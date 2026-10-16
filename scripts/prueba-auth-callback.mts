// Pruebas del callback de sesión de supabase-js: un `onAuthStateChange` que ESPERA una consulta
// a Supabase congela el cliente de la pestaña entera (el «⏳ Guardando…» sin fin de /cotizaciones,
// que solo F5 arreglaba).
//
// 1 · Con supabase-js REAL (fetch y almacén simulados) el patrón viejo se cuelga en los
//     disparadores que avisan CON el candado de sesión tomado, y el nuevo no — también cuando el
//     usuario CAMBIA bajo el candado, que es cuando el nuevo sí consulta. Un tercer patrón, el
//     nuevo SIN el setTimeout, tiene que colgarse ahí: si no, la prueba no distingue nada. Si el
//     viejo deja de colgarse, el escenario dejó de ser el que se rompió (p.ej. una versión nueva
//     de la librería): la prueba falla para que alguien lo mire, no porque el ERP esté mal.
// 2 · Ningún `onAuthStateChange` del ERP es async, devuelve una promesa (flecha concisa), se pasa
//     por nombre, espera algo o llama a Supabase fuera de un setTimeout — ni él ni las funciones
//     del mismo archivo a las que delega.
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
const usuarioDe = (id: string) => ({ id, aud: "authenticated", role: "authenticated", email: `${id}@empresa.pe`, user_metadata: { nombre: "Ana Operadora", rol: "operador" } });
const usuario = usuarioDe("u-1");
const sesion = (exp: number, u = usuario) => ({ access_token: `at-${exp}`, refresh_token: "rt-1", token_type: "bearer", expires_in: exp - ahora(), expires_at: exp, user: u });

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
// El patrón de ahora (alCambiarSesion de la página): síncrono, diferido con setTimeout y solo
// cuando cambia el usuario. `diferir: false` es el mismo SIN el setTimeout — el contraejemplo.
function registrarDedupe(sb: any, diferir: boolean) {
  const cargarNombre = async (session: any) => {
    if (!session?.user) return;
    await sb.from("usuarios").select("nombre").eq("id", session.user.id).maybeSingle();
  };
  let visto: string | null | undefined;
  const alCambiar = (session: any) => {
    const id = session?.user?.id ?? null;
    if (id === visto) return;
    visto = id;
    if (!diferir) return cargarNombre(session);
    setTimeout(() => { void cargarNombre(session); }, 0);
  };
  sb.auth.onAuthStateChange((_e: string, session: any) => alCambiar(session));
}
const registrarNuevo = (sb: any) => registrarDedupe(sb, true);
const registrarSinDiferir = (sb: any) => registrarDedupe(sb, false);

// Lo que hace auth-js en el navegador, cada uno con su candado tomado al avisar. El último es otra
// persona entrando en la misma pestaña: el único caso en que el patrón nuevo SÍ consulta.
const disparadores: Record<string, { exp: () => number; usuario?: ReturnType<typeof usuarioDe>; correr: (sb: any) => Promise<unknown> }> = {
  "volver a la pestaña (SIGNED_IN)": { exp: () => ahora() + 3600, correr: (sb) => sb.auth._acquireLock(5000, async () => { await sb.auth._recoverAndRefresh(); }) },
  "renovación del token (TOKEN_REFRESHED del tick)": { exp: () => ahora() + 30, correr: (sb) => sb.auth._autoRefreshTokenTick() },
  "consulta con el token vencido (TOKEN_REFRESHED en getSession)": { exp: () => ahora() - 10, correr: (sb) => sb.from("cotizaciones").insert({ x: 1 }) },
  "otro usuario al volver a la pestaña (SIGNED_IN de u-2)": { exp: () => ahora() + 3600, usuario: usuarioDe("u-2"), correr: (sb) => sb.auth._acquireLock(5000, async () => { await sb.auth._recoverAndRefresh(); }) },
};

