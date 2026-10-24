-- licitaciones-04-columnas-accesorias.sql — Tres datos que el módulo Licitaciones lee de otras fichas y que hoy no
-- tienen dónde vivir: el AÑO de una unidad tercerizada, la FECHA DE CONSTITUCIÓN de la empresa y el CONDUCTOR
-- TERCERIZADO dueño de un documento del legajo.
-- NO LA CORRE EL DEPLOY: Supabase → SQL Editor → pegar ENTERA → Run. Idempotente. No siembra ni rellena nada.
-- ORDEN: 01a → 01b → 02 → 03 → 04 (esta). No depende de las anteriores: se puede correr antes o sola.
-- SIN ESTA EL MÓDULO FUNCIONA Y LO DICE (ContextoLicitacion.migraciones): sin anio, una unidad tercerizada sale
-- «sin año, no se puede juzgar la antigüedad» (nunca «cumple»); sin fecha_constitucion, la experiencia «desde la
-- constitución» no se puede juzgar; sin conductor_tercero_id, los documentos de un conductor tercerizado no se
-- pueden subir al legajo. La pantalla nombra este archivo en ámbar.
-- SIN BACKFILL: el año de cada unidad de terceros y la fecha de constitución los escribe una persona (el año desde
-- el paso «Recursos», que lo guarda en la ficha). Escribir un año deducido sería inventar un dato.
-- empresa_perfil es LEGIBLE POR ANON (seguridad-01): la fecha de constitución es pública (Ficha RUC, SUNARP), por
-- eso puede ir ahí. Nada personal (DNI, firma del representante) va a empresa_perfil.
-- Bloqueo: columnas nullable sin default (PG11+: no reescriben la tabla); los CHECK y la FK revalidan
-- vehiculos_tercero y documentos_empresa (cientos de filas como mucho): un instante.

-- 1) vehiculos_tercero.anio — el mismo dato que vehiculos.anio (allí integer; aquí smallint: el año cabe).
alter table public.vehiculos_tercero add column if not exists anio smallint;
alter table public.vehiculos_tercero drop constraint if exists vehiculos_tercero_anio_ck,
  add constraint vehiculos_tercero_anio_ck check (anio is null or anio between 1950 and 2100);
comment on column public.vehiculos_tercero.anio is
  'Año de fabricación de la unidad tercerizada (lo escribe una persona; null = no se sabe). Lo juzga Licitaciones.';

-- 2) empresa_perfil.fecha_constitucion — para «N años de experiencia desde la constitución».
alter table public.empresa_perfil add column if not exists fecha_constitucion date;
comment on column public.empresa_perfil.fecha_constitucion is
  'Fecha de constitución de la empresa (Ficha RUC / SUNARP). Pública: empresa_perfil la lee anon. null = no se declaró.';

-- 3) documentos_empresa.conductor_tercero_id — el documento de un conductor de conductores_tercero (alcance
--    'conductor'). Un documento es de UN conductor: del propio (conductor_id) o del tercero, nunca de los dos (los
--    ids de las dos tablas se solapan). La FK aparte, con nombre: re-correr la deja igual.
alter table public.documentos_empresa add column if not exists conductor_tercero_id bigint;
alter table public.documentos_empresa drop constraint if exists documentos_empresa_conductor_tercero_id_fkey,
  add constraint documentos_empresa_conductor_tercero_id_fkey foreign key (conductor_tercero_id)
    references public.conductores_tercero(id) on delete set null;
alter table public.documentos_empresa drop constraint if exists documentos_empresa_un_conductor_ck,
  add constraint documentos_empresa_un_conductor_ck check (num_nonnulls(conductor_id, conductor_tercero_id) <= 1);
comment on column public.documentos_empresa.conductor_tercero_id is
  'Conductor TERCERIZADO dueño del documento (alcance conductor). Excluyente con conductor_id.';

-- 4) La lectura del legajo: por alcance y categoría, el más reciente primero (documentoVigente).
create index if not exists idx_documentos_empresa_alcance_cat on public.documentos_empresa (alcance, categoria, fecha_emision desc);
create index if not exists idx_documentos_empresa_cond_tercero on public.documentos_empresa (conductor_tercero_id)
  where conductor_tercero_id is not null;

-- Verificación (solo lee): las 3 columnas, sus CHECK/FK y los 2 índices.
select 'columna' as que, table_name || '.' || column_name as nombre, data_type || ' · nullable ' || is_nullable as detalle
  from information_schema.columns where table_schema = 'public'
   and (table_name, column_name) in (('vehiculos_tercero', 'anio'), ('empresa_perfil', 'fecha_constitucion'),
        ('documentos_empresa', 'conductor_tercero_id'))
union all select 'restricción', conrelid::regclass::text || '.' || conname, pg_get_constraintdef(oid) from pg_constraint
 where conname in ('vehiculos_tercero_anio_ck', 'documentos_empresa_conductor_tercero_id_fkey', 'documentos_empresa_un_conductor_ck')
union all select 'índice', indexname::text, indexdef from pg_indexes
 where schemaname = 'public' and indexname in ('idx_documentos_empresa_alcance_cat', 'idx_documentos_empresa_cond_tercero')
order by 1, 2;
-- FIN de licitaciones-04-columnas-accesorias.sql
