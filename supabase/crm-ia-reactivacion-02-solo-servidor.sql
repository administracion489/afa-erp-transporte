-- crm-ia-reactivacion-02-solo-servidor.sql — `crm_conversaciones.ia_reactivada_at` la escribe SOLO el servidor.
--   Esa hora dice desde cuándo la pausa por respuesta humana (`pausa_humano_horas`), el límite de turnos y
--   la espera tras corregir una cotización de traslado (lib/traslados/cotizacion-corregida.ts) cuentan
--   solo lo posterior. La tabla tiene la política «crm_all for all to authenticated using (true)», así que
--   cualquier sesión del ERP podía escribir ia_reactivada_at = '2099-01-01' desde la consola y la IA dejaba
--   de apartarse cuando contesta una persona y usaba al instante toda cotización corregida.
--   · La escribe solo POST /api/crm/ia/reactivar (service-role, con el módulo CRM y su `now()`).
--   · Este trigger, con la sesión de una persona (auth.uid() no es null): en un UPDATE conserva la que
--     había (lo que mande el navegador se descarta); en un INSERT la deja en null. El servidor y el SQL
--     Editor (sin auth.uid()) no cambian nada.
--   · El código, además, ignora una reactivación más de 5 min en el futuro
--     (MARGEN_RELOJ_REACTIVACION_MS, lib/crm-ia-reactivacion.ts): las que ya estén escritas así no cuentan.
-- Solo se instala si la columna existe (supabase/crm-ia-reactivacion.sql): una función que nombra un
-- campo que no existe rompería TODO update de la tabla.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente.

do $$
begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'crm_conversaciones' and column_name = 'ia_reactivada_at') then
    raise notice '[crm-ia-reactivacion-02] crm_conversaciones.ia_reactivada_at no existe: corre antes supabase/crm-ia-reactivacion.sql. No se instaló nada.';
    return;
  end if;

  execute $f$
    create or replace function public.fn_crm_conversaciones_reactivacion_solo_servidor()
    returns trigger
    language plpgsql
    security invoker
    set search_path = public, pg_temp
    as $b$
    begin
      -- Solo la sesión de una persona: no puede poner ni mover la reactivación.
      if auth.uid() is not null then
        if tg_op = 'INSERT' then
          new.ia_reactivada_at := null;
        else
          new.ia_reactivada_at := old.ia_reactivada_at;
        end if;
      end if;
      return new;
    end;
    $b$
  $f$;

  execute 'revoke all on function public.fn_crm_conversaciones_reactivacion_solo_servidor() from public, anon, authenticated';
  execute 'drop trigger if exists trg_crm_conversaciones_reactivacion_solo_servidor on public.crm_conversaciones';
  execute 'create trigger trg_crm_conversaciones_reactivacion_solo_servidor before insert or update on public.crm_conversaciones '
       || 'for each row execute function public.fn_crm_conversaciones_reactivacion_solo_servidor()';
end $$;

-- Volver atrás:
--   drop trigger if exists trg_crm_conversaciones_reactivacion_solo_servidor on public.crm_conversaciones;
--   drop function if exists public.fn_crm_conversaciones_reactivacion_solo_servidor();

-- Comprobación (solo lee). `reactivaciones_futuras`: las que ya quedaron escritas más de 5 min en el
-- futuro; el código no las cuenta. Para limpiarlas (opcional, desde aquí no las frena el trigger):
--   update public.crm_conversaciones set ia_reactivada_at = null where ia_reactivada_at > now() + interval '5 minutes';
select (select count(*) from pg_trigger where tgname = 'trg_crm_conversaciones_reactivacion_solo_servidor' and not tgisinternal) as triggers,
       (select count(*) from information_schema.columns where table_schema = 'public'
          and table_name = 'crm_conversaciones' and column_name = 'ia_reactivada_at') as columna,
       (select count(*) from pg_proc where proname = 'fn_crm_conversaciones_reactivacion_solo_servidor') as funcion,
       (select count(*) from public.crm_conversaciones c
          where (to_jsonb(c) ->> 'ia_reactivada_at')::timestamptz > now() + interval '5 minutes') as reactivaciones_futuras;

-- FIN de crm-ia-reactivacion-02-solo-servidor
