-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO DEL SERVICIO · FASE 1 (b) — LOS TRIGGERS
--
-- Requiere: pacto-00, pacto-01 y pacto-02.
--
-- Aquí vive la única defensa real. Todo lo demás del ERP se puede esquivar: las
-- reservas se escriben desde el navegador con la llave pública, así que una
-- validación en pantalla se salta abriendo la consola, y las hay por TRES caminos
-- distintos solo en Programación (guardar :1432, aplicar al contrato :1573,
-- asignación en bloque :1074). Lo que corre en Postgres no se esquiva por ninguno.
--
-- Dos triggers de nacimiento y uno de cambio:
--
--   BEFORE INSERT → deriva los estados y completa lo que el origen dejó a medias.
--     Cubre las CUATRO puertas por las que hoy nace un servicio roto SIN TOCAR SU
--     CÓDIGO: ModalGenerarPrograma (costo_proveedor: 0), el botón "→ Res." de
--     cotizaciones (tipo:'propia' en duro sobre un vehículo de tercero),
--     /despachador (sin empresa ni costo) y Programación.
--
--   AFTER INSERT  → escribe el acta inicial (la fila ya existe: la FK resuelve).
--
--   AFTER UPDATE  → escribe el acta del cambio, con su veredicto y su visado.
--
-- POR QUÉ ESTA REPARTICIÓN. Un trigger AFTER INSERT que hiciera `update reservas`
-- para fijar los estados dispararía el trigger de UPDATE en cascada. Poniendo la
-- derivación en un BEFORE (que solo toca NEW) no hay recursión posible. Y el acta
-- nunca escribe de vuelta sobre `reservas`: lo que la UI necesita saber —si hay un
-- pacto por visar— se DERIVA en las vistas, no se copia.
--
-- ESTA FASE NO BLOQUEA NADA. La política nace en `observa`: se registra lo que se
-- habría rechazado y se revisa en v_pacto_guardia_inventario. El candado es la fase 4.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- El ERP de AFA está EN USO mientras esto corre. `alter table` sobre `reservas`
-- necesita el candado exclusivo de la tabla más consultada del sistema: con
-- lock_timeout, si está ocupada esto falla en 15 segundos con un mensaje claro en vez
-- de quedarse colgado bloqueando la operación. Si falla, se reintenta en un momento
-- tranquilo — la transacción se revierte completa y no queda nada a medias.
set lock_timeout = '15s';

-- ────────────────────────────────────────────────────────────────────────────
-- 1) EL VEREDICTO — ¿este cambio necesita visto bueno?
--
--    Recibe los valores explícitos en vez de leer la reserva: dentro de un trigger la
--    fila ya tiene los valores nuevos, así que leerla daría el "antes" equivocado.
--    Además así se puede probar sin tocar datos.
--
--    CLAVE: la PRIMERA carga de un costo NUNCA es "deterioro". Sin esta excepción,
--    regularizar los servicios trabados generaría decenas de visados el primer día y
--    gerencia aprendería a aprobar sin mirar.
-- ────────────────────────────────────────────────────────────────────────────
drop function if exists public.fn_pacto_evaluar(numeric,numeric,numeric,numeric,boolean,text,text,boolean);
create or replace function public.fn_pacto_evaluar(
  p_costo_antes    numeric,
  p_costo_despues  numeric,
  p_precio_antes   numeric,
  p_precio_despues numeric,
  p_es_primera     boolean default false,
  p_afect_venta    text default '10',
  p_afect_compra   text default '10',
  p_emite_factura  boolean default true,
  -- La afectación del ANTES se pasa aparte porque puede diferir de la del después:
  -- es justo lo que pasa al cambiar de un bus gravado a un taxi exonerado. Evaluar el
  -- "antes" con el régimen del proveedor NUEVO borra el efecto tributario del cambio
  -- —el caso más caro y más invisible— y lo deja pasar como si nada se hubiera movido.
  p_afect_compra_antes  text default null,
  p_emite_factura_antes boolean default null,
  p_afect_venta_antes   text default null
) returns table (
  requiere_visado boolean, severidad text, veredicto text,
  margen_pct_antes numeric, margen_pct_despues numeric
)
language plpgsql stable security definer set search_path = public, pg_temp as $$
declare
  pol record;
  c_ant numeric; c_new numeric; p_ant numeric; p_new numeric;
  d_costo numeric; m_a numeric; m_d numeric; tolerancia numeric;
  af_c_ant text; af_v_ant text; ef_ant boolean;
