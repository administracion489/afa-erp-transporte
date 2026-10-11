-- ════════════════════════════════════════════════════════════════════════════
-- gps-equipo-01.sql
-- El estado del TELÉFONO del conductor llega a la oficina, y cada punto GPS
-- dice cuándo LLEGÓ al servidor.
--
-- EL DEPLOY NO CORRE ESTE ARCHIVO: se ejecuta a mano en Supabase → SQL Editor.
-- Es idempotente: correrlo dos veces no cambia nada (y la segunda vez no vuelve
-- a tomar el candado exclusivo de `ubicaciones_gps`, ver el paso 4).
--
-- CÓRRELO FUERA DE HORA PUNTA, sin buses en ruta. El paso 4 toma el candado
-- EXCLUSIVO de `ubicaciones_gps`, la tabla donde escribe toda la flota cada pocos
-- segundos. El cambio es solo de catálogo (milisegundos), pero para TOMAR el
-- candado espera a que terminen las lecturas en curso de esa tabla, y mientras
-- espera los INSERT de GPS se encolan detrás. El `lock_timeout` del paso 0 pone
-- el techo en 5 s; si salta, se vuelve a correr. No se pierde rastreo: la app del
-- conductor guarda los puntos en su cola y los manda al reconectar.
--
-- ─── POR QUÉ HACÍA FALTA ────────────────────────────────────────────────────
--
-- Un conductor (VFC-962) tenía cortes de rastreo EN MOVIMIENTO mientras el resto
-- de la flota daba 100 %, y el ERP no sabía decir de quién era el problema:
--   · CONFIGURACIÓN del teléfono: batería con restricciones, ubicación «solo
--     mientras se usa», precisión aproximada, servicio de fondo caído;
--   · el EQUIPO: GPS que se pega o que solo entrega la ubicación de la antena;
--   · la RED MÓVIL: sin datos, los puntos se toman a tiempo pero llegan tarde.
-- La app del conductor ya comprobaba casi todo eso en el teléfono —y detectaba la
-- marca—, pero solo en memoria: ninguna acción de /api/conductor lo recibía. La
-- oficina veía solo la traza, que dice CUÁNTO se cortó pero no POR QUÉ.
--
-- Dos piezas, cada una con UNA fila autoritativa (regla de oro de
-- finanzas-00-fundacion.sql, aplicada fuera del dinero):
--   1. `gps_equipo_reportes`: el estado del teléfono, una fila por PERIODO en que
--      ese estado no cambió.
--   2. `ubicaciones_gps.recibido_en`: la hora en que el SERVIDOR recibió el punto.
--      `created_at` la pone el teléfono, y la cola offline manda el punto horas
--      después con esa misma hora: hasta hoy un punto que llegó tarde era
--      indistinguible de uno que llegó a tiempo.
--
-- ─── QUÉ PASA SI NO SE CORRE ────────────────────────────────────────────────
--
-- Nada se rompe. La acción `equipo_gps` responde `sin_migracion` y la app del
-- conductor deja de reportar por 6 h; el modal de diagnóstico de /seguimiento
-- (clic en la celda RASTREO) sale sin la sección «Su teléfono», con un ámbar que
-- nombra este archivo, y «Llegaron tarde» dice que no se puede medir. El % de
-- rastreo, la columna RASTREO y el resto de la torre no cambian.
--
-- ─── TIPOS DE LAS FK ────────────────────────────────────────────────────────
--
-- `conductores`, `conductores_tercero` y `reservas` se crearon desde el panel de
-- Supabase: su DDL no está en el repo. Las tres columnas que las referencian van
-- en `bigint`, como TODAS las columnas del repo que ya apuntan a esos ids
-- (push_suscripciones.conductor_id, checkout_conductor.conductor_id,
-- servicio_pacto.reserva_id, servicio_costo_estimado.reserva_id…). Una FK bigint
-- es válida tanto si la PK es bigint como si es integer (int8 → int4 comparten la
-- familia de operadores `integer_ops`), y `servicio_pacto` y
-- `servicio_costo_estimado` ya declaran `bigint references public.reservas(id)`
-- en producción. La consulta 0 de la revisión, al final, muestra el tipo real.
-- ════════════════════════════════════════════════════════════════════════════


