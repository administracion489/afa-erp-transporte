"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /liquidaciones — Proceso de cierre entre Operaciones y Finanzas.
//   Pestaña CLIENTE:   reservas finalizadas "por_liquidar" → liquidación → factura.
//   Pestaña PROVEEDOR: reservas tercerizadas "por_conciliar" → liquidación → CxP.
// Requiere haber corrido supabase/finanzas-00..03.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { idAfa } from "@/lib/folio";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import { ESTADOS_ADMIN, ESTADOS_PROVEEDOR } from "@/lib/estados";
import {
  crearLiquidacionCliente,
  crearLiquidacionProveedor,
  aprobarLiquidacionCliente,
  aprobarLiquidacionProveedor,
} from "@/lib/liquidaciones";

type Reserva = {
  id: number; codigo: string | null; fecha_servicio: string | null;
  cliente_id: number | null; precio_cliente: number | null;
  empresa_tercerizada_id: number | null; costo_proveedor: number | null;
  origen: string | null; destino: string | null; estado_admin: string | null; estado_proveedor: string | null;
};

// Paginación defensiva (tope 1000 de PostgREST — lección recurrente del proyecto).
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

export default function LiquidacionesPage() {
  const [tab, setTab] = useState<"cliente" | "proveedor">("cliente");
  const [cargando, setCargando] = useState(true);
  const [reservasCli, setReservasCli] = useState<Reserva[]>([]);
  const [reservasProv, setReservasProv] = useState<Reserva[]>([]);
  const [clientes, setClientes] = useState<Record<number, string>>({});
  const [terceros, setTerceros] = useState<Record<number, string>>({});
  const [liqCli, setLiqCli] = useState<any[]>([]);
  const [liqProv, setLiqProv] = useState<any[]>([]);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<string>("");
  const [trabajando, setTrabajando] = useState(false);

  async function cargar() {
    setCargando(true);
    try {
      const [rc, rp, cl, te, lc, lp] = await Promise.all([
        traerTodo(() => supabase.from("reservas")
          .select("id,codigo,fecha_servicio,cliente_id,precio_cliente,empresa_tercerizada_id,costo_proveedor,origen,destino,estado_admin,estado_proveedor")
          .eq("estado", "finalizada").eq("estado_admin", "por_liquidar").order("fecha_servicio", { ascending: true })),
        traerTodo(() => supabase.from("reservas")
          .select("id,codigo,fecha_servicio,cliente_id,precio_cliente,empresa_tercerizada_id,costo_proveedor,origen,destino,estado_admin,estado_proveedor")
          .eq("estado", "finalizada").eq("estado_proveedor", "por_conciliar").order("fecha_servicio", { ascending: true })),
        supabase.from("clientes").select("id,nombre,empresa"),
        supabase.from("empresas_tercerizadas").select("id,razon_social"),
        supabase.from("liquidacion_cliente").select("*").order("id", { ascending: false }).limit(50),
        supabase.from("liquidacion_proveedor").select("*").order("id", { ascending: false }).limit(50),
      ]);
      setReservasCli(rc as Reserva[]);
      setReservasProv(rp as Reserva[]);
      const cmap: Record<number, string> = {};
      for (const c of ((cl.data as any[]) ?? [])) cmap[c.id] = c.empresa || c.nombre || `Cliente ${c.id}`;
      setClientes(cmap);
      const tmap: Record<number, string> = {};
      for (const t of ((te.data as any[]) ?? [])) tmap[t.id] = t.razon_social || `Tercero ${t.id}`;
      setTerceros(tmap);
      setLiqCli((lc.data as any[]) ?? []);
      setLiqProv((lp.data as any[]) ?? []);
    } catch (e: any) {
      setMsg("No se pudo cargar. ¿Corriste supabase/finanzas-00..03? Detalle: " + (e?.message ?? e));
    } finally {
      setCargando(false);
    }
  }
  useEffect(() => { cargar(); }, []);

  const reservas = tab === "cliente" ? reservasCli : reservasProv;

  // Agrupar por contraparte (cliente / empresa tercerizada) para liquidar en lote.
  const grupos = useMemo(() => {
    const g: Record<string, { key: number | null; nombre: string; reservas: Reserva[]; total: number }> = {};
    for (const r of reservas) {
      const key = tab === "cliente" ? r.cliente_id : r.empresa_tercerizada_id;
      const nombre = tab === "cliente"
        ? (key != null ? clientes[key] ?? `Cliente ${key}` : "Sin cliente")
        : (key != null ? terceros[key] ?? `Tercero ${key}` : "Sin empresa");
      const monto = tab === "cliente" ? Number(r.precio_cliente ?? 0) : Number(r.costo_proveedor ?? 0);
      const k = String(key ?? "null");
      (g[k] ??= { key: key ?? null, nombre, reservas: [], total: 0 });
      g[k].reservas.push(r);
      g[k].total += monto;
    }
    return Object.values(g).sort((a, b) => b.total - a.total);
  }, [reservas, tab, clientes, terceros]);

  function toggle(id: number) {
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });
  }
  function toggleGrupo(rs: Reserva[]) {
    setSel((s) => {
      const n = new Set(s);
      const todos = rs.every((r) => n.has(r.id));
      for (const r of rs) todos ? n.delete(r.id) : n.add(r.id);
      return n;
    });
  }

  async function crear(grupo: { key: number | null; reservas: Reserva[] }) {
    const elegidas = grupo.reservas.filter((r) => sel.has(r.id));
    const rs = elegidas.length ? elegidas : grupo.reservas;
    setTrabajando(true); setMsg("");
    try {
      let res;
      if (tab === "cliente") {
        res = await crearLiquidacionCliente(supabase, {
          cliente_id: grupo.key,
          reservas: rs.map((r) => ({ id: r.id, precio_cliente: r.precio_cliente })),
        });
      } else {
        res = await crearLiquidacionProveedor(supabase, {
          empresa_tercerizada_id: grupo.key,
          reservas: rs.map((r) => ({ id: r.id, costo_proveedor: r.costo_proveedor })),
        });
      }
      setMsg(res.ok ? `✅ Liquidación creada (borrador) con ${rs.length} servicio(s).` : `⚠️ ${res.error}`);
      setSel(new Set());
      await cargar();
    } finally { setTrabajando(false); }
  }

  async function aprobar(id: number) {
    setTrabajando(true); setMsg("");
    try {
      const res = tab === "cliente"
        ? await aprobarLiquidacionCliente(supabase, id)
        : await aprobarLiquidacionProveedor(supabase, id);
      setMsg(res.ok
        ? (tab === "cliente" ? `✅ Aprobada y facturada (factura #${(res as any).factura_id}).` : `✅ Aprobada. Cuenta por pagar #${(res as any).documento_compra_id} generada.`)
        : `⚠️ ${res.error}`);
      await cargar();
    } finally { setTrabajando(false); }
  }

  const liqs = tab === "cliente" ? liqCli : liqProv;

  return (
    <div className="max-w-6xl mx-auto">
      <div className="mb-5">
        <h1 className="text-2xl font-black text-[#0b315f]">Liquidaciones</h1>
        <p className="text-sm text-gray-500">Cierre del servicio entre Operaciones y Finanzas. Confirma el importe definitivo antes de facturar (cliente) o pagar (proveedor).</p>
      </div>

      <div className="flex gap-2 mb-4">
        {(["cliente", "proveedor"] as const).map((t) => (
          <button key={t} onClick={() => { setTab(t); setSel(new Set()); setMsg(""); }}
            className={`px-4 py-2 rounded-xl text-sm font-bold transition ${tab === t ? "bg-[#0b315f] text-white shadow" : "bg-white text-gray-600 hover:bg-gray-50 border"}`}>
            {t === "cliente" ? "Al Cliente (facturar)" : "Al Proveedor (pagar)"}
          </button>
        ))}
        <button onClick={cargar} className="ml-auto px-3 py-2 rounded-xl text-sm font-semibold bg-white border hover:bg-gray-50">↻ Recargar</button>
      </div>

      {msg && <div className="mb-4 px-4 py-3 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

      {cargando ? (
        <div className="py-16 text-center text-gray-400">Cargando…</div>
      ) : (
        <div className="grid gap-6">
          {/* Servicios pendientes de liquidar, agrupados por contraparte */}
          <section>
            <h2 className="text-sm font-black uppercase tracking-wide text-gray-400 mb-2">
              {tab === "cliente" ? "Servicios por liquidar (cliente)" : "Servicios tercerizados por conciliar (proveedor)"}
            </h2>
            {grupos.length === 0 ? (
              <div className="bg-white rounded-2xl border p-8 text-center text-gray-400">
                No hay servicios {tab === "cliente" ? "por liquidar" : "por conciliar"}. 🎉
              </div>
            ) : grupos.map((g) => (
              <div key={String(g.key)} className="bg-white rounded-2xl border shadow-sm mb-3 overflow-hidden">
                <div className="flex items-center justify-between px-4 py-3 bg-gray-50 border-b">
                  <div className="flex items-center gap-3">
                    <input type="checkbox" checked={g.reservas.every((r) => sel.has(r.id))} onChange={() => toggleGrupo(g.reservas)} />
                    <span className="font-bold text-[#0b315f]">{g.nombre}</span>
                    <span className="text-xs text-gray-400">{g.reservas.length} servicio(s)</span>
                  </div>
                  <div className="flex items-center gap-3">
                    <span className="font-black text-gray-700">{fmtMoneda(g.total)}</span>
                    <button disabled={trabajando} onClick={() => crear(g)}
                      className="px-3 py-1.5 rounded-lg text-xs font-bold bg-[#2a5298] text-white hover:bg-[#1e3d73] disabled:opacity-50">
                      Crear liquidación
                    </button>
                  </div>
                </div>
                <div className="divide-y">
                  {g.reservas.map((r) => (
                    <label key={r.id} className="flex items-center gap-3 px-4 py-2 text-sm hover:bg-gray-50 cursor-pointer">
                      <input type="checkbox" checked={sel.has(r.id)} onChange={() => toggle(r.id)} />
                      <span className="font-mono text-xs text-gray-500 w-28">{idAfa(r)}</span>
                      <span className="text-gray-400 w-24">{r.fecha_servicio ?? "—"}</span>
                      <span className="flex-1 truncate text-gray-700">{[r.origen, r.destino].filter(Boolean).join(" → ") || "—"}</span>
                      <span className="font-semibold text-gray-700">{fmtMoneda(tab === "cliente" ? Number(r.precio_cliente ?? 0) : Number(r.costo_proveedor ?? 0))}</span>
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </section>

          {/* Liquidaciones ya creadas */}
          <section>
            <h2 className="text-sm font-black uppercase tracking-wide text-gray-400 mb-2">Liquidaciones {tab === "cliente" ? "al cliente" : "al proveedor"}</h2>
            <div className="bg-white rounded-2xl border shadow-sm overflow-hidden">
              {liqs.length === 0 ? (
                <div className="p-8 text-center text-gray-400 text-sm">Aún no hay liquidaciones.</div>
              ) : (
                <table className="w-full text-sm">
                  <thead className="bg-gray-50 text-gray-400 text-xs uppercase">
                    <tr>
                      <th className="text-left px-4 py-2">Código</th>
                      <th className="text-left px-4 py-2">{tab === "cliente" ? "Cliente" : "Empresa"}</th>
                      <th className="text-right px-4 py-2">Subtotal</th>
                      <th className="text-right px-4 py-2">IGV</th>
                      <th className="text-right px-4 py-2">Total</th>
                      <th className="text-left px-4 py-2">Estado</th>
                      <th className="px-4 py-2"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {liqs.map((l) => {
                      const nombre = tab === "cliente" ? (clientes[l.cliente_id] ?? "—") : (terceros[l.empresa_tercerizada_id] ?? "—");
                      const puedeAprobar = l.estado === "borrador" || l.estado === "aprobada";
                      return (
                        <tr key={l.id} className="hover:bg-gray-50">
                          <td className="px-4 py-2 font-mono text-xs">{l.codigo ?? `#${l.id}`}</td>
                          <td className="px-4 py-2">{nombre}</td>
                          <td className="px-4 py-2 text-right">{fmtMoneda(Number(l.subtotal ?? 0))}</td>
                          <td className="px-4 py-2 text-right">{fmtMoneda(Number(l.igv ?? 0))}</td>
                          <td className="px-4 py-2 text-right font-bold">{fmtMoneda(Number(l.total ?? 0))}</td>
                          <td className="px-4 py-2"><span className="px-2 py-0.5 rounded-full text-xs font-bold bg-gray-100 text-gray-600">{l.estado}</span></td>
                          <td className="px-4 py-2 text-right">
                            {puedeAprobar && (
                              <button disabled={trabajando} onClick={() => aprobar(l.id)}
                                className="px-3 py-1 rounded-lg text-xs font-bold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                                {tab === "cliente" ? "Aprobar y facturar" : "Aprobar → CxP"}
                              </button>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </section>

          {/* Leyenda de estados */}
          <div className="text-xs text-gray-400 flex flex-wrap gap-x-4 gap-y-1">
            <span className="font-bold">Ciclo {tab === "cliente" ? "cliente (B)" : "proveedor (C)"}:</span>
            {Object.values(tab === "cliente" ? ESTADOS_ADMIN : ESTADOS_PROVEEDOR).map((e: any) => (
              <span key={e.label} style={{ color: e.color }}>{e.label}</span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
