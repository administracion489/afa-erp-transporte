"use client";
// La CONFIRMACIÓN DE RESERVA: el documento que se le entrega al cliente cuando su servicio queda
// reservado. Este modal no decide nada: el juicio (qué falta, qué se imprime), las versiones y el
// PDF salen de /api/reservas/confirmacion, que usa lib/confirmacion-reserva.ts.
//
// Tres cosas que la pantalla tiene que decir con todas sus letras:
//  · EL ADELANTO LO REGISTRA TESORERÍA/FINANZAS, no quien vende: el formulario solo aparece con
//    ese permiso, y una captura del cliente no habilita nada.
//  · COMPARTIR NO ES ENVIAR: el botón abre la hoja de compartir del teléfono (o descarga el PDF y
//    abre WhatsApp con el mensaje). El ERP no sabe si se envió, y no lo afirma.
//  · UNA VERSIÓN EMITIDA NO CAMBIA: si cambia el horario, la unidad, el conductor o el importe,
//    «Generar» emite la siguiente y dice qué cambió; volver a descargar da el mismo documento.

import { useCallback, useEffect, useState } from "react";
import { X, FileCheck2, Download, Share2, Eye, AlertTriangle } from "lucide-react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { ETIQUETA_CAMBIO, nombreArchivo, type CodigoCambio, type Idioma, type JuicioConfirmacion, type ExtrasConf } from "@/lib/confirmacion-reserva";

type Version = { id: number; version: number; codigo: string; cambios: CodigoCambio[]; generado_en: string; generado_por_nombre: string | null };
type Pago = { id: number; codigo: string | null; fecha: string | null; monto: number; moneda: string | null; metodo: string | null; anulado: boolean };
type Estado = {
  sinMigracion: boolean; sql: string; juicio: JuicioConfirmacion; extras: ExtrasConf;
  importe: { total: number | null; moneda: "PEN" | "USD"; cobrado: number };
  pagos: Pago[]; versiones: Version[]; puedeCobrar: boolean;
  cliente: { telefonoWa: string | null }; empresa: string; mensajes: Record<Idioma, string>;
};

const inputCls = "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const dinero = (n: number, m: string) => `${m === "USD" ? "US$" : "S/"} ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const hoyLima = () => new Date(Date.now() - 5 * 3600 * 1000).toISOString().slice(0, 10);
const fechaHora = (iso: string) => new Date(iso).toLocaleString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });

async function leerEstado(reservaId: number): Promise<{ est: Estado } | { error: string }> {
  try {
    const r = await fetch(`/api/reservas/confirmacion?reserva_id=${reservaId}`, { headers: await cabecerasErp() });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) return { error: j?.detalle || (r.status === 403 ? "No tienes el permiso del módulo Programación." : `Error ${r.status}`) };
    return { est: j as Estado };
  } catch {
    return { error: "No se pudo conectar con el servidor. Revisa la conexión y vuelve a intentar." };
  }
}

