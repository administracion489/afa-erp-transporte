"use client";

// lib/useMensajesNoLeidos.ts
// Contador global (para toda la app) de mensajes de pasajeros sin atender + el
// último mensaje que llegó, para que el operador se entere sin importar en qué
// página del ERP esté. Se usa desde app/layout.tsx (fuente única) y de ahí se
// reparte tanto al badge del menú como al notificador (toast/sonido/aviso).

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";

export type MensajeNuevo = {
  id: number;
  pasajeroNombre: string;
  mensaje: string;
  tipo: string;
};

export function useMensajesNoLeidosPasajero(activo: boolean) {
  const [noLeidos, setNoLeidos] = useState(0);
  const [ultimo, setUltimo] = useState<MensajeNuevo | null>(null);
  const nombresCache = useRef<Map<number, string>>(new Map());

  const recontar = useCallback(async () => {
    const { count } = await supabase
      .from("mensajes_pasajero")
      .select("id", { count: "exact", head: true })
      .eq("remitente", "pasajero")
      .eq("leido", false);
    setNoLeidos(count || 0);
  }, []);

  useEffect(() => {
    if (!activo) return;
    recontar();

    const ch = supabase
      .channel("mensajes-pasajero-notificador")
      .on("postgres_changes", { event: "INSERT", schema: "public", table: "mensajes_pasajero" },
        async (payload: any) => {
          const m = payload.new;
          if (m.remitente !== "pasajero") return;
          recontar();

          let nombre = nombresCache.current.get(m.pasajero_id) || "Pasajero";
          if (m.pasajero_id && !nombresCache.current.has(m.pasajero_id)) {
            const { data } = await supabase.from("pasajeros").select("nombre").eq("id", m.pasajero_id).maybeSingle();
            if (data?.nombre) {
              nombre = data.nombre;
              nombresCache.current.set(m.pasajero_id, nombre);
            }
          }
          setUltimo({ id: m.id, pasajeroNombre: nombre, mensaje: m.mensaje, tipo: m.tipo });
        })
      .on("postgres_changes", { event: "UPDATE", schema: "public", table: "mensajes_pasajero" }, () => recontar())
      .subscribe();

    return () => { supabase.removeChannel(ch); };
  }, [activo, recontar]);

  return { noLeidos, ultimo };
}
