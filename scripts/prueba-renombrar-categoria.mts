// Matriz del cambio de CLAVE de una categoría de traslado (VAN_15 → VAN_17).
//   npx tsx scripts/prueba-renombrar-categoria.mts
// lib/traslados/renombrar-categoria.ts (puro) y renombrar-categoria-datos.ts (contra una base y un
// almacenamiento FALSOS en memoria, con la FK `on update cascade` de tarifas_traslado). Fija:
//  · la clave se mueve en los TRES sitios que la llevan: precios (cascada), fotos (carpeta del bucket,
//    mismo nombre de archivo) y cotizaciones guardadas (`traslado_json.categoria.clave`), y el nombre
//    y la capacidad cotizados no se tocan;
//  · cuando algo falla ANTES del UPDATE, o el UPDATE no entra, NADA cambió (y no quedan copias);
//  · lo que queda a medias (cotizaciones) se dice y `completarRenombre` lo termina — solo si el
//    renombre ya se hizo (nunca le pasa a una categoría viva las cotizaciones de otra);
//  · la semilla de AFA (traslados-03) ya no resucita una clave renombrada.
import { readFileSync } from "node:fs";
import { frasesPlan, planFoto, revisarRenombre, trasladoJsonRenombrado } from "../lib/traslados/renombrar-categoria";
import { CLAVE_RENOMBRE, PRESUPUESTO_COTIZACIONES_MS, completarRenombre, previaRenombre, renombrarCategoria } from "../lib/traslados/renombrar-categoria-datos";
import { RE_RUTA_FOTO, rutaDeUrlFoto } from "../lib/traslados/fotos-categoria";

let bien = 0, mal = 0;
const fallas: string[] = [];
const ok = (c: unknown, n: string) => { if (c) bien++; else { mal++; fallas.push(n); } };

const BASE = "https://proyecto.supabase.co";
const PUB = `${BASE}/storage/v1/object/public/traslados-fotos/`;
const U1 = "318b5bf3-839d-4cea-9f76-6d622ba793a6";
const U2 = "817e6af9-570e-4ae4-b6eb-db10bb5bc2a9";
const foto = (clave: string, lado: string, u: string) => `${PUB}categorias/${clave}/${lado}-${u}.jpg`;

// ── 1. revisarRenombre ────────────────────────────────────────────────────────
{
  const claves = ["AUTO", "VAN_15", "SPRINTER_20"];
  ok(revisarRenombre("VAN_15", "", claves).codigo === "vacia", "vacía → vacia");
  ok(revisarRenombre("VAN_15", "  ¿?  ", claves).codigo === "vacia", "solo signos → vacia");
  ok(revisarRenombre("VAN_15", "van 15", claves).codigo === "igual", "la misma (normalizada) → igual");
  ok(revisarRenombre("VAN_99", "VAN_17", claves).codigo === "no_existe", "de inexistente → no_existe");
  ok(revisarRenombre("VAN_15", "sprinter 20", claves).codigo === "ya_existe", "a existente → ya_existe");
  const r = revisarRenombre("VAN_15", "van 17", claves);
  ok(r.ok && r.a === "VAN_17", "«van 17» → VAN_17");
  const t = revisarRenombre("VAN_15", "Ván  17", claves);
  ok(t.ok && t.a === "VAN_17" || (t.ok && t.a === "VAN__17"), "tildes y espacios se normalizan como al crear");
}

// ── 2. planFoto ───────────────────────────────────────────────────────────────
{
  ok(planFoto(null, BASE, "VAN_15", "VAN_17", "externa").codigo === "sin_foto", "null → sin_foto");
  ok(planFoto("  ", BASE, "VAN_15", "VAN_17", "externa").codigo === "sin_foto", "vacía → sin_foto");
  const p = planFoto(foto("VAN_15", "externa", U1), BASE, "VAN_15", "VAN_17", "externa");
  ok(p.codigo === "mover" && p.desde === `categorias/VAN_15/externa-${U1}.jpg` && p.hasta === `categorias/VAN_17/externa-${U1}.jpg`, "mover: misma foto, carpeta nueva");
  ok(p.codigo === "mover" && RE_RUTA_FOTO.test(p.hasta), "la ruta nueva tiene la forma exacta de rutaFoto");
  ok(planFoto(foto("BUS", "externa", U1), BASE, "VAN_15", "VAN_17", "externa").codigo === "ajena", "foto de OTRA categoría → ajena");
  ok(planFoto(foto("VAN_15", "interna", U1), BASE, "VAN_15", "VAN_17", "externa").codigo === "ajena", "foto del OTRO lado → ajena");
  ok(planFoto(foto("VAN_15", "externa", U1).replace("proyecto", "otro"), BASE, "VAN_15", "VAN_17", "externa").codigo === "ajena", "otro host → ajena");
  ok(planFoto("https://drive.google.com/x.jpg", BASE, "VAN_15", "VAN_17", "externa").codigo === "ajena", "Drive → ajena");
}

