"use client";
// /crm/agente → Ajustes → «Comportamiento». Lo que el motor (lib/crm-ia.ts) antes tenía fijo.
// Los valores se normalizan con el MISMO normalizarAjustes que usa el motor: lo que se ve es
// lo que la IA va a hacer.
import React, { useState } from "react";
import { normalizarAjustes, saludoParaHora, AJUSTES_DEFECTO, RESUMEN_CUANDO, type AjustesIA, type ResumenCuando } from "@/lib/crm-ia-ajustes";

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";
const ayuda = "text-[11px] text-gray-400 mt-1";

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

function Fila({ titulo, detalle, on, onClick, children }: {
  titulo: string; detalle: string; on: boolean; onClick: () => void; children?: React.ReactNode;
}) {
  return (
    <div className="border border-gray-100 rounded-xl p-3 space-y-3">
      <div className="flex items-start justify-between gap-3">
        <div>
          <p className="text-sm font-semibold text-gray-700">{titulo}</p>
          <p className="text-xs text-gray-400">{detalle}</p>
        </div>
        <Interruptor on={on} onClick={onClick} />
      </div>
      {on && children}
    </div>
  );
}

const Num = ({ v, min, max, on }: { v: number; min: number; max: number; on: (n: number) => void }) => (
  <input type="number" min={min} max={max} className={input} value={v} onChange={(e) => on(Number(e.target.value))} />
);

