"use client";

import { useEffect, useRef, useState, useCallback } from "react";
import dynamic from "next/dynamic";
import { supabase } from "@/lib/supabase";
import type { Map as MapboxMap, Marker as MapboxMarker } from "mapbox-gl"; // solo tipos: `import type` no emite JS
import "mapbox-gl/dist/mapbox-gl.css";   // el CSS sí es estático (no arrastra el motor)
import { animarMarcador, animarMarcadorPorCamino, tweenEnVuelo } from "@/lib/anim-marker";
import {
  limpiarHuella, colorearMatched, crearAjustadorHuella, filasAPuntos, huellaCrudaFeatures, colaViva, conVelocidadColor, puentesCrudos,
  puntosTelemetria, type PuntoTelemetria, resumenViaje, type ResumenViaje,
  calcularPuentes, decidirPuente, validarPuente, anclarImprecisos, puentePorRuta, distM, paginarFilas,
  pegarIconoAVia, caminoEntreSnaps, enParalelo,
} from "@/lib/huella";
import { idAfa } from "@/lib/folio";
import { fmtCoord } from "@/lib/coordenadas";
import { estadoCliente, normalizaEstado } from "@/lib/estados";
import { manifiestoMtcHTML, reporteServicioHTML, abrirImprimible, esAbordado } from "@/lib/documentos-servicio";
import { saveSession, loadSession, clearSession, getPortalToken, portalApi } from "@/lib/portal-sesion";

// Los dos modales se cargan al abrirlos, no al entrar al portal. Ambos se montan detrás
// de un guard (`{gpsModalOpen && …}`, `{modalManifiestoData && …}`), así que no necesitan
// fallback. ModalManifiestoPortal arrastra xlsx (136 KB gz) por lib/manifiesto-csv.
const ModalGps = dynamic(() => import("@/components/seguimiento/ModalGps"), { ssr: false });
const ModalManifiestoPortal = dynamic(() => import("@/components/portal/ModalManifiestoPortal"), { ssr: false });

// ─── Mapbox bajo demanda ──────────────────────────────────────────────────
// El motor de mapbox son 461 KB gz — el 57% del JavaScript de esta ruta — y solo lo usa
// la pestaña "En vivo". Importarlo arriba obligaba a descargarlo, parsearlo y ejecutarlo
// ANTES de que el portal pudiera pedir su primer dato, en las seis pestañas por igual.
// Ahora se carga al entrar al mapa. Todos los usos de `mapboxgl` en este archivo están
// detrás de `mapListoEnVivo`, que solo se enciende cuando el mapa ya se creó — es decir,
// después de este cargador.
type MapboxAPI = (typeof import("mapbox-gl"))["default"];
let mapboxgl!: MapboxAPI;
let cargaMapbox: Promise<MapboxAPI> | null = null;
function cargarMapbox(): Promise<MapboxAPI> {
  if (mapboxgl) return Promise.resolve(mapboxgl);
  if (!cargaMapbox) {
    cargaMapbox = import("mapbox-gl").then(mod => {
      const gl = ((mod as any).default ?? mod) as MapboxAPI;
      gl.accessToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
      mapboxgl = gl;
      return gl;
    });
  }
  return cargaMapbox;
}

// ─── TIPOS ────────────────────────────────────────────────────────────────
type Cliente        = { id: number; nombre: string; empresa: string | null; ruc: string | null; email: string | null; telefono: string | null; created_at?: string; };
type Reserva        = { id: number; codigo?: string | null; origen: string; destino: string; fecha_servicio: string | null; hora_servicio: string | null; estado: string; precio_cliente: number; vehiculo_id: number | null; conductor_id: number | null; cotizacion_id: number | null; created_at: string; };
type Parada         = { id: number; reserva_id: number; orden: number; nombre: string; direccion: string | null; lat: number | null; lng: number | null; hora_estimada: string | null; estado: string; };
type Boarding       = { id: number; pasajero_id: number; parada_id: number; timestamp: string; metodo: string; pasajero?: { nombre: string; dni: string | null; empresa: string | null; }; };
type PasajeroParada = { id: number; parada_id: number | null; pasajero_id: number; estado: string; estado_abordaje?: string | null; hora_abordaje?: string | null; pasajero?: { nombre: string; dni: string | null; edad?: number | null; }; };
type GPS            = { lat: number; lng: number; velocidad: number; timestamp: string; estado?: string; };
type EmpresaPerfil  = { nombre: string | null; logo_url: string | null; color_primario: string | null; telefono: string | null; email: string | null; slogan: string | null; };
type ConductorInfo  = { nombre: string; numero_licencia: string | null; telefono: string | null; };
type VehiculoInfo   = { placa: string; };
type Tab = "dashboard" | "activos" | "historial" | "facturacion" | "documentos" | "cuenta";
type CuentaSeccion = "empresa" | "usuarios" | "notificaciones" | "facturacion_cfg" | "integraciones" | "seguridad" | "preferencias";
type Factura = { id: number; reserva_id: number | null; tipo_comprobante: string; serie: string | null; numero: string | null; fecha_emision: string | null; fecha_vencimiento: string | null; total: number; estado: string; pdf_url: string | null; };
type PortalUsuario = { id: number; cliente_id: number; nombre: string; dni: string; cargo: string | null; rol: "admin" | "visor"; email: string | null; codigo_acceso: string; activo: boolean; created_at: string; modulos_permitidos: string[] | null; };

// suavizarHuella + limpieza/Map Matching de la huella viven en lib/huella.ts (compartido con ModalGps).

// Fuente de verdad del abordaje (pasajeros_parada, estado + estado_abordaje) → esAbordado()
// vive ahora en lib/documentos-servicio.ts (compartido con /seguimiento y los documentos).

const MODULOS_CTRL = [
  { id: "activos",     label: "En vivo · GPS" },
  { id: "historial",   label: "Historial de servicios" },
  { id: "reporte",     label: "Reportes de embarque" },
  { id: "facturacion", label: "Facturación" },
  { id: "documentos",  label: "Documentos" },
  { id: "cuenta",      label: "Cuenta y configuración" },
];
type DocPortal = { id: number; nombre: string; categoria: string; storage_path: string; tamano_bytes: number | null; created_at: string; };
type Notif = { id: number; tipo: "warning" | "info" | "success"; titulo: string; desc: string; fecha: string; };

// ─── PALETA (design tokens v3) ────────────────────────────────────────────
const C = {
  // Surfaces warm off-white
  bg:         "#F6F4EE",
  paper:      "#FAF9F4",
  surface:    "#FFFFFF",
  surfaceAlt: "#F1EFE8",
  // Ink
  ink:        "#0A0E1A",
  ink2:       "#1F2433",
  mute:       "#6B6F7C",
  mute2:      "#9AA0AC",
  // Hairlines
  line:       "#E6E2D6",
  line2:      "#D5D1C5",
  // Brand
  navy:       "#0b315f",
  navyDeep:   "#071f3d",
  navyTint:   "#EAEFF6",
  navyTint2:  "#D5DDEA",
  // Semantic
  success:    "#15803d",
  successTint:"#E3F1E6",
  warn:       "#A65B0A",
  warnTint:   "#FBEFD5",
  danger:     "#B91C1C",
  dangerTint: "#FCE5E2",
  info:       "#1d4ed8",
  infoTint:   "#E1E9FB",
  // Backward-compat aliases
  white:      "#FFFFFF",
  gray50:     "#F6F4EE",
  gray100:    "#F1EFE8",
  gray200:    "#E6E2D6",
  gray400:    "#9AA0AC",
  gray600:    "#6B6F7C",
  gray800:    "#1F2433",
  green:      "#15803d",
  red:        "#B91C1C",
  amber:      "#A65B0A",
  blue:       "#1d4ed8",
  navyDark:   "#071f3d",
  navyLight:  "#1a4a7a",
  // Fonts
  fontSans:   '"Manrope", -apple-system, system-ui, sans-serif',
  fontMono:   '"JetBrains Mono", ui-monospace, monospace',
};

// Vocabulario de estados de cara al cliente → única fuente en lib/estados.ts (estadoCliente()).

// ─── SESSION ──────────────────────────────────────────────────────────────
// saveSession/loadSession/clearSession + portalApi viven en lib/portal-sesion.ts
// (compartidas con los modales del portal). La sesión ahora incluye el token de
// /api/cliente: las consultas del portal van por ese endpoint (service role)
// porque RLS bloquea el rol anónimo en las tablas del ERP.

// ─── HELPERS ──────────────────────────────────────────────────────────────
const fmtFecha    = (f: string | null) => f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "–";
const fmtBytesPortal = (b?: number | null) => { if (!b) return "—"; if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b/1024).toFixed(0)} KB`; return `${(b/1048576).toFixed(1)} MB`; };
const fmtFechaLrg = (f: string | null) => f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { weekday: "short", day: "2-digit", month: "short" }) : "–";
const fmtTs       = (ts: string) => new Date(ts).toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" });
const fmtSoles    = (n: number) => `S/ ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2 })}`;

// ─── PERIODO DEL HISTORIAL ────────────────────────────────────────────────
// Un solo periodo gobierna toda la pestaña: las cinco tarjetas, los chips de estado,
// la tabla, la agenda y el Excel. Antes cada tarjeta medía un tramo distinto —una el
// mes, otra "total histórico", otra todo— y la fila entera se leía como si fueran
// cifras comparables.
// Todo se calcula con strings "YYYY-MM-DD" comparados como texto: es exactamente lo
// que guarda fecha_servicio y evita por completo los corrimientos de zona horaria.
type PeriodoId = "mes" | "mes_pasado" | "3meses" | "anio" | "todo" | "custom";
type Rango = { desde: string | null; hasta: string | null; etiqueta: string };

const PERIODOS: { id: PeriodoId; label: string }[] = [
  { id: "mes",        label: "Este mes" },
  { id: "mes_pasado", label: "Mes pasado" },
  { id: "3meses",     label: "Últimos 3 meses" },
  { id: "anio",       label: "Este año" },
  { id: "todo",       label: "Todo" },
  { id: "custom",     label: "Personalizado" },
];

const MES_CORTO = ["ENE","FEB","MAR","ABR","MAY","JUN","JUL","AGO","SET","OCT","NOV","DIC"];
const dosDig    = (n: number) => String(n).padStart(2, "0");
const ultimoDiaMes = (y: number, m: number) => new Date(Date.UTC(y, m, 0)).getUTCDate(); // m = 1..12
/** Suma días a una fecha "YYYY-MM-DD" sin salir del calendario ni tocar zonas horarias. */
function sumarDias(f: string, dias: number): string {
  const d = new Date(f + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + dias);
  return d.toISOString().slice(0, 10);
}

function rangoDePeriodo(p: PeriodoId, hoy: string, desdeC: string, hastaC: string): Rango {
  const Y = Number(hoy.slice(0, 4)), M = Number(hoy.slice(5, 7));
  const mesCompleto = (y: number, m: number): Rango => ({
    desde: `${y}-${dosDig(m)}-01`,
    hasta: `${y}-${dosDig(m)}-${dosDig(ultimoDiaMes(y, m))}`,
    etiqueta: `${MES_CORTO[m - 1]} ${y}`,
  });
  switch (p) {
    case "mes":        return mesCompleto(Y, M);
    case "mes_pasado": return mesCompleto(M === 1 ? Y - 1 : Y, M === 1 ? 12 : M - 1);
    case "3meses":     return { desde: sumarDias(hoy, -90), hasta: hoy, etiqueta: "ÚLT. 3 MESES" };
    case "anio":       return { desde: `${Y}-01-01`, hasta: `${Y}-12-31`, etiqueta: String(Y) };
    case "todo":       return { desde: null, hasta: null, etiqueta: "TODO EL HISTORIAL" };
    case "custom": {
      const d = desdeC || null, h = hastaC || null;
      if (!d && !h) return { desde: null, hasta: null, etiqueta: "TODO EL HISTORIAL" };
      const et = d && h ? `${fmtFecha(d)} – ${fmtFecha(h)}` : d ? `DESDE ${fmtFecha(d)}` : `HASTA ${fmtFecha(h)}`;
      return { desde: d, hasta: h, etiqueta: et };
    }
  }
}

/** El periodo inmediatamente anterior, para el "vs" de la primera tarjeta. */
function rangoAnterior(p: PeriodoId, hoy: string, r: Rango): Rango | null {
  const Y = Number(hoy.slice(0, 4)), M = Number(hoy.slice(5, 7));
  const mesCompleto = (y: number, m: number): Rango => ({
    desde: `${y}-${dosDig(m)}-01`,
    hasta: `${y}-${dosDig(m)}-${dosDig(ultimoDiaMes(y, m))}`,
    etiqueta: `${MES_CORTO[m - 1]} ${y}`,
  });
  if (p === "mes")        return mesCompleto(M === 1 ? Y - 1 : Y, M === 1 ? 12 : M - 1);
  if (p === "mes_pasado") { const y = M === 1 ? Y - 1 : Y, m = M === 1 ? 12 : M - 1;
                            return mesCompleto(m === 1 ? y - 1 : y, m === 1 ? 12 : m - 1); }
  if (p === "anio")       return { desde: `${Y-1}-01-01`, hasta: `${Y-1}-12-31`, etiqueta: String(Y - 1) };
  if (p === "todo")       return null;                       // no hay "antes de todo"
  if (!r.desde || !r.hasta) return null;                     // rango abierto: nada que comparar
  const dias = Math.max(1, Math.round((Date.parse(r.hasta) - Date.parse(r.desde)) / 86400000) + 1);
  return { desde: sumarDias(r.desde, -dias), hasta: sumarDias(r.desde, -1), etiqueta: "periodo anterior" };
}

// Cuánto futuro trae la carga inicial. DEBE coincidir con DIAS_FUTURO de
// app/api/cliente/route.ts: es la frontera que decide si un periodo se puede
// resolver en el navegador o hay que pedirlo al servidor.
const DIAS_VENTANA_FUTURO = 90;

/** ¿Cae la fecha del servicio dentro del rango? Sin fecha = fuera de cualquier periodo acotado. */
function enRango(f: string | null | undefined, r: Rango): boolean {
  if (!r.desde && !r.hasta) return true;
  if (!f) return false;
  const d = f.slice(0, 10);
  return (!r.desde || d >= r.desde) && (!r.hasta || d <= r.hasta);
}

// Normalización de estados (incluye valores legados) → lib/estados.ts (normalizaEstado()).

function Badge({ estado }: { estado: string }) {
  const e = estadoCliente(estado);
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: e.bg, color: e.c, whiteSpace: "nowrap" as const }}>
      <span style={{ width: 5, height: 5, borderRadius: "50%", background: e.dot, display: "inline-block" }} />
      {e.label}
    </span>
  );
}

// ─── Fecha Peru UTC-5 (no usar toISOString para "hoy") ────────────────────
function getHoyPeru() {
  // Siempre UTC-5 fijo, independiente del timezone del navegador/servidor
  return new Date(Date.now() - 5 * 3600000).toISOString().split("T")[0];
}
// Formato de duración (min → "1h 05m") y hora Perú, para el resumen del viaje.
const fmtDur = (m: number) => (m < 60 ? `${m} min` : `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`);
const fmtHoraPe = (ts: number) => new Date(ts).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", hour12: true, timeZone: "America/Lima" });

// ─── FAQ ──────────────────────────────────────────────────────────────────
const FAQ_ITEMS = [
  { q: "¿Por qué no veo mi bus en el mapa?", a: "El GPS del conductor debe estar activo. Si el servicio está programado para hoy y el conductor no ha iniciado el viaje, la señal aún no estará disponible. Espera unos minutos o contáctanos." },
  { q: "¿Con qué frecuencia se actualiza el GPS?", a: "La posición del vehículo se actualiza en tiempo real cada 10 segundos cuando el conductor tiene activa la app y señal de datos." },
  { q: "¿Cómo descargo el manifiesto oficial?", a: "En la pestaña 'Reporte', selecciona el servicio y presiona 'Manifiesto MTC'. El documento sigue el formato R.D. 1946-2009-MTC-15 exigido por SUTRAN." },
  { q: "¿Puedo programar un nuevo servicio desde aquí?", a: "Para programar un nuevo servicio, comunícate con nuestro equipo al 966707225 o escríbenos por WhatsApp." },
  { q: "¿Qué significa cada estado del servicio?", a: "En proceso: recibimos tu solicitud y la estamos gestionando. Programada: con vehículo y conductor asignados. Confirmada: aprobada y lista. En curso: el bus está en ruta hoy. Finalizada: el servicio ya se realizó. Cancelada: servicio anulado." },
  { q: "¿Puedo agregar o editar pasajeros yo mismo?", a: "Sí. En el Historial de servicios, selecciona un servicio pendiente o confirmado y presiona 'Editar manifiesto'. Podrás agregar pasajeros por nombre/DNI, eliminarlos o subir una lista completa en formato Excel/CSV." },
];

// Refresco del loop de huella + puentes (En vivo). OJO: 12 s NO es arbitrario, está ACOPLADO al
// throttle adaptativo de Map Matching de lib/huella.ts (`throttleMs = accMedR > ACC_DEGRADADO_M
// ? 12000 : 60000`), calibrado para un llamador de ~12 s: con GPS degradado el ajustador quiere
// re-pegar la cola a la vía casi en cada fetch. Subir este intervalo NO ahorra pero SÍ degrada el
// dibujo: la punta viva de la estela se queda zigzagueando fuera de la vía todo ese tiempo extra.
// El ahorro ya no depende del intervalo — /api/ruta-puente cachea cada hueco en Postgres, así que
// repetir el ciclo no vuelve a facturar los mismos puentes a Google.
const MS_REFRESCO_PUENTES = 12_000;

// ─── MAIN ─────────────────────────────────────────────────────────────────
export default function ClientePortal() {
  const [cliente,        setCliente]        = useState<Cliente | null>(null);
  const [empresa,        setEmpresa]        = useState<EmpresaPerfil | null>(null);
  const [initing,        setIniting]        = useState(true);
  const [tab,            setTab]            = useState<Tab>("dashboard");

  // Login
  const [rucInput,      setRucInput]      = useState("");
  const [dniInput,      setDniInput]      = useState("");
  const [tipoIdInput,   setTipoIdInput]   = useState<"DNI"|"CE"|"Celular">("DNI");
  const [passwordInput, setPasswordInput] = useState("");
  const [showPassword,  setShowPassword]  = useState(false);
  const [loginErr,      setLoginErr]      = useState("");
  const [loginLoad,     setLoginLoad]     = useState(false);
  const [portalUsuario, setPortalUsuario] = useState<PortalUsuario | null>(null);

  // Reset de contraseña
  const [modalReset,  setModalReset]  = useState(false);
  const [resetStep,   setResetStep]   = useState<1|2>(1);
  const [resetRuc,    setResetRuc]    = useState("");
  const [resetEmail,  setResetEmail]  = useState("");
  const [resetToken,  setResetToken]  = useState("");
  const [resetPass,   setResetPass]   = useState("");
  const [resetPass2,  setResetPass2]  = useState("");
  const [showRPass,   setShowRPass]   = useState(false);
  const [resetErr,    setResetErr]    = useState("");
  const [resetLoad,   setResetLoad]   = useState(false);
  const [resetOk,     setResetOk]     = useState(false);

  // Datos
  const [reservas,       setReservas]       = useState<Reserva[]>([]);
  const [paradas,        setParadas]        = useState<Record<number, Parada[]>>({});
  const [boarding,       setBoarding]       = useState<Record<number, Boarding[]>>({});
  const [ppList,         setPPList]         = useState<Record<number, PasajeroParada[]>>({});
  const [gpsActual,      setGpsActual]      = useState<GPS | null>(null);
  const [vehiculoActivo, setVehiculoActivo] = useState<number | null>(null);
  const [reservaActivaId, setReservaActivaId] = useState<number | null>(null);
  const [loading,        setLoading]        = useState(false);
  const [reservaSel,     setReservaSel]     = useState<Reserva | null>(null);
  const [conductorInfo,  setConductorInfo]  = useState<ConductorInfo | null>(null);
  const [vehiculoInfo,   setVehiculoInfo]   = useState<VehiculoInfo | null>(null);

  // Facturación
  const [facturas,          setFacturas]          = useState<Factura[]>([]);
  // Liquidaciones del periodo pendientes de conformidad (Formato AFA-FL-07). El
  // cliente las aprueba desde aquí sin salir del portal; el mismo enlace le llega
  // por correo y WhatsApp, así que aprobar en cualquiera de los tres cierra el caso.
  const [liquidaciones,     setLiquidaciones]     = useState<any[]>([]);
  const [sedesLiq,          setSedesLiq]          = useState<Record<number, string>>({});
  const [loadingFact,       setLoadingFact]       = useState(false);

  // Documentos
  const [docs, setDocs] = useState<DocPortal[]>([]);
  const [filtroFactEstado,  setFiltroFactEstado]  = useState("todos");
  const [filtroFactDesde,   setFiltroFactDesde]   = useState("");
  const [filtroFactHasta,   setFiltroFactHasta]   = useState("");

  // Colaboradores / Cuenta
  const [colabs,            setColabs]            = useState<PortalUsuario[]>([]);
  const [loadingColabs,     setLoadingColabs]     = useState(false);
  const [modalColab,        setModalColab]        = useState(false);
  const [editColab,         setEditColab]         = useState<PortalUsuario | null>(null);
  const [newColabNombre,    setNewColabNombre]     = useState("");
  const [newColabDni,       setNewColabDni]        = useState("");
  const [newColabEmail,     setNewColabEmail]      = useState("");
  const [newColabCargo,     setNewColabCargo]      = useState("");
  const [newColabRol,       setNewColabRol]        = useState<"admin"|"visor">("visor");
  const [newColabPass,      setNewColabPass]       = useState("");
  const [newColabPermisos,  setNewColabPermisos]   = useState<string[]>(MODULOS_CTRL.map(m => m.id).filter(id => id !== "facturacion"));
  const [colabErr,          setColabErr]           = useState("");
  const [colabLoad,         setColabLoad]          = useState(false);

  // Cambiar contraseña (usuario logueado)
  const [pwdActual, setPwdActual] = useState("");
  const [pwdNueva,  setPwdNueva]  = useState("");
  const [pwdNueva2, setPwdNueva2] = useState("");
  const [pwdShow,   setPwdShow]   = useState(false);
  const [pwdErr,    setPwdErr]    = useState("");
  const [pwdOk,     setPwdOk]     = useState(false);
  const [pwdLoad,   setPwdLoad]   = useState(false);

  // Cuenta / Configuración
  const [cuentaSeccion,     setCuentaSeccion]     = useState<CuentaSeccion>("empresa");
  const [busqueda,          setBusqueda]          = useState("");
  const [editandoEmpresa,   setEditandoEmpresa]   = useState(false);
  const [empSector,         setEmpSector]         = useState("Logística y distribución");
  const [empDireccion,      setEmpDireccion]      = useState("Lima, Perú");
  const [empFlota,          setEmpFlota]          = useState("20–35 pasajeros / servicio promedio");
  const [notifPrefs,        setNotifPrefs]        = useState([
    { id: "ruta",      titulo: "Servicio inicia ruta",              desc: "Cuando el conductor activa el GPS",           canales: ["EMAIL","PUSH","SMS","WHATSAPP"], activo: true  },
    { id: "parada",    titulo: "Embarque iniciado en parada",       desc: "Notificación al llegar a cada parada",        canales: ["EMAIL","PUSH","SMS","WHATSAPP"], activo: true  },
    { id: "estado",    titulo: "Cambios de estado",                 desc: "Confirmado, cancelado, etc.",                 canales: ["EMAIL","PUSH","SMS","WHATSAPP"], activo: true  },
    { id: "trafico",   titulo: "Alertas de tráfico o demora >10 min",desc: "Cuando la ETA cambia significativamente",   canales: ["EMAIL","PUSH","SMS","WHATSAPP"], activo: true  },
    { id: "noshow",    titulo: "Predicciones de no-show",           desc: "Alerta 24h antes con alta probabilidad",      canales: ["EMAIL","PUSH"],                 activo: false },
    { id: "resumen",   titulo: "Resumen ejecutivo semanal · viernes 5pm", desc: "PDF con KPIs, top rutas y ahorros",    canales: ["EMAIL"],                        activo: true  },
  ]);

  // Filtros historial
  const [filtroEstado,   setFiltroEstado]   = useState("todos");
  const [filtroBusqueda, setFiltroBusqueda] = useState("");
  const [vistaAgenda,    setVistaAgenda]    = useState(false);
  // Periodo del Historial: gobierna tarjetas, chips, tabla, agenda y Excel.
  const [periodo,        setPeriodo]        = useState<PeriodoId>("mes");
  const [periodoDesde,   setPeriodoDesde]   = useState("");
  const [periodoHasta,   setPeriodoHasta]   = useState("");
  const [periodoAbierto, setPeriodoAbierto] = useState(false);
  // Reservas traídas del servidor para un periodo que cae fuera de la ventana de "datos"
  // (programación a más de 90 días). Se unen a las cargadas, deduplicando por id.
  const [reservasExtra,  setReservasExtra]  = useState<Reserva[]>([]);
  const [cargandoRango,  setCargandoRango]  = useState(false);
  const rangoPedidoRef = useRef("");
  const [reservaStats,   setReservaStats]   = useState<Record<number, { embarcados: number; esperados: number }>>({});
  const [loadingStats,   setLoadingStats]   = useState(false);
  const [exportando,     setExportando]     = useState(false);
  // Sello del intento de stats: se marca ANTES de pedir y en TODOS los caminos (mismo
  // patrón que el efecto de ETA). Sin él, un intento fallido dejaba la guarda del efecto
  // satisfecha y la pestaña Historial repetía el POST sin freno.
  const statsPedidosRef = useRef(false);
  // Carga en vuelo + sello de frescura, para que los refrescos automáticos no se
  // encimen ni repongan los esqueletos sobre datos que ya están en pantalla.
  const cargandoDatosRef = useRef(false);
  const ultimoDatosRef   = useRef(0);
  const cargandoFlotaRef = useRef(false);
  // "Total histórico": lo cuenta Postgres (servicios ya realizados), no el largo del
  // array —que ahora es una ventana, y antes incluía la programación de 2027-2028.
  const [totalHistorico, setTotalHistorico] = useState<number | null>(null);

  // Modales
  const [gpsModalOpen, setGpsModalOpen] = useState(false);
  const [gpsModalRes,  setGpsModalRes]  = useState<Reserva | null>(null);
  const [modalFaq,     setModalFaq]     = useState(false);
  const [modalNotif,   setModalNotif]   = useState(false);
  const [faqOpen,      setFaqOpen]      = useState<number | null>(null);

  // ── Modal manifiesto portal ────────────────────────────────────────────────
  const [modalManifiestoData, setModalManifiestoData] = useState<{ reservaId: number; clienteId: number; readonly: boolean } | null>(null);

  // En vivo — mapa Mapbox
  const mapContainerRef = useRef<HTMLDivElement>(null);
  const mapRef          = useRef<MapboxMap | null>(null);
  const markersEnVivo   = useRef<Record<string, MapboxMarker>>({});
  const [vehiculosCliente,  setVehiculosCliente]  = useState<{id:number;placa:string}[]>([]);
  // Placas de vehículos de tercero: se muestran igual que las propias para que el
  // cliente NUNCA distinga un servicio tercerizado de uno propio.
  const [vehiculosTerceroCliente, setVehiculosTerceroCliente] = useState<{id:number;placa:string}[]>([]);
  const [ubicacionesEnVivo, setUbicacionesEnVivo] = useState<{vehiculo_id:number|null;vehiculo_tercero_id?:number|null;reserva_id?:number|null;conductor_id?:number|null;conductor_tercero_id?:number|null;lat:number;lng:number;velocidad:number;rumbo?:number|null;timestamp:string}[]>([]);
  const [mapListoEnVivo,    setMapListoEnVivo]    = useState(false);
  const [rutaSelId,         setRutaSelId]         = useState<number | null>(null);
  const [rutasEnVivoMap,    setRutasEnVivoMap]    = useState<Record<number, [number,number][]>>({});
  const rutasEnVivoRef = useRef<Record<number, [number,number][]>>({}); // espejo para leer la ruta planificada en el loop del puente
  const [huellaGpsMap,      setHuellaGpsMap]      = useState<Record<number, {lat:number;lng:number;velocidad:number;ts:string|null;acc?:number}[]>>({});
  const [telemetriaMap,     setTelemetriaMap]     = useState<Record<number, PuntoTelemetria[]>>({}); // puntitos de telemetría real por servicio
  const [resumenMap,        setResumenMap]        = useState<Record<number, ResumenViaje | null>>({}); // resumen del viaje por servicio
  const [puentesMap,        setPuentesMap]        = useState<Record<number, any[]>>({});                // features de tramos estimados (puente azul) por servicio
  // `expira`: fallos transitorios de /api/ruta-puente (red, 429/5xx, cuota) se cachean con
  // vencimiento de 60 s — ni tormenta de reintentos en cada tick ni "ocultar" envenenado de por vida.
  const puentesCacheCliRef = useRef<Map<string, { nivel: string; coords: [number, number][]; km: number; dt: number; expira?: number }>>(new Map());
  const cargandoHuellaCliRef = useRef(false); // evita ciclos solapados de cargarHuella (fetches lentos > MS_REFRESCO_PUENTES)
  const [mostrarPuntosCli,  setMostrarPuntosCli]  = useState(true);                                  // toggle de la leyenda
  const geocacheCliRef = useRef<Map<string, string>>(new Map());                                     // caché reverse-geocode
  const popupTelemCliRef = useRef<any>(null);                                                        // popup activo de un puntito
  // Geometría ajustada a la vía (Map Matching) por servicio — misma calidad que el modal.
  const [matchedEnVivoMap,  setMatchedEnVivoMap]  = useState<Record<number, [number,number][]>>({});
  const [esCrudoEnVivoMap,  setEsCrudoEnVivoMap]  = useState<Record<number, boolean[]>>({});               // esCrudo por vértice, en ESTADO junto a matched (mismo batch → nunca desalineados al dibujar)
  const [suprimirCrudoMap,  setSuprimirCrudoMap]  = useState<Record<number, Array<[number, number]>>>({}); // rangos crudos ruteados por servicio → no dibujar como medido
  const [colaSnappedMap,    setColaSnappedMap]    = useState<Record<number, boolean>>({});                 // ¿la punta viva pegó a la vía por servicio? (false → colaViva sigue la ruta prevista)
  const [colaCleanMap,      setColaCleanMap]      = useState<Record<number, number>>({});                  // último índice de VÍA limpia por servicio (frontera de colaViva)
  const [paradasResueltasMap, setParadasResueltasMap] = useState<Record<number, Parada[]>>({});
  // Dashboard — info enriquecida por servicio destacado
  const [condInfoMap,   setCondInfoMap]   = useState<Record<number, {nombre: string; tel: string}>>({});
  const [vehPlacaMap,   setVehPlacaMap]   = useState<Record<number, string>>({});
  const [gpsCardMap,    setGpsCardMap]    = useState<Record<number, {lat:number;lng:number;velocidad:number;estado:string|null;ts:number} | null>>({});
  // `alejando` = Google devolvió un rodeo absurdo hacia el destino → el bus ya lo pasó o va en
  // sentido contrario. En ese caso NO se pinta hora: una cuenta regresiva que la dirección
  // contradice es exactamente el bug que se está corrigiendo en el modal.
  const [etaDestinoMap, setEtaDestinoMap] = useState<Record<number, { hora: string | null; ts: number; alejando: boolean }>>({});
  // Control de gasto del ETA de las tarjetas (SKU Directions Advanced, sin caché — ver la
  // auditoría de costos de Google del 1-ago-2026). Los tres candados: cadencia por reserva,
  // piso global entre dos llamadas cualesquiera y tope duro por sesión de pestaña.
  const etaCalcRef  = useRef<Record<number, number>>({});
  const etaUltimaRef = useRef(0);
  const etaGastoRef  = useRef(0);
  const ajustadoresRef   = useRef<Record<number, ReturnType<typeof crearAjustadorHuella>>>({}); // 1 ajustador de Map Matching por servicio
  const matchedEnVivoRefMap = useRef<Record<number, [number, number][]>>({}); // última geometría ajustada por servicio (para puentesCrudos aunque el ciclo devuelva null)
  const esCrudoEnVivoRefMap = useRef<Record<number, boolean[]>>({}); // espejo del estado esCrudoEnVivoMap para el efecto de MARCADORES (par ref+ref con matchedEnVivoRefMap → siempre alineados)
  const snapIconoCliRef = useRef<{ rid: number; lat: number; lng: number; s: number | null } | null>(null); // continuidad del snap del ícono (servicio seleccionado)
  const dibujoLayersRef  = useRef<string[]>([]);
  const dibujoSourcesRef = useRef<string[]>([]);
  const stopMarkersRef   = useRef<MapboxMarker[]>([]);
  const lastFitRef           = useRef<number | null>(null);
  const serviciosHoyRef      = useRef<Reserva[]>([]);
  const autocentradoRef      = useRef(false);
  const ubicacionesEnVivoRef = useRef<typeof ubicacionesEnVivo>([]);

  // ─── Init ─────────────────────────────────────────────────────────────────
  useEffect(() => {
    supabase.from("empresa_perfil").select("nombre,logo_url,color_primario,telefono,email,slogan").eq("id", 1).maybeSingle()
      .then(({ data }: any) => { if (data) setEmpresa(data as EmpresaPerfil); });
    const saved = loadSession();
    if (saved) {
      setCliente(saved.c); setPortalUsuario(saved.u);
      cargarDatos(saved.c.id);
      // La flota NO se pide aquí: el efecto de tab === "dashboard" | "activos" ya la
      // carga en el montaje (tab arranca en "dashboard"). Pedirla también acá duplicaba
      // en t=0 las dos llamadas más caras justo mientras se pinta el esqueleto.
    }
    setIniting(false);
  }, []);

  // ─── Login ────────────────────────────────────────────────────────────────
  // Credenciales verificadas en el SERVIDOR (/api/cliente, service role): el rol
  // anónimo no puede leer clientes/portal_usuarios (RLS) ni debe ver claves.
  async function login() {
    if (!rucInput.trim())      { setLoginErr("Ingresa el RUC de tu empresa"); return; }
    if (!dniInput.trim())      { setLoginErr(`Ingresa tu ${tipoIdInput === "Celular" ? "número de celular" : tipoIdInput}`); return; }
    if (!passwordInput.trim()) { setLoginErr("Ingresa tu contraseña"); return; }
    setLoginErr(""); setLoginLoad(true);
    const { ok, data } = await portalApi("login", {
      ruc: rucInput.trim(), doc: dniInput.trim(), password: passwordInput.trim(), tipoId: tipoIdInput,
    });
    if (!ok || !data?.cliente || !data?.token) {
      setLoginErr(data?.error || "No se pudo iniciar sesión. Intenta de nuevo.");
      setLoginLoad(false); return;
    }
    saveSession(data.cliente, data.usuario, data.token);
    setCliente(data.cliente as Cliente); setPortalUsuario(data.usuario as PortalUsuario);
    // La flota la carga el efecto de la pestaña (ver Init): no se duplica aquí.
    await cargarDatos(data.cliente.id); setLoginLoad(false);
  }

  // ─── Reset de contraseña — paso 1: solicitar código ──────────────────────
  async function solicitarReset() {
    if (!resetRuc.trim())   { setResetErr("Ingresa el RUC de tu empresa"); return; }
    if (!resetEmail.trim()) { setResetErr("Ingresa tu correo electrónico"); return; }
    setResetErr(""); setResetLoad(true);
    try {
      const res = await fetch("/api/portal/reset-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ruc: resetRuc.trim(), email: resetEmail.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setResetErr(data.error || "Error al enviar"); setResetLoad(false); return; }
      setResetStep(2);
    } catch { setResetErr("Error de conexión. Intenta de nuevo."); }
    setResetLoad(false);
  }

  // ─── Reset de contraseña — paso 2: confirmar código + nueva contraseña ───
  async function confirmarReset() {
    if (!resetToken.trim())              { setResetErr("Ingresa el código recibido"); return; }
    if (resetPass.trim().length < 6)     { setResetErr("La contraseña debe tener al menos 6 caracteres"); return; }
    if (resetPass.trim() !== resetPass2.trim()) { setResetErr("Las contraseñas no coinciden"); return; }
    setResetErr(""); setResetLoad(true);
    try {
      const res = await fetch("/api/portal/confirmar-reset", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token: resetToken.trim().toUpperCase(), nueva_password: resetPass.trim() }),
      });
      const data = await res.json();
      if (!res.ok) { setResetErr(data.error || "Código inválido"); setResetLoad(false); return; }
      setResetOk(true);
    } catch { setResetErr("Error de conexión. Intenta de nuevo."); }
    setResetLoad(false);
  }

  function cerrarModalReset() {
    setModalReset(false);
    setTimeout(() => { setResetStep(1); setResetRuc(""); setResetEmail(""); setResetToken(""); setResetPass(""); setResetPass2(""); setResetErr(""); setResetOk(false); }, 300);
  }

  // ─── Cambiar contraseña del usuario logueado ─────────────────────────────
  async function cambiarPassword() {
    if (pwdLoad) return;                    // guard anti doble envío (Enter/click repetido en vuelo)
    if (!portalUsuario || !cliente) return;
    setPwdErr(""); setPwdOk(false);         // limpia estados previos ANTES de validar (evita verde+rojo a la vez)
    if (!pwdActual.trim())                     { setPwdErr("Ingresa tu contraseña actual"); return; }
    if (pwdNueva.trim().length < 6)            { setPwdErr("La nueva contraseña debe tener al menos 6 caracteres"); return; }
    if (pwdNueva.trim() !== pwdNueva2.trim())  { setPwdErr("Las contraseñas nuevas no coinciden"); return; }
    if (pwdNueva.trim() === pwdActual.trim())  { setPwdErr("La nueva contraseña debe ser distinta de la actual"); return; }
    setPwdLoad(true);
    try {
      const res = await fetch("/api/portal/cambiar-password", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          usuario_id: portalUsuario.id,
          actual:     pwdActual.trim(),
          nueva:      pwdNueva.trim(),
        }),
      });
      const data = await res.json();
      if (!res.ok) { setPwdErr(data.error || "No se pudo cambiar la contraseña"); setPwdLoad(false); return; }
      // Refleja la nueva clave en la sesión local para mantener coherencia.
      const actualizado = { ...portalUsuario, codigo_acceso: pwdNueva.trim() };
      setPortalUsuario(actualizado);
      const tok = getPortalToken();
      if (tok) saveSession(cliente, actualizado, tok);
      setPwdOk(true); setPwdActual(""); setPwdNueva(""); setPwdNueva2("");
    } catch { setPwdErr("Error de conexión. Intenta de nuevo."); }
    setPwdLoad(false);
  }

  // ─── Cargar datos ─────────────────────────────────────────────────────────
  // Reservas + facturas + documentos llegan juntas desde /api/cliente (service
  // role): el rol anónimo no puede leerlas por RLS.
  // ─── paradas_json bajo demanda ────────────────────────────────────────────
  // La columna más pesada de reservas (~1.7 KB por fila) se quedó fuera de la lista y
  // se trae solo para los servicios que de verdad la pintan: los de hoy y el que se
  // abre en el modal GPS o en el detalle. Se fusiona sobre la reserva ya cargada.
  const traerParadasJson = useCallback(async (ids: number[]): Promise<Map<number, any>> => {
    const limpios = [...new Set(ids)].filter(id => id > 0);
    if (limpios.length === 0) return new Map();
    const { ok, data } = await portalApi("paradas_json_reservas", { reserva_ids: limpios });
    if (!ok || !Array.isArray(data?.reservas)) return new Map();
    return new Map<number, any>(data.reservas.map((x: any) => [x.id, x.paradas_json]));
  }, []);

  const paradasJsonPedidasRef = useRef<Set<number>>(new Set());
  const hidratarParadasJson = useCallback(async (ids: number[]) => {
    const faltan = [...new Set(ids)].filter(id => id > 0 && !paradasJsonPedidasRef.current.has(id));
    if (faltan.length === 0) return;
    faltan.forEach(id => paradasJsonPedidasRef.current.add(id));
    const m = await traerParadasJson(faltan);
    if (m.size === 0) { faltan.forEach(id => paradasJsonPedidasRef.current.delete(id)); return; } // reintentable
    setReservas(prev => prev.map(r => m.has(r.id) ? { ...r, paradas_json: m.get(r.id) } as Reserva : r));
  }, [traerParadasJson]);

  const cargarDatos = useCallback(async (cid: number, silencioso = false) => {
    // Una sola carga a la vez. El intervalo de 30 s, el visibilitychange y el montaje
    // podían solaparse y disparar la misma consulta pesada tres veces seguidas.
    if (cargandoDatosRef.current) return;
    // Un refresco silencioso que llega pisando otro reciente no aporta nada.
    if (silencioso && Date.now() - ultimoDatosRef.current < 15000) return;
    cargandoDatosRef.current = true;
    // Los esqueletos son solo para la PRIMERA carga. Reponerlos en cada revalidación
    // (cada 30 s, y en cada alt-tab) es lo que hacía que el portal pareciera estar
    // cargando siempre, aunque los datos ya estuvieran en pantalla.
    if (!silencioso) { setLoading(true); setLoadingFact(true); }
    // Las liquidaciones van en su propia llamada: si la tabla todavía no existe, la
    // sección simplemente no aparece y el resto del portal no se entera. Se dispara
    // ANTES del await para que Facturación no espere a la lista de servicios.
    portalApi("liquidaciones_listar").then(({ data: d }) => {
      setLiquidaciones((d?.liquidaciones ?? []) as any[]);
      const m: Record<number, string> = {};
      for (const s of ((d?.sedes ?? []) as any[])) m[s.id] = s.nombre;
      setSedesLiq(m);
    }).catch(() => {});
    const { ok, data } = await portalApi("datos");
    cargandoDatosRef.current = false;
    if (!ok) { setLoading(false); setLoadingFact(false); return; } // falla transitoria: conservar estado
    ultimoDatosRef.current = Date.now();
    if (typeof data.total_historico === "number") setTotalHistorico(data.total_historico);
    const rList = (data.reservas || []) as Reserva[];
    // No borrar reservas existentes si la consulta devuelve vacío (falla transitoria).
    setReservas(prev => rList.length > 0 ? rList : prev.length > 0 ? prev : rList);
    const hoy = getHoyPeru();
    // paradas_json ya no viaja en la lista (era la mitad de su peso). Se pide solo para
    // los servicios de HOY, que son los que dibujan tarjeta, mapa y ETA.
    hidratarParadasJson(rList.filter(r => r.fecha_servicio?.startsWith(hoy)).map(r => r.id));
    const activo = rList.find(r => r.fecha_servicio?.startsWith(hoy) && !["cancelado","cancelada"].includes(r.estado));
    setReservaActivaId(activo?.id ?? null);
    if (activo) {
      const av = activo as any;
      if (av.vehiculo_id) setVehiculoActivo(av.vehiculo_id);
      // GPS del servicio activo vía endpoint service_role (sin RLS). Los puntos de
      // tercero llegan con reserva_id null y solo vehiculo_tercero_id, por eso la
      // consulta directa por reserva_id fallaba. El endpoint resuelve la cascada.
      fetch("/api/cliente/gps", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ reservaId: activo.id, vehiculoId: av.vehiculo_id ?? null, vehiculoTerceroId: av.vehiculo_tercero_id ?? null }),
      }).then(r => r.json()).then(j => { if (j?.ubicacion) setGpsActual(j.ubicacion as GPS); }).catch(() => {});
    }
    if (activo?.conductor_id) {
      supabase.from("conductores").select("nombre,numero_licencia,telefono").eq("id", activo.conductor_id).maybeSingle()
        .then(({ data }: any) => { if (data) setConductorInfo(data as ConductorInfo); });
    }
    if (activo?.vehiculo_id) {
      portalApi("placas_vehiculos", { vehiculo_ids: [activo.vehiculo_id] })
        .then(({ ok, data }) => { const placa = ok ? data?.vehiculos?.[0]?.placa : null; if (placa) setVehiculoInfo({ placa }); });
    }
    setLoading(false);
    if (activo) {
      portalApi("paradas_reserva", { reserva_id: activo.id })
        .then(({ ok, data }) => { if (ok && data?.paradas?.length) setParadas(prev => ({ ...prev, [activo.id]: data.paradas })); });
    }
    setFacturas((data.facturas || []) as Factura[]);
    setLoadingFact(false);
    setDocs((data.documentos || []) as DocPortal[]);
  }, [hidratarParadasJson]);

  // ─── Cargar detalles (paradas + boarding + pasajeros + conductor + vehiculo)
  // force=true salta la caché (se usa al editar el manifiesto con el detalle abierto).
  const cargarDetalle = useCallback(async (r: Reserva, force = false) => {
    setReservaSel(r);
    setTab("historial");
    setConductorInfo(null);
    setVehiculoInfo(null);

    const tasks: Promise<any>[] = [];

    // Se condiciona a ppList (no a paradas): GPS, dashboard y la carga inicial llenan
    // paradas[r.id] sin tocar ppList[r.id]. Si el guard fuera por paradas, abrir GPS y
    // luego "Ver" cortocircuitaría esta carga y el detalle quedaría sin roster ("Esperados: 0").
    if (force || !ppList[r.id]) {
      // El armado del roster (paradas + boarding + pasajeros ∪ sin-paradero + edad
      // aislada) vive ahora en /api/cliente acción manifiesto_reserva (service role):
      // el rol anónimo no puede leer esas tablas por RLS. Misma semántica que antes.
      tasks.push(
        portalApi("manifiesto_reserva", { reserva_id: r.id }).then(({ ok, data }) => {
          if (!ok) return; // falla transitoria: conservar estado previo
          setParadas(prev => ({ ...prev, [r.id]: data.paradas || [] }));
          setBoarding(prev => ({ ...prev, [r.id]: data.boarding || [] }));
          setPPList(prev => ({ ...prev, [r.id]: data.roster || [] }));
        })
      );
    }

    // Conductor: propio (conductor_id → tabla conductores) o tercerizado
    // (conductor_tercero_id → tabla conductores_tercero, sin revelar la empresa al cliente).
    const ra = r as any;
    if (r.conductor_id) {
      tasks.push(
        supabase.from("conductores").select("nombre,numero_licencia,telefono").eq("id", r.conductor_id).maybeSingle()
          .then(({ data }: any) => { if (data) setConductorInfo(data as ConductorInfo); })
      );
    } else if (ra.conductor_tercero_id) {
      tasks.push(
        supabase.from("conductores_tercero").select("nombre,licencia,telefono").eq("id", ra.conductor_tercero_id).maybeSingle()
          .then(({ data }: any) => { if (data) setConductorInfo({ nombre: (data as any).nombre, numero_licencia: (data as any).licencia ?? null, telefono: (data as any).telefono || "" } as ConductorInfo); })
      );
    } else if (ra.empresa_tercerizada_id) {
      setConductorInfo({ nombre: "Conductor asignado", numero_licencia: null, telefono: "" } as ConductorInfo);
    }

    // Vehículo: propio (vehiculo_id → /api/cliente, RLS bloquea vehiculos al rol
    // anónimo) o tercerizado (vehiculo_tercero_id → vehiculos_tercero, lectura abierta).
    if (r.vehiculo_id) {
      tasks.push(
        portalApi("placas_vehiculos", { vehiculo_ids: [r.vehiculo_id] })
          .then(({ ok, data }) => { const placa = ok ? data?.vehiculos?.[0]?.placa : null; if (placa) setVehiculoInfo({ placa }); })
      );
    } else if (ra.vehiculo_tercero_id) {
      tasks.push(
        supabase.from("vehiculos_tercero").select("placa").eq("id", ra.vehiculo_tercero_id).maybeSingle()
          .then(({ data }: any) => { if (data) setVehiculoInfo({ placa: (data as any).placa }); })
      );
    }

    await Promise.all(tasks);
  }, [ppList]);

  // ─── Abrir modal GPS ──────────────────────────────────────────────────────
  const abrirGps = useCallback(async (r: Reserva) => {
    setGpsModalRes(r);
    setConductorInfo(null);
    setVehiculoInfo(null);

    // El modal dibuja las paradas de la cotización desde paradas_json, que ya no viene
    // en la lista: se trae para ESTE servicio (una fila) y se inyecta en la copia que
    // el modal tiene abierta. Si la reserva ya venía hidratada, no se vuelve a pedir.
    if (!(r as any).paradas_json) {
      traerParadasJson([r.id]).then(m => {
        const pj = m.get(r.id);
        if (!pj) return;
        setGpsModalRes(prev => (prev && prev.id === r.id ? ({ ...prev, paradas_json: pj } as Reserva) : prev));
        setReservas(prev => prev.map(x => x.id === r.id ? ({ ...x, paradas_json: pj } as Reserva) : x));
      });
    }

    const tasks: Promise<any>[] = [];

    if (!paradas[r.id]) {
      tasks.push(
        portalApi("paradas_reserva", { reserva_id: r.id })
          .then(({ ok, data }) => { if (ok) setParadas(prev => ({ ...prev, [r.id]: data.paradas || [] })); })
      );
    }

    const ra = r as any;
    if (r.conductor_id) {
      // Propio: conductor desde tabla conductores
      tasks.push(
        supabase.from("conductores").select("nombre,numero_licencia,telefono").eq("id", r.conductor_id).maybeSingle()
          .then(({ data }: any) => { if (data) setConductorInfo(data as ConductorInfo); })
      );
    } else if (ra.conductor_tercero_id) {
      // Tercerizado con conductor asignado (no revelar empresa al cliente)
      tasks.push(
        supabase.from("conductores_tercero").select("nombre,telefono").eq("id", ra.conductor_tercero_id).maybeSingle()
          .then(({ data }: any) => { if (data) setConductorInfo({ nombre: (data as any).nombre, telefono: (data as any).telefono || "" } as ConductorInfo); })
      );
    } else if (ra.empresa_tercerizada_id) {
      // Tercerizado sin conductor específico aún asignado
      setConductorInfo({ nombre: "Conductor asignado", telefono: "" } as ConductorInfo);
    }

    if (r.vehiculo_id) {
      tasks.push(
        portalApi("placas_vehiculos", { vehiculo_ids: [r.vehiculo_id] })
          .then(({ ok, data }) => { const placa = ok ? data?.vehiculos?.[0]?.placa : null; if (placa) setVehiculoInfo({ placa }); })
      );
    } else if (ra.vehiculo_tercero_id) {
      tasks.push(
        supabase.from("vehiculos_tercero").select("placa").eq("id", ra.vehiculo_tercero_id).maybeSingle()
          .then(({ data }: any) => { if (data) setVehiculoInfo({ placa: (data as any).placa }); })
      );
    }

    await Promise.all(tasks);
    setGpsModalOpen(true);
  }, [paradas, traerParadasJson]);

  // ─── Portal Usuarios CRUD ─────────────────────────────────────────────────
  // Todo el CRUD va por /api/cliente (service role + token): así las claves de los
  // colaboradores no dependen de que portal_usuarios sea legible/escribible por anon.
  const cargarColabs = useCallback(async (_clienteId: number) => {
    setLoadingColabs(true);
    const { ok, data } = await portalApi("colaboradores_listar");
    if (ok) setColabs((data.colaboradores || []) as PortalUsuario[]);
    setLoadingColabs(false);
  }, []);

  function resetColabForm() {
    setNewColabNombre(""); setNewColabDni(""); setNewColabEmail(""); setNewColabCargo("");
    setNewColabRol("visor"); setNewColabPass(""); setColabErr(""); setEditColab(null);
    setNewColabPermisos(MODULOS_CTRL.map(m => m.id).filter(id => id !== "facturacion"));
  }

  function abrirEditarColab(c: PortalUsuario) {
    setEditColab(c); setNewColabNombre(c.nombre); setNewColabDni(c.dni);
    setNewColabEmail(c.email || ""); setNewColabCargo(c.cargo || ""); setNewColabRol(c.rol);
    setNewColabPass(""); setColabErr(""); setModalColab(true);
    setNewColabPermisos(c.modulos_permitidos || MODULOS_CTRL.map(m => m.id));
  }

  async function guardarColab(clienteId: number) {
    if (!newColabNombre.trim() || !newColabDni.trim()) { setColabErr("Nombre y DNI son obligatorios"); return; }
    if (!editColab && !newColabPass.trim()) { setColabErr("La contraseña es obligatoria para nuevos usuarios"); return; }
    setColabErr(""); setColabLoad(true);
    const todosPermisos = MODULOS_CTRL.every(m => newColabPermisos.includes(m.id));
    const modulosGuardar = (newColabRol === "admin" && todosPermisos) ? null : newColabPermisos;
    const { ok, data } = await portalApi("colaboradores_guardar", {
      id: editColab?.id ?? 0,
      datos: {
        nombre: newColabNombre.trim(), dni: newColabDni.trim(), cargo: newColabCargo.trim() || null,
        rol: newColabRol, email: newColabEmail.trim() || null, modulos_permitidos: modulosGuardar,
        codigo_acceso: newColabPass.trim(),
      },
    });
    if (!ok) { setColabErr(data?.error || "No se pudo guardar. Intenta de nuevo."); setColabLoad(false); return; }
    await cargarColabs(clienteId);
    setModalColab(false); resetColabForm(); setColabLoad(false);
  }

  async function toggleColabActivo(id: number, activo: boolean) {
    const { ok } = await portalApi("colaboradores_toggle", { id });
    if (ok) setColabs(prev => prev.map(c => c.id === id ? { ...c, activo: !activo } : c));
  }

  async function eliminarColab(id: number, nombre: string, clienteId: number) {
    if (!window.confirm(`¿Eliminar definitivamente al usuario "${nombre}"? Esta acción no se puede deshacer.`)) return;
    await portalApi("colaboradores_eliminar", { id });
    await cargarColabs(clienteId);
  }

  // ─── Cargar stats de pasajeros para historial ─────────────────────────────
  // "esperados" = roster del manifiesto = unión de dos fuentes (igual que el
  // modal de manifiesto, que es la fuente de verdad):
  //   (A) pasajeros ad-hoc de la reserva           → pasajeros.reserva_id
  //   (B) pasajeros asignados a una parada         → pasajeros_parada → paradas
  // Se dedupe por pasajero_id (un pasajero con paradero existe en ambas tablas).
  //
  // IMPORTANTE: Supabase limita a 1000 filas por consulta. Con cientos de servicios
  // (cada uno con ~10 paradas) la antigua consulta de paradas .in() se truncaba a 1000
  // de 3000+ filas, y como no tenía orden fijo, qué servicios entraban variaba en cada
  // carga → muchos servicios mostraban manifiesto/pasajeros = 0 de forma intermitente.
  // Solución: (1) leer pasajeros_parada con join a paradas(reserva_id) para no traer las
  // paradas, y (2) paginar con orden estable para superar el tope de 1000.
  // El cómputo (unión A ∪ B paginada + esAbordado) vive ahora en /api/cliente
  // acción historial_stats (service role): RLS bloquea estas tablas al rol anónimo.
  // Los ids ya NO viajan en el body: el servidor los deriva del cliente_id del token,
  // con la misma ventana que la lista. Mandarlos era lo que rompía la pestaña (miles de
  // ids en el filtro → PostgREST 400 → stats vacías → reintento infinito).
  const cargarHistorialStats = useCallback(async () => {
    statsPedidosRef.current = true;   // el sello va PRIMERO: un fallo no debe reintentar solo
    setLoadingStats(true);
    const { ok, data } = await portalApi("historial_stats");
    if (ok) setReservaStats((data.stats || {}) as Record<number, { embarcados: number; esperados: number }>);
    setLoadingStats(false);
  }, []);

  // ─── Vehículos del cliente para mapa En vivo ──────────────────────────────
  const cargarVehiculosCliente = useCallback(async (_cid: number) => {
    // Una sola cadena en vuelo: son dos llamadas en serie (flota → GPS) y el tick de
    // 15 s podía lanzar la siguiente antes de que terminara la anterior.
    if (cargandoFlotaRef.current) return;
    cargandoFlotaRef.current = true;
    try {
    // La resolución reservas → placas (propios y de tercero, dedupe por separado)
    // vive en /api/cliente acción vehiculos_en_vivo (service role): RLS bloquea
    // reservas/vehiculos al rol anónimo.
    const { ok, data } = await portalApi("vehiculos_en_vivo");
    // Si la consulta falla o devuelve vacío, conserva el estado actual (falla transitoria).
    if (!ok) return;
    const vList  = (data.vehiculos || []) as {id:number;placa:string}[];
    const vtList = (data.vehiculos_tercero || []) as {id:number;placa:string}[];
    if (vList.length === 0 && vtList.length === 0) return;

    // GPS después de conocer la flota; los setState van juntos tras el fetch para
    // que el efecto de marcadores nunca vea un estado intermedio (flash "0 buses").
    const gpsJson = await fetch("/api/cliente/gps", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ vehiculoIds: vList.map(v => v.id), vehiculoTerceroIds: vtList.map(v => v.id) }),
    }).then(r => r.json()).catch(() => ({}));
    setVehiculosCliente(vList);
    setVehiculosTerceroCliente(vtList);

    const gpsLista = Array.isArray((gpsJson as any)?.ubicaciones) ? (gpsJson as any).ubicaciones : [];
    const keyDe = (g: any) =>
      g.conductor_tercero_id != null ? `ct${g.conductor_tercero_id}`
      : g.conductor_id != null        ? `c${g.conductor_id}`
      : g.vehiculo_tercero_id != null ? `vt${g.vehiculo_tercero_id}`
      : g.vehiculo_id != null         ? `v${g.vehiculo_id}`
      : g.reserva_id != null          ? `r${g.reserva_id}` : "?";
    // tiempo del punto: created_at o timestamp (lo más reciente de ambos)
    const tMs = (g: any) => Math.max(
      g?.created_at ? new Date(g.created_at).getTime() : 0,
      g?.timestamp  ? new Date(g.timestamp).getTime()  : 0,
    );
    // STICKY (igual que /seguimiento): conserva la última posición conocida de cada
    // vehículo. Un refresco que devuelve vacío o que omite un vehículo NUNCA borra
    // su marcador — solo se actualiza cuando llega un punto más reciente. Esto evita
    // que el bus "desaparezca" tras un F5 o un fetch transitorio vacío. Se descartan
    // puntos con más de 6 h de antigüedad para no arrastrar buses de servicios viejos.
    const MAX_EDAD_MS = 6 * 60 * 60 * 1000;
    setUbicacionesEnVivo(prev => {
      const merged: Record<string, any> = {};
      (prev as any[]).forEach(p => { merged[keyDe(p)] = p; });
      gpsLista.forEach((g: any) => {
        const k = keyDe(g);
        if (!merged[k] || tMs(g) >= tMs(merged[k])) merged[k] = g;
      });
      const ahora = Date.now();
      return Object.values(merged).filter((g: any) => ahora - tMs(g) <= MAX_EDAD_MS);
    });
    } finally { cargandoFlotaRef.current = false; }
  }, []);

  // ─── Cargar colabs cuando se abre la sección de usuarios ──────────────────
  useEffect(() => {
    if (cuentaSeccion === "usuarios" && cliente && colabs.length === 0 && !loadingColabs) {
      cargarColabs(cliente.id);
    }
  }, [cuentaSeccion, cliente, cargarColabs]);

  // ─── Cargar stats historial cuando se abre la pestaña ─────────────────────
  useEffect(() => {
    if (tab === "historial" && reservas.length > 0 && !statsPedidosRef.current) {
      cargarHistorialStats();
    }
  }, [tab, reservas.length, cargarHistorialStats]);

  // El rango vive aquí arriba porque lo necesitan tanto los efectos (para saber si hay
  // que pedirle datos al servidor) como el render de la pestaña Historial.
  const rango = rangoDePeriodo(periodo, getHoyPeru(), periodoDesde, periodoHasta);

  // ─── El periodo elegido se recuerda entre visitas ─────────────────────────
  useEffect(() => {
    try {
      const g = JSON.parse(localStorage.getItem("afa_cliente_periodo") || "null");
      if (g && PERIODOS.some(p => p.id === g.p)) {
        setPeriodo(g.p); setPeriodoDesde(g.d || ""); setPeriodoHasta(g.h || "");
      }
    } catch {}
  }, []);
  useEffect(() => {
    try {
      localStorage.setItem("afa_cliente_periodo", JSON.stringify({ p: periodo, d: periodoDesde, h: periodoHasta }));
    } catch {}
  }, [periodo, periodoDesde, periodoHasta]);

  // ─── Periodos que se salen de la ventana cargada ──────────────────────────
  // "datos" trae todo el pasado + DIAS_VENTANA_FUTURO. Un periodo dentro de eso se filtra
  // en el navegador, sin red. Uno que se pase (todo el año en curso, la programación de
  // 2027, "Todo") se pide al servidor una vez y queda en reservasExtra — sin esto, el
  // selector mostraría cero servicios y estaría mintiendo.
  useEffect(() => {
    if (tab !== "historial") return;
    const tope = sumarDias(getHoyPeru(), DIAS_VENTANA_FUTURO);
    if (rango.hasta !== null && rango.hasta <= tope) return;   // cabe en lo ya cargado
    const clave = `${rango.desde ?? ""}|${rango.hasta ?? ""}`;
    if (rangoPedidoRef.current === clave) return;              // ya se pidió este rango
    rangoPedidoRef.current = clave;
    setCargandoRango(true);
    portalApi("reservas_rango", { desde: rango.desde, hasta: rango.hasta })
      .then(({ ok, data }) => {
        if (ok && Array.isArray(data?.reservas)) {
          setReservasExtra(prev => {
            const m = new Map<number, Reserva>();
            prev.forEach(r => m.set(r.id, r));
            (data.reservas as Reserva[]).forEach(r => m.set(r.id, r));
            return [...m.values()];
          });
        } else {
          rangoPedidoRef.current = "";                         // falló: que se pueda reintentar
        }
      })
      .finally(() => setCargandoRango(false));
  }, [tab, rango.desde, rango.hasta]);

  // ─── Redirección si el tab actual no está permitido ───────────────────────
  useEffect(() => {
    if (portalUsuario?.modulos_permitidos && tab !== "dashboard" && !portalUsuario.modulos_permitidos.includes(tab)) {
      setTab("dashboard");
    }
  }, [portalUsuario, tab]);

  // ─── Helper de permiso ────────────────────────────────────────────────────
  const tienePermiso = (modulo: string) => {
    if (modulo === "dashboard") return true;
    if (!portalUsuario?.modulos_permitidos) return true;
    return portalUsuario.modulos_permitidos.includes(modulo);
  };
  // Usuarios sin acceso a "facturacion" no ven montos ni precios en ninguna vista
  const puedeVerMontos = tienePermiso("facturacion");

  // ─── Auto-refresh reservas cada 30s cuando hay servicio hoy ───────────────
  // Silencioso: revalida en segundo plano sin devolver la pantalla a los esqueletos.
  // La dependencia es el BOOLEANO, no el array: con `reservas` entero el intervalo se
  // destruía y recreaba en cada refresco, así que su cuenta volvía a empezar cada vez.
  const hayServicioHoy = reservas.some(r => r.fecha_servicio?.startsWith(getHoyPeru()) && !["cancelado","cancelada"].includes(r.estado));
  useEffect(() => {
    if (!cliente || !hayServicioHoy) return;
    const iv = setInterval(() => { if (!document.hidden) cargarDatos(cliente.id, true); }, 30000);
    return () => clearInterval(iv);
  }, [cliente, hayServicioHoy, cargarDatos]);

  // ─── Refrescar al volver a la pestaña del navegador ───────────────────────
  // También silencioso, y con la guarda de frescura de cargarDatos: un alt-tab ya no
  // vacía el dashboard para volver a llenarlo con lo mismo.
  useEffect(() => {
    if (!cliente) return;
    const onVisible = () => { if (document.visibilityState === "visible") cargarDatos(cliente.id, true); };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [cliente, cargarDatos]);

  // ─── Realtime GPS ─────────────────────────────────────────────────────────
  // postgres_changes NO soporta OR de columnas. Para servicios de tercero el GPS
  // puede llegar con vehiculo_id null (y vehiculo_tercero_id seteado) o con el id
  // de tercero dentro de vehiculo_id (puntos viejos): por eso suscribimos por
  // reserva_id (llave no ambigua) cuando hay reserva activa, y por vehiculo_id
  // como fallback para los servicios propios sin reserva conocida.
  useEffect(() => {
    if (!reservaActivaId && !vehiculoActivo) return;
    const usarReserva = reservaActivaId != null;
    const filter = usarReserva ? `reserva_id=eq.${reservaActivaId}` : `vehiculo_id=eq.${vehiculoActivo}`;
    const ch = supabase.channel(`cliente-gps-${usarReserva ? `r${reservaActivaId}` : `v${vehiculoActivo}`}`)
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "ubicaciones_gps", filter },
        (payload: any) => setGpsActual(payload.new as GPS))
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [reservaActivaId, vehiculoActivo]);

  // ─── Realtime reservas (cambios de estado en tiempo real) ─────────────────
  useEffect(() => {
    if (!cliente) return;
    const ch = supabase.channel(`cliente-reservas-${cliente.id}`)
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "reservas", filter: `cliente_id=eq.${cliente.id}` },
        (payload: any) => {
          const updated = payload.new as Reserva;
          setReservas(prev => prev.map(r => r.id === updated.id ? { ...r, ...updated } : r));
          // Si el servicio activo ahora tiene conductor/vehículo, cargarlos
          const hoy = getHoyPeru();
          if (updated.fecha_servicio?.startsWith(hoy) && !["cancelado","cancelada"].includes(updated.estado)) {
            // reserva_id es la llave no ambigua para el GPS en vivo (también terceros)
            setReservaActivaId(updated.id);
            if (updated.conductor_id) {
              supabase.from("conductores").select("nombre,numero_licencia,telefono").eq("id", updated.conductor_id).maybeSingle()
                .then(({ data }: any) => { if (data) setConductorInfo(data as ConductorInfo); });
            }
            if (updated.vehiculo_id) {
              setVehiculoActivo(updated.vehiculo_id);
              portalApi("placas_vehiculos", { vehiculo_ids: [updated.vehiculo_id] })
                .then(({ ok, data }) => { const placa = ok ? data?.vehiculos?.[0]?.placa : null; if (placa) setVehiculoInfo({ placa }); });
            }
          }
        })
      .subscribe();
    return () => { supabase.removeChannel(ch); };
  }, [cliente]);

  // ─── Cargar GPS en vivo al abrir En vivo o el Dashboard ───────────────────
  // El dashboard también lo necesita: las cards "EN CURSO" deciden qué servicios
  // están en ruta a partir de ubicacionesEnVivo (no de reservas.estado).
  useEffect(() => {
    if ((tab === "activos" || tab === "dashboard") && cliente) cargarVehiculosCliente(cliente.id);
  }, [tab, cliente, cargarVehiculosCliente]);

  // ─── Refresco periódico GPS cada 15s (En vivo + Dashboard) ────────────────
  useEffect(() => {
    if ((tab !== "activos" && tab !== "dashboard") || !cliente) return;
    const iv = setInterval(() => cargarVehiculosCliente(cliente.id), 15000);
    return () => clearInterval(iv);
  }, [tab, cliente, cargarVehiculosCliente]);

  // ─── Mapa En vivo: inicializar / destruir Mapbox ──────────────────────────
  useEffect(() => {
    if (tab !== "activos") {
      if (mapRef.current) { mapRef.current.remove(); mapRef.current = null; }
      Object.values(markersEnVivo.current).forEach(m => m.remove());
      markersEnVivo.current = {};
      stopMarkersRef.current.forEach(m => m.remove());
      stopMarkersRef.current = [];
      dibujoLayersRef.current = [];
      dibujoSourcesRef.current = [];
      lastFitRef.current = null;
      autocentradoRef.current = false;
      setMapListoEnVivo(false);
      return;
    }
    // El motor de mapbox se descarga AQUÍ, la primera vez que se entra a "En vivo".
    // `cancelado` cubre el caso de salir de la pestaña mientras el chunk viaja: sin él
    // se crearía un mapa sobre un contenedor que React ya desmontó.
    let cancelado = false;
    const t = setTimeout(() => {
      cargarMapbox().then(gl => {
        if (cancelado || !mapContainerRef.current || mapRef.current) return;
        const m = new gl.Map({
          container: mapContainerRef.current,
          style: "mapbox://styles/mapbox/streets-v12",
          center: [-77.0428, -12.0464],
          zoom: 11,
        });
        m.addControl(new gl.NavigationControl(), "top-right");
        m.on("load", () => setMapListoEnVivo(true));
        mapRef.current = m;
      }).catch(() => {});
    }, 80);
    return () => { cancelado = true; clearTimeout(t); };
  }, [tab]);

  // ─── Mapa En vivo: actualizar marcadores cuando cambian ubicaciones ────────
  useEffect(() => {
    if (!mapListoEnVivo || !mapRef.current) return;
    const vistos = new Set<string>();
    // UNA sola fila representa al servicio seleccionado (la misma que elige el draw effect con
    // .find): el merge sticky puede retener varias filas del mismo vehículo con llaves distintas,
    // y si todas snapearan compartirían snapIconoCliRef (continuidad envenenada entre filas).
    const saSel: any = rutaSelId != null ? (serviciosHoyRef.current || []).find((r: any) => r.id === rutaSelId) : null;
    const uSel = saSel ? ubicacionesEnVivo.find(u =>
      (u.reserva_id != null && Number(u.reserva_id) === saSel.id) ||
      (saSel.vehiculo_id != null && u.vehiculo_id === saSel.vehiculo_id) ||
      (saSel.vehiculo_tercero_id != null && u.vehiculo_tercero_id === saSel.vehiculo_tercero_id)) : null;
    ubicacionesEnVivo.forEach(u => {
      // Key compuesta: prioriza conductor/vehículo de tercero sobre los propios.
      // Evita colisiones cuando vehiculo_id es null (puntos de tercero) o cuando
      // ids de tercero y propios se solapan.
      const key =
        (u as any).conductor_tercero_id != null ? `ct${(u as any).conductor_tercero_id}`
        : u.conductor_id != null                ? `c${u.conductor_id}`
        : u.vehiculo_tercero_id != null         ? `vt${u.vehiculo_tercero_id}`
        : u.vehiculo_id != null                 ? `v${u.vehiculo_id}`
        : `r${u.reserva_id}`;
      // Placa: propia o de tercero (indistinguibles para el cliente). Nunca se
      // muestra "(tercero)" ni nada que delate un servicio tercerizado.
      const v = u.vehiculo_id != null
        ? vehiculosCliente.find(x => x.id === u.vehiculo_id)
        : u.vehiculo_tercero_id != null
          ? vehiculosTerceroCliente.find(x => x.id === u.vehiculo_tercero_id)
          : undefined;
      const placa = v?.placa || "Vehículo en ruta";
      const min = Math.floor((Date.now() - new Date(u.timestamp).getTime()) / 60000);
      const color = min <= 2 ? "#16a34a" : min <= 10 ? "#d97706" : "#dc2626";
      const label = min <= 2 ? "En línea" : min <= 10 ? `Hace ${min}m` : "Sin señal";
      vistos.add(key);
      const popupHtml = `<div style="font-family:system-ui,sans-serif;padding:2px 0"><b style="font-size:13px;color:#0a0e1a">${placa}</b><br><span style="font-size:12px;color:${color};font-weight:600">${label}</span><br><span style="font-size:11px;color:#6b6f7c">${u.velocidad} km/h</span></div>`;

      // Ícono PEGADO a la vía para el servicio SELECCIONADO (tiene ruta+trazo cargados): con GPS
      // de red el bus no camina sobre techos. Corrección acotada por la imprecisión del fix
      // (pegarIconoAVia); los demás buses (sin contexto de ruta) quedan en su fix crudo.
      let pos: [number, number] = [u.lng, u.lat];
      let caminoSel: [number, number][] | null = null;   // camino de VÍA entre el snap anterior y el nuevo (tween por la calle)
      let dSnapSel: number | null = null;                // desplazamiento del snap del bus SELECCIONADO (null = no es el seleccionado)
      if (uSel != null && u === uSel && saSel) {
        const prev = snapIconoCliRef.current?.rid === saSel.id ? snapIconoCliRef.current : null;
        const r = pegarIconoAVia(Number(u.lat), Number(u.lng), Number((u as any).precision_m) || 25, {
          ruta: rutasEnVivoRef.current[saSel.id],
          trail: matchedEnVivoRefMap.current[saSel.id] || undefined,
          trailEsCrudo: esCrudoEnVivoRefMap.current[saSel.id],
          prev, prevS: prev?.s ?? null,
        });
        snapIconoCliRef.current = { rid: saSel.id, lat: r.lat, lng: r.lng, s: r.s };
        pos = [r.lng, r.lat];
        // Tween POR LA VÍA (mismo fix que ModalGps, ago-2026): la recta entre dos snaps cortaba la
        // esquina y el bus "volaba" sobre la manzana. Solo con camino fiable; si no, recta de siempre.
        if (prev) {
          dSnapSel = distM(prev.lat, prev.lng, r.lat, r.lng);
          if (dSnapSel > 12 && dSnapSel < 1200) caminoSel = caminoEntreSnaps(prev, r, rutasEnVivoRef.current[saSel.id]);
        }
      }

      // Si el marcador ya existe: deslizarlo suave (tween) y refrescar rumbo, color y popup.
      const existente = markersEnVivo.current[key];
      if (existente) {
        const rumboNum = Number(u.rumbo);
        if (caminoSel) {
          // Desliza por la calle rotando con cada segmento; al final asienta el rumbo real del
          // equipo si lo hay (>0). Sin rumbo real, se queda mirando el último segmento de vía.
          animarMarcadorPorCamino(existente, caminoSel, { rumboFinal: rumboNum > 0 ? rumboNum : undefined });
        } else if (dSnapSel != null && dSnapSel < 1 && tweenEnVuelo(existente)) {
          // Re-render SIN fix nuevo (el poll rearma los arrays cada 15 s / botón Actualizar): NO
          // cancelar el tween por camino en vuelo con una recta ni pisar el rumbo de la calle —
          // solo se refrescan color del pulso y popup, abajo (review ago-2026).
        } else {
          animarMarcador(existente, pos);
          // Bus SELECCIONADO sin rumbo real del equipo: conservar la rotación actual (el tween
          // por camino la dejó alineada a la calle) en vez de resetear a 0/norte en cada parada.
          // Los demás buses (sin contexto de ruta) quedan idénticos a antes.
          if (dSnapSel != null && !(rumboNum > 0)) existente.setRotation(existente.getRotation?.() ?? 0);
          else existente.setRotation(rumboNum || 0);
        }
        existente.getElement().querySelectorAll<HTMLElement>(".afa-pulse1, .afa-pulse2").forEach(d => { d.style.background = color; });
        existente.getPopup()?.setHTML(popupHtml);
        return;
      }

      // CSS de los anillos de pulso (igual que la página de seguimiento), una sola vez.
      if (!document.getElementById("afa-bus-css")) {
        const s = document.createElement("style");
        s.id = "afa-bus-css";
        s.textContent = `
          @keyframes afaBusPulse {
            0%   { transform:scale(1);   opacity:.5; }
            65%  { transform:scale(2.6); opacity:0;  }
            100% { transform:scale(2.6); opacity:0;  }
          }
          @keyframes afaBusPulse2 {
            0%   { transform:scale(1);   opacity:.3; }
            65%  { transform:scale(2.6); opacity:0;  }
            100% { transform:scale(2.6); opacity:0;  }
          }
          .afa-pulse1 { position:absolute; border-radius:50%;
            animation:afaBusPulse  2s ease-out infinite; pointer-events:none; }
          .afa-pulse2 { position:absolute; border-radius:50%;
            animation:afaBusPulse2 2s ease-out .7s infinite; pointer-events:none; }
        `;
        document.head.appendChild(s);
      }

      // Marcador del bus: mismo ícono 3D y anillos de pulso que la vista de
      // seguimiento. El color de los anillos refleja el estado de la señal GPS.
      const el = document.createElement("div");
      el.style.cssText = "position:relative;width:74px;height:74px;cursor:pointer;";
      el.innerHTML = `
        <div style="position:absolute;top:50%;left:50%;width:42px;height:42px;margin:-21px 0 0 -21px;">
          <div class="afa-pulse1" style="inset:0;background:${color};"></div>
          <div class="afa-pulse2" style="inset:0;background:${color};"></div>
        </div>
        <img src="/bussinfondo3.png"
          style="position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);z-index:2;width:44px;height:74px;object-fit:contain;filter:drop-shadow(0 5px 14px rgba(6,14,40,.85));"
          alt="bus"/>
      `;
      const popup = new mapboxgl.Popup({ offset: 28, closeButton: false }).setHTML(popupHtml);
      markersEnVivo.current[key] = new mapboxgl.Marker({
        element: el,
        rotation: Number(u.rumbo) || 0,
        rotationAlignment: "map",
        anchor: "center",
      })
        .setLngLat(pos)
        .setPopup(popup)
        .addTo(mapRef.current!);
    });
    // Quitar marcadores de móviles que ya no aparecen en el lote (desconectados).
    Object.keys(markersEnVivo.current).forEach(k => {
      if (!vistos.has(k)) { markersEnVivo.current[k].remove(); delete markersEnVivo.current[k]; }
    });
    // Mantener ref actualizada para el efecto de chip-click
    ubicacionesEnVivoRef.current = ubicacionesEnVivo;
    // Auto-centrar una sola vez al llegar el primer lote de GPS
    if (!autocentradoRef.current && ubicacionesEnVivo.length > 0 && mapRef.current) {
      autocentradoRef.current = true;
      if (ubicacionesEnVivo.length === 1) {
        mapRef.current.flyTo({ center: [ubicacionesEnVivo[0].lng, ubicacionesEnVivo[0].lat], zoom: 14, duration: 900 });
      } else {
        const b = new mapboxgl.LngLatBounds();
        ubicacionesEnVivo.forEach(u => b.extend([u.lng, u.lat]));
        try { mapRef.current.fitBounds(b, { padding: 80, maxZoom: 15, duration: 900 }); } catch {}
      }
    }
  }, [ubicacionesEnVivo, vehiculosCliente, vehiculosTerceroCliente, mapListoEnVivo, rutaSelId]); // rutaSelId: al (de)seleccionar, el snap del ícono aplica/se quita al instante

  // ─── En vivo: centrar en el bus del chip seleccionado ────────────────────
  useEffect(() => {
    if (!rutaSelId || !mapListoEnVivo || !mapRef.current) return;
    const sel = serviciosHoyRef.current.find(r => r.id === rutaSelId);
    if (!sel) return;
    const gps = ubicacionesEnVivoRef.current.find(u =>
      (sel.vehiculo_id != null && u.vehiculo_id === sel.vehiculo_id) ||
      ((sel as any).vehiculo_tercero_id != null && u.vehiculo_tercero_id === (sel as any).vehiculo_tercero_id)
    );
    if (!gps) return;
    // Centrar en la posición PEGADA a la vía si ya existe para este servicio (donde se dibuja el ícono).
    const c = snapIconoCliRef.current?.rid === rutaSelId ? snapIconoCliRef.current : { lat: gps.lat, lng: gps.lng };
    mapRef.current.flyTo({ center: [c.lng, c.lat], zoom: 14, duration: 900 });
  }, [rutaSelId, mapListoEnVivo]);

  // ─── En vivo: limpiar selección si el servicio elegido ya no existe ───────
  useEffect(() => {
    setRutaSelId(prev => (prev != null && !serviciosHoyRef.current.some(r => r.id === prev) ? null : prev));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reservas.length]);

  // ─── Dashboard + En vivo: cargar paradas de servicios de hoy ─────────────
  useEffect(() => {
    if (tab !== "activos" && tab !== "dashboard") return;
    serviciosHoyRef.current.forEach(async r => {
      if (paradas[r.id] !== undefined) return;
      const { ok, data } = await portalApi("paradas_reserva", { reserva_id: r.id });
      if (!ok) return; // falla transitoria: reintentará el próximo ciclo
      // Siempre registrar (aunque sea []) para distinguir "sin paradas" de "no cargado"
      setParadas(prev => ({ ...prev, [r.id]: (data.paradas || []) as Parada[] }));
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reservas.length]);

  // ─── Dashboard: conductor / vehículo / GPS por servicio destacado ─────────
  useEffect(() => {
    if (tab !== "dashboard") return;
    // Carga datos para TODOS los servicios de hoy (no un solo turno) y los refresca
    // cada 15s: así cualquiera que esté en ruta ahora tiene conductor/placa/GPS listos
    // para su card EN CURSO.
    const cargar = () => serviciosHoyRef.current.forEach(async r => {
      const ra = r as any;
      // Conductor
      if (!(r.id in condInfoMap)) {
        let nombre = "", tel = "";
        if (ra.conductor_id) {
          const { data } = await supabase.from("conductores").select("nombre,telefono").eq("id", ra.conductor_id).maybeSingle();
          if (data) { nombre = (data as any).nombre || ""; tel = (data as any).telefono || ""; }
        } else if (ra.conductor_tercero_id) {
          const { data } = await supabase.from("conductores_tercero").select("nombre,telefono").eq("id", ra.conductor_tercero_id).maybeSingle();
          if (data) { nombre = (data as any).nombre || ""; tel = (data as any).telefono || ""; }
        }
        setCondInfoMap(prev => ({ ...prev, [r.id]: { nombre: nombre || "Conductor asignado", tel } }));
      }
      // Vehículo: vehiculo_id → tabla vehiculos; vehiculo_tercero_id → tabla vehiculos_tercero
      if (!(r.id in vehPlacaMap)) {
        if (r.vehiculo_id) {
          const { ok, data } = await portalApi("placas_vehiculos", { vehiculo_ids: [r.vehiculo_id] });
          const placa = ok ? data?.vehiculos?.[0]?.placa : null;
          if (placa) setVehPlacaMap(prev => ({ ...prev, [r.id]: placa }));
        } else if (ra.vehiculo_tercero_id) {
          const { data } = await supabase.from("vehiculos_tercero").select("placa").eq("id", ra.vehiculo_tercero_id).maybeSingle();
          if ((data as any)?.placa) setVehPlacaMap(prev => ({ ...prev, [r.id]: (data as any).placa }));
        }
      }
      // GPS más reciente de esta reserva
      // `created_at` y `estado` viajan también: sin la edad del fix no se puede distinguir un bus
      // en marcha de uno cuyo GPS murió hace una hora, y el ETA de la tarjeta se refrescaba
      // igual (comprando llamadas caras a Google para pintar una hora imposible).
      const { data: gd } = await supabase.from("ubicaciones_gps")
        .select("lat,lng,velocidad,estado,created_at").eq("reserva_id", r.id)
        .order("created_at", { ascending: false }).limit(1).maybeSingle();
      const g = gd as { lat?: unknown; lng?: unknown; velocidad?: unknown; estado?: string | null; created_at?: string | null } | null;
      if (g?.lat && g?.lng) {
        setGpsCardMap(prev => ({ ...prev, [r.id]: {
          lat: Number(g.lat), lng: Number(g.lng),
          velocidad: Number(g.velocidad) || 0,
          estado: g.estado || null,
          ts: g.created_at ? new Date(g.created_at).getTime() : 0,
        } }));
      } else {
        setGpsCardMap(prev => ({ ...prev, [r.id]: null }));
      }
    });
    cargar();
    const iv = setInterval(cargar, 15000);
    return () => clearInterval(iv);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, reservas.length]);

  // ─── Dashboard: ETA al destino con tráfico real ──────────────────────────────
  // ANTES se calculaba UNA sola vez por reserva y por sesión (`if (rid in etaDestinoMap) return`)
  // y se pintaba en verde con la leyenda "con tráfico real" aunque llevara horas congelado: el
  // cliente veía una hora de hace tres horas presentada como si fuera en vivo. Ahora se refresca,
  // pero el refresco es CARO (Directions Advanced, sin caché), así que va con tres candados de
  // gasto y solo para servicios que de verdad están en marcha. Ver la memoria de costos de Google.
  useEffect(() => {
    // "dashboard" y NO "activos": la tarjeta que muestra esta hora vive en el dashboard, y
    // `gpsCardMap` —su única fuente— solo se rellena mientras esa pestaña está activa. Calcularlo
    // en otra pestaña gastaría llamadas de Google sobre un GPS que ya no se refresca, para
    // pintarlas donde nadie las ve.
    if (tab !== "dashboard") return;

    const MS_REFRESCO_CARD  = 180_000; // por reserva — mismo criterio que el modal
    const MS_PISO_GLOBAL    = 20_000;  // entre DOS llamadas cualesquiera: acota ráfagas con N servicios
    const MAX_ETA_SESION    = 150;     // techo por pestaña: una pestaña olvidada no puede vaciar la cuota
    const MS_FIX_FRESCO     = 300_000; // GPS más viejo que esto = no hay nada que estimar

    const calcularUno = async (rid: number, gps: NonNullable<typeof gpsCardMap[number]>) => {
      // El sello va PRIMERO y en todos los caminos: `ronda` elige un solo candidato y corta, así
      // que una reserva que salga temprano sin sellar (sin destino geocodificado, por ejemplo) se
      // vuelve a elegir cada 30 s y deja sin ETA a todas las demás tarjetas, para siempre.
      etaCalcRef.current[rid] = Date.now();
      const r = serviciosHoyRef.current.find(x => x.id === rid);
      if (!r) return;
      const pjson = (r as any).paradas_json as any[] | null;
      const ps = paradas[rid] || [];
      const psAll: Parada[] = ps.length > 0 ? ps
        : (pjson || []).filter((p: any) => p.nombre).map((p: any, i: number) => ({
            id: -(i+1), reserva_id: rid, orden: i+1, nombre: p.nombre, direccion: null,
            lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
            hora_estimada: p.hora || null, estado: "pendiente",
          } as Parada));
      const destino = psAll[psAll.length - 1];
      const marcar = (v: { hora: string | null; alejando: boolean }) =>
        setEtaDestinoMap(prev => ({ ...prev, [rid]: { ...v, ts: Date.now() } }));
      if (!destino?.lat || !destino?.lng) { marcar({ hora: null, alejando: false }); return; }

      etaUltimaRef.current = Date.now();
      etaGastoRef.current++;
      // Distancia en línea recta: es gratis y es la referencia para detectar la vuelta en U.
      const dRectaM = distM(gps.lat, gps.lng, Number(destino.lat), Number(destino.lng));
      try {
        // conTrafico: aquí SÍ hace falta (ETA en vivo bus → destino). Es el único punto de
        // esta pantalla que usa el SKU caro de Google y no se cachea — de ahí los candados.
        const res = await fetch("/api/ruta", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ conTrafico: true, paradas: [
            { lat: gps.lat, lng: gps.lng, nombre: "Posición actual" },
            { lat: destino.lat, lng: destino.lng, nombre: destino.nombre },
          ]}),
        });
        const data = await res.json();
        // PRUEBA DE CORDURA: un trayecto desproporcionado respecto de la recta no es un
        // trayecto, es una vuelta en U — el destino quedó detrás del vehículo.
        // El umbral NO se aplica cerca del destino: a 120 m en línea recta, un retorno normal
        // por el puente siguiente da 3 km y el cociente se dispara con el bus ENTRANDO. Por
        // debajo de 1 km la razón rodeo/recta no distingue nada, así que no se afirma.
        const rodeoAbsurdo = typeof data.total_km === "number" &&
          dRectaM > 1000 && data.total_km * 1000 > dRectaM * 3 + 2000;
        if (rodeoAbsurdo) {
          marcar({ hora: null, alejando: true });
          return;
        }
        if (typeof data.total_min === "number") {
          const llegada = new Date(Date.now() + data.total_min * 60 * 1000);
          // Ajustar a hora Lima (UTC-5)
          const limaMs = llegada.getTime() - 5 * 60 * 60 * 1000;
          const limaDate = new Date(limaMs);
          const h = String(limaDate.getUTCHours()).padStart(2, "0");
          const m = String(limaDate.getUTCMinutes()).padStart(2, "0");
          marcar({ hora: `${h}:${m}`, alejando: false });
        } else {
          marcar({ hora: null, alejando: false });
        }
      } catch { /* conservar el valor previo: un fallo de red no debe borrar la hora */ }
    };

    const ronda = () => {
      // La pestaña oculta no mira nada: no se compran llamadas en segundo plano.
      if (document.hidden) return;
      if (etaGastoRef.current >= MAX_ETA_SESION) return;
      const ahora = Date.now();
      if (ahora - etaUltimaRef.current < MS_PISO_GLOBAL) return;
      for (const [idStr, gps] of Object.entries(gpsCardMap)) {
        if (!gps) continue;
        const rid = Number(idStr);
        // Sin fix fresco o con el servicio terminado no hay hora de llegada que estimar; el
        // valor anterior se conserva y la UI lo etiqueta como viejo.
        if (gps.estado === "finalizado") continue;
        if (gps.ts > 0 && ahora - gps.ts > MS_FIX_FRESCO) continue;
        if (ahora - (etaCalcRef.current[rid] || 0) < MS_REFRESCO_CARD) continue;
        void calcularUno(rid, gps);
        return;   // UNA por ronda: el piso global hace el resto del reparto
      }
    };

    ronda();
    const iv = setInterval(ronda, 30_000);
    const alVolver = () => ronda();
    document.addEventListener("visibilitychange", alVolver);
    return () => { clearInterval(iv); document.removeEventListener("visibilitychange", alVolver); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, gpsCardMap]);

  // ─── En vivo: CAPA 1 — ruta planificada (geocodifica paradas → Google) ───
  useEffect(() => {
    if (tab !== "activos" || !mapListoEnVivo) return;
    serviciosHoyRef.current.forEach(async r => {
      if (rutasEnVivoMap[r.id] !== undefined) return; // ya intentado (puede ser [])
      if (paradas[r.id] === undefined) return;        // esperar a que carguen las paradas

      const tabla = [...(paradas[r.id] || [])].sort((a, b) => a.orden - b.orden);
      const pjson = (r as any).paradas_json as any[] | null;

      // 1. Construir lista base de paradas (preferir tabla, luego paradas_json, luego origen/destino)
      let lista: Parada[] = [];
      if (tabla.length > 0) {
        lista = tabla;
      } else if (pjson?.length) {
        const ord = [...pjson.filter((p: any) => p.tipo === "inicio"), ...pjson.filter((p: any) => p.tipo === "intermedia"), ...pjson.filter((p: any) => p.tipo === "destino")];
        const fuente = ord.length ? ord : pjson;
        lista = fuente.map((p: any, i: number) => ({ id: -(i + 1), reserva_id: r.id, orden: i + 1, nombre: p.nombre, direccion: p.direccion || null, lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null, hora_estimada: p.hora || null, estado: "pendiente" }));
      } else if (r.origen && r.destino) {
        lista = [
          { id: -1, reserva_id: r.id, orden: 1, nombre: r.origen,  direccion: null, lat: null, lng: null, hora_estimada: null, estado: "pendiente" },
          { id: -2, reserva_id: r.id, orden: 2, nombre: r.destino, direccion: null, lat: null, lng: null, hora_estimada: null, estado: "pendiente" },
        ];
      } else { setRutasEnVivoMap(prev => ({ ...prev, [r.id]: [] })); return; }

      // 2. Rellenar coords faltantes con las EXACTAS de paradas_json (datos de la cotización)
      if (pjson?.length) {
        const byNombre = new Map<string, { lat: number; lng: number }>();
        pjson.forEach((p: any) => { if (p.lat && p.lng) byNombre.set(String(p.nombre || "").trim().toLowerCase(), { lat: Number(p.lat), lng: Number(p.lng) }); });
        lista = lista.map(p => {
          if (p.lat && p.lng) return p;
          const c = byNombre.get(String(p.nombre || "").trim().toLowerCase());
          return c ? { ...p, lat: c.lat, lng: c.lng } : p;
        });
      }

      // 3. Geocodificar SOLO las que sigan sin coordenadas (último recurso)
      const faltan = lista.filter(p => !p.lat || !p.lng);
      if (faltan.length > 0) {
        try {
          // El id que va aquí es SINTÉTICO y negativo (paradas armadas desde paradas_json /
          // origen-destino, que no existen en la tabla `paradas`): sirve solo para reasociar la
          // respuesta en memoria, por eso las coords no se persisten. No factura de más igual:
          // el servidor cachea por TEXTO de dirección y memoriza los fallos.
          const gr = await fetch("/api/geocodificar", {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ paradas: faltan.map(p => ({ id: p.id, nombre: p.direccion || p.nombre })) }),
          });
          const gd = await gr.json();
          if (gd.paradas) {
            const m = new Map<number, { lat: number | null; lng: number | null }>(gd.paradas.map((p: any) => [p.id, { lat: p.lat, lng: p.lng }]));
            lista = lista.map(p => { const c = m.get(p.id); return c && c.lat ? { ...p, lat: c.lat, lng: c.lng } : p; });
          }
        } catch {}
      }

      const conCoords = lista.filter(p => p.lat && p.lng);
      // Guardar paradas resueltas (con coords) para los marcadores del mapa
      setParadasResueltasMap(prev => ({ ...prev, [r.id]: conCoords }));

      if (conCoords.length < 2) { setRutasEnVivoMap(prev => ({ ...prev, [r.id]: [] })); return; }

      try {
        // SIN conTrafico (default): es la ruta PLANIFICADA del contrato, el tráfico de ahora da
        // igual. Así cae en el SKU barato y el servidor la cachea en Postgres por firma
        // geográfica → tras la primera carga este bucle ya no llega a Google (sobrevive al F5).
        const res = await fetch("/api/ruta", {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            paradas: conCoords.map(p => ({
              lat: typeof p.lat === "string" ? parseFloat(p.lat as any) : p.lat,
              lng: typeof p.lng === "string" ? parseFloat(p.lng as any) : p.lng,
              nombre: p.nombre,
            })),
          }),
        });
        const data = await res.json();
        setRutasEnVivoMap(prev => ({ ...prev, [r.id]: data.coordenadas?.length ? data.coordenadas : [] }));
      } catch { setRutasEnVivoMap(prev => ({ ...prev, [r.id]: [] })); }
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, mapListoEnVivo, JSON.stringify(Object.keys(paradas)), reservas.length]);

  useEffect(() => { rutasEnVivoRef.current = rutasEnVivoMap; }, [rutasEnVivoMap]); // el loop del puente lee rutasEnVivoRef

  // ─── En vivo: CAPA 2 — huella GPS real del servicio SELECCIONADO ─────────
  useEffect(() => {
    if (tab !== "activos" || rutaSelId == null) return;
    let cancel = false;
    const token = process.env.NEXT_PUBLIC_MAPBOX_TOKEN || "";
    const cargarHuella = async (rid: number) => {
      if (cargandoHuellaCliRef.current) return;   // ciclo anterior aún en vuelo → saltar este tick
      cargandoHuellaCliRef.current = true;
      try {
      // PAGINADO (paginarFilas): PostgREST recorta al max-rows del servidor (1000) aunque se
      // pida .limit(5000) → la huella se congelaba en el punto 1000 en viajes largos.
      const data = await paginarFilas(() =>
        supabase.from("ubicaciones_gps")
          .select("lat,lng,velocidad,rumbo,precision_m,created_at,timestamp")
          .eq("reserva_id", rid)
          .order("created_at", { ascending: true }).order("id", { ascending: true }));
      if (cancel) return;
      const filas = (data || []).filter((p: any) => p.lat && p.lng);
      // Anclar imprecisos al corredor confiable (mata el zigzag off-road) + limpieza de jitter
      // (mismo motor que el modal): colapsa rachas detenidas, dedup en marcha.
      const crudos = anclarImprecisos(filasAPuntos(filas));
      const limpio = conVelocidadColor(limpiarHuella(crudos));
      // `acc` viaja con cada punto → el dibujo marca `aprox` las cuerdas >60 m con extremo crudo.
      setHuellaGpsMap(prev => ({ ...prev, [rid]: limpio.map(p => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad, ts: null, acc: p.acc })) }));
      // Puntitos de telemetría real (~cada 100 m, anclados a muestra real) — Idea 2.
      setTelemetriaMap(prev => ({ ...prev, [rid]: puntosTelemetria(limpio, crudos) }));
      // Resumen del viaje: se calcula MÁS ABAJO (tras el loop de puentes) para que el badge "Rastreo %"
      // cuente los tramos ruteados como ESTIMADO, no como medido.
      // Map Matching por ventanas (pegado a la pista) — throttle/congelado interno del ajustador.
      if (!ajustadoresRef.current[rid]) ajustadoresRef.current[rid] = crearAjustadorHuella();
      const matched = await ajustadoresRef.current[rid].ajustar(limpio, token, () => cancel);
      if (matched && !cancel) { const ec = ajustadoresRef.current[rid].leerEsCrudo(); esCrudoEnVivoRefMap.current[rid] = ec; setMatchedEnVivoMap(prev => ({ ...prev, [rid]: matched })); setEsCrudoEnVivoMap(prev => ({ ...prev, [rid]: ec })); matchedEnVivoRefMap.current[rid] = matched; }
      if (!cancel) setColaSnappedMap(prev => ({ ...prev, [rid]: ajustadoresRef.current[rid].leerColaSnapped() }));   // ¿pegó la punta viva?
      const colaClean = ajustadoresRef.current[rid].leerColaClean();   // último vértice de VÍA limpia (frontera de colaViva)

      // TRAMO ESTIMADO por RUTA: HUECOS de señal (calcularPuentes) + CORRIDAS CRUDAS CONGELADAS (ventanas
      // que Map Matching no pegó = zigzag del GPS de red). Ambas por la ruta prevista→Google. Las crudas
      // ruteadas se añaden a `suprimir` para no dibujarlas también como medido (crudas).
      const crudoRanges = ajustadoresRef.current[rid].leerCrudoRanges();
      const cruditos = puentesCrudos(matchedEnVivoRefMap.current[rid] || [], crudoRanges);
      // Corridas crudas PRIMERO (mismo criterio que ModalGps): si se supera MAX_PUENTES, lo que
      // quede sin rutear son huecos de señal, no rangos crudos.
      const candidatos = [...cruditos, ...calcularPuentes(limpio)];
      const suprimir: Array<[number, number]> = [];
      const MAX_PUENTES = 30;
      if (candidatos.length > MAX_PUENTES) console.warn(`[cliente] ${candidatos.length} huecos, puenteando ${MAX_PUENTES}`);
      const rutaPlan = rutasEnVivoRef.current[rid] || [];
      const cache = puentesCacheCliRef.current;
      const feats: any[] = [];
      // Fixes GPS REALES del intervalo de un candidato (evidencia para validarPuente): corrida cruda → los
      // vértices crudos son las posiciones reales; hueco → los fixes con ts entre las anclas (vacío = túnel).
      const fixesDelTramo = (c: any): { lat: number; lng: number }[] => {
        if (c.origen === "crudo") {
          const m = matchedEnVivoRefMap.current[rid] || [];
          return m.slice(c.iA + 1, c.iB).map(([lng, lat]: [number, number]) => ({ lat, lng }));
        }
        const tA = limpio[c.iA]?.ts ?? 0, tB = limpio[c.iB]?.ts ?? 0;
        if (!(tB > tA)) return [];
        return crudos.filter((x) => x.ts > tA && x.ts < tB).map((x) => ({ lat: x.lat, lng: x.lng }));
      };
      // Puentes en DOS FASES (mismo fix que ModalGps, ago-2026 "la huella tarda"): FASE 1 síncrona
      // por la ruta planificada; FASE 2 con los fetch de Google EN PARALELO acotado (6). Slots por
      // índice → mismo orden de features y misma geometría que el camino secuencial.
      const cands = candidatos.slice(0, MAX_PUENTES);
      const slots: any[] = new Array(cands.length).fill(null);
      const fixesCand: { lat: number; lng: number }[][] = cands.map(fixesDelTramo);   // evidencia real por candidato
      const porGoogle: number[] = [];
      for (let ci = 0; ci < cands.length; ci++) {
        const c = cands[ci];
        const A = { lat: c.aLat, lng: c.aLng }, B = { lat: c.bLat, lng: c.bLng };
        // 1) Seguir la ruta planificada — SOLO si es coherente con la evidencia GPS (no un lazo del itinerario).
        //    Si falla la validación NO se descarta → cae al fallback de Google directo A→B.
        const porRuta = puentePorRuta(A, B, rutaPlan);
        if (porRuta && porRuta.length >= 2 && validarPuente(porRuta, A, B, fixesCand[ci], c.dt, c.dRecta)) {
          let mts = 0;
          for (let k = 1; k < porRuta.length; k++) mts += distM(porRuta[k - 1][1], porRuta[k - 1][0], porRuta[k][1], porRuta[k][0]);
          slots[ci] = { type: "Feature", geometry: { type: "LineString", coordinates: porRuta }, properties: { nivel: "puente", km: Math.round(mts / 100) / 10, min: Math.round(c.dt / 60) } };
        } else porGoogle.push(ci);
      }
      // 2) FALLBACK: camino fresco de Directions (cacheado por coords del hueco), con tope de
      //    concurrencia. Un `key` repetido dentro del mismo lote comparte UNA sola llamada.
      const enVuelo = new Map<string, Promise<void>>();
      await enParalelo(porGoogle, 6, async (ci) => {
        if (cancel) return;
        const c = cands[ci];
        const A = { lat: c.aLat, lng: c.aLng }, B = { lat: c.bLat, lng: c.bLng };
        const key = `${c.aLat.toFixed(5)},${c.aLng.toFixed(5)}->${c.bLat.toFixed(5)},${c.bLng.toFixed(5)}`;
        let r = cache.get(key);
        if (r?.expira && Date.now() > r.expira) r = undefined;   // fallo transitorio vencido → reintentar
        if (!r) {
          if (!enVuelo.has(key)) enVuelo.set(key, (async () => {
            try {
              const resp = await fetch("/api/ruta-puente", {
                method: "POST", headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ aLat: c.aLat, aLng: c.aLng, bLat: c.bLat, bLng: c.bLng }),
              });
              const j = await resp.json();
              let rr: any;
              if (j?.ocultar || j?.status !== "OK") {
                rr = { nivel: "ocultar", coords: [], km: 0, dt: c.dt };
                // Solo el "sin camino" GEOMÉTRICO es permanente; 429/5xx/cuota vencen en 60 s.
                if (!["ZERO_RESULTS", "NOT_FOUND", "SIN_GEOMETRIA"].includes(j?.status)) rr.expira = Date.now() + 60000;
              } else {
                const nivel = decidirPuente(j.roadM, c.dRecta);   // unir todo por carretera (corte solo si sin ruta o rodeo absurdo >8×)
                // Geometría de VÍA de Google TAL CUAL (nunca cruza casas); los extremos crudos A/B se añaden
                // solo si están pegados a la vía (≤25 m) para cerrar la costura, si no se OMITE la recta
                // (antes esa recta A→vía cruzaba manzanas/ríos = reclamo del usuario, jul-2026).
                const gc: [number, number][] = (j.coords || []) as [number, number][];
                const headOk = gc.length > 0 && distM(c.aLat, c.aLng, gc[0][1], gc[0][0]) <= 25;
                const tailOk = gc.length > 0 && distM(c.bLat, c.bLng, gc[gc.length - 1][1], gc[gc.length - 1][0]) <= 25;
                const coords: [number, number][] = nivel === "puente"
                  ? [...(headOk ? [[c.aLng, c.aLat] as [number, number]] : []), ...gc, ...(tailOk ? [[c.bLng, c.bLat] as [number, number]] : [])]
                  : [];
                rr = { nivel, coords, km: (j.roadM || c.dRecta) / 1000, dt: c.dt };
              }
              cache.set(key, rr);
            // Fallo de RED: cachear "ocultar" CON vencimiento (reintenta al vencer, sin tormenta en cada tick).
            } catch { cache.set(key, { nivel: "ocultar", coords: [], km: 0, dt: c.dt, expira: Date.now() + 60000 }); }
          })());
          await enVuelo.get(key)!;
          r = cache.get(key);
        }
        // Dibujar el estimado de Google SOLO si su geometría A→B directa es coherente con la evidencia GPS.
        if (r && r.nivel !== "ocultar" && r.coords.length >= 2 && validarPuente(r.coords, A, B, fixesCand[ci], c.dt, c.dRecta)) {
          slots[ci] = { type: "Feature", geometry: { type: "LineString", coordinates: r.coords }, properties: { nivel: r.nivel, km: Math.round(r.km * 10) / 10, min: Math.round(c.dt / 60) } };
        }
      });
      if (cancel) return;
      // Ensamblado EN ORDEN de candidatos (idéntico al secuencial): features + supresión del crudo ruteado.
      for (let ci = 0; ci < cands.length; ci++) {
        if (!slots[ci]) continue;
        feats.push(slots[ci]);
        if (cands[ci].origen === "crudo") suprimir.push([cands[ci].iA + 1, cands[ci].iB - 1]);
      }
      // La punta viva CRUDA (después del último vértice limpio) la cubre colaViva por la ruta → NO se dibuja medido.
      const mLenC = matchedEnVivoRefMap.current[rid]?.length || 0;
      if (colaClean >= 0 && colaClean < mLenC - 1) suprimir.push([colaClean + 1, mLenC - 1]);
      if (!cancel) { setPuentesMap(prev => ({ ...prev, [rid]: feats })); setSuprimirCrudoMap(prev => ({ ...prev, [rid]: suprimir })); setColaCleanMap(prev => ({ ...prev, [rid]: colaClean })); }
      // Badge honesto: medido = línea medida sin los tramos crudos ruteados; estimado = petróleo (baja el % en degradados).
      const largoCoordsC = (cs: any[]) => { let m = 0; for (let k = 1; k < (cs?.length || 0); k++) m += distM(cs[k - 1][1], cs[k - 1][0], cs[k][1], cs[k][0]); return m; };
      const largoFeatsC = (fs: any[]) => fs.reduce((a, f) => a + largoCoordsC(f.geometry?.coordinates || []), 0);
      const huellaColorC = limpio.map((p) => ({ lat: p.lat, lng: p.lng, velocidad: p.velocidad }));
      // Badge honesto: medido = línea de velocidad; estimado = petróleo por ruta. El crudo largo ya no
      // se dibuja (ni gris ni medido) — lo cubre el estimado. medidoPct = medido/(medido+estimado).
      const featsColorC = colorearMatched(matchedEnVivoRefMap.current[rid] || [], huellaColorC, suprimir, ajustadoresRef.current[rid].leerEsCrudo());
      const medidoMC = largoFeatsC(featsColorC);
      const estimadoMC = largoFeatsC(feats);
      const rvC = resumenViaje(limpio, crudos);
      if (rvC && medidoMC + estimadoMC > 0) rvC.medidoPct = Math.round((medidoMC / (medidoMC + estimadoMC)) * 100);
      if (!cancel) setResumenMap(prev => ({ ...prev, [rid]: rvC }));
      } finally { cargandoHuellaCliRef.current = false; }
    };
    // Carga inicial. `cargandoHuellaCliRef` es un ref COMPARTIDO entre servicios: si al cambiar de
    // ruta el ciclo anterior sigue en vuelo, esta primera carga se descartaría en silencio y el
    // mapa quedaría vacío hasta el próximo tick → reintentar en cuanto el ciclo en curso libere.
    let tReintento: ReturnType<typeof setTimeout> | null = null;
    const cargarInicial = () => {
      if (cancel) return;
      if (cargandoHuellaCliRef.current) { tReintento = setTimeout(cargarInicial, 300); return; }
      if (rutaSelId != null) cargarHuella(rutaSelId);
    };
    cargarInicial();
    // Refresca cada MS_REFRESCO_PUENTES (para servicios en curso). Con la pestaña oculta se
    // salta el tick: nadie mira el mapa y cada ciclo puede pegarle a /api/ruta-puente.
    const iv = setInterval(() => {
      if (document.hidden) return; // pestaña en segundo plano → no gastar cuota de Google
      if (rutaSelId != null) cargarHuella(rutaSelId);
    }, MS_REFRESCO_PUENTES);
    // Al volver a la pestaña, refrescar de inmediato en vez de esperar el próximo tick.
    const onVisible = () => { if (document.visibilityState === "visible" && rutaSelId != null) cargarHuella(rutaSelId); };
    document.addEventListener("visibilitychange", onVisible);
    return () => { cancel = true; if (tReintento) clearTimeout(tReintento); clearInterval(iv); document.removeEventListener("visibilitychange", onVisible); };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tab, rutaSelId]);

  // ─── En vivo: dibujar las 3 capas en el mapa ─────────────────────────────
  useEffect(() => {
    const map = mapRef.current;
    if (!mapListoEnVivo || !map) return;

    const COL = ["#0b315f", "#ea580c", "#16a34a", "#7c3aed"];
    const svcs = serviciosHoyRef.current;

    // Limpiar capas, sources y marcadores previos
    dibujoLayersRef.current.forEach(lid => { try { if (map.getLayer(lid)) map.removeLayer(lid); } catch {} });
    dibujoSourcesRef.current.forEach(sid => { try { if (map.getSource(sid)) map.removeSource(sid); } catch {} });
    stopMarkersRef.current.forEach(mk => mk.remove());
    dibujoLayersRef.current = []; dibujoSourcesRef.current = []; stopMarkersRef.current = [];

    // Solo se dibuja la ruta del servicio SELECCIONADO. Sin selección → solo buses en vivo.
    if (tab !== "activos" || rutaSelId == null) { lastFitRef.current = null; return; }
    const sel = svcs.find(r => r.id === rutaSelId);
    if (!sel) return;
    const idx = svcs.findIndex(r => r.id === sel.id);
    const color = COL[idx % COL.length];
    const bounds = new mapboxgl.LngLatBounds();
    let hasBounds = false;

    // CAPA 1 — Ruta planificada (línea punteada)
    const coords = rutasEnVivoMap[sel.id];
    if (coords?.length) {
      const sid = `plan-s-${sel.id}`, lid = `plan-l-${sel.id}`;
      try {
        map.addSource(sid, { type: "geojson", data: { type: "Feature", properties: {}, geometry: { type: "LineString", coordinates: coords } } });
        map.addLayer({ id: lid, type: "line", source: sid, layout: { "line-join": "round", "line-cap": "round" }, paint: { "line-color": color, "line-width": 4, "line-opacity": 0.9, "line-dasharray": [2, 1.6] } });
        dibujoSourcesRef.current.push(sid); dibujoLayersRef.current.push(lid);
        coords.forEach((c: [number, number]) => { bounds.extend(c); hasBounds = true; });
      } catch {}
    }

    // CAPA 2 — Huella GPS real (segmentos coloreados por velocidad)
    // Si hay geometría ajustada a la vía (Map Matching) se dibuja esa (pegada a la pista);
    // si no, la huella cruda ya limpiada + suavizada (sin zigzag). Mismo motor que el modal.
    const huellaPts = huellaGpsMap[sel.id] || [];
    const matchedEV = matchedEnVivoMap[sel.id];
    // Posición EN VIVO del bus de ESTE servicio (vía ref → NO se añade a deps, no redibuja de más):
    // extiende la estela ajustada hasta el vehículo (colaViva), igual que el modal. Sin esto la
    // huella queda hasta ~60 s detrás del bus (throttle de Map Matching). colaViva corta en saltos
    // >300 m, así que un punto en vivo rancio/teleport no dibuja recta.
    const sa = sel as any;
    const liveU = ubicacionesEnVivoRef.current.find((u) =>
      (u.reserva_id != null && Number(u.reserva_id) === sel.id) ||
      (sa.vehiculo_id != null && u.vehiculo_id === sa.vehiculo_id) ||
      (sa.vehiculo_tercero_id != null && u.vehiculo_tercero_id === sa.vehiculo_tercero_id)
    );
    // Punto vivo PEGADO a la vía (misma posición que el ícono) → la cola termina en el marcador,
    // sin colita cruda hacia un techo. `acc` se conserva crudo (una cuerda larga sigue saliendo aprox).
    const liveRaw = liveU ? { lat: Number(liveU.lat), lng: Number(liveU.lng), velocidad: Number(liveU.velocidad) || 0, acc: Number((liveU as any).precision_m) || 25 } : null;
    let live = liveRaw;
    if (liveRaw) {
      const prevSnap = snapIconoCliRef.current?.rid === sel.id ? snapIconoCliRef.current : null;
      const rs = pegarIconoAVia(liveRaw.lat, liveRaw.lng, liveRaw.acc, {
        ruta: rutasEnVivoMap[sel.id], trail: matchedEV || undefined, trailEsCrudo: esCrudoEnVivoMap[sel.id],
        prev: prevSnap, prevS: prevSnap?.s ?? null,
      });
      live = { ...liveRaw, lat: rs.lat, lng: rs.lng };
    }
    const cutC = matchedEV ? ((colaCleanMap[sel.id] >= 1 && colaCleanMap[sel.id] < matchedEV.length - 1) ? colaCleanMap[sel.id] : matchedEV.length - 1) : 0;
    const feats: any[] = (matchedEV && matchedEV.length >= 2)
      ? [...colorearMatched(matchedEV, huellaPts, suprimirCrudoMap[sel.id], esCrudoEnVivoMap[sel.id]), ...colaViva(matchedEV.slice(0, cutC + 1), huellaPts, live, rutasEnVivoMap[sel.id], colaSnappedMap[sel.id] === false || cutC < matchedEV.length - 1)]
      : huellaCrudaFeatures(huellaPts);   // cruda por tramos (corta teleports/huecos; la cuerda cruda larga se OMITE, no gris). lib/huella.ts
    if (feats.length > 0) {
      const sid = `gps-s-${sel.id}`, lid = `gps-l-${sel.id}`;
      try {
        map.addSource(sid, { type: "geojson", data: { type: "FeatureCollection", features: feats } as any });
        // Una sola capa: velocidad + punta viva estimada. Se eliminó la capa gris punteada "aprox"
        // (jul-2026); la vía de los tramos crudos la da el estimado por ruta (verde petróleo, siempre sobre calzada).
        map.addLayer({ id: lid, type: "line", source: sid, layout: { "line-join": "round", "line-cap": "round" }, paint: {
          "line-width": 5, "line-opacity": 0.95,
          // Punta viva estimada (sigue la ruta prevista) en verde petróleo; el resto por velocidad.
          "line-color": ["case", ["==", ["get", "estimado"], 1], "#0f766e", ["interpolate", ["linear"], ["get", "velocidad"], 0, "#dc2626", 15, "#f59e0b", 35, "#eab308", 55, "#16a34a"]] as any,
        } });
        dibujoSourcesRef.current.push(sid); dibujoLayersRef.current.push(lid);
        huellaPts.forEach(p => { bounds.extend([p.lng, p.lat]); hasBounds = true; });
      } catch {}
    }

    // CAPA 3 — Marcadores de paradas (origen/intermedias/destino)
    const stops = (paradasResueltasMap[sel.id] || paradas[sel.id] || []).filter(p => p.lat && p.lng).sort((a, b) => a.orden - b.orden);
    stops.forEach((p, i) => {
      const esOrigen = i === 0, esDestino = i === stops.length - 1;
      const bg = esOrigen ? "#16a34a" : esDestino ? "#dc2626" : "#0b315f";
      const txt = esOrigen ? "A" : esDestino ? "B" : String(i);
      const el = document.createElement("div");
      el.style.cssText = `width:24px;height:24px;border-radius:50%;background:${bg};border:2.5px solid white;box-shadow:0 2px 6px rgba(0,0,0,0.35);display:flex;align-items:center;justify-content:center;color:white;font:700 11px system-ui,sans-serif;cursor:pointer;`;
      el.textContent = txt;
      const popup = new mapboxgl.Popup({ offset: 18, closeButton: false }).setHTML(
        `<div style="font-family:system-ui,sans-serif;padding:1px 0"><b style="font-size:12px;color:#0a0e1a">${p.nombre}</b>${p.hora_estimada ? `<br><span style="font-size:11px;color:#0b315f;font-weight:600">${p.hora_estimada}</span>` : ""}</div>`
      );
      const mk = new mapboxgl.Marker({ element: el }).setLngLat([Number(p.lng), Number(p.lat)]).setPopup(popup).addTo(map);
      stopMarkersRef.current.push(mk);
      bounds.extend([Number(p.lng), Number(p.lat)]); hasBounds = true;
    });

    // Encuadrar al seleccionar (no en cada refresh GPS)
    if (hasBounds && lastFitRef.current !== sel.id) {
      try { map.fitBounds(bounds, { padding: 60, maxZoom: 14, duration: 700 }); lastFitRef.current = sel.id; } catch {}
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapListoEnVivo, rutasEnVivoMap, huellaGpsMap, matchedEnVivoMap, esCrudoEnVivoMap, suprimirCrudoMap, colaSnappedMap, colaCleanMap, paradasResueltasMap, paradas, rutaSelId, tab]);

  // ─── En vivo: CAPA 4 — puntitos de telemetría real del servicio seleccionado ─
  // Capa propia con id FIJO + setData (no el remove/add del efecto de arriba) para no apilar
  // handlers. Depende de las mismas señales de redibujo para re-subir la capa (moveLayer) por
  // encima de la línea de huella que el otro efecto re-crea en cada render.
  useEffect(() => {
    const map = mapRef.current;
    if (!mapListoEnVivo || !map) return;
    const rumboCardinal = (deg: number) => ["N","NE","E","SE","S","SO","O","NO"][Math.round(((deg%360)+360)%360/45)%8];
    const fmtHoraPunto = (ts: number) => new Date(ts).toLocaleTimeString("es-PE", { hour: "numeric", minute: "2-digit", second: "2-digit", hour12: true, timeZone: "America/Lima" });
    const puntos = (tab === "activos" && rutaSelId != null) ? (telemetriaMap[rutaSelId] || []) : [];
    try {
      const features = puntos.map((p) => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [p.lng, p.lat] as [number, number] },
        properties: { velocidad: p.velocidad, velReal: p.velReal ? 1 : 0, rumbo: p.rumbo, rumboReal: p.rumboReal ? 1 : 0, acc: Math.round(p.acc), ts: p.ts, lat: p.lat, lng: p.lng },
      }));
      const data: any = { type: "FeatureCollection", features };
      const src: any = map.getSource("telem-cli-src");
      if (src && typeof src.setData === "function") {
        src.setData(data);
      } else {
        map.addSource("telem-cli-src", { type: "geojson", data });
        map.addLayer({
          id: "telem-cli-c", type: "circle", source: "telem-cli-src",
          paint: {
            "circle-radius": ["interpolate", ["linear"], ["zoom"], 11, 2.5, 14, 4, 17, 6],
            "circle-color": ["interpolate", ["linear"], ["get", "velocidad"], 0, "#dc2626", 15, "#f59e0b", 35, "#eab308", 55, "#16a34a"],
            "circle-stroke-color": "#ffffff", "circle-stroke-width": 1.5,
            "circle-opacity": ["interpolate", ["linear"], ["zoom"], 11, 0.55, 14, 0.9],
          },
        });
        map.on("mouseenter", "telem-cli-c", () => { map.getCanvas().style.cursor = "pointer"; });
        map.on("mouseleave", "telem-cli-c", () => { map.getCanvas().style.cursor = ""; });
        map.on("click", "telem-cli-c", async (e: any) => {
          const f = e.features?.[0]; if (!f) return;
          const pr = f.properties || {};
          const vel = Number(pr.velocidad) || 0, velReal = Number(pr.velReal) === 1;
          const rumbo = Number(pr.rumbo) || 0, rumboReal = Number(pr.rumboReal) === 1;
          const acc = Number(pr.acc) || 0, ts = Number(pr.ts) || 0;
          const lat = Number(pr.lat), lng = Number(pr.lng);
          const velTxt = vel <= 0 ? "<b>Detenido</b>" : `<b>${vel} km/h</b>${velReal ? "" : ' <span style="color:#94a3b8">aprox.</span>'}`;
          const rumboTxt = vel <= 0 ? "—" : `${rumboCardinal(rumbo)} (${rumbo}°)${rumboReal ? "" : ' <span style="color:#94a3b8">aprox.</span>'}`;
          const html = (dir: string) => `<div style="font-family:system-ui,sans-serif;font-size:12px;line-height:1.5;min-width:170px"><div style="color:#64748b;font-size:11px">${fmtHoraPunto(ts)}</div><div style="font-size:14px;margin:2px 0">${velTxt}</div><div>Dirección: ${rumboTxt}</div><div style="color:#64748b">Precisión: ±${acc} m</div><div style="color:#334155;margin-top:3px">${dir}</div></div>`;
          if (popupTelemCliRef.current) popupTelemCliRef.current.remove();
          const popup = new mapboxgl.Popup({ closeButton: true, offset: 10, maxWidth: "240px" }).setLngLat([lng, lat]).setHTML(html('<span style="color:#94a3b8">Ubicando dirección…</span>')).addTo(map);
          popupTelemCliRef.current = popup;
          const key = `${lat.toFixed(4)},${lng.toFixed(4)}`;
          const pintar = (dir: string) => { if (popupTelemCliRef.current === popup && popup.isOpen()) popup.setHTML(html(dir)); };
          if (geocacheCliRef.current.has(key)) { pintar(geocacheCliRef.current.get(key)!); return; }
          try {
            const res = await fetch("/api/geocodificar-inverso", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lat, lng }) });
            const j = await res.json();
            const dir = j?.direccion || fmtCoord(lat, lng);
            // Cachear solo con dirección o status terminal; no el fallback por cuota transitoria.
            if (j?.direccion || j?.status === "ZERO_RESULTS") geocacheCliRef.current.set(key, dir);
            pintar(dir);
          } catch { pintar(fmtCoord(lat, lng)); }
        });
      }
      if (map.getLayer("telem-cli-c")) {
        map.setLayoutProperty("telem-cli-c", "visibility", mostrarPuntosCli ? "visible" : "none");
        try { map.moveLayer("telem-cli-c"); } catch {} // encima de la línea de huella que el otro efecto re-crea
      }
    } catch (e) { console.error("[cliente] Error dibujando puntitos:", e); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapListoEnVivo, telemetriaMap, huellaGpsMap, matchedEnVivoMap, rutaSelId, tab, mostrarPuntosCli]);

  // ─── En vivo: CAPA 5 — puente azul de tramos sin señal (estimado por carretera) ─
  useEffect(() => {
    const map = mapRef.current;
    if (!mapListoEnVivo || !map) return;
    const feats = (tab === "activos" && rutaSelId != null) ? (puentesMap[rutaSelId] || []) : [];
    try {
      const data: any = { type: "FeatureCollection", features: feats };
      const src: any = map.getSource("puente-cli-src");
      if (src && typeof src.setData === "function") {
        src.setData(data);
      } else {
        map.addSource("puente-cli-src", { type: "geojson", data });
        map.addLayer({
          id: "puente-cli-l", type: "line", source: "puente-cli-src",
          layout: { "line-join": "round", "line-cap": "round" },
          // Verde petróleo SÓLIDO: el cliente ve una ruta continua. SIN popup ni etiqueta "estimado"
          // (a diferencia del modal admin) — el tecnicismo del tramo sin señal queda solo en /seguimiento.
          paint: { "line-color": "#0f766e", "line-width": 5, "line-opacity": 0.9 },
        });
      }
      // Puente DEBAJO de la huella medida (el otro efecto re-crea gps-l-* al tope cada render): orden
      // estable sin importar cuál efecto corra primero. En los huecos no hay huella encima → visible.
      const lidGps = rutaSelId != null ? `gps-l-${rutaSelId}` : null;
      if (lidGps && map.getLayer("puente-cli-l") && map.getLayer(lidGps)) { try { map.moveLayer("puente-cli-l", lidGps); } catch {} }
    } catch (e) { console.error("[cliente] Error dibujando puentes:", e); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mapListoEnVivo, puentesMap, rutaSelId, tab]);

  // ─── KPIs ─────────────────────────────────────────────────────────────────
  const hoy          = getHoyPeru();
  const esteM        = hoy.slice(0, 7);
  const serviciosMes   = reservas.filter(r => r.fecha_servicio?.startsWith(esteM)).length;
  const esCancelado    = (e: string) => normalizaEstado(e) === "cancelada";
  const esFinalizado   = (e: string) => normalizaEstado(e) === "finalizada";
  const esHoy          = (f: string | null) => !!f && f.startsWith(hoy);
  const esFuturo       = (f: string | null) => !!f && f.slice(0,10) > hoy;
  // Los KPIs "históricos" solo cuentan servicios que YA ocurrieron. Antes se calculaban
  // sobre el array completo, que con la programación fija incluye miles de servicios de
  // 2027-2028: "Total histórico" contaba viajes que aún no existen y el SLA se dividía
  // entre ellos, por eso marcaba 0%. El total lo cuenta Postgres (total_historico).
  const reservasPasadas = reservas.filter(r => !esFuturo(r.fecha_servicio));
  const serviciosTotal = totalHistorico ?? reservasPasadas.length;
  const completados    = reservasPasadas.filter(r => esFinalizado(r.estado)).length;
  const puntualidad    = reservasPasadas.length > 0 ? Math.round((completados / reservasPasadas.length) * 100) : 0;
  const pasajerosTotal = Object.values(boarding).flat().length;

  // Correlativo propio del cliente (su orden interno): numera TODAS sus reservas por
  // antigüedad (id asc), estable por servicio. El identificador OFICIAL para reportar
  // es el "ID AFA" (folio reservas.codigo); este correlativo es solo para su orden.
  const ordenCliente = (() => {
    const m = new Map<number, number>();
    [...reservas].sort((a, b) => a.id - b.id).forEach((r, i) => m.set(r.id, i + 1));
    return m;
  })();

  // Deriva el estado efectivo: si el GPS de hoy está activo para este vehículo → "en_curso"
  // aunque reservas.estado no lo haya actualizado (el conductor app no escribe en reservas)
  const efectivoEstado = (r: Reserva): string => {
    const base = normalizaEstado(r.estado);
    if (esHoy(r.fecha_servicio) && !esCancelado(r.estado) && !esFinalizado(r.estado) && base !== "en_curso") {
      const gpsDeHoy = gpsActual && gpsActual.timestamp?.slice(0, 10) === hoy;
      const mismoVehiculo = r.vehiculo_id && r.vehiculo_id === vehiculoActivo;
      if (gpsDeHoy && mismoVehiculo) return "en_curso";
      if (gpsActual?.estado === "en_ruta" && mismoVehiculo) return "en_curso";
    }
    return base;
  };
  const porPagar       = facturas.filter(f => f.estado === "emitida" || f.estado === "enviada").reduce((s, f) => s + Number(f.total || 0), 0);
  const totalPagado    = facturas.filter(f => f.estado === "cobrada").reduce((s, f) => s + Number(f.total || 0), 0);
  const totalVencido   = facturas.filter(f => f.estado === "vencida").reduce((s, f) => s + Number(f.total || 0), 0);
  const mañana = (() => { const d = new Date(hoy + "T00:00:00"); d.setDate(d.getDate() + 1); return d.toISOString().slice(0, 10); })();
  const notifs: Notif[] = [
    // Facturas vencidas → alertas urgentes
    ...facturas.filter(f => f.estado === "vencida").slice(0, 3).map(f => ({ id: f.id, tipo: "warning" as const, titulo: "Factura vencida", desc: `${f.serie ? f.serie + "-" : ""}${f.numero || "#" + f.id} · ${fmtSoles(f.total)}`, fecha: f.fecha_vencimiento || hoy })),
    // Servicio de hoy activo
    ...reservas.filter(r => esHoy(r.fecha_servicio) && !esCancelado(r.estado) && !esFinalizado(r.estado)).slice(0, 1).map(r => ({ id: r.id + 5000, tipo: "info" as const, titulo: efectivoEstado(r) === "en_curso" ? "🚌 Servicio en ruta ahora" : "Servicio programado hoy", desc: `${r.origen} → ${r.destino} · ${r.hora_servicio?.slice(0,5) || "–"}`, fecha: r.fecha_servicio || hoy })),
    // Servicios mañana
    ...reservas.filter(r => r.fecha_servicio === mañana && !esCancelado(r.estado)).slice(0, 1).map(r => ({ id: r.id + 6000, tipo: "info" as const, titulo: "Servicio programado mañana", desc: `${r.origen} → ${r.destino} · ${r.hora_servicio?.slice(0,5) || "–"}`, fecha: r.fecha_servicio || mañana })),
    // Próximos servicios confirmados
    ...reservas.filter(r => esFuturo(r.fecha_servicio) && r.fecha_servicio !== mañana && normalizaEstado(r.estado) === "confirmada").slice(0, 2).map(r => ({ id: r.id + 1000, tipo: "success" as const, titulo: "Servicio confirmado", desc: `${r.origen} → ${r.destino} · ${fmtFecha(r.fecha_servicio)}`, fecha: r.fecha_servicio || hoy })),
  ];
  const servicioHoy    = reservas.find(r => esHoy(r.fecha_servicio)); // cualquier estado
  const serviciosHoy   = reservas
    .filter(r => esHoy(r.fecha_servicio) && !esCancelado(r.estado))
    .sort((a, b) => (a.hora_servicio || "").localeCompare(b.hora_servicio || ""));
  // ─── ¿Qué servicios están EN RUTA *ahora*? ──────────────────────────────────
  // No se puede confiar en reservas.estado: la app del conductor no siempre marca
  // "finalizada", así que un turno que ya terminó puede quedar "en_curso" en BD y
  // tapar a los que recién arrancan. Fuente de verdad = GPS en vivo + recorrido: un
  // servicio está en ruta si su vehículo transmitió hace ≤20 min y su recorrido no
  // está completo (ni finalizado).
  const LIVE_MAX_MIN = 20;
  const minGpsServicio = (r: Reserva): number | null => {
    const ra = r as any;
    const esTer = ra.vehiculo_tercero_id != null;
    const u = ubicacionesEnVivo.find(p =>
      (p.reserva_id != null && p.reserva_id === r.id) ||
      (esTer && ra.vehiculo_tercero_id != null && p.vehiculo_tercero_id === ra.vehiculo_tercero_id) ||
      (!esTer && r.vehiculo_id != null && p.vehiculo_id === r.vehiculo_id));
    return u ? Math.floor((Date.now() - new Date(u.timestamp).getTime()) / 60000) : null;
  };
  const rutaCompleta = (r: Reserva): boolean => {
    const ps = paradas[r.id] || [];
    return ps.length > 0 && ps.every(p => p.estado === "completada");
  };
  const enRutaAhora = (r: Reserva): boolean => {
    if (esFinalizado(r.estado) || rutaCompleta(r)) return false;
    const m = minGpsServicio(r);
    return m != null && m <= LIVE_MAX_MIN;
  };
  const serviciosEnRuta = serviciosHoy.filter(enRutaAhora);
  // Card principal: el primero en ruta; si ninguno transmite aún, el en_curso por BD o el primer turno.
  const servicioActivo = serviciosEnRuta[0]
    || serviciosHoy.find(r => efectivoEstado(r) === "en_curso")
    || serviciosHoy[0] || null;
  // Cards EN RUTA: TODOS los que están en ruta ahora (varios turnos a la vez). Si ninguno
  // transmite todavía, se muestra el turno del servicio activo como vista previa (pre-inicio).
  const serviciosDestacados = serviciosEnRuta.length > 0
    ? serviciosEnRuta
    : (servicioActivo ? serviciosHoy.filter(r => r.hora_servicio === servicioActivo.hora_servicio) : []);
  // Ref siempre actualizado (para efectos que no pueden incluir serviciosHoy en deps)
  serviciosHoyRef.current = serviciosHoy;
  const COLORES_RUTA = ["#0b315f", "#ea580c", "#16a34a", "#7c3aed"];
  // Servicio cuya ruta está seleccionada (null = solo buses en vivo)
  const servicioSel = rutaSelId != null ? serviciosHoy.find(r => r.id === rutaSelId) ?? null : null;
  const selIdx = servicioSel ? serviciosHoy.findIndex(r => r.id === servicioSel.id) : -1;
  // Para la card de cabecera: el seleccionado, o el activo/primero por defecto
  const servicioEnVivoActivo = servicioSel ?? servicioActivo;
  const busesEnVivo = ubicacionesEnVivo.length;
  // Vehículos asignados a los servicios de HOY (propios + terceros, indistinguibles
  // para el cliente). Se listan TODOS: los que transmiten van "en vivo", el resto
  // como "esperando señal" (aún no aparecen en el mapa porque no tienen ubicación).
  const vehiculosHoyEstado = (() => {
    const out: { key: string; placa: string; live: boolean; minAgo: number | null }[] = [];
    const visto = new Set<string>();
    serviciosHoy.forEach(r => {
      const ra = r as any;
      const esTer = ra.vehiculo_tercero_id != null;
      const vKey = esTer ? `vt${ra.vehiculo_tercero_id}` : r.vehiculo_id != null ? `v${r.vehiculo_id}` : null;
      if (!vKey || visto.has(vKey)) return;
      visto.add(vKey);
      const placa = esTer
        ? (vehiculosTerceroCliente.find(x => x.id === ra.vehiculo_tercero_id)?.placa || "Vehículo")
        : (vehiculosCliente.find(x => x.id === r.vehiculo_id)?.placa || "Vehículo");
      const u = ubicacionesEnVivo.find(p =>
        (esTer && p.vehiculo_tercero_id === ra.vehiculo_tercero_id) ||
        (!esTer && r.vehiculo_id != null && p.vehiculo_id === r.vehiculo_id));
      const minAgo = u ? Math.floor((Date.now() - new Date(u.timestamp).getTime()) / 60000) : null;
      out.push({ key: vKey, placa, live: minAgo != null && minAgo <= 10, minAgo });
    });
    return out;
  })();
  const vehiculosHoyLive = vehiculosHoyEstado.filter(v => v.live).length;
  const proximosSvcs   = reservas
    .filter(r => esFuturo(r.fecha_servicio) && !esCancelado(r.estado) && !esFinalizado(r.estado))
    .sort((a, b) => {
      if (a.fecha_servicio !== b.fecha_servicio) return (a.fecha_servicio || "").localeCompare(b.fecha_servicio || "");
      return (a.hora_servicio || "").localeCompare(b.hora_servicio || "");
    })
    .slice(0, 5);
  const ultimosSvcs    = reservas.filter(r => (r.fecha_servicio || "") < hoy && !esCancelado(r.estado)).slice(0, 6);
  const activosCount   = reservas.filter(r => esHoy(r.fecha_servicio) && !esCancelado(r.estado)).length;
  const prevM          = (() => { const d = new Date(hoy + "T00:00:00"); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  const serviciosPrevMes = reservas.filter(r => r.fecha_servicio?.startsWith(prevM)).length;
  const deltaServicios   = serviciosMes - serviciosPrevMes;
  const gastoMes         = reservas.filter(r => r.fecha_servicio?.startsWith(esteM)).reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
  const saludoHora       = (() => { try { const h = new Date(new Date().toLocaleString("en-US", { timeZone: "America/Lima" })).getHours(); return h < 12 ? "Buen día" : h < 19 ? "Buenas tardes" : "Buenas noches"; } catch { return "Hola"; } })();
  const topRutas         = (() => {
    const m = new Map<string, { total: number; comp: number }>();
    reservas.forEach(r => { const k = `${r.origen} → ${r.destino}`; if (!m.has(k)) m.set(k, { total: 0, comp: 0 }); const e = m.get(k)!; e.total++; if (esFinalizado(r.estado)) e.comp++; });
    return [...m.entries()].map(([ruta, d]) => ({ ruta, sla: d.total > 0 ? Math.round((d.comp / d.total) * 100) : 100, servicios: d.total })).sort((a, b) => b.servicios - a.servicios).slice(0, 4);
  })();

  // ─── Historial: periodo → filtros ─────────────────────────────────────────
  // (el `rango` se resolvió arriba, junto a los efectos que lo consultan)
  // Universo = lo cargado + lo que se pidió aparte por caer fuera de la ventana.
  const universoReservas = reservasExtra.length === 0 ? reservas : (() => {
    const m = new Map<number, Reserva>();
    reservas.forEach(r => m.set(r.id, r));
    reservasExtra.forEach(r => { if (!m.has(r.id)) m.set(r.id, r); });
    return [...m.values()];
  })();
  const reservasPeriodo = universoReservas.filter(r => enRango(r.fecha_servicio, rango));

  const reservasFiltradas = reservasPeriodo.filter(r => {
    const cumpleEstado   = filtroEstado === "todos" || efectivoEstado(r) === filtroEstado;
    const cumpleBusqueda = !filtroBusqueda || r.origen.toLowerCase().includes(filtroBusqueda.toLowerCase()) || r.destino.toLowerCase().includes(filtroBusqueda.toLowerCase()) || fmtFecha(r.fecha_servicio).includes(filtroBusqueda);
    return cumpleEstado && cumpleBusqueda;
  }).sort((a, b) => {
    const da = a.fecha_servicio || "9999-99-99";
    const db = b.fecha_servicio || "9999-99-99";
    const fa = da >= hoy, fb = db >= hoy;
    if (fa && fb) {
      if (da !== db) return da < db ? -1 : 1;
      const ha = a.hora_servicio || "", hb = b.hora_servicio || "";
      return ha !== hb ? ha.localeCompare(hb) : a.id - b.id;
    }
    if (!fa && !fb) {
      if (da !== db) return db < da ? -1 : 1;
      const ha = a.hora_servicio || "", hb = b.hora_servicio || "";
      return ha !== hb ? ha.localeCompare(hb) : a.id - b.id;
    }
    return fa ? -1 : 1;
  });

  const agendaGrupos = (() => {
    const grupos = new Map<string, Reserva[]>();
    reservasFiltradas.forEach(r => {
      const key = r.fecha_servicio || "sin_fecha";
      if (!grupos.has(key)) grupos.set(key, []);
      grupos.get(key)!.push(r);
    });
    return Array.from(grupos.entries()).map(([fecha, filas]) => ({
      fecha,
      filas: [...filas].sort((a, b) => {
        const ha = a.hora_servicio || "";
        const hb = b.hora_servicio || "";
        return ha !== hb ? ha.localeCompare(hb) : a.id - b.id;
      }),
      label: fecha === "sin_fecha" ? "Sin fecha" :
        new Date(fecha + "T12:00:00").toLocaleDateString("es-PE", { weekday: "long", day: "numeric", month: "long", year: "numeric" }),
      esHoy: fecha === hoy,
      esFuturo: fecha !== "sin_fecha" && fecha > hoy,
      esPasado: fecha !== "sin_fecha" && fecha < hoy,
    }));
  })();

  // ─── Reporte de embarque PDF ──────────────────────────────────────────────
  // Los templates HTML viven en lib/documentos-servicio.ts (fuente única del documento
  // legal, compartida con /seguimiento). Acá solo se mapea el estado del portal → doc.
  function generarReportePDF(r: Reserva) {
    abrirImprimible(reporteServicioHTML({
      empresa: {
        nombre: empresa?.nombre ?? null,
        telefono: empresa?.telefono ?? null,
        email: empresa?.email ?? null,
        logoReporteUrl: window.location.origin + "/logoafacotizacion-removebg-preview.png",
        firmaUrl: window.location.origin + "/firmaJLCA.png",
      },
      cliente: { nombre: cliente?.empresa || cliente?.nombre || "", ruc: cliente?.ruc ?? null },
      servicio: { fecha: r.fecha_servicio, hora: r.hora_servicio, origen: r.origen, destino: r.destino },
      paradas: paradas[r.id] || [],
      pasajeros: ppList[r.id] || [],
      boarding: boarding[r.id] || [],
    }));
  }

  // ─── Manifiesto oficial R.D. 1946-2009-MTC-15 ─────────────────────────────
  function generarManifiesto(r: Reserva) {
    abrirImprimible(manifiestoMtcHTML({
      empresa: { logoUrl: empresa?.logo_url ?? null },
      cliente: { nombre: cliente?.empresa || cliente?.nombre || "" },
      servicio: { fecha: r.fecha_servicio, hora: r.hora_servicio, origen: r.origen, destino: r.destino },
      conductor: conductorInfo ? { nombre: conductorInfo.nombre, licencia: conductorInfo.numero_licencia } : null,
      vehiculo: vehiculoInfo ? { placa: vehiculoInfo.placa } : null,
      pasajeros: ppList[r.id] || [],
      boarding: boarding[r.id] || [],
    }));
  }

  // ─── LOADING ──────────────────────────────────────────────────────────────
  if (initing) return (
    <div style={{ minHeight: "100vh", display: "flex", alignItems: "center", justifyContent: "center", background: C.navyDeep, fontFamily: C.fontSans }}>
      <style>{`@import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');@keyframes spin{to{transform:rotate(360deg)}}`}</style>
      <div style={{ textAlign: "center" }}>
        <div style={{ width: 40, height: 40, border: "3px solid rgba(255,255,255,0.15)", borderTopColor: "rgba(123,166,224,0.9)", borderRadius: "50%", margin: "0 auto 18px", animation: "spin 0.8s linear infinite" }} />
        <p style={{ color: "rgba(255,255,255,0.5)", fontWeight: 600, fontSize: 13, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>Cargando portal...</p>
      </div>
    </div>
  );

  // ─── LOGIN ────────────────────────────────────────────────────────────────
  const rucValido = /^\d{11}$/.test(rucInput.trim());

  if (!cliente) return (
    <div style={{ minHeight: "100vh", fontFamily: C.fontSans }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes pcPulse{0%,100%{opacity:1;transform:scale(1)}60%{opacity:.4;transform:scale(1.8)}}
        .pc-split{display:flex;min-height:100vh}
        .pc-left{width:600px;min-height:100vh;position:relative;overflow:hidden;padding:52px 56px;display:flex;flex-direction:column;color:white;flex-shrink:0;background:#071f3d}
        .pc-right{flex:1;display:flex;align-items:center;justify-content:center;padding:56px 64px;background:#F6F4EE}
        .pc-input{width:100%;border:1.5px solid #E6E2D6;border-radius:8px;padding:0 14px;height:48px;font-size:14px;font-family:inherit;outline:none;color:#0A0E1A;background:#fff;box-sizing:border-box;transition:border-color .15s}
        .pc-input:focus{border-color:#0b315f;box-shadow:0 0 0 3px rgba(11,49,95,.08)}
        .pc-btn-primary{width:100%;padding:13px 0;border-radius:8px;border:none;background:#0b315f;color:white;font-size:14px;font-weight:700;font-family:inherit;cursor:pointer;display:flex;align-items:center;justify-content:center;gap:10px;transition:background .15s;letter-spacing:.01em}
        .pc-btn-primary:disabled{background:#D5D1C5;cursor:not-allowed}
        .pc-btn-primary:not(:disabled):hover{background:#071f3d}
        .pc-btn-secondary{flex:1;padding:10px 0;border-radius:8px;border:1.5px solid #E6E2D6;background:#F1EFE8;font-family:inherit;font-weight:700;font-size:12.5px;color:#1F2433;display:inline-flex;align-items:center;justify-content:center;gap:7px;cursor:pointer}
        @media(max-width:900px){
          .pc-split{flex-direction:column}
          .pc-left{width:100%;min-height:auto;padding:28px 24px 40px}
          .pc-right{padding:24px 22px 48px;justify-content:flex-start}
        }
      `}</style>

      <div className="pc-split">

        {/* PANEL IZQUIERDO: brand */}
        <div className="pc-left">
          {/* Grid pattern + glow */}
          <svg style={{ position: "absolute", inset: 0, width: "100%", height: "100%", pointerEvents: "none" }} preserveAspectRatio="none">
            <defs>
              <pattern id="lg" width="40" height="40" patternUnits="userSpaceOnUse">
                <path d="M40 0H0V40" stroke="rgba(255,255,255,0.04)" strokeWidth="1" fill="none"/>
              </pattern>
              <radialGradient id="lglow" cx="20%" cy="85%" r="70%">
                <stop offset="0%" stopColor="#1a4a8a" stopOpacity="0.55"/>
                <stop offset="100%" stopColor="transparent"/>
              </radialGradient>
            </defs>
            <rect width="100%" height="100%" fill="url(#lg)"/>
            <rect width="100%" height="100%" fill="url(#lglow)"/>
            <g stroke="#7BA6E0" strokeWidth="1.5" fill="none" strokeLinecap="round" opacity="0.4">
              <path d="M0,585 L108,495 L210,540 L330,360 L450,405 L600,270"/>
              {[[108,495],[210,540],[330,360],[450,405]].map(([x,y],i) => (
                <circle key={i} cx={x} cy={y} r={4} fill="#071f3d" stroke="#7BA6E0" strokeWidth="1.5"/>
              ))}
            </g>
          </svg>

          <div style={{ position: "relative", zIndex: 1, display: "flex", flexDirection: "column" as const, height: "100%" }}>
            {/* Logo */}
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <img
                src={empresa?.logo_url || "/logoafa-removebg-preview.png"}
                alt="AFA Tours Peru"
                style={{ height: 38, objectFit: "contain", imageRendering: "-webkit-optimize-contrast" as any }}
              />
              <span style={{ fontSize: 10, color: "rgba(255,255,255,0.35)", fontWeight: 700, letterSpacing: "0.12em", textTransform: "uppercase" as const, marginLeft: 4 }}>· Portal Cliente</span>
            </div>

            <div style={{ flex: 1 }}/>

            <p style={{ fontSize: 10.5, fontWeight: 700, color: "rgba(255,255,255,0.45)", letterSpacing: "1.4px", textTransform: "uppercase" as const, margin: "0 0 14px" }}>v3.2 · Acceso seguro</p>
            <h1 style={{ fontFamily: C.fontSans, fontWeight: 800, fontSize: 52, lineHeight: 1.02, letterSpacing: -1.6, margin: "0 0 18px", color: "#fff" }}>
              Control total<br/>de tu flota<br/><span style={{ color: "#7BA6E0" }}>contratada.</span>
            </h1>
            <p style={{ fontSize: 15, lineHeight: 1.55, color: "rgba(255,255,255,0.6)", maxWidth: 420, margin: "0 0 40px", fontWeight: 500 }}>
              Seguimiento GPS en vivo, manifiestos MTC, embarques por parada y reportes auditables.
            </p>

            {/* Stats grid */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 18, maxWidth: 420, marginBottom: 40 }}>
              {[["1,284","servicios / mes"],["42K","pasajeros embarcados"],["99.4%","cumplimiento SLA"]].map(([n,l]) => (
                <div key={l}>
                  <p style={{ fontFamily: C.fontMono, fontWeight: 700, fontSize: 22, color: "#fff", margin: "0 0 4px", letterSpacing: -0.4 }}>{n}</p>
                  <p style={{ margin: 0, fontSize: 10.5, color: "rgba(255,255,255,0.45)", fontWeight: 600, textTransform: "uppercase" as const, letterSpacing: "0.8px" }}>{l}</p>
                </div>
              ))}
            </div>

            <div style={{ flex: 1 }}/>

            {/* TLS badge */}
            <div style={{ display: "flex", alignItems: "center", gap: 10, padding: "12px 16px", background: "rgba(255,255,255,0.04)", border: "1px solid rgba(255,255,255,0.08)", borderRadius: 8 }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#7BA6E0" strokeWidth="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
              <div>
                <p style={{ margin: 0, fontSize: 12, fontWeight: 700, color: "#fff" }}>Conexión cifrada · TLS 1.3</p>
                <p style={{ margin: "2px 0 0", fontSize: 11, color: "rgba(255,255,255,0.45)" }}>Tus datos viajan protegidos en todo momento</p>
              </div>
            </div>

            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 24 }}>
              <p style={{ margin: 0, fontSize: 10.5, color: "rgba(255,255,255,0.35)", fontWeight: 500 }}>© 2026 AFA Tours Peru S.A.C.</p>
              <p style={{ margin: 0, fontSize: 10.5, color: "rgba(255,255,255,0.45)", fontWeight: 600 }}>Estado: <span style={{ color: "#7EE3B0" }}>● operativo</span></p>
            </div>
          </div>
        </div>

        {/* PANEL DERECHO: formulario */}
        <div className="pc-right">
          <div style={{ width: "100%", maxWidth: 420 }}>
            <p style={{ fontSize: 10.5, fontWeight: 700, color: C.mute, letterSpacing: "1.4px", textTransform: "uppercase" as const, margin: "0 0 8px" }}>Acceso clientes corporativos</p>
            <h2 style={{ fontFamily: C.fontSans, fontWeight: 800, fontSize: 30, letterSpacing: -0.7, margin: "0 0 10px", color: C.ink }}>Iniciar sesión</h2>
            <p style={{ fontSize: 14, color: C.mute, margin: "0 0 32px", lineHeight: 1.55 }}>
              Ingresa el RUC de tu empresa, tu documento o celular y tu contraseña.
            </p>

            {/* Campo RUC */}
            <div style={{ marginBottom: 18 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.ink2, marginBottom: 7, letterSpacing: "0.3px", textTransform: "uppercase" as const }}>RUC de tu empresa</label>
              <div style={{ display: "flex", alignItems: "center", border: `1.5px solid ${rucValido ? C.success : rucInput ? C.navy : C.line2}`, borderRadius: 8, background: "#fff", padding: "0 14px", height: 48, transition: "border-color .15s", boxShadow: rucInput ? `0 0 0 3px ${rucValido ? "rgba(21,128,61,.08)" : "rgba(11,49,95,.08)"}` : "none" }}>
                <span style={{ fontFamily: C.fontMono, fontSize: 13, color: C.mute, paddingRight: 8, borderRight: `1px solid ${C.line}`, marginRight: 10, flexShrink: 0 }}>PE</span>
                <input
                  value={rucInput}
                  onChange={e => { setRucInput(e.target.value.replace(/\D/g,"")); setLoginErr(""); }}
                  onKeyDown={e => e.key === "Enter" && login()}
                  placeholder="20123456789"
                  maxLength={11}
                  style={{ flex: 1, border: "none", outline: "none", fontFamily: C.fontMono, fontSize: 15, fontWeight: 600, color: C.ink, letterSpacing: 1, background: "transparent" }}
                />
                {rucValido && (
                  <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2.5" strokeLinecap="round"><polyline points="20 6 9 17 4 12"/></svg>
                )}
              </div>
              {rucValido && (
                <p style={{ margin: "7px 0 0", fontSize: 11.5, color: C.success, fontWeight: 600, display: "flex", alignItems: "center", gap: 5 }}>
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  RUC válido · 11 dígitos
                </p>
              )}
            </div>

            {/* Campo Identificación */}
            <div style={{ marginBottom: 18 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 7 }}>
                <label style={{ fontSize: 11, fontWeight: 700, color: C.ink2, letterSpacing: "0.3px", textTransform: "uppercase" as const }}>Identificación del usuario</label>
              </div>
              {/* Pills selector de tipo */}
              <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
                {(["DNI","CE","Celular"] as const).map(t => (
                  <button key={t} type="button"
                    onClick={() => { setTipoIdInput(t); setDniInput(""); setLoginErr(""); }}
                    style={{ flex: 1, padding: "6px 0", borderRadius: 6, border: `1.5px solid ${tipoIdInput === t ? C.navy : C.line2}`, background: tipoIdInput === t ? C.navyTint : "#fff", color: tipoIdInput === t ? C.navy : C.mute, fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "all .12s" }}>
                    {t === "CE" ? "Cédula / CE" : t}
                  </button>
                ))}
              </div>
              {/* Input */}
              <div style={{ display: "flex", alignItems: "center", border: `1.5px solid ${dniInput ? C.navy : C.line2}`, borderRadius: 8, background: "#fff", padding: "0 14px", height: 48, transition: "border-color .15s", boxShadow: dniInput ? "0 0 0 3px rgba(11,49,95,.08)" : "none" }}>
                {tipoIdInput === "Celular"
                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="2" style={{ flexShrink: 0 }}><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>
                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="2" style={{ flexShrink: 0 }}><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>
                }
                <input
                  value={dniInput}
                  onChange={e => {
                    const v = e.target.value;
                    const cleaned = (tipoIdInput === "DNI" || tipoIdInput === "Celular") ? v.replace(/\D/g,"") : v.replace(/[^a-zA-Z0-9]/g,"");
                    setDniInput(cleaned);
                    setLoginErr("");
                  }}
                  onKeyDown={e => e.key === "Enter" && login()}
                  placeholder={tipoIdInput === "DNI" ? "12345678" : tipoIdInput === "CE" ? "000123456" : "3001234567"}
                  maxLength={tipoIdInput === "DNI" ? 8 : 15}
                  style={{ flex: 1, border: "none", outline: "none", marginLeft: 10, fontFamily: C.fontMono, fontSize: 15, fontWeight: 600, color: C.ink, background: "transparent", letterSpacing: 1 }}
                />
              </div>
            </div>

            {/* Campo contraseña */}
            <div style={{ marginBottom: 14 }}>
              <label style={{ display: "block", fontSize: 11, fontWeight: 700, color: C.ink2, marginBottom: 7, letterSpacing: "0.3px", textTransform: "uppercase" as const }}>Contraseña / Código de acceso</label>
              <div style={{ display: "flex", alignItems: "center", border: `1.5px solid ${passwordInput ? C.navy : C.line2}`, borderRadius: 8, background: "#fff", padding: "0 14px", height: 48, transition: "border-color .15s", boxShadow: passwordInput ? "0 0 0 3px rgba(11,49,95,.08)" : "none" }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="2" style={{ flexShrink: 0 }}><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
                <input
                  type={showPassword ? "text" : "password"}
                  value={passwordInput}
                  onChange={e => { setPasswordInput(e.target.value); setLoginErr(""); }}
                  onKeyDown={e => e.key === "Enter" && login()}
                  placeholder="⬢⬢⬢⬢⬢⬢⬢⬢⬢⬢⬢⬢"
                  style={{ flex: 1, border: "none", outline: "none", marginLeft: 10, fontFamily: C.fontMono, fontSize: 15, fontWeight: 600, color: C.ink, background: "transparent" }}
                />
                <button onClick={() => setShowPassword(v => !v)} style={{ background: "none", border: "none", cursor: "pointer", color: C.mute, padding: 4, display: "flex", alignItems: "center" }}>
                  {showPassword
                    ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                    : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                  }
                </button>
              </div>
            </div>

            {/* Mantener sesión + Olvidaste */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 22 }}>
              <label style={{ display: "flex", alignItems: "center", gap: 7, fontSize: 12.5, color: C.ink2, fontWeight: 600, cursor: "pointer" }}>
                <span style={{ width: 16, height: 16, borderRadius: 4, background: C.navy, display: "inline-flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                </span>
                Mantener sesión por 8 horas
              </label>
              <a onClick={() => { setModalReset(true); setResetRuc(rucInput); }} style={{ fontSize: 12.5, color: C.navy, fontWeight: 700, textDecoration: "none", cursor: "pointer" }}>¿Olvidaste tu acceso?</a>
            </div>

            {/* Error */}
            {loginErr && (
              <div style={{ background: C.dangerTint, border: `1px solid ${C.danger}30`, borderRadius: 8, padding: "10px 14px", marginBottom: 14, display: "flex", alignItems: "center", gap: 8 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.danger} strokeWidth="2" style={{ flexShrink: 0 }}><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>
                <p style={{ color: C.danger, fontSize: 13, fontWeight: 600, margin: 0 }}>{loginErr}</p>
              </div>
            )}

            {/* Botón principal */}
            <button className="pc-btn-primary" onClick={login} disabled={loginLoad || !rucInput.trim() || !dniInput.trim() || !passwordInput.trim()}>
              {loginLoad
                ? <><span style={{ width: 16, height: 16, border: "2.5px solid rgba(255,255,255,0.3)", borderTopColor: "white", borderRadius: "50%", animation: "spin 0.7s linear infinite", display: "inline-block" }} /> Verificando...</>
                : <>Acceder al portal <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5"><line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/></svg></>
              }
            </button>

            <p style={{ margin: "24px 0 0", fontSize: 12.5, color: C.mute, textAlign: "center" as const }}>
              ¿Eres nuevo cliente?{" "}
              <a href={`https://wa.me/51${(empresa?.telefono||"966707225").replace(/\D/g,"")}`} target="_blank" rel="noopener noreferrer" style={{ color: C.navy, fontWeight: 700, textDecoration: "none" }}>
                Solicita acceso →
              </a>
            </p>
          </div>
        </div>

      </div>

      {/* MODAL RESET — dentro del login */}
      {modalReset && (
        <div onClick={e => { if (e.target === e.currentTarget) cerrarModalReset(); }}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(7,31,61,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, backdropFilter: "blur(4px)" }}>
          <div style={{ background: "#FFFFFF", borderRadius: 20, width: "100%", maxWidth: 420, boxShadow: "0 24px 64px rgba(0,0,0,0.25)", overflow: "hidden" }}>

            {/* Cabecera */}
            <div style={{ background: "#071f3d", padding: "22px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", letterSpacing: "0.12em", textTransform: "uppercase" as const }}>
                  {resetOk ? "Listo" : resetStep === 1 ? "Paso 1 de 2" : "Paso 2 de 2"}
                </p>
                <p style={{ margin: "3px 0 0", fontSize: 16, fontWeight: 800, color: "white" }}>
                  {resetOk ? "Contraseña actualizada" : resetStep === 1 ? "Recuperar acceso" : "Ingresa el código"}
                </p>
              </div>
              <button onClick={cerrarModalReset}
                style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "white" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Barra de progreso */}
            {!resetOk && (
              <div style={{ height: 3, background: "#E6E2D6" }}>
                <div style={{ height: "100%", width: resetStep === 1 ? "50%" : "100%", background: "#0b315f", transition: "width 0.4s ease" }} />
              </div>
            )}

            <div style={{ padding: "28px 28px 24px" }}>

              {/* ── ÉXITO ── */}
              {resetOk && (
                <div style={{ textAlign: "center" as const, padding: "12px 0 8px" }}>
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: "#E3F1E6", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="#15803d" strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <p style={{ fontWeight: 800, fontSize: 16, color: "#0A0E1A", margin: "0 0 8px" }}>¡Contraseña actualizada!</p>
                  <p style={{ fontSize: 13.5, color: "#6B6F7C", margin: "0 0 24px", lineHeight: 1.55 }}>Ya puedes iniciar sesión con tu nueva contraseña.</p>
                  <button onClick={cerrarModalReset}
                    style={{ width: "100%", padding: 13, borderRadius: 12, border: "none", background: "#0b315f", color: "white", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
                    Ir al login
                  </button>
                </div>
              )}

              {/* ── PASO 1: RUC + EMAIL ── */}
              {!resetOk && resetStep === 1 && (
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 13.5, color: "#6B6F7C", lineHeight: 1.55 }}>
                    Ingresa el RUC de tu empresa y tu correo registrado en el portal. Te enviaremos un código de 6 caracteres.
                  </p>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: "#1F2433", marginBottom: 6 }}>RUC de la empresa</label>
                    <input value={resetRuc} onChange={e => setResetRuc(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && solicitarReset()}
                      placeholder="20XXXXXXXXX" maxLength={11}
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1.5px solid #E6E2D6", fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: "#F6F4EE" }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: "#1F2433", marginBottom: 6 }}>Tu correo electrónico</label>
                    <input type="email" value={resetEmail} onChange={e => setResetEmail(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && solicitarReset()}
                      placeholder="correo@empresa.com"
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1.5px solid #E6E2D6", fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: "#F6F4EE" }} />
                  </div>
                  {resetErr && (
                    <p style={{ margin: 0, fontSize: 12.5, color: "#B91C1C", fontWeight: 600, background: "#FCE5E2", padding: "8px 12px", borderRadius: 8 }}>{resetErr}</p>
                  )}
                  <button onClick={solicitarReset} disabled={resetLoad}
                    style={{ width: "100%", padding: 13, borderRadius: 12, border: "none", background: resetLoad ? "#9AA0AC" : "#0b315f", color: "white", fontWeight: 800, fontSize: 14, cursor: resetLoad ? "not-allowed" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                    {resetLoad ? "Enviando..." : "Enviar código →"}
                  </button>
                </div>
              )}

              {/* ── PASO 2: CÓDIGO + NUEVA CONTRASEÑA ── */}
              {!resetOk && resetStep === 2 && (
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                  <div style={{ background: "#E3F1E6", border: "1px solid rgba(21,128,61,0.2)", borderRadius: 10, padding: "10px 14px" }}>
                    <p style={{ margin: 0, fontSize: 12.5, color: "#15803d", fontWeight: 600 }}>
                      Código enviado a <strong>{resetEmail}</strong>. Revisa tu bandeja de entrada (y spam).
                    </p>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: "#1F2433", marginBottom: 6 }}>Código de 6 caracteres</label>
                    <input value={resetToken} onChange={e => setResetToken(e.target.value.toUpperCase())}
                      placeholder="Ej: A3KP7M" maxLength={6}
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: "1.5px solid #E6E2D6", fontSize: 22, fontWeight: 800, letterSpacing: "0.35em", outline: "none", fontFamily: "ui-monospace, monospace", textAlign: "center" as const, textTransform: "uppercase" as const, boxSizing: "border-box" as const, background: "#F6F4EE" }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: "#1F2433", marginBottom: 6 }}>Nueva contraseña</label>
                    <div style={{ position: "relative" as const }}>
                      <input type={showRPass ? "text" : "password"} value={resetPass} onChange={e => setResetPass(e.target.value)}
                        placeholder="Mínimo 6 caracteres"
                        style={{ width: "100%", padding: "11px 40px 11px 14px", borderRadius: 10, border: "1.5px solid #E6E2D6", fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: "#F6F4EE" }} />
                      <button onClick={() => setShowRPass(p => !p)} type="button"
                        style={{ position: "absolute" as const, right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#6B6F7C", padding: 4 }}>
                        {showRPass
                          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: "#1F2433", marginBottom: 6 }}>Confirmar contraseña</label>
                    <input type={showRPass ? "text" : "password"} value={resetPass2} onChange={e => setResetPass2(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && confirmarReset()}
                      placeholder="Repite la contraseña"
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${resetPass2 && resetPass !== resetPass2 ? "#B91C1C" : "#E6E2D6"}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: "#F6F4EE" }} />
                  </div>
                  {resetErr && (
                    <p style={{ margin: 0, fontSize: 12.5, color: "#B91C1C", fontWeight: 600, background: "#FCE5E2", padding: "8px 12px", borderRadius: 8 }}>{resetErr}</p>
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={() => { setResetStep(1); setResetErr(""); setResetToken(""); setResetPass(""); setResetPass2(""); }}
                      style={{ flex: 1, padding: 12, borderRadius: 12, border: "1.5px solid #E6E2D6", background: "white", color: "#6B6F7C", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                      ← Volver
                    </button>
                    <button onClick={confirmarReset} disabled={resetLoad}
                      style={{ flex: 2, padding: 12, borderRadius: 12, border: "none", background: resetLoad ? "#9AA0AC" : "#0b315f", color: "white", fontWeight: 800, fontSize: 14, cursor: resetLoad ? "not-allowed" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8 }}>
                      {resetLoad ? "Verificando..." : "Guardar contraseña"}
                    </button>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: "#6B6F7C", textAlign: "center" as const }}>
                    ¿No llegó el correo?{" "}
                    <a onClick={() => { setResetStep(1); setResetErr(""); setResetToken(""); setResetPass(""); setResetPass2(""); }}
                      style={{ color: "#0b315f", fontWeight: 700, cursor: "pointer" }}>
                      Pedir otro código
                    </a>
                  </p>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

    </div>
  );

  // ─── PORTAL AUTENTICADO ───────────────────────────────────────────────────
  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column" as const, background: C.bg, fontFamily: C.fontSans }}>
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Manrope:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;600;700&display=swap');
        @keyframes pcPulse{0%,100%{opacity:1;transform:scale(1)}60%{opacity:.4;transform:scale(1.8)}}
        @keyframes pulse{0%,100%{opacity:1;transform:scale(1)}50%{opacity:.6;transform:scale(1.15)}}
        @keyframes spin{to{transform:rotate(360deg)}}
        @keyframes fadeIn{from{opacity:0;transform:translateY(8px)}to{opacity:1;transform:translateY(0)}}
      `}</style>

      {/* MODAL RESET CONTRASEÑA */}
      {modalReset && (
        <div onClick={e => { if (e.target === e.currentTarget) cerrarModalReset(); }}
          style={{ position: "fixed", inset: 0, zIndex: 100, background: "rgba(7,31,61,0.65)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20, backdropFilter: "blur(4px)" }}>
          <div style={{ background: C.surface, borderRadius: 20, width: "100%", maxWidth: 420, boxShadow: "0 24px 64px rgba(0,0,0,0.25)", overflow: "hidden" }}>

            {/* Cabecera */}
            <div style={{ background: C.navyDeep, padding: "22px 28px", display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <div>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", letterSpacing: "0.12em", textTransform: "uppercase" as const }}>
                  {resetOk ? "Listo" : resetStep === 1 ? "Paso 1 de 2" : "Paso 2 de 2"}
                </p>
                <p style={{ margin: "3px 0 0", fontSize: 16, fontWeight: 800, color: "white" }}>
                  {resetOk ? "Contraseña actualizada" : resetStep === 1 ? "Recuperar acceso" : "Nuevo código recibido"}
                </p>
              </div>
              <button onClick={cerrarModalReset}
                style={{ background: "rgba(255,255,255,0.08)", border: "none", borderRadius: 8, width: 32, height: 32, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", color: "white" }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
              </button>
            </div>

            {/* Barra de progreso */}
            {!resetOk && (
              <div style={{ height: 3, background: C.line }}>
                <div style={{ height: "100%", width: resetStep === 1 ? "50%" : "100%", background: C.navy, transition: "width 0.4s ease", borderRadius: "0 2px 2px 0" }} />
              </div>
            )}

            <div style={{ padding: "28px 28px 24px" }}>

              {/* ── PASO OK ── */}
              {resetOk && (
                <div style={{ textAlign: "center" as const, padding: "12px 0 8px" }}>
                  <div style={{ width: 56, height: 56, borderRadius: "50%", background: C.successTint, border: `2px solid ${C.success}30`, display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 16px" }}>
                    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2.5"><polyline points="20 6 9 17 4 12"/></svg>
                  </div>
                  <p style={{ fontWeight: 800, fontSize: 16, color: C.ink, margin: "0 0 8px" }}>¡Contraseña actualizada!</p>
                  <p style={{ fontSize: 13.5, color: C.mute, margin: "0 0 24px", lineHeight: 1.55 }}>
                    Ya puedes iniciar sesión con tu nueva contraseña.
                  </p>
                  <button onClick={cerrarModalReset}
                    style={{ width: "100%", padding: "13px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 800, fontSize: 14, cursor: "pointer", fontFamily: "inherit" }}>
                    Ir al login
                  </button>
                </div>
              )}

              {/* ── PASO 1: RUC + EMAIL ── */}
              {!resetOk && resetStep === 1 && (
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                  <p style={{ margin: "0 0 4px", fontSize: 13.5, color: C.mute, lineHeight: 1.55 }}>
                    Ingresa el RUC de tu empresa y el correo que tiene registrado en el portal. Te enviaremos un código para restablecer tu contraseña.
                  </p>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6, letterSpacing: "0.04em" }}>RUC de la empresa</label>
                    <input
                      value={resetRuc} onChange={e => setResetRuc(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && solicitarReset()}
                      placeholder="20XXXXXXXXX" maxLength={11}
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${C.line2}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6, letterSpacing: "0.04em" }}>Tu correo electrónico</label>
                    <input
                      type="email" value={resetEmail} onChange={e => setResetEmail(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && solicitarReset()}
                      placeholder="correo@empresa.com"
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${C.line2}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                  </div>
                  {resetErr && (
                    <p style={{ margin: 0, fontSize: 12.5, color: C.danger, fontWeight: 600, background: C.dangerTint, padding: "8px 12px", borderRadius: 8 }}>{resetErr}</p>
                  )}
                  <button onClick={solicitarReset} disabled={resetLoad}
                    style={{ width: "100%", padding: "13px", borderRadius: 12, border: "none", background: resetLoad ? C.mute2 : C.navy, color: "white", fontWeight: 800, fontSize: 14, cursor: resetLoad ? "not-allowed" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "background 0.2s" }}>
                    {resetLoad
                      ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Enviando...</>
                      : "Enviar código →"}
                  </button>
                </div>
              )}

              {/* ── PASO 2: CÓDIGO + NUEVA CONTRASEÑA ── */}
              {!resetOk && resetStep === 2 && (
                <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                  <div style={{ background: C.successTint, border: `1px solid ${C.success}30`, borderRadius: 10, padding: "10px 14px", display: "flex", alignItems: "center", gap: 10 }}>
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.6"/><path d="M22 10.92V8a2 2 0 0 0-2-2h-6"/><polyline points="9 11 12 14 22 4"/></svg>
                    <p style={{ margin: 0, fontSize: 12.5, color: C.success, fontWeight: 600 }}>
                      Código enviado a <strong>{resetEmail}</strong>. Revisa tu bandeja de entrada.
                    </p>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6, letterSpacing: "0.04em" }}>Código de 6 caracteres</label>
                    <input
                      value={resetToken} onChange={e => setResetToken(e.target.value.toUpperCase())}
                      placeholder="EJ: A3KP7M" maxLength={6}
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${C.line2}`, fontSize: 20, fontWeight: 800, letterSpacing: "0.3em", outline: "none", fontFamily: "ui-monospace, monospace", textAlign: "center" as const, textTransform: "uppercase" as const, boxSizing: "border-box" as const, background: C.bg }} />
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6, letterSpacing: "0.04em" }}>Nueva contraseña</label>
                    <div style={{ position: "relative" as const }}>
                      <input
                        type={showRPass ? "text" : "password"} value={resetPass} onChange={e => setResetPass(e.target.value)}
                        placeholder="Mínimo 6 caracteres"
                        style={{ width: "100%", padding: "11px 40px 11px 14px", borderRadius: 10, border: `1.5px solid ${C.line2}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                      <button onClick={() => setShowRPass(p => !p)} type="button"
                        style={{ position: "absolute" as const, right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.mute, padding: 4 }}>
                        {showRPass
                          ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94"/><path d="M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                          : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                      </button>
                    </div>
                  </div>
                  <div>
                    <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6, letterSpacing: "0.04em" }}>Confirmar contraseña</label>
                    <input
                      type={showRPass ? "text" : "password"} value={resetPass2} onChange={e => setResetPass2(e.target.value)}
                      onKeyDown={e => e.key === "Enter" && confirmarReset()}
                      placeholder="Repite la contraseña"
                      style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${resetPass2 && resetPass !== resetPass2 ? C.danger : C.line2}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                  </div>
                  {resetErr && (
                    <p style={{ margin: 0, fontSize: 12.5, color: C.danger, fontWeight: 600, background: C.dangerTint, padding: "8px 12px", borderRadius: 8 }}>{resetErr}</p>
                  )}
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={() => { setResetStep(1); setResetErr(""); setResetToken(""); setResetPass(""); setResetPass2(""); }}
                      style={{ flex: 1, padding: "12px", borderRadius: 12, border: `1.5px solid ${C.line2}`, background: C.surface, color: C.mute, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit" }}>
                      ← Volver
                    </button>
                    <button onClick={confirmarReset} disabled={resetLoad}
                      style={{ flex: 2, padding: "12px", borderRadius: 12, border: "none", background: resetLoad ? C.mute2 : C.navy, color: "white", fontWeight: 800, fontSize: 14, cursor: resetLoad ? "not-allowed" : "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", justifyContent: "center", gap: 8, transition: "background 0.2s" }}>
                      {resetLoad
                        ? <><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2.5" style={{ animation: "spin 1s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> Verificando...</>
                        : "Guardar contraseña"}
                    </button>
                  </div>
                  <p style={{ margin: 0, fontSize: 12, color: C.mute, textAlign: "center" as const }}>
                    ¿No recibiste el correo?{" "}
                    <a onClick={() => { setResetStep(1); setResetErr(""); setResetToken(""); setResetPass(""); setResetPass2(""); }}
                      style={{ color: C.navy, fontWeight: 700, cursor: "pointer" }}>
                      Solicitar de nuevo
                    </a>
                  </p>
                </div>
              )}

            </div>
          </div>
        </div>
      )}

      {/* MODAL GPS */}
      {gpsModalOpen && gpsModalRes && (
        <ModalGps
          reservaId={gpsModalRes.id}
          vehiculoId={gpsModalRes.vehiculo_id}
          vehiculoTerceroId={(gpsModalRes as any).vehiculo_tercero_id ?? null}
          vehiculoPlaca={vehiculoInfo?.placa || "–"}
          conductorNombre={conductorInfo?.nombre || "–"}
          conductorTel={conductorInfo?.telefono || ""}
          clienteNombre={cliente.empresa || cliente.nombre}
          paradas={paradas[gpsModalRes.id] || []}
          paradasJson={(gpsModalRes as any)?.paradas_json}
          origen={gpsModalRes.origen}
          destino={gpsModalRes.destino}
          modoCliente
          onClose={() => { setGpsModalOpen(false); setGpsModalRes(null); }}
        />
      )}

      {/* ══ PANEL NOTIFICACIONES ══ */}
      {modalNotif && (
        <div onClick={() => setModalNotif(false)} style={{ position: "fixed", inset: 0, zIndex: 60, background: "rgba(7,20,40,0.55)", backdropFilter: "blur(2px)" }}>
          <div onClick={e => e.stopPropagation()}
            style={{ position: "absolute", top: 56, right: 12, width: 360, maxHeight: "calc(100vh - 80px)", background: "white", borderRadius: 16, boxShadow: "0 20px 60px rgba(0,0,0,0.25)", display: "flex", flexDirection: "column", overflow: "hidden", animation: "fadeIn 0.15s ease" }}>

            {/* Cabecera */}
            <div style={{ background: C.navyDeep, padding: "14px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                <p style={{ color: "white", fontWeight: 800, fontSize: 14, margin: 0 }}>Notificaciones</p>
                {notifs.length > 0 && (
                  <span style={{ background: notifs.filter(n => n.tipo === "warning").length > 0 ? C.danger : "#2563eb", color: "white", fontSize: 10, fontWeight: 800, borderRadius: 8, padding: "1px 6px" }}>{notifs.length}</span>
                )}
              </div>
              <button onClick={() => setModalNotif(false)} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 8, width: 28, height: 28, color: "white", fontSize: 16, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center" }}>×</button>
            </div>

            {/* Cuerpo scrollable */}
            <div style={{ overflowY: "auto", flex: 1 }}>

              {notifs.length === 0 ? (
                <div style={{ padding: "40px 24px", textAlign: "center" as const }}>
                  <svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="1.4" style={{ margin: "0 auto 12px", display: "block" }}><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                  <p style={{ color: C.mute, fontSize: 13, margin: 0, fontWeight: 600 }}>Todo al día</p>
                  <p style={{ color: C.mute2, fontSize: 12, margin: "4px 0 0" }}>Sin alertas pendientes</p>
                </div>
              ) : (
                <div style={{ padding: "12px 14px", display: "flex", flexDirection: "column" as const, gap: 8 }}>

                  {/* ── Alertas urgentes ── */}
                  {notifs.filter(n => n.tipo === "warning").length > 0 && (
                    <div>
                      <p style={{ fontFamily: C.fontMono, fontSize: 9.5, fontWeight: 700, color: C.warn, letterSpacing: "0.1em", textTransform: "uppercase" as const, margin: "4px 0 6px 2px" }}>
                        ⚠ Requiere atención
                      </p>
                      {notifs.filter(n => n.tipo === "warning").map(n => (
                        <div key={n.id} style={{ display: "flex", gap: 10, padding: "10px 12px", background: C.warnTint, border: `1px solid rgba(166,91,10,0.25)`, borderRadius: 10, marginBottom: 6, alignItems: "flex-start" }}>
                          <div style={{ width: 32, height: 32, borderRadius: 8, background: "rgba(166,91,10,0.15)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.warn} strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontWeight: 700, color: C.ink, fontSize: 12.5, margin: 0 }}>{n.titulo}</p>
                            <p style={{ color: C.mute, fontSize: 11.5, margin: "2px 0 0", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{n.desc}</p>
                            {n.fecha && <p style={{ color: C.warn, fontSize: 10.5, margin: "4px 0 0", fontFamily: C.fontMono }}>{fmtFecha(n.fecha)}</p>}
                          </div>
                          <button onClick={() => { setModalNotif(false); setTab("facturacion"); }} style={{ flexShrink: 0, background: "none", border: "none", color: C.warn, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: "2px 4px", fontFamily: "inherit" }}>Ver →</button>
                        </div>
                      ))}
                    </div>
                  )}

                  {/* ── Servicios ── */}
                  {notifs.filter(n => n.tipo === "info" || n.tipo === "success").length > 0 && (
                    <div>
                      <p style={{ fontFamily: C.fontMono, fontSize: 9.5, fontWeight: 700, color: C.navy, letterSpacing: "0.1em", textTransform: "uppercase" as const, margin: "4px 0 6px 2px" }}>
                        Servicios
                      </p>
                      {notifs.filter(n => n.tipo === "info" || n.tipo === "success").map(n => (
                        <div key={n.id} style={{ display: "flex", gap: 10, padding: "10px 12px", background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, marginBottom: 6, alignItems: "flex-start" }}>
                          <div style={{ width: 32, height: 32, borderRadius: 8, background: n.tipo === "info" ? C.infoTint : C.successTint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            {n.tipo === "info"
                              ? <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.info} strokeWidth="2"><rect x="1" y="3" width="15" height="13" rx="2"/><polygon points="16 8 20 8 23 11 23 16 16 16 16 8"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                              : <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg>
                            }
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontWeight: 700, color: C.ink, fontSize: 12.5, margin: 0 }}>{n.titulo}</p>
                            <p style={{ color: C.mute, fontSize: 11.5, margin: "2px 0 0", whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{n.desc}</p>
                          </div>
                          <button onClick={() => { setModalNotif(false); setTab(n.titulo.toLowerCase().includes("ruta") || n.titulo.toLowerCase().includes("hoy") || n.titulo.toLowerCase().includes("mañana") ? "activos" : "historial"); }} style={{ flexShrink: 0, background: "none", border: "none", color: C.navy, fontSize: 11, fontWeight: 700, cursor: "pointer", padding: "2px 4px", fontFamily: "inherit" }}>Ver →</button>
                        </div>
                      ))}
                    </div>
                  )}

                </div>
              )}
            </div>

            {/* Pie */}
            <div style={{ padding: "10px 14px", borderTop: `1px solid ${C.line}`, background: C.surfaceAlt, flexShrink: 0, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <p style={{ color: C.mute, fontSize: 11, margin: 0 }}>Portal cliente · AFA Tours</p>
              <button onClick={() => { setModalNotif(false); setModalFaq(true); }} style={{ background: "none", border: "none", color: C.navy, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                ¿Necesitas ayuda? →
              </button>
            </div>
          </div>
        </div>
      )}

      {/* MODAL FAQ */}
      {modalFaq && (
        <div onClick={() => setModalFaq(false)} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div onClick={e => e.stopPropagation()} style={{ background: "white", borderRadius: 24, boxShadow: "0 24px 60px rgba(0,0,0,0.2)", width: "100%", maxWidth: 560, maxHeight: "85vh", overflow: "hidden", display: "flex", flexDirection: "column" }}>
            <div style={{ background: C.navy, padding: "20px 24px", display: "flex", justifyContent: "space-between", alignItems: "center" }}>
              <div>
                <p style={{ color: "white", fontWeight: 900, fontSize: 16, margin: 0 }}>Preguntas Frecuentes</p>
                <p style={{ color: "rgba(255,255,255,0.5)", fontSize: 12, margin: "4px 0 0" }}>Portal Empresarial AFA Tours</p>
              </div>
              <button onClick={() => setModalFaq(false)} style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 10, width: 34, height: 34, color: "white", fontSize: 18, cursor: "pointer" }}>×</button>
            </div>
            <div style={{ overflowY: "auto", padding: "16px 24px 24px" }}>
              <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 16 }}>
                <a href="/manuales/portal-cliente" target="_blank" rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderRadius: 14, border: `1px solid ${C.gray200}`, textDecoration: "none", background: "#eef3f8" }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, background: C.navy, color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>📘</span>
                  <span style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 800, fontSize: 13, color: C.navy }}>Manual del Portal Cliente</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11.5, color: C.gray600 }}>Guía completa de esta pantalla, paso a paso</p>
                  </span>
                  <span style={{ color: C.navy, fontSize: 14 }}>↗</span>
                </a>
                <a href="/manuales/pasajero" target="_blank" rel="noopener noreferrer"
                  style={{ display: "flex", alignItems: "center", gap: 12, padding: "13px 16px", borderRadius: 14, border: `1px solid ${C.gray200}`, textDecoration: "none", background: "#f0fdf4" }}>
                  <span style={{ width: 34, height: 34, borderRadius: 9, background: "#12876F", color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 15, flexShrink: 0 }}>🧳</span>
                  <span style={{ flex: 1 }}>
                    <p style={{ margin: 0, fontWeight: 800, fontSize: 13, color: "#0d6455" }}>Manual para tus pasajeros</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11.5, color: C.gray600 }}>Pásaselo a tu equipo: cómo usar la App Pasajero</p>
                  </span>
                  <span style={{ color: "#0d6455", fontSize: 14 }}>↗</span>
                </a>
              </div>
              {FAQ_ITEMS.map((item, i) => (
                <div key={i} style={{ marginBottom: 10, border: `1px solid ${C.gray200}`, borderRadius: 14, overflow: "hidden" }}>
                  <button onClick={() => setFaqOpen(faqOpen === i ? null : i)} style={{ width: "100%", padding: "14px 18px", background: faqOpen === i ? "#eef3f8" : "white", border: "none", cursor: "pointer", display: "flex", justifyContent: "space-between", alignItems: "center", gap: 12, textAlign: "left" }}>
                    <p style={{ fontWeight: 700, color: C.navy, fontSize: 13, margin: 0 }}>{item.q}</p>
                    <span style={{ color: C.navy, fontSize: 16, flexShrink: 0, display: "inline-block", transform: faqOpen === i ? "rotate(180deg)" : "none", transition: "transform 0.2s" }}>▾</span>
                  </button>
                  {faqOpen === i && (
                    <div style={{ padding: "12px 18px", background: "#f8fafc", borderTop: `1px solid ${C.gray100}` }}>
                      <p style={{ color: C.gray600, fontSize: 13, margin: 0, lineHeight: 1.6 }}>{item.a}</p>
                    </div>
                  )}
                </div>
              ))}
              <div style={{ marginTop: 16, background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 14, padding: "16px 18px" }}>
                <p style={{ color: C.green, fontWeight: 900, fontSize: 13, margin: "0 0 6px" }}>¿Necesitas más ayuda?</p>
                <p style={{ color: "#166534", fontSize: 12, margin: 0 }}>Escríbenos por <b>WhatsApp 966707225</b> o llama al <b>01-3453707</b></p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* HEADER */}
      <div style={{ background: C.navyDeep, borderBottom: "1px solid rgba(255,255,255,0.06)", padding: "0 20px", display: "flex", alignItems: "center", gap: 12, position: "sticky", top: 0, zIndex: 30, height: 56 }}>
        {/* Logo */}
        <div style={{ display: "flex", alignItems: "center", gap: 10, flexShrink: 0 }}>
          <img src="/logoafa-removebg-preview.png" alt="AFA Tours Peru" style={{ height: 36, objectFit: "contain", imageRendering: "-webkit-optimize-contrast" as any }} />
          <span style={{ color: "rgba(255,255,255,0.22)", fontSize: 9.5, fontWeight: 700, letterSpacing: "0.14em", textTransform: "uppercase" as const }}>PORTAL CLIENTE</span>
        </div>

        <div style={{ width: 1, height: 20, background: "rgba(255,255,255,0.1)", flexShrink: 0, marginLeft: 4 }} />

        {/* Badge en vivo */}
        {servicioActivo && efectivoEstado(servicioActivo) === "en_curso" && (
          <div style={{ background: "rgba(21,128,61,0.18)", border: "1px solid rgba(21,128,61,0.35)", borderRadius: 999, padding: "3px 10px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#4ade80", display: "inline-block", animation: "pcPulse 1.6s ease-out infinite" }} />
            <p style={{ color: "#4ade80", fontSize: 11, fontWeight: 700, margin: 0 }}>EN RUTA</p>
          </div>
        )}
        {servicioActivo && efectivoEstado(servicioActivo) !== "en_curso" && (
          <div style={{ background: "rgba(29,78,216,0.15)", border: "1px solid rgba(29,78,216,0.3)", borderRadius: 999, padding: "3px 10px", display: "flex", alignItems: "center", gap: 6, flexShrink: 0 }}>
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "#60a5fa", display: "inline-block" }} />
            <p style={{ color: "#60a5fa", fontSize: 11, fontWeight: 700, margin: 0 }}>HOY</p>
          </div>
        )}

        {/* Buscador */}
        <div style={{ flex: 1, maxWidth: 360, position: "relative" as const }}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth="2" style={{ position: "absolute", left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" }}><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>
          <input value={busqueda} onChange={e => setBusqueda(e.target.value)}
            placeholder="Buscar servicios, rutas, fechas..."
            style={{ width: "100%", background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "7px 14px 7px 33px", color: "white", fontSize: 12.5, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }}
          />
        </div>

        {/* Derecha */}
        <div style={{ display: "flex", gap: 6, alignItems: "center", marginLeft: "auto", flexShrink: 0 }}>
          {/* Bell — panel de notificaciones */}
          <button onClick={() => setModalNotif(true)} style={{ position: "relative" as const, background: notifs.length > 0 ? "rgba(255,255,255,0.1)" : "rgba(255,255,255,0.06)", border: notifs.length > 0 ? "1px solid rgba(255,255,255,0.2)" : "1px solid rgba(255,255,255,0.1)", borderRadius: 7, width: 34, height: 34, display: "flex", alignItems: "center", justifyContent: "center", cursor: "pointer", transition: "all 0.15s" }}>
            <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.8)" strokeWidth="2"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
            {notifs.length > 0 && (
              <span style={{ position: "absolute", top: 4, right: 4, minWidth: 14, height: 14, borderRadius: 7, background: notifs.filter(n => n.tipo === "warning").length > 0 ? C.danger : "#2563eb", border: "1.5px solid #071f3d", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 8.5, fontWeight: 800, color: "white", padding: "0 2px" }}>
                {notifs.length}
              </span>
            )}
          </button>
          {/* Ayuda → FAQ */}
          <button onClick={() => setModalFaq(true)} style={{ background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "6px 12px", color: "rgba(255,255,255,0.65)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            Ayuda
          </button>
          {/* Avatar empresa */}
          <button onClick={() => setTab("cuenta")} style={{ display: "flex", alignItems: "center", gap: 8, background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 8, padding: "5px 10px 5px 6px", cursor: "pointer" }}>
            <div style={{ width: 26, height: 26, borderRadius: 6, background: "#1a4a7a", display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 800, fontSize: 10.5, color: "white", flexShrink: 0 }}>
              {(portalUsuario?.nombre || cliente.empresa || cliente.nombre).split(" ").map((w: string) => w[0]).slice(0,2).join("").toUpperCase()}
            </div>
            <div style={{ textAlign: "left" as const }}>
              <p style={{ color: "rgba(255,255,255,0.9)", fontWeight: 700, fontSize: 11.5, margin: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{portalUsuario?.nombre || cliente.empresa || cliente.nombre}</p>
              <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 9.5, margin: 0, fontFamily: C.fontMono }}>{cliente.empresa ? cliente.empresa : `RUC ${cliente.ruc || "–"}`}</p>
            </div>
          </button>
          {/* Salir */}
          <button onClick={() => { clearSession(); setCliente(null); setReservas([]); }}
            style={{ background: "transparent", border: "1px solid rgba(255,255,255,0.1)", borderRadius: 7, padding: "6px 12px", color: "rgba(255,255,255,0.4)", fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit" }}>
            Salir
          </button>
        </div>
      </div>

      {/* TABS */}
      <div style={{ background: C.surface, borderBottom: `1px solid ${C.line}`, display: "flex", overflowX: "auto" as const, scrollbarWidth: "none" as const, paddingLeft: 8 }}>
        {([
          { id: "dashboard",   label: "Dashboard",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/></svg> },
          { id: "activos",     label: "En vivo",     dot: !!servicioActivo, badge: activosCount || undefined,
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 12h3l3-9 4 18 3-9h5"/></svg> },
          { id: "historial",   label: "Historial",   badge: reservas.length || undefined,
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg> },
          { id: "facturacion", label: "Facturación", badge: (facturas.filter(f => f.estado === "vencida").length) || undefined,
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg> },
          { id: "documentos",  label: "Documentos",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg> },
          { id: "cuenta",      label: "Cuenta",
            icon: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg> },
        ] as any[]).filter(t => tienePermiso(t.id)).map(t => {
          const active = tab === t.id;
          return (
            <button key={t.id} onClick={() => !t.disabled && setTab(t.id)}
              style={{ padding: "0 16px", height: 44, border: "none", background: "none", cursor: t.disabled ? "not-allowed" : "pointer", borderBottom: `2px solid ${active ? C.navy : "transparent"}`, color: active ? C.navy : t.disabled ? C.mute2 : C.mute, fontWeight: active ? 800 : 600, fontSize: 13, whiteSpace: "nowrap" as const, display: "flex", alignItems: "center", gap: 6, transition: "color .15s, border-color .15s", fontFamily: "inherit" }}>
              {t.icon}
              {t.label}
              {t.dot && <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.success, animation: "pcPulse 1.6s ease-out infinite", display: "inline-block" }} />}
              {t.badge !== undefined && (
                <span style={{ fontSize: 10, fontWeight: 700, background: active ? C.navyTint : C.surfaceAlt, color: active ? C.navy : C.mute, padding: "1px 7px", borderRadius: 4 }}>
                  {t.badge}
                </span>
              )}
            </button>
          );
        })}
      </div>

      <div style={{ flex: 1, padding: "20px 24px 48px", maxWidth: 1140, margin: "0 auto", width: "100%", boxSizing: "border-box" as const }}>

        {/* DASHBOARD */}
        {tab === "dashboard" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>

            {/* Title row */}
            <div style={{ display: "flex", alignItems: "flex-end", justifyContent: "space-between", gap: 12, marginBottom: 4 }}>
              <div>
                <p style={{ fontSize: 10.5, fontWeight: 700, color: C.mute, letterSpacing: "1.4px", textTransform: "uppercase" as const, margin: "0 0 6px" }}>
                  Resumen · {new Date().toLocaleDateString("es-PE",{weekday:"short",day:"2-digit",month:"short",year:"numeric"})}
                </p>
                <h1 style={{ fontFamily: C.fontSans, fontWeight: 800, fontSize: 24, letterSpacing: -0.5, margin: 0, color: C.ink }}>
                  {saludoHora}, {(portalUsuario?.nombre || cliente.nombre).split(" ")[0]}{cliente.empresa ? ` · ${cliente.empresa}` : ""}
                </h1>
                <p style={{ margin: "4px 0 0", fontSize: 13, color: C.mute }}>
                  {activosCount > 0 ? `${activosCount} servicio en ruta · ` : ""}{proximosSvcs.length} programados esta semana{notifs.filter(n => n.tipo === "warning").length > 0 ? ` · ${notifs.filter(n => n.tipo === "warning").length} alerta${notifs.filter(n => n.tipo === "warning").length !== 1 ? "s" : ""} activa${notifs.filter(n => n.tipo === "warning").length !== 1 ? "s" : ""}` : ""}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={{ padding: "8px 14px", borderRadius: 7, border: `1px solid ${C.line2}`, background: C.surface, color: C.ink2, fontSize: 12.5, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 6 }}>
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                  Exportar resumen
                </button>
                <a href="https://wa.me/51966707225?text=Hola%2C%20necesito%20programar%20un%20servicio" target="_blank" rel="noopener noreferrer"
                  style={{ padding: "8px 16px", borderRadius: 7, border: "none", background: C.navy, color: "white", fontSize: 12.5, fontWeight: 700, cursor: "pointer", textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 6 }}>
                  + Solicitar servicio
                </a>
              </div>
            </div>

            {/* KPI cards */}
            <div style={{ display: "grid", gridTemplateColumns: `repeat(${puedeVerMontos ? 5 : 3},1fr)`, gap: 10 }}>
              {([
                // "T12:00:00" y no la fecha pelada: `new Date("2026-08-01")` se interpreta
                // como medianoche UTC y, al formatearse en hora de Lima (UTC-5), retrocede
                // al 31 de julio — la tarjeta decía "SERVICIOS · JUL." estando en agosto.
                // Mismo patrón que ya usa agendaGrupos.
                { label: `Servicios · ${new Date(esteM + "-01T12:00:00").toLocaleDateString("es-PE",{month:"short"}).toUpperCase()}`, val: String(serviciosMes), delta: deltaServicios },
                { label: "Total histórico",  val: String(serviciosTotal), delta: null },
                ...(puedeVerMontos ? [{ label: "Gasto del mes", val: fmtSoles(gastoMes), delta: null }] : []),
                { label: "Cumplimiento SLA", val: `${puntualidad}%`,      delta: null },
                ...(puedeVerMontos ? [{ label: "Por pagar",     val: fmtSoles(porPagar), delta: null }] : []),
              ] as { label: string; val: string; delta: number | null }[]).map(k => (
                <div key={k.label} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 16px" }}>
                  <p style={{ fontSize: 10.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "1.2px", margin: "0 0 10px" }}>{k.label}</p>
                  <p style={{ fontFamily: C.fontMono, fontWeight: 700, fontSize: 22, color: C.navy, margin: 0, letterSpacing: -0.4, lineHeight: 1 }}>{k.val}</p>
                  {k.delta !== null && (
                    <p style={{ fontSize: 11, margin: "6px 0 0", color: k.delta > 0 ? C.success : k.delta < 0 ? C.danger : C.mute, fontWeight: 700 }}>
                      {k.delta > 0 ? "↑" : k.delta < 0 ? "↓" : "–"} {Math.abs(k.delta)} vs mes anterior
                    </p>
                  )}
                </div>
              ))}
            </div>

            {/* EN RUTA cards — todos los servicios activos (o el primero si ninguno en_curso) */}
            {serviciosDestacados.map(r => {
              const ps = paradas[r.id] || [];
              const pjson = (r as any).paradas_json as any[] | null;
              const psDisplay: Parada[] = ps.length > 0
                ? ps
                : (pjson || []).filter((p: any) => p.nombre).map((p: any, i: number) => ({
                    id: -(i + 1), reserva_id: r.id, orden: i + 1,
                    nombre: p.nombre, direccion: null,
                    lat: p.lat ? Number(p.lat) : null, lng: p.lng ? Number(p.lng) : null,
                    hora_estimada: p.hora || null, estado: "pendiente",
                  } as Parada));
              // Detectar parada actual: primera no-completada después de las completadas
              const ultimaCompletadaIdx = psDisplay.reduce((acc: number, p: Parada, i: number) => p.estado === "completada" ? i : acc, -1);
              const currentStopIdx = ultimaCompletadaIdx < psDisplay.length - 1 ? ultimaCompletadaIdx + 1 : 0;
              const hayCompletadas = ultimaCompletadaIdx >= 0;
              const gpsCard = gpsCardMap[r.id];
              const condCard = condInfoMap[r.id];
              const placaCard = vehPlacaMap[r.id];
              const etaCard    = etaDestinoMap[r.id];
              const etaAlejando = !!etaCard?.alejando;
              const etaHora     = etaCard?.hora || null;
              // Antigüedad del cálculo: es lo que separa "en vivo" de "una hora de hace 3 horas
              // pintada en verde", que era lo que veía el cliente.
              const etaViejoMin = etaCard?.ts ? Math.floor((Date.now() - etaCard.ts) / 60000) : 0;
              const destinoDisplay = psDisplay[psDisplay.length - 1];
              return (
                <div key={r.id} style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                  {/* Cabecera: info servicio + panel conductor/ETA */}
                  <div style={{ display: "grid", gridTemplateColumns: "1fr auto", gap: 0 }}>
                    {/* Panel izquierdo */}
                    <div style={{ padding: "18px 20px" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10 }}>
                        <span style={{ width: 7, height: 7, borderRadius: "50%", background: C.success, animation: "pcPulse 1.6s ease-out infinite", display: "inline-block" }} />
                        <p style={{ color: C.success, fontWeight: 800, fontSize: 11, margin: 0, letterSpacing: "1.2px", textTransform: "uppercase" as const }}>En curso · HOY</p>
                        <span style={{ fontFamily: C.fontMono, fontSize: 10.5, color: C.mute, marginLeft: "auto" }}>{idAfa(r)}</span>
                      </div>
                      <p style={{ fontFamily: C.fontSans, fontWeight: 800, fontSize: 17, letterSpacing: -0.4, margin: "0 0 4px", color: C.ink }}>
                        {r.origen} → {r.destino}
                      </p>
                      <p style={{ color: C.mute, fontSize: 12, margin: "0 0 12px" }}>
                        Turno {r.hora_servicio?.slice(0,5) || "–"} &nbsp;·&nbsp; {fmtFecha(r.fecha_servicio)}
                        {gpsCard && <span> &nbsp;·&nbsp; <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.ink2 }}>{gpsCard.velocidad} km/h</span></span>}
                      </p>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => abrirGps(r)} style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: C.navy, color: "white", fontWeight: 700, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, fontFamily: "inherit" }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                          Ver GPS
                        </button>
                        {condCard?.tel && (
                          <a href={`tel:${condCard.tel}`} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${C.line2}`, background: "transparent", color: C.navy, fontWeight: 700, fontSize: 12, cursor: "pointer", display: "inline-flex", alignItems: "center", gap: 5, textDecoration: "none", fontFamily: "inherit" }}>
                            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.6a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.59 3h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.09a16 16 0 0 0 6 6l1.27-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 17.19z"/></svg>
                            Llamar
                          </a>
                        )}
                      </div>
                    </div>
                    {/* Panel derecho — conductor / vehículo / ETA */}
                    <div style={{ width: 190, borderLeft: `1px solid ${C.line}`, background: C.bg, display: "flex", flexDirection: "column" as const, padding: "14px 16px", gap: 10, justifyContent: "center" }}>
                      {/* Conductor */}
                      <div>
                        <p style={{ fontSize: 8.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "1px", margin: "0 0 2px" }}>Conductor</p>
                        <p style={{ fontWeight: 700, color: C.ink, fontSize: 12.5, margin: 0, lineHeight: 1.2 }}>{condCard?.nombre || "Cargando…"}</p>
                      </div>
                      {/* Vehículo */}
                      {placaCard && (
                        <div>
                          <p style={{ fontSize: 8.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "1px", margin: "0 0 2px" }}>Placa</p>
                          <p style={{ fontFamily: C.fontMono, fontWeight: 800, color: C.navy, fontSize: 13.5, margin: 0, letterSpacing: 1 }}>{placaCard}</p>
                        </div>
                      )}
                      {/* Avance */}
                      {psDisplay.length > 0 && (
                        <div>
                          <p style={{ fontSize: 8.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "1px", margin: "0 0 2px" }}>Avance</p>
                          <p style={{ fontSize: 12, color: C.ink2, margin: 0 }}>
                            Parada&nbsp;<span style={{ fontWeight: 800, color: C.navy }}>{hayCompletadas ? ultimaCompletadaIdx + 1 : 0}</span>&nbsp;de&nbsp;{psDisplay.length}
                          </p>
                        </div>
                      )}
                      {/* ETA destino. La hora "en vivo" solo se presenta como tal si de verdad
                          lo es: pasados unos minutos se etiqueta su antigüedad, y si el bus se
                          aleja del destino no se pinta ninguna hora (era el bug: una llegada
                          calculada sobre una ruta de regreso que el bus no va a hacer). */}
                      {destinoDisplay && (
                        <div style={{ borderTop: `1px solid ${C.line}`, paddingTop: 8 }}>
                          <p style={{ fontSize: 8.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "1px", margin: "0 0 2px" }}>
                            {etaAlejando ? "Se aleja del destino" : etaHora ? "Llega ~" : "Planif. destino"}
                          </p>
                          <p style={{ fontFamily: C.fontMono, fontWeight: 800, fontSize: 19, color: etaAlejando ? C.warn : etaHora ? C.success : C.navy, margin: 0, lineHeight: 1 }}>
                            {etaAlejando ? "–" : etaHora || destinoDisplay.hora_estimada?.slice(0, 5) || "–"}
                          </p>
                          {etaAlejando ? (
                            // La frase está en PRESENTE, así que caduca: pasados unos minutos sin
                            // dato nuevo deja de afirmarse (el servicio pudo terminar y el GPS
                            // callar, y esto se quedaría en pantalla durante horas).
                            <p style={{ fontSize: 8.5, color: C.mute, margin: "3px 0 0", lineHeight: 1.3 }}>
                              {etaViejoMin >= 6 ? `Sin datos recientes (hace ${etaViejoMin} min)` : "El vehículo no va hacia el destino ahora mismo"}
                            </p>
                          ) : etaHora ? (
                            <>
                              {destinoDisplay.hora_estimada && (
                                <p style={{ fontSize: 9, color: C.mute, margin: "3px 0 0" }}>plan {destinoDisplay.hora_estimada.slice(0, 5)}</p>
                              )}
                              <p style={{ fontSize: 8.5, color: C.mute, margin: "2px 0 0" }}>
                                {etaViejoMin >= 5 ? `calculado hace ${etaViejoMin} min` : "con tráfico real"}
                              </p>
                            </>
                          ) : null}
                        </div>
                      )}
                    </div>
                  </div>
                  {/* Timeline de paradas */}
                  {psDisplay.length > 0 && (
                    <div style={{ borderTop: `1px solid ${C.line}`, padding: "14px 20px", overflowX: "auto" }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 12 }}>
                        <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "1px", margin: 0 }}>
                          Progreso del recorrido · {psDisplay.length} paradas
                        </p>
                        {etaHora && !etaAlejando && etaViejoMin < 5 && <span style={{ fontSize: 9, background: "rgba(21,128,61,0.1)", color: C.success, fontWeight: 700, padding: "1px 7px", borderRadius: 4 }}>ETA con tráfico real</span>}
                      </div>
                      <div style={{ display: "flex", alignItems: "flex-start", minWidth: "max-content" }}>
                        {psDisplay.map((p, i, arr) => {
                          const isCompleted = p.estado === "completada";
                          const isCurrent   = !isCompleted && i === currentStopIdx && (hayCompletadas || i === 0);
                          const isDestino   = i === arr.length - 1;
                          const dotBg      = isCompleted ? C.success : isCurrent ? C.navy : C.navyTint;
                          const dotBorder  = isCompleted ? C.success : isCurrent ? C.navy : C.line2;
                          const lineColor  = isCompleted ? C.success : C.line2;
                          return (
                            <div key={p.id} style={{ display: "flex", alignItems: "flex-start" }}>
                              <div style={{ display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 3 }}>
                                {/* Círculo de estado */}
                                <div style={{ position: "relative" as const, width: 22, height: 22, flexShrink: 0 }}>
                                  <div style={{ width: 22, height: 22, borderRadius: "50%", background: dotBg, border: `2px solid ${dotBorder}`, display: "flex", alignItems: "center", justifyContent: "center" }}>
                                    {isCompleted
                                      ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                                      : isCurrent
                                        ? <div style={{ width: 7, height: 7, borderRadius: "50%", background: "white" }} />
                                        : <span style={{ fontSize: 7.5, color: isDestino ? C.navy : C.mute, fontWeight: 700 }}>{i + 1}</span>
                                    }
                                  </div>
                                  {isCurrent && <span style={{ position: "absolute" as const, inset: -4, borderRadius: "50%", border: `2px solid ${C.navy}`, opacity: 0.25, animation: "pcPulse 1.6s ease-out infinite", pointerEvents: "none" as const }} />}
                                </div>
                                {/* Nombre parada */}
                                <p style={{ fontSize: 8.5, color: isCompleted ? C.success : isCurrent ? C.navy : C.mute, maxWidth: 70, textAlign: "center" as const, margin: 0, lineHeight: 1.3, fontWeight: isCurrent ? 700 : 400 }}>
                                  {p.nombre}
                                </p>
                                {/* Hora planificada */}
                                {p.hora_estimada && (
                                  <p style={{ fontFamily: C.fontMono, fontSize: 8, color: isCompleted ? C.success : C.mute, margin: 0, fontWeight: isCompleted ? 700 : 400 }}>
                                    {isCompleted && "✓ "}{p.hora_estimada.slice(0, 5)}
                                  </p>
                                )}
                                {/* ETA con tráfico — solo en destino */}
                                {isDestino && etaHora && !etaAlejando && (
                                  <p style={{ fontFamily: C.fontMono, fontSize: 9, color: C.success, margin: "1px 0 0", fontWeight: 800 }}>
                                    ~{etaHora}
                                  </p>
                                )}
                              </div>
                              {i < arr.length - 1 && (
                                <div style={{ height: 2, background: lineColor, width: 38, marginTop: 10, flexShrink: 0 }} />
                              )}
                            </div>
                          );
                        })}
                      </div>
                    </div>
                  )}
                </div>
              );
            })}

            {/* Otros turnos de hoy — los que no están en la sección EN RUTA */}
            {serviciosHoy.filter(r => !serviciosDestacados.some(s => s.id === r.id)).length > 0 && (
              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "10px 18px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 8 }}>
                  <span style={{ width: 6, height: 6, borderRadius: "50%", background: C.navy, flexShrink: 0 }} />
                  <p style={{ fontWeight: 800, color: C.ink, margin: 0, fontSize: 12 }}>Otros turnos de hoy</p>
                  <span style={{ fontSize: 10, fontWeight: 700, background: C.navyTint, color: C.navy, padding: "1px 7px", borderRadius: 4, marginLeft: "auto" }}>{serviciosHoy.filter(r => !serviciosDestacados.some(s => s.id === r.id)).length}</span>
                </div>
                {serviciosHoy.filter(r => !serviciosDestacados.some(s => s.id === r.id)).map(r => (
                  <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", borderBottom: `1px solid ${C.line}` }}>
                    <div style={{ fontFamily: C.fontMono, fontWeight: 700, fontSize: 13.5, color: C.navy, minWidth: 40, flexShrink: 0 }}>
                      {r.hora_servicio?.slice(0,5) || "–"}
                    </div>
                    <div style={{ flex: 1, minWidth: 0 }}>
                      <p style={{ fontWeight: 700, color: C.ink, fontSize: 12.5, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen} → {r.destino}</p>
                    </div>
                    <Badge estado={efectivoEstado(r)} />
                    <button onClick={() => cargarDetalle(r)} style={{ padding: "4px 11px", borderRadius: 6, border: `1px solid ${C.line2}`, color: C.navy, fontSize: 11.5, fontWeight: 700, background: C.navyTint, cursor: "pointer", flexShrink: 0, fontFamily: "inherit" }}>Ver</button>
                  </div>
                ))}
              </div>
            )}

            {/* Próximos + Últimos servicios */}
            <div style={{ display: "grid", gridTemplateColumns: proximosSvcs.length > 0 ? "1fr 1fr" : "1fr", gap: 12 }}>
              {proximosSvcs.length > 0 && (
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <p style={{ fontWeight: 800, color: C.ink, margin: 0, fontSize: 13 }}>Próximos servicios</p>
                    <span style={{ fontSize: 10, fontWeight: 700, background: C.navyTint, color: C.navy, padding: "2px 8px", borderRadius: 4 }}>{proximosSvcs.length}</span>
                  </div>
                  {proximosSvcs.map(r => (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 18px", borderBottom: `1px solid ${C.line}` }}>
                      <div style={{ background: C.navyTint, borderRadius: 8, padding: "6px 9px", textAlign: "center" as const, flexShrink: 0, minWidth: 46 }}>
                        <p style={{ color: C.navy, fontWeight: 800, fontSize: 15, margin: 0, fontFamily: C.fontMono }}>{new Date(r.fecha_servicio! + "T00:00:00").getDate()}</p>
                        <p style={{ color: C.mute, fontSize: 9, fontWeight: 700, margin: 0, textTransform: "uppercase" as const }}>{new Date(r.fecha_servicio! + "T00:00:00").toLocaleDateString("es-PE", { month: "short" })}</p>
                      </div>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, color: C.ink, fontSize: 12.5, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen} → {r.destino}</p>
                        <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0", fontFamily: C.fontMono }}>{r.hora_servicio?.slice(0,5) || "–"}</p>
                      </div>
                      <Badge estado={r.estado} />
                    </div>
                  ))}
                </div>
              )}

              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                  <p style={{ fontWeight: 800, color: C.ink, margin: 0, fontSize: 13 }}>Últimos servicios</p>
                  <button onClick={() => setTab("historial")} style={{ color: C.navy, fontSize: 12, fontWeight: 700, background: "none", border: "none", cursor: "pointer", fontFamily: "inherit" }}>Ver todos →</button>
                </div>
                {loading
                  ? [1,2,3].map(i => (
                    <div key={i} style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}` }}>
                      <div style={{ height: 11, background: C.surfaceAlt, borderRadius: 4, marginBottom: 6, width: "68%" }} />
                      <div style={{ height: 9, background: C.surfaceAlt, borderRadius: 4, width: "42%" }} />
                    </div>
                  ))
                  : ultimosSvcs.map(r => (
                    <div key={r.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "10px 18px", borderBottom: `1px solid ${C.line}`, gap: 10 }}>
                      <div style={{ flex: 1, minWidth: 0 }}>
                        <p style={{ fontWeight: 700, color: C.ink, fontSize: 12.5, margin: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{r.origen} → {r.destino}</p>
                        <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0", fontFamily: C.fontMono }}>{fmtFechaLrg(r.fecha_servicio)} · {r.hora_servicio?.slice(0,5) || "–"}</p>
                      </div>
                      <Badge estado={efectivoEstado(r)} />
                      {puedeVerMontos && <span style={{ color: C.navy, fontWeight: 700, fontSize: 12.5, flexShrink: 0, fontFamily: C.fontMono }}>{fmtSoles(Number(r.precio_cliente))}</span>}
                      <button onClick={() => cargarDetalle(r)} style={{ padding: "4px 11px", borderRadius: 6, border: `1px solid ${C.line2}`, color: C.navy, fontSize: 11.5, fontWeight: 700, background: C.navyTint, cursor: "pointer", flexShrink: 0, fontFamily: "inherit" }}>Ver</button>
                    </div>
                  ))
                }
                {!loading && ultimosSvcs.length === 0 && (
                  <div style={{ padding: 36, textAlign: "center" as const }}>
                    <p style={{ color: C.mute, fontWeight: 600, fontSize: 13 }}>Sin servicios ejecutados aún</p>
                  </div>
                )}
              </div>
            </div>

            {/* SLA por ruta + Acciones rápidas + Alertas */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>

              {/* SLA por ruta */}
              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "baseline", justifyContent: "space-between" }}>
                  <p style={{ fontWeight: 800, color: C.ink, margin: 0, fontSize: 13 }}>SLA por ruta</p>
                  <p style={{ color: C.mute, fontSize: 10.5, margin: 0 }}>Histórico de cumplimiento</p>
                </div>
                {topRutas.length === 0 ? (
                  <div style={{ padding: 28, textAlign: "center" as const, color: C.mute, fontSize: 13 }}>Sin datos suficientes</div>
                ) : topRutas.map((rt, i) => (
                  <div key={i} style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                      <p style={{ fontWeight: 700, color: C.ink2, fontSize: 12, margin: 0, flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{rt.ruta}</p>
                      <span style={{ fontFamily: C.fontMono, fontWeight: 800, fontSize: 13, color: rt.sla >= 90 ? C.navy : rt.sla >= 70 ? C.warn : C.danger, marginLeft: 10, flexShrink: 0 }}>{rt.sla}%</span>
                    </div>
                    <p style={{ color: C.mute, fontSize: 10.5, margin: "0 0 7px", fontFamily: C.fontMono }}>{rt.servicios} servicio{rt.servicios !== 1 ? "s" : ""}</p>
                    <div style={{ height: 5, background: C.surfaceAlt, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${rt.sla}%`, background: rt.sla >= 90 ? C.navy : rt.sla >= 70 ? C.warn : C.danger, borderRadius: 3 }} />
                    </div>
                  </div>
                ))}
              </div>

              {/* Acciones rápidas + Alertas */}
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>

                {/* Acciones rápidas */}
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}` }}>
                    <p style={{ fontWeight: 800, color: C.ink, margin: 0, fontSize: 13 }}>Acciones rápidas</p>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 1, background: C.line }}>
                    {([
                      { label: "Programar", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>, action: () => window.open("https://wa.me/51966707225?text=Hola%2C%20necesito%20programar%20un%20servicio","_blank") },
                      { label: "Exportar", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>, action: () => {} },
                      { label: "Coordinador", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>, action: () => window.open("https://wa.me/51966707225","_blank") },
                      { label: "Manifiesto", icon: <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>, action: () => setTab("historial") },
                    ] as { label: string; icon: React.ReactNode; action: () => void }[]).map(a => (
                      <button key={a.label} onClick={a.action}
                        style={{ background: C.surface, border: "none", padding: "18px 16px", cursor: "pointer", display: "flex", flexDirection: "column" as const, alignItems: "center", gap: 7, fontFamily: "inherit", color: C.navy }}
                        onMouseEnter={e => (e.currentTarget.style.background = C.navyTint)}
                        onMouseLeave={e => (e.currentTarget.style.background = C.surface)}>
                        {a.icon}
                        <span style={{ fontSize: 11.5, fontWeight: 700, color: C.ink2 }}>{a.label}</span>
                      </button>
                    ))}
                  </div>
                </div>

                {/* Alertas activas */}
                {notifs.filter(n => n.tipo === "warning").length > 0 && (
                  <div style={{ background: C.warnTint, border: `1px solid rgba(166,91,10,0.25)`, borderRadius: 10, overflow: "hidden" }}>
                    <div style={{ padding: "10px 16px", borderBottom: "1px solid rgba(166,91,10,0.2)", display: "flex", alignItems: "center", gap: 6 }}>
                      <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke={C.warn} strokeWidth="2.5"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>
                      <p style={{ fontWeight: 800, color: C.warn, margin: 0, fontSize: 12 }}>{notifs.filter(n => n.tipo === "warning").length} Alerta{notifs.filter(n => n.tipo === "warning").length !== 1 ? "s" : ""} activa{notifs.filter(n => n.tipo === "warning").length !== 1 ? "s" : ""}</p>
                    </div>
                    {notifs.filter(n => n.tipo === "warning").slice(0, 2).map(n => (
                      <div key={n.id} style={{ padding: "10px 16px", borderBottom: "1px solid rgba(166,91,10,0.15)" }}>
                        <p style={{ fontWeight: 700, color: C.ink2, fontSize: 12, margin: 0 }}>{n.titulo}</p>
                        <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0" }}>{n.desc}</p>
                      </div>
                    ))}
                  </div>
                )}

                {/* Notificaciones info/success */}
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                  <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 8 }}>
                    <p style={{ fontWeight: 800, color: C.ink, margin: 0, fontSize: 12 }}>Notificaciones</p>
                    {notifs.length > 0 && <span style={{ marginLeft: "auto", fontSize: 10, fontWeight: 700, background: C.navyTint, color: C.navy, padding: "2px 7px", borderRadius: 4 }}>{notifs.length}</span>}
                  </div>
                  {notifs.length === 0
                    ? <div style={{ padding: 20, textAlign: "center" as const, color: C.mute, fontSize: 12 }}>Sin notificaciones</div>
                    : notifs.filter(n => n.tipo !== "warning").slice(0, 3).map(n => (
                      <div key={n.id} style={{ display: "flex", gap: 10, padding: "10px 16px", borderBottom: `1px solid ${C.line}`, alignItems: "flex-start" }}>
                        <div style={{ width: 7, height: 7, borderRadius: "50%", background: n.tipo === "success" ? C.success : C.info, flexShrink: 0, marginTop: 3 }} />
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <p style={{ fontWeight: 700, color: C.ink2, fontSize: 12, margin: 0 }}>{n.titulo}</p>
                          <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>{n.desc}</p>
                        </div>
                      </div>
                    ))
                  }
                </div>
              </div>
            </div>
          </div>
        )}


        {/* EN TIEMPO REAL */}
        {tab === "activos" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 12, animation: "fadeIn 0.3s ease" }}>

            {/* Selector de servicios — toca uno para ver su ruta en el mapa */}
            {serviciosHoy.length >= 1 && (
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" as const }}>
                  <p style={{ fontSize: 11, fontWeight: 700, color: C.mute, margin: 0 }}>
                    {rutaSelId == null
                      ? <>Mostrando <b style={{ color: C.navy }}>{busesEnVivo} bus{busesEnVivo !== 1 ? "es" : ""}</b> en vivo · toca un servicio para ver su ruta</>
                      : <>Viendo ruta de <b style={{ color: C.navy }}>{servicioSel ? idAfa(servicioSel) : ""}</b></>}
                  </p>
                  {rutaSelId != null && (
                    <button onClick={() => setRutaSelId(null)}
                      style={{ marginLeft: "auto", display: "flex", alignItems: "center", gap: 4, padding: "3px 10px", borderRadius: 7, border: `1px solid ${C.line2}`, background: C.surface, color: C.ink2, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                      <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      Ver buses en vivo
                    </button>
                  )}
                </div>
                <div style={{ display: "flex", gap: 6, overflowX: "auto" as const, paddingBottom: 2 }}>
                  {serviciosHoy.map((r, i) => {
                    const est = efectivoEstado(r);
                    const color = COLORES_RUTA[i % COLORES_RUTA.length];
                    const activo = r.id === rutaSelId;
                    return (
                      <button key={r.id} onClick={() => setRutaSelId(prev => prev === r.id ? null : r.id)}
                        style={{ flexShrink: 0, padding: "8px 14px", borderRadius: 9, border: `2px solid ${activo ? color : C.line}`, background: activo ? color + "14" : C.surface, cursor: "pointer", fontFamily: "inherit", display: "flex", alignItems: "center", gap: 7, transition: "all 0.15s" }}>
                        <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, flexShrink: 0, ...(est === "en_curso" ? { animation: "pcPulse 1.6s ease-out infinite" } : {}) }} />
                        <span style={{ fontWeight: 800, fontSize: 12, color: activo ? color : C.ink }}>
                          {r.hora_servicio?.slice(0, 5) || "–"} &nbsp;·&nbsp; {idAfa(r)}
                        </span>
                        <span style={{ fontSize: 10.5, color: C.mute, fontWeight: 600, maxWidth: 130, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" as const }}>
                          {r.origen?.split(",")[0]}
                        </span>
                        <span style={{ fontSize: 10, fontWeight: 700, background: est === "en_curso" ? "#dcfce7" : C.navyTint, color: est === "en_curso" ? "#15803d" : C.navy, padding: "2px 7px", borderRadius: 4, flexShrink: 0 }}>
                          {estadoCliente(est).label}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Vehículos del día: TODOS los asignados. En vivo (transmitiendo) o esperando señal. */}
            {vehiculosHoyEstado.length > 0 && (
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center" }}>
                <span style={{ fontSize: 11, fontWeight: 700, color: C.mute }}>
                  Vehículos de hoy ({vehiculosHoyLive}/{vehiculosHoyEstado.length} en vivo):
                </span>
                {vehiculosHoyEstado.map(v => (
                  <div key={v.key} title={v.live ? "Enviando ubicación" : "Aún no envía ubicación GPS"}
                    style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 11px", borderRadius: 8, border: `1px solid ${v.live ? "#bbf7d0" : C.line}`, background: v.live ? "#f0fdf4" : C.surfaceAlt }}>
                    <span style={{ width: 8, height: 8, borderRadius: "50%", background: v.live ? C.success : C.mute, flexShrink: 0, ...(v.live ? { animation: "pcPulse 1.6s ease-out infinite" } : {}) }} />
                    <span style={{ fontFamily: C.fontMono, fontWeight: 800, fontSize: 12, color: C.ink }}>{v.placa}</span>
                    <span style={{ fontSize: 10, fontWeight: 700, color: v.live ? "#15803d" : C.mute }}>
                      {v.live ? "En vivo" : "Esperando señal"}
                    </span>
                  </div>
                ))}
              </div>
            )}

            {/* Encabezado de servicio activo (En Vivo) */}
            {servicioEnVivoActivo && (
              <div style={{ background: C.surface, border: `1px solid ${servicioSel && selIdx >= 0 ? COLORES_RUTA[selIdx % COLORES_RUTA.length] + "55" : C.line}`, borderRadius: 10, padding: "16px 20px", display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap" as const, gap: 12 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: efectivoEstado(servicioEnVivoActivo) === "en_curso" ? C.success : C.info, display: "inline-block", animation: "pcPulse 1.6s ease-out infinite" }} />
                    <p style={{ color: efectivoEstado(servicioEnVivoActivo) === "en_curso" ? C.success : C.info, fontWeight: 800, margin: 0, fontSize: 11, textTransform: "uppercase" as const, letterSpacing: "1.2px" }}>
                      {efectivoEstado(servicioEnVivoActivo) === "en_curso" ? "En curso" : esFinalizado(servicioEnVivoActivo.estado) ? "Finalizada hoy" : "Confirmada · Hoy"}
                    </p>
                    <span style={{ fontFamily: C.fontMono, fontSize: 10.5, color: C.mute, marginLeft: 4 }}>{idAfa(servicioEnVivoActivo)}</span>
                  </div>
                  <p style={{ fontFamily: C.fontSans, fontWeight: 800, fontSize: 18, letterSpacing: -0.4, margin: "0 0 3px", color: C.ink }}>
                    {servicioEnVivoActivo.origen} → {servicioEnVivoActivo.destino}
                  </p>
                  <p style={{ color: C.mute, fontSize: 12.5, margin: 0, fontFamily: C.fontMono }}>
                    {servicioEnVivoActivo.hora_servicio?.slice(0,5) || "–"} &nbsp;·&nbsp; {fmtFecha(servicioEnVivoActivo.fecha_servicio)}
                    {gpsActual && <span> &nbsp;·&nbsp; {gpsActual.velocidad} km/h &nbsp;·&nbsp; señal {fmtTs(gpsActual.timestamp)}</span>}
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                  {gpsActual && (
                    <div style={{ display: "flex", gap: 8 }}>
                      <div style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 14px", textAlign: "center" as const }}>
                        <p style={{ fontFamily: C.fontMono, color: C.navy, fontWeight: 700, fontSize: 15, margin: 0 }}>{gpsActual.velocidad}</p>
                        <p style={{ color: C.mute, fontSize: 9, fontWeight: 700, margin: "2px 0 0", textTransform: "uppercase" as const, letterSpacing: "0.8px" }}>km/h</p>
                      </div>
                      <div style={{ background: C.surfaceAlt, border: `1px solid ${C.line}`, borderRadius: 8, padding: "8px 14px", textAlign: "center" as const }}>
                        <p style={{ fontFamily: C.fontMono, color: C.success, fontWeight: 700, fontSize: 13, margin: 0 }}>{fmtTs(gpsActual.timestamp)}</p>
                        <p style={{ color: C.mute, fontSize: 9, fontWeight: 700, margin: "2px 0 0", textTransform: "uppercase" as const, letterSpacing: "0.8px" }}>Señal</p>
                      </div>
                    </div>
                  )}
                  <button onClick={() => cliente && cargarDatos(cliente.id)} style={{ padding: "9px 13px", borderRadius: 7, border: `1px solid ${C.line2}`, background: C.surface, color: C.ink2, fontWeight: 700, fontSize: 12.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    Actualizar
                  </button>
                  <button onClick={() => abrirGps(servicioEnVivoActivo)} style={{ padding: "9px 18px", borderRadius: 7, border: "none", background: C.navy, color: "white", fontWeight: 700, fontSize: 12.5, cursor: "pointer", display: "flex", alignItems: "center", gap: 6, fontFamily: "inherit" }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                    GPS EN VIVO
                  </button>
                </div>
              </div>
            )}

            {/* Aviso compacto cuando no hay servicio hoy */}
            {!servicioEnVivoActivo && (
              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: "14px 20px", display: "flex", alignItems: "center", justifyContent: "space-between", flexWrap: "wrap" as const, gap: 10 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                  <div style={{ width: 36, height: 36, borderRadius: 8, background: C.navyTint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                    <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke={C.navy} strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  </div>
                  <div>
                    <p style={{ fontWeight: 700, fontSize: 13.5, color: C.ink, margin: 0 }}>
                      {servicioHoy?.estado === "cancelado" ? "Servicio de hoy cancelado" : "Sin servicio programado hoy"}
                    </p>
                    <p style={{ fontSize: 12, color: C.mute, margin: "2px 0 0" }}>
                      {servicioHoy?.estado === "cancelado"
                        ? `${servicioHoy.origen} → ${servicioHoy.destino} · ${servicioHoy.hora_servicio?.slice(0,5) || "–"}`
                        : "Los vehículos asignados a tu empresa aparecen en el mapa."}
                    </p>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexShrink: 0 }}>
                  <button onClick={() => setTab("historial")} style={{ padding: "7px 14px", borderRadius: 7, border: `1px solid ${C.line2}`, background: C.surface, color: C.ink2, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: "inherit" }}>
                    Ver historial
                  </button>
                  <a href="https://wa.me/51966707225?text=Hola%2C%20necesito%20programar%20un%20nuevo%20servicio" target="_blank" rel="noopener noreferrer"
                    style={{ padding: "7px 14px", borderRadius: 7, border: "none", background: C.navy, color: "white", fontWeight: 700, fontSize: 12, textDecoration: "none", display: "inline-flex", alignItems: "center", gap: 5 }}>
                    Programar →
                  </a>
                </div>
              </div>
            )}

            {/* MAPA MAPBOX — siempre visible */}
            <div style={{ borderRadius: 10, overflow: "hidden", border: `1px solid ${C.line}`, position: "relative" as const, background: C.navyDeep }}>
              <div ref={mapContainerRef} style={{ width: "100%", height: 420 }} />
              {!mapListoEnVivo && (
                <div style={{ position: "absolute" as const, inset: 0, display: "flex", flexDirection: "column" as const, alignItems: "center", justifyContent: "center", gap: 10, background: C.navyDeep, pointerEvents: "none" }}>
                  <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="rgba(255,255,255,0.35)" strokeWidth="1.5"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                  <p style={{ color: "rgba(255,255,255,0.4)", fontSize: 13, margin: 0 }}>Cargando mapa…</p>
                </div>
              )}
              {servicioEnVivoActivo && gpsActual && (
                <div style={{ position: "absolute" as const, bottom: 14, left: 14 }}>
                  <button onClick={() => abrirGps(servicioEnVivoActivo)}
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 8, border: "none", background: C.navy, color: "white", fontWeight: 700, fontSize: 12.5, cursor: "pointer", boxShadow: "0 2px 12px rgba(0,0,0,0.35)", fontFamily: "inherit" }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: "#4ade80", animation: "pcPulse 1.6s ease-out infinite", display: "inline-block" }} />
                    Ver ruta GPS completa
                  </button>
                </div>
              )}
              {/* Leyenda de capas: ruta planificada vs huella GPS + escala de velocidad (solo con ruta seleccionada) */}
              {servicioSel && ((huellaGpsMap[servicioSel.id]?.length || 0) > 1 || (rutasEnVivoMap[servicioSel.id]?.length || 0) > 0) && (
                <div style={{ position: "absolute" as const, bottom: 14, right: 14, background: "rgba(255,255,255,0.94)", borderRadius: 9, padding: "9px 12px", backdropFilter: "blur(6px)", boxShadow: "0 2px 10px rgba(0,0,0,0.2)", maxWidth: 190 }}>
                  {(rutasEnVivoMap[servicioSel.id]?.length || 0) > 0 && (
                    <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                      <span style={{ width: 22, height: 0, borderTop: `3px dashed ${COLORES_RUTA[(selIdx >= 0 ? selIdx : 0) % COLORES_RUTA.length]}`, flexShrink: 0 }} />
                      <span style={{ fontSize: 10.5, fontWeight: 700, color: "#0a0e1a" }}>Ruta planificada</span>
                    </div>
                  )}
                  {(huellaGpsMap[servicioSel.id]?.length || 0) > 1 && (
                    <>
                      <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 6 }}>
                        <span style={{ width: 22, height: 4, borderRadius: 2, background: "linear-gradient(90deg,#dc2626,#eab308,#16a34a)", flexShrink: 0 }} />
                        <span style={{ fontSize: 10.5, fontWeight: 700, color: "#0a0e1a" }}>Recorrido real GPS</span>
                      </div>
                      <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 2 }}>
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#dc2626" }}>0</span>
                        <span style={{ flex: 1, height: 5, borderRadius: 3, background: "linear-gradient(90deg,#dc2626,#f59e0b,#eab308,#16a34a)" }} />
                        <span style={{ fontSize: 9, fontWeight: 700, color: "#16a34a" }}>55+</span>
                        <span style={{ fontSize: 8.5, color: "#6b6f7c", fontWeight: 600 }}>km/h</span>
                      </div>
                      {(telemetriaMap[servicioSel.id]?.length || 0) > 0 && (
                        <button onClick={() => setMostrarPuntosCli(v => !v)}
                          style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 8, background: "none", border: "none", padding: 0, cursor: "pointer", fontFamily: "inherit" }}>
                          <span style={{ width: 10, height: 10, borderRadius: "50%", border: "2px solid white", background: mostrarPuntosCli ? "#16a34a" : "#cbd5e1", boxShadow: "0 1px 3px rgba(0,0,0,0.25)", flexShrink: 0 }} />
                          <span style={{ fontSize: 10, fontWeight: 700, color: "#475569" }}>{mostrarPuntosCli ? "Ocultar" : "Ver"} datos por punto</span>
                        </button>
                      )}
                      {/* El cliente NO ve la leyenda "Tramo estimado" (decisión del usuario): la línea
                          azul continua se integra como la ruta; el tecnicismo queda solo en /seguimiento. */}
                    </>
                  )}
                </div>
              )}
            </div>

            {/* Resumen del viaje (datos reales) del servicio seleccionado */}
            {servicioSel && resumenMap[servicioSel.id] && resumenMap[servicioSel.id]!.kmRecorridos > 0 && (() => {
              const r = resumenMap[servicioSel.id]!;
              const badgeBg = r.medidoPct >= 90 ? "#dcfce7" : r.medidoPct >= 70 ? "#fef9c3" : "#fee2e2";
              const badgeFg = r.medidoPct >= 90 ? "#15803d" : r.medidoPct >= 70 ? "#a16207" : "#b91c1c";
              // Función (no componente): se invoca como Item({...}), sin crear un fiber nuevo por render.
              const Item = (l: string, v: string) => (
                <div key={l}><p style={{ fontSize: 9, color: C.mute, fontWeight: 700, textTransform: "uppercase" as const, margin: 0 }}>{l}</p><p style={{ fontSize: 14, color: C.ink, fontWeight: 800, margin: "1px 0 0" }}>{v}</p></div>
              );
              return (
                <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, padding: 14 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <p style={{ fontWeight: 700, fontSize: 12, color: C.ink, margin: 0 }}>Resumen del viaje</p>
                    <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 999, background: badgeBg, color: badgeFg }}>Rastreo {r.medidoPct}% medido</span>
                  </div>
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
                    {Item("Recorrido", `${r.kmRecorridos} km`)}
                    {Item("Duración", fmtDur(r.tiempoTotalMin))}
                    {Item("Detenciones", String(r.paradas))}
                    {Item("En marcha", fmtDur(r.tiempoMovimientoMin))}
                    {Item("Detenido", fmtDur(r.tiempoDetenidoMin))}
                    {Item("Vel. máx", `${r.velMaxKmh} km/h`)}
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10, paddingTop: 10, borderTop: `1px solid ${C.line}`, fontSize: 11, color: C.mute }}>
                    <span>Salida <b style={{ color: C.ink }}>{fmtHoraPe(r.horaSalida)}</b></span>
                    <span>Última señal <b style={{ color: C.ink }}>{fmtHoraPe(r.horaLlegada)}</b></span>
                  </div>
                  {r.medidoPct < 90 && (
                    <p style={{ fontSize: 10, color: C.mute, margin: "8px 0 0", lineHeight: 1.4 }}>
                      {100 - r.medidoPct}% del trayecto sin señal (huecos de GPS). Precisión mediana ±{r.precisionMedianaM} m.
                    </p>
                  )}
                </div>
              );
            })()}

            {/* Lista de vehículos del cliente */}
            {vehiculosCliente.length > 0 && (
              <div style={{ background: C.surface, border: `1px solid ${C.line}`, borderRadius: 10, overflow: "hidden" }}>
                <div style={{ padding: "12px 18px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <p style={{ fontWeight: 700, fontSize: 13, color: C.ink, margin: 0 }}>Flota asignada</p>
                  <button onClick={() => cliente && cargarVehiculosCliente(cliente.id)}
                    style={{ background: "none", border: "none", cursor: "pointer", color: C.mute, display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontFamily: "inherit", fontWeight: 600 }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                    Actualizar
                  </button>
                </div>
                <div style={{ display: "flex", overflowX: "auto" as const }}>
                  {vehiculosCliente.map((v, idx) => {
                    const gps = ubicacionesEnVivo.find(u => u.vehiculo_id === v.id);
                    const min = gps ? Math.floor((Date.now() - new Date(gps.timestamp).getTime()) / 60000) : null;
                    const color = min === null ? C.mute2 : min <= 2 ? "#16a34a" : min <= 10 ? "#d97706" : "#dc2626";
                    const label = min === null ? "Sin GPS" : min <= 2 ? "En línea" : min <= 10 ? `Hace ${min}m` : "Sin señal";
                    return (
                      <div key={v.id} style={{ flexShrink: 0, padding: "12px 18px", borderRight: idx < vehiculosCliente.length - 1 ? `1px solid ${C.line}` : "none", minWidth: 130 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 7, marginBottom: 5 }}>
                          <span style={{ width: 8, height: 8, borderRadius: "50%", background: color, display: "inline-block", flexShrink: 0 }} />
                          <span style={{ fontFamily: C.fontMono, fontWeight: 800, fontSize: 14, color: C.ink, letterSpacing: 0.5 }}>{v.placa}</span>
                        </div>
                        <p style={{ margin: 0, fontSize: 11.5, color, fontWeight: 600 }}>{label}</p>
                        {gps && <p style={{ margin: "2px 0 0", fontSize: 11, color: C.mute }}>{gps.velocidad} km/h</p>}
                        {!gps && <p style={{ margin: "2px 0 0", fontSize: 11, color: C.mute2 }}>Sin posición</p>}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* Contacto rápido sin servicio */}
            {!servicioActivo && (
              <div style={{ display: "flex", gap: 10, flexWrap: "wrap" as const }}>
                <a href="https://wa.me/51966707225" target="_blank" rel="noopener noreferrer"
                  style={{ flex: 1, minWidth: 180, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: C.successTint, border: `1px solid ${C.success}30`, borderRadius: 8, textDecoration: "none" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.success} strokeWidth="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>
                  <div>
                    <p style={{ color: C.success, fontWeight: 700, fontSize: 12, margin: 0 }}>WhatsApp</p>
                    <p style={{ color: C.success, fontWeight: 800, fontSize: 13.5, margin: "1px 0 0", fontFamily: C.fontMono }}>966 707 225</p>
                  </div>
                </a>
                <a href="tel:966707225" style={{ flex: 1, minWidth: 180, display: "flex", alignItems: "center", gap: 12, padding: "12px 16px", background: C.infoTint, border: `1px solid ${C.info}30`, borderRadius: 8, textDecoration: "none" }}>
                  <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke={C.info} strokeWidth="2"><path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07A19.5 19.5 0 0 1 4.69 13.6a19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 3.59 3h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L7.91 10.09a16 16 0 0 0 6 6l1.27-.97a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 17.19z"/></svg>
                  <div>
                    <p style={{ color: C.info, fontWeight: 700, fontSize: 12, margin: 0 }}>Teléfono</p>
                    <p style={{ color: C.info, fontWeight: 800, fontSize: 13.5, margin: "1px 0 0", fontFamily: C.fontMono }}>01-3453707</p>
                  </div>
                </a>
              </div>
            )}
          </div>
        )}


        {/* HISTORIAL */}
        {tab === "historial" && !reservaSel && (() => {
          // ── Las CINCO tarjetas miden el mismo periodo ──────────────────────
          // (antes: una el mes, otra "total histórico", otra todo — números que se leían
          // como comparables sin serlo).
          const statsPeriodo = reservasPeriodo.map(r => reservaStats[r.id]).filter(Boolean);
          const totalEmbarcados = statsPeriodo.reduce((s, x) => s + x.embarcados, 0);
          const reservasConStats = statsPeriodo.filter(x => x.esperados > 0);
          const slaPromedio = reservasConStats.length > 0
            ? Math.round(reservasConStats.reduce((s, x) => s + Math.min(100, (x.embarcados / x.esperados) * 100), 0) / reservasConStats.length)
            : null;
          const canceladosPeriodo = reservasPeriodo.filter(r => esCancelado(r.estado)).length;
          const tasaCancelacion = reservasPeriodo.length > 0
            ? Math.round((canceladosPeriodo / reservasPeriodo.length) * 100)
            : 0;
          // Gasto = lo que YA se prestó. Sumar servicios futuros mezclaría gasto real con
          // compromiso y el número dejaría de cuadrar con la contabilidad del cliente;
          // lo programado se informa aparte, en el subtexto.
          const gastoPeriodo = reservasPeriodo
            .filter(r => !esCancelado(r.estado) && !esFuturo(r.fecha_servicio))
            .reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
          const programadoPeriodo = reservasPeriodo
            .filter(r => !esCancelado(r.estado) && esFuturo(r.fecha_servicio))
            .reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
          // Comparación contra el periodo equivalente anterior (mes anterior, año anterior,
          // o el tramo de igual duración justo antes).
          const rangoPrev = rangoAnterior(periodo, hoy, rango);
          const conteoPrev = rangoPrev ? universoReservas.filter(r => enRango(r.fecha_servicio, rangoPrev)).length : null;
          const deltaPeriodo = conteoPrev === null ? null : reservasPeriodo.length - conteoPrev;
          const slaColor = (pct: number) => pct >= 95 ? C.success : pct >= 85 ? C.warn : C.danger;
          // Exporta el historial (respetando filtro/búsqueda activos) a un .xlsx REAL con
          // estilos: banners de marca, cabecera navy, filas cebra, estado coloreado según
          // el design system (estadoCliente), SLA/Total con formato numérico y colores,
          // anchos por contenido con Origen/Destino en columnas separadas (texto completo,
          // wrap) y fila TOTAL. xlsx-js-style se carga on-demand para no cargar el bundle.
          // (Un CSV no puede llevar colores/anchos y Excel además rompía los acentos UTF-8.)
          const exportarExcel = async () => {
            if (exportando) return;
            if (reservasFiltradas.length === 0) { alert("No hay servicios para exportar con los filtros actuales."); return; }
            setExportando(true);
            try {
              const mod: any = await import("xlsx-js-style");
              const XLSX = mod.default ?? mod;
              const A = (hex: string) => "FF" + hex.replace("#", "").toUpperCase();
              const Bd = { style: "thin", color: { rgb: A(C.line) } };
              const border = { top: Bd, bottom: Bd, left: Bd, right: Bd };

              const cols: { k: string; h: string; min: number; max: number; al: string; wrap?: boolean; nf?: string }[] = [
                { k: "id",      h: "ID AFA",     min: 15, max: 18, al: "left"   },
                { k: "orden",   h: "N°",         min: 6,  max: 9,  al: "center" },
                { k: "fecha",   h: "Fecha",      min: 11, max: 13, al: "center" },
                { k: "dia",     h: "Día",        min: 7,  max: 10, al: "center" },
                { k: "hora",    h: "Hora",       min: 7,  max: 9,  al: "center" },
                { k: "origen",  h: "Origen",     min: 22, max: 42, al: "left",  wrap: true },
                { k: "destino", h: "Destino",    min: 22, max: 42, al: "left",  wrap: true },
                { k: "estado",  h: "Estado",     min: 12, max: 14, al: "center" },
                { k: "emb",     h: "Emb.",       min: 6,  max: 9,  al: "center", nf: "0" },
                { k: "esp",     h: "Pax",        min: 6,  max: 9,  al: "center", nf: "0" },
                { k: "sla",     h: "SLA",        min: 7,  max: 9,  al: "center", nf: '0"%"' },
                ...(puedeVerMontos ? [{ k: "total", h: "Total (S/)", min: 13, max: 16, al: "right", nf: '"S/ "#,##0.00' }] : []),
              ];
              const nC = cols.length;
              const empresaNom = cliente?.empresa || cliente?.nombre || "AFA Transportes";
              const generado = fmtFecha(hoy);

              const aoa: any[][] = [];
              aoa.push(["AFA Transportes  ·  Historial de servicios", ...Array(nC - 1).fill("")]);
              aoa.push([`${empresaNom}     —     ${reservasFiltradas.length} servicio${reservasFiltradas.length !== 1 ? "s" : ""}     ·     Generado ${generado}`, ...Array(nC - 1).fill("")]);
              aoa.push(Array(nC).fill(""));
              aoa.push(cols.map(c => c.h));
              const dataStart = aoa.length;

              reservasFiltradas.forEach(r => {
                const st = reservaStats[r.id];
                const sla = st && st.esperados > 0 ? Math.round((st.embarcados / st.esperados) * 100) : "";
                aoa.push(cols.map(c => {
                  switch (c.k) {
                    case "id":      return idAfa(r);
                    case "orden":   return String(ordenCliente.get(r.id) ?? 0).padStart(3, "0");
                    case "fecha":   return fmtFecha(r.fecha_servicio);
                    case "dia":     return fmtFechaLrg(r.fecha_servicio).split(",")[0];
                    case "hora":    return r.hora_servicio?.slice(0, 5) || "";
                    case "origen":  return r.origen || "";
                    case "destino": return r.destino || "";
                    case "estado":  return estadoCliente(efectivoEstado(r)).label;
                    case "emb":     return st ? st.embarcados : "";
                    case "esp":     return st ? st.esperados : "";
                    case "sla":     return sla;
                    case "total":   return Number(r.precio_cliente || 0);
                    default:        return "";
                  }
                }));
              });
              const dataEnd = aoa.length - 1;

              aoa.push(cols.map((c, i) => {
                if (i === 0) return "TOTAL";
                if (c.k === "emb")   return reservasFiltradas.reduce((s, r) => s + (reservaStats[r.id]?.embarcados || 0), 0);
                if (c.k === "esp")   return reservasFiltradas.reduce((s, r) => s + (reservaStats[r.id]?.esperados || 0), 0);
                if (c.k === "total") return reservasFiltradas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0);
                return "";
              }));
              const totalRowIdx = aoa.length - 1;

              const ws = XLSX.utils.aoa_to_sheet(aoa);
              const enc = (r: number, c: number) => XLSX.utils.encode_cell({ r, c });
              ws["!merges"] = [
                { s: { r: 0, c: 0 }, e: { r: 0, c: nC - 1 } },
                { s: { r: 1, c: 0 }, e: { r: 1, c: nC - 1 } },
              ];

              const titleStyle = { font: { bold: true, sz: 15, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: A(C.navyDeep) } }, alignment: { horizontal: "left", vertical: "center", indent: 1 } };
              const subStyle   = { font: { sz: 10.5, color: { rgb: "FFD5DDEA" } }, fill: { fgColor: { rgb: A(C.navy) } }, alignment: { horizontal: "left", vertical: "center", indent: 1 } };
              const headStyle  = { font: { bold: true, sz: 10, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: A(C.navy) } }, alignment: { horizontal: "center", vertical: "center", wrapText: true }, border };
              for (let c = 0; c < nC; c++) {
                if (ws[enc(0, c)]) ws[enc(0, c)].s = titleStyle;
                if (ws[enc(1, c)]) ws[enc(1, c)].s = subStyle;
                if (ws[enc(3, c)]) ws[enc(3, c)].s = headStyle;
              }

              for (let ri = dataStart; ri <= dataEnd; ri++) {
                const r = reservasFiltradas[ri - dataStart];
                const st = reservaStats[r.id];
                const sla = st && st.esperados > 0 ? Math.round((st.embarcados / st.esperados) * 100) : null;
                const zebra = (ri - dataStart) % 2 === 0 ? "#FFFFFF" : C.paper;
                cols.forEach((c, ci) => {
                  const cell = ws[enc(ri, ci)]; if (!cell) return;
                  const s: any = { font: { sz: 10, color: { rgb: A(C.ink2) } }, fill: { fgColor: { rgb: A(zebra) } }, alignment: { horizontal: c.al, vertical: "center", wrapText: !!c.wrap }, border };
                  if (c.nf) s.numFmt = c.nf;
                  if (c.k === "id") s.font = { ...s.font, bold: true, color: { rgb: A(C.navy) } };
                  if (c.k === "estado") {
                    const ec = estadoCliente(efectivoEstado(r));
                    s.fill = { fgColor: { rgb: A(ec.bg) } };
                    s.font = { ...s.font, bold: true, color: { rgb: A(ec.c) } };
                  }
                  if (c.k === "sla" && sla !== null) s.font = { ...s.font, bold: true, color: { rgb: A(slaColor(sla)) } };
                  if (c.k === "total") s.font = { ...s.font, bold: true, color: { rgb: A(C.navy) } };
                  cell.s = s;
                });
              }

              for (let c = 0; c < nC; c++) {
                const cell = ws[enc(totalRowIdx, c)]; if (!cell) continue;
                const s: any = { font: { bold: true, sz: 10.5, color: { rgb: "FFFFFFFF" } }, fill: { fgColor: { rgb: A(C.navyDeep) } }, alignment: { horizontal: cols[c].al, vertical: "center" }, border };
                if (cols[c].nf) s.numFmt = cols[c].nf;
                cell.s = s;
              }

              ws["!cols"] = cols.map((c, ci) => {
                let mx = c.h.length;
                for (let ri = dataStart; ri <= dataEnd; ri++) {
                  const v = aoa[ri][ci];
                  const len = v == null ? 0 : String(v).length + (c.k === "total" ? 4 : c.k === "sla" ? 1 : 0);
                  if (len > mx) mx = len;
                }
                return { wch: Math.min(Math.max(mx + 2, c.min), c.max) };
              });
              ws["!rows"] = [];
              ws["!rows"][0] = { hpt: 26 };
              ws["!rows"][1] = { hpt: 18 };
              ws["!rows"][3] = { hpt: 20 };
              ws["!autofilter"] = { ref: XLSX.utils.encode_range({ s: { r: 3, c: 0 }, e: { r: dataEnd, c: nC - 1 } }) };

              const wb = XLSX.utils.book_new();
              XLSX.utils.book_append_sheet(wb, ws, "Historial");
              const buf = XLSX.write(wb, { bookType: "xlsx", type: "array" });
              const blob = new Blob([buf], { type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" });
              const url = URL.createObjectURL(blob);
              const a = document.createElement("a");
              a.href = url;
              a.download = `Historial_${empresaNom.replace(/[^\w]+/g, "_").replace(/^_+|_+$/g, "")}_${hoy}.xlsx`;
              a.click();
              setTimeout(() => URL.revokeObjectURL(url), 1500);
            } catch (e) {
              console.error("[exportarExcel]", e);
              alert("No se pudo generar el Excel. Intenta de nuevo.");
            } finally {
              setExportando(false);
            }
          };
          return (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>

            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 12 }}>
              <div>
                <p style={{ margin: 0, fontSize: 10, fontWeight: 800, color: C.mute, letterSpacing: "1.2px", textTransform: "uppercase" as const }}>HISTORIAL</p>{/* ya no es "completo": lo que se ve depende del periodo elegido */}
                <h2 style={{ margin: "4px 0 6px", fontSize: 22, fontWeight: 900, color: C.ink, letterSpacing: -0.5 }}>Servicios contratados</h2>
                <p style={{ margin: 0, fontSize: 13, color: C.mute }}>
                  <span style={{ fontFamily: C.fontMono, fontWeight: 700, color: C.navy }}>{reservasPeriodo.length}</span> servicios en {rango.etiqueta.toLowerCase()} · {cliente?.empresa || cliente?.nombre}
                  {cargandoRango && <span style={{ marginLeft: 8, color: C.mute2 }}>· cargando periodo…</span>}
                </p>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                {/* ── Selector de periodo: manda sobre tarjetas, chips, tabla, agenda y Excel ── */}
                <div style={{ position: "relative" as const }}>
                  <button onClick={() => setPeriodoAbierto(v => !v)}
                    title="Elegir el periodo que se muestra en toda la pestaña"
                    style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 14px", borderRadius: 10, border: `1.5px solid ${periodo === "todo" ? C.line2 : C.navy}`, background: periodo === "todo" ? C.surface : C.navyTint, color: periodo === "todo" ? C.ink2 : C.navy, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                    {rango.etiqueta}
                    <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ transform: periodoAbierto ? "rotate(180deg)" : "none", transition: "transform .15s" }}><polyline points="6 9 12 15 18 9"/></svg>
                  </button>
                  {periodoAbierto && (
                    <>
                      <div onClick={() => setPeriodoAbierto(false)} style={{ position: "fixed" as const, inset: 0, zIndex: 40 }} />
                      <div style={{ position: "absolute" as const, top: "calc(100% + 6px)", left: 0, zIndex: 41, background: C.surface, border: `1px solid ${C.line}`, borderRadius: 12, boxShadow: "0 12px 32px rgba(11,49,95,.16)", padding: 6, minWidth: 220 }}>
                        {PERIODOS.map(p => (
                          <button key={p.id}
                            onClick={() => { setPeriodo(p.id); if (p.id !== "custom") setPeriodoAbierto(false); }}
                            style={{ display: "block", width: "100%", textAlign: "left" as const, padding: "9px 12px", borderRadius: 8, border: "none", background: periodo === p.id ? C.navyTint : "transparent", color: periodo === p.id ? C.navy : C.ink2, fontSize: 12.5, fontWeight: periodo === p.id ? 800 : 600, cursor: "pointer", fontFamily: C.fontSans }}>
                            {p.label}
                          </button>
                        ))}
                        {periodo === "custom" && (
                          <div style={{ borderTop: `1px solid ${C.line}`, marginTop: 6, paddingTop: 10, padding: "10px 12px 6px", display: "flex", flexDirection: "column" as const, gap: 8 }}>
                            <label style={{ fontSize: 10.5, fontWeight: 800, color: C.mute, letterSpacing: ".06em", textTransform: "uppercase" as const }}>
                              Desde
                              <input type="date" value={periodoDesde} onChange={e => setPeriodoDesde(e.target.value)}
                                style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12.5, fontFamily: C.fontSans, background: C.bg, color: C.ink, boxSizing: "border-box" as const }} />
                            </label>
                            <label style={{ fontSize: 10.5, fontWeight: 800, color: C.mute, letterSpacing: ".06em", textTransform: "uppercase" as const }}>
                              Hasta
                              <input type="date" value={periodoHasta} onChange={e => setPeriodoHasta(e.target.value)}
                                style={{ display: "block", width: "100%", marginTop: 4, padding: "7px 9px", border: `1px solid ${C.line}`, borderRadius: 8, fontSize: 12.5, fontFamily: C.fontSans, background: C.bg, color: C.ink, boxSizing: "border-box" as const }} />
                            </label>
                            <button onClick={() => setPeriodoAbierto(false)}
                              style={{ padding: "8px 12px", borderRadius: 8, border: "none", background: C.navy, color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                              Aplicar
                            </button>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                </div>
                <button onClick={() => cliente && cargarDatos(cliente.id)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 14px", borderRadius: 10, border: `1.5px solid ${C.line2}`, background: C.surface, color: C.ink2, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>
                  Actualizar
                </button>
                <button onClick={exportarExcel} disabled={exportando} title="Descargar el historial filtrado en Excel (.xlsx) con formato" style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: `1.5px solid ${C.line2}`, background: C.surface, color: C.ink2, fontSize: 12, fontWeight: 700, cursor: exportando ? "default" : "pointer", opacity: exportando ? 0.6 : 1, fontFamily: C.fontSans }}>
                  {exportando
                    ? <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ animation: "spin 0.7s linear infinite" }}><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                    : <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>}
                  {exportando ? "Generando…" : "Exportar Excel"}
                </button>
                <button onClick={() => window.open("https://wa.me/51966707225?text=Hola%2C+quiero+solicitar+un+nuevo+servicio", "_blank")} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                  Solicitar servicio
                </button>
              </div>
            </div>

            {/* KPI strip */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(140px,1fr))", gap: 12 }}>
              {[
                {
                  label: `Servicios · ${rango.etiqueta}`, value: reservasPeriodo.length,
                  sub: deltaPeriodo === null ? "sin periodo con qué comparar"
                     : deltaPeriodo !== 0 ? `${deltaPeriodo > 0 ? "+" : ""}${deltaPeriodo} vs ${rangoPrev!.etiqueta.toLowerCase()}`
                     : `igual que ${rangoPrev!.etiqueta.toLowerCase()}`,
                  accent: C.navy, subColor: (deltaPeriodo ?? 0) > 0 ? C.success : (deltaPeriodo ?? 0) < 0 ? C.danger : C.mute,
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                },
                {
                  label: `Pasajeros · ${rango.etiqueta}`, value: loadingStats ? "..." : totalEmbarcados || "–",
                  sub: "embarcados en el periodo",
                  accent: C.info, subColor: C.mute,
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>
                },
                ...(puedeVerMontos ? [{
                  label: `Gasto · ${rango.etiqueta}`, value: fmtSoles(gastoPeriodo),
                  sub: programadoPeriodo > 0 ? `+ ${fmtSoles(programadoPeriodo)} programado` : "servicios realizados",
                  accent: C.navyDeep, subColor: C.mute,
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><line x1="12" y1="1" x2="12" y2="23"/><path d="M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6"/></svg>
                }] : []),
                {
                  label: `SLA · ${rango.etiqueta}`, value: loadingStats ? "..." : slaPromedio !== null ? `${slaPromedio}%` : "–",
                  sub: "tasa de embarque",
                  accent: slaPromedio !== null ? slaColor(slaPromedio) : C.mute, subColor: C.mute,
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>
                },
                {
                  label: `Cancelación · ${rango.etiqueta}`, value: `${tasaCancelacion}%`,
                  sub: `${canceladosPeriodo} cancelados`,
                  accent: tasaCancelacion > 10 ? C.danger : C.mute, subColor: C.mute,
                  icon: <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
                },
              ].map(k => (
                <div key={k.label} style={{ background: C.surface, borderRadius: 14, padding: "14px 16px", border: `1px solid ${C.line}`, borderTop: `3px solid ${k.accent}` }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 8 }}>
                    <p style={{ margin: 0, fontSize: 10, fontWeight: 800, color: C.mute, letterSpacing: "0.06em", textTransform: "uppercase" as const, lineHeight: 1.3 }}>{k.label}</p>
                    <span style={{ color: k.accent, opacity: 0.7 }}>{k.icon}</span>
                  </div>
                  <p style={{ fontFamily: C.fontMono, fontSize: 22, fontWeight: 900, color: k.accent, margin: "0 0 4px" }}>{k.value}</p>
                  <p style={{ fontSize: 10.5, color: k.subColor, margin: 0, fontWeight: 600 }}>{k.sub}</p>
                </div>
              ))}
            </div>

            {/* Filter bar */}
            <div style={{ background: C.surface, borderRadius: 14, padding: "12px 16px", border: `1px solid ${C.line}`, display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center" }}>
              <div style={{ position: "relative" as const, flex: 1, minWidth: 200 }}>
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke={C.mute} strokeWidth="2" style={{ position: "absolute" as const, left: 11, top: "50%", transform: "translateY(-50%)", pointerEvents: "none" as const }}><circle cx="11" cy="11" r="8"/><path d="m21 21-4.35-4.35"/></svg>
                <input value={filtroBusqueda} onChange={e => setFiltroBusqueda(e.target.value)}
                  placeholder="Buscar por ruta o fecha..."
                  style={{ width: "100%", paddingLeft: 34, paddingRight: 12, paddingTop: 8, paddingBottom: 8, border: `1px solid ${C.line}`, borderRadius: 9, fontSize: 13, outline: "none", fontFamily: C.fontSans, boxSizing: "border-box" as const, background: C.bg, color: C.ink }}
                />
              </div>
              <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                {(["todos","pendiente","programada","confirmada","en_curso","finalizada","cancelada"] as const).map(e => {
                  const cnt = e === "todos" ? reservasPeriodo.length : reservasPeriodo.filter(r => efectivoEstado(r) === e).length;
                  const active = filtroEstado === e;
                  return (
                    <button key={e} onClick={() => setFiltroEstado(e)}
                      style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 11px", borderRadius: 20, border: `1px solid ${active ? C.navy : C.line}`, background: active ? C.navy : C.surface, color: active ? "white" : C.mute, fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans, transition: "all .12s" }}>
                      {e === "todos" ? "Todos" : estadoCliente(e).label}
                      <span style={{ fontSize: 9.5, background: active ? "rgba(255,255,255,0.2)" : C.surfaceAlt, color: active ? "rgba(255,255,255,0.8)" : C.mute2, borderRadius: 10, padding: "0 5px", lineHeight: "17px", minWidth: 20, textAlign: "center" as const }}>{cnt}</span>
                    </button>
                  );
                })}
              </div>
              <span style={{ fontSize: 11, color: C.mute2, fontWeight: 600, whiteSpace: "nowrap" as const }}>
                {reservasFiltradas.length !== reservasPeriodo.length ? `${reservasFiltradas.length} de ${reservasPeriodo.length}` : `${reservasPeriodo.length} servicios`}
              </span>
              <button
                onClick={() => setVistaAgenda(v => !v)}
                title="Cambiar vista"
                style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 9, border: `1.5px solid ${vistaAgenda ? C.navy : C.line2}`, background: vistaAgenda ? C.navyTint : C.surface, color: vistaAgenda ? C.navy : C.mute, fontSize: 11.5, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans, transition: "all .12s", whiteSpace: "nowrap" as const }}
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                {vistaAgenda ? "Vista tabla" : "Vista agenda"}
              </button>
            </div>

            {/* VISTA AGENDA */}
            {vistaAgenda && (
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 12 }}>
                {agendaGrupos.length === 0 ? (
                  <div style={{ background: C.surface, borderRadius: 16, border: `1px solid ${C.line}`, padding: "56px 20px", textAlign: "center" as const }}>
                    <p style={{ fontSize: 32, margin: "0 0 10px" }}>📅</p>
                    <p style={{ color: C.mute, fontSize: 14, fontWeight: 600, margin: 0 }}>Sin resultados para los filtros seleccionados</p>
                  </div>
                ) : agendaGrupos.map(({ fecha, filas, label, esHoy: esHoyGrupo, esPasado }) => (
                  <div key={fecha} style={{ background: C.surface, borderRadius: 16, overflow: "hidden" as const, border: esHoyGrupo ? `2px solid ${C.info}` : `1px solid ${C.line}` }}>
                    {/* cabecera fecha */}
                    <div style={{ padding: "10px 18px", display: "flex", alignItems: "center", justifyContent: "space-between", background: esHoyGrupo ? C.infoTint : esPasado ? C.gray50 : C.navyTint }}>
                      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                        {esHoyGrupo && <span style={{ fontSize: 9.5, fontWeight: 900, letterSpacing: "1px", textTransform: "uppercase" as const, background: C.info, color: "white", padding: "2px 8px", borderRadius: 20 }}>HOY</span>}
                        {esPasado && <span style={{ fontSize: 9.5, fontWeight: 700, letterSpacing: "1px", textTransform: "uppercase" as const, color: C.mute2 }}>pasado</span>}
                        <span style={{ fontWeight: 700, textTransform: "capitalize" as const, color: esHoyGrupo ? C.info : esPasado ? C.mute : C.navy, fontSize: 13 }}>{label}</span>
                      </div>
                      <span style={{ fontSize: 10.5, fontWeight: 700, padding: "2px 10px", borderRadius: 20, background: esHoyGrupo ? "#bfdbfe" : C.surfaceAlt, color: esHoyGrupo ? C.info : C.mute }}>
                        {filas.length} servicio{filas.length !== 1 ? "s" : ""}
                      </span>
                    </div>
                    {/* filas */}
                    <div>
                      {filas.map((r, ri) => {
                        const st = reservaStats[r.id];
                        const sla = st && st.esperados > 0 ? Math.min(100, Math.round((st.embarcados / st.esperados) * 100)) : null;
                        const slaColor = (pct: number) => pct >= 95 ? C.success : pct >= 85 ? C.warn : C.danger;
                        const est = estadoCliente(efectivoEstado(r));
                        return (
                          <div key={r.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "11px 18px", borderTop: ri > 0 ? `1px solid ${C.line}` : undefined, background: efectivoEstado(r) === "en_curso" ? "#F0F7F3" : undefined }}>
                            {/* hora + id */}
                            <div style={{ minWidth: 48, textAlign: "right" as const, flexShrink: 0 }}>
                              <div style={{ fontFamily: C.fontMono, fontWeight: 700, fontSize: 13, color: C.ink2 }}>{r.hora_servicio?.slice(0,5) || "–:–"}</div>
                              <div style={{ fontFamily: C.fontMono, fontSize: 9.5, color: C.mute2 }}>{idAfa(r)}</div>
                            </div>
                            {/* dot */}
                            <div style={{ width: 3, height: 36, borderRadius: 2, background: est.dot, flexShrink: 0 }} />
                            {/* ruta + estado */}
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const }}>
                                <span style={{ fontWeight: 700, fontSize: 12.5, color: C.ink, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>{r.origen}</span>
                                <span style={{ color: C.mute2, fontSize: 11 }}>→</span>
                                <span style={{ fontSize: 12, color: C.mute, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>{r.destino}</span>
                                <span style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 20, background: est.bg, color: est.c, whiteSpace: "nowrap" as const }}>{est.label}</span>
                              </div>
                              {st && (
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 3 }}>
                                  <span style={{ fontSize: 10.5, color: C.mute }}>{st.embarcados}/{st.esperados} pax</span>
                                  {sla !== null && <span style={{ fontSize: 10, fontWeight: 700, color: slaColor(sla) }}>SLA {sla}%</span>}
                                </div>
                              )}
                            </div>
                            {/* monto */}
                            {puedeVerMontos && <div style={{ fontFamily: C.fontMono, fontWeight: 700, fontSize: 12.5, color: C.navy, flexShrink: 0, whiteSpace: "nowrap" as const }}>{fmtSoles(Number(r.precio_cliente))}</div>}
                            {/* acciones */}
                            <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                              {(r.vehiculo_id || (r as any).vehiculo_tercero_id || (r as any).empresa_tercerizada_id) && (
                                <button onClick={() => abrirGps(r)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: `1px solid ${C.navyTint2}`, background: C.navyTint, color: C.navy, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                  GPS
                                </button>
                              )}
                              <button onClick={() => cargarDetalle(r)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface, color: C.ink2, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                                Ver
                              </button>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                ))}
              </div>
            )}

            {/* Table */}
            {!vistaAgenda && <div style={{ background: C.surface, borderRadius: 16, overflow: "hidden" as const, border: `1px solid ${C.line}` }}>
              <div style={{ overflowX: "auto" as const }}>
                <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 13 }}>
                  <thead>
                    <tr style={{ background: C.surfaceAlt, borderBottom: `1.5px solid ${C.line2}` }}>
                      {[["ID","112px"],["Fecha","88px"],["Hora","56px"],["Ruta","auto"],["Estado","100px"],["Manifiesto","80px"],["Pasajeros","92px"],["SLA","92px"],...(puedeVerMontos ? [["Total","96px"]] : [])].map(([h,w]) => (
                        <th key={h} style={{ padding: "10px 12px", textAlign: "left" as const, fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.07em", whiteSpace: "nowrap" as const, width: w !== "auto" ? w : undefined }}>{h}</th>
                      ))}
                      <th style={{ padding: "10px 10px", textAlign: "left" as const, fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.07em", whiteSpace: "nowrap" as const, width: 80, position: "sticky" as const, right: 80, background: C.surfaceAlt, zIndex: 2, boxShadow: "-6px 0 8px -6px rgba(15,23,42,0.12)" }}>GPS</th>
                      <th style={{ padding: "10px 10px", textAlign: "left" as const, fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.07em", whiteSpace: "nowrap" as const, width: 80, position: "sticky" as const, right: 0, background: C.surfaceAlt, zIndex: 2 }}>Ver</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reservasFiltradas.length === 0 ? (
                      <tr><td colSpan={puedeVerMontos ? 11 : 10} style={{ padding: "56px 20px", textAlign: "center" as const }}>
                        <svg width="44" height="44" viewBox="0 0 24 24" fill="none" stroke={C.line2} strokeWidth="1.2" style={{ display: "block", margin: "0 auto 12px" }}><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
                        <p style={{ color: C.mute, fontSize: 14, fontWeight: 600, margin: 0 }}>Sin resultados para los filtros seleccionados</p>
                      </td></tr>
                    ) : reservasFiltradas.map((r, idx) => {
                      const st = reservaStats[r.id];
                      const sla = st && st.esperados > 0 ? Math.round((st.embarcados / st.esperados) * 100) : null;
                      const rowBg = efectivoEstado(r) === "en_curso" ? "#F0F7F3" : idx % 2 === 0 ? C.surface : C.paper;
                      return (
                        <tr key={r.id}
                          onMouseEnter={e => (e.currentTarget.style.background = C.navyTint)}
                          onMouseLeave={e => (e.currentTarget.style.background = rowBg)}
                          style={{ borderBottom: `1px solid ${C.line}`, background: rowBg, transition: "background 0.1s" }}>
                          <td style={{ padding: "10px 12px", whiteSpace: "nowrap" as const }} title="Código oficial AFA — úsalo para reportar este servicio">
                            <div style={{ fontFamily: C.fontMono, fontSize: 11.5, fontWeight: 800, color: C.navy }}>{idAfa(r)}</div>
                            <div style={{ fontFamily: C.fontMono, fontSize: 9.5, color: C.mute2, marginTop: 1 }}>N° {String(ordenCliente.get(r.id) ?? 0).padStart(3, "0")}</div>
                          </td>
                          <td style={{ padding: "10px 14px", whiteSpace: "nowrap" as const }}>
                            <p style={{ fontFamily: C.fontMono, fontSize: 11.5, fontWeight: 700, color: C.ink2, margin: 0 }}>{fmtFecha(r.fecha_servicio)}</p>
                            <p style={{ fontSize: 10, color: C.mute2, margin: "2px 0 0", textTransform: "capitalize" as const }}>{fmtFechaLrg(r.fecha_servicio).split(",")[0]}</p>
                          </td>
                          <td style={{ padding: "10px 14px", fontFamily: C.fontMono, fontSize: 11.5, color: C.mute, whiteSpace: "nowrap" as const }}>
                            {r.hora_servicio?.slice(0,5) || "–"}
                          </td>
                          <td style={{ padding: "10px 12px", maxWidth: 180 }}>
                            <p style={{ fontWeight: 700, color: C.ink, margin: 0, fontSize: 12.5, overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>{r.origen}</p>
                            <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0", overflow: "hidden" as const, textOverflow: "ellipsis" as const, whiteSpace: "nowrap" as const }}>→ {r.destino}</p>
                          </td>
                          <td style={{ padding: "10px 14px" }}><Badge estado={efectivoEstado(r)} /></td>
                          {/* ── Manifiesto ── */}
                          <td style={{ padding: "8px 14px" }}>
                            {(() => {
                              const esEditable = ["pendiente","programada","confirmada"].includes(normalizaEstado(r.estado));
                              const esCanc     = esCancelado(r.estado);
                              const paxCount   = st?.esperados ?? null;
                              return (
                                <button
                                  onClick={() => cliente && setModalManifiestoData({ reservaId: r.id, clienteId: cliente.id, readonly: !esEditable })}
                                  style={{ display: "flex", alignItems: "center", gap: 5, padding: "5px 10px", borderRadius: 7, border: `1px solid ${esEditable ? C.navyTint2 : C.line}`, background: esEditable ? C.navyTint : C.surfaceAlt, color: esEditable ? C.navy : C.mute, fontSize: 11, fontWeight: 700, cursor: esCanc ? "default" : "pointer", fontFamily: C.fontSans, whiteSpace: "nowrap" as const, opacity: esCanc ? 0.45 : 1 }}
                                  disabled={esCanc}
                                  title={esCanc ? "Servicio cancelado" : esEditable ? "Gestionar manifiesto" : "Ver manifiesto"}
                                >
                                  <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
                                  {paxCount !== null ? paxCount : "–"}
                                </button>
                              );
                            })()}
                          </td>
                          <td style={{ padding: "10px 14px", whiteSpace: "nowrap" as const }}>
                            {loadingStats ? (
                              <span style={{ color: C.mute2, fontSize: 11 }}>...</span>
                            ) : st ? (
                              <div>
                                <span style={{ fontFamily: C.fontMono, fontWeight: 700, fontSize: 13, color: C.ink2 }}>{st.embarcados}</span>
                                <span style={{ fontFamily: C.fontMono, fontSize: 11, color: C.mute }}> / {st.esperados}</span>
                                <p style={{ fontSize: 9.5, color: C.mute2, margin: "1px 0 0" }}>embarcados</p>
                              </div>
                            ) : (
                              <span style={{ color: C.mute2, fontSize: 11 }}>–</span>
                            )}
                          </td>
                          <td style={{ padding: "10px 12px", minWidth: 84 }}>
                            {loadingStats ? (
                              <span style={{ color: C.mute2, fontSize: 11 }}>...</span>
                            ) : sla !== null ? (
                              <div>
                                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                                  <span style={{ fontFamily: C.fontMono, fontWeight: 800, fontSize: 12, color: slaColor(sla) }}>{sla}%</span>
                                </div>
                                <div style={{ height: 5, background: C.surfaceAlt, borderRadius: 3, overflow: "hidden" as const }}>
                                  <div style={{ height: "100%", width: `${sla}%`, background: slaColor(sla), borderRadius: 3, transition: "width .4s ease" }} />
                                </div>
                              </div>
                            ) : (
                              <span style={{ color: C.mute2, fontSize: 11 }}>–</span>
                            )}
                          </td>
                          {puedeVerMontos && <td style={{ padding: "10px 14px", fontFamily: C.fontMono, fontWeight: 700, color: C.navy, fontSize: 12.5, whiteSpace: "nowrap" as const }}>{fmtSoles(Number(r.precio_cliente))}</td>}
                          <td style={{ padding: "8px 10px", position: "sticky" as const, right: 80, background: rowBg, zIndex: 1, boxShadow: "-6px 0 8px -6px rgba(15,23,42,0.12)" }}>
                            {(r.vehiculo_id || (r as any).vehiculo_tercero_id || (r as any).empresa_tercerizada_id) ? (
                              <button onClick={() => abrirGps(r)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: `1px solid ${C.navyTint2}`, background: C.navyTint, color: C.navy, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans, whiteSpace: "nowrap" as const }}>
                                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                                GPS
                              </button>
                            ) : <span style={{ color: C.mute2, fontSize: 11 }}>–</span>}
                          </td>
                          <td style={{ padding: "8px 10px", position: "sticky" as const, right: 0, background: rowBg, zIndex: 1 }}>
                            <button onClick={() => cargarDetalle(r)} style={{ display: "flex", alignItems: "center", gap: 4, padding: "5px 9px", borderRadius: 7, border: `1px solid ${C.line}`, background: C.surface, color: C.ink2, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans, whiteSpace: "nowrap" as const }}>
                              <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                              Ver
                            </button>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                  {reservasFiltradas.length > 0 && (
                    <tfoot>
                      <tr style={{ background: C.navyDeep, borderTop: `2px solid ${C.navy}` }}>
                        <td colSpan={4} style={{ padding: "11px 14px", fontWeight: 700, color: "rgba(255,255,255,0.5)", fontSize: 10, letterSpacing: "0.06em", textTransform: "uppercase" as const }}>
                          {reservasFiltradas.length} servicio{reservasFiltradas.length !== 1 ? "s" : ""} · {reservasFiltradas.filter(r => esFinalizado(r.estado)).length} finalizados
                        </td>
                        <td style={{ padding: "11px 14px" }}>
                          <span style={{ fontSize: 10, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: "rgba(255,255,255,0.08)", color: "rgba(255,255,255,0.55)" }}>
                            {reservasFiltradas.filter(r => esCancelado(r.estado)).length} cancelados
                          </span>
                        </td>
                        <td style={{ padding: "11px 14px" }} />
                        <td style={{ padding: "11px 14px", fontFamily: C.fontMono, fontSize: 11, color: "rgba(255,255,255,0.65)" }}>
                          {(() => { const total = Object.entries(reservaStats).filter(([id]) => reservasFiltradas.find(r => r.id === Number(id))).reduce((s, [,x]) => s + x.embarcados, 0); return total > 0 ? `${total} emb.` : "–"; })()}
                        </td>
                        <td style={{ padding: "11px 14px" }} />
                        {puedeVerMontos && (
                          <td style={{ padding: "11px 14px", fontFamily: C.fontMono, fontWeight: 900, color: "white", fontSize: 14 }}>
                            {fmtSoles(reservasFiltradas.reduce((s, r) => s + Number(r.precio_cliente || 0), 0))}
                          </td>
                        )}
                        <td style={{ padding: "11px 10px", position: "sticky" as const, right: 80, background: C.navyDeep, zIndex: 1, boxShadow: "-6px 0 8px -6px rgba(0,0,0,0.3)" }} />
                        <td style={{ padding: "11px 10px", position: "sticky" as const, right: 0, background: C.navyDeep, zIndex: 1 }} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
            </div>}
          </div>
          );
        })()}

        {/* DETALLE / EXPORTAR — se muestra dentro de Historial al hacer clic en "Ver" */}
        {tab === "historial" && reservaSel && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>
            {/* Header card */}
            <div style={{ background: C.surface, borderRadius: 16, padding: "20px 24px", border: `1px solid ${C.line}` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 14 }}>
                <div>
                  <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
                    <button onClick={() => { setReservaSel(null); setTab("historial"); }}
                      style={{ display: "flex", alignItems: "center", gap: 4, background: "none", border: "none", cursor: "pointer", color: C.mute, fontSize: 12, fontWeight: 600, padding: 0, fontFamily: C.fontSans }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><polyline points="15 18 9 12 15 6"/></svg>
                      Historial
                    </button>
                    <span style={{ color: C.mute2, fontSize: 11 }}>⬺</span>
                    <span style={{ fontSize: 12, fontWeight: 700, color: C.ink2 }}>Reporte</span>
                  </div>
                  <p style={{ color: C.navy, fontWeight: 900, fontSize: 20, margin: "0 0 8px" }}>{reservaSel.origen} → {reservaSel.destino}</p>
                  <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" as const }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.mute, fontSize: 12 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                      <span style={{ fontFamily: C.fontMono, fontSize: 12 }}>{fmtFecha(reservaSel.fecha_servicio)}</span>
                    </div>
                    <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.mute, fontSize: 12 }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                      <span style={{ fontFamily: C.fontMono, fontSize: 12 }}>{reservaSel.hora_servicio?.slice(0,5) || "–"}</span>
                    </div>
                    <Badge estado={reservaSel.estado} />
                    {conductorInfo && (
                      <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.mute, fontSize: 12 }}>
                        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        <span>{conductorInfo.nombre}</span>
                        {vehiculoInfo && <>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ marginLeft: 4 }}><rect x="1" y="3" width="15" height="13" rx="1"/><path d="M16 8h4l3 5v3h-7V8z"/><circle cx="5.5" cy="18.5" r="2.5"/><circle cx="18.5" cy="18.5" r="2.5"/></svg>
                          <span style={{ fontFamily: C.fontMono }}>{vehiculoInfo.placa}</span>
                        </>}
                      </div>
                    )}
                  </div>
                </div>
                {/* Botones de acción */}
                <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" as const }}>
                  {/* Botón manifiesto — abre el modal */}
                  {!esCancelado(reservaSel.estado) && (
                    <button
                      onClick={() => setModalManifiestoData({ reservaId: reservaSel.id, clienteId: cliente.id, readonly: esFinalizado(reservaSel.estado) })}
                      style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: `1.5px solid ${C.navyTint2}`, background: C.navyTint, color: C.navy, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: C.fontSans }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
                      {esFinalizado(reservaSel.estado) ? "Ver manifiesto" : "Editar manifiesto"}
                    </button>
                  )}
                  {reservaSel.vehiculo_id && (
                    <button onClick={() => abrirGps(reservaSel)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 16px", borderRadius: 10, border: `1px solid ${C.navyTint2}`, background: C.navyTint, color: C.navy, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                      <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                      GPS en vivo
                    </button>
                  )}
                  <button onClick={() => generarManifiesto(reservaSel)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 10, border: "none", background: C.success, color: "white", fontWeight: 800, fontSize: 12, cursor: "pointer", fontFamily: C.fontSans }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
                    Manifiesto MTC
                  </button>
                  <button onClick={() => generarReportePDF(reservaSel)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "9px 18px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontWeight: 800, fontSize: 12, cursor: "pointer", fontFamily: C.fontSans }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                    Reporte PDF
                  </button>
                </div>
              </div>
            </div>

            {(() => {
              const pp  = ppList[reservaSel.id] || [];
              // El abordaje se cuenta desde pasajeros_parada.estado_abordaje (boarding_log
              // está vacía). Clamp defensivo por si hubiera datos inconsistentes.
              const abordados = pp.filter(esAbordado).length;
              const pct = pp.length > 0 ? Math.min(100, Math.round((abordados / pp.length) * 100)) : 0;
              const noAsistieron = Math.max(0, pp.length - abordados);
              const ps  = paradas[reservaSel.id] || [];
              const pctColor = pct >= 80 ? C.success : pct >= 50 ? C.warn : C.danger;
              return (
                <>
                  {/* KPI Strip */}
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(120px,1fr))", gap: 10 }}>
                    {[
                      { l: "Esperados",     v: pp.length,             sub: "pasajeros",  accent: C.navy    },
                      { l: "Embarcaron",    v: abordados,             sub: "a bordo",    accent: C.success },
                      { l: "No asistieron", v: noAsistieron,           sub: "ausentes",   accent: C.danger  },
                      { l: "Cumplimiento",  v: `${pct}%`,             sub: "SLA",        accent: pctColor  },
                      { l: "Paradas",       v: ps.length,             sub: "paraderos",  accent: C.warn    },
                    ].map(k => (
                      <div key={k.l} style={{ background: C.surface, borderRadius: 14, padding: "14px 16px", border: `1px solid ${C.line}`, borderTop: `3px solid ${k.accent}` }}>
                        <p style={{ fontFamily: C.fontMono, fontSize: 26, fontWeight: 900, color: k.accent, margin: 0 }}>{k.v}</p>
                        <p style={{ fontSize: 11, fontWeight: 700, color: C.mute, margin: "5px 0 0", textTransform: "uppercase" as const, letterSpacing: "0.04em" }}>{k.l}</p>
                        <p style={{ fontSize: 10, color: C.mute2, margin: "2px 0 0" }}>{k.sub}</p>
                      </div>
                    ))}
                  </div>

                  {/* Progress bar */}
                  <div style={{ background: C.surface, borderRadius: 14, padding: "16px 20px", border: `1px solid ${C.line}` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 10 }}>
                      <div>
                        <p style={{ fontWeight: 700, color: C.ink2, fontSize: 13, margin: 0 }}>Tasa de embarque</p>
                        <p style={{ fontSize: 11, color: C.mute, margin: "2px 0 0" }}>{abordados} de {pp.length} pasajeros esperados embarcaron</p>
                      </div>
                      <span style={{ fontFamily: C.fontMono, fontWeight: 900, color: pctColor, fontSize: 20 }}>{pct}%</span>
                    </div>
                    <div style={{ height: 8, background: C.surfaceAlt, borderRadius: 4, overflow: "hidden" as const }}>
                      <div style={{ height: "100%", background: pctColor, width: `${pct}%`, borderRadius: 4, transition: "width 0.6s ease" }} />
                    </div>
                  </div>
                </>
              );
            })()}

            {(paradas[reservaSel.id] || []).length === 0 && (ppList[reservaSel.id] || []).filter(x => !x.parada_id).length === 0 ? (
              <div style={{ background: C.surface, borderRadius: 16, padding: 48, textAlign: "center" as const, border: `1px solid ${C.line}` }}>
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={C.line2} strokeWidth="1.2" style={{ display: "block", margin: "0 auto 14px" }}><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg>
                <p style={{ color: C.ink2, fontWeight: 700, margin: 0, fontSize: 14 }}>Sin paradas configuradas en este servicio</p>
                <p style={{ color: C.mute, fontSize: 13, margin: "6px 0 0" }}>Los datos de boarding aparecerán cuando se configuren los paraderos</p>
              </div>
            ) : (paradas[reservaSel.id] || []).map(p => {
              const ppParada    = (ppList[reservaSel.id] || []).filter(x => x.parada_id === p.id);
              const blParada    = (boarding[reservaSel.id] || []).filter(b => b.parada_id === p.id); // método/hora si existe
              const abordadosPar = ppParada.filter(esAbordado).length;
              const pct      = ppParada.length > 0 ? Math.min(100, Math.round((abordadosPar / ppParada.length) * 100)) : 0;
              const pctColor = pct >= 80 ? C.success : pct >= 50 ? C.warn : C.danger;
              return (
                <div key={p.id} style={{ background: C.surface, borderRadius: 16, overflow: "hidden" as const, border: `1px solid ${C.line}` }}>
                  {/* Cabecera parada */}
                  <div style={{ padding: "14px 20px", background: C.surfaceAlt, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 32, height: 32, borderRadius: "50%", background: p.estado === "completada" ? C.navy : C.mute2, display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 900, flexShrink: 0 }}>{p.orden}</div>
                      <div>
                        <p style={{ color: C.ink, fontWeight: 800, fontSize: 14, margin: 0 }}>{p.nombre}</p>
                        {p.direccion && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.mute, marginTop: 2 }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/></svg>
                            <span style={{ fontSize: 11 }}>{p.direccion}</span>
                          </div>
                        )}
                        {p.hora_estimada && (
                          <div style={{ display: "flex", alignItems: "center", gap: 4, color: C.mute, marginTop: 2 }}>
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                            <span style={{ fontFamily: C.fontMono, fontSize: 11 }}>{p.hora_estimada}</span>
                          </div>
                        )}
                      </div>
                    </div>
                    <div style={{ textAlign: "right" as const }}>
                      <p style={{ fontFamily: C.fontMono, fontWeight: 900, fontSize: 16, color: C.navy, margin: 0 }}>{abordadosPar}/{ppParada.length}</p>
                      <p style={{ color: pctColor, fontSize: 11, fontWeight: 700, margin: "2px 0 0" }}>{pct}% cumplimiento</p>
                    </div>
                  </div>

                  {/* Tabla de pasajeros */}
                  {ppParada.length > 0 ? (
                    <div style={{ overflowX: "auto" as const }}>
                      <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
                        <thead>
                          <tr style={{ background: C.paper, borderBottom: `1px solid ${C.line}` }}>
                            {["Pasajero","DNI","Estado","Hora embarque","Método"].map(h => (
                              <th key={h} style={{ padding: "8px 16px", textAlign: "left" as const, fontSize: 10, fontWeight: 800, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{h}</th>
                            ))}
                          </tr>
                        </thead>
                        <tbody>
                          {ppParada.map(x => {
                            const embarco = esAbordado(x);
                            const blRow   = blParada.find(b => b.pasajero_id === x.pasajero_id); // método/hora si existe
                            const hora    = x.hora_abordaje || blRow?.timestamp || null;
                            const esQR    = blRow?.metodo === "qr" || blRow?.metodo === "qr_conductor";
                            return (
                              <tr key={x.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                                <td style={{ padding: "10px 16px", fontWeight: 700, color: C.ink2 }}>{x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
                                <td style={{ padding: "10px 16px", fontFamily: C.fontMono, color: C.mute, fontSize: 11 }}>{x.pasajero?.dni || "–"}</td>
                                <td style={{ padding: "10px 16px" }}>
                                  <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: embarco ? C.successTint : C.dangerTint, color: embarco ? C.success : C.danger }}>
                                    {embarco
                                      ? <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                                      : <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>}
                                    {embarco ? "Embarcó" : "Pendiente"}
                                  </span>
                                </td>
                                <td style={{ padding: "10px 16px", fontFamily: C.fontMono, color: C.mute, fontSize: 11 }}>{hora ? fmtTs(hora) : "–"}</td>
                                <td style={{ padding: "10px 16px", color: C.mute2, fontSize: 11 }}>
                                  {!blRow?.metodo ? "–" : (
                                    esQR
                                      ? <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: C.navy, fontWeight: 600 }}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="7" height="7"/><rect x="14" y="3" width="7" height="7"/><rect x="3" y="14" width="7" height="7"/><rect x="14" y="14" width="7" height="7"/></svg>
                                          QR
                                        </span>
                                      : <span style={{ display: "inline-flex", alignItems: "center", gap: 4, color: C.mute }}>
                                          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M18 20V10"/><path d="M12 20V4"/><path d="M6 20v-6"/></svg>
                                          Manual
                                        </span>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                  ) : (
                    <div style={{ padding: "16px 20px", textAlign: "center" as const, color: C.mute, fontSize: 13 }}>
                      Sin pasajeros asignados a esta parada
                    </div>
                  )}
                </div>
              );
            })}

            {/* Pasajeros del manifiesto sin paradero asignado */}
            {(() => {
              const sinParada = (ppList[reservaSel.id] || []).filter(x => !x.parada_id);
              if (sinParada.length === 0) return null;
              return (
                <div style={{ background: C.surface, borderRadius: 16, overflow: "hidden" as const, border: `1px solid ${C.line}` }}>
                  <div style={{ padding: "14px 20px", background: C.warnTint, borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
                      <div style={{ width: 32, height: 32, borderRadius: "50%", background: C.warn, display: "flex", alignItems: "center", justifyContent: "center", color: "white", flexShrink: 0 }}>
                        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2"><path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><line x1="12" y1="7" x2="12" y2="11"/><line x1="12" y1="14" x2="12" y2="14"/></svg>
                      </div>
                      <div>
                        <p style={{ color: C.ink, fontWeight: 800, fontSize: 14, margin: 0 }}>Sin paradero asignado</p>
                        <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0" }}>Pasajeros del manifiesto aún sin paradero de abordaje</p>
                      </div>
                    </div>
                    <p style={{ fontFamily: C.fontMono, fontWeight: 900, fontSize: 16, color: C.warn, margin: 0 }}>{sinParada.length}</p>
                  </div>
                  <div style={{ overflowX: "auto" as const }}>
                    <table style={{ width: "100%", borderCollapse: "collapse" as const, fontSize: 12 }}>
                      <thead>
                        <tr style={{ background: C.paper, borderBottom: `1px solid ${C.line}` }}>
                          {["Pasajero","DNI","Estado"].map(h => (
                            <th key={h} style={{ padding: "8px 16px", textAlign: "left" as const, fontSize: 10, fontWeight: 800, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.05em" }}>{h}</th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sinParada.map(x => {
                          const embarco = esAbordado(x);
                          return (
                            <tr key={x.id} style={{ borderBottom: `1px solid ${C.line}` }}>
                              <td style={{ padding: "10px 16px", fontWeight: 700, color: C.ink2 }}>{x.pasajero?.nombre || `#${x.pasajero_id}`}</td>
                              <td style={{ padding: "10px 16px", fontFamily: C.fontMono, color: C.mute, fontSize: 11 }}>{x.pasajero?.dni || "–"}</td>
                              <td style={{ padding: "10px 16px" }}>
                                <span style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: embarco ? C.successTint : C.warnTint, color: embarco ? C.success : C.warn }}>
                                  {embarco ? "Embarcó" : "Sin paradero"}
                                </span>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  </div>
                </div>
              );
            })()}

            {/* Documentos vinculados */}
            <div style={{ background: C.surface, borderRadius: 14, padding: "16px 20px", border: `1px solid ${C.line}` }}>
              <p style={{ fontSize: 10, fontWeight: 800, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.07em", margin: "0 0 12px" }}>Documentos vinculados</p>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const }}>
                {([
                  { label: "Cotización PDF",  color: C.navy,    bg: C.navyTint,    act: () => {},
                    svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg> },
                  { label: "Factura",         color: C.warn,    bg: C.warnTint,    act: () => setTab("facturacion"),
                    svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="2" y="3" width="20" height="14" rx="2"/><line x1="8" y1="21" x2="16" y2="21"/><line x1="12" y1="17" x2="12" y2="21"/></svg> },
                  { label: "Manifiesto MTC",  color: C.success, bg: C.successTint, act: () => generarManifiesto(reservaSel!),
                    svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/><rect x="9" y="3" width="6" height="4" rx="1"/><path d="M9 12h6M9 16h4"/></svg> },
                  { label: "Reporte PDF",     color: C.info,    bg: C.infoTint,    act: () => generarReportePDF(reservaSel!),
                    svg: <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> },
                ] as { label: string; color: string; bg: string; act: () => void; svg: any }[]).map(a => (
                  <button key={a.label} onClick={a.act} style={{ display: "flex", alignItems: "center", gap: 7, padding: "9px 16px", borderRadius: 10, border: "none", background: a.bg, color: a.color, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                    {a.svg} {a.label}
                  </button>
                ))}
              </div>
            </div>
          </div>
        )}

        {/* FACTURACIÓN */}
        {tab === "facturacion" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16, animation: "fadeIn 0.3s ease" }}>
            {/* Liquidaciones del periodo — conformidad del servicio */}
            {liquidaciones.length > 0 && (
              <div style={{ background: C.surface, borderRadius: 14, border: `1px solid ${C.line}`, overflow: "hidden" }}>
                <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 10 }}>
                  <div>
                    <p style={{ margin: 0, fontSize: 13, fontWeight: 900, color: C.navy }}>Liquidaciones del servicio</p>
                    <p style={{ margin: "2px 0 0", fontSize: 11, color: C.mute }}>
                      Valorización del periodo para su revisión y conformidad, antes de la facturación.
                    </p>
                  </div>
                  {liquidaciones.some(l => l.conformidad_estado === "pendiente") && (
                    <span style={{ marginLeft: "auto", background: C.warnTint, color: C.warn, fontSize: 10, fontWeight: 900, padding: "4px 10px", borderRadius: 20 }}>
                      {liquidaciones.filter(l => l.conformidad_estado === "pendiente").length} POR APROBAR
                    </span>
                  )}
                </div>
                <div>
                  {liquidaciones.map((l, i) => {
                    const pend = l.conformidad_estado === "pendiente";
                    const obs  = l.conformidad_estado === "observada";
                    const color = pend ? C.warn : obs ? C.danger : C.success;
                    const fondo = pend ? C.warnTint : obs ? C.dangerTint : C.successTint;
                    return (
                      <div key={l.id} style={{ padding: "12px 20px", borderTop: i ? `1px solid ${C.line}` : "none", display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" as const }}>
                        <div style={{ flex: 1, minWidth: 180 }}>
                          <p style={{ margin: 0, fontSize: 12, fontWeight: 800, color: C.ink }}>
                            {l.codigo}
                            {l.cliente_sede_id && sedesLiq[l.cliente_sede_id] && (
                              <span style={{ color: C.mute, fontWeight: 600 }}> · {sedesLiq[l.cliente_sede_id]}</span>
                            )}
                          </p>
                          <p style={{ margin: "2px 0 0", fontSize: 11, color: C.mute }}>{l.periodo}</p>
                        </div>
                        <p style={{ margin: 0, fontFamily: C.fontMono, fontSize: 14, fontWeight: 900, color: C.ink }}>
                          {fmtSoles(Number(l.total ?? 0))}
                        </p>
                        <span style={{ background: fondo, color, fontSize: 10, fontWeight: 900, padding: "4px 10px", borderRadius: 20, textTransform: "uppercase" as const }}>
                          {pend ? "Por aprobar" : obs ? "Observada" : "Conforme"}
                        </span>
                        <a href={`/conformidad/${l.token}`} target="_blank" rel="noopener noreferrer"
                          style={{ background: pend ? C.navy : C.surfaceAlt, color: pend ? "#fff" : C.ink2, textDecoration: "none", fontSize: 11, fontWeight: 800, padding: "8px 14px", borderRadius: 8, border: `1px solid ${pend ? C.navy : C.line2}` }}>
                          {pend ? "Revisar y aprobar" : "Ver documento"}
                        </a>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(155px,1fr))", gap: 12 }}>
              {([
                { label: "Total pagado",   val: fmtSoles(totalPagado),  accent: C.success, bg: C.successTint,
                  svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="20 6 9 17 4 12"/></svg> },
                { label: "Por pagar",      val: fmtSoles(porPagar),     accent: C.warn,    bg: C.warnTint,
                  svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg> },
                { label: "Vencido",        val: fmtSoles(totalVencido), accent: C.danger,  bg: C.dangerTint,
                  svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg> },
                { label: "Total facturas", val: facturas.length,        accent: C.navy,    bg: C.navyTint,
                  svg: <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg> },
              ] as { label: string; val: any; accent: string; bg: string; svg: any }[]).map(k => (
                <div key={k.label} style={{ background: C.surface, borderRadius: 14, padding: "16px 20px", border: `1px solid ${C.line}`, borderTop: `3px solid ${k.accent}` }}>
                  <div style={{ color: k.accent, marginBottom: 8 }}>{k.svg}</div>
                  <p style={{ fontFamily: C.fontMono, fontSize: 20, fontWeight: 900, color: k.accent, margin: "0 0 4px" }}>{k.val}</p>
                  <p style={{ fontSize: 10, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.05em", margin: 0 }}>{k.label}</p>
                </div>
              ))}
            </div>
            {/* Filtros */}
            <div style={{ background: C.surface, borderRadius: 12, padding: "12px 18px", border: `1px solid ${C.line}`, display: "flex", gap: 10, flexWrap: "wrap" as const, alignItems: "center" }}>
              <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const }}>
                {([
                  { val: "todos",     label: "Todas"     },
                  { val: "pendiente", label: "Pendiente" },
                  { val: "pagada",    label: "Pagada"    },
                  { val: "vencida",   label: "Vencida"   },
                ] as { val: string; label: string }[]).map(e => (
                  <button key={e.val} onClick={() => setFiltroFactEstado(e.val)}
                    style={{ padding: "5px 12px", borderRadius: 20, border: `1px solid ${filtroFactEstado === e.val ? C.navy : C.line}`, background: filtroFactEstado === e.val ? C.navy : C.surface, color: filtroFactEstado === e.val ? "white" : C.mute, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                    {e.label}
                  </button>
                ))}
              </div>
              <input type="date" value={filtroFactDesde} onChange={e => setFiltroFactDesde(e.target.value)}
                style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "5px 10px", fontSize: 12, outline: "none", fontFamily: C.fontSans, color: C.ink2 }} />
              <input type="date" value={filtroFactHasta} onChange={e => setFiltroFactHasta(e.target.value)}
                style={{ border: `1px solid ${C.line}`, borderRadius: 8, padding: "5px 10px", fontSize: 12, outline: "none", fontFamily: C.fontSans, color: C.ink2 }} />
            </div>
            {/* Lista */}
            <div style={{ background: C.surface, borderRadius: 16, overflow: "hidden" as const, border: `1px solid ${C.line}` }}>
              {loadingFact
                ? [1,2,3].map(i => <div key={i} style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}` }}><div style={{ height: 12, background: C.surfaceAlt, borderRadius: 6, width: "60%", marginBottom: 6 }} /><div style={{ height: 10, background: C.surfaceAlt, borderRadius: 6, width: "40%" }} /></div>)
                : (() => {
                    const filt = facturas.filter(f => {
                      const cumpleEstado = filtroFactEstado === "todos"
                      || (filtroFactEstado === "pendiente" && (f.estado === "emitida" || f.estado === "enviada"))
                      || (filtroFactEstado === "pagada"    && f.estado === "cobrada")
                      || (filtroFactEstado === "vencida"   && f.estado === "vencida");
                      const cumpleDesde  = !filtroFactDesde || (f.fecha_emision || "") >= filtroFactDesde;
                      const cumpleHasta  = !filtroFactHasta || (f.fecha_emision || "") <= filtroFactHasta;
                      return cumpleEstado && cumpleDesde && cumpleHasta;
                    });
                    const colorEst: Record<string,{bg:string;c:string;label:string}> = {
                      emitida: { bg: C.warnTint,    c: C.warn,    label: "Pendiente" },
                      enviada: { bg: C.warnTint,    c: C.warn,    label: "Pendiente" },
                      cobrada: { bg: C.successTint, c: C.success, label: "Pagada"    },
                      vencida: { bg: C.dangerTint,  c: C.danger,  label: "Vencida"   },
                      anulada: { bg: C.surfaceAlt,  c: C.mute,    label: "Anulada"   },
                    };
                    if (filt.length === 0) return (
                      <div style={{ padding: "56px 20px", textAlign: "center" as const }}>
                        <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={C.line2} strokeWidth="1.2" style={{ display: "block", margin: "0 auto 12px" }}><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>
                        <p style={{ color: C.mute, fontSize: 14, fontWeight: 600, margin: 0 }}>No hay facturas que coincidan con los filtros</p>
                      </div>
                    );
                    return filt.map(f => {
                      const est = colorEst[f.estado] || { bg: C.surfaceAlt, c: C.mute };
                      const num = `${f.serie || "F"}-${f.numero || f.id}`;
                      return (
                        <div key={f.id} style={{ display: "flex", alignItems: "center", gap: 14, padding: "14px 20px", borderBottom: `1px solid ${C.line}`, transition: "background 0.1s" }}
                          onMouseEnter={e => (e.currentTarget.style.background = C.surfaceAlt)}
                          onMouseLeave={e => (e.currentTarget.style.background = "")}>
                          <div style={{ width: 40, height: 40, borderRadius: 10, background: C.navyTint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 }}>
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke={C.navy} strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>
                          </div>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontWeight: 700, color: C.ink2, fontSize: 13, margin: 0 }}>{f.tipo_comprobante?.toUpperCase() || "FACTURA"} <span style={{ fontFamily: C.fontMono }}>{num}</span></p>
                            <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0", fontFamily: C.fontMono }}>
                              {fmtFecha(f.fecha_emision)}{f.fecha_vencimiento ? ` · Vence ${fmtFecha(f.fecha_vencimiento)}` : ""}
                            </p>
                          </div>
                          <span style={{ fontFamily: C.fontMono, fontWeight: 800, color: C.navy, fontSize: 14, flexShrink: 0 }}>{fmtSoles(Number(f.total))}</span>
                          <span style={{ fontSize: 10, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: est.bg, color: est.c, flexShrink: 0 }}>{est.label}</span>
                          {f.pdf_url
                            ? <a href={f.pdf_url} target="_blank" rel="noopener noreferrer" style={{ display: "flex", alignItems: "center", gap: 5, padding: "6px 12px", borderRadius: 8, border: `1px solid ${C.navyTint2}`, background: C.navyTint, color: C.navy, fontSize: 11, fontWeight: 700, cursor: "pointer", textDecoration: "none", flexShrink: 0 }}>
                                <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
                                PDF
                              </a>
                            : <span style={{ padding: "6px 12px", borderRadius: 8, background: C.surfaceAlt, color: C.mute2, fontSize: 11, flexShrink: 0 }}>Sin PDF</span>}
                        </div>
                      );
                    });
                  })()
              }
            </div>
          </div>
        )}

        {/* DOCUMENTOS */}
        {tab === "documentos" && (
          <div style={{ display: "flex", flexDirection: "column" as const, gap: 16, animation: "fadeIn 0.3s ease" }}>
            {docs.length === 0 ? (
              <div style={{ background: C.white, borderRadius: 18, padding: "48px 32px", textAlign: "center", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                <p style={{ fontSize: 38, margin: "0 0 12px" }}>📂</p>
                <p style={{ fontWeight: 700, fontSize: 15, color: C.gray800, margin: "0 0 6px" }}>Sin documentos disponibles</p>
                <p style={{ fontSize: 13, color: C.gray400, margin: 0 }}>Cuando AFA Transportes suba contratos o cotizaciones aparecerán aquí.</p>
              </div>
            ) : (
              (["Contratos","Cotizaciones","Otros"] as const).map(cat => {
                const catDocs = docs.filter(d => d.categoria === cat);
                if (!catDocs.length) return null;
                return (
                  <div key={cat} style={{ background: C.white, borderRadius: 18, overflow: "hidden", boxShadow: "0 1px 8px rgba(0,0,0,0.06)" }}>
                    <div style={{ padding: "14px 20px", borderBottom: `1px solid ${C.gray100}`, display: "flex", alignItems: "center", gap: 8 }}>
                      <span>{cat === "Contratos" ? "📋" : cat === "Cotizaciones" ? "📑" : "📎"}</span>
                      <p style={{ fontWeight: 900, color: C.gray800, margin: 0, fontSize: 14 }}>{cat}</p>
                      <span style={{ marginLeft: "auto", fontSize: 11, color: C.gray400 }}>{catDocs.length} archivo{catDocs.length !== 1 ? "s" : ""}</span>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill,minmax(280px,1fr))", gap: 12, padding: 16 }}>
                      {catDocs.map(d => (
                        <div key={d.id} style={{ border: `1px solid ${C.gray200}`, borderRadius: 14, padding: "14px 18px", display: "flex", gap: 12, alignItems: "flex-start" }}>
                          <span style={{ fontSize: 28, flexShrink: 0 }}>📄</span>
                          <div style={{ flex: 1, minWidth: 0 }}>
                            <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0, wordBreak: "break-word" }}>{d.nombre}</p>
                            <p style={{ color: C.gray400, fontSize: 11, margin: "4px 0 8px" }}>{fmtBytesPortal(d.tamano_bytes)} · {fmtFecha(d.created_at.slice(0,10))}</p>
                            <button onClick={async () => {
                              const { ok, data } = await portalApi("doc_url", { doc_id: d.id });
                              if (ok && data?.url) window.open(data.url, "_blank");
                            }} style={{ display: "inline-flex", alignItems: "center", gap: 6, padding: "6px 14px", borderRadius: 10, background: "#eef3f8", color: C.navy, fontSize: 11, fontWeight: 800, border: "none", cursor: "pointer" }}>
                              ↓ Descargar
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                );
              })
            )}
            <div style={{ background: "#f0fdf4", border: "1px solid #86efac", borderRadius: 16, padding: "16px 20px", display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ fontSize: 28 }}>📂</span>
              <div>
                <p style={{ color: "#166534", fontWeight: 800, fontSize: 13, margin: 0 }}>¿Necesitas un documento adicional?</p>
                <p style={{ color: "#16a34a", fontSize: 12, margin: "2px 0 0" }}>Escríbenos por WhatsApp al <b>966 707 225</b> y lo gestionamos de inmediato.</p>
              </div>
              <a href="https://wa.me/51966707225" target="_blank" rel="noopener noreferrer" style={{ marginLeft: "auto", padding: "8px 18px", borderRadius: 12, background: "#16a34a", color: "white", fontSize: 12, fontWeight: 800, textDecoration: "none", flexShrink: 0 }}>WhatsApp →</a>
            </div>
          </div>
        )}

        {/* CUENTA / CONFIGURACIÓN */}
        {tab === "cuenta" && (
          <div style={{ animation: "fadeIn 0.3s ease" }}>
            {/* Modal crear / editar usuario */}
            {modalColab && (
              <div onClick={() => { setModalColab(false); resetColabForm(); }} style={{ position: "fixed", inset: 0, zIndex: 50, background: "rgba(15,23,42,0.6)", display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
                <div onClick={e => e.stopPropagation()} style={{ background: "white", borderRadius: 18, padding: "28px", width: "100%", maxWidth: 460, boxShadow: "0 24px 60px rgba(0,0,0,0.2)", maxHeight: "90vh", overflowY: "auto" as const }}>
                  <p style={{ fontWeight: 900, color: C.navy, fontSize: 17, margin: "0 0 20px" }}>{editColab ? "Editar usuario" : "Nuevo usuario"}</p>
                  {([
                    { label: "Nombre completo *", val: newColabNombre, set: setNewColabNombre, ph: "Ej. Juan Pérez" },
                    { label: "DNI *", val: newColabDni, set: (v: string) => setNewColabDni(v.replace(/\D/g,"")), ph: "12345678", mono: true },
                    { label: "Email", val: newColabEmail, set: setNewColabEmail, ph: "juan@empresa.com" },
                    { label: "Cargo", val: newColabCargo, set: setNewColabCargo, ph: "Ej. Gerente de Logística" },
                  ] as { label: string; val: string; set: (v: string) => void; ph: string; mono?: boolean }[]).map(f => (
                    <div key={f.label} style={{ marginBottom: 14 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>{f.label}</label>
                      <input value={f.val} onChange={e => f.set(e.target.value)} placeholder={f.ph}
                        style={{ width: "100%", border: `1.5px solid ${C.line2}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, outline: "none", boxSizing: "border-box" as const, fontFamily: f.mono ? C.fontMono : "inherit", letterSpacing: f.mono ? 1 : "normal" }} />
                    </div>
                  ))}
                  <div style={{ marginBottom: 14 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Contraseña {editColab ? "(dejar en blanco para no cambiar)" : "*"}</label>
                    <input type="password" value={newColabPass} onChange={e => setNewColabPass(e.target.value)} placeholder="⬢⬢⬢⬢⬢⬢⬢⬢"
                      style={{ width: "100%", border: `1.5px solid ${C.line2}`, borderRadius: 8, padding: "10px 14px", fontSize: 13, outline: "none", boxSizing: "border-box" as const, fontFamily: C.fontMono }} />
                  </div>
                  <div style={{ marginBottom: 16 }}>
                    <label style={{ fontSize: 11, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.06em", display: "block", marginBottom: 6 }}>Rol de acceso</label>
                    <div style={{ display: "flex", gap: 8 }}>
                      {(["admin","visor"] as const).map(r => (
                        <button key={r} onClick={() => setNewColabRol(r)} style={{ flex: 1, padding: "10px", borderRadius: 10, border: `2px solid ${newColabRol === r ? C.navy : C.line2}`, background: newColabRol === r ? C.navyTint : "white", color: newColabRol === r ? C.navy : C.mute, fontWeight: 700, fontSize: 13, cursor: "pointer" }}>
                          {r === "admin" ? "Admin · acceso completo" : "Visor · solo lectura"}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Módulos permitidos */}
                  <div style={{ marginBottom: 20 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
                      <label style={{ fontSize: 11, fontWeight: 700, color: C.mute, textTransform: "uppercase" as const, letterSpacing: "0.06em" }}>Módulos con acceso</label>
                      <div style={{ display: "flex", gap: 8 }}>
                        <button onClick={() => setNewColabPermisos(MODULOS_CTRL.map(m => m.id))} style={{ fontSize: 10.5, fontWeight: 700, color: C.navy, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Todos</button>
                        <button onClick={() => setNewColabPermisos([])} style={{ fontSize: 10.5, fontWeight: 700, color: C.mute, background: "none", border: "none", cursor: "pointer", textDecoration: "underline" }}>Ninguno</button>
                      </div>
                    </div>
                    <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 7 }}>
                      {MODULOS_CTRL.map(m => {
                        const on = newColabPermisos.includes(m.id);
                        return (
                          <label key={m.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", border: `1.5px solid ${on ? C.navy : C.line2}`, borderRadius: 8, cursor: "pointer", background: on ? C.navyTint : "white", userSelect: "none" as const }}>
                            <input type="checkbox" checked={on} onChange={e => setNewColabPermisos(prev => e.target.checked ? [...prev, m.id] : prev.filter(x => x !== m.id))} style={{ width: 14, height: 14, accentColor: C.navy, flexShrink: 0 }} />
                            <span style={{ fontSize: 12, fontWeight: 600, color: on ? C.navy : C.mute }}>{m.label}</span>
                          </label>
                        );
                      })}
                    </div>
                    {newColabPermisos.length === 0 && <p style={{ fontSize: 11, color: C.danger, margin: "6px 0 0", fontWeight: 600 }}>Sin acceso a ningún módulo – el usuario no podrá ver nada.</p>}
                  </div>

                  {colabErr && <p style={{ color: C.danger, fontSize: 12, fontWeight: 600, margin: "0 0 12px", background: C.dangerTint, padding: "8px 12px", borderRadius: 7 }}>{colabErr}</p>}
                  <div style={{ display: "flex", gap: 10 }}>
                    <button onClick={() => { setModalColab(false); resetColabForm(); }} style={{ flex: 1, padding: "11px", borderRadius: 12, border: `1px solid ${C.line2}`, background: "white", color: C.mute, fontWeight: 700, cursor: "pointer", fontSize: 13 }}>Cancelar</button>
                    <button onClick={() => guardarColab(cliente.id)} disabled={colabLoad} style={{ flex: 2, padding: "11px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 800, cursor: "pointer", fontSize: 13, opacity: colabLoad ? 0.7 : 1 }}>
                      {colabLoad ? "Guardando..." : editColab ? "Guardar cambios" : "Crear usuario"}
                    </button>
                  </div>
                </div>
              </div>
            )}

            {/* Breadcrumb + header */}
            <div style={{ marginBottom: 16 }}>
              <p style={{ color: C.gray400, fontSize: 11, fontWeight: 700, margin: "0 0 4px", letterSpacing: "0.08em" }}>CONFIGURACIÓN ⬺ {cuentaSeccion.toUpperCase().replace("_CFG","")}</p>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap" as const, gap: 12 }}>
                <div>
                  <p style={{ color: C.gray800, fontWeight: 900, fontSize: 22, margin: 0 }}>{cliente.empresa || cliente.nombre}</p>
                  <p style={{ color: C.gray400, fontSize: 13, margin: "4px 0 0" }}>
                    {/* serviciosTotal, no reservas.length: la lista es una ventana de fechas
                        y aquí se anuncia el histórico completo del cliente. */}
                    RUC {cliente.ruc || "–"} &nbsp;·&nbsp; cliente desde {cliente.created_at ? new Date(cliente.created_at).toLocaleDateString("es-PE",{month:"short",year:"numeric"}) : "–"} &nbsp;·&nbsp; {serviciosTotal} servicios contratados
                  </p>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 16px", borderRadius: 10, border: `1px solid ${C.line}`, background: C.surface, color: C.mute, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                    Vista pública
                  </button>
                  {editandoEmpresa && <button onClick={() => setEditandoEmpresa(false)} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 20px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: C.fontSans }}>
                    <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><polyline points="20 6 9 17 4 12"/></svg>
                    Guardar cambios
                  </button>}
                </div>
              </div>
            </div>

            {/* KPIs */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 12, marginBottom: 16 }}>
              {[
                { label: "USUARIOS ACTIVOS",  val: colabs.filter(c=>c.activo).length, sub: `de ${colabs.length} permitidos` },
                { label: "SERVICIOS ESTE MES",val: serviciosMes, sub: `+${Math.max(0,serviciosMes-2)} vs mes anterior` },
                { label: "MÉTODOS DE PAGO",   val: 2, sub: "tarjeta + factura" },
                { label: "CUMPLIMIENTO SLA",  val: `${puntualidad}%`, sub: "últimos 90 días", color: puntualidad >= 90 ? C.green : C.amber },
              ].map(k => (
                <div key={k.label} style={{ background: C.white, borderRadius: 14, padding: "18px 20px", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: C.gray400, margin: "0 0 8px", letterSpacing: "0.07em" }}>{k.label}</p>
                  <p style={{ fontSize: 28, fontWeight: 900, color: (k as any).color || C.gray800, margin: 0 }}>{k.val}</p>
                  <p style={{ fontSize: 11, color: C.gray400, margin: "4px 0 0" }}>{k.sub}</p>
                </div>
              ))}
            </div>

            {/* Cuerpo: sidebar + contenido */}
            <div style={{ display: "grid", gridTemplateColumns: "220px 1fr", gap: 16, alignItems: "start" }}>

              {/* Sidebar izquierdo */}
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 4 }}>
                <div style={{ background: C.surface, borderRadius: 16, overflow: "hidden" as const, border: `1px solid ${C.line}`, marginBottom: 4 }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: C.mute, padding: "12px 16px 8px", margin: 0, letterSpacing: "0.08em" }}>CUENTA</p>
                  {(() => {
                    const SVG: Record<string, any> = {
                      empresa:        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M3 9l9-7 9 7v11a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/><polyline points="9 22 9 12 15 12 15 22"/></svg>,
                      usuarios:       <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>,
                      notificaciones: <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>,
                      facturacion_cfg:<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>,
                      integraciones:  <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>,
                      seguridad:      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>,
                      preferencias:   <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><line x1="4" y1="6" x2="20" y2="6"/><line x1="4" y1="12" x2="20" y2="12"/><line x1="4" y1="18" x2="20" y2="18"/><circle cx="8" cy="6" r="2.2" fill="currentColor" stroke="none"/><circle cx="16" cy="12" r="2.2" fill="currentColor" stroke="none"/><circle cx="10" cy="18" r="2.2" fill="currentColor" stroke="none"/></svg>,
                    };
                    return ([
                      { id: "empresa",        label: "Empresa",           sub: "Razón social, RUC, datos fiscales" },
                      { id: "usuarios",       label: "Usuarios y accesos",sub: `${colabs.filter(c=>c.activo).length} activos · ${colabs.filter(c=>c.rol==="admin").length} admin` },
                      { id: "notificaciones", label: "Notificaciones",    sub: "Email, SMS, push, WhatsApp" },
                      { id: "facturacion_cfg",label: "Facturación",       sub: "Datos de pago, historial" },
                      { id: "integraciones",  label: "Integraciones",     sub: "API, webhooks, Slack, SAP" },
                      { id: "seguridad",      label: "Seguridad",         sub: "2FA, sesiones, auditoría" },
                      { id: "preferencias",   label: "Preferencias",      sub: "Idioma, zona horaria, formato" },
                    ] as { id: CuentaSeccion; label: string; sub: string }[]).map(item => (
                      <button key={item.id} onClick={() => setCuentaSeccion(item.id)}
                        style={{ width: "100%", padding: "10px 14px", border: "none", background: cuentaSeccion === item.id ? C.navyTint : "transparent", cursor: "pointer", textAlign: "left" as const, borderLeft: `3px solid ${cuentaSeccion === item.id ? C.navy : "transparent"}`, transition: "all 0.15s", fontFamily: C.fontSans }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                          <div style={{ width: 28, height: 28, borderRadius: 8, background: cuentaSeccion === item.id ? C.navyTint2 : C.surfaceAlt, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: cuentaSeccion === item.id ? C.navy : C.mute, transition: "all 0.15s" }}>
                            {SVG[item.id]}
                          </div>
                          <div>
                            <p style={{ fontWeight: 700, color: cuentaSeccion === item.id ? C.navy : C.ink2, fontSize: 13, margin: 0 }}>{item.label}</p>
                            <p style={{ color: C.mute2, fontSize: 10, margin: "1px 0 0" }}>{item.sub}</p>
                          </div>
                        </div>
                      </button>
                    ));
                  })()}
                </div>

                {/* Plan actual */}
                <div style={{ background: C.navyDeep, borderRadius: 16, padding: "16px", color: "white" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "rgba(255,255,255,0.45)", margin: "0 0 8px", letterSpacing: "0.08em" }}>PLAN ACTUAL</p>
                  <p style={{ fontWeight: 900, fontSize: 15, margin: "0 0 4px" }}>Empresarial Plus</p>
                  <p style={{ fontSize: 11, color: "rgba(255,255,255,0.55)", margin: "0 0 12px" }}>Hasta 50 usuarios · GPS · API</p>
                  <button style={{ width: "100%", padding: "8px", borderRadius: 10, border: "1px solid rgba(255,255,255,0.18)", background: "rgba(255,255,255,0.08)", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>Cambiar plan</button>
                </div>
              </div>

              {/* Contenido principal */}
              <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>

                {/* EMPRESA */}
                {cuentaSeccion === "empresa" && (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14, alignItems: "start" }}>
                    <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 10, background: C.navyTint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: C.navy }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                        </div>
                        <div>
                          <p style={{ fontWeight: 800, color: C.ink2, fontSize: 14, margin: 0 }}>Datos de la empresa</p>
                          <p style={{ color: C.mute, fontSize: 11, margin: 0 }}>Información fiscal y de contacto principal</p>
                        </div>
                        <button onClick={() => setEditandoEmpresa(!editandoEmpresa)} style={{ marginLeft: "auto", padding: "5px 14px", borderRadius: 8, border: `1px solid ${C.line}`, background: "white", color: C.navy, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: C.fontSans }}>
                          {editandoEmpresa ? "Cancelar" : "Editar"}
                        </button>
                      </div>
                      {[
                        { label: "Razón social",     val: cliente.empresa || cliente.nombre, editable: false },
                        { label: "RUC",               val: cliente.ruc || "–",               editable: false, badge: "✓ verificado" },
                        { label: "Dirección fiscal",  val: empDireccion,                      editable: true,  set: setEmpDireccion },
                        { label: "Sector",            val: empSector,                         editable: true,  set: setEmpSector },
                        { label: "Tamaño de flota",   val: empFlota,                          editable: true,  set: setEmpFlota },
                      ].map(row => (
                        <div key={row.label} style={{ display: "flex", alignItems: "center", padding: "13px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                          <p style={{ width: 120, flexShrink: 0, color: C.gray400, fontSize: 12, margin: 0 }}>{row.label}</p>
                          <div style={{ flex: 1 }}>
                            {editandoEmpresa && row.editable && row.set
                              ? <input value={row.val} onChange={e => (row.set as any)(e.target.value)} style={{ width: "100%", border: `1px solid ${C.navy}`, borderRadius: 8, padding: "6px 10px", fontSize: 13, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const }} />
                              : <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                                  <p style={{ fontWeight: 600, color: C.gray800, fontSize: 13, margin: 0 }}>{row.val}</p>
                                  {(row as any).badge && <span style={{ fontSize: 10, fontWeight: 800, padding: "2px 8px", borderRadius: 20, background: "#dcfce7", color: C.green }}>{(row as any).badge}</span>}
                                </div>
                            }
                          </div>
                          {!editandoEmpresa && row.editable && <button onClick={() => setEditandoEmpresa(true)} style={{ color: C.navy, fontSize: 12, fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}>Editar</button>}
                        </div>
                      ))}
                    </div>

                    {/* Notificaciones rápidas */}
                    <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", alignItems: "center", gap: 10 }}>
                        <div style={{ width: 32, height: 32, borderRadius: 10, background: C.warnTint, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: C.warn }}>
                          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>
                        </div>
                        <div>
                          <p style={{ fontWeight: 800, color: C.ink2, fontSize: 14, margin: 0 }}>Notificaciones</p>
                          <p style={{ color: C.mute, fontSize: 11, margin: 0 }}>Cómo quieres enterarte de cada evento</p>
                        </div>
                      </div>
                      {notifPrefs.map(np => (
                        <div key={np.id} style={{ padding: "13px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 6 }}>
                            <div>
                              <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0 }}>{np.titulo}</p>
                              <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 6px" }}>{np.desc}</p>
                              <div style={{ display: "flex", gap: 4, flexWrap: "wrap" as const }}>
                                {np.canales.map(c => <span key={c} style={{ fontSize: 9, fontWeight: 800, padding: "2px 7px", borderRadius: 20, background: "#eef3f8", color: C.navy, letterSpacing: "0.04em" }}>{c}</span>)}
                              </div>
                            </div>
                            {/* Toggle */}
                            <button onClick={() => setNotifPrefs(prev => prev.map(p => p.id === np.id ? {...p, activo: !p.activo} : p))}
                              style={{ width: 40, height: 22, borderRadius: 11, border: "none", background: np.activo ? "#1a6fb8" : C.gray200, cursor: "pointer", position: "relative" as const, flexShrink: 0, transition: "background 0.2s" }}>
                              <span style={{ position: "absolute", top: 3, left: np.activo ? 20 : 3, width: 16, height: 16, borderRadius: "50%", background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                )}

                {/* USUARIOS Y ACCESOS */}
                {cuentaSeccion === "usuarios" && (
                  <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                    <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}`, display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                      <div>
                        <p style={{ fontWeight: 800, color: C.ink2, fontSize: 14, margin: 0 }}>Usuarios y accesos</p>
                        <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0" }}>{colabs.filter(c=>c.activo).length} activos · {colabs.filter(c=>!c.activo).length} inactivos · {colabs.filter(c=>c.rol==="admin").length} admin, {colabs.filter(c=>c.rol==="visor").length} visor</p>
                      </div>
                      {portalUsuario?.rol === "admin" && (
                        <button onClick={() => { resetColabForm(); setModalColab(true); }} style={{ display: "flex", alignItems: "center", gap: 6, padding: "8px 18px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontSize: 12, fontWeight: 800, cursor: "pointer", fontFamily: C.fontSans }}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
                          Nuevo usuario
                        </button>
                      )}
                    </div>
                    {loadingColabs
                      ? [1,2].map(i => <div key={i} style={{ padding: "16px 20px", borderBottom: `1px solid ${C.line}` }}><div style={{ height: 12, background: C.surfaceAlt, borderRadius: 4, width: "60%", marginBottom: 6 }} /><div style={{ height: 10, background: C.surfaceAlt, borderRadius: 4, width: "40%" }} /></div>)
                      : colabs.length === 0
                        ? <div style={{ padding: "32px 20px", textAlign: "center" as const, color: C.mute, fontSize: 13 }}>Sin usuarios configurados. Crea el primer usuario con el botón de arriba.</div>
                        : colabs.map(c => (
                          <div key={c.id} style={{ display: "flex", gap: 14, padding: "14px 20px", borderBottom: `1px solid ${C.line}`, alignItems: "center", opacity: c.activo ? 1 : 0.5 }}>
                            <div style={{ width: 40, height: 40, borderRadius: "50%", background: c.rol === "admin" ? C.navy : C.navyTint, display: "flex", alignItems: "center", justifyContent: "center", fontWeight: 900, fontSize: 14, color: c.rol === "admin" ? "white" : C.navy, flexShrink: 0 }}>
                              {c.nombre.split(" ").map((w: string) => w[0]).slice(0,2).join("")}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{ fontWeight: 700, color: C.ink2, fontSize: 13, margin: 0 }}>{c.nombre}</p>
                              <p style={{ color: C.mute, fontSize: 11, margin: "2px 0 0", fontFamily: C.fontMono }}>
                                DNI {c.dni}{c.cargo ? ` · ${c.cargo}` : ""}{c.email ? ` · ${c.email}` : ""}
                              </p>
                              {c.modulos_permitidos && (
                                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 4, marginTop: 5 }}>
                                  {MODULOS_CTRL.map(m => {
                                    const ok = c.modulos_permitidos!.includes(m.id);
                                    return (
                                      <span key={m.id} style={{ fontSize: 9.5, fontWeight: 700, padding: "2px 7px", borderRadius: 4, background: ok ? C.navyTint : C.surfaceAlt, color: ok ? C.navy : C.mute2, textDecoration: ok ? "none" : "line-through" }}>
                                        {m.label}
                                      </span>
                                    );
                                  })}
                                </div>
                              )}
                            </div>
                            <span style={{ fontSize: 11, fontWeight: 800, padding: "3px 10px", borderRadius: 20, background: c.rol === "admin" ? C.navyTint : C.successTint, color: c.rol === "admin" ? C.navy : C.success, flexShrink: 0 }}>{c.rol === "admin" ? "Admin" : "Visor"}</span>
                            {portalUsuario?.rol === "admin" && (<>
                              <button onClick={() => abrirEditarColab(c)}
                                style={{ padding: "5px 11px", borderRadius: 8, border: `1px solid ${C.line2}`, background: C.surface, color: C.ink2, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
                                Editar
                              </button>
                              <button onClick={() => toggleColabActivo(c.id, c.activo)}
                                style={{ padding: "5px 11px", borderRadius: 8, border: `1px solid ${c.activo ? "#fca5a5" : "#86efac"}`, background: c.activo ? "#fff5f5" : "#f0fdf4", color: c.activo ? C.danger : C.success, fontSize: 11, fontWeight: 800, cursor: "pointer", flexShrink: 0 }}>
                                {c.activo ? "Desactivar" : "Reactivar"}
                              </button>
                              <button onClick={() => eliminarColab(c.id, c.nombre, cliente.id)}
                                style={{ padding: "5px 11px", borderRadius: 8, border: `1px solid ${C.line2}`, background: C.surface, color: C.danger, fontSize: 11, fontWeight: 700, cursor: "pointer", flexShrink: 0 }}>
                                Eliminar
                              </button>
                            </>)}
                          </div>
                        ))
                    }
                    <div style={{ padding: "12px 20px", background: C.navyTint, borderTop: `1px solid ${C.line}` }}>
                      <p style={{ color: C.navy, fontSize: 12, margin: 0 }}><b>Admin:</b> acceso completo · <b>Visor:</b> solo lectura de servicios e historial · <b>Login:</b> RUC empresa + DNI + contraseña</p>
                    </div>
                  </div>
                )}

                {/* NOTIFICACIONES */}
                {cuentaSeccion === "notificaciones" && (
                  <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                    <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                      <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: 0 }}>Preferencias de notificación</p>
                      <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>Configura cómo y cuándo quieres recibir alertas de tus servicios</p>
                    </div>
                    {notifPrefs.map(np => (
                      <div key={np.id} style={{ display: "flex", alignItems: "center", gap: 16, padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0 }}>{np.titulo}</p>
                          <p style={{ color: C.gray400, fontSize: 11, margin: "3px 0 8px" }}>{np.desc}</p>
                          <div style={{ display: "flex", gap: 5, flexWrap: "wrap" as const }}>
                            {np.canales.map(ch => <span key={ch} style={{ fontSize: 9, fontWeight: 800, padding: "3px 9px", borderRadius: 20, background: "#eef3f8", color: C.navy, letterSpacing: "0.04em" }}>{ch}</span>)}
                          </div>
                        </div>
                        <button onClick={() => setNotifPrefs(prev => prev.map(p => p.id === np.id ? {...p, activo: !p.activo} : p))}
                          style={{ width: 44, height: 24, borderRadius: 12, border: "none", background: np.activo ? "#1a6fb8" : C.gray200, cursor: "pointer", position: "relative" as const, flexShrink: 0, transition: "background 0.2s" }}>
                          <span style={{ position: "absolute", top: 3, left: np.activo ? 22 : 3, width: 18, height: 18, borderRadius: "50%", background: "white", boxShadow: "0 1px 3px rgba(0,0,0,0.2)", transition: "left 0.2s" }} />
                        </button>
                      </div>
                    ))}
                  </div>
                )}

                {/* FACTURACIÓN */}
                {cuentaSeccion === "facturacion_cfg" && (
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: 14 }}>
                    <div style={{ background: C.white, borderRadius: 16, padding: "20px", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                      <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: "0 0 16px" }}>Datos de facturación</p>
                      {[["Razón social",cliente.empresa||cliente.nombre],["RUC",cliente.ruc||"–"],["Condición de pago","Crédito 30 días"],["Moneda preferida","Soles (PEN)"]].map(([l,v]) => (
                        <div key={l} style={{ display: "flex", padding: "10px 0", borderBottom: `1px solid ${C.gray100}` }}>
                          <p style={{ width: 160, flexShrink: 0, color: C.gray400, fontSize: 12, margin: 0 }}>{l}</p>
                          <p style={{ fontWeight: 600, color: C.gray800, fontSize: 13, margin: 0 }}>{v}</p>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setTab("facturacion")} style={{ alignSelf: "flex-start" as const, padding: "10px 22px", borderRadius: 12, border: "none", background: C.navy, color: "white", fontWeight: 800, fontSize: 13, cursor: "pointer" }}>Ver historial de facturas →</button>
                  </div>
                )}

                {/* INTEGRACIONES */}
                {cuentaSeccion === "integraciones" && (
                  <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                    <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                      <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: 0 }}>Integraciones disponibles</p>
                      <p style={{ color: C.gray400, fontSize: 12, margin: "4px 0 0" }}>Conecta el portal con tus herramientas empresariales</p>
                    </div>
                    {[
                      { nombre: "API REST", desc: "Consulta servicios y tracking programáticamente", estado: "Activo",        color: C.success, bg: C.successTint },
                      { nombre: "Webhooks", desc: "Recibe eventos en tiempo real en tu sistema",    estado: "Configurar",   color: C.navy,    bg: C.navyTint    },
                      { nombre: "Slack",    desc: "Notificaciones de servicio en tu canal Slack",   estado: "Próximamente", color: C.mute,    bg: C.surfaceAlt  },
                      { nombre: "SAP / ERP",desc: "Sincronización con tu ERP de gestión",           estado: "Próximamente", color: C.mute,    bg: C.surfaceAlt  },
                    ].map(int => (
                      <div key={int.nombre} style={{ display: "flex", alignItems: "center", gap: 16, padding: "14px 20px", borderBottom: `1px solid ${C.line}` }}>
                        <div style={{ width: 42, height: 42, borderRadius: 12, background: int.bg, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, color: int.color }}>
                          <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>
                        </div>
                        <div style={{ flex: 1 }}>
                          <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0 }}>{int.nombre}</p>
                          <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>{int.desc}</p>
                        </div>
                        <span style={{ fontSize: 11, fontWeight: 800, padding: "4px 14px", borderRadius: 20, background: int.bg, color: int.color }}>{int.estado}</span>
                      </div>
                    ))}
                  </div>
                )}

                {/* SEGURIDAD */}
                {cuentaSeccion === "seguridad" && (
                  <div style={{ display: "flex", flexDirection: "column" as const, gap: 16 }}>

                    {/* ── Cambiar contraseña — solo usuarios individuales del portal (id>0) ── */}
                    {portalUsuario && portalUsuario.id > 0 ? (
                      <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                          <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: 0 }}>Cambiar contraseña</p>
                          <p style={{ color: C.gray400, fontSize: 11.5, margin: "2px 0 0" }}>
                            Actualiza la contraseña con la que {portalUsuario.nombre || "tu usuario"} accede al portal
                          </p>
                        </div>
                        <form onSubmit={e => { e.preventDefault(); cambiarPassword(); }}
                          style={{ padding: "18px 20px", display: "flex", flexDirection: "column" as const, gap: 14, maxWidth: 460 }}>

                          {/* Contraseña actual */}
                          <div>
                            <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Contraseña actual</label>
                            <input type={pwdShow ? "text" : "password"} value={pwdActual} onChange={e => { setPwdActual(e.target.value); setPwdOk(false); setPwdErr(""); }}
                              autoComplete="current-password" placeholder="Tu contraseña actual"
                              style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${C.line}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                          </div>

                          {/* Nueva contraseña */}
                          <div>
                            <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Nueva contraseña</label>
                            <div style={{ position: "relative" as const }}>
                              <input type={pwdShow ? "text" : "password"} value={pwdNueva} onChange={e => { setPwdNueva(e.target.value); setPwdOk(false); setPwdErr(""); }}
                                autoComplete="new-password" placeholder="Mínimo 6 caracteres"
                                style={{ width: "100%", padding: "11px 40px 11px 14px", borderRadius: 10, border: `1.5px solid ${C.line}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                              <button onClick={() => setPwdShow(p => !p)} type="button" aria-label={pwdShow ? "Ocultar contraseña" : "Mostrar contraseña"} aria-pressed={pwdShow}
                                style={{ position: "absolute" as const, right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: C.mute, padding: 4 }}>
                                {pwdShow
                                  ? <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19"/><line x1="1" y1="1" x2="23" y2="23"/></svg>
                                  : <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>}
                              </button>
                            </div>
                          </div>

                          {/* Confirmar nueva contraseña */}
                          <div>
                            <label style={{ display: "block", fontSize: 11.5, fontWeight: 700, color: C.ink2, marginBottom: 6 }}>Confirmar nueva contraseña</label>
                            <input type={pwdShow ? "text" : "password"} value={pwdNueva2} onChange={e => { setPwdNueva2(e.target.value); setPwdOk(false); setPwdErr(""); }}
                              autoComplete="new-password" placeholder="Repite la nueva contraseña"
                              style={{ width: "100%", padding: "11px 14px", borderRadius: 10, border: `1.5px solid ${pwdNueva2 && pwdNueva !== pwdNueva2 ? C.danger : C.line}`, fontSize: 14, outline: "none", fontFamily: "inherit", boxSizing: "border-box" as const, background: C.bg }} />
                          </div>

                          {pwdErr && (
                            <p style={{ margin: 0, fontSize: 12.5, color: C.danger, fontWeight: 600, background: C.dangerTint, padding: "8px 12px", borderRadius: 8 }}>{pwdErr}</p>
                          )}
                          {pwdOk && (
                            <p style={{ margin: 0, fontSize: 12.5, color: C.success, fontWeight: 600, background: C.successTint, padding: "8px 12px", borderRadius: 8 }}>✓ Contraseña actualizada. Úsala la próxima vez que inicies sesión.</p>
                          )}

                          <div>
                            <button type="submit" disabled={pwdLoad}
                              style={{ padding: "11px 22px", borderRadius: 12, border: "none", background: pwdLoad ? C.mute2 : C.navy, color: "white", fontWeight: 800, fontSize: 13.5, cursor: pwdLoad ? "not-allowed" : "pointer", fontFamily: "inherit", display: "inline-flex", alignItems: "center", gap: 8 }}>
                              {pwdLoad ? "Guardando..." : "Actualizar contraseña"}
                            </button>
                          </div>
                        </form>
                      </div>
                    ) : (
                      <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                        <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                          <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: 0 }}>Cambiar contraseña</p>
                        </div>
                        <div style={{ padding: "18px 20px" }}>
                          <div style={{ background: C.warnTint, border: `1px solid ${C.warn}33`, borderRadius: 10, padding: "11px 14px" }}>
                            <p style={{ margin: 0, fontSize: 12.5, color: C.warn, fontWeight: 600, lineHeight: 1.55 }}>
                              Estás accediendo con el código compartido de la empresa, no con un usuario individual. Para tener tu propia contraseña, pide a AFA Transportes (o a un administrador de tu empresa) que te cree un usuario en <strong>Usuarios y accesos</strong>.
                            </p>
                          </div>
                        </div>
                      </div>
                    )}

                    {/* ── Seguridad de la cuenta (informativo) ── */}
                    <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                      <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                        <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: 0 }}>Seguridad de la cuenta</p>
                      </div>
                      {[
                        { titulo: "Autenticación en 2 pasos (2FA)", desc: "Capa extra de seguridad para el acceso", activo: false },
                        { titulo: "Sesiones activas",               desc: "1 sesión activa · Lima, Perú",          activo: true  },
                        { titulo: "Registro de auditoría",          desc: "Historial de accesos e inicios de sesión",activo: true  },
                      ].map(s => (
                        <div key={s.titulo} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                          <div>
                            <p style={{ fontWeight: 700, color: C.gray800, fontSize: 13, margin: 0 }}>{s.titulo}</p>
                            <p style={{ color: C.gray400, fontSize: 11, margin: "2px 0 0" }}>{s.desc}</p>
                          </div>
                          <span style={{ fontSize: 11, fontWeight: 800, padding: "4px 14px", borderRadius: 20, background: s.activo ? "#dcfce7" : "#fee2e2", color: s.activo ? C.green : C.red }}>{s.activo ? "Activo" : "Inactivo"}</span>
                        </div>
                      ))}
                    </div>

                  </div>
                )}

                {/* PREFERENCIAS */}
                {cuentaSeccion === "preferencias" && (
                  <div style={{ background: C.white, borderRadius: 16, overflow: "hidden", boxShadow: "0 1px 6px rgba(0,0,0,0.05)", border: `1px solid ${C.gray100}` }}>
                    <div style={{ padding: "16px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                      <p style={{ fontWeight: 800, color: C.gray800, fontSize: 14, margin: 0 }}>Preferencias del portal</p>
                    </div>
                    {[
                      { label: "Idioma",         val: "Español (Perú)" },
                      { label: "Zona horaria",   val: "America/Lima (UTC-5)" },
                      { label: "Formato de fecha", val: "DD/MM/YYYY" },
                      { label: "Moneda",         val: "Soles peruanos (PEN, S/)" },
                    ].map(p => (
                      <div key={p.label} style={{ display: "flex", alignItems: "center", padding: "14px 20px", borderBottom: `1px solid ${C.gray100}` }}>
                        <p style={{ width: 160, flexShrink: 0, color: C.gray400, fontSize: 12, margin: 0 }}>{p.label}</p>
                        <p style={{ flex: 1, fontWeight: 600, color: C.gray800, fontSize: 13, margin: 0 }}>{p.val}</p>
                        <button style={{ color: C.navy, fontSize: 12, fontWeight: 700, background: "none", border: "none", cursor: "pointer" }}>Editar</button>
                      </div>
                    ))}
                  </div>
                )}

              </div>
            </div>
          </div>
        )}
      </div>

      {/* ══ MODAL MANIFIESTO PORTAL ══ */}
      {modalManifiestoData && (
        <ModalManifiestoPortal
          reservaId={modalManifiestoData.reservaId}
          clienteId={modalManifiestoData.clienteId}
          readonly={modalManifiestoData.readonly}
          onClose={() => setModalManifiestoData(null)}
          onChanged={() => {
            // Recarga forzada: el sello se limpia para que este cambio sí vuelva a pedir.
            if (cliente) { statsPedidosRef.current = false; cargarHistorialStats(); }
            // El detalle y los PDFs leen ppList/paradas/boarding cacheados. Tras editar el
            // manifiesto hay que refrescarlos o quedarían obsoletos respecto al historial.
            const rid = modalManifiestoData.reservaId;
            if (reservaSel?.id === rid) {
              // Detalle abierto: recarga forzada para que no quede vacío ni desactualizado.
              const r = reservas.find(x => x.id === rid);
              if (r) cargarDetalle(r, true);
            } else {
              // Detalle cerrado: invalida la caché; se recargará al abrir "Ver".
              setPPList(prev => { const cp = { ...prev }; delete cp[rid]; return cp; });
              setParadas(prev => { const cp = { ...prev }; delete cp[rid]; return cp; });
              setBoarding(prev => { const cp = { ...prev }; delete cp[rid]; return cp; });
            }
          }}
        />
      )}
    </div>
  );
}