// ── 3. trasladoJsonRenombrado ─────────────────────────────────────────────────
{
  const tj = { version: 1, firma: "f", pax: 12, categoria: { clave: "VAN_15", nombre: "Sprinter corta (van) 15 pax", capacidad: 15 } };
  const n = trasladoJsonRenombrado(tj, "VAN_15", "VAN_17") as typeof tj | null;
  ok(!!n && n.categoria.clave === "VAN_17", "cambia la clave");
  ok(!!n && n.categoria.nombre === tj.categoria.nombre && n.categoria.capacidad === 15 && n.pax === 12 && n.firma === "f", "conserva nombre, capacidad y lo demás");
  ok(tj.categoria.clave === "VAN_15", "no muta el original");
  ok(trasladoJsonRenombrado({ ...tj, categoria: { ...tj.categoria, clave: "BUS" } }, "VAN_15", "VAN_17") === null, "otra categoría → null");
  ok(trasladoJsonRenombrado(null, "VAN_15", "VAN_17") === null && trasladoJsonRenombrado([], "VAN_15", "VAN_17") === null
    && trasladoJsonRenombrado({ categoria: "VAN_15" }, "VAN_15", "VAN_17") === null, "formas raras → null");
}

// ── 4. frasesPlan: lo desconocido no se dice como 0 ───────────────────────────
{
  const f = frasesPlan("VAN_15", "VAN_17", { tarifas: 6, fotos: 2, cotizaciones: 0 }).join(" ");
  ok(/Los 6 precios de VAN_15 pasan a VAN_17/.test(f) && /2 fotos/.test(f) && !/cotizaci/.test(f), "6 precios, 2 fotos, sin cotizaciones");
  const g = frasesPlan("VAN_15", "VAN_17", { tarifas: null, fotos: 0, cotizaciones: null }).join(" ");
  ok(/no se pudieron contar/.test(g) && !/\b0\b/.test(g), "lo que no se pudo contar se dice, nunca 0");
  const h = frasesPlan("VAN_15", "VAN_17", { tarifas: 1, fotos: 1, cotizaciones: 1 }).join(" ");
  ok(/El precio de VAN_15 pasa a VAN_17/.test(h) && /Su foto se mueve/.test(h) && /1 cotización guardada/.test(h), "singulares");
}

// ── 5. La base y el almacenamiento falsos ─────────────────────────────────────
type Fila = Record<string, unknown>;
type Opc = {
  faltan?: string[];                      // "tabla.columna" que no existen
  falloCopia?: (desde: string) => boolean;
  falloCotizacion?: Set<number>;
  antesDelUpdate?: (db: Db) => void;      // lo que hace «otra persona» justo antes del UPDATE
  falloNota?: boolean;                    // no se puede escribir en alerta_enviada
  falloRelectura?: boolean;               // la relectura antes de deshacer copias falla
};
type Db = { traslado_categorias: Fila[]; tarifas_traslado: Fila[]; cotizaciones: Fila[]; alerta_enviada: Fila[]; objetos: Set<string>; opc: Opc };

