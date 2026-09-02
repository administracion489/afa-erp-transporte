// ──────────────────────────────────────────────────────────────────────────────
// lib/costeo-conductor.ts — Cuánto cuesta un día de conductor.
//
// No es el sueldo entre 30. Es el COSTO EMPRESA —con gratificaciones, CTS,
// EsSalud y SCTR según el régimen laboral— dividido entre los días que esa
// persona de verdad trabajó. Entre una cuenta y otra hay un 24 % en pequeña
// empresa y un 38 % en el régimen general: no es un matiz, es la diferencia entre
// un servicio que deja y uno que no.
//
// LA FÓRMULA VIVE AQUÍ Y SOLO AQUÍ. En SQL, `v_conductor_planilla` publica los
// INSUMOS (sueldo, factores del régimen vigente, SCTR del período) y no calcula
// nada — si además calculara, habría dos motores con la misma fórmula y el día
// que divergen nadie sabría cuál de los dos números creer.
//
// LO QUE NO ENTRA, y es el error clásico que infla el costo un 13 %:
// **AFP y ONP son descuento del TRABAJADOR**, no aporte del empleador. Salen de
// su sueldo, no del bolsillo de la empresa.
// ──────────────────────────────────────────────────────────────────────────────

/** Los factores del régimen laboral. Espejo de `config_laboral_regimen`. */
export type RegimenLaboral = {
  regimen: "microempresa" | "pequena_empresa" | "general";
  nombre: string;
  /** Aporte del empleador sobre la remuneración computable. 0.09 = 9 %. */
  essalud_pct: number;
  /** En microempresa el trabajador va al SIS y el empleador aporta un fijo. */
  usa_sis: boolean;
  sis_aporte_mensual: number;
  /** Sueldos de gratificación al año: 2 general, 1 pequeña, 0 micro. */
  gratificaciones_sueldos: number;
  /** Ley 30334: el 9 % de EsSalud de la gratificación se le entrega al trabajador. */
  bonif_extraordinaria_pct: number;
  /** CTS en sueldos equivalentes al año: 1.1667 general, 0.5 pequeña, 0 micro. */
  cts_sueldos_anio: number;
  /** No cambia el desembolso mensual; cambia los días trabajados del año. */
  vacaciones_dias: number;
};

/** Los datos de la persona y de la empresa que no dependen del régimen. */
export type DatosConductor = {
  tipo_contrato: string | null;
  /** Remuneración básica mensual. Sin esto no hay costo empresa que calcular. */
  sueldo_basico: number | null;
  /** Cuando va por recibo por honorarios, su costo ES el del recibo. */
  honorario_dia?: number | null;
  /** Depende de tener hijos menores, no de la empresa. */
  tiene_asignacion: boolean;
  rmv: number;
  asignacion_familiar_pct: number;
  /** Por persona y mes. Sale de la factura del período o del valor configurado. */
  sctr_mensual: number;
};

export type CostoEmpresaMes = {
  /** Básico + asignación familiar. Es la base de EsSalud, gratificación y CTS. */
  remuneracionComputable: number;
  asignacionFamiliar: number;
  essalud: number;
  sctr: number;
  gratificaciones: number;
  bonifExtraordinaria: number;
  cts: number;
  /** Lo que le cuesta a la empresa cada mes esa persona. */
  total: number;
  /** total / básico. 1.24 en pequeña empresa, 1.38 en general. */
  factor: number;
  /** Por qué no se pudo calcular, cuando `total` es 0. */
  falta: string | null;
};

/** Costo empresa mensual de un conductor en planilla. */
export function costoEmpresaMes(c: DatosConductor, r: RegimenLaboral): CostoEmpresaMes {
  const vacio: CostoEmpresaMes = {
    remuneracionComputable: 0, asignacionFamiliar: 0, essalud: 0, sctr: 0,
    gratificaciones: 0, bonifExtraordinaria: 0, cts: 0, total: 0, factor: 0, falta: null,
  };

  const basico = Number(c.sueldo_basico ?? 0);
  if (!(basico > 0)) return { ...vacio, falta: "Falta el sueldo básico en la ficha del conductor." };

  // La asignación familiar es remuneración: entra en la base de EsSalud, de la
  // gratificación y de la CTS. Dejarla fuera subestima las tres.
  const asignacionFamiliar = c.tiene_asignacion ? Number(c.rmv || 0) * Number(c.asignacion_familiar_pct || 0) : 0;
  const remuneracionComputable = basico + asignacionFamiliar;

  const essalud = r.usa_sis
    ? Number(r.sis_aporte_mensual || 0)
    : remuneracionComputable * Number(r.essalud_pct || 0);

  const sctr = Number(c.sctr_mensual || 0);

  // Las gratificaciones se prorratean: 2 sueldos al año son 2/12 cada mes.
  const gratificaciones = (remuneracionComputable * Number(r.gratificaciones_sueldos || 0)) / 12;
  const bonifExtraordinaria = gratificaciones * Number(r.bonif_extraordinaria_pct || 0);
  const cts = (remuneracionComputable * Number(r.cts_sueldos_anio || 0)) / 12;

  const total = remuneracionComputable + essalud + sctr + gratificaciones + bonifExtraordinaria + cts;

  return {
    remuneracionComputable, asignacionFamiliar, essalud, sctr,
    gratificaciones, bonifExtraordinaria, cts,
    total,
    factor: total / basico,
    falta: null,
  };
}

