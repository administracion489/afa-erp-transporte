// Pruebas del DIAGNÓSTICO DEL RASTREO: lib/gps-equipo.ts y lib/gps-diagnostico.ts (motores PUROS)
// y `tablaFaltante` de lib/columna-faltante.ts. NO tocan la base.
// Uso:  npx tsx scripts/prueba-gps-diagnostico.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJAN:
//   1. LA GUÍA SE MUDÓ, NO SE REESCRIBIÓ: `fabricanteDeUA` contra `detectarFabricanteGps` de la app
//      copiado literal sobre user-agents reales, y `GUIA_AJUSTES_GPS`/`PASOS_COMUNES`/la lista de
//      fabricantes agresivos iguales al original copiado literal.
//   2. EL REPORTE: `normalizarReporte` con basura (un "true" en texto es null, nunca true) y la FIRMA:
//      estable al reordenar claves, ciega a `pendientes_cola` y al motivo, y el CICLO cliente ↔
//      servidor: la firma del snapshot que arma la app es la firma de lo que el servidor normaliza.
//   3. LA LECTURA: `estadoDuranteVentana` (solapamiento, el valor malo gana, el anterior hasta 24 h).
//   4. TRI-ESTADO, el lado que no se afloja: un null NUNCA es una falta, y nunca acusa.
//   5. LA CAUSA DE CADA TRAMO, los CONGELADOS y las LLEGADAS TARDÍAS, uno por uno.
//   6. EL VEREDICTO, por barrido: `configuracion` ⟺ alguna falta que explica el corte;
//      `ajustes_fabricante` ⟹ todo lo relevante en true; congelado dominante ⟹ `equipo`; sin estado
//      del teléfono ⟹ no se acusa a la configuración. Y el corolario: con la batería en false y la app
//      detenida, el motor SÍ dice `configuracion` (un motor que nunca acusara pasaría lo demás).
//   7. EL CASO REAL: reserva #6166, VFC-962 (GPS de 4:08 a 4:11, ruta marcada hasta las 5:03).
//   8. `tablaFaltante` y `patronDelConductor`.
import {
  medirCobertura, acumularFilasGps, trazaVacia, veredictoRastreo, metros, HUECO_MIN_S,
  type TrazaSaneada, type FilaGpsDiag, type MedicionCobertura,
} from "../lib/gps-cobertura";
import {
  fabricanteDeUA, modeloDeUA, androidDeUA, nivelApk, GUIA_AJUSTES_GPS, PASOS_COMUNES, FABRICANTES_AGRESIVOS,
  normalizarReporte, firmaEstado, relojCliente, accionDeReporte, recortarUA, estadoDesdeFilas, estadoDuranteVentana,
  ultimoEstado, faltasDeConfiguracion, valorCampo, CAMPOS_APP_DETENIDA, CAMPOS_POR_ANTENA, CAMPOS_EQUIPO,
  ACC_RED_M, LATIDO_EQUIPO_MS, REPORTE_ANTERIOR_MS,
  type FilaEquipo, type EstadoEquipo, type ReporteEquipo, type CampoEquipo,
} from "../lib/gps-equipo";
import {
  diagnosticarRastreo, detectarCongelados, medirEntregas, clasificarTramos, patronDelConductor,
  MITAD_ANTENA, TOL_REINICIO_MS,
  type DiagnosticoRastreo,
} from "../lib/gps-diagnostico";
import { tablaFaltante, tablaQueFalta, columnaFaltante } from "../lib/columna-faltante";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

let semilla = 424242;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const elegir = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const LAT0 = -12.05, LNG0 = -77.05, M = 111_320;
const T0 = Date.parse("2026-10-09T09:08:00Z");   // 04:08 Lima
const iso = (ts: number) => new Date(ts).toISOString();

