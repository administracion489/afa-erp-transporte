-- ────────────────────────────────────────────────────────────────────────────
-- pacto-03-fix-token-pgcrypto.sql — PARCHE. Corre esto en el SQL Editor.
--
-- SÍNTOMA: al subir el PRECIO AL CLIENTE de un servicio, Programación devuelve
--
--     0 servicio(s) actualizado(s).
--     1 rechazado(s):
--     #16527: function gen_random_bytes(integer) does not exist
--
-- y no guarda NADA de ese servicio, ni siquiera el costo del proveedor.
--
-- CAUSA: cuando el precio sube, el trigger del acta de venta genera el token del
-- enlace publico de conformidad. Lo hacia con gen_random_bytes(24), que pertenece a la
-- extension pgcrypto. En Supabase las extensiones viven en el esquema `extensions`, y
-- esta funcion esta declarada `set search_path = public, pg_temp`: nunca lo ve. El
-- trigger lanza 42883 y Postgres rechaza el UPDATE completo.
--
-- Instalar pgcrypto NO lo arregla, justamente por ese search_path.
--
-- ARREGLO: gen_random_uuid(), que es NUCLEO de PostgreSQL desde la 13 y se resuelve por
-- pg_catalog pase lo que pase. Dos UUID concatenados dan 64 hex = 244 bits, mas
-- entropia que los 192 bits de antes. Es lo que ya usa liquidaciones-v2.sql.
--
-- Solo reemplaza la funcion: NO toca tablas, datos, vistas ni los demas triggers, y los
-- tokens ya emitidos siguen siendo validos. El trigger que la usa no se recrea porque
-- apunta a la funcion por nombre.
-- ────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_reservas_pacto_acta()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare
  pol record; ev record;
  v_af_v text; v_af_c text; v_factura boolean;
  v_af_v_ant text; v_af_c_ant text; v_factura_ant boolean;
  v_costo boolean; v_precio boolean; v_prov boolean; v_recurso boolean;
  v_primera boolean; v_ver int; v_usr uuid;
