// lib/portal-usuarios-csv.ts
// =============================================================================
// AFA Transportes · Carga masiva de usuarios del PORTAL CLIENTE vía Excel/CSV.
//
// A diferencia de lib/manifiesto-csv.ts (que importa PASAJEROS a la nómina),
// esto crea los USUARIOS que inician sesión en el portal (portal_usuarios):
// nombre + documento (login) + rol (admin/visor) + módulos permitidos + clave.
//
// - Parseo tolerante: detecta cabeceras por variantes/tildes, valida por tipo
//   de documento, deduplica dentro del archivo y reporta errores por fila.
// - La contraseña es OPCIONAL en el archivo: si viene vacía, la API la genera.
// - Los módulos se escriben con sus nombres visibles (o "Todos"); el catálogo
//   de módulos se pasa desde la página para no duplicar la fuente de verdad.
//   El parseo usa xlsx (estático); la plantilla/credenciales usan xlsx-js-style
//   (dinámico) para llevar estilos sin engordar el bundle.
// =============================================================================

import * as XLSX from "xlsx";

export type ModuloCatalogo = { id: string; label: string };

export type PortalUsuarioImportado = {
  nombre: string;
  dni: string;
  tipo_doc: "DNI" | "CE" | "Celular";
  email: string | null;
  cargo: string | null;
  rol: "admin" | "visor";
  password: string | null;              // null = la API genera una automáticamente
  modulos_permitidos: string[] | null;  // null = todos (convención del portal)
  modulos_desconocidos: string[];        // etiquetas que no matchearon (solo aviso)
};

export type ResultadoImportPortal = {
  ok: PortalUsuarioImportado[];
  errores: Array<{ fila: number; motivo: string }>;
  total: number;
};

// Aliases de cabecera tolerantes a tildes y a planillas hechas a mano.
const COLUMNAS = {
  nombre:   ["nombre", "nombres", "nombre completo", "usuario", "name", "full name", "apellidos y nombres", "nombres y apellidos"],
  tipo:     ["tipo", "tipo doc", "tipo documento", "tipo de documento", "tipo de identificacion", "tipo id"],
  doc:      ["documento", "dni", "doc", "identificacion", "identificación", "id", "ce", "cedula", "cédula", "celular", "n documento", "nro documento", "numero documento"],
  email:    ["email", "correo", "e-mail", "mail", "correo electronico", "correo electrónico"],
  cargo:    ["cargo", "area", "área", "puesto", "rol cargo", "cargo / area", "cargo/area", "cargo o area"],
  rol:      ["rol", "perfil", "permiso", "acceso", "tipo de usuario", "tipo usuario", "role"],
  password: ["contrasena", "contraseña", "password", "clave", "pass", "pin", "clave de acceso", "codigo", "código", "codigo de acceso"],
  modulos:  ["modulos", "módulos", "permisos", "accesos", "secciones", "modulos permitidos", "módulos permitidos"],
} as const;

function normaliza(s: unknown): string {
  return String(s ?? "")
    .toLowerCase()
    .trim()
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, ""); // quita tildes
}

// Normaliza cabeceras para el matching: además de tildes, colapsa cualquier
// signo (°, /, -, .) a espacios → "N° Documento" ≈ "n documento". Así el match
// puede hacerse por PALABRA COMPLETA y no por substring (evita que "id" matchee
// dentro de "apellidos").
function normHeader(s: unknown): string {
  return normaliza(s).replace(/[^a-z0-9]+/g, " ").trim();
}

// Puntúa cuánto matchea una cabecera con un alias: exacto ≫ palabra-completa ≫ 0.
// La longitud del alias desempata (prefiere "tipo de usuario"→rol sobre "tipo"→tipo).
function scoreMatch(nh: string, alias: string): number {
  if (!alias) return 0;
  if (nh === alias) return 1000 + alias.length;
  if ((" " + nh + " ").includes(" " + alias + " ")) return 100 + alias.length;
  return 0;
}

