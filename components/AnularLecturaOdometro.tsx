"use client";

// Modal de ANULACIÓN de una lectura de odómetro ya registrada (típicamente una
// "aceptada" que estaba mal y contaminó el km vigente).
//
// No borra la fila: exige un motivo tipificado + el km correcto, guarda todo en
// `odometro_correcciones` (bitácora y a la vez dataset que la IA de visión recibe
// como ejemplos), deja la lectura en estado "anulada" con su foto como evidencia y
// recalcula el km vigente — ver lib/odometro.ts → anularLectura().
//
// Lo usan app/mantenimiento/_tabs/OdometroTab.tsx (flota propia) y
// app/tercerizadas/_components/OdometroTerceroModal.tsx (terceros).

import React, { useEffect, useMemo, useState } from "react";
import { supabase } from "@/lib/supabase";
import { anularLectura, reasignarLectura, rejuzgarLectura, MOTIVOS_ANULACION, type MotivoAnulacion, type Flota } from "@/lib/odometro";
import {
  MOTIVO_DECIMAS, leerKmConDecima, esDecimaLeidaComoKm, kmSinDecima, lecturasConDecima,
  type TamborDecimas, type LecturaEnEscala,
} from "@/lib/odometro-decimas";
import { ImgPrivada, EnlacePrivado } from "@/components/ArchivoPrivado";

export type LecturaAnulable = {
  id: string; km: number; fecha: string; fuente: string; foto_url: string | null; estado: string;
};