export type CostoDia = {
  /** Costo empresa del mes. 0 cuando va por honorarios. */
  costoMes: number;
  /** Días en que esa persona tuvo servicio ese mes. El divisor real. */
  diasConServicio: number;
  /** Costo de un día completo de esa persona. */
  porDia: number;
  /**
   * El mismo costo contra los días laborables del mes. Se publica para poder
   * contrastar: la diferencia entre las dos cifras es lo que cuesta tener un
   * conductor sin ruta, y es una señal, no un error.
   */
  porDiaLaborable: number;
  /** Lo que carga UN servicio: el día repartido entre los servicios de esa jornada. */
  porServicio: number;
  /** Cómo se llegó al número, para poder mostrarlo en pantalla. */
  base: string;
  falta: string | null;
};

/**
 * Lo que carga un servicio por su conductor.
 *
 * PLANILLA: el sueldo es un costo del PERÍODO, no del servicio. Un conductor de
 * S/ 1,600 que hizo 26 servicios no cuesta S/ 1,600 en cada uno — imputarle el
 * mes entero a cada servicio multiplica el costo del mes por 26 y hace que todos
 * parezcan pérdida. Se prorratea por día trabajado y el día se reparte entre los
 * servicios que lo ocuparon.
 *
 * HONORARIOS: se contrata PARA ese servicio, así que su importe es del servicio y
 * va completo. No se prorratea nada.
 */
export function costoConductorServicio(
  c: DatosConductor,
  r: RegimenLaboral,
  opts: { diasConServicio: number; serviciosDelDia: number; diasLaborablesMes: number }
): CostoDia {
  const serviciosDelDia = Math.max(1, Math.round(opts.serviciosDelDia || 1));

  if (String(c.tipo_contrato ?? "") === "honorarios") {
    const dia = Number(c.honorario_dia ?? 0);
    if (!(dia > 0)) {
      return {
        costoMes: 0, diasConServicio: 0, porDia: 0, porDiaLaborable: 0, porServicio: 0,
        base: "", falta: "Falta el honorario por día en la ficha del conductor.",
      };
    }
    return {
      costoMes: 0,
      diasConServicio: 0,
      porDia: dia,
      porDiaLaborable: dia,
      porServicio: dia / serviciosDelDia,
      base: `recibo por honorarios · S/ ${dia.toFixed(2)} por día` +
            (serviciosDelDia > 1 ? ` · repartido entre ${serviciosDelDia} servicios` : ""),
      falta: null,
    };
  }

  const mes = costoEmpresaMes(c, r);
  if (mes.falta) {
    return {
      costoMes: 0, diasConServicio: 0, porDia: 0, porDiaLaborable: 0, porServicio: 0,
      base: "", falta: mes.falta,
    };
  }

  const dias = Math.max(0, Math.round(opts.diasConServicio || 0));
  const laborables = Math.max(1, Math.round(opts.diasLaborablesMes || 26));
  // Sin días con servicio no se puede prorratear: se cae al teórico y se dice.
  // Dividir entre cero daría Infinity y ese número llegaría hasta el precio.
  const usaLaborables = dias <= 0;
  const porDia = mes.total / (usaLaborables ? laborables : dias);
  const porDiaLaborable = mes.total / laborables;

  return {
    costoMes: mes.total,
    diasConServicio: dias,
    porDia,
    porDiaLaborable,
    porServicio: porDia / serviciosDelDia,
    base:
      `${r.nombre} · costo empresa S/ ${mes.total.toFixed(2)} (${mes.factor.toFixed(2)}× el básico) ÷ ` +
      (usaLaborables ? `${laborables} días laborables` : `${dias} días con servicio`) +
      (serviciosDelDia > 1 ? ` · repartido entre ${serviciosDelDia} servicios del día` : ""),
    falta: null,
  };
}
