"use client";
// app/combustible/SaldoCuenta.tsx — La tarjeta del saldo de la cuenta prepago (Primax).
//
// El saldo lo calcula lib/combustible/saldo-datos.ts → saldo-cuenta.ts, la MISMA función que
// usa el cron que manda el aviso: la pantalla y el correo no pueden decir dos cifras.
// Los datos los escribe una persona: el saldo que lee en el portal (el ancla) y los abonos.

import React, { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import { hoyLima } from "@/lib/odometro-analitica";
import { cargarCuentas, estadoDeCuentas, type EstadoCuenta, type FilaCuenta } from "@/lib/combustible/saldo-datos";
import {
  decidirAviso, umbralesValidos, fraseExcluidas, avisoExcluidasEnFactura, MOTIVO_NO_DESCUENTA,
  type SaldoCuenta as Saldo, type CargaCuenta, type CargaExcluida,
} from "@/lib/combustible/saldo-cuenta";
import { MAX_DESFASE, normalizarDesfaseConfig } from "@/lib/combustible/desfase-factura";
import { faltaColumna } from "@/lib/columna-faltante";

const S = (n: number | null | undefined) =>
  n == null ? "—" : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

type Modal = null | { tipo: "lectura" | "abono"; cuenta: FilaCuenta } | { tipo: "config"; cuenta: FilaCuenta };

export default function SaldoCuenta() {
  const [estados, setEstados] = useState<EstadoCuenta[] | null>(null);
  const [sinMigracion, setSinMigracion] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [modal, setModal] = useState<Modal>(null);
  const [aviso, setAviso] = useState<string | null>(null);
  // Qué tarjetas tienen abierta la lista de cargas (por id de cuenta).
  const [detalle, setDetalle] = useState<Record<number, boolean>>({});

  const cargar = useCallback(async () => {
    try {
      const { cuentas, sinMigracion } = await cargarCuentas(supabase);
      setSinMigracion(sinMigracion);
      setEstados(await estadoDeCuentas(supabase, cuentas.filter((c) => c.activo), hoyLima()));
      setError(null);
    } catch (e: any) {
      setError(e.message);
      setEstados([]);
    }
  }, []);
  useEffect(() => { cargar(); }, [cargar]);

  async function comprobar() {
    // Tras un abono o una lectura el ciclo de avisos se rearma o avanza: se pide al servidor
    // ahora en vez de esperar al cron de la hora. Best-effort.
    try { await fetch("/api/combustible/saldo", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ accion: "comprobar" }) }); } catch { /* el cron lo hará */ }
  }

  async function prueba(c: FilaCuenta) {
    setAviso("Enviando prueba…");
    const r = await fetch("/api/combustible/saldo", { method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ accion: "prueba", cuenta_id: c.id }) });
    const j = await r.json().catch(() => ({}));
    setAviso(j.ok
      ? `Prueba enviada: ${j.envio.correos} correo(s), ${j.envio.whatsapp} WhatsApp.${j.envio.fallos?.length ? ` Fallaron: ${j.envio.fallos.join(" · ")}` : ""}`
      : `No se envió: ${j.error ?? r.status}`);
  }

  if (sinMigracion) {
    return (
      <div className="rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
        ⛽ <b>Saldo de combustible y facturas por correo</b>: falta correr <code>supabase/combustible-03-saldo-cuenta-y-facturas.sql</code> en Supabase → SQL Editor. Hasta entonces el ERP no puede calcular el saldo ni avisar.
      </div>
    );
  }
  if (estados == null) return <div className="rounded-xl border p-4 text-sm text-gray-400">Calculando saldo de combustible…</div>;
  if (error) return <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">Saldo de combustible: {error}</div>;

  return (
    <>
      {estados.map(({ cuenta, saldo }) => {
        const umbrales = cuenta.umbrales;
        const s = saldo.saldo;
        const d = decidirAviso(s, umbrales, null);
        const tono = s == null ? "gris" : s <= 0 ? "rojo" : d.avisar != null ? (d.avisar === umbrales[umbrales.length - 1] ? "rojo" : "ambar") : "verde";
        const col = { gris: ["#f3f4f6", "#6b7280"], rojo: ["#fef2f2", "#b91c1c"], ambar: ["#fffbeb", "#b45309"], verde: ["#f0fdf4", "#15803d"] }[tono];
        const sinCanal = !cuenta.avisar_correos?.trim() && !cuenta.avisar_telefonos?.trim();
        return (
          <section key={cuenta.id} className="rounded-2xl border p-4 flex flex-wrap items-center gap-x-8 gap-y-3" style={{ background: col[0], borderColor: col[1] + "33" }}>
            <div>
              <div className="text-[11px] font-bold tracking-widest uppercase" style={{ color: col[1] }}>Saldo de combustible · {cuenta.nombre}</div>
              <div className="text-4xl font-black" style={{ color: col[1] }}>{s == null ? "—" : S(s)}</div>
              <div className="text-xs" style={{ color: col[1] }} title="Ritmo: lo que cargaron las unidades propias en los grifos de la cuenta en los últimos 14 días.">
                {s == null ? "Registra el saldo que dice el portal para empezar." :
                  saldo.diasRestantes != null ? `~${saldo.diasRestantes} día(s) al ritmo de ${S(saldo.consumoDiario)}/día` : "estimado"}
              </div>
            </div>
            {saldo.ancla && (
              <div className="text-xs text-gray-700 leading-5 max-w-md">
                <div>Saldo leído del portal: <b>{S(saldo.ancla.monto)}</b> ({saldo.ancla.fecha})</div>
                <div>+ Abonos posteriores: <b>{S(saldo.abonos)}</b></div>
                <div>− Cargas de unidades propias: <b>{S(saldo.consumido)}</b> ({saldo.nCargas})</div>
                {saldo.nPorConfirmar > 0 && <div>− Del Radar, propias sin confirmar: <b>{S(saldo.porConfirmar)}</b> ({saldo.nPorConfirmar})</div>}
                {fraseExcluidas(saldo) && <div className="text-gray-500">{fraseExcluidas(saldo)}</div>}
                {avisoExcluidasEnFactura(saldo) && <div className="text-amber-700 font-bold">⚠ {avisoExcluidasEnFactura(saldo)}</div>}
                {saldo.cargasDescontadas.length + saldo.cargasPorConfirmar.length + saldo.cargasExcluidas.length > 0 && (
                  <button onClick={() => setDetalle((d) => ({ ...d, [cuenta.id]: !d[cuenta.id] }))} className="mt-0.5 text-[#0b315f] font-bold hover:underline">
                    {detalle[cuenta.id] ? "▾ Ocultar las cargas" : "▸ Ver las cargas desde la lectura"}
                  </button>
                )}
              </div>
            )}
            <div className="text-xs text-gray-600 max-w-xs">
              Aviso por correo y WhatsApp al bajar de {umbrales.length ? umbrales.map(S).join(" y ") : "—"} y al agotarse.
              {sinCanal && <div className="text-amber-700 font-bold mt-1">⚠ Sin correos ni teléfonos: el aviso no le llegará a nadie.</div>}
              {cuenta.ultimo_umbral_avisado != null && <div className="mt-1">Último aviso: {S(cuenta.ultimo_umbral_avisado)}{cuenta.ultimo_aviso_en ? ` · ${new Date(cuenta.ultimo_aviso_en).toLocaleString("es-PE")}` : ""}</div>}
            </div>
            <div className="flex flex-wrap gap-2 ml-auto">
              <button onClick={() => setModal({ tipo: "lectura", cuenta })} className="px-3 py-2 rounded-lg text-xs font-bold text-white" style={{ background: "#0b315f" }}>📝 Saldo del portal</button>
              <button onClick={() => setModal({ tipo: "abono", cuenta })} className="px-3 py-2 rounded-lg text-xs font-bold border bg-white">💵 Registrar abono</button>
              <button onClick={() => setModal({ tipo: "config", cuenta })} className="px-3 py-2 rounded-lg text-xs font-bold border bg-white">⚙ Avisos</button>
              <button onClick={() => prueba(cuenta)} className="px-3 py-2 rounded-lg text-xs font-bold border bg-white">✉ Probar aviso</button>
            </div>
            {aviso && <div className="basis-full text-xs text-gray-700">{aviso}</div>}
            {detalle[cuenta.id] && saldo.ancla && <DetalleCargas saldo={saldo} />}
          </section>
        );
      })}
      {modal && (modal.tipo === "config"
        ? <ModalConfig cuenta={modal.cuenta} onCerrar={() => setModal(null)} onGuardado={() => { setModal(null); cargar(); }} />
        : <ModalMovimiento tipo={modal.tipo} cuenta={modal.cuenta} onCerrar={() => setModal(null)} onGuardado={async () => { setModal(null); await comprobar(); cargar(); }} />)}
    </>
  );
}

