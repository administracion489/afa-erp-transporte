"use client";

// ══════════════════════════════════════════════════════════════════════════════
// app/comisiones/page.tsx — Comisiones del ejecutivo de ventas.
//
// Módulo `comisiones`. DOS vistas según el rol (lib/api-auth re-verifica todo en el
// servidor; acá solo se elige qué pintar):
//   · VENDEDOR (rol que no aprueba): solo SUS líneas, con la traza de cada una, el avance
//     de los 7 indicadores del bono de atención y sus clientes. Solo lectura.
//   · ADMINISTRADOR (admin/gerente): todos los vendedores, calcular/recalcular, clasificar
//     reclamos y cancelaciones, corroborar el fondo, marcar cobrado, cerrar el mes,
//     exportar la planilla y poblar el puente usuario↔administrativo.
//
// LOS DATOS DE COMISIÓN VIENEN SOLO DE /api/comisiones/* con cabecerasErp(): nunca se lee
// Supabase para el cálculo (igual que los flujos de tesorería). Lo único que se lee directo
// es DATO MAESTRO (nombres de usuarios/clientes, directorio de personal administrativo) para
// resolver un uuid a un nombre y poblar un selector.
//
// EL MOTIVO SE DECLARA, NO SE OLFATEA: cada línea trae `traza_json.codigo` de un conjunto
// cerrado y la pantalla enruta por ese código (nunca leyendo el texto). Lo retenido y lo no
// cobrado se ve en ÁMBAR con su motivo, no se esconde. Lo informativo/bloqueado se agrupa
// aparte, no se mezcla con lo pagable.
//
// BONO DE ATENCIÓN — TRANSPARENCIA: hoy solo `cero_quejas` y `sin_cancelaciones` tienen
// fuente de datos real; los otros cinco salen "cumplido por defecto". La pantalla LO DICE
// en ámbar por indicador. No se pinta como medido lo que no se midió.
// ══════════════════════════════════════════════════════════════════════════════

import { useCallback, useEffect, useMemo, useState } from "react";
import { usePermiso } from "@/lib/usePermiso";
import { cabecerasErp } from "@/lib/fetch-erp";
import { supabase } from "@/lib/supabase";
import { hoyLima } from "@/lib/alertas";

// ── Tipos del contrato de /api/comisiones/lineas ──────────────────────────────

type Traza = {
  codigo: string;
  regla: string;
  base: number | null;
  tasa: number | null;
  monto: number | null;
  detalle: string;
};

type Linea = {
  id: number;
  vendedor_id: string | null;
  tipo: string; // eventual | fijo | bono_arranque | bono_atencion | fondo_admin
  reserva_id: number | null;
  cliente_id: number | null;
  cotizacion_id: number | null;
  personal_administrativo_id: number | null;
  base_utilidad: number | null;
  pct_aplicado: number | null;
  monto: number | null;
  fecha_cobro_origen: string | null;
  orden_eventual: number | null;
  parametros_id: number | null;
  traza_json: Traza | null;
  estado: string;
};

type Periodo = {
  id: number;
  anio_mes: string;
  estado: string; // preliminar | cerrado
  calculado_en: string | null;
  cerrado_en: string | null;
} | null;

type RespuestaLineas = {
  periodo: Periodo;
  lineas: Linea[];
  totales?: { comisiones: number; fondo: number };
  motivo?: string;
};

// ── Metadatos de cada código de traza (la pantalla enruta por esto) ───────────

type Grupo = "pagable" | "retenido" | "fondo" | "informativo" | "bloqueado";
type Tono = "verde" | "ambar" | "rojo" | "azul" | "gris";

const CODIGOS: Record<string, { etiqueta: string; grupo: Grupo; tono: Tono; ayuda: string }> = {
  pagar: { etiqueta: "Pagable", grupo: "pagable", tono: "verde", ayuda: "Hay monto a pagar." },
  retenido_falta_costear: {
    etiqueta: "Retenido · falta costear",
    grupo: "retenido",
    tono: "ambar",
    ayuda: "El servicio no tiene presupuesto, así que la utilidad no es confiable todavía. Se paga cuando se costee.",
  },
  pendiente_cobro: {
    etiqueta: "Pendiente de cobro",
    grupo: "informativo",
    tono: "azul",
    ayuda: "El mes de este contrato aún no se cobró: todavía no se paga.",
  },
  fondo_pendiente_corroboracion: {
    etiqueta: "Fondo · sin corroborar",
    grupo: "fondo",
    tono: "ambar",
    ayuda: "El fondo está calculado pero no hay operadores corroborados: pendiente de repartir.",
  },
  sin_parametros: {
    etiqueta: "Sin parámetro vigente",
    grupo: "bloqueado",
    tono: "rojo",
    ayuda: "No había un parámetro de comisiones vigente en esa fecha. Configúralo para que calcule.",
  },
  cliente_existente: {
    etiqueta: "Cliente ya existente",
    grupo: "informativo",
    tono: "gris",
    ayuda: "El cliente está en la lista firmada de clientes existentes: no es cliente nuevo, no comisiona.",
  },
  cliente_sin_ventana: {
    etiqueta: "Cliente no nuevo",
    grupo: "informativo",
    tono: "gris",
    ayuda: "Tuvo servicio en los 12 meses previos a la cotización: no cuenta como cliente nuevo.",
  },
  fuera_de_ventana: {
    etiqueta: "Fuera de la ventana",
    grupo: "informativo",
    tono: "gris",
    ayuda: "Pasaron los 12 meses desde el primer servicio cobrado del cliente: ya no comisiona.",
  },
  bono_arranque_cancelado: {
    etiqueta: "Bono de arranque cancelado",
    grupo: "informativo",
    tono: "gris",
    ayuda: "El contrato se canceló antes del mes 3: la 2ª mitad del bono de arranque no se paga.",
  },
  no_cobrado: {
    etiqueta: "No cobrado",
    grupo: "informativo",
    tono: "gris",
    ayuda: "Llegó un servicio no cobrado: no se paga ni cuenta (defensa del motor).",
  },
};

function metaCodigo(codigo: string | undefined) {
  return (
    (codigo && CODIGOS[codigo]) || {
      etiqueta: codigo ?? "—",
      grupo: "informativo" as Grupo,
      tono: "gris" as Tono,
      ayuda: "",
    }
  );
}

const NOMBRE_TIPO: Record<string, string> = {
  eventual: "Eventual",
  fijo: "Fijo (10% mensual)",
  bono_arranque: "Bono de arranque",
  bono_atencion: "Bono de atención",
  fondo_admin: "Fondo administrativo",
};

