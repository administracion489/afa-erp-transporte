import * as XLSX from "xlsx";

// Tipo de cada fila del Excel unificado
export type FilaUnificada = {
  orden: number;
  parada_nombre: string;
  direccion: string | null;
  lat: number;
  lng: number;
  hora: string | null;
  dni: string;
  nombre_pasajero: string;
  telefono: string | null;
  email: string | null;
  empresa: string | null;
  asiento: string | null;
  notas: string | null;
};

// Resultado del parsing previo a la inserción en BD
export type ParadaAgrupada = {
  orden: number;
  nombre: string;
  direccion: string | null;
  lat: number;
  lng: number;
  hora: string | null;
  pasajeros: {
    dni: string;
    nombre: string;
    telefono: string | null;
    email: string | null;
    empresa: string | null;
    asiento: string | null;
    notas: string | null;
  }[];
};

export type ResultadoUnificado = {
  paradas: ParadaAgrupada[];
  errores: { fila: number; motivo: string; raw: any }[];
  totalPasajeros: number;
};

// ── Helpers ─────────────────────────────────────────────────────────────────

function parsearCoordenada(valor: any): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  let s = String(valor).trim().replace(",", ".");
  if (s.includes(" ")) s = s.split(" ")[0];
  const n = Number(s);
  return isNaN(n) ? null : n;
}

function validarCoords(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function parsearHora(valor: any): string | null {
  if (!valor) return null;
  const s = String(valor).trim();
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const partes = s.split(":");
    return partes[0].padStart(2, "0") + ":" + partes[1].padStart(2, "0");
  }
  const n = Number(s);
  if (!isNaN(n) && n >= 0 && n < 1) {
    const totalMin = Math.round(n * 24 * 60);
    const hh = Math.floor(totalMin / 60).toString().padStart(2, "0");
    const mm = (totalMin % 60).toString().padStart(2, "0");
    return hh + ":" + mm;
  }
  return null;
}

function parsearDni(valor: any): string {
  if (!valor) return "";
  const s = String(valor).trim();
  // DNI peruano: 8 dígitos. CE/Pasaporte: alfanumérico 6-12 chars
  if (/^\d{8}$/.test(s)) return s;
  if (/^[A-Za-z0-9]{6,12}$/.test(s)) return s.toUpperCase();
  return "";
}

function parsearEmail(valor: any): string | null {
  if (!valor) return null;
  const s = String(valor).trim();
  if (!s) return null;
  if (/^[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}$/.test(s)) return s;
  return null;
}

function detectarColumna(headers: string[], opciones: string[]): number {
  const norm = (s: string) => s.toLowerCase().trim()
    .replace(/[áàä]/g, "a").replace(/[éèë]/g, "e")
    .replace(/[íìï]/g, "i").replace(/[óòö]/g, "o")
    .replace(/[úùü]/g, "u").replace(/ñ/g, "n");
  for (const op of opciones) {
    const i = headers.findIndex((h) => norm(h) === norm(op));
    if (i >= 0) return i;
  }
  for (const op of opciones) {
    const i = headers.findIndex((h) => norm(h).includes(norm(op)));
    if (i >= 0) return i;
  }
  return -1;
}

// Identifica una parada de forma única (para detectar duplicados)
function claveParada(p: { nombre: string; lat: number; lng: number }): string {
  // Redondeamos coords a 4 decimales (~10m de precisión) para tolerar pequeñas diferencias
  const lat = p.lat.toFixed(4);
  const lng = p.lng.toFixed(4);
  const nombre = p.nombre.toLowerCase().trim();
  return nombre + "|" + lat + "|" + lng;
}

// ── Parser principal ────────────────────────────────────────────────────────

