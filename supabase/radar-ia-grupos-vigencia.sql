-- supabase/radar-ia-grupos-vigencia.sql — "¿este grupo lo ve el número conectado HOY?"
--
-- Incremental sobre supabase/radar-ia.sql (ya corrido en prod). Correr una vez en el
-- editor SQL de Supabase.
--
-- radar_grupos solo CRECÍA: sincronizarGrupos insertaba los nuevos y actualizaba los ya
-- conocidos, pero nunca marcaba los que dejaron de verse. Al cambiar el número del Radar
-- (p.ej. porque WhatsApp bloqueó el anterior) la lista quedaba mezclada: los grupos del
-- número viejo seguían ahí, indistinguibles de los del nuevo. Y lo peligroso: los que
-- estaban en "Monitorear" seguían en ON aparentando que se vigilaban, sin que pudiera
-- llegar un solo mensaje — el número nuevo no es miembro de esos grupos.
--
-- No se borran, se MARCAN: conservan el contexto que se le escribió a ELIA, las
-- categorías permitidas y los mensajes ya capturados (radar_mensajes.grupo_id).

alter table radar_grupos add column if not exists visible boolean not null default true;
alter table radar_grupos add column if not exists visto_en timestamptz;

-- Bandera para pedir una resincronización desde /radar-ia, igual que solicitar_relink.
-- Antes, si la lectura de grupos fallaba al conectar (un timeout basta), no había forma
-- de reintentarla: había que esperar el barrido de cada 30 min o reiniciar el worker.
alter table radar_estado add column if not exists solicitar_sync_grupos boolean not null default false;

-- Última vez que el worker LOGRÓ leer la lista de grupos de WhatsApp (no cuando lo intentó).
-- Es lo que permite decir en pantalla "esta lista es de hace 3 días" en vez de mentir.
alter table radar_estado add column if not exists grupos_sincronizados_en timestamptz;
