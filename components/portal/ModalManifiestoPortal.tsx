"use client";

// components/portal/ModalManifiestoPortal.tsx
// Modal de gestión de manifiesto para el portal cliente.
// Similar a ModalManifiesto del ERP pero adaptado al portal:
//   - Inline styles (paleta C.* del portal)
//   - Sin tab de paradas (solo pasajeros)
//   - Modo readonly para servicios finalizados
//   - Llama a /api/portal/manifiesto (verifica cliente_id)

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { parsearManifiesto, descargarPlantillaPortal } from "@/lib/manifiesto-csv";

// ─── Paleta (misma que page.tsx) ─────────────────────────────────────────────
const C = {
  bg:         "#F6F4EE",
  paper:      "#FAF9F4",
  surface:    "#FFFFFF",
  surfaceAlt: "#F1EFE8",
  ink:        "#0A0E1A",
  ink2:       "#1F2433",
  mute:       "#6B6F7C",
  mute2:      "#9AA0AC",
  line:       "#E6E2D6",
  line2:      "#D5D1C5",
  navy:       "#0b315f",
  navyDeep:   "#071f3d",
  navyTint:   "#EAEFF6",
  navyTint2:  "#D5DDEA",
  success:    "#15803d",
  successTint:"#E3F1E6",
  warn:       "#A65B0A",
  warnTint:   "#FBEFD5",
  danger:     "#B91C1C",
  dangerTint: "#FCE5E2",
  info:       "#1d4ed8",
  infoTint:   "#E1E9FB",
  fontSans:   '"Manrope", -apple-system, system-ui, sans-serif',
  fontMono:   '"JetBrains Mono", ui-monospace, monospace',
};

// ─── Tipos ────────────────────────────────────────────────────────────────────
type Parada = {
  id: number;
  orden: number;
  nombre: string;
  hora_estimada: string | null;
};

type Pasajero = {
  id: number;
  nombre: string;
  dni: string;
  empresa: string | null;
  telefono: string | null;
};

type AsignacionParada = {
  pasajero_id: number;
  parada_id: number;
  estado_abordaje: string;
};

type Mensaje = { tipo: "ok" | "err" | "warn"; texto: string };

type AddForm = { nombre: string; dni: string; empresa: string; telefono: string; edad: string; parada_id: string };

export type Props = {
  reservaId:  number;
  clienteId:  number;
  readonly:   boolean;
  onClose:    () => void;
  onChanged?: () => void;
};

const ESTADOS_EDITABLES = ["pendiente","confirmado","confirmada","por_confirmar","programada"];

// ─── Helpers ─────────────────────────────────────────────────────────────────
async function callApi(body: Record<string, unknown>): Promise<{ ok: boolean; data: any }> {
  const res = await fetch("/api/portal/manifiesto", {
    method:  "POST",
    headers: { "Content-Type": "application/json" },
    body:    JSON.stringify(body),
  });
  const data = await res.json();
  return { ok: res.ok, data };
}

