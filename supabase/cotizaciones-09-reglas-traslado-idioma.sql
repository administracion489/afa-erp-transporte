-- cotizaciones-09-reglas-traslado-idioma.sql — La plantilla PDF del traslado que cotiza la IA se elige por IDIOMA ×
-- MONEDA (castellano/inglés × soles/dólares), en una tabla APARTE: cotizacion_plantilla_reglas_traslado (4 celdas).
--   · es/PEN y es/USD: el TRASPASO (paso 3, una sola vez) copia las celdas de hoy (traslado_ia × particular o empresa,
--     y × extranjero): el castellano sigue imprimiendo lo mismo que hoy.
--   · en/PEN y en/USD: NACEN VACÍAS. El inglés solo se enciende cuando una PERSONA asigna una plantilla en inglés,
--     corporativa y activa, a una de esas celdas en /cotizaciones/plantillas. Correr este archivo NO lo enciende.
-- Por qué una tabla nueva: la vieja (servicio × segmento) la lee el código desplegado, y cambiar su clave o su CHECK no
-- es seguro antes del despliegue. La vieja NO se toca: eventual, turismo y fijo siguen ahí.
-- NO LA CORRE EL DEPLOY: SQL Editor → pegar ENTERA → Run. Idempotente. Segura antes o después del despliegue: el código
-- anterior no mira esta tabla. SIN ELLA: la IA cotiza en castellano, como hoy, aunque el cliente escriba en inglés, y
-- la cuadrícula de Plantillas PDF nombra este archivo. Requiere traslados-01, cotizaciones-04 y cotizaciones-05.

-- 0) Requisitos.
do $$ declare f text := ''; begin
  if to_regprocedure('public.fn_puede_modulo(uuid,text)') is null or to_regprocedure('public.fn_traslados_updated_at()') is null
    then f := f || ' traslados-01-tablas.sql'; end if;
  if not exists (select 1 from information_schema.columns where table_schema = 'public' and table_name = 'cotizaciones'
                    and column_name = 'idioma_pdf') then f := f || ' cotizaciones-04-moneda-idioma.sql'; end if;
  if to_regclass('public.cotizacion_plantilla_reglas') is null or not exists (select 1 from information_schema.columns
       where table_schema = 'public' and table_name = 'cotizacion_plantillas' and column_name = 'diseno')
    then f := f || ' cotizaciones-05-plantillas-uso.sql'; end if;
  if f <> '' then raise exception 'Antes de cotizaciones-09 hay que correr:%', f; end if;
end $$;

-- 1) Una celda (idioma × moneda), una plantilla. Sin fila: en castellano la IA usa la principal; en inglés, el inglés
--    queda APAGADO en esa moneda. Valores = lib/cotizacion-plantillas.ts (CELDAS_TRASLADO).
create table if not exists public.cotizacion_plantilla_reglas_traslado (
  idioma       text not null check (idioma in ('es', 'en')),
  moneda       text not null check (moneda in ('PEN', 'USD')),
  plantilla_id text not null references public.cotizacion_plantillas(id) on delete restrict,
  updated_at   timestamptz not null default now(), primary key (idioma, moneda)
);
drop trigger if exists trg_cotizacion_plantilla_reglas_traslado_upd on public.cotizacion_plantilla_reglas_traslado;
create trigger trg_cotizacion_plantilla_reglas_traslado_upd before update on public.cotizacion_plantilla_reglas_traslado
  for each row execute function public.fn_traslados_updated_at();
comment on table public.cotizacion_plantilla_reglas_traslado is
  'Plantilla PDF del traslado de la IA por idioma × moneda (cotizaciones-09). Las celdas en inglés las asigna una persona en /cotizaciones/plantillas: sin ellas, la IA cotiza en castellano.';

-- 2) Leer: el ERP. Escribir: el módulo Cotizaciones, como las plantillas y la tabla vieja. Antes se quitan TODAS sus
--    políticas (una permisiva olvidada anularía las de abajo). anon: nada.
alter table public.cotizacion_plantilla_reglas_traslado enable row level security;
do $$ declare p record; begin for p in select policyname from pg_policies
  where schemaname = 'public' and tablename = 'cotizacion_plantilla_reglas_traslado' loop
  execute format('drop policy %I on public.cotizacion_plantilla_reglas_traslado', p.policyname); end loop; end $$;
create policy cotizacion_plantilla_reglas_traslado_leer on public.cotizacion_plantilla_reglas_traslado
  for select to authenticated using (true);
