"use client";
// components/licitaciones/editor/recursos/SelectorPersonal.tsx — «Elegir del personal del ERP» para un
// contacto del contrato o el representante legal. Busca en `leerPersonal()` (personal administrativo
// activo). Elegir devuelve la persona: quien llama guarda solo su `personalId` y deja vacíos los textos,
// porque se DERIVAN de personal_administrativo (lo dice el tipo Contacto / Representante).
// Si la lectura falla se dice, y la pantalla queda solo con «Escribir a mano».

import { useCallback } from "react";
import ComboBuscador, { Resaltado, type ArmadoCombo, type OpcionCombo } from "@/components/ComboBuscador";
import { coincideBusqueda, terminosBusqueda } from "@/lib/busqueda-texto";
import type { leerPersonal } from "@/lib/licitaciones/datos";
import type { PersonaERP } from "@/lib/licitaciones/tipos";
import { Nota } from "./comun";

export type ResPersonal = Awaited<ReturnType<typeof leerPersonal>>;
const LIMITE = 40;

export default function SelectorPersonal({ personal, onElegir, recargar, actualId, etiqueta }: {
  personal: ResPersonal | null; onElegir: (p: PersonaERP) => void; recargar: () => void;
  /** La persona ya elegida (no se ofrece de nuevo como si fuera otra). */
  actualId?: number | null; etiqueta: string;
}) {
  const armar = useCallback((q: string): ArmadoCombo<PersonaERP> => {
    if (!personal?.ok) return { opciones: [], pies: [] };
    const t = terminosBusqueda(q);
    const lista = personal.filas.filter((x) => coincideBusqueda([x.nombre, x.dni, x.cargo, x.email, x.telefono].filter(Boolean).join(" "), t));
    const ops: OpcionCombo<PersonaERP>[] = lista.slice(0, LIMITE).map((x) => ({ tipo: "item", clave: String(x.id), dato: x }));
    return { opciones: ops, pies: lista.length > LIMITE ? [`y ${lista.length - LIMITE} más: escribe para buscar`] : [] };
  }, [personal]);

  if (personal && !personal.ok) {
    return (
      <Nota tono="ambar">
        No se pudo leer el personal del ERP ({personal.error}). Mientras tanto, escribe los datos a mano.{" "}
        <button type="button" className="font-semibold underline" onClick={recargar}>Reintentar</button>
      </Nota>
    );
  }
  return (
    <ComboBuscador<PersonaERP>
      valor="" rotuloElegido={null} armar={armar} onElegir={onElegir} onLimpiar={() => {}}
      cargando={!personal} textoCargando="Cargando el personal…" anuncioCargando="Cargando el personal"
      ariaLabel={etiqueta} ariaLista="Personal administrativo" etiquetaLimpiar="Limpiar"
      placeholder="Busca por nombre, DNI o cargo…"
      vacio={(q) => (q ? `Nadie del personal coincide con «${q}».` : "No hay personal administrativo activo registrado.")}
      renderItem={(x, texto) => (
        <div className={x.id === actualId ? "opacity-60" : ""}>
          <p className="text-sm font-semibold text-gray-800"><Resaltado texto={x.nombre} q={texto} />{x.id === actualId ? " · ya elegida" : ""}</p>
          <p className="text-[11px] text-gray-500">{[x.cargo, x.dni ? `DNI ${x.dni}` : null, x.telefono, x.email].filter(Boolean).join(" · ") || "Sin cargo ni datos de contacto en su ficha"}</p>
        </div>
      )}
    />
  );
}
