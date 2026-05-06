"use client";

import React, { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// ─── TIPOS ────────────────────────────────────────────────────────────────────

type EstadoCot = "pendiente" | "enviado" | "aprobado" | "rechazado";

type ItemCot = {
  descripcion: string; dias: number; cantidad: number;
  precio_unit: number; descuento_pct: number;
};

type Cliente = {
  id: number; nombre: string; empresa?: string; tipo?: string;
  ruc?: string; dni?: string; telefono?: string; email?: string;
  direccion?: string; ciudad?: string; estado?: string;
  operativo_nombre?: string; operativo_celular?: string;
  administrativo_nombre?: string;
};

type Cotizacion = {
  id: number; cliente_id: number | null;
  origen: string; destino: string; km: number;
  precio_cliente: number; costo_estimado: number; margen_estimado: number;
  estado: EstadoCot; pdf_url: string | null;
  numero_cotizacion: string | null; atencion: string | null;
  asunto: string | null; punto_retorno: string | null;
  fecha_servicio: string | null; hora_ida: string | null;
  hora_retorno: string | null; descuento_pct: number;
  items_json: ItemCot[] | null;
  numero_aprobacion: string | null; tipo_aprobacion: string | null;
  tipo_vehiculo: string | null; tipo_servicio: string | null;
  equipamiento: string | null; vehiculo_flota_id: number | null;
  consideraciones_json: ConsideracionesCot | null;
  created_at: string;
};

type Tarifa = {
  id: number; origen: string; destino: string;
  tipo_vehiculo: string; equipamiento: string; tipo_servicio: string;
  precio: number; moneda: string; confidencial: boolean;
  incluye_guia: boolean; incluye_peajes: boolean; incluye_alimentacion: boolean;
  notas: string | null;
};

type VehiculoFlota = {
  id: number; placa: string; categoria: string | null;
  marca: string | null; modelo: string | null; anio: number | null;
  capacidad_pasajeros: number | null; equipamiento: string | null;
  foto_externa_url: string | null; foto_interna_url: string | null;
  descripcion_unidad: string | null;
};

// ─── TIPOS CONSIDERACIONES ──────────────────────────────────────────────────

type ConsideracionesCot = {
  incluye: string[];
  no_incluye: string[];
  generales: string[];
};

const DEFAULT_CONSIDERACIONES: ConsideracionesCot = {
  incluye: [
    "Traslado de origen a destino",
    "Conductor profesional certificado",
    "Combustible durante todo el recorrido",
    "GPS en tiempo real",
    "Seguro de viaje SOAT vigente",
  ],
  no_incluye: [
    "Alimentación y bebidas",
    "Guía turístico",
    "Entradas a atractivos turísticos",
    "Peajes (salvo indicación expresa en cotización)",
  ],
  generales: [
    "Precios según fechas y horarios coordinados.",
    "Tolerancia máxima de espera: 30 minutos.",
    "No se permite consumo de alcohol ni tabaco a bordo.",
    "Cambios en ruta u horario pueden generar costos adicionales.",
    "Servicio eventual: adelanto del 50% para confirmar, saldo antes de culminar el servicio.",
    "Recomendamos reservar con 7 días de anticipación mínimo.",
  ],
};

// ─── CONFIG ───────────────────────────────────────────────────────────────────

const TIPOS_VEHICULO = [
  { id: "AUTO_4",      label: "Auto 4 pax",       pax: 4,  icon: "🚗" },
  { id: "SUV_4",       label: "SUV 4 pax",        pax: 4,  icon: "🚙" },
  { id: "SUV_6",       label: "SUV 6 pax",        pax: 6,  icon: "🚙" },
  { id: "MINIVAN_10",  label: "Minivan 10 pax",   pax: 10, icon: "🚐" },
  { id: "VAN_15",      label: "Van 15 pax",       pax: 15, icon: "🚐" },
  { id: "SPRINTER_17", label: "Sprinter 17 pax",  pax: 17, icon: "🚌" },
  { id: "SPRINTER_20", label: "Sprinter 20 pax",  pax: 20, icon: "🚌" },
  { id: "CUSTER_25",   label: "Custer 25 pax",    pax: 25, icon: "🚌" },
  { id: "MINIBUS_30",  label: "Minibus 30 pax",   pax: 30, icon: "🚌" },
  { id: "MINIBUS_35",  label: "Minibus 35 pax",   pax: 35, icon: "🚌" },
  { id: "BUS_40",      label: "Bus 40 pax",       pax: 40, icon: "🚌" },
  { id: "BUS_45",      label: "Bus 45 pax",       pax: 45, icon: "🚌" },
  { id: "BUS_49",      label: "Bus 49 pax",       pax: 49, icon: "🚌" },
  { id: "BUS_50",      label: "Bus 50 pax",       pax: 50, icon: "🚌" },
  { id: "BUS_54",      label: "Bus 54 pax",       pax: 54, icon: "🚌" },
  { id: "BUS_60",      label: "Bus 60 pax",       pax: 60, icon: "🚌" },
];

type Servicio = "solo_ida" | "ida_retorno" | "ida_retorno_paradas" | "full_day";
const TIPOS_SERVICIO: Record<Servicio, { label: string; icon: string; color: string; bg: string }> = {
  solo_ida:            { label: "Solo ida",             icon: "➡️", color: "#0b315f", bg: "#eef3f8" },
  ida_retorno:         { label: "Ida y retorno",         icon: "🔄", color: "#166534", bg: "#dcfce7" },
  ida_retorno_paradas: { label: "Ida/retorno + paradas", icon: "📍", color: "#854d0e", bg: "#fef9c3" },
  full_day:            { label: "Full Day / Tour",       icon: "⭐", color: "#6d28d9", bg: "#ede9fe" },
};

const ESTADO_CFG: Record<EstadoCot, { label: string; bg: string; color: string }> = {
  pendiente: { label: "Pendiente", bg: "#fef9c3", color: "#854d0e" },
  enviado:   { label: "Enviado",   bg: "#e0f2fe", color: "#0369a1" },
  aprobado:  { label: "Aprobado",  bg: "#dcfce7", color: "#166534" },
  rechazado: { label: "Rechazado", bg: "#fee2e2", color: "#991b1b" },
};
const FLUJO_COT: Record<EstadoCot, string> = {
  pendiente: "En elaboración", enviado: "Esperando respuesta",
  aprobado: "Lista para convertir", rechazado: "Cliente rechazó",
};
const TIPOS_APROBACION = [
  "Operación bancaria", "Orden de compra", "Orden de servicio",
  "Correo de confirmación", "Contrato firmado",
];
const ITEM_VACIO: ItemCot = { descripcion: "", dias: 1, cantidad: 1, precio_unit: 0, descuento_pct: 0 };
const FORM_VACIO = {
  cliente_id: "", origen: "", destino: "", km: "",
  costo_estimado: "", estado: "pendiente" as EstadoCot,
  numero_cotizacion: "", atencion: "", asunto: "",
  punto_retorno: "", fecha_servicio: "", hora_ida: "",
  hora_retorno: "", descuento_pct: "0",
  tipo_vehiculo: "BUS_49", tipo_servicio: "solo_ida" as Servicio,
  equipamiento: "full_equipo", vehiculo_flota_id: "",
};

// ─── HELPERS ──────────────────────────────────────────────────────────────────

function fmtSoles(n: number) {
  return `S/ ${n.toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}
function fmtFecha(f: string | null) {
  if (!f) return "—";
  return new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
}
function calcItems(items: ItemCot[]) {
  const subtotal = items.reduce((s, it) => s + it.dias * it.cantidad * it.precio_unit * (1 - it.descuento_pct / 100), 0);
  return { subtotal, igv: subtotal * 0.18, total: subtotal * 1.18 };
}
function norm(s: string) {
  return s.trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "");
}
function inputCls(extra = "") {
  return `w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${extra}`;
}
function Campo({ label, span, req, hint, children }: { label: string; span?: number; req?: boolean; hint?: string; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
        {label}{req && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
      {hint && <p className="text-[10px] text-gray-400 mt-0.5">{hint}</p>}
    </div>
  );
}

// Convierte URL de Google Drive a URL embebible en HTML/PDF
function driveToImg(url: string): string {
  if (!url) return url;
  // Formato: /file/d/ID/view o /d/ID
  const match = url.match(/\/d\/([a-zA-Z0-9_-]{20,})/);
  if (match) {
    // thumbnail funciona sin CORS y sin login para archivos públicos
    return `https://drive.google.com/thumbnail?id=${match[1]}&sz=w800`;
  }
  // Si ya es URL directa de imagen
  return url;
}

// ─── MODAL APROBACIÓN ─────────────────────────────────────────────────────────

