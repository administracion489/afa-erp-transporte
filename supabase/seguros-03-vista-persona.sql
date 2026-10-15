-- ═══════════════════════════════════════════════════════════════════════════
-- seguros-03-vista-persona.sql · v_seguro_persona: el vencimiento de cada
-- seguro de PERSONA (SCTR salud, SCTR pensión, Vida Ley), DERIVADO.
-- (NO la corre el deploy: Supabase → SQL Editor → Run, DESPUÉS de seguros-01 y
-- seguros-02. Idempotente: create or replace.)
--
-- UNA FILA por persona × tipo:
--   tabla        'conductor' | 'personal'   (los ids de las dos tablas se solapan)
--   persona_id   conductores.id | personal_administrativo.id
--   tipo         'sctr_salud' | 'sctr_pension' | 'vida_ley'
--   vencimiento  date, null = no se sabe / no tiene
--   fuente       'poliza' | 'ficha' | null (null cuando vencimiento es null)
--   seguro_id    la póliza que da ese vencimiento (solo con fuente 'poliza')
--
-- MAPEO DE TIPOS (el backend usa EXACTAMENTE estas claves): son los de
-- TIPOS_SEGURO de app/seguros/page.tsx, 1:1 — SCTR NO es un solo tipo. Salud y
-- pensión se contratan aparte (salud con EsSalud/EPS, pensión con ONP o una
-- aseguradora) y vencen por separado, igual que en la ficha. Una póliza que
-- cubra las dos se registra como DOS filas de `seguros` con sus coberturas.
--   seguros.tipo 'sctr_salud'   ↔ ficha sctr_salud_venc
--   seguros.tipo 'sctr_pension' ↔ ficha sctr_pension_venc
--   seguros.tipo 'vida_ley'     ↔ ficha vida_ley_venc, SOLO si vida_ley = true
--                                  (la misma regla que /conductores y /personal)
--
-- REGLA: si la persona está en alguna cobertura de una póliza de ese tipo,
-- manda la PÓLIZA: el fin más lejano entre ellas, coalesce(cobertura.hasta,
-- seguros.fecha_vencimiento). Una baja (hasta en el pasado) da una fecha vencida
-- — es la verdad, no se cae a la ficha. Si no está en ninguna, la FICHA.
-- No mira `desde` ni fecha_inicio: es "hasta cuándo está cubierto", no "desde".
-- La vista PUBLICA; el estado (vigente/por vencer/vencido) lo calcula el TS.
-- ═══════════════════════════════════════════════════════════════════════════

create or replace view public.v_seguro_persona
with (security_invoker = true) as
with fichas as (
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
)
select f.tabla, f.persona_id, f.tipo,
       coalesce(pol.fin, f.venc_ficha) as vencimiento,
       case when pol.fin is not null then 'poliza'
            when f.venc_ficha is not null then 'ficha' end as fuente,
       pol.seguro_id
from fichas f
left join lateral (
  select coalesce(sc.hasta, s.fecha_vencimiento) as fin, s.id as seguro_id
  from public.seguro_cobertura sc
  join public.seguros s on s.id = sc.seguro_id
  where s.tipo = f.tipo
    and ((f.tabla = 'conductor' and sc.conductor_id = f.persona_id)
      or (f.tabla = 'personal'  and sc.personal_administrativo_id = f.persona_id))
    and coalesce(sc.hasta, s.fecha_vencimiento) is not null
  order by coalesce(sc.hasta, s.fecha_vencimiento) desc, s.id desc
  limit 1
) pol on true;

revoke all on public.v_seguro_persona from anon;
grant select on public.v_seguro_persona to authenticated;

-- Verificación: cuántas filas salen de cada fuente.
-- select tabla, tipo, fuente, count(*) from public.v_seguro_persona group by 1,2,3 order by 1,2,3;

-- FIN de seguros-03-vista-persona.sql
