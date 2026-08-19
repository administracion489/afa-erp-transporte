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
-- se puede hacer: dejaría filas viejas certificadas como legítimas sin que nadie las mirara.
--
-- Idempotente: se puede correr varias veces sin efecto.

alter table ubicaciones_gps
  add column if not exists simulado boolean;

comment on column ubicaciones_gps.simulado is
  'true = fix de app de GPS falso (isFromMockProvider). false = comprobado legítimo. NULL = no se pudo comprobar.';

-- Índice parcial: solo indexa las filas sospechosas, que son (deberían ser) poquísimas.
-- Un índice completo sobre una tabla de 666.000+ puntos no se justifica para responder
-- "¿hubo GPS falso?".
--
-- CONCURRENTLY es OBLIGATORIO aquí: esta tabla recibe un punto cada ~4 segundos por cada bus
-- en ruta, y un CREATE INDEX normal toma un lock que BLOQUEA esas escrituras mientras dura —
-- es decir, cortaría el rastreo de toda la flota. Con CONCURRENTLY tarda más pero no bloquea.
--
-- OJO AL CORRERLO: CREATE INDEX CONCURRENTLY no puede ejecutarse dentro de una transacción.
-- En el SQL Editor de Supabase hay que lanzarlo SOLO, en su propia ejecución, separado del
-- ALTER de arriba. Si falla a medias deja un índice INVALID: se borra con
--   drop index if exists idx_ubicaciones_gps_simulado;
-- y se vuelve a lanzar.
create index concurrently if not exists idx_ubicaciones_gps_simulado
  on ubicaciones_gps (reserva_id, created_at)
  where simulado is true;
