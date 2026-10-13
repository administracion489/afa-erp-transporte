"use client";
/**
 * Buscador de unidad de flota (propia o tercerizada) para «Unidad de flota → fotos en PDF» de
 * /cotizaciones. Reemplaza a los dos `<select>` nativos.
 *
 * No decide NADA: qué coincide, en qué orden y en qué sección lo dice `lib/vehiculos-buscador.ts`
 * (matriz `scripts/prueba-vehiculos-buscador.mts`); el teclado y la lista ARIA, `ComboBuscador`.
 * Elegir devuelve el id como texto (o "" para «Sin vehículo…»), que es lo que reciben
 * `selVeh`/`selVehTercero` — siguen siendo la única forma de elegir y son excluyentes entre sí.
 */
import { useCallback, useMemo } from "react";
import ComboBuscador, { Resaltado, type ArmadoCombo, type OpcionCombo } from "@/components/ComboBuscador";
import {
  buscarVehiculos, capacidadVehiculo, chipEstadoVehiculo, coincideTarifa, descripcionVehiculo,
  nivelVehiculo, rotuloVehiculo, seccionesVehiculos, tieneFotos,
  type UsoVehiculo, type VehiculoBuscable,
} from "@/lib/vehiculos-buscador";
import { NIVEL_CFG } from "@/lib/costos/nivel-servicio";

type Props = {
  tipo: "propio" | "tercero";
  vehiculos: VehiculoBuscable[];
  valor: string;
  onElegir: (id: string) => void;
  uso?: Map<number, UsoVehiculo>;
  recientes?: number[];
  /** Clave de la ficha de costeo elegida como «Vehículo de tarifa» (form.tipo_vehiculo). */
  tarifaTipo?: string | null;
  /** Su nombre legible (parametros_costos.nombre). */
  tarifaNombre?: string | null;
  cargando?: boolean;
};

const LIMITE = 50;
/** `null` = la opción «Sin vehículo…» (limpiar). */
type Dato = VehiculoBuscable | null;

export default function SelectorVehiculo({ tipo, vehiculos, valor, onElegir, uso, recientes, tarifaTipo, tarifaNombre, cargando }: Props) {
  const propio = tipo === "propio";
  const sinTexto = propio ? "Sin vehículo propio" : "Sin vehículo tercerizado";
  const elegido = useMemo(() => (valor ? vehiculos.find(v => v.id === Number(valor)) ?? null : null), [vehiculos, valor]);

  const armar = useCallback((q: string): ArmadoCombo<Dato> => {
    const ops: OpcionCombo<Dato>[] = [];
    const pies: string[] = [];
    if (!q) {
      if (valor) ops.push({ tipo: "item", clave: "sin", dato: null, cuenta: false });
      const s = seccionesVehiculos(vehiculos, { tarifaTipo, tarifaNombre, recientes, uso, maxRecientes: 8, limite: LIMITE });
      s.secciones.forEach(sec => sec.vehiculos.forEach(v => ops.push({ tipo: "item", clave: String(v.id), dato: v, seccion: sec.titulo })));
      if (s.ocultos > 0) pies.push(`y ${s.ocultos} más: escribe para buscar`);
      else if (vehiculos.length > 8) pies.push("Escribe placa, marca, capacidad o empresa para buscar");
    } else {
      const r = buscarVehiculos(vehiculos, q, { uso, tarifaTipo, limite: LIMITE });
      r.resultados.forEach(v => ops.push({ tipo: "item", clave: String(v.id), dato: v }));
      if (r.total > LIMITE) pies.push(`y ${r.total - LIMITE} más: afina la búsqueda`);
    }
    return { opciones: ops, pies };
  }, [vehiculos, valor, uso, recientes, tarifaTipo, tarifaNombre]);

  const chip = "flex-shrink-0 text-[9px] font-bold uppercase rounded px-1.5 py-0.5";

  return (
    <ComboBuscador<Dato>
      valor={valor}
      rotuloElegido={elegido ? rotuloVehiculo(elegido) : null}
      armar={armar}
      onElegir={v => onElegir(v ? String(v.id) : "")}
      onLimpiar={() => onElegir("")}
      cargando={cargando}
      textoCargando="Cargando vehículos…"
      anuncioCargando="Cargando vehículos"
      ariaLabel={propio ? "Buscar vehículo propio" : "Buscar vehículo tercerizado"}
      ariaLista={propio ? "Vehículos propios" : "Vehículos tercerizados"}
      etiquetaLimpiar={propio ? "Quitar vehículo propio" : "Quitar vehículo tercerizado"}
      placeholder={`${sinTexto} · busca placa, marca, ${propio ? "capacidad" : "empresa"}…`}
      rotuloSinDato={v => `Unidad #${v} (no está en la lista)`}
      reservaDerecha="pr-10"
      vacio={q => q
        ? `Ninguna unidad coincide con «${q}» entre ${vehiculos.length}.`
        : propio ? "No hay vehículos propios registrados." : "No hay vehículos tercerizados activos."}
      renderItem={(v, texto) => {
        if (!v) return <span className="text-sm text-gray-500 italic">{sinTexto}</span>;
        const cap = capacidadVehiculo(v), nivel = nivelVehiculo(v), desc = descripcionVehiculo(v), est = chipEstadoVehiculo(v);
        const u = uso?.get(v.id);
        return <>
          <div className="flex items-center gap-1.5 min-w-0 flex-wrap">
            <span className="text-sm font-bold text-gray-800 font-mono"><Resaltado texto={v.placa} q={texto} /></span>
            {propio && nivel && <span className={chip} style={{ background: NIVEL_CFG[nivel].bg, color: NIVEL_CFG[nivel].color }}>{NIVEL_CFG[nivel].label}</span>}
            {tieneFotos(v) && <span className={`${chip} bg-green-50 text-green-700`} title="Tiene fotos para el PDF">📸</span>}
            {coincideTarifa(v, tarifaTipo) && <span className={chip} style={{ background: "#eef3f8", color: "#0b315f" }} title={`Su ficha de costeo es la del vehículo de tarifa (${tarifaNombre || tarifaTipo})`}>✓ tarifa</span>}
            {est && <span className={`${chip} bg-gray-100 text-gray-500`}>{est}</span>}
          </div>
          <div className="flex flex-wrap gap-x-2 text-[11px] text-gray-500">
            {desc && <span><Resaltado texto={desc} q={texto} /></span>}
            {cap && <span><Resaltado texto={`${cap} pax`} q={texto} /></span>}
            {!propio && v.empresa_nombre && <span className="font-semibold text-gray-600"><Resaltado texto={v.empresa_nombre} q={texto} /></span>}
            {u && u.cotizaciones > 0 && <span>{u.cotizaciones} cotiz.</span>}
          </div>
        </>;
      }}
    />
  );
}
