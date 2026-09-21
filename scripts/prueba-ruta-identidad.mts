// Matriz de la IDENTIDAD DE LA RUTA: el NOMBRE que alguien teclea y el ORIGEN → DESTINO
// son dos datos distintos, y ninguna pantalla puede sustituir uno por el otro.
// Uso:  npx tsx scripts/prueba-ruta-identidad.mts   (sale con código 1 si algo falla)
//
// QUÉ FIJA, Y POR QUÉ CADA COSA
//
// 1 · EL DEFECTO, CONSERVADO COMO REGRESIÓN. El colapso `ruta_nombre || origen → destino`
//     está copiado LITERAL aquí abajo —tal como estaba en app/pasajero/page.tsx:2362 y :2401—
//     y la prueba comprueba que reproduce el caso real: con `ruta_nombre` vacío, un campo
//     rotulado "RUTA" pinta el plus code geocodificado. Si deja de reproducirlo, el escenario
//     dejó de ser el que se rompió.
//
// 2 · LA INVARIANTE DURA, POR BARRIDO: `identidadRuta` NUNCA sustituye. Sobre la rejilla
//     entera (7 nombres × 6 orígenes × 6 destinos = 252 combinaciones):
//       · `nombre` sale del nombre tecleado o es null — jamás contiene la flecha del recorrido
//         cuando el nombre estaba vacío;
//       · `recorrido` se compone de los extremos — jamás es el nombre;
//       · `fuente` describe exactamente lo que hay.
//     Un módulo que devolviera siempre null cumpliría lo primero de forma trivial, así que
//     se comprueba TAMBIÉN el lado positivo: con nombre escrito, sale ese nombre.
//
// 3 · EL LADO QUE NO SE PUEDE AFLOJAR: la LIQUIDACIÓN sigue colapsando igual. `rotuloColapsado`
//     y `etiquetaCortaDetalle` se comparan contra el original copiado literal sobre la misma
//     rejilla. Ese texto alimenta `agrupacion_clave`, o sea CÓMO SE PARTEN LOS ÍTEMS de una
//     liquidación ya emitida: si cambiara, se moverían renglones que el cliente ya firmó.
//     Ojo con el detalle que casi se cuela: el original compone el tramo con los extremos
//     CRUDOS, así que un origen de solo espacios sobrevive a `filter(Boolean)` y los dobles
//     espacios no se colapsan. Normalizar ahí habría cambiado el texto de servicios reales.
//
// 4 · LAS DOS ETIQUETAS SON DISTINTAS Y NO VACÍAS, y el texto del vacío no es un número ni
//     una cadena vacía: "Sin nombre" se lee; un hueco se lee como pantalla rota.
import { createRequire } from "node:module";

const requerir = createRequire(import.meta.url);
const RI = requerir("../lib/ruta-identidad") as typeof import("../lib/ruta-identidad");
const LIQ = requerir("../lib/liquidacion-agrupacion") as typeof import("../lib/liquidacion-agrupacion");

const {
  identidadRuta, rotuloColapsado, etiquetaCortaDetalle, sinNombreDeRuta,
  ETIQUETA_RUTA, ETIQUETA_RECORRIDO, SIN_NOMBRE_RUTA, SIN_RECORRIDO,
} = RI;

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// ── EL ALGORITMO VIEJO, COPIADO LITERAL ───────────────────────────────────────
// No se toca. Si hay que cambiarlo para que la prueba pase, dejó de ser el que se rompió.

/** app/pasajero/page.tsx:2362 y :2401 — el colapso en silencio bajo el rótulo "RUTA". */
const COLAPSO_PASAJERO = (r: any): string => r?.ruta_nombre || `${r?.origen} → ${r?.destino}`;

