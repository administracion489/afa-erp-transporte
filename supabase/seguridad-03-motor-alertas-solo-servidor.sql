-- ============================================================
-- SEGURIDAD · el registro del motor de alertas lo escribe SOLO el servidor
-- Ejecutar en Supabase SQL Editor. Idempotente. (NO la corre el deploy.)
-- ============================================================
-- `alerta_enviada` (el «este aviso ya salió» de cada aviso, y el freno de 🧪 Probar los avisos) y
-- `avisos_conductor_estado` (lo último que se le avisó al conductor de cada servicio) tenían una
-- política «todo permitido» para cualquier usuario con sesión (alertas-operativas.sql).
--
-- Las escribe SOLO el motor, con service-role (lib/alertas.ts), y ninguna pantalla las escribe
-- (comprobado en el código, 11-10-2026). Con la política abierta, cualquier usuario del ERP podía
-- BORRAR esos registros desde la consola del navegador:
--   · el motor volvía a mandar los WhatsApp ya enviados (que se cobran), y
--   · el freno de las pruebas de avisos (una por minuto, 15 al día) se saltaba.
--
-- Después de este SQL el ERP las sigue LEYENDO (la ficha de /seguimiento lee alerta_enviada); lo
-- que deja de poder es escribirlas. El servidor no cambia: service-role no pasa por RLS.
-- Se revierte volviendo a crear la política anterior (está en alertas-operativas.sql).
-- ============================================================

do $$
declare p record;
begin
  -- Se quitan TODAS las políticas de las dos tablas (la de alertas-operativas.sql y cualquier
  -- genérica que haya dejado seguridad-01-rls.sql), y se deja solo la de lectura.
  for p in
    select policyname, tablename from pg_policies
     where schemaname = 'public' and tablename in ('alerta_enviada', 'avisos_conductor_estado')
  loop
    execute format('drop policy %I on public.%I', p.policyname, p.tablename);
  end loop;
end $$;

alter table public.alerta_enviada enable row level security;
create policy alerta_enviada_lectura on public.alerta_enviada
  for select to authenticated using (true);
revoke insert, update, delete, truncate on public.alerta_enviada from anon, authenticated;
revoke all on public.alerta_enviada from anon;

alter table public.avisos_conductor_estado enable row level security;
create policy avisos_conductor_estado_lectura on public.avisos_conductor_estado
  for select to authenticated using (true);
revoke insert, update, delete, truncate on public.avisos_conductor_estado from anon, authenticated;
revoke all on public.avisos_conductor_estado from anon;

-- ── Verificación ──────────────────────────────────────────────────────────────
-- Debe salir UNA política por tabla, de SELECT, para authenticated:
-- select tablename, policyname, cmd, roles from pg_policies
--  where tablename in ('alerta_enviada', 'avisos_conductor_estado');
