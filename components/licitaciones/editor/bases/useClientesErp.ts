"use client";
// components/licitaciones/editor/bases/useClientesErp.ts — Los clientes del ERP para el selector del
// paso «Bases». Se leen paginados (PostgREST corta en 1000) con orden total; si la lectura falla se dice
// (y se puede escribir el nombre a mano): nunca se ofrece una lista vacía como si no hubiera clientes.
import { useCallback, useEffect, useState } from "react";
import { todasLasPaginas, type ConsultaPaginable } from "@/lib/paginar-estricto";
import type { ClienteBuscable } from "@/lib/clientes-buscador";

export type ClientesErp = { clientes: ClienteBuscable[]; cargando: boolean; error: string | null; reintentar: () => void };

export function useClientesErp(): ClientesErp {
  const [clientes, setClientes] = useState<ClienteBuscable[]>([]);
  const [cargando, setCargando] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    let vivo = true;
    (async () => {
      try {
        const { supabase } = await import("@/lib/supabase");
        const filas = await todasLasPaginas<ClienteBuscable>(
          () => supabase.from("clientes").select("id,nombre,empresa,tipo,ruc,dni,estado").order("nombre").order("id") as unknown as ConsultaPaginable<ClienteBuscable>,
        );
        if (!vivo) return;
        setClientes(filas.map((f) => ({ ...f, id: Number(f.id), nombre: String(f.nombre ?? "") })));
        setError(null);
      } catch (e) {
        if (!vivo) return;
        setError(e instanceof Error ? e.message : String(e ?? "error"));
      } finally {
        if (vivo) setCargando(false);
      }
    })();
    return () => { vivo = false; };
  }, [intento]);

  const reintentar = useCallback(() => { setCargando(true); setIntento((n) => n + 1); }, []);
  return { clientes, cargando, error, reintentar };
}
