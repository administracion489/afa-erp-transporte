// Matriz del ENLACE a las condiciones completas de una cotización y de cuándo se resume la política
// — npx tsx scripts/prueba-condiciones-enlace.mts
//
// Lo que se fija aquí (lib/condiciones-publicas.ts, lib/qr-matriz.ts, lib/condiciones-publicas-armar.ts
// y la ruta app/api/condiciones/[token]/route.ts):
//  1. `enlaceCondiciones` solo arma `${origen}/condiciones/${uuid}` con un origen LIMPIO (https://host,
//     o http://localhost) y un uuid; todo lo demás es null. `esEnlaceCondiciones` reconoce exactamente
//     lo que arma (ida y vuelta).
//  2. LA REGLA QUE NO SE AFLOJA, por barrido: `politicaParaImprimir` da `resumen` ⟺ hay política, el
//     resumen tiene líneas y el enlace es válido; si no, la política ENTERA, línea por línea igual que
//     la fórmula de antes (`(reserva ?? []).map(String).filter(trim)`). Corolario: el resumen sí sale.
//  3. `matrizQr` son los módulos del QR de la librería, casilla por casilla.
//  4. La respuesta pública no lleva nada del cliente, ni precios ni cuentas; sin política, 404.
//  5. La ruta: lee solo sus columnas, no-store + noindex, con límite por IP y sin soltar el error crudo.
import { readFileSync } from "node:fs";
import QRCode from "qrcode";
import * as CP from "../lib/condiciones-publicas";
import { casillaOscura, matrizQr } from "../lib/qr-matriz";
import { armarCondicionesPublicas, COLS_CONDICIONES_PUBLICAS, empresaParaCondiciones } from "../lib/condiciones-publicas-armar";

let fallos = 0, oks = 0;
const ok = (c: boolean, m: string) => { if (c) oks++; else { fallos++; if (fallos <= 60) console.log("  FALLA " + m); } };
const J = (x: unknown) => JSON.stringify(x);
const TOK = "123e4567-e89b-12d3-a456-426614174000";