export async function parsearManifiestoUnificado(file: File): Promise<ResultadoUnificado> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1, defval: "" });

  if (rows.length < 2) {
    return { paradas: [], errores: [{ fila: 0, motivo: "Archivo vacio o sin datos", raw: null }], totalPasajeros: 0 };
  }

  const headers = (rows[0] as any[]).map((h: any) => String(h || ""));

  // Detectar columnas
  const idxOrden = detectarColumna(headers, ["orden", "n"]);
  const idxParada = detectarColumna(headers, ["parada", "nombre parada", "punto", "lugar"]);
  const idxDireccion = detectarColumna(headers, ["direccion", "ubicacion", "address"]);
  const idxLat = detectarColumna(headers, ["lat", "latitud", "latitude"]);
  const idxLng = detectarColumna(headers, ["lng", "lon", "long", "longitud", "longitude"]);
  const idxHora = detectarColumna(headers, ["hora", "hora_estimada", "horario", "time"]);
  const idxDni = detectarColumna(headers, ["dni", "documento", "ci", "cedula", "cedula_identidad"]);
  const idxNombre = detectarColumna(headers, ["nombre pasajero", "pasajero", "nombre completo", "nombre", "apellidos y nombres"]);
  const idxTelefono = detectarColumna(headers, ["telefono", "celular", "movil", "tel"]);
  const idxEmail = detectarColumna(headers, ["email", "correo", "mail"]);
  const idxEmpresa = detectarColumna(headers, ["empresa", "compania", "company", "area"]);
  const idxAsiento = detectarColumna(headers, ["asiento", "seat"]);
  const idxNotas = detectarColumna(headers, ["notas", "obs", "observaciones", "comentarios"]);

  // Validar columnas requeridas
  if (idxParada === -1) {
    return { paradas: [], errores: [{ fila: 0, motivo: "Falta columna 'Parada' o 'Nombre Parada'", raw: headers }], totalPasajeros: 0 };
  }
  if (idxLat === -1 || idxLng === -1) {
    return { paradas: [], errores: [{ fila: 0, motivo: "Faltan columnas 'Lat' y/o 'Lng'", raw: headers }], totalPasajeros: 0 };
  }
  if (idxDni === -1) {
    return { paradas: [], errores: [{ fila: 0, motivo: "Falta columna 'DNI'", raw: headers }], totalPasajeros: 0 };
  }
  if (idxNombre === -1) {
    return { paradas: [], errores: [{ fila: 0, motivo: "Falta columna 'Nombre Pasajero'", raw: headers }], totalPasajeros: 0 };
  }

  const errores: { fila: number; motivo: string; raw: any }[] = [];
  const filasOk: FilaUnificada[] = [];

  // Procesar cada fila
  for (let i = 1; i < rows.length; i++) {
    const fila = i + 1;
    const r = rows[i] as any[];
    if (!r || r.every((c) => c === "" || c === null || c === undefined)) continue;

    // Validar parada
    const parada_nombre = String(r[idxParada] || "").trim();
    if (!parada_nombre) {
      errores.push({ fila, motivo: "Nombre de parada vacio", raw: r });
      continue;
    }

    // Validar coordenadas
    const lat = parsearCoordenada(r[idxLat]);
    const lng = parsearCoordenada(r[idxLng]);
    if (lat === null || lng === null) {
      errores.push({ fila, motivo: "Coordenadas vacias o invalidas", raw: r });
      continue;
    }
    if (!validarCoords(lat, lng)) {
      errores.push({ fila, motivo: "Coordenadas fuera de rango", raw: r });
      continue;
    }

    // Validar pasajero
    const dni = parsearDni(r[idxDni]);
    if (!dni) {
      errores.push({ fila, motivo: "DNI invalido (debe tener 8 digitos o ser alfanumerico 6-12 chars)", raw: r });
      continue;
    }
    const nombre_pasajero = String(r[idxNombre] || "").trim();
    if (!nombre_pasajero) {
      errores.push({ fila, motivo: "Nombre de pasajero vacio", raw: r });
      continue;
    }

    const orden = idxOrden >= 0 ? Number(r[idxOrden]) || 0 : 0;
    const direccion = idxDireccion >= 0 ? String(r[idxDireccion] || "").trim() || null : null;
    const hora = idxHora >= 0 ? parsearHora(r[idxHora]) : null;
    const telefono = idxTelefono >= 0 ? String(r[idxTelefono] || "").trim() || null : null;
    const email = idxEmail >= 0 ? parsearEmail(r[idxEmail]) : null;
    const empresa = idxEmpresa >= 0 ? String(r[idxEmpresa] || "").trim() || null : null;
    const asiento = idxAsiento >= 0 ? String(r[idxAsiento] || "").trim() || null : null;
    const notas = idxNotas >= 0 ? String(r[idxNotas] || "").trim() || null : null;

    filasOk.push({
      orden, parada_nombre, direccion, lat, lng, hora,
      dni, nombre_pasajero, telefono, email, empresa, asiento, notas,
    });
  }

  // Agrupar por parada (usando clave nombre+lat+lng)
  const mapa: Map<string, ParadaAgrupada> = new Map();

  for (const f of filasOk) {
    const k = claveParada({ nombre: f.parada_nombre, lat: f.lat, lng: f.lng });
    let p = mapa.get(k);
    if (!p) {
      p = {
        orden: f.orden || mapa.size + 1,
        nombre: f.parada_nombre,
        direccion: f.direccion,
        lat: f.lat,
        lng: f.lng,
        hora: f.hora,
        pasajeros: [],
      };
      mapa.set(k, p);
    }

    // Detectar pasajero duplicado dentro de la misma parada
    if (p.pasajeros.find((px) => px.dni === f.dni)) {
      continue; // ignora duplicado silenciosamente
    }

    p.pasajeros.push({
      dni: f.dni,
      nombre: f.nombre_pasajero,
      telefono: f.telefono,
      email: f.email,
      empresa: f.empresa,
      asiento: f.asiento,
      notas: f.notas,
    });
  }

  // Convertir a array, ordenar por orden y renumerar
  const paradas = Array.from(mapa.values()).sort((a, b) => a.orden - b.orden);
  paradas.forEach((p, i) => { p.orden = i + 1; });

  const totalPasajeros = paradas.reduce((acc, p) => acc + p.pasajeros.length, 0);

  return { paradas, errores, totalPasajeros };
}

