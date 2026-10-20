-- cotizaciones-05-plantillas-uso.sql — La plantilla PDF lleva su DISEÑO, se elige por REGLA (tipo de servicio × tipo de
-- cliente) y las condiciones del traslado de la IA pasan de traslados_config a una plantilla.
-- NO LA CORRE EL DEPLOY: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Segura antes o después del despliegue:
-- no cambia ningún PDF (las 4 plantillas de siempre dibujan lo mismo y el traspaso copia las listas que la IA imprime hoy)
-- ni siembra datos de ninguna empresa. SIN ELLA: la IA sigue con las listas de /tarifario → Ajustes de traslados,
-- /cotizaciones usa la principal, y «Duplicar» y las reglas salen apagados con un aviso que nombra este archivo.

-- 0) Requisitos: traslados-01 y seguridad-04 (lo que la IA manda SIN revisión solo lo escribe el módulo Cotizaciones).
do $$ declare f text := ''; begin
  if to_regclass('public.cotizacion_plantillas') is null then raise exception 'No existe cotizacion_plantillas.'; end if;
  if to_regprocedure('public.fn_puede_modulo(uuid,text)') is null or to_regprocedure('public.fn_traslados_updated_at()') is null
    then f := f || ' traslados-01-tablas.sql'; end if;
  if not exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'cotizacion_plantillas'
                    and policyname = 'cotizacion_plantillas_insert') then f := f || ' seguridad-04-perfil-y-plantillas.sql'; end if;
  if f <> '' then raise exception 'Antes de cotizaciones-05 hay que correr:%', f; end if;
end $$;

-- 1) El diseño deja de ser el id: las 4 de siempre dibujan el suyo; otra fila, el corporativo. «Duplicar» lo hereda.
alter table public.cotizacion_plantillas add column if not exists diseno text;
update public.cotizacion_plantillas set diseno = case when id in ('corporativo', 'moderno_fotos', 'turistico', 'ejecutivo')
  then id else 'corporativo' end where diseno is null;
alter table public.cotizacion_plantillas alter column diseno set default 'corporativo', alter column diseno set not null,
  drop constraint if exists cotizacion_plantillas_diseno_ck, drop constraint if exists cotizacion_plantillas_id_ck,
  add constraint cotizacion_plantillas_diseno_ck check (diseno in ('corporativo', 'moderno_fotos', 'turistico', 'ejecutivo'));
-- El id va en la URL (?editar=) y lo arma «Duplicar»: su CHECK se pone solo si TODAS las filas de hoy lo cumplen.
do $$ begin if not exists (select 1 from public.cotizacion_plantillas where id !~ '^[a-z0-9_]{3,40}$') then
  alter table public.cotizacion_plantillas add constraint cotizacion_plantillas_id_ck check (id ~ '^[a-z0-9_]{3,40}$');
end if; end $$;

-- 2) Qué plantilla usa cada cotización: una celda (tipo de servicio × tipo de cliente), una plantilla; sin celda, la
--    principal. Valores = lib/cotizacion-plantillas.ts (SERVICIOS_PLANTILLA, SEGMENTOS). Con reglas, no se borra.
create table if not exists public.cotizacion_plantilla_reglas (
  servicio     text not null check (servicio in ('traslado_ia', 'eventual', 'turismo', 'fijo')),
  segmento     text not null check (segmento in ('empresa', 'particular', 'extranjero')),
  plantilla_id text not null references public.cotizacion_plantillas(id) on delete restrict,
  updated_at   timestamptz not null default now(), primary key (servicio, segmento)
);
drop trigger if exists trg_cotizacion_plantilla_reglas_upd on public.cotizacion_plantilla_reglas;
create trigger trg_cotizacion_plantilla_reglas_upd before update on public.cotizacion_plantilla_reglas for each row
  execute function public.fn_traslados_updated_at();
-- Leer: el ERP. Escribir: el módulo Cotizaciones, como las plantillas (seguridad-04). Antes se quitan TODAS sus políticas
-- (una permisiva olvidada anularía las de abajo). anon: nada.
alter table public.cotizacion_plantilla_reglas enable row level security;
do $$ declare p record; begin for p in select policyname from pg_policies
  where schemaname = 'public' and tablename = 'cotizacion_plantilla_reglas' loop
  execute format('drop policy %I on public.cotizacion_plantilla_reglas', p.policyname); end loop; end $$;
create policy cotizacion_plantilla_reglas_leer on public.cotizacion_plantilla_reglas for select to authenticated using (true);
create policy cotizacion_plantilla_reglas_escribir on public.cotizacion_plantilla_reglas for all to authenticated
  using (public.fn_puede_modulo(auth.uid(), 'cotizaciones')) with check (public.fn_puede_modulo(auth.uid(), 'cotizaciones'));
revoke all on public.cotizacion_plantilla_reglas from anon;

