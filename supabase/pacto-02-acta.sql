-- ══════════════════════════════════════════════════════════════════════════════
-- PACTO DEL SERVICIO · FASE 1 (a) — EL ACTA
--
-- Requiere: pacto-00-tributario.sql y pacto-01-costeo.sql
--
-- Hasta hoy el ERP no tiene UNA SOLA tabla de historial. Cambiar el proveedor, el
-- costo o el precio de un servicio es un UPDATE anónimo lanzado desde el navegador
-- con la llave pública: nadie puede decir quién cambió qué, cuándo ni por qué. Por eso
-- "el operador debe crear otra cotización" no era una regla, era un pedido.
--
-- Esta fase crea el acta y los estados. NO bloquea nada todavía: la política nace en
-- modo `observa` y durante dos semanas el sistema solo REGISTRA. Con ese inventario
-- real se decide en la fase 4 dónde poner el candado. Nadie pone un candado en una
-- puerta cuyos usuarios no conoce.
--
-- Dos decisiones de diseño que conviene entender antes de leer el DDL:
--
--   1. El acta la escribe un TRIGGER, no la aplicación. Como las escrituras salen del
--      navegador, cualquier regla puesta en pantalla se salta con solo abrir la
--      consola. Solo lo que corre en Postgres es inevadible. La app tiene permiso de
--      LECTURA sobre el acta y nada más.
--
--   2. NO se guarda en `reservas` un puntero al pacto abierto. Se DERIVA (ver
--      v_servicios_pacto). Guardarlo obligaría al trigger de UPDATE a escribir otra
--      vez sobre `reservas` —recursión— y además duplicaría un dato que el acta ya
--      tiene. Regla de oro de finanzas-00:22-24.
--
-- Cómo correrlo: Supabase → SQL Editor → pegar y ejecutar. Es idempotente.
-- ══════════════════════════════════════════════════════════════════════════════

-- ────────────────────────────────────────────────────────────────────────────
-- 1) MOTIVOS — por qué cambió. Tabla y no enum: los motivos se afinan con el uso.
--    Son pocos y de un clic a propósito: si pedir el motivo cuesta escribir un
--    párrafo, el operador escribe "cambio" y el dato no sirve para nada.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pacto_motivo (
  clave                     text primary key,
  nombre                    text not null,
  lado                      text not null check (lado in ('venta','compra','ambos')),
  exige_evidencia           boolean not null default false,
  exige_conformidad_cliente boolean not null default false,
  activo                    boolean not null default true,
  orden                     int not null default 100
);

insert into public.pacto_motivo (clave,nombre,lado,exige_evidencia,exige_conformidad_cliente,orden) values
  ('cliente_unidad_mayor'  ,'El cliente pidió una unidad de mayor capacidad','ambos' ,true ,true ,10),
  ('cliente_unidad_menor'  ,'El cliente pidió una unidad menor'             ,'ambos' ,true ,true ,20),
  ('cliente_cambio_ruta'   ,'El cliente cambió ruta, horario o paradero'    ,'ambos' ,true ,true ,30),
  ('proveedor_sin_unidad'  ,'El proveedor no tenía unidad disponible'       ,'compra',false,false,40),
  ('proveedor_mejor_precio','Se consiguió un proveedor más barato'          ,'compra',false,false,50),
  ('proveedor_incumplio'   ,'El proveedor incumplió'                        ,'compra',false,false,60),
  ('precio_renegociado'    ,'Se renegoció el importe con el mismo proveedor','compra',false,false,65),
  ('averia_unidad'         ,'Avería o mantenimiento de la unidad'           ,'compra',false,false,70),
  ('correccion_carga'      ,'Corrección de un dato mal cargado'             ,'ambos' ,false,false,90),
  ('regularizacion'        ,'Regularización de datos anteriores al Pacto'   ,'ambos' ,false,false,95),
  ('otro'                  ,'Otro (explicar)'                               ,'ambos' ,false,false,99)