// Asigna cada cabecera a UN solo campo (el de mayor puntaje) y cada campo a UNA
// sola cabecera. Resolver por puntaje descendente evita robos y dobles conteos.
function mapearColumnas(headers: string[]): Record<keyof typeof COLUMNAS, number> {
  const nhs = headers.map(normHeader);
  const campos = Object.keys(COLUMNAS) as Array<keyof typeof COLUMNAS>;

  // Mejor campo para cada columna del archivo
  const candidatos: Array<{ col: number; campo: keyof typeof COLUMNAS; score: number }> = [];
  nhs.forEach((nh, col) => {
    let best: { campo: keyof typeof COLUMNAS; score: number } | null = null;
    for (const campo of campos) {
      for (const alias of COLUMNAS[campo] as readonly string[]) {
        const s = scoreMatch(nh, normHeader(alias));
        if (s > 0 && (!best || s > best.score)) best = { campo, score: s };
      }
    }
    if (best) candidatos.push({ col, campo: best.campo, score: best.score });
  });

  const out = {} as Record<keyof typeof COLUMNAS, number>;
  campos.forEach((k) => { out[k] = -1; });
  const colsUsadas = new Set<number>();
  candidatos.sort((a, b) => b.score - a.score);
  for (const c of candidatos) {
    if (out[c.campo] === -1 && !colsUsadas.has(c.col)) { out[c.campo] = c.col; colsUsadas.add(c.col); }
  }
  return out;
}

// El "Tipo" solo etiqueta el documento en el correo; si no viene, se autodetecta.
function detectarTipo(doc: string): "DNI" | "CE" | "Celular" {
  if (/^\d{8}$/.test(doc)) return "DNI";
  if (/^\d{7,15}$/.test(doc)) return "Celular";
  return "CE";
}

function normalizarTipoExplicito(raw: string): "DNI" | "CE" | "Celular" | null {
  const t = normaliza(raw);
  if (!t) return null;
  if (t === "dni") return "DNI";
  if (["celular", "cel", "telefono", "movil", "whatsapp", "phone"].some((x) => t.includes(x))) return "Celular";
  if (["ce", "cedula", "carnet", "carne", "extranjeria", "pasaporte", "passport"].some((x) => t.includes(x))) return "CE";
  return null;
}

// Mismas reglas que el formulario manual (guardarPU en clientes/page.tsx).
function documentoValido(doc: string, tipo: "DNI" | "CE" | "Celular"): string | null {
  if (tipo === "DNI" && !/^\d{8}$/.test(doc)) return "El DNI debe tener exactamente 8 dígitos";
  if (tipo === "Celular" && !/^\d{7,15}$/.test(doc)) return "El celular debe tener entre 7 y 15 dígitos";
  if (tipo === "CE" && !/^[A-Za-z0-9]{6,}$/.test(doc)) return "La Cédula / CE debe tener al menos 6 caracteres alfanuméricos";
  return null;
}

function normalizarRol(raw: string): "admin" | "visor" {
  const r = normaliza(raw);
  if (["admin", "administrador", "administrator", "gestor", "gestion", "gerente", "editor"].some((x) => r.includes(x))) return "admin";
  return "visor"; // por defecto, solo lectura
}