/**
 * Las cargas detrás del número: las que restan y las de los mismos grifos que NO restan, con su
 * motivo. Sin esta lista «− Cargas: S/ 330.54 (2)» no se puede cotejar, y la única forma de saber
 * si una unidad de tercero se está descontando era adivinar cuáles eran esas dos.
 */
function DetalleCargas({ saldo }: { saldo: Saldo }) {
  // `radar`: la fila es de radar_combustible (id uuid) y no de combustible (id número).
  type Fila = CargaCuenta & { tag: "descuenta" | "radar" | CargaExcluida["motivo"]; radar: boolean };
  const filas: Fila[] = [
    ...saldo.cargasDescontadas.map((c) => ({ ...c, tag: "descuenta" as const, radar: false })),
    ...saldo.cargasPorConfirmar.map((c) => ({ ...c, tag: "radar" as const, radar: true })),
    ...saldo.cargasExcluidas.map((c) => ({ ...c, tag: c.motivo, radar: c.delRadar })),
  ].sort((a, b) => {
    // Lo más reciente arriba. Comparación binaria de las claves ISO, no `localeCompare`.
    const ka = `${a.fecha}|${a.creado_en ?? ""}`, kb = `${b.fecha}|${b.creado_en ?? ""}`;
    return ka === kb ? 0 : ka < kb ? 1 : -1;
  });
  return (
    <div className="basis-full overflow-x-auto">
      <table className="w-full text-xs bg-white/70 rounded-lg">
        <thead>
          <tr className="text-left text-[10px] uppercase tracking-wider text-gray-500">
            <th className="px-2 py-1">Fecha</th>
            <th className="px-2 py-1">Unidad</th>
            <th className="px-2 py-1">Grifo</th>
            <th className="px-2 py-1">Factura</th>
            <th className="px-2 py-1 text-right">Importe</th>
            <th className="px-2 py-1">¿Descuenta?</th>
          </tr>
        </thead>
        <tbody>
          {filas.map((c) => {
            const no = c.tag !== "descuenta" && c.tag !== "radar";
            return (
              <tr key={`${c.radar ? "r" : "c"}${c.id}`} className={`border-t ${no ? "text-gray-500" : ""}`}>
                <td className="px-2 py-1 whitespace-nowrap">{c.fecha}</td>
                <td className="px-2 py-1 whitespace-nowrap font-mono">{c.placa ?? "—"}</td>
                <td className="px-2 py-1">{c.grifo ?? "—"}</td>
                <td className="px-2 py-1 whitespace-nowrap">{c.comprobante ?? "—"}</td>
                <td className={`px-2 py-1 text-right whitespace-nowrap ${no ? "line-through" : "font-bold"}`}>{S(c.total)}</td>
                <td className="px-2 py-1">
                  {c.tag === "descuenta" ? <span className="text-green-700 font-bold">Sí · unidad propia</span>
                    : c.tag === "radar" ? <span className="text-amber-700 font-bold">Sí · propia, del Radar sin confirmar</span>
                    : <span title={MOTIVO_NO_DESCUENTA[c.tag].detalle}>No · {MOTIVO_NO_DESCUENTA[c.tag].corto}{c.radar ? " (Radar)" : ""}</span>}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <p className="text-[11px] text-gray-500 mt-1">
        Solo descuentan las unidades <b>propias</b> (Vehículos): el combustible de una unidad tercerizada lo paga su dueño, aunque cargue en una estación de la cuenta.
        Lo cargado antes de la lectura del {saldo.ancla?.fecha} ya está dentro del saldo del portal.
      </p>
    </div>
  );
}

function Fondo({ children, onCerrar }: { children: React.ReactNode; onCerrar: () => void }) {
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCerrar]);
  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-center justify-center p-4" onClick={onCerrar}>
      <div className="bg-white rounded-2xl p-5 w-full max-w-lg max-h-[90vh] overflow-y-auto space-y-3" onClick={(e) => e.stopPropagation()}>{children}</div>
    </div>
  );
}

function ModalMovimiento({ tipo, cuenta, onCerrar, onGuardado }: {
  tipo: "lectura" | "abono"; cuenta: FilaCuenta; onCerrar: () => void; onGuardado: () => void;
}) {
  const [monto, setMonto] = useState("");
  const [fecha, setFecha] = useState(hoyLima());
  const [operacion, setOperacion] = useState("");
  const [guardando, setGuardando] = useState(false);
  const n = Number(monto.replace(",", "."));
  // Un saldo del portal puede ser 0 o negativo (deuda); un abono no.
  const valido = monto.trim() !== "" && Number.isFinite(n) && (tipo === "lectura" || n > 0);

  async function guardar() {
    setGuardando(true);
    const { data: u } = await supabase.auth.getUser();
    const { error } = await supabase.from("combustible_cuenta_movimientos").insert({
      cuenta_id: cuenta.id, tipo, monto: n, fecha, nro_operacion: operacion.trim() || null, usuario_id: u.user?.id ?? null,
    });
    setGuardando(false);
    if (error) { alert(error.message); return; }
    onGuardado();
  }

  return (
    <Fondo onCerrar={onCerrar}>
      <h3 className="text-lg font-black text-[#0b315f]">{tipo === "lectura" ? `Saldo que dice el portal de ${cuenta.nombre}` : `Abono a ${cuenta.nombre}`}</h3>
      <p className="text-xs text-gray-600">
        {tipo === "lectura"
          ? <>Abre el portal (en Primax Solutions: <b>Estado de cuenta → Disponible (libre)</b>) y copia la cifra. Desde aquí el ERP cuenta: la lectura más reciente MANDA y corrige cualquier diferencia anterior. Hazlo cada vez que mires el portal.</>
          : <>El depósito que hiciste a la cuenta. Se suma al saldo desde la última lectura del portal. Si después lees el portal, esa lectura ya lo incluye.</>}
      </p>
      <label className="block text-xs font-bold text-gray-500">{tipo === "lectura" ? "Disponible (S/)" : "Monto depositado (S/)"}
        <input autoFocus inputMode="decimal" value={monto} onChange={(e) => setMonto(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2 text-lg font-bold" placeholder="5392.76" />
      </label>
      <label className="block text-xs font-bold text-gray-500">Fecha
        <input type="date" value={fecha} onChange={(e) => setFecha(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2" />
      </label>
      {tipo === "abono" && (
        <label className="block text-xs font-bold text-gray-500">Nº de operación (opcional)
          <input value={operacion} onChange={(e) => setOperacion(e.target.value)} className="mt-1 w-full border rounded-lg px-3 py-2" />
        </label>
      )}
      <div className="flex gap-2 justify-end">
        <button onClick={onCerrar} className="px-4 py-2 rounded-lg border text-sm font-bold">Cancelar</button>
        <button disabled={!valido || guardando} onClick={guardar} className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50" style={{ background: "#0b315f" }}>
          {guardando ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </Fondo>
  );
}

function ModalConfig({ cuenta, onCerrar, onGuardado }: { cuenta: FilaCuenta; onCerrar: () => void; onGuardado: () => void }) {
  const [f, setF] = useState({
    nombre: cuenta.nombre,
    umbrales: cuenta.umbrales.join(", "),
    correos: cuenta.avisar_correos ?? "",
    telefonos: cuenta.avisar_telefonos ?? "",
    patrones: cuenta.patrones_grifo.join(", "),
    rucs: cuenta.rucs.join(", "),
    filtro: cuenta.correo_filtro ?? "",
    auto: cuenta.facturas_auto_registrar,
    gracia: String(cuenta.facturas_gracia_dias ?? 1),
    desfase: cuenta.facturas_desfase_dias == null ? "auto" : String(cuenta.facturas_desfase_dias),
  });
  const [guardando, setGuardando] = useState(false);
  const lista = (s: string) => s.split(",").map((x) => x.trim()).filter(Boolean);
  const umbrales = umbralesValidos(lista(f.umbrales).map((x) => Number(x.replace(/[^\d.]/g, ""))));

  async function guardar() {
    setGuardando(true);
    const patch: Record<string, unknown> = {
      nombre: f.nombre.trim() || "Primax",
      umbrales,
      avisar_correos: f.correos.trim() || null,
      avisar_telefonos: f.telefonos.trim() || null,
      patrones_grifo: lista(f.patrones),
      rucs: lista(f.rucs),
      correo_filtro: f.filtro.trim() || "has:attachment",
      facturas_auto_registrar: f.auto,
      facturas_gracia_dias: Math.max(0, Math.min(15, Number(f.gracia) || 0)),
      // Sin combustible-04 la columna no existe: no se manda (el respaldo de abajo cubre el resto).
      ...(cuenta.facturas_desfase_sin_migracion ? {} : { facturas_desfase_dias: normalizarDesfaseConfig(f.desfase === "auto" ? null : f.desfase) }),
      // Cambiar los escalones rearma el ciclo: el próximo cruce se vuelve a avisar.
      ...(umbrales.join() !== cuenta.umbrales.join() ? { ultimo_umbral_avisado: null } : {}),
      updated_at: new Date().toISOString(),
    };
    let { error } = await supabase.from("combustible_cuentas").update(patch).eq("id", cuenta.id);
    let aviso = "";
    if (error && faltaColumna(error, "facturas_desfase_dias")) {
      // combustible-04 sin correr: el resto de la configuración se guarda igual, y se DICE qué no.
      delete patch.facturas_desfase_dias;
      ({ error } = await supabase.from("combustible_cuentas").update(patch).eq("id", cuenta.id));
      if (!error && f.desfase !== "auto") {
        aviso = "Se guardó todo menos el desfase fijo de la factura: falta correr supabase/combustible-04-desfase-factura.sql. Mientras tanto es automático (medido).";
      }
    }
    setGuardando(false);
    if (error) { alert(error.message); return; }
    if (aviso) alert(aviso);
    onGuardado();
  }

  const campo = (k: keyof typeof f, label: string, ayuda?: string, ph?: string) => (
    <label className="block text-xs font-bold text-gray-500">{label}
      <input value={String(f[k])} placeholder={ph} onChange={(e) => setF({ ...f, [k]: e.target.value })} className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal text-gray-900" />
      {ayuda && <span className="block font-normal text-[11px] text-gray-500 mt-0.5">{ayuda}</span>}
    </label>
  );

  return (
    <Fondo onCerrar={onCerrar}>
      <h3 className="text-lg font-black text-[#0b315f]">Avisos de saldo · {cuenta.nombre}</h3>
      {campo("nombre", "Nombre de la cuenta")}
      {campo("umbrales", "Avisar cuando el saldo baje de (S/)", `Separados por coma. Un aviso por escalón; al agotarse (S/ 0) se avisa siempre. Hoy: ${umbrales.length ? umbrales.map(S).join(" · ") : "ninguno"}.`, "500, 300")}
      {campo("correos", "Correos", "Separados por coma.", "administracion@…, operaciones@…")}
      {campo("telefonos", "WhatsApp", "Separados por coma. Sale del número de avisos con la plantilla coordinador_alerta.", "+51 9xx xxx xxx, +51 9xx xxx xxx")}
      <details className="text-xs">
        <summary className="cursor-pointer font-bold text-gray-600">Qué cargas descuentan de esta cuenta</summary>
        <div className="space-y-2 mt-2">
          {campo("patrones", "Nombre del grifo contiene", "Palabras completas. COESTI S.A. opera las estaciones Primax.", "PRIMAX, COESTI")}
          {campo("rucs", "RUC del grifo", undefined, "20127765279")}
          <p className="text-[11px] text-gray-600">
            Y de esas, <b>solo las de unidades propias</b> (Vehículos). Las de unidades tercerizadas se registran en Combustible pero no salen de
            esta cuenta: aunque carguen en una estación Primax, su combustible lo paga su dueño. Tampoco descuenta una recarga del Radar sin
            unidad identificada ni una placa activa en las dos flotas — la tarjeta las enseña aparte en «Ver las cargas».
          </p>
        </div>
      </details>
      <details className="text-xs" open>
        <summary className="cursor-pointer font-bold text-gray-600">Facturas por correo (respaldo del Radar)</summary>
        <div className="space-y-2 mt-2">
          {campo("filtro", "Filtro de Gmail", "Se busca en el correo conectado en la pestaña 📧 Facturas (si no conectaste ninguno, en el Gmail del CRM). Ahí mismo puedes probarlo con «🔎 Probar filtro».", "from:(primax OR coesti) has:attachment")}
          <label className="flex items-center gap-2 text-xs"><input type="checkbox" checked={f.auto} onChange={(e) => setF({ ...f, auto: e.target.checked })} /> Registrar solas las cargas que falten (solo desde el XML de SUNAT, con placa, fecha y cuadre)</label>
          {campo("gracia", "Máximo de días de espera al Radar antes de registrar desde la factura", "Solo se espera si el Radar todavía tiene mensajes SIN PROCESAR desde el día del despacho (pueden traer el voucher, con el kilometraje). Si el Radar está al día y no tiene la carga, se registra desde la factura en cuanto llega; si el voucher aparece después, el Radar propone fusionarlo con ella. Contados desde el despacho.")}
          <label className="block text-xs font-bold text-gray-500">Fecha del despacho en una factura de una sola línea
            <select value={f.desfase} onChange={(e) => setF({ ...f, desfase: e.target.value })} disabled={cuenta.facturas_desfase_sin_migracion}
              className="mt-1 w-full border rounded-lg px-3 py-2 text-sm font-normal text-gray-900 disabled:bg-gray-50">
              <option value="auto">Automático: lo mide el ERP (recomendado)</option>
              <option value="0">La fecha de emisión de la factura (sin desfase)</option>
              {Array.from({ length: MAX_DESFASE }, (_, i) => i + 1).map((k) => (
                <option key={k} value={String(k)}>{k} día{k > 1 ? "s" : ""} antes de la emisión</option>
              ))}
            </select>
            <span className="block font-normal text-[11px] text-gray-500 mt-0.5">
              La factura no trae la fecha del despacho, solo la de emisión (COESTI suele emitirla al día siguiente). En automático el ERP compara las
              recargas que el Radar leyó del voucher con su factura y usa el desfase que se repite; la pestaña 📧 Facturas dice cuál midió y con cuántas.
              La fecha que trae la línea, o la que eliges al confirmar, no se toca.
            </span>
            {cuenta.facturas_desfase_sin_migracion && (
              <span className="block font-normal text-[11px] text-amber-700 mt-0.5">
                Para fijarlo a mano falta correr <code>supabase/combustible-04-desfase-factura.sql</code>. Mientras tanto es automático.
              </span>
            )}
          </label>
        </div>
      </details>
      <div className="flex gap-2 justify-end">
        <button onClick={onCerrar} className="px-4 py-2 rounded-lg border text-sm font-bold">Cancelar</button>
        <button disabled={guardando} onClick={guardar} className="px-4 py-2 rounded-lg text-sm font-bold text-white disabled:opacity-50" style={{ background: "#0b315f" }}>
          {guardando ? "Guardando…" : "Guardar"}
        </button>
      </div>
    </Fondo>
  );
}
