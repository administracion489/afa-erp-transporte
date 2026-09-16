// ──────────────────────────────────────────────────────────────────────────────
// lib/redes/publicadores/whatsapp-estado.ts — El kit del estado de WhatsApp.
//
// ESTO NO PUBLICA NADA, Y NO ES UNA LIMITACIÓN TEMPORAL: **NO EXISTE NINGUNA API PARA
// PUBLICAR ESTADOS DE WHATSAPP.** La Cloud API de Meta manda mensajes a conversaciones
// y nunca ha tenido un endpoint de estados. Lo que sí los publica es un cliente NO
// OFICIAL tipo Baileys, y aquí se cruzarían dos líneas que este repo tiene escritas:
//
//   1. El CLAUDE.md prohíbe vincular Baileys a los dos números que ya están en la
//      Cloud API (+51 966 707 225 y +51 905 438 216): el QR de WhatsApp Web rompe la
//      integración oficial. Esa es la razón de que el Radar tenga chip propio.
//   2. Y aunque se usara el chip del Radar (+51 997 683 199), **un estado solo lo ven
//      los contactos que tienen ese número guardado**. Nadie tiene agendado el chip del
//      Radar, así que sería publicar para nadie — con el riesgo extra de que WhatsApp
//      bloquee por cliente no oficial el número que sostiene el Radar IA.
//
// LA SALIDA REAL, QUE ES LA QUE ELIGIÓ EL DUEÑO: el agente ARMA la pieza y se la manda
// por WhatsApp a quien tiene el celular, y esa persona la publica desde el número de
// atención al cliente —el que los clientes sí tienen guardado— con dos toques. En
// coexistencia ese número sigue vivo en la app del celular, así que se puede.
//
// El motor ya lo sabe (`publicaPorApi: false` → motivo `publicacion_manual`), y el
// destino queda en estado `preparado`, no `publicado`: afirmar que salió algo que
// depende de que alguien abra el celular sería mentir en la única pantalla que dice
// qué se publicó hoy.
// ──────────────────────────────────────────────────────────────────────────────

import { enviarWhatsAppMedia, enviarWhatsApp } from "@/lib/crm-meta";
import type { Publicador } from "./tipos";

/**
 * Manda el kit al celular. El «éxito» aquí es que la pieza LLEGÓ, no que se publicó.
 */
export const prepararEstadoWhatsApp: Publicador = async (cuenta, pieza) => {
  const destino = cuenta.destino_telefono;
  if (!destino) {
    return {
      ok: false,
      error:
        "No hay número al que mandarle la pieza del estado. Configúralo en /redes → Cuentas.",
    };
  }

  // El texto lleva la instrucción, no solo el contenido. Quien recibe esto está en la
  // calle mirando el celular: si le llega una imagen suelta no sabe si es para publicar,
  // para reenviar o para archivar, y a la tercera vez deja de hacerlo.
  const instruccion =
    `📲 *Estado de WhatsApp de hoy*\n\n` +
    `${pieza.texto}\n\n` +
    `— — —\n` +
    `Publícalo como ESTADO desde el número de atención al cliente. ` +
    `El texto de arriba se puede copiar y pegar.`;

  try {
    if (pieza.media?.tipo === "imagen") {
      const id = await enviarWhatsAppMedia(destino, "image", pieza.media.url, instruccion);
      return { ok: true, id_externo: id ?? undefined, nota: NOTA_MANUAL };
    }

    if (pieza.media?.tipo === "video") {
      // `enviarWhatsAppMedia` admite image/document/audio, no video. Mandar un .mp4
      // como `document` funciona —llega y se puede guardar— pero NO se reproduce en el
      // chat, así que se dice: creer que el video se rompió es motivo suficiente para
      // no publicarlo.
      const id = await enviarWhatsAppMedia(destino, "document", pieza.media.url, instruccion);
      return {
        ok: true,
        id_externo: id ?? undefined,
        nota:
          "El video va como archivo adjunto (WhatsApp lo manda así por esta vía): " +
          "descárgalo en el celular y publícalo como estado. " + NOTA_MANUAL,
      };
    }

    const id = await enviarWhatsApp(destino, instruccion);
    return { ok: true, id_externo: id ?? undefined, nota: NOTA_MANUAL };
  } catch (e: any) {
    return { ok: false, error: String(e?.message ?? e) };
  }
};

const NOTA_MANUAL =
  "No existe API para publicar estados de WhatsApp: la pieza está lista y la publicas tú.";
