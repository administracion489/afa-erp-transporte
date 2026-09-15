-- ============================================================================
-- AFA Transportes — El costo de una OT llega al libro, y la factura del taller
-- se vuelve una Cuenta por Pagar.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- ============================================================================
--
-- EL BUG QUE CIERRA, CON SUS DOS MITADES
--
-- 1 · EL COSTO SE CONGELABA. `ordenes_trabajo.costo_total` no lo lee nadie fuera de su propia
--     pantalla; quien cuenta el dinero es `mantenimiento.costo` (lo publica `v_egresos`, lo cruza
--     `v_costo_servicio` y con él se mide el S/km de cada categoría en /configuracion/costos).
--     La copia entre los dos ocurría UNA vez, en el instante de cerrar la OT. Una OT automática
--     nace en 0 y se cierra en 0 → esa fila queda en cero PARA SIEMPRE, y teclear el costo
--     después no movía nada.
--
--     Y no se podía arreglar solo, porque el único vínculo de vuelta era el TEXTO
--     «OT #4 — CWZ-371» dentro de `mantenimiento.descripcion`. Escribir bajo una clave y leer
--     con otra: el patrón que este repo ya pagó cinco veces. Por eso nace
--     `ordenes_trabajo.mantenimiento_id`, un FK de verdad.
--
-- 2 · LA FACTURA NO TENÍA DÓNDE ENTRAR. `mantenimiento.documento_compra_id` ya existía desde la
--     fase 06 y `v_egresos` ya lo publicaba — ninguna pantalla lo escribía. La factura del taller
--     es un comprobante de compra: ahí se aprueba, entra a un lote de pago, se concilia con el
--     banco y sustenta el crédito fiscal del IGV.
--
-- LO QUE ESTE ARCHIVO NO HACE, Y ES DELIBERADO: no crea ninguna fila en `gastos`. El egreso de
-- mantenimiento YA se cuenta, por `mantenimiento`; duplicarlo en `gastos` sería contar el mismo
-- sol dos veces en /finanzas — exactamente lo que evita `promoverGastos` de caja chica filtrando
-- `gasto_id is null`. Y `documentos_compra` se suma aparte, como declara el propio `v_egresos`,
-- así que enlazar la factura tampoco duplica nada.
-- ============================================================================

BEGIN;

-- ── 1 · EL COSTO POR ÍTEM ───────────────────────────────────────────────────
-- El PDF impreso de la OT lleva desde siempre un «Costo: S/ ______» al lado de cada repuesto,
-- para rellenar A MANO. Este es ese campo, ahora dentro del ERP.
--
-- `null` ≠ 0: null es «nadie lo tecleó» y 0 es «esta revisión no costó nada». De esa diferencia
-- depende cuál de los dos números manda como total de la orden (ver `totalDeOT`).
ALTER TABLE public.checklist_ot ADD COLUMN IF NOT EXISTS costo numeric(12,2);
COMMENT ON COLUMN public.checklist_ot.costo IS
  'Costo del repuesto/servicio de este ítem. NULL = sin teclear (distinto de 0). Si algún ítem '
  'tiene costo, el total de la OT se DERIVA de la suma y deja de ser editable.';

-- ── 2 · EL ANCLA ────────────────────────────────────────────────────────────
ALTER TABLE public.ordenes_trabajo ADD COLUMN IF NOT EXISTS mantenimiento_id integer;
ALTER TABLE public.ordenes_trabajo ADD COLUMN IF NOT EXISTS documento_compra_id bigint;

COMMENT ON COLUMN public.ordenes_trabajo.mantenimiento_id IS
  'La fila de `mantenimiento` que esta OT asentó al cerrarse. Es lo que permite que corregir el '
  'costo DESPUÉS del cierre llegue al egreso, al margen del servicio y al S/km medido. Antes el '
  'único vínculo era el texto "OT #N" dentro de mantenimiento.descripcion.';
COMMENT ON COLUMN public.ordenes_trabajo.documento_compra_id IS
  'La factura del taller como comprobante de compra (CxP). No duplica el egreso: v_egresos cuenta '
  'mantenimiento.costo y suma documentos_compra aparte.';

-- Los FK van con `do $$` porque la migración tiene que poder correrse en una base donde
-- `documentos_compra` no exista todavía: perder la integridad referencial de un dato accesorio es
-- mejor que abortar la migración entera y dejar la pantalla sin dónde teclear el costo.
DO $$
BEGIN
  IF to_regclass('public.mantenimiento') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_mantenimiento') THEN
    ALTER TABLE public.ordenes_trabajo
      ADD CONSTRAINT fk_ot_mantenimiento FOREIGN KEY (mantenimiento_id)
      REFERENCES public.mantenimiento(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.documentos_compra') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_documento_compra') THEN
    ALTER TABLE public.ordenes_trabajo
      ADD CONSTRAINT fk_ot_documento_compra FOREIGN KEY (documento_compra_id)
      REFERENCES public.documentos_compra(id) ON DELETE SET NULL;
  END IF;
