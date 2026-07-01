-- ──────────────────────────────────────────────────────────────────────────────
-- FIX RLS: "new row violates row-level security policy for table folio_secuencia"
-- al crear servicios (fijos o eventuales) en Programación.
--
-- CAUSA: la tabla contador `folio_secuencia` tiene RLS activado (se prendió desde el
-- dashboard) y sin ninguna policy. El trigger BEFORE INSERT de `reservas` que asigna el
-- folio "ID AFA" (fn_reservas_set_codigo) hacía el INSERT/UPSERT en `folio_secuencia`
-- como SECURITY INVOKER → corría con el rol `authenticated` del navegador → RLS lo bloquea.
--
-- SOLUCIÓN: recrear la función como SECURITY DEFINER (corre como el dueño `postgres`, que
-- salta RLS por ser dueño de la tabla), fijando search_path. Mismo patrón que el trigger
-- sync_reserva_origen_destino. El contador NO queda expuesto al API: RLS sigue activo y sin
-- policy; solo el trigger puede tocarlo. Es idempotente: pegar en Supabase → SQL Editor.
-- ──────────────────────────────────────────────────────────────────────────────

create or replace function public.fn_reservas_set_codigo()
returns trigger
language plpgsql
security definer
set search_path = public, pg_temp
as $$
declare
  v_anio    int;
  v_n       int;
  v_prefijo text;
begin
  -- Respeta un código ya provisto (backfill, importaciones, migraciones).
  if new.codigo is not null and new.codigo <> '' then
    return new;
  end if;

  v_anio := extract(year from coalesce(new.fecha_servicio, (now() at time zone 'America/Lima')::date))::int;

  -- Incremento atómico del contador del año.
  insert into public.folio_secuencia (anio, ultimo)
    values (v_anio, 1)
    on conflict (anio) do update set ultimo = folio_secuencia.ultimo + 1
    returning ultimo into v_n;

  v_prefijo := coalesce((select valor from public.app_config where clave = 'folio_prefijo'), 'OS');

  new.codigo := case when v_prefijo <> '' then v_prefijo || '-' else '' end
                || v_anio::text || '-' || lpad(v_n::text, 6, '0');

  return new;
end;
$$;

-- El trigger ya existente (trg_reservas_set_codigo) sigue apuntando a esta función;
-- `create or replace function` no lo rompe. No hace falta recrearlo.

-- ── Verificación ────────────────────────────────────────────────────────────
-- Debe decir security_type = DEFINER:
--   select proname, prosecdef from pg_proc where proname = 'fn_reservas_set_codigo';
-- Prueba real: generar un servicio de prueba en Programación → ya no debe salir el error.
