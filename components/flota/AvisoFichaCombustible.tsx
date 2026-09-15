"use client";
// El aviso que cruza la CATEGORÍA DE COSTEO de una placa con los tanques que esa placa declara.
//
// Va debajo del desplegable en `/vehiculos` y en `/tercerizadas`, que son los dos únicos sitios
// donde se elige esa categoría. Antes el desplegable decía `nombre (clave)` y nada más: así se
// le asignó a una unidad de GLP una ficha que costea en otro combustible, y eso no se notó en
// ninguna pantalla hasta que el diagnóstico del rendimiento lo nombró meses después.
//
// QUÉ SE PINTA Y QUÉ NO, que es lo único delicado:
//   · `discrepa` y `familia_desconocida` → ámbar. Son las dos que cuestan dinero.
//   · `sin_tanques` → una línea gris, y SOLO con una ficha ya elegida: es una invitación a
//     llenar el tanque de arriba, no un error.
//   · `coincide` y `sin_ficha` → NADA. Un aviso que sale siempre se vuelve paisaje, y el propio
//     desplegable ya dice «— sin asignar —» cuando no hay ficha.
import React from "react";
import { cotejarFichaConTanques } from "@/lib/costos/rendimiento-tipo";

export default function AvisoFichaCombustible({
  tipoCombustibleFicha, capTanque,
}: {
  /** `parametros_costos.tipo_combustible_1` de la ficha elegida. */
  tipoCombustibleFicha: string | null | undefined;
  /** El estado del bloque «Capacidad de tanque» del MISMO formulario. */
  capTanque: Record<string, string>;
}) {
  const familias = Object.entries(capTanque || {})
    .filter(([, v]) => v !== "" && Number(v) > 0)
    .map(([k]) => k);
  const c = cotejarFichaConTanques(tipoCombustibleFicha, familias);

  if (c.codigo === "coincide" || c.codigo === "sin_ficha") return null;

  if (c.codigo === "sin_tanques") {
    return (
      <p className="text-[10px] text-gray-400 mt-1 leading-snug">
        Esta ficha costea en <b>{tipoCombustibleFicha}</b>. Llena abajo la capacidad de tanque de
        esta unidad y el ERP te avisa si no calzan.
      </p>
    );
  }

  return (
    <div className="mt-1.5 rounded-lg border border-amber-300 bg-amber-50 px-2.5 py-2">
      <p className="text-[10px] font-black text-amber-800 uppercase tracking-wide">
        ⚠️ {c.codigo === "discrepa" ? "El combustible no calza" : "Combustible no reconocido"}
      </p>
      <p className="text-[11px] text-amber-800 mt-0.5 leading-snug">{c.detalle}</p>
    </div>
  );
}
