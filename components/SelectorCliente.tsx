"use client";
/**
 * Buscador de clientes (combobox) — reemplaza al `<select>` de «Nueva cotización».
 *
 * No decide NADA: qué coincide, en qué orden y qué se resalta lo dice `lib/clientes-buscador.ts`
 * (matriz `scripts/prueba-clientes-buscador.mts`). Aquí solo se pinta y se maneja el teclado.
 *  - Cerrado enseña al elegido (rótulo + documento) y una ✕; abierto, lo que se teclea.
 *  - Esc o salir del campo sin elegir RESTAURA el valor: nunca queda puesto lo resaltado.
 *  - Mientras carga dice «Cargando clientes…», jamás «sin resultados».
 */
import React, { useId, useMemo, useState } from "react";
import {
  buscarClientes, documentoCliente, esBloqueado, rotuloCliente, tramosResaltados,
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
type Opcion = { tipo: "cliente"; c: ClienteBuscable; seccion?: string } | { tipo: "crear"; texto: string };

const fmtDia = (iso: string | null) => {
  if (!iso) return "";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? "" : d.toLocaleDateString("es-PE", { timeZone: "America/Lima", day: "2-digit", month: "2-digit", year: "numeric" });
};

/** Texto con sus tramos resaltados como <mark> (nodos React, nunca HTML crudo). */
function Resaltado({ texto, q }: { texto: string; q: string }) {
  const tramos = q.trim() ? tramosResaltados(texto, q) : [];
  if (!tramos.length) return <>{texto}</>;
  const out: React.ReactNode[] = [];
  let i = 0;
  tramos.forEach((t, k) => {
    if (t.desde > i) out.push(texto.slice(i, t.desde));
    out.push(<mark key={k} className="bg-amber-100 text-inherit rounded-sm">{texto.slice(t.desde, t.hasta)}</mark>);
    i = t.hasta;
  });
  if (i < texto.length) out.push(texto.slice(i));
  return <>{out}</>;
}

export default function SelectorCliente({ clientes, valor, onElegir, uso, recientes, onCrear, cargando, placeholder }: Props) {
  const idBase = useId();
  const listId = `${idBase}-lista`;
    const [abierto, setAbierto] = useState(false);
  const [texto, setTexto] = useState("");
  const [activo, setActivo] = useState(-1);

  const elegido = useMemo(() => (valor ? clientes.find(c => c.id === Number(valor)) ?? null : null), [clientes, valor]);

  // Lo que se ofrece. Sin texto: Recientes + Más cotizados (o alfabético si no hay uso).
  const { opciones, pie } = useMemo(() => {
    const ops: Opcion[] = [];
    const pies: string[] = [];
    const q = texto.trim();
    if (!q) {
      const porId = new Map(clientes.map(c => [c.id, c]));
      const rec = (recientes ?? []).map(id => porId.get(id)).filter((c): c is ClienteBuscable => !!c && !esBloqueado(c)).slice(0, MAX_SECCION);
      rec.forEach(c => ops.push({ tipo: "cliente", c, seccion: "Recientes" }));
      const yaRec = new Set(rec.map(c => c.id));
      const conUso = uso && uso.size > 0;
      if (conUso) {
        const top = buscarClientes(clientes, "", { uso }).resultados
          .filter(c => (uso!.get(c.id)?.cotizaciones ?? 0) > 0 && !yaRec.has(c.id)).slice(0, MAX_SECCION);
        top.forEach(c => ops.push({ tipo: "cliente", c, seccion: "Más cotizados" }));
      }
      if (!ops.length) {
        const r = buscarClientes(clientes, "", { limite: LIMITE });
        r.resultados.forEach(c => ops.push({ tipo: "cliente", c, seccion: "Todos (A–Z)" }));
        if (r.total > LIMITE) pies.push(`y ${r.total - LIMITE} más: escribe para buscar`);
      } else {
        pies.push("Escribe para buscar entre todos los clientes");
      }
    } else {
      const r = buscarClientes(clientes, q, { uso, limite: LIMITE });
      r.resultados.forEach(c => ops.push({ tipo: "cliente", c }));
      if (r.total > LIMITE) pies.push(`y ${r.total - LIMITE} más: afina la búsqueda`);
      if (r.bloqueadosCoinciden > 0) pies.push(`${r.bloqueadosCoinciden} cliente(s) bloqueado(s) coinciden (no se pueden cotizar)`);
      if (onCrear) ops.push({ tipo: "crear", texto: q });
    }
    return { opciones: ops, pie: pies };
  }, [clientes, texto, uso, recientes, onCrear]);

  const nClientes = opciones.filter(o => o.tipo === "cliente").length;

  const cerrar = () => { setAbierto(false); setTexto(""); setActivo(-1); };
  const abrir = () => { if (abierto) return; setAbierto(true); setTexto(""); setActivo(-1); };
  const elegir = (o: Opcion | undefined) => {
    if (!o) return;
    if (o.tipo === "crear") onCrear?.(o.texto);
    else onElegir(o.c);
    cerrar();
  };
  const mover = (d: number) => {
    if (!opciones.length) return;
    const n = activo < 0 ? (d > 0 ? 0 : opciones.length - 1) : (activo + d + opciones.length) % opciones.length;
    setActivo(n);
    document.getElementById(`${idBase}-op-${n}`)?.scrollIntoView({ block: "nearest" });
  };

  const onKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (!abierto) abrir(); else mover(1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); if (!abierto) abrir(); else mover(-1); }
    else if (e.key === "Enter") { if (abierto) { e.preventDefault(); if (activo >= 0) elegir(opciones[activo]); } }
    else if (e.key === "Escape") { if (abierto) { e.preventDefault(); e.stopPropagation(); cerrar(); } }
    else if (e.key === "Tab") { if (abierto && activo >= 0) elegir(opciones[activo]); else if (abierto) cerrar(); }
  };

  const doc = elegido ? documentoCliente(elegido) : null;
  const mostrado = abierto ? texto
    : elegido ? rotuloCliente(elegido)
    : valor ? (cargando ? "Cargando…" : `Cliente #${valor}`) : "";
  const idActivo = abierto && activo >= 0 ? `${idBase}-op-${activo}` : undefined;
  const anuncio = !abierto ? "" : cargando ? "Cargando clientes" : `${nClientes} resultado${nClientes === 1 ? "" : "s"}`;

  return (
    <div className="relative w-full">
      <span aria-hidden className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-sm text-gray-400">🔍</span>
      <input
        role="combobox" aria-expanded={abierto} aria-controls={listId} aria-autocomplete="list"
        aria-activedescendant={idActivo} inputMode="search" autoComplete="off" spellCheck={false}
        className={`w-full border border-gray-200 rounded-xl pl-9 ${elegido && !abierto ? "pr-24" : "pr-3"} py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20 focus:border-[#0b315f] transition-all ${!abierto && !elegido && valor ? "text-gray-400" : ""}`}
        placeholder={abierto && elegido ? rotuloCliente(elegido) : (placeholder ?? "Buscar por nombre, RUC, DNI, teléfono…")}
        value={mostrado}
        onFocus={abrir}
        onClick={abrir}
        onBlur={cerrar}
        onChange={e => { setAbierto(true); setTexto(e.target.value); setActivo(e.target.value.trim() ? 0 : -1); }}
        onKeyDown={onKeyDown}
      />
      {elegido && !abierto && (
        <div className="absolute right-2 top-1/2 -translate-y-1/2 flex items-center gap-1.5">
          {doc && <span className="hidden sm:inline text-[10px] font-mono text-gray-400 max-w-[110px] truncate">{doc}</span>}
          <button type="button" aria-label="Quitar cliente" title="Quitar cliente"
            onMouseDown={e => e.preventDefault()} onClick={() => onElegir(null)}
            className="w-7 h-7 rounded-lg text-gray-400 hover:text-red-600 hover:bg-red-50 flex items-center justify-center text-sm">✕</button>
        </div>
      )}
      <span className="sr-only" aria-live="polite">{anuncio}</span>
      {abierto && (
        // mousedown dentro de la lista (también su barra de desplazamiento) no quita el foco al campo.
        <div onMouseDown={e => e.preventDefault()} className="absolute left-0 right-0 z-30 mt-1 bg-white border border-gray-200 rounded-xl shadow-lg overflow-hidden">
          <ul id={listId} role="listbox" aria-label="Clientes" className="max-h-[50vh] overflow-y-auto overscroll-contain">
            {cargando ? (
              <li role="presentation" className="px-3 py-3 text-xs text-gray-400">Cargando clientes…</li>
            ) : opciones.map((o, i) => {
              const previa = i > 0 ? opciones[i - 1] : undefined;
              const cab = o.tipo === "cliente" && o.seccion && (previa?.tipo !== "cliente" || previa.seccion !== o.seccion) ? o.seccion : null;
              const act = i === activo;
              const base = `px-3 py-2 min-h-[44px] cursor-pointer flex flex-col justify-center ${act ? "bg-[#eef3f8]" : "hover:bg-gray-50"}`;
              const comunes = {
                id: `${idBase}-op-${i}`, role: "option" as const, "aria-selected": act,
                onMouseDown: (e: React.MouseEvent) => { e.preventDefault(); elegir(o); },
                onMouseEnter: () => setActivo(i),
              };
              if (o.tipo === "crear") return (
                <li key="crear" {...comunes} className={`${base} border-t border-gray-100 text-sm font-bold text-[#0b315f]`}>
                  + Crear cliente «{o.texto}»
                  <span className="text-[10px] font-normal text-gray-400">Se abre /clientes en otra pestaña con el dato puesto</span>
                </li>
              );
              const c = o.c, u = uso?.get(c.id), d = documentoCliente(c);
              return (
                <React.Fragment key={`${o.seccion ?? ""}-${c.id}`}>
                  {cab && <li role="presentation" className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-widest text-gray-400 bg-gray-50">{cab}</li>}
                  <li {...comunes} className={base}>
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
                  </li>
                </React.Fragment>
              );
            })}
            {!cargando && nClientes === 0 && (
              <li role="presentation" className="px-3 py-3 text-xs text-gray-500">
                {texto.trim() ? `Ningún cliente coincide con «${texto.trim()}» entre ${clientes.filter(c => !esBloqueado(c)).length}.` : "No hay clientes registrados."}
              </li>
            )}
          </ul>
          {!cargando && pie.length > 0 && (
            <div className="border-t border-gray-100 bg-gray-50 px-3 py-1.5 space-y-0.5">
              {pie.map(p => <p key={p} className="text-[10px] text-gray-400">{p}</p>)}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
