-- ══════════════════════════════════════════════════════════════════════════════
-- COMISIONES · FASE 05 — vendedor_id INMUTABLE + cierre de lecturas con PII
--
-- QUÉ HACE:
--   1) Trigger BEFORE UPDATE en `cotizaciones`: si la fila YA tiene vendedor_id, el
--      UPDATE no lo puede cambiar (NEW.vendedor_id := OLD.vendedor_id). El INSERT no
--      pasa por aquí — ahí el creador ES el vendedor.
--   2) Estrecha el SELECT de comisiones_reclamos / comisiones_cancelaciones /
--      comisiones_cobro_prueba de `using(true)` a SOLO APROBADOR (fn_es_aprobador):
--      llevan notas/juicios sobre servicios ajenos (PII). La UI pasa por la API con
--      service-role (que ignora RLS), así que esto no la rompe.
--
-- POR QUÉ: el motor atribuye TODA comisión según cotizaciones.vendedor_id, y
-- `cotizaciones` hereda la política blanket `for all to authenticated using(true)`
-- (seguridad-01), así que cualquier usuario autenticado podía REESCRIBIRLO por consola
-- (robo de comisión) y el propio UPDATE del cliente lo reatribuía al editar. Inmutable
-- una vez puesto cierra las dos puertas. Y las tres tablas de clasificación/pruebas
-- exponían PII de servicios ajenos a cualquiera con sesión.
--
-- SI NO SE CORRE: vendedor_id sigue mutable/forjable desde el cliente (el frontend ya
-- dejó de reescribirlo en el UPDATE, lo que mitiga la reatribución al editar, pero no
-- el robo por consola); y las tres tablas siguen legibles por cualquier autenticado.
--
-- Requiere: 02 (cotizaciones.vendedor_id), 03 (las tres tablas), finanzas-06
-- (fn_es_aprobador). Idempotente, reversible. EL DEPLOY NO LO CORRE.
-- ══════════════════════════════════════════════════════════════════════════════

-- ── 1) vendedor_id inmutable una vez puesto ─────────────────────────────────
create or replace function public.fn_cotizaciones_vendedor_inmutable()
returns trigger language plpgsql as $$
begin
  -- Cierra el robo por UPDATE y la reatribución al editar. Puesto una vez, no cambia.
  if OLD.vendedor_id is not null then
    NEW.vendedor_id := OLD.vendedor_id;
  end if;
  return NEW;
end;
$$;

-- El trigger dispara en CADA update de cotizaciones, así que solo se instala si la
-- columna existe (si falta 02, no romper todas las ediciones de cotización).
do $$
begin
  if exists (select 1 from information_schema.columns
              where table_schema='public' and table_name='cotizaciones'
                and column_name='vendedor_id') then
    drop trigger if exists trg_cotizaciones_vendedor_inmutable on public.cotizaciones;
    create trigger trg_cotizaciones_vendedor_inmutable
      before update on public.cotizaciones
      for each row execute function public.fn_cotizaciones_vendedor_inmutable();
  else
    raise notice '[comisiones05] cotizaciones.vendedor_id no existe; corre comisiones-02 primero. Trigger NO instalado.';
  end if;
end $$;

-- ── 2) SELECT de clasificaciones/pruebas: solo aprobador (PII) ──────────────
do $$
declare t text;
begin
  foreach t in array array['comisiones_reclamos','comisiones_cancelaciones','comisiones_cobro_prueba'] loop
    if to_regclass('public.'||t) is not null then
      execute format('alter table public.%I enable row level security', t);
      execute format('drop policy if exists %I on public.%I', t || '_sel', t);
      execute format(
        'create policy %I on public.%I for select to authenticated using (public.fn_es_aprobador(auth.uid()))',
        t || '_sel', t);
    else
      raise notice '[comisiones05] tabla % no existe; corre comisiones-03 primero.', t;
    end if;
  end loop;
end $$;

-- ── reversión ───────────────────────────────────────────────────────────────
-- drop trigger if exists trg_cotizaciones_vendedor_inmutable on public.cotizaciones;
-- drop function if exists public.fn_cotizaciones_vendedor_inmutable();
-- -- y volver las políticas a using(true), si de verdad se quiere (NO recomendado):
-- do $$ declare t text; begin
--   foreach t in array array['comisiones_reclamos','comisiones_cancelaciones','comisiones_cobro_prueba'] loop
--     execute format('drop policy if exists %I on public.%I', t||'_sel', t);
--     execute format('create policy %I on public.%I for select to authenticated using (true)', t||'_sel', t);
--   end loop; end $$;

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- Un UPDATE que intenta reatribuir debe quedar sin efecto:
--   update public.cotizaciones set vendedor_id = '00000000-0000-0000-0000-000000000000'
--     where id = (select id from public.cotizaciones where vendedor_id is not null limit 1);
--   -- vendedor_id sigue siendo el original.
-- select polname, pg_get_expr(polqual, polrelid) from pg_policy
--   where polrelid = 'public.comisiones_reclamos'::regclass;