// ══ 1. La guía extraída ══════════════════════════════════════════════════════════════
console.log("\n1. La guía por marca se mudó sin reescribirse");
{
  // ── detectarFabricanteGps de app/conductor/page.tsx, copiado literal ──
  // (un `navigator` local para darle el user-agent sin tocar el global de Node)
  let navigator = { userAgent: "" };
  function detectarFabricanteGps(): string {
    const ua = (typeof navigator !== "undefined" ? navigator.userAgent : "").toLowerCase();
    if (/xiaomi|redmi|poco|miui|hyperos/.test(ua)) return "xiaomi";
    if (/samsung|sm-/.test(ua))                    return "samsung";
    if (/oppo|cph/.test(ua))                        return "oppo";
    if (/vivo/.test(ua))                            return "vivo";
    if (/realme|rmx/.test(ua))                      return "realme";
    if (/huawei|honor|\bhry\b|\blio\b/.test(ua))   return "huawei";
    if (/motorola|moto\b|\bmoto /.test(ua))         return "motorola";
    return "generico";
  }
  type PasoAjuste = { titulo: string; detalle: string };
  type GuiaFabricante = { marca: string; pasos: PasoAjuste[] };
  const PASOS_COMUNES_ORIG: PasoAjuste[] = [
    { titulo: "Ubicación: “Permitir todo el tiempo”", detalle: "Ajustes → Apps → AFA Conductores → Permisos → Ubicación → Permitir todo el tiempo." },
    { titulo: "Batería: “Sin restricciones”", detalle: "Ajustes → Apps → AFA Conductores → Batería → Sin restricciones (o “No optimizar”)." },
    { titulo: "Bloquea la app en Recientes", detalle: "Abre Recientes (multitarea), mantén presionada AFA Conductores y toca el candado para que el sistema no la cierre." },
  ];
  const GUIA_ORIG: Record<string, GuiaFabricante> = {
    xiaomi: { marca: "Xiaomi / Redmi / POCO (MIUI/HyperOS)", pasos: [
      { titulo: "Inicio automático: ACTIVADO", detalle: "Ajustes → Apps → Gestión de apps → AFA Conductores → Inicio automático → Activar. (También en Seguridad → Permisos → Inicio automático.)" },
      { titulo: "Ahorro de batería: “Sin restricciones”", detalle: "En la misma pantalla de la app → Ahorro de batería → Sin restricciones." },
      ...PASOS_COMUNES_ORIG,
    ]},
    samsung: { marca: "Samsung (One UI)", pasos: [
      { titulo: "Quita “Poner en suspensión”", detalle: "Ajustes → Batería → Límites de uso en segundo plano → asegúrate que AFA Conductores NO esté en “Apps en suspensión” ni “Suspensión profunda”." },
      ...PASOS_COMUNES_ORIG,
    ]},
    oppo:    { marca: "Oppo / OnePlus (ColorOS)", pasos: [
      { titulo: "Inicio automático: ACTIVADO", detalle: "Ajustes → Gestión de batería/apps → AFA Conductores → permitir inicio automático y ejecución en segundo plano." },
      ...PASOS_COMUNES_ORIG,
    ]},
    vivo:    { marca: "Vivo (Funtouch/OriginOS)", pasos: [
      { titulo: "Inicio automático y alto consumo: PERMITIR", detalle: "Ajustes → Batería → Consumo alto en segundo plano → permitir AFA Conductores; y permitir inicio automático." },
      ...PASOS_COMUNES_ORIG,
    ]},
    realme:  { marca: "Realme (Realme UI)", pasos: [
      { titulo: "Inicio automático: ACTIVADO", detalle: "Ajustes → Apps → AFA Conductores → permitir inicio automático y actividad en segundo plano." },
      ...PASOS_COMUNES_ORIG,
    ]},
    huawei:  { marca: "Huawei / Honor (EMUI/MagicOS)", pasos: [
      { titulo: "Gestión manual de la app", detalle: "Ajustes → Batería → Inicio de apps → AFA Conductores → Gestionar manualmente → activar Inicio automático, Inicio secundario y Ejecución en segundo plano." },
      ...PASOS_COMUNES_ORIG,
    ]},
    motorola:{ marca: "Motorola", pasos: PASOS_COMUNES_ORIG },
    generico:{ marca: "tu equipo", pasos: PASOS_COMUNES_ORIG },
  };
  const AGRESIVOS_ORIG = ["xiaomi", "oppo", "vivo", "realme", "huawei"];

  const UAS: [string, string | null, string | null][] = [
    // [user-agent, modelo esperado, android esperado]
    ["Mozilla/5.0 (Linux; Android 13; SM-A515F Build/TP1A.220624.014; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/117.0.0.0 Mobile Safari/537.36", "SM-A515F", "13"],
    ["Mozilla/5.0 (Linux; Android 13; SAMSUNG SM-A546E) AppleWebKit/537.36 (KHTML, like Gecko) SamsungBrowser/23.0 Chrome/115.0.0.0 Mobile Safari/537.36", "SAMSUNG SM-A546E", "13"],
    ["Mozilla/5.0 (Linux; Android 12; Redmi Note 11 Build/SKQ1.211103.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/116.0.5845.163 Mobile Safari/537.36", "Redmi Note 11", "12"],
    ["Mozilla/5.0 (Linux; Android 11; M2101K6G Build/RKQ1.200826.002; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/110.0.0.0 Mobile Safari/537.36", "M2101K6G", "11"],
    ["Mozilla/5.0 (Linux; Android 13; POCO X5 Pro 5G Build/TKQ1.221114.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/118.0.0.0 Mobile Safari/537.36", "POCO X5 Pro 5G", "13"],
    ["Mozilla/5.0 (Linux; Android 14; 23053RN02A Build/UP1A.231005.007; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36 HyperOS", "23053RN02A", "14"],
    ["Mozilla/5.0 (Linux; Android 12; CPH2185 Build/SP1A.210812.016; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/114.0.0.0 Mobile Safari/537.36", "CPH2185", "12"],
    ["Mozilla/5.0 (Linux; Android 12; vivo 1938 Build/SP1A.210812.003; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/113.0.0.0 Mobile Safari/537.36", "vivo 1938", "12"],
    ["Mozilla/5.0 (Linux; Android 13; RMX3363 Build/TP1A.220905.001; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/119.0.0.0 Mobile Safari/537.36", "RMX3363", "13"],
    ["Mozilla/5.0 (Linux; Android 10; HUAWEI P30 lite Build/HUAWEIMAR-L21A; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/88.0.4324.93 Mobile Safari/537.36", "HUAWEI P30 lite", "10"],
    ["Mozilla/5.0 (Linux; Android 10; HRY-LX1 Build/HONORHRY-L21; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/90.0.0.0 Mobile Safari/537.36", "HRY-LX1", "10"],
    ["Mozilla/5.0 (Linux; Android 12; moto g(30) Build/S0RCS32.41-10-19-15; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/112.0.0.0 Mobile Safari/537.36", "moto g(30)", "12"],
    ["Mozilla/5.0 (Linux; Android 11; motorola one fusion+ Build/RPIS31.Q2-42-25-1; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/100.0.0.0 Mobile Safari/537.36", "motorola one fusion+", "11"],
    ["Mozilla/5.0 (Linux; Android 14; Pixel 7 Build/UQ1A.240205.004; wv) AppleWebKit/537.36 (KHTML, like Gecko) Version/4.0 Chrome/122.0.0.0 Mobile Safari/537.36", "Pixel 7", "14"],
    ["Mozilla/5.0 (Linux; U; Android 4.4.2; es-pe; GT-I9300 Build/KOT49H) AppleWebKit/534.30 (KHTML, like Gecko) Version/4.0 Mobile Safari/534.30", "GT-I9300", "4.4.2"],
    ["Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36", null, null],
    ["Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1", null, null],
    ["Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36", null, null],
    ["", null, null],
  ];
  let iguales = 0;
  for (const [ua] of UAS) { navigator = { userAgent: ua }; if (detectarFabricanteGps() === fabricanteDeUA(ua)) iguales++; }
  chk(`fabricanteDeUA = detectarFabricanteGps original en ${iguales}/${UAS.length} user-agents reales`, iguales === UAS.length);
  const fabs = new Set(UAS.map(([ua]) => fabricanteDeUA(ua)));
  chk("corolario: los UAs cubren las 8 guías", fabs.size === 8, [...fabs].sort().join(", "));
  chk("GUIA_AJUSTES_GPS idéntica al original", JSON.stringify(GUIA_AJUSTES_GPS) === JSON.stringify(GUIA_ORIG));
  chk("PASOS_COMUNES idénticos al original", JSON.stringify(PASOS_COMUNES) === JSON.stringify(PASOS_COMUNES_ORIG));
  chk("FABRICANTES_AGRESIVOS = la lista de la app", JSON.stringify(FABRICANTES_AGRESIVOS) === JSON.stringify(AGRESIVOS_ORIG));
  let modelos = 0, androids = 0;
  for (const [ua, mod, and] of UAS) { if (modeloDeUA(ua) === mod) modelos++; if (androidDeUA(ua) === and) androids++; }
  chk(`modeloDeUA en ${modelos}/${UAS.length}`, modelos === UAS.length);
  chk(`androidDeUA en ${androids}/${UAS.length} (el UA reducido «Android 10; K» no dice ni modelo ni versión)`, androids === UAS.length);
  chk("la marca se deriva también del modelo reportado cuando el UA viene reducido", (() => {
    const e = estadoDesdeFilas([filaEquipo({ user_agent: UAS[15][0], modelo: "SM-A546E" })])!;
    return e.fabricante === "samsung" && e.marca === "Samsung (One UI)" && e.modelo === "SM-A546E" && e.android === null;
  })());

  const n = (o: Partial<Parameters<typeof nivelApk>[0]>) => nivelApk({ plataforma: "apk", plugins: ["AfaNative", "BackgroundGeolocation"], bateria_exenta: true, todo_el_tiempo: true, ajustes_alta_precision: true, ...o }).codigo;
  chk("nivelApk: navegador · iOS · sin AfaNative · sin respuesta · 28 · 29 · actual",
    n({ plataforma: "navegador" }) === "navegador" && n({ plataforma: "ios" }) === "ios" && n({ plugins: ["BackgroundGeolocation"] }) === "sin_modulo"
    && n({ bateria_exenta: null }) === "sin_respuesta" && n({ todo_el_tiempo: null }) === "basico" && n({ ajustes_alta_precision: null }) === "intermedio" && n({}) === "completo");
  chk("nivelApk: sin el plugin de segundo plano lo dice", /segundo plano/.test(nivelApk({ plataforma: "apk", plugins: ["AfaNative"], bateria_exenta: true, todo_el_tiempo: true, ajustes_alta_precision: true }).texto));
}

// ══ Fábricas ═════════════════════════════════════════════════════════════════════════
function filaEquipo(o: Partial<FilaEquipo> = {}): FilaEquipo {
  return {
    dispositivo: "aparato-0001", motivo: "arranque", plataforma: "apk",
    user_agent: "Mozilla/5.0 (Linux; Android 13; SM-A515F Build/TP1A; wv) AppleWebKit/537.36",
    modelo: null, plugins: ["AfaNative", "BackgroundGeolocation"], compartiendo: true,
    bateria_exenta: true, precision_ubicacion: "precisa", todo_el_tiempo: true, ajustes_alta_precision: true,
    servicio_fondo: true, gps_debil_m: 5, gps_atascado: false, pendientes_cola: 0,
    reportado_en: iso(T0 - 600_000), visto_hasta: iso(T0 + 3_600_000),
    reportado_cliente_en: null, visto_cliente_en: null,
    ...o,
  };
}
const estadoDe = (o: Partial<FilaEquipo> = {}) => estadoDesdeFilas([filaEquipo(o)])!;

