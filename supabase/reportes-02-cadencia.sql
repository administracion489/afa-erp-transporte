-- ════════════════════════════════════════════════════════════════════════════
-- reportes-02-cadencia.sql
-- CADA CUÁNTO se manda el reporte de ocupación y CUÁNTO periodo abarca.
--
-- EL DEPLOY NO CORRE ESTE ARCHIVO. Y no correrlo no rompe nada: sin estas dos
-- columnas el código lee `undefined` y cae a `semanal` + `7 días`, que es
-- exactamente lo que el módulo hacía antes de que los dos ejes existieran.
--
-- ─── SON DOS EJES, NO UNO ───────────────────────────────────────────────────
--
-- El reporte nació mandándose los sábados con los últimos 7 días y las dos cosas
-- venían pegadas. Lo pidió el dueño separado: se puede querer un envío QUINCENAL
-- que mire los últimos 30 días (una foto rodante cada dos semanas) o uno SEMANAL
-- que mire solo 7 (lo que pasó esa semana). Atarlos obligaría a elegir entre las
-- dos mitades de lo que alguien quiere.
--
-- ─── LOS DEFAULTS CONSERVAN EL COMPORTAMIENTO ───────────────────────────────
--
-- `semanal` + `7` es lo que ya estaba corriendo, así que correr este SQL no le
-- cambia el reporte a ningún cliente que ya lo tenga encendido. Lo mismo que hace
-- `lineasActivas` con `{personal}`: la migración abre opciones, no toma decisiones.
--
-- Los CHECK están a propósito: el código normaliza cualquier valor desconocido al
-- defecto (nunca apaga el reporte de nadie por un valor raro), pero dejar entrar
-- basura a la columna haría que la pantalla mostrara un desplegable vacío sin que
-- nada fallara. Un valor imposible se rechaza donde se escribe.
-- ════════════════════════════════════════════════════════════════════════════

alter table public.clientes
  add column if not exists reporte_ocupacion_frecuencia text not null default 'semanal';

alter table public.clientes
  drop constraint if exists clientes_reporte_ocupacion_frecuencia_check;
alter table public.clientes
  add constraint clientes_reporte_ocupacion_frecuencia_check
  check (reporte_ocupacion_frecuencia in ('semanal', 'quincenal', 'mensual', 'fin_de_mes'));

comment on column public.clientes.reporte_ocupacion_frecuencia is
  'Cada cuánto sale el reporte de ocupación. semanal = sábados · quincenal = días '
  '1 y 16 · mensual = día 1 · fin_de_mes = último día del mes. Todo se deriva del '
  'calendario, sin ancla guardada: un envío perdido no corre los siguientes.';

alter table public.clientes
  add column if not exists reporte_ocupacion_ventana text not null default '7';

alter table public.clientes
  drop constraint if exists clientes_reporte_ocupacion_ventana_check;
alter table public.clientes
  add constraint clientes_reporte_ocupacion_ventana_check
  check (reporte_ocupacion_ventana in ('7', '15', '30', 'mes'));

comment on column public.clientes.reporte_ocupacion_ventana is
  'Cuánto periodo abarca el reporte. 7/15/30 = los N días que cierran el día del '
  'envío. mes = el último mes calendario COMPLETO, que es lo que hace coherente '
  'la frecuencia fin_de_mes y la mensual (un envío del día 1 reporta el mes que '
  'acaba de cerrar, no un día suelto).';