// ── Plantilla Excel ─────────────────────────────────────────────────────────

export function descargarPlantillaUnificada(): void {
  const wb = XLSX.utils.book_new();

  // Hoja 1: Datos
  const datos = [
    ["Orden", "Parada", "Direccion", "Lat", "Lng", "Hora", "DNI", "Nombre Pasajero", "Telefono", "Email", "Empresa", "Asiento", "Notas"],
    [1, "Aeropuerto Jorge Chavez", "Av. Faucett s/n, Callao", -12.0219, -77.1143, "06:00", "12345678", "Juan Perez Garcia", "999111222", "juan@empresa.pe", "ACME SAC", "A1", ""],
    [1, "Aeropuerto Jorge Chavez", "Av. Faucett s/n, Callao", -12.0219, -77.1143, "06:00", "87654321", "Maria Lopez Torres", "999333444", "maria@empresa.pe", "ACME SAC", "A2", "Vegetariana"],
    [2, "Hotel Crown Plaza", "Av. Benavides 600, Miraflores", -12.1234, -77.0334, "07:00", "11223344", "Carlos Ramirez Vega", "999555666", "carlos@empresa.pe", "ACME SAC", "B1", ""],
    [3, "Plaza San Martin", "Jr. de la Union 1050, Lima", -12.0511, -77.0345, "08:30", "55667788", "Ana Diaz Soto", "999777888", "ana@empresa.pe", "ACME SAC", "B2", "Embarque por puerta lateral"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(datos);

  ws["!cols"] = [
    { wch: 6 },   // Orden
    { wch: 25 },  // Parada
    { wch: 30 },  // Direccion
    { wch: 11 },  // Lat
    { wch: 11 },  // Lng
    { wch: 8 },   // Hora
    { wch: 11 },  // DNI
    { wch: 25 },  // Nombre
    { wch: 12 },  // Telefono
    { wch: 22 },  // Email
    { wch: 15 },  // Empresa
    { wch: 8 },   // Asiento
    { wch: 22 },  // Notas
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Manifiesto");

  // Hoja 2: Instrucciones
  const instrucciones = [
    ["MANIFIESTO COMPLETO - Carga unificada paradas + pasajeros"],
    [""],
    ["Este formato permite cargar TODO en un solo Excel:"],
    ["- Las paradas (ruta del servicio)"],
    ["- Los pasajeros"],
    ["- A que parada sube cada uno (asignacion automatica)"],
    [""],
    ["COMO FUNCIONA:"],
    ["Cada fila representa UN PASAJERO."],
    ["Si 5 personas suben en la misma parada, repite los datos de la parada en las 5 filas."],
    ["El sistema detecta automaticamente las paradas unicas y crea el itinerario."],
    [""],
    ["COLUMNAS REQUERIDAS (obligatorias):"],
    ["- Parada: nombre de la parada"],
    ["- Lat: latitud GPS (ejemplo: -12.0219)"],
    ["- Lng: longitud GPS (ejemplo: -77.1143)"],
    ["- DNI: 8 digitos para peruanos, o alfanumerico 6-12 chars para CE/Pasaporte"],
    ["- Nombre Pasajero: nombre completo"],
    [""],
    ["COLUMNAS OPCIONALES:"],
    ["- Orden: orden de la parada en la ruta (si se omite, se asigna por aparicion)"],
    ["- Direccion: direccion completa de la parada"],
    ["- Hora: hora estimada de paso (formato HH:MM)"],
    ["- Telefono: del pasajero"],
    ["- Email: del pasajero"],
    ["- Empresa: a la que pertenece el pasajero"],
    ["- Asiento: numero de asiento asignado"],
    ["- Notas: observaciones del pasajero"],
    [""],
    ["DETECCION INTELIGENTE DE PARADAS:"],
    ["El sistema agrupa filas que tengan el MISMO nombre Y las MISMAS coordenadas."],
    ["Si en una fila escribes 'Aeropuerto JCH' y en otra 'Aeropuerto Jorge Chavez' (con mismas coords),"],
    ["las trata como paradas DIFERENTES (porque los nombres no son iguales)."],
    ["IMPORTANTE: usa exactamente el mismo nombre para la misma parada en todas las filas."],
    [""],
    ["COMO OBTENER COORDENADAS:"],
    ["1. Abre Google Maps en el navegador"],
    ["2. Click derecho sobre la ubicacion exacta"],
    ["3. Aparecera por ejemplo: -12.0219, -77.1143"],
    ["4. El PRIMER numero es Lat, el SEGUNDO es Lng"],
    [""],
    ["IMPORTANTE PARA PERU:"],
    ["- Lat siempre NEGATIVO (-12.xxxx)"],
    ["- Lng siempre NEGATIVO (-77.xxxx)"],
    ["- Usa PUNTO como decimal, NO coma"],
    [""],
    ["EJEMPLO DE TURNO ROTATIVO:"],
    ["Si todos los dias usas las mismas 3 paradas pero rotan los pasajeros,"],
    ["solo necesitas cambiar las columnas DNI y Nombre Pasajero."],
    ["Las paradas se reutilizaran automaticamente."],
  ];
  const wsInst = XLSX.utils.aoa_to_sheet(instrucciones);
  wsInst["!cols"] = [{ wch: 80 }];
  XLSX.utils.book_append_sheet(wb, wsInst, "Instrucciones");

  XLSX.writeFile(wb, "Plantilla_Manifiesto_Completo_AFA.xlsx");
}