// ══ 2. El reporte y su firma ═════════════════════════════════════════════════════════
console.log("\n2. normalizarReporte con basura, firma estable, y el CICLO cliente ↔ servidor");
const snapBueno = (): Record<string, unknown> => ({
  dispositivo: "3f1c2a9e-77b0-4c1e-9d0a-1b2c3d4e5f60", reserva_id: 6166, motivo: "arranque", plataforma: "apk",
  modelo: "SM-A515F", plugins: ["BackgroundGeolocation", "AfaNative"], compartiendo: true,
  bateria_exenta: false, precision_ubicacion: "precisa", todo_el_tiempo: true, ajustes_alta_precision: null,
  servicio_fondo: true, gps_debil_m: 7, gps_atascado: false, pendientes_cola: 3,
});
{
  chk("no es un objeto → null", [null, undefined, "x", 3, [], true].every((b) => normalizarReporte(b) === null));
  for (const [campo, malo] of [["dispositivo", "abc"], ["dispositivo", "con espacio 1234"], ["dispositivo", "x".repeat(65)], ["dispositivo", 12345678],
    ["motivo", "otro"], ["motivo", null], ["plataforma", "android"], ["plataforma", undefined]] as [string, unknown][]) {
    chk(`${campo} = ${JSON.stringify(malo)?.slice(0, 20)} → todo el reporte es null (400)`, normalizarReporte({ ...snapBueno(), [campo]: malo }) === null);
  }
  const r = normalizarReporte({
    ...snapBueno(), bateria_exenta: "true", todo_el_tiempo: 1, servicio_fondo: "sí", gps_atascado: null,
    compartiendo: "false", precision_ubicacion: "PRECISA", ajustes_alta_precision: false,
    modelo: "  SM-\u0000A515F\n  ", plugins: ["AfaNative", "AfaNative", "Hack", 3, "BackgroundGeolocation"],
    gps_debil_m: 11.6, pendientes_cola: -1, reserva_id: "6166",
  })!;
  chk("tri-estado: \"true\", 1, \"sí\" → null (nunca true); false se conserva", r.bateria_exenta === null && r.todo_el_tiempo === null && r.servicio_fondo === null
    && r.compartiendo === null && r.ajustes_alta_precision === false && r.gps_atascado === null);
  chk("precisión fuera del vocabulario → null", r.precision_ubicacion === null);
  chk("modelo sin control y recortado; plugins filtrados, sin repetir y ordenados", r.modelo === "SM- A515F" && JSON.stringify(r.plugins) === '["AfaNative","BackgroundGeolocation"]', `${JSON.stringify(r.modelo)} ${JSON.stringify(r.plugins)}`);
  chk("números: 11.6 → 12, -1 → null; reserva en texto de dígitos → número", r.gps_debil_m === 12 && r.pendientes_cola === null && r.reserva_id === 6166);
  chk("reserva inválida → null (no tumba el reporte)", [-5, 0, 1.5, "abc", "12a", 1e20].every((x) => normalizarReporte({ ...snapBueno(), reserva_id: x })!.reserva_id === null));
  chk("modelo > 60 se recorta a 60", normalizarReporte({ ...snapBueno(), modelo: "M".repeat(90) })!.modelo!.length === 60);
  // Auditoría de seguridad: `.slice` cortaba por unidades UTF-16 y dejaba medio emoji, que Postgres
  // rechaza al leer el JSON → 500 con el mensaje crudo y la app reintentando para siempre.
  const sueltos = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;
  const mCorte = normalizarReporte({ ...snapBueno(), modelo: "x".repeat(59) + "😀😀" })!.modelo!;
  chk("el recorte no parte un emoji: 60 caracteres completos, sin sustitutos sueltos",
    Array.from(mCorte).length === 60 && !sueltos.test(mCorte) && mCorte.endsWith("😀"), JSON.stringify(mCorte.slice(-4)));
  const mSuelto = normalizarReporte({ ...snapBueno(), modelo: "SM-A\uD83D045M" })!.modelo;
  chk("un sustituto suelto en la entrada se quita", mSuelto === "SM-A045M", JSON.stringify(mSuelto));
  const uaSuelto = recortarUA("Mozilla/5.0 (Linux; Android 13; " + "\uDE00".repeat(3) + "SM-A045M)");
  chk("el user agent tampoco guarda sustitutos sueltos", !!uaSuelto && !sueltos.test(uaSuelto));
  chk("gps_debil_m absurdo → null", [Infinity, NaN, 2e5, "15"].every((x) => normalizarReporte({ ...snapBueno(), gps_debil_m: x })!.gps_debil_m === null));
  chk("recortarUA: 300 caracteres, sin control", recortarUA("a\u0007b".padEnd(500, "z"))!.length === 300 && !/\u0007/.test(recortarUA("a\u0007b")!));

  const base = snapBueno();
  const invertido = Object.fromEntries(Object.entries(base).reverse());
  chk("firma estable al reordenar las claves", firmaEstado(base) === firmaEstado(invertido));
  chk("firma ciega a pendientes_cola y al motivo", firmaEstado(base) === firmaEstado({ ...base, pendientes_cola: 900, motivo: "latido" }));
  chk("firma ciega al valor del GPS mientras no cruce ACC_RED_M", firmaEstado({ ...base, gps_debil_m: 3 }) === firmaEstado({ ...base, gps_debil_m: ACC_RED_M - 1 })
    && firmaEstado({ ...base, gps_debil_m: ACC_RED_M }) === firmaEstado({ ...base, gps_debil_m: 400 }));
  chk("…y cambia al cruzarlo, o de medido a sin muestras", firmaEstado({ ...base, gps_debil_m: ACC_RED_M - 1 }) !== firmaEstado({ ...base, gps_debil_m: ACC_RED_M })
    && firmaEstado({ ...base, gps_debil_m: 3 }) !== firmaEstado({ ...base, gps_debil_m: null }));
  let cambia = true;
  for (const [k, v] of [["bateria_exenta", true], ["precision_ubicacion", "aproximada"], ["todo_el_tiempo", null], ["ajustes_alta_precision", true],
    ["servicio_fondo", false], ["gps_atascado", true], ["reserva_id", 7], ["dispositivo", "otro-aparato-9"], ["plataforma", "navegador"],
    ["modelo", "CPH2185"], ["plugins", ["AfaNative"]], ["compartiendo", false]] as [string, unknown][]) {
    if (firmaEstado(base) === firmaEstado({ ...base, [k]: v })) { cambia = false; console.log("      no cambió con", k); }
  }
  chk("firma cambia con cada campo del estado", cambia);

  // CICLO: lo que la app arma (con valores crudos: espacios, decimales, plugins desordenados) y lo que
  // el servidor guarda tras normalizar el JSON tienen la MISMA firma. Si no, el cliente creería que no
  // cambió nada y el servidor abriría una fila por latido (o al revés).
  let ciclo = true, validos = 0;
  const TRI = [true, false, null] as const;
  for (let k = 0; k < 3000; k++) {
    const snap: Record<string, unknown> = {
      dispositivo: rnd() < 0.97 ? `dev-${Math.floor(rnd() * 1e9).toString(36)}-abcd` : "x",
      reserva_id: rnd() < 0.8 ? 1 + Math.floor(rnd() * 99999) : null,
      motivo: elegir(["arranque", "cambio", "latido", "corte"]), plataforma: elegir(["apk", "ios", "navegador"]),
      modelo: elegir([null, "SM-A515F", "  Redmi Note 11 ", "CPH2185", "M".repeat(80)]),
      plugins: elegir([[], ["AfaNative"], ["BackgroundGeolocation", "AfaNative"], ["AfaNative", "BackgroundGeolocation", "AfaNative"]]),
      compartiendo: elegir([true, false]), bateria_exenta: elegir(TRI), precision_ubicacion: elegir(["precisa", "aproximada", null]),
      todo_el_tiempo: elegir(TRI), ajustes_alta_precision: elegir(TRI), servicio_fondo: elegir(TRI),
      gps_debil_m: rnd() < 0.3 ? null : Math.round(rnd() * 3000) / 100, gps_atascado: elegir(TRI),
      pendientes_cola: rnd() < 0.5 ? null : Math.floor(rnd() * 1200),
    };
    const servidor = normalizarReporte(JSON.parse(JSON.stringify(snap)));
    if (!servidor) continue;
    validos++;
    // …y la fila que se lee de la base (FilaEquipo) da la misma firma que el servidor escribió.
    const leida = JSON.parse(JSON.stringify(servidor));
    if (firmaEstado(snap) !== firmaEstado(servidor) || firmaEstado(servidor) !== firmaEstado(leida)) ciclo = false;
  }
  chk(`CICLO: firma del snapshot del cliente = firma de lo que el servidor normalizó (${validos} reportes)`, ciclo && validos > 2500);

  const ahora = T0;
  chk("relojCliente: a < 48 h se acepta; más lejos, basura o vacío → null",
    relojCliente(iso(ahora - 3 * 3600_000), ahora) === ahora - 3 * 3600_000 && relojCliente(iso(ahora + 47 * 3600_000), ahora) !== null
    && relojCliente(iso(ahora - 49 * 3600_000), ahora) === null && relojCliente("ayer", ahora) === null && relojCliente(null, ahora) === null);
  const ult = { firma: "F", visto_hasta: iso(ahora - 5 * 60_000) };
  chk("dedupe: misma firma y fila viva → estirar", accionDeReporte(ult, { firma: "F", motivo: "latido" }, ahora) === "estirar");
  chk("dedupe: un corte SIEMPRE es su propia fila", accionDeReporte(ult, { firma: "F", motivo: "corte" }, ahora) === "insertar");
  chk("dedupe: firma distinta, fila vieja (> 2 latidos) o sin fila → insertar",
    accionDeReporte(ult, { firma: "G", motivo: "cambio" }, ahora) === "insertar"
    && accionDeReporte({ firma: "F", visto_hasta: iso(ahora - 2 * LATIDO_EQUIPO_MS - 1) }, { firma: "F", motivo: "latido" }, ahora) === "insertar"
    && accionDeReporte(null, { firma: "F", motivo: "latido" }, ahora) === "insertar");
}