// ── Los 7 indicadores del bono de atención (declarados, con su fuente) ────────
// El motor (lib/comisiones/datos.ts → indicadoresDeVendedor) hoy solo puede ROMPER el bono
// con un reclamo o una cancelación clasificados. Los otros cinco salen "cumplido por
// defecto" porque aún no hay fuente de datos. La pantalla lo DICE; no finge medirlos.

const INDICADORES_BONO: { clave: string; nombre: string; valor: number; medido: boolean; fuente: string }[] = [
  { clave: "cero_quejas", nombre: "Cero quejas / reclamos graves", valor: 20, medido: true, fuente: "Reclamos clasificados del mes" },
  { clave: "sin_cancelaciones", nombre: "Sin cancelaciones evitables", valor: 20, medido: true, fuente: "Cancelaciones clasificadas del mes" },
  { clave: "rapidez", nombre: "Rapidez de respuesta", valor: 20, medido: false, fuente: "— aún sin fuente de datos" },
  { clave: "seguimiento", nombre: "Seguimiento a clientes", valor: 25, medido: false, fuente: "— aún sin fuente de datos" },
  { clave: "registros", nombre: "Registros al día", valor: 20, medido: false, fuente: "— aún sin fuente de datos" },
  { clave: "precios", nombre: "Precios correctos", valor: 15, medido: false, fuente: "— aún sin fuente de datos" },
  { clave: "documentacion", nombre: "Documentación completa", valor: 30, medido: false, fuente: "— aún sin fuente de datos" },
];

// ── Utilidades ────────────────────────────────────────────────────────────────

const sol = (n: number | null | undefined) =>
  "S/ " + (Number(n) || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

const mesActual = () => hoyLima().slice(0, 7);

const TONO_CLASES: Record<Tono, { chip: string; borde: string; fondo: string }> = {
  verde: { chip: "bg-green-100 text-green-800", borde: "border-green-200", fondo: "bg-green-50" },
  ambar: { chip: "bg-amber-100 text-amber-800", borde: "border-amber-200", fondo: "bg-amber-50" },
  rojo: { chip: "bg-red-100 text-red-800", borde: "border-red-200", fondo: "bg-red-50" },
  azul: { chip: "bg-blue-100 text-blue-800", borde: "border-blue-200", fondo: "bg-blue-50" },
  gris: { chip: "bg-gray-100 text-gray-700", borde: "border-gray-200", fondo: "bg-gray-50" },
};

/** Lectura de /api/comisiones con cabecerasErp. Distingue sin_migracion y periodo_cerrado. */
async function pedirErp(
  path: string,
  opciones: { method?: string; body?: unknown; multipart?: FormData } = {},
): Promise<{ ok: boolean; status: number; data: any; error: string | null; sinMigracion: boolean }> {
  const headers = await cabecerasErp();
  let body: BodyInit | undefined;
  if (opciones.multipart) {
    delete (headers as Record<string, string>)["Content-Type"]; // el boundary lo pone fetch
    body = opciones.multipart;
  } else if (opciones.body !== undefined) {
    body = JSON.stringify(opciones.body);
  }
  const res = await fetch(path, { method: opciones.method ?? "GET", headers, body, cache: "no-store" });
  const texto = await res.text();
  let data: any = null;
  try { data = texto ? JSON.parse(texto) : null; } catch { /* no era JSON (p.ej. CSV) */ }
  const error = typeof data?.error === "string" ? data.error : res.ok ? null : `Error ${res.status}`;
  const sinMigracion = res.status === 422 && !!error && error.startsWith("sin_migracion");
  return { ok: res.ok, status: res.status, data, error, sinMigracion };
}

// ══════════════════════════════════════════════════════════════════════════════
// Página
// ══════════════════════════════════════════════════════════════════════════════

export default function ComisionesPage() {
  const { validando, permitido } = usePermiso("comisiones");
  const [rol, setRol] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.auth.getSession();
      const uid = data.session?.user?.id;
      if (!uid) return;
      const { data: perfil } = await supabase.from("usuarios").select("rol").eq("id", uid).maybeSingle();
      setRol(perfil?.rol ?? "operador");
    })();
  }, []);

  if (validando || !permitido) {
    return <p className="p-4 text-sm text-gray-500">Validando el permiso del módulo Comisiones…</p>;
  }
  if (rol == null) {
    return <p className="p-4 text-sm text-gray-500">Cargando tu rol…</p>;
  }

  const esAprobador = rol === "admin" || rol === "gerente";
  return esAprobador ? <VistaAdministrador esAdmin={rol === "admin"} /> : <VistaVendedor />;
}

// ── Carga común de líneas de un mes ───────────────────────────────────────────

function useLineas(anioMes: string) {
  const [datos, setDatos] = useState<RespuestaLineas | null>(null);
  const [cargando, setCargando] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [sinMigracion, setSinMigracion] = useState(false);

  const cargar = useCallback(async () => {
    setCargando(true);
    setError(null);
    const r = await pedirErp(`/api/comisiones/lineas?anioMes=${anioMes}`);
    setCargando(false);
    if (r.sinMigracion) { setSinMigracion(true); setDatos(null); return; }
    setSinMigracion(false);
    if (!r.ok) { setError(r.error); setDatos(null); return; }
    setDatos(r.data as RespuestaLineas);
  }, [anioMes]);

  useEffect(() => { cargar(); }, [cargar]);
  return { datos, cargando, error, sinMigracion, recargar: cargar };
}

// ── Resolución de nombres (dato maestro, no dato de comisión) ──────────────────

function useNombres(lineas: Linea[] | undefined) {
  const [vendedores, setVendedores] = useState<Record<string, string>>({});
  const [clientes, setClientes] = useState<Record<number, string>>({});
  const [personal, setPersonal] = useState<Record<number, string>>({});

  useEffect(() => {
    if (!lineas) return;
    const uids = [...new Set(lineas.map((l) => l.vendedor_id).filter(Boolean) as string[])];
    const cids = [...new Set(lineas.map((l) => l.cliente_id).filter((x): x is number => x != null))];
    const paids = [...new Set(lineas.map((l) => l.personal_administrativo_id).filter((x): x is number => x != null))];
    (async () => {
      if (uids.length) {
        const { data } = await supabase.from("usuarios").select("id,nombre").in("id", uids);
        const filas = (data ?? []) as { id: string; nombre: string | null }[];
        setVendedores(Object.fromEntries(filas.map((u) => [String(u.id), u.nombre ?? String(u.id)])));
      }
      if (cids.length) {
        const { data } = await supabase.from("clientes").select("id,nombre").in("id", cids);
        const filas = (data ?? []) as { id: number; nombre: string | null }[];
        setClientes(Object.fromEntries(filas.map((c) => [Number(c.id), c.nombre ?? String(c.id)])));
      }
      if (paids.length) {
        const { data } = await supabase.from("personal_administrativo").select("id,nombre").in("id", paids);
        const filas = (data ?? []) as { id: number; nombre: string | null }[];
        setPersonal(Object.fromEntries(filas.map((p) => [Number(p.id), p.nombre ?? String(p.id)])));
      }
    })();
  }, [lineas]);

  return { vendedores, clientes, personal };
}

