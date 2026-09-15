"use client";
// ──────────────────────────────────────────────────────────────────────────────
// Pactos · Conformidades — la firma del cliente sobre un cambio de precio.
//
// HOY ESTA PESTAÑA ES, NORMALMENTE, UN ARCHIVO. La emisión automática del enlace está
// APAGADA (`pacto_politica.exige_conformidad_cliente`, ver
// supabase/pacto-06-sin-conformidad-de-cambio.sql): AFA pide la firma UNA vez por
// periodo, en la liquidación del cierre, y no un enlace suelto por cada servicio que
// subió de precio. Lo que queda acá es lo que se firmó cuando sí se emitían.
//
// Se conserva la pestaña, y no se borró el flujo, porque una conformidad firmada es
// EVIDENCIA: sostiene el cobro de ese diferencial meses después, cuando la factura se
// discute y nadie recuerda quién pidió el bus grande.
//
// EL ESTADO VACÍO SE LEE DE LA POLÍTICA, no de una frase fija. Antes decía "se genera
// un enlace automáticamente cada vez que sube el precio", y con la bandera abajo eso
// era la pantalla mintiendo sobre lo que hace el sistema. Si algún día se vuelve a
// subir, esta misma pestaña lo dice sin tocar código.
//
// Cuando sí hay enlaces, el envío es MANUAL a propósito: el operador ya está
// conversando con su contacto por el canal que sea, y obligarlo a usar otro solo
// agrega fricción.
// ──────────────────────────────────────────────────────────────────────────────
import { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";

type Fila = {
  id: number;
  codigo: string | null;
  reserva_id: number;
  os: string | null;
  fecha_servicio: string | null;
  ruta_nombre: string | null;
  monto_antes: number | null;
  monto_despues: number | null;
  delta: number | null;
  motivo: string | null;
  token: string | null;
  conformidad_estado: string;
  conformidad_por: string | null;
  conformidad_cargo: string | null;
  conformidad_at: string | null;
  conformidad_comentario: string | null;
  creado_at: string;
};

const ESTADO: Record<string, { label: string; bg: string; color: string }> = {
  pendiente: { label: "Esperando firma", bg: "#ffedd5", color: "#c2410c" },
  conforme:  { label: "Conforme",        bg: "#dcfce7", color: "#166534" },
  observada: { label: "Observada",       bg: "#fee2e2", color: "#b91c1c" },
};

export default function ConformidadesTab({ onCambio }: { onCambio: () => void }) {
  const [filas, setFilas] = useState<Fila[]>([]);
  const [cargando, setCargando] = useState(true);
  const [errorSql, setErrorSql] = useState("");
  const [copiado, setCopiado] = useState<number | null>(null);
  const [verTodas, setVerTodas] = useState(false);
  // null = todavía no se sabe. La política manda sobre lo que emite el trigger, así que
  // es lo único que puede decir la verdad sobre por qué la lista está vacía.
  const [emite, setEmite] = useState<boolean | null>(null);

  const cargar = useCallback(async () => {
    setCargando(true); setErrorSql("");
    const [actas, pol] = await Promise.all([
      supabase
        .from("v_pactos_servicio")
        .select("*")
        .eq("lado", "venta")
        .neq("conformidad_estado", "no_aplica")
        .order("creado_at", { ascending: false })
        .limit(300),
      supabase.from("pacto_politica").select("exige_conformidad_cliente").eq("id", 1).maybeSingle(),
    ]);
    if (actas.error) {
      setErrorSql("Falta correr supabase/pacto-03-triggers.sql: sin el acta no hay conformidades que pedir.");
      setCargando(false); return;
    }
    setFilas((actas.data as Fila[]) ?? []);
    // Sin fila de política el trigger cae en su `coalesce(…, true)` y sí emite: se
    // asume lo mismo acá para no anunciar un apagado que no está puesto.
    setEmite(pol.error ? null : (pol.data?.exige_conformidad_cliente ?? true));
    setCargando(false);
  }, []);

  useEffect(() => { cargar(); }, [cargar]);

  const pendientes = useMemo(() => filas.filter((f) => f.conformidad_estado === "pendiente"), [filas]);
  // Sin nada esperando firma, filtrar por "pendientes" deja la pantalla en blanco con
  // las filas cargadas detrás: el caso normal con la emisión apagada. Se muestra el
  // archivo completo y el conmutador desaparece, que es lo que ya está pasando.
  const soloArchivo = !pendientes.length;
  const visibles = verTodas || soloArchivo ? filas : pendientes;
  const enJuego = useMemo(
    () => pendientes.reduce((a, f) => a + Number(f.delta ?? 0), 0), [pendientes]);

  const enlaceDe = (token: string) =>
    `${typeof window !== "undefined" ? window.location.origin : ""}/conformidad-cambio/${token}`;

  async function copiar(f: Fila) {
    if (!f.token) return;
    try {
      await navigator.clipboard.writeText(enlaceDe(f.token));
      setCopiado(f.id);
      setTimeout(() => setCopiado(null), 2000);
    } catch { /* algunos navegadores lo bloquean sin gesto directo; el enlace igual se ve */ }
  }

  if (cargando) return <div className="py-16 text-center text-gray-400 text-sm">Cargando…</div>;
  if (errorSql)
    return <div className="bg-amber-50 border border-amber-200 rounded-2xl p-6 text-sm text-amber-800">{errorSql}</div>;

  if (!filas.length)
    return (
      <div className="bg-white rounded-2xl border p-10 text-center">
        <p className="text-gray-500 text-sm">No hay conformidades de cambio registradas.</p>
        <p className="text-gray-400 text-xs mt-1 max-w-md mx-auto leading-relaxed">
          {emite === false
            ? "Subir el precio de un servicio ya no genera un enlace para el cliente: la firma se pide una sola vez por periodo, en la liquidación del cierre. El cambio igual queda en el acta, con su motivo, en 📜 Historial."
            : emite === true
            ? "Se genera un enlace cada vez que sube el precio de un servicio ya creado."
            /* No se pudo leer la política: no se afirma ni que emite ni que no. Decir
               cualquiera de las dos sin saberlo es el mismo defecto que se vino a
               arreglar acá. */
            : "Todo cambio de precio queda registrado en 📜 Historial, con su motivo."}
        </p>
      </div>
    );

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-3 text-sm">
        {soloArchivo ? (
          <>
            <span className="text-gray-600"><b>{filas.length}</b> conformidad(es) de cambio</span>
            <span className="text-[11px] text-gray-400">
              Ninguna está esperando firma.
              {emite === false &&
                " Ya no se emiten enlaces nuevos: la firma del cliente se pide una vez por periodo, en la liquidación del cierre."}
            </span>
          </>
        ) : (
          <>
            <span className="text-gray-600"><b>{pendientes.length}</b> esperando firma</span>
            <span className="text-gray-500">
              En juego <b className="tabular-nums text-amber-700">{fmtMoneda(enJuego)}</b>
            </span>
            <span className="text-[11px] text-gray-400">
              Hasta que el cliente firme, este diferencial es discutible al cierre.
            </span>
            <button onClick={() => setVerTodas((v) => !v)}
              className="ml-auto text-xs text-violet-700 hover:underline">
              {verTodas ? "Ver solo pendientes" : `Ver todas (${filas.length})`}
            </button>
          </>
        )}
      </div>

      {visibles.map((f) => {
        const est = ESTADO[f.conformidad_estado] ?? ESTADO.pendiente;
        return (
          <div key={f.id} className="bg-white rounded-2xl border shadow-sm p-4">
            <div className="flex flex-wrap items-start gap-3">
              <div className="flex-1 min-w-[240px]">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-mono text-[11px] text-gray-400">{f.codigo}</span>
                  <span className="font-mono text-xs font-bold text-gray-800">{f.os}</span>
                  <span className="text-[11px] text-gray-400">{f.fecha_servicio}</span>
                  <span className="text-[11px] text-gray-400">{f.ruta_nombre}</span>
                  <span className="text-[10px] font-bold px-2 py-0.5 rounded-md uppercase"
                    style={{ background: est.bg, color: est.color }}>{est.label}</span>
                </div>
                {f.motivo && <p className="text-xs text-gray-500 mt-1">{f.motivo}</p>}

                {f.conformidad_estado !== "pendiente" && (
                  <p className="text-xs text-gray-600 mt-1.5">
                    {f.conformidad_por}{f.conformidad_cargo ? ` · ${f.conformidad_cargo}` : ""}
                    {f.conformidad_at && ` · ${new Date(f.conformidad_at).toLocaleString("es-PE", {
                      day: "2-digit", month: "2-digit", hour: "2-digit", minute: "2-digit" })}`}
                    {f.conformidad_comentario && <span className="italic"> — “{f.conformidad_comentario}”</span>}
                  </p>
                )}
              </div>

              <div className="text-right shrink-0 tabular-nums">
                <p className="text-xs text-gray-400">{fmtMoneda(Number(f.monto_antes ?? 0))}</p>
                <p className="text-sm font-black text-gray-800">{fmtMoneda(Number(f.monto_despues ?? 0))}</p>
                <p className="text-xs font-bold text-amber-700">+{fmtMoneda(Number(f.delta ?? 0))}</p>
              </div>
            </div>

            {f.conformidad_estado === "pendiente" && f.token && (
              <div className="mt-3 pt-3 border-t flex flex-wrap items-center gap-2">
                <code className="text-[11px] text-gray-500 bg-gray-50 border rounded-lg px-2 py-1 flex-1 min-w-[200px] truncate">
                  {enlaceDe(f.token)}
                </code>
                <button onClick={() => copiar(f)}
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-violet-700 bg-violet-50 border border-violet-200 hover:bg-violet-100">
                  {copiado === f.id ? "¡Copiado!" : "Copiar enlace"}
                </button>
                <a href={`https://wa.me/?text=${encodeURIComponent(
                    `Hola, te comparto el cambio del servicio ${f.os ?? ""} del ${f.fecha_servicio ?? ""} para tu conformidad: ${enlaceDe(f.token)}`)}`}
                  target="_blank" rel="noopener noreferrer"
                  className="px-3 py-1.5 rounded-lg text-xs font-bold text-emerald-700 bg-emerald-50 border border-emerald-200 hover:bg-emerald-100">
                  WhatsApp
                </a>
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