// ══ 3. La lectura: estadoDuranteVentana ═════════════════════════════════════════════
console.log("\n3. El estado durante el servicio, el de antes y los reinicios");
{
  const INI = T0, FIN = T0 + 3_600_000;
  const fila = (desde: number, hasta: number, o: Partial<FilaEquipo> = {}) => filaEquipo({ reportado_en: iso(desde), visto_hasta: iso(hasta), ...o });
  const filas: FilaEquipo[] = [
    fila(INI - 30 * 3600_000, INI - 25 * 3600_000, { bateria_exenta: false, dispositivo: "viejo-0000001" }),          // > 24 h antes
    fila(INI - 5 * 3600_000, INI - 4 * 3600_000, { todo_el_tiempo: false }),                                          // antes, del mismo aparato
    fila(INI - 3 * 3600_000, INI - 2 * 3600_000, { todo_el_tiempo: true, servicio_fondo: null }),                      // antes, más reciente
    fila(INI - 600_000, INI + 600_000, { bateria_exenta: true, servicio_fondo: null }),                                // solapa
    fila(INI + 1_200_000, INI + 2_400_000, { bateria_exenta: false, motivo: "corte" }),                                // dentro, otro valor
    fila(INI + 1_800_000, INI + 2_000_000, { dispositivo: "segundo-tel-02", precision_ubicacion: "aproximada" }),     // segundo aparato
    fila(FIN + 3_600_000, FIN + 7_200_000, { ajustes_alta_precision: false }),                                         // después
  ];
  const { durante, anterior, reinicios } = estadoDuranteVentana(filas, INI, FIN);
  chk("durante: solo los que se solapan con la ventana (3)", durante?.reportes === 3, `${durante?.reportes}`);
  chk("durante: false gana sobre true (batería)", durante?.bateria_exenta === false);
  chk("durante: «aproximada» gana sobre «precisa»", durante?.precision_ubicacion === "aproximada");
  chk("durante: true gana sobre null (servicio de fondo)", durante?.servicio_fondo === true);
  chk("durante: lo de después no entra (ajustes)", durante?.ajustes_alta_precision === true);
  chk("durante: cuenta 2 aparatos distintos", durante?.aparatos === 2);
  chk("anterior: la última fila del aparato en las 24 h previas (no la de 30 h antes)", anterior?.reportes === 1 && anterior?.todo_el_tiempo === true && anterior?.bateria_exenta === true);
  chk("reinicios: el corte dentro de la ventana, en hora del teléfono", reinicios.length === 1 && reinicios[0] === INI + 1_200_000);

  const conReloj = estadoDuranteVentana([filaEquipo({
    reportado_en: iso(FIN + 2 * 3600_000), visto_hasta: iso(FIN + 3 * 3600_000),
    reportado_cliente_en: iso(INI + 600_000), visto_cliente_en: null, bateria_exenta: false,
  })], INI, FIN);
  chk("con el reloj del teléfono atrasado 3 h, la fila cae DENTRO (se usa el mismo reloj que la traza)", conReloj.durante?.bateria_exenta === false);
  const limite = estadoDuranteVentana([fila(INI - REPORTE_ANTERIOR_MS + 60_000, INI - REPORTE_ANTERIOR_MS + 120_000)], INI, FIN);
  chk("anterior: a 23 h 58 min antes todavía vale", limite.anterior !== null && limite.durante === null);
  chk("sin filas: todo null y sin reinicios", (() => { const x = estadoDuranteVentana([], INI, FIN); return !x.durante && !x.anterior && !x.reinicios.length; })());
  chk("último estado: la fila más reciente, sola", ultimoEstado(filas)?.ajustes_alta_precision === false && ultimoEstado(filas)?.reportes === 1);
  chk("plataforma fusionada: navegador gana (es la que explica)", estadoDesdeFilas([filaEquipo(), filaEquipo({ plataforma: "navegador", dispositivo: "nav-00000001" })])!.plataforma === "navegador");
}

// ══ 4. Tri-estado ════════════════════════════════════════════════════════════════════
console.log("\n4. Tri-estado: un null nunca es una falta");
{
  let ok = true, faltasVistas = 0, nullsVistos = 0;
  const TRI = [true, false, null] as const;
  for (let k = 0; k < 3000; k++) {
    const e = estadoDe({
      plataforma: elegir(["apk", "ios", "navegador"]), bateria_exenta: elegir(TRI), todo_el_tiempo: elegir(TRI),
      servicio_fondo: elegir(TRI), ajustes_alta_precision: elegir(TRI), precision_ubicacion: elegir(["precisa", "aproximada", null]),
    });
    const { faltas, noComprobado } = faltasDeConfiguracion(e);
    for (const f of faltas) if (valorCampo(e, f.campo) !== false) ok = false;
    for (const c of noComprobado) if (valorCampo(e, c) !== null) ok = false;
    for (const c of CAMPOS_EQUIPO) {
      const v = valorCampo(e, c);
      if (v === false && !faltas.some((f) => f.campo === c)) ok = false;
      if (v === null && !noComprobado.includes(c)) ok = false;
    }
    faltasVistas += faltas.length; nullsVistos += noComprobado.length;
  }
  chk("barrido: toda falta es un false, todo false es una falta, y todo null va a «no comprobado»", ok);
  chk("corolario: hay faltas y nulls en el barrido", faltasVistas > 1000 && nullsVistos > 1000, `${faltasVistas} faltas · ${nullsVistos} nulls`);
  chk("sin estado: ninguna falta", faltasDeConfiguracion(null).faltas.length === 0);
  chk("cada falta trae su arreglo y a qué corte afecta", faltasDeConfiguracion(estadoDe({ plataforma: "navegador", bateria_exenta: false, todo_el_tiempo: false, servicio_fondo: false, precision_ubicacion: "aproximada", ajustes_alta_precision: false }))
    .faltas.every((f) => f.arreglo.length > 20 && (CAMPOS_APP_DETENIDA.includes(f.campo) ? f.afecta === "app_detenida" : f.afecta === "por_antena")));
}

// ══ Constructor de escenarios (filas crudas → traza → medición → veredicto) ═══════════
type Crudo = { created_at: string; lat: number; lng: number; precision_m: number; recibido_en: string | null; fix_ts: string | null; conductor_id: number; estado?: string };
function crudo(ts: number, lat: number, lng: number, o: Partial<{ prec: number; retrasoMs: number | null; fixTs: number | null; estado: string }> = {}): Crudo {
  const retraso = o.retrasoMs === undefined ? 2_000 : o.retrasoMs;
  return {
    created_at: iso(ts), lat, lng, precision_m: o.prec ?? 6,
    recibido_en: retraso === null ? null : iso(ts + retraso),
    fix_ts: o.fixTs === undefined ? iso(ts - 500) : o.fixTs === null ? null : iso(o.fixTs),
    conductor_id: 7, ...(o.estado ? { estado: o.estado } : {}),
  };
}
function trazaCon(filas: Crudo[]): TrazaSaneada {
  const acc: TrazaSaneada = { ...trazaVacia(), filas: [] };
  acumularFilasGps(acc, filas, true);
  return { ...acc, pts: acc.pts.sort((a, b) => a.ts - b.ts), filas: acc.filas!.sort((a, b) => a.ts - b.ts) };
}
/** Puntos en movimiento cada `cadaS` desde `desde` durante `durS`, avanzando `mps` m/s hacia el norte. */
function tramoMovil(desde: number, durS: number, latIni: number, o: { cadaS?: number; mps?: number; prec?: number; retrasoMs?: number | null } = {}): Crudo[] {
  const cada = o.cadaS ?? 10, v = o.mps ?? 8;
  const out: Crudo[] = [];
  for (let s = 0; s <= durS; s += cada) out.push(crudo(desde + s * 1000, latIni + (s * v) / M, LNG0, { prec: o.prec, retrasoMs: o.retrasoMs }));
  return out;
}
const ver = (traza: TrazaSaneada, medicion: MedicionCobertura | null, o: Partial<Parameters<typeof veredictoRastreo>[0]> = {}) =>
  veredictoRastreo({ aplica: true, enCurso: false, traza, medicion, avanzo: true, inmovil: false, inicioTs: null, ahoraMs: T0 + 6 * 3_600_000, ...o });
