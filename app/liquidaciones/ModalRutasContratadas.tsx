"use client";
// Las fichas de las rutas contratadas del periodo: cuántos asientos pidió el cliente.
//
// Es lo único que faltaba para que el formato deje de inventar el "N PAX". Hasta ahora
// ese número salía de la capacidad del bus que tocó ese día, así que una ruta contratada
// para 15 personas se le declaraba al cliente como 20 cuando AFA, por disponibilidad,
// mandaba una unidad más grande.
//
// Se llena desde aquí porque aquí es donde se nota: el periodo ya está cargado, cada
// ruta trae sus servicios del mes y se ve cuáles saldrían sin el dato. Lo que se guarda
// queda en `cliente_ruta` contra el par de nombres (ida + retorno), que es la misma
// identidad con la que la liquidación agrupa sus líneas — o sea que se corrige una vez
// y todos los meses siguientes salen bien solos.

import { useState } from "react";
import { supabase } from "@/lib/supabase";
import { guardarPaxContratado } from "@/lib/liquidacion-rutas";

export type RutaDelPeriodo = {
  clave: string;
  clienteId: number | null;
  clienteNombre: string;
  sedeId: number | null;
  sedeNombre: string;
  nombreIda: string | null;
  nombreRetorno: string | null;
  /** Lo que hoy resuelve la cascada. null = la ruta sale sin el "N PAX". */
  paxContratado: number | null;
  /** La unidad más chica que se asignó en el periodo. Solo referencia, nunca se copia sola. */
  capacidadMinimaAsignada: number | null;
  servicios: number;
};

export default function ModalRutasContratadas({
  rutas, catalogoDisponible, onCerrar, onGuardado,
}: {
  rutas: RutaDelPeriodo[];
  catalogoDisponible: boolean;
  onCerrar: () => void;
  onGuardado: (guardadas: number) => void;
}) {
  const [valores, setValores] = useState<Record<string, string>>(() =>
    Object.fromEntries(rutas.map((r) => [r.clave, r.paxContratado != null ? String(r.paxContratado) : ""]))
  );
  const [guardando, setGuardando] = useState(false);
  const [msg, setMsg] = useState("");

  const sinPax = rutas.filter((r) => !valores[r.clave]?.trim()).length;

  async function guardar() {
    setGuardando(true); setMsg("");
    let ok = 0;
    const fallos: string[] = [];
    for (const r of rutas) {
      const texto = (valores[r.clave] ?? "").trim();
      const pax = texto ? Number(texto) : null;
      // Nada que hacer si no cambió respecto de lo que ya resolvía la cascada.
      if ((pax ?? null) === (r.paxContratado ?? null)) continue;
      if (pax != null && (!Number.isFinite(pax) || pax <= 0)) {
        fallos.push(`${r.nombreIda ?? "(sin nombre)"}: "${texto}" no es una cantidad de asientos`);
        continue;
      }
      const res = await guardarPaxContratado(supabase, {
        clienteId: r.clienteId,
        sedeId: r.sedeId,
        nombreIda: r.nombreIda,
        nombreRetorno: r.nombreRetorno,
        pax,
      });
      if (res.ok) ok += 1;
      else fallos.push(`${r.nombreIda ?? "(sin nombre)"}: ${res.error}`);
    }
    setGuardando(false);
    if (fallos.length) { setMsg(`⚠️ ${fallos.length} no se guardó(aron): ${fallos[0]}`); return; }
    onGuardado(ok);
  }

  return (
    <div className="fixed inset-0 bg-black/50 z-50 flex items-center justify-center p-3" onClick={onCerrar}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-3 border-b sticky top-0 bg-white rounded-t-2xl z-10">
          <h3 className="font-black text-[#0b315f]">Rutas contratadas del periodo</h3>
          <p className="text-xs text-gray-500">
            Cuántos asientos contrató el cliente en cada ruta. Es lo que imprime el formato — no la
            capacidad del bus que salió ese día, que cambia según la disponibilidad.
          </p>
        </div>

        {!catalogoDisponible && (
          <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-amber-50 border border-amber-200 text-xs text-amber-900">
            <b>Falta un paso en la base de datos.</b> Corre <code>supabase/liquidaciones-03-ruta-contratada.sql</code>:
            sin esa tabla no hay dónde guardar la capacidad contratada y el formato seguirá saliendo sin el «N PAX».
          </div>
        )}
        {msg && <div className="mx-5 mt-3 px-3 py-2 rounded-xl bg-blue-50 border border-blue-200 text-sm text-blue-900">{msg}</div>}

        <div className="p-5">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-[10px] uppercase text-gray-500">
              <tr>
                <th className="text-left px-2 py-2">Ruta</th>
                <th className="px-2 py-2 w-20">Serv.</th>
                <th className="px-2 py-2 w-28">Unidad menor</th>
                <th className="px-2 py-2 w-32">PAX contratados</th>
              </tr>
            </thead>
            <tbody className="divide-y">
              {rutas.map((r) => {
                const valor = valores[r.clave] ?? "";
                const falta = !valor.trim();
                return (
                  <tr key={r.clave} className={falta ? "bg-amber-50/50" : ""}>
                    <td className="px-2 py-2">
                      <span className="block font-medium text-gray-800">{r.nombreIda ?? "(sin nombre de ruta)"}</span>
                      {r.nombreRetorno && <span className="block text-[11px] text-gray-500">↩ {r.nombreRetorno}</span>}
                      <span className="block text-[10px] text-gray-400">{r.clienteNombre} · {r.sedeNombre}</span>
                    </td>
                    <td className="px-2 py-2 text-center text-xs text-gray-500">{r.servicios}</td>
                    <td className="px-2 py-2 text-center text-xs text-gray-400">
                      {r.capacidadMinimaAsignada ?? "—"}
                    </td>
                    <td className="px-2 py-2">
                      <input
                        type="number" min="1" step="1"
                        className="w-full px-2 py-1 rounded border text-sm text-center"
                        placeholder="—"
                        value={valor}
                        onChange={(e) => setValores((v) => ({ ...v, [r.clave]: e.target.value }))}
                      />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>

          <p className="mt-3 text-[11px] text-gray-500">
            La columna <b>Unidad menor</b> es la capacidad del bus más chico que cubrió la ruta en el
            periodo. Está solo como referencia y <b>no se copia sola</b>: es un dato de la flota, no del
            contrato, y confundirlos es exactamente lo que hacía que el formato declarara un número que
            nadie pactó. Una ruta sin capacidad se liquida igual, pero su ítem sale sin el «N PAX».
          </p>
        </div>

        <div className="px-5 py-4 border-t flex gap-2 justify-end sticky bottom-0 bg-white rounded-b-2xl">
          <span className="mr-auto text-xs text-gray-500 self-center">
            {sinPax ? `${sinPax} de ${rutas.length} sin capacidad contratada` : "Todas las rutas del periodo tienen su capacidad"}
          </span>
          <button onClick={onCerrar} className="px-4 py-2 rounded-xl border text-sm font-bold text-gray-600 hover:bg-gray-50">Cerrar</button>
          <button onClick={guardar} disabled={guardando || !catalogoDisponible}
            className="px-4 py-2 rounded-xl text-sm font-bold text-white bg-[#0b315f] disabled:opacity-50">
            {guardando ? "Guardando…" : "Guardar fichas"}
          </button>
        </div>
      </div>
    </div>
  );
}
