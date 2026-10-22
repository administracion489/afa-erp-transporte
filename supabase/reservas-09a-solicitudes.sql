-- reservas-09a-solicitudes.sql — La SOLICITUD de reserva de un traslado que cotizó la IA del CRM: una fila por intento
-- («aceptó → paga o espera disponibilidad → se verifica → hay unidad → confirmación», o se cierra con su motivo).
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere traslados-05-cotizacion-ia.sql
-- y crm-agente-ia.sql: si falta una, se detiene nombrándola y NO cambia nada. Después: reservas-09b y reservas-09c.
-- Correrla NO enciende nada (el interruptor es traslados_config.reserva_ia, traslados-09). SIN ELLA la IA no ofrece
-- reservar y el prompt del agente es el de antes, byte a byte.
-- REGLA DE ORO: esta fila NO guarda dinero. Precio, moneda e IGV son de `cotizaciones`; lo cobrado y lo devuelto, de
-- `pagos` (reserva_solicitud_id, reservas-09c). Aquí solo el % de adelanto que se le COMUNICÓ al cliente y la firma de
-- los importes con que se le dijo; adelanto, saldo y devolución pendiente se DERIVAN. factura_cargo_id = el comprobante
-- del cargo retenido que arma el ERP en `facturas` (sin número). RLS SIN POLÍTICAS: solo el servidor (service-role).

do $$ declare f text := ''; begin
  if to_regclass('public.crm_acciones_ia') is null or to_regclass('public.crm_mensajes') is null then
    f := f || ' crm-agente-ia.sql (y crm-schema.sql)'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cotizaciones'
                    and column_name = 'crm_conversacion_id') then f := f || ' traslados-05-cotizacion-ia.sql'; end if;
  if to_regclass('public.facturas') is null then f := f || ' (la tabla public.facturas del módulo Facturación)'; end if;
  if f <> '' then raise exception 'Antes de reservas-09a hay que correr:%', f; end if;
end $$;

create table if not exists public.reserva_solicitudes (
  id                    bigserial primary key,
  cotizacion_id         bigint not null references public.cotizaciones(id) on delete restrict,
  crm_conversacion_id   uuid references public.crm_conversaciones(id) on delete set null,
  crm_accion_id         uuid references public.crm_acciones_ia(id) on delete set null,
  estado text not null, orden text not null, motivos_orden text[] not null default '{}',
  adelanto_pct          numeric(5,2),                                    -- null = crédito (sin adelanto)
  firma_importes text, confirmar_antes_de timestamptz, urgente boolean not null default false,
  nombre_pasajero text, vuelo text, cliente_acepto_en timestamptz,
  acepto_mensaje_id     uuid references public.crm_mensajes(id) on delete set null,
  disponibilidad_en timestamptz, disponibilidad_por uuid references public.usuarios(id) on delete set null,
  reserva_id            bigint references public.reservas(id) on delete set null,         -- la ida
  cancelacion_pedida_en timestamptz, devolucion_pct numeric(5,2),       -- la hora del MENSAJE del cliente
  factura_cargo_id      bigint references public.facturas(id) on delete set null,
  cierre_motivo text, cerrada_en timestamptz, cerrada_por uuid references public.usuarios(id) on delete set null,
  nota text, creada_en timestamptz not null default now(), actualizada_en timestamptz not null default now()
);
-- Cada lista cerrada con su CHECK. motivos_orden solo exige FORMATO de código: los códigos los declara el motor
-- (lib/traslados/reserva-orden.ts) y uno nuevo no puede tumbar una reserva por faltarle una migración.
alter table public.reserva_solicitudes
  drop constraint if exists reserva_solicitudes_estado_ck, drop constraint if exists reserva_solicitudes_orden_ck,
  drop constraint if exists reserva_solicitudes_motivos_ck, drop constraint if exists reserva_solicitudes_adelanto_ck,
  drop constraint if exists reserva_solicitudes_devolucion_ck, drop constraint if exists reserva_solicitudes_cierre_ck,
  drop constraint if exists reserva_solicitudes_textos_ck,
  add constraint reserva_solicitudes_estado_ck check (estado in ('esperando_pago', 'por_confirmar', 'pago_reportado',
    'confirmada', 'sin_unidad', 'cancelada', 'completada')),
  add constraint reserva_solicitudes_orden_ck check (orden in ('pago_primero', 'disponibilidad_primero')),
  add constraint reserva_solicitudes_motivos_ck check (array_to_string(motivos_orden, ',') ~ '^([a-z_]{2,40}(,[a-z_]{2,40})*)?$'),
  add constraint reserva_solicitudes_adelanto_ck check (adelanto_pct is null or (adelanto_pct > 0 and adelanto_pct <= 100)),
  add constraint reserva_solicitudes_devolucion_ck check (devolucion_pct is null or devolucion_pct between 0 and 100),
  add constraint reserva_solicitudes_cierre_ck check (cierre_motivo is null
    or cierre_motivo in ('cliente', 'sin_unidad', 'vencida', 'duplicada', 'ejecutivo')),
  add constraint reserva_solicitudes_textos_ck check (char_length(coalesce(nombre_pasajero, '')) <= 80
    and char_length(coalesce(vuelo, '')) <= 20 and char_length(coalesce(firma_importes, '')) <= 500
    and char_length(coalesce(nota, '')) <= 2000);

