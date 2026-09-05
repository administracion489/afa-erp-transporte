// Pruebas del CUADRE ARITMÉTICO del voucher de grifo. NO tocan la base: datos en
// memoria contra el módulo puro lib/radar/coherencia-voucher.ts.
// Uso:  npx tsx scripts/prueba-voucher.mts   (sale con código 1 si algo falla)
//
// El caso 1 es literal: la nota de despacho V72S-00023776 de COESTI (E/S Macarena),
// del 27/08/2026, que imprime "040002019 UGL 8.799x 24.640" y "TOTAL S/ 216.81". La IA
// leyó 6.799 galones y el Radar la registró como "Monto inconsistente" sin decir cuál de
// los tres números estaba mal ni cuál era. El resto de la matriz cubre lo que NO se puede
// aflojar al corregir plata a partir de una cuenta:
//
//   · un descuadre por descuento del grifo NO se "corrige" inventando un dígito;
//   · si dos lecturas distintas explicarían el descuadre, no se toca nada;
//   · el redondeo a céntimos del propio voucher no cuenta como descuadre;
//   · una tasa de consumo metida en el campo de galones no produce corrección;
//   · la corrección propuesta tiene que CUADRAR de verdad, no solo parecerse.
import {
  revisarCoherenciaVoucher,
  numeroDeTranscripcion,
  toleranciaCuadre,
} from "../lib/radar/coherencia-voucher";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── 1. El caso real: 8.799 gal leídos como 6.799 ────────────────────────────
{
  const r = revisarCoherenciaVoucher({ cantidad: 6.799, precio: 24.64, monto: 216.81 });
  chk("el voucher de COESTI se marca corregible", r.estado === "corregible", r.estado);
  chk("y el campo mal leído es la cantidad", r.correccion?.campo === "cantidad", r.correccion?.campo ?? "—");
  chk("con el valor que impone el papel: 8.799", r.correccion?.corregido === 8.799, String(r.correccion?.corregido));
  chk("declarado como un solo dígito 6→8", r.correccion?.tipo === "digito" && r.correccion?.cambio === "6→8", r.correccion?.cambio ?? "—");
  chk("y el detalle nombra los dos números", r.detalle.includes("6.799") && r.detalle.includes("8.799"));
  console.log(`        ${r.detalle}`);
}

// ── 2. El mismo caso con la transcripción literal a favor ───────────────────
{
  const r = revisarCoherenciaVoucher({ cantidad: 6.799, precio: 24.64, monto: 216.81, cantidadTexto: "8.799x" });
  chk("la transcripción del papel confirma la corrección", r.correccion?.confirmadoPorTexto === true);
  chk("y el detalle lo dice", r.detalle.includes("transcribió"));
}

// ── 3. El voucher que sí cuadra no se toca ──────────────────────────────────
{
  const r = revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.64, monto: 216.81 });
  chk("8.799 × 24.640 = 216.81 cuadra", r.estado === "cuadra", `${r.producto} vs 216.81`);
  chk("y no propone corrección", r.correccion === null);
}

// ── 4. El redondeo a céntimos del propio voucher no es un descuadre ─────────
{
  // 24.64 × 8.799 = 216.80736 → el papel imprime 216.81. La diferencia es de 3 milésimas.
  const r = revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.64, monto: 216.81 });
  chk("el redondeo del papel cae dentro de la tolerancia", r.estado === "cuadra");
  chk("la tolerancia de un voucher chico es de 5 céntimos", toleranciaCuadre(10) === 0.05, String(toleranciaCuadre(10)));
  chk("y la de uno grande, 4 por mil", Math.abs(toleranciaCuadre(1000) - 4) < 1e-9, String(toleranciaCuadre(1000)));
}

// ── 5. Un descuento del grifo NO se corrige inventando un dígito ────────────
{
  // 10 gal × S/ 15.00 = S/ 150.00 pero el conductor pagó 145.00 (vale de descuento).
  const r = revisarCoherenciaVoucher({ cantidad: 10, precio: 15, monto: 145 });
  chk("el descuento se reporta como descuadre", r.estado === "descuadra", r.estado);
  chk("y no se corrige nada", r.correccion === null);
  chk("el detalle sugiere mirar el descuento", r.detalle.includes("descuento"));
}