// ─── Componente ──────────────────────────────────────────────────────────────
export default function ModalManifiestoPortal({ reservaId, clienteId, readonly, onClose, onChanged }: Props) {
  const [paradas,     setParadas]     = useState<Parada[]>([]);
  const [pasajeros,   setPasajeros]   = useState<Pasajero[]>([]);
  const [asig,        setAsig]        = useState<Record<number, AsignacionParada>>({});
  const [loading,     setLoading]     = useState(true);
  const [saving,      setSaving]      = useState(false);
  const [mensaje,     setMensaje]     = useState<Mensaje | null>(null);
  const [busqueda,    setBusqueda]    = useState("");
  const [importando,  setImportando]  = useState(false);
  const [mostrarForm, setMostrarForm] = useState(false);

  // ── Config de ruta ────────────────────────────────────────────────────────
  const [mostrarConfig,         setMostrarConfig]         = useState(false);
  const [rutaNombre,            setRutaNombre]            = useState("");
  const [permiteAutoseleccion,  setPermiteAutoseleccion]  = useState(false);
  const [permiteCambioParadero, setPermiteCambioParadero] = useState(false);
  const [configGuardando,       setConfigGuardando]       = useState(false);

  const fileRef = useRef<HTMLInputElement>(null);

  const emptyForm: AddForm = { nombre: "", dni: "", empresa: "", telefono: "", edad: "", parada_id: "" };
  const [form, setForm] = useState<AddForm>(emptyForm);

  // ── Carga inicial ─────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setLoading(true);
    try {
      // 0. Config de la reserva (ruta_nombre + toggles)
      const { data: resData } = await supabase
        .from("reservas")
        .select("ruta_nombre,permite_autoseleccion,permite_cambio_paradero")
        .eq("id", reservaId)
        .maybeSingle();
      if (resData) {
        setRutaNombre(resData.ruta_nombre || "");
        setPermiteAutoseleccion(!!resData.permite_autoseleccion);
        setPermiteCambioParadero(!!resData.permite_cambio_paradero);
      }

      // 1. Paradas del servicio
      const { data: parData } = await supabase
        .from("paradas")
        .select("id,orden,nombre,hora_estimada")
        .eq("reserva_id", reservaId)
        .order("orden");
      const pars = (parData || []) as Parada[];
      setParadas(pars);
      const paradaIds = pars.map(p => p.id);

      // 2. Pasajeros ad-hoc de esta reserva (reserva_id = X)
      const { data: paxAdhoc } = await supabase
        .from("pasajeros")
        .select("id,nombre,dni,empresa,telefono")
        .eq("reserva_id", reservaId);
      const adhocList = (paxAdhoc || []) as Pasajero[];
      const adhocIds  = new Set(adhocList.map(p => p.id));

      // 3. Asignaciones de pasajeros_parada para las paradas de esta reserva
      const map: Record<number, AsignacionParada> = {};
      let extraPaxIds: number[] = [];

      if (paradaIds.length > 0) {
        const { data: ppData } = await supabase
          .from("pasajeros_parada")
          .select("pasajero_id,parada_id,estado_abordaje")
          .in("parada_id", paradaIds);
        (ppData || []).forEach((row: any) => {
          map[row.pasajero_id] = {
            pasajero_id:     row.pasajero_id,
            parada_id:       row.parada_id,
            estado_abordaje: row.estado_abordaje || "Pendiente",
          };
          // Pasajeros del registro global (no son ad-hoc de esta reserva)
          if (!adhocIds.has(row.pasajero_id)) {
            extraPaxIds.push(row.pasajero_id);
          }
        });
      }
      setAsig(map);

      // 4. Cargar datos de pasajeros del registro global que están asignados aquí
      let globalList: Pasajero[] = [];
      const uniqueExtraIds = [...new Set(extraPaxIds)];
      if (uniqueExtraIds.length > 0) {
        const { data: paxGlobal } = await supabase
          .from("pasajeros")
          .select("id,nombre,dni,empresa,telefono")
          .in("id", uniqueExtraIds);
        globalList = (paxGlobal || []) as Pasajero[];
      }

      // 5. Merge: ad-hoc primero, luego globales (ya deduplicados)
      setPasajeros([...adhocList, ...globalList]);
    } finally {
      setLoading(false);
    }
  }, [reservaId]);

  useEffect(() => { cargar(); }, [cargar]);

  // ── Helpers UI ────────────────────────────────────────────────────────────
  function showMsg(tipo: Mensaje["tipo"], texto: string) {
    setMensaje({ tipo, texto });
  }

  const paxFiltrados = useMemo(() => {
    const q = busqueda.toLowerCase().trim();
    if (!q) return pasajeros;
    return pasajeros.filter(p =>
      p.nombre.toLowerCase().includes(q) ||
      p.dni.toLowerCase().includes(q) ||
      (p.empresa || "").toLowerCase().includes(q)
    );
  }, [pasajeros, busqueda]);

  // ── Agregar pasajero manualmente ──────────────────────────────────────────
  async function agregarPasajero() {
    if (!form.nombre.trim() || !form.dni.trim()) {
      showMsg("err", "Nombre y DNI son requeridos");
      return;
    }
    setSaving(true);
    setMensaje(null);
    try {
      const body: Record<string, unknown> = {
        action:    "add",
        cliente_id: clienteId,
        reserva_id: reservaId,
        nombre:    form.nombre.trim(),
        dni:       form.dni.trim(),
        empresa:   form.empresa.trim() || null,
        telefono:  form.telefono.trim() || null,
        edad:      form.edad.trim() || null,
      };
      if (form.parada_id) body.parada_id = Number(form.parada_id);

      const { ok, data } = await callApi(body);
      if (!ok) { showMsg("err", data.error || "Error al agregar pasajero"); return; }

      showMsg("ok", "Pasajero agregado ✓");
      setForm(emptyForm);
      setMostrarForm(false);
      await cargar();
      onChanged?.();
    } finally {
      setSaving(false);
    }
  }

  // ── Eliminar pasajero ─────────────────────────────────────────────────────
  async function eliminarPasajero(paxId: number, nombre: string) {
    if (!confirm(`¿Quitar a "${nombre}" del manifiesto?`)) return;
    setMensaje(null);
    try {
      const { ok, data } = await callApi({
        action:    "remove",
        cliente_id: clienteId,
        reserva_id: reservaId,
        pasajero_id: paxId,
      });
      if (!ok) { showMsg("err", data.error || "Error al eliminar"); return; }
      showMsg("ok", "Pasajero eliminado");
      await cargar();
      onChanged?.();
    } catch {
      showMsg("err", "Error de conexión");
    }
  }

  // ── Asignar / cambiar parada ──────────────────────────────────────────────
  async function asignarParada(paxId: number, paradaId: number | null) {
    setMensaje(null);
    try {
      const { ok, data } = await callApi({
        action:    "assign_parada",
        cliente_id: clienteId,
        reserva_id: reservaId,
        pasajero_id: paxId,
        parada_id:  paradaId,
      });
      if (!ok) { showMsg("err", data.error || "Error al asignar parada"); return; }
      // Actualizar estado local optimisticamente
      setAsig(prev => {
        const cp = { ...prev };
        if (paradaId) {
          cp[paxId] = { pasajero_id: paxId, parada_id: paradaId, estado_abordaje: "Pendiente" };
        } else {
          delete cp[paxId];
        }
        return cp;
      });
      onChanged?.();
    } catch {
      showMsg("err", "Error de conexión");
    }
  }

  // ── Importar Excel ────────────────────────────────────────────────────────
  async function handleArchivo(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setImportando(true);
    setMensaje(null);
    try {
      const resultado = await parsearManifiesto(file);

      if (resultado.ok.length === 0) {
        showMsg("err", `Sin filas válidas. ${resultado.errores[0]?.motivo || "Revisa el formato."}`);
        return;
      }

      const dnisExistentes = new Set(pasajeros.map(p => p.dni));
      const nuevos = resultado.ok.filter(p => !dnisExistentes.has(p.dni));
      const duplicados = resultado.ok.length - nuevos.length;

      if (nuevos.length === 0) {
        showMsg("warn", `Todos los ${resultado.ok.length} pasajeros ya están en este servicio.`);
        return;
      }

      const { ok, data } = await callApi({
        action:    "bulk",
        cliente_id: clienteId,
        reserva_id: reservaId,
        pasajeros: nuevos.map(p => ({
          nombre:       p.nombre,
          dni:          p.dni,
          empresa:      p.empresa,
          telefono:     p.telefono,
          edad:         p.edad,
          parada_nombre: p.parada || undefined,
        })),
      });

      if (!ok) { showMsg("err", data.error || "Error al importar"); return; }

      const partes = [
        `${data.added} pasajero(s) importado(s)`,
        duplicados > 0 ? `${duplicados} duplicado(s) omitido(s)` : "",
        resultado.errores.length > 0 ? `${resultado.errores.length} fila(s) con error` : "",
      ].filter(Boolean);
      showMsg("ok", partes.join(" · "));
      await cargar();
      onChanged?.();
    } catch (err: any) {
      showMsg("err", "Error al leer archivo: " + (err?.message || err));
    } finally {
      setImportando(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  }

  // ── Guardar config de ruta ────────────────────────────────────────────────
  async function guardarConfig(patch: { ruta_nombre?: string; permite_autoseleccion?: boolean; permite_cambio_paradero?: boolean }) {
    setConfigGuardando(true);
    try {
      await callApi({ action: "actualizar_config", cliente_id: clienteId, reserva_id: reservaId, ...patch });
    } finally {
      setConfigGuardando(false);
    }
  }

  // ── Descarga plantilla ─────────────────────────────────────────────────────
  function descargarPlantilla() {
    descargarPlantillaPortal(paradas.map(p => ({ orden: p.orden, nombre: p.nombre })));
  }

  // ─── Colores de estado abordaje ───────────────────────────────────────────
  const estadoColor: Record<string, { bg: string; c: string }> = {
    "Pendiente": { bg: C.warnTint,    c: C.warn    },
    "Abordado":  { bg: C.successTint, c: C.success },
    "No Show":   { bg: C.dangerTint,  c: C.danger  },
    "Cancelado": { bg: C.surfaceAlt,  c: C.mute    },
  };

  const total      = pasajeros.length;
  const abordados  = Object.values(asig).filter(a => a.estado_abordaje === "Abordado").length;
  const sinParada  = pasajeros.filter(p => !asig[p.id]).length;
  const conParada  = total - sinParada;

  // ─── Render ───────────────────────────────────────────────────────────────
  return (
    <div
      style={{ position: "fixed", inset: 0, zIndex: 80, background: "rgba(7,20,40,0.6)", backdropFilter: "blur(3px)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16, fontFamily: C.fontSans }}
      onClick={onClose}
    >
      <div
        style={{ background: C.surface, borderRadius: 20, boxShadow: "0 24px 80px rgba(0,0,0,0.3)", width: "100%", maxWidth: 860, maxHeight: "90vh", display: "flex", flexDirection: "column", overflow: "hidden" }}
        onClick={e => e.stopPropagation()}
      >
        {/* ── Cabecera ── */}
        <div style={{ background: C.navyDeep, padding: "18px 24px", display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
            <div style={{ width: 38, height: 38, borderRadius: 10, background: "rgba(255,255,255,0.15)", display: "flex", alignItems: "center", justifyContent: "center" }}>
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2">
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                <rect x="9" y="3" width="6" height="4" rx="1"/>
                <path d="M9 12h6M9 16h4"/>
              </svg>
            </div>
            <div>
              <p style={{ color: "rgba(255,255,255,0.6)", fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.1em", margin: 0 }}>
                Servicio #{reservaId}
              </p>
              <p style={{ color: "white", fontWeight: 800, fontSize: 15, margin: "2px 0 0" }}>
                Manifiesto de pasajeros
                {readonly && (
                  <span style={{ marginLeft: 10, fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 20, background: "rgba(255,255,255,0.12)", color: "rgba(255,255,255,0.7)" }}>
                    Solo lectura
                  </span>
                )}
              </p>
            </div>
          </div>
          <button
            onClick={onClose}
            style={{ background: "rgba(255,255,255,0.1)", border: "none", borderRadius: 10, width: 34, height: 34, color: "white", fontSize: 18, cursor: "pointer", display: "flex", alignItems: "center", justifyContent: "center", fontFamily: C.fontSans }}
          >
            ×
          </button>
        </div>

        {/* ── KPIs ── */}
        <div style={{ display: "grid", gridTemplateColumns: "repeat(4,1fr)", gap: 1, background: C.line, borderBottom: `1px solid ${C.line}`, flexShrink: 0 }}>
          {[
            { label: "Total",      val: total,    accent: C.navy,    bg: C.navyTint   },
            { label: "Abordados",  val: abordados, accent: C.success, bg: C.successTint },
            { label: "Con parada", val: conParada, accent: C.info,    bg: C.infoTint   },
            { label: "Paradas",    val: paradas.length, accent: C.warn, bg: C.warnTint },
          ].map(k => (
            <div key={k.label} style={{ padding: "12px 16px", background: k.bg }}>
              <p style={{ fontFamily: C.fontMono, fontSize: 22, fontWeight: 900, color: k.accent, margin: 0 }}>{k.val}</p>
              <p style={{ fontSize: 10, fontWeight: 700, color: k.accent, opacity: 0.75, textTransform: "uppercase", letterSpacing: "0.06em", margin: "3px 0 0" }}>{k.label}</p>
            </div>
          ))}
        </div>

        {/* ── Barra de herramientas ── */}
        {!readonly && (
          <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.line}`, display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", background: C.paper, flexShrink: 0 }}>
            {/* Agregar manualmente */}
            <button
              onClick={() => { setMostrarForm(v => !v); setMensaje(null); }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1.5px solid ${mostrarForm ? C.navy : C.line2}`, background: mostrarForm ? C.navyTint : C.surface, color: mostrarForm ? C.navy : C.ink2, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: C.fontSans }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
              {mostrarForm ? "Cancelar" : "Agregar pasajero"}
            </button>

            {/* Input Excel oculto */}
            <input ref={fileRef} type="file" accept=".csv,.xls,.xlsx" style={{ display: "none" }} onChange={handleArchivo} />
            <button
              onClick={() => fileRef.current?.click()}
              disabled={importando}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1.5px solid ${C.line2}`, background: C.surface, color: C.ink2, fontWeight: 700, fontSize: 12, cursor: importando ? "not-allowed" : "pointer", opacity: importando ? 0.6 : 1, fontFamily: C.fontSans }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/></svg>
              {importando ? "Importando…" : "Importar Excel"}
            </button>

            {/* Plantilla */}
            <button
              onClick={descargarPlantilla}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1.5px solid ${C.line2}`, background: C.surface, color: C.mute, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: C.fontSans }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>
              Plantilla Excel
            </button>

            {/* Configurar ruta */}
            <button
              onClick={() => { setMostrarConfig(v => !v); setMensaje(null); }}
              style={{ display: "flex", alignItems: "center", gap: 6, padding: "7px 14px", borderRadius: 9, border: `1.5px solid ${mostrarConfig ? C.navy : C.line2}`, background: mostrarConfig ? C.navyTint : C.surface, color: mostrarConfig ? C.navy : C.ink2, fontWeight: 700, fontSize: 12, cursor: "pointer", fontFamily: C.fontSans }}
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="3"/><path d="M19.07 4.93a10 10 0 0 1 0 14.14M4.93 4.93a10 10 0 0 0 0 14.14"/></svg>
              Configurar ruta
            </button>

            {/* Búsqueda */}
            <div style={{ flex: 1, minWidth: 160 }}>
              <input
                value={busqueda}
                onChange={e => setBusqueda(e.target.value)}
                placeholder="Buscar nombre, DNI o empresa…"
                style={{ width: "100%", padding: "7px 12px", borderRadius: 9, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontSans, outline: "none", boxSizing: "border-box", background: C.surface, color: C.ink2 }}
              />
            </div>
          </div>
        )}

        {/* Búsqueda en modo readonly */}
        {readonly && (
          <div style={{ padding: "10px 16px", borderBottom: `1px solid ${C.line}`, background: C.paper, flexShrink: 0 }}>
            <input
              value={busqueda}
              onChange={e => setBusqueda(e.target.value)}
              placeholder="Buscar nombre, DNI o empresa…"
              style={{ width: "100%", maxWidth: 320, padding: "7px 12px", borderRadius: 9, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontSans, outline: "none", boxSizing: "border-box", background: C.surface, color: C.ink2 }}
            />
          </div>
        )}

        {/* ── Panel configuración de ruta ── */}
        {mostrarConfig && !readonly && (
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.line}`, background: C.navyTint, flexShrink: 0 }}>
            <p style={{ fontFamily: C.fontMono, fontSize: 9.5, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 12px" }}>
              Configuración de ruta {configGuardando && <span style={{ fontWeight: 400, opacity: 0.6 }}>· guardando…</span>}
            </p>
            <div style={{ display: "flex", gap: 12, flexWrap: "wrap", alignItems: "flex-end" }}>
              {/* Nombre de ruta */}
              <div style={{ flex: "1 1 220px" }}>
                <p style={{ fontSize: 9.5, fontWeight: 700, color: C.navy, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>Nombre de ruta</p>
                <input
                  value={rutaNombre}
                  onChange={e => setRutaNombre(e.target.value)}
                  onBlur={e => guardarConfig({ ruta_nombre: e.target.value.trim() })}
                  placeholder="Ej. RUTA A CHORRILLOS - CALLAO"
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.navyTint2}`, fontSize: 12, fontFamily: C.fontSans, outline: "none", boxSizing: "border-box", background: C.surface }}
                />
                <p style={{ fontSize: 10, color: C.mute, margin: "3px 0 0" }}>Visible al pasajero al elegir su bus</p>
              </div>

              {/* Toggles */}
              <div style={{ display: "flex", flexDirection: "column", gap: 10, flex: "1 1 200px" }}>
                {/* Toggle autoselección */}
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div
                    onClick={() => { const v = !permiteAutoseleccion; setPermiteAutoseleccion(v); guardarConfig({ permite_autoseleccion: v }); }}
                    style={{ width: 38, height: 22, borderRadius: 11, background: permiteAutoseleccion ? C.navy : C.line2, position: "relative", transition: "background 0.2s", flexShrink: 0, cursor: "pointer" }}
                  >
                    <div style={{ position: "absolute", top: 3, left: permiteAutoseleccion ? 19 : 3, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 12, color: C.ink2 }}>Permitir que pasajeros elijan su paradero</p>
                    <p style={{ margin: "1px 0 0", fontSize: 10, color: C.mute }}>Pasajeros sin paradero asignado podrán seleccionar uno</p>
                  </div>
                </label>

                {/* Toggle cambio de paradero */}
                <label style={{ display: "flex", alignItems: "center", gap: 10, cursor: "pointer" }}>
                  <div
                    onClick={() => { const v = !permiteCambioParadero; setPermiteCambioParadero(v); guardarConfig({ permite_cambio_paradero: v }); }}
                    style={{ width: 38, height: 22, borderRadius: 11, background: permiteCambioParadero ? C.navy : C.line2, position: "relative", transition: "background 0.2s", flexShrink: 0, cursor: "pointer" }}
                  >
                    <div style={{ position: "absolute", top: 3, left: permiteCambioParadero ? 19 : 3, width: 16, height: 16, borderRadius: "50%", background: "white", transition: "left 0.2s", boxShadow: "0 1px 3px rgba(0,0,0,0.2)" }} />
                  </div>
                  <div>
                    <p style={{ margin: 0, fontWeight: 700, fontSize: 12, color: C.ink2 }}>Permitir cambio de paradero</p>
                    <p style={{ margin: "1px 0 0", fontSize: 10, color: C.mute }}>Pasajeros con paradero asignado podrán modificarlo</p>
                  </div>
                </label>
              </div>
            </div>
          </div>
        )}

        {/* ── Formulario de agregar ── */}
        {mostrarForm && !readonly && (
          <div style={{ padding: "14px 16px", borderBottom: `1px solid ${C.line}`, background: C.warnTint, flexShrink: 0 }}>
            <p style={{ fontFamily: C.fontMono, fontSize: 9.5, fontWeight: 700, color: C.warn, textTransform: "uppercase", letterSpacing: "0.1em", margin: "0 0 10px" }}>
              Nuevo pasajero
            </p>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end" }}>
              {/* Nombre */}
              <div style={{ flex: "2 1 170px" }}>
                <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>Nombre completo *</p>
                <input
                  value={form.nombre}
                  onChange={e => setForm(f => ({ ...f, nombre: e.target.value }))}
                  onKeyDown={e => e.key === "Enter" && agregarPasajero()}
                  placeholder="Ej. Juan Pérez López"
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontSans, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              {/* DNI */}
              <div style={{ flex: "0 1 120px" }}>
                <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>DNI *</p>
                <input
                  value={form.dni}
                  onChange={e => setForm(f => ({ ...f, dni: e.target.value }))}
                  onKeyDown={e => e.key === "Enter" && agregarPasajero()}
                  placeholder="12345678"
                  maxLength={12}
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontMono, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              {/* Empresa */}
              <div style={{ flex: "1 1 140px" }}>
                <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>Empresa</p>
                <input
                  value={form.empresa}
                  onChange={e => setForm(f => ({ ...f, empresa: e.target.value }))}
                  placeholder="Opcional"
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontSans, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              {/* Teléfono */}
              <div style={{ flex: "0 1 130px" }}>
                <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>Teléfono</p>
                <input
                  value={form.telefono}
                  onChange={e => setForm(f => ({ ...f, telefono: e.target.value }))}
                  placeholder="999111222"
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontMono, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              {/* Edad */}
              <div style={{ flex: "0 1 90px" }}>
                <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>Edad</p>
                <input
                  value={form.edad}
                  onChange={e => setForm(f => ({ ...f, edad: e.target.value.replace(/\D/g, "").slice(0, 3) }))}
                  inputMode="numeric"
                  placeholder="Años"
                  style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontMono, outline: "none", boxSizing: "border-box" }}
                />
              </div>
              {/* Parada */}
              {paradas.length > 0 && (
                <div style={{ flex: "1 1 170px" }}>
                  <p style={{ fontSize: 9.5, fontWeight: 700, color: C.mute, textTransform: "uppercase", letterSpacing: "0.05em", margin: "0 0 4px" }}>Parada de abordaje</p>
                  <select
                    value={form.parada_id}
                    onChange={e => setForm(f => ({ ...f, parada_id: e.target.value }))}
                    style={{ width: "100%", padding: "7px 10px", borderRadius: 8, border: `1px solid ${C.line2}`, fontSize: 12, fontFamily: C.fontSans, outline: "none", boxSizing: "border-box", background: C.surface }}
                  >
                    <option value="">– Sin asignar –</option>
                    {paradas.map(p => (
                      <option key={p.id} value={p.id}>{p.orden}. {p.nombre}</option>
                    ))}
                  </select>
                </div>
              )}
              {/* Botón */}
              <button
                onClick={agregarPasajero}
                disabled={saving || !form.nombre.trim() || !form.dni.trim()}
                style={{ padding: "7px 18px", borderRadius: 8, border: "none", background: form.nombre.trim() && form.dni.trim() ? C.navy : C.mute2, color: "white", fontWeight: 700, fontSize: 12, cursor: saving || !form.nombre.trim() || !form.dni.trim() ? "not-allowed" : "pointer", fontFamily: C.fontSans, flexShrink: 0, whiteSpace: "nowrap" }}
              >
                {saving ? "Guardando…" : "Agregar"}
              </button>
            </div>
          </div>
        )}

        {/* ── Mensaje de feedback ── */}
        {mensaje && (
          <div style={{ margin: "10px 16px 0", padding: "10px 14px", borderRadius: 10, fontSize: 12.5, fontWeight: 600, display: "flex", alignItems: "center", justifyContent: "space-between", flexShrink: 0,
            background: mensaje.tipo === "ok" ? C.successTint : mensaje.tipo === "warn" ? C.warnTint : C.dangerTint,
            color:      mensaje.tipo === "ok" ? C.success      : mensaje.tipo === "warn" ? C.warn      : C.danger,
          }}>
            <span>{mensaje.texto}</span>
            <button onClick={() => setMensaje(null)} style={{ background: "none", border: "none", cursor: "pointer", color: "inherit", fontSize: 16, lineHeight: 1, padding: "0 4px", fontFamily: C.fontSans }}>×</button>
          </div>
        )}

        {/* ── Tabla de pasajeros ── */}
        <div style={{ flex: 1, overflowY: "auto", padding: "0 0 8px" }}>
          {loading ? (
            <div style={{ padding: "56px 24px", textAlign: "center" }}>
              <div style={{ width: 36, height: 36, border: `3px solid ${C.navyTint2}`, borderTopColor: C.navy, borderRadius: "50%", animation: "spin 0.8s linear infinite", margin: "0 auto 14px" }} />
              <p style={{ color: C.mute, fontSize: 13, margin: 0 }}>Cargando manifiesto…</p>
            </div>
          ) : paxFiltrados.length === 0 ? (
            <div style={{ padding: "56px 24px", textAlign: "center" }}>
              <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke={C.line2} strokeWidth="1.2" style={{ display: "block", margin: "0 auto 14px" }}>
                <path d="M9 5H7a2 2 0 0 0-2 2v12a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2h-2"/>
                <rect x="9" y="3" width="6" height="4" rx="1"/>
                <path d="M9 12h6M9 16h4"/>
              </svg>
              <p style={{ color: C.ink2, fontWeight: 700, margin: 0, fontSize: 14 }}>
                {pasajeros.length === 0 ? "Manifiesto vacío" : "Sin resultados"}
              </p>
              <p style={{ color: C.mute, fontSize: 12, margin: "6px 0 0" }}>
                {pasajeros.length === 0 && !readonly
                  ? "Agrega pasajeros manualmente o importa desde Excel."
                  : pasajeros.length === 0
                    ? "Este servicio no tiene pasajeros registrados."
                    : "Ningún pasajero coincide con la búsqueda."}
              </p>
            </div>
          ) : (
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead style={{ position: "sticky", top: 0, zIndex: 2 }}>
                <tr style={{ background: C.surfaceAlt, borderBottom: `1.5px solid ${C.line2}` }}>
                  <th style={{ padding: "9px 14px", textAlign: "left", fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase", letterSpacing: "0.07em", width: 36 }}>#</th>
                  <th style={{ padding: "9px 14px", textAlign: "left", fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase", letterSpacing: "0.07em" }}>Pasajero</th>
                  <th style={{ padding: "9px 14px", textAlign: "left", fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase", letterSpacing: "0.07em", width: 105 }}>DNI</th>
                  <th style={{ padding: "9px 14px", textAlign: "left", fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase", letterSpacing: "0.07em" }}>Empresa</th>
                  <th style={{ padding: "9px 14px", textAlign: "left", fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase", letterSpacing: "0.07em", minWidth: 170 }}>
                    {readonly ? "Parada" : "Parada de abordaje"}
                  </th>
                  <th style={{ padding: "9px 14px", textAlign: "left", fontSize: 9.5, fontWeight: 800, color: C.mute, textTransform: "uppercase", letterSpacing: "0.07em", width: 90 }}>Estado</th>
                  {!readonly && (
                    <th style={{ padding: "9px 14px", width: 48 }} />
                  )}
                </tr>
              </thead>
              <tbody>
                {paxFiltrados.map((p, idx) => {
                  const a      = asig[p.id];
                  const estado = a?.estado_abordaje || "Pendiente";
                  const cfg    = estadoColor[estado] || estadoColor["Pendiente"];
                  const paradaNombre = a ? paradas.find(par => par.id === a.parada_id)?.nombre : null;
                  const rowBg  = idx % 2 === 0 ? C.surface : C.paper;
                  return (
                    <tr key={p.id}
                      onMouseEnter={e => (e.currentTarget.style.background = C.navyTint)}
                      onMouseLeave={e => (e.currentTarget.style.background = rowBg)}
                      style={{ borderBottom: `1px solid ${C.line}`, background: rowBg, transition: "background 0.1s" }}
                    >
                      {/* # */}
                      <td style={{ padding: "10px 14px", fontFamily: C.fontMono, fontSize: 10.5, color: C.mute2, textAlign: "center" }}>
                        {idx + 1}
                      </td>
                      {/* Nombre */}
                      <td style={{ padding: "10px 14px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
                          <div style={{ width: 30, height: 30, borderRadius: 8, background: C.navy, color: "white", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 12, fontWeight: 800, flexShrink: 0 }}>
                            {p.nombre.charAt(0).toUpperCase()}
                          </div>
                          <div>
                            <p style={{ fontWeight: 700, color: C.ink2, margin: 0, fontSize: 12.5 }}>{p.nombre}</p>
                            {p.telefono && (
                              <p style={{ fontFamily: C.fontMono, color: C.mute2, fontSize: 10, margin: "1px 0 0" }}>{p.telefono}</p>
                            )}
                          </div>
                        </div>
                      </td>
                      {/* DNI */}
                      <td style={{ padding: "10px 14px", fontFamily: C.fontMono, color: C.mute, fontSize: 11.5 }}>
                        {p.dni}
                      </td>
                      {/* Empresa */}
                      <td style={{ padding: "10px 14px", color: C.mute, fontSize: 11.5, maxWidth: 160, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                        {p.empresa || <span style={{ color: C.mute2 }}>–</span>}
                      </td>
                      {/* Parada */}
                      <td style={{ padding: "8px 14px" }}>
                        {readonly ? (
                          paradaNombre
                            ? <span style={{ fontSize: 11.5, color: C.ink2, fontWeight: 600 }}>{paradaNombre}</span>
                            : <span style={{ fontSize: 11, color: C.mute2 }}>Sin asignar</span>
                        ) : (
                          <select
                            value={a?.parada_id || ""}
                            onChange={e => asignarParada(p.id, e.target.value ? Number(e.target.value) : null)}
                            style={{ padding: "5px 8px", borderRadius: 7, border: `1px solid ${C.line2}`, fontSize: 11, fontFamily: C.fontSans, outline: "none", background: C.surface, color: C.ink2, maxWidth: 200 }}
                          >
                            <option value="">– Sin asignar –</option>
                            {paradas.map(par => (
                              <option key={par.id} value={par.id}>{par.orden}. {par.nombre}</option>
                            ))}
                          </select>
                        )}
                      </td>
                      {/* Estado */}
                      <td style={{ padding: "10px 14px" }}>
                        <span style={{ display: "inline-flex", alignItems: "center", fontSize: 10.5, fontWeight: 700, padding: "3px 10px", borderRadius: 20, background: cfg.bg, color: cfg.c, whiteSpace: "nowrap" }}>
                          {estado}
                        </span>
                      </td>
                      {/* Eliminar */}
                      {!readonly && (
                        <td style={{ padding: "8px 14px", textAlign: "center" }}>
                          <button
                            onClick={() => eliminarPasajero(p.id, p.nombre)}
                            title="Quitar del manifiesto"
                            style={{ background: "none", border: `1px solid ${C.line2}`, borderRadius: 7, width: 28, height: 28, cursor: "pointer", color: C.danger, display: "flex", alignItems: "center", justifyContent: "center" }}
                          >
                            <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                          </button>
                        </td>
                      )}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        {/* ── Footer ── */}
        <div style={{ padding: "12px 20px", borderTop: `1px solid ${C.line}`, background: C.paper, display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexShrink: 0 }}>
          <p style={{ fontSize: 11, color: C.mute, margin: 0 }}>
            {total} pasajero{total !== 1 ? "s" : ""} · {paradas.length} parada{paradas.length !== 1 ? "s" : ""} en itinerario
          </p>
          <button
            onClick={onClose}
            style={{ padding: "8px 22px", borderRadius: 10, border: "none", background: C.navy, color: "white", fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: C.fontSans }}
          >
            Cerrar
          </button>
        </div>
      </div>

      {/* Spinner CSS */}
      <style>{`@keyframes spin { to { transform: rotate(360deg); } }`}</style>
    </div>
  );
}
