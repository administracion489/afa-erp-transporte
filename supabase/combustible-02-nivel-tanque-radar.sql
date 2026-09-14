-- supabase/combustible-02-nivel-tanque-radar.sql
--
-- LA AGUJA DEL TABLERO, QUE YA LLEGA EN LA FOTO Y NADIE MIRABA.
--
-- `combustible.tanque_lleno` (combustible-01) separa dos causas que hoy producen el mismo rojo:
-- una carga PARCIAL no declarada infla el rendimiento exactamente igual que una carga comprada
-- y no registrada (`rendimiento_alto`), y solo la segunda es plata que falta en los libros.
-- El formulario de /combustible ya la escribe; el Radar no tenía con qué.
--
-- Y sí tiene con qué: el conductor fotografía el tablero al cargar y en esa misma foto sale el
-- indicador de nivel. Esta columna guarda lo que la IA dice haber visto ahí — nada más.
--
-- LO QUE ESTA COLUMNA NO ES: una decisión. `tanque_lleno_fuente` distingue un `true` observado
-- por una persona de uno heredado de la política, y `ia_aguja` está declarado en su CHECK como
-- "PROPUESTA, nunca decisión". Por eso el auto-registro del Radar **sigue sin escribir
-- `tanque_lleno`** (queda en null, que ANCLA por la política, exactamente como hoy):
--
--   · `lleno`      → no cambia nada; si la fila llega a revisión por otro motivo, la casilla
--                    nace marcada y declarándose `ia_aguja`.
--   · `parcial`    → levanta la anomalía `carga_parcial_probable`, que BLOQUEA el auto-registro.
--                    Es el único caso en que la medición por defecto está mal, y es raro: que lo
--                    confirme una persona cuesta un clic, y dejarlo pasar mide mal ese tramo.
--   · `no_visible` → silencio. Tri-estado: no se afirma nada por ausencia de evidencia.
--
-- Correr una vez en el editor SQL de Supabase. Nullable y sin default → seguro de correr antes
-- o después del deploy. EL DEPLOY NO LA CORRE. Sin ella, el Radar funciona igual que hoy: el
-- código reintenta la escritura sin la columna y la propuesta de la aguja simplemente no existe.

alter table public.radar_combustible
  add column if not exists nivel_tanque text;

alter table public.radar_combustible drop constraint if exists radar_combustible_nivel_tanque_chk;
alter table public.radar_combustible
  add constraint radar_combustible_nivel_tanque_chk
  check (nivel_tanque is null or nivel_tanque in ('lleno', 'parcial', 'no_visible'));

comment on column public.radar_combustible.nivel_tanque is
  'Lo que la IA leyó en el indicador de nivel de la foto del tablero, DESPUÉS de cargar. '
  'Propone el valor de `combustible.tanque_lleno` en el panel de revisión; nunca lo decide sola.';

-- ── Verificación sugerida ────────────────────────────────────────────────────
-- select nivel_tanque, count(*) from public.radar_combustible group by 1 order by 2 desc;
