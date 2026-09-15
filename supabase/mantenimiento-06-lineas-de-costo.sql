-- ============================================================================
-- AFA Transportes — Una orden de trabajo la pagan VARIOS bolsillos, y uno de
-- ellos no es un bolsillo.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- Requiere: mantenimiento-05-costo-factura-cxp.sql y costeo-01-planilla-y-presupuesto.sql.
-- ============================================================================
--
-- LO QUE FALTABA, DICHO POR EL DUEÑO: «¿qué pasa si los materiales los compramos aparte y la
-- mano de obra en un taller tercero? ¿Y a futuro, cuando tenga mi mecánico y solo compremos el
-- material?»
--
-- La OT tenía UN costo y UNA factura, o sea describía solo el caso «todo al mismo taller». Lo
-- normal es comprar el repuesto en un sitio y pagar la mano de obra en otro; y con mecánico
-- propio, no pagarle mano de obra a nadie porque ya está en la planilla.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- `origen` NO ES UNA ETIQUETA: DECIDE SI EL SOL ENTRA A `v_egresos`.
--
-- La pregunta exacta que contesta es **¿salió plata de la caja POR ESTA ORDEN?**
--   · `comprado` → sí. Suma a `mantenimiento.costo`, que es lo que publica `v_egresos`.
--   · `propio`   → no. La hora del mecánico de casa YA se pagó en la planilla y el repuesto de
--                  almacén YA se pagó cuando se compró. Contarlo como egreso nuevo sería contar
--                  el mismo sol dos veces — lo que evita `promoverGastos` filtrando `gasto_id is null`.
--
-- PERO NO ES GRATIS. Ese costo es real y es de ese vehículo: va a `mantenimiento.costo_imputado`,
-- el mismo patrón de `v_utilidad_servicio` con neumáticos y depreciación, y **entra al S/km
-- medido de la categoría**. Si no entrara, el día que AFA contrate un mecánico el S/km medido
-- BAJARÍA sin que el costo real hubiera bajado —solo se mudó a la planilla—, la columna «Medido»
-- propondría ese número más barato y el precio ofertado de la categoría bajaría con él. Un costo
-- corto no se discute antes de vender: se descubre cuando el servicio ya se prestó.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- `v_egresos` NO SE TOCA, Y ES LO QUE PRUEBA QUE NO SE DUPLICA NADA.
--
-- Sigue leyendo `coalesce(m.costo,0)`, que ahora es solo el desembolso. `costo_imputado` es una
-- columna nueva que esa vista no mira: el plano de GESTIÓN del costo por kilómetro y el plano del
-- EGRESO dejan de ser el mismo número, que es justo lo que el caso del mecánico propio exige.
-- ============================================================================

BEGIN;