// ── 6. El importe mal leído se detecta igual que la cantidad ────────────────
{
  // 8.799 × 24.64 = 216.81, pero la IA leyó el total como 218.81 (6→8 en el importe).
  const r = revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.64, monto: 218.81 });
  chk("el descuadre se atribuye al importe", r.correccion?.campo === "monto", r.correccion?.campo ?? "—");
  chk("y se corrige a 216.81", r.correccion?.corregido === 216.81, String(r.correccion?.corregido));
}

// ── 7. El precio mal leído, también ─────────────────────────────────────────
{
  // 8.799 gal por S/ 216.81 → el precio es 24.64; la IA leyó 24.04 (6→0).
  const r = revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.04, monto: 216.81 });
  chk("el descuadre se atribuye al precio", r.correccion?.campo === "precio", r.correccion?.campo ?? "—");
  chk("y se corrige a 24.64", r.correccion?.corregido === 24.64, String(r.correccion?.corregido));
}

// ── 8. El punto decimal corrido (8.548 gal ≠ 8548) ──────────────────────────
{
  const r = revisarCoherenciaVoucher({ cantidad: 8548, precio: 24.64, monto: 210.62 });
  chk("el punto corrido se detecta", r.correccion?.tipo === "decimal", r.correccion?.tipo ?? "—");
  chk("y la cantidad vuelve a 8.548", r.correccion?.corregido === 8.548, String(r.correccion?.corregido));
}

// ── 9. Una cifra de menos ───────────────────────────────────────────────────
{
  // El papel dice 12.5 gal; la IA leyó 1.5 (se comió el 2).
  const r = revisarCoherenciaVoucher({ cantidad: 1.5, precio: 16, monto: 200 });
  chk("la cifra que falta se detecta", r.correccion?.tipo === "digito_de_menos", r.correccion?.tipo ?? "—");
  chk("y la cantidad es 12.5", r.correccion?.corregido === 12.5, String(r.correccion?.corregido));
}

// ── 10. Con dos números faltando no hay con qué verificar ───────────────────
{
  const r = revisarCoherenciaVoucher({ cantidad: 8.799, precio: null, monto: null });
  chk("un solo dato no se verifica", r.estado === "incompleto", r.estado);
  chk("y no se inventa nada", r.correccion === null);
}

// ── 11. Falta uno de los tres: se completa, marcado como CALCULADO ──────────
{
  const r = revisarCoherenciaVoucher({ cantidad: null, precio: 24.64, monto: 216.81 });
  chk("la cantidad ausente se deriva", r.estado === "completado", r.estado);
  chk("y da 8.799", r.correccion?.corregido === 8.799, String(r.correccion?.corregido));
  chk("declarada como derivada, no leída", r.correccion?.tipo === "derivado" && r.correccion?.leido === null);
  chk("el detalle avisa que es calculada", r.detalle.includes("CALCULADO"));
}
{
  const r = revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.64, monto: null });
  chk("el importe ausente se deriva", r.correccion?.campo === "monto" && r.correccion?.corregido === 216.81, String(r.correccion?.corregido));
  // acciones.ts NO bloquea este ni el precio derivado: el ERP ya los derivaba en silencio
  // (`precioFinal = monto / cantidad` y la columna generada `combustible.total`), así que
  // bloquearlos ahora sería cola de revisión nueva por una cuenta que ya se hacía. La
  // CANTIDAD sí bloquea: un galonaje que nadie leyó no puede registrarse solo.
  const rp = revisarCoherenciaVoucher({ cantidad: 8.799, precio: null, monto: 216.81 });
  chk("el precio ausente se deriva", rp.correccion?.campo === "precio" && rp.correccion?.corregido === 24.64, String(rp.correccion?.corregido));
}

// ── 12. Una tasa de consumo en el campo de galones no produce corrección ────
{
  // "16.3 L/100km" metido como cantidad, con el precio y el total reales del voucher.
  const r = revisarCoherenciaVoucher({ cantidad: 16.3, precio: 24.64, monto: 216.81 });
  chk("la tasa no se 'corrige' a un galonaje", r.correccion === null, r.correccion?.cambio ?? "—");
  chk("se reporta como descuadre sin explicación", r.estado === "descuadra", r.estado);
}

