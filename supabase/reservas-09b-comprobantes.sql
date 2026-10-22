-- reservas-09b-comprobantes.sql — Los COMPROBANTES de pago que el cliente manda por el chat para una solicitud de reserva
-- de traslado (reservas-09a): de qué mensaje salió, lo que leyó la IA y el cotejo contra la cotización.
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere reservas-09a-solicitudes.sql
-- (y crm-schema.sql): si falta, se detiene nombrándolo y NO cambia nada. SIN ELLA la IA no registra comprobantes
-- (reportar_pago_traslado deriva al ejecutivo) y la tarjeta del inbox no los enseña.
-- LA LECTURA ES EVIDENCIA, NUNCA AUTORIZA: el adelanto solo existe cuando Tesorería/Finanzas registra el cobro en
-- `pagos` (reservas-09c) después de verlo en el banco. Aquí no hay importe autoritativo: `lectura` es lo que la IA
-- creyó ver y `cotejo` los códigos de lib/traslados/comprobante-pago.ts.
-- mensaje_id es UNIQUE: el mismo mensaje no se usa dos veces (dos corridas a la vez chocan en el índice, no duplican).
-- Si se borra la conversación (spam), el mensaje desaparece y aquí queda la lectura con mensaje_id en null.
-- operacion_norm: el nº de operación normalizado, para detectar `operacion_repetida` (no es UNIQUE: se AVISA, no se
-- impide; un rechazo aquí perdería la evidencia del segundo intento).
-- RLS SIN POLÍTICAS (como reservas-09a): solo el servidor (service-role) la lee y escribe.

do $$ declare f text := ''; begin
  if to_regclass('public.reserva_solicitudes') is null then f := f || ' reservas-09a-solicitudes.sql'; end if;
  if to_regclass('public.crm_mensajes') is null then f := f || ' crm-schema.sql'; end if;
  if f <> '' then raise exception 'Antes de reservas-09b hay que correr:%', f; end if;
end $$;

create table if not exists public.reserva_solicitud_comprobantes (
  id             bigserial primary key,
  solicitud_id   bigint not null references public.reserva_solicitudes(id) on delete cascade,
  mensaje_id     uuid unique references public.crm_mensajes(id) on delete set null,
  lectura        jsonb,                                  -- lo que leyó la IA (puede equivocarse); null = no se pudo leer
  cotejo         text[] not null default '{}',
  operacion_norm text,
  correo_en      timestamptz,
  correo_error   text,
  leido_en       timestamptz,                            -- «Leer el último comprobante»: quién lo miró y cuándo
  leido_por      uuid references public.usuarios(id) on delete set null,
  creado_en      timestamptz not null default now()
);
-- cotejo solo exige FORMATO de código (los declara el motor, como motivos_orden en 09a).
alter table public.reserva_solicitud_comprobantes
  drop constraint if exists reserva_solicitud_comprobantes_cotejo_ck,
  drop constraint if exists reserva_solicitud_comprobantes_lectura_ck,
  drop constraint if exists reserva_solicitud_comprobantes_textos_ck,
  add constraint reserva_solicitud_comprobantes_cotejo_ck check (array_to_string(cotejo, ',') ~ '^([a-z_]{2,40}(,[a-z_]{2,40})*)?$'),
  add constraint reserva_solicitud_comprobantes_lectura_ck check (lectura is null or jsonb_typeof(lectura) = 'object'),
  add constraint reserva_solicitud_comprobantes_textos_ck check (char_length(coalesce(operacion_norm, '')) <= 80
    and char_length(coalesce(correo_error, '')) <= 2000);

create index if not exists idx_reserva_comprobantes_solicitud
  on public.reserva_solicitud_comprobantes (solicitud_id, creado_en desc);
create index if not exists idx_reserva_comprobantes_operacion
  on public.reserva_solicitud_comprobantes (operacion_norm) where operacion_norm is not null;

alter table public.reserva_solicitud_comprobantes enable row level security;
do $$ declare p record; begin for p in select policyname from pg_policies where schemaname = 'public'
  and tablename = 'reserva_solicitud_comprobantes' loop
  execute format('drop policy %I on public.reserva_solicitud_comprobantes', p.policyname); end loop; end $$;
revoke all on public.reserva_solicitud_comprobantes from anon, authenticated;
revoke all on sequence public.reserva_solicitud_comprobantes_id_seq from anon, authenticated;
comment on table public.reserva_solicitud_comprobantes is
  'Comprobantes de pago enviados por el chat para una solicitud de reserva: evidencia, nunca autoriza. Solo servidor.';
comment on column public.reserva_solicitud_comprobantes.lectura is
  'Lo que leyó la IA del comprobante (monto, moneda, fecha, operación, destino). Puede equivocarse: no es un cobro.';

-- Verificación (solo lee): RLS y 0 políticas, CHECK y FK, índices (incluido el UNIQUE de mensaje_id) y permisos «ninguno».
select 'tabla' as que, 'reserva_solicitud_comprobantes' as nombre, 'RLS ' || relrowsecurity || ' · políticas '
       || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'reserva_solicitud_comprobantes') as detalle
  from pg_class where oid = 'public.reserva_solicitud_comprobantes'::regclass
union all select 'check / FK / unique', conname::text, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.reserva_solicitud_comprobantes'::regclass and contype in ('c', 'f', 'u')
union all select 'índice', indexname::text, indexdef from pg_indexes
 where schemaname = 'public' and tablename = 'reserva_solicitud_comprobantes'
union all select 'permiso', r, coalesce(string_agg(p, ', ')
         filter (where has_table_privilege(r, 'public.reserva_solicitud_comprobantes', p)), 'ninguno')
  from unnest(array['anon', 'authenticated']) r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p group by r
order by 1, 2;
-- FIN de reservas-09b-comprobantes.sql