begin
  select * into pol from public.pacto_politica where id = 1;

  af_c_ant := coalesce(p_afect_compra_antes,  p_afect_compra);
  af_v_ant := coalesce(p_afect_venta_antes,   p_afect_venta);
  ef_ant   := coalesce(p_emite_factura_antes, p_emite_factura);

  -- Todo se compara en NETO. Un costo exonerado y uno gravado no son comparables en
  -- bruto: el gravado devuelve el IGV como crédito y el exonerado no.
  c_ant := public.fn_costo_real(coalesce(p_costo_antes,0),   af_c_ant, ef_ant);
  c_new := public.fn_costo_real(coalesce(p_costo_despues,0), p_afect_compra, p_emite_factura);
  p_ant := public.fn_ingreso_real(coalesce(p_precio_antes,0),   af_v_ant);
  p_new := public.fn_ingreso_real(coalesce(p_precio_despues,0), p_afect_venta);

  d_costo := c_new - c_ant;
  m_a := case when p_ant > 0 then (p_ant - c_ant) / p_ant * 100 end;
  m_d := case when p_new > 0 then (p_new - c_new) / p_new * 100 end;
  margen_pct_antes := round(m_a, 2); margen_pct_despues := round(m_d, 2);

  -- 1. Primera vez que se pacta un costo: es un dato que faltaba, no un deterioro.
  if coalesce(p_es_primera, false) and c_new > 0 then
    requiere_visado := false; severidad := 'inicial';
    veredicto := 'Costo pactado por primera vez (S/ ' || to_char(c_new,'FM999G999D00') ||
                 ' reales). No requiere visado.';
    return next; return;
  end if;

  -- 2. Nada económico se movió.
  if d_costo = 0 and p_new = p_ant then
    requiere_visado := false; severidad := 'neutro';
    veredicto := 'El cambio no altera el costo ni el precio.';
    return next; return;
  end if;

  -- 3. El margen mejora o se mantiene. Se aplica y se informa, sin pedir permiso.
  --    Deliberado: si el cambio BUENO costara lo mismo que el malo, el operador
  --    aprende a esconder los dos.
  if coalesce(pol.auto_aprueba_si_mejora, true) and coalesce(m_d, 0) >= coalesce(m_a, 0) then
    requiere_visado := false; severidad := 'mejora';
    veredicto := 'El cambio mejora o mantiene el margen (' ||
                 to_char(coalesce(m_a,0),'FM990D0') || '% → ' ||
                 to_char(coalesce(m_d,0),'FM990D0') || '%). Se aplica y se informa a Finanzas.';
    return next; return;
  end if;

  -- 4. Sube, pero dentro de la tolerancia y sin romper el margen mínimo.
  tolerancia := greatest(coalesce(pol.tolerancia_costo_abs,100),
                         c_ant * coalesce(pol.tolerancia_costo_pct,10) / 100);
  if d_costo <= tolerancia and coalesce(m_d, 0) >= coalesce(pol.margen_minimo_pct, 15) then
    requiere_visado := false; severidad := 'neutro';
    veredicto := 'Sube S/ ' || to_char(d_costo,'FM999G999D00') || ' en costo real, dentro de la tolerancia.';
    return next; return;
  end if;

  -- 5. Fuera de tolerancia: se aplica IGUAL —el bus tiene que salir— pero se visa.
  requiere_visado := true;
  severidad := case when coalesce(m_d, 0) < 0 then 'critico' else 'deterioro' end;
  veredicto := 'El margen baja de ' || to_char(coalesce(m_a,0),'FM990D0') || '% a ' ||
               to_char(coalesce(m_d,0),'FM990D0') || '% (S/ ' ||
               to_char(d_costo,'FM999G999D00') || ' de mayor costo real). ' ||
               'Se aplica igual, pero requiere visto bueno de gerencia.';
  return next;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) NACIMIENTO (BEFORE INSERT) — que ningún servicio vuelva a nacer roto.