on conflict (clave) do nothing;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) POLÍTICA — una sola fila. Los umbrales son DATO, nunca constante en el código,
--    igual que las tasas de detracción de la fase 07. Cambiar cuándo se exige visto
--    bueno tiene que ser un UPDATE, no un despliegue.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pacto_politica (
  id                        smallint primary key default 1 check (id = 1),
  guardia_modo              text not null default 'observa'
                            check (guardia_modo in ('observa','exige')),
  margen_minimo_pct         numeric(5,2)  not null default 15,
  tolerancia_costo_pct      numeric(5,2)  not null default 10,
  tolerancia_costo_abs      numeric(12,2) not null default 100,
  auto_aprueba_si_mejora    boolean not null default true,
  exige_conformidad_cliente boolean not null default true,
  horas_para_pactar_costo   int not null default 24,
  horas_vence_visado        int not null default 48,
  bloquea_abono_sin_pacto   boolean not null default true,
  updated_at                timestamptz not null default now()
);
insert into public.pacto_politica (id) values (1) on conflict (id) do nothing;

comment on column public.pacto_politica.guardia_modo is
  'observa = el sistema solo REGISTRA lo que habría rechazado (fase 1 a 3). '
  'exige = el candado está puesto (fase 4). No se sube a exige sin revisar antes '
  'v_pacto_guardia_inventario: rompería escrituras que nadie inventarió.';
comment on column public.pacto_politica.tolerancia_costo_pct is
  'Con 10 % y S/ 100, el caso 500 → 550 queda AUTO-APROBADO y no molesta a gerencia. '
  'Bajarlo genera más visados; subirlo, menos control.';

-- ────────────────────────────────────────────────────────────────────────────
-- 3) FOLIO PROPIO. No se toca folio_secuencia: esa es la de las OS.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.pacto_secuencia (
  clave text primary key,           -- 'PSV-2026' | 'PSC-2026'
  ultimo int not null default 0
);

create or replace function public.fn_pacto_folio(p_pref text)
returns text language plpgsql security definer set search_path = public, pg_temp as $$
declare v_clave text; v_n int;
begin
  -- Perú es UTC-5: con now() pelado, un cambio hecho a las 8 p.m. del 31-dic saltaría
  -- de año. Mismo criterio que el resto del ERP.
  v_clave := p_pref || '-' || extract(year from (now() at time zone 'America/Lima'))::int::text;
  insert into public.pacto_secuencia (clave, ultimo) values (v_clave, 1)
    on conflict (clave) do update set ultimo = public.pacto_secuencia.ultimo + 1
    returning ultimo into v_n;
  return v_clave || '-' || lpad(v_n::text, 6, '0');
end $$;