/** lib/liquidacion-agrupacion.ts, antes del cambio. */
function nombreRutaDetalle_ORIGINAL(r: any): { nombre: string; fuente: string } {
  const n = String(r?.ruta_nombre ?? "").trim().replace(/\s+/g, " ");
  if (n) return { nombre: n, fuente: "nombre" };
  const tramo = [r?.origen, r?.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo ? { nombre: tramo, fuente: "tramo" } : { nombre: "SIN NOMBRE DE RUTA", fuente: "ninguna" };
}

const RE_ETIQUETA_RUTA_ORIGINAL = /\bRUTA[\s:.\-–—]+([A-Z0-9]{1,3})\b/i;
function etiquetaRutaDetalle_ORIGINAL(r: any): { etiqueta: string; fuente: string } {
  const m = RE_ETIQUETA_RUTA_ORIGINAL.exec(String(r.ruta_nombre ?? ""));
  if (m) return { etiqueta: `RUTA ${m[1].toUpperCase()}`, fuente: "nombre" };
  const tramo = [r.origen, r.destino].filter(Boolean).join(" → ").toUpperCase();
  return tramo ? { etiqueta: tramo, fuente: "tramo" } : { etiqueta: "RUTA ÚNICA", fuente: "ninguna" };
}

// ── 1 · EL DEFECTO REAL, REPRODUCIDO ──────────────────────────────────────────
console.log("\n1 · El caso de la captura: un campo rotulado RUTA pintando el plus code\n");

// Fila real del portal del cliente (OS-2026-006575, 19/09/2026): el servicio existe,
// tiene sus dos extremos geocodificados y NADIE le escribió el nombre de la ruta.
const SIN_NOMBRE = {
  ruta_nombre: null,
  origen: "W2VG+39R, El Agustino 15022, Perú",
  destino: "M5JG+GFG Pasillo D Lateral",
};

// El servicio de al lado, con su nombre bien puesto.
const CON_NOMBRE = {
  ruta_nombre: "RUTA A/ ENTRADA 06:30/ SANTA ANITA→BSF PUNTA HERMOSA",
  origen: "Primero De Mayo, Villa El Salvador",
  destino: "M5JG+GFG Pasillo D Lateral",
};

chk(
  "el colapso VIEJO pinta el plus code donde dice RUTA (el defecto)",
  COLAPSO_PASAJERO(SIN_NOMBRE).includes("W2VG+39R"),
  COLAPSO_PASAJERO(SIN_NOMBRE),
);
chk(
  "identidadRuta NO lo hace: sin nombre, nombre es null",
  identidadRuta(SIN_NOMBRE).nombre === null,
);
chk(
  "…y el recorrido sigue disponible, en su propio campo",
  identidadRuta(SIN_NOMBRE).recorrido === "W2VG+39R, El Agustino 15022, Perú → M5JG+GFG Pasillo D Lateral",
  String(identidadRuta(SIN_NOMBRE).recorrido),
);
chk(
  "con nombre escrito, el nombre es el tecleado y el recorrido NO lo pisa",
  identidadRuta(CON_NOMBRE).nombre === CON_NOMBRE.ruta_nombre &&
    identidadRuta(CON_NOMBRE).recorrido === "Primero De Mayo, Villa El Salvador → M5JG+GFG Pasillo D Lateral",
);
chk("sinNombreDeRuta distingue los dos casos",
  sinNombreDeRuta(SIN_NOMBRE) === true && sinNombreDeRuta(CON_NOMBRE) === false);

// El recorrido NO se fuerza a mayúsculas: lo lee el cliente, y en su portal los
// extremos se venían pintando tal como están guardados.
chk("el recorrido conserva la caja con la que se guardó",
  identidadRuta(CON_NOMBRE).recorrido === "Primero De Mayo, Villa El Salvador → M5JG+GFG Pasillo D Lateral");

// ── 2 · LA REJILLA ────────────────────────────────────────────────────────────
const NOMBRES = [
  null,
  undefined,
  "",
  "   ",
  "RUTA B/ ENTRADA 05:10/ CHILCA→BSF PUNTA HERMOSA",
  "  RUTA   C/  RETORNO  17:00  ",       // espacios dobles: se colapsan
  "ENTRADA 06:30/ HOTEL EL VUELO",       // sin la palabra RUTA: no hay etiqueta corta
];
const EXTREMOS = [null, undefined, "", "   ", "SANTA ANITA", "W2VG+39R, El Agustino 15022, Perú"];

// ── 2a · La invariante: identidadRuta nunca sustituye ─────────────────────────
console.log("\n2 · Barrido: identidadRuta NUNCA sustituye un campo por el otro\n");

let combinaciones = 0;
let conNombre = 0;
let conRecorrido = 0;
let malNombre = 0;
let malRecorrido = 0;
let malFuente = 0;

for (const rn of NOMBRES) {
  for (const o of EXTREMOS) {
    for (const d of EXTREMOS) {
      combinaciones++;
      const r = { ruta_nombre: rn, origen: o, destino: d };
      const id = identidadRuta(r);
      const nombreTecleado = String(rn ?? "").trim().replace(/\s+/g, " ");

      // (a) El nombre es el tecleado, o null. Nunca otra cosa.
      if (nombreTecleado) {
        if (id.nombre !== nombreTecleado) malNombre++;
        conNombre++;
      } else if (id.nombre !== null) {
        malNombre++;
      }

      // (b) El recorrido se compone SOLO de los extremos. Nunca del nombre.
      const oLimpio = String(o ?? "").trim().replace(/\s+/g, " ");
      const dLimpio = String(d ?? "").trim().replace(/\s+/g, " ");
      const esperado = oLimpio && dLimpio ? `${oLimpio} → ${dLimpio}` : oLimpio || dLimpio || null;
      if (id.recorrido !== esperado) malRecorrido++;
      if (esperado) conRecorrido++;

      // (c) Y por si el recorrido llegara a contener el nombre por accidente.
      if (nombreTecleado && id.recorrido !== null && id.recorrido.includes(nombreTecleado)) malRecorrido++;

      // (d) La fuente describe exactamente lo que hay.
      const fuenteEsperada = nombreTecleado ? "nombre" : esperado ? "tramo" : "ninguna";
      if (id.fuente !== fuenteEsperada) malFuente++;
    }
  }
}

chk(`${combinaciones} combinaciones · el nombre nunca es el recorrido`, malNombre === 0, `${malNombre} fallos`);
chk(`${combinaciones} combinaciones · el recorrido nunca es el nombre`, malRecorrido === 0, `${malRecorrido} fallos`);
chk(`${combinaciones} combinaciones · la fuente describe lo que hay`, malFuente === 0, `${malFuente} fallos`);
// El lado positivo: un motor que devolviera siempre null cumpliría lo de arriba trivialmente.
chk("no es trivial: hay casos CON nombre y casos CON recorrido en la rejilla",
  conNombre > 0 && conRecorrido > 0, `${conNombre} con nombre · ${conRecorrido} con recorrido`);

// ── 3 · EL LADO QUE NO SE PUEDE AFLOJAR ───────────────────────────────────────
console.log("\n3 · La liquidación sigue colapsando EXACTAMENTE igual\n");

let difRotulo = 0;
let difEtiqueta = 0;
let difFachada = 0;

for (const rn of NOMBRES) {
  for (const o of EXTREMOS) {
    for (const d of EXTREMOS) {
      const r = { ruta_nombre: rn, origen: o, destino: d } as any;

      const viejo = nombreRutaDetalle_ORIGINAL(r);
      const nuevo = rotuloColapsado(r);
      if (viejo.nombre !== nuevo.nombre || viejo.fuente !== nuevo.fuente) difRotulo++;

      const vEtq = etiquetaRutaDetalle_ORIGINAL(r);
      const nEtq = etiquetaCortaDetalle(r);
      if (vEtq.etiqueta !== nEtq.etiqueta || vEtq.fuente !== nEtq.fuente) difEtiqueta++;

      // La fachada que siguen importando /liquidaciones, ModalPrecios, ModalEnlaces…
      const fach = LIQ.nombreRutaDetalle(r);
      if (fach.nombre !== viejo.nombre || fach.fuente !== viejo.fuente) difFachada++;
      if (LIQ.nombreRuta(r) !== viejo.nombre) difFachada++;
      if (LIQ.etiquetaRutaDetalle(r).etiqueta !== vEtq.etiqueta) difFachada++;
    }
  }
}

chk(`${combinaciones} combinaciones · rotuloColapsado ≡ nombreRutaDetalle original`, difRotulo === 0, `${difRotulo} diferencias`);
chk(`${combinaciones} combinaciones · etiquetaCortaDetalle ≡ etiquetaRutaDetalle original`, difEtiqueta === 0, `${difEtiqueta} diferencias`);
chk(`${combinaciones} combinaciones · la fachada de liquidacion-agrupacion no se movió`, difFachada === 0, `${difFachada} diferencias`);

// El detalle que casi se cuela: los extremos van CRUDOS al tramo colapsado.
const SOLO_ESPACIOS = { ruta_nombre: null, origen: "   ", destino: "SANTA ANITA" };
chk(
  "un origen de solo espacios sobrevive a filter(Boolean) en el colapso, como siempre",
  rotuloColapsado(SOLO_ESPACIOS).nombre === nombreRutaDetalle_ORIGINAL(SOLO_ESPACIOS).nombre,
  JSON.stringify(rotuloColapsado(SOLO_ESPACIOS).nombre),
);
chk(
  "…y aun así identidadRuta lo descarta, porque lo suyo es la pantalla",
  identidadRuta(SOLO_ESPACIOS).origen === null && identidadRuta(SOLO_ESPACIOS).recorrido === "SANTA ANITA",
);

const DOBLE_ESPACIO = { ruta_nombre: null, origen: "SANTA  ANITA", destino: "BSF" };
chk(
  "un doble espacio en el extremo NO se colapsa en el rótulo de la liquidación",
  rotuloColapsado(DOBLE_ESPACIO).nombre === nombreRutaDetalle_ORIGINAL(DOBLE_ESPACIO).nombre &&
    rotuloColapsado(DOBLE_ESPACIO).nombre.includes("  "),
  JSON.stringify(rotuloColapsado(DOBLE_ESPACIO).nombre),
);

// ── 4 · LAS ETIQUETAS ─────────────────────────────────────────────────────────
console.log("\n4 · Las dos etiquetas y los textos del vacío\n");

// Se comparan como `string` a propósito: con los literales, TypeScript ya demuestra en
// compilación que son distintos y marca la comparación como inútil (TS2367). Que el
// compilador lo pruebe es justo lo que se quiere — pero la prueba tiene que seguir
// corriendo el día que alguien los mueva a una variable.
const etqRuta: string = ETIQUETA_RUTA;
const etqRec: string = ETIQUETA_RECORRIDO;
const vacioNombre: string = SIN_NOMBRE_RUTA;
const vacioRec: string = SIN_RECORRIDO;

chk("las dos etiquetas existen y son distintas",
  !!etqRuta && !!etqRec && etqRuta !== etqRec,
  `${etqRuta} · ${etqRec}`);
chk("la del recorrido NOMBRA sus dos extremos (no es una palabra que haya que aprender)",
  /ORIGEN/i.test(etqRec) && /DESTINO/i.test(etqRec));
chk("el texto del vacío se lee, no es un hueco ni un cero",
  vacioNombre.trim().length > 2 && vacioRec.trim().length > 2 && vacioNombre !== vacioRec);

// ── Cierre ────────────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "TODO EN VERDE" : `${fallos} FALLO(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
