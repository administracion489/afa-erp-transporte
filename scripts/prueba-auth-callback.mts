// Pruebas del callback de sesión de supabase-js: un `onAuthStateChange` que ESPERA una consulta
// a Supabase congela el cliente de la pestaña entera (el «⏳ Guardando…» sin fin de /cotizaciones,
// que solo F5 arreglaba).
//
// 1 · Con supabase-js REAL (fetch y almacén simulados) el patrón viejo se cuelga en los tres
//     disparadores que avisan CON el candado de sesión tomado, y el nuevo no. Si el viejo deja de
//     colgarse, el escenario dejó de ser el que se rompió (p.ej. una versión nueva de la librería):
//     la prueba falla para que alguien lo mire, no porque el ERP esté mal.
// 2 · Ningún `onAuthStateChange` del ERP es async, espera algo o llama a Supabase fuera de un
//     setTimeout.
//
// Uso:  npx tsx scripts/prueba-auth-callback.mts   (sale con código 1 si algo falla)

import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { createClient } from "@supabase/supabase-js";

let fallos = 0;
const chk = (nombre: string, ok: boolean, detalle = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${detalle ? ` — ${detalle}` : ""}`);
  if (!ok) fallos++;
};

// ── 1 · El mecanismo, con la librería de verdad ───────────────────────────────────────────────
/* eslint-disable @typescript-eslint/no-explicit-any */
const URL_ = "https://xyzproj.supabase.co";
const CLAVE_ALMACEN = "sb-xyzproj-auth-token";
const ahora = () => Math.floor(Date.now() / 1000);
// Como los crea /api/crear-usuario: user_metadata {nombre, rol}, SIN full_name.
const usuario = { id: "u-1", aud: "authenticated", role: "authenticated", email: "op@empresa.pe", user_metadata: { nombre: "Ana Operadora", rol: "operador" } };
const sesion = (exp: number) => ({ access_token: `at-${exp}`, refresh_token: "rt-1", token_type: "bearer", expires_in: exp - ahora(), expires_at: exp, user: usuario });

const fetchFalso = async (input: any) => {
  const u = String(input?.url ?? input);
  const ok = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
  if (u.includes("/auth/v1/token")) return ok(sesion(ahora() + 3600));
  if (u.includes("/auth/v1/user")) return ok(usuario);
  if (u.includes("/rest/v1/usuarios")) return ok([{ nombre: "Ana Operadora" }]);
  if (u.includes("/rest/v1/cotizaciones")) return ok([{ id: 99 }]);
  return ok({});
};

const COLGADO = "colgado";
const conTope = (p: Promise<unknown>, ms: number) =>
  Promise.race([p.then(() => "terminó", () => "terminó con error"), new Promise((r) => setTimeout(() => r(COLGADO), ms))]);

function nuevoCliente() {
  const m = new Map<string, string>([[CLAVE_ALMACEN, JSON.stringify(sesion(ahora() + 3600))]]);
  const almacen = { m, getItem: (k: string) => m.get(k) ?? null, setItem: (k: string, v: string) => { m.set(k, v); }, removeItem: (k: string) => { m.delete(k); } };
  const c: any = createClient(URL_, "anon", { auth: { storage: almacen, autoRefreshToken: false, persistSession: true, detectSessionInUrl: false }, global: { fetch: fetchFalso as any } });
  c.__almacen = almacen;
  return c;
}

// El callback de /cotizaciones ANTES del arreglo, copiado literal en lo que importa.
function registrarViejo(sb: any) {
  const cargarNombre = async (session: any) => {
    if (!session?.user) return;
    const m = session.user.user_metadata;
    if ((m?.full_name || m?.name || "").trim()) return;
    await sb.from("usuarios").select("nombre").eq("id", session.user.id).maybeSingle();
  };
  sb.auth.onAuthStateChange(async (_e: string, session: any) => { await cargarNombre(session); });
}
// El patrón de ahora: síncrono, diferido con setTimeout y solo cuando cambia el usuario.
function registrarNuevo(sb: any) {
  const cargarNombre = async (session: any) => {
    if (!session?.user) return;
    await sb.from("usuarios").select("nombre").eq("id", session.user.id).maybeSingle();
  };
  let visto: string | null | undefined;
  const alCambiar = (session: any) => {
    const id = session?.user?.id ?? null;
    if (id === visto) return;
    visto = id;
    setTimeout(() => { void cargarNombre(session); }, 0);
  };
  sb.auth.onAuthStateChange((_e: string, session: any) => { alCambiar(session); });
}

// Lo que hace auth-js en el navegador, cada uno con su candado tomado al avisar.
const disparadores: Record<string, { exp: () => number; correr: (sb: any) => Promise<unknown> }> = {
  "volver a la pestaña (SIGNED_IN)": { exp: () => ahora() + 3600, correr: (sb) => sb.auth._acquireLock(5000, async () => { await sb.auth._recoverAndRefresh(); }) },
  "renovación del token (TOKEN_REFRESHED del tick)": { exp: () => ahora() + 30, correr: (sb) => sb.auth._autoRefreshTokenTick() },
  "consulta con el token vencido (TOKEN_REFRESHED en getSession)": { exp: () => ahora() - 10, correr: (sb) => sb.from("cotizaciones").insert({ x: 1 }) },
};

const TOPE = 1500;
console.log("\n— 1 · El callback que espera a Supabase congela la pestaña; el diferido no —");
for (const [patron, registrar] of [["viejo", registrarViejo], ["nuevo", registrarNuevo]] as const) {
  for (const [nombre, d] of Object.entries(disparadores)) {
    const sb = nuevoCliente();
    await conTope(sb.auth.initializePromise, TOPE); // el cliente global ya inicializó cuando monta la página
    registrar(sb);
    await new Promise((r) => setTimeout(r, 50)); // INITIAL_SESSION (ese no se emite con el candado)
    sb.__almacen.m.set(CLAVE_ALMACEN, JSON.stringify(sesion(d.exp())));
    await conTope(d.correr(sb), TOPE);
    const guardar = await conTope(sb.from("cotizaciones").insert({ numero: 1 }).select(), TOPE);
    if (patron === "viejo") {
      chk(`[viejo] ${nombre}: guardar queda colgado`, guardar === COLGADO,
        guardar === COLGADO ? "" : "ya NO se reproduce: revisar si cambió supabase-js antes de tocar esta prueba");
    } else {
      chk(`[nuevo] ${nombre}: guardar responde`, guardar !== COLGADO && sb.auth.lockAcquired === false, `guardar ${guardar}`);
    }
    sb.auth.stopAutoRefresh?.();
  }
}

// ── 2 · Ningún callback de sesión del ERP repite el patrón ─────────────────────────────────────
const RAIZ = new URL("..", import.meta.url).pathname;
const CARPETAS = ["app", "components", "lib"];
const archivos: string[] = [];
const recorrer = (dir: string) => {
  for (const n of readdirSync(dir)) {
    if (n === "node_modules" || n.startsWith(".")) continue;
    const p = join(dir, n);
    if (statSync(p).isDirectory()) recorrer(p);
    else if (/\.(tsx?|jsx?|mts)$/.test(n)) archivos.push(p);
  }
};
for (const c of CARPETAS) recorrer(join(RAIZ, c));

/** Desde la posición del `(`, el texto hasta su `)` (sin entrar en cadenas). */
const hastaCierre = (s: string, abre: number) => {
  let prof = 0, cad: string | null = null;
  for (let i = abre; i < s.length; i++) {
    const ch = s[i];
    if (cad) { if (ch === "\\") { i++; continue; } if (ch === cad) cad = null; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { cad = ch; continue; }
    if (ch === "(") prof++;
    else if (ch === ")" && --prof === 0) return s.slice(abre + 1, i);
  }
  return s.slice(abre + 1);
};
/** Quita los setTimeout(...) enteros: lo de adentro corre DESPUÉS de soltar el candado. */
const sinDiferidos = (s: string) => {
  let out = s, i: number;
  while ((i = out.indexOf("setTimeout(")) >= 0) {
    const dentro = hastaCierre(out, i + "setTimeout".length);
    out = out.slice(0, i) + out.slice(i + "setTimeout(".length + dentro.length + 1);
  }
  return out;
};

console.log("\n— 2 · Los onAuthStateChange del ERP —");
let vistos = 0;
for (const f of archivos) {
  const s = readFileSync(f, "utf8");
  let desde = 0, i: number;
  while ((i = s.indexOf("onAuthStateChange(", desde)) >= 0) {
    desde = i + 1;
    vistos++;
    const linea = s.slice(0, i).split("\n").length;
    const cb = hastaCierre(s, i + "onAuthStateChange".length);
    const directo = sinDiferidos(cb);
    const problemas = [
      /^\s*async\b/.test(cb) ? "es async" : "",
      /\bawait\b/.test(directo) ? "espera algo (await)" : "",
      /\bsupabase\s*\.|\bcabecerasErp\s*\(|\bfetch\s*\(/.test(directo) ? "llama a Supabase/red sin setTimeout" : "",
    ].filter(Boolean);
    chk(`${relative(RAIZ, f)}:${linea}`, problemas.length === 0, problemas.join(", "));
  }
}
chk("el barrido encontró los callbacks (no se quedó mirando una carpeta vacía)", vistos > 0, `${vistos} encontrado(s)`);

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