export default function AjustesComportamiento({
  valor, onChange, transcripcionLista, instrucciones,
}: {
  valor: unknown;
  onChange: (v: AjustesIA) => void;
  /** null = no se sabe todavía. */
  transcripcionLista: boolean | null;
  instrucciones: string | null;
}) {
  // Los números se guardan tal cual se teclean y se acotan al guardar/usar: acotar en cada
  // tecla impediría escribir «15» (el «1» saltaría al mínimo).
  const a = { ...normalizarAjustes(valor), ...(valor && typeof valor === "object" ? (valor as object) : {}) } as AjustesIA;
  const n = normalizarAjustes(a);
  const set = <K extends keyof AjustesIA>(k: K, v: AjustesIA[K]) => onChange({ ...a, [k]: v });
  const [verPrompt, setVerPrompt] = useState(false);

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-bold text-gray-800">Comportamiento del agente</h3>
        <button type="button" className="text-xs text-[#0b315f] underline" onClick={() => onChange({ ...AJUSTES_DEFECTO })}>
          Restaurar valores por defecto
        </button>
      </div>

      <Fila
        titulo="👋 Saludar en el primer mensaje del día"
        detalle="Si hoy (hora de Lima) nadie le escribió todavía en ese chat, la respuesta empieza con el saludo y el nombre. Después no vuelve a saludar."
        on={a.saludo_activo} onClick={() => set("saludo_activo", !a.saludo_activo)}
      >
        <div className="grid grid-cols-3 gap-2">
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
      </Fila>

      <div className="border border-gray-100 rounded-xl p-3 space-y-2">
        <label className={label}>Cómo se presenta</label>
        <input className={input} value={a.presentarse_como} onChange={(e) => set("presentarse_como", e.target.value)} placeholder="el asistente de {empresa}" />
        <p className={ayuda}>{"{empresa}"} = el nombre de /configuracion/perfil.</p>
        <label className="flex items-center gap-2 text-sm text-gray-600">
          <input type="checkbox" checked={a.ocultar_ia} onChange={() => set("ocultar_ia", !a.ocultar_ia)} />
          No decir que es una IA salvo que se lo pregunten
        </label>
      </div>

      <Fila
        titulo="📋 No volver a pedir lo que el cliente ya dio"
        detalle="Antes de responder relee la conversación y arma la ficha del pedido (origen, destino, fecha, hora, pasajeros, equipaje, ida/vuelta, nombre). Si falta algo, lo pide todo junto y una sola vez; con los datos completos, los confirma y avanza con la cotización."
        on={a.recordar_datos} onClick={() => set("recordar_datos", !a.recordar_datos)}
      >
        <div>
          <label className={label}>Lugares que no necesitan dirección exacta</label>
          <input className={input} value={a.lugares_conocidos} onChange={(e) => set("lugares_conocidos", e.target.value)}
            placeholder="el aeropuerto, los terminales terrestres…" />
          <p className={ayuda}>Para que no pida «la calle o avenida» del aeropuerto. Vacío = ninguno.</p>
        </div>
        <div className="w-48">
          <label className={label}>Mensajes que relee</label>
          <Num v={a.mensajes_historial} min={10} max={60} on={(x) => set("mensajes_historial", x)} />
          <p className={ayuda}>Más mensajes = más contexto (y más costo).</p>
        </div>
      </Fila>

      <Fila
        titulo="🧾 Resumen del pedido"
        detalle={n.resumen_cuando === "al_final"
          ? "Mientras falten datos, la IA pide SOLO lo que falta, sin repetir lo que el cliente ya dio. Cuando tiene todo, muestra el resumen UNA vez. También al derivar a un ejecutivo."
          : "Mientras el cliente pide un servicio, cada respuesta termina con los datos que ya dio y SOLO los que faltan. Si ya está todo, lo confirma. También al derivar a un ejecutivo."}
        on={a.resumen_pedido} onClick={() => set("resumen_pedido", !a.resumen_pedido)}
      >
        <div>
          <label className={label}>¿Cuándo lo muestra?</label>
          <select className={input} value={n.resumen_cuando} onChange={(e) => set("resumen_cuando", e.target.value as ResumenCuando)}>
            {RESUMEN_CUANDO.map((o) => <option key={o.valor} value={o.valor}>{o.etiqueta}</option>)}
          </select>
        </div>
        <div>
          <label className={label}>Datos que forman el pedido</label>
          <textarea rows={2} className={input} value={a.campos_pedido} onChange={(e) => set("campos_pedido", e.target.value)} />
        </div>
        <div className="rounded-lg bg-[#d9fdd3] px-3 py-2 text-[12px] text-gray-800 whitespace-pre-line">
          {n.resumen_cuando === "al_final"
            ? "Mientras falten datos:\n¿Me indica la fecha, la hora de recojo y cuántas maletas de 23 kg llevan?\n\nCon todo completo:\n📋 Resumen de su solicitud\n• Ruta: Surco → Aeropuerto\n• Fecha y hora: martes 20/10, 5:00 a. m.\n• Pasajeros: 18, con maletas de 23 kg\n• Servicio: solo ida\n• Nombre: Paola Huarachi\nCon esto ya tengo todo lo necesario."
            : "Ejemplo:\n📋 Resumen de su solicitud\n• Ruta: Surco → Aeropuerto\n• Fecha y hora: martes 20/10, 5:00 a. m.\n• Pasajeros: 18, con maletas de 23 kg\n• Servicio: solo ida\n• Nombre: Paola Huarachi\nSolo me falta: la dirección exacta de recojo en Surco."}
        </div>
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
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={label}>Etiqueta que pone al chat</label>
            <input className={input} value={a.etiqueta_derivacion} onChange={(e) => set("etiqueta_derivacion", e.target.value)} placeholder="(ninguna)" />
            <p className={ayuda}>Vacía = no etiqueta. Filtra la bandeja por ella para ver lo pendiente.</p>
          </div>
          <label className="flex items-start gap-2 text-sm text-gray-600 mt-5">
            <input type="checkbox" className="mt-1" checked={a.nota_interna_derivacion} onChange={() => set("nota_interna_derivacion", !a.nota_interna_derivacion)} />
            Dejar una nota interna 🔒 con el motivo y lo que pidió el cliente
          </label>
        </div>
        <p className={ayuda}>La IA queda pausada en ese chat. El texto que recibe el cliente es «Mensaje al derivar a un ejecutivo» (arriba).</p>
      </div>

      <Fila
        titulo="🎤 Escuchar notas de voz"
        detalle="Transcribe cada audio al llegar: el equipo lee la transcripción bajo el reproductor y la IA responde como si fuera texto."
        on={a.transcribir_audios} onClick={() => set("transcribir_audios", !a.transcribir_audios)}
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
        titulo="🖼️ Leer fotos y PDF"
        detalle="La IA mira las fotos y documentos que manda el cliente (fechas, rutas, pasajeros). Apagado: dice que un ejecutivo los revisará."
        on={a.leer_archivos} onClick={() => set("leer_archivos", !a.leer_archivos)}
      >
        <div className="w-48"><label className={label}>Archivos recientes que lee</label><Num v={a.max_archivos} min={1} max={8} on={(x) => set("max_archivos", x)} /></div>
      </Fila>

      <div className="border border-gray-100 rounded-xl p-3 space-y-2">
        <p className="text-sm font-semibold text-gray-700">⏳ Esperar a que el cliente termine de escribir</p>
        <p className="text-xs text-gray-400">Responde una sola vez a varios mensajes seguidos. Mientras espera, el cliente ve ✓✓ y «escribiendo…».</p>
        <div className="grid grid-cols-3 gap-2">
          <div><label className={label}>Silencio normal (seg)</label><Num v={a.silencio_seg} min={1} max={60} on={(x) => set("silencio_seg", x)} /></div>
          <div><label className={label}>Si el mensaje parece completo (seg)</label><Num v={a.silencio_completo_seg} min={1} max={60} on={(x) => set("silencio_completo_seg", x)} /></div>
          <div><label className={label}>Espera máxima (seg)</label><Num v={a.espera_max_seg} min={5} max={120} on={(x) => set("espera_max_seg", x)} /></div>
        </div>
        <p className={ayuda}>«Parece completo» = termina en «?», es largo o es un documento.</p>
      </div>

      <div className="border border-gray-100 rounded-xl p-3 space-y-2">
        <label className={label}>📋 Reglas propias del negocio (una por línea)</label>
        <textarea rows={4} className={input} value={a.reglas_extra} onChange={(e) => set("reglas_extra", e.target.value)}
          placeholder={"Nunca prometas una unidad específica.\nSi piden factura, pide el RUC."} />
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
