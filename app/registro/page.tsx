"use client";

import { useState } from "react";
import { supabase } from "@/lib/supabase";

/* ══════════════════════════════════════════════
   TYPES & CONSTANTS
══════════════════════════════════════════════ */
type Contacto = { nombre: string; apellido: string; cargo: string; telefono: string; email: string; tipoDoc: string; numDoc: string };

const BLANK: Contacto = { nombre: "", apellido: "", cargo: "", telefono: "", email: "", tipoDoc: "DNI", numDoc: "" };

const DEPARTAMENTOS = [
  "Amazonas","Áncash","Apurímac","Arequipa","Ayacucho","Cajamarca","Callao",
  "Cusco","Huancavelica","Huánuco","Ica","Junín","La Libertad","Lambayeque",
  "Lima","Loreto","Madre de Dios","Moquegua","Pasco","Piura","Puno",
  "San Martín","Tacna","Tumbes","Ucayali",
];

const SERVICIOS = [
  "Transporte de personal",
  "Transporte turístico",
  "Alquiler de vehículos",
  "Otros",
];

const SVC_COLORS: Record<string, [string, string]> = {
  "Transporte de personal": ["#eff6ff","#1d4ed8"],
  "Transporte turístico":   ["#f0fdf4","#166534"],
  "Alquiler de vehículos":  ["#fef9ec","#92400e"],
  "Otros":                  ["#f5f3ff","#6d28d9"],
};

/* ══════════════════════════════════════════════
   SMALL COMPONENTS
══════════════════════════════════════════════ */
const Label = ({ children, required }: { children: React.ReactNode; required?: boolean }) => (
  <label style={{ display: "block", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".04em", color: "#5A6478", marginBottom: 4 }}>
    {children}{required && <span style={{ color: "#A32D2D", marginLeft: 2 }}>*</span>}
  </label>
);

const FieldErr = ({ msg }: { msg?: string }) =>
  msg ? <p style={{ fontSize: 11, color: "#A32D2D", marginTop: 3 }}>⚠ {msg}</p> : null;

const fieldStyle = (error?: boolean): React.CSSProperties => ({
  width: "100%", boxSizing: "border-box" as const,
  border: `1.5px solid ${error ? "#fca5a5" : "#D8DDE8"}`,
  borderRadius: 10, padding: "10px 12px", fontSize: 14,
  outline: "none", fontFamily: "inherit", background: error ? "#fef9f9" : "white",
  color: "#1A1A2E", transition: "border-color .15s",
});

const divider = (
  <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "1.5rem 0", color: "#8892A4", fontSize: 11, fontWeight: 700, letterSpacing: ".05em", textTransform: "uppercase" as const }}>
    <div style={{ flex: 1, height: 1, background: "#D8DDE8" }} />
    <span>o</span>
    <div style={{ flex: 1, height: 1, background: "#D8DDE8" }} />
  </div>
);