console.log("1. enlaceCondiciones · origenCondiciones · esEnlaceCondiciones");
{
  const buenos: [unknown, string][] = [
    ["https://www.ejemplo.pe", "https://www.ejemplo.pe"],
    ["https://www.ejemplo.pe/", "https://www.ejemplo.pe"],
    ["  https://erp.ejemplo.pe//  ", "https://erp.ejemplo.pe"],
    ["HTTPS://WWW.EJEMPLO.PE", "https://www.ejemplo.pe"],
    ["https://erp.ejemplo.pe:8443", "https://erp.ejemplo.pe:8443"],
    ["http://localhost:3000", "http://localhost:3000"],
    ["http://127.0.0.1:3000/", "http://127.0.0.1:3000"],
  ];
  for (const [b, o] of buenos) {
    ok(CP.origenCondiciones(b) === o, `origen de ${J(b)} = ${o} (${CP.origenCondiciones(b)})`);
    ok(CP.enlaceCondiciones(b, TOK) === `${o}/condiciones/${TOK}`, `enlace con ${J(b)}`);
  }
  const malos: unknown[] = [
    null, undefined, "", "   ", 42, {}, "www.ejemplo.pe", "http://www.ejemplo.pe", "ftp://ejemplo.pe", "javascript:alert(1)",
    "https://ejemplo.pe/erp", "https://ejemplo.pe/?a=1", "https://ejemplo.pe/#x", "https://user:clave@ejemplo.pe", "https://ejemplo.pe /x",
    "https://ejemplo.pe\"onmouseover=1", "https://<b>.pe", "https://", `https://${"a".repeat(95)}.pe`, "https://ejemplo.pe:443",
    "data:text/html,hola", "//ejemplo.pe", "https://ejemplo.pe\\x",
  ];
  for (const b of malos) ok(CP.origenCondiciones(b) === null && CP.enlaceCondiciones(b, TOK) === null, `base inválida ${J(b)} → null`);
  const tokensMalos: unknown[] = [null, undefined, "", "abc", "123e4567e89b12d3a456426614174000", `{${TOK}}`, `${TOK}x`, `${TOK}/../x`, 12345, `${TOK.slice(0, -1)}g`];
  for (const t of tokensMalos) ok(CP.enlaceCondiciones("https://www.ejemplo.pe", t) === null && !CP.esTokenCondiciones(t), `token inválido ${J(t)} → null`);
  ok(CP.enlaceCondiciones("https://www.ejemplo.pe", ` ${TOK.toUpperCase()} `) === `https://www.ejemplo.pe/condiciones/${TOK}`, "un uuid en mayúsculas y con espacios: en minúsculas");
  ok(CP.RUTA_CONDICIONES === "/condiciones" && CP.SQL_RESUMEN_CONDICIONES === "supabase/cotizaciones-08-resumen-condiciones.sql", "la ruta y el SQL que se nombran");
  // Ida y vuelta: lo que arma `enlaceCondiciones` lo reconoce `esEnlaceCondiciones`, y nada más.
  for (const [b] of buenos) ok(CP.esEnlaceCondiciones(CP.enlaceCondiciones(b, TOK)), `esEnlaceCondiciones(enlace de ${J(b)})`);
  for (const x of [null, "", "https://www.ejemplo.pe", `https://www.ejemplo.pe/condiciones/${TOK.toUpperCase()}`, `https://www.ejemplo.pe/condiciones/${TOK}?a`,
    `http://www.ejemplo.pe/condiciones/${TOK}`, `https://www.ejemplo.pe/x/condiciones/${TOK}`, `https://www.ejemplo.pe/condiciones/${TOK}/`, `javascript:/condiciones/${TOK}`]) {
    ok(!CP.esEnlaceCondiciones(x), `no es un enlace de condiciones: ${J(x)}`);
  }
  // El SQL de la migración: los nombres que lee el código.
  const sql = readFileSync("supabase/cotizaciones-08-resumen-condiciones.sql", "utf8");
  ok(/add column if not exists condiciones_reserva_resumen text\[\]/.test(sql) && /add column if not exists condiciones_token uuid/.test(sql) && /uq_cotizaciones_condiciones_token/.test(sql), "la migración crea condiciones_reserva_resumen, condiciones_token y su índice único");
}

console.log("2. politicaParaImprimir: resumen ⟺ política ∧ resumen ∧ enlace (barrido)");
{
  const ENL = CP.enlaceCondiciones("https://www.ejemplo.pe", TOK)!;
  const politicas: unknown[] = [undefined, null, [], ["", "  "], ["Una"], ["  Con espacios  ", "", "Dos"], "texto", [null, "Tres", 4]];
  const resumenes: unknown[] = [undefined, null, [], ["", " "], ["R1"], ["R1", "", "  R2 "], "texto"];
  const enlaces: unknown[] = [undefined, null, "", ENL, `${ENL}x`, "https://www.ejemplo.pe", 5];
  const viejo = (r: unknown) => ((Array.isArray(r) ? r : []) as unknown[]).map((x) => String(x ?? "")).filter((x) => x.trim() !== "");
  let n = 0, resumen = 0;
  for (const p of politicas) for (const r of resumenes) for (const e of enlaces) {
    n++;
    const d = CP.politicaParaImprimir({ politica: p, resumen: r, enlace: e });
    const esperaResumen = viejo(p).length > 0 && viejo(r).length > 0 && CP.esEnlaceCondiciones(e);
    ok((d.modo === "resumen") === esperaResumen, `modo ${d.modo} con ${J([p, r, e])}`);
    if (d.modo === "resumen") {
      resumen++;
      ok(J(d.items) === J(viejo(r)) && d.enlace === e, `resumen: sus líneas y el enlace ${J([p, r, e])}`);
    } else {
      // La política entera, EXACTAMENTE la fórmula de antes (byte a byte).
      ok(J(d.items) === J(viejo(p)) && d.enlace === null, `completa: la política de siempre ${J([p, r, e])}`);
    }
    // Nunca se esconde lo que mueve dinero: con política, siempre se imprime algo.
    ok(viejo(p).length === 0 || d.items.length > 0, `con política siempre se imprime algo ${J([p, r, e])}`);
  }
  ok(resumen > 0 && resumen < n, `corolario: el barrido sí produce resúmenes (${resumen} de ${n})`);
}

