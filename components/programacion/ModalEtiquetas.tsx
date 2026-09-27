"use client";
// ──────────────────────────────────────────────────────────────────────────────
// ModalEtiquetas — poner RUTA, TURNO y MÓVIL a muchos servicios a la vez.
//
// Las etiquetas deciden el ítem de la liquidación (lib/liquidacion-etiquetas.ts). Nadie va
// a teclearlas servicio por servicio, y no hace falta: el ERP las PROPONE —la RUTA sale
// del nombre cuando el nombre dice "RUTA A/ …", el TURNO del orden de salida de cada día,
// el MÓVIL de los buses que salen a la misma hora— y aquí una persona las revisa POR
// GRUPOS y las guarda. Lo que el ERP no puede proponer sin adivinar sale en ámbar con su
// motivo y los campos en blanco.
//
// Tres reglas de esta pantalla:
//   · Se escribe en los DOS tramos del día (la ida y el retorno), porque las etiquetas son
//     del día igual que los PAX. El hermano se busca aunque esté fuera de lo que se ve.
//   · Solo se escribe lo que CAMBIA, y el total se dice antes del botón.
//   · Las etiquetas ya escritas no se tocan salvo que alguien lo pida («Reemplazar»):
//     lo que una persona decidió no lo pisa una propuesta.
//
// Se abre desde Liquidaciones (el periodo del cierre), Programación (las filas marcadas)
// y Seguimiento (los servicios del día).
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { guardarReservas } from "@/lib/reservas-pacto";
import {
  SQL_ETIQUETAS, faltaMigracionEtiquetas, validarEtiquetas, rotuloEtiquetas,
} from "@/lib/liquidacion-etiquetas";
import {
  armarDias, proponerEtiquetas, agruparParaEtiquetar, planDeGuardado, TEXTO_MOTIVO_PROPUESTA,
  type TramoEtq, type DecisionGrupo, type GrupoEtq, type DiaEtq,
} from "@/lib/liquidacion-etiquetas-propuesta";

const COLS_BASE =
  "id,codigo,cliente_id,fecha_servicio,hora_servicio,direccion_servicio,ruta_nombre,origen,destino," +
  "reserva_vinculada_id,estado";
/** Accesorias: si la base no las tiene se suelta la que el error nombra, sin perder la consulta. */
const COLS_OPCIONALES = ["origen_contractual", "capacidad_contratada", "ruta_etiqueta", "turno", "movil"];

type RespuestaTramos = { data: unknown; error: { message: string } | null };
/** Lo único que este modal le pide a la consulta: acotarla por una columna de ids. */
type ConsultaTramos = { in: (columna: string, valores: number[]) => PromiseLike<RespuestaTramos> };

/** Tramos por un filtro, tolerando migraciones accesorias sin correr. */
async function leerTramos(filtrar: (q: ConsultaTramos) => PromiseLike<RespuestaTramos>): Promise<TramoEtq[]> {
  let opc = [...COLS_OPCIONALES];
  for (;;) {
    const r = await filtrar(supabase.from("reservas").select([COLS_BASE, ...opc].join(",")));
    if (!r.error) return (r.data as TramoEtq[] | null) ?? [];
    const mensaje = String(r.error.message);
    const falta = opc.find((c) => new RegExp(`\\b${c}\\b`, "i").test(mensaje));
    if (!falta) return [];
    opc = opc.filter((c) => c !== falta);
  }
}

const dedupe = (xs: TramoEtq[]) => [...new Map(xs.map((t) => [t.id, t])).values()];
const fCorta = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso ?? ""));
  return m ? `${m[3]}/${m[2]}` : "—";
};

