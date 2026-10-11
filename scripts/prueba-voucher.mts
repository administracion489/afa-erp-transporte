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
  toleranciaRedondeo,
  umbralImporteInconsistente,
  precioSegunImporte,
  errorDeLecturaSinCifras,
  detectarInversionCantidadPrecio,
} from "../lib/radar/coherencia-voucher";
import { textoLeccion } from "../lib/radar/lecciones-combustible";
import { promptExtraccionMedia, promptExtraccion } from "../lib/radar/prompts";

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

// ── 19. LA INVERSIÓN QUE EL CUADRE NO PUEDE VER ────────────────────────────
// La nota V87T-00008182 imprime `040002072 UGL 8.829x 6.990` con `GLP-G 61.71`: 8.829 galones
// a S/ 6.990. La IA guardó 6.99 gal a S/ 8.829 — y cuadra IGUAL DE BIEN, porque la
// multiplicación es conmutativa. Hace falta una cuarta cifra de fuera del voucher: el precio
// referencial del tipo de combustible.
{
  const cuadra = revisarCoherenciaVoucher({ cantidad: 6.99, precio: 8.829, monto: 61.71 });
  chk("con los números invertidos el cuadre no ve nada", cuadra.estado === "cuadra", cuadra.estado);
  const inv = detectarInversionCantidadPrecio(6.99, 8.829, 7.0);
  chk("el referencial del GLP sí lo delata", inv !== null);
  chk("y devuelve los valores en su sitio", inv?.cantidad === 8.829 && inv?.precio === 6.99,
    `${inv?.cantidad} gal a ${inv?.precio}`);
  console.log(`        ${inv?.detalle}`);
}
{
  // La compra legítima NO se toca: 8.829 gal a S/ 6.99 con el mismo referencial.
  chk("la lectura correcta no se marca", detectarInversionCantidadPrecio(8.829, 6.99, 7.0) === null);
}
{
  // El falso positivo que hay que evitar: un diésel de ~16 gal con el referencial al día en
  // ~24.6. La cantidad NO se parece al referencial, así que no se propone nada.
  chk("16.4 gal de diésel a S/ 24.64 con ref 24.60 no es inversión",
    detectarInversionCantidadPrecio(16.4, 24.64, 24.6) === null);
  // Y con el referencial DESACTUALIZADO (16.5), la cantidad sí se le parece: por eso se exige
  // además que el precio esté fuera de rango… que aquí lo está. Este es el caso límite y se
  // acepta a conciencia: un referencial mal mantenido produce ruido, no una corrección callada
  // (la anomalía bloquea y una persona confirma contra la foto).
  const limite = detectarInversionCantidadPrecio(16.4, 24.64, 16.5);
  chk("con el referencial desactualizado se avisa, y bloquea para que alguien mire", limite !== null);
}
{
  chk("sin referencial no se juzga", detectarInversionCantidadPrecio(6.99, 8.829, null) === null);
  chk("con referencial en cero tampoco", detectarInversionCantidadPrecio(6.99, 8.829, 0) === null);
  chk("sin cantidad o sin precio tampoco",
    detectarInversionCantidadPrecio(null, 8.829, 7) === null && detectarInversionCantidadPrecio(6.99, null, 7) === null);
  chk("dos valores iguales no se intercambian", detectarInversionCantidadPrecio(7, 7, 7) === null);
}
{
  // El precio dentro de rango nunca es inversión, aunque la cantidad se parezca al referencial.
  chk("precio dentro de rango no se toca", detectarInversionCantidadPrecio(7.1, 7.4, 7.0) === null);
}

