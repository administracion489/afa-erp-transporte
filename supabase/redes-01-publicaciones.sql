-- ─────────────────────────────────────────────────────────────────────────────
-- redes-01-publicaciones.sql — El agente que publica todos los días.
--
-- EL DEPLOY NO CORRE ESTO. Hay que ejecutarlo a mano en Supabase → SQL Editor.
-- Hasta que se corra, /redes carga y lo DICE en ámbar nombrando este archivo, en vez
-- de fingir que guarda (mismo patrón que `faltaCanales` y `alertas-horario-conductor`).
--
-- CUATRO TABLAS, Y LA SEGUNDA ES LA QUE IMPORTA
--
--   redes_cuentas       — una credencial por red. Cifrada, service-role, nunca al
--                         navegador (mismo trato que `whatsapp_tokens`).
--   redes_publicaciones — el post del día: texto, pieza, modo de video.
--   redes_destinos      — UNA FILA POR RED. Es la fila autoritativa de «¿salió?».
--   redes_intentos      — bitácora append-only de cada llamada a cada plataforma.
--
-- POR QUÉ `redes_destinos` EXISTE Y NO ES UN `estado` EN LA PUBLICACIÓN
-- Un `estado` único en `redes_publicaciones` tendría que contestar «¿se publicó?» con
-- una sola palabra cuando Facebook salió, Instagram rechazó el caption y a YouTube le
-- faltaba el video. Cualquier valor que se eligiera —«publicada», «fallida», «parcial»—
-- sería falso para tres de las cinco, y la pantalla tendría que deducir el resto
-- leyendo un texto de error. Cada red triunfa o falla por su cuenta, así que cada una
-- tiene su fila con su código de motivo, su id externo y su enlace.
-- Es la regla de oro de `finanzas-00-fundacion.sql` aplicada fuera del dinero: un
-- hecho, una fila autoritativa.
--
-- EL ÍNDICE ÚNICO `(publicacion_id, red)` ES LA ÚLTIMA LÍNEA DE DEFENSA CONTRA EL
-- DOBLE POSTEO. El motor ya frena con `ya_publicada` y el despachador comprueba antes
-- de llamar, pero el cron reintenta, el operador hace doble clic y dos pestañas abiertas
-- publican a la vez. Un post duplicado no se puede despublicar de la memoria de quien
-- lo vio. Mismo criterio que `uq_cc_rend_abierta` en caja chica.
-- ─────────────────────────────────────────────────────────────────────────────

-- ── 1 · Cuentas conectadas ───────────────────────────────────────────────────

create table if not exists public.redes_cuentas (
  id                bigserial primary key,
  red               text not null check (red in
                      ('facebook','instagram','tiktok','youtube','whatsapp_estado')),

  -- Cómo se llama de cara al operador: «AFA Transportes» (la Página), «@afatours».
  nombre_cuenta     text,
  -- El id con el que habla la plataforma: page_id · ig_user_id · channel_id · open_id.
  cuenta_externa_id text,

  -- AES-256-GCM con TOKEN_ENCRYPTION_KEY, mismo formato y mismo módulo que
  -- `whatsapp_tokens` (lib/meta-tokens.ts). Sin esa variable no se guarda NADA:
  -- un token de publicación en texto plano es una credencial de primer orden.
  token_cifrado     text,
  refresh_cifrado   text,
  token_expira_en   timestamptz,

  -- `false` cuando la plataforma revocó el token o caducó. Lo escribe el publicador
  -- al recibir un 401/190, y es lo que el motor lee como `cuenta_caducada`.
  vigente           boolean not null default true,
  ultimo_error      text,
  ultimo_ok_en      timestamptz,

  -- SOLO para whatsapp_estado: a qué número se le manda la pieza lista, en E.164.
  -- El estado de WhatsApp no tiene API (ver lib/redes/tipos.ts), así que aquí la
  -- "cuenta" es la persona que tiene el celular con el número de atención al cliente.
  destino_telefono  text,

  creado_en         timestamptz not null default now(),
  actualizado_en    timestamptz not null default now()
);

-- Una cuenta VIGENTE por red. Se permite conservar las viejas (para el historial de
-- qué cuenta publicó qué), pero solo una puede estar activa.
create unique index if not exists uq_redes_cuenta_vigente
  on public.redes_cuentas (red) where vigente;

-- ── 2 · La publicación del día ───────────────────────────────────────────────