-- ── 0) Candado con plazo ────────────────────────────────────────────────────
-- Este archivo toma candados sobre tablas muy escritas: ACCESS EXCLUSIVE sobre
-- `ubicaciones_gps` (paso 4) y, al crear las FK del paso 1, SHARE ROW EXCLUSIVE
-- sobre `reservas`, `conductores` y `conductores_tercero`. Si alguna está
-- ocupada, mejor FALLAR en 5 s con un mensaje claro que quedarse esperando con
-- los GPS de toda la flota encolados detrás. Más corto que los 15 s de los
-- pacto-*: allí el que espera es un operador guardando una reserva; aquí, el
-- rastreo de la flota entera. Reintentar es seguro: el SQL Editor corre el
-- archivo en UNA transacción y, si algo falla, se revierte completo.
set lock_timeout = '5s';


-- ── 1) gps_equipo_reportes: el estado del teléfono del conductor ────────────
--
-- Cada fila es un PERIODO en que el estado no cambió: desde `reportado_en` hasta
-- `visto_hasta`. El latido de la app (cada 10 min mientras comparte) solo ESTIRA
-- `visto_hasta` de la última fila de ese conductor y ese aparato; un cambio de
-- estado (otra `firma`) o un reporte de corte abre fila nueva.
--
-- TRES ESTADOS A PROPÓSITO en cada comprobación (por eso los booleanos admiten
-- NULL y NO tienen default):
--   true  → comprobado y bien;
--   false → comprobado y mal configurado;
--   NULL  → NO SE PUDO COMPROBAR (navegador, APK viejo, ajuste que el sistema no
--           deja leer).
-- Un default false convertiría «no lo sé» en «está mal», y el diagnóstico
-- mandaría al conductor a arreglar un ajuste que quizá está bien. Es la misma
-- regla que `ubicaciones_gps.simulado`.
create table if not exists public.gps_equipo_reportes (
  id bigint generated always as identity primary key,

  -- QUIÉN. El conductor vive en DOS tablas cuyos ids SE SOLAPAN (el 7 existe en
  -- las dos y son personas distintas): va llena exactamente UNA de las dos
  -- columnas. La pone el servidor desde el TOKEN de la sesión, nunca el cuerpo.
  conductor_id          bigint references public.conductores(id)         on delete cascade,
  conductor_tercero_id  bigint references public.conductores_tercero(id) on delete cascade,
  -- El servicio que tenía al reportar, SOLO si es suyo (reservaEsDelConductor).
  -- Borrar el servicio no borra lo que se supo del teléfono.
  reserva_id            bigint references public.reservas(id)            on delete set null,

  dispositivo  text not null,
  motivo       text not null,
  plataforma   text not null,
  user_agent   text,
  modelo       text,
  plugins      text[] not null default '{}',

  compartiendo           boolean,
  bateria_exenta         boolean,
  precision_ubicacion    text,
  todo_el_tiempo         boolean,
  ajustes_alta_precision boolean,
  servicio_fondo         boolean,
  gps_debil_m            integer,
  gps_atascado           boolean,
  pendientes_cola        integer,

  firma text not null,

  -- Reloj del SERVIDOR: inicio y fin del periodo.
  reportado_en timestamptz not null default now(),
  visto_hasta  timestamptz not null default now(),
  -- Reloj del TELÉFONO (solo si difiere < 48 h del servidor): la traza también
  -- va en hora del teléfono (`created_at`), y con esta se casa un reporte de
  -- corte con el final de un tramo sin rastreo.
  reportado_cliente_en timestamptz,
  visto_cliente_en     timestamptz,

  constraint gps_equipo_un_conductor   check (num_nonnulls(conductor_id, conductor_tercero_id) = 1),
  constraint gps_equipo_dispositivo_ck check (dispositivo ~ '^[A-Za-z0-9-]{8,64}$'),
  constraint gps_equipo_motivo_ck      check (motivo in ('arranque','cambio','latido','corte')),
  constraint gps_equipo_plataforma_ck  check (plataforma in ('apk','ios','navegador')),
  constraint gps_equipo_precision_ck   check (precision_ubicacion is null or precision_ubicacion in ('precisa','aproximada')),
  constraint gps_equipo_ua_ck          check (user_agent is null or char_length(user_agent) <= 300),
  constraint gps_equipo_modelo_ck      check (modelo is null or char_length(modelo) <= 60),
  constraint gps_equipo_debil_ck       check (gps_debil_m is null or gps_debil_m between 0 and 100000),
  constraint gps_equipo_cola_ck        check (pendientes_cola is null or pendientes_cola >= 0),
  constraint gps_equipo_visto_ck       check (visto_hasta >= reportado_en)
);

