-- ══════════════════════════════════════════════════════════════════════════════
-- COMISIONES DEL EJECUTIVO DE VENTAS · FASE 01 — Parámetros y calendario
--
-- QUÉ HACE: crea las tablas de CONFIGURACIÓN del módulo de comisiones. Son los
-- números que gobiernan todo el cálculo: porcentajes por tipo de venta, ventanas
-- de tiempo, el reparto del bono de arranque, los siete indicadores del bono de
-- atención y el calendario laboral (días hábiles, horario y feriados) con el que
-- se mide la "rapidez" de respuesta del vendedor.
--
-- POR QUÉ: la comisión no puede vivir como constantes en el código. Las tasas y
-- los montos cambian por decisión de gerencia, y un mes ya CERRADO (fase 04) no
-- debe recalcularse si mañana suben un porcentaje. Por eso `comisiones_parametros`
-- se versiona por fecha de vigencia —calca `config_laboral_regimen` de
-- costeo-01—: una fila nueva con otra `vigente_desde` no pisa la historia.
--
-- SI NO SE CORRE: el módulo de comisiones no existe (ninguna pantalla ni cálculo).
-- No afecta a nada de lo ya desplegado: solo agrega tablas nuevas.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. ES IDEMPOTENTE
-- (create ... if not exists, inserts guardados). EL DEPLOY NO LO CORRE.
-- Orden de la familia: 01 → 02 → 03 → 04.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) PARÁMETROS versionados por fecha de vigencia.
--    Mismo patrón que config_laboral_regimen: las filas NO se editan; para cambiar
--    una tasa se inserta otra con `vigente_desde` posterior. El cálculo elige la
--    fila vigente a la fecha del servicio, y cada línea (fase 04) guarda el id de
--    la versión que usó (snapshot), de modo que un mes cerrado nunca se mueve.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.comisiones_parametros (
  id                           bigserial primary key,
  vigente_desde                date not null default current_date,

  -- ── EVENTUAL: comisión por servicio eventual sobre la UTILIDAD antes de impuestos.
  --    Dos tramos: los primeros N servicios del período pagan tramo1, el resto tramo2.
  pct_eventual_tramo1          numeric(6,4)  not null default 0.20,
  pct_eventual_tramo2          numeric(6,4)  not null default 0.12,
  tramo_eventual_hasta         int           not null default 30,

  -- ── FIJO: comisión por servicio de contrato fijo sobre la utilidad.
  pct_fijo                     numeric(6,4)  not null default 0.10,

  -- ── BONO DE ARRANQUE: por traer un cliente NUEVO. Se paga partido en dos
  --    (arranque_split, p.ej. [0.5,0.5]); la segunda parte el mes indicado.
  pct_bono_arranque            numeric(6,4)  not null default 0.30,
  arranque_split               jsonb         not null default '[0.5,0.5]'::jsonb,
  arranque_mes_2da_parte       int           not null default 3,

  -- ── VENTANAS de tiempo (en meses): cuánto dura la comisión del fijo desde el
  --    arranque del contrato, y hasta cuándo un cliente cuenta como "nuevo".
  ventana_fijo_meses           int           not null default 12,
  ventana_cliente_nuevo_meses  int           not null default 12,

  -- ── BONO DE ATENCIÓN: tope mensual y los siete indicadores que lo componen.
  --    Los siete montos (en soles) + la tolerancia de "rapidez" viven en el jsonb
  --    para que agregar o retocar un indicador no obligue a una migración nueva.
  --    Claves: rapidez, cero_quejas, sin_cancelaciones, seguimiento, registros,
  --    precios, documentacion; tolerancia_rapidez = fracción de cotizaciones que
  --    deben responderse dentro del horario hábil para ganar el indicador.
  tope_bono_atencion           numeric(14,2) not null default 150,
  indicadores_json             jsonb         not null default
    '{"rapidez":20,"cero_quejas":20,"sin_cancelaciones":20,"seguimiento":25,'
    '"registros":20,"precios":15,"documentacion":30,"tolerancia_rapidez":0.90}'::jsonb,

  -- ── FONDO de operación/administración: lo que cada servicio eventual aporta al
  --    fondo que se reparte entre el personal administrativo corroborado (fase 03).
  --    Monto en soles por servicio eventual (la semántica la aplica el backend).
  fondo_admin_por_eventual     numeric(14,2) not null default 4,

  notas                        text,
  created_at                   timestamptz   not null default now(),
  unique (vigente_desde)
);

comment on table public.comisiones_parametros is
  'Parámetros del módulo de comisiones, versionados por fecha de vigencia (calca '
  'config_laboral_regimen). Para cambiar una tasa se INSERTA una fila con otra '
  'vigente_desde; no se edita. Cada comisiones_linea guarda parametros_id (snapshot) '
  'para que los meses cerrados no se recalculen.';

-- Semilla: una sola fila con los valores pedidos, vigente desde HOY. Se inserta
-- solo si la tabla está vacía — re-correr el archivo no pisa parámetros ajustados.
insert into public.comisiones_parametros (vigente_desde, notas)
select current_date, 'Semilla inicial del módulo de comisiones.'
where not exists (select 1 from public.comisiones_parametros);

-- ────────────────────────────────────────────────────────────────────────────
-- 2) CALENDARIO LABORAL (fila única). Define qué es "horario hábil" para medir la
--    rapidez de respuesta del vendedor (indicador del bono de atención).
--    dias_habiles: días de la semana en ISO (1 = lunes … 7 = domingo).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.calendario_laboral (
  id           int  primary key default 1 check (id = 1),
  dias_habiles int[] not null default '{1,2,3,4,5}',   -- Lun–Vie (ISO dow)
  hora_inicio  time not null default '08:00',
  hora_fin     time not null default '18:00',
  updated_at   timestamptz not null default now()
);
insert into public.calendario_laboral (id) values (1) on conflict (id) do nothing;

