-- IA del CRM: apagarla por CONTACTO (proveedores, conductores) y candado contra la
-- respuesta repetida cuando llega una ráfaga de fotos. No la corre el deploy.
alter table public.crm_contactos      add column if not exists ia_desactivada boolean not null default false;
alter table public.crm_conversaciones add column if not exists ia_respondiendo_at timestamptz;
-- FIN de crm-ia-contactos.sql
