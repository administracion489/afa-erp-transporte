-- CRM en tiempo real: sin estas tablas en la publicación de Realtime, el Inbox solo se
-- actualizaba al recargar. (La pantalla ahora también sondea cada 8 s como respaldo.)
-- Idempotente: se puede correr varias veces.
do $$
declare t text;
begin
  foreach t in array array['crm_mensajes','crm_conversaciones','crm_acciones_ia'] loop
    if not exists (select 1 from pg_publication_tables
                   where pubname = 'supabase_realtime' and schemaname = 'public' and tablename = t) then
      execute format('alter publication supabase_realtime add table public.%I', t);
    end if;
  end loop;
end $$;

-- Número de avisos fuera del CRM y sin IA: marcar el 905 438 216 como solo avisos.
update public.whatsapp_numeros
   set usa_crm = false, usa_avisos = true
 where display_phone_number = '51905438216';
-- FIN de crm-realtime.sql