-- Índices para las DOS lecturas reales, parciales porque cada fila llena solo
-- una de las dos columnas de conductor:
--   · el dedupe del servidor: «la última fila de este conductor en este aparato»
--     (order by reportado_en desc limit 1);
--   · el modal: los reportes de un conductor alrededor de la ventana del servicio
--     (usa la primera columna del índice).
-- Los mismos índices sirven al `on delete cascade` de las FK de conductor, y el
-- de `reserva_id` al `on delete set null` cuando se borra un servicio en lote.
create index if not exists gps_equipo_cond_idx
  on public.gps_equipo_reportes (conductor_id, dispositivo, reportado_en desc)
  where conductor_id is not null;
create index if not exists gps_equipo_cond_ter_idx
  on public.gps_equipo_reportes (conductor_tercero_id, dispositivo, reportado_en desc)
  where conductor_tercero_id is not null;
create index if not exists gps_equipo_reserva_idx
  on public.gps_equipo_reportes (reserva_id)
  where reserva_id is not null;


-- ── 2) Seguridad: RLS SIN políticas, solo service-role ──────────────────────
--
-- La anon key va en el JavaScript público: `anon` = cualquiera en internet. Y
-- tampoco va `to authenticated`: dejaría leer el teléfono de cada conductor a
-- cualquier usuario del ERP, tenga o no el módulo Seguimiento. Hay UNA puerta de
-- escritura (/api/conductor, acción `equipo_gps`, identidad del token) y UNA de
-- lectura (/api/seguimiento/rastreo/diagnostico, detrás de
-- verificarUsuarioApi("seguimiento")), las dos con service-role, que no mira RLS.
-- Una política permisiva sería una segunda puerta que puede contestar distinto —
-- mismo criterio que `whatsapp_tokens` y `reporte_ocupacion_config`.
--
-- El bucle 1 de seguridad-01-rls.sql solo toca tablas SIN RLS, así que volver a
-- correrlo no le agrega a esta la política `_authenticated` abierta.
--
-- Las FK no se rompen por esto: las acciones `on delete cascade` / `set null` que
-- dispara borrar un conductor o un servicio desde el ERP corren como dueño de la
-- tabla y no están sujetas a RLS.
alter table public.gps_equipo_reportes enable row level security;

-- Supabase le da a toda tabla nueva de `public` el GRANT por defecto a anon y
-- authenticated. Con RLS y sin políticas ya no ven filas; se quita igual, para
-- que el permiso diga lo mismo que el diseño.
revoke all on public.gps_equipo_reportes from anon, authenticated;
-- Lo que sí tiene que poder, explícito (es lo que da el default de Supabase; si
-- una instalación no lo tuviera, el reporte fallaría con «permission denied»).
grant select, insert, update, delete on public.gps_equipo_reportes to service_role;

-- La secuencia de `id` nace con el mismo GRANT por defecto. No expone ninguna
-- fila, pero ningún rol del navegador tiene por qué tocarla; la columna es
-- GENERATED ALWAYS, así que el INSERT del servidor no necesita permiso sobre ella.
-- Se busca por `pg_get_serial_sequence` en vez de escribir su nombre a mano.
do $$
declare s text := pg_get_serial_sequence('public.gps_equipo_reportes', 'id');
begin
  if s is not null then
    execute format('revoke all on sequence %s from anon, authenticated', s);
  end if;
end $$;