--
--    Repara en la base lo que los cuatro orígenes dejan mal, sin tocar su código:
--      · Si viene vehiculo_tercero_id sin empresa, la deriva del vehículo. Ese es
--        exactamente el bug de cotizaciones/page.tsx:1223, donde el servicio queda
--        tercerizado en la calle y "propio" para el ERP — un costo invisible que ni
--        siquiera aparece en el bloque rojo.
--      · Declara el estado del costo y del precio en vez de dejar un cero ambiguo.
--      · Al retorno de un par lo marca `incluido`, no `pendiente`.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_reservas_pacto_nacimiento()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_emp int; v_ter boolean; v_costo numeric; v_horas int;
        v_es_retorno boolean; v_par_pagado boolean; v_par_con_precio boolean;
begin
  -- "Incluido" es SOLO el tramo que NO lleva la tarifa. Marcar así a la ida de un par
  -- 0+0 la escondería de la bandeja de pendientes: nadie la pactaría nunca y el
  -- servicio llegaría al cierre sin costo, que es exactamente lo que hay que evitar.
  -- Al nacer, el hermano puede no existir todavía (se insertan uno tras otro), por eso
  -- manda el sentido declarado y el estado del hermano es solo un refuerzo.
  v_es_retorno := coalesce(new.direccion_servicio,'') = 'retorno';
  select coalesce(costo_proveedor,0) > 0, coalesce(precio_cliente,0) > 0
    into v_par_pagado, v_par_con_precio
    from public.reservas where id = new.reserva_vinculada_id;
  v_par_pagado := coalesce(v_par_pagado, false);
  v_par_con_precio := coalesce(v_par_con_precio, false);

  v_emp := new.empresa_tercerizada_id;
  if v_emp is null and new.vehiculo_tercero_id is not null then
    select empresa_id into v_emp from public.vehiculos_tercero where id = new.vehiculo_tercero_id;
  end if;

  v_ter := coalesce(new.tipo_asignacion,'') = 'tercerizado'
           or v_emp is not null or new.vehiculo_tercero_id is not null;
  v_costo := coalesce(new.costo_proveedor, 0);

  if v_ter then
    new.empresa_tercerizada_id := coalesce(new.empresa_tercerizada_id, v_emp);
    new.tipo_asignacion := 'tercerizado';
    new.tipo            := 'tercerizada';
  end if;

  -- COMPRA
  new.costo_estado := case
    when not v_ter   then 'no_aplica'
    when v_costo > 0 then 'pactado'
    -- El retorno de un par: su tarifa va en la ida. Su cero es correcto.
    when v_es_retorno or v_par_pagado then 'incluido'
    else 'pendiente' end;

  if new.costo_estado = 'pactado' then
    new.costo_pactado_at := now();
  elsif new.costo_estado = 'pendiente' then
    select horas_para_pactar_costo into v_horas from public.pacto_politica where id = 1;
    -- El plazo vence lo que ocurra primero: el plazo de la política, o el día después
    -- del servicio. Pactar el costo cuando el bus ya volvió no sirve de nada.
    new.costo_limite_at := least(
      now() + make_interval(hours => coalesce(v_horas, 24)),
      (new.fecha_servicio + 1)::timestamptz);
  end if;

  -- VENTA. El retorno nace en 0 A PROPÓSITO: el precio va en la ida.
  new.precio_estado := case
    when coalesce(new.precio_cliente,0) > 0        then 'pactado'
    when v_es_retorno or v_par_con_precio          then 'incluido'
    else 'pendiente' end;
  if new.precio_estado = 'pactado' then new.precio_pactado_at := now(); end if;

  new.actualizado_at := now();
  return new;
end $$;

drop trigger if exists trg_reservas_pacto_nacimiento on public.reservas;
create trigger trg_reservas_pacto_nacimiento
  before insert on public.reservas
  for each row execute function public.fn_reservas_pacto_nacimiento();

