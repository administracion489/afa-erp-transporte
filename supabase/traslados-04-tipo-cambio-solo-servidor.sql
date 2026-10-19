-- traslados-04-tipo-cambio-solo-servidor.sql — Quién puede ESCRIBIR el tipo de cambio y el IGV.
-- NO la corre el deploy. Independiente de traslados-01..03 (se puede correr antes o después).
--
-- Hasta ahora `tipo_cambio` y `config_tributaria` tenían una política «for all» para cualquier
-- usuario con sesión (finanzas-00: using auth.role() = 'authenticated'). Era tolerable mientras
-- una persona miraba el número antes de usarlo; ya no: la cotización automática de traslados
-- convierte los dólares a soles con el ÚLTIMO tipo de cambio y suma el IGV de config_tributaria
-- sin que nadie los revise. Una fila falsa escrita desde la consola del navegador cambiaría el
-- importe de cada cotización en dólares.
--
--  · tipo_cambio: lo escribe SOLO el servidor (cron y botón de /api/tipo-cambio/sunat, con
--    service-role). Ninguna pantalla lo escribe; todas lo leen.
--  · config_tributaria: la edita Tesorería (PanelTasasDetraccion): escribir exige ese módulo.
-- Requiere public.fn_puede_modulo (seguros-05 o traslados-01). Correr entero con Run.

create or replace function public.fn_puede_modulo(p_uid uuid, p_modulo text)
returns boolean language sql stable security definer set search_path = public, pg_temp as $$
  select exists (
    select 1 from public.usuarios u
     where u.id = p_uid and coalesce(u.activo, true) = true
       and (u.rol = 'admin'
            or exists (select 1 from public.permisos_usuario pu
                        where pu.usuario_id = p_uid and pu.modulo = p_modulo and pu.permitido = true))
  );
$$;
revoke all on function public.fn_puede_modulo(uuid, text) from public, anon;
grant execute on function public.fn_puede_modulo(uuid, text) to authenticated;

alter table public.tipo_cambio enable row level security;
drop policy if exists tipo_cambio_auth on public.tipo_cambio;
drop policy if exists tipo_cambio_authenticated on public.tipo_cambio;
drop policy if exists tipo_cambio_leer on public.tipo_cambio;
create policy tipo_cambio_leer on public.tipo_cambio for select to authenticated using (true);
revoke insert, update, delete, truncate on public.tipo_cambio from anon, authenticated;
revoke all on public.tipo_cambio from anon;

alter table public.config_tributaria enable row level security;
drop policy if exists config_tributaria_auth on public.config_tributaria;
drop policy if exists config_tributaria_authenticated on public.config_tributaria;
drop policy if exists config_tributaria_leer on public.config_tributaria;
drop policy if exists config_tributaria_escribir on public.config_tributaria;
create policy config_tributaria_leer on public.config_tributaria for select to authenticated using (true);
create policy config_tributaria_escribir on public.config_tributaria for all to authenticated
  using (public.fn_puede_modulo(auth.uid(), 'tesoreria'))
  with check (public.fn_puede_modulo(auth.uid(), 'tesoreria'));
revoke all on public.config_tributaria from anon;

-- Verificación (con un usuario sin los módulos, desde la consola de la app): un upsert a
-- tipo_cambio da error de permisos; un update a config_tributaria cambia 0 filas; leer sigue igual.
-- FIN de traslados-04-tipo-cambio-solo-servidor.sql
