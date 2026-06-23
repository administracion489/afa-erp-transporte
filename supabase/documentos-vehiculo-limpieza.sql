-- supabase/documentos-vehiculo-limpieza.sql
-- =============================================================================
-- AFA Transportes · Limpieza de columnas legadas en `documentos_vehiculo`.
--
-- La tabla arrastraba columnas duplicadas por deriva de esquema:
--   · tipo_documento   (legada, NOT NULL)  ⟶  el app usa `tipo`
--   · numero_documento (legada, nullable)  ⟶  el app usa `numero`
--
-- El NOT NULL de `tipo_documento` rompía el alta de documentos (SOAT, etc.),
-- porque el formulario solo escribe `tipo`/`numero`. Ningún archivo del código
-- referencia `tipo_documento` ni `numero_documento` (verificado por grep).
--
-- ORDEN DE EJECUCIÓN (importante):
--   1) Despliega/redeploya el código (la página /documentos-vehiculares ya
--      escribe únicamente `tipo` y `numero`).
--   2) Recién entonces corre este script en el SQL Editor de Supabase.
--   Si se corre antes del redeploy, el alta de documentos fallará de forma
--   transitoria hasta que el redeploy termine (no hay pérdida de datos).
--
-- Es idempotente (DROP COLUMN IF EXISTS) y NO usa CASCADE: si alguna vista o
-- trigger dependiera de estas columnas, el script falla con un error claro en
-- lugar de borrar nada en cadena.
-- =============================================================================

ALTER TABLE documentos_vehiculo
  DROP COLUMN IF EXISTS tipo_documento;

ALTER TABLE documentos_vehiculo
  DROP COLUMN IF EXISTS numero_documento;