-- ── Acta inicial (AFTER INSERT: la fila ya existe, la FK resuelve) ──────────
create or replace function public.fn_reservas_pacto_alta()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
declare v_af_v text; v_af_c text;
begin
  select coalesce(new.venta_afectacion, cl.afectacion_defecto, '10')
    into v_af_v from public.clientes cl where cl.id = new.cliente_id;
  v_af_v := coalesce(v_af_v, '10');
  select coalesce(new.compra_afectacion, et.afectacion_defecto, '10')
    into v_af_c from public.empresas_tercerizadas et where et.id = new.empresa_tercerizada_id;
  v_af_c := coalesce(v_af_c, '10');

  insert into public.servicio_pacto
    (reserva_id, cotizacion_id, lado, origen, contraparte_despues_id, monto_despues,
     afectacion_despues, severidad, veredicto, motivo_clave, estado_reserva, usuario)
  values
    (new.id, new.cotizacion_id, 'venta', 'gesto', new.cliente_id,
     coalesce(new.precio_cliente,0), v_af_v, 'inicial',
     'Precio inicial del servicio.', 'correccion_carga', new.estado, auth.uid());

  if coalesce(new.tipo_asignacion,'') = 'tercerizado' then
    insert into public.servicio_pacto
      (reserva_id, cotizacion_id, lado, origen, contraparte_despues_id, monto_despues,
       afectacion_despues, severidad, veredicto, motivo_clave, estado_reserva, usuario)
    values
      (new.id, new.cotizacion_id, 'compra', 'gesto', new.empresa_tercerizada_id,
       coalesce(new.costo_proveedor,0), v_af_c, 'inicial',
       case when coalesce(new.costo_proveedor,0) > 0
            then 'Costo inicial pactado con el proveedor.'
            when new.costo_estado = 'incluido'
            then 'Tramo incluido en la tarifa del servicio hermano.'
            else 'NACE SIN COSTO PACTADO. Vence el ' ||
                 to_char(new.costo_limite_at, 'DD/MM HH24:MI') || '.' end,
       'correccion_carga', new.estado, auth.uid());
  end if;
  return null;
end $$;

drop trigger if exists trg_reservas_pacto_alta on public.reservas;
create trigger trg_reservas_pacto_alta
  after insert on public.reservas
  for each row execute function public.fn_reservas_pacto_alta();

-- ────────────────────────────────────────────────────────────────────────────
-- 3) EL CAMBIO (AFTER UPDATE) — el acta de lo que se movió.
--
--    El WHEN del trigger filtra en el motor: un update de estado, de hora o de GPS no
--    entra siquiera a la función. Solo lo económico y el recurso.
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
       case when coalesce(new.precio_cliente,0) > coalesce(old.precio_cliente,0)
                 and coalesce(pol.exige_conformidad_cliente, true)
            then encode(gen_random_bytes(24),'hex') end,
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

drop trigger if exists trg_reservas_pacto_acta on public.reservas;
create trigger trg_reservas_pacto_acta
  after update on public.reservas
  for each row
  when (
    coalesce(new.costo_proveedor,0) is distinct from coalesce(old.costo_proveedor,0)
    or coalesce(new.precio_cliente,0) is distinct from coalesce(old.precio_cliente,0)
    or new.empresa_tercerizada_id is distinct from old.empresa_tercerizada_id
    or new.vehiculo_id is distinct from old.vehiculo_id
    or new.vehiculo_tercero_id is distinct from old.vehiculo_tercero_id
  )
  execute function public.fn_reservas_pacto_acta();

-- ── Mantener los estados al día en el mismo UPDATE (BEFORE: sin recursión) ──
create or replace function public.fn_reservas_pacto_estados()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if coalesce(new.costo_proveedor,0) is distinct from coalesce(old.costo_proveedor,0) then
    if coalesce(new.costo_proveedor,0) > 0 then
      new.costo_estado := 'pactado';
      new.costo_pactado_at := now();
      new.costo_limite_at := null;
    elsif coalesce(new.tipo_asignacion,'') = 'tercerizado' then
      new.costo_estado := case when new.reserva_vinculada_id is not null then 'incluido' else 'pendiente' end;
    end if;
  end if;

  if coalesce(new.precio_cliente,0) is distinct from coalesce(old.precio_cliente,0)
     and coalesce(new.precio_cliente,0) > 0 then
    new.precio_estado := 'pactado';
    new.precio_pactado_at := now();
  end if;

  -- Pasar un servicio a flota propia deja de ser una deuda con el proveedor.
  if coalesce(new.tipo_asignacion,'') <> 'tercerizado'
     and coalesce(old.tipo_asignacion,'') = 'tercerizado' then
    new.costo_estado := 'no_aplica';
    new.costo_limite_at := null;
  end if;

  new.actualizado_at := now();
  new.actualizado_por := auth.uid();
  -- El motivo es de ESTE cambio: se consume aquí para que no quede pegado al siguiente.
  if new.cambio_motivo is not null then new.cambio_at := now(); end if;
  return new;
