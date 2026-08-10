"use client";
// Página PÚBLICA de autoservicio de documentos para proveedores (empresas tercerizadas).
// El proveedor llega por el link que manda el cron (correo/WhatsApp) o que un operador le
// reenvía a mano. Sin login: el token en la URL es la única autorización.
//
// Lo que sube acá NO actualiza el documento en el ERP de inmediato — queda "En revisión"
// hasta que un operador lo apruebe desde /tercerizadas. Ese es el punto: evita que una fecha
// inventada o una foto ilegible se cuele directo al sistema.

import { useEffect, useMemo, useState } from "react";
import { useParams } from "next/navigation";

type Documento = {
  id: number; vehiculo_id: number | null; tipo: string; numero: string | null;
  fecha_vencimiento: string | null; entidad_emisora: string | null; archivo_url: string | null;
  estado: "vigente" | "por_vencer" | "vencido" | "sin_fecha";
};
type Revision = {
  id: number; documento_id: number | null; vehiculo_id: number | null; tipo: string;
  estado: "pendiente" | "aprobado" | "rechazado"; motivo_rechazo: string | null; creado_en: string;
};
type Vehiculo = { id: number; placa: string };

const ESTADO_CFG: Record<string, { label: string; bg: string; color: string }> = {
  vigente:    { label: "Vigente",    bg: "#dcfce7", color: "#166534" },
  por_vencer: { label: "Por vencer", bg: "#fef9c3", color: "#854d0e" },
  vencido:    { label: "Vencido",    bg: "#fee2e2", color: "#991b1b" },
  sin_fecha:  { label: "Sin fecha",  bg: "#f3f4f6", color: "#4b5563" },
};

const fmtFecha = (f: string | null) =>
  f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

function fileABase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result).split(",")[1] || "");
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

const FORM_VACIO = { numero: "", fechaVencimientoPropuesta: "", entidadEmisora: "", observaciones: "" };