/* ══════════════════════════════════════════════
   CONTACT CARD
══════════════════════════════════════════════ */
function ContactCard({ ct, idx, tipo, onChange, onRemove, canRemove }: {
  ct: Contacto; idx: number; tipo: "admin" | "op";
  onChange: (k: keyof Contacto, v: string) => void;
  onRemove: () => void; canRemove: boolean;
}) {
  const color = tipo === "admin" ? "#1262bd" : "#0f6e56";
  const label = tipo === "admin" ? "Contacto administrativo" : "Contacto operativo";
  return (
    <div style={{ background: "#F4F6FA", border: "1.5px solid #D8DDE8", borderRadius: 12, padding: "14px 16px", marginBottom: 10 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <span style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".05em", color }}>
          {label} #{idx + 1}
        </span>
        {canRemove && (
          <button type="button" onClick={onRemove}
            style={{ fontSize: 11, fontWeight: 600, color: "#8892A4", background: "transparent", border: "1px solid #D8DDE8", borderRadius: 20, padding: "3px 10px", cursor: "pointer", fontFamily: "inherit" }}>
            ✕ Quitar
          </button>
        )}
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 10 }}>
        <div>
          <Label required>Nombres</Label>
          <input style={fieldStyle()} placeholder="Nombre(s)" value={ct.nombre} onChange={e => onChange("nombre", e.target.value)} />
        </div>
        <div>
          <Label>Apellidos</Label>
          <input style={fieldStyle()} placeholder="Apellidos" value={ct.apellido} onChange={e => onChange("apellido", e.target.value)} />
        </div>
        <div>
          <Label>Cargo / Área</Label>
          <input style={fieldStyle()} placeholder="Ej: Gerente de Compras" value={ct.cargo} onChange={e => onChange("cargo", e.target.value)} />
        </div>
        <div>
          <Label>Celular</Label>
          <input style={fieldStyle()} placeholder="+51 9XX XXX XXX" value={ct.telefono} onChange={e => onChange("telefono", e.target.value)} />
        </div>
      </div>
      <div style={{ marginBottom: 10 }}>
        <Label>Correo electrónico</Label>
        <input type="email" style={fieldStyle()} placeholder="correo@empresa.com" value={ct.email} onChange={e => onChange("email", e.target.value)} />
      </div>

      {/* Documento de identidad — necesario para acceso al portal */}
      <div style={{ borderTop: "1px dashed #D8DDE8", paddingTop: 10 }}>
        <div style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 8 }}>
          <span style={{ fontSize: 10, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".06em", color: "#8892A4" }}>Documento de identidad</span>
          <span style={{ fontSize: 10, background: color + "18", color, padding: "2px 8px", borderRadius: 20, fontWeight: 700 }}>Requerido para acceso al portal</span>
        </div>
        <div style={{ display: "grid", gridTemplateColumns: "140px 1fr", gap: 10 }}>
          <div>
            <Label>Tipo</Label>
            <select style={fieldStyle()} value={ct.tipoDoc} onChange={e => onChange("tipoDoc", e.target.value)}>
              <option value="DNI">DNI</option>
              <option value="CE">Cédula / CE</option>
              <option value="Pasaporte">Pasaporte</option>
            </select>
          </div>
          <div>
            <Label>Número de documento</Label>
            <input
              style={fieldStyle()}
              placeholder={ct.tipoDoc === "DNI" ? "12345678 (8 dígitos)" : "Número de documento"}
              maxLength={ct.tipoDoc === "DNI" ? 8 : 20}
              value={ct.numDoc}
              onChange={e => onChange("numDoc", ct.tipoDoc === "DNI" ? e.target.value.replace(/\D/g, "") : e.target.value)}
            />
            <p style={{ fontSize: 11, color: "#8892A4", marginTop: 3 }}>
              Será el usuario de ingreso al portal cliente
            </p>
          </div>
        </div>
      </div>
    </div>
  );
}