function crearDb(opc: Opc = {}): Db {
  return {
    traslado_categorias: [
      { clave: "AUTO", nombre: "Auto 4 pax", capacidad: 4, maletas_bodega: 0, tipo_vehiculo: "AUTO_4", orden: 10, activo: true, foto_externa_url: null, foto_interna_url: null, descripcion_cliente: null },
      { clave: "VAN_15", nombre: "Sprinter corta (van) 17 pax", capacidad: 17, maletas_bodega: 0, tipo_vehiculo: "VAN_15", orden: 40, activo: true,
        foto_externa_url: foto("VAN_15", "externa", U1), foto_interna_url: foto("VAN_15", "interna", U2), descripcion_cliente: "- Aire\n- USB" },
      { clave: "BUS", nombre: "Bus 45-50 pax", capacidad: 50, maletas_bodega: 45, tipo_vehiculo: "BUS_50", orden: 70, activo: true, foto_externa_url: null, foto_interna_url: null, descripcion_cliente: null },
    ],
    tarifas_traslado: [
      ...[1, 2, 3, 4, 5, 6].map((i) => ({ id: i, categoria: "VAN_15", precio_tramo: 300 })),
      { id: 7, categoria: "BUS", precio_tramo: 900 },
    ],
    cotizaciones: [
      { id: 10, traslado_json: { version: 1, firma: "a", categoria: { clave: "VAN_15", nombre: "Sprinter corta (van) 15 pax", capacidad: 15 } } },
      { id: 11, traslado_json: { version: 1, firma: "b", categoria: { clave: "BUS", nombre: "Bus 45-50 pax", capacidad: 50 } } },
      { id: 12, traslado_json: null },
      { id: 13, traslado_json: { version: 1, firma: "c", categoria: { clave: "VAN_15", nombre: "Sprinter corta (van) 15 pax", capacidad: 15 } } },
    ],
    alerta_enviada: [],
    objetos: new Set([`categorias/VAN_15/externa-${U1}.jpg`, `categorias/VAN_15/interna-${U2}.jpg`]),
    opc,
  };
}

const leerRuta = (f: Fila, col: string): unknown => {
  if (!col.includes("->")) return f[col];
  const partes = col.split(/->>?/);
  let v: unknown = f[partes[0]];
  for (const p of partes.slice(1)) v = v && typeof v === "object" ? (v as Fila)[p] : undefined;
  return v;
};

/** LIKE de Postgres: `%` cualquier cosa, `_` un carácter cualquiera (por eso el código filtra exacto después). */
function comoLike(x: string, pat: string): boolean {
  const esc = (ch: string) => (/[a-zA-Z0-9]/.test(ch) ? ch : `\\${ch}`);
  const re = [...pat].map((ch) => (ch === "%" ? ".*" : ch === "_" ? "." : esc(ch))).join("");
  return new RegExp(`^${re}$`).test(x);
}

