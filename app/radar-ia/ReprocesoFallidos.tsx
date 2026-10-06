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
"use client";

import { useCallback, useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import { FILTRO_FALLIDOS } from "@/lib/radar/reproceso";

/** Mismo número que el servidor usa por defecto (app/api/radar/reprocesar/route.ts). */
const DIAS_FALLIDOS = 60;

const desdeLima = () =>
  new Date(Date.now() - 5 * 3600 * 1000 - DIAS_FALLIDOS * 86_400_000).toISOString().slice(0, 10);

const fechaCorta = (iso: string) =>
  new Date(iso).toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", timeZone: "America/Lima" });

type Conteo = { total: number; combustible: number; sinClasificar: number; otros: number; primero: string | null };

type Progreso = { reprocesados: number; resueltos: number; siguen: number; arrastrados: number; quedan: number; costo: number };

export default function ReprocesoFallidos({ refrescar, onTerminado }: { refrescar: unknown; onTerminado: () => void }) {
  const [conteo, setConteo] = useState<Conteo | null>(null);
  const [corriendo, setCorriendo] = useState(false);
  const [progreso, setProgreso] = useState<Progreso | null>(null);
  const [aviso, setAviso] = useState<{ texto: string; ok: boolean } | null>(null);
  const desde = desdeLima();

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
          (acum.siguen ? ` · ${acum.siguen} volvieron a fallar (su motivo está en el detalle de cada mensaje)` : "") +
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
        {aviso && (
          <span className={`text-xs font-bold ${aviso.ok ? "text-[#27AE60]" : "text-[#EB5757]"}`}>{aviso.texto}</span>
        )}
      </div>
    </div>
  );
}
