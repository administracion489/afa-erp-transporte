"use client";

import React, { useEffect, useState, useCallback, useRef } from "react";
import { supabase } from "@/lib/supabase";
import { parsearManifiesto, descargarPlantilla } from "@/lib/manifiesto-csv";
import { parsearPortalUsuarios, descargarPlantillaPortalUsuarios, descargarCredencialesPortal, type CredencialExport } from "@/lib/portal-usuarios-csv";
import { useCanalesInvitacion } from "@/lib/useCanalesInvitacion";

/* ══════════════════════════════════════════════
   TYPES
══════════════════════════════════════════════ */
type TipoCliente    = "b2b" | "b2c";
type EstadoCliente  = "activo" | "inactivo" | "bloqueado";
type EstadoSolicitud = "pendiente" | "en_revision" | "aprobada" | "rechazada";
type Tab            = "clientes" | "solicitudes";
type SortDir        = "asc" | "desc";
type Toast          = { id: number; msg: string; type: "ok" | "error" | "info" };

type PasajeroCliente = {
  id: number;
  nombre: string;
  dni: string;
  telefono: string | null;
  empresa: string | null;
  email: string | null;
  pin_acceso: string | null;
  edad: number | null;
};

type Contacto = {
  id?: number;
  cliente_id?: number;
  tipo: "administrativo" | "operativo";
  nombre: string;
  apellido?: string;
  cargo?: string;
  telefono?: string;
  email?: string;
  principal?: boolean;
};

type Cliente = {
  id: number;
  nombre: string;
  tipo: TipoCliente;
  empresa?: string;
  ruc?: string;
  dni?: string;
  telefono?: string;
  email?: string;
  email_facturacion?: string;
  estado: EstadoCliente;
  direccion?: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
  ciudad?: string;
  notas?: string;
  tipo_empresa?: string;
  rubro?: string;
  nombre_comercial?: string;
  condicion_pago?: string;
  moneda?: string;
  tipo_comprobante?: string;
  volumen_compra?: string;
  como_nos_conocio?: string;
  servicios_interes?: string;
  contactos?: Contacto[];
  created_at?: string;
};

type SolContacto = { nombre?: string; apellido?: string; cargo?: string; telefono?: string; email?: string };

type Solicitud = {
  id: number;
  tipo_doc?: string;
  num_doc?: string;
  razon_social: string;
  nombre_comercial?: string;
  tipo_empresa?: string;
  rubro?: string;
  web?: string;
  direccion?: string;
  distrito?: string;
  provincia?: string;
  departamento?: string;
  email_facturacion?: string;
  contactos_administrativos?: SolContacto[];
  contactos_operativos?: SolContacto[];
  tipo_cliente?: string;
  condicion_pago?: string;
  moneda?: string;
  tipo_comprobante?: string;
  volumen_compra?: string;
  servicios_interes?: string;
  como_nos_conocio?: string;
  observaciones?: string;
  estado: EstadoSolicitud;
  nota_interna?: string;
  cliente_id?: number;
  revisado_por?: string;
  revisado_at?: string;
  created_at?: string;
};

type FormContacto = { nombre: string; apellido: string; cargo: string; telefono: string; email: string };

type PortalUsuario = { id: number; cliente_id: number; nombre: string; dni: string; cargo: string | null; rol: "admin" | "visor"; email: string | null; codigo_acceso: string; activo: boolean; created_at: string; modulos_permitidos: string[] | null; };
type DocCliente    = { id: number; nombre: string; categoria: string; storage_path: string; tamano_bytes: number | null; created_at: string; };

/* ══════════════════════════════════════════════
   CONSTANTS
══════════════════════════════════════════════ */
const SERVICIOS = ["Transporte de personal", "Transporte turístico", "Alquiler de vehículos", "Otros"];

const MODULOS_CTRL = [
  { id: "activos",     label: "En vivo · GPS" },
  { id: "historial",   label: "Historial de servicios" },
  { id: "reporte",     label: "Reportes de embarque" },
  { id: "facturacion", label: "Facturación" },
  { id: "documentos",  label: "Documentos" },
  { id: "cuenta",      label: "Cuenta y configuración" },
];

const ESTADO_CLIENTE: Record<EstadoCliente, { label: string; bg: string; color: string }> = {
  activo:    { label: "Activo",    bg: "#dcfce7", color: "#166534" },
  inactivo:  { label: "Inactivo",  bg: "#f3f4f6", color: "#4b5563" },
  bloqueado: { label: "Bloqueado", bg: "#fee2e2", color: "#991b1b" },
};

const ESTADO_SOL: Record<EstadoSolicitud, { label: string; bg: string; color: string; icon: string }> = {
  pendiente:   { label: "Pendiente",   bg: "#fef9ec", color: "#92400e", icon: "⏳" },
  en_revision: { label: "En revisión", bg: "#eff6ff", color: "#1d4ed8", icon: "🔍" },
  aprobada:    { label: "Aprobada",    bg: "#dcfce7", color: "#166534", icon: "✓" },
  rechazada:   { label: "Rechazada",   bg: "#fee2e2", color: "#991b1b", icon: "✕" },
};

const BLANK_CONTACTO: FormContacto = { nombre: "", apellido: "", cargo: "", telefono: "", email: "" };

const FORM_VACIO = {
  nombre: "", tipo: "b2b" as TipoCliente, empresa: "", ruc: "", dni: "",
  telefono: "", email: "", email_facturacion: "", estado: "activo" as EstadoCliente,
  direccion: "", distrito: "", ciudad: "", notas: "",
  tipo_empresa: "", rubro: "", nombre_comercial: "",
  condicion_pago: "", moneda: "", tipo_comprobante: "", volumen_compra: "",
  como_nos_conocio: "",
  servicios_interes: [] as string[],
  contactos_admin: [{ ...BLANK_CONTACTO }] as FormContacto[],
  contactos_op:    [{ ...BLANK_CONTACTO }] as FormContacto[],
};

/* ══════════════════════════════════════════════
   UTILITIES
══════════════════════════════════════════════ */
const iniciales  = (n: string) => n.split(" ").slice(0, 2).map(p => p[0] || "").join("").toUpperCase();
const avatarBg   = (n: string) => {
  const cols = ["#0b315f","#1262bd","#0f6e56","#854F0B","#6b21a8","#b91c1c","#0369a1"];
  return cols[(n.charCodeAt(0) || 0) % cols.length];
};
const fmtDate  = (s?: string) => s ? new Date(s).toLocaleDateString("es-PE", { day: "2-digit", month: "short", year: "numeric" }) : "—";
const fmtTime  = (s?: string) => s ? new Date(s).toLocaleString("es-PE",  { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }) : "—";
const parseSvc = (s?: string) => s ? s.split(",").map(x => x.trim()).filter(Boolean) : [];
const fmtBytes = (b?: number | null) => { if (!b) return "—"; if (b < 1024) return `${b} B`; if (b < 1048576) return `${(b/1024).toFixed(0)} KB`; return `${(b/1048576).toFixed(1)} MB`; };

/* ══════════════════════════════════════════════
   SHARED COMPONENTS
══════════════════════════════════════════════ */

function ToastStack({ toasts, remove }: { toasts: Toast[]; remove: (id: number) => void }) {
  const pal: Record<Toast["type"], { bg: string; border: string; color: string; icon: string }> = {
    ok:    { bg: "#f0fdf4", border: "#bbf7d0", color: "#166534", icon: "✓" },
    error: { bg: "#fef2f2", border: "#fecaca", color: "#991b1b", icon: "✕" },
    info:  { bg: "#eff6ff", border: "#bfdbfe", color: "#1d4ed8", icon: "·" },
  };
  return (
    <div style={{ position: "fixed", top: 20, right: 20, zIndex: 9999, display: "flex", flexDirection: "column", gap: 8, pointerEvents: "none" }}>
      {toasts.map(t => {
        const p = pal[t.type];
        return (
          <div key={t.id} onClick={() => remove(t.id)} style={{
            display: "flex", alignItems: "center", gap: 10, padding: "11px 16px",
            borderRadius: 12, pointerEvents: "auto", cursor: "pointer",
            minWidth: 240, maxWidth: 380, background: p.bg,
            border: `1px solid ${p.border}`, color: p.color,
            fontSize: 13, fontWeight: 500,
            boxShadow: "0 4px 16px rgba(0,0,0,0.10)", animation: "toastIn .22s ease",
          }}>
            <span style={{ fontWeight: 800, fontSize: 15 }}>{p.icon}</span>
            <span style={{ flex: 1 }}>{t.msg}</span>
          </div>
        );
      })}
    </div>
  );
}

function ConfirmModal({ title, msg, confirmLabel = "Confirmar", danger = false, onOk, onCancel, children }: {
  title: string; msg: string; confirmLabel?: string; danger?: boolean;
  onOk: () => void; onCancel: () => void; children?: React.ReactNode;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.45)", zIndex: 9000,
      display: "flex", alignItems: "center", justifyContent: "center", animation: "fadeIn .15s ease" }}>
      <div style={{ background: "white", borderRadius: 18, padding: "28px 30px", maxWidth: 420, width: "90%",
        boxShadow: "0 24px 64px rgba(0,0,0,.22)", animation: "scaleIn .18s ease" }}>
        <h3 style={{ fontWeight: 800, fontSize: 17, color: "#0f172a", margin: "0 0 8px" }}>{title}</h3>
        <p style={{ fontSize: 14, color: "#64748b", margin: "0 0 16px", lineHeight: 1.6 }}>{msg}</p>
        {children}
        <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20 }}>
          <button onClick={onCancel} style={{ padding: "9px 22px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>Cancelar</button>
          <button onClick={onOk}    style={{ padding: "9px 22px", borderRadius: 10, border: "none", background: danger ? "#dc2626" : "#0b315f", color: "white", fontSize: 13, fontWeight: 700, cursor: "pointer" }}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  );
}

function SvcTag({ label }: { label: string }) {
  const map: Record<string, [string, string]> = {
    "Transporte de personal": ["#eff6ff","#1d4ed8"],
    "Transporte turístico":   ["#f0fdf4","#166534"],
    "Alquiler de vehículos":  ["#fef9ec","#92400e"],
    "Otros":                  ["#f5f3ff","#6d28d9"],
  };
  const [bg, color] = map[label] || ["#f3f4f6","#374151"];
  return <span style={{ fontSize: 11, fontWeight: 600, padding: "3px 9px", borderRadius: 20, background: bg, color, whiteSpace: "nowrap" }}>{label}</span>;
}

function Skeleton() {
  return <>{[72,55,68,60].map((w,i) => (
    <tr key={i}><td colSpan={8} style={{ padding: "14px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
        <div style={{ width: 38, height: 38, borderRadius: 11, background: "#f1f5f9", flexShrink: 0 }}/>
        <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
          <div style={{ height: 12, width: w, borderRadius: 6, background: "#f1f5f9" }}/>
          <div style={{ height: 10, width: w * 0.6, borderRadius: 6, background: "#f8fafc" }}/>
        </div>
      </div>
    </td></tr>
  ))}</>;
}

const SecLabel = ({ children }: { children: React.ReactNode }) => (
  <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".08em",
    color: "#94a3b8", borderBottom: "1px solid #f1f5f9", paddingBottom: 6, marginBottom: 14, marginTop: 0 }}>
    {children}
  </p>
);

function Field({ label, span, error, hint, children }: {
  label: string; span?: number; error?: string; hint?: string; children: React.ReactNode;
}) {
  return (
    <div style={{ gridColumn: span ? `span ${span}` : undefined }}>
      <label style={{ display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase",
        letterSpacing: ".04em", color: error ? "#ef4444" : "#6b7280", marginBottom: 4 }}>
        {label}
      </label>
      {children}
      {hint  && <p style={{ fontSize: 11, color: "#94a3b8", marginTop: 3 }}>{hint}</p>}
      {error && <p style={{ fontSize: 11, color: "#ef4444", marginTop: 3 }}>⚠ {error}</p>}
    </div>
  );
}

const inp = (error?: boolean): React.CSSProperties => ({
  width: "100%", boxSizing: "border-box", border: `1.5px solid ${error ? "#fca5a5" : "#e5e7eb"}`,
  borderRadius: 10, padding: "9px 12px", fontSize: 13, outline: "none", fontFamily: "inherit",
  background: error ? "#fef9f9" : "white", transition: "border-color .15s",
});