function sbFalso(db: Db) {
  const faltan = new Set(db.opc.faltan ?? []);
  const from = (tabla: keyof Db & string) => {
    const st: { op: "select" | "update" | "insert"; cols?: string; head?: boolean; count?: boolean; patch?: Fila; filtros: [string, (v: unknown) => boolean][]; orden?: string; limite?: number; una?: boolean; devolver?: string } = { op: "select", filtros: [] };
    const b = {
      select(cols: string, o?: { count?: string; head?: boolean }) {
        if (st.op === "update") st.devolver = cols; else { st.cols = cols; st.head = !!o?.head; st.count = !!o?.count; }
        return b;
      },
      update(patch: Fila) { st.op = "update"; st.patch = patch; return b; },
      insert(fila: Fila) { st.op = "insert"; st.patch = fila; return b; },
      like(c: string, pat: string) { st.filtros.push([c, (x) => comoLike(String(x), pat)]); return b; },
      eq(c: string, v: unknown) { st.filtros.push([c, (x) => x === v]); return b; },
      is(c: string, v: null) { st.filtros.push([c, (x) => x == v]); return b; },
      gt(c: string, v: number) { st.filtros.push([c, (x) => Number(x) > v]); return b; },
      in(c: string, vs: unknown[]) { st.filtros.push([c, (x) => vs.includes(x)]); return b; },
      order(c: string) { st.orden = c; return b; },
      limit(n: number) { st.limite = n; return b; },
      maybeSingle() { st.una = true; return b; },
      then(res: (r: unknown) => unknown, rej?: (e: unknown) => unknown) { return Promise.resolve(correr()).then(res, rej); },
    };
    const proyectar = (f: Fila, cols?: string) => {
      if (!cols) return { ...f };
      const o: Fila = {};
      for (const c of cols.split(",").map((s) => s.trim())) o[c] = f[c];
      return o;
    };
    const correr = () => {
      const filas = db[tabla] as Fila[];
      const colsUsadas = [...(st.cols ?? "").split(","), ...(st.devolver ?? "").split(","), ...st.filtros.map(([c]) => c.split("->")[0])].map((s) => s.trim()).filter(Boolean);
      for (const c of colsUsadas) if (faltan.has(`${tabla}.${c}`)) return { data: null, count: null, error: { code: "42703", message: `column ${tabla}.${c} does not exist` } };
      if (st.op === "insert") {
        if (tabla === "alerta_enviada" && db.opc.falloNota) return { data: null, error: { message: "fetch failed" } };
        const f = st.patch!;
        if (filas.some((x) => x.clave === f.clave && x.ref === f.ref && x.fecha === f.fecha)) return { data: null, error: { code: "23505", message: "duplicate key" } };
        filas.push({ ...f });
        return { data: null, error: null };
      }
      if (st.op === "select" && tabla === "traslado_categorias" && db.opc.falloRelectura && st.filtros.some(([c]) => c === "clave") && /foto_externa_url/.test(st.cols ?? "") && !/nombre/.test(st.cols ?? "")) {
        return { data: null, error: { message: "fetch failed" } };
      }
      if (st.op === "update") {
        for (const k of Object.keys(st.patch!)) if (faltan.has(`${tabla}.${k}`)) return { data: null, error: { code: "PGRST204", message: `Could not find the '${k}' column of '${tabla}' in the schema cache` } };
        if (tabla === "traslado_categorias") db.opc.antesDelUpdate?.(db);
        const hits = filas.filter((f) => st.filtros.every(([c, p]) => p(leerRuta(f, c))));
        if (tabla === "cotizaciones" && hits.some((h) => db.opc.falloCotizacion?.has(Number(h.id)))) return { data: null, error: { message: "fetch failed" } };
        const nueva = st.patch!.clave;
        if (nueva != null && hits.length && filas.some((f) => f.clave === nueva && !hits.includes(f))) return { data: null, error: { code: "23505", message: "duplicate key value violates unique constraint" } };
        for (const h of hits) {
          const vieja = h.clave;
          Object.assign(h, st.patch);
          // FK on update cascade de tarifas_traslado
          if (tabla === "traslado_categorias" && nueva != null && vieja !== nueva) for (const t of db.tarifas_traslado) if (t.categoria === vieja) t.categoria = nueva;
        }
        return { data: st.devolver ? hits.map((h) => proyectar(h, st.devolver)) : null, error: null };
      }
      let r = filas.filter((f) => st.filtros.every(([c, p]) => p(leerRuta(f, c))));
      if (st.orden) r = [...r].sort((x, y) => Number(x[st.orden!]) - Number(y[st.orden!]));
      if (st.limite != null) r = r.slice(0, st.limite);
      if (st.head) return { data: null, count: r.length, error: null };
      if (st.una) return { data: r[0] ? proyectar(r[0], st.cols) : null, error: null };
      return { data: r.map((f) => proyectar(f, st.cols)), error: null };
    };
    return b;
  };
  const storage = {
    from: () => ({
      copy: async (desde: string, hasta: string) => {
        if (db.opc.falloCopia?.(desde) || !db.objetos.has(desde)) return { data: null, error: { message: "Object not found" } };
        if (db.objetos.has(hasta)) return { data: null, error: { message: "The resource already exists" } };
        db.objetos.add(hasta);
        return { data: { path: hasta }, error: null };
      },
      remove: async (rutas: string[]) => { for (const r of rutas) db.objetos.delete(r); return { data: [], error: null }; },
      getPublicUrl: (r: string) => ({ data: { publicUrl: `${PUB}${r}` } }),
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { from, storage } as any;
}

const foto15 = (db: Db) => db.traslado_categorias.find((c) => c.clave === "VAN_15");
const sinCambios = (db: Db, n: string) => {
  // La nota del cambio puede quedar (se escribe antes); lo que no puede cambiar es lo demás.
  const f = crearDb();
  ok(JSON.stringify(db.traslado_categorias) === JSON.stringify(f.traslado_categorias), `${n}: categorías intactas`);
  ok(JSON.stringify(db.tarifas_traslado) === JSON.stringify(f.tarifas_traslado), `${n}: precios intactos`);
  ok(JSON.stringify(db.cotizaciones) === JSON.stringify(f.cotizaciones), `${n}: cotizaciones intactas`);
  ok([...db.objetos].sort().join() === [...f.objetos].sort().join(), `${n}: almacenamiento intacto (sin copias sueltas)`);
};

// a) El caso real: VAN_15 → VAN_17, con 2 fotos, 6 precios y 2 cotizaciones.
{
  const db = crearDb();
  const sb = sbFalso(db);
  const p = await previaRenombre(sb, "VAN_15", BASE);
  ok(p.ok && p.previa.tarifas === 6 && p.previa.fotos === 2 && p.previa.cotizaciones === 2, "previa: 6 precios, 2 fotos, 2 cotizaciones");
  const r = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "van 17", supabaseUrl: BASE });
  ok(r.ok && r.codigo === "ok" && r.a === "VAN_17", `renombra (${r.codigo}: ${r.detalle})`);
  ok(!db.traslado_categorias.some((c) => c.clave === "VAN_15") && !!db.traslado_categorias.find((c) => c.clave === "VAN_17"), "VAN_15 ya no existe, VAN_17 sí");
  const v17 = db.traslado_categorias.find((c) => c.clave === "VAN_17")!;
  ok(v17.nombre === "Sprinter corta (van) 17 pax" && v17.capacidad === 17 && v17.descripcion_cliente === "- Aire\n- USB" && v17.tipo_vehiculo === "VAN_15", "nombre, asientos, descripción y ficha no cambian");
  ok(db.tarifas_traslado.filter((t) => t.categoria === "VAN_17").length === 6 && !db.tarifas_traslado.some((t) => t.categoria === "VAN_15") && r.tarifas === 6, "los 6 precios pasan a VAN_17 (cascada)");
  ok(db.tarifas_traslado.filter((t) => t.categoria === "VAN_17").every((t) => t.precio_tramo === 300), "ningún importe cambia");
  ok(rutaDeUrlFoto(v17.foto_externa_url, BASE, { clave: "VAN_17", lado: "externa" }) === `categorias/VAN_17/externa-${U1}.jpg`, "foto exterior: URL nueva, válida para VAN_17");
  ok(rutaDeUrlFoto(v17.foto_interna_url, BASE, { clave: "VAN_17", lado: "interna" }) === `categorias/VAN_17/interna-${U2}.jpg`, "foto interior: URL nueva, válida para VAN_17");
  ok(db.objetos.has(`categorias/VAN_17/externa-${U1}.jpg`) && db.objetos.has(`categorias/VAN_17/interna-${U2}.jpg`), "los archivos existen en la carpeta nueva");
  ok(![...db.objetos].some((o) => o.includes("/VAN_15/")) && r.fotos_movidas === 2 && r.fotos_sin_borrar === 0, "y la carpeta vieja quedó vacía");
  const c10 = db.cotizaciones.find((c) => c.id === 10)!.traslado_json as { categoria: { clave: string; nombre: string; capacidad: number } };
  ok(c10.categoria.clave === "VAN_17" && c10.categoria.nombre === "Sprinter corta (van) 15 pax" && c10.categoria.capacidad === 15, "cotización: clave nueva, lo cotizado intacto");
  ok((db.cotizaciones.find((c) => c.id === 13)!.traslado_json as { categoria: { clave: string } }).categoria.clave === "VAN_17", "la otra cotización también");
  ok((db.cotizaciones.find((c) => c.id === 11)!.traslado_json as { categoria: { clave: string } }).categoria.clave === "BUS" && db.cotizaciones.find((c) => c.id === 12)!.traslado_json === null, "las de otra categoría (o sin traslado) no se tocan");
  ok(r.cotizaciones === 2 && r.cotizaciones_pendientes === 0, "2 actualizadas, 0 pendientes");
  ok(!!r.categoria && r.categoria.clave === "VAN_17" && r.categoria.foto_externa_url === v17.foto_externa_url, "devuelve la fila nueva para la pantalla");
  // Repetirlo no hace nada (VAN_15 ya no existe).
  const otra = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "VAN_18", supabaseUrl: BASE });
  ok(!otra.ok && otra.codigo === "no_existe" && otra.status === 404, "repetir con la clave vieja → no_existe");
  ok(db.alerta_enviada.some((n) => n.clave === CLAVE_RENOMBRE && n.ref === "VAN_15>VAN_17"), "el cambio queda anotado (VAN_15>VAN_17)");
}

