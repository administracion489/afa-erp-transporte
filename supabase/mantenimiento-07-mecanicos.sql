-- ============================================================================
-- AFA Transportes — La hora de casa la hace una PERSONA, y esa persona ya existe.
-- Ejecutar en Supabase SQL Editor. Es IDEMPOTENTE: se puede correr dos veces.
-- Requiere: mantenimiento-06-lineas-de-costo.sql y costeo-01-planilla-y-presupuesto.sql.
-- ============================================================================
--
-- EL PENDIENTE QUE CIERRA
--
-- `mantenimiento-06` puso el sueldo del mecánico en `config_mantenimiento`, la fila única de
-- configuración, «porque hoy AFA habla de UN mecánico» — y dejó escrito que con dos o más se
-- quedaba corto. Esto es eso.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- NO SE CREA UNA TABLA `mecanicos`, Y ESA ES LA DECISIÓN ENTERA
--
-- La tentación es obvia y es la equivocada: un mecánico no es una entidad nueva, es una PERSONA
-- EN PLANILLA. Este ERP ya tiene dos sitios donde vive una persona con su sueldo —`conductores`
-- y `personal_administrativo`— y una tercera tabla sería el sueldo de alguien escrito en tres
-- lugares, que es exactamente lo que prohíbe la regla de oro: cada monto tiene UNA fila
-- autoritativa. El día que a esa persona le suban el sueldo habría que acordarse de los tres.
--
-- Un mecánico es `personal_administrativo`: ya tiene nombre, DNI, cargo, departamento, tipo de
-- contrato y estado, con su pantalla en /personal-administrativo. Lo único que le faltaba es lo
-- que `conductores` sí tiene y él no: **cuánto gana**.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- Y NO SE MARCA QUIÉN ES MECÁNICO. SE DERIVA DE QUIÉN SE PUEDE COSTEAR.
--
-- Una bandera `es_mecanico` es una casilla que alguien tiene que acordarse de marcar, y el día
-- que no la marca su hora no se puede cargar sin que nadie entienda por qué. El selector de la
-- orden de trabajo lista al personal activo **que tiene sueldo o tarifa configurada**, porque es
-- exactamente el que el ERP sabe valorizar: si no aparece, lo que falta es su sueldo, y eso se
-- arregla en su ficha. Misma regla que el `area` de caja chica: se DERIVA, no se copia.
--
-- Y el campo de la línea no se llama «mecánico» sino **quién hizo el trabajo**: si el contador
-- dedicó dos horas a una unidad, esas horas son tan reales como las del mecánico.
--
-- ─────────────────────────────────────────────────────────────────────────────
-- SOLO PLANILLA IMPUTA. QUIEN VA POR RECIBO SE PAGA, NO SE IMPUTA.
--
-- `origen = 'propio'` significa «ya estaba pagado». Eso es cierto de quien está en planilla: su
-- sueldo sale el 30 pase lo que pase. NO es cierto de quien va por honorarios: a esa persona se
-- le paga POR el trabajo, así que su línea es `comprado` con el importe de su recibo — el mismo
-- criterio que `modoCostoConductor` aplica desde siempre (`service` no se imputa porque ya está
-- dentro de la factura del proveedor). Contar una hora de honorarios como imputada la dejaría
-- fuera de `v_egresos`, que es donde esa plata SÍ tiene que estar.
-- ============================================================================

BEGIN;

-- ── 1 · LO QUE LE FALTABA A UNA PERSONA QUE NO CONDUCE ──────────────────────
-- Los mismos campos que `conductores` ya tiene, con los mismos nombres: `v_conductor_planilla`
-- y `v_personal_planilla` alimentan la MISMA función de TS (`costoEmpresaMes`), así que dos
-- nombres distintos para el mismo insumo serían dos formas de leer lo mismo.
ALTER TABLE public.personal_administrativo ADD COLUMN IF NOT EXISTS sueldo_basico       numeric(10,2);
ALTER TABLE public.personal_administrativo ADD COLUMN IF NOT EXISTS asignacion_familiar boolean NOT NULL DEFAULT false;
ALTER TABLE public.personal_administrativo ADD COLUMN IF NOT EXISTS honorario_dia       numeric(10,2);
ALTER TABLE public.personal_administrativo ADD COLUMN IF NOT EXISTS horas_mes           int;

COMMENT ON COLUMN public.personal_administrativo.sueldo_basico IS
  'Remuneración básica mensual. Con ella el ERP calcula su COSTO EMPRESA real '
  '(lib/costeo-conductor.ts) y puede valorizar una hora suya en una orden de trabajo.';
COMMENT ON COLUMN public.personal_administrativo.honorario_dia IS
  'Importe por día de quien va por recibo por honorarios. NO se imputa como hora propia: a esa '
  'persona se le paga POR el trabajo, así que su línea de la OT es `comprado`, no `propio`.';
