// lib/fetch-erp.ts — SOLO NAVEGADOR.
// Cabeceras para llamar a /api/* desde una pantalla del ERP: el servidor re-verifica
// sesión y permiso de módulo (lib/api-auth.ts), así que cada fetch tiene que llevar el
// access token de Supabase. Sin sesión se manda sin Authorization y el servidor decide
// (401, o modo de solo lectura en los endpoints que también sirven a páginas públicas).

import { supabase } from "@/lib/supabase";

export async function cabecerasErp(extra: Record<string, string> = {}): Promise<Record<string, string>> {
  const { data } = await supabase.auth.getSession();
  const token = data.session?.access_token;
  return {
    "Content-Type": "application/json",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...extra,
  };
}
