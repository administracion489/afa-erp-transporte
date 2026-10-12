"use client";

// components/seguimiento/EnlacesAnalitica.tsx — Desde la ficha de un servicio (/seguimiento) a su
// estadística (/uso-flota → Servicios, módulo `vehiculos`) y a sus excesos de velocidad
// (/seguridad-vial, módulo `monitoreo`).
//
// CADA ENLACE SOLO SI EL USUARIO TIENE EL MÓDULO DEL DESTINO, y se pregunta con `usePuedeVer`, no con
// `usePermiso`: ese hook es la guarda de una pantalla y REDIRIGE al dashboard a quien no tiene el
// módulo, o sea que expulsaría de /seguimiento a quien solo tiene Seguimiento. Sin ninguno de los dos
// módulos no se pinta nada; mientras se consulta, tampoco (no es un «no puedes», es un «todavía no sé»).
// La consulta se comparte entre todas las fichas que se abran (caché del hook).
//
// SE ABREN EN OTRA PESTAÑA: la torre de /seguimiento es una pantalla en vivo y el operador vuelve a
// ella; y las dos pantallas de destino leen sus parámetros de la URL al cargar.
//
// LO QUE NO SE PUEDE MEDIR SE VE EN GRIS CON SU PORQUÉ, en vez de desaparecer: un servicio cancelado
// (la torre no lo mide), uno que todavía no ocurre, o uno más viejo que los DIAS_ATRAS_MAX_EXCESOS días
// que aceptan las dos APIs.
//
// LOS EXCESOS SE PIDEN DEL DÍA DEL SERVICIO AL SIGUIENTE (si ya llegó): /seguridad-vial lee los
// puntos por día de calendario y un exceso cuenta en el día en que EMPIEZA, así que el tramo después
// de medianoche de un servicio nocturno quedaría fuera con `hasta = fecha`, y la pantalla diría
// «ningún exceso» de un servicio que sí lo tuvo. El servicio del enlace se resalta igual (`reserva`).

import React, { useState } from "react";
import { usePuedeVer } from "@/lib/usePuedeVer";
import { fechaLima } from "@/lib/alertas-horario";
import { DIAS_ATRAS_MAX_EXCESOS, sumarDias } from "@/lib/flota/excesos";

const MODULOS_DESTINO = ["vehiculos", "monitoreo"] as const;
const FOCO = "outline-none focus-visible:ring-2 focus-visible:ring-[#1262bd] focus-visible:ring-offset-1";
const BASE = `inline-flex items-center gap-1.5 text-[11.5px] font-bold px-3 py-2 rounded-xl border min-h-[36px] ${FOCO}`;

export default function EnlacesAnalitica({ reservaId, fecha, cancelado }: {
  reservaId: number | null | undefined;
  /** reservas.fecha_servicio (AAAA-MM-DD) */
  fecha: string | null | undefined;
  cancelado: boolean;
}) {
  const puede = usePuedeVer(MODULOS_DESTINO);
  const [hoy] = useState(() => fechaLima(Date.now()));

  if (!puede || (!puede.vehiculos && !puede.monitoreo)) return null;
  const f = typeof fecha === "string" ? fecha.slice(0, 10) : "";
  if (reservaId == null || !/^\d{4}-\d{2}-\d{2}$/.test(f)) return null;

  const motivo = cancelado
    ? "el servicio está cancelado: no hubo recorrido que medir."
    : f > hoy
      ? "el servicio todavía no ocurre: no hay recorrido que medir."
      : f < sumarDias(hoy, -DIAS_ATRAS_MAX_EXCESOS)
        ? `el GPS se analiza hasta ${DIAS_ATRAS_MAX_EXCESOS} días atrás y este servicio es más antiguo.`
        : null;

  const siguiente = sumarDias(f, 1);
  const hastaExcesos = siguiente <= hoy ? siguiente : f;
  const enlaces = [
    puede.vehiculos && {
      k: "estadistica",
      texto: "📊 Estadística del servicio",
      href: `/uso-flota?tab=servicios&fecha=${f}&reserva=${reservaId}`,
      titulo: "Km por GPS, marcha, excesos, combustible, costo y CO₂ estimados del servicio (Uso de flota → Servicios)",
    },
    puede.monitoreo && {
      k: "excesos",
      texto: "🚦 Excesos",
      href: `/seguridad-vial?desde=${f}&hasta=${hastaExcesos}&reserva=${reservaId}`,
      titulo: "Excesos de velocidad sostenidos y corroborados del servicio (Seguridad vial)",
    },
  ].filter((e): e is { k: string; texto: string; href: string; titulo: string } => !!e);

  return (
    <div className="mt-3 pt-2.5 border-t border-gray-100">
      <div className="flex flex-wrap items-center gap-2">
        <span className="text-[10.5px] font-bold uppercase tracking-wide text-gray-400">Analítica</span>
        {enlaces.map((e) => motivo ? (
          <span key={e.k} aria-disabled="true" title={`No disponible: ${motivo}`}
            className={`${BASE} border-gray-100 bg-gray-50 text-gray-400 cursor-not-allowed`}>
            {e.texto}
          </span>
        ) : (
          <a key={e.k} href={e.href} target="_blank" rel="noopener noreferrer" title={`${e.titulo}. Se abre en otra pestaña.`}
            className={`${BASE} border-gray-200 bg-white text-[#0b315f] hover:bg-[#eef3f8] transition-colors`}>
            {e.texto} <span aria-hidden="true" className="text-gray-400">↗</span>
          </a>
        ))}
      </div>
      {motivo && <p className="mt-1 text-[10.5px] text-gray-400">Analítica: {motivo}</p>}
    </div>
  );
}