// Convierte "En vivo · GPS, Historial" | "todos" | "activos;historial" → ids del catálogo.
function parsearModulos(
  raw: string,
  rol: "admin" | "visor",
  catalogo: ModuloCatalogo[],
): { modulos_permitidos: string[] | null; desconocidos: string[] } {
  const txt = normaliza(raw);
  const idsTodos = catalogo.map((m) => m.id);

  // Vacío → default sensato (todo menos Facturación, igual que el formulario).
  if (!txt) {
    const def = idsTodos.filter((id) => id !== "facturacion");
    return { modulos_permitidos: rol === "admin" ? null : def, desconocidos: [] };
  }
  if (["todos", "todo", "all", "completo", "full", "*"].includes(txt)) {
    return { modulos_permitidos: rol === "admin" ? null : idsTodos, desconocidos: [] };
  }

  const tokens = raw.split(/[,;/|]+/).map((t) => normaliza(t)).filter(Boolean);
  const ids: string[] = [];
  const desconocidos: string[] = [];
  for (const tok of tokens) {
    const m = catalogo.find((c) => {
      const nid = normaliza(c.id);
      const nlbl = normaliza(c.label);
      return nid === tok || nlbl === tok || nlbl.includes(tok) || tok.includes(nid);
    });
    if (m) { if (!ids.includes(m.id)) ids.push(m.id); }
    else desconocidos.push(tok);
  }
  if (ids.length === 0) {
    // No matcheó nada útil → default, pero conserva el aviso.
    const def = idsTodos.filter((id) => id !== "facturacion");
    return { modulos_permitidos: rol === "admin" ? null : def, desconocidos };
  }
  // admin + todos los módulos → null (convención del portal)
  if (rol === "admin" && ids.length === idsTodos.length) return { modulos_permitidos: null, desconocidos };
  return { modulos_permitidos: ids, desconocidos };
}

export async function parsearPortalUsuarios(
  file: File,
  catalogo: ModuloCatalogo[],
): Promise<ResultadoImportPortal> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) {
    return { ok: [], errores: [{ fila: 0, motivo: "Archivo vacío o sin hoja válida" }], total: 0 };
  }

  const rows: unknown[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "", blankrows: false });
  if (rows.length < 2) {
    return { ok: [], errores: [{ fila: 0, motivo: "El archivo no tiene filas de datos" }], total: 0 };
  }

  const headers = (rows[0] as unknown[]).map((h) => String(h ?? ""));
  const idx = mapearColumnas(headers);

  if (idx.nombre === -1 || idx.doc === -1) {
    return {
      ok: [],
      errores: [{
        fila: 1,
        motivo: `Faltan columnas obligatorias. Detectadas: [${headers.join(", ")}]. Se requieren al menos: Nombre y Documento`,
      }],
      total: 0,
    };
  }

  const ok: PortalUsuarioImportado[] = [];
  const errores: ResultadoImportPortal["errores"] = [];
  const docsVistos = new Set<string>();

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i] as unknown[];
    if (!r || r.every((c) => String(c ?? "").trim() === "")) continue;
    const fila = i + 1; // número tal como lo ve el usuario en Excel

    const get = (k: keyof typeof COLUMNAS) => (idx[k] >= 0 ? String(r[idx[k]] ?? "").trim() : "");

    const nombre = get("nombre");
    // Documento: limpia espacios; CE conserva alfanumérico, resto solo dígitos… pero
    // como el tipo se resuelve abajo, aquí solo quitamos espacios/guiones/puntos.
    const docRaw = get("doc").replace(/[\s.\-]/g, "");

    if (!nombre) { errores.push({ fila, motivo: "Falta el nombre" }); continue; }
    if (!docRaw) { errores.push({ fila, motivo: "Falta el documento (login)" }); continue; }

    const tipo = normalizarTipoExplicito(get("tipo")) ?? detectarTipo(docRaw);
    const errDoc = documentoValido(docRaw, tipo);
    if (errDoc) { errores.push({ fila, motivo: `${errDoc} (documento: "${docRaw}")` }); continue; }

    if (docsVistos.has(docRaw)) { errores.push({ fila, motivo: `Documento duplicado en el archivo: ${docRaw}` }); continue; }
    docsVistos.add(docRaw);

    const rol = normalizarRol(get("rol"));
    const { modulos_permitidos, desconocidos } = parsearModulos(get("modulos"), rol, catalogo);
    const email = get("email");
    const pass = get("password");

    ok.push({
      nombre,
      dni: docRaw,
      tipo_doc: tipo,
      email: email || null,
      cargo: get("cargo") || null,
      rol,
      password: pass || null,
      modulos_permitidos,
      modulos_desconocidos: desconocidos,
    });
  }

  return { ok, errores, total: rows.length - 1 };
}

