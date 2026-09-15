-- ────────────────────────────────────────────────────────────────────────────
-- liquidaciones-03-ruta-contratada.sql — La RUTA por fin tiene ficha, y el
-- formato deja de inventar el "N PAX".
--
-- EL PROBLEMA QUE RESUELVE
--
-- Hasta aquí, la descripción de una línea de liquidación decía cosas como:
--
--     TRANSPORTE DE PERSONAL / 17 PAX / DEL 01-08 AL 31-08 / RUTA B / TURNO DÍA / MÓVIL 1
--
-- De esas seis piezas, CUATRO no existían como dato: "RUTA B" era un recorte del
-- nombre con un regex, "TURNO DÍA" se deducía de la hora, "MÓVIL 1" era un índice
-- calculado, y el "17 PAX" salía de la CAPACIDAD DEL BUS ASIGNADO.
--
-- Ese último es el que duele en el papel que firma el cliente: si se contrataron
-- 15 asientos y AFA, por disponibilidad, mandó un bus de 17, luego uno de 20 y
-- luego uno de 16, la liquidación declaraba 20 PAX sobre un contrato de 15. Es un
-- número con el que el cliente puede observar la factura, y lo generaba el ERP
-- solo, sin que nadie lo escribiera.
--
-- La causa de fondo: en todo el esquema NO había ninguna capacidad CONTRATADA.
-- Las únicas capacidades que existen —vehiculos.capacidad_pasajeros,
-- vehiculos_tercero.capacidad, parametros_costos.capacidad— son de la FLOTA, o
-- sea de lo que AFA tiene, no de lo que el cliente pidió. Y la ruta tampoco tenía
-- dónde vivir: existe únicamente como texto libre en reservas.ruta_nombre,
-- tecleado a mano en tres pantallas distintas.
--
-- LO QUE AGREGA ESTE ARCHIVO
--
--   1) reservas.capacidad_contratada       — snapshot por servicio, igual que ya
--                                            se hace con precio_cliente.
--   2) cliente_ruta                        — la ficha de la ruta contratada.
--   3) *_linea.pax_contratado              — snapshot en el documento emitido.
--
-- La resolución en cascada vive en la app (lib/liquidacion-rutas.ts):
--
--     línea editada a mano  →  reservas.capacidad_contratada
--                           →  ítem de la cotización (items_json)
--                           →  cliente_ruta
--                           →  NADA: se omite el "N PAX" y se avisa.
--
-- La última rama es la regla dura: **nunca se cae a la capacidad del vehículo**.
-- Un dato de menos es recuperable; un 20 donde el contrato dice 15 se descubre
-- cuando el cliente rechaza la valorización.
--
-- Requiere: supabase/liquidaciones-v2.sql (crea cliente_sedes y las liquidaciones).
-- ────────────────────────────────────────────────────────────────────────────

-- ────────────────────────────────────────────────────────────────────────────
-- 1) Normalizador del nombre de ruta
--
-- El nombre se escribe a mano en Programación, en el Manifiesto y en la torre de
-- control, así que "RUTA B/ ENTRADA 05:10/ CHILCA→BSF" y "ruta b/  entrada 05:10/
-- chilca→bsf" son la misma ruta para cualquiera que las mire. Sin esto, el
-- catálogo acumularía una fila por variante tipográfica y el pax contratado se
-- perdería justo el mes en que alguien tecleó un espacio de más.
--
-- IMMUTABLE porque se usa dentro de un índice único.
-- ────────────────────────────────────────────────────────────────────────────
create or replace function public.fn_norm_ruta(t text)
returns text
language sql
immutable
as $$
  select upper(regexp_replace(btrim(coalesce(t, '')), '\s+', ' ', 'g'))
$$;

-- ────────────────────────────────────────────────────────────────────────────
-- 2) La capacidad contratada viaja con el servicio
--
-- Snapshot, no derivación: el contrato puede renegociarse en junio y los
-- servicios de agosto tienen que seguir declarando lo que se pactó para agosto.
-- Es el mismo criterio con el que reservas ya guarda precio_cliente en vez de
-- leerlo de la cotización cada vez.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.reservas
  add column if not exists capacidad_contratada int;

comment on column public.reservas.capacidad_contratada is
  'Asientos CONTRATADOS por el cliente para este servicio. NO es la capacidad del '
  'vehículo asignado (esa está en vehiculos.capacidad_pasajeros y cambia según la '
  'disponibilidad del día). Lo copia el generador de programa desde el ítem de la '
  'cotización; es lo que imprime la liquidación.';

alter table public.reservas
  drop constraint if exists reservas_capacidad_contratada_check;
