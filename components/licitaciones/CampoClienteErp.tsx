"use client";
// components/licitaciones/CampoClienteErp.tsx — «Cliente del ERP (opcional)» con el buscador de
// clientes de /cotizaciones. Solo ELIGE: qué nombre o RUC se escribe en el formulario lo decide quien
// lo usa (onElegir recibe el cliente o null). Si la lista no se pudo leer lo dice y deja reintentar:
// el nombre siempre se puede escribir a mano.

import SelectorCliente from "@/components/SelectorCliente";
import type { ClienteBuscable } from "@/lib/clientes-buscador";
import { useClientesErp } from "./clientes-erp";

export default function CampoClienteErp({ valor, onElegir, deshabilitado }: {
  valor: number | null; onElegir: (c: ClienteBuscable | null) => void; deshabilitado?: boolean;
}) {
  const { clientes, cargando, error, reintentar } = useClientesErp(true);
  if (error) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900">
        No se pudo leer la lista de clientes del ERP ({error}). Escribe el nombre a mano o{" "}
        <button type="button" onClick={reintentar} className="underline font-bold">reintenta</button>.
      </div>
    );
  }
  return (
    <div className={deshabilitado ? "pointer-events-none opacity-50" : ""}>
      <SelectorCliente
        clientes={clientes}
        valor={valor != null ? String(valor) : ""}
        onElegir={onElegir}
        cargando={cargando}
        placeholder="Buscar un cliente del ERP (opcional)…"
      />
    </div>
  );
}
