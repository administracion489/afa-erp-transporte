"use client";

import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";
import {
  describirCopiaInterna, alarmaCopiaInterna, FUENTE_COPIA,
  type CopiaInterna,
} from "@/lib/ocupacion/copia-interna";

export default function ReportesPage() {
  const [resumen, setResumen] = useState<any>(null);
  const [reservas, setReservas] = useState<any[]>([]);
  const [gastos, setGastos] = useState<any[]>([]);
  const [facturas, setFacturas] = useState<any[]>([]);
  const [loading, setLoading] = useState(false);

  const cargarDatos = async () => {
    setLoading(true);

    const [resumenRes, reservasRes, gastosRes, facturasRes] =
      await Promise.all([
        supabase.from("resumen_erp").select("*").single(),
        supabase.from("reservas").select("*").order("id", { ascending: false }),
        supabase.from("gastos").select("*").order("fecha", { ascending: false }),
        supabase.from("facturas").select("*").order("id", { ascending: false }),
      ]);

    if (resumenRes.error) alert(resumenRes.error.message);
    else setResumen(resumenRes.data);

    setReservas(reservasRes.data || []);
    setGastos(gastosRes.data || []);
    setFacturas(facturasRes.data || []);

    setLoading(false);
  };

  useEffect(() => {
    cargarDatos();
  }, []);

  const totalReservas = Number(resumen?.total_reservas || 0);
  const ventasReservas = Number(resumen?.total_ventas_reservas || 0);
  const margenReservas = Number(resumen?.total_margen_reservas || 0);
  const totalFacturado = Number(resumen?.total_facturado || 0);
  const totalGastos = Number(resumen?.total_gastos || 0);
  const utilidadEstimada = totalFacturado - totalGastos;

  const gastosPorCategoria = gastos.reduce((acc: any, g) => {
    acc[g.categoria] = (acc[g.categoria] || 0) + Number(g.monto || 0);
    return acc;
  }, {});

  const reservasPorTipo = reservas.reduce((acc: any, r) => {
    acc[r.tipo] = (acc[r.tipo] || 0) + 1;
    return acc;
  }, {});

  const facturasPorEstado = facturas.reduce((acc: any, f) => {
    acc[f.estado] = (acc[f.estado] || 0) + Number(f.total || 0);
    return acc;
  }, {});

  return (
    <main className="p-6 space-y-6">
      <div>
        <h1 className="text-3xl font-bold">Reportes</h1>
        <p className="text-gray-600">
          Resumen financiero, operativo y documental del ERP.
        </p>
      </div>

      <PanelOcupacionSemanal />

      {loading ? (
        <div className="bg-white rounded-xl border shadow p-6 text-center">
          Cargando reportes...
        </div>
      ) : (
        <>
          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Clientes</p>
              <p className="text-2xl font-bold">
                {resumen?.total_clientes || 0}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Reservas</p>
              <p className="text-2xl font-bold">{totalReservas}</p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Ventas reservas</p>
              <p className="text-2xl font-bold text-green-600">
                S/ {ventasReservas.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Margen reservas</p>
              <p className="text-2xl font-bold text-blue-600">
                S/ {margenReservas.toFixed(2)}
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Facturado</p>
              <p className="text-2xl font-bold text-green-600">
                S/ {totalFacturado.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Gastos</p>
              <p className="text-2xl font-bold text-red-600">
                S/ {totalGastos.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Utilidad estimada</p>
              <p
                className={`text-2xl font-bold ${
                  utilidadEstimada >= 0 ? "text-green-600" : "text-red-600"
                }`}
              >
                S/ {utilidadEstimada.toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Combustible</p>
              <p className="text-2xl font-bold text-red-600">
                S/ {Number(resumen?.total_combustible || 0).toFixed(2)}
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-4 gap-4">
            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Mantenimiento</p>
              <p className="text-2xl font-bold text-red-600">
                S/ {Number(resumen?.total_mantenimiento || 0).toFixed(2)}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Docs vencidos</p>
              <p className="text-2xl font-bold text-red-600">
                {resumen?.documentos_vencidos || 0}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Docs por vencer</p>
              <p className="text-2xl font-bold text-yellow-600">
                {resumen?.documentos_por_vencer || 0}
              </p>
            </div>

            <div className="bg-white rounded-xl border shadow p-4">
              <p className="text-sm text-gray-500">Seguros por vencer</p>
              <p className="text-2xl font-bold text-yellow-600">
                {resumen?.seguros_por_vencer || 0}
              </p>
            </div>
          </section>

          <section className="grid grid-cols-1 md:grid-cols-3 gap-4">
            <div className="bg-white rounded-xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Gastos por categoría</h2>

              {Object.keys(gastosPorCategoria).length === 0 ? (
                <p className="text-gray-500">Sin gastos registrados.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(gastosPorCategoria).map(([cat, monto]) => (
                    <div key={cat} className="flex justify-between border-b pb-2">
                      <span>{cat}</span>
                      <span className="font-bold text-red-600">
                        S/ {Number(monto).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Reservas por tipo</h2>

              {Object.keys(reservasPorTipo).length === 0 ? (
                <p className="text-gray-500">Sin reservas registradas.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(reservasPorTipo).map(([tipo, cantidad]) => (
                    <div key={tipo} className="flex justify-between border-b pb-2">
                      <span>{tipo}</span>
                      <span className="font-bold">{Number(cantidad)}</span>
                    </div>
                  ))}
                </div>
              )}
            </div>

            <div className="bg-white rounded-xl border shadow p-6">
              <h2 className="text-xl font-bold mb-4">Facturas por estado</h2>

              {Object.keys(facturasPorEstado).length === 0 ? (
                <p className="text-gray-500">Sin facturas registradas.</p>
              ) : (
                <div className="space-y-2">
                  {Object.entries(facturasPorEstado).map(([estado, total]) => (
                    <div
                      key={estado}
                      className="flex justify-between border-b pb-2"
                    >
                      <span>{estado}</span>
                      <span className="font-bold text-green-600">
                        S/ {Number(total).toFixed(2)}
                      </span>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </section>

          <section className="bg-white rounded-xl border shadow p-6 overflow-x-auto">
            <h2 className="text-xl font-bold mb-4">Últimas reservas</h2>

            <table className="w-full text-sm">
              <thead className="bg-gray-100">
                <tr>
                  <th className="p-3 text-left">ID</th>
                  <th className="p-3 text-left">Ruta</th>
                  <th className="p-3 text-left">Tipo</th>
                  <th className="p-3 text-left">Estado</th>
                  <th className="p-3 text-left">Precio</th>
                  <th className="p-3 text-left">Margen</th>
                </tr>
              </thead>

              <tbody>
                {reservas.slice(0, 10).map((r) => (
                  <tr key={r.id} className="border-t">
                    <td className="p-3">{r.id}</td>
                    <td className="p-3">
                      {r.origen} → {r.destino}
                    </td>
                    <td className="p-3">{r.tipo}</td>
                    <td className="p-3">{r.estado}</td>
                    <td className="p-3">
                      S/ {Number(r.precio_cliente || 0).toFixed(2)}
                    </td>
                    <td className="p-3 font-bold text-green-600">
                      S/ {Number(r.margen || 0).toFixed(2)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
    </main>
  );
}
// ══════════════════════════════════════════════════════════════════════════════
// Reporte semanal de ocupación — disparo manual y estado
//
// El correo sale solo los sábados a las 20:00 (Lima) por cron. Este panel existe
// por dos razones concretas:
//
//  · PODER COMPROBARLO SIN ESPERAR AL SÁBADO. Un envío automático que solo se
//    puede verificar una vez por semana se despliega a ciegas.
//  · PODER REEMITIR una semana cuyo cron falló, nombrando su fecha de cierre.
//
// El botón NO salta el candado del envío doble: el endpoint relee la bitácora y
// el índice único de Postgres remata. Reemitir una semana ya enviada responde
// «ya se envió este periodo» en vez de mandarlo otra vez — un correo no se
// des-envía, así que ese candado no se puede aflojar ni «para probar».
// ══════════════════════════════════════════════════════════════════════════════
function PanelOcupacionSemanal() {
  const [corriendo, setCorriendo] = useState(false);
  const [res, setRes] = useState<any>(null);
  const [fin, setFin] = useState("");

  const emitir = async () => {
    // `forzarDia` salta SOLO la comprobación de «¿hoy le toca a este cliente?», para
    // poder probar sin esperar a su fecha. La VENTANA no se toca: cada cliente sigue
    // recibiendo el periodo que tiene configurado, cerrando en la fecha indicada.
    // Nunca se inventa un periodo distinto del que se va a mandar de verdad.
    if (!confirm("Se van a enviar correos REALES a los clientes que tengan el reporte activado. ¿Continuar?")) return;
    setCorriendo(true); setRes(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch("/api/reportes/ocupacion-semanal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
        body: JSON.stringify({ fin: fin || undefined, forzarDia: true }),
      });
      setRes(await r.json());
    } catch (e: any) {
      setRes({ error: String(e?.message ?? e) });
    } finally {
      setCorriendo(false);
    }
  };

  const sinMigracion = typeof res?.motivo === "string" && res.motivo.startsWith("sin_migracion");

  return (
    <section className="bg-white rounded-xl border shadow p-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="font-bold text-lg">Ocupación semanal</h2>
          <p className="text-sm text-gray-600 max-w-2xl mt-1">
            A las <b>20:00</b> sale, a cada cliente que lo tenga activado, el detalle de cuánta gente
            viajó frente a los asientos contratados, ruta por ruta, con el Excel del detalle, los
            manifiestos y los reportes de servicio. Se mide el <b>día de más afluencia</b>, nunca el
            promedio. <b>Cada cuánto se envía</b> (sábados · días 1 y 16 · día 1 · fin de mes) y
            <b>qué periodo abarca</b> (7, 15, 30 días o el mes calendario) se eligen por separado, en
            <b>Clientes → editar → Reporte semanal de ocupación</b>, junto con el interruptor de las
            sugerencias. El cron corre a diario y cada cliente sale el día que le toca.
          </p>
        </div>
        <div className="flex items-end gap-2">
          <label className="text-xs text-gray-500">
            <span className="block mb-1">Periodo que cierra el</span>
            <input type="date" value={fin} onChange={e => setFin(e.target.value)}
              className="border rounded-lg px-2 py-1.5 text-sm" />
          </label>
          <button onClick={emitir} disabled={corriendo}
            className={`px-4 py-2 rounded-lg text-sm font-bold text-white ${corriendo ? "bg-gray-400" : "bg-[#0b315f] hover:bg-[#0a2a50]"}`}>
            {corriendo ? "Enviando…" : "Enviar ahora"}
          </button>
        </div>
      </div>

      {sinMigracion && (
        <p className="mt-3 text-sm bg-amber-50 border-l-4 border-amber-500 rounded-r px-3 py-2 text-amber-900">
          Falta correr <code className="font-mono text-xs">supabase/reportes-01-ocupacion-semanal.sql</code>.
          Hasta entonces no se manda nada y el interruptor por cliente no se guarda.
        </p>
      )}

      <BloqueCopiaInterna />
      <BloquePrueba fin={fin} />

      {res?.error && <p className="mt-3 text-sm text-red-700">{res.error}</p>}

      {res && !res.error && !sinMigracion && (
        <div className="mt-4 text-sm">
          {res.periodo && (
            <p className="text-gray-500 text-xs mb-2">
              Periodo {res.periodo.inicio} → {res.periodo.fin}
            </p>
          )}
          {/* Lo que hizo la copia interna en ESTA corrida. Solo se dice cuando NO
              salió: contesta «¿por qué no me llegó a mí?» sin mirar la base, y
              repetirlo cada vez que sí sale lo volvería paisaje. */}
          {res.copia_interna && res.copia_interna.codigo !== "activa" && (
            <p className="text-gray-500 text-xs mb-2">
              Copia interna de AFA:{" "}
              {res.copia_interna.codigo === "apagada"
                ? "apagada, no salió."
                : "encendida pero sin ninguna dirección, no salió."}
            </p>
          )}
          {res.motivo === "ningun_cliente_activo" ? (
            <p className="text-gray-600">
              Ningún cliente tiene el reporte activado todavía. Se enciende en <b>Clientes → editar →
              Reporte semanal de ocupación</b>.
            </p>
          ) : res.motivo === "hoy_no_toca_a_nadie" ? (
            <p className="text-gray-600">
              Hoy no le toca a ningún cliente según su cadencia, así que el cron no habría emitido.
            </p>
          ) : (
            <table className="w-full text-sm">
              <thead>
                <tr className="text-left text-[11px] uppercase tracking-wide text-gray-500 border-b">
                  <th className="py-1.5">Cliente</th><th className="py-1.5">Rutas</th><th className="py-1.5">Enviado a</th>
                </tr>
              </thead>
              <tbody>
                {(res.clientes ?? []).map((c: any, i: number) => (
                  <tr key={i} className="border-b last:border-0">
                    <td className="py-1.5 font-medium">{c.cliente}</td>
                    <td className="py-1.5 text-gray-600">{c.rutas}</td>
                    <td className="py-1.5 text-gray-600">
                      {c.error
                        ? <span className="text-red-700">{c.error}</span>
                        : c.enviados?.length
                          ? c.enviados.join(", ")
                          : <span className="text-gray-400">{c.omitido ?? "—"}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// La copia interna de AFA — el interruptor y a quién le llega
//
// Es el correo que le sale a AFA por CADA cliente al que se le manda el reporte,
// y es la única que lleva las sugerencias completas aunque el cliente las tenga
// apagadas: la propuesta comercial la tiene que ver quien puede decidirla.
//
// Vivía en una variable de entorno de Vercel, o sea un control que el sistema LEE
// y que nadie podía tocar desde el ERP — el mismo defecto que una columna sin
// formulario. Lo pidió el dueño así: «mejor que esté detallado, o un botón para
// activar o desactivar el envío al área de operaciones de AFA».
//
// LA PANTALLA NO RESUELVE NADA POR SU CUENTA. `REPORTE_OCUPACION_CORREOS` solo
// existe en el servidor, así que quien dice a quién le va a llegar es el endpoint,
// con el MISMO `resolverCopiaInterna` que corre el cron. Acá se pinta lo que
// contestó: una pantalla con su propia cuenta terminaría enseñando una lista y el
// cron mandando a otra.
// ══════════════════════════════════════════════════════════════════════════════
function BloqueCopiaInterna() {
  const [cargando, setCargando] = useState(true);
  const [guardando, setGuardando] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const [sinTabla, setSinTabla] = useState(false);
  const [activa, setActiva] = useState(true);
  const [correos, setCorreos] = useState("");
  const [copia, setCopia] = useState<CopiaInterna | null>(null);
  const [respaldos, setRespaldos] = useState<{ variable_entorno: string[]; perfil_empresa: string[] } | null>(null);

  const aplicar = (j: any) => {
    setSinTabla(j?.sin_tabla === true);
    if (j?.fila) {
      setActiva(j.fila.copia_afa_activa !== false);
      setCorreos(j.fila.copia_afa_correos ?? "");
    }
    if (j?.copia) setCopia(j.copia as CopiaInterna);
    if (j?.respaldos) setRespaldos(j.respaldos);
  };

  const pedir = async (metodo: "GET" | "POST") => {
    const { data: s } = await supabase.auth.getSession();
    const r = await fetch("/api/reportes/copia-interna", {
      method: metodo,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
      ...(metodo === "POST"
        ? { body: JSON.stringify({ copia_afa_activa: activa, copia_afa_correos: correos }) }
        : {}),
    });
    const j = await r.json();
    // El endpoint exige el módulo `reportes`, y un operador puede no tenerlo. Sin
    // nombrarlo se lee como que el ERP está roto.
    if (r.status === 403) throw new Error("Te falta el permiso del módulo Reportes para ver o cambiar esto.");
    if (j?.error) throw new Error(j.error);
    return j;
  };

  useEffect(() => {
    (async () => {
      try { aplicar(await pedir("GET")); }
      catch (e: any) { setErr(String(e?.message ?? e)); }
      finally { setCargando(false); }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const guardar = async () => {
    setGuardando(true); setErr(null);
    try {
      const j = await pedir("POST");
      aplicar(j);
      if (j?.ok === false && j?.error) setErr(j.error);
    } catch (e: any) {
      setErr(String(e?.message ?? e));
    } finally {
      setGuardando(false);
    }
  };

  return (
    <div className="mt-5 border-t pt-4">
      <h3 className="font-bold text-sm">Copia interna de AFA</h3>

      {cargando ? (
        // Nunca se afirma un vacío mientras se está buscando.
        <p className="text-sm text-gray-500 mt-1">Consultando…</p>
      ) : (
        <>
          <label className="flex items-start gap-2 mt-2 cursor-pointer">
            <input type="checkbox" checked={activa} onChange={e => setActiva(e.target.checked)}
              className="mt-1" />
            <span className="text-sm">
              <b>Enviar copia al área de operaciones de AFA</b>
              <span className="block text-xs text-gray-600 mt-0.5">
                Un correo por cada cliente al que se le mande el reporte, <b>siempre con las
                sugerencias completas</b> aunque ese cliente las tenga apagadas. No sustituye al
                interruptor de cada cliente: si nadie lo tiene encendido, no hay nada que copiar.
              </span>
            </span>
          </label>

          <label className="block mt-3 text-xs text-gray-500">
            <span className="block mb-1">Correos de operaciones (separados por coma)</span>
            <input value={correos} onChange={e => setCorreos(e.target.value)}
              disabled={!activa}
              placeholder="operaciones@empresa.com, gerencia@empresa.com"
              className={`w-full max-w-xl border rounded-lg px-3 py-2 text-sm ${activa ? "" : "bg-gray-100 text-gray-400"}`} />
          </label>

          {/* Los dos escalones de respaldo se NOMBRAN, porque cada uno se corrige
              en otro sitio: Vercel o /configuracion/perfil. Sin decirlo, vaciar el
              campo parece apagar la copia y en realidad la manda a otra parte. */}
          {activa && !correos.trim() && respaldos && (
            <p className="text-xs text-gray-500 mt-1">
              Vacío = se usa{" "}
              {respaldos.variable_entorno.length
                ? <>la variable <code className="font-mono">REPORTE_OCUPACION_CORREOS</code> de Vercel ({respaldos.variable_entorno.join(", ")})</>
                : respaldos.perfil_empresa.length
                  ? <>el correo de la empresa de <b>/configuracion/perfil</b> ({respaldos.perfil_empresa.join(", ")})</>
                  : <>… y no hay nada en ninguno de los dos escalones de respaldo.</>}
            </p>
          )}

          {/* La frase la compone el módulo PURO con los mismos valores que el cron.
              Dentro del TSX, una pantalla puede describir al revés lo que el sistema
              hace sin que nada falle. */}
          {copia && (
            <p className={`mt-3 text-sm rounded-r px-3 py-2 border-l-4 ${
              alarmaCopiaInterna(copia)
                ? "bg-amber-50 border-amber-500 text-amber-900"
                : "bg-gray-50 border-gray-300 text-gray-700"}`}>
              {describirCopiaInterna(copia)}
              {copia.fuente && copia.fuente !== "configurada" && (
                <span className="block text-xs mt-1 text-gray-500">
                  Se corrigen {FUENTE_COPIA[copia.fuente]}.
                </span>
              )}
            </p>
          )}

          <div className="flex items-center gap-3 mt-3">
            <button onClick={guardar} disabled={guardando}
              className={`px-4 py-2 rounded-lg text-sm font-bold text-white ${guardando ? "bg-gray-400" : "bg-[#0b315f] hover:bg-[#0a2a50]"}`}>
              {guardando ? "Guardando…" : "Guardar copia interna"}
            </button>
            <span className="text-xs text-gray-500">
              Lo guardado es lo que lee el cron: la frase de arriba se rehace con la respuesta del servidor.
            </span>
          </div>

          {sinTabla && (
            <p className="mt-3 text-sm bg-amber-50 border-l-4 border-amber-500 rounded-r px-3 py-2 text-amber-900">
              Falta correr <code className="font-mono text-xs">supabase/reportes-03-copia-interna.sql</code>.
              Hasta entonces esto <b>no se guarda</b> — y la copia sigue saliendo exactamente como
              hasta ahora, a la dirección que resuelva la cascada.
            </p>
          )}

          {err && <p className="mt-3 text-sm text-red-700">{err}</p>}
        </>
      )}
    </div>
  );
}

// ══════════════════════════════════════════════════════════════════════════════
// Probar: el reporte de UN cliente, SOLO a AFA
//
// Lo pidió el dueño: «quiero enviar solo a un cliente y solo a AFA para probar,
// no hay esa opción». Y no la había — los dos botones que existían le mandan al
// CLIENTE: el de arriba dispara el tick entero y el de la ficha manda a uno pero
// también a él. O sea, no había forma de ver cómo queda el reporte de un cliente
// sin que ese cliente lo recibiera, que es justo lo que se quiere mirar ANTES de
// encenderle el envío.
//
// DOS COSAS QUE LA HACEN UNA PRUEBA Y NO UN ENVÍO, y las decide `planDeEnvio`:
//
//  · El cliente no entra ni por asomo. Ni se resuelve su correo, ni se escribe su
//    fila de bitácora. Y si la copia interna no tiene a dónde ir, la prueba NO
//    sale: no se cae al cliente, que sería el correo que no se des-envía.
//  · NO consume el envío del sábado. Se registra como `prueba_afa`, así que el
//    candado `(cliente_id, destino, periodo_fin)` de `afa` queda libre. Con
//    destino `afa` habría quemado la copia real de ese periodo en silencio.
//
// Por eso ESTA lista trae TODOS los clientes, encendidos o no: probar antes de
// encender es el caso de uso. La garantía dura del módulo —nada le sale a un
// cliente que nadie encendió— no la toca, porque la prueba nunca le escribe.
// ══════════════════════════════════════════════════════════════════════════════
function BloquePrueba({ fin }: { fin: string }) {
  const [clientes, setClientes] = useState<any[]>([]);
  const [cargando, setCargando] = useState(true);
  const [id, setId] = useState("");
  const [enviando, setEnviando] = useState(false);
  const [res, setRes] = useState<any>(null);

  useEffect(() => {
    (async () => {
      // `reporte_ocupacion_activo` es de una migración accesoria: se pide y, si el
      // error la NOMBRA, se reintenta sin ella. Lo único que se pierde entonces es
      // la marca de «ya encendido»; la lista sigue sirviendo para probar.
      const base = "id,nombre,empresa";
      let r = await supabase.from("clientes").select(`${base},reporte_ocupacion_activo`).order("empresa");
      if (r.error && /reporte_ocupacion/i.test(r.error.message ?? "")) {
        r = await supabase.from("clientes").select(base).order("empresa");
      }
      setClientes((r.data as any[]) ?? []);
      setCargando(false);
    })();
  }, []);

  const elegido = clientes.find((c) => String(c.id) === id);
  const nombre = elegido ? String(elegido.empresa || elegido.nombre || `Cliente ${elegido.id}`) : "";

  const probar = async () => {
    if (!elegido) return;
    // El confirm NOMBRA al cliente y dice las dos cosas que la separan de un
    // envío, en vez de preguntar «¿estás seguro?».
    if (!confirm(
      `Se va a enviar el reporte de ${nombre}${fin ? ` (periodo que cierra el ${fin})` : ""} `
      + "SOLO a los correos de la copia interna de AFA.\n\n"
      + "· El cliente NO recibe nada.\n"
      + "· No consume su envío programado: ese sigue saliendo el día que le toca.\n\n"
      + "¿Continuar?",
    )) return;

    setEnviando(true); setRes(null);
    try {
      const { data: s } = await supabase.auth.getSession();
      const r = await fetch("/api/reportes/ocupacion-semanal", {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.session?.access_token ?? ""}` },
        body: JSON.stringify({ clienteId: Number(id), soloAfa: true, fin: fin || undefined }),
      });
      if (r.status === 403) throw new Error("Te falta el permiso del módulo Reportes.");
      setRes(await r.json());
    } catch (e: any) {
      setRes({ error: String(e?.message ?? e) });
    } finally {
      setEnviando(false);
    }
  };

  const salieron: string[] = (res?.clientes ?? []).flatMap((c: any) => c.enviados ?? []);
  const omitido: string | undefined = (res?.clientes ?? [])[0]?.omitido;

  return (
    <div className="mt-5 border-t pt-4">
      <h3 className="font-bold text-sm">Probar: mándame a mí el de un cliente</h3>
      <p className="text-xs text-gray-600 mt-1 max-w-2xl">
        Sale <b>solo a los correos de la copia interna</b> de arriba, con las sugerencias completas.
        El cliente <b>no recibe nada</b> y <b>no se gasta su envío programado</b>. Sirve para ver cómo
        le va a quedar antes de encenderle el reporte en <b>Clientes → editar</b>.
      </p>

      <div className="flex flex-wrap items-end gap-2 mt-3">
        <label className="text-xs text-gray-500">
          <span className="block mb-1">Cliente</span>
          <select value={id} onChange={e => { setId(e.target.value); setRes(null); }}
            disabled={cargando}
            className="border rounded-lg px-2 py-1.5 text-sm min-w-[18rem]">
            <option value="">{cargando ? "Cargando clientes…" : "— elige un cliente —"}</option>
            {clientes.map((c) => (
              <option key={c.id} value={c.id}>
                {String(c.empresa || c.nombre || `Cliente ${c.id}`)}
                {c.reporte_ocupacion_activo ? " · reporte encendido" : ""}
              </option>
            ))}
          </select>
        </label>
        <button onClick={probar} disabled={!id || enviando}
          className={`px-4 py-2 rounded-lg text-sm font-bold text-white ${!id || enviando ? "bg-gray-400" : "bg-[#0b315f] hover:bg-[#0a2a50]"}`}>
          {enviando ? "Enviando…" : "Enviarme la prueba"}
        </button>
      </div>

      {/* Un botón apagado DICE qué le falta, en vez de quedarse mudo. */}
      {!id && !cargando && (
        <p className="text-xs text-gray-500 mt-1">Elige un cliente para habilitar el botón.</p>
      )}
      <p className="text-xs text-gray-500 mt-1">
        {fin ? <>Usa el <b>periodo que cierra el {fin}</b> de arriba.</> : <>Sin fecha arriba, usa el periodo que cierra <b>hoy</b>.</>}
      </p>

      {res?.error && <p className="mt-3 text-sm text-red-700">{res.error}</p>}

      {res && !res.error && (
        <p className={`mt-3 text-sm rounded-r px-3 py-2 border-l-4 ${
          salieron.length ? "bg-green-50 border-green-500 text-green-900"
                          : "bg-amber-50 border-amber-500 text-amber-900"}`}>
          {salieron.length ? (
            <>Enviado a <b>{[...new Set(salieron)].join(", ")}</b>
              {res.periodo && <> · periodo {res.periodo.inicio} → {res.periodo.fin}</>}.
              {" "}Al cliente no le llegó nada.</>
          ) : (
            // El motivo viene del servidor con su código delante; se enseña entero
            // porque cada uno se arregla en otro sitio.
            <>No salió: {res.motivo ?? omitido ?? "sin motivo declarado"}</>
          )}
        </p>
      )}
    </div>
  );
}