create policy cotizacion_plantilla_reglas_traslado_escribir on public.cotizacion_plantilla_reglas_traslado for all to authenticated
  using (public.fn_puede_modulo(auth.uid(), 'cotizaciones')) with check (public.fn_puede_modulo(auth.uid(), 'cotizaciones'));
revoke all on public.cotizacion_plantilla_reglas_traslado from anon;
grant select, insert, update, delete on public.cotizacion_plantilla_reglas_traslado to authenticated;
grant all on public.cotizacion_plantilla_reglas_traslado to service_role;

-- 3) TRASPASO (genérico, una sola vez: solo si la tabla nueva está VACÍA y hay reglas viejas de traslado_ia).
--    es/PEN ← la de particular (o la de empresa, si particular no tiene) · es/USD ← la de extranjero. Si empresa y
--    particular difieren, la de empresa no se traspasa y se avisa. NO inserta nada en inglés.
--    Ojo: vaciar esta tabla a mano y volver a correr el archivo la rellena con las reglas viejas.
do $$ declare pa text; em text; ex text; begin
  if exists (select 1 from public.cotizacion_plantilla_reglas_traslado)
     or not exists (select 1 from public.cotizacion_plantilla_reglas where servicio = 'traslado_ia') then return; end if;
  pa := (select plantilla_id from public.cotizacion_plantilla_reglas where servicio = 'traslado_ia' and segmento = 'particular');
  em := (select plantilla_id from public.cotizacion_plantilla_reglas where servicio = 'traslado_ia' and segmento = 'empresa');
  ex := (select plantilla_id from public.cotizacion_plantilla_reglas where servicio = 'traslado_ia' and segmento = 'extranjero');
  if em is distinct from pa then raise notice
    'traslado_ia × empresa (%) y × particular (%) no usan la misma plantilla: castellano · soles queda con «%»: desde ahora la usan empresas y particulares.',
    coalesce(em, 'ninguna'), coalesce(pa, 'ninguna'), coalesce(pa, em); end if;
  insert into public.cotizacion_plantilla_reglas_traslado (idioma, moneda, plantilla_id)
    select 'es', 'PEN', coalesce(pa, em) where coalesce(pa, em) is not null
    union all select 'es', 'USD', ex where ex is not null;
end $$;

-- 4) Las filas traslado_ia de la tabla vieja quedan OBSOLETAS (no se borran: el código sin este despliegue aún las lee).
comment on table public.cotizacion_plantilla_reglas is
  'Plantilla PDF por tipo de servicio × tipo de cliente (cotizaciones-05). Las filas traslado_ia quedan OBSOLETAS desde cotizaciones-09 (solo las lee el código anterior); no se borran.';

-- 5) Comprobación (solo lee): las 4 celdas, las plantillas con su idioma y si la IA puede usarlas, y las reglas viejas.
with pl as (select id, nombre, case when lower(trim(coalesce(idioma, ''))) = 'en' then 'en' else 'es' end as idi,
                   coalesce(idioma, 'NULL') as idioma_crudo, diseno, activa is distinct from false as act
              from public.cotizacion_plantillas)
select '1 celda nueva' as que, c.o || '. ' || c.i || ' · ' || c.m as detalle, coalesce(r.plantilla_id || coalesce(' («' || pl.nombre || '», idioma '
       || pl.idi || case when pl.act and pl.diseno = 'corporativo' and pl.idi = c.i then ', la IA puede usarla)'
       else ', la IA NO puede usarla en esta celda)' end, ' (NO EXISTE)'), case when c.i = 'es' then 'vacía: usa la principal'
       else 'vacía: inglés apagado en esta moneda' end) as estado
  from (values (1, 'es', 'PEN'), (2, 'es', 'USD'), (3, 'en', 'PEN'), (4, 'en', 'USD')) c(o, i, m)
  left join public.cotizacion_plantilla_reglas_traslado r on r.idioma = c.i and r.moneda = c.m
  left join pl on pl.id = r.plantilla_id
union all select '2 plantilla', id || ' · ' || nombre, 'idioma ' || idioma_crudo || ' · diseño ' || diseno || ' · activa '
       || act::text || ' · ' || case when act and diseno = 'corporativo' then 'sirve para la IA en '
       || case idi when 'en' then 'inglés' else 'castellano' end else 'no sirve para la IA' end from pl
union all select '3 regla vieja (OBSOLETA)', servicio || ' × ' || segmento, plantilla_id
  from public.cotizacion_plantilla_reglas where servicio = 'traslado_ia'
order by 1, 2;
-- FIN de cotizaciones-09-reglas-traslado-idioma.sql