/* ── Contact card (dynamic, reusable) ── */
function ContactCard({ contacto, index, tipo, onChange, onRemove, canRemove }: {
  contacto: FormContacto; index: number; tipo: string;
  onChange: (k: keyof FormContacto, v: string) => void;
  onRemove: () => void; canRemove: boolean;
}) {
  const lbl = tipo === "admin" ? "Administrativo" : "Operativo";
  return (
    <div style={{ background: "#f8fafc", border: "1.5px solid #e5e7eb", borderRadius: 12, padding: "14px 16px", marginBottom: 10, animation: "slideDown .2s ease" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".05em", color: tipo === "admin" ? "#1262bd" : "#0f6e56" }}>
          {lbl} #{index + 1}
        </span>
        {canRemove && (
          <button type="button" onClick={onRemove} style={{ display: "flex", alignItems: "center", gap: 4, background: "transparent", border: "1px solid #e5e7eb", color: "#94a3b8", fontSize: 11, fontWeight: 600, padding: "3px 10px", borderRadius: 20, cursor: "pointer", fontFamily: "inherit" }}>
            ✕ Quitar
          </button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <Field label="Nombre *">
          <input style={inp(!contacto.nombre.trim() && false)} placeholder="Nombre(s)" value={contacto.nombre} onChange={e => onChange("nombre", e.target.value)} />
        </Field>
        <Field label="Apellidos">
          <input style={inp()} placeholder="Apellidos" value={contacto.apellido} onChange={e => onChange("apellido", e.target.value)} />
        </Field>
        <Field label="Cargo / Área">
          <input style={inp()} placeholder="Ej: Gerente Administrativo" value={contacto.cargo} onChange={e => onChange("cargo", e.target.value)} />
        </Field>
        <Field label="Celular">
          <input style={inp()} placeholder="+51 9XX XXX XXX" value={contacto.telefono} onChange={e => onChange("telefono", e.target.value)} />
        </Field>
      </div>
      <Field label="Correo electrónico">
        <input type="email" style={inp()} placeholder="correo@empresa.com" value={contacto.email} onChange={e => onChange("email", e.target.value)} />
      </Field>
    </div>
  );
}

/* ══════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════ */
export default function ClientesPage() {
  /* ── Global state ── */
  const [tab,          setTab]          = useState<Tab>("clientes");
  const [toasts,       setToasts]       = useState<Toast[]>([]);
  const toastRef = useRef(0);

  const toast = useCallback((msg: string, type: Toast["type"] = "ok") => {
    const id = ++toastRef.current;
    setToasts(p => [...p, { id, msg, type }]);
    setTimeout(() => setToasts(p => p.filter(t => t.id !== id)), 4000);
  }, []);
  const removeToast = (id: number) => setToasts(p => p.filter(t => t.id !== id));

  /* ── ESC ── */
  const limpiarClienteRef  = useRef<() => void>(() => {});
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") limpiarClienteRef.current(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, []);

  /* ══════════════════════════════════════════
     TAB: CLIENTES
  ══════════════════════════════════════════ */
  const [clientes,     setClientes]     = useState<Cliente[]>([]);
  const [loadingCli,   setLoadingCli]   = useState(false);
  const [guardando,    setGuardando]    = useState(false);
  const [busqueda,     setBusqueda]     = useState("");
  const [busqActiva,   setBusqActiva]   = useState("");
  const [filtroEstado, setFiltroEstado] = useState("todos");
  const [filtroTipo,   setFiltroTipo]   = useState("todos");
  const [filtroSvc,    setFiltroSvc]    = useState("todos");
  const [sortDir,      setSortDir]      = useState<SortDir>("asc");
  const [expandidoId,  setExpandidoId]  = useState<number | null>(null);
  const [mostrarForm,  setMostrarForm]  = useState(false);
  const [editandoId,   setEditandoId]   = useState<number | null>(null);
  const [form,         setForm]         = useState(FORM_VACIO);
  const [errors,       setErrors]       = useState<Record<string, string>>({});
  const [toDelete,     setToDelete]     = useState<{ id: number; nombre: string } | null>(null);
  const formRef = useRef<HTMLDivElement>(null);
  const debRef  = useRef<ReturnType<typeof setTimeout>>();

  limpiarClienteRef.current = () => {
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(false); setErrors({});
  };

  /* Debounced search */
  useEffect(() => {
    clearTimeout(debRef.current);
    debRef.current = setTimeout(() => setBusqActiva(busqueda), 280);
    return () => clearTimeout(debRef.current);
  }, [busqueda]);

  const cargarClientes = async () => {
    setLoadingCli(true);
    const { data, error } = await supabase
      .from("clientes")
      .select("*, contactos(*)")
      .order("nombre")
      .limit(2000);
    if (error) toast(error.message, "error");
    else setClientes((data || []) as Cliente[]);
    setLoadingCli(false);
  };
  useEffect(() => { cargarClientes(); }, []);

  /* Form helpers */
  const f = (key: string) =>
    (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
      setForm(prev => ({ ...prev, [key]: e.target.value }));
      setErrors(prev => { const n = { ...prev }; delete n[key]; return n; });
    };

  const toggleSvc = (s: string) =>
    setForm(prev => ({
      ...prev,
      servicios_interes: prev.servicios_interes.includes(s)
        ? prev.servicios_interes.filter(x => x !== s)
        : [...prev.servicios_interes, s],
    }));

  /* Contacts CRUD */
  const addContacto = (tipo: "admin" | "op") =>
    setForm(prev => ({
      ...prev,
      [`contactos_${tipo}`]: [...prev[`contactos_${tipo}`], { ...BLANK_CONTACTO }],
    }));

  const removeContacto = (tipo: "admin" | "op", idx: number) =>
    setForm(prev => ({
      ...prev,
      [`contactos_${tipo}`]: prev[`contactos_${tipo}`].filter((_: FormContacto, i: number) => i !== idx),
    }));

  const updateContacto = (tipo: "admin" | "op", idx: number, key: keyof FormContacto, val: string) =>
    setForm(prev => {
      const arr = [...prev[`contactos_${tipo}`]];
      arr[idx] = { ...arr[idx], [key]: val };
      return { ...prev, [`contactos_${tipo}`]: arr };
    });

  const limpiarCliente = () => limpiarClienteRef.current();

  const abrirNuevo = () => {
    setForm(FORM_VACIO); setEditandoId(null); setMostrarForm(true); setErrors({});
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  const editarCliente = (c: Cliente) => {
    const adminContacts = (c.contactos || []).filter(x => x.tipo === "administrativo");
    const opContacts    = (c.contactos || []).filter(x => x.tipo === "operativo");
    setForm({
      nombre: c.nombre || "", tipo: c.tipo || "b2b", empresa: c.empresa || "",
      ruc: c.ruc || "", dni: c.dni || "", telefono: c.telefono || "",
      email: c.email || "", email_facturacion: c.email_facturacion || "",
      estado: c.estado || "activo", direccion: c.direccion || "",
      distrito: c.distrito || "", ciudad: c.ciudad || "", notas: c.notas || "",
      tipo_empresa: c.tipo_empresa || "", rubro: c.rubro || "",
      nombre_comercial: c.nombre_comercial || "",
      condicion_pago: c.condicion_pago || "", moneda: c.moneda || "",
      tipo_comprobante: c.tipo_comprobante || "", volumen_compra: c.volumen_compra || "",
      como_nos_conocio: c.como_nos_conocio || "",
      servicios_interes: parseSvc(c.servicios_interes),
      contactos_admin: adminContacts.length
        ? adminContacts.map(x => ({ nombre: x.nombre || "", apellido: x.apellido || "", cargo: x.cargo || "", telefono: x.telefono || "", email: x.email || "" }))
        : [{ ...BLANK_CONTACTO }],
      contactos_op: opContacts.length
        ? opContacts.map(x => ({ nombre: x.nombre || "", apellido: x.apellido || "", cargo: x.cargo || "", telefono: x.telefono || "", email: x.email || "" }))
        : [{ ...BLANK_CONTACTO }],
    });
    setEditandoId(c.id); setMostrarForm(true); setErrors({});
    setTimeout(() => formRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
  };

  /* Validation */
  const validate = () => {
    const e: Record<string, string> = {};
    if (!form.nombre.trim())  e.nombre  = "Obligatorio";
    if (form.tipo === "b2b" && !form.empresa.trim()) e.empresa = "Razón social obligatoria";
    if (form.email.trim() && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(form.email)) e.email = "Email inválido";
    if (form.ruc.trim() && form.ruc.length !== 11) e.ruc = "RUC debe tener 11 dígitos";
    if (form.dni.trim() && form.dni.length !== 8)  e.dni = "DNI debe tener 8 dígitos";
    setErrors(e);
    if (Object.keys(e).length) toast("Revisa los campos marcados", "error");
    return Object.keys(e).length === 0;
  };

  /* Save client */
  const guardarCliente = async () => {
    if (!validate()) return;
    setGuardando(true);

    const payload: Partial<Cliente> = {
      nombre: form.nombre.trim(), tipo: form.tipo, estado: form.estado,
      telefono:        form.telefono.trim()        || undefined,
      email:           form.email.trim()           || undefined,
      email_facturacion: form.email_facturacion.trim() || undefined,
      direccion:       form.direccion.trim()       || undefined,
      distrito:        form.distrito.trim()        || undefined,
      ciudad:          form.ciudad.trim()          || undefined,
      notas:           form.notas.trim()           || undefined,
      empresa:         form.tipo === "b2b" ? form.empresa.trim()        || undefined : undefined,
      ruc:             form.tipo === "b2b" ? form.ruc.trim()            || undefined : undefined,
      tipo_empresa:    form.tipo === "b2b" ? form.tipo_empresa.trim()   || undefined : undefined,
      rubro:           form.tipo === "b2b" ? form.rubro.trim()          || undefined : undefined,
      nombre_comercial:form.tipo === "b2b" ? form.nombre_comercial.trim()|| undefined : undefined,
      condicion_pago:  form.tipo === "b2b" ? form.condicion_pago.trim() || undefined : undefined,
      moneda:          form.tipo === "b2b" ? form.moneda.trim()         || undefined : undefined,
      tipo_comprobante:form.tipo === "b2b" ? form.tipo_comprobante.trim()|| undefined : undefined,
      volumen_compra:  form.tipo === "b2b" ? form.volumen_compra.trim() || undefined : undefined,
      como_nos_conocio:form.como_nos_conocio.trim()|| undefined,
      dni:             form.tipo === "b2c" ? form.dni.trim()            || undefined : undefined,
    };

    let clienteId = editandoId;

    if (editandoId) {
      const { error } = await supabase.from("clientes").update(payload).eq("id", editandoId);
      if (error) { toast(error.message, "error"); setGuardando(false); return; }
    } else {
      const { data, error } = await supabase.from("clientes").insert(payload).select("id").single();
      if (error) { toast(error.message, "error"); setGuardando(false); return; }
      clienteId = data.id;
    }

    /* Sync contacts */
    if (clienteId) {
      if (editandoId) await supabase.from("contactos").delete().eq("cliente_id", editandoId);
      const toInsert = [
        ...form.contactos_admin.filter((c: FormContacto) => c.nombre.trim()).map((c: FormContacto, i: number) => ({
          cliente_id: clienteId, tipo: "administrativo", principal: i === 0,
          nombre: c.nombre.trim(), apellido: c.apellido.trim() || undefined,
          cargo: c.cargo.trim() || undefined, telefono: c.telefono.trim() || undefined,
          email: c.email.trim() || undefined,
        })),
        ...form.contactos_op.filter((c: FormContacto) => c.nombre.trim()).map((c: FormContacto, i: number) => ({
          cliente_id: clienteId, tipo: "operativo", principal: i === 0,
          nombre: c.nombre.trim(), apellido: c.apellido.trim() || undefined,
          cargo: c.cargo.trim() || undefined, telefono: c.telefono.trim() || undefined,
          email: c.email.trim() || undefined,
        })),
      ];
      if (toInsert.length) await supabase.from("contactos").insert(toInsert);
    }

    toast(editandoId ? "Cliente actualizado ✓" : "Cliente creado ✓", "ok");
    limpiarCliente(); cargarClientes(); setGuardando(false);
  };

  /* Status & delete */
  const cambiarEstado = async (id: number, estado: EstadoCliente) => {
    const { error } = await supabase.from("clientes").update({ estado }).eq("id", id);
    if (error) { toast(error.message, "error"); return; }
    setClientes(prev => prev.map(c => c.id === id ? { ...c, estado } : c));
    toast(`Estado → "${ESTADO_CLIENTE[estado].label}"`, "info");
  };

  const eliminarCliente = async () => {
    if (!toDelete) return;
    await supabase.from("contactos").delete().eq("cliente_id", toDelete.id);
    const { error } = await supabase.from("clientes").delete().eq("id", toDelete.id);
    if (error) toast(error.message, "error");
    else { toast(`"${toDelete.nombre}" eliminado`, "ok"); cargarClientes(); }
    setToDelete(null);
  };

  const copiar = (text: string, label: string) =>
    navigator.clipboard.writeText(text).then(() => toast(`${label} copiado`, "info"));

  const exportCSV = () => {
    const hdr = ["ID","Nombre","Empresa","Tipo","RUC","DNI","Email","Teléfono","Estado","Ciudad","Servicios","Alta"];
    const rows = filtrados.map(c => [
      c.id, c.nombre, c.empresa||"", c.tipo, c.ruc||"", c.dni||"",
      c.email||"", c.telefono||"", c.estado, c.ciudad||"",
      c.servicios_interes||"", fmtDate(c.created_at),
    ]);
    const csv = [hdr, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g,'""')}"`).join(",")).join("\n");
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(new Blob(["\uFEFF"+csv], { type: "text/csv;charset=utf-8;" })),
      download: "clientes_afa.csv",
    });
    a.click(); URL.revokeObjectURL(a.href);
    toast("CSV exportado ✓");
  };

  /* Stats & filter */
  const total      = clientes.length;
  const b2bCount   = clientes.filter(c => c.tipo === "b2b").length;
  const b2cCount   = clientes.filter(c => c.tipo === "b2c").length;
  const activos    = clientes.filter(c => c.estado === "activo").length;
  const bloqueados = clientes.filter(c => c.estado === "bloqueado").length;

  const filtrados = clientes
    .filter(c => {
      const q = busqActiva.toLowerCase();
      const hit = !q ||
        c.nombre.toLowerCase().includes(q) ||
        (c.empresa||"").toLowerCase().includes(q) ||
        (c.ruc||"").includes(q) || (c.dni||"").includes(q) ||
        (c.email||"").toLowerCase().includes(q) || (c.ciudad||"").toLowerCase().includes(q);
      return hit &&
        (filtroEstado === "todos" || c.estado === filtroEstado) &&
        (filtroTipo   === "todos" || c.tipo   === filtroTipo) &&
        (filtroSvc    === "todos" || parseSvc(c.servicios_interes).includes(filtroSvc));
    })
    .sort((a, b) => {
      const va = ((a.empresa || a.nombre)).toLowerCase();
      const vb = ((b.empresa || b.nombre)).toLowerCase();
      return sortDir === "asc" ? va.localeCompare(vb,"es") : vb.localeCompare(va,"es");
    });

  /* ══════════════════════════════════════════
     TAB: SOLICITUDES
  ══════════════════════════════════════════ */
  const [solicitudes,   setSolicitudes]   = useState<Solicitud[]>([]);
  const [loadingSol,    setLoadingSol]    = useState(false);
  const [filtroSolEst,  setFiltroSolEst]  = useState<EstadoSolicitud | "todos">("pendiente");
  const [expandSolId,   setExpandSolId]   = useState<number | null>(null);
  const [aprobando,     setAprobando]     = useState<number | null>(null);
  const [rechazarModal, setRechazarModal] = useState<Solicitud | null>(null);
  const [notaRechazo,   setNotaRechazo]   = useState("");
  const [editSol,       setEditSol]       = useState<Solicitud | null>(null);
  const [editSolForm,   setEditSolForm]   = useState<Partial<Solicitud>>({});
  const [guardandoSol,  setGuardandoSol]  = useState(false);

  const cargarSolicitudes = async () => {
    setLoadingSol(true);
    const { data, error } = await supabase
      .from("solicitudes_cliente")
      .select("*")
      .order("created_at", { ascending: false })
      .limit(500);
    if (error) toast(error.message, "error");
    else setSolicitudes((data || []) as Solicitud[]);
    setLoadingSol(false);
  };
  useEffect(() => { if (tab === "solicitudes") cargarSolicitudes(); }, [tab]);

  const pendienteCount = solicitudes.filter(s => s.estado === "pendiente").length;

  const solFiltradas = solicitudes.filter(s =>
    filtroSolEst === "todos" || s.estado === filtroSolEst
  );

  const abrirEditSol = (sol: Solicitud) => {
    setEditSol(sol);
    setEditSolForm({
      razon_social: sol.razon_social, nombre_comercial: sol.nombre_comercial,
      tipo_doc: sol.tipo_doc, num_doc: sol.num_doc,
      tipo_empresa: sol.tipo_empresa, rubro: sol.rubro,
      direccion: sol.direccion, distrito: sol.distrito,
      provincia: sol.provincia, departamento: sol.departamento,
      email_facturacion: sol.email_facturacion, web: sol.web,
      condicion_pago: sol.condicion_pago, moneda: sol.moneda,
      tipo_comprobante: sol.tipo_comprobante, volumen_compra: sol.volumen_compra,
      como_nos_conocio: sol.como_nos_conocio, observaciones: sol.observaciones,
      nota_interna: sol.nota_interna,
    });
  };

  const guardarEdicionSolicitud = async () => {
    if (!editSol) return;
    setGuardandoSol(true);
    const { error } = await supabase.from("solicitudes_cliente")
      .update(editSolForm).eq("id", editSol.id);
    if (error) { toast(error.message, "error"); setGuardandoSol(false); return; }
    toast("Solicitud actualizada ✓", "ok");
    setEditSol(null);
    setGuardandoSol(false);
    cargarSolicitudes();
  };

  const aprobarSolicitud = async (sol: Solicitud) => {
    setAprobando(sol.id);

    const clientePayload = {
      nombre: sol.razon_social, tipo: "b2b" as TipoCliente, estado: "activo" as EstadoCliente,
      empresa:          sol.razon_social || undefined,
      ruc:              sol.tipo_doc === "RUC" ? sol.num_doc : undefined,
      email_facturacion: sol.email_facturacion || undefined,
      direccion:        sol.direccion || undefined,
      distrito:         sol.distrito  || undefined,
      tipo_empresa:     sol.tipo_empresa     || undefined,
      rubro:            sol.rubro            || undefined,
      nombre_comercial: sol.nombre_comercial || undefined,
      condicion_pago:   sol.condicion_pago   || undefined,
      moneda:           sol.moneda           || undefined,
      tipo_comprobante: sol.tipo_comprobante || undefined,
      volumen_compra:   sol.volumen_compra   || undefined,
      como_nos_conocio: sol.como_nos_conocio || undefined,
    };

    const { data: nuevoCliente, error: errCliente } = await supabase
      .from("clientes").insert(clientePayload).select("id").single();
    if (errCliente) { toast(errCliente.message, "error"); setAprobando(null); return; }

    const contactosInsert = [
      ...(sol.contactos_administrativos || []).filter(c => c.nombre).map((c, i) => ({
        cliente_id: nuevoCliente.id, tipo: "administrativo", principal: i === 0,
        nombre: c.nombre || "", apellido: c.apellido || undefined,
        cargo: c.cargo || undefined, telefono: c.telefono || undefined, email: c.email || undefined,
      })),
      ...(sol.contactos_operativos || []).filter(c => c.nombre).map((c, i) => ({
        cliente_id: nuevoCliente.id, tipo: "operativo", principal: i === 0,
        nombre: c.nombre || "", apellido: c.apellido || undefined,
        cargo: c.cargo || undefined, telefono: c.telefono || undefined, email: c.email || undefined,
      })),
    ];
    if (contactosInsert.length) await supabase.from("contactos").insert(contactosInsert);

    const { error: errSol } = await supabase.from("solicitudes_cliente").update({
      estado: "aprobada", cliente_id: nuevoCliente.id,
      revisado_por: "erp_user", revisado_at: new Date().toISOString(),
    }).eq("id", sol.id);
    if (errSol) { toast(errSol.message, "error"); setAprobando(null); return; }

    toast(`"${sol.razon_social}" aprobado y dado de alta como cliente ✓`, "ok");
    setAprobando(null);
    cargarSolicitudes(); cargarClientes();
  };

  const marcarEnRevision = async (sol: Solicitud) => {
    const { error } = await supabase.from("solicitudes_cliente")
      .update({ estado: "en_revision" }).eq("id", sol.id);
    if (error) { toast(error.message, "error"); return; }
    setSolicitudes(prev => prev.map(s => s.id === sol.id ? { ...s, estado: "en_revision" } : s));
    toast("Solicitud marcada en revisión", "info");
  };

  const rechazarSolicitud = async () => {
    if (!rechazarModal) return;
    const { error } = await supabase.from("solicitudes_cliente").update({
      estado: "rechazada",
      nota_interna: notaRechazo.trim() || undefined,
      revisado_por: "erp_user",
      revisado_at: new Date().toISOString(),
    }).eq("id", rechazarModal.id);
    if (error) { toast(error.message, "error"); return; }
    toast(`Solicitud de "${rechazarModal.razon_social}" rechazada`, "info");
    setRechazarModal(null); setNotaRechazo("");
    cargarSolicitudes();
  };

  /* ══════════════════════════════════════════
     TAB: ACCESO PORTAL
  ══════════════════════════════════════════ */
  const [portalUsers,    setPortalUsers]    = useState<PortalUsuario[]>([]);
  const [loadingPU,      setLoadingPU]      = useState(false);
  const [modalPU,        setModalPU]        = useState(false);
  const [editPU,         setEditPU]         = useState<PortalUsuario | null>(null);
  const [puNombre,       setPuNombre]       = useState("");
  const [puTipoDoc,      setPuTipoDoc]      = useState<"DNI"|"CE"|"Celular">("DNI");
  const [puDni,          setPuDni]          = useState("");
  const [puEmail,        setPuEmail]        = useState("");
  const [puCargo,        setPuCargo]        = useState("");
  const [puRol,          setPuRol]          = useState<"admin"|"visor">("visor");
  const [puPass,         setPuPass]         = useState("");
  const [puPermisos,     setPuPermisos]     = useState<string[]>(MODULOS_CTRL.map(m => m.id).filter(id => id !== "facturacion"));
  const [puErr,          setPuErr]          = useState("");
  const [puLoad,         setPuLoad]         = useState(false);
  const [toDeletePU,     setToDeletePU]     = useState<{ id: number; nombre: string } | null>(null);
  const [showPuPass,     setShowPuPass]     = useState(false);
  const [puContactosTab, setPuContactosTab] = useState<"admin"|"op">("admin");
  const [puImportadoDe,  setPuImportadoDe]  = useState("");
  // Carga masiva de usuarios del portal por Excel
  const puImportInputRef = useRef<HTMLInputElement>(null);
  const [importandoPU,   setImportandoPU]   = useState(false);
  const [enviandoCredsPU,setEnviandoCredsPU]= useState(false);
  const [resultadoImportPU, setResultadoImportPU] = useState<null | {
    insertados: number; actualizados: number; errores: number;
    mensajesError: string[];
    credenciales: (CredencialExport & { id: number | null; tipo_doc: "DNI"|"CE"|"Celular" })[];
    avisos: string[];
  }>(null);

  // Documentos
  const [expandDocs,   setExpandDocs]   = useState<DocCliente[]>([]);
  const [loadingDocs,  setLoadingDocs]  = useState(false);
  const [subiendoDoc,  setSubiendoDoc]  = useState(false);
  const [docCategoria, setDocCategoria] = useState("Contratos");
  const [toDeleteDoc,  setToDeleteDoc]  = useState<{ id: number; nombre: string; storage_path: string } | null>(null);
  const docInputRef = useRef<HTMLInputElement>(null);
  const [nominaMap,        setNominaMap]        = useState<Record<number, PasajeroCliente[]>>({});
  const [loadingNomina,    setLoadingNomina]    = useState(false);
  const [importandoNomina, setImportandoNomina] = useState(false);
  const [nominaExpandida,  setNominaExpandida]  = useState(false);
  const [editandoPax,      setEditandoPax]      = useState<PasajeroCliente | null>(null);
  const [creandoPax,       setCreandoPax]       = useState(false);
  const [formPax,          setFormPax]          = useState({ nombre: "", dni: "", telefono: "", empresa: "", email: "", pin_acceso: "", edad: "" });
  const [savingPax,        setSavingPax]        = useState(false);
  const [enviandoCreds,    setEnviandoCreds]    = useState<Set<number>>(new Set());
  const nominaInputRef = useRef<HTMLInputElement>(null);
  const { canalEmail, setCanalEmail, canalWhatsapp, setCanalWhatsapp } = useCanalesInvitacion();

  // Derivado: cliente actualmente expandido
  const accesoCliente = expandidoId ? (clientes.find(c => c.id === expandidoId) ?? null) : null;

  const cargarPortalUsers = async (clienteId: number) => {
    setLoadingPU(true);
    const { data } = await supabase.from("portal_usuarios").select("*").eq("cliente_id", clienteId).order("created_at");
    setPortalUsers((data || []) as PortalUsuario[]);
    setLoadingPU(false);
  };

  const cargarDocumentos = async (clienteId: number) => {
    setLoadingDocs(true);
    const { data } = await supabase.from("documentos_cliente").select("*").eq("cliente_id", clienteId).order("created_at", { ascending: false });
    setExpandDocs((data || []) as DocCliente[]);
    setLoadingDocs(false);
  };

  const subirDocumento = async (clienteId: number, file: File, categoria: string) => {
    setSubiendoDoc(true);
    const safeName = file.name.replace(/[^a-zA-Z0-9._\-]/g, "_");
    const path = `${clienteId}/${Date.now()}_${safeName}`;
    const { error: upErr } = await supabase.storage.from("documentos-clientes").upload(path, file);
    if (upErr) { toast(upErr.message, "error"); setSubiendoDoc(false); return; }
    const { error: dbErr } = await supabase.from("documentos_cliente").insert({ cliente_id: clienteId, nombre: file.name, categoria, storage_path: path, tamano_bytes: file.size });
    if (dbErr) { toast(dbErr.message, "error"); } else { toast("Documento subido ✓", "ok"); await cargarDocumentos(clienteId); }
    setSubiendoDoc(false);
  };

  const descargarDoc = async (doc: DocCliente) => {
    const { data } = await supabase.storage.from("documentos-clientes").createSignedUrl(doc.storage_path, 3600);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
    else toast("No se pudo generar el enlace", "error");
  };

  const eliminarDocumento = async () => {
    if (!toDeleteDoc || !expandidoId) return;
    await supabase.storage.from("documentos-clientes").remove([toDeleteDoc.storage_path]);
    await supabase.from("documentos_cliente").delete().eq("id", toDeleteDoc.id);
    toast("Documento eliminado", "ok");
    await cargarDocumentos(expandidoId);
    setToDeleteDoc(null);
  };

  const cargarNomina = async (clienteId: number) => {
    setLoadingNomina(true);
    const { data } = await supabase
      .from("pasajeros")
      .select("id, nombre, dni, telefono, empresa, email, pin_acceso, edad")
      .eq("cliente_id", clienteId)
      .is("reserva_id", null)
      .order("nombre");
    setNominaMap(prev => ({ ...prev, [clienteId]: (data || []) as PasajeroCliente[] }));
    setLoadingNomina(false);
  };

  const handleNominaArchivo = async (file: File, clienteId: number) => {
    setImportandoNomina(true);
    try {
      const resultado = await parsearManifiesto(file);
      if (resultado.ok.length === 0) {
        toast("El archivo no tiene pasajeros válidos" + (resultado.errores.length ? `: ${resultado.errores[0].motivo}` : ""), "error");
        return;
      }
      // Diagnóstico: cuántos emails vienen en el archivo
      const emailsEnArchivo = resultado.ok.filter(p => p.email).length;
      if (emailsEnArchivo === 0) {
        toast(`⚠ Sin columna "Email" reconocida. Cabeceras aceptadas: Email, correo, mail`, "error");
        return;
      }

      // Upsert via API route (service role — evita RLS)
      const res = await fetch("/api/pasajeros/upsert-nomina", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clienteId,
          pasajeros: resultado.ok.map(p => ({
            nombre: p.nombre, dni: p.dni, telefono: p.telefono,
            empresa: p.empresa, email: p.email, edad: p.edad,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast(json.error || "Error al guardar", "error"); return; }

      const { insertados, actualizados, errores: erroresApi, mensajesError, nuevosIds } = json;
      const partes = [];
      if (insertados)   partes.push(`${insertados} nuevo(s)`);
      if (actualizados) partes.push(`${actualizados} actualizado(s) · ${emailsEnArchivo} con email`);
      if (erroresApi)   partes.push(`⚠ ${erroresApi} error(es): ${mensajesError?.[0] || ""}`);
      toast(partes.join(" · ") + (erroresApi ? "" : " ✓"), erroresApi ? "error" : "ok");

      if ((canalEmail || canalWhatsapp) && nuevosIds?.length) {
        await enviarInvitaciones(nuevosIds);
      }
      await cargarNomina(clienteId);
    } finally {
      setImportandoNomina(false);
    }
  };

  /** Correo + WhatsApp de invitación (automático) a pasajeros recién creados, según canales habilitados por el operador. */
  const enviarInvitaciones = async (pasajeroIds: number[]) => {
    if (!pasajeroIds.length || (!canalEmail && !canalWhatsapp)) return;
    try {
      const res = await fetch("/api/pasajeros/invitacion", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pasajeroIds, canales: { email: canalEmail, whatsapp: canalWhatsapp } }),
      });
      const json = await res.json();
      if (!res.ok) return;
      const partes = [];
      if (canalEmail)    partes.push(`✉ ${json.emailEnviados || 0} correo(s)`);
      if (canalWhatsapp) partes.push(`💬 ${json.whatsappEnviados || 0} WhatsApp`);
      if (partes.length) toast(`Invitación enviada: ${partes.join(" · ")}`, "ok");
    } catch {}
  };

  const abrirEditarPax = (p: PasajeroCliente) => {
    setCreandoPax(false);
    setEditandoPax(p);
    setFormPax({ nombre: p.nombre, dni: p.dni, telefono: p.telefono || "", empresa: p.empresa || "", email: p.email || "", pin_acceso: p.pin_acceso || "", edad: p.edad != null ? String(p.edad) : "" });
  };

  const abrirNuevoPax = () => {
    setEditandoPax(null);
    setFormPax({ nombre: "", dni: "", telefono: "", empresa: "", email: "", pin_acceso: "", edad: "" });
    setCreandoPax(true);
  };

  const cerrarModalPax = () => { setEditandoPax(null); setCreandoPax(false); };

  const guardarPax = async () => {
    if (editandoPax) {
      setSavingPax(true);
      const res = await fetch("/api/pasajeros/upsert-nomina", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          id: editandoPax.id,
          campos: {
            nombre:     formPax.nombre.trim(),
            dni:        formPax.dni.trim(),
            telefono:   formPax.telefono.trim()   || null,
            empresa:    formPax.empresa.trim()    || null,
            email:      formPax.email.trim()      || null,
            pin_acceso: formPax.pin_acceso.trim() || null,
            edad:       formPax.edad.trim() === "" ? null : Number(formPax.edad),
          },
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast(json.error || "Error al guardar", "error"); }
      else {
        toast("Pasajero actualizado ✓", "ok");
        setEditandoPax(null);
        if (expandidoId) await cargarNomina(expandidoId);
      }
      setSavingPax(false);
      return;
    }

    // Modo creación (creandoPax)
    if (!expandidoId) return;
    setSavingPax(true);
    const res = await fetch("/api/pasajeros/upsert-nomina", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        clienteId: expandidoId,
        pasajeros: [{
          nombre: formPax.nombre.trim(), dni: formPax.dni.trim(),
          telefono: formPax.telefono.trim() || null, empresa: formPax.empresa.trim() || null,
          email: formPax.email.trim() || null,
          edad: formPax.edad.trim() === "" ? null : Number(formPax.edad),
        }],
      }),
    });
    const json = await res.json();
    if (!res.ok) { toast(json.error || "Error al guardar", "error"); setSavingPax(false); return; }

    if (json.errores) {
      toast(json.mensajesError?.[0] || "Error al guardar", "error");
    } else if (json.actualizados) {
      toast("Ya existía un pasajero con ese DNI en la nómina — se actualizó ✓", "info");
    } else {
      toast("Pasajero creado ✓", "ok");
      if (json.nuevosIds?.length) await enviarInvitaciones(json.nuevosIds);
    }
    setCreandoPax(false);
    if (expandidoId) await cargarNomina(expandidoId);
    setSavingPax(false);
  };

  const enviarCredenciales = async (ids: number[]) => {
    setEnviandoCreds(new Set(ids));
    try {
      const res = await fetch("/api/pasajeros/credenciales", {
        method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pasajeroIds: ids }),
      });
      const json = await res.json();
      if (!res.ok) { toast(json.error || "Error al enviar", "error"); return; }
      const { enviados, sinEmail, errores } = json;
      const msg = `${enviados} enviado(s)${sinEmail ? ` · ${sinEmail} sin email` : ""}${errores ? ` · ${errores} error(es)` : ""}`;
      toast(msg, enviados > 0 ? "ok" : "info");
    } finally {
      setEnviandoCreds(new Set());
    }
  };

  const expandirCliente = (c: Cliente) => {
    const newId = expandidoId === c.id ? null : c.id;
    setExpandidoId(newId);
    if (newId) {
      setPortalUsers([]);
      setExpandDocs([]);
      cargarPortalUsers(newId);
      cargarDocumentos(newId);
      cargarNomina(newId);
    }
  };

  function resetPUForm() {
    setPuNombre(""); setPuTipoDoc("DNI"); setPuDni(""); setPuEmail(""); setPuCargo("");
    setPuRol("visor"); setPuPass(""); setPuErr(""); setEditPU(null); setShowPuPass(false);
    setPuContactosTab("admin"); setPuImportadoDe("");
    setPuPermisos(MODULOS_CTRL.map(m => m.id).filter(id => id !== "facturacion"));
  }

  function importarContacto(ct: Contacto) {
    const nombreCompleto = [ct.nombre, ct.apellido].filter(Boolean).join(" ");
    setPuNombre(nombreCompleto);
    setPuEmail(ct.email || "");
    setPuCargo(ct.cargo || "");
    setPuImportadoDe(nombreCompleto);
    setPuDni(""); // El documento se ingresa manualmente
  }

  function abrirEditarPU(u: PortalUsuario) {
    setEditPU(u); setPuNombre(u.nombre); setPuDni(u.dni);
    // Detectar tipo por el valor almacenado
    const detectedTipo: "DNI"|"CE"|"Celular" =
      /^\d{8}$/.test(u.dni) ? "DNI" :
      /^\d{7,15}$/.test(u.dni) ? "Celular" : "CE";
    setPuTipoDoc(detectedTipo);
    setPuEmail(u.email || ""); setPuCargo(u.cargo || ""); setPuRol(u.rol);
    setPuPass(""); setPuErr(""); setShowPuPass(false);
    setPuPermisos(u.modulos_permitidos || MODULOS_CTRL.map(m => m.id));
    setModalPU(true);
  }

  async function guardarPU() {
    if (!accesoCliente) return;
    if (!puNombre.trim() || !puDni.trim()) { setPuErr("Nombre e identificación son obligatorios"); return; }
    if (!editPU && !puPass.trim()) { setPuErr("La contraseña es obligatoria para nuevos usuarios"); return; }
    if (puTipoDoc === "DNI" && puDni.trim().length !== 8) { setPuErr("El DNI debe tener exactamente 8 dígitos"); return; }
    if (puTipoDoc === "Celular" && (puDni.trim().length < 7 || puDni.trim().length > 15)) { setPuErr("El número de celular debe tener entre 7 y 15 dígitos"); return; }
    if (puTipoDoc === "CE" && puDni.trim().length < 6) { setPuErr("La Cédula / CE debe tener al menos 6 caracteres"); return; }
    setPuErr(""); setPuLoad(true);
    const modulos = (puRol === "admin" && puPermisos.length === MODULOS_CTRL.length) ? null : puPermisos;

    const { data: { session } } = await supabase.auth.getSession();
    const bearerToken = session?.access_token ?? "";

    const enviarCredenciales = async (uid: number, pass: string) => {
      if (!puEmail.trim()) return;
      try {
        await fetch("/api/portal/enviar-credenciales", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bearerToken}` },
          body: JSON.stringify({ usuario_id: uid, password: pass, tipo_doc: puTipoDoc }),
        });
      } catch { /* silencioso — no bloquear el flujo */ }
    };

    if (editPU) {
      const updates: Record<string, unknown> = { nombre: puNombre.trim(), dni: puDni.trim(), cargo: puCargo.trim() || null, rol: puRol, email: puEmail.trim() || null, modulos_permitidos: modulos };
      if (puPass.trim()) updates.codigo_acceso = puPass.trim();
      const { error } = await supabase.from("portal_usuarios").update(updates).eq("id", editPU.id);
      if (error) { setPuErr("Error al actualizar: " + error.message); setPuLoad(false); return; }
      if (puPass.trim()) {
        await enviarCredenciales(editPU.id, puPass.trim());
        toast(puEmail.trim() ? "Usuario actualizado · credenciales enviadas ✓" : "Usuario actualizado ✓", "ok");
      } else {
        toast("Usuario actualizado ✓", "ok");
      }
    } else {
      const { data: nuevoUser, error } = await supabase.from("portal_usuarios")
        .insert({ cliente_id: accesoCliente.id, nombre: puNombre.trim(), dni: puDni.trim(), cargo: puCargo.trim() || null, rol: puRol, email: puEmail.trim() || null, codigo_acceso: puPass.trim(), activo: true, modulos_permitidos: modulos })
        .select("id").single();
      if (error) { setPuErr(error.message.includes("unique") ? `Ya existe un usuario con ese ${puTipoDoc} para este cliente` : error.message); setPuLoad(false); return; }
      if (nuevoUser) await enviarCredenciales(nuevoUser.id, puPass.trim());
      toast(puEmail.trim() ? "Usuario creado · credenciales enviadas ✓" : "Usuario creado ✓", "ok");
    }

    await cargarPortalUsers(accesoCliente.id);
    setModalPU(false); resetPUForm(); setPuLoad(false);
  }

  async function togglePUActivo(id: number, activo: boolean) {
    await supabase.from("portal_usuarios").update({ activo: !activo }).eq("id", id);
    setPortalUsers(prev => prev.map(u => u.id === id ? { ...u, activo: !activo } : u));
    toast(activo ? "Usuario desactivado" : "Usuario activado", "info");
  }

  async function eliminarPU() {
    if (!toDeletePU || !accesoCliente) return;
    const { error } = await supabase.from("portal_usuarios").delete().eq("id", toDeletePU.id);
    if (error) { toast(error.message, "error"); }
    else { toast(`"${toDeletePU.nombre}" eliminado`, "ok"); await cargarPortalUsers(accesoCliente.id); }
    setToDeletePU(null);
  }

  // ── Carga masiva de usuarios del portal por Excel ──
  async function handlePortalUsuariosArchivo(file: File, clienteId: number) {
    setImportandoPU(true);
    try {
      const resultado = await parsearPortalUsuarios(file, MODULOS_CTRL);
      if (resultado.ok.length === 0) {
        toast("El archivo no tiene usuarios válidos" + (resultado.errores[0] ? `: ${resultado.errores[0].motivo}` : ""), "error");
        return;
      }

      const { data: { session } } = await supabase.auth.getSession();
      const res = await fetch("/api/portal/importar-usuarios", {
        method: "POST",
        headers: { "Content-Type": "application/json", "Authorization": `Bearer ${session?.access_token ?? ""}` },
        body: JSON.stringify({
          clienteId,
          usuarios: resultado.ok.map(u => ({
            nombre: u.nombre, dni: u.dni, tipo_doc: u.tipo_doc,
            email: u.email, cargo: u.cargo, rol: u.rol,
            password: u.password, modulos_permitidos: u.modulos_permitidos,
          })),
        }),
      });
      const json = await res.json();
      if (!res.ok) { toast(json.error || "Error al importar", "error"); return; }

      // Errores por fila del parseo + módulos desconocidos → avisos informativos
      const avisos: string[] = [];
      resultado.errores.forEach(e => avisos.push(`Fila ${e.fila}: ${e.motivo}`));
      const modsDesc = Array.from(new Set(resultado.ok.flatMap(u => u.modulos_desconocidos)));
      if (modsDesc.length) avisos.push(`Módulos no reconocidos (ignorados): ${modsDesc.join(", ")}`);
      (json.mensajesError || []).forEach((m: string) => avisos.push(m));

      setResultadoImportPU({
        insertados: json.insertados || 0,
        actualizados: json.actualizados || 0,
        errores: json.errores || 0,
        mensajesError: json.mensajesError || [],
        credenciales: json.credenciales || [],
        avisos,
      });

      const partes: string[] = [];
      if (json.insertados)   partes.push(`${json.insertados} nuevo(s)`);
      if (json.actualizados) partes.push(`${json.actualizados} actualizado(s)`);
      if (json.errores)      partes.push(`⚠ ${json.errores} error(es)`);
      toast(partes.join(" · ") + (json.errores ? "" : " ✓"), json.errores ? "error" : "ok");
      await cargarPortalUsers(clienteId);
    } finally {
      setImportandoPU(false);
    }
  }

  // Envía por correo las credenciales de los usuarios recién creados/actualizados
  // que tienen email y una contraseña conocida (no "(sin cambio)").
  async function enviarCredencialesImportadas() {
    if (!resultadoImportPU) return;
    const conEmail = resultadoImportPU.credenciales.filter(
      c => c.id && c.email && c.password && c.password !== "(sin cambio)",
    );
    if (conEmail.length === 0) { toast("Ningún usuario tiene correo + contraseña para enviar", "info"); return; }
    setEnviandoCredsPU(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();
      const bearer = session?.access_token ?? "";
      const results = await Promise.all(conEmail.map(c =>
        fetch("/api/portal/enviar-credenciales", {
          method: "POST",
          headers: { "Content-Type": "application/json", "Authorization": `Bearer ${bearer}` },
          body: JSON.stringify({ usuario_id: c.id, password: c.password, tipo_doc: c.tipo_doc }),
        }).then(r => r.ok).catch(() => false),
      ));
      const enviados = results.filter(Boolean).length;
      toast(`${enviados} de ${conEmail.length} correo(s) enviado(s)` + (enviados < conEmail.length ? " · algunos fallaron" : " ✓"), enviados > 0 ? "ok" : "error");
    } finally {
      setEnviandoCredsPU(false);
    }
  }

  /* ══════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════ */
  return (
    <>
      <style>{`
        @keyframes toastIn  { from{opacity:0;transform:translateX(16px)} to{opacity:1;transform:translateX(0)} }
        @keyframes fadeIn   { from{opacity:0} to{opacity:1} }
        @keyframes scaleIn  { from{opacity:0;transform:scale(.94)} to{opacity:1;transform:scale(1)} }
        @keyframes slideDown { from{opacity:0;transform:translateY(-8px)} to{opacity:1;transform:translateY(0)} }
        .row-hover:hover { background:#f8fafc !important; }
        .copy-cell:hover { text-decoration:underline; cursor:pointer; }
        .act-btn:hover   { background:#f8fafc !important; }
        .del-btn:hover   { background:#fef2f2 !important; }
        .sol-card:hover  { border-color:#0b315f !important; }
        input:focus,select:focus,textarea:focus {
          border-color:#0b315f !important;
          box-shadow:0 0 0 3px rgba(11,49,95,.10) !important;
          outline:none;
        }
      `}</style>

      <ToastStack toasts={toasts} remove={removeToast} />

      {/* ── Modal editar / nuevo pasajero ── */}
      {(editandoPax || creandoPax) && (
        <div style={{ position: "fixed", inset: 0, zIndex: 80, display: "flex", alignItems: "center", justifyContent: "center", padding: 16, background: "rgba(15,23,42,0.55)" }}
          onClick={cerrarModalPax}>
          <div style={{ background: "white", borderRadius: 18, boxShadow: "0 20px 60px rgba(0,0,0,.18)", width: "100%", maxWidth: 480, overflow: "hidden" }}
            onClick={e => e.stopPropagation()}>
            {/* Header */}
            <div style={{ background: "#0b315f", padding: "18px 24px" }}>
              <p style={{ color: "white", fontWeight: 800, fontSize: 15, margin: 0 }}>{editandoPax ? "Editar pasajero" : "Nuevo pasajero"}</p>
              <p style={{ color: "#93c5fd", fontSize: 12, margin: "2px 0 0" }}>
                {editandoPax ? "DNI es el usuario de acceso · PIN para ingresar a la app" : "Si completas correo y/o teléfono, se enviará la invitación automática según los canales habilitados"}
              </p>
            </div>
            {/* Body */}
            <div style={{ padding: "20px 24px", display: "flex", flexDirection: "column", gap: 14 }}>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>Nombre completo *</p>
                  <input value={formPax.nombre} onChange={e => setFormPax(f => ({ ...f, nombre: e.target.value }))}
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>DNI *</p>
                  <input value={formPax.dni} onChange={e => setFormPax(f => ({ ...f, dni: e.target.value }))}
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 13, fontFamily: "monospace", outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>Teléfono</p>
                  <input value={formPax.telefono} onChange={e => setFormPax(f => ({ ...f, telefono: e.target.value }))}
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>Empresa</p>
                  <input value={formPax.empresa} onChange={e => setFormPax(f => ({ ...f, empresa: e.target.value }))}
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div style={{ gridColumn: "1 / -1" }}>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>Email (para enviar credenciales)</p>
                  <input type="email" value={formPax.email} onChange={e => setFormPax(f => ({ ...f, email: e.target.value }))}
                    placeholder="correo@empresa.com"
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>Edad</p>
                  <input value={formPax.edad} onChange={e => setFormPax(f => ({ ...f, edad: e.target.value.replace(/\D/g, "").slice(0, 3) }))}
                    inputMode="numeric" placeholder="Años (para Manifiesto MTC)"
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 13, outline: "none", boxSizing: "border-box" }} />
                </div>
                {editandoPax && (
                <div>
                  <p style={{ fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", margin: "0 0 4px" }}>PIN de acceso (4 dígitos)</p>
                  <input value={formPax.pin_acceso} onChange={e => setFormPax(f => ({ ...f, pin_acceso: e.target.value.replace(/\D/g, "").slice(0,4) }))}
                    placeholder={`default: ${formPax.dni.slice(-4) || "últimos 4 del DNI"}`}
                    maxLength={4}
                    style={{ width: "100%", border: "1px solid #e5e7eb", borderRadius: 9, padding: "8px 12px", fontSize: 16, fontFamily: "monospace", letterSpacing: 4, outline: "none", boxSizing: "border-box" }} />
                  <p style={{ fontSize: 10, color: "#94a3b8", margin: "4px 0 0" }}>Vacío = últimos 4 dígitos del DNI como PIN</p>
                </div>
                )}
                {editandoPax && (
                <div style={{ display: "flex", alignItems: "flex-end", gridColumn: "1 / -1" }}>
                  <button onClick={e => { e.stopPropagation(); if (editandoPax) enviarCredenciales([editandoPax.id]); }} disabled={!formPax.email || enviandoCreds.size > 0}
                    style={{ width: "100%", padding: "8px 12px", borderRadius: 9, border: "1px solid #0b315f", background: "white", fontSize: 12, fontWeight: 700, cursor: formPax.email ? "pointer" : "not-allowed", color: formPax.email ? "#0b315f" : "#94a3b8", opacity: formPax.email ? 1 : 0.5 }}>
                    {enviandoCreds.size > 0 ? "Enviando..." : "✉ Enviar credenciales"}
                  </button>
                </div>
                )}
              </div>
            </div>
            {/* Footer */}
            <div style={{ padding: "12px 24px 20px", display: "flex", gap: 10, justifyContent: "flex-end" }}>
              <button onClick={cerrarModalPax}
                style={{ padding: "9px 20px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                Cancelar
              </button>
              <button onClick={guardarPax} disabled={savingPax || !formPax.nombre.trim() || !formPax.dni.trim()}
                style={{ padding: "9px 24px", borderRadius: 10, border: "none", background: savingPax ? "#94a3b8" : "#0b315f", color: "white", fontSize: 13, fontWeight: 700, cursor: savingPax ? "not-allowed" : "pointer" }}>
                {savingPax ? "Guardando..." : "Guardar"}
              </button>
            </div>
          </div>
        </div>
      )}

      {toDelete && (
        <ConfirmModal title="¿Eliminar cliente?" danger
          msg={`Se eliminará permanentemente "${toDelete.nombre}" y todos sus contactos.`}
          confirmLabel="Eliminar" onOk={eliminarCliente} onCancel={() => setToDelete(null)} />
      )}

      {toDeleteDoc && (
        <ConfirmModal title="¿Eliminar documento?" danger
          msg={`Se eliminará "${toDeleteDoc.nombre}" del sistema. Esta acción no se puede deshacer.`}
          confirmLabel="Eliminar" onOk={eliminarDocumento} onCancel={() => setToDeleteDoc(null)} />
      )}

      {editSol && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: "white", borderRadius: 20, padding: 28, maxWidth: 640, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,.22)", animation: "scaleIn .18s ease" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <h3 style={{ fontWeight: 800, fontSize: 17, color: "#0f172a", margin: 0 }}>Editar solicitud</h3>
              <button onClick={() => setEditSol(null)} style={{ background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8" }}>✕</button>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              {([
                ["razon_social","Razón social",2],["nombre_comercial","Nombre comercial",1],
                ["tipo_doc","Tipo doc",1],["num_doc","Número doc",1],
                ["tipo_empresa","Tipo empresa",1],["rubro","Rubro",1],
                ["email_facturacion","Email facturación",2],["web","Web",1],
                ["direccion","Dirección",2],["distrito","Distrito",1],
                ["provincia","Provincia",1],["departamento","Departamento",1],
                ["condicion_pago","Condición pago",1],["moneda","Moneda",1],
                ["tipo_comprobante","Tipo comprobante",1],["volumen_compra","Volumen compra",1],
                ["como_nos_conocio","¿Cómo nos conoció?",2],
                ["observaciones","Observaciones",2],["nota_interna","Nota interna",2],
              ] as [keyof Solicitud, string, number][]).map(([key, label, span]) => (
                <div key={key} style={{ gridColumn: `span ${span}` }}>
                  <label style={{ display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".04em", color: "#6b7280", marginBottom: 4 }}>{label}</label>
                  {(key === "observaciones" || key === "nota_interna") ? (
                    <textarea value={(editSolForm[key] as string) || ""} onChange={e => setEditSolForm(p => ({ ...p, [key]: e.target.value }))}
                      style={{ ...inp(), resize: "none", height: 64 } as React.CSSProperties} />
                  ) : (
                    <input value={(editSolForm[key] as string) || ""} onChange={e => setEditSolForm(p => ({ ...p, [key]: e.target.value }))} style={inp()} />
                  )}
                </div>
              ))}
            </div>
            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", marginTop: 20, paddingTop: 16, borderTop: "1px solid #f1f5f9" }}>
              <button onClick={() => setEditSol(null)} style={{ padding: "9px 22px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>Cancelar</button>
              <button onClick={guardarEdicionSolicitud} disabled={guardandoSol}
                style={{ padding: "9px 22px", borderRadius: 10, border: "none", background: guardandoSol ? "#94a3b8" : "#0b315f", color: "white", fontSize: 13, fontWeight: 700, cursor: guardandoSol ? "not-allowed" : "pointer" }}>
                {guardandoSol ? "Guardando..." : "Guardar cambios"}
              </button>
            </div>
          </div>
        </div>
      )}

      {rechazarModal && (
        <ConfirmModal title="Rechazar solicitud" danger={false} confirmLabel="Rechazar solicitud"
          msg={`Estás rechazando la solicitud de "${rechazarModal.razon_social}". Puedes agregar un motivo:`}
          onOk={rechazarSolicitud} onCancel={() => { setRechazarModal(null); setNotaRechazo(""); }}>
          <textarea value={notaRechazo} onChange={e => setNotaRechazo(e.target.value)}
            placeholder="Motivo del rechazo (opcional)..."
            style={{ ...inp(), height: 80, resize: "none", marginTop: 4 } as React.CSSProperties} />
        </ConfirmModal>
      )}

      {toDeletePU && (
        <ConfirmModal title="¿Eliminar usuario del portal?" danger
          msg={`Se eliminará permanentemente el acceso de "${toDeletePU.nombre}" al portal cliente.`}
          confirmLabel="Eliminar" onOk={eliminarPU} onCancel={() => setToDeletePU(null)} />
      )}

      {modalPU && accesoCliente && (
        <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", zIndex: 9000, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
          <div style={{ background: "white", borderRadius: 20, padding: 28, maxWidth: 560, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,.22)", animation: "scaleIn .18s ease" }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 20 }}>
              <div>
                <h3 style={{ fontWeight: 800, fontSize: 17, color: "#0f172a", margin: 0 }}>{editPU ? "Editar usuario" : "Nuevo usuario del portal"}</h3>
                <p style={{ fontSize: 12, color: "#94a3b8", margin: "3px 0 0" }}>{accesoCliente.empresa || accesoCliente.nombre}</p>
              </div>
              <button onClick={() => { setModalPU(false); resetPUForm(); }} style={{ background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8" }}>✕</button>
            </div>

            {/* ── Importar desde contactos registrados ── */}
            {!editPU && (() => {
              const allContactos = accesoCliente.contactos || [];
              const admins = allContactos.filter(ct => ct.tipo === "administrativo");
              const ops    = allContactos.filter(ct => ct.tipo === "operativo");
              const lista  = puContactosTab === "admin" ? admins : ops;
              if (allContactos.length === 0) return null;
              return (
                <div style={{ marginBottom: 18 }}>
                  <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 10 }}>
                    <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".06em", color: "#6b7280", margin: 0 }}>
                      Importar de contactos registrados
                    </p>
                    {puImportadoDe && (
                      <span style={{ fontSize: 11, fontWeight: 700, background: "#dcfce7", color: "#166534", padding: "3px 10px", borderRadius: 20, display: "flex", alignItems: "center", gap: 5 }}>
                        ✓ {puImportadoDe}
                        <button type="button" onClick={() => setPuImportadoDe("")} style={{ background: "none", border: "none", cursor: "pointer", color: "#166534", fontSize: 12, padding: 0, lineHeight: 1 }}>✕</button>
                      </span>
                    )}
                  </div>
                  {/* Tabs admin / operativo */}
                  <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
                    {([["admin","administrativo","Administrativos","#1262bd"],["op","operativo","Operativos","#0f6e56"]] as [string,string,string,string][]).map(([key,_tipo,label,color]) => {
                      const count = key === "admin" ? admins.length : ops.length;
                      const active = puContactosTab === key;
                      return (
                        <button key={key} type="button" onClick={() => setPuContactosTab(key as "admin"|"op")}
                          style={{ padding: "5px 14px", borderRadius: 20, fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "all .12s",
                            border: `1.5px solid ${active ? color : "#e5e7eb"}`,
                            background: active ? color + "14" : "white", color: active ? color : "#94a3b8" }}>
                          {label} ({count})
                        </button>
                      );
                    })}
                  </div>
                  {/* Lista de contactos */}
                  {lista.length === 0 ? (
                    <p style={{ fontSize: 12, color: "#94a3b8", padding: "10px 12px", background: "#f8fafc", borderRadius: 8, margin: 0 }}>
                      Sin contactos {puContactosTab === "admin" ? "administrativos" : "operativos"} registrados para este cliente.
                    </p>
                  ) : (
                    <div style={{ display: "flex", flexDirection: "column" as const, gap: 6 }}>
                      {lista.map((ct, i) => {
                        const nombreCompleto = [ct.nombre, ct.apellido].filter(Boolean).join(" ");
                        const isSelected = puImportadoDe === nombreCompleto;
                        return (
                          <div key={i} onClick={() => importarContacto(ct)}
                            style={{ display: "flex", alignItems: "center", gap: 12, padding: "10px 14px", borderRadius: 10, cursor: "pointer", transition: "all .12s",
                              border: `1.5px solid ${isSelected ? "#0b315f" : "#e5e7eb"}`,
                              background: isSelected ? "#eef3f8" : "#f8fafc" }}>
                            <div style={{ width: 36, height: 36, borderRadius: 10, background: isSelected ? "#0b315f" : avatarBg(nombreCompleto), display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 11, fontWeight: 800, flexShrink: 0 }}>
                              {iniciales(nombreCompleto)}
                            </div>
                            <div style={{ flex: 1, minWidth: 0 }}>
                              <p style={{ fontWeight: 700, fontSize: 13, color: "#0f172a", margin: 0, whiteSpace: "nowrap" as const, overflow: "hidden", textOverflow: "ellipsis" }}>{nombreCompleto}</p>
                              <p style={{ fontSize: 11, color: "#94a3b8", margin: 0 }}>
                                {[ct.cargo, ct.telefono, ct.email].filter(Boolean).join(" · ")}
                              </p>
                            </div>
                            {ct.principal && <span style={{ fontSize: 10, fontWeight: 700, background: "#eff6ff", color: "#1262bd", padding: "2px 7px", borderRadius: 10, flexShrink: 0 }}>Principal</span>}
                            <span style={{ fontSize: 11, fontWeight: 700, color: isSelected ? "#0b315f" : "#94a3b8", flexShrink: 0 }}>
                              {isSelected ? "✓ Seleccionado" : "Usar →"}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  )}
                  {/* Divisor */}
                  <div style={{ display: "flex", alignItems: "center", gap: 10, margin: "16px 0 0" }}>
                    <div style={{ flex: 1, height: 1, background: "#f1f5f9" }}/>
                    <span style={{ fontSize: 10, fontWeight: 600, color: "#94a3b8", letterSpacing: ".04em", textTransform: "uppercase" as const }}>o completar manualmente</span>
                    <div style={{ flex: 1, height: 1, background: "#f1f5f9" }}/>
                  </div>
                </div>
              );
            })()}

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12, marginBottom: 16 }}>
              <Field label="Nombre completo *">
                <input style={inp()} placeholder="Nombre y apellidos" value={puNombre} onChange={e => { setPuNombre(e.target.value); setPuImportadoDe(""); }} />
              </Field>
              <div>
                <label style={{ display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".04em", color: "#6b7280", marginBottom: 4 }}>
                  Identificación * <span style={{ fontSize: 10, color: "#94a3b8", textTransform: "none" as const, fontWeight: 500, letterSpacing: 0 }}>— usado para iniciar sesión</span>
                </label>
                {/* Pills selector */}
                <div style={{ display: "flex", gap: 5, marginBottom: 7 }}>
                  {(["DNI","CE","Celular"] as const).map(t => (
                    <button key={t} type="button"
                      onClick={() => { setPuTipoDoc(t); setPuDni(""); }}
                      style={{ flex: 1, padding: "5px 0", borderRadius: 7, border: `1.5px solid ${puTipoDoc === t ? "#0b315f" : "#e5e7eb"}`, background: puTipoDoc === t ? "#eef3f8" : "white", color: puTipoDoc === t ? "#0b315f" : "#9ca3af", fontSize: 11, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "all .12s" }}>
                      {t === "CE" ? "Cédula / CE" : t}
                    </button>
                  ))}
                </div>
                <input
                  style={inp()}
                  placeholder={puTipoDoc === "DNI" ? "12345678" : puTipoDoc === "CE" ? "000123456" : "3001234567"}
                  maxLength={puTipoDoc === "DNI" ? 8 : 15}
                  value={puDni}
                  onChange={e => {
                    const v = e.target.value;
                    setPuDni(puTipoDoc === "CE" ? v.replace(/[^a-zA-Z0-9]/g, "") : v.replace(/\D/g, ""));
                  }}
                />
              </div>
              <Field label="Correo electrónico">
                <input type="email" style={inp()} placeholder="correo@empresa.com" value={puEmail} onChange={e => setPuEmail(e.target.value)} />
              </Field>
              <Field label="Cargo / Área">
                <input style={inp()} placeholder="Ej: Coordinador de transporte" value={puCargo} onChange={e => setPuCargo(e.target.value)} />
              </Field>
              <Field label="Rol">
                <select style={inp()} value={puRol} onChange={e => setPuRol(e.target.value as "admin"|"visor")}>
                  <option value="visor">Visor — solo lectura</option>
                  <option value="admin">Admin — gestión completa</option>
                </select>
              </Field>
              <Field label={editPU ? "Nueva contraseña (vacío = sin cambio)" : "Contraseña *"}>
                <div style={{ position: "relative" }}>
                  <input type={showPuPass ? "text" : "password"} style={{ ...inp(), paddingRight: 38 }} placeholder={editPU ? "Dejar vacío para no cambiar" : "Contraseña de acceso"} value={puPass} onChange={e => setPuPass(e.target.value)} />
                  <button type="button" onClick={() => setShowPuPass(p => !p)} style={{ position: "absolute", right: 10, top: "50%", transform: "translateY(-50%)", background: "none", border: "none", cursor: "pointer", color: "#94a3b8", fontSize: 14 }}>{showPuPass ? "🙈" : "👁"}</button>
                </div>
              </Field>
            </div>

            <div style={{ marginBottom: 16 }}>
              <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#6b7280", marginBottom: 10, marginTop: 0 }}>Módulos permitidos</p>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
                {MODULOS_CTRL.map(m => {
                  const on = puPermisos.includes(m.id);
                  return (
                    <button key={m.id} type="button"
                      onClick={() => setPuPermisos(p => on ? p.filter(x => x !== m.id) : [...p, m.id])}
                      style={{ display: "flex", alignItems: "center", gap: 8, padding: "8px 12px", borderRadius: 10, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", textAlign: "left",
                        border: `1.5px solid ${on ? "#0b315f" : "#e5e7eb"}`,
                        background: on ? "#eef3f8" : "white", color: on ? "#0b315f" : "#94a3b8" }}>
                      <span style={{ width: 16, height: 16, borderRadius: 4, border: `2px solid ${on ? "#0b315f" : "#d1d5db"}`, background: on ? "#0b315f" : "white", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0, fontSize: 10, color: "white" }}>{on ? "✓" : ""}</span>
                      {m.label}
                    </button>
                  );
                })}
              </div>
              <button type="button" onClick={() => setPuPermisos(puPermisos.length === MODULOS_CTRL.length ? [] : MODULOS_CTRL.map(m => m.id))}
                style={{ marginTop: 8, fontSize: 11, fontWeight: 600, color: "#64748b", background: "transparent", border: "none", cursor: "pointer", padding: 0, fontFamily: "inherit" }}>
                {puPermisos.length === MODULOS_CTRL.length ? "✕ Quitar todos" : "✓ Seleccionar todos"}
              </button>
            </div>

            {puErr && <p style={{ fontSize: 12, color: "#dc2626", background: "#fef2f2", padding: "8px 12px", borderRadius: 8, margin: "0 0 14px" }}>⚠ {puErr}</p>}

            <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", paddingTop: 16, borderTop: "1px solid #f1f5f9" }}>
              <button onClick={() => { setModalPU(false); resetPUForm(); }} style={{ padding: "9px 22px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#374151" }}>Cancelar</button>
              <button onClick={guardarPU} disabled={puLoad}
                style={{ padding: "9px 22px", borderRadius: 10, border: "none", background: puLoad ? "#94a3b8" : "#0b315f", color: "white", fontSize: 13, fontWeight: 700, cursor: puLoad ? "not-allowed" : "pointer" }}>
                {puLoad ? "Guardando..." : editPU ? "Actualizar usuario" : "Crear usuario"}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Resultado de la carga masiva de usuarios del portal ── */}
      {resultadoImportPU && (() => {
        const r = resultadoImportPU;
        const enviables = r.credenciales.filter(c => c.id && c.email && c.password && c.password !== "(sin cambio)");
        const conClave  = r.credenciales.filter(c => c.password && c.password !== "(sin cambio)");
        const nombreCli = accesoCliente?.empresa || accesoCliente?.nombre || "Cliente";
        return (
          <div style={{ position: "fixed", inset: 0, background: "rgba(15,23,42,.5)", zIndex: 9100, display: "flex", alignItems: "center", justifyContent: "center", padding: 20 }}>
            <div style={{ background: "white", borderRadius: 20, padding: 28, maxWidth: 620, width: "100%", maxHeight: "90vh", overflowY: "auto", boxShadow: "0 24px 64px rgba(0,0,0,.22)", animation: "scaleIn .18s ease" }}>
              <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 16 }}>
                <div>
                  <h3 style={{ fontWeight: 800, fontSize: 17, color: "#0f172a", margin: 0 }}>Carga masiva completada</h3>
                  <p style={{ fontSize: 12, color: "#94a3b8", margin: "3px 0 0" }}>{nombreCli} · Acceso al portal</p>
                </div>
                <button onClick={() => setResultadoImportPU(null)} style={{ background: "transparent", border: "none", fontSize: 18, cursor: "pointer", color: "#94a3b8" }}>✕</button>
              </div>

              {/* Resumen */}
              <div style={{ display: "flex", gap: 8, marginBottom: 16, flexWrap: "wrap" }}>
                <div style={{ flex: 1, minWidth: 120, background: "#f0fdf4", border: "1px solid #dcfce7", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#166534" }}>{r.insertados}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#16a34a" }}>Nuevos</div>
                </div>
                <div style={{ flex: 1, minWidth: 120, background: "#eff6ff", border: "1px solid #dbeafe", borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: "#1e40af" }}>{r.actualizados}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: "#2563eb" }}>Actualizados</div>
                </div>
                <div style={{ flex: 1, minWidth: 120, background: r.errores ? "#fef2f2" : "#f8fafc", border: `1px solid ${r.errores ? "#fecaca" : "#f1f5f9"}`, borderRadius: 12, padding: "12px 14px" }}>
                  <div style={{ fontSize: 22, fontWeight: 900, color: r.errores ? "#991b1b" : "#94a3b8" }}>{r.avisos.length}</div>
                  <div style={{ fontSize: 11, fontWeight: 700, color: r.errores ? "#dc2626" : "#94a3b8" }}>Errores / avisos</div>
                </div>
              </div>

              {/* Credenciales (destaca las autogeneradas) */}
              {conClave.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#6b7280", margin: "0 0 8px" }}>
                    Credenciales de acceso ({conClave.length})
                  </p>
                  <div style={{ border: "1px solid #f1f5f9", borderRadius: 12, overflow: "hidden", maxHeight: 220, overflowY: "auto" }}>
                    {conClave.map((c, i) => (
                      <div key={i} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", borderTop: i ? "1px solid #f1f5f9" : "none", background: "white" }}>
                        <div style={{ flex: 1, minWidth: 0 }}>
                          <span style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{c.nombre}</span>
                          <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8, fontFamily: "monospace" }}>{c.dni}</span>
                        </div>
                        <span style={{ fontSize: 12, fontWeight: 800, color: "#0b315f", fontFamily: "ui-monospace,monospace", background: "#eef3f8", padding: "2px 8px", borderRadius: 6 }}>{c.password}</span>
                        {c.email
                          ? <span style={{ fontSize: 10, color: "#16a34a", flexShrink: 0 }} title={c.email}>✓ correo</span>
                          : <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0 }}>sin correo</span>}
                      </div>
                    ))}
                  </div>
                  <p style={{ fontSize: 11, color: "#94a3b8", margin: "6px 0 0" }}>
                    🔒 Comparte estas contraseñas con cada usuario. Podrán cambiarla desde el portal.
                  </p>
                </div>
              )}

              {/* Avisos / errores */}
              {r.avisos.length > 0 && (
                <div style={{ marginBottom: 16 }}>
                  <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".06em", color: "#6b7280", margin: "0 0 8px" }}>Avisos ({r.avisos.length})</p>
                  <div style={{ background: "#fffbeb", border: "1px solid #fde68a", borderRadius: 12, padding: "10px 14px", maxHeight: 160, overflowY: "auto" }}>
                    {r.avisos.map((a, i) => (
                      <p key={i} style={{ fontSize: 12, color: "#92400e", margin: i ? "6px 0 0" : 0 }}>• {a}</p>
                    ))}
                  </div>
                </div>
              )}

              {/* Acciones */}
              <div style={{ display: "flex", gap: 10, justifyContent: "flex-end", flexWrap: "wrap", paddingTop: 16, borderTop: "1px solid #f1f5f9" }}>
                {conClave.length > 0 && (
                  <button onClick={() => descargarCredencialesPortal(nombreCli, r.credenciales.map(c => ({ nombre: c.nombre, dni: c.dni, email: c.email, password: c.password, rol: c.rol, estado: c.estado })))}
                    style={{ padding: "9px 16px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", color: "#374151" }}>
                    ↓ Descargar credenciales
                  </button>
                )}
                {enviables.length > 0 && (
                  <button onClick={enviarCredencialesImportadas} disabled={enviandoCredsPU}
                    style={{ padding: "9px 16px", borderRadius: 10, border: "none", background: enviandoCredsPU ? "#94a3b8" : "#16a34a", color: "white", fontSize: 12, fontWeight: 700, cursor: enviandoCredsPU ? "not-allowed" : "pointer" }}>
                    {enviandoCredsPU ? "Enviando..." : `✉ Enviar credenciales (${enviables.length})`}
                  </button>
                )}
                <button onClick={() => setResultadoImportPU(null)}
                  style={{ padding: "9px 22px", borderRadius: 10, border: "none", background: "#0b315f", color: "white", fontSize: 12, fontWeight: 700, cursor: "pointer" }}>
                  Cerrar
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <main style={{ padding: "28px 24px", maxWidth: 1320, margin: "0 auto", fontFamily: "system-ui,-apple-system,sans-serif", color: "#0f172a" }}>

        {/* ── HEADER ── */}
        <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", flexWrap: "wrap", gap: 12, marginBottom: 24 }}>
          <div>
            <h1 style={{ fontSize: 30, fontWeight: 900, margin: 0, letterSpacing: "-.5px" }}>Clientes</h1>
            <p style={{ fontSize: 13, color: "#94a3b8", margin: "3px 0 0" }}>AFA Transportes · Gestión comercial B2B y B2C</p>
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            {tab === "clientes" && <>
              <button onClick={cargarClientes} title="Actualizar" style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 15, color: "#64748b" }}>↻</button>
              <button onClick={exportCSV} style={{ padding: "10px 18px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 12, fontWeight: 700, color: "#374151" }}>↓ Exportar CSV</button>
              <button onClick={mostrarForm ? limpiarCliente : abrirNuevo}
                style={{ padding: "10px 22px", borderRadius: 10, border: "none", background: mostrarForm ? "#64748b" : "#0b315f", color: "white", cursor: "pointer", fontSize: 13, fontWeight: 700 }}>
                {mostrarForm ? "✕ Cancelar" : "+ Nuevo cliente"}
              </button>
            </>}
            {tab === "solicitudes" && (
              <button onClick={cargarSolicitudes} style={{ padding: "10px 14px", borderRadius: 10, border: "1px solid #e5e7eb", background: "white", cursor: "pointer", fontSize: 15, color: "#64748b" }}>↻</button>
            )}
          </div>
        </div>

        {/* ── KPIs (solo en clientes) ── */}
        {tab === "clientes" && (
          <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(130px,1fr))", gap: 12, marginBottom: 24 }}>
            {[
              { label: "Total",      v: total,      color: "#0b315f", bg: "#eef3f8", sub: "clientes" },
              { label: "B2B",        v: b2bCount,   color: "#1262bd", bg: "#eff6ff", sub: "empresas" },
              { label: "B2C",        v: b2cCount,   color: "#0f6e56", bg: "#f0fdf4", sub: "personas" },
              { label: "Activos",    v: activos,    color: "#166534", bg: "#dcfce7", sub: total ? `${Math.round(activos/total*100)}%` : "0%" },
              { label: "Bloqueados", v: bloqueados, color: "#991b1b", bg: "#fee2e2", sub: "con restricción" },
            ].map(k => (
              <div key={k.label} style={{ background: k.bg, border: `1px solid ${k.color}22`, borderRadius: 14, padding: "16px 18px" }}>
                <p style={{ fontSize: 10, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase", color: `${k.color}aa`, margin: "0 0 4px" }}>{k.label}</p>
                <p style={{ fontSize: 32, fontWeight: 900, color: k.color, margin: "0 0 2px", lineHeight: 1 }}>{k.v}</p>
                <p style={{ fontSize: 11, color: `${k.color}88`, margin: 0 }}>{k.sub}</p>
              </div>
            ))}
          </div>
        )}

        {/* ── TABS ── */}
        <div style={{ display: "flex", gap: 4, marginBottom: 24, background: "#f8fafc", borderRadius: 12, padding: 4, width: "fit-content" }}>
          {([
            { key: "clientes",     label: "Clientes",       count: total,          badge: false },
            { key: "solicitudes",  label: "Solicitudes",    count: pendienteCount, badge: true  },
          ] as { key: Tab; label: string; count: number; badge: boolean }[]).map(t => (
            <button key={t.key} onClick={() => setTab(t.key)}
              style={{ padding: "8px 20px", borderRadius: 9, border: "none", cursor: "pointer", fontSize: 13, fontWeight: 700, transition: "all .15s",
                background: tab === t.key ? "white" : "transparent",
                color: tab === t.key ? "#0b315f" : "#64748b",
                boxShadow: tab === t.key ? "0 1px 4px rgba(0,0,0,.08)" : "none",
                display: "flex", alignItems: "center", gap: 8 }}>
              {t.label}
              {t.badge && t.count > 0 && (
                <span style={{ background: "#ef4444", color: "white", borderRadius: 10, fontSize: 11, fontWeight: 700, padding: "1px 7px", minWidth: 20, textAlign: "center" }}>{t.count}</span>
              )}
            </button>
          ))}
        </div>

        {/* ════════════════════════════════════
            CLIENTES TAB
        ════════════════════════════════════ */}
        {tab === "clientes" && (<>

          {/* ── FORM ── */}
          {mostrarForm && (
            <div ref={formRef} style={{ background: "white", borderRadius: 20, border: "1px solid #e5e7eb", boxShadow: "0 4px 28px rgba(0,0,0,.07)", padding: 28, marginBottom: 24, animation: "slideDown .22s ease" }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 24 }}>
                <div style={{ width: 44, height: 44, borderRadius: 13, background: "#0b315f", display: "flex", alignItems: "center", justifyContent: "center", fontSize: 20 }}>{editandoId ? "✏️" : "➕"}</div>
                <div>
                  <h2 style={{ fontWeight: 800, fontSize: 17, margin: 0 }}>{editandoId ? "Editar cliente" : "Nuevo cliente"}</h2>
                  <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>* obligatorios · ESC para cerrar</p>
                </div>
              </div>

              {/* B2B / B2C */}
              <div style={{ display: "flex", gap: 10, marginBottom: 24 }}>
                {(["b2b","b2c"] as TipoCliente[]).map(t => (
                  <button key={t} type="button" onClick={() => { setForm(p => ({ ...p, tipo: t })); setErrors({}); }}
                    style={{ flex: 1, padding: 12, borderRadius: 12, fontWeight: 700, fontSize: 13, cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                      border: `2px solid ${form.tipo === t ? "#0b315f" : "#e5e7eb"}`,
                      background: form.tipo === t ? "#0b315f" : "white",
                      color: form.tipo === t ? "white" : "#9ca3af" }}>
                    {t === "b2b" ? "🏢 B2B — Empresa" : "👤 B2C — Persona natural"}
                  </button>
                ))}
              </div>

              {/* Datos principales */}
              <div style={{ marginBottom: 22 }}>
                <SecLabel>Datos principales</SecLabel>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
                  {form.tipo === "b2b" ? (<>
                    <Field label="Razón social *" span={2} error={errors.empresa}>
                      <input style={inp(!!errors.empresa)} placeholder="Ej: GLOBAL BUS S.A.C." value={form.empresa} onChange={f("empresa")} />
                    </Field>
                    <Field label="RUC" error={errors.ruc}>
                      <input style={inp(!!errors.ruc)} placeholder="20XXXXXXXXX" maxLength={11} value={form.ruc} onChange={f("ruc")} />
                    </Field>
                    <Field label="Nombre de contacto *" span={2} error={errors.nombre}>
                      <input style={inp(!!errors.nombre)} placeholder="Nombre y apellidos" value={form.nombre} onChange={f("nombre")} />
                    </Field>
                    <Field label="Estado">
                      <select style={inp()} value={form.estado} onChange={f("estado")}>
                        <option value="activo">Activo</option><option value="inactivo">Inactivo</option><option value="bloqueado">Bloqueado</option>
                      </select>
                    </Field>
                    <Field label="Tipo de empresa">
                      <select style={inp()} value={form.tipo_empresa} onChange={f("tipo_empresa")}>
                        <option value="">Seleccione...</option>
                        {["S.A.C.","S.A.","S.R.L.","E.I.R.L.","Persona Natural","ONG","Otro"].map(o => <option key={o}>{o}</option>)}
                      </select>
                    </Field>
                    <Field label="Rubro / Sector">
                      <select style={inp()} value={form.rubro} onChange={f("rubro")}>
                        <option value="">Seleccione...</option>
                        {["Comercio","Construcción","Educación","Gastronomía","Industria","Minería","Salud","Servicios","Tecnología","Transporte","Otro"].map(o => <option key={o}>{o}</option>)}
                      </select>
                    </Field>
                    <Field label="Nombre comercial">
                      <input style={inp()} placeholder="Si difiere de la razón social" value={form.nombre_comercial} onChange={f("nombre_comercial")} />
                    </Field>
                    <Field label="Teléfono">
                      <input style={inp()} placeholder="+51 9XX XXX XXX" value={form.telefono} onChange={f("telefono")} />
                    </Field>
                    <Field label="Email" error={errors.email}>
                      <input type="email" style={inp(!!errors.email)} placeholder="correo@empresa.com" value={form.email} onChange={f("email")} />
                    </Field>
                    <Field label="Email facturación" hint="Recibe comprobantes SUNAT">
                      <input type="email" style={inp()} placeholder="facturacion@empresa.com" value={form.email_facturacion} onChange={f("email_facturacion")} />
                    </Field>
                  </>) : (<>
                    <Field label="Nombre completo *" span={2} error={errors.nombre}>
                      <input style={inp(!!errors.nombre)} placeholder="Nombre y apellidos" value={form.nombre} onChange={f("nombre")} />
                    </Field>
                    <Field label="DNI" error={errors.dni}>
                      <input style={inp(!!errors.dni)} maxLength={8} placeholder="12345678" value={form.dni} onChange={f("dni")} />
                    </Field>
                    <Field label="Teléfono">
                      <input style={inp()} placeholder="+51 9XX XXX XXX" value={form.telefono} onChange={f("telefono")} />
                    </Field>
                    <Field label="Email" span={2} error={errors.email}>
                      <input type="email" style={inp(!!errors.email)} placeholder="correo@persona.com" value={form.email} onChange={f("email")} />
                    </Field>
                    <Field label="Estado">
                      <select style={inp()} value={form.estado} onChange={f("estado")}>
                        <option value="activo">Activo</option><option value="inactivo">Inactivo</option><option value="bloqueado">Bloqueado</option>
                      </select>
                    </Field>
                  </>)}
                </div>
              </div>

              {/* Contacts B2B */}
              {form.tipo === "b2b" && (<>
                {/* ADMINISTRATIVOS */}
                <div style={{ marginBottom: 20 }}>
                  <SecLabel>Contactos administrativos</SecLabel>
                  {form.contactos_admin.map((c: FormContacto, i: number) => (
                    <ContactCard key={i} contacto={c} index={i} tipo="admin"
                      onChange={(k, v) => updateContacto("admin", i, k, v)}
                      onRemove={() => removeContacto("admin", i)}
                      canRemove={form.contactos_admin.length > 1} />
                  ))}
                  <button type="button" onClick={() => addContacto("admin")}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", padding: "9px", border: "1.5px dashed #1262bd", borderRadius: 10, background: "transparent", color: "#1262bd", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    + Agregar contacto administrativo
                  </button>
                </div>

                {/* OPERATIVOS */}
                <div style={{ marginBottom: 20 }}>
                  <SecLabel>Contactos operativos</SecLabel>
                  {form.contactos_op.map((c: FormContacto, i: number) => (
                    <ContactCard key={i} contacto={c} index={i} tipo="op"
                      onChange={(k, v) => updateContacto("op", i, k, v)}
                      onRemove={() => removeContacto("op", i)}
                      canRemove={form.contactos_op.length > 1} />
                  ))}
                  <button type="button" onClick={() => addContacto("op")}
                    style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", padding: "9px", border: "1.5px dashed #0f6e56", borderRadius: 10, background: "transparent", color: "#0f6e56", fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
                    + Agregar contacto operativo
                  </button>
                </div>
              </>)}

              {/* Servicios */}
              <div style={{ marginBottom: 20 }}>
                <SecLabel>Servicios de interés</SecLabel>
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {SERVICIOS.map(s => {
                    const on = form.servicios_interes.includes(s);
                    return (
                      <button key={s} type="button" onClick={() => toggleSvc(s)}
                        style={{ padding: "7px 16px", borderRadius: 20, fontSize: 12, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                          border: `1.5px solid ${on ? "#0b315f" : "#e5e7eb"}`,
                          background: on ? "#0b315f" : "white", color: on ? "white" : "#6b7280" }}>
                        {on && "✓ "}{s}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Comercial (B2B) */}
              {form.tipo === "b2b" && (
                <div style={{ marginBottom: 20 }}>
                  <SecLabel>Condiciones comerciales</SecLabel>
                  <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
                    <Field label="Condición de pago">
                      <select style={inp()} value={form.condicion_pago} onChange={f("condicion_pago")}>
                        <option value="">Seleccione...</option>
                        {["Contado","Crédito 15d","Crédito 30d","Crédito 45d","Crédito 60d","Crédito 90d"].map(o => <option key={o}>{o}</option>)}
                      </select>
                    </Field>
                    <Field label="Moneda">
                      <select style={inp()} value={form.moneda} onChange={f("moneda")}>
                        <option value="">Seleccione...</option>
                        <option>Soles (PEN)</option><option>Dólares (USD)</option><option>Euros (EUR)</option>
                      </select>
                    </Field>
                    <Field label="Tipo de comprobante">
                      <select style={inp()} value={form.tipo_comprobante} onChange={f("tipo_comprobante")}>
                        <option value="">Seleccione...</option>
                        <option>Factura electrónica</option><option>Boleta electrónica</option><option>Ambas</option>
                      </select>
                    </Field>
                    <Field label="Volumen estimado / mes">
                      <select style={inp()} value={form.volumen_compra} onChange={f("volumen_compra")}>
                        <option value="">Seleccione...</option>
                        {["Menos de S/ 5,000","S/ 5,000 – 20,000","S/ 20,000 – 50,000","Más de S/ 50,000"].map(o => <option key={o}>{o}</option>)}
                      </select>
                    </Field>
                    <Field label="¿Cómo nos conoció?">
                      <select style={inp()} value={form.como_nos_conocio} onChange={f("como_nos_conocio")}>
                        <option value="">Seleccione...</option>
                        {["Recomendación","Redes sociales","Google","Feria","Visita vendedor","Correo","Otro"].map(o => <option key={o}>{o}</option>)}
                      </select>
                    </Field>
                  </div>
                </div>
              )}

              {/* Ubicación */}
              <div style={{ marginBottom: 24 }}>
                <SecLabel>Ubicación y notas</SecLabel>
                <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 14 }}>
                  <Field label="Dirección" span={2}>
                    <input style={inp()} placeholder="Av., calle, número..." value={form.direccion} onChange={f("direccion")} />
                  </Field>
                  <Field label="Distrito / Ciudad">
                    <input style={inp()} placeholder="Ej: Miraflores" value={form.distrito} onChange={f("distrito")} />
                  </Field>
                  <Field label="Notas internas" span={3}>
                    <textarea style={{ ...inp(), resize: "none", height: 72 } as React.CSSProperties} placeholder="Observaciones, condiciones especiales..." value={form.notas} onChange={f("notas")} />
                  </Field>
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, paddingTop: 16, borderTop: "1px solid #f1f5f9" }}>
                <button onClick={guardarCliente} disabled={guardando}
                  style={{ padding: "11px 30px", borderRadius: 11, border: "none", background: guardando ? "#94a3b8" : "#0b315f", color: "white", fontSize: 13, fontWeight: 700, cursor: guardando ? "not-allowed" : "pointer" }}>
                  {guardando ? "Guardando..." : editandoId ? "Actualizar cliente" : "Guardar cliente"}
                </button>
                <button onClick={limpiarCliente} style={{ padding: "11px 22px", borderRadius: 11, border: "1px solid #e5e7eb", background: "white", fontSize: 13, fontWeight: 600, cursor: "pointer", color: "#64748b" }}>Cancelar</button>
              </div>
            </div>
          )}

          {/* ── FILTERS ── */}
          <div style={{ display: "flex", gap: 10, marginBottom: 16, flexWrap: "wrap" }}>
            <div style={{ position: "relative", flex: 1, minWidth: 220 }}>
              <span style={{ position: "absolute", left: 12, top: "50%", transform: "translateY(-50%)", fontSize: 14, color: "#94a3b8" }}>🔍</span>
              <input style={{ width: "100%", boxSizing: "border-box", padding: "10px 12px 10px 38px", border: "1px solid #e5e7eb", borderRadius: 11, fontSize: 13, outline: "none" }}
                placeholder="Buscar por nombre, empresa, RUC, DNI, email..." value={busqueda} onChange={e => setBusqueda(e.target.value)} />
            </div>
            {[
              { val: filtroTipo,   set: setFiltroTipo,   opts: [["todos","Todos los tipos"],["b2b","🏢 B2B"],["b2c","👤 B2C"]] },
              { val: filtroEstado, set: setFiltroEstado, opts: [["todos","Todos los estados"],["activo","Activos"],["inactivo","Inactivos"],["bloqueado","Bloqueados"]] },
              { val: filtroSvc,    set: setFiltroSvc,    opts: [["todos","Todos los servicios"],...SERVICIOS.map(s=>[s,s])] },
            ].map((filter, i) => (
              <select key={i} value={filter.val} onChange={e => filter.set(e.target.value)}
                style={{ padding: "10px 14px", border: "1px solid #e5e7eb", borderRadius: 11, fontSize: 13, minWidth: 160, cursor: "pointer" }}>
                {filter.opts.map(([v,l]) => <option key={v} value={v}>{l}</option>)}
              </select>
            ))}
            <button onClick={() => setSortDir(d => d === "asc" ? "desc" : "asc")}
              style={{ padding: "10px 14px", border: "1px solid #e5e7eb", borderRadius: 11, fontSize: 12, fontWeight: 700, cursor: "pointer", background: "white", color: "#374151" }}>
              A→Z {sortDir === "asc" ? "↑" : "↓"}
            </button>
            <div style={{ padding: "10px 16px", background: "#f8fafc", border: "1px solid #e5e7eb", borderRadius: 11, fontSize: 12, color: "#64748b", display: "flex", alignItems: "center" }}>
              {filtrados.length} resultado{filtrados.length !== 1 ? "s" : ""}
            </div>
          </div>

          {/* ── TABLE ── */}
          <div style={{ background: "white", borderRadius: 20, border: "1px solid #e5e7eb", boxShadow: "0 2px 12px rgba(0,0,0,.04)", overflow: "hidden" }}>
            <div style={{ overflowX: "auto" }}>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                <thead>
                  <tr style={{ background: "#f8fafc", borderBottom: "1px solid #e2e8f0" }}>
                    <th style={{ width: 36, padding: "12px 8px 12px 18px" }} />
                    {["Cliente","Tipo","Identificación","Contacto principal","Servicios","Estado","Acciones"].map(h => (
                      <th key={h} style={{ padding: "12px 14px", textAlign: "left", fontSize: 10, fontWeight: 700, color: "#64748b", textTransform: "uppercase", letterSpacing: ".06em", whiteSpace: "nowrap" }}>{h}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {loadingCli ? <Skeleton /> : filtrados.length === 0 ? (
                    <tr><td colSpan={8} style={{ padding: "64px 20px", textAlign: "center", color: "#94a3b8" }}>
                      <div style={{ fontSize: 38, marginBottom: 12 }}>👥</div>
                      <p style={{ fontWeight: 700, fontSize: 15, color: "#475569", margin: "0 0 6px" }}>Sin resultados</p>
                      <p style={{ fontSize: 13, margin: 0 }}>{busqueda ? "Prueba con otros filtros" : "Agrega el primer cliente"}</p>
                    </td></tr>
                  ) : filtrados.map(c => {
                    const est     = ESTADO_CLIENTE[c.estado] || ESTADO_CLIENTE.inactivo;
                    const expd    = expandidoId === c.id;
                    const display = c.tipo === "b2b" ? (c.empresa || c.nombre) : c.nombre;
                    const svcs    = parseSvc(c.servicios_interes);
                    const adminPrincipal = (c.contactos || []).find(x => x.tipo === "administrativo" && x.principal) || (c.contactos || []).find(x => x.tipo === "administrativo");
                    const opPrincipal    = (c.contactos || []).find(x => x.tipo === "operativo" && x.principal)    || (c.contactos || []).find(x => x.tipo === "operativo");
                    const adminCount  = (c.contactos || []).filter(x => x.tipo === "administrativo").length;
                    const opCount     = (c.contactos || []).filter(x => x.tipo === "operativo").length;

                    return (
                      <React.Fragment key={c.id}>
                        <tr className="row-hover" style={{ borderTop: "1px solid #f1f5f9", cursor: "pointer" }}
                          onClick={() => expandirCliente(c)}>
                          <td style={{ padding: "14px 8px 14px 18px", color: "#cbd5e1", fontSize: 11 }}>{expd ? "▼" : "▶"}</td>
                          <td style={{ padding: "14px" }}>
                            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
                              <div style={{ width: 38, height: 38, borderRadius: 11, background: avatarBg(display), display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 12, fontWeight: 800, flexShrink: 0 }}>{iniciales(display)}</div>
                              <div>
                                <p style={{ fontWeight: 700, color: "#0f172a", margin: 0, fontSize: 13 }}>{display}</p>
                                {c.tipo === "b2b" && c.nombre && c.nombre !== c.empresa && <p style={{ fontSize: 11, color: "#94a3b8", margin: 0 }}>Cto: {c.nombre}</p>}
                                {c.distrito && <p style={{ fontSize: 11, color: "#cbd5e1", margin: 0 }}>📍 {c.distrito}</p>}
                              </div>
                            </div>
                          </td>
                          <td style={{ padding: "14px" }}>
                            <span style={{ fontSize: 11, fontWeight: 700, padding: "4px 10px", borderRadius: 8, ...(c.tipo==="b2b" ? {background:"#eff6ff",color:"#1d4ed8"} : {background:"#f0fdf4",color:"#166534"}) }}>
                              {c.tipo === "b2b" ? "🏢 B2B" : "👤 B2C"}
                            </span>
                          </td>
                          <td style={{ padding: "14px", fontFamily: "monospace", fontSize: 12, color: "#64748b" }}>
                            {c.tipo==="b2b" ? (c.ruc ? `RUC: ${c.ruc}` : "—") : (c.dni ? `DNI: ${c.dni}` : "—")}
                          </td>
                          <td style={{ padding: "14px" }} onClick={e => e.stopPropagation()}>
                            {adminPrincipal && (
                              <div style={{ fontSize: 12 }}>
                                <span style={{ fontWeight: 600, color: "#1262bd", display: "block" }}>{adminPrincipal.nombre} {adminPrincipal.apellido || ""}</span>
                                {adminPrincipal.telefono && <span className="copy-cell" onClick={() => copiar(adminPrincipal.telefono!, "Teléfono")} style={{ color: "#64748b", display: "block" }}>📞 {adminPrincipal.telefono}</span>}
                              </div>
                            )}
                            {!adminPrincipal && c.telefono && <span className="copy-cell" onClick={() => copiar(c.telefono!, "Teléfono")} style={{ fontSize: 12, color: "#64748b" }}>📞 {c.telefono}</span>}
                            {!adminPrincipal && !c.telefono && <span style={{ color: "#e2e8f0" }}>—</span>}
                          </td>
                          <td style={{ padding: "14px" }}>
                            <div style={{ display: "flex", flexWrap: "wrap", gap: 4, maxWidth: 200 }}>
                              {svcs.length ? svcs.map(s => <SvcTag key={s} label={s}/>) : <span style={{ color: "#e2e8f0", fontSize: 11 }}>—</span>}
                            </div>
                          </td>
                          <td style={{ padding: "14px" }} onClick={e => e.stopPropagation()}>
                            <select value={c.estado} onChange={e => cambiarEstado(c.id, e.target.value as EstadoCliente)}
                              style={{ fontSize: 11, fontWeight: 700, padding: "5px 10px", borderRadius: 8, border: "none", cursor: "pointer", background: est.bg, color: est.color, outline: "none" }}>
                              <option value="activo">Activo</option><option value="inactivo">Inactivo</option><option value="bloqueado">Bloqueado</option>
                            </select>
                          </td>
                          <td style={{ padding: "14px" }} onClick={e => e.stopPropagation()}>
                            <div style={{ display: "flex", gap: 6, justifyContent: "flex-end" }}>
                              <button className="act-btn" onClick={() => editarCliente(c)} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #e5e7eb", background: "white", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#374151" }}>Editar</button>
                              <button className="del-btn" onClick={() => setToDelete({ id: c.id, nombre: display })} style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid #fecaca", background: "white", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#dc2626" }}>Eliminar</button>
                            </div>
                          </td>
                        </tr>

                        {expd && (
                          <tr style={{ background: "#f8fafc", borderTop: "1px solid #f1f5f9", borderBottom: "1px solid #f1f5f9" }}>
                            <td colSpan={8} style={{ padding: "20px 24px", animation: "slideDown .18s ease" }}>
                              <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 20 }}>
                                <div>
                                  <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#94a3b8", marginBottom: 10 }}>Datos generales</p>
                                  <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#475569" }}>
                                    {c.direccion && <span>📍 {c.direccion}{c.distrito ? `, ${c.distrito}` : ""}</span>}
                                    {c.email     && <span className="copy-cell" onClick={() => copiar(c.email!, "Email")}>✉️ {c.email}</span>}
                                    {c.email_facturacion && <span style={{ color: "#94a3b8" }}>🧾 {c.email_facturacion}</span>}
                                    {c.condicion_pago   && <span>💳 {c.condicion_pago} · {c.moneda || "PEN"}</span>}
                                    {c.created_at && <span style={{ color: "#94a3b8", fontSize: 11 }}>📅 Alta: {fmtDate(c.created_at)}</span>}
                                    {c.notas && <span style={{ fontStyle: "italic", color: "#94a3b8" }}>"{c.notas}"</span>}
                                  </div>
                                </div>

                                {/* Contactos administrativos */}
                                {adminCount > 0 && (
                                  <div>
                                    <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#1262bd", marginBottom: 10 }}>
                                      Contactos administrativos ({adminCount})
                                    </p>
                                    {(c.contactos||[]).filter(x=>x.tipo==="administrativo").map((ct,i) => (
                                      <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < adminCount-1 ? "1px solid #f1f5f9" : "none" }}>
                                        <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{ct.nombre} {ct.apellido||""}</span>
                                        {ct.principal && <span style={{ fontSize: 10, background: "#eff6ff", color: "#1262bd", padding: "1px 6px", borderRadius: 10, marginLeft: 6, fontWeight: 700 }}>Principal</span>}
                                        {ct.cargo    && <p style={{ fontSize: 11, color: "#94a3b8", margin: "2px 0 0" }}>{ct.cargo}</p>}
                                        {ct.telefono && <p className="copy-cell" onClick={() => copiar(ct.telefono!, "Celular")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>📱 {ct.telefono}</p>}
                                        {ct.email    && <p className="copy-cell" onClick={() => copiar(ct.email!, "Email")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>✉️ {ct.email}</p>}
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {/* Contactos operativos */}
                                {opCount > 0 && (
                                  <div>
                                    <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#0f6e56", marginBottom: 10 }}>
                                      Contactos operativos ({opCount})
                                    </p>
                                    {(c.contactos||[]).filter(x=>x.tipo==="operativo").map((ct,i) => (
                                      <div key={i} style={{ marginBottom: 10, paddingBottom: 10, borderBottom: i < opCount-1 ? "1px solid #f1f5f9" : "none" }}>
                                        <span style={{ fontWeight: 600, fontSize: 12, color: "#0f172a" }}>{ct.nombre} {ct.apellido||""}</span>
                                        {ct.principal && <span style={{ fontSize: 10, background: "#f0fdf4", color: "#0f6e56", padding: "1px 6px", borderRadius: 10, marginLeft: 6, fontWeight: 700 }}>Principal</span>}
                                        {ct.cargo    && <p style={{ fontSize: 11, color: "#94a3b8", margin: "2px 0 0" }}>{ct.cargo}</p>}
                                        {ct.telefono && <p className="copy-cell" onClick={() => copiar(ct.telefono!, "Celular")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>📱 {ct.telefono}</p>}
                                        {ct.email    && <p className="copy-cell" onClick={() => copiar(ct.email!, "Email")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>✉️ {ct.email}</p>}
                                      </div>
                                    ))}
                                  </div>
                                )}

                                {svcs.length > 0 && (
                                  <div>
                                    <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#94a3b8", marginBottom: 10 }}>Servicios de interés</p>
                                    <div style={{ display: "flex", flexWrap: "wrap", gap: 6 }}>{svcs.map(s=><SvcTag key={s} label={s}/>)}</div>
                                  </div>
                                )}
                              </div>

                              {/* ── Acceso al Portal ── */}
                              <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 16, paddingTop: 16 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                                  <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#64748b", margin: 0, flex: 1 }}>
                                    Acceso al Portal {loadingPU ? "…" : `(${portalUsers.length})`}
                                  </p>
                                  <button onClick={e => { e.stopPropagation(); descargarPlantillaPortalUsuarios(MODULOS_CTRL); }}
                                    style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #e5e7eb", background: "white", fontSize: 11, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                                    ↓ Plantilla
                                  </button>
                                  <button onClick={e => { e.stopPropagation(); puImportInputRef.current?.click(); }} disabled={importandoPU}
                                    style={{ padding: "5px 12px", borderRadius: 8, border: "1px solid #e5e7eb", background: importandoPU ? "#94a3b8" : "white", fontSize: 11, fontWeight: 600, cursor: importandoPU ? "not-allowed" : "pointer", color: importandoPU ? "white" : "#374151" }}>
                                    {importandoPU ? "Importando..." : "⇪ Subir Excel"}
                                  </button>
                                  <input ref={puImportInputRef} type="file" accept=".xls,.xlsx,.csv" style={{ display: "none" }}
                                    onChange={e => { e.stopPropagation(); const file = e.target.files?.[0]; if (file && expandidoId) handlePortalUsuariosArchivo(file, expandidoId); e.target.value = ""; }} />
                                  <button onClick={e => { e.stopPropagation(); resetPUForm(); setModalPU(true); }}
                                    style={{ padding: "5px 14px", borderRadius: 8, border: "none", background: "#0b315f", color: "white", fontSize: 11, fontWeight: 700, cursor: "pointer" }}>
                                    + Nuevo usuario
                                  </button>
                                </div>
                                {loadingPU ? (
                                  <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>Cargando...</p>
                                ) : portalUsers.length === 0 ? (
                                  <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>Sin usuarios configurados aún.</p>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                    {portalUsers.map(u => (
                                      <div key={u.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "white", borderRadius: 10, border: "1px solid #f1f5f9" }}>
                                        <div style={{ width: 28, height: 28, borderRadius: 8, background: u.activo ? avatarBg(u.nombre) : "#e5e7eb", display: "flex", alignItems: "center", justifyContent: "center", color: u.activo ? "white" : "#9ca3af", fontSize: 9, fontWeight: 800, flexShrink: 0 }}>{iniciales(u.nombre)}</div>
                                        <div style={{ flex: 1 }}>
                                          <span style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{u.nombre}</span>
                                          <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>ID: {u.dni}</span>
                                          {u.cargo && <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>{u.cargo}</span>}
                                        </div>
                                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: u.rol === "admin" ? "#eef3f8" : "#f0fdf4", color: u.rol === "admin" ? "#0b315f" : "#166534" }}>{u.rol === "admin" ? "Admin" : "Visor"}</span>
                                        <span style={{ fontSize: 10, fontWeight: 700, padding: "2px 8px", borderRadius: 8, background: u.activo ? "#dcfce7" : "#fee2e2", color: u.activo ? "#166534" : "#991b1b" }}>{u.activo ? "Activo" : "Inactivo"}</span>
                                        <button className="act-btn" onClick={e => { e.stopPropagation(); abrirEditarPU(u); }} style={{ padding: "4px 10px", borderRadius: 7, border: "1px solid #e5e7eb", background: "white", fontSize: 10, fontWeight: 600, cursor: "pointer", color: "#374151" }}>Editar</button>
                                        <button className="del-btn" onClick={e => { e.stopPropagation(); setToDeletePU({ id: u.id, nombre: u.nombre }); }} style={{ padding: "4px 8px", borderRadius: 7, border: "1px solid #fecaca", background: "white", fontSize: 10, cursor: "pointer", color: "#dc2626" }}>✕</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                              {/* ── Nómina de pasajeros ── */}
                              {(() => {
                                const nomina = nominaMap[expandidoId!] || [];
                                const conEmail = nomina.filter(p => p.email);
                                return (
                                  <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 16, paddingTop: 16 }}>
                                    {/* Header row */}
                                    <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 10, flexWrap: "wrap" }}>
                                      <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#64748b", margin: 0, flex: 1 }}>
                                        Nómina de pasajeros {loadingNomina ? "…" : `(${nomina.length})`}
                                      </p>
                                      {nomina.length > 0 && (
                                        <button onClick={e => { e.stopPropagation(); setNominaExpandida(v => !v); }}
                                          style={{ padding: "4px 10px", borderRadius: 7, border: "1px solid #e5e7eb", background: "white", fontSize: 10, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                                          {nominaExpandida ? "⊖ Compactar" : "⊕ Expandir"}
                                        </button>
                                      )}
                                      {conEmail.length > 0 && (
                                        <button onClick={e => { e.stopPropagation(); enviarCredenciales(nomina.map(p => p.id)); }} disabled={enviandoCreds.size > 0}
                                          style={{ padding: "4px 12px", borderRadius: 7, border: "none", background: enviandoCreds.size > 0 ? "#94a3b8" : "#16a34a", color: "white", fontSize: 10, fontWeight: 700, cursor: enviandoCreds.size > 0 ? "not-allowed" : "pointer" }}>
                                          {enviandoCreds.size > 0 ? "Enviando..." : `✉ Enviar credenciales (${conEmail.length})`}
                                        </button>
                                      )}
                                      <button onClick={e => { e.stopPropagation(); descargarPlantilla(); }}
                                        style={{ padding: "4px 10px", borderRadius: 7, border: "1px solid #e5e7eb", background: "white", fontSize: 10, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                                        ↓ Plantilla
                                      </button>
                                      <button onClick={e => { e.stopPropagation(); abrirNuevoPax(); }}
                                        style={{ padding: "4px 12px", borderRadius: 7, border: "1px solid #0b315f", background: "white", fontSize: 10, fontWeight: 700, cursor: "pointer", color: "#0b315f" }}>
                                        + Nuevo pasajero
                                      </button>
                                      <button onClick={e => { e.stopPropagation(); nominaInputRef.current?.click(); }} disabled={importandoNomina}
                                        style={{ padding: "4px 12px", borderRadius: 7, border: "none", background: importandoNomina ? "#94a3b8" : "#0b315f", color: "white", fontSize: 10, fontWeight: 700, cursor: importandoNomina ? "not-allowed" : "pointer" }}>
                                        {importandoNomina ? "Importando..." : "+ Subir Excel"}
                                      </button>
                                      <input ref={nominaInputRef} type="file" accept=".xls,.xlsx,.csv" style={{ display: "none" }}
                                        onChange={e => { e.stopPropagation(); const file = e.target.files?.[0]; if (file && expandidoId) handleNominaArchivo(file, expandidoId); e.target.value = ""; }} />
                                    </div>
                                    <div style={{ display: "flex", alignItems: "center", gap: 14, marginBottom: 10 }} onClick={e => e.stopPropagation()}>
                                      <span style={{ fontSize: 10, color: "#94a3b8", fontWeight: 600 }}>Al crear pasajero, enviar invitación automática por:</span>
                                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                                        <input type="checkbox" checked={canalEmail} onChange={e => setCanalEmail(e.target.checked)} />
                                        ✉ Correo
                                      </label>
                                      <label style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, fontWeight: 600, color: "#374151", cursor: "pointer" }}>
                                        <input type="checkbox" checked={canalWhatsapp} onChange={e => setCanalWhatsapp(e.target.checked)} />
                                        💬 WhatsApp
                                      </label>
                                    </div>
                                    {/* List */}
                                    {loadingNomina ? (
                                      <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>Cargando nómina...</p>
                                    ) : nomina.length === 0 ? (
                                      <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>Sin pasajeros. Usa "+ Subir Excel" para importar la nómina (mismo formato que el manifiesto).</p>
                                    ) : (
                                      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxHeight: nominaExpandida ? "none" : 240, overflowY: nominaExpandida ? "visible" : "auto" }}>
                                        {nomina.map(p => (
                                          <div key={p.id} style={{ display: "flex", alignItems: "center", gap: 8, padding: "5px 10px", background: "white", borderRadius: 8, border: "1px solid #f1f5f9" }}>
                                            <span style={{ fontWeight: 700, fontSize: 11, color: "#0f172a", flex: 1, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.nombre}</span>
                                            <span style={{ fontSize: 10, color: "#64748b", fontFamily: "monospace", flexShrink: 0 }}>{p.dni}</span>
                                            {p.edad != null && <span style={{ fontSize: 10, color: "#64748b", flexShrink: 0 }} title="Edad">{p.edad} años</span>}
                                            {p.empresa && <span style={{ fontSize: 10, color: "#94a3b8", flexShrink: 0, maxWidth: 120, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>{p.empresa}</span>}
                                            {p.email
                                              ? <span style={{ fontSize: 10, color: "#16a34a", flexShrink: 0 }}>✓ email</span>
                                              : <span style={{ fontSize: 10, color: "#f59e0b", flexShrink: 0 }}>sin email</span>}
                                            <button onClick={e => { e.stopPropagation(); abrirEditarPax(p); }}
                                              style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid #e5e7eb", background: "white", fontSize: 10, fontWeight: 600, cursor: "pointer", color: "#374151", flexShrink: 0 }}>✎</button>
                                            <button onClick={e => { e.stopPropagation(); enviarCredenciales([p.id]); }} disabled={!p.email || enviandoCreds.has(p.id)}
                                              title={p.email ? "Enviar credenciales" : "Agrega un email primero"}
                                              style={{ padding: "3px 8px", borderRadius: 6, border: "1px solid #e5e7eb", background: "white", fontSize: 10, fontWeight: 600, cursor: p.email ? "pointer" : "not-allowed", color: p.email ? "#0b315f" : "#cbd5e1", flexShrink: 0, opacity: p.email ? 1 : 0.5 }}>✉</button>
                                          </div>
                                        ))}
                                      </div>
                                    )}
                                  </div>
                                );
                              })()}

                              {/* ── Documentos ── */}
                              <div style={{ borderTop: "1px solid #e2e8f0", marginTop: 16, paddingTop: 16 }}>
                                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 10 }}>
                                  <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#64748b", margin: 0, flex: 1 }}>
                                    Documentos {loadingDocs ? "…" : `(${expandDocs.length})`}
                                  </p>
                                  <select value={docCategoria} onChange={e => setDocCategoria(e.target.value)} onClick={e => e.stopPropagation()}
                                    style={{ fontSize: 11, padding: "5px 8px", borderRadius: 8, border: "1px solid #e5e7eb", background: "white", color: "#374151", cursor: "pointer", outline: "none" }}>
                                    <option>Contratos</option>
                                    <option>Cotizaciones</option>
                                    <option>Otros</option>
                                  </select>
                                  <button onClick={e => { e.stopPropagation(); docInputRef.current?.click(); }} disabled={subiendoDoc}
                                    style={{ padding: "5px 14px", borderRadius: 8, border: "none", background: subiendoDoc ? "#94a3b8" : "#0f6e56", color: "white", fontSize: 11, fontWeight: 700, cursor: subiendoDoc ? "not-allowed" : "pointer" }}>
                                    {subiendoDoc ? "Subiendo..." : "+ Subir archivo"}
                                  </button>
                                  <input ref={docInputRef} type="file" accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg" style={{ display: "none" }}
                                    onChange={e => { e.stopPropagation(); const file = e.target.files?.[0]; if (file && expandidoId) subirDocumento(expandidoId, file, docCategoria); e.target.value = ""; }} />
                                </div>
                                {loadingDocs ? (
                                  <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>Cargando documentos...</p>
                                ) : expandDocs.length === 0 ? (
                                  <p style={{ fontSize: 12, color: "#94a3b8", margin: 0 }}>Sin documentos. Usa "+ Subir archivo" para agregar el primero.</p>
                                ) : (
                                  <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                                    {expandDocs.map(d => (
                                      <div key={d.id} style={{ display: "flex", alignItems: "center", gap: 10, padding: "8px 12px", background: "white", borderRadius: 10, border: "1px solid #f1f5f9" }}>
                                        <span style={{ fontSize: 16, flexShrink: 0 }}>📄</span>
                                        <div style={{ flex: 1, minWidth: 0 }}>
                                          <span style={{ fontWeight: 700, fontSize: 12, color: "#0f172a" }}>{d.nombre}</span>
                                          <span style={{ fontSize: 11, color: "#94a3b8", marginLeft: 8 }}>{d.categoria}</span>
                                        </div>
                                        <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{fmtBytes(d.tamano_bytes)}</span>
                                        <span style={{ fontSize: 11, color: "#94a3b8", flexShrink: 0 }}>{fmtDate(d.created_at)}</span>
                                        <button onClick={e => { e.stopPropagation(); descargarDoc(d); }}
                                          style={{ padding: "4px 10px", borderRadius: 7, border: "1px solid #e5e7eb", background: "white", fontSize: 10, fontWeight: 600, cursor: "pointer", color: "#0b315f", flexShrink: 0 }}>↓ Ver</button>
                                        <button className="del-btn" onClick={e => { e.stopPropagation(); setToDeleteDoc({ id: d.id, nombre: d.nombre, storage_path: d.storage_path }); }}
                                          style={{ padding: "4px 8px", borderRadius: 7, border: "1px solid #fecaca", background: "white", fontSize: 10, cursor: "pointer", color: "#dc2626", flexShrink: 0 }}>✕</button>
                                      </div>
                                    ))}
                                  </div>
                                )}
                              </div>

                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {filtrados.length > 0 && (
              <div style={{ padding: "12px 22px", fontSize: 11, color: "#94a3b8", borderTop: "1px solid #f1f5f9", display: "flex", justifyContent: "space-between" }}>
                <span>{filtrados.length} de {total} clientes · {b2bCount} empresas · {b2cCount} personas</span>
                <span>AFA Transportes · ERP Comercial</span>
              </div>
            )}
          </div>
        </>)}

        {/* ════════════════════════════════════
            SOLICITUDES TAB
        ════════════════════════════════════ */}
        {tab === "solicitudes" && (<>

          {/* Filters */}
          <div style={{ display: "flex", gap: 8, marginBottom: 20, flexWrap: "wrap", alignItems: "center" }}>
            {(["todos","pendiente","en_revision","aprobada","rechazada"] as const).map(est => {
              const cfg = est === "todos" ? { label: "Todas", bg: "#f1f5f9", color: "#475569", icon: "·" } : ESTADO_SOL[est];
              const cnt = est === "todos" ? solicitudes.length : solicitudes.filter(s => s.estado === est).length;
              return (
                <button key={est} onClick={() => setFiltroSolEst(est)}
                  style={{ padding: "8px 16px", borderRadius: 20, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                    border: `1.5px solid ${filtroSolEst === est ? (est === "todos" ? "#64748b" : cfg.color) : "#e5e7eb"}`,
                    background: filtroSolEst === est ? (est === "todos" ? "#f1f5f9" : cfg.bg) : "white",
                    color: filtroSolEst === est ? (est === "todos" ? "#475569" : cfg.color) : "#94a3b8" }}>
                  {cfg.icon} {cfg.label} ({cnt})
                </button>
              );
            })}
            <div style={{ flex: 1 }} />
            <span style={{ fontSize: 12, color: "#94a3b8" }}>{solFiltradas.length} solicitud{solFiltradas.length !== 1 ? "es" : ""}</span>
          </div>

          {/* Cards */}
          {loadingSol ? (
            <div style={{ padding: 40, textAlign: "center", color: "#94a3b8" }}>
              <div style={{ width: 28, height: 28, border: "3px solid #e5e7eb", borderTopColor: "#0b315f", borderRadius: "50%", margin: "0 auto 12px", animation: "spin 1s linear infinite" }} />
              Cargando solicitudes...
            </div>
          ) : solFiltradas.length === 0 ? (
            <div style={{ padding: "60px 20px", textAlign: "center", color: "#94a3b8" }}>
              <div style={{ fontSize: 38, marginBottom: 12 }}>📋</div>
              <p style={{ fontWeight: 700, fontSize: 15, color: "#475569", margin: "0 0 6px" }}>Sin solicitudes</p>
              <p style={{ fontSize: 13, margin: 0 }}>Las solicitudes del formulario aparecerán aquí</p>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
              {solFiltradas.map(sol => {
                const estCfg = ESTADO_SOL[sol.estado];
                const expd   = expandSolId === sol.id;
                const svcs   = parseSvc(sol.servicios_interes);
                const admins = sol.contactos_administrativos || [];
                const ops    = sol.contactos_operativos || [];

                return (
                  <div key={sol.id} className="sol-card"
                    style={{ background: "white", border: "1px solid #e5e7eb", borderRadius: 16, overflow: "hidden", transition: "border-color .15s" }}>

                    {/* Card header */}
                    <div style={{ padding: "18px 22px", display: "flex", alignItems: "flex-start", gap: 16, flexWrap: "wrap" }}>
                      {/* Avatar */}
                      <div style={{ width: 44, height: 44, borderRadius: 12, background: avatarBg(sol.razon_social), display: "flex", alignItems: "center", justifyContent: "center", color: "white", fontSize: 14, fontWeight: 800, flexShrink: 0 }}>
                        {iniciales(sol.razon_social)}
                      </div>

                      {/* Info */}
                      <div style={{ flex: 1 }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap", marginBottom: 4 }}>
                          <p style={{ fontWeight: 800, fontSize: 15, color: "#0f172a", margin: 0 }}>{sol.razon_social}</p>
                          <span style={{ fontSize: 11, fontWeight: 700, padding: "3px 9px", borderRadius: 20, background: estCfg.bg, color: estCfg.color }}>
                            {estCfg.icon} {estCfg.label}
                          </span>
                          {sol.tipo_doc && sol.num_doc && (
                            <span style={{ fontSize: 11, fontFamily: "monospace", color: "#64748b", background: "#f8fafc", padding: "3px 9px", borderRadius: 8 }}>
                              {sol.tipo_doc}: {sol.num_doc}
                            </span>
                          )}
                        </div>
                        <div style={{ display: "flex", flexWrap: "wrap", gap: 12, fontSize: 12, color: "#64748b" }}>
                          {sol.tipo_empresa  && <span>🏢 {sol.tipo_empresa}</span>}
                          {sol.rubro         && <span>· {sol.rubro}</span>}
                          {sol.distrito      && <span>📍 {sol.distrito}, {sol.departamento || ""}</span>}
                          {sol.condicion_pago && <span>💳 {sol.condicion_pago}</span>}
                          {sol.como_nos_conocio && <span>· vía {sol.como_nos_conocio}</span>}
                          <span style={{ color: "#94a3b8" }}>🕐 {fmtTime(sol.created_at)}</span>
                        </div>
                        {svcs.length > 0 && (
                          <div style={{ display: "flex", flexWrap: "wrap", gap: 5, marginTop: 8 }}>
                            {svcs.map(s => <SvcTag key={s} label={s}/>)}
                          </div>
                        )}
                        {sol.nota_interna && (
                          <div style={{ marginTop: 8, fontSize: 12, color: "#991b1b", background: "#fef2f2", padding: "6px 10px", borderRadius: 8 }}>
                            Nota: {sol.nota_interna}
                          </div>
                        )}
                        {sol.estado === "aprobada" && sol.cliente_id && (
                          <div style={{ marginTop: 8, fontSize: 12, color: "#166534", background: "#f0fdf4", padding: "6px 10px", borderRadius: 8 }}>
                            ✓ Cliente creado · ID #{sol.cliente_id} · Aprobado {fmtDate(sol.revisado_at)}
                          </div>
                        )}
                      </div>

                      {/* Actions */}
                      <div style={{ display: "flex", gap: 8, alignItems: "center", flexShrink: 0 }}>
                        <button onClick={() => setExpandSolId(expd ? null : sol.id)}
                          style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid #e5e7eb", background: "white", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                          {expd ? "Ocultar ▲" : "Ver detalle ▼"}
                        </button>
                        {(sol.estado === "pendiente" || sol.estado === "en_revision") && (
                          <button onClick={() => abrirEditSol(sol)}
                            style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid #e5e7eb", background: "white", fontSize: 12, fontWeight: 600, cursor: "pointer", color: "#374151" }}>
                            ✏️ Editar
                          </button>
                        )}
                        {sol.estado === "pendiente" && (
                          <button onClick={() => marcarEnRevision(sol)}
                            style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid #bfdbfe", background: "#eff6ff", fontSize: 12, fontWeight: 700, cursor: "pointer", color: "#1d4ed8" }}>
                            🔍 Revisar
                          </button>
                        )}
                        {(sol.estado === "pendiente" || sol.estado === "en_revision") && (<>
                          <button onClick={() => aprobarSolicitud(sol)} disabled={aprobando === sol.id}
                            style={{ padding: "7px 18px", borderRadius: 9, border: "none", background: aprobando === sol.id ? "#94a3b8" : "#0b315f", color: "white", fontSize: 12, fontWeight: 700, cursor: aprobando === sol.id ? "not-allowed" : "pointer" }}>
                            {aprobando === sol.id ? "..." : "✓ Aprobar"}
                          </button>
                          <button onClick={() => { setRechazarModal(sol); setNotaRechazo(""); }}
                            style={{ padding: "7px 14px", borderRadius: 9, border: "1px solid #fecaca", background: "white", fontSize: 12, fontWeight: 700, cursor: "pointer", color: "#dc2626" }}>
                            ✕ Rechazar
                          </button>
                        </>)}
                      </div>
                    </div>

                    {/* Expanded detail */}
                    {expd && (
                      <div style={{ borderTop: "1px solid #f1f5f9", padding: "18px 22px", background: "#f8fafc", animation: "slideDown .18s ease" }}>
                        <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fit,minmax(200px,1fr))", gap: 20 }}>

                          {/* Empresa */}
                          <div>
                            <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#94a3b8", marginBottom: 10 }}>Empresa / Datos</p>
                            <div style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12, color: "#475569" }}>
                              {sol.email_facturacion && <span>🧾 {sol.email_facturacion}</span>}
                              {sol.direccion && <span>📍 {sol.direccion}, {sol.distrito}</span>}
                              {sol.moneda && <span>💱 {sol.moneda} · {sol.tipo_comprobante || ""}</span>}
                              {sol.volumen_compra && <span>📦 {sol.volumen_compra}</span>}
                              {sol.web && <span>🌐 {sol.web}</span>}
                              {sol.observaciones && <span style={{ fontStyle: "italic", color: "#94a3b8" }}>"{sol.observaciones}"</span>}
                            </div>
                          </div>

                          {/* Contactos administrativos */}
                          {admins.length > 0 && (
                            <div>
                              <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#1262bd", marginBottom: 10 }}>Contactos admin ({admins.length})</p>
                              {admins.map((ct, i) => (
                                <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < admins.length-1 ? "1px solid #f1f5f9" : "none" }}>
                                  <p style={{ fontWeight: 600, fontSize: 12, color: "#0f172a", margin: 0 }}>{ct.nombre} {ct.apellido||""}</p>
                                  {ct.cargo    && <p style={{ fontSize: 11, color: "#94a3b8", margin: "2px 0 0" }}>{ct.cargo}</p>}
                                  {ct.telefono && <p className="copy-cell" onClick={() => copiar(ct.telefono!, "Celular")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>📱 {ct.telefono}</p>}
                                  {ct.email    && <p className="copy-cell" onClick={() => copiar(ct.email!, "Email")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>✉️ {ct.email}</p>}
                                </div>
                              ))}
                            </div>
                          )}

                          {/* Contactos operativos */}
                          {ops.length > 0 && (
                            <div>
                              <p style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase", letterSpacing: ".07em", color: "#0f6e56", marginBottom: 10 }}>Contactos operativos ({ops.length})</p>
                              {ops.map((ct, i) => (
                                <div key={i} style={{ marginBottom: 8, paddingBottom: 8, borderBottom: i < ops.length-1 ? "1px solid #f1f5f9" : "none" }}>
                                  <p style={{ fontWeight: 600, fontSize: 12, color: "#0f172a", margin: 0 }}>{ct.nombre} {ct.apellido||""}</p>
                                  {ct.cargo    && <p style={{ fontSize: 11, color: "#94a3b8", margin: "2px 0 0" }}>{ct.cargo}</p>}
                                  {ct.telefono && <p className="copy-cell" onClick={() => copiar(ct.telefono!, "Celular")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>📱 {ct.telefono}</p>}
                                  {ct.email    && <p className="copy-cell" onClick={() => copiar(ct.email!, "Email")} style={{ fontSize: 12, color: "#475569", margin: "2px 0 0" }}>✉️ {ct.email}</p>}
                                </div>
                              ))}
                            </div>
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </>)}


      </main>
      <style>{`@keyframes spin{to{transform:rotate(360deg)}}`}</style>
    </>
  );
}