// ── 20. EL CASO CWZ-371 (11/10/2026): el precio del EJEMPLO del prompt ─────
// La nota imprimía `040002019 UGL 10.527x 24.720` y `MAX-D DIESEL B5 S50 UV 260.23`, con el surtidor
// diciendo 260.23 y 10.527. La IA guardó el precio a S/ 24.64 —el `24.640` de la nota de ejemplo que
// el prompt enseñaba dos veces, mismo grifo y misma línea—. 10.527 × 24.64 = 259.39: ochenta y cuatro
// céntimos que la tolerancia de 4 por mil (S/ 1.04 en S/ 260) daba por buenos, y la carga quedó con el
// precio de otra nota y S/ 0.84 menos de gasto (combustible.total = galones × precio).
{
  const caso = { cantidad: 10.527, precio: 24.64, monto: 260.23 };
  // El defecto, conservado: con la tolerancia vieja ESTO CUADRABA. Si deja de ser así, el escenario
  // dejó de ser el que se rompió.
  chk("regresión: con la tolerancia vieja (4 por mil) la diferencia pasaba como cuadre",
    Math.abs(caso.cantidad * caso.precio - caso.monto) <= toleranciaCuadre(caso.monto));
  const r = revisarCoherenciaVoucher(caso);
  chk("ahora NO cuadra: el redondeo no explica 84 céntimos", r.estado !== "cuadra", r.estado);
  chk("ningún dígito mal leído lo explica (24.64 → 24.72 son dos cifras)", r.estado === "descuadra", r.estado);
  const aj = precioSegunImporte(caso, r);
  chk("el importe manda: se guarda el precio que lo reproduce", aj?.precio === 24.72, String(aj?.precio));
  chk("y se conserva lo que leyó la IA", aj?.leido === 24.64);
  chk("el precio nuevo reproduce el importe dentro del redondeo",
    aj != null && Math.abs(caso.cantidad * aj.precio - caso.monto) <= toleranciaRedondeo(caso.cantidad, aj.precio));
  chk("el detalle nombra los dos precios y el importe", !!aj && aj.detalle.includes("24.64") && aj.detalle.includes("24.72") && aj.detalle.includes("260.23"));
  console.log(`        ${aj?.detalle}`);
}

// ── 21. UN VOUCHER BIEN LEÍDO NUNCA DEJA DE CUADRAR (el lado que no se puede aflojar) ──
// Apretar la tolerancia no puede mandar a revisión una lectura buena. Se barren cantidades con 3
// decimales y precios con 2 y 3, el importe redondeado a céntimos como lo imprime el papel, y además
// la cantidad y el precio que la IA devuelve REDONDEADOS a 2 decimales (o sin los ceros del final).
{
  let casos = 0, falsos = 0;
  const ejemplo: string[] = [];
  const r2 = (n: number) => Math.round(n * 100) / 100;
  const r3 = (n: number) => Math.round(n * 1000) / 1000;
  for (let c = 0.731; c < 120; c = r3(c * 1.173 + 0.389)) {
    for (const p of [1.69, 1.739, 6.99, 7.549, 7.55, 14.5, 16.5, 23.88, 24.64, 24.72, 25.739, 26.1]) {
      const monto = r2(c * p);
      for (const [cl, pl] of [[c, p], [r2(c), p], [c, r2(p)], [r2(c), r2(p)]]) {
        casos++;
        const v = revisarCoherenciaVoucher({ cantidad: cl, precio: pl, monto });
        if (v.estado !== "cuadra") { falsos++; if (ejemplo.length < 3) ejemplo.push(`${cl}×${pl} vs ${monto}: ${v.estado}`); }
      }
    }
  }
  chk(`ninguna lectura buena deja de cuadrar (${casos} combinaciones)`, falsos === 0 && casos > 1000, `${falsos} falsas · ${ejemplo.join(" | ")}`);
}

// ── 22. LA BANDA FINA: lo que antes «cuadraba» y era un dígito mal leído ────
{
  // El precio 24.720 leído como 24.70 (un solo dígito): S/ 0.21 en S/ 260, dentro de la tolerancia vieja.
  const caso = { cantidad: 10.527, precio: 24.7, monto: 260.23 };
  const r = revisarCoherenciaVoucher(caso);
  chk("un dígito del precio en la banda fina se corrige", r.estado === "corregible" && r.correccion?.campo === "precio" && r.correccion?.corregido === 24.72,
    `${r.estado} ${r.correccion?.campo} ${r.correccion?.corregido}`);
  // acciones.ts NO bloquea un precio corregido cuyo descuadre cabía en la tolerancia vieja: antes se
  // registraba solo con el precio malo; ahora se registra solo con el bueno.
  chk("y cae dentro de la tolerancia vieja (por eso no bloquea)", Math.abs(r.diferencia ?? Infinity) <= toleranciaCuadre(caso.monto));
  // Una cantidad mal leída en la banda fina SÍ bloquea (el galonaje alimenta el rendimiento). Ojo: un
  // error en la TERCERA cifra decimal de la cantidad cabe en la tolerancia de redondeo (es lo que mueve
  // una cantidad que la IA devolvió redondeada a 2) y no se puede separar de él; en la segunda, sí.
  const rc = revisarCoherenciaVoucher({ cantidad: 10.547, precio: 24.72, monto: 260.23 });
  chk("una cifra de la cantidad en la banda fina también se detecta", rc.estado === "corregible" && rc.correccion?.campo === "cantidad" && rc.correccion?.corregido === 10.527,
    `${rc.estado} ${rc.correccion?.campo} ${rc.correccion?.corregido}`);
}

