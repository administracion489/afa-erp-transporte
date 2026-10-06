// app/radar-ia/ReprocesoFallidos.tsx — Los mensajes que FALLARON, contados y reprocesables en lote.
//
// Del 14/09 al 06/10 el Radar no guardó ninguna recarga (la acción fallaba y el mensaje se marcaba
// «Procesado» igual), y del 30/09 al 02/10 casi nada se pudo ni clasificar. Reprocesarlos de a uno
// desde el feed son decenas de clics; aquí se cuentan con el MISMO filtro con que el servidor los
// reprocesa (FILTRO_FALLIDOS) y se reprocesan todos, de a uno, del más viejo al más nuevo.
//
// No duplica: cada mensaje retira lo que su corrida anterior dejó propuesto y no repite lo que ya
// comprometió (lib/radar/reproceso.ts), y la acción de combustible reconoce lo que ya está en
// /combustible —a mano o desde la factura— por comprobante, o por placa e importe con un día de
// margen, y lo manda a revisión en vez de registrarlo otra vez.
//
// Y DICE CUÁLES SON. El aviso contaba «2 fallaron… su motivo está en el detalle de cada mensaje» y
// no había cómo llegar a ellos: el feed trae los 150 más recientes y un mensaje sin clasificar no
// tiene filtro. La lista sale del MISMO filtro que el conteo y el lote, se abre sola con pocos, y
// cada uno se puede «quitar del aviso» (una foto que no es de combustible fallará siempre: sin esa
// salida, el aviso se vuelve paisaje).
"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { FILTRO_FALLIDOS, PATCH_QUITAR_DEL_AVISO, motivoDeFallo } from "@/lib/radar/reproceso";
import { CATEGORIAS_RADAR, type CategoriaRadar } from "@/lib/radar/tipos";
import { EnlacePrivado } from "@/components/ArchivoPrivado";

/** Mismo número que el servidor usa por defecto (app/api/radar/reprocesar/route.ts). */
const DIAS_FALLIDOS = 60;
/** Cuántos se listan. Con más, el lote es el camino; la lista es para saber CUÁLES son. */
const MAX_LISTA = 50;
/** Con pocos, la lista se abre sola: «2 fallaron» sin decir cuáles obliga a ir a buscarlos. */
const ABRIR_SOLA_HASTA = 5;

const desdeLima = () =>
  new Date(Date.now() - 5 * 3600 * 1000 - DIAS_FALLIDOS * 86_400_000).toISOString().slice(0, 10);

const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", timeZone: "America/Lima" });

const fechaHora = (iso: string) =>
  new Date(iso).toLocaleString("es-PE", {
    day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit", timeZone: "America/Lima",
  });

const TIPO_TEXTO: Record<string, string> = {
  imagen: "📷 Foto", documento: "📄 Documento", audio: "🎤 Nota de voz", video: "🎬 Video", texto: "💬 Texto",
};

type Conteo = { total: number; combustible: number; sinClasificar: number; otros: number; primero: string | null };

type Fallido = {
  id: string; ts_mensaje: string; recibido_en: string; categoria: CategoriaRadar | null;
  grupo_nombre: string | null; remitente_nombre: string | null; tipo: string;
  texto: string | null; media_url: string | null; media_nombre: string | null;
  error: string | null; accion: string | null; estado: string; resultado: unknown;
};

type Progreso = { reprocesados: number; resueltos: number; siguen: number; arrastrados: number; quedan: number; costo: number };