-- ── 3) Documentación en la base ─────────────────────────────────────────────
comment on table public.gps_equipo_reportes is
  'Estado del TELÉFONO del conductor (lo que decide si el rastreo GPS se corta). '
  'Cada fila es un PERIODO sin cambio de estado: reportado_en → visto_hasta; el '
  'latido solo estira visto_hasta, un cambio de firma o un corte abre fila nueva. '
  'Comprobaciones TRI-ESTADO: null = no se pudo comprobar, nunca false por no '
  'saber. La marca y la versión de Android NO se guardan: se derivan del '
  'user_agent al leer (fabricanteDeUA, lib/gps-equipo.ts). Escribe SOLO '
  '/api/conductor (acción equipo_gps, service-role, identidad del token); lee SOLO '
  '/api/seguimiento/rastreo/diagnostico (service-role). RLS sin políticas. '
  'Migración: supabase/gps-equipo-01.sql.';

comment on column public.gps_equipo_reportes.conductor_id is
  'Conductor de la flota propia (tabla conductores). Exactamente una de '
  'conductor_id / conductor_tercero_id va llena: los ids de las dos tablas se '
  'solapan. La pone el servidor desde el token, nunca el cuerpo del pedido.';
comment on column public.gps_equipo_reportes.conductor_tercero_id is
  'Conductor tercerizado (tabla conductores_tercero). Ver conductor_id.';
comment on column public.gps_equipo_reportes.reserva_id is
  'Servicio que tenía al reportar, solo si es suyo (reservaEsDelConductor); si no, '
  'null. Borrar el servicio deja la fila con null.';
comment on column public.gps_equipo_reportes.dispositivo is
  'Identificador del APARATO: UUID guardado en localStorage (afa_dispositivo_v1), '
  'que no se borra al cerrar sesión. Separa dos teléfonos del mismo conductor.';
comment on column public.gps_equipo_reportes.motivo is
  'Por qué se mandó: arranque (la app abrió con sesión), cambio (otra firma), '
  'latido (cada 10 min mientras comparte; con la misma firma solo estira '
  'visto_hasta) o corte (al abrir había un servicio guardado y el último latido '
  'de la app tenía más de 4 min: el sistema o el conductor cerró la app). Un '
  'corte nunca se funde con la fila anterior.';
comment on column public.gps_equipo_reportes.plataforma is
  'apk | ios | navegador (Capacitor.getPlatform()). En navegador el rastreo de '
  'fondo no existe: es por sí sola una falta de configuración.';
comment on column public.gps_equipo_reportes.user_agent is
  'Cabecera User-Agent del pedido (no del cuerpo), recortada a 300. De aquí se '
  'derivan al leer la marca, el modelo y la versión de Android. Ojo: Chrome para '
  'Android envía un UA reducido (Android 10; K).';
comment on column public.gps_equipo_reportes.modelo is
  'Modelo que entrega el navegador por Client Hints (getHighEntropyValues), '
  'best-effort. null = no lo entregó; el lector cae a lo que diga el user_agent.';
comment on column public.gps_equipo_reportes.plugins is
  'Plugins nativos que respondieron (Capacitor.isPluginAvailable): AfaNative, '
  'BackgroundGeolocation. De aquí se deduce el nivel del APK: la versión no se '
  'puede leer desde la app.';
comment on column public.gps_equipo_reportes.compartiendo is
  'Si el conductor tenía el rastreo encendido al reportar.';
comment on column public.gps_equipo_reportes.bateria_exenta is
  'App exenta de la optimización de batería. Tri-estado: null = no se pudo comprobar.';
comment on column public.gps_equipo_reportes.precision_ubicacion is
  'Permiso de ubicación precisa o aproximada. null = no se pudo comprobar.';
comment on column public.gps_equipo_reportes.todo_el_tiempo is
  'Permiso de ubicación «Permitir todo el tiempo» (no solo mientras se usa). '
  'Tri-estado: null = no se pudo comprobar.';
comment on column public.gps_equipo_reportes.ajustes_alta_precision is
  'Ajustes de ubicación del sistema en alta precisión. Tri-estado: null = el '
  'sistema no lo dejó leer.';
