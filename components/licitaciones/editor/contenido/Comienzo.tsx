"use client";
// components/licitaciones/editor/contenido/Comienzo.tsx — Las tres formas de empezar la propuesta cuando
// todavía no tiene secciones. (Duplicar otra licitación se hace desde la lista de licitaciones.)

export default function Comienzo({ plantilla, importar, blanco }: { plantilla: () => void; importar: () => void; blanco: () => void }) {
  const opciones = [
    { icono: "📋", titulo: "Empezar con la plantilla base", texto: "Veinte secciones de una propuesta de transporte de personal, con texto genérico, {variables} que salen del ERP y marcas [COMPLETAR] donde va lo de este concurso.", accion: plantilla, primario: true },
    { icono: "📄", titulo: "Importar desde Word", texto: "Convierte un .docx existente: Título 1 en secciones, Título 2 en subtítulos, tablas, listas e imágenes. Antes de aplicar se ve todo lo que trae.", accion: importar, primario: false },
    { icono: "✏️", titulo: "Empezar en blanco", texto: "Una sección vacía para escribir desde cero. La portada, el control, la carta y el glosario se completan aparte.", accion: blanco, primario: false },
  ];
  return (
    <section className="rounded-2xl border border-[#0b315f]/20 bg-[#0b315f]/[0.03] p-4 sm:p-5" aria-label="Cómo empezar la propuesta">
      <h3 className="text-base font-semibold text-[#0b315f]">La propuesta técnica todavía no tiene secciones</h3>
      <p className="mt-0.5 text-xs text-gray-600">Elige cómo empezar. Todo se puede cambiar después; para copiar otra licitación, usa «Duplicar» en la lista de licitaciones.</p>
      <div className="mt-3 grid grid-cols-1 gap-3 md:grid-cols-3">
        {opciones.map((o) => (
          <button key={o.titulo} type="button" onClick={o.accion}
            className={`flex min-h-28 flex-col items-start gap-1 rounded-xl border bg-white p-4 text-left transition hover:shadow-md ${o.primario ? "border-[#0b315f]" : "border-gray-200"}`}>
            <span className="text-xl" aria-hidden>{o.icono}</span>
            <span className="text-sm font-semibold text-gray-900">{o.titulo}</span>
            <span className="text-xs text-gray-600">{o.texto}</span>
          </button>
        ))}
      </div>
    </section>
  );
}
