"use client";
// app/configuracion/operaciones/PruebaAvisos.tsx — «Probar los avisos al conductor».
//
// Manda a UN número los mismos WhatsApp que recibe un conductor que no pulsa INICIAR (y los del
// coordinador), con datos de ejemplo y en el orden en que llegan. Lo pidió el dueño para ver
// «cómo está» la escalera sin esperar a que a un conductor real se le olvide.
//
// La lista se calcula con lib/escalera-muestra.ts — el MISMO módulo que usa el servidor para
// enviar —, así lo que se ve aquí es lo que sale. Al servidor solo viajan los ids elegidos y el
// número: la plantilla y el texto los vuelve a armar él con la configuración guardada.

import { useMemo, useState } from "react";
import { cabecerasErp } from "@/lib/fetch-erp";
import { datosDeMuestra, planDeMuestra, telefonoDeMuestra, type CfgMuestra, type CodigoMuestra } from "@/lib/escalera-muestra";

type CfgPantalla = CfgMuestra & { destinatarios: number[]; nombre?: string };
type DestPantalla = { id: number; activo: boolean; telefono: string | null };
type Resultado = { ok: boolean; error?: string; nota?: string };

const CLAVE_TEL = "afa_prueba_avisos_tel";

/** Los códigos que piden atención (algo no está como se cree): el resto es informativo. */
const AMBAR: CodigoMuestra[] = ["mudo", "sin_config", "sin_plantilla"];

function telGuardado(): string {
  try { return localStorage.getItem(CLAVE_TEL) ?? ""; } catch { return ""; }
}

