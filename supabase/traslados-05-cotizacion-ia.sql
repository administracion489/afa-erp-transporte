-- traslados-05-cotizacion-ia.sql — Fase 2: la IA del CRM cotiza traslados por WhatsApp y envía el PDF.
-- NO la corre el deploy: hay que ejecutarla en Supabase (SQL Editor → pegar ENTERA → Run). Idempotente.
-- Requiere traslados-01 y -04, crm-agente-ia.sql y cotizaciones-04-moneda-idioma.sql (moneda y tipo_cambio);
-- el bloque SOLO AFA, además, -02 y -03. Si falta una, se detiene nombrándola y NO cambia nada. traslados-04
-- se exige porque la IA convierte con el ÚLTIMO tipo de cambio y suma el IGV sin que nadie los mire.
--
-- PARTE GENERAL (cualquier instalación). Correrla NO empieza a cotizar ni a enviar nada: los tres
-- interruptores NACEN APAGADOS y los cambia quien tiene el módulo «tarifas» (política de traslados-01).
--   traslados_config.ia_cotiza         la IA puede cotizar traslados; apagado ni ofrece la herramienta.
--   traslados_config.envio_automatico  maestro del envío SIN revisión; apagado, todo espera a un ejecutivo.
--   zonas_traslado.envio_automatico    qué zonas salen solas (desde o hacia; una subzona hereda del distrito).
-- En cotizaciones: la conversación del CRM de la que salió y los HECHOS del traslado (zonas, pasajeros,
-- maletas, categoría, fechas). Nunca dinero: los importes siguen en sus columnas de siempre, en soles.
-- crm_acciones_ia.tipo y .estado NO tienen CHECK (crm-agente-ia.sql): el tipo nuevo `cotizacion_traslado`
-- y el estado transitorio `enviando` no necesitan SQL; solo se documentan abajo.
-- SIN ESTA MIGRACIÓN la app lee los interruptores como apagados y /tarifario lo dice nombrando este archivo.
-- Bloqueo: columnas con default constante no reescriben la tabla (PG11+); el índice es parcial y nace vacío.

-- 0) Requisitos. Además se anota si las columnas nacen en ESTA corrida: el bloque SOLO AFA enciende los
--    interruptores solo entonces, para que volver a correr el archivo no reencienda lo que alguien apagó.
do $$ declare f text := ''; begin
  if to_regclass('public.traslados_config') is null then f := f || ' traslados-01-tablas.sql'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'tipo_cambio'
                    and policyname = 'tipo_cambio_leer') then f := f || ' traslados-04-tipo-cambio-solo-servidor.sql'; end if;
  if to_regclass('public.crm_acciones_ia') is null then f := f || ' crm-agente-ia.sql'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                    and table_name = 'cotizaciones' and column_name = 'tipo_cambio') then f := f || ' cotizaciones-04-moneda-idioma.sql'; end if;
  if f <> '' then raise exception 'Antes de traslados-05 hay que correr:%', f; end if;
  perform set_config('afa.traslados05_nuevo', (not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'traslados_config' and column_name = 'envio_automatico'))::text, true);
end $$;

-- 1) Interruptores (nacen en false) y el vínculo cotización ↔ conversación.
alter table public.traslados_config
  add column if not exists ia_cotiza        boolean not null default false,
  add column if not exists envio_automatico boolean not null default false;
insert into public.traslados_config (id) values (1) on conflict (id) do nothing;
alter table public.zonas_traslado
  add column if not exists envio_automatico boolean not null default false;
-- on delete set null: borrar una conversación (spam) no borra la cotización, que es la fila autoritativa.
alter table public.cotizaciones
  add column if not exists crm_conversacion_id uuid references public.crm_conversaciones(id) on delete set null,
  add column if not exists traslado_json jsonb;
-- Sirve a «¿ya se cotizó en esta conversación?» y al set null del FK al borrar una conversación.
create index if not exists idx_cotizaciones_crm_conv
  on public.cotizaciones (crm_conversacion_id) where crm_conversacion_id is not null;

comment on column public.traslados_config.ia_cotiza is
  'La IA del CRM (WhatsApp) puede cotizar traslados con esta tarifa. false = ni ofrece la herramienta.';
