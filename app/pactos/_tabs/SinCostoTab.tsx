"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Pactos · Sin costo pactado — LA BANDEJA.
//
// Es el pasivo del módulo: todo servicio tercerizado que nadie pactó. Se lee de
// v_servicios_sin_costo, que DERIVA de `reservas` y no del acta — así ve TODOS los
// rotos, los haya tocado alguien o no. Un tablero que solo mira lo ya registrado es
// ciego justo para el caso que originó el problema.
//
// Dos cosas que hacen la diferencia entre una bandeja que se usa y una que se ignora:
//
//   · Distingue LÍNEAS ROJAS de DECISIONES REALES. Un par ida+retorno sin costo pinta
//     dos filas pero es UN importe a decidir: al pactar la ida, el retorno pasa solo a
//     "incluido". Contar las dos es lo que hace que 30 problemas parezcan 67.
//   · Ordena por urgencia: lo ya EJECUTADO sin costo va primero. Ahí el proveedor ya
//     trabajó y está esperando su plata sin que el ERP sepa cuánto.
// ──────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import ModalCostos, { type ReservaSinCosto } from "@/components/pactos/ModalCostos";

type Fila = {
  reserva_id: number;
  os: string | null;
  fecha_servicio: string | null;
  hora_servicio: string | null;
  direccion_servicio: string | null;
  ruta_nombre: string | null;
  empresa_tercerizada_id: number | null;
  proveedor: string | null;
  placa: string | null;
  dias_al_servicio: number | null;
  urgencia: string;
  cubierto_por_par: boolean;
  propuestas_de_importe: number;
};

const URGENCIA_CFG: Record<string, { label: string; bg: string; color: string; orden: number }> = {
  ejecutado_sin_costo: { label: "Ya ejecutado", bg: "#fee2e2", color: "#b91c1c", orden: 0 },
  hoy:                 { label: "Hoy",          bg: "#ffedd5", color: "#c2410c", orden: 1 },
  futuro:              { label: "Próximo",      bg: "#e0f2fe", color: "#0369a1", orden: 2 },
};

