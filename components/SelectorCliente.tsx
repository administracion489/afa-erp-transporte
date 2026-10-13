"use client";
/**
 * Buscador de clientes (combobox) — reemplaza al `<select>` de «Nueva cotización».
 *
 * No decide NADA: qué coincide, en qué orden y qué se resalta lo dice `lib/clientes-buscador.ts`
 * (matriz `scripts/prueba-clientes-buscador.mts`). El teclado, la lista ARIA y el «restaurar al
 * salir» viven en `components/ComboBuscador.tsx`, compartido con los buscadores de unidad.
 *  - Cerrado enseña al elegido (rótulo + documento) y una ✕; abierto, lo que se teclea.
 *  - Esc o salir del campo sin elegir RESTAURA el valor: nunca queda puesto lo resaltado.
 *  - Mientras carga dice «Cargando clientes…», jamás «sin resultados».
 */
import { useCallback, useMemo } from "react";
import ComboBuscador, { Resaltado, type ArmadoCombo, type OpcionCombo } from "@/components/ComboBuscador";
import {
  buscarClientes, documentoCliente, esBloqueado, rotuloCliente,
  type ClienteBuscable, type UsoCliente,
} from "@/lib/clientes-buscador";

type Props = {
  clientes: ClienteBuscable[];
  valor: string;
  onElegir: (c: ClienteBuscable | null) => void;
  uso?: Map<number, UsoCliente>;
  recientes?: number[];
  onCrear?: (texto: string) => void;
  cargando?: boolean;
  placeholder?: string;
};

const LIMITE = 50, MAX_SECCION = 8;

const fmtDia = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" });
};

export default function SelectorCliente({ clientes, valor, onElegir, uso, recientes, onCrear, cargando, placeholder }: Props) {
  const elegido = useMemo(() => (valor ? clientes.find(c => c.id === Number(valor)) ?? null : null), [clientes, valor]);

  // Lo que se ofrece. Sin texto: Recientes + Más cotizados (o alfabético si no hay uso).
  const armar = useCallback((q: string): ArmadoCombo<ClienteBuscable> => {
    const ops: OpcionCombo<ClienteBuscable>[] = [];
    const pies: string[] = [];
    const item = (c: ClienteBuscable, seccion?: string): OpcionCombo<ClienteBuscable> => ({ tipo: "item", clave: String(c.id), dato: c, seccion });
    if (!q) {
      const porId = new Map(clientes.map(c => [c.id, c]));
      const rec = (recientes ?? []).map(id => porId.get(id)).filter((c): c is ClienteBuscable => !!c && !esBloqueado(c)).slice(0, MAX_SECCION);
      rec.forEach(c => ops.push(item(c, "Recientes")));
      const yaRec = new Set(rec.map(c => c.id));
      const conUso = uso && uso.size > 0;
      if (conUso) {
        const top = buscarClientes(clientes, "", { uso }).resultados
          .filter(c => (uso!.get(c.id)?.cotizaciones ?? 0) > 0 && !yaRec.has(c.id)).slice(0, MAX_SECCION);
        top.forEach(c => ops.push(item(c, "Más cotizados")));
      }
      if (!ops.length) {
        const r = buscarClientes(clientes, "", { limite: LIMITE });
        r.resultados.forEach(c => ops.push(item(c, "Todos (A–Z)")));
        if (r.total > LIMITE) pies.push(`y ${r.total - LIMITE} más: escribe para buscar`);
      } else {
        pies.push("Escribe para buscar entre todos los clientes");
      }
    } else {
      const r = buscarClientes(clientes, q, { uso, limite: LIMITE });
      r.resultados.forEach(c => ops.push(item(c)));
      if (r.total > LIMITE) pies.push(`y ${r.total - LIMITE} más: afina la búsqueda`);
      if (r.bloqueadosCoinciden > 0) pies.push(`${r.bloqueadosCoinciden} cliente(s) bloqueado(s) coinciden (no se pueden cotizar)`);
      if (onCrear) ops.push({ tipo: "crear", texto: q });
    }
    return { opciones: ops, pies };
  }, [clientes, uso, recientes, onCrear]);

  const doc = elegido ? documentoCliente(elegido) : null;

  return (
    <ComboBuscador<ClienteBuscable>
      valor={valor}
      rotuloElegido={elegido ? rotuloCliente(elegido) : null}
      armar={armar}
      onElegir={c => onElegir(c)}
      onLimpiar={() => onElegir(null)}
      onCrear={onCrear}
      cargando={cargando}
      textoCargando="Cargando clientes…"
      anuncioCargando="Cargando clientes"
      ariaLabel="Buscar cliente"
      ariaLista="Clientes"
      etiquetaLimpiar="Quitar cliente"
      placeholder={placeholder ?? "Buscar por nombre, RUC, DNI, teléfono…"}
      rotuloSinDato={v => `Cliente #${v}`}
      extraElegido={doc && <span className="hidden sm:inline text-[10px] font-mono text-gray-400 max-w-[110px] truncate">{doc}</span>}
      renderCrear={t => <>
        + Crear cliente «{t}»
        <span className="text-[10px] font-normal text-gray-400">Se abre /clientes en otra pestaña con el dato puesto</span>
      </>}
      vacio={q => q
        ? `Ningún cliente coincide con «${q}» entre ${clientes.filter(c => !esBloqueado(c)).length}.`
        : "No hay clientes registrados."}
      renderItem={(c, texto) => {
        const u = uso?.get(c.id), d = documentoCliente(c);
        return <>
          <div className="flex items-center gap-2 min-w-0">
            <span className="text-sm font-semibold text-gray-800 truncate"><Resaltado texto={rotuloCliente(c)} q={texto} /></span>
            <span className="flex-shrink-0 text-[9px] font-bold uppercase rounded px-1.5 py-0.5" style={c.tipo === "b2b" ? { background: "#eef3f8", color: "#0b315f" } : { background: "#f5f3ff", color: "#6d28d9" }}>{c.tipo === "b2b" ? "Empresa" : "Persona"}</span>
            {c.estado === "inactivo" && <span className="flex-shrink-0 text-[9px] font-bold uppercase rounded px-1.5 py-0.5 bg-gray-100 text-gray-500">Inactivo</span>}
          </div>
          <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
            {d && <span className="font-mono"><Resaltado texto={d} q={texto} /></span>}
            {u && u.cotizaciones > 0 && <span>{u.cotizaciones} cotiz.{u.ultima ? ` · última ${fmtDia(u.ultima)}` : ""}</span>}
            {c.ciudad && <span>{c.ciudad}</span>}
          </div>
        </>;
      }}
    />
  );
}