const sinEquipo = { durante: null, anterior: null };
function diag(traza: TrazaSaneada, medicion: MedicionCobertura | null, o: Partial<Parameters<typeof diagnosticarRastreo>[0]> = {}): DiagnosticoRastreo {
  return diagnosticarRastreo({
    veredicto: ver(traza, medicion), medicion, traza, filas: traza.filas ?? null, enCurso: false,
    equipo: sinEquipo, reinicios: [], recibidoMedible: true, ...o,
  });
}

// ══ 5. La causa de cada tramo ════════════════════════════════════════════════════════
console.log("\n5. Causa de cada tramo, congelados y llegadas tardías");
{
  // Hueco de 10 min en movimiento, sin nada en medio → la app se detuvo.
  const a = tramoMovil(T0, 600, LAT0);
  const b = tramoMovil(T0 + 1_200_000, 600, LAT0 + 9_000 / M);
  const tr = trazaCon([...a, ...b]);
  const m = medirCobertura({ pts: tr.pts })!;
  const d = diag(tr, m);
  chk("hueco sin nada en medio → app_detenida, y en movimiento", d.tramos.length === 1 && d.tramos[0].causa === "app_detenida" && d.tramos[0].enMovimiento, d.tramos[0]?.texto);
  chk("los tramos del diagnóstico son los de la medición, uno a uno", JSON.stringify(d.tramos.map((t) => [t.tipo, t.desdeTs, t.hastaTs, t.durS])) === JSON.stringify(m.tramos.map((t) => [t.tipo, t.desdeTs, t.hastaTs, t.durS])));
  chk("…en movimiento el texto da los km y no dice «detenido»", /mientras el bus avanzó/.test(d.tramos[0].texto) && !/detenido/.test(d.tramos[0].texto), d.tramos[0].texto);

  // Reserva #27107: 7 min sin posiciones con el bus esperando la hora de salida (se movió ~120 m).
  // Sigue siendo app_detenida y sigue restando del % (decisión del dueño); el texto dice que estaba quieto.
  const q1 = tramoMovil(T0, 60, LAT0, { mps: 0.5 });
  const q2 = tramoMovil(T0 + 480_000, 600, LAT0 + 120 / M);
  const trQ = trazaCon([...q1, ...q2]);
  const mQ = medirCobertura({ pts: trQ.pts })!;
  const dQ = diag(trQ, mQ);
  chk("hueco con el bus quieto → app_detenida, sin movimiento, y resta del %", dQ.tramos.length === 1 && dQ.tramos[0].causa === "app_detenida" && !dQ.tramos[0].enMovimiento && mQ.cobertura < 100, `${mQ.cobertura} % · ${dQ.tramos[0]?.texto}`);
  chk("…el texto dice que estaba detenido, cuánto se movió y que resta igual", /con el bus detenido \(se movió \d+ m\)/.test(dQ.tramos[0].texto) && /resta del %/.test(dQ.tramos[0].texto), dQ.tramos[0].texto);

  // El mismo hueco, con el teléfono mandando por antena cada 15 s → por_antena.
  const antena: Crudo[] = [];
  for (let s = 15; s < 600; s += 15) antena.push(crudo(T0 + 600_000 + s * 1000, LAT0 + 4_000 / M, LNG0, { prec: 400 }));
  const trA = trazaCon([...a, ...antena, ...b]);
  const dA = diag(trA, medirCobertura({ pts: trA.pts }));
  chk("hueco cubierto por filas de antena → por_antena, con su precisión", dA.tramos[0].causa === "por_antena" && dA.tramos[0].filasAntena === antena.length && dA.tramos[0].precisionMedianaM === 400, dA.tramos[0].texto);
  // Solo dos filas de antena al principio: no cubren la mitad → sigue siendo la app.
  const trA2 = trazaCon([...a, ...antena.slice(0, 2), ...b]);
  const dA2 = diag(trA2, medirCobertura({ pts: trA2.pts }));
  chk("dos filas de antena que no cubren la mitad → app_detenida (antena ≥ mitad decide, no la sola presencia)", dA2.tramos[0].causa === "app_detenida" && dA2.tramos[0].filasAntena === 2);
  chk("filas que no se pudieron leer → desconocida (no se adivina)", diag(tr, m, { filas: null }).tramos.every((t) => t.causa === "desconocida"));

  // La posición que cierra el hueco llegó 12 min tarde (sobre un normal de 2 s) → sin_datos.
  const bTarde = tramoMovil(T0 + 1_200_000, 600, LAT0 + 9_000 / M).map((c, i) => (i === 0 ? crudo(Date.parse(c.created_at), c.lat, c.lng, { retrasoMs: 12 * 60_000 }) : c));
  const trT = trazaCon([...a, ...bTarde]);
  const dT = diag(trT, medirCobertura({ pts: trT.pts }));
  chk("la primera posición tras el hueco llegó 12 min tarde → sin_datos", dT.tramos[0].causa === "sin_datos", dT.tramos[0].texto);
  chk("…sin la columna recibido_en no se afirma sin_datos", diag(trT, medirCobertura({ pts: trT.pts }), { recibidoMedible: false }).tramos[0].causa === "app_detenida");

  // Cabeza y colas.
  const cabeza = medirCobertura({ pts: tr.pts, inicioTs: T0 - 900_000 })!;
  chk("cabeza (el inicio lo marcó el conductor) → app_detenida", diag(tr, cabeza).tramos[0].tipo === "cabeza" && diag(tr, cabeza).tramos[0].causa === "app_detenida");
  const ultTs = tr.pts[tr.pts.length - 1].ts;
  const lejos = { lat: LAT0 + 60_000 / M, lng: LNG0 };
  const cola = (o: Parameters<typeof medirCobertura>[0]) => { const mm = medirCobertura(o)!; return diag(tr, mm).tramos.find((t) => t.tipo === "cola")!; };
  chk("cola hasta el CIERRE del conductor → app_detenida", cola({ pts: tr.pts, destino: lejos, cierreTs: ultTs + 1_800_000 }).causa === "app_detenida");
  chk("cola hasta las MARCAS del conductor → app_detenida", cola({ pts: tr.pts, destino: lejos, finTs: ultTs + 1_800_000 }).causa === "app_detenida");
  const prev = cola({ pts: tr.pts, destino: lejos, finPrevistoTs: ultTs + 1_800_000 });
  chk("cola hasta la hora PREVISTA → desconocida («no se sabe si el servicio seguía»)", prev.causa === "desconocida" && /no se sabe si el servicio seguía/.test(prev.texto), prev.texto);
  const cur = cola({ pts: tr.pts, hastaTs: ultTs + 1_800_000 });
  chk("cola EN CURSO → desconocida («los puntos aún pueden llegar»)", cur.causa === "desconocida" && /todavía pueden llegar/.test(cur.texto), cur.texto);

  // Reinicio de la app: dentro y fuera de la tolerancia.
  const finHueco = d.tramos[0].hastaTs;
  const r1 = diag(tr, m, { reinicios: [finHueco + TOL_REINICIO_MS - 1_000] }).tramos[0];
  const r2 = diag(tr, m, { reinicios: [finHueco + TOL_REINICIO_MS + 60_000, finHueco - TOL_REINICIO_MS - 60_000] }).tramos[0];
  chk("reinicio a < 5 min del final del tramo → se anota (el sistema la había cerrado)", r1.reinicioApp?.clienteTs === finHueco + TOL_REINICIO_MS - 1_000 && /volvió a abrir/.test(r1.texto));
  chk("reinicio a > 5 min → no se anota", r2.reinicioApp === null && !/volvió a abrir/.test(r2.texto));
}

