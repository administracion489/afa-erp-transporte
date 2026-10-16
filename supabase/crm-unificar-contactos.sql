-- CRM: junta contactos repetidos y sus chats. No la corre el deploy. Se puede repetir.
-- Dos causas: (a) el mismo número guardado de dos formas; (b) mensajes que llegaron sin
-- número (cliente con «usuario» de WhatsApp): cada uno creaba un contacto SIN número con
-- el mismo nombre (el «Charle Herrera» ×3).
drop index if exists public.uq_crm_conv_abierta;

do $$
declare fk record;
begin
  create temp table _dupc on commit drop as
    select id, first_value(id) over (partition by clave order by created_at, id) as keeper
    from (
      select id, created_at,
             case
               when length(right(regexp_replace(coalesce(wa_id, telefono, ''), '\D', '', 'g'), 9)) = 9
                 and coalesce(wa_id, telefono) !~ '[A-Za-z]'
                 then 'n:' || right(regexp_replace(coalesce(wa_id, telefono, ''), '\D', '', 'g'), 9)
               when wa_id is null and telefono is null and coalesce(canal_origen, 'whatsapp') = 'whatsapp'
                    and coalesce(trim(nombre), '') <> ''
                 then 's:' || lower(trim(nombre))
             end as clave
      from public.crm_contactos
    ) x
    where clave is not null;
  delete from _dupc where id = keeper;

  update public.crm_contactos k set
    email = coalesce(k.email, d.email), empresa = coalesce(k.empresa, d.empresa), telefono = coalesce(k.telefono, d.telefono)
  from (select x.keeper, max(c.email) email, max(c.empresa) empresa, max(c.telefono) telefono
          from _dupc x join public.crm_contactos c on c.id = x.id group by x.keeper) d
  where k.id = d.keeper;

  for fk in
    select cl.relname as tabla, a.attname as col
    from pg_constraint c
    join pg_class cl on cl.oid = c.conrelid
    join pg_attribute a on a.attrelid = c.conrelid and a.attnum = c.conkey[1]
    where c.confrelid = 'public.crm_contactos'::regclass and c.contype = 'f'
  loop
    execute format('update public.%I t set %I = d.keeper from _dupc d where t.%I = d.id', fk.tabla, fk.col, fk.col);
  end loop;

  create temp table _wa on commit drop as
    select d.keeper, max(c.wa_id) wa from _dupc d join public.crm_contactos c on c.id = d.id
    where c.wa_id is not null group by d.keeper;
  delete from public.crm_contactos where id in (select id from _dupc);
  update public.crm_contactos k set wa_id = w.wa from _wa w where k.id = w.keeper and k.wa_id is null;

  -- Un solo chat abierto por contacto y canal.
  create temp table _dup on commit drop as
    select id, first_value(id) over (partition by contacto_id, canal order by created_at, id) as keeper
    from public.crm_conversaciones where estado <> 'resuelta';
  delete from _dup where id = keeper;

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
     set no_leidos = coalesce(k.no_leidos, 0) + s.n, ultimo_mensaje_at = greatest(k.ultimo_mensaje_at, s.ult)
    from (select d.keeper, sum(coalesce(c.no_leidos, 0)) n, max(c.ultimo_mensaje_at) ult
            from _dup d join public.crm_conversaciones c on c.id = d.id group by d.keeper) s
   where k.id = s.keeper;

  delete from public.crm_conversaciones where id in (select id from _dup);
end $$;

create unique index if not exists uq_crm_conv_abierta
  on public.crm_conversaciones (contacto_id, canal) where estado <> 'resuelta';
-- FIN de crm-unificar-contactos.sql
