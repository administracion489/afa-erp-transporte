"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Plantilla = {
  id: string; nombre: string; descripcion: string; activa: boolean; es_principal: boolean;
  color_primario: string; color_secundario: string; color_acento: string; fuente: string;
  mostrar_logo: boolean; titulo_documento: string; subtitulo: string | null;
  mostrar_fotos_vehiculo: boolean; mostrar_itinerario: boolean; mostrar_precio_pax: boolean;
  mostrar_sla: boolean; mensaje_cierre: string | null;
  mostrar_cuentas_bancarias: boolean; mostrar_firma: boolean; firma_url: string | null;
  condiciones_incluye: string[] | null; condiciones_no_incluye: string[] | null;
  condiciones_generales: string[] | null;
  usar_bancos_propios: boolean;
  banco_1_nombre: string | null; banco_1_cuenta: string | null; banco_1_cci: string | null;
  banco_2_nombre: string | null; banco_2_cuenta: string | null; banco_2_cci: string | null;
  banco_3_nombre: string | null; banco_3_cuenta: string | null; banco_3_cci: string | null;
  idioma: string; recomendado_para: string | null; icono: string; orden: number;
  updated_at: string;
};

const DEFAULTS: Record<string, Partial<Plantilla>> = {
  corporativo:   { color_primario:"#0b315f", color_secundario:"#1262bd", color_acento:"#C8A24B", titulo_documento:"COTIZACIÓN DE SERVICIO",    mensaje_cierre:"Agradecemos su preferencia. Quedamos a su disposición.", idioma:"es" },
  moderno_fotos: { color_primario:"#1a1a2e", color_secundario:"#2f8ee9", color_acento:"#C8A24B", titulo_documento:"PROPUESTA DE SERVICIO",      mensaje_cierre:"Confíe en AFA Transportes para su próximo traslado.",    idioma:"es" },
  turistico:     { color_primario:"#b45309", color_secundario:"#d97706", color_acento:"#fde68a", titulo_documento:"COTIZACIÓN TURÍSTICA",         mensaje_cierre:"¡Gracias por elegir AFA Tours Peru! Nos vemos pronto.", idioma:"es" },
  ejecutivo:     { color_primario:"#1a1a1a", color_secundario:"#C8A24B", color_acento:"#C8A24B", titulo_documento:"SERVICE QUOTATION / COTIZACIÓN",mensaje_cierre:"Thank you for choosing AFA. We look forward to serving you.", idioma:"es_en" },
};

const DEFAULT_INC  = ["Traslado de origen a destino","Conductor profesional certificado","Combustible durante todo el recorrido","GPS en tiempo real","Seguro de viaje SOAT vigente"];
const DEFAULT_NOINC= ["Alimentación y bebidas","Guía turístico","Entradas a atractivos turísticos","Peajes (salvo indicación expresa)"];
const DEFAULT_GEN  = ["Precios según fechas y horarios coordinados.","Tolerancia máxima de espera: 30 minutos.","No se permite consumo de alcohol ni tabaco a bordo.","Cambios en ruta u horario pueden generar costos adicionales.","Servicio eventual: adelanto del 50% para confirmar.","Recomendamos reservar con 7 días de anticipación mínimo."];
const FUENTES      = ["Helvetica Neue","Arial","Georgia","Times New Roman","Trebuchet MS"];
const IDIOMAS      = [{val:"es",label:"Español"},{val:"en",label:"English"},{val:"es_en",label:"Bilingüe ES+EN"}];

const C = { navy:"#0b315f", white:"#fff", gray50:"#f8fafc", gray100:"#f1f5f9", gray200:"#e2e8f0", gray400:"#94a3b8", gray600:"#475569", gray800:"#1e293b" };
const iSt: React.CSSProperties = { width:"100%", border:"1px solid #e2e8f0", borderRadius:10, padding:"8px 12px", fontSize:13, outline:"none", background:"white" };