comment on column public.gps_equipo_reportes.servicio_fondo is
  'Servicio de rastreo en segundo plano corriendo, MEDIDO (no el valor optimista '
  'con que la app arranca). Tri-estado: null = no se pudo comprobar.';
comment on column public.gps_equipo_reportes.gps_debil_m is
  'Precisión mediana medida del GPS, en metros (≥ 12 m = ubicación de red, no '
  'satélite). null = sin muestras: no es 0.';
comment on column public.gps_equipo_reportes.gps_atascado is
  'El GPS entrega el mismo fix sin avanzar. Tri-estado: null = no se pudo comprobar.';
comment on column public.gps_equipo_reportes.pendientes_cola is
  'Puntos GPS esperando en la cola offline del teléfono al reportar. No entra en '
  'la firma: cambia con cada punto.';
comment on column public.gps_equipo_reportes.firma is
  'firmaEstado (lib/gps-equipo.ts), la MISMA función en el teléfono y en el '
  'servidor. Excluye motivo, pendientes_cola y el número de gps_debil_m (solo '
  'cuenta si supera 12 m). Misma firma = mismo periodo.';
comment on column public.gps_equipo_reportes.reportado_en is
  'Hora del SERVIDOR en que empezó el periodo.';
comment on column public.gps_equipo_reportes.visto_hasta is
  'Hora del SERVIDOR del último reporte con la misma firma (el latido la estira).';
comment on column public.gps_equipo_reportes.reportado_cliente_en is
  'Reloj del TELÉFONO al empezar el periodo, solo si difería < 48 h del servidor '
  '(si no, null). Sirve para casar con la traza, que también va en hora del teléfono.';
comment on column public.gps_equipo_reportes.visto_cliente_en is
  'Reloj del TELÉFONO del último reporte del periodo. Ver reportado_cliente_en.';


-- ── 4) ubicaciones_gps.recibido_en: la hora de RECEPCIÓN ────────────────────
--
-- VA AL FINAL A PROPÓSITO: el ALTER toma ACCESS EXCLUSIVE sobre la tabla de GPS
-- y lo retiene hasta el final de la transacción (el SQL Editor corre todo el
-- archivo en una). Lo último que se toma es lo que menos tiempo se retiene.
--
-- EN DOS PASOS, y es lo único delicado de este archivo: en PostgreSQL 11+,
-- `add column … default now()` NO reescribe la tabla, pero guarda la hora del
-- ALTER como valor «missing» fijo, y TODAS las filas viejas la devolverían:
-- millones de puntos parecerían recibidos hoy, a la vez, y el diagnóstico los
-- leería como una avalancha de llegadas tardías. Así, primero la columna NULLABLE
-- sin default (las viejas quedan en NULL = «no se sabe») y después el default,
-- que solo afecta a los INSERT que vengan. Los dos pasos son solo de catálogo.
--
-- La pone el SERVIDOR: el default de la base, nunca el teléfono (`sanitizar` de
-- /api/conductor no la deja pasar). Una cola offline que llega en lote recibe la
-- misma hora en todos sus puntos, que es justo lo que delata la llegada tardía.
--
-- SIN BACKFILL: rellenarla con `created_at` afirmaría que cada punto viejo llegó a
-- tiempo, que es justo lo que no se sabe (y un UPDATE sobre toda la tabla
-- reescribiría millones de filas con la flota escribiendo). El diagnóstico solo
-- mide llegadas tardías sobre filas con `recibido_en`.
--
-- SIN ÍNDICE: se lee siempre junto con la traza, por `reserva_id`, que ya tiene el
-- suyo. Y un CREATE INDEX aquí bloquearía los INSERT de GPS mientras construye
-- (ver ubicaciones-gps-simulado.sql).
--
-- Dentro de un DO para que la SEGUNDA corrida no tome el candado exclusivo en
-- vano: cada paso se da solo si falta.
do $$
begin
  -- Paso A: la columna, NULLABLE y SIN default.
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ubicaciones_gps'
       and column_name = 'recibido_en'
  ) then
    alter table public.ubicaciones_gps add column recibido_en timestamptz;
  end if;

  -- Paso B: el default, DESPUÉS de crear la columna.
  if exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'ubicaciones_gps'
       and column_name = 'recibido_en' and column_default is null
  ) then
    alter table public.ubicaciones_gps alter column recibido_en set default now();
  end if;
