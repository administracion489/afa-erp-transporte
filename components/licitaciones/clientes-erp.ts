"use client";
// components/licitaciones/clientes-erp.ts — Los clientes del ERP para el selector de /licitaciones
// (nueva licitación y experiencia). lib/licitaciones/datos.ts no trae una lectura de `clientes`, así
// que se lee aquí con la MISMA consulta que /cotizaciones (select *, orden nombre + id, paginado):
// el selector es components/SelectorCliente y necesita los campos de ClienteBuscable.
//
// Una lectura fallida NO es «no hay clientes»: el selector queda deshabilitado y se dice por qué, y
// siempre se puede escribir el nombre a mano. Se lee una vez por carga de la página (caché del
// módulo) y se comparte entre las pestañas.

import { useCallback, useEffect, useState } from "react";
import { todasLasPaginas } from "@/lib/paginar-estricto";
import type { ClienteBuscable } from "@/lib/clientes-buscador";

type Estado = { clientes: ClienteBuscable[]; cargando: boolean; error: string | null };

let promesa: Promise<ClienteBuscable[]> | null = null;

async function leerClientes(): Promise<ClienteBuscable[]> {
  const { supabase } = await import("@/lib/supabase");
  const filas = await todasLasPaginas<ClienteBuscable>(() => supabase.from("clientes").select("*").order("nombre").order("id"));
  return filas.filter((c) => c && Number.isSafeInteger(Number(c.id)));
}

export function useClientesErp(activo: boolean = true): Estado & { reintentar: () => void } {
  const [estado, setEstado] = useState<Estado>({ clientes: [], cargando: true, error: null });
  const [intento, setIntento] = useState(0);

  useEffect(() => {
    if (!activo) return;
    let vivo = true;
    if (!promesa) promesa = leerClientes();
    const p = promesa;
    p.then((clientes) => { if (vivo) setEstado({ clientes, cargando: false, error: null }); })
      .catch((e: unknown) => {
        if (promesa === p) promesa = null; // el próximo intento vuelve a leer
        if (vivo) setEstado({ clientes: [], cargando: false, error: e instanceof Error ? e.message : String(e) });
      });
    return () => { vivo = false; };
  }, [activo, intento]);

  const reintentar = useCallback(() => {
    promesa = null;
    setEstado((s) => ({ ...s, cargando: true, error: null }));
    setIntento((n) => n + 1);
  }, []);

  return { ...estado, reintentar };
}