// ── Congelados ──
{
  // `minClavado` min de posición idéntica cada 10 s; luego la siguiente a `salto` metros, `trasS` s después.
  const congelado = (minClavado: number, salto: number, trasS: number, o: { fix?: boolean; mover?: boolean } = {}) => {
    const filas: Crudo[] = tramoMovil(T0, 300, LAT0);
    const ult = filas[filas.length - 1];
    const t1 = Date.parse(ult.created_at);
    const fixFijo = t1;
    for (let s = 10; s <= minClavado * 60; s += 10) {
      // fix_estancado: el teléfono repite el mismo fix; con `mover` la posición jitterea (no es idéntica)
      const lat = o.mover ? ult.lat + ((s / 10) % 2) * 0.00001 : ult.lat;
      filas.push(crudo(t1 + s * 1000, lat, ult.lng, { fixTs: o.fix ? fixFijo : undefined }));
    }
    const finClav = t1 + minClavado * 60_000;
    filas.push(...tramoMovil(finClav + trasS * 1000, 300, ult.lat + salto / M));
    const tr = trazaCon(filas);
    return { tr, m: medirCobertura({ pts: tr.pts })! };
  };
  const c1 = congelado(9, 2_000, 20);
  const k1 = detectarCongelados(c1.tr.filas!);
  chk("9 min de posición idéntica y después 2 km → congelado (posicion_identica)", k1.length === 1 && k1[0].por === "posicion_identica" && Math.round(k1[0].saltoM) >= 1_900, k1[0]?.texto);
  chk("9 min + movimiento chico (100 m) → no (el bus estaba parado)", detectarCongelados(congelado(9, 100, 20).tr.filas!).length === 0);
  chk("5 min de posición idéntica + 2 km → no (por debajo de POS_CLAVADA_MS)", detectarCongelados(congelado(5, 2_000, 20).tr.filas!).length === 0);
  const k4 = detectarCongelados(congelado(4, 2_000, 20, { fix: true, mover: true }).tr.filas!);
  chk("fix_ts estancado 4 min + 2 km → congelado (fix_estancado)", k4.length === 1 && k4[0].por === "fix_estancado", k4[0]?.texto);
  chk("fix_ts estancado 2 min → no (por debajo de FIX_ESTANCADO_MS)", detectarCongelados(congelado(2, 2_000, 20, { fix: true, mover: true }).tr.filas!).length === 0);
  const seguidoDeHueco = congelado(9, 2_000, 300);
  chk("9 min + 2 km pero DESPUÉS DE UN HUECO → no es congelado (el hueco ya cuenta el movimiento)", detectarCongelados(seguidoDeHueco.tr.filas!).length === 0
    && seguidoDeHueco.m.cortes === 1);
  const dC = diag(c1.tr, c1.m);
  chk("congelado dominante → equipo, y el % NO cambia (el de la celda)", dC.codigo === "equipo" && dC.causaDominante === "congelado" && ver(c1.tr, c1.m).pct === c1.m.cobertura && c1.m.cobertura === 100, `${dC.codigo} · ${c1.m.cobertura} %`);
  chk("filas null → ningún congelado", detectarCongelados(null).length === 0);
}

// ── Llegadas tardías ──
{
  const conRetraso = (f: (i: number) => number, n = 120) =>
    trazaCon(Array.from({ length: n }, (_, i) => crudo(T0 + i * 10_000, LAT0 + (i * 80) / M, LNG0, { retrasoMs: f(i) }))).filas!;
  const constante = medirEntregas(conRetraso(() => 3 * 60_000 + 1_500), true);
  chk("desfase constante de reloj (+3 min) → nada llegó tarde", constante.medible && constante.tardias.length === 0, constante.texto);
  const negativo = medirEntregas(conRetraso((i) => -7 * 60_000 + (i % 5) * 400), true);
  chk("reloj del teléfono adelantado (−7 min) → nada llegó tarde", negativo.medible && negativo.tardias.length === 0);
  const bloque = medirEntregas(conRetraso((i) => (i >= 40 && i < 70 ? 11 * 60_000 + (70 - i) * 10_000 : 2_000)), true);
  chk("un bloque que llegó +11 min tarde → UNA llegada tardía de 30 posiciones",
    bloque.medible && bloque.tardias.length === 1 && bloque.tardias[0].puntos === 30 && bloque.tardias[0].retrasoMaxS >= 11 * 60, JSON.stringify(bloque.medible ? bloque.tardias.map((t) => [t.puntos, t.retrasoMaxS]) : bloque));
  chk("menos de 20 posiciones con hora de recepción → pocos_puntos", (() => { const x = medirEntregas(conRetraso(() => 2_000, 15), true); return !x.medible && x.motivo === "pocos_puntos"; })());
  chk("filas anteriores a la migración (recibido null) → pocos_puntos, no «nada llegó tarde»", (() => { const x = medirEntregas(conRetraso(() => null as any), true); return !x.medible && x.motivo === "pocos_puntos"; })());
  chk("sin la columna → sin_columna, nombrando el SQL", (() => { const x = medirEntregas(conRetraso(() => 2_000), false); return !x.medible && x.motivo === "sin_columna" && /gps-equipo-01\.sql/.test(x.texto); })());
  chk("sin filas → sin_filas", (() => { const x = medirEntregas(null, true); return !x.medible && x.motivo === "sin_filas"; })());
  // Sin tramos ni congelados, pero con llegadas tardías → red_movil (no se perdió nada).
  const filas = Array.from({ length: 120 }, (_, i) => crudo(T0 + i * 10_000, LAT0 + (i * 80) / M, LNG0, { retrasoMs: i >= 40 && i < 70 ? 11 * 60_000 : 2_000 }));
  const tr = trazaCon(filas);
  const d = diag(tr, medirCobertura({ pts: tr.pts }));
  chk("solo llegadas tardías → red_movil, azul, sin tramos", d.codigo === "red_movil" && d.tramos.length === 0 && d.color === "#1e40af", d.titular);
}

