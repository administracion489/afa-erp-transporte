-- ══════════════════════════════════════════════════════════════════════════════
-- FINANZAS · FASE 08 — Caja chica para TODO el personal, no solo conductores
--
-- Corregir un supuesto de la fase 06: la caja chica se modeló pensando en la calle
-- (conductor · vehículo · peaje) y la oficina quedó a medias. En AFA también reciben
-- caja chica el gerente, el contador y el personal administrativo, y sus gastos son
-- otros: útiles, courier, notaría, refrigerio de reunión, representación.
--
-- Qué cambia aquí (todo idempotente; correr DESPUÉS de finanzas-06 y 07):
--   1) responsable_tipo acepta 'personal_administrativo' + FK a esa tabla.
--   2) caja_chica_gastos.categoria suma las categorías de OFICINA.
--   3) El fondo declara un CENTRO DE COSTO. Para el administrativo NO se copia: se
--      DERIVA de personal_administrativo.departamento en la vista (regla de oro).
--   4) Las vistas publican quién es el responsable en las tres formas posibles y el
--      área, para poder reportar "cuánto gastó Gerencia este mes" sin joins a mano.
--   5) v_caja_chica_por_area — el corte que la oficina necesita y la calle no.
--
-- Lo que NO cambia: la regla de bloqueo, los derivados y v_egresos siguen igual. Un
-- gasto de oficina entra a egresos por el mismo camino que un peaje.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) El responsable puede ser personal administrativo.
--    El CHECK se reemplaza (no se puede "agregar" un valor a un check existente).
-- ────────────────────────────────────────────────────────────────────────────
alter table public.caja_chica_fondos drop constraint if exists caja_chica_fondos_responsable_tipo_check;
alter table public.caja_chica_fondos
  add constraint caja_chica_fondos_responsable_tipo_check
  check (responsable_tipo in ('conductor','personal_administrativo','usuario','otro'));

-- FK a la tabla de administrativos (tipo de PK resuelto en runtime, como el resto).
-- Si la tabla no existiera, _fin_add_fk emite un NOTICE y sigue: la migración no cae.
select public._fin_add_fk('caja_chica_fondos','personal_administrativo_id','personal_administrativo');

-- Cargo del responsable: dato de presentación para la bandeja ("Gerente General"),
-- no una segunda fuente de verdad. Para el administrativo la vista prefiere SIEMPRE
-- lo que diga personal_administrativo; esta columna solo cubre a 'usuario' y 'otro'.
alter table public.caja_chica_fondos add column if not exists cargo text;

-- Centro de costo declarado a mano. Es el respaldo para quien no tiene ficha en
-- personal_administrativo; el administrativo lo hereda de su departamento.
alter table public.caja_chica_fondos add column if not exists centro_costo text;

create index if not exists idx_cc_fondos_centro on public.caja_chica_fondos (centro_costo);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) Categorías de OFICINA en los comprobantes.
--    Las de calle se quedan tal cual: un fondo de gerencia también paga un taxi.
--    OJO 'representacion': el gasto de representación tiene tope tributario (0.5 %
--    de los ingresos brutos acumulados, máximo 40 UIT — art. 37 inc. q LIR). Se
--    separa de 'refrigerio' justamente para poder controlarlo, no por estética.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.caja_chica_gastos drop constraint if exists caja_chica_gastos_categoria_check;
alter table public.caja_chica_gastos
  add constraint caja_chica_gastos_categoria_check
  check (categoria in (
    -- calle / operación
    'peaje','lavado','estacionamiento','viaticos','movilidad',
    'repuesto_menor','combustible','tramite','multa',
    -- oficina / administración
    'utiles_oficina','courier','refrigerio','representacion',
    'servicios_basicos','limpieza','mantenimiento_local','capacitacion',
    'otro'));

create index if not exists idx_cc_gastos_categoria on public.caja_chica_gastos (categoria);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) Vistas: publican al responsable en sus tres formas y DERIVAN el área.
--
--    Se hace dentro de un bloque que comprueba si personal_administrativo existe y
--    si la FK llegó a crearse: en una base donde falte, la vista se arma igual sin
--    ese join en vez de abortar toda la migración. Mismo patrón que la fase 06 usó
--    con v_detracciones_pendientes.
--
--    DROP CASCADE porque cambia la lista de columnas y v_caja_chica_saldos depende
--    de v_caja_chica_rendiciones; ambas se recrean aquí abajo.
-- ────────────────────────────────────────────────────────────────────────────
do $vw$
declare
  v_hay_pa boolean;
  v_join   text;
  v_area   text;
  v_cargo  text;
  v_pa_id  text;
  v_usr_id boolean;
