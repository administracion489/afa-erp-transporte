// npx tsx scripts/prueba-crm-enviar-texto.mts
// `enviarTextoCRM` (lib/crm-enviar-texto.ts) es `enviarPorCanal` de lib/crm-ia.ts EXTRAÍDA: con los
// valores por defecto tiene que hacer EXACTAMENTE lo mismo que el original (copiado literal abajo,
// con sus dependencias inyectadas): el mismo envío por el mismo canal, la misma fila en crm_mensajes,
// el mismo error y la misma actualización de la conversación. Además, lo nuevo: `generadoPorIa` y
// `enviadoPor`.
import { enviarTextoCRM, waDestinoDe, type DepsEnvioTexto } from "../lib/crm-enviar-texto";

let ok = 0, mal = 0;
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; console.log("✗", n); } };

// ── El original, copiado literal de lib/crm-ia.ts (antes de la extracción) ──
function waDestinoDeViejo(contacto: { wa_id?: unknown; telefono?: unknown } | null | undefined): string {
  if (contacto?.wa_id) return String(contacto.wa_id);
  return contacto?.telefono ? String(contacto.telefono).replace(/\D/g, "") : "";
}
// eslint-disable-next-line @typescript-eslint/no-explicit-any
async function enviarPorCanalViejo(sb: any, conv: any, contacto: any, texto: string, waDestinoFijo: string | undefined, d: Required<Pick<DepsEnvioTexto, "enviarWhatsApp" | "enviarMessenger" | "enviarInstagram" | "enviarEmail" | "phonePara">> & { explicar: (s: string) => string; ahora: () => number }): Promise<string | null> {
  let metaId: string | null = null;
  let gmailMsgId: string | null = null;
  let error: string | null = null;
  try {
    const waDestino = waDestinoFijo !== undefined ? waDestinoFijo : waDestinoDeViejo(contacto);
    if (conv.canal === "whatsapp" && waDestino)
      metaId = await d.enviarWhatsApp(waDestino, texto, conv.phone_number_id ?? (await d.phonePara("crm")));
    else if (conv.canal === "messenger" && contacto?.fb_psid) metaId = await d.enviarMessenger(contacto.fb_psid, texto);
    else if (conv.canal === "instagram" && contacto?.ig_id) metaId = await d.enviarInstagram(contacto.ig_id, texto);
    else if (conv.canal === "gmail" && contacto?.gmail_email) {
      const r = await d.enviarEmail(contacto.gmail_email, conv.asunto ?? "Re: Consulta", texto.replace(/\n/g, "<br>"), conv.gmail_thread_id ?? undefined);
      gmailMsgId = r.messageId;
    } else error = "Canal sin datos para enviar";
  } catch (e: any) {
    error = d.explicar(String(e?.message ?? "Error de envío"));
  }
  await sb.from("crm_mensajes").insert({
    conversacion_id: conv.id, direccion: "saliente", tipo: "texto", contenido: texto, meta_message_id: metaId,
    gmail_message_id: gmailMsgId, generado_por_ia: true, error,
  });
  await sb.from("crm_conversaciones").update({ ultimo_mensaje_at: new Date(d.ahora()).toISOString() }).eq("id", conv.id);
  return error;
}

// ── Una base que solo anota ──
const base = () => {
  const log: unknown[] = [];
  const sb = {
    from: (tabla: string) => ({
      insert: async (fila: unknown) => { log.push(["insert", tabla, fila]); return { error: null }; },
      update: (v: unknown) => ({ eq: async (c: string, x: unknown) => { log.push(["update", tabla, v, c, x]); return { error: null }; } }),
    }),
  };
  return { sb, log };
};

const AHORA = Date.parse("2026-10-22T15:00:00Z");
// El error de WhatsApp lo explica crm-meta; aquí se inyecta igual en los dos (la explicación no es lo que se prueba).
const llamadas = (falla: string | null) => {
  const visto: unknown[] = [];
  const d = {
    enviarWhatsApp: async (to: string, txt: string, phone?: string) => { visto.push(["wa", to, txt, phone]); if (falla === "wa") throw new Error("(#131047) Re-engagement message"); return "wamid.1"; },
    enviarMessenger: async (to: string, txt: string) => { visto.push(["fb", to, txt]); if (falla === "fb") throw new Error("fb caído"); return "mid.1"; },
    enviarInstagram: async (to: string, txt: string) => { visto.push(["ig", to, txt]); return "ig.1"; },
    enviarEmail: async (to: string, asunto: string, html: string, hilo?: string) => { visto.push(["mail", to, asunto, html, hilo]); return { messageId: "gm.1" }; },
    phonePara: async () => "PN-CRM",
  };
  return { d, visto };
};

