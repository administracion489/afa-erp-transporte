"use client";
// /crm/agente → Ajustes → «Comportamiento». Lo que el motor (lib/crm-ia.ts) antes tenía fijo.
// Los valores se normalizan con el MISMO normalizarAjustes que usa el motor: lo que se ve es
// lo que la IA va a hacer.
//
// En su tema MANDA EL AJUSTE (lib/crm-ia-ajustes.ts): cada control lleva como `id` el `ancla` del
// tema (TEMAS_AJUSTE), que es adonde lleva «Ir al ajuste» del panel de choques, y debajo los avisos
// del auditor (components/crm/CoherenciaAgente.tsx) cuando un texto del dueño dice otra cosa. Los
// ejemplos se arman con las MISMAS funciones que usa el código al escribirle al cliente.
import React, { useState } from "react";
import {
  normalizarAjustes, saludoParaHora, presentacion, estiloDe, mensajeDerivacionDefecto, tituloResumen, cierreResumen,
  ponerNombre, AJUSTES_DEFECTO, RESUMEN_CUANDO, TRATAMIENTOS, MODOS_PREGUNTAS, TEMAS_AJUSTE,
  type AjustesIA, type ResumenCuando, type Tratamiento, type ModoPreguntas,
} from "@/lib/crm-ia-ajustes";
import { atencionDe, describirAtencion, fraseFueraDeAtencion, problemaAtencion, PROBLEMA_ATENCION } from "@/lib/crm-ia-atencion";
import { fraseFaltanTraslado } from "@/lib/traslados/envio-ia";
import { sumarDias } from "@/lib/comisiones/calendario";
import { AvisoCampo, AvisosAjuste } from "@/components/crm/CoherenciaAgente";

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";
const ayuda = "text-[11px] text-gray-400 mt-1";
const ejemplo = "rounded-lg bg-[#d9fdd3] px-3 py-2 text-[12px] text-gray-800 whitespace-pre-line";

function Interruptor({ on, onClick }: { on: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`shrink-0 w-11 h-6 rounded-full relative transition-colors ${on ? "bg-[#0b315f]" : "bg-gray-300"}`}
    >
      <span className={`absolute top-0.5 w-5 h-5 bg-white rounded-full transition-all ${on ? "left-5" : "left-0.5"}`} />
    </button>
  );
}

/** Un bloque con interruptor. `pie` se ve siempre (los avisos del auditor no se esconden al apagar). */
function Fila({ id, titulo, detalle, on, onClick, pie, children }: {
  id?: string; titulo: string; detalle: string; on: boolean; onClick: () => void; pie?: React.ReactNode; children?: React.ReactNode;
}) {
  return (
    <div id={id} className="border border-gray-100 rounded-xl p-3 space-y-3 scroll-mt-24">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-700">{titulo}</p>
          <p className="text-xs text-gray-400">{detalle}</p>
        </div>
        <Interruptor on={on} onClick={onClick} />
      </div>
      {on && children}
      {pie}
    </div>
  );
}

const Num = ({ v, min, max, on }: { v: number; min: number; max: number; on: (n: number) => void }) => (
  <input type="number" min={min} max={max} className={input} value={v} onChange={(e) => on(Number(e.target.value))} />
);

/** El texto de un ejemplo de WhatsApp: *negrita* con un asterisco, como lo verá el cliente. */
function Wa({ texto }: { texto: string }) {
  return (
    <>
      {texto.split(/(\*[^*\n]+\*)/g).map((p, i) =>
        /^\*[^*\n]+\*$/.test(p) ? <b key={i}>{p.slice(1, -1)}</b> : <React.Fragment key={i}>{p}</React.Fragment>,
      )}
    </>
  );
}

/** Lo que falta en los ejemplos, en el orden en que lo da el cotizador de traslados. */
const FALTAN_EJEMPLO = ["la fecha del servicio", "el número de pasajeros", "si llevan maletas de 23 kg y cuántas"];

