"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /finanzas — Hub de dinero: Ingresos (CxC) · Egresos · Tesorería.
// El aging de CxC/CxP es REAL: saldo = total − Σ pagos_aplicacion (derivado, no flag).
// Requiere supabase/finanzas-00..02.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda, saldo as calcSaldo, diasVencido, cubetaAging } from "@/lib/finanzas/dinero";
import { registrarCobroFactura, registrarPagoCompra } from "@/lib/finanzas/pagos";

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

const BUCKETS = ["vigente", "0-30", "31-60", "61-90", "+90"] as const;

export default function FinanzasPage() {
  const [tab, setTab] = useState<"ingresos" | "egresos" | "tesoreria">("ingresos");
  const [cargando, setCargando] = useState(true);
  const [facturas, setFacturas] = useState<any[]>([]);
  const [aplicFactura, setAplicFactura] = useState<Record<number, number>>({});
  const [aplicCompra, setAplicCompra] = useState<Record<number, number>>({});
  const [egresos, setEgresos] = useState<any[]>([]);
  const [docsCompra, setDocsCompra] = useState<any[]>([]);
  const [cuentas, setCuentas] = useState<any[]>([]);
  const [movs, setMovs] = useState<any[]>([]);
  const [msg, setMsg] = useState("");

  async function cargar() {
    setCargando(true);
    try {
      const [fs, ap, eg, dc, ct, mv] = await Promise.all([
        traerTodo(() => supabase.from("facturas").select("id,serie,numero,cliente_id,total,estado,fecha_emision,fecha_vencimiento,tipo_comprobante").neq("estado", "anulada").order("fecha_emision", { ascending: false })),
        supabase.from("pagos_aplicacion").select("documento_tipo,documento_id,monto_aplicado,pagos!inner(anulado)").eq("pagos.anulado", false),
        traerTodo(() => supabase.from("v_egresos").select("*").order("fecha", { ascending: false })),
        traerTodo(() => supabase.from("documentos_compra").select("id,razon_social,proveedor_id,total,estado_conciliacion,fecha_emision,fecha_vencimiento,serie,numero").neq("estado_conciliacion", "anulado").order("fecha_emision", { ascending: false })),
        supabase.from("cuentas_tesoreria").select("*").order("id"),
        supabase.from("movimientos_tesoreria").select("*").order("fecha", { ascending: false }).limit(300),
      ]);
      setFacturas(fs);
      const af: Record<number, number> = {}, ac: Record<number, number> = {};
      for (const r of ((ap.data as any[]) ?? [])) {
        if (r.documento_tipo === "factura") af[r.documento_id] = (af[r.documento_id] ?? 0) + Number(r.monto_aplicado || 0);
        else if (r.documento_tipo === "documento_compra") ac[r.documento_id] = (ac[r.documento_id] ?? 0) + Number(r.monto_aplicado || 0);
      }
      setAplicFactura(af); setAplicCompra(ac);
      setEgresos(eg); setDocsCompra(dc);
      setCuentas((ct.data as any[]) ?? []);
      setMovs((mv.data as any[]) ?? []);
    } catch (e: any) {
      setMsg("No se pudo cargar. ¿Corriste supabase/finanzas-00..02? " + (e?.message ?? e));
    } finally { setCargando(false); }
  }
  useEffect(() => { cargar(); }, []);

  // ── Ingresos: CxC + aging ──────────────────────────────────────────────────
  const cxc = useMemo(() => {
    const filas = facturas.map((f) => {
      const pagado = aplicFactura[f.id] ?? 0;
      const sal = calcSaldo(Number(f.total ?? 0), pagado);
      const dias = diasVencido(f.fecha_vencimiento);
      return { ...f, pagado, saldo: sal, dias, bucket: sal > 0 ? cubetaAging(dias) : "cobrada" };
    });
    const totalFacturado = filas.reduce((a, f) => a + Number(f.total ?? 0), 0);
    const porCobrar = filas.reduce((a, f) => a + f.saldo, 0);
    const porBucket: Record<string, number> = {};
    for (const b of BUCKETS) porBucket[b] = 0;
    for (const f of filas) if (f.saldo > 0) porBucket[f.bucket] += f.saldo;
    return { filas, totalFacturado, porCobrar, porBucket };
  }, [facturas, aplicFactura]);

  // ── Egresos: vista única ────────────────────────────────────────────────────
  const egresosResumen = useMemo(() => {
    const porFuente: Record<string, number> = {};
    let total = 0;
    for (const e of egresos) { porFuente[e.fuente] = (porFuente[e.fuente] ?? 0) + Number(e.monto || 0); total += Number(e.monto || 0); }
    return { porFuente, total };
  }, [egresos]);

  // ── Tesorería: saldo por cuenta = inicial + Σ movimientos ──────────────────
  const saldosCuenta = useMemo(() => {
    const m: Record<number, number> = {};
    for (const c of cuentas) m[c.id] = Number(c.saldo_inicial ?? 0);
    for (const mv of movs) m[mv.cuenta_tesoreria_id] = (m[mv.cuenta_tesoreria_id] ?? 0) + (mv.sentido === "entrada" ? 1 : -1) * Number(mv.monto || 0);
    return m;
  }, [cuentas, movs]);

  async function cobrar(f: any) {
    const monto = Number(prompt(`Cobro para ${f.serie ?? ""}-${f.numero ?? f.id}. Saldo ${fmtMoneda(f.saldo)}. Monto a cobrar:`, String(f.saldo)) || 0);
    if (!(monto > 0)) return;
    const res = await registrarCobroFactura(supabase, { factura_id: f.id, monto, cliente_id: f.cliente_id });
    setMsg(res.ok ? "✅ Cobro registrado." : `⚠️ ${res.error}`); await cargar();
  }
  async function pagar(d: any) {
    const pagado = aplicCompra[d.id] ?? 0; const sal = calcSaldo(Number(d.total ?? 0), pagado);
    const monto = Number(prompt(`Pago para ${d.razon_social ?? d.id}. Saldo ${fmtMoneda(sal)}. Monto a pagar:`, String(sal)) || 0);
    if (!(monto > 0)) return;
    const res = await registrarPagoCompra(supabase, { documento_compra_id: d.id, monto, proveedor_id: d.proveedor_id });
    setMsg(res.ok ? "✅ Pago registrado." : `⚠️ ${res.error}`); await cargar();
  }

  const Card = ({ t, v, c }: { t: string; v: string; c?: string }) => (
    <div className="bg-white rounded-2xl border shadow-sm p-4">
      <p className="text-xs text-gray-400 font-semibold uppercase">{t}</p>
      <p className={`text-2xl font-black ${c ?? "text-[#0b315f]"}`}>{v}</p>
    </div>
  );

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-black text-[#0b315f]">Finanzas</h1>
        <p className="text-sm text-gray-500">Administra el dinero de la empresa: cuentas por cobrar, egresos y tesorería.</p>
      </div>
      <div className="flex gap-2 mb-4">
        {(["ingresos", "egresos", "tesoreria"] as const).map((t) => (
          <button key={t} onClick={() => setTab(t)} className={`px-4 py-2 rounded-xl text-sm font-bold capitalize transition ${tab === t ? "bg-[#0b315f] text-white shadow" : "bg-white text-gray-600 hover:bg-gray-50 border"}`}>{t}</button>
        ))}
        <button onClick={cargar} className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold bg-white border hover:bg-gray-50">↻</button>
      </div>
      {msg && <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

      {cargando ? <div className="py-16 text-center text-gray-400">Cargando…</div> : (
        <>
          {tab === "ingresos" && (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card t="Facturado" v={fmtMoneda(cxc.totalFacturado)} />
                <Card t="Por cobrar" v={fmtMoneda(cxc.porCobrar)} c="text-amber-600" />
                <Card t="Vencido (+30d)" v={fmtMoneda(cxc.porBucket["31-60"] + cxc.porBucket["61-90"] + cxc.porBucket["+90"])} c="text-red-600" />
                <Card t="Comprobantes" v={String(cxc.filas.length)} />
              </div>
              <div className="bg-white rounded-2xl border shadow-sm p-4">
                <p className="text-xs font-black uppercase text-gray-400 mb-2">Antigüedad de cuentas por cobrar</p>
                <div className="grid grid-cols-5 gap-2">
                  {BUCKETS.map((b) => (
                    <div key={b} className="text-center p-2 rounded-xl bg-gray-50">
                      <p className="text-[11px] text-gray-400">{b === "vigente" ? "Vigente" : b + " d"}</p>
                      <p className="font-bold text-sm text-gray-700">{fmtMoneda(cxc.porBucket[b])}</p>
                    </div>
                  ))}
                </div>
              </div>
              <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-400 text-xs uppercase"><tr>
                    <th className="text-left px-4 py-2">Comprobante</th><th className="text-right px-4 py-2">Total</th>
                    <th className="text-right px-4 py-2">Pagado</th><th className="text-right px-4 py-2">Saldo</th>
                    <th className="text-left px-4 py-2">Vence</th><th className="px-4 py-2"></th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {cxc.filas.filter((f) => f.saldo > 0).slice(0, 100).map((f) => (
                      <tr key={f.id} className="hover:bg-gray-50">
                        <td className="px-4 py-2 font-mono text-xs">{f.serie ?? ""}-{f.numero ?? f.id}</td>
                        <td className="px-4 py-2 text-right">{fmtMoneda(Number(f.total ?? 0))}</td>
                        <td className="px-4 py-2 text-right text-emerald-600">{fmtMoneda(f.pagado)}</td>
                        <td className="px-4 py-2 text-right font-bold">{fmtMoneda(f.saldo)}</td>
                        <td className="px-4 py-2 text-xs text-gray-500">{f.fecha_vencimiento ?? "—"}{f.dias != null && f.dias > 0 && <span className="text-red-500"> (+{f.dias}d)</span>}</td>
                        <td className="px-4 py-2 text-right"><button onClick={() => cobrar(f)} className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700">Registrar cobro</button></td>
                      </tr>
                    ))}
                    {cxc.filas.filter((f) => f.saldo > 0).length === 0 && <tr><td colSpan={6} className="p-8 text-center text-gray-400">Sin saldos por cobrar. 🎉</td></tr>}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {tab === "egresos" && (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <Card t="Egreso total" v={fmtMoneda(egresosResumen.total)} c="text-red-600" />
                {Object.entries(egresosResumen.porFuente).map(([k, v]) => <Card key={k} t={k} v={fmtMoneda(v)} />)}
              </div>
              <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-400 text-xs uppercase"><tr>
                    <th className="text-left px-4 py-2">Fuente</th><th className="text-left px-4 py-2">Fecha</th>
                    <th className="text-left px-4 py-2">Concepto</th><th className="text-right px-4 py-2">Monto</th><th className="text-left px-4 py-2">Estado</th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {egresos.slice(0, 150).map((e, i) => (
                      <tr key={i} className="hover:bg-gray-50">
                        <td className="px-4 py-2"><span className="px-2 py-0.5 rounded-full text-xs bg-gray-100 text-gray-600">{e.fuente}</span></td>
                        <td className="px-4 py-2 text-xs text-gray-500">{e.fecha ?? "—"}</td>
                        <td className="px-4 py-2 text-gray-700">{e.concepto ?? "—"}</td>
                        <td className="px-4 py-2 text-right font-semibold">{fmtMoneda(Number(e.monto || 0))}</td>
                        <td className="px-4 py-2 text-xs">{e.estado ?? "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-xs text-gray-400">Vista única <code>v_egresos</code> (gastos + combustible + mantenimiento). Es plano de GESTIÓN; el plano fiscal (IGV, Registro de Compras) se ve en Contabilidad para no contar dos veces el mismo monto.</p>
            </div>
          )}

          {tab === "tesoreria" && (
            <div className="grid gap-4">
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                {cuentas.length === 0 && <div className="col-span-full bg-amber-50 border border-amber-200 rounded-2xl p-4 text-sm text-amber-800">Aún no hay cuentas de tesorería. Créalas insertando en <code>cuentas_tesoreria</code> (banco/caja).</div>}
                {cuentas.map((c) => (
                  <div key={c.id} className="bg-white rounded-2xl border shadow-sm p-4">
                    <p className="text-xs text-gray-400 font-semibold">{c.tipo} · {c.moneda}</p>
                    <p className="font-bold text-[#0b315f]">{c.nombre}</p>
                    <p className="text-2xl font-black text-gray-800">{fmtMoneda(saldosCuenta[c.id] ?? 0, c.moneda)}</p>
                  </div>
                ))}
              </div>
              <div className="bg-white rounded-2xl border shadow-sm p-4">
                <p className="text-xs font-black uppercase text-gray-400 mb-2">Cuentas por pagar (proveedores)</p>
                <table className="w-full text-sm">
                  <thead className="text-gray-400 text-xs uppercase"><tr>
                    <th className="text-left py-1">Proveedor</th><th className="text-right py-1">Total</th><th className="text-right py-1">Saldo</th><th></th>
                  </tr></thead>
                  <tbody className="divide-y">
                    {docsCompra.map((d) => {
                      const sal = calcSaldo(Number(d.total ?? 0), aplicCompra[d.id] ?? 0);
                      if (sal <= 0) return null;
                      return (
                        <tr key={d.id}>
                          <td className="py-1.5">{d.razon_social ?? `Proveedor ${d.proveedor_id ?? ""}`}</td>
                          <td className="py-1.5 text-right">{fmtMoneda(Number(d.total ?? 0))}</td>
                          <td className="py-1.5 text-right font-bold">{fmtMoneda(sal)}</td>
                          <td className="py-1.5 text-right"><button onClick={() => pagar(d)} className="px-2 py-0.5 rounded text-xs font-bold bg-[#2a5298] text-white">Pagar</button></td>
                        </tr>
                      );
                    })}
                    {docsCompra.every((d) => calcSaldo(Number(d.total ?? 0), aplicCompra[d.id] ?? 0) <= 0) && <tr><td colSpan={4} className="py-6 text-center text-gray-400">Sin cuentas por pagar. 🎉</td></tr>}
                  </tbody>
                </table>
              </div>
              <div className="bg-white rounded-2xl border shadow-sm overflow-x-auto">
                <p className="text-xs font-black uppercase text-gray-400 px-4 pt-3">Movimientos recientes</p>
                <table className="w-full text-sm"><tbody className="divide-y">
                  {movs.slice(0, 50).map((m) => (
                    <tr key={m.id}><td className="px-4 py-1.5 text-xs text-gray-500">{m.fecha}</td>
                      <td className="px-4 py-1.5">{m.concepto ?? "—"}</td>
                      <td className={`px-4 py-1.5 text-right font-semibold ${m.sentido === "entrada" ? "text-emerald-600" : "text-red-600"}`}>{m.sentido === "entrada" ? "+" : "−"}{fmtMoneda(Number(m.monto || 0), m.moneda)}</td></tr>
                  ))}
                  {movs.length === 0 && <tr><td className="p-6 text-center text-gray-400">Sin movimientos.</td></tr>}
                </tbody></table>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}
