"use client";

// lib/usePuedeVer.ts — ¿El usuario tiene estos módulos? Contesta SIN redirigir.
//
// `usePermiso` (lib/usePermiso.ts) es la guarda de una PANTALLA: si falta el módulo, manda a
// /dashboard. Para decidir si se PINTA un enlace hacia otra pantalla eso es justo lo que no se puede
// usar: la ficha de un servicio en /seguimiento expulsaría a quien tiene Seguimiento pero no
// Monitoreo. Este hook solo contesta, y el destino conserva su propia guarda (el layout y su API).
//
// Las mismas reglas que el layout y que `usePermiso`:
//   · el rol `admin` tiene todos los módulos (no tiene filas en `permisos_usuario`);
//   · el resto, los módulos con `permitido = true`.
//
// Tri-estado, sin afirmar nada mientras no se sabe:
//   · `null` mientras consulta: el enlace todavía no se pinta (no es un «no puedes»);
//   · si la consulta falla, todo `false`: el enlace es un atajo, y ofrecer uno que termina en un
//     rebote al dashboard es peor que no ofrecerlo.
//
// UNA consulta por usuario cada CACHE_MS, compartida por todos los que lo llamen: la ficha de
// /seguimiento se abre y se cierra decenas de veces en un turno, y cada apertura no puede costar
// dos consultas más. Cerrar sesión recarga la página (layout → /login), así que la caché no pasa
// de una persona a otra; igual se compara el usuario de la sesión en cada lectura.

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

type Acceso = { admin: boolean; modulos: ReadonlySet<string> };

/** Cuánto se reusa la respuesta. No medido: los permisos cambian rara vez, y el destino re-verifica. */
const CACHE_MS = 5 * 60_000;

let guardado: { uid: string; acceso: Acceso; en: number } | null = null;
let enVuelo: { uid: string; promesa: Promise<Acceso | null> } | null = null;

async function consultar(uid: string): Promise<Acceso | null> {
  const [perfil, permisos] = await Promise.all([
    supabase.from("usuarios").select("rol").eq("id", uid).maybeSingle(),
    supabase.from("permisos_usuario").select("modulo").eq("usuario_id", uid).eq("permitido", true),
  ]);
  if (perfil.error) return null;
  const admin = perfil.data?.rol === "admin";
  if (!admin && permisos.error) return null;
  const modulos = new Set<string>(
    ((permisos.data ?? []) as { modulo: string | null }[]).map((p) => String(p.modulo ?? "")).filter(Boolean),
  );
  const acceso: Acceso = { admin, modulos };
  guardado = { uid, acceso, en: Date.now() };
  return acceso;
}

/** El acceso del usuario de la sesión, de la caché si está fresca. `null` = no se pudo saber. */
async function leerAcceso(): Promise<Acceso | null> {
  const { data } = await supabase.auth.getSession();
  const uid: string | undefined = data?.session?.user?.id;
  if (!uid) return null;
  if (guardado && guardado.uid === uid && Date.now() - guardado.en < CACHE_MS) return guardado.acceso;
  if (enVuelo && enVuelo.uid === uid) return enVuelo.promesa;
  const promesa = consultar(uid)
    .catch(() => null)
    .finally(() => { if (enVuelo?.uid === uid) enVuelo = null; });
  enVuelo = { uid, promesa };
  return promesa;
}

/**
 * `{ modulo: puede }` para cada módulo pedido, o `null` mientras se consulta.
 * Pasa siempre la misma lista (una constante o un literal): la clave es su contenido, no su identidad.
 */
export function usePuedeVer(modulos: readonly string[]): Record<string, boolean> | null {
  const clave = modulos.join("|");
  const [resultado, setResultado] = useState<{ clave: string; valor: Record<string, boolean> } | null>(null);

  useEffect(() => {
    let vivo = true;
    void leerAcceso().then((acceso) => {
      if (!vivo) return;
      const valor: Record<string, boolean> = {};
      for (const m of clave.split("|")) {
        if (m) valor[m] = !!acceso && (acceso.admin || acceso.modulos.has(m));
      }
      setResultado({ clave, valor });
    });
    return () => { vivo = false; };
  }, [clave]);

  return resultado && resultado.clave === clave ? resultado.valor : null;
}

/**
 * ¿El usuario de la sesión es administrador del ERP (`usuarios.rol = 'admin'`)? `null` mientras se
 * consulta; `false` si la consulta falla (mismo criterio que `usePuedeVer`). Lo usa una pantalla
 * para enseñar en SOLO LECTURA un dato que la base solo deja cambiar a un administrador (p. ej.
 * `traslados_config.reserva_correo`, supabase/seguridad-05-reserva-dinero.sql): la regla la aplica
 * la base; esto solo evita ofrecer un campo que va a rechazar.
 */
export function useEsAdmin(): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let vivo = true;
    void leerAcceso().then((acceso) => { if (vivo) setAdmin(!!acceso?.admin); });
    return () => { vivo = false; };
  }, []);
  return admin;
}