-- Una solicitud VIVA por cotización (última defensa contra el doble envío); el tick por plazo; la IA por hilo; y un
-- comprobante del cargo no se comparte entre dos solicitudes.
create unique index if not exists uq_reserva_solicitudes_viva on public.reserva_solicitudes (cotizacion_id)
  where estado in ('esperando_pago', 'por_confirmar', 'pago_reportado', 'confirmada');
create index if not exists idx_reserva_solicitudes_plazo on public.reserva_solicitudes (estado, confirmar_antes_de);
create index if not exists idx_reserva_solicitudes_conv on public.reserva_solicitudes (crm_conversacion_id, creada_en desc)
  where crm_conversacion_id is not null;
create unique index if not exists uq_reserva_solicitudes_cargo on public.reserva_solicitudes (factura_cargo_id)
  where factura_cargo_id is not null;

create or replace function public.fn_reserva_solicitudes_actualizada() returns trigger
language plpgsql security invoker set search_path = public, pg_temp as $$ begin new.actualizada_en := now(); return new; end $$;
drop trigger if exists trg_reserva_solicitudes_actualizada on public.reserva_solicitudes;
create trigger trg_reserva_solicitudes_actualizada before update on public.reserva_solicitudes
  for each row execute function public.fn_reserva_solicitudes_actualizada();

-- Solo servidor: RLS, NINGUNA política (se borra cualquiera que haya) y sin permisos para anon ni authenticated.
alter table public.reserva_solicitudes enable row level security;
do $$ declare p record; begin for p in select policyname from pg_policies where schemaname = 'public'
  and tablename = 'reserva_solicitudes' loop execute format('drop policy %I on public.reserva_solicitudes', p.policyname);
  end loop; end $$;
revoke all on public.reserva_solicitudes from anon, authenticated;
revoke all on sequence public.reserva_solicitudes_id_seq from anon, authenticated;
comment on table public.reserva_solicitudes is
  'Solicitudes de reserva de los traslados que cotiza la IA del CRM. Sin dinero: se deriva de cotizaciones y pagos. Solo servidor.';
comment on column public.crm_acciones_ia.tipo is
  'cotizacion | reserva | cotizacion_traslado | reserva_traslado (sin CHECK: un tipo nuevo no necesita migración).';

-- Verificación (solo lee): RLS y 0 políticas, los CHECK y FK, índices, trigger y permisos «ninguno».
select 'tabla' as que, 'reserva_solicitudes' as nombre, 'RLS ' || relrowsecurity || ' · políticas '
       || (select count(*) from pg_policies where schemaname = 'public' and tablename = 'reserva_solicitudes') as detalle
  from pg_class where oid = 'public.reserva_solicitudes'::regclass
union all select 'check / FK', conname::text, pg_get_constraintdef(oid) from pg_constraint
 where conrelid = 'public.reserva_solicitudes'::regclass and contype in ('c', 'f')
union all select 'índice', indexname::text, indexdef from pg_indexes
 where schemaname = 'public' and tablename = 'reserva_solicitudes'
union all select 'trigger', tgname::text, pg_get_triggerdef(oid) from pg_trigger
 where tgrelid = 'public.reserva_solicitudes'::regclass and not tgisinternal
union all select 'permiso', r, coalesce(string_agg(p, ', ')
         filter (where has_table_privilege(r, 'public.reserva_solicitudes', p)), 'ninguno')
  from unnest(array['anon', 'authenticated']) r, unnest(array['SELECT', 'INSERT', 'UPDATE', 'DELETE']) p group by r
order by 1, 2;
-- FIN de reservas-09a-solicitudes.sql
