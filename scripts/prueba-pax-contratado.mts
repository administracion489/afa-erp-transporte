// Los asientos CONTRATADOS: la cascada, y el número que NADIE firmó.
//
// ─── EL CASO ────────────────────────────────────────────────────────────────
//
// Reportado desde el portal del cliente (18-09-2026, Compañía Hard Discount):
//
//   RUTA C/ENTRADA 6:35 · bus B8H-967 de 50 asientos · 34 pasajeros a bordo
//   /programacion decía  →  «34/50»
//   /cliente decía       →  «34 / 10 de contratados»
//
// Los dos números eran de dos preguntas distintas y ninguna pantalla decía cuál:
//
//   · el 50 es la capacidad de la UNIDAD ASIGNADA (`capacidadDe`), que contesta
//     "¿cabe todo el mundo en el bus que sale?" — y se leyó como el contrato;
//   · el 10 salió de la CASCADA de asientos contratados… y no lo había escrito nadie.
//
// ─── LA CAUSA DEL 10: UN ÍTEM MUDO QUE "CONSENTÍA" ──────────────────────────
//
// `ModalGenerarPrograma` arma UN MÓVIL POR ÍTEM de la cotización, así que una
// cotización de tres ítems son tres móviles y cada uno puede tener su capacidad.
// `cargarPaxDeCotizaciones` miraba solo "los ítems que DECLARAN pax": con un ítem
// declarando 10 y dos callados, `paxes.length === 1` y esos 10 se le prestaban a los
// tres. La reserva no guarda a qué ítem pertenece, así que el móvil de un bus de 50
// terminaba publicándole al cliente un contrato de 10.
//
// La regla correcta: la cotización contesta solo si TODOS sus ítems declaran pax y
// declaran el MISMO. Un ítem callado no es un acuerdo con el que sí habló.
//
// La sección 1 conserva el algoritmo VIEJO copiado literal y exige que reproduzca el
// defecto: si deja de hacerlo, el escenario dejó de ser el que se rompió.
//
// Correr:  npx tsx scripts/prueba-pax-contratado.mts
import {
  paxDeItems, resolverPaxDeServicio, paxDeFichaPorNombre,
  type CatalogoRutas, type ServicioPax,
} from "../lib/liquidacion-rutas";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

/** Ítem de `cotizaciones.items_json`, con lo único que mira la cascada. */
const item = (pax: number | null) => ({ descripcion: "móvil", pax_contratado: pax });

/** EL ALGORITMO VIEJO, copiado literal de lib/liquidacion-rutas.ts antes del arreglo. */
function paxDeItemsVIEJO(itemsJson: unknown): number | null {
  const items = Array.isArray(itemsJson) ? itemsJson : [];
  const paxes = [
    ...new Set(
      items
        .map((it: any) => Number(it?.pax_contratado ?? 0))
        .filter((n: number) => Number.isFinite(n) && n > 0)
    ),
  ];
  return paxes.length === 1 ? Number(paxes[0]) : null;
}

const catalogoVacio: CatalogoRutas = { porClave: new Map(), filas: [], disponible: false };

const ficha = (nombreIda: string, pax: number | null, clienteId = 7) => ({
  id: Math.floor(Math.random() * 1e6),
  cliente_id: clienteId,
  cliente_sede_id: null,
  nombre_ida: nombreIda,
  nombre_retorno: null,
  pax_contratado: pax,
});
const catalogoCon = (...filas: any[]): CatalogoRutas => ({
  porClave: new Map(), filas, disponible: true,
});

// ── 1 · EL CASO QUE SALIÓ EN EL PORTAL ──────────────────────────────────────
titulo("1 · La cotización de tres móviles: uno declara 10 y dos callan");

// La cotización de la RUTA C: el bus grande y dos móviles más, y solo uno con el
// pax tecleado. Ninguno de los tres dice que el bus grande sean 10 asientos.
const cotRutaC = [item(null), item(10), item(null)];

ok(paxDeItemsVIEJO(cotRutaC) === 10,
  "el algoritmo VIEJO reproduce el defecto (presta los 10 a los tres móviles)",
  paxDeItemsVIEJO(cotRutaC));