export default function ModalEtiquetas({
  titulo, subtitulo, objetivo, contexto, nombreCliente, onCerrar, onGuardado,
}: {
  titulo?: string;
  subtitulo?: string;
  /** Los servicios a etiquetar. Sus hermanos (ida/retorno) se agregan solos. */
  objetivo: TramoEtq[];
  /** Todo lo cargado: con esto se ordenan los turnos del día y se encuentran los hermanos. */
  contexto: TramoEtq[];
  nombreCliente: (id: number | null) => string;
  onCerrar: () => void;
  /** `n` tramos actualizados; `detalle` lo que conviene decir (rechazos, avisos). */
  onGuardado: (n: number, detalle: string) => void;
}) {
  const [extra, setExtra] = useState<TramoEtq[]>([]);
  /** null = todavía se está comprobando: nunca se afirma que falta algo mientras se busca. */
  const [sinMigracion, setSinMigracion] = useState<boolean | null>(null);
  const [buscandoHermanos, setBuscandoHermanos] = useState(true);
  const [reemplazar, setReemplazar] = useState(false);
  const [soloFaltan, setSoloFaltan] = useState(false);
  const [decisiones, setDecisiones] = useState<Map<string, DecisionGrupo>>(new Map());
  const [abiertos, setAbiertos] = useState<Set<string>>(new Set());
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");

  // ── Hermanos fuera de lo que se ve, y ¿existe la migración? ────────────────
  useEffect(() => {
    let vivo = true;
    (async () => {
      const sonda = await supabase.from("reservas").select("ruta_etiqueta").limit(1);
      if (!vivo) return;
      setSinMigracion(!!sonda.error && faltaMigracionEtiquetas(sonda.error.message));

      // El otro tramo del día puede quedar fuera de la ventana cargada (el retorno de un
      // nocturno cae al día siguiente). Sin él, el día se etiquetaría a medias.
      const conocidos = new Set([...contexto, ...objetivo].map((t) => t.id));
      const adelante = [...new Set(objetivo.map((t) => Number(t.reserva_vinculada_id ?? 0)))]
        .filter((id) => id > 0 && !conocidos.has(id));
      const ids = objetivo.map((t) => t.id);
      const nuevos: TramoEtq[] = [];
      for (let i = 0; i < adelante.length; i += 300) {
        const trozo = adelante.slice(i, i + 300);
        nuevos.push(...(await leerTramos((q) => q.in("id", trozo))));
      }
      for (let i = 0; i < ids.length; i += 300) {
        const trozo = ids.slice(i, i + 300);
        nuevos.push(...(await leerTramos((q) => q.in("reserva_vinculada_id", trozo)))
          .filter((t) => !conocidos.has(t.id)));
      }
      if (vivo) setExtra(dedupe(nuevos));
    })()
      .catch(() => { /* best-effort: sin los hermanos de fuera se etiqueta lo que se ve */ })
      .finally(() => { if (vivo) setBuscandoHermanos(false); });
    return () => { vivo = false; };
    // Se consulta una vez al abrir: el modal trabaja sobre la foto con la que se abrió.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Días, propuestas y grupos ─────────────────────────────────────────────
  const universo = useMemo(() => dedupe([...contexto, ...objetivo, ...extra]), [contexto, objetivo, extra]);
  const diasTodos = useMemo(() => proponerEtiquetas(armarDias(universo)), [universo]);
  const idsObjetivo = useMemo(() => new Set(objetivo.map((t) => t.id)), [objetivo]);
  const dias = useMemo(
    () => diasTodos.filter((d) => d.tramos.some((t) => idsObjetivo.has(t.id))),
    [diasTodos, idsObjetivo]);
  const grupos = useMemo(() => {
    const gs = agruparParaEtiquetar(dias, { reemplazar });
    const nombre = (g: GrupoEtq) => nombreCliente(g.cliente_id);
    // Por cliente y, dentro, el orden del motor (lo que falta primero).
    return gs
      .map((g, i) => ({ g, i }))
      .sort((a, b) => nombre(a.g).localeCompare(nombre(b.g)) || a.i - b.i)
      .map((x) => x.g);
  }, [dias, reemplazar, nombreCliente]);

  /** Lo que el operador dejó en cada grupo; si no tocó nada, lo que el ERP propone. */
  const decisionDe = (g: GrupoEtq): DecisionGrupo =>
    decisiones.get(g.clave) ?? { ...g.inicial, aplicar: g.fuente === "propuesta" && g.completo };
  const efectivas = useMemo(
    () => new Map(grupos.map((g) => [g.clave, decisiones.get(g.clave) ?? { ...g.inicial, aplicar: g.fuente === "propuesta" && g.completo }])),
    [grupos, decisiones]);
  const plan = useMemo(() => planDeGuardado(grupos, efectivas), [grupos, efectivas]);

  const cambiar = (g: GrupoEtq, campo: "ruta" | "turno" | "movil", valor: string) =>
    setDecisiones((prev) => new Map(prev).set(g.clave, { ...decisionDe(g), [campo]: valor, aplicar: true }));
  const marcar = (g: GrupoEtq, aplicar: boolean) =>
    setDecisiones((prev) => new Map(prev).set(g.clave, { ...decisionDe(g), aplicar }));
  const marcarPropuestas = () =>
    setDecisiones((prev) => {
      const n = new Map(prev);
      for (const g of grupos)
        if (g.fuente === "propuesta" && validarEtiquetas(decisionDe(g)).ok) n.set(g.clave, { ...decisionDe(g), aplicar: true });
      return n;
    });

  const visibles = soloFaltan ? grupos.filter((g) => g.fuente === "propuesta") : grupos;
  const cuenta = {
    dias: dias.length,
    etiquetados: dias.filter((d) => d.actual.etiquetas).length,
    propuestos: dias.filter((d) => !d.actual.etiquetas && d.motivo === "propuesta").length,
  };
  const porCompletar = cuenta.dias - cuenta.etiquetados - cuenta.propuestos;

  async function guardar() {
    if (!plan.lotes.length || sinMigracion) return;
    if (!confirm(
      `Se escribirán las etiquetas en ${plan.tramos} servicio(s) (${plan.dias} día(s) entre ida y retorno)` +
      (plan.sinCambio ? `; ${plan.sinCambio} ya decían eso y no se tocan` : "") +
      (plan.quitar ? `.\n\nA ${plan.quitar} se les QUITAN las etiquetas (vuelven a agruparse por el nombre)` : "") +
      `.\n\nNo cambia ningún importe: solo decide en qué ítem de la liquidación va cada servicio.\n\n¿Guardar?`
    )) return;
    setGuardando(true); setMsg("");
    let guardados = 0;
    const rechazos: { id: number; motivo: string }[] = [];
    let aviso = "";
    for (const l of plan.lotes) {
      // Sin `cambio`: las etiquetas no son dinero y no levantan acta. Un motivo pegado aquí
      // contaminaría el acta del próximo cambio de importe de esas filas.
      const r = await guardarReservas(supabase, l.ids, l.patch);
      guardados += r.guardados.length;
      rechazos.push(...r.rechazos);
      if (r.aviso) aviso = r.aviso;
    }
    setGuardando(false);
    if (!guardados) {
      setMsg(aviso || rechazos.length
        ? `No se guardó ninguna etiqueta. ${aviso || rechazos[0]?.motivo || ""}`
        : "No se guardó ninguna etiqueta.");
      return;
    }
    onGuardado(
      guardados,
      (rechazos.length ? ` ⚠️ ${rechazos.length} no se pudieron: ${rechazos[0].motivo}` : "") + (aviso ? ` ${aviso}` : ""),
    );
  }

  const errorDe = (g: GrupoEtq) => plan.errores.find((e) => e.clave === g.clave)?.error ?? null;

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-6xl max-h-[92vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b rounded-t-2xl">
          <h3 className="font-black text-[#0b315f]">🏷 {titulo ?? "Etiquetas del ítem de liquidación"}</h3>
          {subtitulo && <p className="text-[11px] text-gray-400">{subtitulo}</p>}
          <p className="text-xs text-gray-500 mt-1">
            Cada ítem de la liquidación es <b>RUTA + TURNO</b> (+ <b>MÓVIL</b> si salen dos buses a la vez),
            con sus <b>PAX contratados</b> y su <b>tarifa</b>. <b>La hora ya no separa ítems</b>: si el turno 1 sale
            a las 04:35 una semana y a las 05:00 la siguiente, suma en el mismo. La RUTA se toma del nombre
            («RUTA A/ …») y el TURNO del orden de salida de cada día (el más temprano es el 1): revisa y guarda.
          </p>
          <p className="text-[11px] text-gray-500 mt-1">
            <b>{cuenta.dias}</b> día(s) · <b>{cuenta.etiquetados}</b> ya etiquetado(s) · <b>{cuenta.propuestos}</b> con propuesta completa
            {porCompletar > 0 && <> · <b className="text-amber-700">{porCompletar} por completar a mano</b></>}
            {buscandoHermanos && <span className="text-gray-400"> · buscando los tramos hermanos…</span>}
          </p>
        </div>

        {sinMigracion && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-[12px] text-amber-900">
            <b>Falta un paso en la base de datos.</b> Las etiquetas todavía no se pueden guardar: hay que correr{" "}
            <code className="font-mono">{SQL_ETIQUETAS}</code> en Supabase. Mientras tanto la liquidación agrupa por el
            nombre de la ruta, como antes.
          </div>
        )}
        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-sm text-amber-900">{msg}</div>}

        <div className="px-5 pt-3 flex flex-wrap items-center gap-3 text-xs">
          <label className="flex items-center gap-1.5 text-gray-600" title="Las etiquetas ya escritas no se tocan salvo que lo pidas.">
            <input type="checkbox" checked={reemplazar} onChange={(e) => { setReemplazar(e.target.checked); setDecisiones(new Map()); }} />
            Reemplazar también las que ya están etiquetadas por la propuesta
          </label>
          <label className="flex items-center gap-1.5 text-gray-600">
            <input type="checkbox" checked={soloFaltan} onChange={(e) => setSoloFaltan(e.target.checked)} />
            Ver solo lo que falta etiquetar
          </label>
          <button onClick={marcarPropuestas}
            className="ml-auto px-2.5 py-1 rounded-lg border bg-white font-bold text-[#0b315f] hover:bg-gray-50">
            Marcar todas las propuestas completas
          </button>
        </div>

        <div className="flex-1 overflow-auto p-5 space-y-2">
          {visibles.length === 0 && (
            <div className="py-10 text-center text-gray-400 text-sm">
              {grupos.length ? "Todo lo que ves ya está etiquetado." : "No hay servicios para etiquetar."}
            </div>
          )}
          {visibles.map((g) => {
            const d = decisionDe(g);
            const v = validarEtiquetas(d);
            const error = d.aplicar ? errorDe(g) : null;
            const abierto = abiertos.has(g.clave);
            const tono = g.fuente === "actual" ? "border-gray-200" : g.completo ? "border-sky-200" : "border-amber-300";
            return (
              <div key={g.clave} className={`rounded-xl border ${tono} ${d.aplicar ? "bg-white" : "bg-gray-50/60"}`}>
                <div className="flex flex-wrap items-start gap-3 px-3 py-2">
                  <input type="checkbox" className="mt-2" checked={d.aplicar} onChange={(e) => marcar(g, e.target.checked)} />
                  <div className="flex items-end gap-1.5">
                    <label className="text-[9px] font-black text-gray-400 uppercase">Ruta
                      <input value={d.ruta} onChange={(e) => cambiar(g, "ruta", e.target.value)} placeholder="RUTA A"
                        className="block w-28 mt-0.5 border rounded-lg px-2 py-1 text-xs font-bold text-[#0b315f] uppercase" />
                    </label>
                    <label className="text-[9px] font-black text-gray-400 uppercase">Turno
                      <input value={d.turno} onChange={(e) => cambiar(g, "turno", e.target.value)} placeholder="1" inputMode="numeric"
                        className="block w-14 mt-0.5 border rounded-lg px-2 py-1 text-xs font-bold text-[#0b315f]" />
                    </label>
                    <label className="text-[9px] font-black text-gray-400 uppercase" title="Solo si salen 2 o más buses a la vez en la misma ruta y turno. Vacío = un solo bus.">Móvil
                      <input value={d.movil} onChange={(e) => cambiar(g, "movil", e.target.value)} placeholder="—" inputMode="numeric"
                        className="block w-14 mt-0.5 border rounded-lg px-2 py-1 text-xs font-bold text-[#0b315f]" />
                    </label>
                  </div>
                  <div className="flex-1 min-w-[16rem] text-xs">
                    <div className="flex flex-wrap items-center gap-1.5">
                      <b className="text-gray-800">{nombreCliente(g.cliente_id)}</b>
                      <span className="text-gray-500">· {g.dias.length} día(s) · {fCorta(g.desde)}{g.hasta !== g.desde ? ` al ${fCorta(g.hasta)}` : ""}</span>
                      {g.fuente === "actual" ? (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-gray-100 text-gray-500">YA ETIQUETADO</span>
                      ) : g.completo ? (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-sky-100 text-sky-800">PROPUESTA DEL ERP</span>
                      ) : (
                        <span className="text-[9px] font-black px-1.5 py-0.5 rounded-full bg-amber-100 text-amber-800">COMPLÉTALO</span>
                      )}
                      {v.ok && v.etiquetas && (
                        <span className="text-[10px] text-gray-500">→ <b className="text-[#075985]">{rotuloEtiquetas(v.etiquetas, g.paxes.length === 1 ? g.paxes[0] : null)}</b></span>
                      )}
                      {v.ok && !v.etiquetas && g.fuente === "actual" && d.aplicar && (
                        <span className="text-[10px] font-bold text-amber-700">→ se quitan las etiquetas</span>
                      )}
                    </div>
                    <div className="text-[11px] text-gray-500 mt-0.5">
                      Salidas: {g.horas.length ? g.horas.map((h) => `${h.hora}${h.dias > 1 ? ` ×${h.dias}` : ""}`).join(" · ") : "sin hora"}
                      {" · "}PAX contratados: {g.paxes.length ? g.paxes.join(" / ") : "sin dato en el servicio"}
                      {g.paxes.length > 1 && <b className="text-amber-700"> (distintos: saldrán en ítems separados)</b>}
                    </div>
                    {g.nombres[0] && (
                      <div className="text-[11px] text-gray-400 truncate" title={g.nombres.map((n) => `${n.nombre} (${n.dias})`).join("\n")}>
                        {g.nombres[0].nombre}{g.nombres.length > 1 ? ` · y ${g.nombres.length - 1} nombre(s) más` : ""}
                      </div>
                    )}
                    {g.motivos.map((m) => (
                      <div key={m.motivo} className="text-[11px] text-amber-800">⚠ {m.dias} día(s): {TEXTO_MOTIVO_PROPUESTA[m.motivo]}</div>
                    ))}
                    {g.conflictos > 0 && (
                      <div className="text-[11px] text-amber-800">⚠ {g.conflictos} día(s) con la ida y el retorno etiquetados distinto: al guardar quedan iguales.</div>
                    )}
                    {g.aMedio > 0 && (
                      <div className="text-[11px] text-gray-500">{g.aMedio} día(s) con un solo tramo etiquetado: al guardar se completa el otro.</div>
                    )}
                    {error && <div className="text-[11px] font-bold text-red-700">{error}</div>}
                    <button type="button"
                      onClick={() => setAbiertos((s) => { const n = new Set(s); if (n.has(g.clave)) n.delete(g.clave); else n.add(g.clave); return n; })}
                      className="mt-0.5 text-[11px] underline decoration-dotted text-gray-500 hover:text-gray-800">
                      {abierto ? "▲ ocultar los días" : `▼ ver los ${g.dias.length} día(s)`}
                    </button>
                    {abierto && <ListaDias dias={g.dias} />}
                  </div>
                </div>
              </div>
            );
          })}
        </div>

        <div className="px-5 py-4 border-t flex flex-wrap gap-2 justify-end items-center rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500">
            {plan.tramos
              ? <>Se escribirán <b>{plan.tramos}</b> servicio(s) de <b>{plan.dias}</b> día(s)</>
              : "Nada que escribir todavía"}
            {plan.sinCambio > 0 && <> · {plan.sinCambio} ya estaban así</>}
            {plan.errores.length > 0 && <span className="text-red-600 font-semibold"> · {plan.errores.length} grupo(s) marcados con datos incompletos</span>}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !plan.lotes.length || !!sinMigracion || plan.errores.length > 0}
            title={plan.errores.length ? "Completa o desmarca los grupos en rojo" : undefined}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-40">
            {guardando ? "Guardando…" : `Guardar etiquetas${plan.tramos ? ` (${plan.tramos})` : ""}`}
          </button>
        </div>
      </div>
    </div>
  );
}