create table if not exists public.redes_publicaciones (
  id                  bigserial primary key,
  fecha               date not null,
  -- Minuto del día (0–1439) hora de Lima. Entero y no `time` porque el motor puro
  -- razona en minutos y convertir en dos sitios es cómo los dos dejan de coincidir.
  hora_programada_min int  not null default 480,   -- 08:00

  texto               text not null default '',
  -- Título de YouTube (100 caracteres). Se guarda aparte porque NO es el texto: el
  -- texto va a la descripción, y recortarlo a 100 produciría títulos cortados a media
  -- palabra en el único sitio donde el título es lo que se ve en el buscador.
  titulo              text,

  imagen_url          text,
  video_url           text,
  video_duracion_seg  int,

  modo_video          text not null default 'ninguno'
                      check (modo_video in ('ninguno','generado','propio')),

  -- Redes encendidas para ESTA publicación. Un array y no cinco booleanos: el motor
  -- recibe una lista y añadir una red sexta no debe ser una migración.
  redes               text[] not null default
                      array['facebook','instagram','whatsapp_estado']::text[],

  -- propuesta → la IA la redactó y espera revisión (el estado en que nace).
  -- aprobada  → una persona la firmó. Es lo ÚNICO que autoriza publicar.
  -- cerrada   → el despachador ya la procesó; el detalle por red está en destinos.
  -- descartada→ el operador la desechó. No se borra: saber qué NO se publicó un día
  --             es parte de la historia del canal.
  estado              text not null default 'propuesta'
                      check (estado in ('propuesta','aprobada','cerrada','descartada')),

  origen              text not null default 'ia' check (origen in ('ia','manual')),

  aprobada_por        uuid references auth.users(id) on delete set null,
  aprobada_en         timestamptz,

  -- Con qué se redactó, para poder repetir o corregir el estilo más adelante.
  ia_modelo           text,
  ia_tema             text,
  -- Lo que el operador cambió respecto de lo que propuso la IA. Es el dataset que
  -- enseña: mismo papel que `radar_combustible_correcciones`.
  ia_texto_original   text,

  nota                text,
  creado_en           timestamptz not null default now(),
  actualizado_en      timestamptz not null default now()
);

-- Una publicación viva por día. Descartar libera el día para volver a proponer.
create unique index if not exists uq_redes_publicacion_dia
  on public.redes_publicaciones (fecha) where estado <> 'descartada';

create index if not exists ix_redes_publicaciones_fecha
  on public.redes_publicaciones (fecha desc);

-- ── 3 · El destino: una fila por red ─────────────────────────────────────────

create table if not exists public.redes_destinos (
  id              bigserial primary key,
  publicacion_id  bigint not null
                  references public.redes_publicaciones(id) on delete cascade,
  red             text not null,

  -- pendiente  → todavía no se intentó.
  -- publicado  → salió. `id_externo` y `url_publicacion` lo demuestran.
  -- preparado  → la pieza está lista y la publica una persona (estado de WhatsApp).
  -- omitido    → el motor decidió que no salía, y `motivo` dice por qué.
  -- fallido    → se intentó y la plataforma lo rechazó. `error` trae su texto crudo.
  estado          text not null default 'pendiente'
                  check (estado in ('pendiente','publicado','preparado','omitido','fallido')),

  -- El CÓDIGO de lib/redes/tipos.ts, nunca una frase. La pantalla enruta por código y
  -- saca el texto del catálogo: una frase guardada aquí sería una segunda redacción
  -- del mismo estado, que envejece sola.
  motivo          text,
  detalle         text,

  id_externo      text,
  url_publicacion text,

  intentos        int not null default 0,
  -- El error CRUDO de la plataforma, sin interpretar. El catálogo evita la llamada
  -- imposible; esto es lo que queda cuando la plataforma rechaza por algo que no está
  -- escrito en ninguna documentación (un clasificador, una canción con copyright).
  error           text,

  publicado_en    timestamptz,
  creado_en       timestamptz not null default now(),
  actualizado_en  timestamptz not null default now()
);

-- EL CANDADO CONTRA EL DOBLE POSTEO. Ver la cabecera.
create unique index if not exists uq_redes_destino
  on public.redes_destinos (publicacion_id, red);

create index if not exists ix_redes_destinos_pub
  on public.redes_destinos (publicacion_id);

-- ── 4 · Bitácora de intentos ─────────────────────────────────────────────────
--
-- Append-only. `redes_destinos` dice en qué quedó; esto dice qué se intentó y cuándo,
-- que es lo único que contesta «¿por qué no salió el jueves?» tres semanas después.
-- Mismo papel que `notificaciones_enviadas` en el pipeline de avisos.

create table if not exists public.redes_intentos (
  id             bigserial primary key,
  publicacion_id bigint references public.redes_publicaciones(id) on delete cascade,
  red            text not null,
  ok             boolean not null,
  motivo         text,
  detalle        text,
  id_externo     text,
  -- Milisegundos que tardó la plataforma. Un salto aquí suele preceder a una caída.
  ms             int,
  creado_en      timestamptz not null default now()
);

create index if not exists ix_redes_intentos_pub
  on public.redes_intentos (publicacion_id, creado_en desc);

