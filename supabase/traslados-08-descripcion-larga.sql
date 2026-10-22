-- traslados-08-descripcion-larga.sql — La descripción de la categoría de traslado para el cliente pasa de
-- 300 a 1000 caracteres (en renglones: cada salto de línea se imprime en el PDF).
-- NO la corre el deploy: SQL Editor de Supabase → pegar ENTERA → Run. Idempotente. Solo AMPLÍA el tope:
-- no cambia ninguna descripción guardada ni ningún PDF. Requiere traslados-07.
-- SIN ELLA: /tarifario → Vehículos guarda hasta 300 caracteres y, si se escribe más, dice que falta esta.

do $$ begin
  if not exists (select 1 from information_schema.columns where table_schema = 'public'
                   and table_name = 'traslado_categorias' and column_name = 'descripcion_cliente') then
    raise exception 'Antes de traslados-08 hay que correr: traslados-07-fotos-categoria.sql';
  end if;
end $$;

alter table public.traslado_categorias
  drop constraint if exists traslado_categorias_descripcion_ck,
  add constraint traslado_categorias_descripcion_ck check (descripcion_cliente is null
    or char_length(descripcion_cliente) <= 1000);

comment on column public.traslado_categorias.descripcion_cliente is
  'Texto para el cliente en «Características» (≤ 1000, en renglones: cada salto de línea se imprime). null = la frase por defecto con capacidad y bodega.';

-- Comprobación (solo lee): el tope que queda puesto.
select conname as restriccion, pg_get_constraintdef(oid) as regla
from pg_constraint where conname = 'traslado_categorias_descripcion_ck';
-- FIN de traslados-08-descripcion-larga.sql