ok(paxDeItems(cotRutaC) === null,
  "el motor de hoy NO contesta: un ítem mudo no consiente",
  String(paxDeItems(cotRutaC)));

// Y el efecto en la cascada completa, que es donde el número llega al cliente.
const servicioRutaC: ServicioPax = {
  capacidad_contratada: null,   // el generador no lo escribió: es un servicio viejo
  cotizacion_id: 238,
  cliente_id: 7,
  ruta_nombre: "RUTA C/ENTRADA 6:35/ 1RO MAYO→BSF",
};
const conViejo = resolverPaxDeServicio(servicioRutaC, null, {
  paxCotizacion: new Map([[238, paxDeItemsVIEJO(cotRutaC)!]]),
  catalogo: catalogoVacio,
});
const conHoy = resolverPaxDeServicio(servicioRutaC, null, {
  paxCotizacion: new Map(paxDeItems(cotRutaC) != null ? [[238, paxDeItems(cotRutaC)!]] : []),
  catalogo: catalogoVacio,
});
ok(conViejo.pax === 10 && conViejo.fuente === "cotizacion",
  "antes: el portal publicaba «/ 10 de contratados»", JSON.stringify(conViejo));
ok(conHoy.pax === null && conHoy.fuente === null,
  "ahora: sin dato — el portal pinta «—» y /programacion lo pide en ámbar",
  JSON.stringify(conHoy));

// ── 2 · EL LADO QUE NO SE PUEDE AFLOJAR ─────────────────────────────────────
titulo("2 · Lo que SÍ sabía contestar sigue contestando igual");

// Un motor que devolviera siempre null cumpliría la sección 1 de forma trivial. El
// escalón se creó para los servicios generados antes de que existiera la columna
// `reservas.capacidad_contratada`, y ESO no puede dejar de funcionar.
ok(paxDeItems([item(15)]) === 15,
  "cotización de UN móvil que declara 15 → 15");
ok(paxDeItems([item(15), item(15), item(15)]) === 15,
  "tres móviles que declaran lo MISMO → 15");
ok(paxDeItemsVIEJO([item(15)]) === paxDeItems([item(15)]),
  "un solo móvil: viejo y nuevo coinciden");
ok(paxDeItemsVIEJO([item(15), item(15)]) === paxDeItems([item(15), item(15)]),
  "dos móviles iguales: viejo y nuevo coinciden");

// ── 3 · LO QUE NO SE CONTESTA, Y POR QUÉ ────────────────────────────────────
titulo("3 · Los silencios");

ok(paxDeItems([item(10), item(20)]) === null,
  "dos móviles con capacidades distintas → null (ya era así)");
ok(paxDeItems([]) === null,
  "sin ítems no hay ningún móvil descrito → null");
ok(paxDeItems(null) === null, "items_json ausente → null");
ok(paxDeItems("[]") === null, "items_json que no es array → null");
ok(paxDeItems([item(0), item(10)]) === null,
  "un 0 es «no lo sé», no «cero asientos» → null");
ok(paxDeItems([item(-5), item(-5)]) === null,
  "un negativo tampoco declara nada → null");
ok(paxDeItems([{ descripcion: "peaje" } as any, item(30)]) === null,
  "un ítem sin el campo siquiera → null");
ok(paxDeItems([{ pax_contratado: "12" } as any, { pax_contratado: 12 } as any]) === 12,
  "el número viene como texto del jsonb y se normaliza igual");
ok(paxDeItems([item(12.4), item(12)]) === 12,
  "se redondea antes de comparar, para no partir por un decimal del jsonb");

// ── 4 · LA REGLA DURA DE LA CASCADA ─────────────────────────────────────────
titulo("4 · NUNCA se cae a la capacidad del vehículo");