// ── 13. Cuando dos lecturas explicarían el descuadre, no se toca nada ───────
{
  // 2 gal × S/ 3 = 6 y el total dice 8. Sube la cantidad a 2.667 (no cuadra a 0 decimales…)
  // El caso construido: cantidad 4, precio 2, monto 6 → cantidad podría ser 3 (4→3) y el
  // precio podría ser 1.5 (no es un dígito); monto podría ser 8 (6→8). Dos hipótesis.
  const r = revisarCoherenciaVoucher({ cantidad: 4, precio: 2, monto: 6 });
  chk("con dos explicaciones no se corrige", r.correccion === null, r.correccion?.campo ?? "—");
  chk("y se marca ambiguo", r.estado === "ambiguo", `${r.estado} (${r.candidatos.length} candidatos)`);
  chk("el detalle lista las dos", r.candidatos.length >= 2, String(r.candidatos.length));
}

// ── 14. La corrección propuesta tiene que cuadrar DE VERDAD ─────────────────
{
  // 9 gal × S/ 24.64 = 221.76 contra 216.81 impresos. La cantidad "real" sería 8.7988, que
  // redondeada a 0 decimales (los que trae "9") da 9 otra vez: no explica nada y no se
  // propone. Antes de este guard, un valor redondeado de vuelta al leído podía colarse.
  const r = revisarCoherenciaVoucher({ cantidad: 9, precio: 24.64, monto: 216.81 });
  chk("un redondeo que vuelve al valor leído no es corrección", r.correccion === null, r.correccion?.cambio ?? "—");
}

// ── 15. La transcripción literal solo se usa cuando es inequívoca ───────────
{
  chk('"8.799x" → 8.799', numeroDeTranscripcion("8.799x") === 8.799);
  chk('"8,799 UGL" → 8.799', numeroDeTranscripcion("8,799 UGL") === 8.799);
  chk('"1,234.56" es ambiguo → null', numeroDeTranscripcion("1,234.56") === null);
  chk('"" → null', numeroDeTranscripcion("") === null);
  chk("null → null", numeroDeTranscripcion(null) === null);
}

// ── 16. Números imposibles no llegan al cuadre ──────────────────────────────
{
  const r = revisarCoherenciaVoucher({ cantidad: 0, precio: 24.64, monto: 216.81 });
  chk("un cero se trata como dato ausente", r.estado === "completado" || r.estado === "incompleto", r.estado);
  const r2 = revisarCoherenciaVoucher({ cantidad: -3, precio: 24.64, monto: 216.81 });
  chk("un negativo también", r2.estado === "completado" || r2.estado === "incompleto", r2.estado);
}

// ── 17. Lo que hace acciones.ts con el veredicto (las reglas del enganche) ──
// El módulo es puro, así que estas son las decisiones que toma quien lo usa. Se fijan acá
// porque son las que protegen la plata, y ninguna se ve leyendo solo el módulo.
{
  const casos: { nombre: string; l: Parameters<typeof revisarCoherenciaVoucher>[0] }[] = [
    { nombre: "el voucher de COESTI", l: { cantidad: 6.799, precio: 24.64, monto: 216.81 } },
    { nombre: "la cantidad derivada", l: { cantidad: null, precio: 24.64, monto: 216.81 } },
  ];
  for (const { nombre, l } of casos) {
    const r = revisarCoherenciaVoucher(l);
    chk(`${nombre} deja un número que el formulario puede prellenar`, r.correccion != null);
    // acciones.ts marca SIEMPRE bloquea:true sobre estas dos, así que nunca auto-registran.
    chk(`${nombre} conserva lo que leyó la IA para la lección`, "leido" in (r.correccion ?? {}));
  }
  // La transcripción que NO desempata nada: con los tres números cuadrando, un "8.8" copiado
  // a mano no puede mandar a revisión una carga que la aritmética respalda.
  const cuadrado = revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.64, monto: 216.81, cantidadTexto: "8.8" });
  chk("una transcripción floja no rompe un voucher que cuadra", cuadrado.estado === "cuadra", cuadrado.estado);
}

// ── 18. Un voucher grande, para que la tolerancia relativa no ahogue el caso ─
{
  // 60 gal × S/ 16.50 = S/ 990.00; la IA leyó 66 gal (6→6 duplicado, un clásico). El 4 por mil
  // de 990 son S/ 3.96: la diferencia real es de S/ 99, no se confunde con redondeo.
  const r = revisarCoherenciaVoucher({ cantidad: 66, precio: 16.5, monto: 990 });
  chk("en un voucher de S/ 990 se detecta igual", r.estado === "corregible", r.estado);
  chk("y la cantidad vuelve a 60", r.correccion?.corregido === 60, String(r.correccion?.corregido));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
