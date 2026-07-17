-- Fusión / normalización de variantes en pasajeros.empresa
-- =============================================================================
-- PROBLEMA: `pasajeros.empresa` es TEXTO LIBRE (no es FK). El filtro/KPI de
-- /pasajeros agrupa por string EXACTO, así que dos grafías casi iguales de la
-- misma razón social salen como dos empresas distintas. Caso real:
--   "SNACKS AMERICA LATINA S.R.L"   (sin punto final)  → 8 pasajeros
--   "SNACKS AMERICA LATINA S.R.L."  (con punto final)  → 77 pasajeros
--
-- QUÉ HACE: agrupa por una CLAVE canónica (minúsculas + espacios colapsados +
-- sin espacios/puntos/comas al final) y reescribe TODAS las filas del grupo a la
-- grafía GANADORA = la más frecuente (la "lista mayor"). Desempate determinista:
-- más frecuente → grafía más larga (prefiere "S.R.L." con punto) → alfabética.
-- Coincide con lib/empresa.ts (agruparEmpresas) que ahora usa la UI.
--
-- SEGURIDAD: `empresa` no es FK y no participa de ningún índice único, constraint
-- ni trigger (la única unique de pasajeros es uq_pasajero_cliente_dni sobre
-- (dni, cliente_id)). Grupos, abordaje QR y radar referencian al pasajero por
-- id/cliente_id, nunca por este string. El Manifiesto MTC legal NO usa
-- pasajeros.empresa (usa el perfil de AFA). Por eso este UPDATE de texto puro no
-- puede romper integridad ni el documento legal. Alcanza a las filas ligadas a
-- reservas también (aparecen igual en el filtro de /pasajeros); el cambio es solo
-- cosmético (grafía) y no altera identidad ni datos del servicio.
--
-- CÓMO CORRER: ejecutá el PASO 0 y el PASO 1 primero (no cambian nada). Revisá el
-- preview del PASO 1. Si está bien, corré el PASO 2 y hacé COMMIT.

-- ══ PASO 0 · Verificar el esquema vivo (no cambia nada) ══════════════════════
-- El CREATE TABLE base de `pasajeros` no está versionado en el repo (se hizo en el
-- panel de Supabase). Estas consultas deberían devolver 0 filas. Si alguna devuelve
-- algo que dependa de `empresa`, revisalo ANTES del PASO 2.
select indexname, indexdef
  from pg_indexes
 where schemaname = 'public' and tablename = 'pasajeros'
   and indexdef ilike '%empresa%';

select conname, pg_get_constraintdef(oid) as definicion
  from pg_constraint
 where conrelid = 'public.pasajeros'::regclass
   and pg_get_constraintdef(oid) ilike '%empresa%';

-- ══ PASO 1 · DRY-RUN: previsualizar la fusión (no cambia nada) ═══════════════
-- Por cada clave con más de una grafía, muestra la ganadora y cada variante con
-- su conteo. Así ves exactamente qué se va a unir antes de tocar la tabla.
with base as (
  select id, empresa,
         nullif(regexp_replace(regexp_replace(lower(btrim(empresa)), '\s+', ' ', 'g'),
                               '[.,[:space:]]+$', ''), '') as clave,
         regexp_replace(btrim(empresa), '\s+', ' ', 'g')   as limpio
    from public.pasajeros
   where empresa is not null and btrim(empresa) <> ''
),
conteo as (
  select clave, limpio, count(*) as n
    from base
   group by clave, limpio
),
ganador as (
  select clave, canonico from (
    select clave, limpio as canonico,
           row_number() over (partition by clave
                              order by n desc, char_length(limpio) desc, limpio asc) as rn
      from conteo
  ) s where rn = 1
)
select c.clave,
       g.canonico as grafia_ganadora,
       c.limpio   as variante_actual,
       c.n        as pasajeros
  from conteo c
  join ganador g on g.clave = c.clave
 where c.clave in (select clave from conteo group by clave having count(*) > 1)
 order by c.clave, c.n desc;

-- ══ PASO 2 · APLICAR (transacción) ══════════════════════════════════════════
-- Reescribe pasajeros.empresa a la grafía ganadora de su clave. También limpia
-- espacios sobrantes en las que no tenían variante (idempotente: correrlo de nuevo
-- no cambia nada). Revisá y luego COMMIT (o ROLLBACK si algo se ve mal).
begin;

with base as (
  select id, empresa,
         nullif(regexp_replace(regexp_replace(lower(btrim(empresa)), '\s+', ' ', 'g'),
                               '[.,[:space:]]+$', ''), '') as clave,
         regexp_replace(btrim(empresa), '\s+', ' ', 'g')   as limpio
    from public.pasajeros
   where empresa is not null and btrim(empresa) <> ''
),
conteo as (
  select clave, limpio, count(*) as n
    from base
   group by clave, limpio
),
ganador as (
  select clave, canonico from (
    select clave, limpio as canonico,
           row_number() over (partition by clave
                              order by n desc, char_length(limpio) desc, limpio asc) as rn
      from conteo
  ) s where rn = 1
)
update public.pasajeros p
   set empresa = g.canonico
  from base b
  join ganador g on g.clave = b.clave
 where p.id = b.id
   and p.empresa is distinct from g.canonico;

-- Revisá cuántas filas cambiaron arriba. Si todo ok:
commit;
-- Si algo se ve mal, en vez del commit:
-- rollback;