export default function ModalConfirmacionReserva({ reservaId, etiqueta, onCerrar }: { reservaId: number; etiqueta: string; onCerrar: () => void }) {
  const [est, setEst] = useState<Estado | null>(null);
  const [error, setError] = useState("");
  const [msg, setMsg] = useState<{ tono: "ok" | "error" | "info"; texto: string } | null>(null);
  const [extras, setExtras] = useState<ExtrasConf>({});
  const [idioma, setIdioma] = useState<Idioma>("es");
  const [ocupado, setOcupado] = useState<string | null>(null);
  const [adel, setAdel] = useState({ monto: "", fecha: hoyLima(), metodo: "transferencia", referencia: "" });

  const aplicar = useCallback((r: Awaited<ReturnType<typeof leerEstado>>, primera: boolean) => {
    if ("error" in r) { setError(r.error); return; }
    setError("");
    setEst(r.est);
    if (primera) { setExtras(r.est.extras ?? {}); setIdioma(r.est.juicio?.idiomaSugerido ?? "es"); }
  }, []);
  const cargar = useCallback(async (primera = false) => aplicar(await leerEstado(reservaId), primera), [reservaId, aplicar]);
  useEffect(() => {
    let vivo = true;
    (async () => { const r = await leerEstado(reservaId); if (vivo) aplicar(r, true); })();
    return () => { vivo = false; };
  }, [reservaId, aplicar]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape" && !ocupado) onCerrar(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCerrar, ocupado]);

  const post = async (cuerpo: Record<string, unknown>) => {
    const r = await fetch("/api/reservas/confirmacion", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ reserva_id: reservaId, ...cuerpo }) });
    const j = await r.json().catch(() => null);
    if (!r.ok || !j?.ok) throw new Error(j?.detalle || `Error ${r.status}`);
    return j;
  };

  const emitir = async () => {
    setOcupado("emitir"); setMsg(null);
    try {
      const v = await post({ accion: "emitir", extras });
      setMsg(v.nueva
        ? { tono: "ok", texto: `Versión ${v.version} emitida (${v.codigo}).${v.cambios?.length ? ` Cambió: ${v.cambios.map((c: CodigoCambio) => ETIQUETA_CAMBIO[c]).join(", ")}.` : ""}` }
        : { tono: "info", texto: `Nada cambió desde la versión ${v.version}: se usa la misma (${v.codigo}).` });
      await cargar();
    } catch (e) { setMsg({ tono: "error", texto: (e as Error).message }); }
    setOcupado(null);
  };

  const registrarAdelanto = async () => {
    const monto = Number(adel.monto.replace(",", "."));
    if (!(monto > 0)) { setMsg({ tono: "error", texto: "Escribe el monto del adelanto." }); return; }
    if (!confirm(`¿Registrar un cobro de ${dinero(monto, est!.importe.moneda)} del ${adel.fecha} para esta reserva?\nSolo regístralo si el dinero ya está en la cuenta (validado contra el banco o recibido en efectivo).`)) return;
    setOcupado("adelanto"); setMsg(null);
    try {
      const r = await post({ accion: "adelanto", monto, fecha: adel.fecha, metodo: adel.metodo, referencia: adel.referencia });
      setMsg({ tono: "ok", texto: `Cobro ${r.codigo ?? ""} registrado.` });
      setAdel((a) => ({ ...a, monto: "", referencia: "" }));
      await cargar();
    } catch (e) { setMsg({ tono: "error", texto: (e as Error).message }); }
    setOcupado(null);
  };

  const anular = async (p: Pago) => {
    if (!confirm(`¿Anular el cobro ${p.codigo ?? p.id} de ${dinero(p.monto, p.moneda ?? "PEN")}? Queda en el registro como anulado.`)) return;
    setOcupado(`anular-${p.id}`); setMsg(null);
    try { await post({ accion: "anular_adelanto", pago_id: p.id }); setMsg({ tono: "ok", texto: "Cobro anulado." }); await cargar(); }
    catch (e) { setMsg({ tono: "error", texto: (e as Error).message }); }
    setOcupado(null);
  };

  const bajarPdf = async (v: Version): Promise<Blob> => {
    const r = await fetch(`/api/reservas/confirmacion?version_id=${v.id}&idioma=${idioma}`, { headers: await cabecerasErp() });
    if (!r.ok) { const j = await r.json().catch(() => null); throw new Error(j?.detalle || `Error ${r.status} al generar el PDF`); }
    return await r.blob();
  };
  const guardarArchivo = (b: Blob, nombre: string) => {
    const url = URL.createObjectURL(b);
    const a = document.createElement("a"); a.href = url; a.download = nombre; a.click();
    setTimeout(() => URL.revokeObjectURL(url), 30_000);
  };

  const accionPdf = async (v: Version, modo: "ver" | "descargar" | "compartir") => {
    setOcupado(`${modo}-${v.id}`); setMsg(null);
    // La ventana se abre ANTES del await: un popup abierto después lo bloquea el navegador.
    const ventana = modo === "ver" ? window.open("", "_blank") : null;
    try {
      const blob = await bajarPdf(v);
      const nombre = nombreArchivo(v.codigo, idioma);
      if (modo === "ver") {
        const url = URL.createObjectURL(blob);
        if (ventana) ventana.location.href = url; else window.open(url, "_blank");
        setTimeout(() => URL.revokeObjectURL(url), 120_000);
      } else if (modo === "descargar") {
        guardarArchivo(blob, nombre);
      } else {
        const texto = (est?.mensajes[idioma] ?? "").replace("{codigo}", v.codigo);
        const archivo = new File([blob], nombre, { type: "application/pdf" });
        const nav = navigator as Navigator & { canShare?: (d: ShareData) => boolean };
        if (nav.canShare?.({ files: [archivo] })) {
          try { await nav.share({ files: [archivo], text: texto, title: v.codigo }); setMsg({ tono: "info", texto: "Se abrió la hoja de compartir. Elige WhatsApp y el chat del cliente." }); }
          catch (e) { if ((e as Error).name !== "AbortError") throw e; }
        } else {
          guardarArchivo(blob, nombre);
          const tel = est?.cliente.telefonoWa;
          window.open(`https://wa.me/${tel ?? ""}?text=${encodeURIComponent(texto)}`, "_blank", "noopener");
          setMsg({ tono: "info", texto: `El PDF se descargó y se abrió WhatsApp${tel ? " con el número del cliente" : ""} y el mensaje. Adjunta el archivo «${nombre}» en el chat: el envío lo haces tú, el ERP no lo registra como enviado.` });
        }
      }
    } catch (e) {
      ventana?.close();
      setMsg({ tono: "error", texto: (e as Error).message });
    }
    setOcupado(null);
  };

  const j = est?.juicio;
  const moneda = est?.importe.moneda ?? "PEN";
  const saldo = est && est.importe.total != null ? Math.max(0, est.importe.total - est.importe.cobrado) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4" style={{ background: "rgba(0,0,0,0.45)" }} onClick={() => !ocupado && onCerrar()}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-2xl flex flex-col" style={{ maxHeight: "calc(100vh - 16px)" }} onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between px-5 py-4 border-b shrink-0" style={{ borderColor: "#e2e8f0" }}>
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-9 h-9 rounded-xl flex items-center justify-center text-white shrink-0" style={{ background: "#0b315f" }}><FileCheck2 size={18} /></div>
            <div className="min-w-0">
              <h2 className="text-lg font-bold text-gray-900">Confirmación de reserva</h2>
              <p className="text-xs text-gray-400 truncate">{etiqueta}</p>
            </div>
          </div>
          <button onClick={onCerrar} disabled={!!ocupado} className="p-2 rounded-lg hover:bg-gray-100 text-gray-500" aria-label="Cerrar"><X size={18} /></button>
        </div>

        <div className="overflow-y-auto px-5 py-4 space-y-4">
          {error && <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{error} <button className="underline font-bold ml-1" onClick={() => cargar(true)}>Reintentar</button></div>}
          {!est && !error && <p className="text-sm text-gray-400">Comprobando la reserva…</p>}

          {est?.sinMigracion && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-xs text-amber-800">
              Falta correr <b>{est.sql}</b> en Supabase: sin él no se pueden registrar adelantos ni emitir confirmaciones.
            </div>
          )}

          {est && j && (
            <>
              {/* El dinero, tal como está registrado. */}
              <section className="rounded-xl border border-gray-200 p-3">
                <p className="text-[11px] font-black uppercase text-[#0b315f] mb-2">Pago del servicio</p>
                <div className="grid grid-cols-3 gap-2 text-center">
                  <div><p className="text-[10px] text-gray-400 font-bold uppercase">Precio</p><p className="font-black text-sm">{est.importe.total != null && est.importe.total > 0 ? dinero(est.importe.total, moneda) : "—"}</p></div>
                  <div><p className="text-[10px] text-gray-400 font-bold uppercase">Cobrado</p><p className="font-black text-sm text-green-700">{dinero(est.importe.cobrado, moneda)}</p></div>
                  <div><p className="text-[10px] text-gray-400 font-bold uppercase">Saldo</p><p className="font-black text-sm">{saldo != null ? dinero(saldo, moneda) : "—"}</p></div>
                </div>
                {est.pagos.length > 0 && (
                  <ul className="mt-3 space-y-1">
                    {est.pagos.map((p) => (
                      <li key={p.id} className={`flex items-center justify-between text-xs rounded-lg px-2 py-1 ${p.anulado ? "bg-gray-50 text-gray-400 line-through" : "bg-green-50 text-green-800"}`}>
                        <span>{p.codigo ?? `#${p.id}`} · {p.fecha} · {p.metodo ?? "—"}</span>
                        <span className="flex items-center gap-2 font-bold">{dinero(p.monto, p.moneda ?? "PEN")}
                          {est.puedeCobrar && !p.anulado && <button onClick={() => anular(p)} disabled={!!ocupado} className="text-red-600 underline font-semibold">anular</button>}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
                {est.puedeCobrar ? (
                  <div className="mt-3 border-t border-dashed border-gray-200 pt-3">
                    <p className="text-[10px] font-bold uppercase text-gray-500 mb-1.5">Registrar adelanto validado ({moneda})</p>
                    <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                      <input className={inputCls} inputMode="decimal" placeholder="Monto" value={adel.monto} onChange={(e) => setAdel({ ...adel, monto: e.target.value })} />
                      <input className={inputCls} type="date" max={hoyLima()} value={adel.fecha} onChange={(e) => setAdel({ ...adel, fecha: e.target.value })} />
                      <select className={inputCls} value={adel.metodo} onChange={(e) => setAdel({ ...adel, metodo: e.target.value })}>
                        {["transferencia", "deposito", "yape", "plin", "tarjeta", "efectivo"].map((m) => <option key={m} value={m}>{m}</option>)}
                      </select>
                      <input className={inputCls} placeholder={adel.metodo === "efectivo" ? "Nº de recibo (opcional)" : "Nº de operación"} value={adel.referencia} onChange={(e) => setAdel({ ...adel, referencia: e.target.value })} />
                    </div>
                    <button onClick={registrarAdelanto} disabled={!!ocupado || est.sinMigracion} className="mt-2 px-3 py-1.5 rounded-xl text-xs font-black text-white bg-green-700 disabled:opacity-40">
                      {ocupado === "adelanto" ? "Registrando…" : "Registrar cobro"}
                    </button>
                    <p className="text-[10px] text-gray-400 mt-1">Queda en Finanzas como cobro sin aplicar (anticipo) de este cliente. Una captura del cliente no basta: regístralo cuando el dinero ya esté en la cuenta.</p>
                  </div>
                ) : (
                  <p className="text-[11px] text-gray-500 mt-2">El adelanto lo registra quien tiene el módulo Finanzas o Cuentas por Pagar (Tesorería), cuando valida el pago. Pídeselo con el código de la reserva.</p>
                )}
              </section>

              {j.bloqueos.length > 0 && (
                <section className="rounded-xl border border-red-200 bg-red-50 p-3">
                  <p className="text-xs font-black text-red-700 mb-1">Todavía no se puede emitir:</p>
                  <ul className="list-disc pl-5 text-xs text-red-700 space-y-0.5">{j.bloqueos.map((b, i) => <li key={i}>{b.detalle}</li>)}</ul>
                </section>
              )}
              {j.avisos.length > 0 && (
                <section className="rounded-xl border border-amber-200 bg-amber-50 p-3">
                  <ul className="text-xs text-amber-800 space-y-0.5">{j.avisos.map((a, i) => <li key={i} className="flex gap-1.5"><AlertTriangle size={12} className="mt-0.5 shrink-0" />{a.detalle}</li>)}</ul>
                </section>
              )}

              {/* Lo que escribe quien emite. */}
              <section className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <label className="text-[11px] font-bold text-gray-500">Nº de vuelo (si es aeropuerto)
                  <input className={inputCls} maxLength={40} placeholder="Ej. LA2045" value={extras.vuelo ?? ""} onChange={(e) => setExtras({ ...extras, vuelo: e.target.value })} />
                </label>
                <label className="text-[11px] font-bold text-gray-500">Punto de encuentro / terminal
                  <input className={inputCls} maxLength={120} placeholder="Ej. Salida de llegadas nacionales, puerta 3" value={extras.punto_encuentro ?? ""} onChange={(e) => setExtras({ ...extras, punto_encuentro: e.target.value })} />
                </label>
                <label className="text-[11px] font-bold text-gray-500 sm:col-span-2">Indicaciones para el cliente (opcional)
                  <textarea className={inputCls} rows={2} maxLength={300} value={extras.nota ?? ""} onChange={(e) => setExtras({ ...extras, nota: e.target.value })} />
                </label>
                <label className="flex items-center gap-2 text-xs text-gray-600 sm:col-span-2">
                  <input type="checkbox" checked={!!extras.incluir_telefono_conductor} onChange={(e) => setExtras({ ...extras, incluir_telefono_conductor: e.target.checked })} />
                  Incluir el teléfono del conductor (solo si está autorizado a compartirse con el cliente)
                </label>
              </section>

              <div className="flex flex-wrap items-center gap-2">
                <select className="border border-gray-200 rounded-xl px-3 py-2 text-sm" value={idioma} onChange={(e) => setIdioma(e.target.value as Idioma)}>
                  <option value="es">Español</option>
                  <option value="en">English</option>
                </select>
                <button onClick={emitir} disabled={!!ocupado || !j.ok || est.sinMigracion} className="flex-1 min-w-[220px] px-4 py-2 rounded-xl font-black text-sm text-white disabled:opacity-40" style={{ background: "#0b315f" }}>
                  {ocupado === "emitir" ? "Generando…" : "Generar confirmación de reserva"}
                </button>
              </div>
              <p className="text-[10px] text-gray-400 -mt-2">El idioma solo cambia el PDF; la misma versión se descarga en español o en inglés.</p>
            </>
          )}

          {msg && <div className={`rounded-xl p-3 text-xs border ${msg.tono === "ok" ? "bg-green-50 border-green-200 text-green-800" : msg.tono === "error" ? "bg-red-50 border-red-200 text-red-700" : "bg-sky-50 border-sky-200 text-sky-800"}`}>{msg.texto}</div>}

          {est && est.versiones.length > 0 && (
            <section>
              <p className="text-[11px] font-black uppercase text-[#0b315f] mb-2">Confirmaciones emitidas</p>
              <ul className="space-y-2">
                {est.versiones.map((v, i) => (
                  <li key={v.id} className={`rounded-xl border p-2.5 ${i === 0 ? "border-[#0b315f]/40" : "border-gray-200 opacity-80"}`}>
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <div className="text-xs">
                        <b>{v.codigo}</b> {i === 0 ? <span className="text-green-700 font-bold">· vigente</span> : <span className="text-gray-400">· reemplazada</span>}
                        <p className="text-[10px] text-gray-400">{fechaHora(v.generado_en)}{v.generado_por_nombre ? ` · ${v.generado_por_nombre}` : ""}{v.cambios?.length ? ` · cambió: ${v.cambios.map((c) => ETIQUETA_CAMBIO[c] ?? c).join(", ")}` : ""}</p>
                      </div>
                      <div className="flex gap-1.5">
                        <button onClick={() => accionPdf(v, "ver")} disabled={!!ocupado} className="flex items-center gap-1 text-[11px] font-bold px-2 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"><Eye size={12} /> Ver</button>
                        <button onClick={() => accionPdf(v, "descargar")} disabled={!!ocupado} className="flex items-center gap-1 text-[11px] font-bold px-2 py-1.5 rounded-lg border border-gray-200 hover:bg-gray-50"><Download size={12} /> {ocupado === `descargar-${v.id}` ? "…" : "PDF"}</button>
                        {i === 0 && <button onClick={() => accionPdf(v, "compartir")} disabled={!!ocupado} className="flex items-center gap-1 text-[11px] font-bold px-2 py-1.5 rounded-lg text-white bg-green-600 hover:bg-green-700"><Share2 size={12} /> {ocupado === `compartir-${v.id}` ? "…" : "WhatsApp"}</button>}
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}
