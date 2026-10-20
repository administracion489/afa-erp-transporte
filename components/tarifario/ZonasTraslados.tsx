"use client";
// components/tarifario/ZonasTraslados.tsx — La vista «🗺 Zonas y traslados» de /tarifario: los
// precios por ZONA que usa el cotizador automático de traslados del CRM (lib/traslados/motor.ts).
//
// Cinco pestañas: Precios · Zonas · Vehículos · Simulador · Ajustes. La elegida va en la URL
// (`?vista=zonas&tab=…`) para poder enlazarla; nada de datos en localStorage. Cada pestaña se
// monta la primera vez que se abre y se queda montada (volver a ella no pierde lo que se escribió).
//
// Sin la migración (supabase/traslados-01…05) la vista lo dice en ámbar nombrando los SQL y no
// enseña nada más: una pantalla vacía se leería como «no hay precios». Sin traslados-07 (fotos y
// descripción de cada vehículo, listas Incluye / No incluye) todo funciona como antes y las
// pestañas Vehículos y Ajustes lo dicen en ámbar.

import { useCallback, useEffect, useState } from "react";
import { SQL_TRASLADOS, type CategoriaFila, type TarifaFila, type ZonaFila } from "./traslados-pantalla";
import { cargarTraslados, type CargaTraslados, type ConfigFila } from "./traslados-datos";
import { AvisoFlotante, useAviso } from "./traslados-comun";
import PreciosTraslado from "./PreciosTraslado";
import ZonasCatalogo from "./ZonasCatalogo";
import VehiculosTraslado from "./VehiculosTraslado";
import SimuladorTraslado from "./SimuladorTraslado";
import AjustesTraslado from "./AjustesTraslado";

export type TabTraslados = "precios" | "zonas" | "vehiculos" | "simulador" | "ajustes";

const TABS: { id: TabTraslados; icono: string; label: string }[] = [
  { id: "precios", icono: "💲", label: "Precios" },
  { id: "zonas", icono: "🗺", label: "Zonas" },
  { id: "vehiculos", icono: "🚐", label: "Vehículos" },
  { id: "simulador", icono: "🧪", label: "Simulador" },
  { id: "ajustes", icono: "⚙", label: "Ajustes" },
];

const esTab = (x: unknown): x is TabTraslados => TABS.some((t) => t.id === x);

/** La pestaña pedida en la URL. Solo en el navegador (esta vista no se pinta en el servidor: el layout espera la sesión). */
function tabInicial(): TabTraslados {
  if (typeof window === "undefined") return "precios";
  try {
    const t = new URLSearchParams(window.location.search).get("tab");
    return esTab(t) ? t : "precios";
  } catch { return "precios"; }
}

function escribirTab(t: TabTraslados) {
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("vista", "zonas");
    if (t === "precios") u.searchParams.delete("tab"); else u.searchParams.set("tab", t);
    window.history.replaceState(window.history.state, "", `${u.pathname}${u.search}${u.hash}`);
  } catch { /* la URL es una comodidad */ }
}

type Datos = Extract<CargaTraslados, { tipo: "ok" }>;

