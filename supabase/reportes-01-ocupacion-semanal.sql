-- ════════════════════════════════════════════════════════════════════════════
-- reportes-01-ocupacion-semanal.sql
-- El reporte semanal de ocupación: a quién se le manda y qué se le manda.
--
-- EL DEPLOY NO CORRE ESTE ARCHIVO. Hasta que alguien lo ejecute, el cron
-- responde `sin_migracion` y no manda NADA — que es el lado correcto: un correo
-- que sale sin que nadie lo haya configurado va a un cliente que no lo pidió.
--
-- ─── POR QUÉ LA CONFIGURACIÓN ES POR CLIENTE ────────────────────────────────
--
-- Lo pidió el dueño así: «que llegue al cliente y a AFA, pero no a todos los
-- clientes — algunos sí y otros no, configurable desde la lista de clientes».
-- Tiene sentido comercial: la sugerencia de bajar de vehículo es ofrecerle a un
-- cliente pagar menos, y eso se decide cliente por cliente, no de una vez.
--
-- ─── LOS TRES DEFAULTS SON `false`, Y ESO ES LO QUE HACE SEGURA LA MIGRACIÓN ─
--
-- Correr este SQL NO empieza a mandar correos. Cada cliente se enciende a mano.
-- Sembrar `true` mandaría, el primer sábado, un correo con la ocupación de sus
-- rutas a TODOS los clientes de la base sin que nadie lo haya decidido — y en la
-- instalación de un comprador del ERP, a los suyos. Es el mismo criterio del
-- `default '{personal}'` de `redes_config.lineas` y del perfil de empresa.
-- ════════════════════════════════════════════════════════════════════════════

-- ── 1) A quién se le manda ──────────────────────────────────────────────────

alter table public.clientes
  add column if not exists reporte_ocupacion_activo boolean not null default false;

comment on column public.clientes.reporte_ocupacion_activo is
  'Si este cliente recibe el reporte semanal de ocupación cada sábado. Nace en '
  'false: encenderlo es una decisión comercial que se toma cliente por cliente.';

-- Destinatarios PROPIOS del reporte. Si está vacío se cae a `email` y
-- `email_facturacion`, que es donde ya está escrito el contacto del cliente.
-- Se guarda como texto separado por comas/;/espacios, igual que
-- `config_mantenimiento.correos_alerta`, para no inventar un formato nuevo.
alter table public.clientes
  add column if not exists reporte_ocupacion_correos text;

comment on column public.clientes.reporte_ocupacion_correos is
  'Correos que reciben el reporte semanal, separados por coma. Vacío = se usan '
  'clientes.email y clientes.email_facturacion.';

-- ¿A ESTE cliente se le enseña la sugerencia de cambiar de vehículo?
--
-- Va APARTE del interruptor de arriba porque son dos decisiones distintas: los
-- DATOS de ocupación son hechos sobre su propio servicio y se pueden mandar
-- siempre; la SUGERENCIA es una propuesta comercial. Un cliente puede querer el
-- reporte sin que AFA le proponga nada. `CODIGO_ES_PROPUESTA` en
-- lib/ocupacion/semanal.ts es quien decide qué fila cae de este lado.
--
-- Nace en `true` —a diferencia de los otros dos— porque solo tiene efecto sobre
-- clientes que YA se encendieron a mano: quien enciende el reporte lo hace para
-- que sirva, y apagar la sugerencia es el caso raro.
alter table public.clientes
  add column if not exists reporte_ocupacion_sugerencias boolean not null default true;

comment on column public.clientes.reporte_ocupacion_sugerencias is
  'Si el reporte de este cliente incluye la sugerencia de cambio de vehículo. '
  'Solo aplica si reporte_ocupacion_activo. AFA la recibe siempre en su copia.';

-- ── 2) Qué se mandó, y el candado contra el envío doble ─────────────────────
--
-- Un cron se puede disparar dos veces (reintento de la plataforma, un "enviar
-- ahora" desde la pantalla). Un correo no se des-envía, así que el candado vive
-- en Postgres y no solo en el código — mismo criterio que el índice único
-- (publicacion_id, red) de redes_destinos.

create table if not exists public.reporte_ocupacion_envios (
  id             bigserial primary key,
  cliente_id     bigint not null references public.clientes(id) on delete cascade,
  periodo_inicio date not null,
  periodo_fin    date not null,
  -- 'cliente' | 'afa'. La copia interna de AFA se registra aparte: lleva las
  -- sugerencias aunque el cliente las tenga apagadas, así que no es el mismo envío.
  destino        text not null default 'cliente',
  destinatarios  text,
  servicios      int,
  rutas          int,
  sugerencias    int,
  -- Null = salió. Con texto = falló, y la fila queda para poder reintentar.
  error          text,
  enviado_en     timestamptz not null default now()
);

comment on table public.reporte_ocupacion_envios is
  'Bitácora del reporte semanal de ocupación. Su índice único es lo que impide '
  'que un reintento del cron mande el mismo correo dos veces.';

-- Solo los envíos EXITOSOS bloquean: si falló, el próximo tick tiene que poder
-- reintentar. Es la misma razón por la que `error` es nullable y no un booleano.
create unique index if not exists uq_reporte_ocupacion_envio
  on public.reporte_ocupacion_envios (cliente_id, destino, periodo_fin)
  where error is null;

create index if not exists idx_reporte_ocupacion_cliente
  on public.reporte_ocupacion_envios (cliente_id, periodo_fin desc);

alter table public.reporte_ocupacion_envios enable row level security;

-- Sin política permisiva: la bitácora la escribe el cron con service-role y la
-- lee el ERP por el mismo camino. Un cliente del portal no tiene por qué saber a
-- quién más se le manda un reporte.
