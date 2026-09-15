-- El Inbox CRM ahora consulta notificaciones_enviadas para mostrar qué recordatorio
-- automático le llegó a un contacto antes de que escribiera (lib/crm-avisos-automaticos.ts).
-- La consulta filtra por tipo/estado y hace `ilike destinatario, '%<9 dígitos>'` — sin
-- índice, cada apertura de conversación de WhatsApp escanea toda la tabla.
--
-- btree no sirve para un LIKE con comodín al INICIO ('%sufijo'); se usa trigram, que sí.
create extension if not exists pg_trgm;

create index if not exists idx_notif_enviadas_destinatario_trgm
  on public.notificaciones_enviadas
  using gin (destinatario gin_trgm_ops);
