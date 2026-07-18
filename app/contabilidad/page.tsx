"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /contabilidad — Compras (Registro de Compras) · IGV · Asientos · Activos fijos.
// Los asientos se DERIVAN de los documentos (no se teclean). Requiere finanzas-00..05
// y contabilidad-04.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda, redondear } from "@/lib/finanzas/dinero";
import { asientoVenta, asientoCompra, asientoDepreciacion, guardarAsiento } from "@/lib/contabilidad/asientos";

async function traerTodo(query: () => any): Promise<any[]> {
  const paso = 1000; let desde = 0; const acc: any[] = [];
  for (;;) {
    const { data, error } = await query().range(desde, desde + paso - 1);
    if (error) break;
    const filas = (data as any[]) ?? [];
    acc.push(...filas);
    if (filas.length < paso) break;
    desde += paso;
  }
  return acc;
}
const periodoDe = (f?: string | null) => (f ?? "").slice(0, 7);
const mesActual = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 7);

export default function ContabilidadPage() {
  const [tab, setTab] = useState<"compras" | "igv" | "asientos" | "activos" | "bandeja">("compras");
  const [cargando, setCargando] = useState(true);
  const [facturas, setFacturas] = useState<any[]>([]);
  const [docs, setDocs] = useState<any[]>([]);
  const [asientos, setAsientos] = useState<any[]>([]);
  const [activos, setActivos] = useState<any[]>([]);
  const [deprec, setDeprec] = useState<any[]>([]);
  const [bandeja, setBandeja] = useState<any[]>([]);
  const [periodo, setPeriodo] = useState(mesActual());
  const [msg, setMsg] = useState("");
  const [trab, setTrab] = useState(false);

  async function cargar() {
    setCargando(true);
    try {
      const [fs, dc, as, af, dp, bj] = await Promise.all([
        traerTodo(() => supabase.from("facturas").select("id,serie,numero,fecha_emision,subtotal,igv,total,estado,tipo_comprobante,cliente_id").neq("estado", "anulada")),
        traerTodo(() => supabase.from("documentos_compra").select("*").neq("estado_conciliacion", "anulado")),
        supabase.from("asiento").select("id,numero,fecha,glosa,origen_tipo,origen_id,total_debe,total_haber,estado").order("id", { ascending: false }).limit(200),
        supabase.from("activos_fijos").select("*").eq("activo", true),
        supabase.from("depreciacion").select("*"),
        supabase.from("radar_facturas").select("*").order("id", { ascending: false }).limit(50),
      ]);
      setFacturas(fs); setDocs(dc);
      setAsientos((as.data as any[]) ?? []);
      setActivos((af.data as any[]) ?? []);
      setDeprec((dp.data as any[]) ?? []);
      setBandeja((bj.data as any[]) ?? []);
    } catch (e: any) {
      setMsg("No se pudo cargar. ¿Corriste finanzas-00..05 y contabilidad-04? " + (e?.message ?? e));
    } finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  // ── IGV del periodo: débito (ventas) vs crédito (compras) ───────────────────
  const igv = useMemo(() => {
    const debito = facturas.filter((f) => periodoDe(f.fecha_emision) === periodo).reduce((a, f) => a + Number(f.igv ?? 0), 0);
    const credito = docs.filter((d) => periodoDe(d.fecha_emision) === periodo).reduce((a, d) => a + Number(d.igv ?? 0), 0);
    return { debito: redondear(debito), credito: redondear(credito), aPagar: redondear(Math.max(0, debito - credito)) };
  }, [facturas, docs, periodo]);

  const asientoDe = useMemo(() => {
    const s = new Set(asientos.filter((a) => a.estado !== "anulado").map((a) => `${a.origen_tipo}:${a.origen_id}`));
    return s;
  }, [asientos]);

  // ── Generar asientos faltantes (venta + compra) ─────────────────────────────
  async function generarAsientos() {
    setTrab(true); setMsg("");
    let n = 0;
    try {
      for (const f of facturas) {
        if (asientoDe.has(`factura:${f.id}`)) continue;
        if (!(Number(f.total ?? 0) > 0)) continue;
        const a = asientoVenta({ id: f.id, fecha: f.fecha_emision ?? mesActual() + "-01", subtotal: Number(f.subtotal ?? 0), igv: Number(f.igv ?? 0), total: Number(f.total ?? 0), tipo_comprobante: f.tipo_comprobante, cliente_id: f.cliente_id });
        const r = await guardarAsiento(supabase, a); if (r.ok && !r.yaExistia) n++;
      }
      for (const d of docs) {
        if (asientoDe.has(`documento_compra:${d.id}`)) continue;
        if (!(Number(d.total ?? 0) > 0)) continue;
        const a = asientoCompra({ id: d.id, fecha: d.fecha_emision ?? mesActual() + "-01", subtotal: Number(d.subtotal ?? 0), igv: Number(d.igv ?? 0), total: Number(d.total ?? 0), categoria: d.categoria, proveedor_id: d.proveedor_id });
        const r = await guardarAsiento(supabase, a); if (r.ok && !r.yaExistia) n++;
      }
      setMsg(`✅ ${n} asiento(s) generados.`); await cargar();
    } catch (e: any) { setMsg("⚠️ " + (e?.message ?? e)); } finally { setTrab(false); }
  }

  // ── Depreciación del periodo (lineal) ───────────────────────────────────────
  async function depreciarMes() {
    setTrab(true); setMsg("");
    let n = 0;
    try {
      for (const act of activos) {
        if (deprec.some((d) => d.activo_id === act.id && d.periodo === periodo)) continue;
        const vida = Number(act.vida_util_meses ?? 60);
        const base = Number(act.valor_adquisicion ?? 0) - Number(act.valor_residual ?? 0);
        const cuota = vida > 0 ? redondear(base / vida) : 0;
        if (cuota <= 0) continue;
        const acumPrev = deprec.filter((d) => d.activo_id === act.id).reduce((a, d) => a + Number(d.monto || 0), 0);
        const { data: dep, error } = await supabase.from("depreciacion").insert({ activo_id: act.id, periodo, monto: cuota, acumulado: redondear(acumPrev + cuota) }).select("id").single();
        if (error) continue;
        const asi = asientoDepreciacion({ id: Number((dep as any).id), fecha: periodo + "-28", monto: cuota, vehiculo_id: act.vehiculo_id });
        const r = await guardarAsiento(supabase, asi);
        if (r.ok && r.id) await supabase.from("depreciacion").update({ asiento_id: r.id }).eq("id", (dep as any).id);
        n++;
      }
      setMsg(`✅ Depreciación de ${n} activo(s) registrada para ${periodo}.`); await cargar();
    } catch (e: any) { setMsg("⚠️ " + (e?.message ?? e)); } finally { setTrab(false); }
  }

  // ── Lector de factura por archivo (XML/PDF) → /api/facturas/leer ────────────
  async function leerArchivo(file: File) {
    setTrab(true); setMsg("Leyendo factura…");
    try {
      if (file.name.toLowerCase().endsWith(".xml")) {
        const xml = await file.text();
        const res = await fetch("/api/facturas/leer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ xml, conciliar: true }) });
        const j = await res.json();
        setMsg(j.ok ? `✅ ${j.conciliacion?.detalle ?? "Factura leída."}` : `⚠️ ${j.error}`);
      } else {
        const b64 = await new Promise<string>((ok, err) => { const r = new FileReader(); r.onload = () => ok(String(r.result).split(",")[1] || ""); r.onerror = err; r.readAsDataURL(file); });
        const tipo = file.type === "application/pdf" ? "pdf" : "image";
        const res = await fetch("/api/facturas/leer", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ adjunto: { tipo, media_type: file.type, data: b64 }, conciliar: true }) });
        const j = await res.json();
        setMsg(j.ok ? `✅ ${j.conciliacion?.detalle ?? `Leída: ${j.extraida?.razon_social ?? ""} ${fmtMoneda(Number(j.extraida?.total ?? 0))}`}` : `⚠️ ${j.error}`);
      }
      await cargar();
    } catch (e: any) { setMsg("⚠️ " + (e?.message ?? e)); } finally { setTrab(false); }
  }

  const Card = ({ t, v, c }: { t: string; v: string; c?: string }) => (
    <div className="bg-white rounded-2xl border shadow-sm p-4"><p className="text-xs text-gray-400 font-semibold uppercase">{t}</p><p className={`text-2xl font-black ${c ?? "text-[#0b315f]"}`}>{v}</p></div>
  );

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-black text-[#0b315f]">Contabilidad</h1>
          <p className="text-sm text-gray-500">Compras, IGV, asientos automáticos y activos fijos. Los asientos se derivan de los documentos.</p>
        </div>
        <input type="month" value={periodo} onChange={(e) => setPeriodo(e.target.value)} className="border rounded-lg px-3 py-1.5 text-sm" />
      </div>
      <div className="flex gap-2 mb-4 flex-wrap">
        {(["compras", "igv", "asientos", "activos", "bandeja"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-xl text-sm font-bold capitalize transition ${tab === t ? "bg-[#0b315f] text-white shadow" : "bg-white text-gray-600 hover:bg-gray-50 border"}`}>{t === "bandeja" ? "Bandeja IA" : t}</button>
        ))}
        <button onClick={cargar} className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold bg-white border hover:bg-gray-50">↻</button>
      </div>
      {msg && <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

      {cargando ? <div className="py-16 text-center text-gray-400">Cargando…</div> : (
        <>
          {tab === "compras" && (
            <div className="grid gap-4">
              <label className="bg-white rounded-2xl border-2 border-dashed border-[#2a5298]/40 p-5 text-center cursor-pointer hover:bg-blue-50/40">
                <input type="file" accept=".xml,application/pdf,image/*" className="hidden" disabled={trab}
                  onChange={(e) => { const f = e.target.files?.[0]; if (f) leerArchivo(f); e.currentTarget.value = ""; }} />
                <p className="font-bold text-[#2a5298]">📎 Leer factura de proveedor (XML SUNAT o PDF/foto)</p>
                <p className="text-xs text-gray-400">La IA extrae RUC/serie/número/IGV/total y concilia con el abastecimiento existente sin duplicar.</p>
              </label>
              <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-400 text-xs uppercase"><tr>
                    <th className="text-left px-4 py-2">Emisor</th><th className="text-left px-4 py-2">Comprobante</th><th className="text-left px-4 py-2">Fecha</th>
                    <th className="text-right px-4 py-2">Subtotal</th><th className="text-right px-4 py-2">IGV</th><th className="text-right px-4 py-2">Total</th><th className="text-left px-4 py-2">Estado</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {docs.slice(0, 150).map((d) => (
                      <tr key={d.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2">{d.razon_social ?? d.ruc_emisor ?? "—"}</td>
                        <td className="px-4 py-2 font-mono text-xs">{d.serie ?? ""}{d.numero ? "-" + d.numero : ""}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">{d.fecha_emision ?? "—"}</td>
                        <td className="px-4 py-2 text-right">{fmtMoneda(Number(d.subtotal ?? 0))}</td>
                        <td className="px-4 py-2 text-right">{fmtMoneda(Number(d.igv ?? 0))}</td>
                        <td className="px-4 py-2 text-right font-bold">{fmtMoneda(Number(d.total ?? 0))}</td>
                        <td className="px-4 py-2 text-xs">{d.estado_conciliacion}</td>
                      </tr>
                    ))}
                    {docs.length === 0 && <tr><td colSpan={7} className="p-8 text-center text-gray-400">Sin compras registradas. Sube una factura arriba.</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "igv" && (
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <Card t={`IGV ventas ${periodo}`} v={fmtMoneda(igv.debito)} c="text-emerald-600" />
              <Card t={`IGV compras ${periodo}`} v={fmtMoneda(igv.credito)} c="text-blue-600" />
              <Card t="IGV a pagar" v={fmtMoneda(igv.aPagar)} c={igv.aPagar > 0 ? "text-red-600" : "text-emerald-600"} />
              <p className="md:col-span-3 text-xs text-gray-400">Débito fiscal (ventas) − crédito fiscal (compras) = IGV a pagar del periodo. Base del PLE (Registro de Ventas/Compras) — export TXT es fase posterior.</p>
            </div>
          )}

          {tab === "asientos" && (
            <div className="grid gap-4">
              <button disabled={trab} onClick={generarAsientos} className="self-start px-4 py-2 rounded-xl text-sm font-bold bg-[#2a5298] text-white hover:bg-[#1e3d73] disabled:opacity-50">Generar asientos faltantes</button>
              <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-400 text-xs uppercase"><tr>
                    <th className="text-left px-4 py-2">Nº</th><th className="text-left px-4 py-2">Fecha</th><th className="text-left px-4 py-2">Glosa</th>
                    <th className="text-left px-4 py-2">Origen</th><th className="text-right px-4 py-2">Debe</th><th className="text-right px-4 py-2">Haber</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {asientos.map((a) => (
                      <tr key={a.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs">{a.numero}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">{a.fecha}</td>
                        <td className="px-4 py-2">{a.glosa}</td>
                        <td className="px-4 py-2 text-xs text-gray-400">{a.origen_tipo}#{a.origen_id}</td>
                        <td className="px-4 py-2 text-right">{fmtMoneda(Number(a.total_debe ?? 0))}</td>
                        <td className="px-4 py-2 text-right">{fmtMoneda(Number(a.total_haber ?? 0))}</td>
                      </tr>
                    ))}
                    {asientos.length === 0 && <tr><td colSpan={6} className="p-8 text-center text-gray-400">Sin asientos. Pulsa "Generar asientos faltantes".</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "activos" && (
            <div className="grid gap-4">
              <button disabled={trab} onClick={depreciarMes} className="self-start px-4 py-2 rounded-xl text-sm font-bold bg-[#2a5298] text-white hover:bg-[#1e3d73] disabled:opacity-50">Depreciar {periodo}</button>
              <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-400 text-xs uppercase"><tr>
                    <th className="text-left px-4 py-2">Activo</th><th className="text-right px-4 py-2">Valor</th><th className="text-right px-4 py-2">Vida (m)</th>
                    <th className="text-right px-4 py-2">Deprec. acum.</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {activos.map((a) => {
                      const acum = deprec.filter((d) => d.activo_id === a.id).reduce((s, d) => s + Number(d.monto || 0), 0);
                      return (
                        <tr key={a.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2">{a.descripcion}</td>
                          <td className="px-4 py-2 text-right">{fmtMoneda(Number(a.valor_adquisicion ?? 0))}</td>
                          <td className="px-4 py-2 text-right">{a.vida_util_meses}</td>
                          <td className="px-4 py-2 text-right font-semibold">{fmtMoneda(acum)}</td>
                        </tr>
                      );
                    })}
                    {activos.length === 0 && <tr><td colSpan={4} className="p-8 text-center text-gray-400">Sin activos fijos. Regístralos en <code>activos_fijos</code> (los vehículos son el maestro natural).</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "bandeja" && (
            <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-gray-50 text-gray-400 text-xs uppercase"><tr>
                  <th className="text-left px-4 py-2">Recibido</th><th className="text-left px-4 py-2">Emisor</th><th className="text-left px-4 py-2">Comprobante</th>
                  <th className="text-right px-4 py-2">Total</th><th className="text-left px-4 py-2">Estado</th>
                </tr></thead>
                <tbody className="divide-y">
                  {bandeja.map((b) => (
                    <tr key={b.id} className="hover:bg-gray-50">
                      <td className="px-4 py-2 text-xs text-gray-500">{(b.recibido_en ?? "").slice(0, 16).replace("T", " ")}</td>
                      <td className="px-4 py-2">{b.razon_social ?? b.remitente_email ?? "—"}</td>
                      <td className="px-4 py-2 font-mono text-xs">{b.serie ?? ""}{b.numero ? "-" + b.numero : ""}</td>
                      <td className="px-4 py-2 text-right">{fmtMoneda(Number(b.total ?? 0))}</td>
                      <td className="px-4 py-2 text-xs">{b.estado}</td>
                    </tr>
                  ))}
                  {bandeja.length === 0 && <tr><td colSpan={5} className="p-8 text-center text-gray-400">Bandeja vacía. El pipeline de correo (fase 4) alimentará <code>radar_facturas</code>.</td></tr>}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}