export default function SinCostoTab({ onCambio }: { onCambio: () => void }) {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [terceros, setTerceros] = useState<Record<number, any>>({});
  const [cargando, setCargando] = useState(true);
  const [errorSql, setErrorSql] = useState("");
  const [modal, setModal] = useState<ReservaSinCosto[] | null>(null);
  const [abierto, setAbierto] = useState<Set<string>>(new Set());

  const cargar = useCallback(async () => {
    setCargando(true); setErrorSql("");
    const { data, error } = await supabase
      .from("v_servicios_sin_costo")
      .select("*")
      .order("fecha_servicio", { ascending: true })
      .limit(2000);

    if (error) {
      setErrorSql("Falta correr supabase/pacto-01-costeo.sql en Supabase: sin esa vista no hay bandeja.");
      setFilas([]); setCargando(false); return;
    }
    setFilas((data as Fila[]) ?? []);

    // Los campos tributarios van en consulta aparte y tolerante: sin pacto-00 corrido
    // las columnas no existen y PostgREST rechazaría el select entero.
    const base = await supabase.from("empresas_tercerizadas").select("id,razon_social");
    const map: Record<number, any> = {};
    for (const t of ((base.data as any[]) ?? [])) map[t.id] = t;
    const trib = await supabase.from("empresas_tercerizadas").select("id,afectacion_defecto,emite_factura");
    if (!trib.error)
      for (const t of ((trib.data as any[]) ?? []))
        if (map[t.id]) Object.assign(map[t.id], t);
    setTerceros(map);
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  // Solo las decisiones reales: el retorno cubierto por su ida no es un problema.
  const pendientes = useMemo(() => filas.filter((f) => !f.cubierto_por_par), [filas]);

  const grupos = useMemo(() => {
    const m = new Map<string, { clave: string; proveedor: string; ruta: string; urgencia: string; filas: Fila[] }>();
    for (const f of pendientes) {
      const clave = `${f.empresa_tercerizada_id ?? "x"}|${f.ruta_nombre ?? "sin-ruta"}|${f.urgencia}`;
      const g = m.get(clave) ?? {
        clave,
        proveedor: f.proveedor ?? "Sin empresa tercerizada",
        ruta: f.ruta_nombre ?? "Sin ruta",
        urgencia: f.urgencia,
        filas: [] as Fila[],
      };
      g.filas.push(f);
      m.set(clave, g);
    }
    return [...m.values()].sort((a, b) =>
      (URGENCIA_CFG[a.urgencia]?.orden ?? 9) - (URGENCIA_CFG[b.urgencia]?.orden ?? 9)
      || b.filas.length - a.filas.length);
  }, [pendientes]);

  const conPropuesta = useMemo(
    () => pendientes.filter((f) => f.propuestas_de_importe > 0).length, [pendientes]);

  const abrir = (fs: Fila[]) =>
    setModal(fs.map((f) => ({
      id: f.reserva_id, codigo: f.os, fecha_servicio: f.fecha_servicio,
      hora_servicio: f.hora_servicio, direccion_servicio: f.direccion_servicio,
      ruta_nombre: f.ruta_nombre, empresa_tercerizada_id: f.empresa_tercerizada_id,
    })));

  if (cargando) return <div className="py-16 text-center text-gray-400 text-sm">Cargando la bandeja…</div>;

  if (errorSql)
    return (
      <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-sm text-amber-800">
        {errorSql}
      </div>
    );

  if (!pendientes.length)
    return (
      <div className="bg-white rounded-2xl border p-10 text-center">
        <p className="text-gray-500 text-sm">No hay servicios tercerizados sin costo pactado. 🎉</p>
        <p className="text-gray-400 text-xs mt-1">
          {filas.length > 0 && `${filas.length} tramo(s) figuran en cero, pero su tarifa va en el servicio hermano.`}
        </p>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        <span className="text-gray-600">
          <b>{pendientes.length}</b> decisión(es) real(es)
          {filas.length !== pendientes.length && (
            <span className="text-gray-400"> · {filas.length} línea(s) en cero, {filas.length - pendientes.length} son retornos incluidos</span>
          )}
        </span>
        {conPropuesta > 0 && (
          <span className="text-[11px] px-2 py-1 rounded-lg bg-emerald-50 text-emerald-700 border border-emerald-200">
            {conPropuesta} con importe ya facturado por proponer
          </span>
        )}
        <button onClick={() => abrir(pendientes)}
          className="ml-auto px-4 py-2 rounded-xl text-sm font-bold text-white bg-violet-600 hover:bg-violet-700">
          Pactar todo ({pendientes.length})
        </button>
      </div>

      {grupos.map((g) => {
        const cfg = URGENCIA_CFG[g.urgencia] ?? URGENCIA_CFG.futuro;
        const open = abierto.has(g.clave);
        return (
          <div key={g.clave} className="bg-white rounded-2xl border shadow-sm overflow-hidden">
            <div className="flex flex-wrap items-center gap-3 px-4 py-3 border-b bg-gray-50">
              <button onClick={() => setAbierto((s) => {
                const n = new Set(s); n.has(g.clave) ? n.delete(g.clave) : n.add(g.clave); return n;
              })} className="text-gray-400 hover:text-gray-600 w-5">{open ? "▾" : "▸"}</button>

              <span className="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase tracking-wide"
                style={{ background: cfg.bg, color: cfg.color }}>{cfg.label}</span>

              <span className="font-black text-gray-800 text-sm">{g.proveedor}</span>
              <span className="text-gray-300">·</span>
              <span className="text-sm text-gray-600">{g.ruta}</span>
              <span className="text-[11px] text-gray-500 bg-white border rounded-full px-2 py-0.5">
                {g.filas.length} servicio(s)
              </span>

              <button onClick={() => abrir(g.filas)}
                className="ml-auto px-3 py-1.5 rounded-lg text-xs font-bold text-violet-700 bg-violet-50 border border-violet-200 hover:bg-violet-100">
                Pactar {g.filas.length}
              </button>
            </div>

            {open && (
              <div className="divide-y max-h-72 overflow-y-auto">
                {g.filas.map((f) => (
                  <div key={f.reserva_id} className="flex items-center gap-3 px-4 py-2 text-xs">
                    <span className="font-mono text-gray-700 w-40 shrink-0">{f.os ?? "#" + f.reserva_id}</span>
                    <span className="text-gray-400 w-24 shrink-0">{f.fecha_servicio}</span>
                    <span className="text-gray-400 w-16 shrink-0">
                      {f.direccion_servicio === "retorno" ? "retorno" : "ida"}
                    </span>
                    <span className="text-gray-400 flex-1 truncate">{f.placa ?? ""}</span>
                    {f.propuestas_de_importe > 0 && (
                      <span className="text-emerald-600 shrink-0">importe propuesto disponible</span>
                    )}
                  </div>
                ))}
              </div>
            )}
          </div>
        );
      })}

      {modal && (
        <ModalCostos reservas={modal} terceros={terceros}
          onCerrar={() => setModal(null)}
          onGuardado={() => { setModal(null); cargar(); onCambio(); }} />
      )}
    </div>
  );
}