/** El detalle de un grupo: para verificar la propuesta contra los días de verdad. */
function ListaDias({ dias }: { dias: DiaEtq[] }) {
  const orden = [...dias].sort((a, b) =>
    String(a.fecha ?? "").localeCompare(String(b.fecha ?? "")) || String(a.horaIda ?? a.horaRetorno ?? "").localeCompare(String(b.horaIda ?? b.horaRetorno ?? "")));
  const muestra = orden.slice(0, 80);
  return (
    <div className="mt-1 max-h-56 overflow-auto rounded-lg border bg-gray-50 px-2 py-1 space-y-0.5">
      {muestra.map((d) => (
        <div key={d.clave} className="text-[10px] text-gray-600 flex flex-wrap gap-x-2">
          <span className="font-mono text-gray-500">{fCorta(d.fecha)}</span>
          <span className="font-bold">{d.horaIda ?? "—"}{d.horaRetorno ? ` ↩ ${d.horaRetorno}` : ""}</span>
          <span className="font-mono text-gray-400">{d.tramos.map((t) => t.codigo ?? `#${t.id}`).join(" + ")}</span>
          <span className="truncate max-w-[22rem]">{d.nombre ?? "sin nombre de ruta"}</span>
          {d.actual.etiquetas && <span className="text-sky-700">hoy: {rotuloEtiquetas(d.actual.etiquetas)}</span>}
          {d.adicional && <span className="text-amber-700">adicional</span>}
        </div>
      ))}
      {orden.length > muestra.length && <div className="text-[10px] text-gray-400">y {orden.length - muestra.length} más…</div>}
    </div>
  );
}
