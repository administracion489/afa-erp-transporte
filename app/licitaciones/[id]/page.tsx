"use client";
// app/licitaciones/[id]/page.tsx — El editor de UNA licitación (propuesta técnica + expediente), por
// pasos: ?paso=bases|recursos|contenido|expediente|revision. Todo el estado y el guardado viven en
// components/licitaciones/editor/EditorLicitacion.tsx; cada paso en su componente (contrato-editor.ts).
// El gate de sesión y del módulo «licitaciones» es el de app/layout.tsx (la ruta cuelga de /licitaciones
// en menuGrupos) más usePermiso dentro del editor.
import { Suspense } from "react";
import { useParams } from "next/navigation";
import EditorLicitacion from "@/components/licitaciones/editor/EditorLicitacion";

function Interno() {
  const p = useParams<{ id: string }>();
  const crudo = Array.isArray(p?.id) ? p.id[0] : p?.id;
  const id = /^\d{1,15}$/.test(crudo ?? "") ? Number(crudo) : 0;
  // `key`: al ir a otra licitación (p. ej. tras «guardar como copia») el editor se monta de cero.
  return <EditorLicitacion key={id} id={id} />;
}

export default function PaginaLicitacion() {
  return (
    <Suspense fallback={<main className="p-4 md:p-6"><p className="text-sm text-gray-500">Abriendo la licitación…</p></main>}>
      <Interno />
    </Suspense>
  );
}
