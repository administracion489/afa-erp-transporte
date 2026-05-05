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
  equipamiento: string | null;
  created_at: string;
};

type Tarifa = {
  id: number; origen: string; destino: string;
  tipo_vehiculo: string; equipamiento: string; tipo_servicio: string;
  precio: number; moneda: string; confidencial: boolean;
  incluye_guia: boolean; incluye_peajes: boolean; incluye_alimentacion: boolean;
  notas: string | null;
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
  solo_ida:            { label: "Solo ida",            icon: "➡️", color: "#0b315f", bg: "#eef3f8" },
  ida_retorno:         { label: "Ida y retorno",        icon: "🔄", color: "#166534", bg: "#dcfce7" },
  ida_retorno_paradas: { label: "Ida/retorno + paradas",icon: "📍", color: "#854d0e", bg: "#fef9c3" },
  full_day:            { label: "Full Day / Tour",      icon: "⭐", color: "#6d28d9", bg: "#ede9fe" },
};

const ESTADO_CFG: Record<EstadoCot, { label: string; bg: string; color: string }> = {
  pendiente: { label: "Pendiente", bg: "#fef9c3", color: "#854d0e" },
  enviado:   { label: "Enviado",   bg: "#e0f2fe", color: "#0369a1" },
  aprobado:  { label: "Aprobado",  bg: "#dcfce7", color: "#166534" },
  rechazado: { label: "Rechazado", bg: "#fee2e2", color: "#991b1b" },
};