comment on column public.traslados_config.envio_automatico is
  'Maestro del envío del PDF SIN revisión. false = toda cotización de la IA espera a que un ejecutivo la envíe.';
comment on column public.zonas_traslado.envio_automatico is
  'Un traslado desde o hacia esta zona (o su distrito, si es subzona) sale solo, si el maestro está encendido.';
comment on column public.cotizaciones.crm_conversacion_id is
  'Conversación del CRM de la que salió la cotización (IA de traslados). null = creada en /cotizaciones.';
comment on column public.cotizaciones.traslado_json is
  'Hechos del traslado cotizado por la IA (zonas, pasajeros, maletas, categoría, fechas). Nunca importes.';
comment on column public.crm_acciones_ia.tipo is
  'cotizacion | reserva | cotizacion_traslado (sin CHECK: un tipo nuevo no necesita migración).';
comment on column public.crm_acciones_ia.estado is
  'pendiente | enviando (reclamada para enviar; resuelta_at es su plazo) | aprobada | rechazada.';

-- Verificación (solo lee): deben salir las 5 columnas. Si se deja fuera el bloque SOLO AFA, es lo último que se ve.
select table_name, column_name, data_type, column_default, is_nullable
  from information_schema.columns
 where table_schema = 'public'
   and (table_name, column_name) in (('traslados_config', 'ia_cotiza'), ('traslados_config', 'envio_automatico'),
        ('zonas_traslado', 'envio_automatico'), ('cotizaciones', 'crm_conversacion_id'), ('cotizaciones', 'traslado_json'))
 order by table_name, column_name;

-- ── SOLO AFA (otra instalación deja fuera este bloque) ──────────────────────────────────────────
-- Decisión del dueño, 19-10-2026, literal: «que envíe en automático, por el momento como PRUEBA solo
-- los traslados al aeropuerto y viceversa (solo ida, o ida y retorno); las demás rutas quedan en modo
-- revisión». Por eso SOLO la geocerca del aeropuerto lleva la bandera y se encienden los dos maestros,
-- y solo la primera vez (paso 0). Se detiene si falta el aeropuerto con precios (traslados-02 y -03).
-- Volver atrás es un UPDATE, no un despliegue (o desde /tarifario → Zonas y traslados → Ajustes):
--   update public.traslados_config set envio_automatico = false where id = 1;  -- todo a revisión
--   update public.traslados_config set ia_cotiza = false where id = 1;         -- la IA deja de cotizar
do $$ begin
  if not exists (select 1 from public.zonas_traslado z
                   join public.tarifas_traslado t on z.id in (t.zona_a_id, t.zona_b_id) and t.activo
                  where lower(z.nombre) = lower('Aeropuerto Jorge Chávez') and z.tipo = 'punto' and z.activo) then
    raise exception 'Falta el aeropuerto con precios: corre traslados-02 y traslados-03 y vuelve a correr este archivo.';
  end if;
end $$;
update public.zonas_traslado set envio_automatico = true
 where current_setting('afa.traslados05_nuevo', true) = 'true'
   and lower(nombre) = lower('Aeropuerto Jorge Chávez') and tipo = 'punto';
update public.traslados_config set ia_cotiza = true, envio_automatico = true
 where id = 1 and current_setting('afa.traslados05_nuevo', true) = 'true';
-- Lo que quedó encendido (solo lee). «ya existían» = no se tocó lo que alguien decidió después.
select 'traslados_config' as que, 'ia_cotiza ' || ia_cotiza || ' · envio_automatico ' || envio_automatico as estado,
       case coalesce(current_setting('afa.traslados05_nuevo', true), '') when 'true' then 'encendido ahora'
            when 'false' then 'ya existían: no se tocó' else 'NO se encendió: corre el archivo ENTERO con Run' end as nota
  from public.traslados_config where id = 1
union all
select 'zona con envío automático', nombre || ' (' || tipo || ')', 'debe ser SOLO el aeropuerto'
  from public.zonas_traslado where envio_automatico;
-- FIN de traslados-05-cotizacion-ia.sql
