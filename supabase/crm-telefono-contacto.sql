-- El número de quien escribe, visible en el ERP.
--
-- El webhook de Meta guardaba el número del cliente SÓLO en `crm_contactos.wa_id` (la
-- clave con la que Meta identifica al remitente y con la que hay que responderle), y
-- nunca escribía `telefono`. Como el Inbox y el Pipeline pintan `telefono`, todo
-- contacto creado automáticamente por WhatsApp aparecía sin número: se veía el nombre
-- del cliente y no había forma de llamarlo desde la pantalla.
--
-- El webhook ya escribe ambas columnas a partir de este cambio. Esto rellena el
-- histórico para no tener que esperar a que cada cliente vuelva a escribir.
--
-- `wa_id` es E.164 sin "+" (51987654321), así que se copia literal: el formateo se hace
-- al pintar (lib/crm-telefono.ts), nunca al guardar.

-- Sólo donde falta. El filtro `telefono is null` es lo que impide pisar un número que
-- alguien corrigió a mano, que siempre es mejor dato que el de WhatsApp.
update crm_contactos
   set telefono = wa_id
 where telefono is null
   and wa_id is not null
   and wa_id ~ '^[0-9]{7,15}$';   -- descarta cualquier wa_id con forma rara

comment on column crm_contactos.telefono is
  'Teléfono del contacto. Para los creados por el webhook de WhatsApp es una copia de wa_id (E.164 sin "+"); tiene prioridad sobre wa_id al mostrarlo porque puede haberse corregido a mano.';

comment on column crm_contactos.wa_id is
  'Identificador de WhatsApp del remitente (E.164 sin "+"). Es la clave con la que Meta exige responder — NO reformatear. Para mostrar el número usa telefono, con wa_id de respaldo.';

-- Se busca por número en el Inbox; con el histórico ya poblado el índice tiene sentido.
create index if not exists idx_crm_contacto_telefono
  on crm_contactos (telefono);