function ModalAprobacion({ cotizacion, onConfirmar, onCancelar }: {
  cotizacion: Cotizacion; onConfirmar: (tipo: string, numero: string) => void; onCancelar: () => void;
}) {
  const [tipo, setTipo] = useState("Operación bancaria");
  const [numero, setNumero] = useState(""); const [error, setError] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: "#dcfce7" }}>✅</div>
          <div><h3 className="text-base font-bold">Aprobar cotización</h3><p className="text-xs text-gray-400">Registra el documento de respaldo</p></div>
        </div>
        <div className="rounded-xl p-3 text-xs space-y-1.5" style={{ background: "#f8fafc" }}>
          <div className="flex justify-between"><span className="text-gray-400">Cotización</span><span className="font-bold">#{cotizacion.numero_cotizacion || String(cotizacion.id).padStart(5, "0")}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Monto</span><span className="font-bold text-green-700">{fmtSoles(Number(cotizacion.precio_cliente || 0))}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Ruta</span><span className="font-medium truncate ml-4">{cotizacion.origen} → {cotizacion.destino}</span></div>
        </div>
        <div className="space-y-1">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400">Tipo de documento *</label>
          <select className={inputCls()} value={tipo} onChange={e => setTipo(e.target.value)}>
            {TIPOS_APROBACION.map(t => <option key={t}>{t}</option>)}
          </select>
        </div>
        <div className="space-y-1">
          <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400">Número de referencia *</label>
          <input className={inputCls("font-mono")} placeholder="Número o código" value={numero}
            onChange={e => { setNumero(e.target.value); setError(""); }} autoFocus
            onKeyDown={e => e.key === "Enter" && (numero.trim() ? onConfirmar(tipo, numero.trim()) : setError("Obligatorio"))} />
          {error && <p className="text-xs text-red-600">⚠ {error}</p>}
        </div>
        <div className="flex gap-3">
          <button onClick={() => numero.trim() ? onConfirmar(tipo, numero.trim()) : setError("Obligatorio")}
            className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white" style={{ background: "#166534" }}>✅ Confirmar</button>
          <button onClick={onCancelar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600">Cancelar</button>
        </div>
      </div>
    </div>
  );
}

// ─── PANEL SUGERENCIA TARIFARIO ───────────────────────────────────────────────