end $$;

drop trigger if exists trg_reservas_pacto_estados on public.reservas;
create trigger trg_reservas_pacto_estados
  before update on public.reservas
  for each row execute function public.fn_reservas_pacto_estados();

-- ── Al pactar la IDA, su RETORNO queda incluido ─────────────────────────────
-- La tarifa de un par va en un solo tramo. Sin esto el hermano se queda en
-- `pendiente` para siempre: no bloquea la liquidación (liquidacion-agrupacion.ts:166
-- lo resuelve en caliente), pero envenena la bandeja de pendientes con servicios que
-- nadie tiene que pactar, y una bandeja con ruido se deja de mirar.
--
-- No hay recursión: el update al hermano solo toca costo_estado, y el WHEN del trigger
-- del acta exige que se mueva el costo, el precio, la empresa o la unidad.
create or replace function public.fn_reservas_pacto_par()
returns trigger language plpgsql security definer set search_path = public, pg_temp as $$
begin
  if new.reserva_vinculada_id is null then return null; end if;

  if coalesce(new.costo_proveedor,0) > 0 then
    update public.reservas
       set costo_estado = 'incluido', costo_limite_at = null
     where id = new.reserva_vinculada_id
       and coalesce(costo_proveedor,0) = 0
       and coalesce(costo_estado,'pendiente') = 'pendiente';
  else
    -- Y al revés: si a la ida se le quita el importe, el retorno vuelve a estar en deuda.
    update public.reservas
       set costo_estado = 'pendiente'
     where id = new.reserva_vinculada_id
       and coalesce(costo_proveedor,0) = 0
       and costo_estado = 'incluido';
  end if;
  return null;
end $$;

drop trigger if exists trg_reservas_pacto_par on public.reservas;
create trigger trg_reservas_pacto_par
  after update on public.reservas
  for each row
  when (coalesce(new.costo_proveedor,0) is distinct from coalesce(old.costo_proveedor,0))
  execute function public.fn_reservas_pacto_par();

-- ────────────────────────────────────────────────────────────────────────────
-- 4) VISAR — la única escritura sobre el acta que hace la app, y va por RPC.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_pacto_visar(
  p_pacto_id bigint, p_aprobar boolean, p_motivo text default null
) returns table (ok boolean, mensaje text)
language plpgsql security definer set search_path = public, pg_temp as $$
declare v_estado text;
begin
  select estado_visado into v_estado from public.servicio_pacto where id = p_pacto_id;
  if v_estado is null then
    ok := false; mensaje := 'El pacto no existe.'; return next; return;
  end if;
  if v_estado <> 'pendiente' then
    ok := false; mensaje := 'Ese pacto ya fue ' || v_estado || '.'; return next; return;
  end if;
  if not p_aprobar and coalesce(trim(p_motivo),'') = '' then
    ok := false; mensaje := 'Para rechazar hay que decir por qué.'; return next; return;
  end if;

  update public.servicio_pacto
     set estado_visado    = case when p_aprobar then 'aprobado' else 'rechazado' end,
         aprobado_por     = auth.uid(),
         fecha_aprobacion = now(),
         motivo_rechazo   = case when p_aprobar then null else p_motivo end
   where id = p_pacto_id;

  ok := true;
  mensaje := case when p_aprobar then 'Pacto aprobado.' else 'Pacto rechazado.' end;
  return next;
end $$;

comment on function public.fn_pacto_visar(bigint,boolean,text) is
  'Aprueba o rechaza un pacto. Es la única escritura de la app sobre el acta: no se '
  'abre un update genérico, porque el acta es la evidencia y tiene que ser append-only.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) VISTAS — lo que ve la gente. Todo DERIVADO: el acta no se copia a `reservas`.