// a2) No se pudo anotar el cambio → no se toca nada.
{
  const db = crearDb({ falloNota: true });
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "error" && /No se cambió nada/.test(r.detalle), "sin nota → error, nada cambia");
  sinCambios(db, "sin nota");
}

// a3) Dos cambios a la vez (revisión de seguridad, hallazgo 1). R1 ya copió y su UPDATE entra justo
//     antes del de R2: R2 encuentra las copias hechas (no son suyas), su UPDATE no entra, y NO puede
//     borrar las fotos que VAN_17 ya está usando.
{
  const db = crearDb({
    antesDelUpdate: (d) => {
      const f = d.traslado_categorias.find((c) => c.clave === "VAN_15");
      if (!f) return;
      Object.assign(f, { clave: "VAN_17", foto_externa_url: foto("VAN_17", "externa", U1), foto_interna_url: foto("VAN_17", "interna", U2) });
      for (const t of d.tarifas_traslado) if (t.categoria === "VAN_15") t.categoria = "VAN_17";
    },
  });
  db.objetos.add(`categorias/VAN_17/externa-${U1}.jpg`);
  db.objetos.add(`categorias/VAN_17/interna-${U2}.jpg`);
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "cambio_concurrente", "carrera: el segundo → cambio_concurrente");
  ok(db.objetos.has(`categorias/VAN_17/externa-${U1}.jpg`) && db.objetos.has(`categorias/VAN_17/interna-${U2}.jpg`), "carrera: las fotos que VAN_17 usa siguen en su sitio");
}