const convs = [
  { id: "c1", canal: "whatsapp", phone_number_id: "PN-1" },
  { id: "c2", canal: "whatsapp", phone_number_id: null },
  { id: "c3", canal: "messenger" },
  { id: "c4", canal: "instagram" },
  { id: "c5", canal: "gmail", asunto: "Cotización", gmail_thread_id: "th-1" },
  { id: "c6", canal: "gmail" },
  { id: "c7", canal: "sms" },
];
const contactos = [
  { wa_id: "51987654321", telefono: null, fb_psid: "psid", ig_id: "igid", gmail_email: "a@b.test" },
  { wa_id: null, telefono: "+51 987-654-321" },
  { wa_id: null, telefono: null },
  null,
];
const fijos: (string | undefined)[] = [undefined, "51911111111", ""];
let n = 0;
for (const conv of convs) for (const ct of contactos) for (const fijo of fijos) for (const falla of [null, "wa", "fb"]) {
  n++;
  const a = base(), b = base();
  const la = llamadas(falla), lb = llamadas(falla);
  const explicar = (s: string) => `EXPLICADO: ${s}`;
  const errViejo = await enviarPorCanalViejo(a.sb, conv, ct, "Hola\nmundo", fijo, { ...la.d, explicar, ahora: () => AHORA });
  // El explicador real de crm-meta: el nuevo lo llama siempre; se compara el texto antes de explicar.
  const r = await enviarTextoCRM(b.sb, conv, ct, "Hola\nmundo", { waDestino: fijo }, { ...lb.d, ahoraMs: () => AHORA });
  const nombre = `${conv.canal}/${conv.id} · contacto ${contactos.indexOf(ct)} · fijo ${String(fijo)} · falla ${falla}`;
  t(`${nombre}: las mismas llamadas a los canales`, JSON.stringify(la.visto) === JSON.stringify(lb.visto));
  t(`${nombre}: hay error ⟺ había error`, (errViejo == null) === (r.error == null));
  if (errViejo == null) t(`${nombre}: la misma fila y el mismo update`, JSON.stringify(a.log) === JSON.stringify(b.log));
  else {
    // La fila es la misma salvo el texto del error (el nuevo usa el explicador real de crm-meta).
    const sinErr = (log: unknown[]) => JSON.stringify(log.map((x) => (Array.isArray(x) && x[0] === "insert" ? ["insert", x[1], { ...(x[2] as object), error: "·" }] : x)));
    t(`${nombre}: la misma fila (sin el texto del error) y el mismo update`, sinErr(a.log) === sinErr(b.log));
    t(`${nombre}: el error del canal sin datos es el mismo texto`, errViejo !== "Canal sin datos para enviar" || r.error === "Canal sin datos para enviar");
  }
}
t(`barrido: ${n} combinaciones`, n === convs.length * contactos.length * fijos.length * 3);

// Lo nuevo: las acciones de la tarjeta pasan quién y si lo «generó la IA».
{
  const b = base();
  const { d } = llamadas(null);
  await enviarTextoCRM(b.sb, convs[0], contactos[0], "x", { waDestino: "51987654321", generadoPorIa: true, enviadoPor: "u-1" }, { ...d, ahoraMs: () => AHORA });
  const fila = (b.log[0] as unknown[])[2] as Record<string, unknown>;
  t("con enviadoPor: la fila lo lleva y sigue generado_por_ia", fila.enviado_por === "u-1" && fila.generado_por_ia === true);
  const c = base();
  await enviarTextoCRM(c.sb, convs[0], contactos[0], "x", { generadoPorIa: false }, { ...d, ahoraMs: () => AHORA });
  const f2 = (c.log[0] as unknown[])[2] as Record<string, unknown>;
  t("generadoPorIa false: la fila dice false y no lleva enviado_por", f2.generado_por_ia === false && !("enviado_por" in f2));
  t("waDestinoDe ≡ el original", contactos.every((ct) => waDestinoDe(ct) === waDestinoDeViejo(ct)));
}

console.log(`\n${ok} OK · ${mal} mal`);
if (mal) process.exit(1);
console.log("Todo OK");