// ══ 6. El veredicto: la tabla y el barrido ═══════════════════════════════════════════
console.log("\n6. Veredicto: la tabla del plan y el barrido tri-estado");
{
  const vivo = tramoMovil(T0, 1_800, LAT0);
  const trV = trazaCon(vivo);
  const mV = medirCobertura({ pts: trV.pts })!;
  chk("nada → sin_problema, verde", diag(trV, mV).codigo === "sin_problema" && diag(trV, mV).color === "#166534");
  const conV = (o: Partial<Parameters<typeof veredictoRastreo>[0]>, extra: Partial<Parameters<typeof diagnosticarRastreo>[0]> = {}) =>
    diagnosticarRastreo({ veredicto: ver(trV, mV, o), medicion: o.medicion === undefined ? mV : o.medicion, traza: trV, filas: trV.filas!, enCurso: !!o.enCurso,
      equipo: sinEquipo, reinicios: [], recibidoMedible: true, ...extra });
  chk("no aplica → no_aplica (y el estado del teléfono se enseña igual)", conV({ aplica: false }).codigo === "no_aplica");
  chk("recién iniciado → no_aplica", conV({ enCurso: true, traza: trazaVacia(), medicion: null, inicioTs: T0 + 6 * 3_600_000 - 60_000 }).codigo === "no_aplica");
  chk("sin_medir → sin_medir, gris, sin faltas que expliquen", (() => { const x = conV({ traza: null }, { equipo: { durante: estadoDe({ bateria_exenta: false }), anterior: null } }); return x.codigo === "sin_medir" && x.color === "#6b7280" && !x.faltas.some((f) => f.explica); })());
  const sinSenal = conV({ traza: trazaVacia(), medicion: null }, { equipo: { durante: estadoDe({ todo_el_tiempo: false }), anterior: null } });
  chk("sin señal → causa global app_detenida (con «todo el tiempo» en false → configuracion)", sinSenal.causaDominante === "app_detenida" && sinSenal.codigo === "configuracion", sinSenal.detalle);
  const soloAntena = conV({ traza: { ...trazaVacia(), totalCrudo: 40, porAntena: 40 }, medicion: null }, { equipo: { durante: estadoDe(), anterior: null } });
  chk("solo antena → causa global por_antena (todo bien puesto → equipo)", soloAntena.causaDominante === "por_antena" && soloAntena.codigo === "equipo", soloAntena.titular);
  const inmovil = conV({ inmovil: true });
  chk("gps inmóvil sin congelados → no_se_sabe, con las dos explicaciones", inmovil.codigo === "no_se_sabe" && /no iba en el vehículo/.test(inmovil.detalle) && /pegado/.test(inmovil.detalle));
  const perdida = conV({ enCurso: true, traza: trazaVacia(), medicion: null, inicioTs: T0 }, {});
  chk("en ruta sin ninguna posición → no_se_sabe (puede ser falta de datos: aún pueden llegar)", perdida.codigo === "no_se_sabe" && /pueden llegar/.test(perdida.detalle));

  // ── Barrido ──
  const TRI = [true, false, null] as const;
  let n = 0;
  const vistos: Record<string, number> = {};
  const inv = { nullNoFalta: true, configSiExplica: true, fabricanteTodoTrue: true, congeladoEquipo: true, sinEstadoNoAcusa: true,
    corolarioBateria: true, explicaSoloDominante: true, tramosIguales: true, textos: true, pctIgual: true, antenaNoApp: true, sinAntenaNoPorAntena: true, colaSinPrueba: true };
  let corolarioCasos = 0;
  for (let k = 0; k < 2500; k++) {
    // Traza: segmentos al azar (en marcha, hueco, antena, clavado, tardío).
    const crudos: Crudo[] = [];
    let ts = T0, lat = LAT0;
    const skew = Math.floor((rnd() - 0.5) * 6 * 60_000);
    const segs = 2 + Math.floor(rnd() * 6);
    for (let s = 0; s < segs; s++) {
      const tipo = elegir(["marcha", "marcha", "hueco", "antena", "clavado", "tardio"] as const);
      const durS = 60 + Math.floor(rnd() * 900);
      if (tipo === "hueco") { ts += durS * 1000; lat += (rnd() * 3000) / M; continue; }
      for (let x = 0; x < durS; x += 10) {
        const t = ts + x * 1000;
        if (tipo === "antena") crudos.push(crudo(t, lat + (rnd() * 300) / M, LNG0, { prec: 200 + rnd() * 800, retrasoMs: skew + 2_000 }));
        else if (tipo === "clavado") crudos.push(crudo(t, lat, LNG0, { retrasoMs: skew + 2_000, fixTs: rnd() < 0.5 ? ts : undefined }));
        else crudos.push(crudo(t, lat + (x * 8) / M, LNG0, { retrasoMs: skew + (tipo === "tardio" ? 8 * 60_000 + rnd() * 600_000 : 1_000 + rnd() * 4_000) }));
      }
      ts += durS * 1000;
      if (tipo === "clavado") lat += (rnd() < 0.7 ? 2_000 : 50) / M;
      else if (tipo !== "antena") lat += (durS * 8) / M;
    }
    const tr = trazaCon(crudos);
    if (tr.pts.length < 2) continue;
    const ult = tr.pts[tr.pts.length - 1].ts;
    const enCurso = rnd() < 0.15;
    const m = medirCobertura({
      pts: tr.pts, destino: rnd() < 0.3 ? { lat: lat + 50_000 / M, lng: LNG0 } : null,
      inicioTs: rnd() < 0.4 ? tr.pts[0].ts - Math.floor(rnd() * 900_000) : null,
      finPrevistoTs: rnd() < 0.5 ? ult + Math.floor(rnd() * 1_800_000) : null,
      finTs: rnd() < 0.25 ? ult + Math.floor(rnd() * 1_800_000) : null,
      cierreTs: rnd() < 0.25 ? ult + Math.floor(rnd() * 1_800_000) : null,
      hastaTs: enCurso ? ult + Math.floor(rnd() * 1_800_000) : null,
    })!;
    const veredicto = veredictoRastreo({ aplica: true, enCurso, traza: tr, medicion: m, avanzo: rnd() < 0.7, inmovil: rnd() < 0.05, inicioTs: null, ahoraMs: ult + 1_800_000 });
    // La mitad de los teléfonos nace bien configurada (y a veces se le estropea UN ajuste): sin eso,
    // «todo en true» sale 1 de cada 80 veces y `ajustes_fabricante` casi no se ejercitaría.
    const bienPuesto = rnd() < 0.5;
    const tri = () => (bienPuesto && rnd() < 0.85 ? true : elegir(TRI));
    const estado: EstadoEquipo | null = rnd() < 0.2 ? null : estadoDe({
      plataforma: rnd() < (bienPuesto ? 0.03 : 0.15) ? "navegador" : "apk",
      bateria_exenta: tri(), todo_el_tiempo: tri(), servicio_fondo: tri(), ajustes_alta_precision: tri(),
      precision_ubicacion: bienPuesto && rnd() < 0.85 ? "precisa" : elegir(["precisa", "aproximada", null]),
    });
    const usarAnterior = rnd() < 0.3;
    const filasLeidas = rnd() < 0.08 ? null : tr.filas!;
    const d = diagnosticarRastreo({
      veredicto, medicion: m, traza: tr, filas: filasLeidas, enCurso,
      equipo: usarAnterior ? { durante: null, anterior: estado } : { durante: estado, anterior: null },
      reinicios: rnd() < 0.3 ? [ult - Math.floor(rnd() * 600_000)] : [], recibidoMedible: rnd() < 0.9,
    });
    n++;
    vistos[d.codigo] = (vistos[d.codigo] ?? 0) + 1;
    // un null nunca es una falta
    for (const f of d.faltas) if (!estado || valorCampo(estado, f.campo) !== false) inv.nullNoFalta = false;
    // configuracion ⟺ alguna falta que explica
    if ((d.codigo === "configuracion") !== d.faltas.some((f) => f.explica)) inv.configSiExplica = false;
    // explica solo la causa dominante
    if (d.faltas.some((f) => f.explica && f.afecta !== d.causaDominante)) inv.explicaSoloDominante = false;
    // ajustes_fabricante ⟹ todo lo relevante en true
    if (d.codigo === "ajustes_fabricante" && (!estado || CAMPOS_APP_DETENIDA.some((c) => valorCampo(estado, c) !== true))) inv.fabricanteTodoTrue = false;
    if (d.codigo === "equipo" && d.causaDominante === "por_antena" && (!estado || CAMPOS_POR_ANTENA.some((c) => valorCampo(estado, c) !== true))) inv.fabricanteTodoTrue = false;
    // congelado dominante ⟹ equipo
    if (d.causaDominante === "congelado" && d.codigo !== "equipo") inv.congeladoEquipo = false;
    // sin estado del teléfono ⟹ nunca se acusa a la configuración
    if (!estado && (d.codigo === "configuracion" || d.codigo === "ajustes_fabricante" || (d.codigo === "equipo" && d.causaDominante !== "congelado"))) inv.sinEstadoNoAcusa = false;
    if (!estado && (d.causaDominante === "app_detenida" || d.causaDominante === "por_antena") && d.codigo !== "no_se_sabe") inv.sinEstadoNoAcusa = false;
    // corolario: batería false + app detenida ⟹ configuracion
    if (estado?.bateria_exenta === false && d.causaDominante === "app_detenida") { corolarioCasos++; if (d.codigo !== "configuracion") inv.corolarioBateria = false; }
    // los tramos son los de la medición, uno a uno; el % es el de la celda
    if (JSON.stringify(d.tramos.map((t) => [t.tipo, t.desdeTs, t.hastaTs])) !== JSON.stringify(m.tramos.map((t) => [t.tipo, t.desdeTs, t.hastaTs]))) inv.tramosIguales = false;
    if (veredicto.pct !== null && veredicto.pct !== m.cobertura && !["senal_perdida", "gps_inmovil"].includes(veredicto.codigo)) inv.pctIgual = false;
    // textos compuestos por el motor
    if (!d.titular || !d.detalle || !d.resumen || d.tramos.some((t) => !t.texto) || d.congelados.some((c) => !c.texto) || !d.entregas.texto) inv.textos = false;
    for (const t of d.tramos) {
      if (t.causa === "por_antena" && t.filasAntena === 0) inv.sinAntenaNoPorAntena = false;
      if (t.causa === "app_detenida" && filasLeidas && coberturaAntena(t, filasLeidas) >= MITAD_ANTENA * t.durS) inv.antenaNoApp = false;
      if (t.tipo === "cola" && (m.finPor === "previsto" || m.finPor === "en_curso") && (t.causa === "app_detenida" || t.causa === "sin_datos")) inv.colaSinPrueba = false;
      if (!filasLeidas && t.causa !== "desconocida") inv.colaSinPrueba = false;
    }
  }
  chk(`barrido (${n} escenarios): un null nunca es una falta`, inv.nullNoFalta);
  chk("barrido: configuracion ⟺ alguna falta que explica el corte", inv.configSiExplica);
  chk("barrido: una falta solo «explica» si afecta a la causa dominante", inv.explicaSoloDominante);
  chk("barrido: ajustes_fabricante / equipo-por-antena ⟹ todo lo relevante en true", inv.fabricanteTodoTrue);
  chk("barrido: congelado dominante ⟹ equipo", inv.congeladoEquipo);
  chk("barrido: sin estado del teléfono no se acusa a la configuración (no_se_sabe)", inv.sinEstadoNoAcusa);
  chk("barrido: nunca por_antena sin filas de antena", inv.sinAntenaNoPorAntena);
  chk("barrido: nunca app_detenida con la antena cubriendo la mitad del tramo", inv.antenaNoApp);
  chk("barrido: cola sin prueba (prevista / en curso) nunca es app_detenida ni sin_datos; sin filas, todo desconocida", inv.colaSinPrueba);
  chk("barrido: los tramos son los de la medición y el % es el de la celda", inv.tramosIguales && inv.pctIgual);
  chk("barrido: toda frase la compone el motor (ninguna vacía)", inv.textos);
  chk(`corolario: batería false + app detenida ⟹ configuracion (${corolarioCasos} casos)`, inv.corolarioBateria && corolarioCasos > 30);
  const codigos = ["sin_problema", "configuracion", "ajustes_fabricante", "equipo", "red_movil", "no_se_sabe"];
  chk("corolario: el barrido produce cada veredicto (no es un motor que nunca acusa ni siempre acusa)", codigos.every((c) => (vistos[c] ?? 0) > 10), JSON.stringify(vistos));
}