-- ────────────────────────────────────────────────────────────────────────────
drop view if exists public.v_pactos_servicio cascade;
create view public.v_pactos_servicio as
select p.*, r.codigo as os, r.fecha_servicio, r.ruta_nombre,
       m.nombre as motivo,
       ea.razon_social as proveedor_antes,
       en.razon_social as proveedor_despues
  from public.servicio_pacto p
  join public.reservas r on r.id = p.reserva_id
  left join public.pacto_motivo m on m.clave = p.motivo_clave
  left join public.empresas_tercerizadas ea
         on p.lado = 'compra' and ea.id = p.contraparte_antes_id
  left join public.empresas_tercerizadas en
         on p.lado = 'compra' and en.id = p.contraparte_despues_id;

-- La cola de gerencia.
drop view if exists public.v_pactos_por_visar cascade;
create view public.v_pactos_por_visar as
select v.*, (now() > v.fecha_limite) as vencido,
       round(extract(epoch from (now() - v.creado_at)) / 3600, 1) as horas_abierto
  from public.v_pactos_servicio v
 where v.estado_visado = 'pendiente';

-- El pacto abierto de cada servicio: DERIVADO, no guardado en reservas.
drop view if exists public.v_reserva_pacto_abierto cascade;
create view public.v_reserva_pacto_abierto as
select distinct on (p.reserva_id)
       p.reserva_id, p.id as pacto_id, p.codigo, p.severidad, p.veredicto,
       p.delta, p.fecha_limite, (now() > p.fecha_limite) as vencido
  from public.servicio_pacto p
 where p.estado_visado = 'pendiente'
 order by p.reserva_id, p.creado_at desc;

-- ── CUENTA DE CONTROL ───────────────────────────────────────────────────────
-- Un libro auxiliar sin cuenta de control no es auditoría, es decoración. Compara el
-- acta contra la realidad. DEBE DEVOLVER CERO FILAS. Si devuelve algo, hay una
-- escritura que esquivó el trigger y hay que encontrarla antes de subir la guardia.
drop view if exists public.v_pactos_descuadrados cascade;
create view public.v_pactos_descuadrados as
select r.id as reserva_id, r.codigo as os, 'compra' as lado,
       coalesce(r.costo_proveedor,0) as valor_en_reserva,
       coalesce(p.monto_despues,0)   as valor_en_acta,
       coalesce(r.costo_proveedor,0) - coalesce(p.monto_despues,0) as diferencia
  from public.reservas r
  left join lateral (
    select monto_despues from public.servicio_pacto s
     where s.reserva_id = r.id and s.lado = 'compra'
     order by s.version desc, s.creado_at desc limit 1
  ) p on true
 where coalesce(r.tipo_asignacion,'') = 'tercerizado'
   and abs(coalesce(r.costo_proveedor,0) - coalesce(p.monto_despues,0)) > 0.005
union all
select r.id, r.codigo, 'venta',
       coalesce(r.precio_cliente,0), coalesce(p.monto_despues,0),
       coalesce(r.precio_cliente,0) - coalesce(p.monto_despues,0)
  from public.reservas r
  left join lateral (
    select monto_despues from public.servicio_pacto s
     where s.reserva_id = r.id and s.lado = 'venta'
     order by s.version desc, s.creado_at desc limit 1
  ) p on true
 where abs(coalesce(r.precio_cliente,0) - coalesce(p.monto_despues,0)) > 0.005;

comment on view public.v_pactos_descuadrados is
  'Cuenta de control del acta. DEBE dar cero filas. Cualquier fila es una escritura que '
  'no pasó por el trigger: revísala ANTES de poner la política en modo exige.';

