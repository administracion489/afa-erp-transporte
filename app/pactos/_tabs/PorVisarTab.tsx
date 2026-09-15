"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Pactos · Por visar — LA COLA DE GERENCIA.
//
// Solo llegan aquí los cambios que EMPEORAN el margen más allá de la tolerancia. El
// resto —la primera carga de un costo, un cambio que mejora, uno dentro del margen—
// se auto-aprueba y no molesta a nadie. Es deliberado: una cola que recibe todo se
// convierte en un sello de goma en la primera semana.
//
// El servicio YA SE PRESTÓ y el acta YA está escrita: visar no cambia la operación,
// autoriza la plata. Por eso rechazar no "deshace" nada — marca que ese sobrecosto no
// estaba autorizado, y en la fase 4 eso frena el abono al proveedor, no el bus.
//
// El visado va por RPC (fn_pacto_visar) y no por un update directo: el acta es la
// evidencia y tiene que ser append-only. Nadie escribe sobre ella desde el navegador.
// ──────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";

type Pacto = {
  id: number;
  codigo: string | null;
  reserva_id: number;
  os: string | null;
  fecha_servicio: string | null;
  ruta_nombre: string | null;
  lado: string;
  monto_antes: number | null;
  monto_despues: number | null;
  delta: number | null;
  margen_pct_antes: number | null;
  margen_pct_despues: number | null;
  severidad: string | null;
  veredicto: string | null;
  motivo: string | null;
  motivo_nota: string | null;
  proveedor_antes: string | null;
  proveedor_despues: string | null;
  fecha_limite: string | null;
  vencido: boolean;
  horas_abierto: number | null;
};