export default function ZonasTraslados() {
  const [tab, setTab] = useState<TabTraslados>(tabInicial);
  const [montadas, setMontadas] = useState<Set<TabTraslados>>(() => new Set([tabInicial()]));
  const [carga, setCarga] = useState<CargaTraslados | null>(null);
  const [n, setN] = useState(0);
  const { aviso, decir, cerrar } = useAviso();

  useEffect(() => {
    let vivo = true;
    void cargarTraslados().then((r) => { if (vivo) setCarga(r); });
    return () => { vivo = false; };
  }, [n]);

  const recargar = () => { setCarga(null); setN((x) => x + 1); };

  const irA = useCallback((t: TabTraslados) => {
    setTab(t);
    setMontadas((s) => (s.has(t) ? s : new Set([...s, t])));
    escribirTab(t);
  }, []);

  // ── Actualizaciones locales tras una escritura que la base confirmó ─────────
  const conDatos = (f: (d: Datos) => Datos) => setCarga((c) => (c && c.tipo === "ok" ? f(c) : c));
  const onZona = (z: ZonaFila) => conDatos((d) => ({ ...d, zonas: d.zonas.some((x) => x.id === z.id) ? d.zonas.map((x) => (x.id === z.id ? z : x)) : [...d.zonas, z] }));
  const onZonaBorrada = (id: number) => conDatos((d) => {
    // La base borra en cascada las subzonas y los precios: se refleja igual aquí.
    const fuera = new Set([id, ...d.zonas.filter((z) => z.padre_id === id).map((z) => z.id)]);
    return { ...d, zonas: d.zonas.filter((z) => !fuera.has(z.id)), tarifas: d.tarifas.filter((t) => !fuera.has(t.zona_a_id) && !fuera.has(t.zona_b_id)) };
  });
  const onTarifas = (filas: TarifaFila[]) => conDatos((d) => {
    const porId = new Map(d.tarifas.map((t) => [t.id, t]));
    for (const f of filas) porId.set(f.id, f);
    return { ...d, tarifas: [...porId.values()] };
  });
  const onTarifasBorradas = (ids: number[]) => conDatos((d) => {
    const fuera = new Set(ids);
    return { ...d, tarifas: d.tarifas.filter((t) => !fuera.has(t.id)) };
  });
  const onCategoria = (c: CategoriaFila) => conDatos((d) => ({
    ...d, categorias: d.categorias.some((x) => x.clave === c.clave) ? d.categorias.map((x) => (x.clave === c.clave ? c : x)) : [...d.categorias, c],
  }));
  const onConfig = (c: ConfigFila) => conDatos((d) => ({ ...d, config: c, configExiste: true }));

  if (carga == null) {
    return <div className="bg-white border rounded-2xl p-10 text-center text-sm text-gray-400">Cargando zonas, vehículos y precios de traslado…</div>;
  }
  if (carga.tipo === "sin_tablas") {
    return (
      <div className="rounded-2xl border border-amber-300 bg-amber-50 p-5 text-sm text-amber-900 space-y-3">
        <p className="font-bold">Falta correr la migración de traslados{carga.tabla ? ` (no existe la tabla ${carga.tabla})` : ""}.</p>
        <p>En Supabase → SQL Editor, corre estos archivos en este orden, cada uno entero con Run:</p>
        <ol className="list-decimal pl-5 space-y-1">
          {SQL_TRASLADOS.map((s) => <li key={s.archivo}><span className="font-mono">{s.archivo}</span> — {s.que}.</li>)}
        </ol>
        <p className="text-xs">Mientras tanto, la IA del CRM no cotiza traslados: todo pedido pasa a un ejecutivo.</p>
        <button type="button" onClick={recargar} className="px-4 py-2 rounded-xl text-xs font-bold border border-amber-400 hover:bg-amber-100 min-h-[40px]">↻ Volver a comprobar</button>
      </div>
    );
  }
  if (carga.tipo === "error") {
    return (
      <div className="rounded-2xl border border-red-200 bg-red-50 p-5 text-sm text-red-800 space-y-3">
        <p>{carga.detalle}</p>
        <button type="button" onClick={recargar} className="px-4 py-2 rounded-xl text-xs font-bold border border-red-300 hover:bg-red-100 min-h-[40px]">↻ Reintentar</button>
      </div>
    );
  }

  const d = carga;
  const oculto = (t: TabTraslados) => (tab === t ? "" : "hidden");
  // Ajustes se vuelve a montar SOLO cuando cambia lo que edita su formulario: los interruptores de
  // la IA se guardan al instante y no pueden borrar lo que alguien dejó escrito sin guardar.
  const claveAjustes = JSON.stringify([d.config.validez_dias, d.config.espera_gratis_min, d.config.consideraciones, d.config.consideraciones_usd, d.config.incluye, d.config.no_incluye]);
  return (
    <div className="space-y-4">
      <div className="flex gap-1 overflow-x-auto border-b -mx-1 px-1" role="tablist">
        {TABS.map((t) => (
          <button key={t.id} type="button" role="tab" aria-selected={tab === t.id} onClick={() => irA(t.id)}
            className={`flex items-center gap-1.5 px-4 py-2.5 text-sm font-bold border-b-2 -mb-px whitespace-nowrap min-h-[44px] transition-all ${tab === t.id ? "border-[#0b315f] text-[#0b315f] bg-[#eef3f8]/60" : "border-transparent text-gray-400 hover:text-gray-600"}`}>
            <span aria-hidden>{t.icono}</span>{t.label}
          </button>
        ))}
        <button type="button" onClick={recargar} title="Volver a leer zonas, vehículos y precios de la base"
          className="ml-auto px-3 text-xs font-bold text-gray-400 hover:text-gray-600 whitespace-nowrap">↻ Recargar</button>
      </div>

      {montadas.has("precios") && (
        <div className={oculto("precios")}>
          <PreciosTraslado zonas={d.zonas} categorias={d.categorias} tarifas={d.tarifas} decir={decir}
            onTarifas={onTarifas} onTarifasBorradas={onTarifasBorradas} onIrA={irA} />
        </div>
      )}
      {montadas.has("zonas") && (
        <div className={oculto("zonas")}>
          <ZonasCatalogo zonas={d.zonas} tarifas={d.tarifas} decir={decir} onZona={onZona} onZonaBorrada={onZonaBorrada}
            colsZona={d.colsZona} sinMigracionIA={d.sinMigracionIA} envioMaestro={d.config.envio_automatico} onIrAjustes={() => irA("ajustes")} />
        </div>
      )}
      {montadas.has("vehiculos") && (
        <div className={oculto("vehiculos")}>
          <VehiculosTraslado categorias={d.categorias} onCategoria={onCategoria} decir={decir}
            colsCategoria={d.colsCategoria} sinMigracionFotos={d.sinMigracionFotos} />
        </div>
      )}
      {montadas.has("simulador") && (
        <div className={oculto("simulador")}>
          <SimuladorTraslado onIrA={irA} iaCotiza={d.config.ia_cotiza} sinMigracionIA={d.sinMigracionIA} />
        </div>
      )}
      {montadas.has("ajustes") && (
        <div className={oculto("ajustes")}>
          <AjustesTraslado key={claveAjustes} config={d.config} configExiste={d.configExiste} onConfig={onConfig} decir={decir}
            zonas={d.zonas} sinMigracionIA={d.sinMigracionIA} sinMigracionListas={d.sinMigracionListas} colsConfig={d.colsConfig} onIrAZonas={() => irA("zonas")} />
        </div>
      )}

      <AvisoFlotante aviso={aviso} onCerrar={cerrar} />
    </div>
  );
}
