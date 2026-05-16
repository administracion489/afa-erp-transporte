import * as XLSX from "xlsx";

export type ParadaImportada = {
  orden: number;
  nombre: string;
  direccion: string | null;
  lat: number;
  lng: number;
  hora_estimada: string | null;
  notas: string | null;
};

export type ResultadoParadas = {
  ok: ParadaImportada[];
  errores: { fila: number; motivo: string; raw: any }[];
};

// Parsea coordenada en cualquier formato comun
// "-12.0219", "-12,0219", "-12.0219, -77.1143", " -12.0219 "
function parsearCoordenada(valor: any): number | null {
  if (valor === null || valor === undefined || valor === "") return null;
  let s = String(valor).trim().replace(",", ".");
  // Si vienen las dos juntas, agarra la primera
  if (s.includes(" ")) s = s.split(" ")[0];
  const n = Number(s);
  return isNaN(n) ? null : n;
}

// Valida que lat este entre -90 y 90, lng entre -180 y 180
function validarCoords(lat: number, lng: number): boolean {
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

function parsearHora(valor: any): string | null {
  if (!valor) return null;
  const s = String(valor).trim();
  // Aceptar HH:MM o HH:MM:SS
  if (/^\d{1,2}:\d{2}(:\d{2})?$/.test(s)) {
    const partes = s.split(":");
    const hh = partes[0].padStart(2, "0");
    const mm = partes[1].padStart(2, "0");
    return hh + ":" + mm;
  }
  // Excel a veces devuelve fracciones de dia (0.25 = 06:00)
  const n = Number(s);
  if (!isNaN(n) && n >= 0 && n < 1) {
    const totalMin = Math.round(n * 24 * 60);
    const hh = Math.floor(totalMin / 60).toString().padStart(2, "0");
    const mm = (totalMin % 60).toString().padStart(2, "0");
    return hh + ":" + mm;
  }
  return null;
}

// Detecta y normaliza nombres de columnas (acepta variantes)
function detectarColumna(headers: string[], opciones: string[]): number {
  const norm = (s: string) => s.toLowerCase().trim().replace(/[áéíóú]/g, (c) => "aeiou"["áéíóú".indexOf(c)]);
  for (const op of opciones) {
    const i = headers.findIndex((h) => norm(h) === norm(op));
    if (i >= 0) return i;
  }
  // Busqueda parcial
  for (const op of opciones) {
    const i = headers.findIndex((h) => norm(h).includes(norm(op)));
    if (i >= 0) return i;
  }
  return -1;
}

export async function parsearParadasArchivo(file: File): Promise<ResultadoParadas> {
  const buf = await file.arrayBuffer();
  const wb = XLSX.read(buf, { type: "array", cellDates: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json<any>(sheet, { header: 1, defval: "" });

  if (rows.length < 2) {
    return { ok: [], errores: [{ fila: 0, motivo: "Archivo vacio o sin filas de datos", raw: null }] };
  }

  const headers = (rows[0] as any[]).map((h: any) => String(h || ""));
  const idxOrden = detectarColumna(headers, ["orden", "n", "numero", "num"]);
  const idxNombre = detectarColumna(headers, ["nombre", "parada", "punto", "lugar"]);
  const idxDireccion = detectarColumna(headers, ["direccion", "ubicacion", "address"]);
  const idxLat = detectarColumna(headers, ["lat", "latitud", "latitude"]);
  const idxLng = detectarColumna(headers, ["lng", "lon", "long", "longitud", "longitude"]);
  const idxHora = detectarColumna(headers, ["hora", "hora_estimada", "horario", "time"]);
  const idxNotas = detectarColumna(headers, ["notas", "obs", "observaciones", "comentarios"]);

  if (idxNombre === -1) {
    return { ok: [], errores: [{ fila: 0, motivo: "No se encontro columna 'Nombre Parada'", raw: headers }] };
  }
  if (idxLat === -1 || idxLng === -1) {
    return { ok: [], errores: [{ fila: 0, motivo: "Faltan columnas 'Lat' y/o 'Lng'", raw: headers }] };
  }

  const ok: ParadaImportada[] = [];
  const errores: { fila: number; motivo: string; raw: any }[] = [];

  for (let i = 1; i < rows.length; i++) {
    const fila = i + 1; // numero de fila como lo ve el usuario en Excel
    const r = rows[i] as any[];
    if (!r || r.every((c) => c === "" || c === null || c === undefined)) continue;

    const nombre = String(r[idxNombre] || "").trim();
    if (!nombre) {
      errores.push({ fila, motivo: "Nombre vacio", raw: r });
      continue;
    }

    const lat = parsearCoordenada(r[idxLat]);
    const lng = parsearCoordenada(r[idxLng]);
    if (lat === null || lng === null) {
      errores.push({ fila, motivo: "Coordenadas vacias o invalidas", raw: r });
      continue;
    }
    if (!validarCoords(lat, lng)) {
      errores.push({ fila, motivo: "Coordenadas fuera de rango (lat: " + lat + ", lng: " + lng + ")", raw: r });
      continue;
    }

    const orden = idxOrden >= 0 ? Number(r[idxOrden]) || ok.length + 1 : ok.length + 1;
    const direccion = idxDireccion >= 0 ? String(r[idxDireccion] || "").trim() || null : null;
    const hora = idxHora >= 0 ? parsearHora(r[idxHora]) : null;
    const notas = idxNotas >= 0 ? String(r[idxNotas] || "").trim() || null : null;

    ok.push({ orden, nombre, direccion, lat, lng, hora_estimada: hora, notas });
  }

  // Re-ordenar y normalizar el orden
  ok.sort((a, b) => a.orden - b.orden);
  ok.forEach((p, i) => { p.orden = i + 1; });

  return { ok, errores };
}

export function descargarPlantillaParadas(): void {
  const wb = XLSX.utils.book_new();
  const datos = [
    ["Orden", "Nombre Parada", "Direccion", "Lat", "Lng", "Hora", "Notas"],
    [1, "Aeropuerto Jorge Chavez", "Av. Faucett s/n, Callao", -12.0219, -77.1143, "06:00", "Recojo en puerta 5"],
    [2, "Hotel Crown Plaza", "Av. Benavides 600, Miraflores", -12.1234, -77.0334, "07:00", ""],
    [3, "Plaza San Martin", "Jr. de la Union 1050, Lima", -12.0511, -77.0345, "08:30", "Punto de espera 5 min"],
  ];
  const ws = XLSX.utils.aoa_to_sheet(datos);

  // Ajustar anchos
  ws["!cols"] = [
    { wch: 8 },   // Orden
    { wch: 28 },  // Nombre
    { wch: 35 },  // Direccion
    { wch: 12 },  // Lat
    { wch: 12 },  // Lng
    { wch: 8 },   // Hora
    { wch: 25 },  // Notas
  ];

  XLSX.utils.book_append_sheet(wb, ws, "Paradas");

  // Hoja de instrucciones
  const instrucciones = [
    ["INSTRUCCIONES - Carga de Paradas AFA Transportes"],
    [""],
    ["Columnas requeridas:"],
    ["- Nombre Parada (texto): nombre corto para identificar la parada"],
    ["- Lat (numero): latitud GPS, ejemplo -12.0219"],
    ["- Lng (numero): longitud GPS, ejemplo -77.1143"],
    [""],
    ["Columnas opcionales:"],
    ["- Orden (numero): orden de la parada en la ruta (si no se especifica, se asigna automaticamente)"],
    ["- Direccion (texto): direccion completa para mostrar en apps"],
    ["- Hora (HH:MM): hora estimada de llegada"],
    ["- Notas (texto): observaciones adicionales"],
    [""],
    ["Como obtener coordenadas de Google Maps:"],
    ["1. Abre Google Maps en el navegador"],
    ["2. Click derecho sobre la ubicacion exacta"],
    ["3. Aparecera por ejemplo: -12.0219, -77.1143"],
    ["4. El PRIMER numero es Lat, el SEGUNDO es Lng"],
    ["5. Copia cada uno en su columna correspondiente"],
    [""],
    ["IMPORTANTE:"],
    ["- En Peru, Lat siempre es NEGATIVO (-12.xxxx)"],
    ["- En Peru, Lng siempre es NEGATIVO (-77.xxxx)"],
    ["- Usa PUNTO como separador decimal, no coma"],
  ];
  const wsInst = XLSX.utils.aoa_to_sheet(instrucciones);
  wsInst["!cols"] = [{ wch: 70 }];
  XLSX.utils.book_append_sheet(wb, wsInst, "Instrucciones");

  XLSX.writeFile(wb, "Plantilla_Paradas_AFA.xlsx");
}