console.log("3. matrizQr: los módulos de la librería, casilla por casilla");
{
  for (const url of [CP.enlaceCondiciones("https://www.ejemplo.pe", TOK)!, CP.enlaceCondiciones("http://localhost:3000", TOK)!, "x", "https://a.pe/condiciones/" + "f".repeat(36)]) {
    const m = matrizQr(url)!;
    const q = QRCode.create(url, { errorCorrectionLevel: "M" });
    ok(!!m && m.tamano === q.modules.size, `${url.slice(0, 40)}: mismo tamaño (${m?.tamano})`);
    let distintas = 0, oscuras = 0;
    for (let f = 0; f < q.modules.size; f++) for (let c = 0; c < q.modules.size; c++) {
      const lib = q.modules.get(f, c) === 1;
      if (lib) oscuras++;
      if (lib !== casillaOscura(m, f, c)) distintas++;
    }
    ok(distintas === 0 && oscuras > 0, `${url.slice(0, 40)}: ${distintas} casillas distintas de ${q.modules.size ** 2}`);
    // Los tramos no se pisan y no salen de la matriz.
    const vistos = new Set<string>();
    let pisa = false, fuera = false;
    for (const [f, c, l] of m.tramos) for (let k = 0; k < l; k++) { const kk = `${f},${c + k}`; if (vistos.has(kk)) pisa = true; vistos.add(kk); if (f >= m.tamano || c + k >= m.tamano) fuera = true; }
    ok(!pisa && !fuera && vistos.size === oscuras, `${url.slice(0, 40)}: los tramos cubren exactamente las oscuras`);
  }
  ok(matrizQr("") === null && matrizQr("a".repeat(5000)) === null, "vacío o demasiado largo: null (no se inventa un QR)");
  const enlace = CP.enlaceCondiciones("https://www.transportes-de-ejemplo.com.pe", TOK)!;
  ok((matrizQr(enlace)?.tamano ?? 99) <= 41, `un enlace normal es un QR chico (${matrizQr(enlace)?.tamano} módulos)`);
}

