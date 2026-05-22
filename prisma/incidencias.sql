-- Tabla `incidencias` — ya existe en Supabase (no requiere DDL).
-- Este archivo documenta el contrato del INSERT que hace `app/conductor/page.tsx`
-- en `enviarIncidencia()` para que cualquier cambio futuro al schema se coordine.

-- ─── Columnas que el INSERT del conductor consume ──────────────────────────
--   conductor_id  bigint     -- FK conductores.id
--   vehiculo_id   bigint     -- FK vehiculos.id
--   reserva_id    bigint     -- FK reservas.id (null si no hay viaje activo)
--   tipo          text NN    -- trafico|mecanica|pasajero|accidente|combustible|seguridad
--   severidad     text NN    -- leve|media|alta
--   descripcion   text NN    -- texto libre + sufijo "(retraso estimado: N min)" si aplica
--   ubicacion     text       -- nombre de la parada activa al momento del reporte
--   lat / lng     numeric    -- posición GPS del conductor
-- (estado, id, created_at, updated_at usan los defaults del schema actual:
--    estado = 'reportado', id = INC-YYYY-NNNN, created_at/updated_at = now())

-- ─── Diagnóstico — confirmar el contrato actual ─────────────────────────────
select column_name, data_type, is_nullable, column_default
from information_schema.columns
where table_schema = 'public' and table_name = 'incidencias'
order by ordinal_position;

-- ─── Sugerencias (opcional) ────────────────────────────────────────────────
-- Si más adelante se quiere modelar el retraso o la parada como columnas propias
-- en vez de texto embebido en descripcion/ubicacion:
--
--   alter table incidencias add column if not exists retraso_min integer;
--   alter table incidencias add column if not exists parada_id   bigint references paradas(id);
--
-- Y actualizar el INSERT en enviarIncidencia() para enviarlos estructurados.

-- Índices útiles (si todavía no existen)
create index if not exists idx_incidencias_reserva on incidencias (reserva_id);
create index if not exists idx_incidencias_created on incidencias (created_at desc);
create index if not exists idx_incidencias_estado  on incidencias (estado)
  where estado in ('reportado', 'en_revision');