// ── Piezas visuales compartidas ───────────────────────────────────────────────

function Chip({ tono, children }: { tono: Tono; children: React.ReactNode }) {
  return <span className={`inline-block px-2 py-0.5 rounded-full text-xs font-semibold ${TONO_CLASES[tono].chip}`}>{children}</span>;
}

function SelectorMes({ valor, onChange }: { valor: string; onChange: (v: string) => void }) {
  return (
    <input
      type="month"
      value={valor}
      max={mesActual()}
      onChange={(e) => onChange(e.target.value)}
      className="border border-gray-300 rounded-lg px-3 py-2 text-sm"
    />
  );
}

function BannerSinMigracion() {
  return (
    <div className="rounded-xl border border-amber-300 bg-amber-50 p-4 text-sm text-amber-900">
      <p className="font-bold">Faltan correr las migraciones del módulo</p>
      <p className="mt-1">
        El módulo de comisiones necesita las migraciones{" "}
        <code className="bg-amber-100 px-1 rounded">supabase/comisiones-01..04.sql</code>. Hasta que un administrador las
        corra en Supabase, no se pueden calcular ni mostrar las comisiones. El resto del ERP funciona con normalidad.
      </p>
    </div>
  );
}

function Tarjeta({ titulo, valor, tono = "gris", nota }: { titulo: string; valor: string; tono?: Tono; nota?: string }) {
  const c = TONO_CLASES[tono];
  return (
    <div className={`rounded-xl border ${c.borde} ${c.fondo} p-4`}>
      <p className="text-xs uppercase tracking-wide text-gray-500">{titulo}</p>
      <p className="text-2xl font-bold text-gray-900 mt-1">{valor}</p>
      {nota && <p className="text-xs text-gray-500 mt-1">{nota}</p>}
    </div>
  );
}