begin
  v_hay_pa := exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'caja_chica_fondos'
       and column_name = 'personal_administrativo_id'
  ) and exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'personal_administrativo'
       and column_name = 'departamento'
  );

  v_usr_id := exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'caja_chica_fondos'
       and column_name = 'usuario_id'
  );

  if v_hay_pa then
    v_join  := 'left join public.personal_administrativo pa on pa.id = f.personal_administrativo_id';
    -- El área del administrativo la manda SU ficha, no una copia en el fondo.
    v_area  := 'coalesce(pa.departamento, f.centro_costo, '
               || 'case when f.responsable_tipo = ''conductor'' then ''Operaciones'' end)';
    v_cargo := 'coalesce(pa.cargo, f.cargo)';
    v_pa_id := 'f.personal_administrativo_id';
  else
    v_join  := '';
    v_area  := 'coalesce(f.centro_costo, '
               || 'case when f.responsable_tipo = ''conductor'' then ''Operaciones'' end)';
    v_cargo := 'f.cargo';
    v_pa_id := 'null::bigint';
    raise notice '[fase08] personal_administrativo no disponible: el área se toma solo de centro_costo';
  end if;

  execute 'drop view if exists public.v_caja_chica_por_area cascade';
  execute 'drop view if exists public.v_caja_chica_saldos    cascade';
  execute 'drop view if exists public.v_caja_chica_rendiciones cascade';

  -- 3.1) Rendiciones (mismos derivados de la fase 06 + identidad y área).
  execute format($sql$
    create view public.v_caja_chica_rendiciones as
      select r.id,
             r.codigo,
             r.fondo_id,
             f.nombre                as fondo_nombre,
             f.responsable_tipo,
             f.responsable_nombre,
             f.documento_identidad,
             f.conductor_id,
             %s                      as personal_administrativo_id,
             %s                      as usuario_id,
             %s                      as cargo,
             %s                      as area,
             r.vehiculo_id,
             r.periodo_desde,
             r.periodo_hasta,
             r.fecha_entrega,
             r.fecha_limite,
             r.monto_asignado,
             coalesce(g.rendido, 0)                          as monto_rendido,
             coalesce(g.pendiente_revision, 0)               as monto_por_revisar,
             coalesce(g.rechazado, 0)                        as monto_rechazado,
             r.monto_devuelto,
             (r.monto_asignado - coalesce(g.rendido, 0) - r.monto_devuelto) as saldo_pendiente,
             coalesce(g.n_comprobantes, 0)                   as comprobantes,
             r.moneda,
             r.estado,
             (r.estado in ('abierta','por_revisar','observada')
              and r.fecha_limite < (now() at time zone 'America/Lima')::date) as atrasada,
             greatest(0, (now() at time zone 'America/Lima')::date - r.fecha_limite) as dias_atraso,
             r.pago_entrega_id,
             r.pago_reembolso_id,
             r.enviada_at,
             r.revisada_por,
             r.fecha_revision,
             r.aprobada_por,
             r.fecha_aprobacion,
             r.motivo_observacion,
             r.observaciones,
             r.created_at
        from public.caja_chica_rendiciones r
        join public.caja_chica_fondos f on f.id = r.fondo_id
        %s
        left join lateral (
          select sum(cg.monto) filter (where cg.estado_revision <> 'rechazado') as rendido,
                 sum(cg.monto) filter (where cg.estado_revision = 'pendiente')  as pendiente_revision,
                 sum(cg.monto) filter (where cg.estado_revision = 'rechazado')  as rechazado,
                 count(*)                                                       as n_comprobantes
            from public.caja_chica_gastos cg
           where cg.rendicion_id = r.id
        ) g on true
  $sql$, v_pa_id, case when v_usr_id then 'f.usuario_id' else 'null::uuid' end,
         v_cargo, v_area, v_join);

  -- 3.2) Saldo por fondo (base de la regla de bloqueo; se conserva su contrato).
  execute format($sql$
    create view public.v_caja_chica_saldos as
      select f.id                                     as fondo_id,
             f.nombre,
             f.responsable_tipo,
             f.responsable_nombre,
             f.conductor_id,
             %s                                       as personal_administrativo_id,
             %s                                       as usuario_id,
             %s                                       as cargo,
             %s                                       as area,
             f.moneda,
             f.tope,
             f.activo,
             count(v.id) filter (where v.estado in ('abierta','por_revisar','observada')) as rendiciones_vivas,
             count(v.id) filter (where v.atrasada)                                        as rendiciones_atrasadas,
             coalesce(sum(v.saldo_pendiente) filter
                      (where v.estado in ('abierta','por_revisar','observada')), 0)       as saldo_en_calle,
             max(v.fecha_entrega)                                                         as ultima_entrega
        from public.caja_chica_fondos f
        %s
        left join public.v_caja_chica_rendiciones v on v.fondo_id = f.id
       group by f.id, f.nombre, f.responsable_tipo, f.responsable_nombre,
                f.conductor_id, f.moneda, f.tope, f.activo, f.centro_costo, f.cargo%s
  $sql$, v_pa_id, case when v_usr_id then 'f.usuario_id' else 'null::uuid' end,
         v_cargo, v_area, v_join,
         case when v_hay_pa then ', f.personal_administrativo_id, pa.departamento, pa.cargo' else '' end);

  -- 3.3) El corte que la oficina pedía: gasto de caja chica por área y por mes.
  --      Se apoya en la rendición (que ya sabe el área) y NO recalcula montos.
  execute $sql$
    create view public.v_caja_chica_por_area as
      select coalesce(v.area, 'Sin asignar')                as area,
             to_char(cg.fecha, 'YYYY-MM')                   as periodo,
             cg.categoria,
             count(*)                                       as comprobantes,
             sum(cg.monto) filter (where cg.estado_revision = 'aprobado')  as monto_aprobado,
             sum(cg.monto) filter (where cg.estado_revision = 'pendiente') as monto_por_revisar,
             sum(cg.monto) filter (where cg.estado_revision <> 'rechazado') as monto_rendido
        from public.caja_chica_gastos cg
        join public.v_caja_chica_rendiciones v on v.id = cg.rendicion_id
       group by 1, 2, 3
  $sql$;