// ── 23. EL IMPORTE MANDA, PERO SOLO HASTA `monto_inconsistente` ─────────────
{
  const desc = { cantidad: 10, precio: 15, monto: 145 }; // vale de descuento: S/ 5 en S/ 145
  const r = revisarCoherenciaVoucher(desc);
  const aj = precioSegunImporte(desc, r);
  chk("un descuento del grifo guarda el precio EFECTIVO", aj?.precio === 14.5, String(aj?.precio));
  chk("el umbral de monto_inconsistente es max(S/ 2, 5 %)", umbralImporteInconsistente(145) === 7.25 && umbralImporteInconsistente(20) === 2);
  const grande = { cantidad: 10, precio: 15, monto: 120 }; // S/ 30 de diferencia: lo decide una persona
  chk("por encima del umbral no se toca (es monto_inconsistente)", precioSegunImporte(grande, revisarCoherenciaVoucher(grande)) === null);
  chk("un voucher que cuadra no se ajusta", precioSegunImporte({ cantidad: 8.799, precio: 24.64, monto: 216.81 }, revisarCoherenciaVoucher({ cantidad: 8.799, precio: 24.64, monto: 216.81 })) === null);
  chk("una corrección de un dígito tampoco (ya la hizo el cuadre)", precioSegunImporte({ cantidad: 6.799, precio: 24.64, monto: 216.81 }, revisarCoherenciaVoucher({ cantidad: 6.799, precio: 24.64, monto: 216.81 })) === null);
  chk("sin los tres números no hay ajuste", precioSegunImporte({ cantidad: 10, precio: null, monto: 145 }, revisarCoherenciaVoucher({ cantidad: 10, precio: null, monto: 145 })) === null);
  // Barrido: todo ajuste reproduce el importe y nunca se aplica fuera del umbral.
  let malos = 0, ajustes = 0;
  for (let c = 1.237; c < 80; c *= 1.37) for (let p = 1.5; p < 30; p *= 1.29) for (const f of [0.9, 0.97, 0.995, 1.004, 1.03, 1.2]) {
    const monto = Math.round(c * p * f * 100) / 100;
    const l = { cantidad: Math.round(c * 1000) / 1000, precio: Math.round(p * 1000) / 1000, monto };
    const aj2 = precioSegunImporte(l, revisarCoherenciaVoucher(l));
    if (!aj2) continue;
    ajustes++;
    if (Math.abs(l.cantidad * aj2.precio - monto) > toleranciaRedondeo(l.cantidad, aj2.precio)) malos++;
    if (Math.abs(l.cantidad * l.precio - monto) > umbralImporteInconsistente(monto)) malos++;
  }
  chk(`todo ajuste reproduce el importe y respeta el umbral (${ajustes} ajustes)`, malos === 0 && ajustes > 0, `${malos} malos`);
}