function PanelSugerencia({ tarifas, origen, destino, tipoVeh, tipoServ, equip, onAplicar }: {
  tarifas: Tarifa[]; origen: string; destino: string;
  tipoVeh: string; tipoServ: string; equip: string;
  onAplicar: (precioSinIgv: number, tarifa: Tarifa) => void;
}) {
  const exacta = tarifas.find(t =>
    norm(t.origen) === norm(origen) && norm(t.destino) === norm(destino) &&
    t.tipo_vehiculo === tipoVeh && t.equipamiento === equip && t.tipo_servicio === tipoServ
  );
  const mismaRutaOtrosVeh = tarifas.filter(t =>
    norm(t.origen) === norm(origen) && norm(t.destino) === norm(destino) &&
    t.tipo_servicio === tipoServ && t.equipamiento === equip && t.tipo_vehiculo !== tipoVeh
  ).slice(0, 3);

  if (!origen.trim() || !destino.trim()) return null;
  if (!exacta && mismaRutaOtrosVeh.length === 0) return null;

  return (
    <div className="rounded-2xl border-2 p-4 space-y-3" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
      <div className="flex items-center gap-2">
        <span className="text-lg">💡</span>
        <p className="text-sm font-bold text-green-800">Sugerencias del tarifario</p>
      </div>
      {exacta && !exacta.confidencial && (
        <div className="rounded-xl border-2 border-green-400 bg-white p-3 flex items-center justify-between gap-3">
          <div>
            <p className="text-[10px] font-bold uppercase text-green-600">✅ Coincidencia exacta</p>
            <p className="font-bold text-gray-800 text-sm">{exacta.origen} → {exacta.destino}</p>
            <p className="text-xs text-gray-500">{TIPOS_VEHICULO.find(v => v.id === exacta.tipo_vehiculo)?.label} · {exacta.equipamiento === "full_equipo" ? "⭐ Full Equipo" : "📦 Básico"}</p>
          </div>
          <div className="text-right">
            <p className="text-xs text-gray-400">Sin IGV</p>
            <p className="text-2xl font-black text-green-700 font-mono">{fmtSoles(exacta.precio)}</p>
            <button onClick={() => onAplicar(exacta.precio, exacta)}
              className="mt-1 px-4 py-1.5 rounded-xl text-xs font-black text-white" style={{ background: "#166534" }}>
              Aplicar ✓
            </button>
          </div>
        </div>
      )}
      {exacta?.confidencial && (
        <div className="rounded-xl border-2 border-purple-300 bg-purple-50 p-3">
          <p className="text-xs font-bold text-purple-700">🔒 Tarifa Full Day confidencial — consultar precio con gerencia</p>
        </div>
      )}
      {mismaRutaOtrosVeh.length > 0 && (
        <div className="grid grid-cols-3 gap-2">
          {mismaRutaOtrosVeh.map(t => {
            const veh = TIPOS_VEHICULO.find(v => v.id === t.tipo_vehiculo);
            return (
              <div key={t.id} className="rounded-xl border bg-white p-2.5 cursor-pointer hover:border-green-400 transition-all"
                onClick={() => !t.confidencial && onAplicar(t.precio, t)}>
                <p className="text-[10px] font-bold text-gray-500">{veh?.icon} {veh?.label}</p>
                {t.confidencial ? <p className="font-bold text-purple-700">🔒</p> : <p className="font-black text-gray-800 font-mono">{fmtSoles(t.precio)}</p>}
                {!t.confidencial && <p className="text-[9px] text-green-600 font-bold">clic para aplicar</p>}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ─── GENERADOR PDF ────────────────────────────────────────────────────────────

function generarPDFHtml(cot: Cotizacion, cliente: Cliente | undefined, items: ItemCot[], vehiculo?: VehiculoFlota, reprNombre = 'JENNY ELYZABETH URBINA AFATA', consideraciones: ConsideracionesCot = DEFAULT_CONSIDERACIONES) {
  const { subtotal, igv, total } = calcItems(items);
  const descuentoTotal = items.reduce((s, it) => s + it.dias * it.cantidad * it.precio_unit * (it.descuento_pct / 100), 0);
  const nombreCliente = cliente?.tipo === "b2b" ? (cliente.empresa || cliente.nombre) : cliente?.nombre || "—";
  const rucDni    = cliente?.ruc ? `RUC: ${cliente.ruc}` : cliente?.dni ? `DNI: ${cliente.dni}` : "—";
  const atencion  = cot.atencion || cliente?.operativo_nombre || cliente?.administrativo_nombre || "—";
  const numeroCot = cot.numero_cotizacion || String(cot.id).padStart(5, "0");
  const fechaDoc  = cot.created_at
    ? new Date(cot.created_at).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" })
    : new Date().toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" });
  const anio = new Date().getFullYear();

  const filasItems = items.map((it, i) => {
    const totalFila = it.dias * it.cantidad * it.precio_unit * (1 - it.descuento_pct / 100);
    return `<tr>
      <td style="text-align:center;padding:7px 6px;border:1px solid #ccc;">${i + 1}</td>
      <td style="padding:7px 6px;border:1px solid #ccc;">${it.descripcion}</td>
      <td style="text-align:center;padding:7px 6px;border:1px solid #ccc;">${it.dias}</td>
      <td style="text-align:center;padding:7px 6px;border:1px solid #ccc;">${it.cantidad}</td>
      <td style="text-align:right;padding:7px 6px;border:1px solid #ccc;">S/ ${it.precio_unit.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td>
      <td style="text-align:center;padding:7px 6px;border:1px solid #ccc;">${it.descuento_pct > 0 ? it.descuento_pct + "%" : ""}</td>
      <td style="text-align:right;padding:7px 6px;border:1px solid #ccc;font-weight:bold;">S/ ${totalFila.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td>
    </tr>`;
  }).join("");


  // ── ANEXO 1 — Características de la unidad ──────────────────────────────
  const esFull = (vehiculo?.equipamiento || cot.equipamiento || "full_equipo") === "full_equipo";

  const descripcionUnidad = vehiculo?.descripcion_unidad
    || (esFull
      ? `Bus con capacidad para ${vehiculo?.capacidad_pasajeros || "—"} pasajeros, con aire acondicionado, sistema de audio (radio y TV), asientos reclinables con reposapiés, cortinas, bodega para equipaje y GPS en tiempo real.`
      : `Bus con capacidad para ${vehiculo?.capacidad_pasajeros || "—"} pasajeros, con asientos estándar, bodega para equipaje y GPS en tiempo real.`);

  const subtituloEquip = esFull
    ? `⭐ Equipamiento: Full Equipo (AC · TV · reclinables · bodega · GPS)`
    : `📦 Equipamiento: Básico (estándar · bodega · GPS)`;

  const fotosHtml = vehiculo && (vehiculo.foto_externa_url || vehiculo.foto_interna_url) ? `
    <div style="margin-top:14px;">
      <p style="font-size:10px;font-weight:900;color:#0b315f;text-transform:uppercase;margin-bottom:10px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;">Fotografías de la unidad</p>
      <div style="display:grid;grid-template-columns:${vehiculo.foto_externa_url && vehiculo.foto_interna_url ? "1fr 1fr" : "1fr"};gap:12px;">
        ${vehiculo.foto_externa_url ? `
        <div>
          <p style="font-size:9px;font-weight:700;color:#6b7280;margin-bottom:6px;text-transform:uppercase;">Vista exterior</p>
          <div style="background:#f3f4f6;border-radius:8px;border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;overflow:hidden;height:190px;">
            <img src="${driveToImg(vehiculo.foto_externa_url)}" 
              style="max-width:100%;max-height:190px;object-fit:contain;display:block;"
              onerror="this.parentElement.innerHTML='<p style=\'color:#9ca3af;font-size:10px;text-align:center;padding:20px;\'>Imagen no disponible</p>'"/>
          </div>
          <p style="font-size:8px;color:#9ca3af;text-align:center;margin-top:4px;font-style:italic;">IMAGEN REFERENCIAL</p>
        </div>` : ""}
        ${vehiculo.foto_interna_url ? `
        <div>
          <p style="font-size:9px;font-weight:700;color:#6b7280;margin-bottom:6px;text-transform:uppercase;">Vista interior</p>
          <div style="background:#f3f4f6;border-radius:8px;border:1px solid #e5e7eb;display:flex;align-items:center;justify-content:center;overflow:hidden;height:190px;">
            <img src="${driveToImg(vehiculo.foto_interna_url)}" 
              style="max-width:100%;max-height:190px;object-fit:contain;display:block;"
              onerror="this.parentElement.innerHTML='<p style=\'color:#9ca3af;font-size:10px;text-align:center;padding:20px;\'>Imagen no disponible</p>'"/>
          </div>
          <p style="font-size:8px;color:#9ca3af;text-align:center;margin-top:4px;font-style:italic;">IMAGEN REFERENCIAL</p>
        </div>` : ""}
      </div>
    </div>` : "";

  // PDF: solo características + equipamiento + fotos (sin datos de placa/marca que pueden cambiar)
  const datosVehiculoHtml = `
    <div class="box" style="margin-bottom:12px;">
      <div class="box-title">Características de la unidad</div>
      <div class="box-row" style="line-height:1.6;color:#333;">${descripcionUnidad}</div>
    </div>
    ${fotosHtml}
  `;

  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Cotización N° ${numeroCot} - AFA TOURS PERU</title>
<style>
@page{size:A4;margin:18mm 15mm 15mm 15mm}
*{box-sizing:border-box}
body{font-family:"Helvetica Neue",Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0;line-height:1.4}
.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:3px solid #0b315f;padding-bottom:10px}
.logo{height:60px}
.titulo-cot{text-align:right}
.titulo-cot h1{font-size:19px;font-weight:900;color:#0b315f;margin:0;letter-spacing:-0.5px}
.titulo-cot p{margin:2px 0;font-size:11px;color:#444}
.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}
.box{border:1px solid #ccc;border-radius:4px;padding:8px 10px}
.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;letter-spacing:0.8px;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}
.box-row{margin:3px 0;font-size:10.5px}
table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10.5px}
thead{background:#0b315f;color:white;letter-spacing:0.3px}
thead th{padding:7px 6px;text-align:center;font-weight:700;font-size:10px;border:1px solid #0b315f}
tbody tr:nth-child(even){background:#f8fafc}
.totales td{padding:4px 10px;font-size:11px}
.totales .label{text-align:right;color:#555;font-weight:600}
.totales .valor{text-align:right;font-weight:700;min-width:100px}
.totales .total-neto{font-size:13px;font-weight:900;color:#0b315f}
.totales .sep{border-top:2px solid #0b315f}
.cuentas{margin-top:14px;border-top:2px solid #0b315f;padding-top:10px}
.cuentas h3{font-size:11px;font-weight:900;color:#0b315f;margin:0 0 8px;text-transform:uppercase}
.cuentas-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}
.cuenta-box{border:1px solid #ddd;border-radius:4px;padding:6px 8px}
.cuenta-box .banco{font-weight:900;font-size:10px;color:#0b315f;margin-bottom:4px}
.cuenta-box p{margin:2px 0;font-size:9.5px;color:#333}
.firma{margin-top:20px;display:flex;justify-content:flex-end}
.firma-box{text-align:center;border-top:1px solid #333;padding-top:6px;width:180px;font-size:10px;color:#555}
.page-break{page-break-before:always}
.anexo h3{font-size:10.5px;font-weight:900;margin:10px 0 5px;text-transform:uppercase;letter-spacing:0.5px}
.anexo p,.anexo li{font-size:10.5px;color:#333;line-height:1.6;margin:3px 0}
.anexo ul{padding-left:18px}
.footer-doc{margin-top:16px;border-top:2px solid #0b315f;padding-top:8px;text-align:center;font-size:9px;color:#0b315f;letter-spacing:0.3px}
@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}
</style></head><body>

<div class="header">
  <img src="/logoafa.png" alt="AFA TOURS PERU" class="logo"/>
  <div class="titulo-cot">
    <h1>COTIZACIÓN N° ${numeroCot} - ${anio}</h1>
    <p><b>FECHA:</b> ${fechaDoc}</p>
    <p style="font-style:italic;color:#666;font-size:10px;">Cotización válida por 30 días</p>
  </div>
</div>

<div class="grid2">
  <div class="box">
    <div class="box-title">Datos del cliente</div>
    <div class="box-row"><b>CLIENTE:</b> ${nombreCliente}</div>
    <div class="box-row"><b>${cliente?.ruc ? "RUC" : "DNI"}:</b> ${rucDni.replace(/^(RUC|DNI): /, "")}</div>
    <div class="box-row"><b>DIRECCIÓN:</b> ${cliente?.direccion || "—"}</div>
    <div class="box-row"><b>CELULAR:</b> ${cliente?.telefono || "—"}</div>
    <div class="box-row"><b>ATENCIÓN:</b> ${atencion}</div>
  </div>
  <div class="box">
    <div class="box-title">AFA Tours Peru S.A.C.</div>
    <div class="box-row"><b>RUC:</b> 20602117091</div>
    <div class="box-row"><b>DIRECCIÓN:</b> MZA. F LOTE. 2 ASC. TRABAJADORES UNIDOS CHACRASANA - LURIGANCHO</div>
    <div class="box-row"><b>REPR:</b> ${reprNombre}</div>
    <div class="box-row"><b>EMAIL:</b> transporte@afatoursperu.com</div>
    <div class="box-row"><b>TELF:</b> (01) 3453707 – 966 707 225</div>
  </div>
</div>

<div class="box" style="margin-bottom:10px;">
  <div class="box-title">Detalle del servicio</div>
  <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;">
    <div class="box-row"><b>PUNTO DE RECOJO:</b> ${cot.origen || "—"}</div>
    <div class="box-row"><b>PUNTO DE DESTINO:</b> ${cot.destino || "—"}</div>
    <div class="box-row"><b>PUNTO DE RETORNO:</b> ${cot.punto_retorno || cot.origen || "—"}</div>
  </div>
  ${cot.asunto ? `<div class="box-row" style="margin-top:4px;"><b>ASUNTO:</b> ${cot.asunto}</div>` : ""}
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:6px;margin-top:6px;">
    <div class="box-row"><b>FECHA DEL SERVICIO:</b> ${cot.fecha_servicio ? new Date(cot.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" }).toUpperCase() : "___________________________"}</div>
    <div class="box-row"><b>HORARIO:</b> Salida: <b>${cot.hora_ida || "______"}</b> &nbsp;|&nbsp; Retorno: <b>${cot.hora_retorno || "______"}</b></div>
  </div>
</div>

<table>
  <thead>
    <tr>
      <th style="width:40px;">ITEM</th>
      <th style="text-align:left;">DESCRIPCIÓN</th>
      <th style="width:45px;">DÍAS</th>
      <th style="width:55px;">CANTIDAD</th>
      <th style="width:110px;">P. UNIT SIN IGV</th>
      <th style="width:55px;">% DSCTO.</th>
      <th style="width:110px;">TOTAL VENTA (S/.)</th>
    </tr>
  </thead>
  <tbody>
    ${filasItems}
    <tr>
      <td colspan="4" style="border:1px solid #ccc;padding:7px 8px;font-size:9.5px;color:#555;font-style:italic;">
        <b>INCLUYE:</b> Traslado, conductor, combustible y peajes de ruta.
      </td>
      <td colspan="3" style="border:1px solid #ccc;padding:0;vertical-align:top;">
        <table class="totales">
          <tr><td class="label">SUBTOTAL</td><td class="valor">S/ ${subtotal.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr>
          ${descuentoTotal > 0 ? `<tr><td class="label">DESCUENTO</td><td class="valor" style="color:#dc2626;">- S/ ${descuentoTotal.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr>` : "<tr><td class='label'>DESCUENTO</td><td class='valor'>—</td></tr>"}
          <tr><td class="label">IGV (18%)</td><td class="valor">S/ ${igv.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr>
          <tr class="sep"><td class="label total-neto">TOTAL NETO</td><td class="valor total-neto">S/ ${total.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr>
        </table>
      </td>
    </tr>
  </tbody>
</table>

<div class="firma"><div class="firma-box">REVISADO POR</div></div>

<div class="cuentas">
  <h3>Nuestras cuentas bancarias</h3>
  <div class="cuentas-grid">
    <div class="cuenta-box"><div class="banco">BCP — Cuenta Soles</div><p>Cta. Corriente: 191-2644342-0-24</p><p>CCI: 00219100264434202450</p></div>
    <div class="cuenta-box"><div class="banco">BCP — Cuenta Dólares</div><p>Cta.: 191-7394169-1-83</p><p>CCI: 00219100739416918351</p></div>
    <div class="cuenta-box"><div class="banco">Banco de la Nación (Detracción 10%)</div><p>Cta.: 00-091-069571</p><p>CCI: 01809100009106957197</p></div>
  </div>
</div>

<div class="footer-doc"><span style="color:#1d4ed8">📍</span> Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana - Lima &nbsp;&nbsp;|&nbsp;&nbsp; <span style="color:#1d4ed8">📞</span> (01) 3453707 &nbsp;·&nbsp; <span style="color:#1d4ed8">📱</span> 966 707 225 &nbsp;&nbsp;|&nbsp;&nbsp; <span style="color:#1d4ed8">✉️</span> transporte@afatoursperu.com</div>

<div class="page-break"></div>

<div class="header">
  <img src="/logoafa.png" alt="AFA TOURS PERU" class="logo"/>
  <div class="titulo-cot">
    <h1>COTIZACIÓN N° ${numeroCot} - ${anio}</h1>
    <p style="font-size:12px;font-weight:700;color:#6b7280;">Descripción de la unidad y condiciones del servicio</p>
  </div>
</div>

${datosVehiculoHtml}

<div class="anexo">
  <div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-bottom:12px;">
    <div>
      <h3 style="color:#166534;border-bottom:2px solid #16a34a;padding-bottom:4px;">✅ Servicio incluye</h3>
      <ul>${consideraciones.incluye.map((item: string) => `<li>${item}</li>`).join("")}</ul>
    </div>
    <div>
      <h3 style="color:#991b1b;border-bottom:2px solid #dc2626;padding-bottom:4px;">❌ Servicio no incluye</h3>
      <ul>${consideraciones.no_incluye.map((item: string) => `<li>${item}</li>`).join("")}</ul>
    </div>
  </div>
  <h3 style="color:#0b315f;border-bottom:2px solid #0b315f;padding-bottom:4px;">📋 Consideraciones generales</h3>
  <ul>${consideraciones.generales.map((item: string) => `<li>${item}</li>`).join("")}</ul>
  <p style="margin-top:10px;">Enviar orden o comprobante a <b>transporte@afatoursperu.com</b> o WhatsApp <b>966 707 225</b>.</p>
</div>

<div class="footer-doc" style="margin-top:30px;"><span style="color:#1d4ed8">📍</span> Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana - Lima &nbsp;&nbsp;|&nbsp;&nbsp; <span style="color:#1d4ed8">📞</span> (01) 3453707 &nbsp;·&nbsp; <span style="color:#1d4ed8">📱</span> 966 707 225 &nbsp;&nbsp;|&nbsp;&nbsp; <span style="color:#1d4ed8">✉️</span> transporte@afatoursperu.com</div>
<script>window.onload=()=>window.print();</script>
</body></html>`;
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function CotizacionesPage() {
  const [clientes,       setClientes]       = useState<Cliente[]>([]);
  const [cotizaciones,   setCotizaciones]   = useState<Cotizacion[]>([]);
  const [tarifas,        setTarifas]        = useState<Tarifa[]>([]);
  const [vehiculosFlota, setVehiculosFlota] = useState<VehiculoFlota[]>([]);
  const [loading,        setLoading]        = useState(false);
  const [guardando,      setGuardando]      = useState(false);
  const [mostrarForm,    setMostrarForm]    = useState(false);
  const [editandoId,     setEditandoId]     = useState<number | null>(null);
  const [busqueda,       setBusqueda]       = useState("");
  const [filtroEst,      setFiltroEst]      = useState("todos");
  const [form,           setForm]           = useState(FORM_VACIO);
  const [items,          setItems]          = useState<ItemCot[]>([{ ...ITEM_VACIO }]);
  const [modalAprobacion,setModalAprobacion]= useState<Cotizacion | null>(null);
  const [guardarEnTarifario, setGuardarEnTarifario] = useState(true);
  const [reprNombre, setReprNombre] = useState("JENNY ELYZABETH URBINA AFATA");
  const [consideraciones, setConsideraciones] = useState<ConsideracionesCot>(DEFAULT_CONSIDERACIONES);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  useEffect(() => {
    supabase.auth.getUser().then(({ data }) => {
      if (data?.user) {
        const meta = data.user.user_metadata;
        const nombre = meta?.full_name || meta?.name || data.user.email || "JENNY ELYZABETH URBINA AFATA";
        setReprNombre(nombre.toUpperCase());
      }
    });
  }, []);

  const cargarDatos = async () => {
    setLoading(true);
    const [clRes, cotRes, tRes, vRes] = await Promise.all([
      supabase.from("clientes").select("*").order("nombre").limit(1000),
      supabase.from("cotizaciones").select("*").order("id", { ascending: false }),
      supabase.from("tarifario").select("*").eq("activo", true),
      supabase.from("vehiculos").select("id,placa,categoria,marca,modelo,anio,capacidad_pasajeros,equipamiento,foto_externa_url,foto_interna_url,descripcion_unidad").order("placa"),
    ]);
    setClientes(clRes.data       || []);
    setCotizaciones(cotRes.data  || []);
    setTarifas(tRes.data         || []);
    setVehiculosFlota(vRes.data  || []);
    setLoading(false);
  };
  useEffect(() => { cargarDatos(); }, []);

  const actualizarItem = (i: number, k: keyof ItemCot, v: string | number) =>
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, [k]: Number.isNaN(Number(v)) ? v : Number(v) } : it));
  const agregarItem  = () => setItems(p => [...p, { ...ITEM_VACIO }]);
  const eliminarItem = (i: number) => setItems(p => p.filter((_, idx) => idx !== i));
  const { subtotal, igv, total } = calcItems(items);

  const limpiar = () => { setForm(FORM_VACIO); setItems([{ ...ITEM_VACIO }]); setConsideraciones(DEFAULT_CONSIDERACIONES); setEditandoId(null); setMostrarForm(false); };

  // Al seleccionar vehículo de flota → auto-rellena equipamiento y tipo
  const seleccionarVehiculoFlota = (id: string) => {
    setForm(p => ({ ...p, vehiculo_flota_id: id }));
    if (!id) return;
    const veh = vehiculosFlota.find(v => v.id === Number(id));
    if (!veh) return;
    setForm(p => ({ ...p, vehiculo_flota_id: id, equipamiento: veh.equipamiento || "full_equipo" }));
    // Auto-fill descripción en primer item si está vacío
    if (items[0] && !items[0].descripcion && veh.placa) {
      setItems(prev => {
        const nuevos = [...prev];
        nuevos[0] = { ...nuevos[0], descripcion: `Servicio de transporte — ${veh.placa} ${veh.categoria || ""} ${veh.marca || ""} (${veh.capacidad_pasajeros || "—"} pax)` };
        return nuevos;
      });
    }
  };

  const aplicarPrecioTarifario = (precioSinIgv: number, tarifa: Tarifa) => {
    const veh = TIPOS_VEHICULO.find(v => v.id === tarifa.tipo_vehiculo);
    setItems(prev => {
      const nuevos = [...prev];
      nuevos[0] = { ...nuevos[0], precio_unit: precioSinIgv, descripcion: nuevos[0].descripcion || `${veh?.icon} ${veh?.label} — ${tarifa.origen} → ${tarifa.destino}` };
      return nuevos;
    });
    setForm(p => ({ ...p, tipo_vehiculo: tarifa.tipo_vehiculo, tipo_servicio: tarifa.tipo_servicio as Servicio, equipamiento: tarifa.equipamiento }));
  };

  const guardarCotizacion = async () => {
    if (!form.cliente_id || !form.origen || !form.destino) { alert("Selecciona cliente, origen y destino"); return; }
    const cliente = clientes.find(c => c.id === Number(form.cliente_id));
    if (cliente?.estado === "bloqueado") { alert("Cliente bloqueado."); return; }
    if (items.some(it => !it.descripcion.trim())) { alert("Todos los items necesitan descripción"); return; }
    setGuardando(true);
    const payload = {
      cliente_id: Number(form.cliente_id), origen: form.origen.trim(), destino: form.destino.trim(),
      km: Number(form.km || 0), precio_cliente: total,
      costo_estimado: Number(form.costo_estimado || 0),
      margen_estimado: total - Number(form.costo_estimado || 0),
      estado: form.estado, numero_cotizacion: form.numero_cotizacion.trim() || null,
      atencion: form.atencion.trim() || null, asunto: form.asunto.trim() || null,
      punto_retorno: form.punto_retorno.trim() || null,
      fecha_servicio: form.fecha_servicio || null, hora_ida: form.hora_ida || null,
      hora_retorno: form.hora_retorno || null, descuento_pct: Number(form.descuento_pct || 0),
      items_json: items,
      tipo_vehiculo: form.tipo_vehiculo || null, tipo_servicio: form.tipo_servicio || null,
      equipamiento: form.equipamiento || null,
      vehiculo_flota_id: form.vehiculo_flota_id ? Number(form.vehiculo_flota_id) : null,
      consideraciones_json: consideraciones,
    };
    const { error } = editandoId
      ? await supabase.from("cotizaciones").update(payload).eq("id", editandoId)
      : await supabase.from("cotizaciones").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }
    if (guardarEnTarifario && form.tipo_vehiculo && form.tipo_servicio && form.equipamiento && subtotal > 0) {
      await supabase.from("tarifario").upsert({
        origen: form.origen.trim().toUpperCase(), destino: form.destino.trim().toUpperCase(),
        tipo_vehiculo: form.tipo_vehiculo, equipamiento: form.equipamiento,
        tipo_servicio: form.tipo_servicio, precio: subtotal, moneda: "PEN",
        confidencial: form.tipo_servicio === "full_day",
        incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false,
        notas: `Cotización ${form.numero_cotizacion || ""}`.trim(), activo: true,
      }, { onConflict: "origen,destino,tipo_vehiculo,equipamiento,tipo_servicio" });
    }
    limpiar(); cargarDatos(); setGuardando(false);
  };

  const cambiarEstado = async (cot: Cotizacion, nuevoEstado: EstadoCot) => {
    if (nuevoEstado === "aprobado" && cot.estado !== "aprobado") { setModalAprobacion(cot); return; }
    await supabase.from("cotizaciones").update({ estado: nuevoEstado }).eq("id", cot.id);
    cargarDatos();
  };

  const confirmarAprobacion = async (tipo: string, numero: string) => {
    if (!modalAprobacion) return;
    await supabase.from("cotizaciones").update({ estado: "aprobado", tipo_aprobacion: tipo, numero_aprobacion: numero }).eq("id", modalAprobacion.id);
    if (modalAprobacion.tipo_vehiculo && modalAprobacion.tipo_servicio && modalAprobacion.equipamiento) {
      await supabase.from("tarifario").upsert({
        origen: modalAprobacion.origen.toUpperCase(), destino: modalAprobacion.destino.toUpperCase(),
        tipo_vehiculo: modalAprobacion.tipo_vehiculo, equipamiento: modalAprobacion.equipamiento,
        tipo_servicio: modalAprobacion.tipo_servicio,
        precio: Math.round(Number(modalAprobacion.precio_cliente) / 1.18 * 100) / 100,
        moneda: "PEN", confidencial: modalAprobacion.tipo_servicio === "full_day",
        incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false,
        notas: `Cotización aprobada #${modalAprobacion.numero_cotizacion || modalAprobacion.id}`, activo: true,
      }, { onConflict: "origen,destino,tipo_vehiculo,equipamiento,tipo_servicio" });
    }
    setModalAprobacion(null); cargarDatos();
  };

  const convertirAReserva = async (cot: Cotizacion) => {
    if (cot.estado !== "aprobado") { alert("Solo cotizaciones aprobadas pueden convertirse en reserva"); return; }
    const { data: existe } = await supabase.from("reservas").select("id").eq("cotizacion_id", cot.id).maybeSingle();
    if (existe) { alert("Esta cotización ya fue convertida en reserva"); return; }
    const { error } = await supabase.from("reservas").insert({
      cliente_id: cot.cliente_id, cotizacion_id: cot.id,
      origen: cot.origen, destino: cot.destino,
      precio_cliente: cot.precio_cliente, costo_proveedor: 0,
      fecha_servicio: cot.fecha_servicio || new Date().toISOString().split("T")[0],
      hora_servicio: cot.hora_ida || new Date().toTimeString().slice(0, 5),
      estado: "pendiente", tipo: "propia",
    });
    if (error) { alert(error.message); return; }
    alert("✅ Cotización convertida en reserva"); cargarDatos();
  };

  const editarCotizacion = (c: Cotizacion) => {
    setForm({
      cliente_id: String(c.cliente_id || ""), origen: c.origen || "", destino: c.destino || "",
      km: c.km ? String(c.km) : "", costo_estimado: c.costo_estimado ? String(c.costo_estimado) : "",
      estado: c.estado || "pendiente", numero_cotizacion: c.numero_cotizacion || "",
      atencion: c.atencion || "", asunto: c.asunto || "", punto_retorno: c.punto_retorno || "",
      fecha_servicio: c.fecha_servicio || "", hora_ida: c.hora_ida || "", hora_retorno: c.hora_retorno || "",
      descuento_pct: c.descuento_pct ? String(c.descuento_pct) : "0",
      tipo_vehiculo: c.tipo_vehiculo || "BUS_49",
      tipo_servicio: (c.tipo_servicio || "solo_ida") as Servicio,
      equipamiento: c.equipamiento || "full_equipo",
      vehiculo_flota_id: c.vehiculo_flota_id ? String(c.vehiculo_flota_id) : "",
    });
    if (c.items_json && c.items_json.length > 0) setItems(c.items_json);
    else { const p = Number(c.precio_cliente || 0) / 1.18; setItems([{ descripcion: c.asunto || `${c.origen} → ${c.destino}`, dias: 1, cantidad: 1, precio_unit: Math.round(p * 100) / 100, descuento_pct: 0 }]); }
    setConsideraciones(c.consideraciones_json || DEFAULT_CONSIDERACIONES);
    setEditandoId(c.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const generarPDF = (cot: Cotizacion) => {
    const cliente  = clientes.find(c => c.id === cot.cliente_id);
    const vehiculo = vehiculosFlota.find(v => v.id === cot.vehiculo_flota_id);
    const its = (cot.items_json && cot.items_json.length > 0)
      ? cot.items_json
      : [{ descripcion: `${cot.asunto || "SERVICIO DE TRANSPORTE"} — ${cot.origen} → ${cot.destino}`, dias: 1, cantidad: 1, precio_unit: cot.precio_cliente / 1.18, descuento_pct: 0 }];
    const win = window.open("", "_blank");
    if (win) { win.document.write(generarPDFHtml(cot, cliente, its, vehiculo, reprNombre, cot.consideraciones_json || consideraciones)); win.document.close(); }
  };

  // KPIs
  const total_cots     = cotizaciones.length;
  const pendientes     = cotizaciones.filter(c => c.estado === "pendiente").length;
  const enviados       = cotizaciones.filter(c => c.estado === "enviado").length;
  const aprobadas      = cotizaciones.filter(c => c.estado === "aprobado").length;
  const valorTotal     = cotizaciones.reduce((s, c) => s + Number(c.precio_cliente || 0), 0);
  const tasaAprobacion = total_cots > 0 ? Math.round((aprobadas / total_cots) * 100) : 0;
  const nombreCliente  = (id: number | null) => {
    const c = clientes.find(cl => cl.id === id);
    return c ? (c.nombre + (c.empresa && c.empresa !== c.nombre ? ` (${c.empresa})` : "")) : "Sin cliente";
  };

  const filtradas = cotizaciones.filter(c => {
    const ncl = clientes.find(cl => cl.id === c.cliente_id);
    const ncn = ncl?.nombre || "";
    const q = busqueda.toLowerCase();
    return (ncn.toLowerCase().includes(q) || c.origen.toLowerCase().includes(q) ||
      c.destino.toLowerCase().includes(q) || (c.numero_cotizacion || "").includes(q)) &&
      (filtroEst === "todos" || c.estado === filtroEst);
  });

  const vehFloraSel = vehiculosFlota.find(v => v.id === Number(form.vehiculo_flota_id));

  // ─── RENDER ───────────────────────────────────────────────────────────────

  return (
    <>
      {modalAprobacion && (
        <ModalAprobacion cotizacion={modalAprobacion} onConfirmar={confirmarAprobacion} onCancelar={() => setModalAprobacion(null)} />
      )}
      <main className="p-6 space-y-5 max-w-7xl mx-auto">

        {/* ENCABEZADO */}
        <div className="flex items-start justify-between flex-wrap gap-3">
          <div>
            <h1 className="text-3xl font-bold text-gray-900">Cotizaciones</h1>
            <p className="text-gray-400 text-sm mt-1">Gestión comercial · tarifario automático · PDF con características de la unidad</p>
          </div>
          <button onClick={() => { limpiar(); setMostrarForm(v => !v); }}
            className="px-5 py-2.5 rounded-xl font-bold text-sm text-white hover:opacity-90"
            style={{ background: mostrarForm ? "#6b7280" : "#0b315f" }}>
            {mostrarForm ? "✕ Cancelar" : "+ Nueva cotización"}
          </button>
        </div>

        {/* FLUJO */}
        <div className="bg-white rounded-2xl border shadow-sm px-5 py-4">
          <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 mb-3">Flujo de estados</p>
          <div className="flex items-center gap-1 flex-wrap">
            {(Object.entries(FLUJO_COT) as [EstadoCot, string][]).map(([est, desc], i, arr) => {
              const cfg = ESTADO_CFG[est]; const count = cotizaciones.filter(c => c.estado === est).length;
              return (
                <React.Fragment key={est}>
                  <div className="flex flex-col items-center">
                    <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold" style={{ background: cfg.bg, color: cfg.color }}>
                      {cfg.label}{count > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black text-white" style={{ background: cfg.color }}>{count}</span>}
                    </div>
                    <p className="text-[9px] text-gray-400 mt-1 text-center max-w-[90px]">{desc}</p>
                  </div>
                  {i < arr.length - 1 && <span className="text-gray-300 text-lg mb-4">→</span>}
                </React.Fragment>
              );
            })}
          </div>
        </div>

        {/* KPIs */}
        <section className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
          {[
            { label: "Total",       valor: total_cots,          color: "#0b315f", bg: "#eef3f8" },
            { label: "Pendientes",  valor: pendientes,           color: "#854d0e", bg: "#fef9c3" },
            { label: "Enviadas",    valor: enviados,             color: "#0369a1", bg: "#e0f2fe" },
            { label: "Aprobadas",   valor: aprobadas,            color: "#166534", bg: "#dcfce7" },
            { label: "Tasa aprob.", valor: `${tasaAprobacion}%`, color: "#1d4ed8", bg: "#dbeafe" },
            { label: "Valor total", valor: fmtSoles(valorTotal), color: "#166534", bg: "#dcfce7" },
          ].map(k => (
            <div key={k.label} className="rounded-xl p-3 border" style={{ background: k.bg, borderColor: k.color + "22" }}>
              <p className="text-[10px] font-bold uppercase tracking-wide" style={{ color: k.color + "99" }}>{k.label}</p>
              <p className="text-xl font-black mt-0.5" style={{ color: k.color }}>{k.valor}</p>
            </div>
          ))}
        </section>

        {/* FORMULARIO */}
        {mostrarForm && (
          <section className="bg-white rounded-2xl border shadow-sm p-6 space-y-5">
            <div className="flex items-center gap-3">
              <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white text-lg" style={{ background: "#0b315f" }}>
                {editandoId ? "✏️" : "📄"}
              </div>
              <div>
                <h2 className="text-lg font-bold">{editandoId ? "Editar cotización" : "Nueva cotización"}</h2>
                <p className="text-xs text-gray-400">El PDF jala automáticamente las características y fotos del vehículo elegido</p>
              </div>
            </div>

            {/* Identificación */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Cliente" req>
                  <div className="flex gap-2">
                    <select className={inputCls()} value={form.cliente_id} onChange={f("cliente_id")}>
                      <option value="">— Seleccionar cliente ({clientes.length}) —</option>
                      {clientes.filter(c => c.estado !== "bloqueado")
                        .sort((a, b) => (a.nombre).localeCompare(b.nombre))
                        .map(c => (
                          <option key={c.id} value={c.id}>
                            {c.nombre}{c.empresa && c.empresa !== c.nombre ? ` (${c.empresa})` : ""}{c.ruc ? ` · RUC ${c.ruc}` : c.dni ? ` · DNI ${c.dni}` : ""}
                          </option>
                        ))}
                    </select>
                    <a href="/clientes" target="_blank" rel="noreferrer"
                      className="flex-shrink-0 w-10 h-10 rounded-xl border-2 flex items-center justify-center font-black text-lg"
                      style={{ background: "#eef3f8", borderColor: "#0b315f33", color: "#0b315f" }}>+</a>
                  </div>
                </Campo>
                <Campo label="N° cotización">
                  <input className={inputCls("font-mono")} placeholder="Ej: 10996" value={form.numero_cotizacion} onChange={f("numero_cotizacion")} />
                </Campo>
                <Campo label="Estado">
                  <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                    <option value="pendiente">Pendiente</option><option value="enviado">Enviado</option><option value="rechazado">Rechazado</option>
                  </select>
                </Campo>
                <Campo label="Atención" span={2}>
                  <input className={inputCls()} placeholder="Nombre del responsable del cliente" value={form.atencion} onChange={f("atencion")} />
                </Campo>
                <Campo label="Asunto">
                  <input className={inputCls()} placeholder="Ej: Servicio turístico" value={form.asunto} onChange={f("asunto")} />
                </Campo>
              </div>
            </div>

            {/* UNIDAD DE FLOTA — selector clave */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
                Unidad de flota
                <span className="ml-2 normal-case font-normal text-blue-500">→ jala características y fotos para el PDF</span>
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                <Campo label="Vehículo específico de la flota (opcional)"
                  hint="Al seleccionar, el PDF incluirá las características y fotos registradas en Flota">
                  <select className={inputCls()} value={form.vehiculo_flota_id} onChange={e => seleccionarVehiculoFlota(e.target.value)}>
                    <option value="">Sin vehículo específico (descripción genérica en PDF)</option>
                    {vehiculosFlota.map(v => (
                      <option key={v.id} value={v.id}>
                        {v.placa} — {v.categoria} {v.marca} {v.modelo} {v.capacidad_pasajeros ? `(${v.capacidad_pasajeros} pax)` : ""} · {v.equipamiento === "full_equipo" ? "⭐ Full" : "📦 Básico"}
                        {v.foto_externa_url ? " · 📸" : ""}
                      </option>
                    ))}
                  </select>
                </Campo>

                {/* Preview del vehículo seleccionado */}
                {vehFloraSel && (
                  <div className="rounded-xl border-2 p-3 space-y-1.5" style={{ background: "#eef3f8", borderColor: "#0b315f33" }}>
                    <p className="text-[10px] font-bold uppercase text-[#0b315f]">✅ Vehículo seleccionado</p>
                    <p className="font-black text-[#0b315f] font-mono">{vehFloraSel.placa}</p>
                    <p className="text-xs text-gray-600">{vehFloraSel.marca} {vehFloraSel.modelo} {vehFloraSel.anio ? `· ${vehFloraSel.anio}` : ""}</p>
                    <p className="text-xs font-bold" style={{ color: vehFloraSel.equipamiento === "full_equipo" ? "#0b315f" : "#4b5563" }}>
                      {vehFloraSel.equipamiento === "full_equipo" ? "⭐ Full Equipo" : "📦 Básico"}
                    </p>
                    {vehFloraSel.descripcion_unidad && <p className="text-[10px] text-gray-500 italic line-clamp-2">"{vehFloraSel.descripcion_unidad}"</p>}
                    <div className="flex gap-2 text-[10px]">
                      {vehFloraSel.foto_externa_url && <span className="text-green-600 font-bold">📸 Foto exterior ✓</span>}
                      {vehFloraSel.foto_interna_url && <span className="text-green-600 font-bold">📸 Foto interior ✓</span>}
                      {!vehFloraSel.foto_externa_url && !vehFloraSel.foto_interna_url && <span className="text-gray-400">Sin fotos registradas</span>}
                    </div>
                  </div>
                )}
              </div>
            </div>

            {/* Tipo de servicio + equipamiento + vehículo */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Tipo de servicio y categoría</p>
              <div className="space-y-3">
                <div className="grid grid-cols-2 md:grid-cols-4 gap-2">
                  {(Object.entries(TIPOS_SERVICIO) as [Servicio, typeof TIPOS_SERVICIO[Servicio]][]).map(([k, v]) => {
                    const act = form.tipo_servicio === k;
                    return (
                      <button key={k} onClick={() => setForm(p => ({ ...p, tipo_servicio: k }))}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all"
                        style={{ background: act ? v.bg : "white", borderColor: act ? v.color : "#e5e7eb", color: act ? v.color : "#9ca3af" }}>
                        <span>{v.icon}</span><span className="font-bold text-xs">{v.label}</span>
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { val: "full_equipo", label: "⭐ Full Equipo", sub: "AC, TV, reclinables, premium", color: "#0b315f", bg: "#eef3f8" },
                    { val: "basico",      label: "📦 Básico",      sub: "Servicio estándar",            color: "#4b5563", bg: "#f3f4f6" },
                  ].map(e => {
                    const act = form.equipamiento === e.val;
                    return (
                      <button key={e.val} onClick={() => setForm(p => ({ ...p, equipamiento: e.val }))}
                        className="flex items-center gap-2 px-3 py-2 rounded-xl border-2 transition-all text-left"
                        style={{ background: act ? e.bg : "white", borderColor: act ? e.color : "#e5e7eb", color: act ? e.color : "#9ca3af" }}>
                        <div><p className="font-bold text-xs">{e.label}</p><p className="text-[10px] opacity-70">{e.sub}</p></div>
                      </button>
                    );
                  })}
                </div>
                <div className="grid grid-cols-4 md:grid-cols-9 gap-1.5">
                  {TIPOS_VEHICULO.map(t => {
                    const act = form.tipo_vehiculo === t.id;
                    return (
                      <button key={t.id} onClick={() => setForm(p => ({ ...p, tipo_vehiculo: t.id }))}
                        className="flex flex-col items-center gap-0.5 px-1 py-2 rounded-xl border-2 transition-all"
                        style={{ background: act ? "#eef3f8" : "white", borderColor: act ? "#0b315f" : "#e5e7eb", color: act ? "#0b315f" : "#9ca3af" }}>
                        <span className="text-base">{t.icon}</span>
                        <span className="text-[8px] font-bold leading-tight text-center">{t.label}</span>
                      </button>
                    );
                  })}
                </div>
              </div>
            </div>

            {/* Ruta */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Ruta del servicio</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Punto de recojo" req><input className={inputCls()} placeholder="Av. República de Panamá 3623" value={form.origen} onChange={f("origen")} /></Campo>
                <Campo label="Punto de destino" req><input className={inputCls()} placeholder="Kusina Pachacamac" value={form.destino} onChange={f("destino")} /></Campo>
                <Campo label="Punto de retorno"><input className={inputCls()} placeholder="Igual al origen si aplica" value={form.punto_retorno} onChange={f("punto_retorno")} /></Campo>
                <Campo label="Fecha de servicio"><input type="date" className={inputCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} /></Campo>
                <Campo label="Hora de ida"><input type="time" className={inputCls()} value={form.hora_ida} onChange={f("hora_ida")} /></Campo>
                <Campo label="Hora de retorno"><input type="time" className={inputCls()} value={form.hora_retorno} onChange={f("hora_retorno")} /></Campo>
                <Campo label="Km estimados"><input type="number" className={inputCls()} value={form.km} onChange={f("km")} /></Campo>
                <Campo label="Costo interno S/"><input type="number" className={inputCls()} value={form.costo_estimado} onChange={f("costo_estimado")} /></Campo>
              </div>
            </div>

            {/* Sugerencia tarifario */}
            <PanelSugerencia
              tarifas={tarifas} origen={form.origen} destino={form.destino}
              tipoVeh={form.tipo_vehiculo} tipoServ={form.tipo_servicio} equip={form.equipamiento}
              onAplicar={aplicarPrecioTarifario}
            />

            {/* Items */}
            <div>
              <div className="flex items-center justify-between border-b pb-1 mb-3">
                <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400">Items del servicio</p>
                <button onClick={agregarItem} className="text-xs font-bold text-[#0b315f] hover:underline">+ Agregar item</button>
              </div>
              <div className="space-y-2">
                <div className="hidden md:grid grid-cols-12 gap-2 text-[10px] font-bold uppercase tracking-wide text-gray-400 px-2">
                  <div className="col-span-4">Descripción</div>
                  <div className="col-span-1 text-center">Días</div>
                  <div className="col-span-1 text-center">Cant.</div>
                  <div className="col-span-2 text-right">P. Unit S/ (sin IGV)</div>
                  <div className="col-span-1 text-center">% Dscto</div>
                  <div className="col-span-2 text-right">Total S/</div>
                  <div className="col-span-1"></div>
                </div>
                {items.map((it, i) => {
                  const totalFila = it.dias * it.cantidad * it.precio_unit * (1 - it.descuento_pct / 100);
                  return (
                    <div key={i} className="grid grid-cols-12 gap-2 items-center bg-gray-50 rounded-xl p-2">
                      <div className="col-span-12 md:col-span-4">
                        <input className={inputCls()} placeholder="Ej: Transporte en Bus 50 PAX"
                          value={it.descripcion} onChange={e => actualizarItem(i, "descripcion", e.target.value)} />
                      </div>
                      <div className="col-span-4 md:col-span-1"><input type="number" min="1" className={inputCls("text-center")} value={it.dias} onChange={e => actualizarItem(i, "dias", e.target.value)} /></div>
                      <div className="col-span-4 md:col-span-1"><input type="number" min="1" className={inputCls("text-center")} value={it.cantidad} onChange={e => actualizarItem(i, "cantidad", e.target.value)} /></div>
                      <div className="col-span-4 md:col-span-2"><input type="number" min="0" className={inputCls("text-right")} placeholder="0.00" value={it.precio_unit || ""} onChange={e => actualizarItem(i, "precio_unit", e.target.value)} /></div>
                      <div className="col-span-4 md:col-span-1"><input type="number" min="0" max="100" className={inputCls("text-center")} placeholder="0" value={it.descuento_pct || ""} onChange={e => actualizarItem(i, "descuento_pct", e.target.value)} /></div>
                      <div className="col-span-6 md:col-span-2 text-right font-bold text-sm text-gray-800 pr-2">{fmtSoles(totalFila)}</div>
                      <div className="col-span-2 md:col-span-1 flex justify-end">
                        {items.length > 1 && <button onClick={() => eliminarItem(i)} className="w-7 h-7 rounded-lg text-red-400 hover:bg-red-50 font-bold text-sm flex items-center justify-center">✕</button>}
                      </div>
                    </div>
                  );
                })}
              </div>
              <div className="flex justify-end mt-4">
                <div className="w-72 space-y-1.5 bg-gray-50 rounded-xl p-4">
                  <div className="flex justify-between text-sm"><span className="text-gray-500">Subtotal (sin IGV)</span><span className="font-bold">{fmtSoles(subtotal)}</span></div>
                  <div className="flex justify-between text-sm"><span className="text-gray-500">IGV 18%</span><span className="font-bold">{fmtSoles(igv)}</span></div>
                  <div className="flex justify-between text-base border-t pt-2" style={{ borderColor: "#0b315f" }}>
                    <span className="font-black">Total neto</span>
                    <span className="font-black" style={{ color: "#0b315f" }}>{fmtSoles(total)}</span>
                  </div>
                  <div className="flex justify-between text-xs">
                    <span className="text-gray-400">Margen estimado</span>
                    <span className="font-bold text-green-600">{fmtSoles(total - Number(form.costo_estimado || 0))}</span>
                  </div>
                </div>
              </div>
            </div>


            {/* ── EDITOR DE CONSIDERACIONES ── */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">
                Consideraciones del servicio
                <span className="ml-2 normal-case font-normal text-blue-500">→ aparecen en el PDF</span>
              </p>
              <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                {([
                  { key: "incluye"    as const, label: "✅ Servicio incluye",    color: "#166534", bg: "#f0fdf4", border: "#86efac" },
                  { key: "no_incluye" as const, label: "❌ Servicio no incluye", color: "#991b1b", bg: "#fff5f5", border: "#fca5a5" },
                ]).map(({ key, label, color, bg, border }) => (
                  <div key={key} className="rounded-xl border-2 p-3 space-y-2" style={{ background: bg, borderColor: border }}>
                    <p className="text-xs font-black" style={{ color }}>{label}</p>
                    <div className="space-y-1.5">
                      {consideraciones[key].map((item, i) => (
                        <div key={i} className="flex gap-2 items-center">
                          <input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white"
                            value={item}
                            onChange={e => setConsideraciones(prev => ({ ...prev, [key]: prev[key].map((it, idx) => idx === i ? e.target.value : it) }))} />
                          <button onClick={() => setConsideraciones(prev => ({ ...prev, [key]: prev[key].filter((_, idx) => idx !== i) }))}
                            className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button>
                        </div>
                      ))}
                    </div>
                    <button onClick={() => setConsideraciones(prev => ({ ...prev, [key]: [...prev[key], ""] }))}
                      className="text-[10px] font-bold hover:underline" style={{ color }}>+ Agregar ítem</button>
                  </div>
                ))}
              </div>
              <div className="rounded-xl border-2 p-3 space-y-2 mt-3" style={{ background: "#eef3f8", borderColor: "#93c5fd" }}>
                <p className="text-xs font-black text-[#0b315f]">📋 Consideraciones generales</p>
                <div className="space-y-1.5">
                  {consideraciones.generales.map((item, i) => (
                    <div key={i} className="flex gap-2 items-center">
                      <input className="flex-1 rounded-lg border border-gray-200 px-2.5 py-1.5 text-xs focus:outline-none bg-white"
                        value={item}
                        onChange={e => setConsideraciones(prev => ({ ...prev, generales: prev.generales.map((it, idx) => idx === i ? e.target.value : it) }))} />
                      <button onClick={() => setConsideraciones(prev => ({ ...prev, generales: prev.generales.filter((_, idx) => idx !== i) }))}
                        className="text-gray-300 hover:text-red-500 font-bold text-sm flex-shrink-0">✕</button>
                    </div>
                  ))}
                </div>
                <div className="flex items-center gap-4">
                  <button onClick={() => setConsideraciones(prev => ({ ...prev, generales: [...prev.generales, ""] }))}
                    className="text-[10px] font-bold text-[#0b315f] hover:underline">+ Agregar ítem</button>
                  <button onClick={() => setConsideraciones(prev => ({ ...prev, generales: [...DEFAULT_CONSIDERACIONES.generales] }))}
                    className="text-[10px] text-gray-400 hover:underline">↺ Restaurar por defecto</button>
                </div>
              </div>
            </div>

            {/* Guardar en tarifario */}
            {form.tipo_vehiculo && form.tipo_servicio && form.origen && form.destino && (
              <div className="rounded-xl border px-4 py-3 flex items-start gap-3" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
                <input type="checkbox" id="chk_tarifario" checked={guardarEnTarifario}
                  onChange={e => setGuardarEnTarifario(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-green-600 flex-shrink-0" />
                <label htmlFor="chk_tarifario" className="cursor-pointer text-xs text-green-800">
                  <b>Guardar en Tarifario</b> — {form.origen} → {form.destino} ·{" "}
                  {TIPOS_VEHICULO.find(v => v.id === form.tipo_vehiculo)?.label} ·{" "}
                  {TIPOS_SERVICIO[form.tipo_servicio]?.icon} {TIPOS_SERVICIO[form.tipo_servicio]?.label}
                </label>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={guardarCotizacion} disabled={guardando}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60" style={{ background: "#0b315f" }}>
                {guardando ? "Guardando..." : editandoId ? "Actualizar cotización" : "Guardar cotización"}
              </button>
              <button onClick={limpiar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
            </div>
          </section>
        )}

        {/* FILTROS */}
        <section className="flex flex-col md:flex-row gap-3">
          <div className="relative flex-1">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-gray-400">🔍</span>
            <input className="w-full border rounded-xl pl-9 pr-4 py-2.5 text-sm focus:outline-none"
              placeholder="Buscar cliente, ruta o N° cotización..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
          </div>
          <select className="border rounded-xl px-4 py-2.5 text-sm" value={filtroEst} onChange={e => setFiltroEst(e.target.value)}>
            <option value="todos">Todos los estados</option>
            <option value="pendiente">Pendientes</option><option value="enviado">Enviadas</option>
            <option value="aprobado">Aprobadas</option><option value="rechazado">Rechazadas</option>
          </select>
          <div className="flex items-center px-4 py-2.5 bg-gray-50 border rounded-xl text-sm text-gray-400">
            {filtradas.length} resultado{filtradas.length !== 1 ? "s" : ""}
          </div>
        </section>

        {/* TABLA */}
        <section className="bg-white rounded-2xl border shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                  {["N°", "Cliente", "Ruta", "Unidad", "Servicio", "Fecha", "Precio", "Margen", "Estado", "Acciones"].map(h => (
                    <th key={h} className="p-3 text-left text-xs font-bold text-gray-500 uppercase tracking-wide whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400">
                    <div className="flex items-center justify-center gap-2"><div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />Cargando...</div>
                  </td></tr>
                ) : filtradas.length === 0 ? (
                  <tr><td colSpan={10} className="p-10 text-center text-gray-400"><p className="text-3xl mb-2">📄</p><p>No hay cotizaciones</p></td></tr>
                ) : filtradas.map(c => {
                  const est    = ESTADO_CFG[c.estado] || ESTADO_CFG.pendiente;
                  const margen = Number(c.margen_estimado || 0);
                  const veh    = TIPOS_VEHICULO.find(v => v.id === c.tipo_vehiculo);
                  const serv   = c.tipo_servicio ? TIPOS_SERVICIO[c.tipo_servicio as Servicio] : null;
                  const vehFlota = vehiculosFlota.find(v => v.id === c.vehiculo_flota_id);
                  return (
                    <tr key={c.id} className="border-t hover:bg-gray-50" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-mono font-black text-[#0b315f] text-xs">#{c.numero_cotizacion || String(c.id).padStart(5, "0")}</td>
                      <td className="p-3 max-w-[120px]">
                        <div className="font-bold text-gray-800 truncate">{nombreCliente(c.cliente_id)}</div>
                        {c.atencion && <div className="text-xs text-gray-400 truncate">{c.atencion}</div>}
                      </td>
                      <td className="p-3 max-w-[150px]">
                        <div className="truncate text-gray-700 text-xs">{c.origen} → {c.destino}</div>
                        {c.asunto && <div className="text-[10px] text-gray-400 truncate">{c.asunto}</div>}
                      </td>
                      <td className="p-3">
                        {vehFlota
                          ? <div><p className="font-mono font-black text-xs text-[#0b315f]">{vehFlota.placa}</p>
                              <p className="text-[10px] text-gray-400">{vehFlota.equipamiento === "full_equipo" ? "⭐" : "📦"}{vehFlota.foto_externa_url ? " 📸" : ""}</p>
                            </div>
                          : veh ? <div className="text-xs text-gray-500">{veh.icon} {veh.label}</div>
                          : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                      <td className="p-3">
                        {serv && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-lg" style={{ background: serv.bg, color: serv.color }}>{serv.icon} {serv.label}</span>}
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {fmtFecha(c.fecha_servicio)}
                        {c.hora_ida && <div className="text-gray-400">{c.hora_ida}</div>}
                      </td>
                      <td className="p-3 font-bold text-gray-800">{fmtSoles(Number(c.precio_cliente || 0))}</td>
                      <td className="p-3 font-bold" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(margen)}</td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select value={c.estado} onChange={e => cambiarEstado(c, e.target.value as EstadoCot)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: est.bg, color: est.color }}>
                          <option value="pendiente">Pendiente</option><option value="enviado">Enviado</option>
                          <option value="aprobado">Aprobado</option><option value="rechazado">Rechazado</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1 flex-wrap">
                          <button onClick={() => editarCotizacion(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          <button onClick={() => generarPDF(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border" style={{ background: "#eef3f8", color: "#0b315f" }}>📄 PDF</button>
                          <button onClick={() => convertirAReserva(c)} disabled={c.estado !== "aprobado"}
                            className="px-2 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-30"
                            style={{ background: "#dcfce7", color: "#166534" }}>→Res</button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <div className="px-4 py-3 text-xs text-gray-400 border-t flex justify-between" style={{ borderColor: "#f1f5f9" }}>
            <span>{filtradas.length} de {total_cots} cotizaciones · Tasa de aprobación: {tasaAprobacion}%</span>
            <span>AFA ERP · Comercial</span>
          </div>
        </section>
      </main>
    </>
  );
}