-- ────────────────────────────────────────────────────────────────────────────
-- 4) EL ACTA. Append-only: nunca se actualiza una fila salvo para visarla.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.servicio_pacto (
  id            bigserial primary key,
  codigo        text unique,               -- PSC-2026-000118 (compra) · PSV- (venta)
  reserva_id    bigint not null references public.reservas(id) on delete cascade,
  cotizacion_id int,                       -- desnormalizado: sobrevive al borrado
  lado          text not null check (lado in ('venta','compra','recurso')),
  version       int  not null default 1,
  origen        text not null default 'gesto'
                check (origen in ('gesto','apertura','regularizacion','importacion')),

  -- ── ANTES / DESPUÉS ──
  contraparte_antes_id   int,              -- cliente (venta) | tercerizada (compra)
  contraparte_despues_id int,
  unidad_antes           text,             -- placa o etiqueta legible
  unidad_despues         text,
  monto_antes            numeric(14,2),
  monto_despues          numeric(14,2),
  delta numeric(14,2) generated always as
        (coalesce(monto_despues,0) - coalesce(monto_antes,0)) stored,
  -- La afectación es parte del hecho económico: el mismo importe con otro tratamiento
  -- de IGV es otro costo real. Sin esto el acta no permitiría reconstruir el margen.
  afectacion_antes   text,
  afectacion_despues text,

  -- ── IMPACTO congelado: evidencia de la decisión, no dato recalculable ──
  margen_pct_antes   numeric(7,2),
  margen_pct_despues numeric(7,2),
  severidad text check (severidad in ('inicial','neutro','mejora','deterioro','critico')),
  veredicto text,                          -- el porqué, en castellano, para la UI

  -- ── INTENCIÓN ──
  motivo_clave  text references public.pacto_motivo(clave),
  motivo_nota   text,
  evidencia_url text,                      -- ruta dentro del bucket PRIVADO comprobantes
  usuario       uuid,

  -- ── GOBIERNO (mismo eje que documentos_compra.estado_aprobacion) ──
  estado_visado text not null default 'no_requiere'
                check (estado_visado in ('no_requiere','pendiente','aprobado','rechazado')),
  fecha_limite     timestamptz,
  aprobado_por     uuid,
  fecha_aprobacion timestamptz,
  motivo_rechazo   text,

  -- ── CONFORMIDAD DEL CLIENTE (se usa en la fase 5; las columnas nacen aquí) ──
  token text unique,
  conformidad_estado text not null default 'no_aplica'
       check (conformidad_estado in ('no_aplica','pendiente','conforme','observada')),
  conformidad_por text, conformidad_cargo text, conformidad_at timestamptz,
  conformidad_ip  text, conformidad_comentario text,

  -- ── CIERRE CONTABLE: un mes liquidado no se reescribe (fase 6) ──
  liquidacion_congelada_id bigint,
  efecto_cierre text not null default 'no_aplica'
       check (efecto_cierre in ('no_aplica','pendiente_regularizar','regularizado_nota',
                                'regularizado_periodo_siguiente','asumido')),

  -- ── Foto del contexto al momento del hecho ──
  estado_reserva text, estado_admin text, estado_proveedor text,
  liquidado_cliente boolean, liquidado_proveedor boolean,
  creado_at timestamptz not null default now()
);

create index if not exists idx_pacto_reserva on public.servicio_pacto (reserva_id, lado, version desc);
create index if not exists idx_pacto_cot     on public.servicio_pacto (cotizacion_id, creado_at desc);
create index if not exists idx_pacto_motivo  on public.servicio_pacto (motivo_clave, creado_at desc);
create index if not exists idx_pacto_visado  on public.servicio_pacto (fecha_limite)
  where estado_visado = 'pendiente';
create index if not exists idx_pacto_regular on public.servicio_pacto (efecto_cierre)
  where efecto_cierre = 'pendiente_regularizar';

comment on table public.servicio_pacto is
  'El acta de todo cambio económico de un servicio. La escribe un trigger, no la app: '
  'las escrituras del ERP salen del navegador y cualquier regla de pantalla se salta. '
  'Append-only — solo se actualiza para visar o para marcar el efecto de cierre.';

-- ────────────────────────────────────────────────────────────────────────────
-- 5) ESTADOS DEL MONTO en `reservas`.
--
--    NO se cambia el tipo ni el significado de precio_cliente / costo_proveedor: los
--    38 escritores y las 17 pantallas que hoy los leen siguen viendo lo mismo. Lo que
--    se agrega es qué SIGNIFICA su cero, que hoy es ambiguo:
--
--      pendiente  → nadie pactó nada. Es deuda con plazo.
--      pactado    → hay importe acordado.
--      incluido   → la tarifa va en el tramo hermano (el retorno de un par).
--      no_aplica  → flota propia, no hay proveedor a quien pagarle.
--
--    Volver NULL el importe habría sido lo semánticamente correcto y lo
--    operativamente suicida: hay once lugares que fuerzan el nulo a cero, incluidos
--    los tres de liquidacion-agrupacion.ts que deciden el bloqueo.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists costo_estado      text,
  add column if not exists precio_estado     text,
  add column if not exists costo_pactado_at  timestamptz,
  add column if not exists costo_limite_at   timestamptz,
  add column if not exists precio_pactado_at timestamptz,
  add column if not exists cambio_motivo     text,
  add column if not exists cambio_nota       text,
  add column if not exists cambio_at         timestamptz,
  add column if not exists actualizado_at    timestamptz,
  add column if not exists actualizado_por   uuid;

