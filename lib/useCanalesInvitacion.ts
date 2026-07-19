"use client";

import { useEffect, useState } from "react";

const KEY = "afa_canales_invitacion_pax";

/** Preferencia del operador (por navegador) sobre qué canales usar al enviar la
 *  invitación automática a un pasajero recién dado de alta. Por defecto ambos activos. */
export function useCanalesInvitacion() {
  const [canalEmail, setCanalEmail] = useState(true);
  const [canalWhatsapp, setCanalWhatsapp] = useState(true);

  useEffect(() => {
    try {
      const saved = localStorage.getItem(KEY);
      if (saved) {
        const v = JSON.parse(saved);
        if (typeof v.email === "boolean") setCanalEmail(v.email);
        if (typeof v.whatsapp === "boolean") setCanalWhatsapp(v.whatsapp);
      }
    } catch {}
  }, []);

  useEffect(() => {
    try { localStorage.setItem(KEY, JSON.stringify({ email: canalEmail, whatsapp: canalWhatsapp })); } catch {}
  }, [canalEmail, canalWhatsapp]);

  return { canalEmail, setCanalEmail, canalWhatsapp, setCanalWhatsapp };
}