console.log("4. La respuesta pública: solo la política de la cotización y el pie de la empresa");
{
  const perfil = { nombre: "Transportes Ñandú", razon_social: "Transportes Ñandú S.A.C.", ruc: "20123456789", logo_url: "https://x.supabase.co/storage/v1/object/public/empresa/logo.png", telefono: "+51 999 888 777", email: "ventas@ejemplo.pe", web: "www.ejemplo.pe", direccion: "Av. Siempre Viva 1", cuentas_bancarias: [{ banco: "BCP", cuenta: "111", cci: "222" }] };
  const POL = ["La reserva se confirma con un adelanto del 50 %.", "  ", "Cancelación con 24 horas o más: sin costo."];
  const fila = {
    id: 736, numero_cotizacion: null, created_at: "2026-10-23T03:30:00Z", idioma_pdf: "en",
    consideraciones_json: { incluye: ["Agua"], generales: ["G"], reserva: POL, reserva_resumen: ["R1", ""], version: 2, plantilla: "traslados_ia" },
    // Lo que NUNCA debe salir aunque llegue en la fila:
    precio_cliente: 87654.3, items_json: [{ precio_unit: 76543.2 }], cliente_id: 7, atencion: "Ana Pérez", telefono: "987654321",
  } as any;
  const r = armarCondicionesPublicas(fila, perfil as any);
  ok(r.ok === true, "con política: ok");
  if (r.ok) {
    ok(J(Object.keys(r).sort()) === J(["emitida", "empresa", "idioma", "numero", "ok", "politica", "resumen"]), `solo esas claves (${Object.keys(r).join(",")})`);
    ok(J(Object.keys(r.empresa).sort()) === J(["email", "logo_url", "nombre", "razon_social", "ruc", "telefono", "web"]), "de la empresa, solo el pie (sin dirección ni cuentas)");
    ok(J(r.politica) === J([POL[0], POL[2]]) && J(r.resumen) === J(["R1"]), "la política y el resumen, limpios");
    ok(r.numero === "00736" && r.emitida === "2026-10-22" && r.idioma === "en", `número, fecha de Lima y el idioma (${r.numero} ${r.emitida} ${r.idioma})`);
    const todo = J(r);
    ok(!/87654|76543|987654321|Ana Pérez|precio|cliente|BCP|"111"|Agua|Siempre Viva/.test(todo), "nada del cliente, ni precios, ni cuentas, ni las otras listas");
  }
  for (const cj of [null, {}, { reserva: [] }, { reserva: ["", " "] }, { reserva: "texto" }, [], { reserva_resumen: ["R"] }]) {
    const x = armarCondicionesPublicas({ id: 1, consideraciones_json: cj }, perfil as any);
    ok(!x.ok && x.codigo === "sin_condiciones", `sin política (${J(cj)}) → sin_condiciones`);
  }
  const e0 = empresaParaCondiciones(null);
  ok(e0.nombre === null && e0.razon_social === null && e0.ruc === null && e0.logo_url === null, "perfil sin configurar: nunca el aviso «configura el perfil»");
  ok(armarCondicionesPublicas({ id: 3, consideraciones_json: { reserva: ["P"] }, created_at: "x" }, null).ok && (armarCondicionesPublicas({ id: 3, consideraciones_json: { reserva: ["P"] } }, null) as any).emitida === null, "sin fecha legible: emitida null");
  ok(J([...COLS_CONDICIONES_PUBLICAS].sort()) === J(["consideraciones_json", "created_at", "id", "idioma_pdf", "numero_cotizacion"]), "las columnas que lee la ruta");
  for (const k of Object.keys(CP.DETALLE_CONDICIONES)) ok(!/[<>]/.test((CP.DETALLE_CONDICIONES as any)[k]) && (CP.DETALLE_CONDICIONES as any)[k].length > 20, `el texto de ${k} es una frase`);
}

console.log("5. La ruta pública (lectura del código)");
{
  const src = readFileSync("app/api/condiciones/[token]/route.ts", "utf8");
  const sinComentarios = src.replace(/\/\/.*$/gm, "");
  ok(/esTokenCondiciones\(token\)/.test(sinComentarios), "valida el token (uuid) antes de tocar la base");
  ok(/limitarTasa\(clave, LIMITE_POR_MINUTO, 60_000\)/.test(sinComentarios) && /LIMITE_POR_MINUTO = 30/.test(sinComentarios), "30 por minuto por IP");
  ok(/"Cache-Control": "no-store"/.test(src) && /"X-Robots-Tag": "noindex/.test(src), "no-store y noindex");
  ok(/\.select\(cols\.join\(", "\)\)/.test(sinComentarios) && !/select\("\*"\)/.test(sinComentarios), "lee solo sus columnas (nunca select *)");
  ok(/faltaColumna\(r\.error, "condiciones_token"\)/.test(sinComentarios) && /sin_migracion/.test(sinComentarios), "sin la columna del token: sin_migracion");
  ok(!/error\.message\s*[,}]/.test(sinComentarios.replace(/console\.error\([^)]*\)/g, "").replace(/throw new Error\([^)]*\)/g, "")) && /MENSAJE_GENERICO/.test(sinComentarios), "el error crudo va al log, a la respuesta el genérico");
  ok(/SUPABASE_SERVICE_ROLE_KEY/.test(src) && !/NEXT_PUBLIC_SUPABASE_SERVICE/.test(src), "service-role creado en el archivo (sin NEXT_PUBLIC)");
  ok(/export async function GET\(req: NextRequest, \{ params \}: \{ params: Promise<\{ token: string \}> \}\)/.test(src), "params es una promesa (Next 16)");
  const layout = readFileSync("app/layout.tsx", "utf8");
  ok(/"\/condiciones"\]\.some\(/.test(layout), "/condiciones es una ruta pública del layout");
}

console.log(fallos ? `\n${fallos} FALLAN (${oks} ok)` : `\nTODO OK (${oks} comprobaciones)`);
process.exit(fallos ? 1 : 0);