// a4) La otra variante: ESTA petición creó las copias, pero la fila ya quedó con esas URLs (la otra
//     terminó, o el UPDATE entró y se perdió la respuesta). Tampoco se borran.
{
  const db = crearDb({
    antesDelUpdate: (d) => {
      const f = d.traslado_categorias.find((c) => c.clave === "VAN_15");
      if (f) Object.assign(f, { clave: "VAN_17", foto_externa_url: foto("VAN_17", "externa", U1), foto_interna_url: foto("VAN_17", "interna", U2) });
    },
  });
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && db.objetos.has(`categorias/VAN_17/externa-${U1}.jpg`) && db.objetos.has(`categorias/VAN_17/interna-${U2}.jpg`), "copias propias en uso: no se borran");
}

// a5) Si no se puede comprobar quién usa las copias, no se borra nada (una huérfana no rompe un PDF).
{
  const db = crearDb({ falloRelectura: true, antesDelUpdate: (d) => { foto15(d)!.foto_externa_url = null; } });
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "cambio_concurrente" && db.objetos.has(`categorias/VAN_17/interna-${U2}.jpg`), "sin poder comprobar: las copias se quedan");
}

// b) La clave nueva ya existe → nada cambia.
{
  const db = crearDb();
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "bus", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "ya_existe" && r.status === 409, "a existente → 409 ya_existe");
  sinCambios(db, "ya_existe");
  ok(db.alerta_enviada.length === 0, "ya_existe: tampoco se anota");
}

// c) Una foto no se pudo copiar → nada cambia y no queda la otra copia.
{
  const db = crearDb({ falloCopia: (d) => d.includes("interna") });
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "foto" && /interior/.test(r.detalle) && /No se cambió nada/.test(r.detalle), "copia fallida → foto, lo dice");
  sinCambios(db, "copia fallida");
}

// d) Otra persona cambió una foto mientras tanto → 0 filas, nada cambia.
{
  const db = crearDb({ antesDelUpdate: (d) => { foto15(d)!.foto_externa_url = null; } });
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "cambio_concurrente" && r.status === 409, "cambio ajeno → cambio_concurrente");
  ok(db.traslado_categorias.some((c) => c.clave === "VAN_15") && db.tarifas_traslado.filter((t) => t.categoria === "VAN_15").length === 6, "la clave y los precios siguen");
  ok(![...db.objetos].some((o) => o.includes("/VAN_17/")), "y no quedan copias en la carpeta nueva");
}

// e) Alguien creó VAN_17 entre la revisión y el UPDATE → 23505 → ya_existe, nada cambia.
{
  const db = crearDb({ antesDelUpdate: (d) => { if (!d.traslado_categorias.some((c) => c.clave === "VAN_17")) d.traslado_categorias.push({ clave: "VAN_17", nombre: "x", capacidad: 17 }); } });
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "ya_existe", "carrera con un alta → ya_existe");
  ok(db.tarifas_traslado.filter((t) => t.categoria === "VAN_15").length === 6 && ![...db.objetos].some((o) => o.includes("/VAN_17/")), "precios intactos, sin copias");
}

// f) Sin traslados-07 (sin columnas de fotos): se renombra igual.
{
  const db = crearDb({ faltan: ["traslado_categorias.foto_externa_url", "traslado_categorias.foto_interna_url", "traslado_categorias.descripcion_cliente"] });
  const sb = sbFalso(db);
  const p = await previaRenombre(sb, "VAN_15", BASE);
  ok(p.ok && p.previa.fotos === 0, "previa sin columnas de fotos: 0 fotos");
  const r = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(r.ok && r.fotos_movidas === 0 && db.tarifas_traslado.filter((t) => t.categoria === "VAN_17").length === 6, "sin traslados-07: renombra y mueve los precios");
  ok(db.objetos.size === 2 && [...db.objetos].every((o) => o.includes("/VAN_15/")), "y no toca el almacenamiento");
}