// Es la invariante del módulo entero: el bus que sale no dice qué se pactó. Se barre
// la rejilla de todas las formas en que puede llegar un servicio y se comprueba que el
// resultado siempre sale de una fuente DECLARADA, nunca de un número de la flota.
const CAP_BUS = 50;   // el bus asignado, que NO puede aparecer jamás
let barridos = 0, conFuente = 0, coladoDelBus = 0;
for (const propio of [null, 0, 15]) {
  for (const delHermano of [null, 0, 20]) {
    for (const cot of [null, 25]) {
      for (const conFicha of [false, true]) {
        for (const conNombre of [false, true]) {
          barridos++;
          const s: ServicioPax = {
            capacidad_contratada: propio,
            cotizacion_id: cot != null ? 99 : null,
            cliente_id: 7,
            ruta_nombre: conNombre ? "RUTA C/ENTRADA 6:35" : null,
          };
          const r = resolverPaxDeServicio(
            s,
            delHermano != null ? { capacidad_contratada: delHermano, ruta_nombre: null } : null,
            {
              paxCotizacion: cot != null ? new Map([[99, cot]]) : undefined,
              catalogo: conFicha
                ? catalogoCon(ficha("RUTA C/ENTRADA 6:35", 30))
                : catalogoVacio,
            },
          );
          // Invariante 1: hay número ⟺ hay fuente. Un número sin fuente es un número
          // que nadie puede corregir, porque nadie sabe dónde vive.
          if ((r.pax != null) !== (r.fuente != null)) conFuente++;
          // Invariante 2: la capacidad del bus no se cuela por ninguna rama.
          if (r.pax === CAP_BUS) coladoDelBus++;
          // Invariante 3: el orden de la cascada se respeta.
          const esperado =
            propio && propio > 0 ? { pax: propio, fuente: "servicio" }
            : delHermano && delHermano > 0 ? { pax: delHermano, fuente: "hermano" }
            : cot != null ? { pax: cot, fuente: "cotizacion" }
            : conFicha && conNombre ? { pax: 30, fuente: "ficha" }
            : { pax: null, fuente: null };
          if (r.pax !== esperado.pax || r.fuente !== esperado.fuente) {
            ok(false, `cascada fuera de orden`,
              `${JSON.stringify({ propio, delHermano, cot, conFicha, conNombre })} → ${JSON.stringify(r)} ≠ ${JSON.stringify(esperado)}`);
          }
        }
      }
    }
  }
}
ok(conFuente === 0, `todo número declara su fuente (${barridos} combinaciones)`);
ok(coladoDelBus === 0, "la capacidad del vehículo no aparece en ninguna combinación");
ok(barridos === 3 * 3 * 2 * 2 * 2, "la rejilla se barrió entera", barridos);

// Y el corolario, porque un motor que devolviera siempre null cumpliría lo anterior
// de forma trivial: con dato escrito, sale ese dato.
ok(resolverPaxDeServicio(
  { capacidad_contratada: 50, cliente_id: 7 }, null, {},
).pax === 50, "con 50 escrito en el servicio, la cascada devuelve 50");

// ── 5 · LA FICHA, QUE ES EL ESCALÓN QUE HEREDA ──────────────────────────────
titulo("5 · paxDeFichaPorNombre: ambiguo es null, no «la primera que calce»");

const cat2 = catalogoCon(
  ficha("RUTA C/ENTRADA 6:35", 50),
  ficha("RUTA B/ ENTRADA 07:00", 10),
);
ok(paxDeFichaPorNombre(cat2, 7, ["RUTA C/ENTRADA 6:35"]) === 50,
  "la ficha de la RUTA C da 50, no el 10 de la RUTA B");
ok(paxDeFichaPorNombre(cat2, 7, ["RUTA B/ ENTRADA 07:00"]) === 10,
  "y la de la RUTA B da 10");
ok(paxDeFichaPorNombre(cat2, 7, ["ruta c/entrada   6:35"]) === 50,
  "normaliza espacios y mayúsculas, igual que el índice único del catálogo");
ok(paxDeFichaPorNombre(catalogoCon(ficha("RUTA C", 50), ficha("RUTA C", 30)), 7, ["RUTA C"]) === null,
  "dos fichas del mismo nombre con capacidades distintas → null");
ok(paxDeFichaPorNombre(cat2, 99, ["RUTA C/ENTRADA 6:35"]) === null,
  "la ficha de OTRO cliente no contesta");
ok(paxDeFichaPorNombre(cat2, 7, [null, undefined, "  "]) === null,
  "sin nombre no hay con qué buscar → null (y nunca casa con un nombre_retorno vacío)");

// ── Resultado ───────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "✓ TODO EN VERDE" : `✗ ${fallos} FALLA(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