-- ── 1 · LAS LÍNEAS DE COSTO ─────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS public.ot_costo_linea (
  id                  bigserial PRIMARY KEY,
  orden_trabajo_id    integer NOT NULL,
  -- Qué se pagó. Separa el repuesto del trabajo, que es el desglose que pide un taller.
  tipo                text NOT NULL DEFAULT 'material'
                      CHECK (tipo IN ('material','mano_obra','servicio')),
  -- ¿Salió plata por esta orden? Lo único que decide si entra al egreso.
  origen              text NOT NULL DEFAULT 'comprado'
                      CHECK (origen IN ('comprado','propio')),
  concepto            text,
  -- SIN IGV, el mismo criterio que el costo de la orden: el IGV se recupera como crédito fiscal
  -- y meterlo subiría el S/km de toda la categoría un 18 %.
  monto               numeric(12,2) NOT NULL DEFAULT 0,
  -- Solo en mano de obra propia. Se guardan los DOS factores, no solo el producto: sin ellos un
  -- importe suelto no se puede rehacer ni explicar el día que el sueldo del mecánico cambie.
  horas               numeric(8,2),
  tarifa_hora         numeric(10,2),
  -- De dónde salió la tarifa: 'costo_empresa' | 'tarifa_configurada'. Es el mismo criterio de
  -- `fuentes` en el presupuesto de servicio: un número sin procedencia no se puede auditar.
  tarifa_fuente       text,
  proveedor_id        integer,
  documento_compra_id bigint,
  -- Cuando la línea nació del costo tecleado en un ítem del checklist. Anclarla ahí es lo que
  -- impide que el ítem se cuente DOS veces (ver `repartoDeOT`).
  checklist_ot_id     integer,
  observacion         text,
  created_at          timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE public.ot_costo_linea IS
  'Un renglón de costo de una orden de trabajo, con su tipo, su origen, su proveedor y su '
  'comprobante. Las que hagan falta por orden: dos proveedores de repuestos, un taller tercero y '
  'el mecánico de casa caben en la misma OT. `origen` decide si el importe es egreso (comprado) o '
  'costo ya pagado por otra vía (propio).';
COMMENT ON COLUMN public.ot_costo_linea.origen IS
  '¿Salió plata de la caja POR ESTA ORDEN? comprado = sí, va a mantenimiento.costo y a v_egresos. '
  'propio = no (planilla o almacén), va a mantenimiento.costo_imputado y NO a v_egresos.';

-- Un ítem del checklist lo representa como mucho UNA línea: con dos, su costo se contaría por
-- partida doble y el índice es lo único que lo garantiza cuando dos pestañas escriben a la vez.
CREATE UNIQUE INDEX IF NOT EXISTS uq_ot_linea_checklist
  ON public.ot_costo_linea (checklist_ot_id) WHERE checklist_ot_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_ot_linea_ot        ON public.ot_costo_linea (orden_trabajo_id);
CREATE INDEX IF NOT EXISTS idx_ot_linea_documento ON public.ot_costo_linea (documento_compra_id);

-- Los FK van con `do $$` por lo mismo que en mantenimiento-05: perder la integridad referencial
-- de un dato accesorio es mejor que abortar la migración y dejar la pantalla sin dónde teclear.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_linea_ot') THEN
    ALTER TABLE public.ot_costo_linea
      ADD CONSTRAINT fk_ot_linea_ot FOREIGN KEY (orden_trabajo_id)
      REFERENCES public.ordenes_trabajo(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.checklist_ot') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_linea_checklist') THEN
    ALTER TABLE public.ot_costo_linea
      ADD CONSTRAINT fk_ot_linea_checklist FOREIGN KEY (checklist_ot_id)
      REFERENCES public.checklist_ot(id) ON DELETE CASCADE;
  END IF;
  IF to_regclass('public.documentos_compra') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_linea_documento') THEN
    ALTER TABLE public.ot_costo_linea
      ADD CONSTRAINT fk_ot_linea_documento FOREIGN KEY (documento_compra_id)
      REFERENCES public.documentos_compra(id) ON DELETE SET NULL;
  END IF;
  IF to_regclass('public.proveedores') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_linea_proveedor') THEN
    ALTER TABLE public.ot_costo_linea
      ADD CONSTRAINT fk_ot_linea_proveedor FOREIGN KEY (proveedor_id)
      REFERENCES public.proveedores(id) ON DELETE SET NULL;
  END IF;
END $$;

ALTER TABLE public.ot_costo_linea ENABLE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "ot_linea_all" ON public.ot_costo_linea;
CREATE POLICY "ot_linea_all" ON public.ot_costo_linea FOR ALL
  USING (auth.role() = 'authenticated') WITH CHECK (auth.role() = 'authenticated');

-- ── 2 · EL COSTO QUE NO ES EGRESO ───────────────────────────────────────────
ALTER TABLE public.mantenimiento ADD COLUMN IF NOT EXISTS costo_imputado numeric(12,2) NOT NULL DEFAULT 0;
COMMENT ON COLUMN public.mantenimiento.costo_imputado IS
  'Lo que costó la orden SIN que saliera plata por ella: la hora del mecánico de planilla, el '
  'repuesto sacado de almacén. NO entra a v_egresos (ya se pagó por otra vía) pero SÍ al S/km '
  'medido de la categoría. Mismo patrón que costo_imputado en v_utilidad_servicio.';

-- ── 3 · CON QUÉ SE VALORIZA LA HORA DE CASA ─────────────────────────────────
-- Los DOS métodos que pidió el dueño. Son escalones de una cascada, no una alternativa:
-- manda el costo empresa cuando se puede calcular (aritmética exacta sobre la planilla) y el
-- S/hora tecleado es el respaldo. Sin ninguno de los dos NO se inventa un número.
--
-- Viven en `config_mantenimiento` (fila única) y no en una tabla de mecánicos porque hoy AFA
-- habla de UN mecánico. PENDIENTE CONOCIDO: con dos o más, esto se queda corto y hay que
-- llevarlo a una tabla propia con su FK en la línea. No se adelanta: una tabla de personal que
-- nadie llena es una columna vacía que la pantalla tiene que explicar cada vez.
ALTER TABLE public.config_mantenimiento ADD COLUMN IF NOT EXISTS tarifa_hora_mecanico       numeric(10,2);
ALTER TABLE public.config_mantenimiento ADD COLUMN IF NOT EXISTS mecanico_nombre            text;
ALTER TABLE public.config_mantenimiento ADD COLUMN IF NOT EXISTS mecanico_sueldo_basico     numeric(10,2);
ALTER TABLE public.config_mantenimiento ADD COLUMN IF NOT EXISTS mecanico_asignacion        boolean NOT NULL DEFAULT false;
ALTER TABLE public.config_mantenimiento ADD COLUMN IF NOT EXISTS mecanico_horas_mes         int;

COMMENT ON COLUMN public.config_mantenimiento.mecanico_sueldo_basico IS
  'Remuneración básica del mecánico de planilla. Con ella, la hora de casa se valoriza con su '
  'COSTO EMPRESA real (lib/costeo-conductor.ts) en vez de con la tarifa tecleada.';
COMMENT ON COLUMN public.config_mantenimiento.tarifa_hora_mecanico IS
  'S/hora de taller, el respaldo cuando no se quiere publicar el sueldo del mecánico. Es una '
  'opinión que envejece: se teclea una vez y se queda mientras el sueldo sube.';

-- La vista publica los INSUMOS del costo empresa del mecánico y NO CALCULA NADA, igual que
-- `v_conductor_planilla`. La fórmula vive una sola vez, en lib/costeo-conductor.ts: si además
-- calculara aquí, habría dos motores con la misma fórmula y el día que divergen nadie sabría
-- cuál de los dos números creer.
CREATE OR REPLACE VIEW public.v_taller_mano_obra AS
  WITH cfg AS (
    SELECT c.regimen, c.rmv, c.asignacion_familiar_pct, c.sctr_mensual_defecto
      FROM public.config_laboral c WHERE c.id = 1
  ),
  reg AS (
    SELECT DISTINCT ON (r.regimen) r.*
      FROM public.config_laboral_regimen r, cfg
     WHERE r.regimen = cfg.regimen AND r.vigente_desde <= current_date
     ORDER BY r.regimen, r.vigente_desde DESC
  )
  SELECT m.tarifa_hora_mecanico,
         m.mecanico_nombre,
         m.mecanico_sueldo_basico,
         m.mecanico_asignacion            AS tiene_asignacion,
         coalesce(m.mecanico_horas_mes, 208) AS horas_mes,
         cfg.regimen,
         cfg.rmv,
         cfg.asignacion_familiar_pct,
         cfg.sctr_mensual_defecto         AS sctr_mensual,
         reg.nombre                       AS regimen_nombre,
         reg.essalud_pct,
         reg.usa_sis,
         reg.sis_aporte_mensual,
         reg.gratificaciones_sueldos,
         reg.bonif_extraordinaria_pct,
         reg.cts_sueldos_anio,
         reg.vacaciones_dias
    FROM public.config_mantenimiento m, cfg, reg
   WHERE m.id = 1;

COMMENT ON VIEW public.v_taller_mano_obra IS
  'INSUMOS para valorizar una hora de mecánico propio: su sueldo y los factores del régimen '
  'vigente. La fórmula NO está aquí — vive en lib/costeo-conductor.ts, una sola vez.';

-- ── 4 · ADOPCIÓN: LA FACTURA QUE YA COLGABA DE LA ORDEN ─────────────────────
-- `ordenes_trabajo.documento_compra_id` no se retira: sigue siendo válida para el caso de una
-- sola factura y es lo que ya está escrito. `facturasDeOT` junta esa con las de las líneas y
-- decide cuál puede representar a la orden en el libro — con dos o más, NINGUNA, porque
-- `mantenimiento.documento_compra_id` es escalar y elegir una haría creer que la otra no existe.
--
-- No se crean líneas desde lo ya guardado: un `costo_total` plano no dice qué parte fue repuesto
-- y qué parte mano de obra, y partirlo sería inventar el reparto. Las órdenes viejas siguen
-- funcionando tal cual —sin líneas, el reparto es idéntico al de antes y todo es desembolso—
-- y se detallan el día que alguien las abra.

COMMIT;

-- ── 5 · COMPROBACIÓN ────────────────────────────────────────────────────────
-- Lo que hay que mirar: `imputado` en 0 en todas las órdenes (todavía no hay mecánico propio) y
-- `desembolsado` igual al costo que ya estaba. En cuanto se cargue una línea propia, las dos
-- columnas se separan y `v_egresos` sigue contando solo la primera.
SELECT o.id AS ot, o.estado, o.costo_total,
       m.costo           AS desembolsado_en_el_libro,
       m.costo_imputado  AS imputado_en_el_libro,
       (SELECT count(*) FROM public.ot_costo_linea l WHERE l.orden_trabajo_id = o.id)                          AS lineas,
       (SELECT count(*) FROM public.ot_costo_linea l WHERE l.orden_trabajo_id = o.id AND l.origen = 'propio')  AS lineas_de_casa,
       (SELECT count(DISTINCT l.documento_compra_id) FROM public.ot_costo_linea l
         WHERE l.orden_trabajo_id = o.id AND l.documento_compra_id IS NOT NULL)                                AS facturas_en_lineas
  FROM public.ordenes_trabajo o
  LEFT JOIN public.mantenimiento m ON m.id = o.mantenimiento_id
 ORDER BY o.id DESC;

-- Con qué se valoriza hoy una hora de casa. `fuente` dice cuál de los dos métodos manda.
SELECT mecanico_nombre, mecanico_sueldo_basico, tarifa_hora_mecanico, horas_mes, regimen_nombre,
       CASE WHEN coalesce(mecanico_sueldo_basico,0) > 0 THEN 'costo empresa del mecánico'
            WHEN coalesce(tarifa_hora_mecanico,0)   > 0 THEN 'tarifa de taller tecleada'
            ELSE 'SIN TARIFA — una hora propia no se puede valorizar' END AS fuente
  FROM public.v_taller_mano_obra;