-- 3) Las 4 listas de traslados_config quedan OBSOLETAS (no se borran: el código sin esta migración aún las lee). TRASPASO
--    (genérico, una sola vez): pasan a «Traslados (IA)», copia de `corporativo` con TODAS sus columnas (sus cuentas son las
--    que la IA imprime hoy), y si hay líneas solo para dólares, a «Traslados (IA) · dólares» (consideraciones + _usd).
--    No traspasa si falta traslados_config o `corporativo`, si ya hay reglas de la IA o si ya existen esas plantillas.
--    La config se lee con to_jsonb (tolera columnas que falten: sin traslados-07 no hay incluye / no_incluye).
do $$ declare c text; cfg jsonb; src jsonb; cols text; g jsonb; gu jsonb; o numeric; sql text; begin
  foreach c in array array['consideraciones', 'consideraciones_usd', 'incluye', 'no_incluye'] loop
    if exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'traslados_config'
                  and column_name = c) then execute format('comment on column public.traslados_config.%I is %L', c,
      'OBSOLETA desde cotizaciones-05-plantillas-uso.sql: el PDF del traslado de la IA toma sus condiciones de la plantilla '
      || 'de su regla (/cotizaciones/plantillas). No se borra.'); end if;
  end loop;
  if to_regclass('public.traslados_config') is null
     or exists (select 1 from public.cotizacion_plantilla_reglas where servicio = 'traslado_ia')
     or exists (select 1 from public.cotizacion_plantillas where id in ('traslados_ia', 'traslados_ia_usd'))
     or not exists (select 1 from public.cotizacion_plantillas where id = 'corporativo') then return; end if;
  cfg := jsonb_strip_nulls(coalesce((select to_jsonb(t) from public.traslados_config t order by t.id limit 1), '{}'));
  g := coalesce(cfg->'consideraciones', '[]'); gu := coalesce(cfg->'consideraciones_usd', '[]');
  o := coalesce((select max((to_jsonb(p)->>'orden')::numeric) from public.cotizacion_plantillas p), 0);
  src := (select to_jsonb(p) from public.cotizacion_plantillas p where p.id = 'corporativo') || jsonb_build_object(
    'es_principal', false, 'activa', true, 'diseno', 'corporativo', 'idioma', 'es', 'recomendado_para', null, 'icono', '🚐',
    'descripcion', 'Condiciones del PDF de los traslados que cotiza la IA (traspasadas de Ajustes de traslados).',
    'condiciones_incluye', coalesce(cfg->'incluye', '[]'), 'condiciones_no_incluye', coalesce(cfg->'no_incluye', '[]'),
    'created_at', now(), 'updated_at', now());
  cols := (select string_agg(format('%I', column_name), ', ' order by ordinal_position) from information_schema.columns
            where table_schema = 'public' and table_name = 'cotizacion_plantillas' and is_generated = 'NEVER'
              and identity_generation is distinct from 'ALWAYS');
  sql := format('insert into public.cotizacion_plantillas (%1$s) select %1$s from jsonb_populate_record(null::public.cotizacion_plantillas, $1)', cols);
  execute sql using src || jsonb_build_object('id', 'traslados_ia', 'nombre', 'Traslados (IA)', 'orden', o + 1, 'condiciones_generales', g);
  if jsonb_array_length(gu) > 0 then execute sql using src || jsonb_build_object('id', 'traslados_ia_usd',
    'nombre', 'Traslados (IA) · dólares', 'orden', o + 2, 'condiciones_generales', g || gu); end if;
  insert into public.cotizacion_plantilla_reglas (servicio, segmento, plantilla_id) values
    ('traslado_ia', 'empresa', 'traslados_ia'), ('traslado_ia', 'particular', 'traslados_ia'),
    ('traslado_ia', 'extranjero', case when jsonb_array_length(gu) > 0 then 'traslados_ia_usd' else 'traslados_ia' end);
end $$;

-- 4) Comprobación (solo lee): plantillas (listas generales/incluye/no incluye: NULL = las de cada cotización), reglas, CHECK.
select 'plantilla' as que, (j->>'id') || ' · ' || coalesce(j->>'nombre', '—') as detalle, 'diseño ' || coalesce(j->>'diseno', '—')
       || ' · activa ' || coalesce(j->>'activa', '—') || ' · principal ' || coalesce(j->>'es_principal', '—') || ' · listas '
       || (select string_agg(case jsonb_typeof(j->k) when 'array' then jsonb_array_length(j->k)::text else 'NULL' end, '/' order by n)
             from unnest(array['condiciones_generales', 'condiciones_incluye', 'condiciones_no_incluye']) with ordinality u(k, n)) as estado
  from (select to_jsonb(t) as j from public.cotizacion_plantillas t) x
union all select 'regla', servicio || ' × ' || segmento, plantilla_id from public.cotizacion_plantilla_reglas
union all select 'CHECK del formato del id', 'cotizacion_plantillas_id_ck', case when exists (select 1 from pg_constraint
    where conname = 'cotizacion_plantillas_id_ck') then 'puesto' else 'NO puesto: hay ids fuera de formato (ver el diagnóstico)' end
order by 1, 2;
-- FIN de cotizaciones-05-plantillas-uso.sql