export default function PorVisarTab({ onCambio }: { onCambio: () => void }) {
  const [pactos, setPactos] = useState<Pacto[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorSql, setErrorSql] = useState("");
  const [puedeVisar, setPuedeVisar] = useState(false);
  const [sel, setSel] = useState<Set<number>>(new Set());
  const [trabajando, setTrabajando] = useState(false);
  const [msg, setMsg] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true); setErrorSql("");

    const { data: sesion } = await supabase.auth.getSession();
    const uid = sesion?.session?.user?.id;
    if (uid) {
      // Visar gasto es decisión de gerencia, no de operaciones. Mismo criterio que
      // Tesorería (LotesTab, PlanillaTab, CuentasPorPagarTab).
      const { data } = await supabase.from("usuarios").select("rol").eq("id", uid).maybeSingle();
      setPuedeVisar(data?.rol === "admin" || data?.rol === "gerente");
    }

    const { data, error } = await supabase
      .from("v_pactos_por_visar")
      .select("*")
      .order("creado_at", { ascending: true })
      .limit(500);

    if (error) {
      setErrorSql("Falta correr supabase/pacto-03-triggers.sql en Supabase: sin esa vista no hay cola de visado.");
      setPactos([]); setCargando(false); return;
    }
    setPactos((data as Pacto[]) ?? []);
    setSel(new Set());
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const vencidos = useMemo(() => pactos.filter((p) => p.vencido).length, [pactos]);
  const impacto = useMemo(
    () => pactos.reduce((a, p) => a + Number(p.delta ?? 0), 0), [pactos]);

  async function visar(ids: number[], aprobar: boolean) {
    if (!ids.length) return;
    let motivo: string | null = null;
    if (!aprobar) {
      motivo = prompt("¿Por qué se rechaza? Queda en el acta y lo lee quien hizo el cambio.");
      if (!motivo?.trim()) return;   // rechazar sin motivo no aporta nada
    }
    setTrabajando(true); setMsg("");
    const errores: string[] = [];
    for (const id of ids) {
      const { data, error } = await supabase.rpc("fn_pacto_visar", {
        p_pacto_id: id, p_aprobar: aprobar, p_motivo: motivo,
      });
      const fila = Array.isArray(data) ? data[0] : data;
      if (error) errores.push(`#${id}: ${error.message}`);
      else if (fila && fila.ok === false) errores.push(`#${id}: ${fila.mensaje}`);
    }
    setTrabajando(false);
    if (errores.length) setMsg(`${errores.length} no se pudieron procesar: ${errores[0]}`);
    await cargar();
    onCambio();
  }

  const toggle = (id: number) =>
    setSel((s) => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n; });

  if (cargando) return <div className="py-16 text-center text-gray-400 text-sm">Cargando la cola…</div>;

  if (errorSql)
    return <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-sm text-amber-800">{errorSql}</div>;

  if (!pactos.length)
    return (
      <div className="bg-white rounded-2xl border p-10 text-center">
        <p className="text-gray-500 text-sm">No hay cambios esperando visto bueno. 🎉</p>
        <p className="text-gray-400 text-xs mt-1">
          Solo llegan aquí los que empeoran el margen más allá de la tolerancia.
        </p>
      </div>
    );

  return (
    <div className="space-y-3">
      {!puedeVisar && (
        <div className="rounded-xl px-4 py-3 text-xs bg-sky-50 border border-sky-200 text-sky-800">
          Estás viendo la cola en modo lectura: aprobar o rechazar es de administración o gerencia.
        </div>
      )}
      {msg && <div className="rounded-xl px-4 py-3 text-xs bg-red-50 border border-red-200 text-red-700">{msg}</div>}

      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-gray-600"><b>{pactos.length}</b> por visar</span>
        {vencidos > 0 && (
          <span className="text-[11px] px-2 py-1 rounded-lg bg-red-50 text-red-700 border border-red-200">
            {vencidos} con el plazo vencido
          </span>
        )}
        <span className="text-gray-500">
          Impacto acumulado <b className="tabular-nums" style={{ color: impacto > 0 ? "#b91c1c" : "#166534" }}>
            {fmtMoneda(impacto)}
          </b>
        </span>
        {puedeVisar && (
          <div className="ml-auto flex gap-2">
            <button disabled={trabajando || !sel.size} onClick={() => visar([...sel], false)}
              className="px-3 py-2 rounded-xl text-sm font-bold border text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-40">
              Rechazar {sel.size || ""}
            </button>
            <button disabled={trabajando || !sel.size} onClick={() => visar([...sel], true)}
              className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
              {trabajando ? "Procesando…" : `Aprobar ${sel.size || ""}`}
            </button>
          </div>
        )}
      </div>

      {pactos.map((p) => {
        const critico = p.severidad === "critico";
        return (
          <div key={p.id} className={`bg-white rounded-2xl border shadow-sm overflow-hidden ${p.vencido ? "border-red-300" : ""}`}>
            <div className="flex flex-wrap items-start gap-3 p-4">
              {puedeVisar && (
                <input type="checkbox" className="mt-1 w-4 h-4 accent-violet-600"
                  checked={sel.has(p.id)} onChange={() => toggle(p.id)} />
              )}

              <div className="flex-1 min-w-[260px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-xs text-gray-500">{p.codigo}</span>
                  <span className="font-mono text-xs font-bold text-gray-800">{p.os}</span>
                  <span className="text-xs text-gray-400">{p.fecha_servicio}</span>
                  <span className="text-xs text-gray-400">{p.ruta_nombre}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase"
                    style={critico
                      ? { background: "#fee2e2", color: "#b91c1c" }
                      : { background: "#ffedd5", color: "#c2410c" }}>
                    {critico ? "Margen negativo" : "Deterioro"}
                  </span>
                  {p.vencido && (
                    <span className="text-[10px] font-bold px-2 py-0.5 rounded-md bg-red-600 text-white uppercase">
                      Vencido
                    </span>
                  )}
                </div>

                {(p.proveedor_antes || p.proveedor_despues) && (
                  <p className="text-xs text-gray-600 mt-1.5">
                    {p.proveedor_antes ?? "—"} <span className="text-gray-300">→</span>{" "}
                    <b className="text-gray-800">{p.proveedor_despues ?? "—"}</b>
                  </p>
                )}

                <p className="text-xs text-gray-700 mt-1.5">{p.veredicto}</p>
                {p.motivo && (
                  <p className="text-[11px] text-gray-500 mt-1">
                    Motivo: <b>{p.motivo}</b>{p.motivo_nota ? ` · ${p.motivo_nota}` : ""}
                  </p>
                )}
                <p className="text-[11px] text-gray-400 mt-1">
                  Abierto hace {Math.round(Number(p.horas_abierto ?? 0))} h
                  {p.fecha_limite && ` · vence ${new Date(p.fecha_limite).toLocaleString("es-PE", { day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`}
                </p>
              </div>

              <div className="text-right shrink-0 tabular-nums">
                <p className="text-[10px] uppercase text-gray-400">Costo</p>
                <p className="text-sm text-gray-500">{fmtMoneda(Number(p.monto_antes ?? 0))}</p>
                <p className="text-base font-black text-gray-800">{fmtMoneda(Number(p.monto_despues ?? 0))}</p>
                <p className="text-xs font-bold" style={{ color: Number(p.delta ?? 0) > 0 ? "#b91c1c" : "#166534" }}>
                  {Number(p.delta ?? 0) > 0 ? "+" : ""}{fmtMoneda(Number(p.delta ?? 0))}
                </p>
                <p className="text-[11px] text-gray-400 mt-1">
                  margen {Number(p.margen_pct_antes ?? 0).toFixed(1)}% → {Number(p.margen_pct_despues ?? 0).toFixed(1)}%
                </p>
              </div>

              {puedeVisar && (
                <div className="flex flex-col gap-1.5 shrink-0">
                  <button disabled={trabajando} onClick={() => visar([p.id], true)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
                    Aprobar
                  </button>
                  <button disabled={trabajando} onClick={() => visar([p.id], false)}
                    className="px-3 py-1.5 rounded-lg text-xs font-bold border text-red-600 border-red-200 hover:bg-red-50 disabled:opacity-40">
                    Rechazar
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
