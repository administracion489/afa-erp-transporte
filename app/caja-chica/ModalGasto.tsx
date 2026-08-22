"use client";

// Registrar un comprobante de caja chica DESDE EL ERP.
//
// Por qué existe: hasta la fase 08 el único código que insertaba en `caja_chica_gastos`
// era la app del conductor (POST /api/conductor → rendir_gasto). Un gerente o un
// asistente administrativo podía recibir dinero —se le abría la rendición— pero no
// tenía forma de rendirlo: su rendición quedaba vacía para siempre y nunca llegaba a
// liquidarse. Esta pantalla es su camino, con las MISMAS reglas que el chofer:
//   · solo se rinde sobre una rendición viva (abierta u observada),
//   · el comprobante es obligatorio salvo declaración expresa,
//   · la foto va al bucket PRIVADO y se guarda su ruta, nunca una URL pública.
// Toda esa validación vive en `registrarGasto` (lib/finanzas/caja-chica), no aquí.

import React, { useCallback, useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fmtMoneda } from "@/lib/finanzas/dinero";
import {
  categoriasParaTipo,
  configCategoriaCC,
  hoyLima,
  registrarGasto,
  type RendicionCajaChica,
} from "@/lib/finanzas/caja-chica";

type Props = {
  rendicionId: number;
  onCerrar: () => void;
  /** Se llama tras registrar; el padre refresca y avisa. */
  onListo: (mensaje: string) => void;
};

type VehiculoRef = { id: number; placa: string };
type ReservaRef = { id: number; codigo: string | null; fecha_servicio: string | null; origen: string | null; destino: string | null };

const TIPOS_COMPROBANTE = [
  { valor: "boleta", label: "Boleta" },
  { valor: "factura", label: "Factura" },
  { valor: "ticket", label: "Ticket" },
  { valor: "recibo", label: "Recibo" },
];

/** 25 MB: el límite de `hashDeFoto` en el servidor y más que suficiente para un ticket. */
const MAX_BYTES = 25 * 1024 * 1024;

function inputCls(extra = "") {
  return "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all " + extra;
}

function Campo({ label, span, children }: { label: string; span?: number; children: React.ReactNode }) {
  return (
    <div className={span === 2 ? "md:col-span-2" : span === 3 ? "md:col-span-3" : ""}>
      <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">{label}</label>
      {children}
    </div>
  );
}

/**
 * Lectura que no revienta si la tabla o alguna columna no existe en esta base:
 * PostgREST devuelve 400 y aquí se traduce a "sin opciones" en vez de romper el modal.
 */
type Consulta<T> = PromiseLike<{ data: T[] | null; error: unknown }>;

async function safe<T>(consulta: Consulta<T>): Promise<T[]> {
  const { data, error } = await consulta;
  return error ? [] : (data ?? []);
}

