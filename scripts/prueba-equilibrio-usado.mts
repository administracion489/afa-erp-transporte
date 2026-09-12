// Matriz del PUNTO DE EQUILIBRIO de una categoría USADA contra su gemela PREMIUM.
// Uso:  npx tsx scripts/prueba-equilibrio-usado.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · QUE EL EQUILIBRIO EQUILIBRE DE VERDAD. Se calcula el número, se mete en la ficha usada y
//     se vuelve a correr la fórmula ÚNICA del S/km: las dos fichas tienen que costar lo mismo.
//     Es la única prueba que importa — un despeje mal hecho da un número que parece razonable.
//
// 2 · QUE EL REDONDEO VAYA HACIA ARRIBA, SIEMPRE. Medio céntimo del lado caro no le mueve el
//     precio a nadie; del lado barato hace que el ERP afirme que la unidad usada cuesta menos,
//     que es exactamente lo que no se puede afirmar sin medirlo.
//
// 3 · LOS CÓDIGOS. `sin_gemela`, `parametro_incompleto` e `imposible` existen para que la
//     pantalla enrute por código y no por un número mágico (un 0 o un negativo colados en el
//     campo de mantenimiento serían dinero escrito al azar).
//
// 4 · LA IDENTIDAD DEL PAR. El sufijo `_ESTANDAR` es la CLAVE que escribió costos-02 y no se
//     renombra nunca; el nombre visible sí cambió. Y `emparejarFlota` no puede PERDER una ficha:
//     una usada huérfana que no se lista es una ficha activa que se sigue cotizando y nadie ve.
//
// 5 · EL CASO REAL (Sprinter 17 de AFA, con sus números de producción) y el que lo motivó: el
//     ×1.60 de costos-02 la dejaba más cara que su gemela nueva.
//
// 6 · QUE EL MOTIVO NO SE CONFUNDA CON UNA MEDICIÓN. `motivoEquilibrio` NO lleva el prefijo
//     "Auto:", que es el sello de `motivoHistorialMant`: si lo llevara,
//     `procedenciaMantDeHistorial` marcaría la ficha como medida y el chip dejaría de proponer
//     el número real el día que exista.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const EQ = requerir("../lib/costos/equilibrio-usado") as typeof import("../lib/costos/equilibrio-usado");
const CKM = requerir("../lib/costos/costo-km-parametro") as typeof import("../lib/costos/costo-km-parametro");
const MANT = requerir("../lib/costos/mantenimiento-tipo") as typeof import("../lib/costos/mantenimiento-tipo");

const {
  SUFIJO_USADO, esUsado, clavePremiumDe, claveUsadaDe, emparejarFlota,
  compararPar, mantenimientoDeEquilibrio, motivoEquilibrio, RENGLONES,
} = EQ;
const { costoKmDeParametro } = CKM;

type ParametrosCostoKm = import("../lib/costos/costo-km-parametro").ParametrosCostoKm;

const PRECIOS = { "Diésel": 24.64, "Gasolina": 22.00, "UREA": 2.50 };

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── FIXTURES ──────────────────────────────────────────────────────────────────

function ficha(o: Partial<ParametrosCostoKm> = {}): ParametrosCostoKm {
  return {
    tipo_combustible_1: "Diésel", rendimiento_1: 28.61, pct_uso_1: 1,
    tipo_combustible_2: null, rendimiento_2: null, pct_uso_2: null,
    usa_urea: false, consumo_urea_pct: 0.04,
    n_neumaticos: 6, costo_neumatico: 1500, vida_neumatico_km: 65000,
    mantenimiento_km: 0.85,
    valor_compra: 140000, residual_pct: 0.18, vida_util_anios: 10, km_anio: 60000,
    seguro_anual: 6000, soat_anual: 400, revision_semestral: 180,
    permisos_anual: 900, otros_fijos_mensual: 0,
    ...o,
  };
}

/** La gemela usada con los factores que escribió costos-02. */
function usadaDe(p: ParametrosCostoKm): ParametrosCostoKm {
  return {
    ...p,
    rendimiento_1: Math.round(p.rendimiento_1 * 0.9 * 100) / 100,
    vida_neumatico_km: Math.round(p.vida_neumatico_km * 0.9),
    mantenimiento_km: Math.round(p.mantenimiento_km * 1.6 * 100) / 100,
    valor_compra: Math.round(p.valor_compra * 0.25),
    residual_pct: 0.30,
    vida_util_anios: 5,
    seguro_anual: Math.round(p.seguro_anual * 0.5),
    usa_urea: false,
  };
}