export default function AnularLecturaOdometro({
  lectura, placa, onClose, onAnulada, motivoInicial, destinoInicial, aviso,
}: {
  lectura: LecturaAnulable;
  placa: string;
  onClose: () => void;
  onAnulada: (kmVigente: number | null) => void;
  /** Abre con un motivo ya elegido (p. ej. «Foto de otra unidad» desde la auditoría de placas del Radar). */
  motivoInicial?: MotivoAnulacion;
  /** Placa propuesta para «Foto de otra unidad»: se puede cambiar o vaciar antes de confirmar. */
  destinoInicial?: string;
  /** Por qué se abrió el modal (la frase de la auditoría): se enseña arriba, tal cual. */
  aviso?: string | null;
}) {
  const [motivo, setMotivo]   = useState<MotivoAnulacion | "">(motivoInicial ?? "");
  const [nota, setNota]       = useState("");
  const [kmOk, setKmOk]       = useState("");
  const [confirmar, setConfirmar] = useState(false);   // 2º paso: confirmación explícita
  const [guardando, setGuardando] = useState(false);
  // "Foto de otra unidad": la lectura está BIEN leída, solo se grabó en la unidad equivocada.
  // Se ofrece pasarla a la correcta en vez de solo anularla (y perder el km y su foto).
  const [unidades, setUnidades] = useState<{ id: number; placa: string; flota: Flota }[] | null>(null);
  const [destinoTxt, setDestinoTxt] = useState(destinoInicial ?? "");
  // Las demás lecturas de la unidad, para ofrecer corregir juntas las que llevan la décima metida
  // como cifra. null = todavía no se pidieron (o se están pidiendo); "error" = no se pudieron leer.
  const [lecturasUnidad, setLecturasUnidad] = useState<LecturaEnEscala[] | "error" | null>(null);
  const [corregirLote, setCorregirLote] = useState(false);

  // Carriles donde el número lo propuso una lectura automática. Debe coincidir con FUENTES_IA
  // de lib/odometro.ts (leccionesOdometro): es el mismo criterio que decide qué correcciones
  // se le enseñan a la IA, así que si aquí dijera otra cosa el aviso mentiría.
  const esIA = ["whatsapp_foto", "whatsapp_manual", "checklist", "servicio", "combustible"].includes(String(lectura.fuente));
  const kmFmt = Number(lectura.km).toLocaleString("es-PE");

  const motivoCfg = MOTIVOS_ANULACION.find(m => m.id === motivo) || null;
  // Espejo de MOTIVOS_NO_ENSENAN en lib/odometro.ts: todo lo que salió de un carril de IA
  // enseña, salvo los motivos que describen un acierto de la IA o un hecho del mundo.
  const ensenaEsteCaso = !!motivo && !["duplicada", "otra_unidad", "reinicio"].includes(motivo);
  const pideKm = !!motivoCfg?.corrige;                 // este motivo corrige el número
  const kmObligatorio = pideKm && motivo !== "otro";   // en "otro" el km es opcional
  const esReinicio = motivo === "reinicio";            // no anula: re-ancla el vigente a este km
  const esOtraUnidad = motivo === "otra_unidad";
  const esMotivoDecimas = motivo === MOTIVO_DECIMAS;

  useEffect(() => {
    if (!esOtraUnidad || unidades) return;
    (async () => {
      const [p, t] = await Promise.all([
        supabase.from("vehiculos").select("id,placa").order("placa"),
        supabase.from("vehiculos_tercero").select("id,placa").order("placa"),
      ]);
      setUnidades([
        ...((p.data || []) as any[]).map(v => ({ id: Number(v.id), placa: String(v.placa), flota: "propia" as Flota })),
        ...((t.data || []) as any[]).map(v => ({ id: Number(v.id), placa: String(v.placa), flota: "tercero" as Flota })),
      ].filter(u => u.placa));
    })();
  }, [esOtraUnidad, unidades]);

  const normPlaca = (x: string) => x.toUpperCase().replace(/[^A-Z0-9]/g, "");
  // La placa se escribe o se elige de la lista; solo vale si coincide EXACTO con una unidad, y
  // nunca con la misma en la que ya está la lectura.
  const destino = useMemo(() => {
    const q = normPlaca(destinoTxt);
    if (!q || !unidades) return null;
    const hits = unidades.filter(u => normPlaca(u.placa) === q);
    return hits.length === 1 ? hits[0] : null;
  }, [destinoTxt, unidades]);
  const destinoEsLaMisma = !!destino && normPlaca(destino.placa) === normPlaca(placa);
  const destinoInvalido = esOtraUnidad && !!destinoTxt.trim() && (!destino || destinoEsLaMisma);
  const vaAReasignar = esOtraUnidad && !!destino && !destinoEsLaMisma;

  // Validación del km correcto ingresado. Se acepta con su décima («560243.2»): el ERP guarda km
  // ENTEROS, así que la décima se descarta (se trunca, nunca se redondea), pero sirve para reconocer
  // el caso del tambor de décimas leído como un km más (lib/odometro-decimas.ts).
  const entrada = leerKmConDecima(kmOk);
  const kmNum = entrada?.km ?? null;
  const kmValido = kmNum != null && kmNum > 0;
  const kmIgual = kmValido && kmNum === Number(lectura.km);
  const kmOkFmt = kmValido ? kmNum!.toLocaleString("es-PE") : "";
  // Lo escrito es la lectura de la IA con la décima en su sitio: 5,602,432 → «560243.2».
  const esDecima = esDecimaLeidaComoKm(Number(lectura.km), entrada);
  const kmSinUltima = kmSinDecima(Number(lectura.km));

  // El tambor de décimas que esta corrección declara: con él se buscan las OTRAS lecturas de la
  // unidad que llevan la décima metida, para corregirlas juntas. Solo con un número bueno escrito.
  const tamborModal: TamborDecimas | null = useMemo(() => {
    if (!pideKm || !kmValido || kmIgual || !(esMotivoDecimas || esDecima)) return null;
    return { kmCorrecto: kmNum!, cifras: String(kmNum!).length, fecha: null, por: "motivo" };
  }, [pideKm, kmValido, kmIgual, esMotivoDecimas, esDecima, kmNum]);

  useEffect(() => {
    if (!tamborModal || lecturasUnidad !== null) return;
    let vivo = true;
    (async () => {
      try {
        // select("*"): migration-safe con vehiculo_tercero_id (mismo criterio que aceptarLectura).
        const { data: l, error: eL } = await supabase.from("lecturas_odometro").select("*").eq("id", lectura.id).single();
        if (eL || !l) throw new Error(eL?.message || "sin lectura");
        const fila = l as { vehiculo_id?: number | null; vehiculo_tercero_id?: number | null };
        const fk = fila.vehiculo_tercero_id != null ? "vehiculo_tercero_id" : "vehiculo_id";
        const vid = fila[fk];
        // Todas, paginadas con orden total: una lista cortada callaría lecturas que sí hay que corregir.
        const todas: LecturaEnEscala[] = [];
        for (let desde = 0; desde < 20_000; desde += 1000) {
          const { data, error } = await supabase.from("lecturas_odometro")
            .select("id, km, estado, fecha, ref_origen").eq(fk, vid)
            .order("fecha", { ascending: true }).order("id", { ascending: true })
            .range(desde, desde + 999);
          if (error) throw new Error(error.message);
          type Fila = { id: string | number; km: number; estado: string | null; fecha: string | null; ref_origen: string | null };
          todas.push(...((data || []) as Fila[]).map(f => ({
            id: String(f.id), km: Number(f.km), estado: String(f.estado ?? ""), fecha: f.fecha ?? null, ref_origen: f.ref_origen ?? null,
          })));
          if (!data || data.length < 1000) break;
        }
        if (vivo) setLecturasUnidad(todas);
      } catch {
        if (vivo) setLecturasUnidad("error");
      }
    })();
    return () => { vivo = false; };
  }, [tamborModal, lecturasUnidad, lectura.id]);

  const otrasConDecima = useMemo(
    () => (tamborModal && Array.isArray(lecturasUnidad) ? lecturasConDecima(lecturasUnidad, tamborModal, lectura.id) : []),
    [tamborModal, lecturasUnidad, lectura.id],
  );
  const vaLote = corregirLote && otrasConDecima.length > 0;

  // Se puede continuar según el motivo:
  //  - no correctivo → basta el motivo (el km escrito, si quedó de otro motivo, se ignora).
  //  - correctivo obligatorio → km válido y distinto al mal leído.
  //  - correctivo opcional ("otro") → km vacío, o válido y distinto.
  const puedeSeguir = !!motivo && !destinoInvalido && (
    !pideKm ? true
    : kmObligatorio ? (kmValido && !kmIgual)
    : (!kmOk.trim() || (kmValido && !kmIgual))
  );
  // Solo se registra lectura corregida si el motivo corrige y el km es válido y distinto.
  const vaACorregir = pideKm && kmValido && !kmIgual;

  const anular = async () => {
    if (!motivo || !puedeSeguir) return;
    setGuardando(true);
    try {
      const { data: sess } = await supabase.auth.getSession();
      if (vaAReasignar) {
        const rr = await reasignarLectura(supabase, {
          lecturaId: lectura.id,
          destino: { vehiculo_id: destino!.id, flota: destino!.flota, placa: destino!.placa },
          placaOrigen: placa,
          nota: nota.trim() || null,
          usuario: sess?.session?.user?.email || null,
        });
        if (!rr.ok) throw new Error(rr.error || "No se pudo reasignar");
        if (rr.estadoDestino && rr.estadoDestino !== "aceptada") {
          alert(`Se pasó a ${destino!.placa}, pero allí quedó "${rr.estadoDestino}": ${rr.motivoDestino ?? "fuera de rango"}. Revísala en "Lecturas por revisar".`);
        }
        onAnulada(rr.kmVigenteOrigen ?? null);
        onClose();
        return;
      }
      const usuario = sess?.session?.user?.email || null;
      const r = await anularLectura(supabase, {
        lecturaId: lectura.id,
        motivo_tipo: motivo,
        nota: nota.trim() || null,
        // el km solo aplica a motivos correctivos (evita arrastrar un valor tecleado
        // antes de cambiar a un motivo que no corrige el número)
        km_correcto: pideKm && kmValido ? kmNum : null,
        usuario,
        placa,
      });
      if (!r.ok) throw new Error(r.error || "No se pudo anular");
      let kmVigente = r.kmVigente ?? null;

      // Las OTRAS lecturas con la décima metida, si se pidió. Las aceptadas quedan aceptadas con el
      // km bueno; las que estaban por revisar siguen por revisar —nadie miró cada foto— y se vuelven
      // a juzgar contra sus vecinas cuando ya están todas en la escala buena.
      if (vaLote) {
        const fallos: string[] = [];
        const porRejuzgar: { id: string; km: number; kmNuevo: number }[] = [];
        for (const o of otrasConDecima) {
          const rr = await anularLectura(supabase, {
            lecturaId: o.id,
            motivo_tipo: MOTIVO_DECIMAS,
            nota: `En lote, desde la lectura del ${lectura.fecha}: el último tambor marca décimas`,
            km_correcto: o.kmNuevo,
            usuario,
            placa,
            estadoCorregida: o.estado === "aceptada" ? "aceptada" : "sospechosa",
          });
          if (!rr.ok) { fallos.push(`${o.fecha ?? "?"} · ${o.km.toLocaleString("es-PE")}: ${rr.error ?? "error"}`); continue; }
          if (rr.kmVigente !== undefined) kmVigente = rr.kmVigente ?? null;
          if (o.estado !== "aceptada" && rr.lecturaCorregidaId) porRejuzgar.push({ id: rr.lecturaCorregidaId, km: o.km, kmNuevo: o.kmNuevo });
        }
        for (const x of porRejuzgar) {
          const j = await rejuzgarLectura(supabase, x.id,
            `Décima quitada (${x.km.toLocaleString("es-PE")} → ${x.kmNuevo.toLocaleString("es-PE")})`);
          if (!j.ok) fallos.push(`no se pudo volver a juzgar la de ${x.kmNuevo.toLocaleString("es-PE")} km: ${j.error ?? "error"}`);
        }
        if (fallos.length) {
          alert(`Se corrigió esta lectura, pero ${fallos.length} de las demás no:\n\n${fallos.slice(0, 8).join("\n")}` +
            `${fallos.length > 8 ? `\n… y ${fallos.length - 8} más` : ""}\n\nVuelve a abrir una de ellas: se ofrecerán otra vez.`);
        }
      }
      onAnulada(kmVigente);
      onClose();
    } catch (e: any) {
      alert("Error: " + e.message);
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 p-4" onClick={onClose}>
      <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={e => e.stopPropagation()}>
        <div className="px-6 py-4 border-b">
          <h3 className="font-bold text-gray-900">¿Qué pasó con esta lectura?</h3>
          <p className="text-xs text-gray-500 mt-0.5">
            <span className="font-mono font-bold">{placa}</span> · <span className="font-mono">{kmFmt} km</span> · {lectura.fecha}
            {" — "}corrige el número (y enseña a la IA) o descártala con un motivo.
          </p>
        </div>

        <div className="p-6 space-y-4">
          {aviso && (
            <p className="text-xs text-[#7A271A] bg-[#FEF3F2] border border-[#F3B8B3] rounded-xl p-3">⚠ {aviso}</p>
          )}
          {lectura.foto_url && (
            <EnlacePrivado href={lectura.foto_url} target="_blank" rel="noreferrer" className="block">
              <ImgPrivada src={lectura.foto_url} alt="Tablero" className="w-full max-h-48 object-contain rounded-xl border bg-gray-50" />
            </EnlacePrivado>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1.5">¿Cuál fue el error? *</label>
            <div className="flex flex-wrap gap-1.5">
              {MOTIVOS_ANULACION.map(m => (
                <button key={m.id} type="button" onClick={() => setMotivo(m.id)}
                  className={`px-3 py-1.5 rounded-xl text-xs font-bold border transition-all ${
                    motivo === m.id ? "text-white border-transparent" : "text-gray-600 border-gray-200 hover:bg-gray-50"}`}
                  style={motivo === m.id ? { background: "#0b315f" } : undefined}>
                  {m.label}
                </button>
              ))}
            </div>
            {/* Qué se le enseña a la IA y qué no. Antes solo se confirmaba el caso bueno y se
                callaba el malo: el operador reformulaba la corrección creyendo que enseñaba y
                se archivaba en silencio. Ahora el aviso dice siempre en qué caso está. */}
            {motivo && esIA && ensenaEsteCaso && (
              <p className="text-[11px] text-green-700 mt-1.5">
                🤖 Esto se le enseña a la IA: {nota.trim()
                  ? "tu explicación se usará en las próximas lecturas de esta placa."
                  : "escribe abajo DÓNDE está el odómetro en este tablero y lo aplicará la próxima vez."}
              </p>
            )}
            {motivo && esIA && !ensenaEsteCaso && (
              <p className="text-[11px] text-amber-700 mt-1.5">
                Este motivo no le enseña nada a la IA (describe un problema de flujo, no una lectura mal hecha).
                Si el número lo leyó mal, elige otro motivo y explica en el detalle dónde está el odómetro.
              </p>
            )}
            {motivo && !esIA && (
              <p className="text-[11px] text-gray-500 mt-1.5">Esta lectura no la propuso la IA, así que no se usa como ejemplo.</p>
            )}
          </div>

          {/* KM CORRECTO — prominente cuando el motivo corrige el número */}
          {pideKm && (
            <div className="rounded-xl border-2 border-[#0b315f]/15 bg-[#0b315f]/[0.03] p-4">
              <label className="block text-xs font-bold text-[#0b315f] mb-1.5">
                ¿Cuál es la lectura correcta? {kmObligatorio ? <span className="text-red-500">*</span> : <span className="text-gray-400 font-normal">(opcional)</span>}
              </label>
              <div className="flex items-center gap-2">
                {/* Texto y no `number`: así se puede escribir la décima con punto o con coma
                    («560243.2» / «560243,2»), que es justo como se ve un tablero de tambores. */}
                <input type="text" inputMode="decimal" autoFocus value={kmOk}
                  onChange={e => setKmOk(e.target.value)}
                  placeholder={esMotivoDecimas ? `Como en la foto, con la décima: ${kmSinUltima}.${String(lectura.km).slice(-1)}` : `Se leyó ${kmFmt}`}
                  className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-base font-mono focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30 focus:border-[#0b315f]" />
                <span className="text-sm font-bold text-gray-400">km</span>
              </div>
              {kmOk.trim() && !kmValido && (
                <p className="text-[11px] text-red-600 mt-1.5">
                  Escribe el kilometraje con números. Si el tablero tiene décima, va después de un punto o una coma (por ejemplo 560243.2).
                </p>
              )}
              {kmIgual && <p className="text-[11px] text-amber-700 mt-1.5">Es el mismo número que ya estaba: no habría nada que corregir.</p>}
              {vaACorregir && (
                <p className="text-[11px] text-green-700 mt-1.5">
                  ✓ Se registrará <b className="font-mono">{kmOkFmt} km</b> como lectura corregida{lectura.foto_url ? ", con esta misma foto" : ""}. El km vigente se recalcula con ese valor.
                  {entrada?.decima != null && (
                    <> La décima (<b className="font-mono">.{entrada.decima}</b>) no se guarda: el ERP lleva el odómetro en kilómetros enteros, y la décima no se redondea.</>
                  )}
                </p>
              )}
              {/* Lo escrito es la lectura de la IA con la décima en su sitio: que el motivo lo diga,
                  porque es el motivo el que deja al ERP recordando el tambor de esta unidad. */}
              {vaACorregir && esDecima && !esMotivoDecimas && (
                <div className="mt-2 rounded-lg bg-blue-50 border border-blue-200 p-2.5 text-[11px] text-blue-900">
                  Es la <b>décima</b>: el último tambor de este tablero la marca y la IA lo leyó como un km más.
                  <button type="button" onClick={() => setMotivo(MOTIVO_DECIMAS)}
                    className="ml-1 underline font-bold hover:no-underline">
                    Marcar «La IA leyó la décima como km»
                  </button>
                  {" "}— así el ERP lo recuerda para {placa} y quita la décima solo en las próximas lecturas.
                </div>
              )}
              {esMotivoDecimas && (
                <p className="text-[11px] text-blue-800 mt-1.5">
                  🔟 El ERP recordará que el tablero de <b className="font-mono">{placa}</b> tiene tambor de décimas:
                  en las próximas lecturas de esta unidad, la cifra de más se quita sola.
                  {kmValido && !kmIgual && !esDecima && kmNum !== kmSinUltima && (
                    <span className="block text-amber-700 mt-1">
                      Ojo: {kmOkFmt} no es la lectura de la IA sin su última cifra ({kmSinUltima.toLocaleString("es-PE")}). Revisa el número contra la foto.
                    </span>
                  )}
                </p>
              )}
            </div>
          )}

          {/* LAS OTRAS LECTURAS DE LA UNIDAD CON LA DÉCIMA METIDA COMO CIFRA: se ofrecen juntas, nunca
              se corrigen solas (la casilla nace apagada y la lista está a la vista). */}
          {tamborModal && (
            <div className="rounded-xl border border-blue-200 bg-blue-50/60 p-4 text-[11px] text-blue-950">
              {lecturasUnidad === null && <p className="text-gray-500">Buscando otras lecturas de {placa} con la décima metida…</p>}
              {lecturasUnidad === "error" && (
                <p className="text-amber-700">No se pudieron leer las demás lecturas de {placa}: corrige esta y vuelve a abrir otra para ver las que quedan.</p>
              )}
              {Array.isArray(lecturasUnidad) && otrasConDecima.length === 0 && (
                <p className="text-gray-600">No hay más lecturas de {placa} con la décima metida como cifra.</p>
              )}
              {otrasConDecima.length > 0 && (
                <>
                  <p className="font-bold text-blue-900">
                    {placa} tiene {otrasConDecima.length} lectura{otrasConDecima.length === 1 ? "" : "s"} más con la décima metida como cifra
                  </p>
                  <ul className="mt-1.5 max-h-32 overflow-y-auto font-mono space-y-0.5">
                    {otrasConDecima.map(o => (
                      <li key={o.id}>
                        {o.fecha ?? "—"} · {o.km.toLocaleString("es-PE")} → <b>{o.kmNuevo.toLocaleString("es-PE")}</b>
                        <span className="font-sans text-gray-500"> · {o.estado === "aceptada" ? "aceptada" : "por revisar"}</span>
                      </li>
                    ))}
                  </ul>
                  <label className="mt-2 flex items-start gap-2 cursor-pointer">
                    <input type="checkbox" checked={corregirLote} onChange={e => setCorregirLote(e.target.checked)} className="mt-0.5" />
                    <span>
                      <b>Corregir también estas {otrasConDecima.length}</b>, quitándoles la décima. Las aceptadas quedan aceptadas
                      con el km bueno; las que estaban por revisar siguen por revisar —ya con el km bueno— y la bandeja dice si cuadran.
                    </span>
                  </label>
                </>
              )}
            </div>
          )}

          {esOtraUnidad && (
            <div className="rounded-xl border-2 border-[#0b315f]/15 bg-[#0b315f]/[0.03] p-4">
              <label className="block text-xs font-bold text-[#0b315f] mb-1.5">
                ¿De qué unidad es? <span className="text-gray-400 font-normal">(opcional — si no lo sabes, déjalo vacío y solo se anula)</span>
              </label>
              <input value={destinoTxt} onChange={e => setDestinoTxt(e.target.value)} list="placas-reasignar" autoFocus
                placeholder={unidades ? "Escribe o elige la placa, ej. BUI-272" : "Cargando unidades…"}
                className="w-full border border-gray-300 rounded-xl px-3 py-2.5 text-base font-mono uppercase focus:outline-none focus:ring-2 focus:ring-[#0b315f]/30 focus:border-[#0b315f]" />
              <datalist id="placas-reasignar">
                {(unidades || []).map(u => <option key={`${u.flota}:${u.id}`} value={u.placa}>{u.flota === "tercero" ? "Tercerizada" : "Flota propia"}</option>)}
              </datalist>
              {destinoTxt.trim() && unidades && !destino && <p className="text-[11px] text-red-600 mt-1.5">Esa placa no está registrada ni en la flota propia ni en la tercerizada.</p>}
              {destinoEsLaMisma && <p className="text-[11px] text-red-600 mt-1.5">Es la misma unidad en la que ya está la lectura.</p>}
              {vaAReasignar && (
                <p className="text-[11px] text-green-700 mt-1.5">
                  ✓ Se pasará <b className="font-mono">{kmFmt} km</b>{lectura.foto_url ? " con esta foto" : ""} a <b className="font-mono">{destino!.placa}</b>
                  {destino!.flota === "tercero" ? " (tercerizada)" : ""} con su misma fecha y hora, y se anulará en <b className="font-mono">{placa}</b>.
                  En {destino!.placa} se valida igual que cualquier lectura: si no cuadra, queda por revisar.
                </p>
              )}
            </div>
          )}

          <div>
            <label className="block text-[11px] font-bold uppercase tracking-wide text-gray-400 mb-1">Detalle (opcional)</label>
            <input value={nota} onChange={e => setNota(e.target.value)} placeholder="Ej: el odómetro está debajo del texto km, antes del ícono de combustible"
              className="w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20" />
          </div>

          {esReinicio && (
            <p className="text-[11px] text-blue-700 bg-blue-50 rounded-xl p-3">
              Se marcará esta lectura como el <b>nuevo tablero</b> y el km vigente se re-anclará a
              <b className="font-mono"> {kmFmt} km</b> (no se pierde: queda como reinicio).
            </p>
          )}
          {!pideKm && !esReinicio && !vaAReasignar && lectura.estado === "aceptada" && (
            <p className="text-[11px] text-gray-500 bg-gray-50 rounded-xl p-3">
              La lectura no se borra: queda como <b>anulada</b> con su foto. El km vigente se recalcula
              con las lecturas que quedan.
            </p>
          )}
        </div>

        <div className="px-6 py-4 border-t flex items-center justify-end gap-2">
          <button onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-bold text-gray-500 hover:bg-gray-100">Cancelar</button>
          {!confirmar ? (
            <button onClick={() => setConfirmar(true)} disabled={!puedeSeguir}
              className={`px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-40 hover:opacity-90 ${esReinicio ? "bg-blue-600" : "bg-red-600"}`}>
              {esReinicio ? "Marcar reinicio" : vaAReasignar ? `Pasar a ${destino!.placa}` : vaACorregir ? "Corregir lectura" : "Anular lectura"}
            </button>
          ) : (
            <button onClick={anular} disabled={guardando || !puedeSeguir}
              className={`px-5 py-2 rounded-xl text-sm font-bold text-white disabled:opacity-60 hover:opacity-90 ${esReinicio ? "bg-blue-600" : "bg-red-600"}`}>
              {guardando ? "Guardando…" : esReinicio ? `Confirmar: reinicio a ${kmFmt} km` : vaAReasignar ? `Confirmar: pasar ${kmFmt} km a ${destino!.placa}` : vaACorregir ? `Confirmar: corregir a ${kmOkFmt} km${vaLote ? ` y ${otrasConDecima.length} más` : ""}` : `Confirmar: anular ${kmFmt} km`}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
