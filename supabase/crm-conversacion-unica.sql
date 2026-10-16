-- CRM: una sola conversación ABIERTA por contacto y canal. No la corre el deploy.
-- Varios mensajes seguidos llegaban en webhooks paralelos y cada uno creaba su propio hilo
-- (el «Charle Herrera» ×3). Esto (1) junta los duplicados que ya existen en el más antiguo,
-- con sus mensajes, notas y propuestas, y (2) crea el índice que impide que vuelva a pasar.
do $$
declare fk record;
begin
  create temp table _dup on commit drop as
    select id, first_value(id) over (partition by contacto_id, canal order by created_at, id) as keeper
    from public.crm_conversaciones
    where estado <> 'resuelta';
  delete from _dup where id = keeper;

  -- Todo lo que cuelga de una conversación se pasa a la que se queda.
  for fk in
    select cl.relname as tabla, a.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.crm_conversaciones'::regclass and c.contype = 'f'
  loop
    execute format('update public.%I t set %I = d.keeper from _dup d where t.%I = d.id', fk.tabla, fk.col, fk.col);
  end loop;

  update public.crm_conversaciones k
     set no_leidos = coalesce(k.no_leidos, 0) + s.n,
         ultimo_mensaje_at = greatest(k.ultimo_mensaje_at, s.ult)
    from (select d.keeper, sum(coalesce(c.no_leidos, 0)) as n, max(c.ultimo_mensaje_at) as ult
            from _dup d join public.crm_conversaciones c on c.id = d.id group by d.keeper) s
   where k.id = s.keeper;

  delete from public.crm_conversaciones where id in (select id from _dup);
end $$;

create unique index if not exists uq_crm_conv_abierta
  on public.crm_conversaciones (contacto_id, canal) where estado <> 'resuelta';
-- FIN de crm-conversacion-unica.sql
