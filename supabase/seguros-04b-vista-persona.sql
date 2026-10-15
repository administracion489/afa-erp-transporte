-- ═══════════════════════════════════════════════════════════════════════════
-- seguros-04b-vista-persona.sql · v_seguro_persona con INCLUSIONES pendientes.
-- (NO la corre el deploy: Supabase → SQL Editor → Run, DESPUÉS de seguros-04a.
-- Idempotente: create or replace. Regla completa: seguros-04-notas.md.)
--
-- Conserva las 6 columnas de seguros-03 (mismo orden y tipo) y agrega al final:
--   inclusion            'solicitada' | 'por_iniciar' | null
--   inclusion_fecha      solicitada_en | inicio efectivo de la cobertura
--   inclusion_seguro_id  la póliza de esa inclusión
-- fuente pasa a admitir 'pendiente' (vencimiento null, NO se usa la ficha).
-- Gana el primer paso: 1 póliza vigente · 2 inclusión pendiente · 3 póliza
-- vencida o de baja · 4 ficha · 5 nada. Sin estados, sin `coberturas` y sin
-- inicios futuros da EXACTAMENTE lo mismo que seguros-03.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view public.v_seguro_persona
with (security_invoker = true) as
with h as (select (now() at time zone 'America/Lima')::date as hoy),
fichas as (
  select 'conductor'::text as tabla, c.id::bigint as persona_id, t.tipo,
         case t.tipo
           when 'sctr_salud'   then c.sctr_salud_venc::date
           when 'sctr_pension' then c.sctr_pension_venc::date
           when 'vida_ley'     then case when c.vida_ley is true then c.vida_ley_venc::date end
         end as venc_ficha
  from public.conductores c
  cross join (values ('sctr_salud'),('sctr_pension'),('vida_ley')) as t(tipo)
  union all
  select 'personal', p.id::bigint, t.tipo,
         case t.tipo
           when 'sctr_salud'   then p.sctr_salud_venc::date
           when 'sctr_pension' then p.sctr_pension_venc::date
           when 'vida_ley'     then case when p.vida_ley is true then p.vida_ley_venc::date end
         end
  from public.personal_administrativo p
  cross join (values ('sctr_salud'),('sctr_pension'),('vida_ley')) as t(tipo)
),
cob as (
  select case when sc.conductor_id is not null then 'conductor' else 'personal' end as tabla,
         coalesce(sc.conductor_id, sc.personal_administrativo_id)::bigint as persona_id,
         t.tipo, coalesce(sc.estado, 'incluida') as est, sc.solicitada_en,
         coalesce(sc.desde, s.fecha_inicio)::date as ini,
         coalesce(sc.hasta, s.fecha_vencimiento)::date as fin,
         s.id::bigint as seguro_id
  from public.seguro_cobertura sc
  join public.seguros s on s.id = sc.seguro_id
  cross join lateral unnest(coalesce(s.coberturas, array[s.tipo]::text[])) as t(tipo)
  where sc.conductor_id is not null or sc.personal_administrativo_id is not null
)
select f.tabla, f.persona_id, f.tipo,
       (case when vig.seguro_id is not null then vig.fin
             when pen.seguro_id is not null then null
             when ven.seguro_id is not null then ven.fin
             else f.venc_ficha end)::date as vencimiento,
       (case when vig.seguro_id is not null then 'poliza'
             when pen.seguro_id is not null then 'pendiente'
             when ven.seguro_id is not null then 'poliza'
             when f.venc_ficha is not null then 'ficha' end)::text as fuente,
       (case when vig.seguro_id is not null then vig.seguro_id
             when pen.seguro_id is null then ven.seguro_id end)::bigint as seguro_id,
       (case when vig.seguro_id is null then pen.inclusion end)::text as inclusion,
       (case when vig.seguro_id is null then pen.fecha end)::date as inclusion_fecha,
       (case when vig.seguro_id is null then pen.seguro_id end)::bigint as inclusion_seguro_id
from fichas f
cross join h
left join lateral (   -- 1 · cubre HOY
  select x.fin, x.seguro_id from cob x
  where x.tabla = f.tabla and x.persona_id = f.persona_id and x.tipo = f.tipo
    and x.est <> 'solicitada' and (x.ini is null or x.ini <= h.hoy) and x.fin >= h.hoy
  order by x.fin desc, x.seguro_id desc limit 1
) vig on true
left join lateral (   -- 2 · pendiente: por_iniciar antes que solicitada
  select case when x.est = 'solicitada' then 'solicitada' else 'por_iniciar' end as inclusion,
         case when x.est = 'solicitada' then x.solicitada_en else x.ini end as fecha,
         x.seguro_id from cob x
  where x.tabla = f.tabla and x.persona_id = f.persona_id and x.tipo = f.tipo
    and (x.est = 'solicitada' or (x.est = 'incluida' and x.ini > h.hoy))
  order by (x.est = 'solicitada'), 2 asc, x.seguro_id desc limit 1
) pen on true
left join lateral (   -- 3 · vencida o dada de baja (fin en el pasado)
  select x.fin, x.seguro_id from cob x
  where x.tabla = f.tabla and x.persona_id = f.persona_id and x.tipo = f.tipo
    and x.est <> 'solicitada' and (x.ini is null or x.ini <= h.hoy) and x.fin is not null
  order by x.fin desc, x.seguro_id desc limit 1
) ven on true;

revoke all on public.v_seguro_persona from anon;
grant select on public.v_seguro_persona to authenticated;

-- Verificación:
-- select fuente, inclusion, count(*) from public.v_seguro_persona group by 1,2 order by 1,2;

-- FIN de seguros-04b-vista-persona.sql