// ══ 1 · LA IDENTIDAD DEL PAR ═════════════════════════════════════════════════
console.log("\n1 · LA IDENTIDAD DEL PAR: el sufijo es la CLAVE, y no se pierde ninguna ficha");

chk("el sufijo es el que escribió costos-02", SUFIJO_USADO === "_ESTANDAR", SUFIJO_USADO);
chk("esUsado reconoce la usada", esUsado("BUS_50_ESTANDAR") && !esUsado("BUS_50"));
chk("una clave llamada ESTANDAR a secas NO es una usada", !esUsado("ESTANDAR"));
chk("clavePremiumDe deshace el sufijo", clavePremiumDe("BUS_50_ESTANDAR") === "BUS_50");
chk("clavePremiumDe sobre una premium devuelve null", clavePremiumDe("BUS_50") === null);
chk("claveUsadaDe lo pone", claveUsadaDe("BUS_50") === "BUS_50_ESTANDAR");

{
  const flota = [
    { tipo_vehiculo: "SPRINTER_17" },
    { tipo_vehiculo: "SPRINTER_17_ESTANDAR" },
    { tipo_vehiculo: "BUS_50" },
    { tipo_vehiculo: "BUS_50_ESTANDAR" },
    { tipo_vehiculo: "VAN_15" },                      // sin gemela
    { tipo_vehiculo: "CUSTER_25_ESTANDAR" },          // huérfana: su premium no está activa
  ];
  const pares = emparejarFlota(flota);
  chk("un par por premium, más la huérfana", pares.length === 4, `${pares.length}`);
  chk("conserva el orden de entrada",
    pares.slice(0, 3).map((p) => p.clave).join(",") === "SPRINTER_17,BUS_50,VAN_15",
    pares.map((p) => p.clave).join(","));
  chk("la premium sin gemela queda con usada null", pares[2].usada === null);
  chk("la usada huérfana NO se pierde", pares[3].clave === "CUSTER_25_ESTANDAR");
  // Ninguna ficha puede desaparecer: una activa que no se lista se sigue cotizando y nadie la ve.
  const vistas = new Set(pares.flatMap((p) => [p.premium.tipo_vehiculo, p.usada?.tipo_vehiculo]).filter(Boolean));
  chk("las 6 fichas aparecen exactamente una vez", vistas.size === flota.length, `${vistas.size}`);
}

// ══ 2 · EL EQUILIBRIO EQUILIBRA ══════════════════════════════════════════════
console.log("\n2 · EL EQUILIBRIO EQUILIBRA: se aplica y se vuelve a correr la fórmula única");

const casos: { nombre: string; premium: ParametrosCostoKm }[] = [
  { nombre: "Sprinter 17 diésel", premium: ficha() },
  { nombre: "Bus 50 diésel", premium: ficha({ rendimiento_1: 12, mantenimiento_km: 2.0, valor_compra: 600000, residual_pct: 0.12, km_anio: 78000, n_neumaticos: 10, seguro_anual: 33000 }) },
  { nombre: "Auto 4 gasolina", premium: ficha({ tipo_combustible_1: "Gasolina", rendimiento_1: 42, mantenimiento_km: 0.25, valor_compra: 80000, residual_pct: 0.25, km_anio: 45000, n_neumaticos: 4, costo_neumatico: 400, vida_neumatico_km: 50000, seguro_anual: 2500 }) },
  { nombre: "Bus Euro V con urea", premium: ficha({ rendimiento_1: 12, usa_urea: true, mantenimiento_km: 2.0, valor_compra: 600000, km_anio: 78000, n_neumaticos: 10, seguro_anual: 33000 }) },
];