/** Días en el orden en que se dicen (la semana empieza el lunes); 0 = domingo. */
const DIAS = [
  { d: 1, corto: "Lun", nombre: "lunes" }, { d: 2, corto: "Mar", nombre: "martes" }, { d: 3, corto: "Mié", nombre: "miércoles" },
  { d: 4, corto: "Jue", nombre: "jueves" }, { d: 5, corto: "Vie", nombre: "viernes" }, { d: 6, corto: "Sáb", nombre: "sábado" },
  { d: 0, corto: "Dom", nombre: "domingo" },
];
/** Un lunes cualquiera: solo sirve para armar el ejemplo de «fuera de horario» con un día de la semana. */
const LUNES_DE_EJEMPLO = "2026-10-19";

function Segmentos<T extends string>({ opciones, valor, onChange }: {
  opciones: { valor: T; etiqueta: string }[]; valor: T; onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-wrap gap-2">
      {opciones.map((o) => (
        <button
          key={o.valor}
          type="button"
          onClick={() => onChange(o.valor)}
          className={`px-3 py-2 rounded-xl text-sm font-medium border transition-colors min-h-[40px] ${
            valor === o.valor ? "border-[#0b315f] bg-[#0b315f]/5 text-[#0b315f]" : "border-gray-200 text-gray-500 hover:text-gray-700"
          }`}
        >
          {o.etiqueta}
        </button>
      ))}
    </div>
  );
}