COMMENT ON COLUMN public.personal_administrativo.horas_mes IS
  'Horas de taller al mes de ESTA persona, el divisor de su costo empresa. NULL = se usa el de '
  'config_mantenimiento.mecanico_horas_mes (la jornada del taller). Existe porque con dos '
  'personas una puede ser de medio tiempo, y repartir su sueldo entre la jornada completa '
  'abarataría su hora a la mitad.';

-- ── 2 · DE QUIÉN SON LAS HORAS DE UNA LÍNEA ─────────────────────────────────
ALTER TABLE public.ot_costo_linea ADD COLUMN IF NOT EXISTS personal_administrativo_id integer;

COMMENT ON COLUMN public.ot_costo_linea.personal_administrativo_id IS
  'Quién hizo el trabajo de esta línea. Es lo que permite que con dos personas cada una se '
  'valorice con SU costo empresa: sin esto, todas las horas salían a la tarifa de una sola. '
  'NULL en una línea `comprado` (ahí quien trabajó es el taller tercero) y en las anteriores a '
  'esta migración, que se valorizaron con la tarifa única.';

DO $$
BEGIN
  IF to_regclass('public.personal_administrativo') IS NOT NULL
     AND NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'fk_ot_linea_personal') THEN
    ALTER TABLE public.ot_costo_linea
      ADD CONSTRAINT fk_ot_linea_personal FOREIGN KEY (personal_administrativo_id)
      -- SET NULL y no CASCADE: dar de baja a una persona NO puede borrar el costo de una orden
      -- ya asentada. El importe se queda; lo que se pierde es de quién eran esas horas.
      REFERENCES public.personal_administrativo(id) ON DELETE SET NULL;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS idx_ot_linea_personal ON public.ot_costo_linea (personal_administrativo_id);

-- ── 3 · LOS INSUMOS DE CADA PERSONA ─────────────────────────────────────────
-- Espejo exacto de `v_conductor_planilla`, y por la misma razón: publica los INSUMOS y NO
-- CALCULA NADA. La fórmula del costo empresa vive una sola vez, en lib/costeo-conductor.ts —
-- si además calculara aquí, habría dos motores y el día que divergen nadie sabría cuál creer.
CREATE OR REPLACE VIEW public.v_personal_planilla AS
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
  SELECT pa.id                              AS personal_id,
         pa.nombre,
         pa.cargo,
         pa.departamento,
         pa.tipo_contrato,
         pa.sueldo_basico,
         pa.honorario_dia,
         pa.asignacion_familiar             AS tiene_asignacion,
         pa.horas_mes,
         cfg.regimen,
         cfg.rmv,
         cfg.asignacion_familiar_pct,
         cfg.sctr_mensual_defecto           AS sctr_mensual,
         reg.nombre                         AS regimen_nombre,
         reg.essalud_pct,
         reg.usa_sis,
         reg.sis_aporte_mensual,
         reg.gratificaciones_sueldos,
         reg.bonif_extraordinaria_pct,
         reg.cts_sueldos_anio,
         reg.vacaciones_dias
    FROM public.personal_administrativo pa, cfg, reg
   WHERE coalesce(pa.estado, 'activo') = 'activo';

COMMENT ON VIEW public.v_personal_planilla IS
  'INSUMOS del costo empresa de cada persona del equipo interno, con los factores del régimen '
  'vigente. La fórmula NO está aquí — vive en lib/costeo-conductor.ts, una sola vez. Solo '
  'personal ACTIVO: a quien está de baja no se le cargan horas nuevas.';

COMMIT;

-- ── 4 · COMPROBACIÓN ────────────────────────────────────────────────────────
-- Quién puede valorizar una hora hoy. Si sale vacío, ponle el sueldo (o el importe por día) a
-- tu mecánico en /personal-administrativo; hasta entonces el selector de la orden de trabajo
-- está vacío y lo dice.
SELECT nombre, cargo, departamento, tipo_contrato, sueldo_basico, honorario_dia, horas_mes,
       CASE WHEN tipo_contrato IN ('honorarios','practicante') AND coalesce(honorario_dia,0) > 0
              THEN 'por recibo — su línea va como COMPRADO, no como hora propia'
            WHEN coalesce(sueldo_basico,0) > 0
              THEN 'planilla — su hora se valoriza con su costo empresa real'
            ELSE 'SIN SUELDO — no aparece en el selector de la orden de trabajo' END AS diagnostico
  FROM public.v_personal_planilla
 ORDER BY (coalesce(sueldo_basico,0) > 0 OR coalesce(honorario_dia,0) > 0) DESC, nombre;