// ─────────────────────────────────────────────────────────────────────────────
// Plantilla descargable (estilizada) — Hoja "Usuarios" + Hoja "Instrucciones".
// ─────────────────────────────────────────────────────────────────────────────
export async function descargarPlantillaPortalUsuarios(catalogo: ModuloCatalogo[]): Promise<void> {
  const mod: any = await import("xlsx-js-style");
  const XLSXS = mod.default ?? mod;
  const A = (hex: string) => "FF" + hex.replace("#", "").toUpperCase();

  const wb = XLSXS.utils.book_new();

  const cabecera = ["Nombre", "Tipo", "Documento", "Correo", "Cargo", "Rol", "Contraseña", "Módulos"];
  const ejemplos = [
    ["Juan Pérez Quispe", "DNI", "12345678", "juan@empresa.com", "Coordinador de transporte", "Admin", "", "Todos"],
    ["María García Rodríguez", "DNI", "87654321", "maria@empresa.com", "Bodega Callao", "Visor", "", "En vivo · GPS, Historial de servicios"],
    ["Carlos Ruiz Ttito", "CE", "001234567", "", "Supervisor", "Visor", "", "Reportes de embarque"],
  ];

  const ws = XLSXS.utils.aoa_to_sheet([cabecera, ...ejemplos]);
  ws["!cols"] = [
    { wch: 28 }, { wch: 9 }, { wch: 13 }, { wch: 26 }, { wch: 26 }, { wch: 9 }, { wch: 14 }, { wch: 40 },
  ];
  // Estilo de la cabecera (navy AFA, texto blanco, centrado)
  const headStyle = {
    font: { bold: true, color: { rgb: "FFFFFFFF" }, sz: 11 },
    fill: { fgColor: { rgb: A("#0b315f") } },
    alignment: { horizontal: "center", vertical: "center" },
  };
  for (let c = 0; c < cabecera.length; c++) {
    const ref = XLSXS.utils.encode_cell({ r: 0, c });
    if (ws[ref]) ws[ref].s = headStyle;
  }
  // Ejemplos en gris tenue para que se note que son de muestra
  for (let rIdx = 1; rIdx <= ejemplos.length; rIdx++) {
    for (let c = 0; c < cabecera.length; c++) {
      const ref = XLSXS.utils.encode_cell({ r: rIdx, c });
      if (ws[ref]) ws[ref].s = { font: { color: { rgb: A("#94a3b8") }, italic: true } };
    }
  }
  XLSXS.utils.book_append_sheet(wb, ws, "Usuarios");

  // Hoja de instrucciones
  const modulosLista = catalogo.map((m) => `   • ${m.label}`);
  const inst: string[][] = [
    ["INSTRUCCIONES — Carga de usuarios del Portal · AFA Transportes"],
    [""],
    ["Cada fila crea (o actualiza) un usuario que inicia sesión en el portal del cliente."],
    ["El sistema hace COINCIDIR por Documento: si el documento ya existe para este cliente,"],
    ["se ACTUALIZAN sus datos; si no existe, se CREA el acceso."],
    [""],
    ["COLUMNAS OBLIGATORIAS:"],
    ["   • Nombre — nombre y apellidos del usuario"],
    ["   • Documento — es el usuario para iniciar sesión (DNI, Cédula/CE o celular)"],
    [""],
    ["COLUMNAS OPCIONALES:"],
    ["   • Tipo — DNI, CE o Celular. Si se deja vacío se detecta automáticamente."],
    ["        DNI = 8 dígitos · Celular = 7 a 15 dígitos · CE = 6+ alfanumérico"],
    ["   • Correo — si lo pones, se le pueden enviar las credenciales por email"],
    ["   • Cargo — área o puesto (solo referencia)"],
    ["   • Rol — 'Admin' (gestión completa) o 'Visor' (solo lectura). Por defecto: Visor"],
    ["   • Contraseña — si la dejas VACÍA, el sistema genera una automáticamente"],
    ["        y te la muestra al terminar para que puedas compartirla."],
    ["   • Módulos — separa con comas. Usa 'Todos' para todo el portal."],
    [""],
    ["MÓDULOS DISPONIBLES (copia los nombres tal cual):"],
    ...modulosLista.map((m) => [m]),
    [""],
    ["NOTAS:"],
    ["   • No repitas el mismo documento dos veces en el archivo."],
    ["   • Las filas de ejemplo (en gris) puedes borrarlas o sobrescribirlas."],
    ["   • Acepta .xlsx, .xls y .csv."],
  ];
  const wsInst = XLSXS.utils.aoa_to_sheet(inst);
  wsInst["!cols"] = [{ wch: 78 }];
  if (wsInst["A1"]) wsInst["A1"].s = { font: { bold: true, sz: 13, color: { rgb: A("#0b315f") } } };
  XLSXS.utils.book_append_sheet(wb, wsInst, "Instrucciones");

  XLSXS.writeFile(wb, "plantilla_usuarios_portal_afa.xlsx");
}

