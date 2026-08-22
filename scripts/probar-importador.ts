// ──────────────────────────────────────────────────────────────────────────────
// scripts/probar-importador.ts — Banco de pruebas del importador de finanzas.
//
// Corre los perfiles REALES (lib/importador) contra archivos de proveedores reales y
// muestra qué se detectó, qué filas entraron y cuáles se rechazaron y por qué. Es la
// forma de verificar un perfil nuevo sin levantar la app ni tocar Supabase.
//
//   npx tsx scripts/probar-importador.ts <archivo.xlsx> [más archivos...]
//
// Sin argumentos usa los archivos de muestra que estén en scripts/muestras/.
// ──────────────────────────────────────────────────────────────────────────────

import { readFileSync, existsSync, readdirSync } from "node:fs";
import { basename, join } from "node:path";
import {
  leerArchivo,
  aplicarPerfil,
  detectarPerfil,
  puntuarPerfiles,
  mapearColumnas,
  type Perfil,
} from "../lib/importador/tabular";
import {
  PERFILES_CXP,
  PERFILES_GASTOS_GENERALES,
  PERFILES_CAJA_CHICA,
  PERFILES_EXTRACTO,
} from "../lib/importador/perfiles-finanzas";

const TODOS = [
  ...PERFILES_CXP,
  ...PERFILES_GASTOS_GENERALES,
  ...PERFILES_CAJA_CHICA,
  ...PERFILES_EXTRACTO,
] as unknown as Perfil<Record<string, unknown>>[];

/** `leerArchivo` recibe un File del navegador; en Node se emula con el Blob nativo. */
function comoFile(ruta: string): File {
  const buf = readFileSync(ruta);
  return new File([new Uint8Array(buf)], basename(ruta), {
    type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  });
}

function recorta(v: unknown, n = 34): string {
  const s = v == null ? "—" : String(v);
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

async function probar(ruta: string) {
  console.log("\n" + "═".repeat(96));
  console.log("ARCHIVO:", basename(ruta));
  console.log("═".repeat(96));

  const crudas = await leerArchivo(comoFile(ruta));
  console.log(`\nHoja "${crudas.hoja}" · cabecera en la fila ${crudas.filaCabecera + 1} · ${crudas.filas.length} filas de datos`);
  console.log("\nCABECERAS DETECTADAS:");
  crudas.cabeceras.forEach((c, i) => {
    if (String(c).trim()) console.log(`   [${String(i).padStart(2)}] ${c}`);
  });

  console.log("\nPUNTAJE POR PERFIL:");
  for (const p of puntuarPerfiles(crudas.cabeceras, TODOS)) {
    const falta = p.requeridosFaltantes.length ? `  falta: ${p.requeridosFaltantes.join(", ")}` : "";
    console.log(`   ${(Math.round(p.puntaje * 100) + "%").padStart(4)}  ${p.nombre}${falta}`);
  }

  const perfil = detectarPerfil(crudas.cabeceras, TODOS);
  if (!perfil) {
    console.log("\n✗ NINGÚN PERFIL RECONOCIDO — la UI ofrecería el mapeo manual.");
    return;
  }
  console.log(`\n✓ PERFIL ELEGIDO: ${perfil.nombre} (${perfil.clave})`);

  console.log("\nMAPEO CAMPO → COLUMNA:");
  const mapa = mapearColumnas(crudas.cabeceras, perfil.campos);
  for (const c of perfil.campos) {
    const col = mapa[c.campo];
    const marca = c.requerido ? "*" : " ";
    const cab = col >= 0 ? `[${col}] ${crudas.cabeceras[col]}` : "— sin columna";
    console.log(`  ${marca} ${c.campo.padEnd(24)} ${cab}`);
  }

  // Se replica EXACTAMENTE lo que hace la pantalla: le pasa el mapa detectado como
  // `sobrescribirMapa` en cada parseo. Sin esta llamada igual a la real, el banco de
  // pruebas verificaba un camino que la UI no toma.
  const res = aplicarPerfil(crudas, perfil, { fecha_por_defecto: "2026-08-01" }, mapa);
  console.log(`\nRESULTADO: ${res.ok.length} válidas · ${res.errores.length} con error · ${res.total} leídas`);

  if (res.errores.length) {
    console.log("\nERRORES (hasta 12):");
    for (const e of res.errores.slice(0, 12)) console.log(`   fila ${e.fila}: ${e.motivo}`);
    if (res.errores.length > 12) console.log(`   … y ${res.errores.length - 12} más`);
  }

  if (res.ok.length) {
    const muestra = [res.ok[0], res.ok[Math.floor(res.ok.length / 2)], res.ok[res.ok.length - 1]];
    console.log("\nFILAS CONSTRUIDAS (primera / media / última):");
    for (const f of muestra) {
      const o = f as Record<string, unknown>;
      console.log("   ─────────────────────────────────────────────");
      for (const [k, v] of Object.entries(o)) {
        if (v === null || v === "" || v === 0) continue;
        console.log(`     ${k.padEnd(24)} ${recorta(v, 46)}`);
      }
    }

    // Comprobaciones agregadas: lo que un contador miraría primero.
    const filas = res.ok as unknown as Record<string, number | string | null>[];
    const suma = (k: string) => filas.reduce((s, f) => s + (Number(f[k]) || 0), 0);
    const cuenta = (k: string) => filas.filter((f) => f[k] !== null && f[k] !== "" && f[k] !== 0).length;
    console.log("\nRESUMEN DE LO IMPORTADO:");
    console.log(`   total               S/ ${suma("total").toFixed(2)}`);
    console.log(`   detracción          S/ ${suma("detraccion_monto").toFixed(2)}`);
    console.log(`   adelantos           S/ ${(suma("adelanto_1") + suma("adelanto_2")).toFixed(2)}`);
    for (const k of ["proveedor_ruc", "serie", "numero", "fecha_servicio", "vehiculo_placa",
                     "nro_operacion_bancaria", "cci_destino", "cuenta_destino", "banco_destino", "turno"]) {
      if (filas.some((f) => k in f)) console.log(`   con ${k.padEnd(22)} ${cuenta(k)}/${filas.length}`);
    }
    const porEstado = (k: string) => {
      const m = new Map<string, number>();
      for (const f of filas) m.set(String(f[k] ?? "—"), (m.get(String(f[k] ?? "—")) ?? 0) + 1);
      return [...m].map(([v, n]) => `${v}=${n}`).join("  ");
    };
    for (const k of ["tipo_comprobante", "estado_pago", "estado_aprobacion", "estado_detraccion"]) {
      if (filas.some((f) => k in f)) console.log(`   ${k.padEnd(26)} ${porEstado(k)}`);
    }
  }
}

async function main() {
  let rutas = process.argv.slice(2);
  if (!rutas.length) {
    const dir = join(process.cwd(), "scripts", "muestras");
    rutas = existsSync(dir)
      ? readdirSync(dir).filter((f) => /\.(xlsx|xls|csv)$/i.test(f)).map((f) => join(dir, f))
      : [];
  }
  if (!rutas.length) {
    console.error("Uso: npx tsx scripts/probar-importador.ts <archivo.xlsx> [...]");
    process.exit(1);
  }
  for (const r of rutas) {
    try {
      await probar(r);
    } catch (e) {
      console.error(`\n✗ ${basename(r)}: ${(e as Error)?.message ?? e}`);
    }
  }
}

main();