alter table public.reservas
  add constraint reservas_capacidad_contratada_check
  check (capacidad_contratada is null or capacidad_contratada > 0);

-- ────────────────────────────────────────────────────────────────────────────
-- 3) cliente_ruta — la ficha de la ruta contratada
--
-- Se identifica por el PAR de nombres (ida + retorno), que es exactamente la
-- clave con la que la liquidación agrupa sus líneas desde este cambio. Gracias a
-- eso cada línea del formato mapea 1:1 contra una fila de aquí: corriges el pax
-- una vez en el borrador, se guarda, y el mes siguiente ya sale bien solo.
--
-- nombre_retorno es NULL cuando la ruta es de un solo tramo. No se rellena con ''
-- por comodidad: null significa "no tiene retorno" y '' significaría "tiene un
-- retorno sin nombre", que son dos cosas distintas al liquidar.
-- ────────────────────────────────────────────────────────────────────────────
create table if not exists public.cliente_ruta (
  id                bigserial primary key,
  cliente_id        bigint not null references public.clientes(id) on delete cascade,
  -- Una misma sede tiene la RUTA A de 15 y la RUTA C de 50: el pax es de la RUTA,
  -- no de la sede. La sede solo acota a qué grupo del cierre pertenece.
  cliente_sede_id   bigint references public.cliente_sedes(id) on delete set null,
  nombre_ida        text not null,      -- 'RUTA A/ ENTRADA 06:35/ SANTA ANITA→BSF PUNTA HERMOSA'
  nombre_retorno    text,               -- 'RUTA A/ RETORNO 17:00/ BSF PUNTA HERMOSA→SANTA ANITA'
  pax_contratado    int,
  notas             text,
  activo            boolean not null default true,
  created_at        timestamptz not null default now(),
  updated_at        timestamptz not null default now()
);

comment on table public.cliente_ruta is
  'Catálogo de rutas contratadas. Hasta ahora la ruta existía solo como texto libre '
  'en reservas.ruta_nombre y no había dónde guardar lo pactado con el cliente.';

alter table public.cliente_ruta
  drop constraint if exists cliente_ruta_pax_check;
alter table public.cliente_ruta
  add constraint cliente_ruta_pax_check
  check (pax_contratado is null or pax_contratado > 0);

-- Una sola ficha por ruta y cliente, sin importar cómo se tecleó el nombre.
create unique index if not exists uq_cliente_ruta_identidad
  on public.cliente_ruta (
    cliente_id,
    coalesce(cliente_sede_id, 0),
    public.fn_norm_ruta(nombre_ida),
    public.fn_norm_ruta(coalesce(nombre_retorno, ''))
  );

create index if not exists idx_cliente_ruta_cliente
  on public.cliente_ruta (cliente_id, activo);

-- ────────────────────────────────────────────────────────────────────────────
-- 4) El documento guarda el pax que imprimió
--
-- La liquidación es un snapshot: si mañana se corrige la ficha de la ruta, el
-- formato que el cliente ya firmó no puede cambiar de número por debajo.
-- ────────────────────────────────────────────────────────────────────────────
alter table public.liquidacion_cliente_linea
  add column if not exists pax_contratado int;
alter table public.liquidacion_proveedor_linea
  add column if not exists pax_contratado int;

-- ────────────────────────────────────────────────────────────────────────────
-- 5) RLS — mismo criterio que el resto del módulo: usuarios autenticados del ERP.
-- ────────────────────────────────────────────────────────────────────────────
do $$
begin
  execute 'alter table public.cliente_ruta enable row level security';
  execute 'drop policy if exists cliente_ruta_auth on public.cliente_ruta';
  execute
    'create policy cliente_ruta_auth on public.cliente_ruta for all '
    'using (auth.role() = ''authenticated'') with check (auth.role() = ''authenticated'')';
end $$;

-- ── Verificación sugerida ───────────────────────────────────────────────────
-- Rutas del periodo que todavía no tienen capacidad contratada (las que saldrán
-- sin el "N PAX" en el formato y con aviso en la pantalla de cierre):
--
--   select r.cliente_id, r.ruta_nombre, count(*) as servicios
--     from public.reservas r
--     left join public.cliente_ruta cr
--       on cr.cliente_id = r.cliente_id
--      and public.fn_norm_ruta(cr.nombre_ida) = public.fn_norm_ruta(r.ruta_nombre)
--    where r.fecha_servicio between '2026-08-01' and '2026-08-31'
--      and r.capacidad_contratada is null
--      and cr.id is null
--    group by 1, 2
--    order by servicios desc;
