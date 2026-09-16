// lib/redes/publicadores/index.ts — El mapa red → publicador, en un solo sitio.
//
// Es un `Record` completo sobre `Red` a propósito: si mañana se añade una red al
// catálogo y nadie escribe su publicador, esto NO COMPILA. Un `switch` con `default`,
// o un objeto parcial, dejarían la red nueva fallando en ejecución con un «undefined is
// not a function» a las seis de la mañana, dentro del cron — que es exactamente el tipo
// de fallo que este repo persigue con los códigos declarados.

import type { Red } from "../tipos";
import type { Publicador } from "./tipos";
import { publicarFacebook, publicarInstagram } from "./meta";
import { publicarYouTube } from "./youtube";
import { publicarTikTok } from "./tiktok";
import { prepararEstadoWhatsApp } from "./whatsapp-estado";

export const PUBLICADORES: Record<Red, Publicador> = {
  facebook: publicarFacebook,
  instagram: publicarInstagram,
  tiktok: publicarTikTok,
  youtube: publicarYouTube,
  whatsapp_estado: prepararEstadoWhatsApp,
};

export type { Publicador, PiezaAPublicar, ResultadoPublicacion } from "./tipos";