const FLUJO_COT: Record<EstadoCot, string> = {
  pendiente: "En elaboración",
  enviado:   "Esperando respuesta",
  aprobado:  "Lista para convertir",
  rechazado: "Cliente rechazó",
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
  tipo_vehiculo: "AUTO_4", tipo_servicio: "solo_ida" as Servicio,
  equipamiento: "full_equipo",
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
function Campo({ label, span, req, children }: { label: string; span?: number; req?: boolean; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">
        {label}{req && <span className="text-red-400 ml-0.5">*</span>}
      </label>
      {children}
    </div>
  );
}

// ─── MODAL APROBACIÓN ─────────────────────────────────────────────────────────

function ModalAprobacion({ cotizacion, onConfirmar, onCancelar }: {
  cotizacion: Cotizacion; onConfirmar: (tipo: string, numero: string) => void; onCancelar: () => void;
}) {
  const [tipo, setTipo] = useState("Operación bancaria");
  const [numero, setNumero] = useState("");
  const [error, setError] = useState("");
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" style={{ background: "rgba(0,0,0,0.5)" }}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md p-6 space-y-5">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-xl flex items-center justify-center text-xl" style={{ background: "#dcfce7" }}>✅</div>
          <div><h3 className="text-base font-bold text-gray-900">Aprobar cotización</h3><p className="text-xs text-gray-400 mt-0.5">Registra el documento de respaldo</p></div>
        </div>
        <div className="rounded-xl p-3 text-xs space-y-1.5" style={{ background: "#f8fafc" }}>
          <div className="flex justify-between"><span className="text-gray-400">Cotización</span><span className="font-bold">#{cotizacion.numero_cotizacion || String(cotizacion.id).padStart(5, "0")}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Monto</span><span className="font-bold text-green-700">{fmtSoles(Number(cotizacion.precio_cliente || 0))}</span></div>
          <div className="flex justify-between"><span className="text-gray-400">Ruta</span><span className="font-medium truncate ml-4">{cotizacion.origen} → {cotizacion.destino}</span></div>
          {cotizacion.tipo_vehiculo && (
            <div className="flex justify-between"><span className="text-gray-400">Vehículo</span>
              <span className="font-medium">{TIPOS_VEHICULO.find(v => v.id === cotizacion.tipo_vehiculo)?.label || cotizacion.tipo_vehiculo}</span>
            </div>
          )}
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
            onChange={e => { setNumero(e.target.value); setError(""); }}
            autoFocus onKeyDown={e => e.key === "Enter" && (numero.trim() ? onConfirmar(tipo, numero.trim()) : setError("Obligatorio"))} />
          {error && <p className="text-xs text-red-600">⚠ {error}</p>}
        </div>
        <div className="rounded-xl p-3 text-xs text-blue-700" style={{ background: "#eff6ff" }}>
          Este número quedará registrado y no podrá modificarse una vez aprobada.
        </div>
        <div className="flex gap-3">
          <button onClick={() => numero.trim() ? onConfirmar(tipo, numero.trim()) : setError("Obligatorio")}
            className="flex-1 py-2.5 rounded-xl font-bold text-sm text-white" style={{ background: "#166534" }}>✅ Confirmar</button>
          <button onClick={onCancelar} className="px-5 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">Cancelar</button>
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
  const rutasSimilares = tarifas.filter(t =>
    (norm(t.origen).includes(norm(origen)) || norm(t.destino).includes(norm(destino))) &&
    t.tipo_vehiculo === tipoVeh && !exacta
  ).slice(0, 3);

  if (!origen.trim() || !destino.trim()) return null;
  if (!exacta && mismaRutaOtrosVeh.length === 0 && rutasSimilares.length === 0) return null;

  return (
    <div className="rounded-2xl border-2 p-4 space-y-3" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
      <div className="flex items-center gap-2">
        <span className="text-lg">💡</span>
        <p className="text-sm font-bold text-green-800">Sugerencias del tarifario</p>
      </div>

      {exacta && (
        <div className="rounded-xl border-2 border-green-400 bg-white p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <p className="text-[10px] font-bold uppercase tracking-wide text-green-600">✅ Coincidencia exacta</p>
              <p className="font-bold text-gray-800 text-sm">{exacta.origen} → {exacta.destino}</p>
              <p className="text-xs text-gray-500">
                {TIPOS_VEHICULO.find(v => v.id === exacta.tipo_vehiculo)?.label} ·{" "}
                {TIPOS_SERVICIO[exacta.tipo_servicio as Servicio]?.icon} {TIPOS_SERVICIO[exacta.tipo_servicio as Servicio]?.label}
                {exacta.equip === "full_equipo" ? " · ⭐ Full Equipo" : " · 📦 Básico"}
              </p>
              {(exacta.incluye_guia || exacta.incluye_peajes || exacta.incluye_alimentacion) && (
                <p className="text-[10px] text-gray-400 mt-0.5">
                  Incluye: {[exacta.incluye_guia && "🎤 Guía", exacta.incluye_peajes && "🛣️ Peajes", exacta.incluye_alimentacion && "🍽️ Alim."].filter(Boolean).join(" · ")}
                </p>
              )}
              {exacta.notas && <p className="text-[10px] text-gray-400 italic mt-0.5">"{exacta.notas}"</p>}
            </div>
            <div className="text-right flex-shrink-0">
              {exacta.confidencial
                ? <p className="text-purple-700 font-bold text-sm">🔒 Tarifa conf.</p>
                : <>
                    <p className="text-xs text-gray-400">Sin IGV</p>
                    <p className="text-2xl font-black text-green-700 font-mono">{fmtSoles(exacta.precio)}</p>
                    <p className="text-xs text-gray-400">Con IGV: {fmtSoles(exacta.precio * 1.18)}</p>
                  </>
              }
              {!exacta.confidencial && (
                <button onClick={() => onAplicar(exacta.precio, exacta)}
                  className="mt-2 px-4 py-1.5 rounded-xl text-xs font-black text-white"
                  style={{ background: "#166534" }}>
                  Aplicar precio ✓
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      {mismaRutaOtrosVeh.length > 0 && (
        <div>
          <p className="text-[10px] font-bold uppercase text-green-700 mb-2">Misma ruta — otros vehículos</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {mismaRutaOtrosVeh.map(t => {
              const veh = TIPOS_VEHICULO.find(v => v.id === t.tipo_vehiculo);
              return (
                <div key={t.id} className="rounded-xl border bg-white p-2.5 cursor-pointer hover:border-green-400 transition-all"
                  onClick={() => !t.confidencial && onAplicar(t.precio, t)}>
                  <p className="text-[10px] font-bold text-gray-500">{veh?.icon} {veh?.label}</p>
                  {t.confidencial
                    ? <p className="font-bold text-purple-700 text-sm">🔒 Conf.</p>
                    : <p className="font-black text-gray-800 font-mono">{fmtSoles(t.precio)}</p>}
                  <p className="text-[9px] text-green-600 font-bold">clic para aplicar</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {rutasSimilares.length > 0 && !exacta && (
        <div>
          <p className="text-[10px] font-bold uppercase text-amber-700 mb-2">⚠️ Rutas similares (referencia)</p>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-2">
            {rutasSimilares.map(t => (
              <div key={t.id} className="rounded-xl border border-amber-200 bg-amber-50 p-2.5 cursor-pointer hover:border-amber-400 transition-all"
                onClick={() => !t.confidencial && onAplicar(t.precio, t)}>
                <p className="text-[10px] font-bold text-amber-700">{t.origen} → {t.destino}</p>
                {t.confidencial
                  ? <p className="font-bold text-purple-700 text-sm">🔒 Conf.</p>
                  : <p className="font-black text-gray-800 font-mono">{fmtSoles(t.precio)}</p>}
                <p className="text-[9px] text-amber-600">ref. — verificar ruta</p>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── GENERADOR PDF ────────────────────────────────────────────────────────────

function generarPDFHtml(cot: Cotizacion, cliente: Cliente | undefined, items: ItemCot[]) {
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
  const notasServicio = [
    cot.fecha_servicio ? `<b>FECHA:</b> ${new Date(cot.fecha_servicio + "T00:00:00").toLocaleDateString("es-PE", { day: "numeric", month: "long", year: "numeric" }).toUpperCase()}` : "",
    cot.hora_ida       ? `<b>IDA:</b> ${cot.hora_ida}` : "",
    cot.hora_retorno   ? `<b>RETORNO:</b> ${cot.hora_retorno}` : "",
  ].filter(Boolean).join("&nbsp;&nbsp;");
  return `<!DOCTYPE html><html lang="es"><head><meta charset="UTF-8"/>
<title>Cotización N° ${numeroCot} - AFA TOURS PERU</title>
<style>@page{size:A4;margin:18mm 15mm 15mm 15mm}*{box-sizing:border-box}body{font-family:Arial,sans-serif;font-size:11px;color:#1a1a1a;margin:0}.header{display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;border-bottom:3px solid #0b315f;padding-bottom:10px}.logo{height:60px}.titulo-cot{text-align:right}.titulo-cot h1{font-size:18px;font-weight:900;color:#0b315f;margin:0}.titulo-cot p{margin:2px 0;font-size:11px;color:#444}.grid2{display:grid;grid-template-columns:1fr 1fr;gap:10px;margin-bottom:10px}.box{border:1px solid #ccc;border-radius:4px;padding:8px 10px}.box-title{font-weight:900;font-size:10px;color:#0b315f;text-transform:uppercase;border-bottom:1px solid #e5e7eb;padding-bottom:4px;margin-bottom:6px}.box-row{margin:3px 0;font-size:10.5px}table{width:100%;border-collapse:collapse;margin:10px 0;font-size:10.5px}thead{background:#0b315f;color:white}thead th{padding:7px 6px;text-align:center;font-weight:700;font-size:10px;border:1px solid #0b315f}tbody tr:nth-child(even){background:#f8fafc}.totales td{padding:4px 10px;font-size:11px}.totales .label{text-align:right;color:#555;font-weight:600}.totales .valor{text-align:right;font-weight:700;min-width:100px}.totales .total-neto{font-size:13px;font-weight:900;color:#0b315f}.totales .sep{border-top:2px solid #0b315f}.cuentas{margin-top:14px;border-top:2px solid #0b315f;padding-top:10px}.cuentas h3{font-size:11px;font-weight:900;color:#0b315f;margin:0 0 8px;text-transform:uppercase}.cuentas-grid{display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px}.cuenta-box{border:1px solid #ddd;border-radius:4px;padding:6px 8px}.cuenta-box .banco{font-weight:900;font-size:10px;color:#0b315f;margin-bottom:4px}.cuenta-box p{margin:2px 0;font-size:9.5px;color:#333}.firma{margin-top:20px;display:flex;justify-content:flex-end}.firma-box{text-align:center;border-top:1px solid #333;padding-top:6px;width:180px;font-size:10px;color:#555}.page-break{page-break-before:always}.anexo h3{font-size:11px;font-weight:900;color:#0b315f;margin:12px 0 4px;text-transform:uppercase}.anexo p,.anexo li{font-size:10.5px;color:#333;line-height:1.6;margin:3px 0}.anexo ul{padding-left:18px}.footer-doc{margin-top:16px;border-top:1px solid #ccc;padding-top:8px;text-align:center;font-size:9px;color:#888}@media print{body{-webkit-print-color-adjust:exact;print-color-adjust:exact}}</style></head><body>
<div class="header"><img src="/logoafa.png" alt="AFA TOURS PERU" class="logo"/><div class="titulo-cot"><h1>COTIZACIÓN N° ${numeroCot} - ${anio}</h1><p><b>FECHA:</b> ${fechaDoc}</p><p style="font-style:italic;color:#666;font-size:10px;">Cotización válida por 30 días</p></div></div>
<div class="grid2"><div class="box"><div class="box-title">Datos del cliente</div><div class="box-row"><b>CLIENTE:</b> ${nombreCliente}</div><div class="box-row"><b>${cliente?.ruc ? "RUC" : "DNI"}:</b> ${rucDni.replace(/^(RUC|DNI): /, "")}</div><div class="box-row"><b>DIRECCIÓN:</b> ${cliente?.direccion || "—"}</div><div class="box-row"><b>CELULAR:</b> ${cliente?.telefono || "—"}</div><div class="box-row"><b>ATENCIÓN:</b> ${atencion}</div></div><div class="box"><div class="box-title">AFA Tours Peru S.A.C.</div><div class="box-row"><b>RUC:</b> 20602117091</div><div class="box-row"><b>DIRECCIÓN:</b> MZA. F LOTE. 2 ASC. TRABAJADORES UNIDOS CHACRASANA - LURIGANCHO</div><div class="box-row"><b>REPR:</b> JENNY ELYZABETH URBINA AFATA</div><div class="box-row"><b>EMAIL:</b> transporte@afatoursperu.com</div><div class="box-row"><b>TELF:</b> (01) 3453707 – 966 707 225</div></div></div>
<div class="box" style="margin-bottom:10px;"><div class="box-title">Detalle del servicio</div><div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:6px;"><div class="box-row"><b>PUNTO DE RECOJO:</b> ${cot.origen || "—"}</div><div class="box-row"><b>PUNTO DE DESTINO:</b> ${cot.destino || "—"}</div><div class="box-row"><b>PUNTO DE RETORNO:</b> ${cot.punto_retorno || cot.origen || "—"}</div></div>${cot.asunto ? `<div class="box-row" style="margin-top:4px;"><b>ASUNTO:</b> ${cot.asunto}</div>` : ""}</div>
<table><thead><tr><th style="width:40px;">ITEM</th><th style="text-align:left;">DESCRIPCIÓN</th><th style="width:45px;">DÍAS</th><th style="width:55px;">CANTIDAD</th><th style="width:110px;">P. UNIT SIN IGV</th><th style="width:55px;">% DSCTO.</th><th style="width:110px;">TOTAL VENTA (S/.)</th></tr></thead><tbody>${filasItems}<tr><td colspan="4" style="border:1px solid #ccc;padding:7px 8px;font-size:9.5px;color:#555;font-style:italic;"><b>CANTIDAD:</b> Número de unidades &nbsp;|&nbsp; <b>INCLUYE:</b> Traslado, conductor, combustible, peajes.${notasServicio ? `<br/>${notasServicio}` : ""}<br/><b>FORMA DE PAGO:</b> Transferencia / Depósito</td><td colspan="3" style="border:1px solid #ccc;padding:0;vertical-align:top;"><table class="totales"><tr><td class="label">SUBTOTAL</td><td class="valor">S/ ${subtotal.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr>${descuentoTotal > 0 ? `<tr><td class="label">DESCUENTO</td><td class="valor" style="color:#dc2626;">- S/ ${descuentoTotal.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr>` : "<tr><td class='label'>DESCUENTO</td><td class='valor'>—</td></tr>"}<tr><td class="label">IGV (18%)</td><td class="valor">S/ ${igv.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr><tr class="sep"><td class="label total-neto">TOTAL NETO</td><td class="valor total-neto">S/ ${total.toLocaleString("es-PE", { minimumFractionDigits: 2 })}</td></tr></table></td></tr></tbody></table>
<div class="firma"><div class="firma-box">REVISADO POR</div></div>
<div class="cuentas"><h3>Nuestras cuentas bancarias</h3><div class="cuentas-grid"><div class="cuenta-box"><div class="banco">BCP — Cuenta Soles</div><p>Cta. Corriente: 191-2644342-0-24</p><p>CCI: 00219100264434202450</p></div><div class="cuenta-box"><div class="banco">BCP — Cuenta Dólares</div><p>Cta.: 191-7394169-1-83</p><p>CCI: 00219100739416918351</p></div><div class="cuenta-box"><div class="banco">Banco de la Nación (Detracción 10%)</div><p>Cta.: 00-091-069571</p><p>CCI: 01809100009106957197</p></div></div></div>
<div class="footer-doc">Dir.: Av. Unión Mz. A Lt.3 Urb. San Bartolomé - Chaclacayo – Lima &nbsp;|&nbsp; (01) 3097082 - 966707225 &nbsp;|&nbsp; transporte@afatoursperu.com</div>
<div class="page-break"></div>
<div class="header"><img src="/logoafa.png" alt="AFA TOURS PERU" class="logo"/><div class="titulo-cot"><h1>COTIZACIÓN N° ${numeroCot} - ${anio}</h1><p style="font-size:12px;font-weight:700;">ANEXO 1 — DESCRIPCIÓN DE UNIDADES</p></div></div>
<div class="anexo"><h3>Características de la unidad</h3><p>Bus con capacidad para 49 pasajeros, con audio (radio y TV), aire acondicionado, calefacción, bodega y GPS en tiempo real.</p><h3>Condiciones del servicio</h3><ul><li>Precios según fechas y horarios coordinados.</li><li>Tolerancia máxima de espera: 30 minutos.</li><li>No se permite consumo de alcohol ni tabaco.</li><li>Cambios en ruta u horario pueden generar costos adicionales.</li></ul><h3>Condiciones de pago</h3><ul><li><b>Servicio recurrente:</b> Orden de compra/servicio o buena pro.</li><li><b>Servicio eventual:</b> Adelanto del <b>50%</b> para confirmar, saldo antes de culminar.</li></ul><p>Enviar orden o comprobante a <b>transporte@afatoursperu.com</b> o WhatsApp <b>966 707 225</b>. Reservar con <b>7 días de anticipación mínimo</b>.</p></div>
<div class="footer-doc" style="margin-top:30px;">Dir.: Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana - Lima &nbsp;|&nbsp; (01) 3453707 - 966707225 &nbsp;|&nbsp; transporte@afatoursperu.com</div>
<script>window.onload=()=>window.print();</script></body></html>`;
}

// ─── PAGE ─────────────────────────────────────────────────────────────────────

export default function CotizacionesPage() {
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [cotizaciones, setCotizaciones] = useState<Cotizacion[]>([]);
  const [tarifas,      setTarifas]      = useState<Tarifa[]>([]);
  const [loading,      setLoading]      = useState(false);
  const [guardando,    setGuardando]    = useState(false);
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [busqueda,     setBusqueda]     = useState("");
  const [filtroEst,    setFiltroEst]    = useState("todos");
  const [form,         setForm]         = useState(FORM_VACIO);
  const [items,        setItems]        = useState<ItemCot[]>([{ ...ITEM_VACIO }]);
  const [modalAprobacion, setModalAprobacion] = useState<Cotizacion | null>(null);
  const [guardarEnTarifario, setGuardarEnTarifario] = useState(true);

  const f = (k: keyof typeof FORM_VACIO) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
      setForm(p => ({ ...p, [k]: e.target.value }));

  const cargarDatos = async () => {
    setLoading(true);
    const [clRes, cotRes, tRes] = await Promise.all([
      supabase.from("clientes").select("*").order("nombre").limit(1000),
      supabase.from("cotizaciones").select("*").order("id", { ascending: false }),
      supabase.from("tarifario").select("*").eq("activo", true),
    ]);
    setClientes(clRes.data    || []);
    setCotizaciones(cotRes.data || []);
    setTarifas(tRes.data      || []);
    setLoading(false);
  };

  useEffect(() => { cargarDatos(); }, []);

  const actualizarItem = (i: number, k: keyof ItemCot, v: string | number) =>
    setItems(prev => prev.map((it, idx) => idx === i ? { ...it, [k]: Number.isNaN(Number(v)) ? v : Number(v) } : it));
  const agregarItem  = () => setItems(p => [...p, { ...ITEM_VACIO }]);
  const eliminarItem = (i: number) => setItems(p => p.filter((_, idx) => idx !== i));
  const { subtotal, igv, total } = calcItems(items);

  const limpiar = () => { setForm(FORM_VACIO); setItems([{ ...ITEM_VACIO }]); setEditandoId(null); setMostrarForm(false); };

  // Aplicar precio sugerido del tarifario
  const aplicarPrecioTarifario = (precioSinIgv: number, tarifa: Tarifa) => {
    const veh = TIPOS_VEHICULO.find(v => v.id === tarifa.tipo_vehiculo);
    setItems(prev => {
      const nuevos = [...prev];
      nuevos[0] = {
        ...nuevos[0],
        precio_unit: precioSinIgv,
        descripcion: nuevos[0].descripcion || `${veh?.icon} ${veh?.label} — ${tarifa.origen} → ${tarifa.destino}`,
      };
      return nuevos;
    });
    setForm(p => ({ ...p, tipo_vehiculo: tarifa.tipo_vehiculo, tipo_servicio: tarifa.tipo_servicio as Servicio, equipamiento: tarifa.equipamiento }));
  };

  // Guardar cotización
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
      tipo_vehiculo: form.tipo_vehiculo || null,
      tipo_servicio: form.tipo_servicio || null,
      equipamiento: form.equipamiento || null,
    };

    const { error } = editandoId
      ? await supabase.from("cotizaciones").update(payload).eq("id", editandoId)
      : await supabase.from("cotizaciones").insert(payload);
    if (error) { alert(error.message); setGuardando(false); return; }

    // Guardar en tarifario si aplica
    if (guardarEnTarifario && form.tipo_vehiculo && form.tipo_servicio && form.equipamiento && subtotal > 0) {
      const precioSinIgv = subtotal;
      await supabase.from("tarifario").upsert({
        origen: form.origen.trim().toUpperCase(),
        destino: form.destino.trim().toUpperCase(),
        tipo_vehiculo: form.tipo_vehiculo,
        equipamiento: form.equipamiento,
        tipo_servicio: form.tipo_servicio,
        precio: precioSinIgv,
        moneda: "PEN",
        confidencial: form.tipo_servicio === "full_day",
        incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false,
        notas: `Generado desde cotización ${form.numero_cotizacion || ""}`.trim(),
        activo: true,
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
    // Al aprobar, también guardar en tarifario si tiene tipo_vehiculo
    if (modalAprobacion.tipo_vehiculo && modalAprobacion.tipo_servicio && modalAprobacion.equipamiento) {
      const precioSinIgv = Number(modalAprobacion.precio_cliente) / 1.18;
      await supabase.from("tarifario").upsert({
        origen: modalAprobacion.origen.toUpperCase(),
        destino: modalAprobacion.destino.toUpperCase(),
        tipo_vehiculo: modalAprobacion.tipo_vehiculo,
        equipamiento: modalAprobacion.equipamiento,
        tipo_servicio: modalAprobacion.tipo_servicio,
        precio: Math.round(precioSinIgv * 100) / 100,
        moneda: "PEN",
        confidencial: modalAprobacion.tipo_servicio === "full_day",
        incluye_guia: false, incluye_peajes: false, incluye_alimentacion: false,
        notas: `Cotización aprobada #${modalAprobacion.numero_cotizacion || modalAprobacion.id}`,
        activo: true,
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
    alert("✅ Cotización convertida en reserva");
    cargarDatos();
  };

  const editarCotizacion = (c: Cotizacion) => {
    setForm({
      cliente_id: String(c.cliente_id || ""), origen: c.origen || "", destino: c.destino || "",
      km: c.km ? String(c.km) : "", costo_estimado: c.costo_estimado ? String(c.costo_estimado) : "",
      estado: c.estado || "pendiente", numero_cotizacion: c.numero_cotizacion || "",
      atencion: c.atencion || "", asunto: c.asunto || "", punto_retorno: c.punto_retorno || "",
      fecha_servicio: c.fecha_servicio || "", hora_ida: c.hora_ida || "", hora_retorno: c.hora_retorno || "",
      descuento_pct: c.descuento_pct ? String(c.descuento_pct) : "0",
      tipo_vehiculo: c.tipo_vehiculo || "AUTO_4",
      tipo_servicio: (c.tipo_servicio || "solo_ida") as Servicio,
      equipamiento: c.equipamiento || "full_equipo",
    });
    if (c.items_json && c.items_json.length > 0) setItems(c.items_json);
    else { const p = Number(c.precio_cliente || 0) / 1.18; setItems([{ descripcion: c.asunto || `${c.origen} → ${c.destino}`, dias: 1, cantidad: 1, precio_unit: Math.round(p * 100) / 100, descuento_pct: 0 }]); }
    setEditandoId(c.id); setMostrarForm(true);
    setTimeout(() => window.scrollTo({ top: 0, behavior: "smooth" }), 50);
  };

  const generarPDF = (cot: Cotizacion) => {
    const cliente = clientes.find(c => c.id === cot.cliente_id);
    const its = (cot.items_json && cot.items_json.length > 0)
      ? cot.items_json
      : [{ descripcion: `${cot.asunto || "SERVICIO DE TRANSPORTE"} — ${cot.origen} → ${cot.destino}`, dias: 1, cantidad: 1, precio_unit: cot.precio_cliente / 1.18, descuento_pct: 0 }];
    const win = window.open("", "_blank");
    if (win) { win.document.write(generarPDFHtml(cot, cliente, its)); win.document.close(); }
  };

  // KPIs
  const total_cots     = cotizaciones.length;
  const pendientes     = cotizaciones.filter(c => c.estado === "pendiente").length;
  const enviados       = cotizaciones.filter(c => c.estado === "enviado").length;
  const aprobadas      = cotizaciones.filter(c => c.estado === "aprobado").length;
  const rechazadas     = cotizaciones.filter(c => c.estado === "rechazado").length;
  const valorTotal     = cotizaciones.reduce((s, c) => s + Number(c.precio_cliente || 0), 0);
  const tasaAprobacion = total_cots > 0 ? Math.round((aprobadas / total_cots) * 100) : 0;
  const nombreCliente  = (id: number | null) => { const c = clientes.find(cl => cl.id === id); return c ? (c.empresa || c.nombre) : "Sin cliente"; };

  const filtradas = cotizaciones.filter(c => {
    const ncl = clientes.find(cl => cl.id === c.cliente_id);
    const ncn = ncl?.empresa || ncl?.nombre || "";
    const q = busqueda.toLowerCase();
    return (ncn.toLowerCase().includes(q) || c.origen.toLowerCase().includes(q) ||
      c.destino.toLowerCase().includes(q) || (c.numero_cotizacion || "").includes(q)) &&
      (filtroEst === "todos" || c.estado === filtroEst);
  });

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
            <p className="text-gray-400 text-sm mt-1">Gestión comercial · sugerencias automáticas del tarifario · alimentación del tarifario</p>
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
                      {cfg.label}
                      {count > 0 && <span className="ml-1 px-1.5 py-0.5 rounded-full text-[10px] font-black text-white" style={{ background: cfg.color }}>{count}</span>}
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
            { label: "Total",       valor: total_cots,           color: "#0b315f", bg: "#eef3f8" },
            { label: "Pendientes",  valor: pendientes,            color: "#854d0e", bg: "#fef9c3" },
            { label: "Enviadas",    valor: enviados,              color: "#0369a1", bg: "#e0f2fe" },
            { label: "Aprobadas",   valor: aprobadas,             color: "#166534", bg: "#dcfce7" },
            { label: "Tasa aprob.", valor: `${tasaAprobacion}%`,  color: "#1d4ed8", bg: "#dbeafe" },
            { label: "Valor total", valor: fmtSoles(valorTotal),  color: "#166534", bg: "#dcfce7" },
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
                <h2 className="text-lg font-bold text-gray-900">{editandoId ? "Editar cotización" : "Nueva cotización"}</h2>
                <p className="text-xs text-gray-400">El precio se calcula automáticamente. Si existe la ruta en el tarifario, se sugiere el precio.</p>
              </div>
            </div>

            {/* Identificación */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Identificación</p>
              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Cliente" req>
                  <div className="flex gap-2">
                    <select className={inputCls()} value={form.cliente_id} onChange={f("cliente_id")}>
                      <option value="">— Seleccionar cliente ({clientes.length} registrados) —</option>
                      {clientes
                        .filter(c => c.estado !== "bloqueado")
                        .sort((a, b) => (a.empresa || a.nombre).localeCompare(b.empresa || b.nombre))
                        .map(c => (
                          <option key={c.id} value={c.id}>
                            {c.empresa || c.nombre}{c.ruc ? ` · RUC ${c.ruc}` : c.dni ? ` · DNI ${c.dni}` : ""}
                          </option>
                        ))}
                      {clientes.filter(c => c.estado === "bloqueado").length > 0 && (
                        <>
                          <option disabled>── Bloqueados ──</option>
                          {clientes.filter(c => c.estado === "bloqueado").map(c => (
                            <option key={c.id} value={c.id} disabled>{c.empresa || c.nombre} — BLOQUEADO</option>
                          ))}
                        </>
                      )}
                    </select>
                    <a href="/clientes" target="_blank" rel="noreferrer"
                      title="Agregar nuevo cliente (se abre en nueva pestaña)"
                      className="flex-shrink-0 w-10 h-10 rounded-xl border-2 flex items-center justify-center font-black text-lg transition-all hover:shadow-md"
                      style={{ background: "#eef3f8", borderColor: "#0b315f33", color: "#0b315f" }}>
                      +
                    </a>
                  </div>
                  <p className="text-[10px] text-gray-400 mt-1">El <b>+</b> abre la página de clientes en nueva pestaña para agregar uno nuevo</p>
                </Campo>
                <Campo label="N° cotización">
                  <input className={inputCls("font-mono")} placeholder="Ej: 10996" value={form.numero_cotizacion} onChange={f("numero_cotizacion")} />
                </Campo>
                <Campo label="Estado">
                  <select className={inputCls()} value={form.estado} onChange={f("estado")}>
                    <option value="pendiente">Pendiente</option><option value="enviado">Enviado</option><option value="rechazado">Rechazado</option>
                  </select>
                </Campo>
                <Campo label="Atención (contacto del cliente)" span={2}>
                  <input className={inputCls()} placeholder="Nombre del responsable" value={form.atencion} onChange={f("atencion")} />
                </Campo>
                <Campo label="Asunto">
                  <input className={inputCls()} placeholder="Ej: Servicio turístico" value={form.asunto} onChange={f("asunto")} />
                </Campo>
              </div>
            </div>

            {/* Tipo de servicio + vehículo + equipamiento */}
            <div>
              <p className="text-[10px] font-bold uppercase tracking-widest text-gray-400 border-b pb-1 mb-3">Tipo de servicio y vehículo</p>
              <div className="space-y-3">
                {/* Tipo servicio */}
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
                {/* Equipamiento */}
                <div className="grid grid-cols-2 gap-2">
                  {[
                    { val: "full_equipo", label: "⭐ Full Equipo", sub: "AC, TV, WiFi, premium", color: "#0b315f", bg: "#eef3f8" },
                    { val: "basico",      label: "📦 Básico",      sub: "Servicio estándar",   color: "#4b5563", bg: "#f3f4f6" },
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
                {/* Tipo vehículo */}
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
                <Campo label="Punto de recojo" req>
                  <input className={inputCls()} placeholder="Av. República de Panamá 3623" value={form.origen} onChange={f("origen")} />
                </Campo>
                <Campo label="Punto de destino" req>
                  <input className={inputCls()} placeholder="Kusina Pachacamac" value={form.destino} onChange={f("destino")} />
                </Campo>
                <Campo label="Punto de retorno">
                  <input className={inputCls()} placeholder="Igual al origen si aplica" value={form.punto_retorno} onChange={f("punto_retorno")} />
                </Campo>
                <Campo label="Fecha de servicio">
                  <input type="date" className={inputCls()} value={form.fecha_servicio} onChange={f("fecha_servicio")} />
                </Campo>
                <Campo label="Hora de ida">
                  <input type="time" className={inputCls()} value={form.hora_ida} onChange={f("hora_ida")} />
                </Campo>
                <Campo label="Hora de retorno">
                  <input type="time" className={inputCls()} value={form.hora_retorno} onChange={f("hora_retorno")} />
                </Campo>
                <Campo label="Km estimados">
                  <input type="number" className={inputCls()} value={form.km} onChange={f("km")} />
                </Campo>
                <Campo label="Costo interno S/ (no visible al cliente)">
                  <input type="number" className={inputCls()} value={form.costo_estimado} onChange={f("costo_estimado")} />
                </Campo>
              </div>
            </div>

            {/* PANEL SUGERENCIA TARIFARIO */}
            <PanelSugerencia
              tarifas={tarifas}
              origen={form.origen} destino={form.destino}
              tipoVeh={form.tipo_vehiculo} tipoServ={form.tipo_servicio}
              equip={form.equipamiento}
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
                  <div className="flex justify-between text-base border-t pt-2 mt-1" style={{ borderColor: "#0b315f" }}>
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

            {/* Opción guardar en tarifario */}
            {form.tipo_vehiculo && form.tipo_servicio && form.origen && form.destino && (
              <div className="rounded-xl border px-4 py-3 flex items-start gap-3" style={{ background: "#f0fdf4", borderColor: "#86efac" }}>
                <input type="checkbox" id="chk_tarifario" checked={guardarEnTarifario}
                  onChange={e => setGuardarEnTarifario(e.target.checked)}
                  className="w-4 h-4 mt-0.5 accent-green-600 flex-shrink-0" />
                <label htmlFor="chk_tarifario" className="cursor-pointer text-xs text-green-800">
                  <b>Guardar automáticamente en el Tarifario</b> — este precio (sin IGV) quedará registrado para {form.origen} → {form.destino} con{" "}
                  {TIPOS_VEHICULO.find(v => v.id === form.tipo_vehiculo)?.label} ·{" "}
                  {TIPOS_SERVICIO[form.tipo_servicio]?.icon} {TIPOS_SERVICIO[form.tipo_servicio]?.label}.
                  La próxima cotización similar tendrá sugerencia automática.
                </label>
              </div>
            )}

            <div className="flex gap-3">
              <button onClick={guardarCotizacion} disabled={guardando}
                className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60"
                style={{ background: "#0b315f" }}>
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
              placeholder="Buscar por cliente, ruta o N° cotización..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
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
                  {["N°", "Cliente", "Ruta", "Servicio", "Fecha", "Precio", "Margen", "Aprobación", "Estado", "Acciones"].map(h => (
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
                  return (
                    <tr key={c.id} className="border-t hover:bg-gray-50 transition-colors" style={{ borderColor: "#f1f5f9" }}>
                      <td className="p-3 font-mono font-black text-[#0b315f] text-xs">#{c.numero_cotizacion || String(c.id).padStart(5, "0")}</td>
                      <td className="p-3 font-bold text-gray-800 max-w-[130px]">
                        <div className="truncate">{nombreCliente(c.cliente_id)}</div>
                        {c.atencion && <div className="text-xs text-gray-400 font-normal truncate">{c.atencion}</div>}
                      </td>
                      <td className="p-3 max-w-[160px]">
                        <div className="truncate text-gray-700">{c.origen} → {c.destino}</div>
                        {c.asunto && <div className="text-xs text-gray-400 truncate">{c.asunto}</div>}
                      </td>
                      <td className="p-3">
                        <div className="space-y-0.5">
                          {veh && <div className="text-xs text-gray-600">{veh.icon} {veh.label}</div>}
                          {serv && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded-lg" style={{ background: serv.bg, color: serv.color }}>{serv.icon} {serv.label}</span>}
                        </div>
                      </td>
                      <td className="p-3 text-xs text-gray-500">
                        {fmtFecha(c.fecha_servicio)}
                        {c.hora_ida && <div className="text-gray-400">{c.hora_ida}</div>}
                      </td>
                      <td className="p-3 font-bold text-gray-800">{fmtSoles(Number(c.precio_cliente || 0))}</td>
                      <td className="p-3 font-bold" style={{ color: margen >= 0 ? "#166534" : "#991b1b" }}>{fmtSoles(margen)}</td>
                      <td className="p-3">
                        {c.numero_aprobacion
                          ? <div><div className="text-xs font-bold font-mono">{c.numero_aprobacion}</div><div className="text-[10px] text-gray-400">{c.tipo_aprobacion}</div></div>
                          : c.estado === "aprobado" ? <span className="text-[10px] text-amber-600">Sin registro</span> : <span className="text-gray-300 text-xs">—</span>}
                      </td>
                      <td className="p-3" onClick={e => e.stopPropagation()}>
                        <select value={c.estado} onChange={e => cambiarEstado(c, e.target.value as EstadoCot)}
                          className="text-xs font-bold px-2 py-1 rounded-lg border-0 cursor-pointer"
                          style={{ background: est.bg, color: est.color }}>
                          <option value="pendiente">Pendiente</option>
                          <option value="enviado">Enviado</option>
                          <option value="aprobado">Aprobado</option>
                          <option value="rechazado">Rechazado</option>
                        </select>
                      </td>
                      <td className="p-3">
                        <div className="flex gap-1 flex-wrap">
                          <button onClick={() => editarCotizacion(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border hover:bg-gray-50 text-gray-700">✏️</button>
                          <button onClick={() => generarPDF(c)} className="px-2 py-1.5 rounded-lg text-xs font-bold border" style={{ background: "#eef3f8", color: "#0b315f" }}>📄</button>
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