// g) Sin traslados-05 (sin cotizaciones.traslado_json): se renombra igual, 0 cotizaciones.
{
  const db = crearDb({ faltan: ["cotizaciones.traslado_json"] });
  const sb = sbFalso(db);
  const p = await previaRenombre(sb, "VAN_15", BASE);
  ok(p.ok && p.previa.cotizaciones === 0, "previa sin traslado_json: 0 cotizaciones");
  const r = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(r.ok && r.codigo === "ok" && r.cotizaciones === 0 && r.cotizaciones_pendientes === 0, "sin traslados-05: ok, sin cotizaciones");
}

// h) Una cotización no se pudo actualizar → parcial; completarRenombre lo termina.
{
  const fallo = new Set([13]);
  const db = crearDb({ falloCotizacion: fallo });
  const sb = sbFalso(db);
  const r = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(r.ok && r.codigo === "parcial" && r.cotizaciones === 1 && r.cotizaciones_pendientes === 1 && /Reintentar/.test(r.detalle), "una falla → parcial con 1 pendiente");
  ok(db.traslado_categorias.some((c) => c.clave === "VAN_17"), "la clave sí cambió");
  fallo.clear();
  const c = await completarRenombre(sb, { de: "VAN_15", a: "VAN_17" });
  ok(c.ok && c.codigo === "ok" && c.cotizaciones === 1 && c.cotizaciones_pendientes === 0, "completar: la que faltaba pasa a VAN_17");
  ok(db.cotizaciones.filter((x) => (x.traslado_json as { categoria?: { clave: string } } | null)?.categoria?.clave === "VAN_15").length === 0, "no queda ninguna con VAN_15");
}

// h2) El presupuesto de tiempo (revisión de seguridad, hallazgo 2): con un reloj que avanza 15 s por
//     consulta, el cambio responde «parcial» antes de que muera la función; la previa de la clave
//     NUEVA encuentra lo que quedó con la vieja, y «Terminar» lo pasa.
{
  const db = crearDb();
  for (let i = 0; i < 30; i++) db.cotizaciones.push({ id: 100 + i, traslado_json: { categoria: { clave: "VAN_15", nombre: "x", capacidad: 15 } } });
  let t = 0;
  const reloj = { ahoraMs: () => (t += 15_000) };
  const sb = sbFalso(db);
  const r = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE, ...reloj });
  ok(r.ok && r.codigo === "parcial" && (r.cotizaciones_pendientes ?? 0) > 0 && r.cotizaciones < 32, `presupuesto: parcial (${r.cotizaciones} hechas, ${r.cotizaciones_pendientes} pendientes)`);
  ok(PRESUPUESTO_COTIZACIONES_MS < 60_000, "el presupuesto cabe en la vida de la ruta (60 s)");
  const p = await previaRenombre(sb, "VAN_17", BASE);
  ok(p.ok && p.pendientes.length === 1 && p.pendientes[0].de === "VAN_15" && p.pendientes[0].cotizaciones === r.cotizaciones_pendientes, "la previa de VAN_17 dice que quedaron cotizaciones con VAN_15");
  const c = await completarRenombre(sb, { de: "VAN_15", a: "VAN_17" });
  ok(c.ok && c.codigo === "ok" && c.cotizaciones_pendientes === 0, "Terminar: no queda ninguna");
  const p2 = await previaRenombre(sb, "VAN_17", BASE);
  ok(p2.ok && p2.pendientes.length === 0, "y la previa ya no ofrece terminar");
}

// i) completarRenombre solo termina un renombre YA hecho.
{
  const db = crearDb();
  const c1 = await completarRenombre(sbFalso(db), { de: "VAN_15", a: "BUS" });
  ok(!c1.ok && c1.codigo === "no_aplica", "con VAN_15 viva → no_aplica (no le pasa sus cotizaciones a BUS)");
  ok((db.cotizaciones.find((c) => c.id === 10)!.traslado_json as { categoria: { clave: string } }).categoria.clave === "VAN_15", "y no toca nada");
  const db2 = crearDb();
  db2.traslado_categorias = db2.traslado_categorias.filter((c) => c.clave !== "VAN_15");
  const c2 = await completarRenombre(sbFalso(db2), { de: "VAN_15", a: "VAN_99" });
  ok(!c2.ok && c2.codigo === "no_aplica", "con la nueva inexistente → no_aplica");
  // Hallazgo 3: una categoría BORRADA (VAN_15 ya no existe) no le pasa sus cotizaciones a BUS sin
  // un cambio de clave anotado.
  const c3 = await completarRenombre(sbFalso(db2), { de: "VAN_15", a: "BUS" });
  ok(!c3.ok && c3.codigo === "no_aplica" && /No hay ningún cambio de clave/.test(c3.detalle), "sin nota → no_aplica (no se mueven cotizaciones de una borrada)");
  ok((db2.cotizaciones.find((c) => c.id === 10)!.traslado_json as { categoria: { clave: string } }).categoria.clave === "VAN_15", "y las cotizaciones siguen como estaban");
}