export default function ReprocesoFallidos({ refrescar, onTerminado }: { refrescar: unknown; onTerminado: () => void }) {
  const [conteo, setConteo] = useState<Conteo | null>(null);
  const [corriendo, setCorriendo] = useState(false);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean } | null>(null);
  // CUÁLES fallaron. Se piden con el MISMO filtro que el conteo y el lote (FILTRO_FALLIDOS + desde):
  // si la lista saliera de otra consulta, el aviso podría decir 2 y enseñar otros.
  const [verLista, setVerLista] = useState<boolean | null>(null);
  const [lista, setLista] = useState<Fallido[] | null>(null);
  const [quitando, setQuitando] = useState<string | null>(null);
  const desde = desdeLima();

  const cargarLista = useCallback(async () => {
    const { data, error } = await supabase
      .from("radar_mensajes")
      .select("id, ts_mensaje, recibido_en, categoria, grupo_nombre, remitente_nombre, tipo, texto, media_url, media_nombre, error, accion, estado, resultado")
      .or(FILTRO_FALLIDOS)
      .gte("recibido_en", desde)
      .order("ts_mensaje", { ascending: false })
      .limit(MAX_LISTA);
    setLista(error ? [] : ((data ?? []) as Fallido[]));
  }, [desde]);

  const contar = useCallback(async () => {
    const { data, count, error } = await supabase
      .from("radar_mensajes")
      .select("id, recibido_en, categoria", { count: "exact" })
      .or(FILTRO_FALLIDOS)
      .gte("recibido_en", desde)
      .order("recibido_en", { ascending: true })
      .limit(1000);
    if (error) { setConteo(null); return; }
    const filas = (data ?? []) as { id: string; recibido_en: string; categoria: string | null }[];
    setConteo({
      total: count ?? filas.length,
      combustible: filas.filter((f) => f.categoria === "combustible").length,
      sinClasificar: filas.filter((f) => !f.categoria).length,
      otros: filas.filter((f) => f.categoria && f.categoria !== "combustible").length,
      primero: filas[0]?.recibido_en ?? null,
    });
  }, [desde]);

  useEffect(() => { contar(); }, [contar, refrescar]);

  // Abierta si la persona la abrió, o sola si son pocos y nadie la cerró.
  const abierta = verLista ?? (!!conteo?.total && conteo.total <= ABRIR_SOLA_HASTA);
  useEffect(() => { if (abierta) cargarLista(); }, [abierta, cargarLista, refrescar, conteo?.total]);

  async function quitarDelAviso(m: Fallido) {
    const ok = window.confirm(
      `¿Quitar este mensaje del aviso?\n\n${fechaHora(m.ts_mensaje)} · ${m.grupo_nombre ?? "grupo desconocido"} · ` +
      `${m.remitente_nombre ?? "remitente desconocido"}\n\nNo se vuelve a leer. Si traía una recarga, regístrala a mano ` +
      `en Combustible o espera la factura del correo. El motivo del fallo queda guardado en el mensaje.`
    );
    if (!ok) return;
    setQuitando(m.id);
    const { error } = await supabase.from("radar_mensajes").update(PATCH_QUITAR_DEL_AVISO).eq("id", m.id);
    setQuitando(null);
    if (error) { setAviso({ texto: `No se pudo quitar: ${error.message}`, ok: false }); return; }
    setLista((xs) => (xs ?? []).filter((x) => x.id !== m.id));
    contar();
  }

  async function reprocesarTodos() {
    if (!conteo?.total) return;
    const ok = window.confirm(
      `Se vuelven a leer ${conteo.total} mensaje(s) que fallaron desde el ${conteo.primero ? fechaCorta(conteo.primero) : "—"}, ` +
      `de a uno y con las fotos de su ráfaga.\n\n` +
      `No se duplica nada: lo que ya está en Combustible (registrado a mano o desde la factura del correo) ` +
      `se reconoce por el número de comprobante, o por placa e importe con un día de margen, y queda EN REVISIÓN ` +
      `en vez de registrarse otra vez.\n\n` +
      `Usa IA: unos US$ 0.02–0.05 por mensaje con fotos. Puede tardar varios minutos; no cierres esta pestaña.\n\n¿Seguir?`
    );
    if (!ok) return;
    setCorriendo(true);
    setAviso(null);
    const acum: Progreso = { reprocesados: 0, resueltos: 0, siguen: 0, arrastrados: 0, quedan: conteo.total, costo: 0 };
    setProgreso({ ...acum });
    let despuesDe: string | null = null;
    try {
      for (let vuelta = 0; vuelta < 80; vuelta++) {
        const { data: s } = await supabase.auth.getSession();
        const token = s.session?.access_token;
        if (!token) throw new Error("Sesión expirada: vuelve a iniciar sesión");
        const res: Response = await fetch("/api/radar/reprocesar", {
          method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: JSON.stringify({ fallidos: true, desde, despues_de: despuesDe }),
        });
        const r: Record<string, unknown> = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof r.error === "string" ? r.error : `El servidor respondió ${res.status}`);
        acum.reprocesados += Number(r.reprocesados ?? 0);
        acum.resueltos += Number(r.resueltos ?? 0);
        acum.siguen += Number(r.siguen ?? 0);
        acum.arrastrados += Number(r.arrastrados ?? 0);
        acum.costo += Number(r.costo_usd ?? 0);
        acum.quedan = Number(r.quedan ?? 0);
        setProgreso({ ...acum });
        despuesDe = typeof r.ultimo === "string" ? r.ultimo : despuesDe;
        // Sin avance no se insiste: el cursor no se movió y la próxima vuelta pediría lo mismo.
        if (!acum.quedan || !Number(r.reprocesados ?? 0)) break;
      }
      setAviso({
        // Cada ráfaga cuenta UNA vez aunque traiga varias fotos: sin decir cuántas vinieron con ellas,
        // «se vuelven a leer 45» y «listo: 20» se leerían como 25 perdidos.
        texto:
          `Listo: ${acum.resueltos} resuelto(s)` +
          (acum.arrastrados ? ` (con ${acum.arrastrados} mensaje(s) más de sus ráfagas)` : "") +
          (acum.siguen ? ` · ${acum.siguen} volvieron a fallar (abajo, cada uno con su motivo)` : "") +
          (acum.quedan ? ` · ${acum.quedan} sin mirar todavía: vuelve a pulsar` : "") +
          ` · costo IA US$ ${acum.costo.toFixed(2)}.`,
        ok: !acum.siguen,
      });
    } catch (e: unknown) {
      setAviso({ texto: `Se detuvo: ${(e as Error)?.message ?? e}. Lo ya reprocesado quedó guardado; puedes volver a pulsar.`, ok: false });
    } finally {
      setCorriendo(false);
      contar();
      onTerminado();
    }
  }

  if (!conteo?.total && !aviso && !corriendo) return null;

  const partes: string[] = [];
  if (conteo?.combustible) partes.push(`${conteo.combustible} de combustible`);
  if (conteo?.sinClasificar) partes.push(`${conteo.sinClasificar} sin clasificar`);
  if (conteo?.otros) partes.push(`${conteo.otros} de otras categorías`);

  return (
    <div className={`rounded-2xl border p-4 ${conteo?.total ? "border-[#F2C94C] bg-[#FFF8E1]" : "border-gray-100 bg-white"}`}>
      {!!conteo?.total && (
        <>
          <p className="text-sm font-black text-[#7a5a00]">
            ⚠ {conteo.total} mensaje(s) del Radar fallaron
            {conteo.primero ? ` desde el ${fechaCorta(conteo.primero)}` : ""}
            {partes.length ? ` — ${partes.join(" · ")}` : ""}.
          </p>
          <p className="text-xs text-[#7a5a00] mt-1">
            Un mensaje que falla no guardó lo que traía (una recarga de combustible no está en Combustible). Reprocesarlos los
            vuelve a leer con sus fotos; lo que ya está registrado —a mano o desde la factura— se reconoce y queda en revisión,
            sin duplicarse.
          </p>
        </>
      )}
      <div className="flex items-center gap-3 flex-wrap mt-3">
        {!!conteo?.total && (
          <button
            onClick={reprocesarTodos}
            disabled={corriendo}
            className="px-4 py-2 rounded-xl text-sm font-black bg-[#0b315f] text-white hover:bg-[#1262bd] disabled:opacity-60"
          >
            {corriendo ? "Reprocesando…" : `🔁 Reprocesar los ${conteo.total}`}
          </button>
        )}
        {progreso && corriendo && (
          <span className="text-xs font-bold text-[#0b315f]">
            {progreso.reprocesados} listo(s) · {progreso.resueltos} resuelto(s){progreso.siguen ? ` · ${progreso.siguen} siguen fallando` : ""} · quedan {progreso.quedan}
          </span>
        )}
        {!!conteo?.total && (
          <button
            onClick={() => setVerLista(!abierta)}
            className="px-3 py-2 rounded-xl text-xs font-black border border-[#F2C94C] bg-white text-[#7a5a00] hover:bg-[#FFF3C4]"
          >
            {abierta ? "Ocultar cuáles" : `👀 Ver cuáles son`}
          </button>
        )}
        {aviso && (
          <span className={`text-xs font-bold ${aviso.ok ? "text-[#27AE60]" : "text-[#EB5757]"}`}>{aviso.texto}</span>
        )}
      </div>

      {abierta && !!conteo?.total && (
        <div className="mt-3 bg-white rounded-xl border border-[#F2C94C] divide-y divide-[#FCEFC7]">
          {lista == null ? (
            <p className="px-3 py-2 text-xs text-gray-500">Buscando los mensajes…</p>
          ) : !lista.length ? (
            <p className="px-3 py-2 text-xs text-gray-500">No se pudieron leer los mensajes: vuelve a cargar la página.</p>
          ) : (
            lista.map((m) => {
              const cat = m.categoria ? CATEGORIAS_RADAR[m.categoria] : null;
              const texto = (m.texto ?? "").trim() || m.media_nombre || "";
              return (
                <div key={m.id} className="px-3 py-2.5 text-xs space-y-1">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-black text-[#0b315f]">{fechaHora(m.ts_mensaje)}</span>
                    <span className="text-gray-600 font-semibold">
                      {m.grupo_nombre ?? "Grupo desconocido"} · {m.remitente_nombre ?? "remitente desconocido"}
                    </span>
                    <span className="font-bold text-gray-500">{TIPO_TEXTO[m.tipo] ?? m.tipo}</span>
                    {cat ? (
                      <span className="font-black px-2 py-0.5 rounded-full" style={{ color: cat.color, background: cat.bg }}>{cat.emoji} {cat.label}</span>
                    ) : (
                      <span className="font-black px-2 py-0.5 rounded-full text-[#5B6B82] bg-[#eef2f7]">Sin clasificar</span>
                    )}
                  </div>
                  {texto && <p className="text-gray-700">«{texto.length > 160 ? `${texto.slice(0, 160)}…` : texto}»</p>}
                  <p className="text-[#C0392B] font-semibold">Motivo: {motivoDeFallo(m)}</p>
                  <div className="flex items-center gap-3 flex-wrap">
                    {m.media_url && (
                      <EnlacePrivado href={m.media_url} target="_blank" rel="noreferrer" className="font-bold text-[#1262bd] hover:underline">
                        {m.tipo === "imagen" ? "Ver la foto" : "Ver el archivo"}
                      </EnlacePrivado>
                    )}
                    <button
                      onClick={() => quitarDelAviso(m)}
                      disabled={quitando === m.id || corriendo}
                      className="font-bold text-gray-500 hover:text-[#0b315f] disabled:opacity-50"
                      title="No se vuelve a leer: deja de contar en este aviso. El motivo queda guardado en el mensaje."
                    >
                      {quitando === m.id ? "Quitando…" : "Quitar del aviso"}
                    </button>
                  </div>
                </div>
              );
            })
          )}
          {!!lista && conteo.total > lista.length && (
            <p className="px-3 py-2 text-[11px] text-gray-500">
              Se muestran los {lista.length} más recientes de {conteo.total}.
            </p>
          )}
        </div>
      )}
    </div>
  );
}