begin
  -- Cinturón: si alguna vez se agrega un trigger que escriba sobre reservas, esto
  -- evita la cascada. Hoy ninguno lo hace.
  if pg_trigger_depth() > 1 then return null; end if;

  select * into pol from public.pacto_politica where id = 1;
  v_usr := auth.uid();

  v_costo   := coalesce(new.costo_proveedor,0) is distinct from coalesce(old.costo_proveedor,0);
  v_precio  := coalesce(new.precio_cliente,0)  is distinct from coalesce(old.precio_cliente,0);
  v_prov    := new.empresa_tercerizada_id      is distinct from old.empresa_tercerizada_id;
  v_recurso := new.vehiculo_id is distinct from old.vehiculo_id
            or new.vehiculo_tercero_id is distinct from old.vehiculo_tercero_id;

  select coalesce(new.venta_afectacion, cl.afectacion_defecto, '10')
    into v_af_v from public.clientes cl where cl.id = new.cliente_id;
  v_af_v := coalesce(v_af_v, '10');
  select coalesce(new.compra_afectacion, et.afectacion_defecto, '10'),
         coalesce(et.emite_factura, true)
    into v_af_c, v_factura
    from public.empresas_tercerizadas et where et.id = new.empresa_tercerizada_id;
  v_af_c := coalesce(v_af_c, '10'); v_factura := coalesce(v_factura, true);

  -- El régimen que regía ANTES. Cuando el proveedor cambia, es el suyo, no el del
  -- entrante: pasar de un bus gravado a un taxi exonerado sube el costo real aunque
  -- el importe baje, y evaluarlo con el régimen nuevo escondería justo ese efecto.
  select coalesce(old.compra_afectacion, et.afectacion_defecto, '10'),
         coalesce(et.emite_factura, true)
    into v_af_c_ant, v_factura_ant
    from public.empresas_tercerizadas et where et.id = old.empresa_tercerizada_id;
  v_af_c_ant := coalesce(v_af_c_ant, v_af_c); v_factura_ant := coalesce(v_factura_ant, v_factura);

  select coalesce(old.venta_afectacion, cl.afectacion_defecto, '10')
    into v_af_v_ant from public.clientes cl where cl.id = old.cliente_id;
  v_af_v_ant := coalesce(v_af_v_ant, v_af_v);

  -- Cargar por primera vez un costo que estaba pendiente NO es un deterioro.
  v_primera := coalesce(old.costo_estado,'pendiente') <> 'pactado'
               and coalesce(old.costo_proveedor,0) = 0;

  select * into ev from public.fn_pacto_evaluar(
    old.costo_proveedor, new.costo_proveedor,
    old.precio_cliente,  new.precio_cliente,
    v_primera, v_af_v, v_af_c, v_factura,
    v_af_c_ant, v_factura_ant, v_af_v_ant);

  -- ── Acta de COMPRA ──
  if v_costo or v_prov then
    select coalesce(max(version),0) + 1 into v_ver
      from public.servicio_pacto where reserva_id = new.id and lado = 'compra';

    insert into public.servicio_pacto
      (codigo, reserva_id, cotizacion_id, lado, version, origen,
       contraparte_antes_id, contraparte_despues_id, monto_antes, monto_despues,
       afectacion_antes, afectacion_despues,
       margen_pct_antes, margen_pct_despues, severidad, veredicto,
       motivo_clave, motivo_nota, usuario,
       estado_visado, fecha_limite,
       estado_reserva, estado_admin, estado_proveedor,
       liquidado_cliente, liquidado_proveedor)
    values
      (public.fn_pacto_folio('PSC'), new.id, new.cotizacion_id, 'compra', v_ver, 'gesto',
       old.empresa_tercerizada_id, new.empresa_tercerizada_id,
       old.costo_proveedor, new.costo_proveedor,
       v_af_c_ant, v_af_c,
       ev.margen_pct_antes, ev.margen_pct_despues, ev.severidad, ev.veredicto,
       new.cambio_motivo, new.cambio_nota, v_usr,
       case when ev.requiere_visado then 'pendiente' else 'no_requiere' end,
       case when ev.requiere_visado
            then now() + make_interval(hours => coalesce(pol.horas_vence_visado,48)) end,
       new.estado, new.estado_admin, new.estado_proveedor,
       new.liquidacion_cliente_id is not null, new.liquidacion_proveedor_id is not null);
  end if;

  -- ── Acta de VENTA ──
  if v_precio then
    select coalesce(max(version),0) + 1 into v_ver
      from public.servicio_pacto where reserva_id = new.id and lado = 'venta';

    insert into public.servicio_pacto
      (codigo, reserva_id, cotizacion_id, lado, version, origen,
       contraparte_antes_id, contraparte_despues_id, monto_antes, monto_despues,
       afectacion_antes, afectacion_despues,
       margen_pct_antes, margen_pct_despues, severidad, veredicto,
       motivo_clave, motivo_nota, usuario,
       -- La conformidad del cliente se pide cuando el precio SUBE: ese papel es lo que
       -- hace cobrable el diferencial. El flujo público es la fase 5.
       token, conformidad_estado,
       estado_reserva, estado_admin, liquidado_cliente)
    values
      (public.fn_pacto_folio('PSV'), new.id, new.cotizacion_id, 'venta', v_ver, 'gesto',
       old.cliente_id, new.cliente_id, old.precio_cliente, new.precio_cliente,
       v_af_v_ant, v_af_v,
       ev.margen_pct_antes, ev.margen_pct_despues, ev.severidad, ev.veredicto,
       new.cambio_motivo, new.cambio_nota, v_usr,
       -- Token del enlace público de conformidad. Dos UUID concatenados = 64 hex
       -- (244 bits), MÁS entropía que los 192 bits del gen_random_bytes(24) que había
       -- aquí, y sin depender de pgcrypto: `gen_random_bytes` es de esa extensión, que
       -- en Supabase se instala en el esquema `extensions` — fuera del
       -- `set search_path = public, pg_temp` de esta función. El trigger reventaba con
       -- "function gen_random_bytes(integer) does not exist" y Postgres RECHAZABA el
       -- UPDATE entero de la reserva: subir el precio al cliente era imposible.
       -- `gen_random_uuid()` es núcleo desde PG13 y se resuelve por pg_catalog siempre.
       -- Es además lo que ya usa liquidaciones-v2.sql para sus tokens.
       case when coalesce(new.precio_cliente,0) > coalesce(old.precio_cliente,0)
                 and coalesce(pol.exige_conformidad_cliente, true)
            then replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '') end,
       case when coalesce(new.precio_cliente,0) > coalesce(old.precio_cliente,0)
                 and coalesce(pol.exige_conformidad_cliente, true)
            then 'pendiente' else 'no_aplica' end,
       new.estado, new.estado_admin, new.liquidacion_cliente_id is not null);
  end if;

  -- ── Acta LIGERA de recurso: sin folio y sin visado ──
  -- Cambiar un bus propio por otro es el movimiento más frecuente del día (la avería
  -- de las 5 a.m.) y no mueve un sol. Se deja rastro, no se le cobra peaje.
  if v_recurso and not (v_costo or v_precio or v_prov) then
    insert into public.servicio_pacto
      (reserva_id, cotizacion_id, lado, origen, unidad_antes, unidad_despues,
       severidad, veredicto, motivo_clave, motivo_nota, usuario, estado_reserva)
    values
      (new.id, new.cotizacion_id, 'recurso', 'gesto',
       coalesce(old.vehiculo_id::text, old.vehiculo_tercero_id::text, '—'),
       coalesce(new.vehiculo_id::text, new.vehiculo_tercero_id::text, '—'),
       'neutro', 'Cambio de unidad sin efecto económico.',
       new.cambio_motivo, new.cambio_nota, v_usr, new.estado);
  end if;

  return null;
end $$;

-- ── Verificacion ────────────────────────────────────────────────────────────
-- Debe devolver 0 filas: ninguna funcion del ERP depende ya de pgcrypto.
--
-- Dos detalles que rompen la consulta obvia:
--   · pg_get_functiondef() LANZA ERROR sobre funciones agregadas ("array_agg is an
--     aggregate function"), asi que hay que acotar a prokind = 'f'.
--   · El filtro y la llamada van en pasos separados (CTE MATERIALIZED). Sin eso el
--     planificador puede evaluar pg_get_functiondef ANTES del filtro y reventar igual.
--
--   with fns as materialized (
--     select p.oid, p.proname
--       from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--      where n.nspname = 'public' and p.prokind = 'f'
--   )
--   select proname from fns where pg_get_functiondef(oid) ilike '%gen_random_bytes%';
--
-- Version acotada, si solo interesa esta funcion (no puede tocar un agregado):
--
--   select count(*)
--     from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public' and p.proname = 'fn_reservas_pacto_acta'
--      and pg_get_functiondef(p.oid) ilike '%gen_random_bytes%';   -- 0 = parche aplicado
