-- Trazabilidad del número de WhatsApp por el que ENTRÓ cada mensaje.
--
-- El webhook de Meta es a nivel de WABA, así que los dos números de la cuenta
-- (CRM/ventas +51 966707225 y AVISOS +51 905438216) caen en el mismo Inbox.
-- Hasta ahora `value.metadata.phone_number_id` se leía sólo para decidir si
-- contestaba la IA y se descartaba: era imposible saber a qué número escribió
-- el cliente. Estas columnas lo persisten.
--
-- Las filas anteriores a esta migración quedan en NULL (el dato no se guardó
-- nunca); la única fuente para el histórico es WhatsApp Manager de Meta.

alter table crm_mensajes
  add column if not exists phone_number_id      text,
  add column if not exists display_phone_number text;

alter table crm_conversaciones
  add column if not exists phone_number_id      text,
  add column if not exists display_phone_number text;

comment on column crm_conversaciones.phone_number_id is
  'phone_number_id de Meta del número de la empresa por el que entró la conversación (CRM vs AVISOS). NULL en conversaciones previas a ago-2026.';

-- El Inbox filtra por número → índice sobre el campo de agrupación.
create index if not exists idx_crm_conv_phone_number
  on crm_conversaciones (phone_number_id, ultimo_mensaje_at desc);