export default function AjustesComportamiento({
  valor, onChange, transcripcionLista, instrucciones, empresa, nombreAgente, mensajeDerivacionPropio,
}: {
  valor: unknown;
  onChange: (v: AjustesIA) => void;
  /** null = no se sabe todavía. */
  transcripcionLista: boolean | null;
  instrucciones: string | null;
  /** Nombre del perfil de la empresa ({empresa}); "" = sin perfil. */
  empresa: string;
  /** crm_agentes_ia.nombre ({agente}). */
  nombreAgente: string;
  /** El «Mensaje al derivar a un ejecutivo» propio ("" = el mensaje por defecto). */
  mensajeDerivacionPropio: string;
}) {
  // Los números se guardan tal cual se teclean y se acotan al guardar/usar: acotar en cada
  // tecla impediría escribir «15» (el «1» saltaría al mínimo).
  const a = { ...normalizarAjustes(valor), ...(valor && typeof valor === "object" ? (valor as object) : {}) } as AjustesIA;
  const n = normalizarAjustes(a);
  const set = <K extends keyof AjustesIA>(k: K, v: AjustesIA[K]) => onChange({ ...a, [k]: v });
  const [verPrompt, setVerPrompt] = useState(false);

  const estilo = estiloDe(n);
  const tu = n.tratamiento === "tu";
  const una = n.preguntas === "una_por_mensaje";
  const derivacionEjemplo = ponerNombre(mensajeDerivacionDefecto(n.tratamiento), "María");
  const meFalta = fraseFaltanTraslado(FALTAN_EJEMPLO, estilo);
  const derivacionPropia = mensajeDerivacionPropio.trim() !== "";

  // Horario de atención del equipo: el mismo objeto que lee el motor.
  const at = atencionDe(n);
  const problema = problemaAtencion(at);
  const ultimoDia = [...DIAS].reverse().find((x) => at.dias.includes(x.d));
  const fueraEjemplo = !problema && ultimoDia
    ? fraseFueraDeAtencion({ ...at, activa: true }, sumarDias(LUNES_DE_EJEMPLO, (ultimoDia.d + 6) % 7), at.hasta, n.tratamiento)
    : "";
  // Lo tecleado tal cual (un campo de hora vaciado se queda vacío mientras se edita); si lo guardado
  // no es texto, lo normalizado.
  const horaCampo = (raw: unknown, normal: string) => (typeof raw === "string" ? raw : normal);
  const alternarDia = (d: number) => {
    const actuales = n.atencion_dias;
    set("atencion_dias", (actuales.includes(d) ? actuales.filter((x) => x !== d) : [...actuales, d]).sort((x, y) => x - y));
  };

  // El ejemplo del resumen, con el título, el cierre, el trato y el modo de preguntar de los ajustes.
  const lineasResumen = "• Ruta: Surco → Aeropuerto\n• Fecha y hora: martes 20/10, 5:00 a. m.\n• Pasajeros: 18, con maletas de 23 kg\n• Servicio: solo ida\n• Nombre: Paola Huarachi";
  const preguntaEjemplo = una
    ? `¿Me indica${tu ? "s" : ""} la fecha del servicio?`
    : `¿Me indica${tu ? "s" : ""} la fecha, la hora de recojo y cuántas maletas de 23 kg llevan?`;
  const ejemploResumen = n.resumen_cuando === "al_final"
    ? `Mientras falten datos:\n${preguntaEjemplo}\n\nCon todo completo:\n${tituloResumen(n)}\n${lineasResumen}\n${cierreResumen(n, "Paola")}`
    : `Ejemplo:\n${tituloResumen(n)}\n${lineasResumen}\n${una ? "*Lo siguiente que necesito:*" : "*Solo me falta:*"} la dirección exacta de recojo en Surco.`;

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-800">Comportamiento del agente</h3>
        <button type="button" className="text-xs text-[#0b315f] underline" onClick={() => onChange({ ...AJUSTES_DEFECTO })}>
          Restaurar valores por defecto
        </button>
      </div>
      <p className="text-xs text-gray-500">
        En estos temas <b>manda el ajuste</b>, aunque la personalidad, «Sobre la empresa», los objetivos o la base de
        conocimiento digan otra cosa. Si un texto choca, el aviso sale arriba y aquí mismo.
      </p>

      <div id="ajuste-tratamiento" className="border border-gray-100 rounded-xl p-3 space-y-2 scroll-mt-24">
        <label className={label}>{TEMAS_AJUSTE.tratamiento.etiqueta}</label>
        <Segmentos<Tratamiento> opciones={TRATAMIENTOS} valor={n.tratamiento} onChange={(v) => set("tratamiento", v)} />
        <p className={ayuda}>
          Lo cumple la IA en todos sus mensajes y también los textos que arma el sistema (la derivación por defecto, el
          «me falta» y el mensaje de una cotización de traslado): el cliente no recibe una frase de usted y otra de tú.
        </p>
        <div className={ejemplo}>
          <span className="text-gray-500">Al derivar a un ejecutivo{derivacionPropia ? " (mensaje por defecto)" : ""}:</span>
          {"\n"}{derivacionEjemplo}
          {"\n\n"}<span className="text-gray-500">Si a un traslado le faltan datos:</span>
          {"\n"}{meFalta}
        </div>
        {derivacionPropia && (
          <p className={ayuda}>
            Usas tu propio «Mensaje al derivar a un ejecutivo»: ese se envía tal cual, así que escríbelo en este mismo trato.
          </p>
        )}
        <AvisosAjuste ancla={TEMAS_AJUSTE.tratamiento.ancla} />
      </div>

      <div id="ajuste-preguntas" className="border border-gray-100 rounded-xl p-3 space-y-2 scroll-mt-24">
        <label className={label}>{TEMAS_AJUSTE.preguntas.etiqueta}</label>
        <select className={input} value={n.preguntas} onChange={(e) => set("preguntas", e.target.value as ModoPreguntas)}>
          {MODOS_PREGUNTAS.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
        </select>
        <div className={ejemplo}>
          <span className="text-gray-500">Si faltan la fecha, los pasajeros y las maletas:</span>
          {"\n"}{meFalta}
        </div>
        <p className={ayuda}>
          {una
            ? "Pide solo el siguiente dato que falta, en el orden de «Datos que forman el pedido»; cuando el cliente lo contesta, pide el siguiente."
            : "Pide todo lo que falta en un solo mensaje."}
        </p>
        <AvisosAjuste ancla={TEMAS_AJUSTE.preguntas.ancla} />
      </div>

      <Fila
        id="ajuste-saludo"
        titulo="👋 Saludar en el primer mensaje del día"
        detalle="Si hoy (hora de Lima) nadie le escribió todavía en ese chat, la respuesta empieza con el saludo y el nombre. Después no vuelve a saludar."
        on={a.saludo_activo} onClick={() => set("saludo_activo", !a.saludo_activo)}
        pie={<AvisosAjuste ancla={TEMAS_AJUSTE.saludo.ancla} />}
      >
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div><label className={label}>Mañana</label><input className={input} value={a.saludo_manana} onChange={(e) => set("saludo_manana", e.target.value)} /></div>
          <div><label className={label}>Tarde (desde las)</label>
            <div className="flex gap-1"><input className={input} value={a.saludo_tarde} onChange={(e) => set("saludo_tarde", e.target.value)} />
              <div className="w-16"><Num v={a.hora_tarde} min={1} max={22} on={(x) => set("hora_tarde", x)} /></div></div></div>
          <div><label className={label}>Noche (desde las)</label>
            <div className="flex gap-1"><input className={input} value={a.saludo_noche} onChange={(e) => set("saludo_noche", e.target.value)} />
              <div className="w-16"><Num v={a.hora_noche} min={2} max={23} on={(x) => set("hora_noche", x)} /></div></div></div>
        </div>
        <p className={ayuda}>
          Ejemplo: a las 10:00 → «{saludoParaHora(n, 10)}, María» · a las 15:00 → «{saludoParaHora(n, 15)}, María» · a las 21:00 → «{saludoParaHora(n, 21)}, María».
        </p>
        <div>
          <label className={label}>{TEMAS_AJUSTE.saludo.etiqueta}</label>
          <textarea
            rows={4}
            className={input}
            value={a.menu_saludo}
            onChange={(e) => set("menu_saludo", e.target.value)}
            placeholder={tu
              ? "¿En qué te puedo ayudar?\n1. Cotizar un traslado\n2. Consultar un servicio\n3. Hablar con un ejecutivo"
              : "¿En qué le puedo ayudar?\n1. Cotizar un traslado\n2. Consultar un servicio\n3. Hablar con un ejecutivo"}
          />
          <p className={ayuda}>
            Si el cliente solo saluda o no dice qué necesita, después del saludo la IA ofrece esto tal cual. Escríbelo en el
            mismo trato de «{TEMAS_AJUSTE.tratamiento.etiqueta}». Vacío = no ofrece un menú.
          </p>
        </div>
      </Fila>

      <div id="ajuste-presentacion" className="border border-gray-100 rounded-xl p-3 space-y-2 scroll-mt-24">
        <label className={label}>{TEMAS_AJUSTE.presentacion.etiqueta}</label>
        <input className={input} value={a.presentarse_como} onChange={(e) => set("presentarse_como", e.target.value)} placeholder="el asistente de {empresa}" />
        <p className={ayuda}>
          {"{empresa}"} = el nombre de /configuracion/perfil · {"{agente}"} = el «Nombre del agente» (pestaña Personalidad),
          por ejemplo «{"{agente}"}, el asistente de {"{empresa}"}».
        </p>
        <p className="text-xs text-gray-600">
          Se presenta como: <span className="italic">«{presentacion(n, empresa, nombreAgente)}»</span>
        </p>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={a.ocultar_ia} onChange={() => set("ocultar_ia", !a.ocultar_ia)} />
          {TEMAS_AJUSTE.identidad_ia.etiqueta}
        </label>
        <AvisosAjuste ancla={TEMAS_AJUSTE.presentacion.ancla} />
      </div>

      <Fila
        titulo="📋 No volver a pedir lo que el cliente ya dio"
        detalle={`Antes de responder relee la conversación y arma la ficha del pedido (origen, destino, fecha, hora, pasajeros, equipaje, ida/vuelta, nombre). Si falta algo, ${
          una ? "pide el siguiente dato que falta (uno por mensaje)" : "lo pide todo junto y una sola vez"
        }; con los datos completos, los confirma y avanza con la cotización.`}
        on={a.recordar_datos} onClick={() => set("recordar_datos", !a.recordar_datos)}
      >
        <div className="w-48">
          <label className={label}>Mensajes que relee</label>
          <Num v={a.mensajes_historial} min={10} max={60} on={(x) => set("mensajes_historial", x)} />
          <p className={ayuda}>Más mensajes = más contexto (y más costo).</p>
        </div>
      </Fila>

      <div id="ajuste-lugares" className="border border-gray-100 rounded-xl p-3 space-y-2 scroll-mt-24">
        <label className={label}>📍 {TEMAS_AJUSTE.direccion.etiqueta}</label>
        <input className={input} value={a.lugares_conocidos} onChange={(e) => set("lugares_conocidos", e.target.value)}
          placeholder="el aeropuerto, los terminales terrestres…" />
        <p className={ayuda}>Para que no pida «la calle o avenida» del aeropuerto. Vale siempre, no solo con «No volver a pedir». Vacío = ninguno.</p>
        <AvisosAjuste ancla={TEMAS_AJUSTE.direccion.ancla} />
      </div>

      <Fila
        id="ajuste-resumen"
        titulo="🧾 Resumen del pedido"
        detalle={n.resumen_cuando === "al_final"
          ? `Mientras falten datos, la IA pide SOLO ${una ? "el siguiente dato que falta" : "lo que falta"}, sin repetir lo que el cliente ya dio. Cuando tiene todo, muestra el resumen UNA vez. También al derivar a un ejecutivo.`
          : `Mientras el cliente pide un servicio, cada respuesta termina con los datos que ya dio y ${una ? "el siguiente que falta" : "SOLO los que faltan"}. Si ya está todo, lo confirma. También al derivar a un ejecutivo.`}
        on={a.resumen_pedido} onClick={() => set("resumen_pedido", !a.resumen_pedido)}
        pie={<AvisosAjuste ancla={TEMAS_AJUSTE.resumen.ancla} />}
      >
        <div>
          <label className={label}>{TEMAS_AJUSTE.resumen.etiqueta}</label>
          <select className={input} value={n.resumen_cuando} onChange={(e) => set("resumen_cuando", e.target.value as ResumenCuando)}>
            {RESUMEN_CUANDO.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Datos que forman el pedido</label>
          <textarea rows={2} className={input} value={a.campos_pedido} onChange={(e) => set("campos_pedido", e.target.value)} />
          <p className={ayuda}>En este orden los pide cuando faltan.</p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>Título del resumen</label>
            <input className={input} value={a.resumen_titulo} onChange={(e) => set("resumen_titulo", e.target.value)}
              placeholder={tituloResumen({ resumen_titulo: "", tratamiento: n.tratamiento })} />
            <p className={ayuda}>Vacío = automático según el trato. *texto* = negrita en WhatsApp.</p>
          </div>
          <div>
            <label className={label}>Cierre del resumen</label>
            <input className={input} value={a.resumen_cierre} onChange={(e) => set("resumen_cierre", e.target.value)}
              placeholder={AJUSTES_DEFECTO.resumen_cierre} />
            <p className={ayuda}>La última línea cuando ya está todo. {"{nombre}"} = primer nombre del cliente. Vacío = «{AJUSTES_DEFECTO.resumen_cierre}».</p>
          </div>
        </div>
        <div className={ejemplo}><Wa texto={ejemploResumen} /></div>
      </Fila>

      <Fila
        titulo="🙅 Nunca decir «no encontré sus servicios»"
        detalle="Si el sistema no encuentra lo que piden, no asusta al cliente: pide datos y deriva el chat a un ejecutivo con el mensaje de derivación."
        on={a.no_decir_no_encontre} onClick={() => set("no_decir_no_encontre", !a.no_decir_no_encontre)}
      >
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Veces que pide fecha o nº de servicio antes de derivar</label>
            <Num v={a.intentos_pedir_datos} min={0} max={3} on={(x) => set("intentos_pedir_datos", x)} />
            <p className={ayuda}>0 = deriva sin pedir nada.</p>
          </div>
        </div>
      </Fila>

      <div className="border border-gray-100 rounded-xl p-3 space-y-3">
        <p className="text-sm font-semibold text-gray-700">🧑‍💼 Al derivar a un ejecutivo</p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className={label}>Etiqueta que pone al chat</label>
            <input className={input} value={a.etiqueta_derivacion} onChange={(e) => set("etiqueta_derivacion", e.target.value)} placeholder="(ninguna)" />
            <p className={ayuda}>Vacía = no etiqueta. Filtra la bandeja por ella para ver lo pendiente.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-600 sm:mt-5">
            <input type="checkbox" className="mt-1" checked={a.nota_interna_derivacion} onChange={() => set("nota_interna_derivacion", !a.nota_interna_derivacion)} />
            Dejar una nota interna 🔒 con el motivo y lo que pidió el cliente
          </label>
        </div>
        <p className={ayuda}>La IA queda pausada en ese chat. El texto que recibe el cliente es «Mensaje al derivar a un ejecutivo» (arriba).</p>
      </div>

      <Fila
        id="ajuste-atencion"
        titulo={`🕘 ${TEMAS_AJUSTE.horario.etiqueta}`}
        detalle="Cuándo hay una persona del equipo para atender. Fuera de él, la IA no promete una respuesta inmediata y el mensaje al derivar dice cuándo responde un ejecutivo. NO es el horario en que la IA contesta sola: ese es «Restringir autonomía a horario», arriba."
        on={a.atencion_activa} onClick={() => set("atencion_activa", !a.atencion_activa)}
        pie={<AvisosAjuste ancla={TEMAS_AJUSTE.horario.ancla} />}
      >
        <div>
          <label className={label}>Días</label>
          <div className="flex flex-wrap gap-1.5">
            {DIAS.map((x) => {
              const on = n.atencion_dias.includes(x.d);
              return (
                <button
                  key={x.d}
                  type="button"
                  onClick={() => alternarDia(x.d)}
                  aria-pressed={on}
                  className={`min-w-[44px] min-h-[40px] px-2 rounded-lg text-xs font-semibold border ${
                    on ? "border-[#0b315f] bg-[#0b315f] text-white" : "border-gray-200 text-gray-500"
                  }`}
                >
                  {x.corto}
                </button>
              );
            })}
          </div>
        </div>
        <div className="flex flex-wrap gap-3">
          <div>
            <label className={label}>Desde</label>
            <input type="time" className={input} value={horaCampo(a.atencion_desde, n.atencion_desde)} onChange={(e) => set("atencion_desde", e.target.value)} />
          </div>
          <div>
            <label className={label}>Hasta</label>
            <input type="time" className={input} value={horaCampo(a.atencion_hasta, n.atencion_hasta)} onChange={(e) => set("atencion_hasta", e.target.value)} />
          </div>
        </div>
        {problema ? (
          <p className="text-xs rounded-lg bg-amber-50 text-amber-800 px-3 py-2">⚠ {PROBLEMA_ATENCION[problema]}</p>
        ) : (
          <>
            <p className="text-xs text-gray-600">
              Atienden <b>{describirAtencion(at)}</b>.
            </p>
            {fueraEjemplo && ultimoDia && (
              <div className={ejemplo}>
                <span className="text-gray-500">
                  Si un cliente escribe el {ultimoDia.nombre} a las {at.hasta} y la IA lo pasa a un ejecutivo, el mensaje por defecto termina con:
                </span>
                {"\n"}{fueraEjemplo.trim()}
              </div>
            )}
            {derivacionPropia && (
              <p className={ayuda}>
                Tu «Mensaje al derivar a un ejecutivo» propio solo lo dice donde escribas {"{atencion}"}; en horario, esa llave desaparece.
              </p>
            )}
          </>
        )}
      </Fila>

      <Fila
        id="ajuste-audios"
        titulo={`🎤 ${TEMAS_AJUSTE.audios.etiqueta}`}
        detalle="Transcribe cada audio al llegar: el equipo lee la transcripción bajo el reproductor y la IA responde como si fuera texto."
        on={a.transcribir_audios} onClick={() => set("transcribir_audios", !a.transcribir_audios)}
        pie={<AvisosAjuste ancla={TEMAS_AJUSTE.audios.ancla} />}
      >
        {transcripcionLista === false && (
          <p className="text-xs rounded-lg bg-amber-50 text-amber-800 px-3 py-2">
            ⚠ El servidor no tiene <b>OPENAI_API_KEY</b>: los audios no se transcriben y la IA deriva esos chats a un ejecutivo. Se carga en Vercel → Settings → Environment Variables (Production).
          </p>
        )}
        {transcripcionLista === true && <p className="text-xs text-emerald-700">✓ Transcripción configurada en el servidor.</p>}
        <div className="w-48"><label className={label}>Audios recientes que escucha</label><Num v={a.max_audios} min={1} max={6} on={(x) => set("max_audios", x)} /></div>
      </Fila>

      <Fila
        id="ajuste-archivos"
        titulo={`🖼️ ${TEMAS_AJUSTE.archivos.etiqueta}`}
        detalle="La IA mira las fotos y documentos que manda el cliente (fechas, rutas, pasajeros). Apagado: dice que un ejecutivo los revisará."
        on={a.leer_archivos} onClick={() => set("leer_archivos", !a.leer_archivos)}
        pie={<AvisosAjuste ancla={TEMAS_AJUSTE.archivos.ancla} />}
      >
        <div className="w-48"><label className={label}>Archivos recientes que lee</label><Num v={a.max_archivos} min={1} max={8} on={(x) => set("max_archivos", x)} /></div>
      </Fila>

      <div className="border border-gray-100 rounded-xl p-3 space-y-2">
        <p className="text-sm font-semibold text-gray-700">⏳ Esperar a que el cliente termine de escribir</p>
        <p className="text-xs text-gray-400">Responde una sola vez a varios mensajes seguidos. Mientras espera, el cliente ve ✓✓ y «escribiendo…».</p>
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          <div><label className={label}>Silencio normal (seg)</label><Num v={a.silencio_seg} min={1} max={60} on={(x) => set("silencio_seg", x)} /></div>
          <div><label className={label}>Si el mensaje parece completo (seg)</label><Num v={a.silencio_completo_seg} min={1} max={60} on={(x) => set("silencio_completo_seg", x)} /></div>
          <div><label className={label}>Espera máxima (seg)</label><Num v={a.espera_max_seg} min={5} max={120} on={(x) => set("espera_max_seg", x)} /></div>
        </div>
        <p className={ayuda}>«Parece completo» = termina en «?», es largo o es un documento.</p>
      </div>

      <div className="border border-gray-100 rounded-xl p-3 space-y-2">
        <label className={label} htmlFor="campo-reglas_extra">📋 Reglas propias del negocio (una por línea)</label>
        <textarea id="campo-reglas_extra" rows={4} className={input} value={a.reglas_extra} onChange={(e) => set("reglas_extra", e.target.value)}
          placeholder={"Nunca prometas una unidad específica.\nSi piden factura, pide el RUC."} />
        <AvisoCampo campo="reglas_extra" />
      </div>

      <div className="border border-gray-100 rounded-xl p-3">
        <button type="button" className="text-xs font-semibold text-[#0b315f]" onClick={() => setVerPrompt((v) => !v)}>
          {verPrompt ? "▾" : "▸"} Ver las instrucciones completas que recibe la IA
        </button>
        {verPrompt && (
          <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap text-[11px] text-gray-600 bg-gray-50 rounded-lg p-3">
            {instrucciones ?? "Cargando… (refleja lo GUARDADO: guarda para ver los cambios)"}
          </pre>
        )}
      </div>
    </div>
  );
}