function Toast({ msg, ok }: { msg: string; ok: boolean }) {
  return (
    <div style={{ position:"fixed", bottom:28, right:28, zIndex:100, background: ok ? "#166534" : "#991b1b", color:"white", padding:"12px 20px", borderRadius:14, fontWeight:700, fontSize:13, boxShadow:"0 8px 24px rgba(0,0,0,0.2)", maxWidth:340 }}>
      {ok ? "✅" : "❌"} {msg}
    </div>
  );
}

export default function PlantillasPDFPage() {
  const [plantillas, setPlantillas] = useState<Plantilla[]>([]);
  const [loading,    setLoading]    = useState(true);
  const [editId,     setEditId]     = useState<string | null>(null);
  const [form,       setForm]       = useState<Partial<Plantilla>>({});
  const [tab,        setTab]        = useState<"diseno"|"contenido"|"condiciones"|"bancos"|"idioma">("diseno");
  const [guardando,  setGuardando]  = useState(false);
  const [toast,      setToast]      = useState<{msg:string;ok:boolean}|null>(null);

  const showToast = (msg: string, ok = true) => { setToast({ msg, ok }); setTimeout(() => setToast(null), 3500); };

  const cargar = async () => {
    setLoading(true);
    const { data } = await supabase.from("cotizacion_plantillas").select("*").order("orden");
    setPlantillas(data || []);
    setLoading(false);
  };

  useEffect(() => { cargar(); }, []);

  const abrirEditor = (p: Plantilla) => {
    setForm({ ...p, condiciones_incluye: p.condiciones_incluye || DEFAULT_INC, condiciones_no_incluye: p.condiciones_no_incluye || DEFAULT_NOINC, condiciones_generales: p.condiciones_generales || DEFAULT_GEN });
    setEditId(p.id);
    setTab("diseno");
  };

  const guardar = async () => {
    if (!editId) return;
    setGuardando(true);
    const { error } = await supabase.from("cotizacion_plantillas").update({ ...form, updated_at: new Date().toISOString() }).eq("id", editId);
    if (error) showToast(error.message, false);
    else { showToast("Cambios guardados correctamente"); cargar(); }
    setGuardando(false);
  };

  const restaurar = () => {
    const def = DEFAULTS[editId!];
    if (!def) return;
    setForm(prev => ({ ...prev, ...def, condiciones_incluye: DEFAULT_INC, condiciones_no_incluye: DEFAULT_NOINC, condiciones_generales: DEFAULT_GEN }));
    showToast("Valores restaurados (no guardados aún)");
  };

  const toggleActiva = async (p: Plantilla) => {
    if (p.es_principal) return;
    await supabase.from("cotizacion_plantillas").update({ activa: !p.activa }).eq("id", p.id);
    cargar();
  };

  const fStr = (k: keyof Plantilla) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.value }));
  const fBool = (k: keyof Plantilla) => (e: React.ChangeEvent<HTMLInputElement>) =>
    setForm(prev => ({ ...prev, [k]: e.target.checked }));

  const editP = editId ? plantillas.find(p => p.id === editId) : null;
  const cp = (form.color_primario as string) || "#0b315f";
  const cs = (form.color_secundario as string) || "#1262bd";
  const ca = (form.color_acento as string) || "#C8A24B";

  // ── lista editable de condiciones ──
  const ListaItems = ({ campo, label, color }: { campo: "condiciones_incluye"|"condiciones_no_incluye"|"condiciones_generales"; label: string; color: string }) => {
    const items: string[] = (form[campo] as string[]) || [];
    const update = (i: number, v: string) => setForm(prev => ({ ...prev, [campo]: items.map((x, idx) => idx === i ? v : x) }));
    const remove = (i: number) => setForm(prev => ({ ...prev, [campo]: items.filter((_, idx) => idx !== i) }));
    const add    = () => setForm(prev => ({ ...prev, [campo]: [...items, ""] }));
    return (
      <div>
        <p style={{ fontWeight:800, fontSize:12, color, textTransform:"uppercase", marginBottom:8 }}>{label}</p>
        <div style={{ display:"flex", flexDirection:"column", gap:6 }}>
          {items.map((item, i) => (
            <div key={i} style={{ display:"flex", gap:8 }}>
              <input value={item} onChange={e => update(i, e.target.value)} style={{ ...iSt, flex:1, fontSize:12 }} />
              <button onClick={() => remove(i)} style={{ padding:"0 10px", borderRadius:8, border:"1px solid #fca5a5", background:"#fff5f5", color:"#dc2626", cursor:"pointer", fontWeight:800 }}>✕</button>
            </div>
          ))}
        </div>
        <button onClick={add} style={{ marginTop:8, fontSize:11, fontWeight:700, color, background:"none", border:"none", cursor:"pointer", padding:0 }}>+ Agregar ítem</button>
      </div>
    );
  };

  return (
    <div style={{ padding:"28px 24px", maxWidth:1000, margin:"0 auto", fontFamily:"system-ui,sans-serif" }}>
      {toast && <Toast msg={toast.msg} ok={toast.ok} />}

      {/* Header */}
      <div style={{ marginBottom:24 }}>
        <h1 style={{ fontSize:26, fontWeight:900, color:C.gray800, margin:0 }}>Plantillas PDF</h1>
        <p style={{ color:C.gray400, fontSize:13, margin:"4px 0 0" }}>Configura el diseño de cada plantilla de cotización</p>
      </div>

      {/* Grid de plantillas */}
      {loading ? (
        <div style={{ textAlign:"center", padding:60, color:C.gray400 }}>Cargando...</div>
      ) : (
        <div style={{ display:"grid", gridTemplateColumns:"repeat(auto-fill,minmax(220px,1fr))", gap:14, marginBottom:28 }}>
          {plantillas.map(p => (
            <div key={p.id} style={{ background:C.white, border:`2px solid ${editId===p.id?p.color_primario:C.gray200}`, borderRadius:18, padding:18, boxShadow: editId===p.id?"0 0 0 3px "+p.color_primario+"22":"none", transition:"all 0.15s" }}>
              <div style={{ display:"flex", alignItems:"center", justifyContent:"space-between", marginBottom:10 }}>
                <div style={{ display:"flex", alignItems:"center", gap:8 }}>
                  <span style={{ fontSize:22 }}>{p.icono}</span>
                  <div>
                    <p style={{ fontWeight:900, fontSize:13, color:C.gray800, margin:0 }}>{p.nombre}</p>
                    {p.es_principal && <span style={{ fontSize:9, fontWeight:900, background:p.color_primario, color:"white", padding:"2px 7px", borderRadius:20 }}>PRINCIPAL</span>}
                  </div>
                </div>
                {/* toggle activa */}
                <button
                  onClick={() => toggleActiva(p)}
                  disabled={p.es_principal}
                  title={p.es_principal ? "No se puede desactivar la plantilla principal" : "Activar/desactivar"}
                  style={{ width:38, height:22, borderRadius:11, border:"none", cursor: p.es_principal?"not-allowed":"pointer", background: p.activa ? "#16a34a" : "#e2e8f0", position:"relative", transition:"background 0.2s", opacity: p.es_principal? 0.5 : 1 }}
                >
                  <span style={{ position:"absolute", top:3, left: p.activa ? 18 : 3, width:16, height:16, borderRadius:"50%", background:"white", transition:"left 0.2s" }} />
                </button>
              </div>
              <p style={{ color:C.gray400, fontSize:11, margin:"0 0 10px" }}>{p.descripcion}</p>
              <div style={{ display:"flex", gap:6, marginBottom:12 }}>
                <div style={{ width:18, height:18, borderRadius:4, background:p.color_primario, border:"1px solid #e2e8f0" }} title="Color primario" />
                <div style={{ width:18, height:18, borderRadius:4, background:p.color_secundario, border:"1px solid #e2e8f0" }} title="Color secundario" />
                <div style={{ width:18, height:18, borderRadius:4, background:p.color_acento, border:"1px solid #e2e8f0" }} title="Color acento" />
              </div>
              {p.recomendado_para && <p style={{ fontSize:10, color:C.gray400, background:C.gray50, borderRadius:6, padding:"3px 8px", margin:"0 0 10px" }}>📌 {p.recomendado_para}</p>}
              <div style={{ display:"flex", gap:5 }}>
                <span style={{ fontSize:10, fontWeight:700, background: p.idioma==="es_en"?"#dbeafe":C.gray100, color: p.idioma==="es_en"?"#1d4ed8":C.gray600, padding:"2px 8px", borderRadius:20 }}>
                  {p.idioma==="es"?"ES":p.idioma==="en"?"EN":"ES+EN"}
                </span>
              </div>
              <button
                onClick={() => abrirEditor(p)}
                style={{ marginTop:12, width:"100%", padding:"8px", borderRadius:10, border:`1px solid ${p.color_primario}33`, background: editId===p.id ? p.color_primario : C.gray50, color: editId===p.id ? "white" : p.color_primario, fontWeight:800, fontSize:12, cursor:"pointer" }}
              >
                {editId===p.id ? "✓ Editando" : "⚙ Configurar"}
              </button>
            </div>
          ))}
        </div>
      )}

      {/* Editor */}
      {editId && form && (
        <div style={{ background:C.white, border:`2px solid ${cp}`, borderRadius:22, overflow:"hidden", boxShadow:"0 8px 32px rgba(0,0,0,0.08)" }}>
          {/* header editor */}
          <div style={{ background:cp, padding:"16px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
            <div>
              <p style={{ color:"white", fontWeight:900, fontSize:16, margin:0 }}>{editP?.icono} {editP?.nombre}</p>
              <p style={{ color:"rgba(255,255,255,0.6)", fontSize:11, margin:"3px 0 0" }}>Editando configuración</p>
            </div>
            <div style={{ display:"flex", gap:8 }}>
              <button onClick={restaurar} style={{ padding:"7px 16px", borderRadius:10, border:"1px solid rgba(255,255,255,0.3)", background:"transparent", color:"white", fontWeight:700, fontSize:12, cursor:"pointer" }}>↺ Restaurar</button>
              <button onClick={guardar} disabled={guardando} style={{ padding:"7px 18px", borderRadius:10, border:"none", background:"white", color:cp, fontWeight:900, fontSize:12, cursor:"pointer", opacity: guardando ? 0.7 : 1 }}>{guardando ? "Guardando..." : "💾 Guardar"}</button>
              <button onClick={() => setEditId(null)} style={{ padding:"7px 12px", borderRadius:10, border:"1px solid rgba(255,255,255,0.3)", background:"transparent", color:"white", fontWeight:700, fontSize:13, cursor:"pointer" }}>✕</button>
            </div>
          </div>

          {/* tabs */}
          <div style={{ background:C.gray50, borderBottom:`1px solid ${C.gray200}`, display:"flex", overflowX:"auto" }}>
            {([
              { id:"diseno",     label:"🎨 Diseño" },
              { id:"contenido",  label:"📝 Contenido" },
              { id:"condiciones",label:"📋 Condiciones" },
              { id:"bancos",     label:"🏦 Cuentas" },
              { id:"idioma",     label:"🌐 Idioma" },
            ] as const).map(t => (
              <button key={t.id} onClick={() => setTab(t.id)}
                style={{ padding:"11px 20px", border:"none", borderBottom:`3px solid ${tab===t.id?cp:"transparent"}`, background:"none", color: tab===t.id?cp:C.gray600, fontWeight: tab===t.id?800:600, fontSize:13, cursor:"pointer", whiteSpace:"nowrap" }}
              >{t.label}</button>
            ))}
          </div>

          <div style={{ padding:24 }}>

            {/* ── TAB DISEÑO ── */}
            {tab === "diseno" && (
              <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
                {editP?.es_principal && (
                  <div style={{ background:"#fef9c3", border:"1px solid #fde047", borderRadius:12, padding:"12px 16px" }}>
                    <p style={{ fontWeight:700, fontSize:12, color:"#854d0e", margin:0 }}>ℹ️ Los colores se aplican a las nuevas plantillas. El diseño base del Clásico Corporativo no cambia para garantizar compatibilidad.</p>
                  </div>
                )}
                {/* preview colores */}
                <div style={{ background:`linear-gradient(135deg, ${cp} 0%, ${cs} 100%)`, borderRadius:14, padding:"18px 24px", display:"flex", alignItems:"center", justifyContent:"space-between" }}>
                  <div>
                    <p style={{ color:"white", fontWeight:900, fontSize:16, margin:0 }}>{form.titulo_documento||"COTIZACIÓN"}</p>
                    <p style={{ color:"rgba(255,255,255,0.65)", fontSize:12, margin:"4px 0 0" }}>Preview en tiempo real</p>
                  </div>
                  <div style={{ width:44, height:44, borderRadius:12, background:ca, display:"flex", alignItems:"center", justifyContent:"center", fontSize:20 }}>★</div>
                </div>
                <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:14 }}>
                  <div>
                    <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Color primario</label>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      <input type="color" value={form.color_primario as string||"#0b315f"} onChange={fStr("color_primario")} style={{ width:44, height:40, border:"1px solid #e2e8f0", borderRadius:8, cursor:"pointer", padding:2 }} />
                      <input value={form.color_primario as string||""} onChange={fStr("color_primario")} style={{ ...iSt, fontFamily:"monospace", flex:1 }} placeholder="#0b315f" />
                    </div>
                  </div>
                  <div>
                    <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Color secundario</label>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      <input type="color" value={form.color_secundario as string||"#1262bd"} onChange={fStr("color_secundario")} style={{ width:44, height:40, border:"1px solid #e2e8f0", borderRadius:8, cursor:"pointer", padding:2 }} />
                      <input value={form.color_secundario as string||""} onChange={fStr("color_secundario")} style={{ ...iSt, fontFamily:"monospace", flex:1 }} placeholder="#1262bd" />
                    </div>
                  </div>
                  <div>
                    <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Color acento / dorado</label>
                    <div style={{ display:"flex", gap:8, alignItems:"center" }}>
                      <input type="color" value={form.color_acento as string||"#C8A24B"} onChange={fStr("color_acento")} style={{ width:44, height:40, border:"1px solid #e2e8f0", borderRadius:8, cursor:"pointer", padding:2 }} />
                      <input value={form.color_acento as string||""} onChange={fStr("color_acento")} style={{ ...iSt, fontFamily:"monospace", flex:1 }} placeholder="#C8A24B" />
                    </div>
                  </div>
                </div>
                <div>
                  <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Fuente</label>
                  <select value={form.fuente as string||"Helvetica Neue"} onChange={fStr("fuente")} style={iSt}>
                    {FUENTES.map(f => <option key={f}>{f}</option>)}
                  </select>
                </div>
              </div>
            )}

            {/* ── TAB CONTENIDO ── */}
            {tab === "contenido" && (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <div>
                  <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Título del documento</label>
                  <input value={form.titulo_documento as string||""} onChange={fStr("titulo_documento")} style={iSt} placeholder="COTIZACIÓN DE SERVICIO" />
                </div>
                <div>
                  <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Subtítulo (opcional)</label>
                  <input value={form.subtitulo as string||""} onChange={fStr("subtitulo")} style={iSt} placeholder="Ej: Propuesta personalizada" />
                </div>
                <div>
                  <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:6 }}>Mensaje de cierre</label>
                  <textarea value={form.mensaje_cierre as string||""} onChange={fStr("mensaje_cierre")} rows={2} style={{ ...iSt, resize:"vertical" }} placeholder="Agradecemos su preferencia..." />
                </div>
                <div>
                  <p style={{ fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:12 }}>Elementos a mostrar</p>
                  <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr", gap:10 }}>
                    {([
                      { k:"mostrar_logo",             label:"🏢 Logo empresa" },
                      { k:"mostrar_fotos_vehiculo",   label:"📸 Fotos del vehículo" },
                      { k:"mostrar_itinerario",       label:"🗺️ Itinerario / paradas" },
                      { k:"mostrar_precio_pax",       label:"👥 Precio por pasajero" },
                      { k:"mostrar_sla",              label:"⏱️ SLA / tiempos" },
                      { k:"mostrar_cuentas_bancarias",label:"🏦 Cuentas bancarias" },
                      { k:"mostrar_firma",            label:"✍️ Firma" },
                    ] as const).map(({ k, label }) => (
                      <label key={k} style={{ display:"flex", alignItems:"center", gap:10, background:C.gray50, borderRadius:10, padding:"10px 14px", cursor:"pointer" }}>
                        <input type="checkbox" checked={!!form[k]} onChange={fBool(k)} style={{ width:16, height:16, accentColor:cp }} />
                        <span style={{ fontSize:13, fontWeight:600, color:C.gray800 }}>{label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              </div>
            )}

            {/* ── TAB CONDICIONES ── */}
            {tab === "condiciones" && (
              <div style={{ display:"flex", flexDirection:"column", gap:20 }}>
                <ListaItems campo="condiciones_incluye"   label="✅ Incluye"               color="#166534" />
                <ListaItems campo="condiciones_no_incluye" label="❌ No incluye"            color="#991b1b" />
                <ListaItems campo="condiciones_generales" label="📋 Consideraciones generales" color="#0b315f" />
                <button onClick={() => setForm(prev => ({ ...prev, condiciones_incluye: DEFAULT_INC, condiciones_no_incluye: DEFAULT_NOINC, condiciones_generales: DEFAULT_GEN }))}
                  style={{ padding:"9px 18px", borderRadius:10, border:"1px solid #e2e8f0", background:C.gray50, color:C.gray600, fontWeight:700, fontSize:12, cursor:"pointer", alignSelf:"flex-start" }}>
                  ↺ Restaurar condiciones por defecto
                </button>
              </div>
            )}

            {/* ── TAB BANCOS ── */}
            {tab === "bancos" && (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <label style={{ display:"flex", alignItems:"center", gap:10, background:C.gray50, borderRadius:12, padding:"12px 16px", cursor:"pointer" }}>
                  <input type="checkbox" checked={!!form.usar_bancos_propios} onChange={fBool("usar_bancos_propios")} style={{ width:18, height:18, accentColor:cp }} />
                  <div>
                    <p style={{ fontWeight:800, fontSize:13, color:C.gray800, margin:0 }}>Usar cuentas propias de esta plantilla</p>
                    <p style={{ color:C.gray400, fontSize:11, margin:"2px 0 0" }}>Si está desactivado, se usan las cuentas del perfil de empresa</p>
                  </div>
                </label>
                {form.usar_bancos_propios && (
                  <div style={{ display:"flex", flexDirection:"column", gap:14 }}>
                    {([1,2,3] as const).map(n => (
                      <div key={n} style={{ background:C.gray50, borderRadius:12, padding:"14px 16px" }}>
                        <p style={{ fontWeight:800, fontSize:12, color:cp, marginBottom:10 }}>Banco {n}</p>
                        <div style={{ display:"grid", gridTemplateColumns:"1fr 1fr 1fr", gap:10 }}>
                          <div><label style={{ fontSize:10, fontWeight:700, color:C.gray400, textTransform:"uppercase" as const, display:"block", marginBottom:4 }}>Banco</label><input value={(form[`banco_${n}_nombre` as keyof Plantilla] as string)||""} onChange={fStr(`banco_${n}_nombre` as any)} style={iSt} placeholder="BCP" /></div>
                          <div><label style={{ fontSize:10, fontWeight:700, color:C.gray400, textTransform:"uppercase" as const, display:"block", marginBottom:4 }}>N° Cuenta</label><input value={(form[`banco_${n}_cuenta` as keyof Plantilla] as string)||""} onChange={fStr(`banco_${n}_cuenta` as any)} style={{ ...iSt, fontFamily:"monospace" }} placeholder="000-000000-0-00" /></div>
                          <div><label style={{ fontSize:10, fontWeight:700, color:C.gray400, textTransform:"uppercase" as const, display:"block", marginBottom:4 }}>CCI</label><input value={(form[`banco_${n}_cci` as keyof Plantilla] as string)||""} onChange={fStr(`banco_${n}_cci` as any)} style={{ ...iSt, fontFamily:"monospace" }} placeholder="00000000000000000000" /></div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
                {!form.usar_bancos_propios && (
                  <div style={{ background:"#eef3f8", borderRadius:12, padding:"14px 18px", border:"1px solid #c7d8ed" }}>
                    <p style={{ fontWeight:700, fontSize:13, color:cp, margin:0 }}>ℹ️ Se usarán las cuentas configuradas en Perfil Empresa</p>
                    <p style={{ color:C.gray600, fontSize:12, margin:"4px 0 0" }}>Ve a Configuración → Perfil Empresa para editar las cuentas bancarias.</p>
                  </div>
                )}
              </div>
            )}

            {/* ── TAB IDIOMA ── */}
            {tab === "idioma" && (
              <div style={{ display:"flex", flexDirection:"column", gap:16 }}>
                <div>
                  <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:8 }}>Idioma del PDF</label>
                  <div style={{ display:"flex", gap:10 }}>
                    {IDIOMAS.map(id => (
                      <button key={id.val} onClick={() => setForm(prev => ({ ...prev, idioma: id.val }))}
                        style={{ flex:1, padding:"12px", borderRadius:12, border:`2px solid ${form.idioma===id.val?cp:"#e2e8f0"}`, background: form.idioma===id.val?"#eef3f8":"white", color: form.idioma===id.val?cp:C.gray600, fontWeight:800, fontSize:13, cursor:"pointer" }}>
                        {id.label}
                      </button>
                    ))}
                  </div>
                </div>
                {form.idioma === "es_en" && (
                  <div style={{ background:"#eef3f8", border:"1px solid #c7d8ed", borderRadius:12, padding:"14px 18px" }}>
                    <p style={{ fontWeight:700, fontSize:13, color:cp, margin:"0 0 8px" }}>📋 Modo bilingüe activo</p>
                    <p style={{ color:C.gray600, fontSize:12, margin:0 }}>El PDF mostrará títulos y etiquetas en español e inglés simultáneamente. Aplicable a la plantilla Ejecutivo Premium.</p>
                  </div>
                )}
                <div>
                  <label style={{ display:"block", fontSize:11, fontWeight:700, color:C.gray400, textTransform:"uppercase", marginBottom:8 }}>Recomendado para</label>
                  <input value={form.recomendado_para as string||""} onChange={fStr("recomendado_para")} style={iSt} placeholder="Ej: B2B · Empresas · Contratos" />
                </div>
              </div>
            )}

          </div>

          {/* footer guardar */}
          <div style={{ padding:"16px 24px", borderTop:`1px solid ${C.gray200}`, display:"flex", justifyContent:"flex-end", gap:10, background:C.gray50 }}>
            <button onClick={restaurar} style={{ padding:"9px 18px", borderRadius:10, border:`1px solid ${C.gray200}`, background:C.white, color:C.gray600, fontWeight:700, fontSize:13, cursor:"pointer" }}>↺ Restaurar</button>
            <button onClick={guardar} disabled={guardando} style={{ padding:"9px 24px", borderRadius:10, border:"none", background:cp, color:"white", fontWeight:900, fontSize:13, cursor:"pointer", opacity: guardando?0.7:1 }}>{guardando?"Guardando...":"💾 Guardar cambios"}</button>
          </div>
        </div>
      )}

      {/* SQL hint */}
      <div style={{ marginTop:32, background:C.gray50, border:"1px solid #e2e8f0", borderRadius:14, padding:"14px 18px" }}>
        <p style={{ fontWeight:800, color:C.gray600, fontSize:12, margin:"0 0 6px" }}>📌 SQL requerido (ejecutar en Supabase si las plantillas no aparecen)</p>
        <code style={{ fontSize:10, color:C.gray400, display:"block" }}>
          ALTER TABLE cotizaciones ADD COLUMN IF NOT EXISTS plantilla_pdf TEXT DEFAULT 'corporativo';
        </code>
      </div>
    </div>
  );
}