end $$;

comment on column public.ubicaciones_gps.recibido_en is
  'Hora en que el SERVIDOR recibió el punto (default now() de la base; el teléfono '
  'no la puede mandar). created_at es la hora del teléfono: recibido_en − created_at '
  'mide cuánto tardó en llegar. NULL = punto anterior a esta columna: no se sabe. '
  'Migración: supabase/gps-equipo-01.sql.';

-- No dejar el plazo de 5 s pegado a la sesión del SQL Editor. (Si algo falló, el
-- SET se revirtió junto con la transacción y esta línea no hace falta.)
reset lock_timeout;


-- ════════════════════════════════════════════════════════════════════════════
-- REVISIÓN (después de correrlo). Comentadas a propósito: se copian de a una.
-- ════════════════════════════════════════════════════════════════════════════
--
-- 0) El tipo real de las PK referenciadas (para el registro; las FK bigint valen
--    con integer o bigint):
-- select table_name, data_type
--   from information_schema.columns
--  where table_schema = 'public' and column_name = 'id'
--    and table_name in ('conductores', 'conductores_tercero', 'reservas');
--
-- 1) El default de recibido_en quedó puesto (debe decir now()) y admite NULL:
-- select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--  where table_schema = 'public' and table_name = 'ubicaciones_gps'
--    and column_name = 'recibido_en';
--
-- 2) Se agregó en DOS pasos: sin valor «missing» guardado (debe salir false). Si
--    sale true, las filas viejas devuelven la hora del ALTER: avisar antes de
--    seguir, el diagnóstico de llegadas tardías estaría leyendo un dato falso.
-- select attname, atthasmissing
--   from pg_attribute
--  where attrelid = 'public.ubicaciones_gps'::regclass and attname = 'recibido_en';
--
-- 3) Las filas VIEJAS siguen en NULL (por la clave primaria, sin recorrer la tabla):
-- select id, created_at, recibido_en
--   from public.ubicaciones_gps order by id asc limit 5;
--
-- 4) Las filas NUEVAS ya traen la hora de recepción (con algún bus en ruta, a los
--    pocos minutos). `retraso` es lo que tardó cada punto en llegar:
-- select id, created_at, recibido_en, recibido_en - created_at as retraso
--   from public.ubicaciones_gps order by id desc limit 10;
--
-- 5) La tabla tiene RLS y NINGUNA política (las dos: true, y 0 filas):
-- select relrowsecurity from pg_class where oid = 'public.gps_equipo_reportes'::regclass;
-- select policyname, roles, cmd
--   from pg_policies where schemaname = 'public' and tablename = 'gps_equipo_reportes';
--
-- 6) Ni anon ni authenticated tienen permiso; service_role sí (false, false, true):
-- select has_table_privilege('anon',          'public.gps_equipo_reportes', 'select') as anon_lee,
--        has_table_privilege('authenticated', 'public.gps_equipo_reportes', 'select') as erp_lee,
--        has_table_privilege('service_role',  'public.gps_equipo_reportes', 'insert') as servidor_escribe;
--
-- 7) La secuencia de id tampoco (false, false):
-- select has_sequence_privilege('anon',
--          pg_get_serial_sequence('public.gps_equipo_reportes', 'id'), 'usage') as anon_seq,
--        has_sequence_privilege('authenticated',
--          pg_get_serial_sequence('public.gps_equipo_reportes', 'id'), 'usage') as erp_seq;
--
-- 8) Las restricciones quedaron como se diseñaron:
-- select conname, pg_get_constraintdef(oid)
--   from pg_constraint
--  where conrelid = 'public.gps_equipo_reportes'::regclass order by conname;
--
-- 9) Cuando la app nueva esté en los teléfonos: los primeros reportes.
-- select id, conductor_id, conductor_tercero_id, dispositivo, motivo, plataforma,
--        bateria_exenta, todo_el_tiempo, servicio_fondo, reportado_en, visto_hasta
--   from public.gps_equipo_reportes order by id desc limit 20;
