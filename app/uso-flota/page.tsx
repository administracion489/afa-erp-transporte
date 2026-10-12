"use client";

// app/uso-flota/page.tsx — USO DE FLOTA. Dos pestañas:
//   · Resumen   (GET /api/flota/uso): km, servicios, horas, unidades sin uso, gasto y CO₂ de lo
//                comprado de un periodo, contra el periodo anterior del mismo largo.
//   · Servicios (GET /api/flota/servicios): la estadística de cada servicio (km por GPS, marcha,
//                excesos, combustible, costo y CO₂ estimados) y su corte por cliente.
//
// Parámetros (se leen de window.location, como /combustible, para no exigir un Suspense):
//   ?tab=resumen|servicios  &desde&hasta (Resumen)  &fecha&reserva (Servicios)
// Las pestañas reescriben la URL con history.replaceState: un enlace copiado abre lo mismo.
//
// EL PERMISO. Tres capas, como /seguridad-vial: el layout (la ruta va en `menuGrupos` con el
// módulo `vehiculos`), la guarda de esta pantalla con `usePermiso("vehiculos")` —que ya deja pasar
// al rol admin, sin filas en permisos_usuario: antes no lo hacía y por eso aquí no se usaba— y las
// dos APIs, que re-verifican el módulo en cada llamada y, si falta, la pantalla NOMBRA el permiso en
// vez de enseñar un «403». La guarda va en un componente aparte para no condicionar los hooks.
//
// La pantalla no calcula nada que el motor ya decida: ver components/flota/uso/*.

import React, { useCallback, useState, useSyncExternalStore } from "react";
import { fechaLima } from "@/lib/alertas-horario";
import UsoFlotaResumen, { EnlacesResumen, periodoInicial, type Periodo } from "@/components/flota/uso/UsoFlotaResumen";
import UsoFlotaServicios from "@/components/flota/uso/UsoFlotaServicios";
import { usePermiso } from "@/lib/usePermiso";

type Tab = "resumen" | "servicios";

type Inicial = {
  hoy: string;
  tab: Tab;
  periodo: Periodo;
  fecha: string;
  reserva: number | null;
};

const fechaOk = (f: string | null): f is string => !!f && /^\d{4}-\d{2}-\d{2}$/.test(f);

/** Lo que piden los parámetros de la URL. En el servidor (sin window) son los valores por defecto. */
function leerInicial(): Inicial {
  const hoy = fechaLima(Date.now());
  let sp = new URLSearchParams();
  try { if (typeof window !== "undefined") sp = new URLSearchParams(window.location.search); } catch { /* sin URL legible */ }
  const tab: Tab = sp.get("tab") === "servicios" ? "servicios" : "resumen";
  const f = sp.get("fecha");
  const reservaNum = Number(sp.get("reserva"));
  return {
    hoy,
    tab,
    periodo: periodoInicial(hoy, sp.get("desde"), sp.get("hasta")),
    fecha: fechaOk(f) && f <= hoy ? f : hoy,
    reserva: Number.isSafeInteger(reservaNum) && reservaNum > 0 ? reservaNum : null,
  };
}

const suscribirNada = () => () => {};

/** Reescribe la URL sin navegar (y sin tocar los parámetros que no son de esta pantalla). */
function escribirUrl(cambios: Record<string, string | null>) {
  try {
    const u = new URL(window.location.href);
    for (const [k, v] of Object.entries(cambios)) {
      if (v == null || v === "") u.searchParams.delete(k);
      else u.searchParams.set(k, v);
    }
    const nueva = `${u.pathname}${u.search}${u.hash}`;
    if (nueva !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
      window.history.replaceState(window.history.state, "", nueva);
    }
  } catch { /* la URL es una comodidad: si no se puede escribir, la pantalla sigue igual */ }
}

