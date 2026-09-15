"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Pactos · Cierre — las diferencias que aparecieron DESPUÉS de liquidar.
//
// Un servicio puede cambiar de precio o de costo cuando su periodo ya se facturó. Pasa
// todo el tiempo: la factura del tercero llega tarde y no coincide con lo pactado, o
// el cliente reclama el diferencial de un cambio de unidad tres semanas después.
//
// LA REGLA: un mes cerrado no se reescribe. Cambiar hacia atrás un importe ya
// facturado desalinea el ERP de lo que SUNAT ya recibió. Las salidas legítimas son
// tres, y las tres quedan con autor:
//
//   · Nota de crédito o débito sobre el comprobante original.
//   · Línea de ajuste en la liquidación del periodo siguiente.
//   · Asumido — la empresa se come la diferencia. No es un fracaso: es una decisión
//     comercial, y queda registrada como tal en vez de perderse.
//
// Requiere supabase/pacto-05-cierre.sql.
// ──────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";

type Fila = {
  id: number;
  codigo: string | null;
  os: string | null;
  fecha_servicio: string | null;
  ruta_nombre: string | null;
  lado: string;
  monto_antes: number | null;
  monto_despues: number | null;
  delta: number | null;
  motivo: string | null;
  motivo_nota: string | null;
  liquidacion_congelada_id: number | null;
  proveedor_despues: string | null;
  que_significa: string;
  tipo_nota: string;
};

const VIAS = [
  { key: "nota", label: "Nota de crédito/débito", ayuda: "Se emite sobre el comprobante original." },
  { key: "periodo_siguiente", label: "Ajuste del periodo siguiente", ayuda: "Entra como línea en el próximo cierre." },
  { key: "asumido", label: "Lo asume AFA", ayuda: "Decisión comercial. Hay que explicar por qué." },
];