/** Una fila de comisión con su traza. */
function FilaLinea({
  l,
  nombreCliente,
  nombreVendedor,
  nombrePersonal,
}: {
  l: Linea;
  nombreCliente?: string;
  nombreVendedor?: string;
  nombrePersonal?: string;
}) {
  const meta = metaCodigo(l.traza_json?.codigo);
  const c = TONO_CLASES[meta.tono];
  return (
    <div className={`rounded-lg border ${c.borde} ${c.fondo} p-3`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2 min-w-0">
          <span className="text-sm font-semibold text-gray-900">{NOMBRE_TIPO[l.tipo] ?? l.tipo}</span>
          <Chip tono={meta.tono}>{meta.etiqueta}</Chip>
          {l.reserva_id != null && <span className="text-xs text-gray-500">Reserva #{l.reserva_id}</span>}
          {nombreCliente && <span className="text-xs text-gray-500">· {nombreCliente}</span>}
          {nombrePersonal && <span className="text-xs text-gray-500">· Operador: {nombrePersonal}</span>}
        </div>
        <div className="text-right shrink-0">
          {l.monto != null && l.monto > 0 ? (
            <span className="text-base font-bold text-gray-900">{sol(l.monto)}</span>
          ) : meta.grupo === "retenido" ? (
            <span className="text-sm font-semibold text-amber-700">
              {sol((Number(l.base_utilidad) || 0) * (Number(l.pct_aplicado) || 0))} retenido
            </span>
          ) : (
            <span className="text-sm text-gray-400">—</span>
          )}
        </div>
      </div>
      <p className="text-xs text-gray-600 mt-1">{l.traza_json?.detalle || meta.ayuda}</p>
      {nombreVendedor && <p className="text-[11px] text-gray-400 mt-0.5">Vendedor: {nombreVendedor}</p>}
      {l.fecha_cobro_origen && <p className="text-[11px] text-gray-400">Cobro: {l.fecha_cobro_origen}</p>}
    </div>
  );
}

/** Secciones de líneas agrupadas por grupo (pagable/retenido/informativo/bloqueado/fondo). */
function SeccionesLineas({
  lineas,
  nombres,
}: {
  lineas: Linea[];
  nombres: ReturnType<typeof useNombres>;
}) {
  const porGrupo = useMemo(() => {
    const g: Record<Grupo, Linea[]> = { pagable: [], retenido: [], fondo: [], informativo: [], bloqueado: [] };
    for (const l of lineas) g[metaCodigo(l.traza_json?.codigo).grupo].push(l);
    return g;
  }, [lineas]);

  const render = (titulo: string, arr: Linea[], subtitulo?: string) =>
    arr.length === 0 ? null : (
      <div className="space-y-2">
        <h3 className="text-sm font-bold text-gray-700">
          {titulo} <span className="text-gray-400 font-normal">({arr.length})</span>
        </h3>
        {subtitulo && <p className="text-xs text-gray-500 -mt-1">{subtitulo}</p>}
        <div className="space-y-2">
          {arr.map((l) => (
            <FilaLinea
              key={l.id}
              l={l}
              nombreCliente={l.cliente_id != null ? nombres.clientes[l.cliente_id] : undefined}
              nombreVendedor={l.vendedor_id ? nombres.vendedores[l.vendedor_id] : undefined}
              nombrePersonal={l.personal_administrativo_id != null ? nombres.personal[l.personal_administrativo_id] : undefined}
            />
          ))}
        </div>
      </div>
    );

  return (
    <div className="space-y-5">
      {render("A pagar", porGrupo.pagable)}
      {render(
        "Retenidas (falta costear para comisionar)",
        porGrupo.retenido,
        "El servicio ocurrió y se cobró, pero sin presupuesto la utilidad no es confiable. Se paga en cuanto se costee.",
      )}
      {render("Fondo administrativo", porGrupo.fondo)}
      {render("Bloqueadas", porGrupo.bloqueado, "No calculan hasta resolver lo que indica cada fila.")}
      {render(
        "Informativas (no comisionan)",
        porGrupo.informativo,
        "Clientes que no son nuevos o que salieron de la ventana de 12 meses: se muestran para que se entienda por qué no pagan.",
      )}
    </div>
  );
}

/** El avance de los 7 indicadores del bono de atención, con su transparencia. */
function BonoAtencion({ lineaBono }: { lineaBono: Linea | undefined }) {
  // El detalle del motor nombra los indicadores que FALLARON. Es el único signo por
  // indicador que da el contrato; se usa solo para los dos que el motor puede romper.
  const detalle = lineaBono?.traza_json?.detalle ?? "";
  const fallo = (clave: string) => detalle.includes(clave);
  const total = lineaBono?.monto ?? null;

  return (
    <div className="rounded-xl border border-gray-200 bg-white p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="text-sm font-bold text-gray-800">Bono de atención</h3>
        <span className="text-lg font-bold text-gray-900">{total != null ? sol(total) : "sin calcular"}</span>
      </div>
      <div className="mt-2 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-xs text-amber-900">
        Hoy solo <b>cero quejas</b> y <b>sin cancelaciones</b> se evalúan con datos reales. Los otros cinco salen{" "}
        <b>cumplidos por defecto</b> porque aún no hay fuente de datos para medirlos. No se está midiendo lo que no se puede medir.
      </div>
      <div className="mt-3 space-y-2">
        {INDICADORES_BONO.map((ind) => {
          const falla = ind.medido && lineaBono != null && fallo(ind.clave);
          return (
            <div key={ind.clave} className="flex flex-wrap items-center justify-between gap-2 border-b border-gray-100 pb-2 last:border-0">
              <div className="min-w-0">
                <p className="text-sm text-gray-800">{ind.nombre}</p>
                <p className="text-[11px] text-gray-500">
                  {ind.medido ? (
                    <span className="text-green-700">Evaluado con datos · {ind.fuente}</span>
                  ) : (
                    <span className="text-amber-700">Cumplido por defecto — aún sin fuente de datos</span>
                  )}
                </p>
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <span className="text-xs text-gray-500">{sol(ind.valor)}</span>
                {lineaBono == null ? (
                  <Chip tono="gris">sin calcular</Chip>
                ) : falla ? (
                  <Chip tono="rojo">no cumplido</Chip>
                ) : ind.medido ? (
                  <Chip tono="verde">cumplido</Chip>
                ) : (
                  <Chip tono="ambar">por defecto</Chip>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <p className="mt-2 text-[11px] text-gray-400">
        Montos referenciales de la política por defecto (suman S/ 150, el tope del bono). El total pagado lo decide el motor
        según los indicadores cumplidos del mes.
      </p>
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Vista VENDEDOR
// ══════════════════════════════════════════════════════════════════════════════

function VistaVendedor() {
  const [anioMes, setAnioMes] = useState(mesActual());
  const { datos, cargando, error, sinMigracion } = useLineas(anioMes);
  const lineas = useMemo(() => datos?.lineas ?? [], [datos]);
  const nombres = useNombres(lineas);

  const lineaBono = lineas.find((l) => l.tipo === "bono_atencion");
  const totalPagar = useMemo(
    () => lineas.filter((l) => l.tipo !== "fondo_admin").reduce((a, l) => a + (Number(l.monto) || 0), 0),
    [lineas],
  );
  const totalFondo = useMemo(
    () => lineas.filter((l) => l.tipo === "fondo_admin").reduce((a, l) => a + (Number(l.monto) || 0), 0),
    [lineas],
  );

  // Clientes del mes agrupados por estado (comisiona / fuera de ventana / no nuevo).
  const clientesPorEstado = useMemo(() => {
    const m = new Map<number, { nombre: string; codigos: Set<string> }>();
    for (const l of lineas) {
      if (l.cliente_id == null) continue;
      const e = m.get(l.cliente_id) ?? { nombre: nombres.clientes[l.cliente_id] ?? `Cliente #${l.cliente_id}`, codigos: new Set() };
      if (l.traza_json?.codigo) e.codigos.add(l.traza_json.codigo);
      m.set(l.cliente_id, e);
    }
    return [...m.entries()];
  }, [lineas, nombres.clientes]);

  return (
    <main className="max-w-5xl mx-auto px-4 py-6 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Mis comisiones</h1>
          <p className="text-sm text-gray-500">Lo que te toca este mes, con el detalle de cada cálculo. Solo lectura.</p>
        </div>
        <SelectorMes valor={anioMes} onChange={setAnioMes} />
      </header>

      {sinMigracion && <BannerSinMigracion />}
      {error && !sinMigracion && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}
      {cargando && <p className="text-sm text-gray-500">Calculando…</p>}

      {!sinMigracion && !cargando && datos && !datos.periodo && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          Este mes todavía no se ha calculado. El cálculo preliminar lo deja listo tu administración a fin de mes.
        </div>
      )}

      {!sinMigracion && datos?.periodo && (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            <Tarjeta titulo="A pagar este mes" valor={sol(totalPagar)} tono="verde" />
            <Tarjeta
              titulo="Periodo"
              valor={datos.periodo.estado === "cerrado" ? "Cerrado" : "Preliminar"}
              tono={datos.periodo.estado === "cerrado" ? "gris" : "azul"}
              nota={datos.periodo.estado === "cerrado" ? "Ya no cambia." : "Puede cambiar hasta el cierre."}
            />
            {totalFondo > 0 && <Tarjeta titulo="Fondo administrativo" valor={sol(totalFondo)} tono="ambar" nota="Si también operas servicios." />}
          </div>

          <BonoAtencion lineaBono={lineaBono} />

          {clientesPorEstado.length > 0 && (
            <div className="rounded-xl border border-gray-200 bg-white p-4">
              <h3 className="text-sm font-bold text-gray-800 mb-2">Mis clientes del mes</h3>
              <div className="space-y-1.5">
                {clientesPorEstado.map(([id, e]) => {
                  const comisiona = e.codigos.has("pagar") || e.codigos.has("retenido_falta_costear");
                  const fuera = e.codigos.has("fuera_de_ventana");
                  const noNuevo = e.codigos.has("cliente_existente") || e.codigos.has("cliente_sin_ventana");
                  return (
                    <div key={id} className="flex items-center justify-between gap-2 text-sm">
                      <span className="text-gray-800 truncate">{e.nombre}</span>
                      {comisiona ? (
                        <Chip tono="verde">comisiona</Chip>
                      ) : fuera ? (
                        <Chip tono="gris">fuera de la ventana de 12 meses</Chip>
                      ) : noNuevo ? (
                        <Chip tono="gris">no es cliente nuevo</Chip>
                      ) : (
                        <Chip tono="gris">—</Chip>
                      )}
                    </div>
                  );
                })}
              </div>
              <p className="mt-2 text-[11px] text-gray-400">
                Los meses exactos que le quedan a cada cliente aparecen en el detalle de cada línea más abajo.
              </p>
            </div>
          )}

          <section className="space-y-4">
            <h2 className="text-lg font-bold text-gray-900">Detalle de mis líneas</h2>
            {lineas.length === 0 ? (
              <p className="text-sm text-gray-500">No tienes líneas este mes.</p>
            ) : (
              <SeccionesLineas lineas={lineas} nombres={nombres} />
            )}
          </section>
        </>
      )}
    </main>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Vista ADMINISTRADOR
// ══════════════════════════════════════════════════════════════════════════════

function VistaAdministrador({ esAdmin }: { esAdmin: boolean }) {
  const [anioMes, setAnioMes] = useState(mesActual());
  const { datos, cargando, error, sinMigracion, recargar } = useLineas(anioMes);
  const lineas = useMemo(() => datos?.lineas ?? [], [datos]);
  const nombres = useNombres(lineas);

  const [accion, setAccion] = useState<string | null>(null); // mensaje de la última acción
  const [trabajando, setTrabajando] = useState(false);
  const [modal, setModal] = useState<null | "clasificar" | "opero" | "cobrar">(null);

  const cerrado = datos?.periodo?.estado === "cerrado";

  const totales = useMemo(() => {
    let comisiones = 0, fondo = 0, retenidas = 0;
    for (const l of lineas) {
      const m = Number(l.monto) || 0;
      if (l.tipo === "fondo_admin") fondo += m;
      else comisiones += m;
      if (l.traza_json?.codigo === "retenido_falta_costear") {
        retenidas += (Number(l.base_utilidad) || 0) * (Number(l.pct_aplicado) || 0);
      }
    }
    return { comisiones, fondo, retenidas };
  }, [lineas]);

  // Líneas agrupadas por vendedor.
  const porVendedor = useMemo(() => {
    const m = new Map<string, Linea[]>();
    for (const l of lineas) {
      if (l.tipo === "fondo_admin") continue;
      const k = l.vendedor_id ?? "__sin__";
      (m.get(k) ?? m.set(k, []).get(k)!).push(l);
    }
    return [...m.entries()];
  }, [lineas]);

  const lineasFondo = lineas.filter((l) => l.tipo === "fondo_admin");

  async function accionErp(path: string, body: unknown, exito: string) {
    setTrabajando(true);
    setAccion(null);
    const r = await pedirErp(path, { method: "POST", body });
    setTrabajando(false);
    if (r.sinMigracion) { setAccion(r.error); return false; }
    if (!r.ok) { setAccion("Error: " + (r.error ?? "no se pudo completar")); return false; }
    setAccion(exito);
    await recargar();
    return true;
  }

  async function calcular() {
    await accionErp("/api/comisiones/calcular", { anioMes }, "Periodo recalculado.");
  }

  async function cerrar() {
    if (!confirm(`Vas a CERRAR el periodo ${anioMes}. Una vez cerrado queda INMUTABLE: las líneas se confirman y el mes ya no se recalcula. ¿Cerrar?`)) return;
    await accionErp("/api/comisiones/cerrar", { anioMes }, `Periodo ${anioMes} cerrado.`);
  }

  async function poblarPuente() {
    if (!confirm("Vincular automáticamente al personal administrativo con su usuario del ERP cuando el nombre coincida sin ambigüedad. ¿Continuar?")) return;
    setTrabajando(true);
    setAccion(null);
    const r = await pedirErp("/api/comisiones/puente", { method: "POST", body: { auto: true } });
    setTrabajando(false);
    if (r.sinMigracion) { setAccion(r.error); return; }
    if (!r.ok) { setAccion("Error: " + (r.error ?? "")); return; }
    setAccion(`Puente poblado: ${r.data?.vinculados ?? 0} vinculados, ${r.data?.ambiguos?.length ?? 0} ambiguos (asignación manual), ${r.data?.sin_match ?? 0} sin coincidencia.`);
  }

  async function exportar() {
    const headers = await cabecerasErp();
    const res = await fetch(`/api/comisiones/exportar?anioMes=${anioMes}`, { headers, cache: "no-store" });
    if (!res.ok) {
      const t = await res.text();
      let msg = `Error ${res.status}`;
      try { msg = JSON.parse(t).error ?? msg; } catch { /* */ }
      setAccion("No se pudo exportar: " + msg);
      return;
    }
    const blob = await res.blob();
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `comisiones-${anioMes}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  }

  return (
    <main className="max-w-6xl mx-auto px-4 py-6 space-y-6">
      <header className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl sm:text-3xl font-bold text-gray-900">Comisiones · administración</h1>
          <p className="text-sm text-gray-500">Calcula el preliminar, clasifica, corrobora el fondo y cierra el mes.</p>
        </div>
        <div className="flex items-center gap-2">
          <SelectorMes valor={anioMes} onChange={setAnioMes} />
          <button
            onClick={calcular}
            disabled={trabajando || cerrado}
            className="rounded-lg bg-blue-600 text-white text-sm font-semibold px-3 py-2 disabled:opacity-50"
          >
            {cerrado ? "Mes cerrado" : "Calcular / recalcular"}
          </button>
        </div>
      </header>

      {sinMigracion && <BannerSinMigracion />}
      {error && !sinMigracion && (
        <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">{error}</div>
      )}
      {accion && (
        <div className="rounded-xl border border-blue-200 bg-blue-50 p-3 text-sm text-blue-900">{accion}</div>
      )}
      {cargando && <p className="text-sm text-gray-500">Calculando…</p>}

      {!sinMigracion && datos && !datos.periodo && (
        <div className="rounded-xl border border-gray-200 bg-gray-50 p-4 text-sm text-gray-600">
          El periodo {anioMes} todavía no está calculado. Pulsa <b>Calcular / recalcular</b> para dejar el preliminar.
        </div>
      )}

      {!sinMigracion && datos?.periodo && (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
            <Tarjeta titulo="Comisiones del mes" valor={sol(totales.comisiones)} tono="verde" />
            <Tarjeta titulo="Retenido (falta costear)" valor={sol(totales.retenidas)} tono="ambar" nota="Se paga al costear." />
            <Tarjeta titulo="Fondo administrativo" valor={sol(totales.fondo)} tono="azul" nota="Lo paga la empresa." />
            <Tarjeta
              titulo="Periodo"
              valor={cerrado ? "Cerrado" : "Preliminar"}
              tono={cerrado ? "gris" : "ambar"}
              nota={datos.periodo.calculado_en ? `Calculado ${new Date(datos.periodo.calculado_en).toLocaleString("es-PE")}` : undefined}
            />
          </div>

          {/* Acciones del periodo */}
          <div className="flex flex-wrap gap-2">
            <button onClick={() => setModal("clasificar")} disabled={trabajando} className="rounded-lg border border-gray-300 bg-white text-sm font-semibold px-3 py-2 disabled:opacity-50">
              Clasificar reclamo / cancelación
            </button>
            <button onClick={() => setModal("opero")} disabled={trabajando} className="rounded-lg border border-gray-300 bg-white text-sm font-semibold px-3 py-2 disabled:opacity-50">
              Acreditar operador (fondo)
            </button>
            <button onClick={() => setModal("cobrar")} disabled={trabajando} className="rounded-lg border border-gray-300 bg-white text-sm font-semibold px-3 py-2 disabled:opacity-50">
              Marcar cobrado (con pruebas)
            </button>
            <button onClick={exportar} disabled={trabajando} className="rounded-lg border border-gray-300 bg-white text-sm font-semibold px-3 py-2 disabled:opacity-50">
              Exportar planilla (CSV)
            </button>
            {esAdmin && (
              <button onClick={poblarPuente} disabled={trabajando} className="rounded-lg border border-gray-300 bg-white text-sm font-semibold px-3 py-2 disabled:opacity-50">
                Poblar puente usuario↔administrativo
              </button>
            )}
            <button onClick={cerrar} disabled={trabajando || cerrado} className="rounded-lg bg-gray-900 text-white text-sm font-semibold px-3 py-2 disabled:opacity-50">
              {cerrado ? "Periodo cerrado" : "Cerrar el mes (inmutable)"}
            </button>
          </div>

          {/* Fondo administrativo y su corroboración */}
          <SeccionFondo
            esAdmin={esAdmin}
            anioMes={anioMes}
            lineasFondo={lineasFondo}
            nombres={nombres}
            onCambio={recargar}
            setAccion={setAccion}
          />

          {/* Por vendedor */}
          <section className="space-y-4">
            <h2 className="text-lg font-bold text-gray-900">Por vendedor</h2>
            {porVendedor.length === 0 && <p className="text-sm text-gray-500">No hay líneas de vendedor este mes.</p>}
            {porVendedor.map(([vid, arr]) => {
              const nombre = vid === "__sin__" ? "Sin vendedor identificado" : nombres.vendedores[vid] ?? vid;
              const subtotal = arr.reduce((a, l) => a + (Number(l.monto) || 0), 0);
              const bono = arr.find((l) => l.tipo === "bono_atencion");
              return (
                <div key={vid} className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <h3 className="font-bold text-gray-900">{nombre}</h3>
                    <span className="text-sm font-semibold text-gray-700">Subtotal: {sol(subtotal)}</span>
                  </div>
                  <SeccionesLineas lineas={arr} nombres={nombres} />
                  <details className="text-sm">
                    <summary className="cursor-pointer text-gray-600 font-semibold">Bono de atención y sus 7 indicadores</summary>
                    <div className="mt-2"><BonoAtencion lineaBono={bono} /></div>
                  </details>
                </div>
              );
            })}
          </section>

          {/* Lista firmada de clientes existentes */}
          <ListaFirmada />
        </>
      )}

      {modal === "clasificar" && <ModalClasificar onClose={() => setModal(null)} onHecho={recargar} setAccion={setAccion} />}
      {modal === "opero" && <ModalOpero onClose={() => setModal(null)} onHecho={recargar} setAccion={setAccion} />}
      {modal === "cobrar" && <ModalCobrar onClose={() => setModal(null)} onHecho={recargar} setAccion={setAccion} />}
    </main>
  );
}

// ── Fondo administrativo y corroboración ──────────────────────────────────────

function SeccionFondo({
  esAdmin,
  anioMes,
  lineasFondo,
  nombres,
  onCambio,
  setAccion,
}: {
  esAdmin: boolean;
  anioMes: string;
  lineasFondo: Linea[];
  nombres: ReturnType<typeof useNombres>;
  onCambio: () => void;
  setAccion: (s: string) => void;
}) {
  const [idMarca, setIdMarca] = useState("");
  const [trabajando, setTrabajando] = useState(false);
  const pendiente = lineasFondo.some((l) => l.traza_json?.codigo === "fondo_pendiente_corroboracion");

  async function corroborar(quitar = false) {
    const id = Number(idMarca.trim());
    if (!Number.isFinite(id) || id <= 0) { setAccion("Indica el id de la marca de operación a corroborar."); return; }
    setTrabajando(true);
    const r = await pedirErp("/api/comisiones/corroborar", {
      method: "POST",
      body: { id, anioMes, corroborar: !quitar },
    });
    setTrabajando(false);
    if (!r.ok) { setAccion("Error al corroborar: " + (r.error ?? "")); return; }
    setAccion(quitar ? `Corroboración retirada (${r.data?.actualizadas ?? 0}).` : `Marca corroborada (${r.data?.actualizadas ?? 0}).`);
    setIdMarca("");
    onCambio();
  }

  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-3">
      <h2 className="text-lg font-bold text-gray-900">Fondo administrativo</h2>
      {lineasFondo.length === 0 ? (
        <p className="text-sm text-gray-500">Este mes no hay fondo (ningún eventual nuevo cobrado).</p>
      ) : (
        <div className="space-y-2">
          {lineasFondo.map((l) => (
            <FilaLinea
              key={l.id}
              l={l}
              nombrePersonal={l.personal_administrativo_id != null ? nombres.personal[l.personal_administrativo_id] : undefined}
            />
          ))}
        </div>
      )}

      {pendiente && esAdmin && (
        <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900 space-y-2">
          <p className="font-semibold">El fondo está calculado pero no hay operadores corroborados.</p>
          <p>
            El reparto se hace entre los administrativos que <b>tú corrobores</b> sobre las marcas que dejaron los vendedores
            (botón «Acreditar operador»). El id de cada marca lo devuelve esa acción; corrobórala aquí:
          </p>
          <div className="flex flex-wrap items-center gap-2">
            <input
              value={idMarca}
              onChange={(e) => setIdMarca(e.target.value)}
              placeholder="id de la marca"
              inputMode="numeric"
              className="border border-amber-300 rounded px-2 py-1 text-sm w-40"
            />
            <button onClick={() => corroborar(false)} disabled={trabajando} className="rounded bg-amber-600 text-white text-sm font-semibold px-3 py-1.5 disabled:opacity-50">
              Corroborar marca
            </button>
            <button onClick={() => corroborar(true)} disabled={trabajando} className="rounded border border-amber-300 text-sm px-3 py-1.5 disabled:opacity-50">
              Retirar
            </button>
          </div>
          <p className="text-[11px] text-amber-700">
            Pendiente de backend: aún no hay una ruta que LISTE las marcas de operación por corroborar; mientras llega, se
            corrobora por id. (Solicitado: <code>GET /api/comisiones/marcas?anioMes=</code>.)
          </p>
        </div>
      )}
    </section>
  );
}

// ── Lista firmada de clientes existentes ──────────────────────────────────────

function ListaFirmada() {
  return (
    <section className="rounded-xl border border-gray-200 bg-white p-4 space-y-2">
      <h2 className="text-lg font-bold text-gray-900">Lista firmada de clientes existentes</h2>
      <p className="text-sm text-gray-600">
        Es la lista de clientes que ya existían al arrancar el módulo: un cliente en esta lista <b>no cuenta como nuevo</b> y
        no da bono de arranque. La define la base (<code>comisiones_lista_clientes_existentes</code>).
      </p>
      <div className="rounded-lg border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
        <p className="font-semibold">Carga pendiente de backend.</p>
        <p>
          Todavía no hay una ruta <code>/api/comisiones/*</code> para subir o pegar esta lista desde la pantalla, y este
          módulo no lee Supabase directo. Mientras llega esa ruta, la lista se carga por migración/base.
          (Solicitado: <code>POST /api/comisiones/lista-existentes</code> con los RUC/cliente_id firmados.)
        </p>
      </div>
    </section>
  );
}

// ── Modal: clasificar reclamo / cancelación ───────────────────────────────────

function ModalBase({ titulo, onClose, children }: { titulo: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md max-h-[90vh] overflow-y-auto p-5" onClick={(e) => e.stopPropagation()}>
        <div className="flex items-center justify-between mb-3">
          <h3 className="text-lg font-bold text-gray-900">{titulo}</h3>
          <button onClick={onClose} className="text-gray-400 hover:text-gray-700 text-xl leading-none">×</button>
        </div>
        {children}
      </div>
    </div>
  );
}

function ModalClasificar({ onClose, onHecho, setAccion }: { onClose: () => void; onHecho: () => void; setAccion: (s: string) => void }) {
  const [tipo, setTipo] = useState<"reclamo" | "cancelacion">("reclamo");
  const [reservaId, setReservaId] = useState("");
  const [clienteId, setClienteId] = useState("");
  const [gravedad, setGravedad] = useState("leve");
  const [fundado, setFundado] = useState(false);
  const [atribuible, setAtribuible] = useState(false);
  const [evitable, setEvitable] = useState(false);
  const [constancia, setConstancia] = useState(false);
  const [nota, setNota] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  async function enviar() {
    setErr(null);
    const rid = reservaId.trim() ? Number(reservaId) : null;
    const cid = clienteId.trim() ? Number(clienteId) : null;
    if (!rid && !cid) { setErr("Indica la reserva o el cliente."); return; }
    const body: Record<string, unknown> =
      tipo === "reclamo"
        ? { tipo, reservaId: rid, clienteId: cid, gravedad, fundado, atribuible_vendedor: atribuible, nota }
        : { tipo, reservaId: rid, evitable, constancia_escrita: constancia, nota };
    setEnviando(true);
    const r = await pedirErp("/api/comisiones/clasificar", { method: "POST", body });
    setEnviando(false);
    if (!r.ok) { setErr(r.error ?? "No se pudo clasificar."); return; }
    setAccion("Clasificación registrada. Recalcula el mes para que se refleje en el bono.");
    onHecho();
    onClose();
  }

  return (
    <ModalBase titulo="Clasificar reclamo / cancelación" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-gray-500">
          El motor paga ante la duda: un reclamo/cancelación sin clasificar NO rompe el bono. Clasificar es lo que lo puede
          romper. No puedes clasificar un servicio que tú vendiste.
        </p>
        <div className="flex gap-2">
          <button onClick={() => setTipo("reclamo")} className={`flex-1 rounded-lg border px-3 py-1.5 font-semibold ${tipo === "reclamo" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"}`}>Reclamo</button>
          <button onClick={() => setTipo("cancelacion")} className={`flex-1 rounded-lg border px-3 py-1.5 font-semibold ${tipo === "cancelacion" ? "border-gray-900 bg-gray-900 text-white" : "border-gray-300"}`}>Cancelación</button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <label className="block">
            <span className="text-xs text-gray-500">Reserva (id)</span>
            <input value={reservaId} onChange={(e) => setReservaId(e.target.value)} inputMode="numeric" className="w-full border border-gray-300 rounded px-2 py-1" />
          </label>
          {tipo === "reclamo" && (
            <label className="block">
              <span className="text-xs text-gray-500">o Cliente (id)</span>
              <input value={clienteId} onChange={(e) => setClienteId(e.target.value)} inputMode="numeric" className="w-full border border-gray-300 rounded px-2 py-1" />
            </label>
          )}
        </div>

        {tipo === "reclamo" ? (
          <>
            <label className="block">
              <span className="text-xs text-gray-500">Gravedad</span>
              <select value={gravedad} onChange={(e) => setGravedad(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1">
                <option value="leve">Leve</option>
                <option value="moderada">Moderada</option>
                <option value="grave">Grave</option>
              </select>
            </label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={fundado} onChange={(e) => setFundado(e.target.checked)} /> Fundado</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={atribuible} onChange={(e) => setAtribuible(e.target.checked)} /> Atribuible al vendedor</label>
            <p className="text-[11px] text-gray-400">Solo rompe el bono si es grave, fundado y atribuible al vendedor, a la vez.</p>
          </>
        ) : (
          <>
            <label className="flex items-center gap-2"><input type="checkbox" checked={evitable} onChange={(e) => setEvitable(e.target.checked)} /> Evitable</label>
            <label className="flex items-center gap-2"><input type="checkbox" checked={constancia} onChange={(e) => setConstancia(e.target.checked)} /> Con constancia escrita</label>
            <p className="text-[11px] text-gray-400">Solo rompe el bono si es evitable y con constancia escrita, a la vez.</p>
          </>
        )}

        <label className="block">
          <span className="text-xs text-gray-500">Nota (opcional)</span>
          <textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={2} className="w-full border border-gray-300 rounded px-2 py-1" />
        </label>

        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1.5">Cancelar</button>
          <button onClick={enviar} disabled={enviando} className="rounded-lg bg-gray-900 text-white font-semibold px-3 py-1.5 disabled:opacity-50">Guardar</button>
        </div>
      </div>
    </ModalBase>
  );
}

// ── Modal: acreditar operador (fondo) ─────────────────────────────────────────

function ModalOpero({ onClose, onHecho, setAccion }: { onClose: () => void; onHecho: () => void; setAccion: (s: string) => void }) {
  const [reservaId, setReservaId] = useState("");
  const [paId, setPaId] = useState("");
  const [nota, setNota] = useState("");
  const [personal, setPersonal] = useState<{ id: number; nombre: string }[]>([]);
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      const { data } = await supabase.from("personal_administrativo").select("id,nombre").order("nombre");
      const filas = (data ?? []) as { id: number; nombre: string | null }[];
      setPersonal(filas.map((p) => ({ id: Number(p.id), nombre: p.nombre ?? String(p.id) })));
    })();
  }, []);

  async function enviar() {
    setErr(null);
    const rid = Number(reservaId);
    const pid = Number(paId);
    if (!Number.isFinite(rid) || rid <= 0) { setErr("Indica la reserva."); return; }
    if (!Number.isFinite(pid) || pid <= 0) { setErr("Elige al administrativo que ayudó."); return; }
    setEnviando(true);
    const r = await pedirErp("/api/comisiones/opero", { method: "POST", body: { reservaId: rid, personalAdministrativoId: pid, nota } });
    setEnviando(false);
    if (!r.ok) { setErr(r.error ?? "No se pudo acreditar."); return; }
    setAccion(`Operador acreditado (marca #${r.data?.id ?? "?"}). Corrobórala en la sección de Fondo con ese id.`);
    onHecho();
    onClose();
  }

  return (
    <ModalBase titulo="Acreditar operador (fondo)" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-gray-500">Marca que un administrativo ayudó en un servicio. La marca queda SIN corroborar; solo lo que el admin corrobore entra al reparto del fondo.</p>
        <label className="block">
          <span className="text-xs text-gray-500">Reserva (id)</span>
          <input value={reservaId} onChange={(e) => setReservaId(e.target.value)} inputMode="numeric" className="w-full border border-gray-300 rounded px-2 py-1" />
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Administrativo que ayudó</span>
          <select value={paId} onChange={(e) => setPaId(e.target.value)} className="w-full border border-gray-300 rounded px-2 py-1">
            <option value="">— elegir —</option>
            {personal.map((p) => <option key={p.id} value={p.id}>{p.nombre}</option>)}
          </select>
        </label>
        <label className="block">
          <span className="text-xs text-gray-500">Nota (opcional)</span>
          <textarea value={nota} onChange={(e) => setNota(e.target.value)} rows={2} className="w-full border border-gray-300 rounded px-2 py-1" />
        </label>
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1.5">Cancelar</button>
          <button onClick={enviar} disabled={enviando} className="rounded-lg bg-gray-900 text-white font-semibold px-3 py-1.5 disabled:opacity-50">Acreditar</button>
        </div>
      </div>
    </ModalBase>
  );
}

// ── Modal: marcar cobrado (3 pruebas) ─────────────────────────────────────────

function ModalCobrar({ onClose, onHecho, setAccion }: { onClose: () => void; onHecho: () => void; setAccion: (s: string) => void }) {
  const [reservaId, setReservaId] = useState("");
  const [deposito, setDeposito] = useState<File | null>(null);
  const [facturaPdf, setFacturaPdf] = useState<File | null>(null);
  const [facturaXml, setFacturaXml] = useState<File | null>(null);
  const [enviando, setEnviando] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const rid = Number(reservaId);
  const faltan: string[] = [];
  if (!Number.isFinite(rid) || rid <= 0) faltan.push("la reserva");
  if (!deposito) faltan.push("la foto del depósito");
  if (!facturaPdf) faltan.push("la factura en PDF");
  if (!facturaXml) faltan.push("la factura en XML");
  const listo = faltan.length === 0;

  async function enviar() {
    if (!listo) return;
    setErr(null);
    setEnviando(true);
    const fd = new FormData();
    fd.set("reservaId", String(rid));
    fd.set("deposito", deposito!);
    fd.set("factura_pdf", facturaPdf!);
    fd.set("factura_xml", facturaXml!);
    const r = await pedirErp("/api/comisiones/cobrar", { method: "POST", multipart: fd });
    setEnviando(false);
    if (!r.ok) { setErr(r.error ?? "No se pudo marcar cobrado."); return; }
    setAccion(`Reserva #${rid} marcada como cobrada con sus tres pruebas. Recalcula para reflejarlo.`);
    onHecho();
    onClose();
  }

  const campoArchivo = (label: string, val: File | null, set: (f: File | null) => void, accept: string) => (
    <label className="block">
      <span className="text-xs text-gray-500">{label} {val && <span className="text-green-700">✓ {val.name}</span>}</span>
      <input type="file" accept={accept} onChange={(e) => set(e.target.files?.[0] ?? null)} className="w-full text-sm mt-0.5" />
    </label>
  );

  return (
    <ModalBase titulo="Marcar cobrado" onClose={onClose}>
      <div className="space-y-3 text-sm">
        <p className="text-xs text-gray-500">La comisión se reconoce cuando el servicio está cobrado. Se exigen las TRES pruebas; se guardan en el bucket privado.</p>
        <label className="block">
          <span className="text-xs text-gray-500">Reserva (id)</span>
          <input value={reservaId} onChange={(e) => setReservaId(e.target.value)} inputMode="numeric" className="w-full border border-gray-300 rounded px-2 py-1" />
        </label>
        {campoArchivo("Foto del depósito", deposito, setDeposito, "image/*,application/pdf")}
        {campoArchivo("Factura en PDF", facturaPdf, setFacturaPdf, "application/pdf")}
        {campoArchivo("Factura en XML", facturaXml, setFacturaXml, ".xml,text/xml,application/xml")}
        {!listo && <p className="text-xs text-amber-700">Falta {faltan.join(", ")} para habilitar el botón.</p>}
        {err && <p className="text-sm text-red-700">{err}</p>}
        <div className="flex justify-end gap-2">
          <button onClick={onClose} className="rounded-lg border border-gray-300 px-3 py-1.5">Cancelar</button>
          <button onClick={enviar} disabled={!listo || enviando} className="rounded-lg bg-green-600 text-white font-semibold px-3 py-1.5 disabled:opacity-50">
            {enviando ? "Subiendo…" : "Marcar cobrado"}
          </button>
        </div>
      </div>
    </ModalBase>
  );
}