/* ══════════════════════════════════════════════
   MAIN PAGE
══════════════════════════════════════════════ */
export default function RegistroClientePage() {

  const [step,   setStep]   = useState(1);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);
  const [done,   setDone]   = useState(false);

  /* Step 1 — Empresa */
  const [tipoDoc,    setTipoDoc]    = useState("RUC");
  const [numDoc,     setNumDoc]     = useState("");
  const [razon,      setRazon]      = useState("");
  const [nomComercial, setNomComercial] = useState("");
  const [tipoEmpresa,  setTipoEmpresa] = useState("");
  const [rubro,      setRubro]      = useState("");
  const [web,        setWeb]        = useState("");
  const [direccion,  setDireccion]  = useState("");
  const [distrito,   setDistrito]   = useState("");
  const [provincia,  setProvincia]  = useState("");
  const [departamento, setDepartamento] = useState("Lima");

  /* Step 2 — Contactos */
  const [emailFact,  setEmailFact]  = useState("");
  const [admins,     setAdmins]     = useState<Contacto[]>([{ ...BLANK }]);
  const [ops,        setOps]        = useState<Contacto[]>([{ ...BLANK }]);

  /* Step 3 — Comercial */
  const [tipoCliente,  setTipoCliente]  = useState("");
  const [condPago,     setCondPago]     = useState("");
  const [moneda,       setMoneda]       = useState("");
  const [comprobante,  setComprobante]  = useState("");
  const [volumen,      setVolumen]      = useState("");
  const [servicios,    setServicios]    = useState<string[]>([]);
  const [comoNos,      setComoNos]      = useState("");
  const [obs,          setObs]          = useState("");

  /* Step 4 — Confirmación */
  const [aceptaTerminos, setAceptaTerminos] = useState(false);
  const [aceptaComun,    setAceptaComun]    = useState(false);

  /* ── Contact helpers ── */
  const addContact    = (set: React.Dispatch<React.SetStateAction<Contacto[]>>) =>
    set(prev => [...prev, { ...BLANK }]);

  const removeContact = (set: React.Dispatch<React.SetStateAction<Contacto[]>>, idx: number) =>
    set(prev => prev.filter((_, i) => i !== idx));

  const updateContact = (set: React.Dispatch<React.SetStateAction<Contacto[]>>, idx: number, key: keyof Contacto, val: string) =>
    set(prev => { const arr = [...prev]; arr[idx] = { ...arr[idx], [key]: val }; return arr; });

  const toggleSvc = (s: string) =>
    setServicios(prev => prev.includes(s) ? prev.filter(x => x !== s) : [...prev, s]);

  /* ── Validation per step ── */
  const validate = (s: number): boolean => {
    const e: Record<string, string> = {};

    if (s === 1) {
      if (!numDoc.trim())    e.numDoc    = "Requerido";
      if (!razon.trim())     e.razon     = "Requerido";
      if (!tipoEmpresa)      e.tipoEmpresa = "Seleccione";
      if (!rubro)            e.rubro     = "Seleccione";
      if (!direccion.trim()) e.direccion = "Requerido";
      if (!distrito.trim())  e.distrito  = "Requerido";
      if (!provincia.trim()) e.provincia = "Requerido";
    }

    if (s === 2) {
      if (!emailFact.trim()) e.emailFact = "Requerido";
      else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(emailFact)) e.emailFact = "Email inválido";
      admins.forEach((c, i) => {
        if (!c.nombre.trim()) e[`admin_${i}_nombre`] = "Requerido";
      });
      ops.forEach((c, i) => {
        if (!c.nombre.trim()) e[`op_${i}_nombre`] = "Requerido";
      });
    }

    if (s === 3) {
      if (!condPago)   e.condPago   = "Seleccione";
      if (!moneda)     e.moneda     = "Seleccione";
      if (!comprobante) e.comprobante = "Seleccione";
      if (servicios.length === 0) e.servicios = "Seleccione al menos uno";
    }

    if (s === 4) {
      if (!aceptaTerminos) e.terminos = "Debe aceptar para continuar";
    }

    setErrors(e);
    return Object.keys(e).length === 0;
  };

  const nextStep = () => {
    if (!validate(step)) return;
    setStep(s => s + 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  const prevStep = () => {
    setStep(s => s - 1);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ── Submit ── */
  const handleSubmit = async () => {
    if (!validate(4)) return;
    setSending(true);

    const payload = {
      tipo_doc: tipoDoc,
      num_doc:  numDoc.trim(),
      razon_social: razon.trim(),
      nombre_comercial: nomComercial.trim() || null,
      tipo_empresa: tipoEmpresa || null,
      rubro:        rubro       || null,
      web:          web.trim()  || null,
      direccion:    direccion.trim(),
      distrito:     distrito.trim(),
      provincia:    provincia.trim(),
      departamento,
      email_facturacion: emailFact.trim(),
      contactos_administrativos: admins.filter(c => c.nombre.trim()).map(c => ({
        nombre:   c.nombre.trim(),
        apellido: c.apellido.trim() || null,
        cargo:    c.cargo.trim()    || null,
        telefono: c.telefono.trim() || null,
        email:    c.email.trim()    || null,
        tipo_doc: c.tipoDoc         || "DNI",
        num_doc:  c.numDoc.trim()   || null,
      })),
      contactos_operativos: ops.filter(c => c.nombre.trim()).map(c => ({
        nombre:   c.nombre.trim(),
        apellido: c.apellido.trim() || null,
        cargo:    c.cargo.trim()    || null,
        telefono: c.telefono.trim() || null,
        email:    c.email.trim()    || null,
        tipo_doc: c.tipoDoc         || "DNI",
        num_doc:  c.numDoc.trim()   || null,
      })),
      tipo_cliente:  tipoCliente  || null,
      condicion_pago: condPago,
      moneda,
      tipo_comprobante: comprobante,
      volumen_compra: volumen || null,
      servicios_interes: servicios.join(","),
      como_nos_conocio: comoNos || null,
      observaciones: obs.trim() || null,
      acepta_terminos: aceptaTerminos,
      acepta_comunicaciones: aceptaComun,
      estado: "pendiente",
    };

    const { error } = await supabase.from("solicitudes_cliente").insert(payload);

    if (error) {
      setErrors({ submit: "Hubo un error al enviar. Por favor intente nuevamente." });
      setSending(false);
      return;
    }

    setDone(true);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };

  /* ══════════════════════════════════════════
     STYLES
  ══════════════════════════════════════════ */
  const wrap: React.CSSProperties = {
    fontFamily: "'DM Sans', system-ui, sans-serif",
    background: "#F4F6FA",
    minHeight: "100vh",
    padding: "2rem 1rem 4rem",
  };

  const page: React.CSSProperties = {
    maxWidth: 760, margin: "0 auto",
  };

  const card: React.CSSProperties = {
    background: "white", borderRadius: "0 0 16px 16px",
    boxShadow: "0 4px 24px rgba(13,34,64,.10)",
  };

  const sectionPad: React.CSSProperties = { padding: "2rem 2.5rem" };

  const grid2: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "1rem" };
  const grid3: React.CSSProperties = { display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: "1rem" };

  const divLine = (label: string) => (
    <div style={{ display: "flex", alignItems: "center", gap: 12, margin: "1.5rem 0 1rem", color: "#8892A4", fontSize: 10, fontWeight: 700, letterSpacing: ".07em", textTransform: "uppercase" as const }}>
      <div style={{ flex: 1, height: 1, background: "#D8DDE8" }} />
      {label}
      <div style={{ flex: 1, height: 1, background: "#D8DDE8" }} />
    </div>
  );

  const addBtn = (label: string, color: string, onClick: () => void) => (
    <button type="button" onClick={onClick}
      style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: 7, width: "100%", padding: "9px", border: `1.5px dashed ${color}`, borderRadius: 10, background: "transparent", color, fontSize: 12, fontWeight: 700, cursor: "pointer", fontFamily: "inherit", marginTop: 4 }}>
      + {label}
    </button>
  );

  const navBar = (isLast = false) => (
    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", padding: "1.25rem 2.5rem 2rem", borderTop: "1px solid #D8DDE8" }}>
      <button type="button" onClick={prevStep}
        style={{ visibility: step > 1 ? "visible" : "hidden", display: "flex", alignItems: "center", gap: 6, padding: "10px 20px", borderRadius: 10, border: "1.5px solid #D8DDE8", background: "white", fontSize: 13, fontWeight: 700, cursor: "pointer", color: "#5A6478", fontFamily: "inherit" }}>
        ← Anterior
      </button>
      <span style={{ fontSize: 12, color: "#8892A4", fontWeight: 500 }}>Paso {step} de 4</span>
      {isLast ? (
        <button type="button" onClick={handleSubmit} disabled={sending}
          style={{ display: "flex", alignItems: "center", gap: 8, padding: "10px 24px", borderRadius: 10, border: "none", background: sending ? "#94a3b8" : "#0D2240", color: "white", fontSize: 13, fontWeight: 700, cursor: sending ? "not-allowed" : "pointer", fontFamily: "inherit" }}>
          {sending ? "Enviando..." : "✉ Enviar registro"}
        </button>
      ) : (
        <button type="button" onClick={nextStep}
          style={{ display: "flex", alignItems: "center", gap: 6, padding: "10px 22px", borderRadius: 10, border: "none", background: "#0D2240", color: "white", fontSize: 13, fontWeight: 700, cursor: "pointer", fontFamily: "inherit" }}>
          Siguiente →
        </button>
      )}
    </div>
  );

  /* ══════════════════════════════════════════
     RENDER
  ══════════════════════════════════════════ */
  return (
    <div style={wrap}>
      <link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=DM+Sans:wght@400;500;600;700&family=DM+Serif+Display&display=swap" />
      <style>{`
        input:focus, select:focus, textarea:focus { border-color:#1E5FA8 !important; box-shadow:0 0 0 3px rgba(30,95,168,.12) !important; outline:none; }
        select { appearance:none; background-image:url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%235A6478' stroke-width='2'%3E%3Cpath d='M6 9l6 6 6-6'/%3E%3C/svg%3E"); background-repeat:no-repeat; background-position:right .75rem center; padding-right:2.5rem !important; }
        @media (max-width:580px) { .grid2 { grid-template-columns:1fr !important; } .grid3 { grid-template-columns:1fr !important; } .sec-pad { padding:1.5rem !important; } .nav-pad { padding:1rem 1.5rem 1.5rem !important; } }
      `}</style>

      <div style={page}>

        {/* ── HEADER ── */}
        <div style={{ background: "#0D2240", borderRadius: "16px 16px 0 0", padding: "2.5rem 2.5rem 2rem", position: "relative", overflow: "hidden" }}>
          <div style={{ position: "absolute", top: -60, right: -60, width: 220, height: 220, background: "rgba(200,162,75,.12)", borderRadius: "50%", pointerEvents: "none" }} />
          <div style={{ display: "inline-flex", alignItems: "center", gap: 6, background: "rgba(200,162,75,.18)", color: "#C8A24B", fontSize: 11, fontWeight: 700, letterSpacing: ".08em", textTransform: "uppercase", padding: "5px 12px", borderRadius: 20, marginBottom: "1rem", position: "relative" }}>
            <span style={{ width: 6, height: 6, background: "#C8A24B", borderRadius: "50%", display: "inline-block" }} />
            Documento oficial
          </div>
          <h1 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "2rem", fontWeight: 400, color: "white", lineHeight: 1.2, margin: "0 0 .5rem", position: "relative" }}>
            Ficha de Registro<br />de Cliente
          </h1>
          <p style={{ fontSize: 14, color: "rgba(255,255,255,.65)", margin: 0, lineHeight: 1.6, position: "relative" }}>
            Complete todos los campos para formalizar el alta de su cuenta en AFA Transportes.
          </p>
        </div>

        {/* ── PROGRESS TABS ── */}
        <div style={{ background: "white", borderBottom: "1px solid #D8DDE8", display: "flex" }}>
          {[
            { n: 1, label: "Empresa" },
            { n: 2, label: "Contactos" },
            { n: 3, label: "Servicios" },
            { n: 4, label: "Confirmar" },
          ].map(t => (
            <div key={t.n} style={{ flex: 1, padding: ".85rem 0", textAlign: "center" as const, fontSize: 12, fontWeight: 600,
              color: step === t.n ? "#1E5FA8" : step > t.n ? "#0F6E56" : "#8892A4",
              borderBottom: `2px solid ${step === t.n ? "#1E5FA8" : step > t.n ? "#0F6E56" : "transparent"}` }}>
              <span style={{ display: "inline-flex", alignItems: "center", justifyContent: "center", width: 20, height: 20, borderRadius: "50%", fontSize: 10, fontWeight: 700, marginRight: 5,
                background: step === t.n ? "#EBF2FB" : step > t.n ? "#E1F5EE" : "#E8ECF4",
                color: step === t.n ? "#1E5FA8" : step > t.n ? "#0F6E56" : "#8892A4" }}>
                {step > t.n ? "✓" : t.n}
              </span>
              {t.label}
            </div>
          ))}
        </div>

        {/* ── CARD ── */}
        <div style={card}>

          {/* ════════ DONE SCREEN ════════ */}
          {done && (
            <div style={{ ...sectionPad, textAlign: "center", padding: "4rem 2.5rem" }}>
              <div style={{ width: 72, height: 72, background: "#E1F5EE", borderRadius: "50%", display: "flex", alignItems: "center", justifyContent: "center", margin: "0 auto 1.5rem", fontSize: 32 }}>✓</div>
              <h2 style={{ fontFamily: "'DM Serif Display', serif", fontSize: "1.75rem", color: "#0D2240", margin: "0 0 .75rem" }}>¡Registro enviado!</h2>
              <p style={{ fontSize: 15, color: "#5A6478", maxWidth: 400, margin: "0 auto 2rem", lineHeight: 1.6 }}>
                Hemos recibido su solicitud. Nuestro equipo comercial revisará la información y se pondrá en contacto en un plazo de 24–48 horas hábiles.
              </p>
              <p style={{ fontSize: 13, color: "#8892A4" }}>¿Tiene alguna consulta? Escríbanos a <strong>comercial@afa.com</strong></p>
            </div>
          )}

          {/* ════════ STEP 1: EMPRESA ════════ */}
          {!done && step === 1 && (
            <>
              <div className="sec-pad" style={sectionPad}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.5rem", paddingBottom: ".75rem", borderBottom: "1px solid #EBF0F8" }}>
                  <div style={{ width: 32, height: 32, background: "#EBF2FB", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>🏢</div>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#0D2240" }}>Datos de la Empresa</span>
                </div>

                <div className="grid2" style={{ ...grid2, marginBottom: "1rem" }}>
                  <div>
                    <Label required>Tipo de documento</Label>
                    <select style={fieldStyle()} value={tipoDoc} onChange={e => setTipoDoc(e.target.value)}>
                      <option value="RUC">RUC</option>
                      <option value="DNI">DNI</option>
                      <option value="CE">Carnet de Extranjería</option>
                      <option value="Pasaporte">Pasaporte</option>
                    </select>
                  </div>
                  <div>
                    <Label required>Número de documento</Label>
                    <input style={fieldStyle(!!errors.numDoc)} placeholder="20XXXXXXXXX" maxLength={15} value={numDoc} onChange={e => setNumDoc(e.target.value)} />
                    <FieldErr msg={errors.numDoc} />
                  </div>
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <Label required>Razón social / Nombre completo</Label>
                  <input style={fieldStyle(!!errors.razon)} placeholder="Empresa S.A.C. o nombre completo" value={razon} onChange={e => setRazon(e.target.value)} />
                  <FieldErr msg={errors.razon} />
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <Label>Nombre comercial</Label>
                  <input style={fieldStyle()} placeholder="Si difiere de la razón social" value={nomComercial} onChange={e => setNomComercial(e.target.value)} />
                </div>

                <div className="grid2" style={{ ...grid2, marginBottom: "1rem" }}>
                  <div>
                    <Label required>Tipo de empresa</Label>
                    <select style={fieldStyle(!!errors.tipoEmpresa)} value={tipoEmpresa} onChange={e => setTipoEmpresa(e.target.value)}>
                      <option value="">Seleccione...</option>
                      {["S.A.C.","S.A.","S.R.L.","E.I.R.L.","S.A.S.","Persona Natural","ONG / Asociación","Otro"].map(o => <option key={o}>{o}</option>)}
                    </select>
                    <FieldErr msg={errors.tipoEmpresa} />
                  </div>
                  <div>
                    <Label required>Rubro / Sector</Label>
                    <select style={fieldStyle(!!errors.rubro)} value={rubro} onChange={e => setRubro(e.target.value)}>
                      <option value="">Seleccione...</option>
                      {["Comercio","Construcción","Educación","Gastronomía","Industria / Manufactura","Minería","Salud","Servicios profesionales","Tecnología","Transporte / Logística","Otro"].map(o => <option key={o}>{o}</option>)}
                    </select>
                    <FieldErr msg={errors.rubro} />
                  </div>
                </div>

                <div style={{ marginBottom: "1rem" }}>
                  <Label>Página web</Label>
                  <input type="url" style={fieldStyle()} placeholder="https://www.empresa.com.pe" value={web} onChange={e => setWeb(e.target.value)} />
                </div>

                {divLine("Dirección fiscal")}

                <div style={{ marginBottom: "1rem" }}>
                  <Label required>Dirección completa</Label>
                  <input style={fieldStyle(!!errors.direccion)} placeholder="Av. / Jr. / Calle, número, urbanización" value={direccion} onChange={e => setDireccion(e.target.value)} />
                  <FieldErr msg={errors.direccion} />
                </div>

                <div className="grid3" style={grid3}>
                  <div>
                    <Label required>Distrito</Label>
                    <input style={fieldStyle(!!errors.distrito)} placeholder="Ej: Miraflores" value={distrito} onChange={e => setDistrito(e.target.value)} />
                    <FieldErr msg={errors.distrito} />
                  </div>
                  <div>
                    <Label required>Provincia</Label>
                    <input style={fieldStyle(!!errors.provincia)} placeholder="Ej: Lima" value={provincia} onChange={e => setProvincia(e.target.value)} />
                    <FieldErr msg={errors.provincia} />
                  </div>
                  <div>
                    <Label required>Departamento</Label>
                    <select style={fieldStyle()} value={departamento} onChange={e => setDepartamento(e.target.value)}>
                      {DEPARTAMENTOS.map(d => <option key={d}>{d}</option>)}
                    </select>
                  </div>
                </div>
              </div>
              {navBar()}
            </>
          )}

          {/* ════════ STEP 2: CONTACTOS ════════ */}
          {!done && step === 2 && (
            <>
              <div className="sec-pad" style={sectionPad}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.5rem", paddingBottom: ".75rem", borderBottom: "1px solid #EBF0F8" }}>
                  <div style={{ width: 32, height: 32, background: "#EBF2FB", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>👤</div>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#0D2240" }}>Personas de Contacto</span>
                </div>

                {/* Email facturación */}
                <div style={{ marginBottom: "1.5rem" }}>
                  <Label required>Correo para facturación electrónica</Label>
                  <input type="email" style={fieldStyle(!!errors.emailFact)} placeholder="facturacion@empresa.com" value={emailFact} onChange={e => setEmailFact(e.target.value)} />
                  <FieldErr msg={errors.emailFact} />
                  <p style={{ fontSize: 11, color: "#8892A4", marginTop: 3 }}>Se usará para enviar comprobantes SUNAT</p>
                </div>

                {/* Administrativos */}
                {divLine("Contactos Administrativos")}
                <p style={{ fontSize: 12, color: "#8892A4", marginBottom: ".75rem" }}>Responsables de aprobaciones, contratos y pagos.</p>
                {admins.map((ct, i) => (
                  <ContactCard key={i} ct={ct} idx={i} tipo="admin"
                    onChange={(k, v) => updateContact(setAdmins, i, k, v)}
                    onRemove={() => removeContact(setAdmins, i)}
                    canRemove={admins.length > 1} />
                ))}
                {addBtn("Agregar contacto administrativo", "#1262bd", () => addContact(setAdmins))}

                {/* Operativos */}
                {divLine("Contactos Operativos")}
                <p style={{ fontSize: 12, color: "#8892A4", marginBottom: ".75rem" }}>Coordinadores del servicio diario (logística, operaciones).</p>
                {ops.map((ct, i) => (
                  <ContactCard key={i} ct={ct} idx={i} tipo="op"
                    onChange={(k, v) => updateContact(setOps, i, k, v)}
                    onRemove={() => removeContact(setOps, i)}
                    canRemove={ops.length > 1} />
                ))}
                {addBtn("Agregar contacto operativo", "#0f6e56", () => addContact(setOps))}
              </div>
              {navBar()}
            </>
          )}

          {/* ════════ STEP 3: SERVICIOS + COMERCIAL ════════ */}
          {!done && step === 3 && (
            <>
              <div className="sec-pad" style={sectionPad}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.5rem", paddingBottom: ".75rem", borderBottom: "1px solid #EBF0F8" }}>
                  <div style={{ width: 32, height: 32, background: "#EBF2FB", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>📋</div>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#0D2240" }}>Información Comercial</span>
                </div>

                {/* Tipo de cliente */}
                <div style={{ marginBottom: "1.5rem" }}>
                  <Label>Tipo de cliente</Label>
                  <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 8, marginTop: 6 }}>
                    {["Distribuidor","Minorista","Mayorista","Usuario final","Gobierno"].map(t => (
                      <label key={t} style={{ display: "flex", alignItems: "center", gap: 6, padding: "6px 14px", border: `1.5px solid ${tipoCliente === t ? "#1E5FA8" : "#D8DDE8"}`, borderRadius: 20, cursor: "pointer", fontSize: 13, background: tipoCliente === t ? "#EBF2FB" : "white", color: tipoCliente === t ? "#1E5FA8" : "#1A1A2E", fontWeight: tipoCliente === t ? 700 : 400 }}>
                        <input type="radio" name="tipo_cliente" value={t} checked={tipoCliente === t} onChange={() => setTipoCliente(t)} style={{ accentColor: "#1E5FA8" }} />
                        {t}
                      </label>
                    ))}
                  </div>
                </div>

                <div className="grid2" style={{ ...grid2, marginBottom: "1rem" }}>
                  <div>
                    <Label required>Condición de pago</Label>
                    <select style={fieldStyle(!!errors.condPago)} value={condPago} onChange={e => setCondPago(e.target.value)}>
                      <option value="">Seleccione...</option>
                      {["Contado","Crédito 15 días","Crédito 30 días","Crédito 45 días","Crédito 60 días","Crédito 90 días"].map(o => <option key={o}>{o}</option>)}
                    </select>
                    <FieldErr msg={errors.condPago} />
                  </div>
                  <div>
                    <Label required>Moneda de facturación</Label>
                    <select style={fieldStyle(!!errors.moneda)} value={moneda} onChange={e => setMoneda(e.target.value)}>
                      <option value="">Seleccione...</option>
                      <option>Soles (PEN)</option>
                      <option>Dólares (USD)</option>
                      <option>Euros (EUR)</option>
                    </select>
                    <FieldErr msg={errors.moneda} />
                  </div>
                  <div>
                    <Label required>Tipo de comprobante</Label>
                    <select style={fieldStyle(!!errors.comprobante)} value={comprobante} onChange={e => setComprobante(e.target.value)}>
                      <option value="">Seleccione...</option>
                      <option>Factura electrónica</option>
                      <option>Boleta electrónica</option>
                      <option>Ambas</option>
                    </select>
                    <FieldErr msg={errors.comprobante} />
                  </div>
                  <div>
                    <Label>Volumen estimado / mes</Label>
                    <select style={fieldStyle()} value={volumen} onChange={e => setVolumen(e.target.value)}>
                      <option value="">Seleccione...</option>
                      {["Menos de S/ 5,000","S/ 5,000 – S/ 20,000","S/ 20,000 – S/ 50,000","Más de S/ 50,000"].map(o => <option key={o}>{o}</option>)}
                    </select>
                  </div>
                </div>

                {/* Servicios */}
                {divLine("Servicios de interés")}
                <div style={{ display: "flex", flexWrap: "wrap" as const, gap: 10, marginBottom: "1.5rem" }}>
                  {SERVICIOS.map(s => {
                    const on = servicios.includes(s);
                    const [bg, color] = SVC_COLORS[s] || ["#f3f4f6","#374151"];
                    return (
                      <button key={s} type="button" onClick={() => toggleSvc(s)}
                        style={{ padding: "10px 20px", borderRadius: 20, fontSize: 13, fontWeight: 600, cursor: "pointer", fontFamily: "inherit", transition: "all .15s",
                          border: `1.5px solid ${on ? color : "#D8DDE8"}`,
                          background: on ? bg : "white", color: on ? color : "#5A6478" }}>
                        {on && "✓ "}{s}
                      </button>
                    );
                  })}
                </div>
                <FieldErr msg={errors.servicios} />

                <div style={{ marginBottom: "1rem" }}>
                  <Label>¿Cómo nos conoció?</Label>
                  <select style={fieldStyle()} value={comoNos} onChange={e => setComoNos(e.target.value)}>
                    <option value="">Seleccione...</option>
                    {["Recomendación","Redes sociales","Google / Internet","Feria o evento","Visita de vendedor","Correo / Publicidad","Otro"].map(o => <option key={o}>{o}</option>)}
                  </select>
                </div>

                <div>
                  <Label>Observaciones / Requerimientos especiales</Label>
                  <textarea style={{ ...fieldStyle(), resize: "vertical" as const, minHeight: 90 }} placeholder="Indique requerimientos especiales, condiciones adicionales..." value={obs} onChange={e => setObs(e.target.value)} />
                </div>
              </div>
              {navBar()}
            </>
          )}

          {/* ════════ STEP 4: CONFIRMACIÓN ════════ */}
          {!done && step === 4 && (
            <>
              <div className="sec-pad" style={sectionPad}>
                <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: "1.5rem", paddingBottom: ".75rem", borderBottom: "1px solid #EBF0F8" }}>
                  <div style={{ width: 32, height: 32, background: "#EBF2FB", borderRadius: 8, display: "flex", alignItems: "center", justifyContent: "center" }}>✅</div>
                  <span style={{ fontSize: 15, fontWeight: 700, color: "#0D2240" }}>Confirmación y Envío</span>
                </div>

                {/* Resumen */}
                <div style={{ background: "#F4F6FA", borderRadius: 12, padding: "1rem 1.25rem", border: "1px solid #D8DDE8", marginBottom: "1.5rem" }}>
                  <p style={{ fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".05em", color: "#8892A4", marginBottom: ".75rem" }}>Resumen</p>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
                    <tbody>
                      {[
                        ["Tipo de documento", tipoDoc],
                        ["N° de documento",   numDoc],
                        ["Razón social",       razon],
                        ["Tipo de empresa",    tipoEmpresa],
                        ["Rubro",              rubro],
                        ["Distrito",           `${distrito}, ${departamento}`],
                        ["Correo facturación", emailFact],
                        ["Contactos admin",    `${admins.filter(c=>c.nombre).length} registrado(s)`],
                        ["Contactos operativos", `${ops.filter(c=>c.nombre).length} registrado(s)`],
                        ["Condición de pago",  condPago],
                        ["Moneda",             moneda],
                        ["Servicios",          servicios.join(", ") || "—"],
                      ].filter(([,v]) => v && v.trim() && v !== ", ").map(([k,v]) => (
                        <tr key={k}>
                          <td style={{ padding: "5px 0", fontSize: 11, fontWeight: 700, textTransform: "uppercase" as const, letterSpacing: ".03em", color: "#8892A4", width: "42%" }}>{k}</td>
                          <td style={{ padding: "5px 0 5px 12px", color: "#1A1A2E" }}>{v}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                {/* Info legal */}
                <div style={{ background: "#EBF2FB", border: "1px solid rgba(30,95,168,.15)", borderRadius: 10, padding: ".9rem 1.1rem", fontSize: 13, color: "#1A3A60", display: "flex", alignItems: "flex-start", gap: 8, marginBottom: "1.5rem", lineHeight: 1.6 }}>
                  <span style={{ flexShrink: 0, marginTop: 1 }}>ℹ</span>
                  Al enviar autoriza el tratamiento de sus datos con fines comerciales conforme a la <strong>Ley N° 29733</strong> de Protección de Datos Personales del Perú.
                </div>

                {/* Checkboxes */}
                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", border: `1.5px solid ${errors.terminos ? "#fca5a5" : "#D8DDE8"}`, borderRadius: 10, cursor: "pointer", marginBottom: "1rem", fontSize: 13, lineHeight: 1.5, background: errors.terminos ? "#fef9f9" : "white" }}>
                  <input type="checkbox" checked={aceptaTerminos} onChange={e => setAceptaTerminos(e.target.checked)} style={{ marginTop: 2, accentColor: "#1E5FA8", flexShrink: 0 }} />
                  <span>Confirmo que los datos ingresados son verídicos y autorizo su uso para establecer la relación comercial. <span style={{ color: "#A32D2D" }}>*</span></span>
                </label>
                <FieldErr msg={errors.terminos} />

                <label style={{ display: "flex", alignItems: "flex-start", gap: 10, padding: "12px 14px", border: "1.5px solid #D8DDE8", borderRadius: 10, cursor: "pointer", fontSize: 13, lineHeight: 1.5 }}>
                  <input type="checkbox" checked={aceptaComun} onChange={e => setAceptaComun(e.target.checked)} style={{ marginTop: 2, accentColor: "#1E5FA8", flexShrink: 0 }} />
                  <span>Acepto recibir comunicaciones comerciales, promociones y novedades de AFA Transportes por correo electrónico.</span>
                </label>

                {errors.submit && (
                  <div style={{ marginTop: "1rem", padding: "12px 14px", background: "#fef2f2", border: "1px solid #fecaca", borderRadius: 10, fontSize: 13, color: "#991b1b" }}>
                    ⚠ {errors.submit}
                  </div>
                )}
              </div>
              {navBar(true)}
            </>
          )}

        </div>

        {/* Footer */}
        <p style={{ textAlign: "center", marginTop: "1.5rem", fontSize: 12, color: "#8892A4" }}>
          Sus datos están protegidos · AFA Transportes © {new Date().getFullYear()}
        </p>

      </div>
    </div>
  );
}