export default function CierreTab({ onCambio }: { onCambio: () => void }) {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorSql, setErrorSql] = useState("");
  const [puedeResolver, setPuedeResolver] = useState(false);
  const [trabajando, setTrabajando] = useState<number | null>(null);
  const [msg, setMsg] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true); setErrorSql("");

    const { data: sesion } = await supabase.auth.getSession();
    const uid = sesion?.session?.user?.id;
    if (uid) {
      const { data } = await supabase.from("usuarios").select("rol").eq("id", uid).maybeSingle();
      setPuedeResolver(data?.rol === "admin" || data?.rol === "gerente");
    }

    const { data, error } = await supabase
      .from("v_regularizaciones_pendientes")
      .select("*")
      .order("creado_at", { ascending: true })
      .limit(500);
    if (error) {
      setErrorSql("Falta correr supabase/pacto-05-cierre.sql: sin esa vista no hay bandeja de regularización.");
      setCargando(false); return;
    }
    setFilas((data as Fila[]) ?? []);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const totales = useMemo(() => {
    const venta = filas.filter((f) => f.lado === "venta").reduce((a, f) => a + Number(f.delta ?? 0), 0);
    const compra = filas.filter((f) => f.lado === "compra").reduce((a, f) => a + Number(f.delta ?? 0), 0);
    return { venta, compra, neto: venta - compra };
  }, [filas]);

  async function resolver(f: Fila, via: string) {
    let nota: string | null = null;
    if (via === "asumido") {
      nota = prompt("¿Por qué AFA asume esta diferencia? Queda registrado con tu nombre.");
      if (!nota?.trim()) return;
    } else {
      nota = prompt("Nota para el acta (opcional): ¿en qué comprobante o periodo se resuelve?") || null;
    }
    setTrabajando(f.id); setMsg("");
    const { data, error } = await supabase.rpc("fn_pacto_regularizar", {
      p_pacto_id: f.id, p_via: via, p_nota: nota,
    });
    const r = Array.isArray(data) ? data[0] : data;
    setTrabajando(null);
    if (error) setMsg(error.message);
    else if (r && r.ok === false) setMsg(r.mensaje);
    else { await cargar(); onCambio(); }
  }

  if (cargando) return <div className="py-16 text-center text-gray-400 text-sm">Cargando…</div>;
  if (errorSql)
    return <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-sm text-amber-800">{errorSql}</div>;

  if (!filas.length)
    return (
      <div className="bg-white rounded-2xl border p-10 text-center">
        <p className="text-gray-500 text-sm">No hay diferencias de periodos ya cerrados. 🎉</p>
        <p className="text-gray-400 text-xs mt-1">
          Aquí aparecen los cambios de importe que ocurren después de haber liquidado o facturado.
        </p>
      </div>
    );

  return (
    <div className="space-y-3">
      {!puedeResolver && (
        <div className="rounded-xl px-4 py-3 text-xs bg-sky-50 border border-sky-200 text-sky-800">
          Modo lectura: resolver una diferencia de un periodo cerrado es de administración o gerencia.
        </div>
      )}
      {msg && <div className="rounded-xl px-4 py-3 text-xs bg-red-50 border border-red-200 text-red-700">{msg}</div>}

      <div className="flex flex-wrap items-center gap-4 text-sm bg-white rounded-2xl border px-4 py-3">
        <span className="text-gray-600"><b>{filas.length}</b> diferencia(s) por regularizar</span>
        <span className="text-gray-500">
          Lado cliente <b className="tabular-nums">{fmtMoneda(totales.venta)}</b>
        </span>
        <span className="text-gray-500">
          Lado proveedor <b className="tabular-nums">{fmtMoneda(totales.compra)}</b>
        </span>
        <span className="text-gray-500 ml-auto">
          Efecto neto en margen{" "}
          <b className="tabular-nums" style={{ color: totales.neto < 0 ? "#b91c1c" : "#166534" }}>
            {fmtMoneda(totales.neto)}
          </b>
        </span>
      </div>

      {filas.map((f) => (
        <div key={f.id} className="bg-white rounded-2xl border shadow-sm p-4">
          <div className="flex flex-wrap items-start gap-3">
            <div className="flex-1 min-w-[260px]">
              <div className="flex flex-wrap items-center gap-2">
                <span className="font-mono text-[11px] text-gray-400">{f.codigo}</span>
                <span className="font-mono text-xs font-bold text-gray-800">{f.os}</span>
                <span className="text-[11px] text-gray-400">{f.fecha_servicio}</span>
                <span className="text-[11px] text-gray-400">{f.ruta_nombre}</span>
                <span className="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase"
                  style={f.lado === "venta"
                    ? { background: "#dbeafe", color: "#1d4ed8" }
                    : { background: "#ede9fe", color: "#6d28d9" }}>
                  {f.lado === "venta" ? "Cliente" : "Proveedor"}
                </span>
              </div>
              <p className="text-sm text-gray-800 font-bold mt-1.5">{f.que_significa}</p>
              {f.proveedor_despues && f.lado === "compra" && (
                <p className="text-xs text-gray-500">{f.proveedor_despues}</p>
              )}
              {f.motivo && (
                <p className="text-[11px] text-gray-400 mt-1">
                  {f.motivo}{f.motivo_nota ? ` · ${f.motivo_nota}` : ""}
                </p>
              )}
              {f.liquidacion_congelada_id && (
                <p className="text-[11px] text-gray-400 mt-0.5">
                  Liquidación ya emitida #{f.liquidacion_congelada_id} — no se toca.
                </p>
              )}
            </div>

            <div className="text-right shrink-0 tabular-nums">
              <p className="text-xs text-gray-400">{fmtMoneda(Number(f.monto_antes ?? 0))}</p>
              <p className="text-sm font-black text-gray-800">{fmtMoneda(Number(f.monto_despues ?? 0))}</p>
              <p className="text-xs font-bold" style={{ color: Number(f.delta ?? 0) > 0 ? "#b91c1c" : "#166534" }}>
                {Number(f.delta ?? 0) > 0 ? "+" : ""}{fmtMoneda(Number(f.delta ?? 0))}
              </p>
              <p className="text-[10px] text-gray-400 uppercase mt-0.5">nota de {f.tipo_nota}</p>
            </div>
          </div>

          {puedeResolver && (
            <div className="mt-3 pt-3 border-t flex flex-wrap gap-2">
              {VIAS.map((v) => (
                <button key={v.key} disabled={trabajando === f.id}
                  onClick={() => resolver(f, v.key)} title={v.ayuda}
                  className={`px-3 py-1.5 rounded-lg text-xs font-bold border disabled:opacity-40 ${
                    v.key === "asumido"
                      ? "text-gray-600 border-gray-200 hover:bg-gray-50"
                      : "text-violet-700 bg-violet-50 border-violet-200 hover:bg-violet-100"}`}>
                  {trabajando === f.id ? "…" : v.label}
                </button>
              ))}
            </div>
          )}
        </div>
      ))}
    </div>
  );
}
