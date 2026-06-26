-- fix_ts: hora del ÚLTIMO fix GPS REAL recibido por el equipo del conductor.
-- NO es created_at (hora de envío): el "backstop" de la app web re-envía el MISMO punto
-- cada pocos segundos con un created_at NUEVO, pero con el MISMO fix_ts. Por eso:
--   • fix_ts que NO avanza por >3 min  → GPS congelado de verdad (se re-envía un fix viejo).
--   • fix_ts que avanza                → el equipo está vivo, aunque el bus esté parado en
--                                        GPS de baja precisión (red/FUSED devuelve el mismo
--                                        centroide en cada fix FRESCO).
-- Esto reemplaza la heurística por byte-identidad de coordenadas, que daba falso "GPS roto"
-- en buses parados con GPS de red. Ver components/seguimiento/ModalGps.tsx.
--
-- Nullable y SIN default: las filas históricas y las versiones viejas del APK quedan en NULL,
-- y el lector cae automáticamente a la heurística por precisión (no rompe nada).
alter table public.ubicaciones_gps
  add column if not exists fix_ts timestamptz;