comment on table public.calendario_laboral is
  'Fila única. Horario y días hábiles para medir la rapidez de respuesta. '
  'dias_habiles en ISO: 1=lunes … 7=domingo. Los feriados salen de la tabla feriados.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) FERIADOS. La rapidez se cuenta sobre horas hábiles; un día feriado no cuenta.
--    Semilla: feriados NACIONALES del Perú del año en curso (2026) y el siguiente
--    (2027). Las fechas de Semana Santa (Jueves y Viernes Santo) son móviles y van
--    calculadas: Pascua 2026 = 5-abr → jue/vie 2-3 abr; Pascua 2027 = 28-mar →
--    jue/vie 25-26 mar. El resto son fijas (incluye las añadidas por la Ley 31643).
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.feriados (
  fecha  date primary key,
  nombre text not null,
  ambito text not null default 'nacional'
         check (ambito in ('nacional','regional','local'))
);

insert into public.feriados (fecha, nombre, ambito) values
  -- 2026
  (date '2026-01-01', 'Año Nuevo',                               'nacional'),
  (date '2026-04-02', 'Jueves Santo',                            'nacional'),
  (date '2026-04-03', 'Viernes Santo',                           'nacional'),
  (date '2026-05-01', 'Día del Trabajo',                         'nacional'),
  (date '2026-06-07', 'Batalla de Arica y Día de la Bandera',    'nacional'),
  (date '2026-06-29', 'San Pedro y San Pablo',                   'nacional'),
  (date '2026-07-23', 'Día de la Fuerza Aérea del Perú',         'nacional'),
  (date '2026-07-28', 'Fiestas Patrias',                         'nacional'),
  (date '2026-07-29', 'Fiestas Patrias',                         'nacional'),
  (date '2026-08-06', 'Batalla de Junín',                        'nacional'),
  (date '2026-08-30', 'Santa Rosa de Lima',                      'nacional'),
  (date '2026-10-08', 'Combate de Angamos',                      'nacional'),
  (date '2026-11-01', 'Día de Todos los Santos',                 'nacional'),
  (date '2026-12-08', 'Inmaculada Concepción',                   'nacional'),
  (date '2026-12-09', 'Batalla de Ayacucho',                     'nacional'),
  (date '2026-12-25', 'Navidad',                                 'nacional'),
  -- 2027
  (date '2027-01-01', 'Año Nuevo',                               'nacional'),
  (date '2027-03-25', 'Jueves Santo',                            'nacional'),
  (date '2027-03-26', 'Viernes Santo',                           'nacional'),
  (date '2027-05-01', 'Día del Trabajo',                         'nacional'),
  (date '2027-06-07', 'Batalla de Arica y Día de la Bandera',    'nacional'),
  (date '2027-06-29', 'San Pedro y San Pablo',                   'nacional'),
  (date '2027-07-23', 'Día de la Fuerza Aérea del Perú',         'nacional'),
  (date '2027-07-28', 'Fiestas Patrias',                         'nacional'),
  (date '2027-07-29', 'Fiestas Patrias',                         'nacional'),
  (date '2027-08-06', 'Batalla de Junín',                        'nacional'),
  (date '2027-08-30', 'Santa Rosa de Lima',                      'nacional'),
  (date '2027-10-08', 'Combate de Angamos',                      'nacional'),
  (date '2027-11-01', 'Día de Todos los Santos',                 'nacional'),
  (date '2027-12-08', 'Inmaculada Concepción',                   'nacional'),
  (date '2027-12-09', 'Batalla de Ayacucho',                     'nacional'),
  (date '2027-12-25', 'Navidad',                                 'nacional')
on conflict (fecha) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) RLS — lectura `to authenticated`, escritura SOLO service-role.
--    Estas tres son tablas de parámetros: cualquiera del ERP las lee para mostrar
--    el cálculo; nadie las escribe desde el navegador (la anon/authenticated key
--    es pública). Al NO crear política de escritura, `authenticated` solo puede
--    SELECT; la service-role del backend salta RLS y escribe. Mismo criterio que
--    las tablas del motor de alertas (seguridad-03).
-- ────────────────────────────────────────────────────────────────────────────
do $$
declare t text;
begin
  foreach t in array array['comisiones_parametros','calendario_laboral','feriados'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('drop policy if exists %I on public.%I', t || '_sel', t);
    execute format(
      'create policy %I on public.%I for select to authenticated using (true)',
      t || '_sel', t);
  end loop;
end $$;

-- ── CONTRATO DE NOMBRES (el backend depende de esto) ────────────────────────
--   comisiones_parametros(id, vigente_desde, pct_eventual_tramo1, pct_eventual_tramo2,
--     tramo_eventual_hasta, pct_fijo, pct_bono_arranque, arranque_split,
--     arranque_mes_2da_parte, ventana_fijo_meses, ventana_cliente_nuevo_meses,
--     tope_bono_atencion, indicadores_json, fondo_admin_por_eventual)
--   calendario_laboral(id=1, dias_habiles int[] ISO, hora_inicio, hora_fin)
--   feriados(fecha PK, nombre, ambito)

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop table if exists public.feriados;
-- drop table if exists public.calendario_laboral;
-- drop table if exists public.comisiones_parametros;

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- select * from public.comisiones_parametros order by vigente_desde desc;
-- select * from public.calendario_laboral;
-- select count(*), min(fecha), max(fecha) from public.feriados;