for (const c of casos) {
  const usada = usadaDe(c.premium);
  const e = mantenimientoDeEquilibrio(c.premium, usada, PRECIOS);
  chk(`hay equilibrio — ${c.nombre}`, e.codigo === "equilibrio" && e.mantenimiento !== null,
    `${e.codigo} · ${e.mantenimiento}`);

  const conEq = { ...usada, mantenimiento_km: e.mantenimiento as number };
  const kmPrem = costoKmDeParametro(c.premium, PRECIOS);
  const kmUsada = costoKmDeParametro(conEq, PRECIOS);
  const diff = kmUsada - kmPrem;

  chk(`  aplicado, las dos cuestan lo mismo — ${c.nombre}`, Math.abs(diff) < 0.01,
    `premium ${kmPrem.toFixed(4)} · usada ${kmUsada.toFixed(4)}`);
  // 2 · EL REDONDEO VA HACIA ARRIBA: nunca deja la usada por debajo.
  chk(`  y nunca queda más BARATA que su gemela — ${c.nombre}`, diff >= 0,
    `Δ ${diff.toFixed(6)}`);

  // Con el mantenimiento de costos-02 (×1.60) la usada salía más cara: es el caso que lo motivó.
  const km160 = costoKmDeParametro(usada, PRECIOS);
  chk(`  el ×1.60 de costos-02 la dejaba más cara — ${c.nombre}`, km160 > kmPrem,
    `${km160.toFixed(4)} vs ${kmPrem.toFixed(4)} (+${(((km160 - kmPrem) / kmPrem) * 100).toFixed(1)} %)`);
  chk(`  y el equilibrio es MENOR que ese ×1.60 — ${c.nombre}`,
    (e.mantenimiento as number) < usada.mantenimiento_km,
    `${e.mantenimiento} < ${usada.mantenimiento_km}`);
}

{
  // La brecha DECLARA de qué lado está hoy la ficha: positiva = hoy cuesta más que su gemela.
  const premium = ficha();
  const usada = usadaDe(premium);
  const e = mantenimientoDeEquilibrio(premium, usada, PRECIOS);
  chk("la brecha dice que hoy la usada cuesta MÁS", (e.brecha as number) > 0, `${e.brecha}`);
  chk("y el actual es el tecleado, no el propuesto", e.actual === usada.mantenimiento_km);
}

// ══ 3 · LOS CÓDIGOS ══════════════════════════════════════════════════════════
console.log("\n3 · LOS CÓDIGOS: ningún cero ni negativo se cuela en el campo de dinero");

{
  const premium = ficha();
  chk("sin gemela → sin_gemela",
    mantenimientoDeEquilibrio(null, usadaDe(premium), PRECIOS).codigo === "sin_gemela");
  chk("sin la usada → sin_gemela",
    mantenimientoDeEquilibrio(premium, null, PRECIOS).codigo === "sin_gemela");
  chk("y ninguno de los dos trae número",
    mantenimientoDeEquilibrio(null, null, PRECIOS).mantenimiento === null);

  // Un divisor en cero deja la fórmula en Infinity — el módulo NO lo convierte en un número.
  const rota = { ...usadaDe(premium), rendimiento_1: 0 };
  chk("rendimiento en cero → parametro_incompleto",
    mantenimientoDeEquilibrio(premium, rota, PRECIOS).codigo === "parametro_incompleto");
  const rota2 = { ...premium, km_anio: 0 };
  chk("km anuales en cero → parametro_incompleto",
    mantenimientoDeEquilibrio(rota2, usadaDe(premium), PRECIOS).codigo === "parametro_incompleto");

  // Una "usada" carísima en todo lo demás no empata ni con el taller gratis: se NOMBRA.
  const carisima = { ...usadaDe(premium), rendimiento_1: 3, valor_compra: 900000, vida_util_anios: 2 };
  const imp = mantenimientoDeEquilibrio(premium, carisima, PRECIOS);
  chk("ni con taller gratis → imposible", imp.codigo === "imposible" && imp.mantenimiento === null);
  chk("y el detalle manda a revisar los OTROS renglones", /valor de compra|vida útil|rendimiento/i.test(imp.detalle));
}

// ══ 4 · LA COMPARACIÓN RENGLÓN A RENGLÓN ═════════════════════════════════════
console.log("\n4 · LOS SEIS RENGLONES: la evidencia sin la cual el resultado parece un error");