// ── 24. LAS LECCIONES DE UN NÚMERO SE DICEN SIN EL NÚMERO ────────────────────
// «Para el precio leíste "24.64" y lo correcto era "24.720"» deja en el prompt un precio que el modelo
// copia en la nota siguiente. Se describe el ERROR, no el valor.
{
  const precio = textoLeccion({ campo: "precio", valor_ia: "24.64", valor_correcto: "24.72", nota: null });
  chk("la lección del precio no lleva ningún precio", !/24[.,]6|24[.,]7/.test(precio), precio);
  const cant = textoLeccion({ campo: "galones", valor_ia: "6.799", valor_correcto: "8.799", nota: "lo detectó el cuadre · 6→8" });
  chk("la del dígito dice cuál, sin el número", cant.includes("leíste un 6 donde el papel decía 8") && !cant.includes("6.799") && !cant.includes("8.799"), cant);
  const km = textoLeccion({ campo: "kilometraje", valor_ia: "239980", valor_correcto: "23980", nota: "decía 23980 en el tablero" });
  chk("la del km: una cifra de más, y la nota con sus cifras tapadas", km.includes("una cifra de más") && !km.includes("23980") && !km.includes("239980"), km);
  const grifo = textoLeccion({ campo: "grifo", valor_ia: "CORATI SA COESTI", valor_correcto: "COESTI S.A.", nota: null });
  chk("la del grifo sí conserva los nombres (no son números copiables)", grifo.includes("COESTI S.A."), grifo);
  chk("errorDeLecturaSinCifras: el punto corrido", errorDeLecturaSinCifras(8548, 8.548) === "el punto decimal quedó corrido");
  chk("errorDeLecturaSinCifras: dos cifras no es UN error", errorDeLecturaSinCifras(24.64, 24.72) === null);
}

// ── 25. AL PROMPT DEL VOUCHER NO VA NINGÚN NÚMERO DE UNA NOTA REAL ──────────
// Las cifras de los ejemplos (las notas V72S-00023776 y V87T-00008182, el álbum de las dos placas, los
// RUC del encabezado y del cliente, el comprobante de muestra) son números que el modelo copia cuando
// no logra leer la foto — o cuando la nota se parece al ejemplo, que es lo que pasó.
{
  const COPIABLES = ["24.640", "24.64", "8.799", "216.81", "8.829", "6.990", "6.99", "61.71", "9.417", "7.550", "7.55",
    "71.10", "20127765279", "20611105291", "180.03", "240.56", "CTV370", "BUI272", "CTV-370", "BUI-272", "B001-004521", "8.548", "1,234.56"];
  const enTexto = (t: string) => COPIABLES.filter((n) => t.includes(n));
  const media = promptExtraccionMedia({ fechaHoy: "2026-10-11", horaAhora: "07:58", guiaVoucher: "en COESTI el precio va a la derecha, hoy 24.720, RUC 20127765279" });
  chk("el prompt de visión no lleva ninguna cifra de una nota real", enTexto(media).length === 0, enTexto(media).join(", "));
  chk("…y la guía del operador viaja con sus cifras tapadas", media.includes("##.###") && !media.includes("24.720"));
  chk("…y sigue enseñando la forma de la línea (con letras)", media.includes("C.CCCx") && media.includes("PP.PPP"));
  chk("…y dice que el precio sale del papel", /precio unitario se lee del papel/i.test(media));
  const texto = promptExtraccion("combustible", { fechaHoy: "2026-10-11", horaAhora: "07:58" });
  chk("el prompt del voucher dictado tampoco", enTexto(texto).length === 0, enTexto(texto).join(", "));
}

// ── 26. LA HORA DEL DESPACHO SE PIDE, Y NO ES LA DEL MENSAJE ──────────────────
// La CWZ-371 del 11/10/2026 imprimía «11/10/2026 07:55:41» y entró sin hora: el esquema decía solo
// "hora": "HH:MM" sin decir de dónde, y el prompt le da al modelo la hora del mensaje («son las 07:58»).
{
  const media = promptExtraccionMedia({ fechaHoy: "2026-10-11", horaAhora: "07:58" });
  chk("el prompt de visión dice dónde está la hora (junto a la fecha de la nota)", /FECHA Y LA HORA DEL DESPACHO/.test(media) && /DD\/MM\/AAAA HH:MM:SS/.test(media));
  chk("…que va en 24 h y con segundos", /"hora": "HH:MM"\|"HH:MM:SS"\|null/.test(media));
  chk("…y que NO es la hora del mensaje", /NO es la de este mensaje/.test(media) && /NUNCA la hora de este mensaje/.test(media));
  const texto = promptExtraccion("combustible", { fechaHoy: "2026-10-11", horaAhora: "07:58" });
  chk("el dictado también lo dice", /NO es la hora de este mensaje/.test(texto));
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