end $vw$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) Coherencia del fondo: el id del responsable debe calzar con su tipo.
--    Sin esto se puede guardar un fondo tipo 'conductor' apuntando a un
--    administrativo, y la bandeja mostraría un nombre que no corresponde a nadie.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'caja_chica_fondos'
                and column_name = 'personal_administrativo_id')
  then
    alter table public.caja_chica_fondos drop constraint if exists cc_fondos_responsable_coherente;
    alter table public.caja_chica_fondos
      add constraint cc_fondos_responsable_coherente check (
        (responsable_tipo = 'conductor'                and personal_administrativo_id is null)
     or (responsable_tipo = 'personal_administrativo'  and conductor_id is null)
     or (responsable_tipo in ('usuario','otro')        and conductor_id is null
                                                       and personal_administrativo_id is null)
      ) not valid;
    -- NOT VALID: no se revisan las filas ya existentes (una base con datos previos
    -- no debe caerse al migrar); a partir de ahora sí se exige en cada escritura.
  end if;
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) Un fondo por persona: dos fondos activos para el mismo administrativo
--    partirían su saldo en dos y la regla de bloqueo dejaría de servir.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema = 'public' and table_name = 'caja_chica_fondos'
                and column_name = 'personal_administrativo_id')
  then
    execute 'create unique index if not exists uq_cc_fondo_administrativo
               on public.caja_chica_fondos (personal_administrativo_id)
              where personal_administrativo_id is not null and activo';
  end if;
end $$;

create unique index if not exists uq_cc_fondo_conductor
  on public.caja_chica_fondos (conductor_id)
  where conductor_id is not null and activo;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- select responsable_tipo, count(*) from public.caja_chica_fondos group by 1;
-- select * from public.v_caja_chica_saldos order by saldo_en_calle desc;
-- select * from public.v_caja_chica_por_area order by periodo desc, monto_rendido desc;
-- Debe seguir cuadrando con /gastos:
-- select fuente, count(*), sum(monto) from public.v_egresos group by 1 order by 3 desc;