alter table public.reservas drop constraint if exists reservas_costo_estado_check;
alter table public.reservas add constraint reservas_costo_estado_check
  check (costo_estado is null or costo_estado in ('pendiente','pactado','incluido','no_aplica'));
alter table public.reservas drop constraint if exists reservas_precio_estado_check;
alter table public.reservas add constraint reservas_precio_estado_check
  check (precio_estado is null or precio_estado in ('pendiente','pactado','incluido','no_aplica'));

comment on column public.reservas.costo_estado is
  'Resuelve la ambigüedad del cero SIN cambiar el tipo de costo_proveedor. Un retorno '
  '"incluido" deja de aparecer en el rojo de /liquidaciones, que es lo que infla las '
  'líneas rojas a casi el doble de los problemas reales.';
comment on column public.reservas.cambio_motivo is
  'Lo declara quien guarda el cambio (clave de pacto_motivo). El trigger lo copia al '
  'acta y lo limpia, para que no quede pegado al siguiente cambio.';

create index if not exists idx_reservas_costo_estado
  on public.reservas (costo_estado, fecha_servicio) where costo_estado = 'pendiente';

-- ────────────────────────────────────────────────────────────────────────────
-- 6) RLS — una sentencia explícita por tabla.
--
--    Las CUATRO tablas que crea este archivo quedan con RLS. Va escrito una por una y
--    no en un bucle dinámico a propósito: el `execute format(...)` funcionaba igual,
--    pero la postura de seguridad de un archivo tiene que leerse de un vistazo, y el
--    analizador del editor de Supabase —que lee el texto del SQL— no puede mirar
--    dentro de un bloque dinámico y avisaba "crea tablas sin RLS" sobre tablas que sí
--    la tienen. Un aviso que es mentira enseña a ignorar los avisos.
--
--    La app SOLO LEE el acta: la escribe el trigger, que corre como dueño. El visado
--    es la única escritura legítima desde la app y va por RPC (fn_pacto_visar), no por
--    un update genérico.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.servicio_pacto  enable row level security;
alter table public.pacto_motivo    enable row level security;
alter table public.pacto_politica  enable row level security;
alter table public.pacto_secuencia enable row level security;

drop policy if exists p_pacto_select on public.servicio_pacto;
create policy p_pacto_select on public.servicio_pacto
  for select using (auth.role() = 'authenticated');

drop policy if exists pacto_motivo_auth on public.pacto_motivo;
create policy pacto_motivo_auth on public.pacto_motivo
  for select using (auth.role() = 'authenticated');

drop policy if exists pacto_politica_auth on public.pacto_politica;
create policy pacto_politica_auth on public.pacto_politica
  for select using (auth.role() = 'authenticated');

-- Los umbrales los edita un administrador desde el ERP; por eso esta sí acepta update.
drop policy if exists pacto_politica_rw on public.pacto_politica;
create policy pacto_politica_rw on public.pacto_politica
  for update using (auth.role() = 'authenticated') with check (auth.role() = 'authenticated');

-- pacto_secuencia queda con RLS y SIN policy: es el correlativo de los folios y nadie
-- tiene por qué leerlo ni tocarlo desde el navegador. Lo maneja fn_pacto_folio, que
-- corre como definer y no pasa por RLS.
drop policy if exists pacto_secuencia_auth on public.pacto_secuencia;

-- ══════════════════════════════════════════════════════════════════════════════
-- VERIFICACIÓN
--   select * from public.pacto_politica;
--   select clave, nombre, lado from public.pacto_motivo order by orden;
--   select public.fn_pacto_folio('PSC');     -- PSC-2026-000001
--
-- ROLLBACK
--   drop table if exists public.servicio_pacto;
--   drop function if exists public.fn_pacto_folio(text);
--   drop table if exists public.pacto_secuencia, public.pacto_politica, public.pacto_motivo;
--   -- las columnas de reservas son aditivas: se pueden dejar.
-- ══════════════════════════════════════════════════════════════════════════════