export default function UsoFlotaPage() {
  const { validando, permitido } = usePermiso("vehiculos");
  if (validando) return <p className="p-2 text-sm text-gray-500">Verificando permisos…</p>;
  if (!permitido) return null;
  return <UsoFlota />;
}

function UsoFlota() {
  // Solo en el navegador: en el servidor (y durante la hidratación) se pinta el esqueleto, así el
  // HTML coincide y la lectura de window.location no depende de un efecto.
  const enNavegador = useSyncExternalStore(suscribirNada, () => true, () => false);
  const [inicial] = useState<Inicial>(leerInicial);
  const [tab, setTab] = useState<Tab>(inicial.tab);
  // Una pestaña se monta la primera vez que se abre (cada una mide caro) y se queda montada:
  // volver a ella no repite su medición.
  const [vistas, setVistas] = useState<Record<Tab, boolean>>({ resumen: inicial.tab === "resumen", servicios: inicial.tab === "servicios" });

  const cambiarTab = (t: Tab) => {
    setTab(t);
    setVistas((v) => (v[t] ? v : { ...v, [t]: true }));
    // Los parámetros de la otra pestaña se quitan; los suyos los escribe ella al montarse/volver.
    escribirUrl(t === "servicios" ? { tab: t, desde: null, hasta: null } : { tab: t, fecha: null });
  };
  const onPeriodo = useCallback((p: Periodo) => escribirUrl({ tab: "resumen", desde: p.desde, hasta: p.hasta }), []);
  const onFecha = useCallback((f: string) => escribirUrl({ tab: "servicios", fecha: f }), []);

  return (
    <main className="space-y-5 max-w-7xl mx-auto">
      <div className="flex items-start justify-between flex-wrap gap-3">
        <div className="min-w-0">
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Uso de flota</h1>
          <p className="text-gray-400 text-sm mt-1 max-w-2xl">
            Cuánto trabajó la flota propia y qué gastó: km, servicios, horas, unidades sin uso, combustible y CO₂.
            Lo medido y lo estimado van siempre separados, y un dato que falta se dice: nunca es un cero.
          </p>
        </div>
        <EnlacesResumen />
      </div>

      <div className="flex gap-1 border-b border-gray-200" role="tablist" aria-label="Vista">
        {([["resumen", "📊 Resumen"], ["servicios", "🚌 Servicios"]] as [Tab, string][]).map(([t, l]) => {
          // Sin marcar ninguna hasta estar en el navegador: la pestaña sale de la URL, que el
          // servidor no ve, y el HTML de la hidratación tiene que ser el mismo.
          const activa = enNavegador && tab === t;
          return (
            <button key={t} type="button" role="tab" aria-selected={activa} onClick={() => cambiarTab(t)}
              className={`px-4 py-2.5 text-sm font-bold -mb-px border-b-2 min-h-[44px] transition-colors ${activa ? "border-[#0b315f] text-[#0b315f]" : "border-transparent text-gray-500 hover:text-gray-700"}`}>
              {l}
            </button>
          );
        })}
      </div>

      {!enNavegador ? (
        <div className="bg-white rounded-2xl border shadow-sm p-8 text-center text-sm text-gray-500">Midiendo…</div>
      ) : (
        <>
          {vistas.resumen && (
            <div hidden={tab !== "resumen"}>
              <UsoFlotaResumen hoy={inicial.hoy} periodoDeInicio={inicial.periodo} onPeriodo={tab === "resumen" ? onPeriodo : noEscribir} />
            </div>
          )}
          {vistas.servicios && (
            <div hidden={tab !== "servicios"}>
              <UsoFlotaServicios hoy={inicial.hoy} fechaInicial={inicial.fecha} reservaResaltada={inicial.reserva}
                onFecha={tab === "servicios" ? onFecha : noEscribir} />
            </div>
          )}
        </>
      )}
    </main>
  );
}

/** Lo que recibe la pestaña oculta: no escribe la URL de la que se está mirando. */
const noEscribir = () => {};