export default function ModalGasto({ rendicionId, onCerrar, onListo }: Props) {
  const [rendicion, setRendicion] = useState<RendicionCajaChica | null>(null);
  const [vehiculos, setVehiculos] = useState<VehiculoRef[]>([]);
  const [reservas, setReservas] = useState<ReservaRef[]>([]);
  const [cargando, setCargando] = useState(true);

  const [fecha, setFecha] = useState(hoyLima());
  const [categoria, setCategoria] = useState("otro");
  const [monto, setMonto] = useState("");
  const [descripcion, setDescripcion] = useState("");
  const [tipoComprobante, setTipoComprobante] = useState("boleta");
  const [ruc, setRuc] = useState("");
  const [serie, setSerie] = useState("");
  const [numero, setNumero] = useState("");
  const [igv, setIgv] = useState("");
  const [vehiculoId, setVehiculoId] = useState("");
  const [reservaId, setReservaId] = useState("");
  const [archivo, setArchivo] = useState<File | null>(null);
  const [sinComprobante, setSinComprobante] = useState(false);

  const [guardando, setGuardando] = useState(false);
  const [error, setError] = useState("");

  const cargar = useCallback(async () => {
    setCargando(true);
    const [r, vs, rs] = await Promise.all([
      supabase.from("v_caja_chica_rendiciones").select("*").eq("id", rendicionId).maybeSingle(),
      safe<VehiculoRef>(supabase.from("vehiculos").select("id, placa").order("placa")),
      // Solo servicios recientes: el enganche gasto→servicio se usa para lo que se
      // acaba de ejecutar, no para revisar el archivo histórico entero.
      safe<ReservaRef>(
        supabase
          .from("reservas")
          .select("id, codigo, fecha_servicio, origen, destino")
          .order("fecha_servicio", { ascending: false })
          .limit(200)
      ),
    ]);
    const fila = (r.data ?? null) as RendicionCajaChica | null;
    setRendicion(fila);
    setVehiculos(vs);
    setReservas(rs);
    // El vehículo de la rendición es el candidato natural para un gasto de calle.
    if (fila?.vehiculo_id) setVehiculoId(String(fila.vehiculo_id));
    setCargando(false);
  }, [rendicionId]);

  // Carga inicial (patrón de todo el ERP): el setState ocurre tras el await.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    cargar();
  }, [cargar]);

  // La vista previa se DERIVA del archivo (no es estado propio) y el efecto solo se
  // encarga de revocar el object URL: sin eso se filtra memoria al cambiar de foto
  // varias veces seguidas. Un PDF no se previsualiza, se muestra su icono.
  const preview = useMemo(
    () => (archivo && archivo.type.startsWith("image/") ? URL.createObjectURL(archivo) : null),
    [archivo]
  );
  useEffect(() => {
    if (!preview) return;
    return () => URL.revokeObjectURL(preview);
  }, [preview]);

  const categorias = useMemo(
    () => categoriasParaTipo(rendicion?.responsable_tipo),
    [rendicion?.responsable_tipo]
  );
  const cfgCat = configCategoriaCC(categoria);
  const moneda = rendicion?.moneda ?? "PEN";
  const viva = rendicion ? ["abierta", "observada"].includes(rendicion.estado) : false;

  // Cuánto queda de lo entregado. Que se pase no bloquea —a veces el responsable pone
  // de su bolsillo y se le reembolsa— pero sí se avisa antes de guardar.
  const restante = rendicion
    ? Number(rendicion.monto_asignado) - Number(rendicion.monto_rendido) - Number(rendicion.monto_devuelto ?? 0)
    : 0;
  const excede = Number(monto) > 0 && Number(monto) > restante;

  function elegirArchivo(f: File | null) {
    setError("");
    if (f && f.size > MAX_BYTES) {
      setError("El archivo pesa más de 25 MB. Sácale una foto más liviana o comprímelo.");
      return;
    }
    setArchivo(f);
    if (f) setSinComprobante(false);
  }

  /** El IGV de una boleta con RUC: atajo para no obligar a sacar la calculadora. */
  function calcularIgv() {
    const total = Number(monto);
    if (!(total > 0)) return;
    // El monto rendido es el TOTAL (incluye IGV); el impuesto contenido es total·18/118.
    setIgv(((total * 18) / 118).toFixed(2));
  }

  async function guardar() {
    setError("");
    const r = await registrarGasto(supabase, {
      rendicion_id: rendicionId,
      fecha,
      categoria,
      descripcion,
      monto: Number(monto),
      moneda,
      tipo_comprobante: sinComprobante ? "sin_comprobante" : tipoComprobante,
      ruc_proveedor: ruc,
      comprobante_serie: serie,
      comprobante_numero: numero,
      igv: Number(igv) || 0,
      archivo,
      sin_comprobante: sinComprobante,
      vehiculo_id: vehiculoId ? Number(vehiculoId) : null,
      reserva_id: reservaId ? Number(reservaId) : null,
    });

    if (!r.ok) {
      setError(r.error);
      return;
    }
    onListo(`Comprobante registrado por ${fmtMoneda(Number(monto), moneda)}`);
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCerrar}>
      <div
        className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[90vh] overflow-y-auto"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-6 py-4 border-b">
          <h3 className="font-bold text-gray-900">
            Registrar comprobante{" "}
            <span className="font-mono text-[#0b315f]">{rendicion?.codigo ?? ""}</span>
          </h3>
          <p className="text-xs text-gray-400 mt-1">
            {rendicion?.responsable_nombre ?? "—"}
            {rendicion?.cargo ? ` · ${rendicion.cargo}` : ""}
            {rendicion?.area ? ` · ${rendicion.area}` : ""}
            {rendicion ? ` · Quedan ${fmtMoneda(restante, moneda)} de lo entregado` : ""}
          </p>
        </div>

        <div className="p-6 space-y-4">
          {cargando && (
            <div className="p-8 text-center text-gray-400">
              <div className="flex items-center justify-center gap-2">
                <div className="w-5 h-5 border-2 border-gray-200 border-t-[#0b315f] rounded-full animate-spin" />
                Cargando…
              </div>
            </div>
          )}

          {!cargando && !viva && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3 text-sm text-amber-800">
              <span className="text-lg leading-none">🔒</span>
              <span>
                Esta rendición ya no admite comprobantes: está{" "}
                <span className="font-bold">{rendicion?.estado}</span>. Para agregar uno,
                el revisor tiene que devolverla observada.
              </span>
            </div>
          )}

          {!cargando && viva && (
            <>
              <div>
                <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-2">Categoría</label>
                <div className="flex flex-wrap gap-2">
                  {categorias.map(({ clave, cfg }) => {
                    const act = categoria === clave;
                    return (
                      <button
                        key={clave}
                        type="button"
                        onClick={() => setCategoria(clave)}
                        className="px-3 py-1.5 rounded-xl text-xs font-bold border transition-all"
                        style={
                          act
                            ? { background: cfg.bg, color: cfg.color, borderColor: cfg.color }
                            : { background: "#fff", color: "#6b7280", borderColor: "#e2e8f0" }
                        }
                      >
                        {cfg.emoji} {cfg.label}
                      </button>
                    );
                  })}
                </div>
                {cfgCat.ojo && (
                  <p className="text-[11px] text-amber-700 mt-2 flex items-start gap-1.5">
                    <span>⚠️</span>
                    <span>{cfgCat.ojo}</span>
                  </p>
                )}
              </div>

              <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
                <Campo label="Fecha del gasto">
                  <input type="date" className={inputCls()} value={fecha} onChange={(e) => setFecha(e.target.value)} />
                </Campo>
                <Campo label={`Monto total (${moneda})`}>
                  <input
                    type="number"
                    min="0"
                    step="0.01"
                    className={inputCls(excede ? "border-amber-400" : "")}
                    value={monto}
                    onChange={(e) => setMonto(e.target.value)}
                    placeholder="0.00"
                  />
                </Campo>
                <Campo label="IGV incluido">
                  <div className="flex gap-2">
                    <input
                      type="number"
                      min="0"
                      step="0.01"
                      className={inputCls()}
                      value={igv}
                      onChange={(e) => setIgv(e.target.value)}
                      placeholder="0.00"
                    />
                    <button
                      type="button"
                      onClick={calcularIgv}
                      title="Calcular el IGV contenido en el total (18/118)"
                      className="px-3 rounded-xl border text-xs font-bold text-[#0b315f] hover:bg-gray-50 whitespace-nowrap"
                    >
                      18 %
                    </button>
                  </div>
                </Campo>

                <Campo label="Descripción" span={3}>
                  <input
                    className={inputCls()}
                    value={descripcion}
                    onChange={(e) => setDescripcion(e.target.value)}
                    placeholder="Qué se compró o pagó, y para qué"
                  />
                </Campo>

                <Campo label="Tipo de comprobante">
                  <select
                    className={inputCls()}
                    value={tipoComprobante}
                    onChange={(e) => setTipoComprobante(e.target.value)}
                    disabled={sinComprobante}
                  >
                    {TIPOS_COMPROBANTE.map((t) => (
                      <option key={t.valor} value={t.valor}>
                        {t.label}
                      </option>
                    ))}
                  </select>
                </Campo>
                <Campo label="RUC del proveedor">
                  <input
                    className={inputCls()}
                    value={ruc}
                    onChange={(e) => setRuc(e.target.value.replace(/\D/g, "").slice(0, 11))}
                    placeholder="20123456789"
                    disabled={sinComprobante}
                  />
                </Campo>
                <Campo label="Serie y número">
                  <div className="flex gap-2">
                    <input
                      className={inputCls()}
                      value={serie}
                      onChange={(e) => setSerie(e.target.value.toUpperCase().slice(0, 8))}
                      placeholder="B001"
                      disabled={sinComprobante}
                    />
                    <input
                      className={inputCls()}
                      value={numero}
                      onChange={(e) => setNumero(e.target.value.slice(0, 12))}
                      placeholder="0001234"
                      disabled={sinComprobante}
                    />
                  </div>
                </Campo>

                <Campo label="Vehículo (opcional)">
                  <select className={inputCls()} value={vehiculoId} onChange={(e) => setVehiculoId(e.target.value)}>
                    <option value="">Sin vehículo</option>
                    {vehiculos.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.placa}
                      </option>
                    ))}
                  </select>
                </Campo>
                <Campo label="Servicio (opcional)" span={2}>
                  <select className={inputCls()} value={reservaId} onChange={(e) => setReservaId(e.target.value)}>
                    <option value="">Sin servicio · queda como gasto general del área</option>
                    {reservas.map((r) => (
                      <option key={r.id} value={r.id}>
                        {[r.codigo || `#${r.id}`, r.fecha_servicio?.slice(0, 10), [r.origen, r.destino].filter(Boolean).join(" → ")]
                          .filter(Boolean)
                          .join(" · ")}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-gray-400 mt-1">
                    Atarlo a un servicio es lo que hace que aparezca en su costo real y en el margen.
                  </p>
                </Campo>
              </div>

              <div className="rounded-2xl border p-4 space-y-3" style={{ borderColor: "#e2e8f0" }}>
                <div className="flex items-start gap-4 flex-wrap">
                  <div className="shrink-0">
                    {preview ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={preview}
                        alt="Comprobante"
                        className="w-32 h-32 object-cover rounded-xl border"
                        style={{ borderColor: "#e2e8f0" }}
                      />
                    ) : (
                      <div
                        className="w-32 h-32 rounded-xl border flex flex-col items-center justify-center text-gray-300"
                        style={{ borderColor: "#e2e8f0", background: "#f8fafc" }}
                      >
                        <p className="text-3xl">{archivo ? "📄" : "📷"}</p>
                        <p className="text-[11px] mt-1">{archivo ? "Adjunto" : "Sin foto"}</p>
                      </div>
                    )}
                  </div>
                  <div className="flex-1 min-w-[220px] space-y-2">
                    <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400">
                      Foto o PDF del comprobante
                    </label>
                    <input
                      type="file"
                      accept="image/*,application/pdf"
                      onChange={(e) => elegirArchivo(e.target.files?.[0] ?? null)}
                      disabled={sinComprobante}
                      className="block w-full text-xs text-gray-600 file:mr-3 file:px-3 file:py-2 file:rounded-xl file:border-0 file:text-xs file:font-bold file:bg-[#eef3f8] file:text-[#0b315f] hover:file:bg-[#dde8f3] disabled:opacity-50"
                    />
                    {archivo && (
                      <p className="text-[11px] text-gray-400">
                        {archivo.name} · {(archivo.size / 1024).toFixed(0)} KB
                        <button
                          type="button"
                          onClick={() => elegirArchivo(null)}
                          className="ml-2 text-red-500 font-bold hover:underline"
                        >
                          quitar
                        </button>
                      </p>
                    )}
                    <label className="flex items-start gap-2.5 text-sm text-gray-700 pt-1">
                      <input
                        type="checkbox"
                        className="mt-0.5"
                        checked={sinComprobante}
                        onChange={(e) => {
                          setSinComprobante(e.target.checked);
                          if (e.target.checked) setArchivo(null);
                        }}
                      />
                      <span>
                        <span className="font-bold">No hubo comprobante</span>
                        <span className="block text-xs text-gray-400">
                          Una movilidad, una propina de parqueo. Queda marcado para que el contador lo mire
                          aparte: sin comprobante no da crédito fiscal ni es deducible.
                        </span>
                      </span>
                    </label>
                  </div>
                </div>
                <p className="text-[11px] text-gray-400">
                  🔒 El archivo va a un bucket privado: solo se abre con un enlace firmado desde el ERP.
                </p>
              </div>

              {excede && (
                <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 flex items-start gap-3 text-sm text-amber-800">
                  <span className="text-lg leading-none">⚠️</span>
                  <span>
                    Este gasto supera lo que queda de la entrega ({fmtMoneda(restante, moneda)}). Se puede
                    registrar igual —a veces el responsable pone de su bolsillo— y al liquidar quedará como
                    reembolso a su favor.
                  </span>
                </div>
              )}

              {error && (
                <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 flex items-start gap-3 text-sm text-red-800">
                  <span className="text-lg leading-none">⚠️</span>
                  {error}
                </div>
              )}
            </>
          )}
        </div>

        <div className="px-6 py-4 border-t flex justify-end gap-3">
          <button onClick={onCerrar} className="px-6 py-2.5 rounded-xl font-bold text-sm border text-gray-600 hover:bg-gray-50">
            Cerrar
          </button>
          <button
            onClick={async () => {
              setGuardando(true);
              await guardar();
              setGuardando(false);
            }}
            disabled={!viva || guardando || cargando || !(Number(monto) > 0)}
            className="px-6 py-2.5 rounded-xl font-bold text-sm text-white disabled:opacity-60 hover:opacity-90"
            style={{ background: "#0b315f" }}
          >
            {guardando ? "Registrando…" : "Registrar comprobante"}
          </button>
        </div>
      </div>
    </div>
  );
}