END $$;

-- `mantenimiento.documento_compra_id` la declara finanzas-06 y `v_egresos` la lee. Se asegura
-- aquí por lo mismo que hace la fase 06 con `liquidacion_proveedor_id`: sin ella, el enlace desde
-- la OT fallaría fila por fila con un error que acusa a otra migración.
ALTER TABLE public.mantenimiento ADD COLUMN IF NOT EXISTS documento_compra_id bigint;

CREATE INDEX IF NOT EXISTS idx_ot_mantenimiento    ON public.ordenes_trabajo (mantenimiento_id);
CREATE INDEX IF NOT EXISTS idx_ot_documento_compra ON public.ordenes_trabajo (documento_compra_id);

-- ── 3 · ADOPCIÓN DE LAS OT YA CERRADAS ──────────────────────────────────────
-- El texto «OT #N» era la única pista, y se usa AQUÍ UNA SOLA VEZ para escribir el FK. A partir
-- de esta migración la verdad es el FK y nadie vuelve a leer ese texto.
--
-- SOLO SE ADOPTA LO INEQUÍVOCO, y las tres condiciones son obligatorias:
--   · una sola fila de `mantenimiento` nombra a esa OT (con dos, elegir sería atar el egreso a la
--     fila equivocada y las correcciones futuras irían a parar a otra orden),
--   · esa fila no está ya tomada por otra OT,
--   · coincide el vehículo — el texto es libre y alguien pudo teclear «OT #4» en la unidad que no era.
-- Lo que no cumpla las tres se queda sin ancla, y la pantalla lo DICE en vez de adivinar.
WITH candidatas AS (
  SELECT m.id AS mant_id,
         (regexp_match(m.descripcion, '(?:^|\s)OT\s*#\s*([0-9]+)\y', 'i'))[1]::int AS ot_id,
         m.vehiculo_id
    FROM public.mantenimiento m
   WHERE m.descripcion ~* '(^|\s)OT\s*#\s*[0-9]+'
), unicas AS (
  SELECT ot_id, min(mant_id) AS mant_id, count(*) AS n, min(vehiculo_id) AS vehiculo_id
    FROM candidatas
   GROUP BY ot_id
  HAVING count(*) = 1
)
UPDATE public.ordenes_trabajo o
   SET mantenimiento_id = u.mant_id
  FROM unicas u
 WHERE o.id = u.ot_id
   AND o.mantenimiento_id IS NULL
   AND o.vehiculo_id IS NOT DISTINCT FROM u.vehiculo_id
   AND NOT EXISTS (SELECT 1 FROM public.ordenes_trabajo o2
                    WHERE o2.mantenimiento_id = u.mant_id AND o2.id <> o.id);

-- ── 4 · EL COSTO QUE YA ESTABA TECLEADO, AL LIBRO ───────────────────────────
-- Las OT cerradas que tienen un `costo_total` > 0 y cuya fila quedó en cero: es justo el caso
-- reportado. Solo se escribe donde la fila está en 0 o en null — **nunca se pisa un importe que
-- ya dice algo**, porque ese pudo corregirse a mano en /mantenimiento → Historial y sería el
-- número bueno. Equivocarse hacia abajo en un costo es el error que no vuelve.
UPDATE public.mantenimiento m
   SET costo = o.costo_total
  FROM public.ordenes_trabajo o
 WHERE o.mantenimiento_id = m.id
   AND coalesce(o.costo_total, 0) > 0
   AND coalesce(m.costo, 0) = 0;

COMMIT;

-- ── 5 · COMPROBACIÓN ────────────────────────────────────────────────────────
-- Lo que hay que mirar: cuántas OT cerradas quedaron con ancla y cuántas no. Las que no, se
-- corrigen a mano en /mantenimiento → Historial; la pantalla las marca «sin vínculo con el libro».
SELECT o.id                AS ot,
       o.estado,
       o.fecha_cierre,
       o.costo_total       AS costo_ot,
       o.mantenimiento_id,
       m.costo             AS costo_en_el_libro,
       m.kilometraje,
       CASE WHEN o.mantenimiento_id IS NULL AND o.estado = 'cerrada' THEN 'SIN ANCLA — revisar a mano'
            WHEN coalesce(o.costo_total,0) = 0 AND o.estado = 'cerrada' THEN 'sin costo tecleado'
            ELSE 'ok' END  AS diagnostico
  FROM public.ordenes_trabajo o
  LEFT JOIN public.mantenimiento m ON m.id = o.mantenimiento_id
 ORDER BY o.id DESC;