export default function PruebaAvisos({ cfgs, dests }: { cfgs: CfgPantalla[]; dests: DestPantalla[] }) {
  const [abierto, setAbierto] = useState(false);
  const [telefono, setTelefono] = useState("");
  const [elegidos, setElegidos] = useState<Set<string> | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [resultados, setResultados] = useState<Record<string, Resultado>>({});
  const [mensaje, setMensaje] = useState<{ texto: string; ok: boolean } | null>(null);

  // La misma selección de contactos que hace el tick (activos y con teléfono). Los datos de
  // ejemplo no cambian qué mensajes hay ni por qué salen: solo su texto, que arma el servidor.
  const plan = useMemo(() => {
    const vivos = new Set(dests.filter((d) => d.activo && String(d.telefono ?? "").trim()).map((d) => d.id));
    const conContactos = cfgs.map((c) => ({ ...c, contactos: c.destinatarios.filter((id) => vivos.has(id)).length }));
    // La fecha solo fecha la evidencia del coordinador, que esta lista no enseña (el texto lo arma
    // el servidor): una fija mantiene el render puro.
    return planDeMuestra(conContactos, datosDeMuestra({ nombreUsuario: null, fecha: "2000-01-01", telContingencia: "" }));
  }, [cfgs, dests]);

  const seleccion = elegidos ?? new Set(plan.filter((m) => m.marcado).map((m) => m.id));
  const tel = telefonoDeMuestra(telefono);
  const n = plan.filter((m) => m.enviable && seleccion.has(m.id)).length;
  const conLlamada = plan.some((m) => m.canal === "llamada" && m.enviable && seleccion.has(m.id));

  const abrir = () => {
    setAbierto(true);
    if (!telefono) setTelefono(telGuardado());
  };

  const alternar = (id: string) => {
    const s = new Set(seleccion);
    if (s.has(id)) s.delete(id); else s.add(id);
    setElegidos(s);
  };

  const enviar = async () => {
    if (!tel.ok || n === 0) return;
    const wa = conLlamada ? n - 1 : n;
    if (!confirm(
      `Se enviarán ${wa} WhatsApp de prueba a ${tel.visible}, desde el número de avisos y en el orden en que llegan, ` +
      "con datos de ejemplo (tu nombre como conductor y un servicio de las 06:30 desde «Paradero de prueba»)." +
      (conLlamada ? "\n\nY se pondrá en la cola de la central una LLAMADA de prueba a ese número." : "") +
      "\n\n¿Continuar?",
    )) return;
    setEnviando(true);
    setMensaje(null);
    setResultados({});
    try { localStorage.setItem(CLAVE_TEL, telefono); } catch { /* sin almacenamiento: no pasa nada */ }
    try {
      const ids = plan.filter((m) => m.enviable && seleccion.has(m.id)).map((m) => m.id);
      const res = await fetch("/api/alertas-flota/prueba", {
        method: "POST", headers: await cabecerasErp(), body: JSON.stringify({ telefono, ids }),
      });
      const j = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMensaje({ texto: j.error || `No se pudo enviar (HTTP ${res.status}).`, ok: false });
        return;
      }
      const r: Record<string, Resultado> = {};
      for (const x of (j.resultados ?? []) as ({ id: string } & Resultado)[]) r[x.id] = { ok: x.ok, error: x.error, nota: x.nota };
      setResultados(r);
      const ok = Object.values(r).filter((x) => x.ok).length;
      const mal = Object.values(r).length - ok;
      setMensaje(mal === 0
        ? { texto: `Listo: ${ok} mensaje(s) enviados a ${j.telefono ?? tel.visible}. Revisa ese WhatsApp.`, ok: true }
        : { texto: `${ok} enviado(s) y ${mal} con error: el motivo está al lado de cada mensaje.`, ok: ok > 0 });
    } catch {
      setMensaje({ texto: "Sin conexión con el servidor. Vuelve a intentarlo.", ok: false });
    } finally {
      setEnviando(false);
    }
  };

  return (
    <div className="bg-white border border-gray-200 rounded-2xl p-5 mb-6">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div className="min-w-0">
          <h2 className="text-sm font-bold text-gray-700">🧪 Probar los avisos al conductor que no inicia</h2>
          <p className="text-xs text-gray-500 mt-0.5">
            Te llegan por WhatsApp, a tu número, los mismos mensajes que recibe un conductor que no pulsa INICIAR
            (y los del coordinador), en el orden en que llegan y con datos de ejemplo.
          </p>
        </div>
        {!abierto && (
          <button onClick={abrir} className="text-xs font-semibold text-white bg-[#0b315f] px-4 py-2 rounded-lg hover:bg-[#0a2a52] shrink-0">
            Probar
          </button>
        )}
      </div>

      {abierto && (
        <div className="mt-4 space-y-3">
          <div className="flex flex-wrap items-end gap-2">
            <div className="w-48">
              <label className="block text-[11px] font-semibold text-gray-500 mb-1">Enviar a (celular)</label>
              <input
                className="w-full border border-gray-200 rounded-lg px-2.5 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20"
                inputMode="tel" placeholder="987 654 321" value={telefono}
                onChange={(e) => setTelefono(e.target.value)}
              />
            </div>
            <button
              onClick={enviar} disabled={!tel.ok || n === 0 || enviando}
              className="text-xs font-semibold text-white bg-green-600 px-4 py-2.5 rounded-lg hover:bg-green-700 disabled:opacity-50"
            >
              {enviando ? "Enviando…" : `Enviar ${n} mensaje(s)`}
            </button>
            <button onClick={() => setAbierto(false)} className="text-xs font-semibold text-gray-500 px-3 py-2.5 rounded-lg hover:bg-gray-50">
              Cerrar
            </button>
          </div>
          {telefono.trim() && !tel.ok && <p className="text-[11px] text-amber-700">{tel.motivo}</p>}

          <div className="border border-gray-100 rounded-xl divide-y divide-gray-100">
            {plan.map((m) => {
              const r = resultados[m.id];
              return (
                <label key={m.id} className={`flex items-start gap-3 px-3 py-2.5 ${m.enviable ? "cursor-pointer" : "opacity-60"}`}>
                  <input type="checkbox" className="mt-1" disabled={!m.enviable || enviando}
                    checked={m.enviable && seleccion.has(m.id)} onChange={() => alternar(m.id)} />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-x-2 gap-y-0.5">
                      <span className="text-[11px] font-mono text-gray-500 w-28 shrink-0">{m.cuando}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${m.para === "conductor" ? "bg-blue-50 text-blue-700" : "bg-purple-50 text-purple-700"}`}>
                        {m.para === "conductor" ? "Conductor" : "Coordinador"}
                      </span>
                      <span className="text-sm font-semibold text-gray-800">{m.canal === "llamada" ? "📞 " : ""}{m.titulo}</span>
                      {/* La fila dice el TÍTULO del mensaje; la tarjeta que se configura puede llamarse
                          distinto («Falta iniciar recorrido» vive en «Alerta previa al coordinador»). */}
                      {(() => {
                        const tarjeta = cfgs.find((c) => c.clave === m.clave)?.nombre;
                        return tarjeta && tarjeta !== m.titulo
                          ? <span className="text-[10px] text-gray-400">tarjeta «{tarjeta}»</span>
                          : null;
                      })()}
                      {m.plantilla && <span className="text-[10px] font-mono text-gray-400">{m.plantilla}</span>}
                    </div>
                    <p className={`text-[11px] mt-0.5 ${AMBAR.includes(m.codigo) ? "text-amber-700" : "text-gray-500"}`}>{m.nota}</p>
                    {r?.nota && (
                      <p className={`text-[11px] mt-0.5 font-semibold ${/no saldrá/.test(r.nota) ? "text-amber-700" : "text-green-700"}`}>{r.nota}</p>
                    )}
                  </div>
                  {r && (
                    <span className={`text-[11px] font-semibold shrink-0 max-w-[40%] text-right ${r.ok ? "text-green-700" : "text-red-600"}`}>
                      {r.ok ? (m.canal === "llamada" ? "✓ En cola" : "✓ Enviado") : `✗ ${r.error}`}
                    </span>
                  )}
                </label>
              );
            })}
          </div>

          {mensaje && (
            <div className={`text-xs rounded-lg px-3 py-2 ${mensaje.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-700 border border-red-200"}`}>
              {mensaje.texto}
            </div>
          )}

          <p className="text-[11px] text-gray-500">
            Salen desde el número de avisos con las plantillas reales. Un administrador puede probar con cualquier
            celular; los demás, con un número del <strong>Directorio de contactos</strong>. La <strong>notificación del app</strong> (la que suena
            como Uber) no llega a un número: solo a un teléfono con el app del conductor. Para verla, abre el app →
            <strong> Perfil → Notificaciones → Probar</strong>.
          </p>
        </div>
      )}
    </div>
  );
}
