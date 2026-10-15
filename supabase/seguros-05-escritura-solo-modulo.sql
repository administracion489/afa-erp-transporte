-- ═══════════════════════════════════════════════════════════════════════════
-- seguros-05-escritura-solo-modulo.sql · Solo quien tiene el módulo «seguros»
-- (o es admin) puede ESCRIBIR pólizas y coberturas. Leer, cualquier usuario del ERP.
-- (NO la corre el deploy: Supabase → SQL Editor → Run, después de 04a/04b.
-- Idempotente.)
--
-- POR QUÉ: desde 04a, seguro_cobertura.estado decide si un trabajador está
-- cubierto por el SCTR (lo leen el aviso de vencimiento, la app del conductor y
-- las fichas). Con «authenticated all», cualquier usuario con sesión podía
-- marcar «incluida» desde la consola del navegador sin constancia.
-- El único escritor es /seguros, que ya exige el módulo: nada cambia en pantalla.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace function public.fn_puede_modulo(p_uid uuid, p_modulo text)
returns boolean
language sql
stable
security definer
set search_path = public, pg_temp
as $$
  select exists (
    select 1 from public.usuarios u
     where u.id = p_uid and coalesce(u.activo, true) = true
       and (u.rol = 'admin'
            or exists (select 1 from public.permisos_usuario pu
                        where pu.usuario_id = p_uid and pu.modulo = p_modulo
                          and pu.permitido = true))
  );
$$;
revoke all on function public.fn_puede_modulo(uuid, text) from public, anon;
grant execute on function public.fn_puede_modulo(uuid, text) to authenticated;

-- seguros
drop policy if exists seguros_authenticated on public.seguros;
drop policy if exists seguros_leer on public.seguros;
drop policy if exists seguros_escribir on public.seguros;
create policy seguros_leer on public.seguros
  for select to authenticated using (true);
create policy seguros_escribir on public.seguros
  for all to authenticated
  using (public.fn_puede_modulo(auth.uid(), 'seguros'))
  with check (public.fn_puede_modulo(auth.uid(), 'seguros'));

-- seguro_cobertura
drop policy if exists seguro_cobertura_authenticated on public.seguro_cobertura;
drop policy if exists seguro_cobertura_leer on public.seguro_cobertura;
drop policy if exists seguro_cobertura_escribir on public.seguro_cobertura;
create policy seguro_cobertura_leer on public.seguro_cobertura
  for select to authenticated using (true);
create policy seguro_cobertura_escribir on public.seguro_cobertura
  for all to authenticated
  using (public.fn_puede_modulo(auth.uid(), 'seguros'))
  with check (public.fn_puede_modulo(auth.uid(), 'seguros'));

-- Verificación (con un usuario SIN el módulo, desde la app): un update a
-- seguro_cobertura no cambia ninguna fila.

-- FIN de seguros-05-escritura-solo-modulo.sql