// j) Una foto que no es de esta categoría se deja tal cual (el PDF ya no la usaba).
{
  const db = crearDb();
  foto15(db)!.foto_interna_url = "https://drive.google.com/foto.jpg";
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  const v = db.traslado_categorias.find((c) => c.clave === "VAN_17")!;
  ok(r.ok && r.fotos_movidas === 1 && r.fotos_ajenas.join() === "interna" && v.foto_interna_url === "https://drive.google.com/foto.jpg", "ajena: se queda, y se informa");
  ok(db.objetos.has(`categorias/VAN_15/interna-${U2}.jpg`), "y su archivo (de otro dueño) no se borra");
}

// k) Una copia que ya estaba (intento anterior sin terminar) sirve igual.
{
  const db = crearDb();
  db.objetos.add(`categorias/VAN_17/externa-${U1}.jpg`);
  const r = await renombrarCategoria(sbFalso(db), { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(r.ok && r.fotos_movidas === 2 && !!db.traslado_categorias.find((c) => c.clave === "VAN_17")?.foto_externa_url, "copia previa → se usa");
}

// l) Sin la tabla (traslados-01): lo dice.
{
  const sb = {
    from: () => { const b: Record<string, unknown> = {}; for (const m of ["select", "eq", "maybeSingle", "in"]) b[m] = () => b; b.then = (res: (r: unknown) => unknown) => Promise.resolve({ data: null, error: { code: "PGRST205", message: "Could not find the table 'public.traslado_categorias' in the schema cache" } }).then(res); return b; },
    storage: { from: () => ({}) },
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  const r = await renombrarCategoria(sb, { de: "VAN_15", aTecleada: "VAN_17", supabaseUrl: BASE });
  ok(!r.ok && r.codigo === "sin_migracion" && /traslados-01/.test(r.detalle), "sin tablas → sin_migracion nombrando el SQL");
  const p = await previaRenombre(sb, "VAN_15", BASE);
  ok(!p.ok && p.codigo === "sin_migracion", "previa sin tablas → sin_migracion");
}

// ── 6. La semilla de AFA no resucita una clave renombrada ─────────────────────
{
  const sql = readFileSync("supabase/traslados-03-precios-afa.sql", "utf8");
  const cat = sql.slice(sql.indexOf("insert into public.traslado_categorias"), sql.indexOf("on conflict (clave)"));
  ok(/where not exists \(select 1 from public\.traslado_categorias\)/.test(cat), "categorías: solo si no hay ninguna");
  const pre = sql.slice(sql.indexOf("insert into public.tarifas_traslado"));
  ok(/where exists \(select 1 from public\.traslado_categorias c where c\.clave = p\.categoria\)/.test(pre), "precios: solo de categorías que existen (sin FK rota ni clave vieja)");
}

// ── 7. La ruta y la pantalla ──────────────────────────────────────────────────
{
  const ruta = readFileSync("app/api/traslados/categorias/renombrar/route.ts", "utf8");
  ok((ruta.match(/verificarUsuarioApi\(req, "tarifas"\)/g) ?? []).length === 2, "GET y POST exigen el módulo Tarifas");
  ok(/if \(!mismoOrigen\(req\)\)/.test(ruta) && /limitarTasa\(/.test(ruta), "POST: mismo origen y freno");
  const pantalla = readFileSync("components/tarifario/VehiculosTraslado.tsx", "utf8");
  ok(!/La clave no se (puede )?cambia/.test(pantalla), "la pantalla ya no dice que la clave no se cambia");
  ok(/ModalClaveCategoria/.test(pantalla), "la tabla ofrece cambiar la clave");
  const zonas = readFileSync("components/tarifario/ZonasTraslados.tsx", "utf8");
  ok(/t\.categoria === de \? \{ \.\.\.t, categoria: c\.clave \}/.test(zonas), "la pantalla mueve sus precios a la clave nueva (como la cascada)");
}

console.log(`\n${bien} bien · ${mal} mal`);
if (mal) { console.log(fallas.map((f) => `  ✗ ${f}`).join("\n")); process.exit(1); }
