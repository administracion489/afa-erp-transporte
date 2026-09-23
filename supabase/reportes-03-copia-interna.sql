-- ════════════════════════════════════════════════════════════════════════════
-- reportes-03-copia-interna.sql
-- La copia del reporte de ocupación que le llega a AFA: interruptor y correos.
--
-- EL DEPLOY NO CORRE ESTE ARCHIVO. Y no hace falta correrlo para que nada
-- cambie: sin la tabla, `resolverCopiaInterna` lee la fila como ausente, la
-- copia sigue saliendo y sus direcciones siguen resolviéndose por la cascada de
-- siempre (REPORTE_OCUPACION_CORREOS → empresa_perfil.email). Byte a byte el
-- comportamiento anterior. Lo único que abre la migración es poder GOBERNARLO
-- desde una pantalla.
--
-- ─── POR QUÉ HACÍA FALTA ────────────────────────────────────────────────────
--
-- La copia interna es el correo que le sale a AFA por cada cliente al que se le
-- manda el reporte, y es la ÚNICA que lleva las sugerencias completas aunque el
-- cliente las tenga apagadas: la propuesta comercial la tiene que ver quien
-- puede decidirla. Su destinatario vivía en una VARIABLE DE ENTORNO de Vercel
-- —o sea, un control que el sistema LEE y que nadie puede tocar desde el ERP—,
-- que es el mismo defecto de `vehiculos_tercero.capacidad_tanque` sin
-- formulario. Lo reportó el dueño: «mejor que esté detallado, o un botón para
-- activar o desactivar el envío al área de operaciones de AFA».
--
-- ─── SE DECIDE UNA VEZ, NO POR CLIENTE ──────────────────────────────────────
--
-- El interruptor del CLIENTE (`clientes.reporte_ocupacion_activo`) es por
-- cliente porque enseñarle «te cabe una unidad más chica» es una decisión
-- comercial sobre ESE cliente. La copia interna es al revés: es el buzón de
-- AFA, y lo que AFA necesita es verlas TODAS. Por cliente sería una casilla que
-- alguien tiene que acordarse de marcar, y el día que no la marque operaciones
-- deja de ver las sugerencias de ese cliente sin que nada lo diga. Por eso es
-- una fila única, como `redes_config` y `radar_config`.
--
-- ─── EL DEFAULT ES `true`, Y AQUÍ ESO ES LO SEGURO ──────────────────────────
--
-- Al revés que `reporte_ocupacion_activo`, que nace en `false` porque encenderlo
-- manda un correo a un TERCERO que no lo pidió. Esta copia no sale de la
-- empresa: apagarla por omisión dejaría a operaciones sin las sugerencias el día
-- que alguien corra el SQL, sin que nada lo avise. Correr una migración no puede
-- cambiar lo que hace el sistema — solo `false` explícito apaga.
-- ════════════════════════════════════════════════════════════════════════════

create table if not exists public.reporte_ocupacion_config (
  -- Fila única, mismo candado que `redes_config` y `config_mantenimiento`.
  id                smallint primary key default 1 check (id = 1),

  -- ¿Sale la copia interna? `true` = el comportamiento de siempre.
  copia_afa_activa  boolean not null default true,

  -- A quién. Vacío = se cae a REPORTE_OCUPACION_CORREOS y después a
  -- `empresa_perfil.email`, que es la cascada que ya existía. Texto separado por
  -- coma/;/salto de línea, igual que `clientes.reporte_ocupacion_correos` y
  -- `config_mantenimiento.correos_alerta`: inventar un separador distinto en la
  -- tercera pantalla es cómo alguien pega una lista que el sistema lee como una
  -- sola dirección.
  copia_afa_correos text,

  updated_at        timestamptz not null default now()
);

comment on table public.reporte_ocupacion_config is
  'Fila única: si la copia interna del reporte de ocupación sale y a quién. La '
  'decisión es de AFA y es una sola, no una por cliente.';

comment on column public.reporte_ocupacion_config.copia_afa_activa is
  'Si operaciones recibe su copia (la que SIEMPRE lleva las sugerencias, aunque '
  'el cliente las tenga apagadas). Nace en true: la copia ya salía antes de esta '
  'tabla, y correr el SQL no puede apagarla.';

comment on column public.reporte_ocupacion_config.copia_afa_correos is
  'Destinatarios de la copia interna, separados por coma. Vacío = se usa la '
  'variable REPORTE_OCUPACION_CORREOS y, si tampoco está, empresa_perfil.email.';

-- La fila nace con los defaults: activa y sin correos propios, que es
-- exactamente lo que el sistema hacía ayer.
insert into public.reporte_ocupacion_config (id)
  values (1)
  on conflict (id) do nothing;

-- ── RLS: SIN POLÍTICA PERMISIVA, IGUAL QUE LA BITÁCORA ──────────────────────
--
-- Y no es prudencia de más: la pantalla NO PUEDE resolver esto por su cuenta.
-- Una de las tres fuentes de la cascada es `REPORTE_OCUPACION_CORREOS`, una
-- variable de entorno que solo existe en el servidor, así que un /reportes que
-- leyera esta fila directo enseñaría «sale al correo de la empresa» mientras el
-- cron le manda a la dirección de Vercel — la pantalla describiendo al revés lo
-- que hace el sistema, que es el defecto que este módulo vino a cerrar.
--
-- Por eso hay UNA sola puerta: `/api/reportes/copia-interna` (GET resuelve con
-- el mismo motor que el cron, POST guarda), detrás de
-- `verificarUsuarioApi("reportes")` y con service-role. Una política permisiva
-- sería una segunda puerta que nadie usa y que puede contestar distinto.
alter table public.reporte_ocupacion_config enable row level security;