-- ── INVENTARIO DE LA GUARDIA (el "modo observa" hecho vista) ────────────────
-- Qué se rechazaría HOY si la política estuviera en `exige`. Es lo que hay que dejar
-- en cero durante dos semanas antes de poner el candado en la fase 4.
drop view if exists public.v_pacto_guardia_inventario cascade;
create view public.v_pacto_guardia_inventario as
select r.id as reserva_id, r.codigo as os, r.fecha_servicio,
       et.razon_social as proveedor, r.ruta_nombre, r.costo_estado,
       r.costo_limite_at, (now() > r.costo_limite_at) as vencido,
       -- Un par 0+0 pinta DOS líneas rojas pero es UN costo a decidir: al pactar la
       -- ida, el retorno pasa solo a "incluido". Contar las dos es lo que infla el
       -- problema a casi el doble y hace que el bloque rojo parezca inabordable.
       -- Es "la" decisión el tramo que llevará la tarifa: la ida, o el id menor
       -- cuando el par no declara sentido.
       (r.reserva_vinculada_id is null
        or coalesce(r.direccion_servicio,'') = 'ida'
        or (coalesce(r.direccion_servicio,'') not in ('ida','retorno')
            and r.id < r.reserva_vinculada_id)) as decision_real,
       case
         when r.costo_estado = 'pendiente' and now() > r.costo_limite_at
              then 'Servicio tercerizado sin costo pactado y con el plazo vencido'
         when r.costo_estado = 'pendiente'
              then 'Servicio tercerizado sin costo pactado (dentro del plazo)'
         else 'Sin observación' end as motivo_rechazo
  from public.reservas r
  left join public.empresas_tercerizadas et on et.id = r.empresa_tercerizada_id
 where coalesce(r.tipo_asignacion,'') = 'tercerizado'
   and coalesce(r.costo_estado,'pendiente') = 'pendiente'
   and coalesce(r.estado,'') <> 'cancelada'
   and r.liquidacion_proveedor_id is null;

comment on view public.v_pacto_guardia_inventario is
  'Lo que la guardia rechazaría HOY si la política estuviera en modo exige. Filtra por '
  'decision_real para contar decisiones y no líneas rojas: un par 0+0 son dos líneas y '
  'un solo costo. Debe quedar en cero antes de subir la guardia en la fase 4.';

-- ── LA ADENDA que hoy se le exige al operador, hecha sola ───────────────────
drop view if exists public.v_adenda_contrato cascade;
create view public.v_adenda_contrato as
select p.cotizacion_id,
       min(p.creado_at)::date as desde,
       max(p.creado_at)::date as hasta,
       count(*) filter (where p.lado = 'venta')  as cambios_de_precio,
       count(*) filter (where p.lado = 'compra') as cambios_de_costo,
       count(distinct p.reserva_id)              as servicios_afectados,
       sum(p.delta) filter (where p.lado = 'venta')  as delta_venta,
       sum(p.delta) filter (where p.lado = 'compra') as delta_costo,
       coalesce(sum(p.delta) filter (where p.lado = 'venta'), 0)
       - coalesce(sum(p.delta) filter (where p.lado = 'compra'), 0) as delta_margen
  from public.servicio_pacto p
 where p.lado in ('venta','compra')
   and p.version > 1
   and p.cotizacion_id is not null
   -- La PRIMERA carga de un costo (0 → 500) no es una adenda: es un dato que faltaba.
   -- Contarla como cambio del contrato infla el delta y hace que un servicio
   -- regularizado parezca una pérdida. La adenda muestra lo que cambió DESPUÉS de
   -- quedar pactado, que es lo que hay que sustentarle al cliente y a gerencia.
   and p.severidad <> 'inicial'
   and p.origen = 'gesto'
 group by p.cotizacion_id;

comment on view public.v_adenda_contrato is
  'El sustento del cambio por contrato: la "segunda cotización" que hoy se le pide al '
  'operador, armada sola a partir del acta.';

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN — correr DESPUÉS del backfill (pacto-04)
--   select count(*) from public.v_pactos_descuadrados;      -- debe ser 0
--   select count(*) from public.v_pacto_guardia_inventario; -- el pasivo a resolver
--   select os, severidad, veredicto from public.v_pactos_por_visar;
--
-- ROLLBACK
--   drop trigger if exists trg_reservas_pacto_acta       on public.reservas;
--   drop trigger if exists trg_reservas_pacto_estados    on public.reservas;
--   drop trigger if exists trg_reservas_pacto_alta       on public.reservas;
--   drop trigger if exists trg_reservas_pacto_nacimiento on public.reservas;
-- ══════════════════════════════════════════════════════════════════════════════