const TOPE = 1500;
const PATRONES = [["viejo", registrarViejo], ["nuevo", registrarNuevo], ["sin setTimeout", registrarSinDiferir]] as const;
console.log("\n— 1 · El callback que espera a Supabase congela la pestaña; el diferido no —");
for (const [patron, registrar] of PATRONES) {
  for (const [nombre, d] of Object.entries(disparadores)) {
    const sb = nuevoCliente();
    await conTope(sb.auth.initializePromise, TOPE); // el cliente global ya inicializó cuando monta la página
    registrar(sb);
    await new Promise((r) => setTimeout(r, 50)); // INITIAL_SESSION (ese no se emite con el candado)
    sb.__almacen.m.set(CLAVE_ALMACEN, JSON.stringify(sesion(d.exp(), d.usuario)));
    await conTope(d.correr(sb), TOPE);
    const guardar = await conTope(sb.from("cotizaciones").insert({ numero: 1 }).select(), TOPE);
    const cambia = !!d.usuario;
    if (patron === "viejo") {
      chk(`[viejo] ${nombre}: guardar queda colgado`, guardar === COLGADO,
        guardar === COLGADO ? "" : "ya NO se reproduce: revisar si cambió supabase-js antes de tocar esta prueba");
    } else if (patron === "nuevo") {
      chk(`[nuevo] ${nombre}: guardar responde`, guardar !== COLGADO && sb.auth.lockAcquired === false, `guardar ${guardar}`);
    } else if (cambia) {
      // Sin este contraejemplo, «el nuevo responde» podría deberse solo al dedupe.
      chk(`[sin setTimeout] ${nombre}: guardar queda colgado (la prueba distingue el setTimeout)`, guardar === COLGADO, `guardar ${guardar}`);
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

/** Desde el `(` o `{` en `abre`, el texto hasta su cierre (sin entrar en cadenas ni comentarios). */
const hastaCierre = (s: string, abre: number) => {
  const a = s[abre], c = a === "(" ? ")" : a === "{" ? "}" : "]";
  let prof = 0, cad: string | null = null;
  for (let i = abre; i < s.length; i++) {
    const ch = s[i];
    if (cad) { if (ch === "\\") { i++; continue; } if (ch === cad) cad = null; continue; }
    if (ch === "/" && s[i + 1] === "/") { const f = s.indexOf("\n", i); i = f < 0 ? s.length : f; continue; }
    if (ch === "/" && s[i + 1] === "*") { const f = s.indexOf("*/", i + 2); i = f < 0 ? s.length : f + 1; continue; }
    if (ch === '"' || ch === "'" || ch === "`") { cad = ch; continue; }
    if (ch === a) prof++;
    else if (ch === c && --prof === 0) return s.slice(abre + 1, i);
  }
  return s.slice(abre + 1);
};
/** Quita los setTimeout(...) enteros: lo de adentro corre DESPUÉS de soltar el candado. */
const sinDiferidos = (s: string) => {
  let out = s, m: RegExpExecArray | null;
  while ((m = /\bsetTimeout\s*\(/.exec(out))) {
    const abre = m.index + m[0].length - 1;
    const dentro = hastaCierre(out, abre);
    out = out.slice(0, m.index) + out.slice(abre + dentro.length + 2);
  }
  return out;
};
const sinComentarios = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, " ").replace(/(^|[^:"'`])\/\/[^\n]*/g, "$1");

type Juicio = { problemas: string[] };
/**
 * Juzga una función (texto de su definición: `(a,b)=>{…}`, `async x=>…`, `function(…){…}`).
 * La regla: síncrona, con cuerpo entre llaves (una flecha concisa DEVUELVE la promesa y auth-js
 * la espera), sin `await`, sin `return` de una llamada y sin tocar Supabase/red fuera de un
 * setTimeout. Lo que llame de este mismo archivo se juzga igual (hasta `prof` niveles).
 */
function juzgarFuncion(texto: string, archivo: string, prof: number, vistos: Set<string>): Juicio {
  const t = texto.trim();
  const problemas: string[] = [];
  if (/^async\b/.test(t)) problemas.push("es async");
  const flecha = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>\s*/.exec(t);
  const funcion = /^(?:async\s*)?function\b[^(]*\([^)]*\)\s*(?::[^{]*)?/.exec(t);
  let cuerpo: string;
  if (flecha) {
    const resto = t.slice(flecha[0].length);
    if (!resto.startsWith("{")) { problemas.push("flecha concisa: devuelve lo que llama y auth-js lo espera"); cuerpo = resto; }
    else cuerpo = hastaCierre(resto, 0);
  } else if (funcion) {
    const resto = t.slice(funcion[0].length);
    cuerpo = resto.startsWith("{") ? hastaCierre(resto, 0) : resto;
  } else {
    return { problemas: ["no es una función escrita en el lugar (se pasa por nombre o expresión): no se puede juzgar"] };
  }
  const directo = sinComentarios(sinDiferidos(cuerpo));
  if (/\bawait\b/.test(directo)) problemas.push("espera algo (await)");
  if (/\breturn\s+[^;}\n]*\(/.test(directo)) problemas.push("devuelve el resultado de una llamada");
  if (/\bsupabase\s*\.|\bcabecerasErp\s*\(|\bfetch\s*\(/.test(directo)) problemas.push("llama a Supabase/red sin setTimeout");
  // Delegados del mismo archivo: `alCambiarSesion(session)` se juzga por su definición.
  if (prof > 0) {
    const IGNORAR = new Set(["if", "for", "while", "switch", "catch", "return", "typeof", "void", "String", "Number", "Boolean", "Array", "Object", "JSON", "Math", "Date", "Promise", "console", "alert"]);
    for (const m of directo.matchAll(/(?<![.\w$])([A-Za-z_$][\w$]*)\s*\(/g)) {
      const nombre = m[1];
      if (IGNORAR.has(nombre) || /^set[A-Z]/.test(nombre) || vistos.has(nombre)) continue;
      const def = definicionEn(archivo, nombre);
      if (!def) continue;
      vistos.add(nombre);
      const sub = juzgarFuncion(def, archivo, prof - 1, vistos);
      problemas.push(...sub.problemas.map((p) => `${nombre}: ${p}`));
    }
  }
  return { problemas };
}
/** El texto de `const NOMBRE = (…) => …` o `function NOMBRE(…) {…}` en el archivo, si existe. */
function definicionEn(archivo: string, nombre: string): string | null {
  const flecha = new RegExp(`(?:const|let|var)\\s+${nombre}\\s*(?::[^=]+)?=\\s*`).exec(archivo);
  if (flecha) {
    const ini = flecha.index + flecha[0].length;
    const resto = archivo.slice(ini);
    const cab = /^(?:async\s*)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*(?::[^=]*?)?=>\s*/.exec(resto);
    if (!cab) return null;
    const tras = resto.slice(cab[0].length);
    if (tras.startsWith("{")) return cab[0] + "{" + hastaCierre(tras, 0) + "}";
    return cab[0] + tras.slice(0, tras.search(/[;\n]/) < 0 ? tras.length : tras.search(/[;\n]/));
  }
  const fn = new RegExp(`(?:async\\s+)?function\\s+${nombre}\\s*\\(`).exec(archivo);
  if (fn) {
    const llave = archivo.indexOf("{", fn.index);
    return archivo.slice(fn.index, llave) + "{" + hastaCierre(archivo, llave) + "}";
  }
  return null;
}
/** Los callbacks de `onAuthStateChange` de un archivo, con su línea. */
function callbacksDe(archivo: string): { linea: number; texto: string }[] {
  const out: { linea: number; texto: string }[] = [];
  for (const m of archivo.matchAll(/\bonAuthStateChange\s*\(/g)) {
    const abre = m.index! + m[0].length - 1;
    out.push({ linea: archivo.slice(0, m.index).split("\n").length, texto: hastaCierre(archivo, abre) });
  }
  return out;
}
const juzgarArchivo = (archivo: string) => callbacksDe(archivo).map((c) => ({ ...c, ...juzgarFuncion(c.texto, archivo, 3, new Set()) }));

console.log("\n— 2a · El barrido reconoce el patrón malo en todas sus formas —");
const MALOS: Record<string, string> = {
  "async + await (el de origin/main)": `x.onAuthStateChange(async(_e,s)=>{await cargarNombre(s);});`,
  "flecha concisa que devuelve la promesa": `x.onAuthStateChange((_e,s)=>cargarNombre(s));`,
  "callback por nombre": `const alCambio=async(e,s)=>{await cargarNombre(s)}; x.onAuthStateChange(alCambio);`,
  "espacio y salto antes del paréntesis": `x.onAuthStateChange \n ((_e,s)=>{ supabase.from("u").select("*"); });`,
  "delegado que espera": `const alCambiar=async(s)=>{await supabase.from("u").select("*");}; x.onAuthStateChange((_e,s)=>{alCambiar(s);});`,
  "delegado sin setTimeout que devuelve la promesa": `const cargarNombre=async(s)=>{await supabase.from("u").select("*");}; const alCambiar=(s)=>{ if(!s)return; return cargarNombre(s); }; x.onAuthStateChange((_e,s)=>{alCambiar(s);});`,
  "return de la llamada en el callback": `x.onAuthStateChange((_e,s)=>{ return cargarNombre(s); });`,
};
for (const [nombre, codigo] of Object.entries(MALOS)) {
  const j = juzgarArchivo(codigo);
  chk(`detecta: ${nombre}`, j.length === 1 && j[0].problemas.length > 0, j.map((x) => x.problemas.join(", ")).join(" | ") || "no encontró el callback");
}
const BUENOS: Record<string, string> = {
  "síncrono con setTimeout (el de la página)": `const cargarNombre=async(s)=>{await supabase.from("u").select("*");}; const alCambiar=(s)=>{ if(!s)return; setTimeout(()=>{setReprNombre("");void cargarNombre(s);},0); }; x.onAuthStateChange((_e,s)=>{alCambiar(s);});`,
  "solo estado de React": `x.onAuthStateChange((_e,s)=>{ setUsuario(s?.user ?? null); });`,
  "comentario con apóstrofo dentro": `x.onAuthStateChange((_e,s)=>{ // it's fine\n setUsuario(s); });`,
};
for (const [nombre, codigo] of Object.entries(BUENOS)) {
  const j = juzgarArchivo(codigo);
  chk(`acepta: ${nombre}`, j.length === 1 && j[0].problemas.length === 0, j.map((x) => x.problemas.join(", ")).join(" | "));
}

console.log("\n— 2b · Los onAuthStateChange del ERP —");
let vistos = 0;
for (const f of archivos) {
  const s = readFileSync(f, "utf8");
  for (const c of juzgarArchivo(s)) {
    vistos++;
    chk(`${relative(RAIZ, f)}:${c.linea}`, c.problemas.length === 0, c.problemas.join(", "));
  }
}
chk("el barrido encontró los callbacks (no se quedó mirando una carpeta vacía)", vistos > 0, `${vistos} encontrado(s)`);

console.log(fallos ? `\n${fallos} prueba(s) fallaron` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