/** Copia del criterio de antena del motor, para juzgarlo desde fuera (solo bordes que son posiciones). */
function coberturaAntena(t: { tipo: string; desdeTs: number; hastaTs: number }, filas: FilaGpsDiag[]): number {
  const dentro = filas.filter((f) => f.antena && f.ts >= t.desdeTs && f.ts <= t.hastaTs).map((f) => f.ts);
  if (!dentro.length) return 0;
  const seq = [...(t.tipo !== "cabeza" ? [t.desdeTs] : []), ...dentro, ...(t.tipo !== "cola" ? [t.hastaTs] : [])].sort((a, b) => a - b);
  let s = 0;
  for (let i = 1; i < seq.length; i++) { const g = (seq[i] - seq[i - 1]) / 1000; if (g <= HUECO_MIN_S) s += g; }
  return s;
}

// ══ 7. El caso real #6166, VFC-962 ═══════════════════════════════════════════════════
console.log("\n7. Reserva #6166 (VFC-962): GPS de 4:08 a 4:11, ruta marcada hasta las 5:03");
{
  const fin6166 = Date.parse("2026-10-09T10:03:00Z");   // 05:03 Lima
  const crudos = Array.from({ length: 37 }, (_, i) => crudo(T0 + i * 5_000, LAT0 + (i * 11) / M, LNG0));
  const tr = trazaCon(crudos);
  const m = medirCobertura({ pts: tr.pts, destino: { lat: LAT0 + 18_000 / M, lng: LNG0 + 0.05 }, finPrevistoTs: fin6166, finTs: fin6166 })!;
  const v = ver(tr, m);
  const caso = (equipo: Parameters<typeof diagnosticarRastreo>[0]["equipo"], reinicios: number[] = []) =>
    diagnosticarRastreo({ veredicto: v, medicion: m, traza: tr, filas: tr.filas!, enCurso: false, equipo, reinicios, recibidoMedible: true });
  chk("la celda: Incompleto", v.codigo === "incompleto", `${v.celda}`);
  const sin = caso(sinEquipo);
  chk("sin reporte del teléfono → no_se_sabe (no se acusa a nadie)", sin.codigo === "no_se_sabe" && sin.causaDominante === "app_detenida" && /no reportó/.test(sin.titular), sin.detalle);
  chk("…el tramo es la cola hasta las marcas, con la app detenida", sin.tramos.length === 1 && sin.tramos[0].tipo === "cola" && sin.tramos[0].causa === "app_detenida", sin.tramos[0]?.texto);
  const bat = caso({ durante: estadoDe({ bateria_exenta: false, user_agent: "Mozilla/5.0 (Linux; Android 12; Redmi Note 11 Build/SKQ1; wv)" }), anterior: null });
  chk("con la batería en false → configuracion, la falta de batería primero y explicando", bat.codigo === "configuracion" && bat.faltas[0]?.campo === "bateria_exenta" && bat.faltas[0].explica && bat.color === "#92400e", bat.detalle);
  chk("…y la guía es la de su marca, expandida (Xiaomi es agresivo)", bat.guia?.fabricante === "xiaomi" && bat.guia.agresivo && bat.guia.pasos.length === GUIA_AJUSTES_GPS.xiaomi.pasos.length);
  const bien = caso({ durante: estadoDe(), anterior: null }, [m.ventanaFinTs - 60_000]);
  chk("todo bien configurado → ajustes_fabricante (inicio automático, recientes)", bien.codigo === "ajustes_fabricante" && /inicio automático/.test(bien.detalle), bien.detalle);
  chk("…con el reinicio de la app anotado", bien.tramos[0].reinicioApp !== null && /se volvió a abrir/.test(bien.detalle));
  const nav = caso({ durante: estadoDe({ plataforma: "navegador", bateria_exenta: null, todo_el_tiempo: null, servicio_fondo: null, ajustes_alta_precision: null, precision_ubicacion: null }), anterior: null });
  chk("desde el navegador → configuracion (instalar la app)", nav.codigo === "configuracion" && nav.faltas[0].campo === "plataforma", nav.detalle);
  const nulos = caso({ durante: estadoDe({ bateria_exenta: null, todo_el_tiempo: true, servicio_fondo: true }), anterior: null });
  chk("batería sin comprobar y lo demás bien → no_se_sabe nombrando lo que no se pudo comprobar", nulos.codigo === "no_se_sabe" && /batería sin restricciones/.test(nulos.detalle), nulos.detalle);
  const ant = caso({ durante: null, anterior: estadoDe({ todo_el_tiempo: false }) });
  chk("sin reporte durante, con el de antes → se juzga con el anterior y se dice", ant.codigo === "configuracion" && ant.estadoUsado === "anterior" && /antes del servicio/.test(ant.detalle), ant.detalle);
}

// ══ 8. tablaFaltante y patronDelConductor ════════════════════════════════════════════
console.log("\n8. tablaFaltante y el patrón del conductor");
{
  const e205 = { code: "PGRST205", message: "Could not find the table 'public.gps_equipo_reportes' in the schema cache" };
  const e42P01 = { code: "42P01", message: 'relation "public.gps_equipo_reportes" does not exist' };
  const e204 = { code: "PGRST204", message: "Could not find the 'recibido_en' column of 'ubicaciones_gps' in the schema cache" };
  const e42703 = { code: "42703", message: 'column "recibido_en" of relation "ubicaciones_gps" does not exist' };
  const e42703b = { code: "42703", message: "column ubicaciones_gps.recibido_en does not exist" };
  chk("PGRST205 y 42P01 → falta la tabla, con su nombre sin esquema", tablaFaltante(e205) && tablaFaltante(e42P01) && tablaQueFalta(e205) === "gps_equipo_reportes" && tablaQueFalta(e42P01) === "gps_equipo_reportes");
  chk("con la tabla nombrada: solo ESA (acepta el esquema)", tablaFaltante(e205, "gps_equipo_reportes") && tablaFaltante(e42P01, "public.gps_equipo_reportes") && !tablaFaltante(e205, "otra_tabla"));
  chk("PGRST204 y 42703 (una COLUMNA) → no es una tabla, aunque el mensaje diga «relation … does not exist»",
    !tablaFaltante(e204) && !tablaFaltante(e42703) && !tablaFaltante(e42703b) && tablaQueFalta(e42703) === null && columnaFaltante(e42703) === "recibido_en");
  chk("solo el código, sin mensaje → sí; otro error, null o vacío → no", tablaFaltante({ code: "PGRST205", message: "" }) && tablaFaltante({ code: "42P01" })
    && !tablaFaltante({ code: "23505", message: "duplicate key" }) && !tablaFaltante(null) && !tablaFaltante(undefined));

  const it = (pct: number | null, codigo: any = pct == null ? "no_aplica" : pct >= 95 ? "completo" : pct >= 90 ? "aceptable" : pct >= 70 ? "con_cortes" : "incompleto") => ({ pct, codigo });
  chk("sin servicios medidos → sin_historial", patronDelConductor([it(null), it(null, "sin_medir")]).codigo === "sin_historial");
  chk("ninguno falla → aislado", patronDelConductor([it(100), it(98), it(91)]).codigo === "aislado");
  chk("≥ 3 medidos y la mitad bajo el 90 % → patrón", patronDelConductor([it(40), it(100), it(60), it(99)]).codigo === "patron");
  chk("sin señal e inmóvil cuentan como falla", patronDelConductor([it(0, "sin_senal"), it(97, "gps_inmovil"), it(100)]).codigo === "patron");
  chk("pocos o menos de la mitad → irregular", patronDelConductor([it(40), it(100)]).codigo === "irregular" && patronDelConductor([it(40), it(100), it(100), it(100)]).codigo === "irregular");
  chk("los no medidos no cuentan", patronDelConductor([it(40), it(50), it(null), it(null, "sin_medir"), it(null, "recien_iniciado")]).codigo === "irregular");
}

console.log(fallos ? `\n✗ ${fallos} prueba(s) fallaron` : "\n✓ todo en verde");
process.exit(fallos ? 1 : 0);