export default function ProveedorDocumentosPage() {
  const { token } = useParams<{ token: string }>();
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState("");
  const [empresa, setEmpresa] = useState<any>(null);
  const [documentos, setDocumentos] = useState<Documento[]>([]);
  const [vehiculos, setVehiculos] = useState<Vehiculo[]>([]);
  const [revisiones, setRevisiones] = useState<Revision[]>([]);
  const [tiposObligatorios, setTiposObligatorios] = useState<string[]>([]);

  const [panelAbierto, setPanelAbierto] = useState<{ documentoId: number | null; vehiculoId: number | null; tipo: string } | null>(null);
  const [form, setForm] = useState(FORM_VACIO);
  const [archivo, setArchivo] = useState<File | null>(null);
  const [subiendo, setSubiendo] = useState(false);
  const [errorForm, setErrorForm] = useState("");

  async function cargar() {
    setCargando(true);
    try {
      const r = await fetch(`/api/tercerizadas/documentos-proveedor?token=${encodeURIComponent(String(token))}`);
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se pudo cargar la información.");
      setEmpresa(j.empresa);
      setDocumentos(j.documentos || []);
      setVehiculos(j.vehiculos || []);
      setRevisiones(j.revisiones || []);
      setTiposObligatorios(j.tiposObligatorios || []);
    } catch (e: any) {
      setError(String(e?.message ?? e));
    } finally {
      setCargando(false);
    }
  }

  useEffect(() => { cargar(); }, [token]);

  // La última revisión de CADA (documentoId|tipo+vehiculoId) — para saber si mostrar
  // "En revisión" o el motivo de un rechazo reciente en vez del botón de subir.
  const ultimaRevisionPor = useMemo(() => {
    const map = new Map<string, Revision>();
    for (const r of revisiones) {
      const clave = r.documento_id ? `doc:${r.documento_id}` : `nuevo:${r.tipo}:${r.vehiculo_id ?? "emp"}`;
      const prev = map.get(clave);
      if (!prev || new Date(r.creado_en) > new Date(prev.creado_en)) map.set(clave, r);
    }
    return map;
  }, [revisiones]);

  function abrirPanel(d: { documentoId: number | null; vehiculoId: number | null; tipo: string }) {
    setPanelAbierto(d);
    setForm(FORM_VACIO);
    setArchivo(null);
    setErrorForm("");
  }

  async function enviar() {
    if (!panelAbierto) return;
    if (!archivo) { setErrorForm("Adjunta la foto o el PDF del documento."); return; }
    setSubiendo(true); setErrorForm("");
    try {
      const data = await fileABase64(archivo);
      const r = await fetch("/api/tercerizadas/documentos-proveedor", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          token, accion: "subir",
          documentoId: panelAbierto.documentoId, vehiculoId: panelAbierto.vehiculoId, tipo: panelAbierto.tipo,
          numero: form.numero, fechaVencimientoPropuesta: form.fechaVencimientoPropuesta || null,
          entidadEmisora: form.entidadEmisora, observaciones: form.observaciones,
          archivo: { data, mediaType: archivo.type || "application/octet-stream", filename: archivo.name },
        }),
      });
      const j = await r.json();
      if (!r.ok) throw new Error(j.error || "No se pudo subir el documento.");
      setPanelAbierto(null);
      await cargar();
    } catch (e: any) {
      setErrorForm(String(e?.message ?? e));
    } finally {
      setSubiendo(false);
    }
  }

  if (cargando)
    return <div className="min-h-screen grid place-items-center text-gray-400 text-sm">Cargando…</div>;

  if (error && !empresa)
    return (
      <div className="min-h-screen grid place-items-center p-6">
        <div className="max-w-md text-center">
          <div className="text-4xl mb-3">🔗</div>
          <h1 className="text-lg font-black text-[#0b315f] mb-1">Enlace no válido</h1>
          <p className="text-sm text-gray-500">{error}</p>
          <p className="text-xs text-gray-400 mt-4">Si el enlace le llegó por correo o WhatsApp, escríbanos y le enviamos uno nuevo.</p>
        </div>
      </div>
    );

  const placaDe = (id: number | null) => vehiculos.find(v => v.id === id)?.placa || null;

  const claveRevision = (documentoId: number | null, tipo: string, vehiculoId: number | null) =>
    documentoId ? `doc:${documentoId}` : `nuevo:${tipo}:${vehiculoId ?? "emp"}`;

  function estadoAdjunto(documentoId: number | null, tipo: string, vehiculoId: number | null) {
    const rev = ultimaRevisionPor.get(claveRevision(documentoId, tipo, vehiculoId));
    if (rev?.estado === "pendiente") return { badge: "🕓 En revisión — un operador la va a validar", tono: "info" as const };
    if (rev?.estado === "rechazado") return { badge: `⚠️ Observado: ${rev.motivo_rechazo || "sin motivo indicado"}`, tono: "error" as const };
    return null;
  }

  const ordenados = [...documentos].sort((a, b) => {
    const peso = (e: string) => (e === "vencido" ? 0 : e === "por_vencer" ? 1 : e === "sin_fecha" ? 2 : 3);
    return peso(a.estado) - peso(b.estado);
  });

  return (
    <div className="min-h-screen bg-slate-100">
      <div className="bg-[#0b315f] text-white">
        <div className="max-w-2xl mx-auto px-5 py-6">
          <p className="text-[11px] uppercase tracking-widest text-white/60">Autoservicio de documentos</p>
          <h1 className="text-xl font-black mt-1">{empresa.razon_social}</h1>
          <p className="text-sm text-white/70 mt-1">Suba sus documentos actualizados — un operador los revisa antes de darlos por válidos.</p>
        </div>
      </div>

      <div className="max-w-2xl mx-auto px-5 py-6 grid gap-3">
        {ordenados.length === 0 && (
          <div className="bg-white rounded-2xl border shadow-sm p-6 text-center text-sm text-gray-400">
            No hay documentos registrados todavía.
          </div>
        )}

        {ordenados.map(d => {
          const cfg = ESTADO_CFG[d.estado];
          const adj = estadoAdjunto(d.id, d.tipo, d.vehiculo_id);
          const placa = placaDe(d.vehiculo_id);
          return (
            <div key={d.id} className="bg-white rounded-2xl border shadow-sm p-4">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <p className="font-bold text-[#0b315f] text-sm">{d.tipo}</p>
                  <p className="text-xs text-gray-400 mt-0.5">{placa ? `Unidad ${placa}` : "Empresa (general)"} · Vence {fmtFecha(d.fecha_vencimiento)}</p>
                </div>
                <span className="text-[11px] font-bold px-2 py-1 rounded-lg whitespace-nowrap" style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>
              </div>
              {adj ? (
                <p className={`text-xs mt-3 font-semibold ${adj.tono === "error" ? "text-red-600" : "text-amber-700"}`}>{adj.badge}</p>
              ) : (
                (d.estado === "vencido" || d.estado === "por_vencer" || d.estado === "sin_fecha") && (
                  <button onClick={() => abrirPanel({ documentoId: d.id, vehiculoId: d.vehiculo_id, tipo: d.tipo })}
                    className="mt-3 text-xs font-bold text-white px-3 py-2 rounded-xl" style={{ background: "#0b315f" }}>
                    Subir documento actualizado
                  </button>
                )
              )}
            </div>
          );
        })}

        <div className="bg-white rounded-2xl border shadow-sm p-4">
          <p className="font-bold text-[#0b315f] text-sm mb-2">¿Falta un documento en la lista?</p>
          <div className="flex flex-wrap gap-2">
            {tiposObligatorios.filter(t => !documentos.some(d => d.tipo === t && d.vehiculo_id === null)).map(t => (
              <button key={t} onClick={() => abrirPanel({ documentoId: null, vehiculoId: null, tipo: t })}
                className="text-[11px] font-bold px-2.5 py-1.5 rounded-lg border border-gray-300 text-gray-600 hover:border-[#0b315f] hover:text-[#0b315f]">
                {t} +
              </button>
            ))}
          </div>
        </div>
      </div>

      {panelAbierto && (
        <div className="fixed inset-0 bg-black/40 flex items-end sm:items-center justify-center z-50 p-0 sm:p-4" onClick={() => !subiendo && setPanelAbierto(null)}>
          <div className="bg-white rounded-t-2xl sm:rounded-2xl w-full sm:max-w-md p-5 max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Subir documento</p>
            <h2 className="font-black text-[#0b315f] text-lg mb-4">{panelAbierto.tipo}{placaDe(panelAbierto.vehiculoId) ? ` · ${placaDe(panelAbierto.vehiculoId)}` : ""}</h2>

            <div className="grid gap-3">
              <div>
                <label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Foto o PDF del documento *</label>
                <input type="file" accept="image/*,application/pdf" onChange={e => setArchivo(e.target.files?.[0] || null)}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5" />
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Nueva fecha de vencimiento</label>
                <input type="date" value={form.fechaVencimientoPropuesta} onChange={e => setForm(p => ({ ...p, fechaVencimientoPropuesta: e.target.value }))}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5" />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">N° documento</label>
                  <input value={form.numero} onChange={e => setForm(p => ({ ...p, numero: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5" />
                </div>
                <div>
                  <label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Entidad emisora</label>
                  <input value={form.entidadEmisora} onChange={e => setForm(p => ({ ...p, entidadEmisora: e.target.value }))}
                    className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5" />
                </div>
              </div>
              <div>
                <label className="block text-[11px] font-bold uppercase text-gray-400 mb-1">Observaciones (opcional)</label>
                <textarea value={form.observaciones} onChange={e => setForm(p => ({ ...p, observaciones: e.target.value }))} rows={2}
                  className="w-full text-sm border border-gray-200 rounded-xl px-3 py-2.5" />
              </div>
            </div>

            {errorForm && <p className="text-xs text-red-600 mt-3">{errorForm}</p>}

            <div className="flex gap-2 mt-5">
              <button onClick={enviar} disabled={subiendo}
                className="flex-1 py-3 rounded-xl text-sm font-bold text-white disabled:opacity-50" style={{ background: "#0b315f" }}>
                {subiendo ? "Enviando…" : "Enviar para revisión"}
              </button>
              <button onClick={() => setPanelAbierto(null)} disabled={subiendo}
                className="px-4 py-3 rounded-xl text-sm font-bold border text-gray-600">Cancelar</button>
            </div>
            <p className="text-[11px] text-gray-400 mt-3 text-center">Un operador revisará el documento antes de darlo por actualizado en el sistema.</p>
          </div>
        </div>
      )}
    </div>
  );
}
