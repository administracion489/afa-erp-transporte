-- traslados-10-descripcion-ingles.sql — La descripción de la categoría de traslado para el cliente, EN INGLÉS:
-- traslado_categorias.descripcion_cliente_en (≤ 1000 caracteres, en renglones como la de castellano). La imprime el PDF
-- del traslado cuando la cotización va en inglés. NULL = en inglés va la frase del sistema con capacidad y bodega
-- («… for up to N passengers · luggage hold for M large (23 kg) suitcases»), NUNCA la descripción en castellano.
-- La escribe una persona en /tarifario → Zonas y traslados → Vehículos. SIN BACKFILL: traducir sola la de castellano
-- sería afirmar algo que nadie firmó. RLS: la columna hereda la de la tabla (escribe el módulo Tarifas, traslados-01).
-- NO la corre el deploy: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Requiere traslados-07 y traslados-08.
-- SIN ELLA: el PDF en inglés lleva la frase del sistema y la pantalla dice en ámbar que falta este archivo.
-- Bloqueo: la columna no tiene default (no reescribe la tabla) y el CHECK revalida unas pocas filas.

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'traslado_categorias' and column_name = 'descripcion_cliente') then
    raise exception 'Antes de traslados-10 hay que correr: traslados-07-fotos-categoria.sql y traslados-08-descripcion-larga.sql';
  end if;
  if not exists (select 1 from pg_constraint where conrelid = to_regclass('public.traslado_categorias')
                   and conname = 'traslado_categorias_descripcion_ck' and pg_get_constraintdef(oid) like '%1000%') then
    raise exception 'Antes de traslados-10 hay que correr: traslados-08-descripcion-larga.sql';
  end if;
end $$;

alter table public.traslado_categorias add column if not exists descripcion_cliente_en text;
alter table public.traslado_categorias
  drop constraint if exists traslado_categorias_descripcion_en_ck,
  add constraint traslado_categorias_descripcion_en_ck check (descripcion_cliente_en is null
    or char_length(descripcion_cliente_en) <= 1000);

comment on column public.traslado_categorias.descripcion_cliente_en is
  'Texto EN INGLÉS para el cliente en «Vehicle features» del PDF en inglés (≤ 1000, en renglones). null = la frase del sistema en inglés con capacidad y bodega; nunca la descripción en castellano.';

-- Comprobación (solo lee): el tope que queda puesto y cuántas categorías tienen descripción en cada idioma.
select conname::text as que, pg_get_constraintdef(oid) as detalle
  from pg_constraint where conrelid = 'public.traslado_categorias'::regclass
   and conname in ('traslado_categorias_descripcion_ck', 'traslado_categorias_descripcion_en_ck')
union all
select 'categorías', count(*) || ' · con descripción en castellano ' || count(descripcion_cliente)
       || ' · en inglés ' || count(descripcion_cliente_en) from public.traslado_categorias
order by 1;
-- FIN de traslados-10-descripcion-ingles.sql