// ─────────────────────────────────────────────────────────────────────────────
// Exporta las credenciales resultantes (útil cuando la clave fue autogenerada).
// ─────────────────────────────────────────────────────────────────────────────
export type CredencialExport = {
  nombre: string;
  dni: string;
  email: string | null;
  password: string;        // "" o "(sin cambio)" cuando no aplica
  rol: "admin" | "visor";
  estado: string;          // Nuevo / Actualizado
};

export async function descargarCredencialesPortal(
  nombreCliente: string,
  filas: CredencialExport[],
): Promise<void> {
  const mod: any = await import("xlsx-js-style");
  const XLSXS = mod.default ?? mod;
  const A = (hex: string) => "FF" + hex.replace("#", "").toUpperCase();

  const cabecera = ["Nombre", "Documento", "Correo", "Contraseña", "Rol", "Estado"];
  const aoa: any[][] = [
    [`AFA Transportes · Credenciales de acceso — ${nombreCliente}`, "", "", "", "", ""],
    cabecera,
    ...filas.map((f) => [
      f.nombre, f.dni, f.email || "", f.password, f.rol === "admin" ? "Admin" : "Visor", f.estado,
    ]),
  ];
  const ws = XLSXS.utils.aoa_to_sheet(aoa);
  ws["!cols"] = [{ wch: 28 }, { wch: 14 }, { wch: 26 }, { wch: 16 }, { wch: 9 }, { wch: 13 }];
  ws["!merges"] = [{ s: { r: 0, c: 0 }, e: { r: 0, c: 5 } }];

  // Título
  if (ws["A1"]) ws["A1"].s = { font: { bold: true, sz: 13, color: { rgb: A("#0b315f") } } };
  // Cabecera navy
  for (let c = 0; c < cabecera.length; c++) {
    const ref = XLSXS.utils.encode_cell({ r: 1, c });
    if (ws[ref]) ws[ref].s = {
      font: { bold: true, color: { rgb: "FFFFFFFF" } },
      fill: { fgColor: { rgb: A("#0b315f") } },
      alignment: { horizontal: "center" },
    };
  }
  // Contraseña en monoespaciada resaltada
  for (let rIdx = 0; rIdx < filas.length; rIdx++) {
    const ref = XLSXS.utils.encode_cell({ r: 2 + rIdx, c: 3 });
    if (ws[ref]) ws[ref].s = { font: { bold: true, name: "Consolas", color: { rgb: A("#0b315f") } } };
  }

  const wb = XLSXS.utils.book_new();
  XLSXS.utils.book_append_sheet(wb, ws, "Credenciales");
  const safe = nombreCliente.replace(/[^a-zA-Z0-9]+/g, "_").slice(0, 40) || "cliente";
  XLSXS.writeFile(wb, `credenciales_portal_${safe}.xlsx`);
}