-- ── 5 · Configuración (fila única) ───────────────────────────────────────────
--
-- Lo que la IA necesita saber para redactar como AFA y no como un chatbot genérico.
-- Vive en la base y no en el código porque ESTE ERP SE VENDE: una constante con el
-- tono de AFA la heredaría el primer comprador, igual que pasó con `autorizacion_mtc`.

create table if not exists public.redes_config (
  id                 int primary key default 1 check (id = 1),

  activo             boolean not null default false,
  -- A qué hora se propone el post del día (minuto de Lima). El cron corre a esta hora.
  hora_propuesta_min int not null default 360,   -- 06:00, para que esté listo temprano
  hora_publicar_min  int not null default 480,   -- 08:00

  -- Cómo habla la marca. Texto libre que entra al prompt.
  tono               text,
  -- Qué vende y a quién. Sin esto la IA escribe sobre "transporte" en abstracto.
  publico            text,
  -- Lo que NUNCA se publica: precios concretos, nombres de clientes, placas.
  prohibido          text,
  hashtags_fijos     text,

  -- Temas que rotan por día de la semana, para que el canal no diga lo mismo siempre.
  temas              text[],

  modelo             text default 'claude-sonnet-5',

  creado_en          timestamptz not null default now(),
  actualizado_en     timestamptz not null default now()
);

insert into public.redes_config (id) values (1) on conflict (id) do nothing;

-- ── 6 · RLS ──────────────────────────────────────────────────────────────────
--
-- `redes_cuentas` guarda tokens de publicación: SIN política permisiva, igual que
-- `whatsapp_tokens`. Solo el service-role la toca, y solo desde el servidor.
-- Las otras tres las lee la pantalla con la sesión del usuario; el permiso de módulo
-- lo vuelve a verificar cada ruta API con `verificarUsuarioApi("redes")`, porque el
-- gate del menú es evadible llamando la API directamente.

alter table public.redes_cuentas       enable row level security;
alter table public.redes_publicaciones enable row level security;
alter table public.redes_destinos      enable row level security;
alter table public.redes_intentos      enable row level security;
alter table public.redes_config        enable row level security;

do $$
begin
  if not exists (select 1 from pg_policies
                 where tablename = 'redes_publicaciones' and policyname = 'redes_pub_auth') then
    create policy redes_pub_auth on public.redes_publicaciones
      for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies
                 where tablename = 'redes_destinos' and policyname = 'redes_dest_auth') then
    create policy redes_dest_auth on public.redes_destinos
      for all to authenticated using (true) with check (true);
  end if;
  if not exists (select 1 from pg_policies
                 where tablename = 'redes_intentos' and policyname = 'redes_int_auth') then
    create policy redes_int_auth on public.redes_intentos
      for select to authenticated using (true);
  end if;
  if not exists (select 1 from pg_policies
                 where tablename = 'redes_config' and policyname = 'redes_cfg_auth') then
    create policy redes_cfg_auth on public.redes_config
      for all to authenticated using (true) with check (true);
  end if;
end $$;

-- `redes_cuentas` NO recibe política a propósito: con RLS activo y sin políticas, la
-- clave anónima no lee ni una fila. La pantalla nunca ve un token; para saber qué hay
-- conectado consulta /api/redes/cuentas, que devuelve solo nombre y estado.

-- ── 7 · Bucket de piezas ─────────────────────────────────────────────────────
--
-- ESTE BUCKET ES PÚBLICO, Y ES LA ÚNICA EXCEPCIÓN DEL ERP A «los buckets son privados».
-- No es un descuido ni una comodidad: Facebook e Instagram NO reciben el archivo, se
-- les manda una URL y la descargan desde sus servidores (`image_url`). Una signed URL
-- caduca y un bucket privado devuelve un 400 que no nombra la causa. Y el contenido es,
-- por definición, lo que se va a publicar en abierto dentro de un minuto.
-- Lo que NUNCA va aquí: nada con placas, nombres de pasajeros ni documentos — para eso
-- están `comprobantes` y `documentos`, que siguen privados.

insert into storage.buckets (id, name, public)
values ('redes-publicaciones', 'redes-publicaciones', true)
on conflict (id) do nothing;

do $$
begin
  if not exists (select 1 from pg_policies
                 where tablename = 'objects' and policyname = 'redes_media_lectura') then
    create policy redes_media_lectura on storage.objects
      for select using (bucket_id = 'redes-publicaciones');
  end if;
  if not exists (select 1 from pg_policies
                 where tablename = 'objects' and policyname = 'redes_media_escritura') then
    create policy redes_media_escritura on storage.objects
      for insert to authenticated with check (bucket_id = 'redes-publicaciones');
  end if;
  if not exists (select 1 from pg_policies
                 where tablename = 'objects' and policyname = 'redes_media_borrado') then
    create policy redes_media_borrado on storage.objects
      for delete to authenticated using (bucket_id = 'redes-publicaciones');
  end if;
end $$;