{
  const premium = ficha();
  const usada = usadaDe(premium);
  const c = compararPar(premium, usada, PRECIOS);

  chk("hay una fila por renglón", c.filas.length === RENGLONES.length, `${c.filas.length}`);
  const suma = c.filas.reduce((s, f) => s + f.delta, 0);
  chk("los deltas suman el delta total", Math.abs(suma - c.delta) < 1e-9,
    `${suma.toFixed(6)} vs ${c.delta.toFixed(6)}`);
  const total = c.filas.reduce((s, f) => s + f.premium, 0);
  chk("y los renglones suman el total del S/km", Math.abs(total - c.totalPremium) < 1e-9);

  const de = (k: string) => c.filas.find((f) => f.clave === k)!;
  chk("la usada AHORRA en depreciación", de("depreciacion").delta < 0, `${de("depreciacion").delta.toFixed(4)}`);
  chk("la usada AHORRA en seguros y fijos", de("fijos").delta < 0, `${de("fijos").delta.toFixed(4)}`);
  chk("y GASTA más en combustible", de("combustible").delta > 0, `${de("combustible").delta.toFixed(4)}`);
  chk("y en neumáticos", de("neumaticos").delta > 0, `${de("neumaticos").delta.toFixed(4)}`);
}

// ══ 5 · EL CASO REAL DE AFA (Sprinter 17, números de producción) ═════════════
console.log("\n5 · EL CASO QUE LO MOTIVÓ: Sprinter 17, con los números que salieron en pantalla");

{
  // Premium y usada tal como quedaron tras costos-02. Seguros de laboratorio (el dump de
  // producción no los traía), así que lo que se fija es el COMPORTAMIENTO, no el céntimo.
  const premium = ficha({ rendimiento_1: 28.61, mantenimiento_km: 0.85, valor_compra: 140000, residual_pct: 0.18, vida_util_anios: 10, km_anio: 60000 });
  const usada = ficha({ rendimiento_1: 25.75, mantenimiento_km: 1.36, valor_compra: 35000, residual_pct: 0.30, vida_util_anios: 5, km_anio: 60000, vida_neumatico_km: 58500, seguro_anual: 3000 });

  const c = compararPar(premium, usada, PRECIOS);
  const mant = c.filas.find((f) => f.clave === "mantenimiento")!;
  chk("el mantenimiento inventado es el renglón que MÁS pesa en la diferencia",
    mant.delta > c.filas.filter((f) => f.clave !== "mantenimiento").reduce((s, f) => s + Math.abs(f.delta), 0) * 0.5,
    `mant +${mant.delta.toFixed(4)} de un total +${c.delta.toFixed(4)}`);

  const e = mantenimientoDeEquilibrio(premium, usada, PRECIOS);
  chk("su equilibrio queda pegado al mantenimiento de la NUEVA",
    Math.abs((e.mantenimiento as number) - premium.mantenimiento_km) < 0.12,
    `equilibrio ${e.mantenimiento} vs premium ${premium.mantenimiento_km}`);
  // Es el hallazgo de negocio: en esta unidad el ahorro de capital es tan chico que casi no
  // compra taller. Si algún día deja de ser verdad, esta prueba lo dice.
}

// ══ 6 · EL MOTIVO NO ES UNA MEDICIÓN ═════════════════════════════════════════
console.log("\n6 · EL HISTORIAL: un equilibrio NO puede leerse como una medición adoptada");

{
  const premium = ficha();
  const e = mantenimientoDeEquilibrio(premium, usadaDe(premium), PRECIOS);
  const motivo = motivoEquilibrio(e, "Sprinter 17 pax Diésel · Premium");
  chk("el motivo NO empieza por «Auto:»", !motivo.startsWith("Auto:"), motivo.slice(0, 40));
  chk("y dice que no es medido", /no medido|Valor de arranque/i.test(motivo));

  // La prueba que cierra el ciclo: leído de vuelta, NO deja la ficha sellada como medida.
  const proc = MANT.procedenciaMantDeHistorial([
    { campo_modificado: "mantenimiento_km", valor_nuevo: e.mantenimiento, motivo,
      cambiado_por: "jose@afa.pe", cambiado_en: "2026-09-12T10:00:00Z" },
  ]);
  chk("la procedencia lo lee como tecleado a mano, no como medido", proc.origen === "manual", proc.origen);
}

console.log(fallos ? `\n❌ ${fallos} fallo(s)` : "\n✅ todo en verde");
process.exit(fallos ? 1 : 0);
