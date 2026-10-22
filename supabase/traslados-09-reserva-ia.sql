-- traslados-09-reserva-ia.sql — La configuración de la RESERVA de los traslados que cotiza la IA del CRM: el interruptor,
-- el % de adelanto, a quién se le avisa por correo y los plazos para confirmar.
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere traslados-05-cotizacion-ia.sql;
-- el bloque SOLO AFA, además, reservas-09a, -09b, -09c y cotizaciones-06. Si falta algo, se detiene nombrándolo y NO
-- cambia nada.
-- PARTE GENERAL (cualquier instalación). Correrla NO empieza a reservar ni a pedir pagos: `reserva_ia` NACE APAGADO y
-- `reserva_adelanto_pct` sin valor (sin % la IA no pide pago: `sin_adelanto_config`). Lo cambia quien tiene el módulo
-- «tarifas» (política de traslados-01), en /tarifario → Zonas y traslados → Ajustes.
--   reserva_ia                      la IA ofrece reservar_traslado (solo con el agente autónomo). false = ni lo ofrece.
--   reserva_adelanto_pct            % del total que se pide de adelanto (0 < % ≤ 100). null = no se pide pago.
--   reserva_correo                  a quién avisa el correo «pago REPORTADO» (lista separada por coma); null = el correo
--                                   del perfil de la empresa.
--   reserva_plazo_confirmacion_min  P: minutos DE ATENCIÓN del equipo para confirmar (15..1440). Defecto 120, no medido.
--   reserva_margen_min              M: minutos reales entre esa confirmación y el inicio del servicio (0..4320). Defecto 360.
--   reserva_devolucion_plazo_h      horas en que se devuelve lo pagado (1..720); null = el mensaje no promete un plazo.
-- SIN ESTA MIGRACIÓN la app lee la reserva como apagada y el prompt del agente es el de antes, byte a byte.
-- Bloqueo: columnas con default constante (PG11+: no reescriben la tabla); los CHECK revalidan una sola fila.

do $$ begin
  if to_regclass('public.traslados_config') is null or not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'traslados_config' and column_name = 'ia_cotiza') then
    raise exception 'Antes de traslados-09 hay que correr: traslados-05-cotizacion-ia.sql';
  end if;
  -- ¿Las columnas nacen en ESTA corrida? El bloque SOLO AFA solo enciende entonces (volver a correr no reenciende).
  perform set_config('afa.traslados09_nuevo', (not exists (select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'traslados_config' and column_name = 'reserva_ia'))::text, true);
end $$;

alter table public.traslados_config
  add column if not exists reserva_ia                     boolean not null default false,
  add column if not exists reserva_adelanto_pct           numeric(5,2),
  add column if not exists reserva_correo                 text,
  add column if not exists reserva_plazo_confirmacion_min int not null default 120,
  add column if not exists reserva_margen_min             int not null default 360,
  add column if not exists reserva_devolucion_plazo_h     int;
alter table public.traslados_config
  drop constraint if exists traslados_config_reserva_adelanto_ck, drop constraint if exists traslados_config_reserva_correo_ck,
  drop constraint if exists traslados_config_reserva_plazo_ck, drop constraint if exists traslados_config_reserva_margen_ck,
  drop constraint if exists traslados_config_reserva_devolucion_ck,
  add constraint traslados_config_reserva_adelanto_ck check (reserva_adelanto_pct is null
    or (reserva_adelanto_pct > 0 and reserva_adelanto_pct <= 100)),
  add constraint traslados_config_reserva_correo_ck check (reserva_correo is null
    or (char_length(reserva_correo) between 3 and 500 and position('@' in reserva_correo) > 0)),
  add constraint traslados_config_reserva_plazo_ck check (reserva_plazo_confirmacion_min between 15 and 1440),
  add constraint traslados_config_reserva_margen_ck check (reserva_margen_min between 0 and 4320),
  add constraint traslados_config_reserva_devolucion_ck check (reserva_devolucion_plazo_h is null
    or reserva_devolucion_plazo_h between 1 and 720);
insert into public.traslados_config (id) values (1) on conflict (id) do nothing;

comment on column public.traslados_config.reserva_ia is
  'La IA del CRM puede reservar los traslados que cotizó (pide el adelanto o la disponibilidad). false = ni lo ofrece.';
comment on column public.traslados_config.reserva_adelanto_pct is
  '% del total que se pide de adelanto al reservar. null = no se pide pago (la IA pide confirmar disponibilidad).';
comment on column public.traslados_config.reserva_correo is
  'Correos que reciben «pago REPORTADO, pendiente de verificar» (separados por coma). null = el correo del perfil.';
comment on column public.traslados_config.reserva_plazo_confirmacion_min is
  'P: minutos de horario de ATENCIÓN del equipo para confirmar una reserva (15..1440).';
comment on column public.traslados_config.reserva_margen_min is
  'M: minutos reales entre la confirmación y el inicio del servicio (0..4320).';
comment on column public.traslados_config.reserva_devolucion_plazo_h is
  'Horas en que se devuelve lo pagado (1..720). null = los mensajes no prometen un plazo.';

-- Verificación (solo lee): las 6 columnas con su valor. Si se deja fuera el bloque SOLO AFA, es lo último que se ve.
select key as columna, coalesce(value, 'null') as valor from jsonb_each_text((select to_jsonb(t) from public.traslados_config t
 where id = 1)) where key like 'reserva\_%' order by key;

-- ── SOLO AFA (otra instalación deja fuera este bloque) ──────────────────────────────────────────
-- Decisión del dueño (22-10-2026): adelanto del 50 %, P = 120 min de atención, M = 360 min, devolución en 48 h, y el
-- aviso a transporte@. Solo la primera vez (paso 0). Volver atrás es un UPDATE, no un despliegue:
--   update public.traslados_config set reserva_ia = false where id = 1;   -- la IA deja de reservar
do $$ declare f text := ''; begin
  if to_regclass('public.reserva_solicitudes') is null then f := f || ' reservas-09a-solicitudes.sql'; end if;
  if to_regclass('public.reserva_solicitud_comprobantes') is null then f := f || ' reservas-09b-comprobantes.sql'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'pagos'
                    and column_name = 'reserva_solicitud_id') then f := f || ' reservas-09c-pagos-solicitud.sql'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cotizacion_plantillas'
                    and column_name = 'condiciones_reserva') then f := f || ' cotizaciones-06-politica-reserva.sql'; end if;
  if f <> '' then raise exception 'Para encender la reserva de AFA antes hay que correr:%', f; end if;
end $$;
update public.traslados_config set reserva_ia = true, reserva_adelanto_pct = 50, reserva_correo = 'transporte@afatoursperu.com',
       reserva_plazo_confirmacion_min = 120, reserva_margen_min = 360, reserva_devolucion_plazo_h = 48
 where id = 1 and current_setting('afa.traslados09_nuevo', true) = 'true';
select key as columna, coalesce(value, 'null') || case coalesce(current_setting('afa.traslados09_nuevo', true), '')
         when 'true' then ' · puesto ahora' when 'false' then ' · ya existía: no se tocó'
         else ' · NO se puso: corre el archivo ENTERO con Run' end as valor
  from jsonb_each_text((select to_jsonb(t) from public.traslados_config t where id = 1)) where key like 'reserva\_%' order by key;
-- FIN de traslados-09-reserva-ia.sql
