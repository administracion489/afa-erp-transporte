-- supabase/ubicaciones-gps-simulado.sql
--
-- Marca los puntos GPS inyectados por una app de "GPS falso" en vez de venir de los sensores
-- del teléfono. Android lo expone en cada fix (Location.isFromMockProvider); el plugin de
-- fondo ya lo entregaba y el ERP lo estaba descartando antes de guardarlo.
--
-- TRES ESTADOS A PROPÓSITO (por eso admite NULL y no tiene DEFAULT false):
--   true  → el fix vino de una app simuladora.
--   false → comprobado y legítimo.
--   NULL  → NO SE PUDO COMPROBAR (primer plano, APK viejo, o punto anterior a esta columna).
-- Un DEFAULT false convertiría "no lo sé" en "está limpio", que es justo la afirmación que no
-- se puede hacer: dejaría 666.000 filas viejas certificadas como legítimas sin que nadie las
-- mirara.
--
-- SEGURO EN PRODUCCIÓN: añadir una columna NULLABLE sin default es una operación de metadatos
-- en PostgreSQL 11+, no reescribe la tabla ni bloquea las escrituras de GPS.
--
-- Idempotente: se puede correr varias veces sin efecto.

alter table ubicaciones_gps
  add column if not exists simulado boolean;

comment on column ubicaciones_gps.simulado is
  'true = fix de app de GPS falso (isFromMockProvider). false = comprobado legítimo. NULL = no se pudo comprobar.';

-- SIN ÍNDICE, A PROPÓSITO.
-- Una versión anterior creaba un índice parcial aquí. Se quitó por dos razones:
--   1. Nadie lo usa. El panel /gps-salud lee la traza por reserva_id (que YA tiene índice) y
--      cuenta los simulados en memoria; no hay ninguna consulta que filtre por esta columna.
--   2. No se puede crear sin riesgo desde el SQL Editor de Supabase: envuelve cada ejecución
--      en una transacción, y CREATE INDEX CONCURRENTLY no admite correr dentro de una
--      (ERROR 25001). Sin CONCURRENTLY, el índice toma un lock que bloquea los INSERT de
--      ubicaciones_gps — o sea, corta el rastreo de toda la flota mientras se construye.
-- Si algún día hace falta consultar "todos los puntos simulados de la flota", el índice se
-- añade entonces, y desde una conexión directa (psql) donde CONCURRENTLY sí funciona.
