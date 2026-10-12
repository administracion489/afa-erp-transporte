// Matriz del USO DE FLOTA (lib/flota/uso-flota.ts, motor PURO). NO toca la base: datos sintéticos.
// Uso:  npx tsx scripts/prueba-uso-flota.mts   (sale con código 1 si algo falla)
//
// LO QUE FIJA, y lo que no se puede aflojar:
//   1. `utilizacion_flota` de ELIA, el VIEJO copiado literal: servicios_totales, tercerizados,
//      pct_tercerizado, dias_activos (y servicios, placa y orden de por_unidad) y unidades_sin_uso salen
//      IDÉNTICOS sobre cientos de conjuntos aleatorios; las mismas claves y los mismos bloques ui.
//   2. DIVERGENCIA DECLARADA en km_recorridos: con la lectura alta equivocada (el 24,484 de la CWZ-371)
//      el viejo infla y el nuevo no; sin lecturas equivocadas ni km nocturno, coinciden; y sin
//      reinicios de tablero el nuevo NUNCA da más km que el viejo.
//   3. `periodoAnterior`: mismo largo, contiguo, sin solaparse, correcto en cambios de mes, de año y en
//      el 29 de febrero.
//   4. La serie tiene el mismo número de días en los dos periodos y su suma es el total (km, servicios,
//      horas, gasto, CO₂), con `null` = sin dato que no suma.
//   5. Activas ∪ sin uso = flota de hoy, disjuntas, y ninguna inactiva en ninguna de las dos.
//   6. El odómetro SIEMPRE gana al GPS; `esPiso ⟺` alguna jornada con servicio no salió del odómetro;
//      cada fuente del GPS (gps, gps_parcial, sin_dato, tope) dice exactamente lo que tiene.
//   7. `sinHora` nunca suma horas: el total es la suma de las duraciones medidas y nada más.
//   8. Las cargas de terceros no suman ni gasto ni CO₂; la urea suma gasto y NO CO₂; galones y m³
//      nunca se suman entre sí; un GNV rotulado en galones son m³.
//   9. SENTIDO_METRICA: km, servicios, horas, gasto y CO₂ neutros; unidades sin uso subir_malo.
//  10. Corolario: una semana con actividad da km, servicios, horas, gasto y CO₂ distintos de cero
//      (un motor que devolviera ceros cumpliría todo lo de arriba de forma trivial).
//  11. La ruta: un `desde` anterior a hoy − DIAS_ATRAS_MAX_USO es 400 `rango_antiguo` sin leer nada (el
//      borde exacto pasa), y la cola de cálculos es de 6.

/* eslint-disable @typescript-eslint/no-explicit-any -- filas sintéticas con la forma de las de Supabase */
import {
  resumenUso, compararUso, periodoAnterior, diasDelPeriodo, jornadasUso, diasPorRellenarConGps, vehiculosSinServicio,
  utilizacionParaElia, jornadaOdometroValida, SENTIDO_METRICA, METRICAS_USO, MAX_TRAZAS_RELLENO, constantesUso,
  type EntradaUso, type CargaUso, type PropiaUso, type MetricaUso,
} from "../lib/flota/uso-flota";
import { sanearLecturas, recorridosDiarios, sumarDias, diasEntreFechas, type LecturaCruda } from "../lib/odometro-analitica";
import { derivarTiempos } from "../lib/servicio-tiempos";
import { contextoServicio } from "../lib/gps-cobertura";
import { tonoVariacion } from "../lib/rendimiento";
import type { KmGps } from "../lib/flota/km-gps";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
/** Un barrido: cuenta los casos y solo imprime el primero que falla. */
function barrido(nombre: string) {
  let n = 0, malos = 0, primero = "";
  return {
    ver(ok: boolean, detalle: () => string) { n++; if (!ok) { malos++; if (!primero) primero = detalle(); } },
    cerrar() { chk(`${nombre} (${n} casos)`, malos === 0 && n > 0, malos ? `${malos} fallan; el primero: ${primero}` : n ? "" : "barrido vacío"); },
  };
}
let semilla = 20261012;
const rnd = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const ent = (a: number, b: number) => a + Math.floor(rnd() * (b - a + 1));
const elegir = <T,>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)];
const cerca = (a: number | null, b: number | null, tol = 1e-6) => (a == null && b == null) || (a != null && b != null && Math.abs(a - b) <= tol * Math.max(1, Math.abs(a), Math.abs(b)));
const hh = (m: number) => `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;

// ══ El utilizacion_flota VIEJO, copiado LITERAL de lib/elia/herramientas.ts ═══════════════════════
// Lo único que cambió es de dónde salen `vehs`, `filas` y `lecturas`: antes eran tres consultas
// (vehiculos sin orden; reservas de [inicio, hoy] con `.neq("estado","cancelada")`; lecturas propias
// con fecha ≥ inicio y estado `aceptada`). Aquí llegan ya filtradas como las devolvía la base.
function utilizacionVieja(vehs: any[], filas: any[], lecturas: any[], inicio: string, hoy: string): { paraModelo: string; ui?: any[] } {
        const vehiculos = (vehs as any[]) ?? [];
        if (filas.length === 0)
          return { paraModelo: JSON.stringify({ encontrados: 0, desde: inicio, nota: "Sin servicios en el rango." }) };

        const kmPorVeh: Record<number, { min: number; max: number }> = {};
        for (const l of lecturas) {
          const k = (kmPorVeh[l.vehiculo_id] ||= { min: Number(l.km), max: Number(l.km) });
          k.min = Math.min(k.min, Number(l.km));
          k.max = Math.max(k.max, Number(l.km));
        }

        const uso: Record<number, { servicios: number; dias: Set<string> }> = {};
        let tercerizados = 0;
        for (const r of filas) {
          if (r.tipo_asignacion === "tercerizado" || r.vehiculo_tercero_id) tercerizados++;
          if (r.vehiculo_id) {
            const u = (uso[r.vehiculo_id] ||= { servicios: 0, dias: new Set() });
            u.servicios++;
            u.dias.add(r.fecha_servicio);
          }
        }
        const pctTerceros = Math.round((tercerizados / filas.length) * 100);

        const porUnidad = vehiculos
          .map((v) => ({
            placa: v.placa,
            categoria: v.categoria,
            estado: v.estado,
            servicios: uso[v.id]?.servicios || 0,
            dias_activos: uso[v.id]?.dias.size || 0,
            km_recorridos: kmPorVeh[v.id] ? Math.max(0, kmPorVeh[v.id].max - kmPorVeh[v.id].min) : null,
          }))
          .sort((a, b) => b.servicios - a.servicios);
        const ociosas = porUnidad.filter((u) => u.servicios === 0 && u.estado !== "inactivo");

        return {
          paraModelo: JSON.stringify({
            desde: inicio,
            hasta: hoy,
            servicios_totales: filas.length,
            tercerizados,
            pct_tercerizado: pctTerceros,
            por_unidad: porUnidad,
            unidades_sin_uso: ociosas.map((u) => u.placa),
          }),
          ui: [
            {
              tipo: "kpis",
              items: [
                { label: "Servicios", valor: String(filas.length), sub: `desde ${inicio}`, intent: "info" },
                { label: "Tercerizados", valor: `${pctTerceros}%`, sub: `${tercerizados} servicios`, intent: pctTerceros > 40 ? "warn" : "ok" },
                { label: "Unidades sin uso", valor: String(ociosas.length), sub: ociosas.slice(0, 3).map((u) => u.placa).join(", ") || undefined, intent: ociosas.length ? "warn" : "ok" },
              ],
            },
            {
              tipo: "ranking",
              titulo: "Unidades más utilizadas",
              items: porUnidad.slice(0, 5).map((u, i) => ({
                puesto: i + 1,
                nombre: u.placa,
                valor: `${u.servicios} serv.`,
                sub: `${u.dias_activos} días activos${u.km_recorridos ? ` · ${u.km_recorridos.toLocaleString("es-PE")} km` : ""}`,
              })),
            },
          ],
        };
}
/** Lo que devolvían las tres consultas de antes, sobre los mismos datos. */
const filasViejas = (reservas: any[], inicio: string, hoy: string) =>
  reservas.filter((r) => r.fecha_servicio >= inicio && r.fecha_servicio <= hoy && r.estado != null && r.estado !== "cancelada");
const lecturasViejas = (lecturas: LecturaCruda[], inicio: string) =>
  lecturas.filter((l) => l.vehiculo_id != null && l.fecha >= inicio && l.estado === "aceptada").map((l) => ({ vehiculo_id: l.vehiculo_id, km: l.km, fecha: l.fecha }));

// ══ Datos sintéticos ═════════════════════════════════════════════════════════════════════════════
let idLec = 1, idRes = 1, idPar = 1;
const lec = (veh: number, fecha: string, minuto: number, km: number, estado = "aceptada", momento: string | null = null): LecturaCruda => {
  const t = `${fecha}T${hh(minuto)}:00-05:00`;
  return { id: `L${idLec++}`, vehiculo_id: veh, vehiculo_tercero_id: null, km, fuente: "app_conductor", fecha, estado, created_at: t, capturado_en: t, momento };
};
const ESTADOS_VEH = ["disponible", "ocupado", "mantenimiento", "inactivo", null] as const;
const ESTADOS_RES = ["finalizada", "finalizada", "finalizada", "finalizada", "finalizada", "finalizada", "programada", "confirmada", "pendiente", "en_curso", "cancelada", "cancelada"] as const;
const TIPOS_CARGA = ["diesel", "diesel", "gnv", "gnv", "glp", "gasolina_premium", "urea", "biodiesel", "Diésel", "GNV", "xyz", null] as const;
const UNIDADES_CARGA = ["galones", "galones", "litros", "m3", null] as const;

type Datos = { propios: PropiaUso[]; reservas: any[]; lecturas: LecturaCruda[]; cargas: CargaUso[]; paradas: Map<number, any[]> };

/** Una flota de 3 a 8 unidades con servicios, odómetro (a veces con lecturas equivocadas) y cargas. */
function datosAleatorios(dDesde: string, dHasta: string, lecDesde: string, hoy: string): Datos {
  const nVeh = ent(3, 8);
  const propios: PropiaUso[] = [];
  for (let i = 0; i < nVeh; i++) {
    const id = 10 + i * ent(1, 3) + i;
    if (propios.some((p) => p.id === id)) continue;
    propios.push({ id, placa: `P${id}-${ent(100, 999)}`, estado: elegir(ESTADOS_VEH), categoria: elegir(["BUS", "VAN", "MINIBUS", null]) });
  }
  const ids = propios.map((p) => p.id);
  const reservas: any[] = [];
  const paradas = new Map<number, any[]>();
  for (const f of diasDelPeriodo(dDesde, dHasta)) {
    const k = ent(0, 5);
    for (let j = 0; j < k; j++) {
      const id = idRes++;
      const estado = elegir(ESTADOS_RES);
      const asign = rnd();
      const r: any = { id, fecha_servicio: f, hora_servicio: `${hh(ent(300, 1200))}:00`, estado, vehiculo_id: null, vehiculo_tercero_id: null, tipo_asignacion: "propio" };
      if (asign < 0.6) r.vehiculo_id = rnd() < 0.05 ? 999 : elegir(ids);
      else if (asign < 0.85) { r.vehiculo_tercero_id = ent(1, 5); r.tipo_asignacion = "tercerizado"; }
      else if (asign < 0.92) r.tipo_asignacion = "tercerizado";
      if (estado === "finalizada" && rnd() < 0.7) {
        const ini = ent(300, 1100);
        r.hora_real_inicio = `${hh(ini)}:00`;
        r.hora_real_fin = `${hh(ini + ent(30, 300))}:00`;
      } else if (estado === "en_curso") r.hora_real_inicio = `${hh(ent(300, 900))}:00`;
      // A veces paradas: completas (terminado por paradas aunque no esté finalizada) o a medias.
      if (rnd() < 0.15) {
        const n = ent(1, 3);
        const ps: any[] = [];
        const base = Date.parse(`${f}T${hh(ent(300, 900))}:00-05:00`);
        for (let o = 0; o < n; o++) {
          const comp = rnd() < 0.7;
          ps.push({ id: idPar++, reserva_id: id, orden: o + 1, nombre: `Paradero ${o + 1}`, estado: comp ? "completada" : "pendiente",
            hora_estimada: hh(360 + o * 30), hora_llegada: comp ? new Date(base + o * 25 * 60_000).toISOString() : null });
        }
        paradas.set(id, ps);
      }
      reservas.push(r);
    }
  }
  const lecturas: LecturaCruda[] = [];
  for (const p of propios) {
    let km = ent(10_000, 300_000);
    for (const f of diasDelPeriodo(lecDesde, hoy)) {
      const u = rnd();
      if (u < 0.6) {
        const ini = ent(330, 420), fin = ent(1080, 1260);
        lecturas.push(lec(p.id, f, ini, km, "aceptada", "checkin"));
        km += ent(30, 250);
        lecturas.push(lec(p.id, f, fin, km, rnd() < 0.05 ? "sospechosa" : "aceptada", "checkout"));
      } else if (u < 0.75) {
        lecturas.push(lec(p.id, f, ent(330, 1260), km, "aceptada"));
        km += ent(0, 150);
      }
      if (rnd() < 0.2) km += ent(0, 20);                                         // km de noche
      if (rnd() < 0.03) lecturas.push(lec(p.id, f, 720, km * (rnd() < 0.5 ? 10 : 1) + 5000)); // lectura alta equivocada, aceptada
      if (rnd() < 0.02) lecturas.push(lec(p.id, f, 730, km - 3000, "rechazada"));
      if (rnd() < 0.004) { km = ent(50, 500); lecturas.push(lec(p.id, f, 1300, km, "reinicio")); }
    }
  }
  const cargas: CargaUso[] = [];
  for (const f of diasDelPeriodo(dDesde, dHasta)) {
    const k = ent(0, 3);
    for (let j = 0; j < k; j++) {
      const t = rnd();
      cargas.push({
        fecha: f,
        vehiculo_id: t < 0.75 ? elegir(ids) : t < 0.8 ? elegir(ids) : null,
        vehiculo_tercero_id: t < 0.75 ? null : ent(1, 5),
        tipo_combustible: elegir(TIPOS_CARGA),
        galones: rnd() < 0.05 ? null : Math.round(rnd() * 600) / 10,
        unidad: elegir(UNIDADES_CARGA),
        total: rnd() < 0.05 ? null : Math.round(rnd() * 60000) / 100,
      });
    }
  }
  return { propios, reservas, lecturas, cargas, paradas };
}

const kmGps = (codigo: KmGps["codigo"], km: number | null): KmGps => ({ codigo, km, piso: codigo === "piso", coberturaPct: km == null ? null : 90, detalle: "" });

/** Rellena por GPS como lo haría el lector: unos con km, otros sin km publicable, otros sin medir por tope. */
function rellenoAleatorio(ids: number[]): { km: Map<number, KmGps>; tope: Set<number> } {
  const km = new Map<number, KmGps>(), tope = new Set<number>();
  for (const id of ids) {
    const u = rnd();
    if (u < 0.35) km.set(id, kmGps("medido", Math.round(rnd() * 1500) / 10 + 1));
    else if (u < 0.5) km.set(id, kmGps("piso", Math.round(rnd() * 900) / 10 + 1));
    else if (u < 0.65) km.set(id, kmGps(elegir(["sin_gps", "insuficiente", "sin_medir", "no_aplica"] as const), null));
    else if (u < 0.8) tope.add(id);
  }
  return { km, tope };
}

const entrada = (d: Datos, desde: string, hasta: string, hoy: string, extra: Partial<EntradaUso> = {}): EntradaUso => ({
  desde, hasta, hoy, ahoraMs: Date.parse(`${hoy}T20:00:00Z`),
  propios: d.propios, reservas: d.reservas, lecturas: d.lecturas, paradasPorReserva: d.paradas,
  kmGpsPorReserva: new Map(), sinMedirPorTope: new Set(), cargas: d.cargas, ...extra,
});

// ══ 1 · ELIA: el viejo copiado literal ═════════════════════════════════════════════════════════════
console.log("\n1 · utilizacion_flota de ELIA contra el viejo copiado literal");
{
  const b = barrido("servicios_totales, tercerizados, pct, días activos, orden de por_unidad, sin uso y bloques ui idénticos");
  const bKm = barrido("sin reinicios de tablero, el km nuevo nunca supera al viejo");
  const bClaves = barrido("las mismas claves en paraModelo y en cada fila de por_unidad");
  for (let caso = 0; caso < 400; caso++) {
    const inicio = "2026-08-01", hoy = "2026-09-15";
    const d = datosAleatorios(inicio, hoy, "2026-07-01", hoy);
    // Uno de cada 25 casos se queda sin servicios en el periodo: «encontrados: 0» también tiene que coincidir.
    if (caso % 25 === 0) d.reservas = d.reservas.filter((r) => r.fecha_servicio < inicio);
    const viejo = utilizacionVieja(d.propios, filasViejas(d.reservas, inicio, hoy), lecturasViejas(d.lecturas, inicio), inicio, hoy);
    const nuevo = utilizacionParaElia(entrada(d, inicio, hoy, hoy, { cargas: null, paradasPorReserva: new Map() }));
    const v = JSON.parse(viejo.paraModelo), n = JSON.parse(nuevo.paraModelo);
    const sinKm = (o: any) => ({ ...o, por_unidad: (o.por_unidad ?? []).map((u: any) => ({ ...u, km_recorridos: "·" })) });
    const uiSinKm = (ui: any[] | undefined) => JSON.stringify((ui ?? []).map((bl) => bl.tipo === "ranking"
      ? { ...bl, items: bl.items.map((it: any) => ({ ...it, sub: String(it.sub).split(" · ")[0] })) } : bl));
    b.ver(JSON.stringify(sinKm(v)) === JSON.stringify(sinKm(n)) && uiSinKm(viejo.ui) === uiSinKm(nuevo.ui),
      () => `caso ${caso}: ${JSON.stringify(sinKm(v)).slice(0, 300)} ≠ ${JSON.stringify(sinKm(n)).slice(0, 300)}`);
    bClaves.ver(JSON.stringify(Object.keys(v)) === JSON.stringify(Object.keys(n))
      && (v.por_unidad ?? []).every((u: any, i: number) => JSON.stringify(Object.keys(u)) === JSON.stringify(Object.keys(n.por_unidad[i]))),
      () => `caso ${caso}: ${Object.keys(v)} ≠ ${Object.keys(n)}`);
    const conReinicio = new Set(d.lecturas.filter((l) => l.estado === "reinicio").map((l) => l.vehiculo_id));
    for (const p of d.propios) {
      if (conReinicio.has(p.id)) continue;
      const uv = (v.por_unidad ?? []).find((u: any) => u.placa === p.placa);
      const un = (n.por_unidad ?? []).find((u: any) => u.placa === p.placa);
      if (!uv || !un || un.km_recorridos == null) continue;
      bKm.ver(uv.km_recorridos != null && un.km_recorridos <= uv.km_recorridos + 0.051, () => `caso ${caso} ${p.placa}: nuevo ${un.km_recorridos} > viejo ${uv.km_recorridos}`);
    }
  }
  b.cerrar(); bClaves.cerrar(); bKm.cerrar();
}

// ══ 2 · La divergencia declarada: la lectura alta equivocada ════════════════════════════════════════
console.log("\n2 · km_recorridos: la lectura alta equivocada (CWZ-371) ya no infla");
{
  // ~90 km por día del 01/09 al 30/09, dos lecturas por día, estacionada de noche; el 12/09 a las 17:02
  // entra ACEPTADA una lectura de 24,484 km (foto de otra unidad).
  const veh = 371;
  const propios: PropiaUso[] = [{ id: veh, placa: "CWZ-371", estado: "disponible", categoria: "VAN" }];
  const construir = (conEquivocada: boolean) => {
    const lecturas: LecturaCruda[] = [];
    let km = 19_000;
    for (const f of diasDelPeriodo("2026-08-20", "2026-09-30")) {
      lecturas.push(lec(veh, f, 360, km, "aceptada", "checkin"));
      km += 90;
      lecturas.push(lec(veh, f, 1140, km, "aceptada", "checkout"));
      if (conEquivocada && f === "2026-09-12") lecturas.push(lec(veh, f, 1022, 24_484));
    }
    const reservas = diasDelPeriodo("2026-09-01", "2026-09-30").map((f) => ({ id: idRes++, fecha_servicio: f, hora_servicio: "06:00:00", estado: "finalizada", vehiculo_id: veh, vehiculo_tercero_id: null, tipo_asignacion: "propio" }));
    return { propios, reservas, lecturas, cargas: [] as CargaUso[], paradas: new Map<number, any[]>() };
  };
  const inicio = "2026-09-01", hoy = "2026-09-30";
  const kmDe = (r: { paraModelo: string }) => JSON.parse(r.paraModelo).por_unidad[0].km_recorridos;
  const malo = construir(true), bueno = construir(false);
  const viejoMalo = kmDe(utilizacionVieja(malo.propios, filasViejas(malo.reservas, inicio, hoy), lecturasViejas(malo.lecturas, inicio), inicio, hoy));
  const nuevoMalo = kmDe(utilizacionParaElia(entrada(malo, inicio, hoy, hoy)));
  const viejoBueno = kmDe(utilizacionVieja(bueno.propios, filasViejas(bueno.reservas, inicio, hoy), lecturasViejas(bueno.lecturas, inicio), inicio, hoy));
  const nuevoBueno = kmDe(utilizacionParaElia(entrada(bueno, inicio, hoy, hoy)));
  // El 01/09 la unidad arranca con 19,000 + 12 días × 90 = 20,080 km.
  chk("el VIEJO reproduce el defecto: 24,484 − 20,080 = 4,404 km", viejoMalo === 4404, `viejo ${viejoMalo}`);
  chk("el nuevo da los 30 días × 90 km = 2,700 km aunque la lectura equivocada esté aceptada", nuevoMalo === 2700, `nuevo ${nuevoMalo}`);
  chk("sin la lectura equivocada (y sin km de noche) los dos coinciden", viejoBueno === 2700 && nuevoBueno === 2700, `viejo ${viejoBueno} · nuevo ${nuevoBueno}`);
  const r = resumenUso(entrada(malo, "2026-09-08", "2026-09-14", "2026-09-30"));
  chk("en el resumen semanal la jornada del 12/09 vale 90 km y la semana 630, todo por odómetro",
    r.km.total === 630 && r.km.odometro === 630 && !r.km.esPiso && jornadasUso(entrada(malo, "2026-09-12", "2026-09-12", "2026-09-30"))[0]?.km === 90,
    `total ${r.km.total} · piso ${r.km.esPiso}`);
  // Un salto imposible dentro de la jornada (la equivocada es la ÚLTIMA lectura, sin posteriores que la delaten):
  // esa jornada no cuenta como odómetro.
  const ultima = construir(false);
  ultima.lecturas.push(lec(veh, "2026-09-30", 1200, 24_484));
  const j30 = jornadasUso(entrada(ultima, "2026-09-30", "2026-09-30", "2026-09-30"))[0];
  chk("una jornada con un salto imposible no se publica como odómetro (cae al GPS / sin dato)", j30?.fuente === "sin_dato" && j30.km == null, JSON.stringify(j30));
}

// ══ 3 · periodoAnterior ═════════════════════════════════════════════════════════════════════════════
console.log("\n3 · periodoAnterior: mismo largo, contiguo, cruces de mes y de año");
{
  const casos: [string, string, string, string][] = [
    ["2026-10-06", "2026-10-12", "2026-09-29", "2026-10-05"],
    ["2026-01-01", "2026-01-07", "2025-12-25", "2025-12-31"],
    ["2026-03-01", "2026-03-31", "2026-01-29", "2026-02-28"],
    ["2028-03-01", "2028-03-07", "2028-02-23", "2028-02-29"],
    ["2026-01-01", "2026-01-01", "2025-12-31", "2025-12-31"],
    ["2026-12-27", "2027-01-02", "2026-12-20", "2026-12-26"],
  ];
  for (const [d, h, ed, eh] of casos) {
    const p = periodoAnterior(d, h);
    chk(`${d}…${h} → ${ed}…${eh}`, p.desde === ed && p.hasta === eh, `${p.desde}…${p.hasta}`);
  }
  const b = barrido("todo inicio de 2025 a 2028 × largos de 1 a 31: mismo largo, contiguo, sin solaparse");
  for (let f = "2025-01-01"; f <= "2028-12-31"; f = sumarDias(f, 1)) {
    for (let n = 1; n <= 31; n++) {
      const h = sumarDias(f, n - 1);
      const p = periodoAnterior(f, h);
      const ok = diasEntreFechas(p.desde, p.hasta) + 1 === n && sumarDias(p.hasta, 1) === f && p.hasta < f
        && diasDelPeriodo(p.desde, p.hasta).length === diasDelPeriodo(f, h).length;
      b.ver(ok, () => `${f}+${n}: ${p.desde}…${p.hasta}`);
    }
  }
  b.cerrar();
}

// ══ 4-8 · Invariantes por barrido ════════════════════════════════════════════════════════════════
console.log("\n4-8 · invariantes sobre conjuntos aleatorios (dos periodos contiguos)");
{
  const bSerie = barrido("la serie tiene los días del periodo, la misma cantidad en los dos, y suma el total");
  const bParticion = barrido("prestados + en curso + sin cerrar + programados = no cancelados");
  const bFlota = barrido("activas ∪ sin uso = flota de hoy, disjuntas, sin inactivas");
  const bCobertura = barrido("odómetro + GPS + sin dato + tope = jornadas con servicio; total = odómetro + GPS");
  const bOdo = barrido("el odómetro gana al GPS: toda jornada válida del odómetro sale como odómetro con su km");
  const bOdoGps = barrido("dar km por GPS a TODOS los servicios no mueve ningún km del odómetro");
  const bPiso = barrido("esPiso ⟺ alguna jornada con servicio no salió del odómetro");
  const bFuentes = barrido("cada fuente del GPS dice exactamente lo que tiene");
  const bRelleno = barrido("diasPorRellenarConGps = exactamente los servicios que pudieron correr sin jornada de odómetro");
  const bHoras = barrido("horas = suma de las duraciones medidas; sinHora = terminados sin duración (no suman)");
  const bTerceros = barrido("quitar las cargas de terceros no cambia nada");
  const bUrea = barrido("quitar la urea no cambia el CO₂ y baja el gasto exactamente en su importe");
  const bCo2 = barrido("con CO₂ + sin factor + sin cantidad = cargas; aditivo ⊆ sin factor");
  const bFamilias = barrido("cada familia una sola vez y en su unidad canónica (galones y m³ nunca juntos)");
  const bSinUso = barrido("vehiculosSinServicio = los sin uso del resumen, en el mismo orden");
  const bTope = barrido("ninguna jornada `tope` sin un servicio sin medir por el tope");
  const bUnidades = barrido("las filas por unidad suman los totales (km, gasto, CO₂; servicios y horas de los que tienen unidad propia)");

  const CANON: Record<string, string> = { diesel: "galones", gasolina: "galones", glp: "galones", gnv: "m3", urea: "litros", biodiesel: "galones" };
  for (let caso = 0; caso < 250; caso++) {
    const hoy = "2026-09-14";
    const d = datosAleatorios("2026-08-28", "2026-09-16", "2026-08-01", hoy);
    const eA0 = entrada(d, "2026-09-08", "2026-09-14", hoy);
    const eP0 = entrada(d, "2026-09-01", "2026-09-07", hoy);
    const cand = [...new Set([...diasPorRellenarConGps(eA0), ...diasPorRellenarConGps(eP0)])];
    const { km, tope } = rellenoAleatorio(cand);
    const eA = { ...eA0, kmGpsPorReserva: km, sinMedirPorTope: tope };
    const eP = { ...eP0, kmGpsPorReserva: km, sinMedirPorTope: tope };
    for (const [nombre, e] of [["actual", eA], ["anterior", eP]] as const) {
      const r = resumenUso(e);
      const dias = diasDelPeriodo(e.desde, e.hasta);
      const suma = (k: "km" | "servicios" | "horas" | "gasto" | "co2") => r.serie.reduce((s, x) => s + ((x as any)[k] ?? 0), 0);
      bSerie.ver(r.serie.length === dias.length && r.serie.every((x, i) => x.fecha === dias[i])
        && cerca(suma("km"), r.km.total ?? 0) && suma("servicios") === r.servicios.noCancelados
        && cerca(suma("horas"), r.horas.total ?? 0) && cerca(suma("gasto"), r.combustible.gasto ?? 0) && cerca(suma("co2"), r.combustible.co2Kg ?? 0),
      () => `caso ${caso} ${nombre}: km ${suma("km")}/${r.km.total} · horas ${suma("horas")}/${r.horas.total} · gasto ${suma("gasto")}/${r.combustible.gasto} · co2 ${suma("co2")}/${r.combustible.co2Kg}`);

      const s = r.servicios;
      bParticion.ver(s.prestados + s.enCurso + s.sinCerrar + s.programados === s.noCancelados
        && s.noCancelados === d.reservas.filter((x) => x.estado !== "cancelada" && x.fecha_servicio >= e.desde && x.fecha_servicio <= e.hasta).length,
      () => `caso ${caso} ${nombre}: ${JSON.stringify(s)}`);

      const flota = d.propios.filter((p) => p.estado !== "inactivo").map((p) => p.id);
      const activas = new Set(r.unidades.activasIds), sinUso = new Set(r.unidades.sinUso.map((x) => x.vehiculoId));
      const union = new Set([...activas, ...sinUso]);
      const inactivas = new Set(d.propios.filter((p) => p.estado === "inactivo").map((p) => p.id));
      bFlota.ver([...activas].every((x) => !sinUso.has(x)) && union.size === flota.length && flota.every((x) => union.has(x))
        && [...union].every((x) => !inactivas.has(x)) && r.unidades.flota === flota.length && r.unidades.activas === activas.size,
      () => `caso ${caso} ${nombre}: activas ${[...activas]} · sin uso ${[...sinUso]} · flota ${flota}`);

      const c = r.km.cobertura;
      bCobertura.ver(c.conOdometro + c.conGps + c.sinDato + c.tope === c.jornadasConServicio
        && (r.km.total == null || cerca(r.km.total, r.km.odometro + r.km.gps)),
      () => `caso ${caso} ${nombre}: ${JSON.stringify(r.km)}`);

      // El odómetro, calculado aparte con el mismo saneo.
      const js = jornadasUso(e);
      const odo = new Map<string, number>();
      for (const p of new Set(d.lecturas.map((l) => Number(l.vehiculo_id)))) {
        const { limpias } = sanearLecturas(d.lecturas.filter((l) => l.vehiculo_id === p));
        for (const dr of recorridosDiarios(limpias)) if (jornadaOdometroValida(dr) && dr.fecha >= e.desde && dr.fecha <= e.hasta) odo.set(`${p}|${dr.fecha}`, dr.recorrido!);
      }
      const porClave = new Map(js.map((j) => [`${j.vehiculoId}|${j.fecha}`, j]));
      bOdo.ver([...odo].every(([k, v]) => porClave.get(k)?.fuente === "odometro" && porClave.get(k)?.km === v)
        && js.every((j) => j.fuente !== "odometro" || odo.get(`${j.vehiculoId}|${j.fecha}`) === j.km),
      () => `caso ${caso} ${nombre}: ${[...odo].find(([k, v]) => porClave.get(k)?.km !== v)}`);

      const todo = new Map<number, KmGps>(e.reservas.map((x: any) => [x.id, kmGps("medido", 777)]));
      const rTodo = resumenUso({ ...e, kmGpsPorReserva: todo, sinMedirPorTope: new Set() });
      bOdoGps.ver(rTodo.km.odometro === r.km.odometro && rTodo.km.cobertura.conOdometro === c.conOdometro,
        () => `caso ${caso} ${nombre}: odómetro ${r.km.odometro} → ${rTodo.km.odometro}`);

      bPiso.ver(r.km.esPiso === js.some((j) => j.conServicio && j.fuente !== "odometro"), () => `caso ${caso} ${nombre}`);

      bFuentes.ver(js.every((j) => {
        if (j.fuente === "odometro") return j.km != null;
        const pub = j.reservas.filter((id) => e.kmGpsPorReserva.get(id)?.km != null);
        const top = j.reservas.filter((id) => e.sinMedirPorTope?.has(id));
        const suma = pub.reduce((s, id) => s + (e.kmGpsPorReserva.get(id)!.km as number), 0);
        if (!j.conServicio || j.reservas.length === 0) return false;
        if (j.fuente === "tope") return top.length > 0 && (pub.length ? cerca(j.km, suma) : j.km == null);
        if (j.fuente === "sin_dato") return pub.length === 0 && top.length === 0 && j.km == null;
        if (j.fuente === "gps") return pub.length === j.reservas.length && cerca(j.km, suma);
        return pub.length > 0 && pub.length < j.reservas.length && top.length === 0 && cerca(j.km, suma);
      }), () => `caso ${caso} ${nombre}`);

      const vehOdo = (x: any) => x.vehiculo_id != null && odo.has(`${x.vehiculo_id}|${x.fecha_servicio}`);
      const esperados = e.reservas.filter((x: any) => x.estado !== "cancelada" && x.fecha_servicio >= e.desde && x.fecha_servicio <= e.hasta
        && x.vehiculo_id != null && !vehOdo(x) && !(x.fecha_servicio >= hoy && x.estado !== "finalizada" && !(x.estado === "en_curso" && x.fecha_servicio === hoy)))
        .map((x: any) => x.id).sort((a: number, b: number) => a - b);
      bRelleno.ver(JSON.stringify([...diasPorRellenarConGps(e)].sort((a, b) => a - b)) === JSON.stringify(esperados), () => `caso ${caso} ${nombre}`);

      let minutos = 0, conH = 0, sinH = 0, minutosConVeh = 0;
      for (const x of e.reservas) {
        if (x.estado === "cancelada" || x.fecha_servicio < e.desde || x.fecha_servicio > e.hasta) continue;
        const ps = d.paradas.get(x.id) ?? [];
        const t = derivarTiempos({ reserva: x, paradas: ps, ahoraMs: e.ahoraMs, hoy });
        if (t.duracionMin != null) { minutos += t.duracionMin; conH++; if (x.vehiculo_id != null) minutosConVeh += t.duracionMin; }
        else if (contextoServicio(x, ps, { hoy, ahoraMs: e.ahoraMs }).terminado) sinH++;
      }
      bHoras.ver(r.horas.totalMin === minutos && r.horas.conHora === conH && r.horas.sinHora === sinH
        && (r.horas.total == null ? conH === 0 && sinH > 0 : cerca(r.horas.total, minutos / 60)),
      () => `caso ${caso} ${nombre}: ${JSON.stringify(r.horas)} vs ${minutos} min · ${conH} · ${sinH}`);

      const soloPropias = { ...e, cargas: d.cargas.filter((x) => x.vehiculo_id != null && x.vehiculo_tercero_id == null) };
      const rP = resumenUso(soloPropias);
      bTerceros.ver(JSON.stringify(rP.combustible) === JSON.stringify(r.combustible) && JSON.stringify(rP.serie) === JSON.stringify(r.serie),
        () => `caso ${caso} ${nombre}`);

      const esUrea = (x: CargaUso) => String(x.tipo_combustible ?? "").toLowerCase() === "urea";
      const sinUrea = resumenUso({ ...e, cargas: d.cargas.filter((x) => !esUrea(x)) });
      const gastoUrea = d.cargas.filter((x) => esUrea(x) && x.vehiculo_id != null && x.vehiculo_tercero_id == null && x.fecha >= e.desde && x.fecha <= e.hasta && x.total != null)
        .reduce((s2, x) => s2 + (x.total as number), 0);
      bUrea.ver(cerca(sinUrea.combustible.co2Kg, r.combustible.co2Kg) && cerca((sinUrea.combustible.gasto ?? 0) + gastoUrea, r.combustible.gasto ?? 0),
        () => `caso ${caso} ${nombre}: co2 ${r.combustible.co2Kg} vs ${sinUrea.combustible.co2Kg}`);

      const cb = r.combustible;
      bCo2.ver(cb.cargasConCo2 + cb.cargasSinFactor + cb.cargasSinCantidad === cb.cargas && cb.cargasAditivo <= cb.cargasSinFactor,
        () => `caso ${caso} ${nombre}: ${JSON.stringify(cb)}`);
      bFamilias.ver(new Set(cb.porFamilia.map((f) => f.familia)).size === cb.porFamilia.length && cb.porFamilia.every((f) => CANON[f.familia] === f.unidad),
        () => `caso ${caso} ${nombre}: ${JSON.stringify(cb.porFamilia)}`);

      bSinUso.ver(JSON.stringify(vehiculosSinServicio(e)) === JSON.stringify(r.unidades.sinUso.map((x) => x.vehiculoId)), () => `caso ${caso} ${nombre}`);
      bTope.ver(js.every((j) => j.fuente !== "tope" || j.reservas.some((id) => tope.has(id))), () => `caso ${caso} ${nombre}`);

      const sumaU = (f: (u: (typeof r.porUnidad)[number]) => number | null) => r.porUnidad.reduce((acc, u) => acc + (f(u) ?? 0), 0);
      const conVeh = e.reservas.filter((x: any) => x.estado !== "cancelada" && x.fecha_servicio >= e.desde && x.fecha_servicio <= e.hasta && x.vehiculo_id != null).length;
      bUnidades.ver(cerca(sumaU((u) => u.km), r.km.total ?? 0) && sumaU((u) => u.servicios) === conVeh
        && cerca(sumaU((u) => u.horas), minutosConVeh / 60) && cerca(sumaU((u) => u.gasto), r.combustible.gasto ?? 0)
        && (r.combustible.co2Kg == null || cerca(sumaU((u) => u.co2Kg), r.combustible.co2Kg))
        && new Set(r.porUnidad.map((u) => u.vehiculoId)).size === r.porUnidad.length,
      () => `caso ${caso} ${nombre}: km ${sumaU((u) => u.km)}/${r.km.total} · serv ${sumaU((u) => u.servicios)}/${conVeh} · gasto ${sumaU((u) => u.gasto)}/${r.combustible.gasto}`);
    }
    const rA = resumenUso(eA), rP = resumenUso(eP);
    bSerie.ver(rA.serie.length === rP.serie.length, () => `caso ${caso}: ${rA.serie.length} ≠ ${rP.serie.length}`);
  }
  for (const b of [bSerie, bParticion, bFlota, bCobertura, bOdo, bOdoGps, bPiso, bFuentes, bRelleno, bHoras, bTerceros, bUrea, bCo2, bFamilias, bSinUso, bTope, bUnidades]) b.cerrar();
}

// ══ 6 · Las fuentes del km, una por una ═══════════════════════════════════════════════════════════
console.log("\n6 · fuentes del km por unidad y día");
{
  const hoy = "2026-09-14";
  const propios: PropiaUso[] = [{ id: 1, placa: "AAA-111", estado: "disponible", categoria: "BUS" }];
  const r = (id: number, fecha: string, estado = "finalizada") => ({ id, fecha_servicio: fecha, hora_servicio: "06:00:00", estado, vehiculo_id: 1, vehiculo_tercero_id: null, tipo_asignacion: "propio" });
  const reservas = [r(101, "2026-09-10"), r(102, "2026-09-10"), r(103, "2026-09-11"), r(104, "2026-09-11"), r(105, "2026-09-12"), r(106, "2026-09-13"), r(107, "2026-09-09"), r(108, "2026-09-14", "programada")];
  const lecturas = [lec(1, "2026-09-09", 360, 5000, "aceptada", "checkin"), lec(1, "2026-09-09", 1140, 5180, "aceptada", "checkout")];
  const e: EntradaUso = {
    desde: "2026-09-08", hasta: "2026-09-14", hoy, ahoraMs: Date.parse("2026-09-14T15:00:00Z"),
    propios, reservas, lecturas, paradasPorReserva: new Map(), cargas: [],
    kmGpsPorReserva: new Map([[101, kmGps("medido", 40)], [102, kmGps("piso", 30)], [103, kmGps("medido", 25)], [104, kmGps("sin_gps", null)], [106, kmGps("insuficiente", null)], [107, kmGps("medido", 999)]]),
    sinMedirPorTope: new Set([105]),
  };
  const js = new Map(jornadasUso(e).map((j) => [j.fecha, j]));
  chk("09/09: jornada de odómetro → odómetro (180 km), aunque su servicio tenga 999 km por GPS", js.get("2026-09-09")?.fuente === "odometro" && js.get("2026-09-09")?.km === 180);
  chk("10/09: los dos servicios con km → gps (70 km)", js.get("2026-09-10")?.fuente === "gps" && js.get("2026-09-10")?.km === 70);
  chk("11/09: uno con km y otro sin GPS → gps_parcial (25 km)", js.get("2026-09-11")?.fuente === "gps_parcial" && js.get("2026-09-11")?.km === 25);
  chk("12/09: sin medir por el tope → tope (sin km)", js.get("2026-09-12")?.fuente === "tope" && js.get("2026-09-12")?.km == null);
  chk("13/09: rastreo insuficiente → sin_dato (sin km, nunca 0)", js.get("2026-09-13")?.fuente === "sin_dato" && js.get("2026-09-13")?.km == null);
  chk("14/09: el servicio de hoy que aún no empieza no abre jornada", !js.has("2026-09-14"));
  const res = resumenUso(e);
  chk("el total es 180 + 70 + 25 = 275, marcado «≥»", res.km.total === 275 && res.km.esPiso && res.km.odometro === 180 && res.km.gps === 95, JSON.stringify(res.km));
  chk("la cobertura cuenta 1 odómetro, 2 GPS, 1 sin dato, 1 tope de 5 jornadas con servicio",
    JSON.stringify(res.km.cobertura) === JSON.stringify({ jornadasConServicio: 5, conOdometro: 1, conGps: 2, sinDato: 1, tope: 1, pct: 20 }), JSON.stringify(res.km.cobertura));
  const serie = new Map(res.serie.map((x) => [x.fecha, x]));
  chk("en la serie, un día sin dato va en null (no 0) y un día sin nada va en 0",
    serie.get("2026-09-13")?.km === null && serie.get("2026-09-12")?.km === null && serie.get("2026-09-08")?.km === 0 && serie.get("2026-09-14")?.km === 0);
  chk("el día con km por GPS es un piso; el del odómetro no", serie.get("2026-09-10")?.kmPiso === true && serie.get("2026-09-09")?.kmPiso === false);
  chk(`MAX_TRAZAS_RELLENO es ${MAX_TRAZAS_RELLENO} y se declara operativo`, MAX_TRAZAS_RELLENO === 40 && constantesUso().find((c) => c.clave === "MAX_TRAZAS_RELLENO")?.procedencia === "operativo");
  chk("el relleno pide los servicios sin jornada de odómetro, los más recientes primero, y no el de hoy sin empezar",
    JSON.stringify(diasPorRellenarConGps(e)) === JSON.stringify([106, 105, 103, 104, 101, 102]), JSON.stringify(diasPorRellenarConGps(e)));
}

// ══ 7 · Horas: lo no registrado no suma ════════════════════════════════════════════════════════════
console.log("\n7 · horas en servicio");
{
  const hoy = "2026-09-14";
  const base = { vehiculo_id: 1, vehiculo_tercero_id: null, tipo_asignacion: "propio", hora_servicio: "06:00:00" };
  const reservas = [
    { ...base, id: 1, fecha_servicio: "2026-09-10", estado: "finalizada", hora_real_inicio: "06:05:00", hora_real_fin: "08:35:00" },
    { ...base, id: 2, fecha_servicio: "2026-09-10", estado: "finalizada" },
    { ...base, id: 3, fecha_servicio: "2026-09-11", estado: "finalizada" },
    { ...base, id: 4, fecha_servicio: "2026-09-12", estado: "programada" },
    { ...base, id: 5, fecha_servicio: hoy, estado: "en_curso", hora_real_inicio: "06:05:00" },
  ];
  const e: EntradaUso = {
    desde: "2026-09-08", hasta: hoy, hoy, ahoraMs: Date.parse("2026-09-14T20:00:00Z"),
    propios: [{ id: 1, placa: "AAA-111", estado: "disponible", categoria: null }], reservas, lecturas: [], paradasPorReserva: new Map(),
    kmGpsPorReserva: new Map(), cargas: [],
  };
  const r = resumenUso(e);
  chk("2 h 30 de un servicio con inicio y fin; los dos terminados sin hora cuentan aparte y no suman",
    r.horas.totalMin === 150 && r.horas.conHora === 1 && r.horas.sinHora === 2 && r.horas.total === 2.5, JSON.stringify(r.horas));
  const serie = new Map(r.serie.map((x) => [x.fecha, x]));
  chk("el 11/09 (solo un terminado sin hora) va en null, no en 0; el 12/09 (programada que no se cerró) en 0",
    serie.get("2026-09-11")?.horas === null && serie.get("2026-09-12")?.horas === 0 && serie.get("2026-09-10")?.horas === 2.5);
  const soloSin = resumenUso({ ...e, reservas: [reservas[1], reservas[2]] });
  chk("sin ningún servicio con hora, el total es null (sin dato), no 0", soloSin.horas.total === null && soloSin.horas.sinHora === 2);
  chk("el servicio en curso y el programado no son «sin hora»", r.servicios.enCurso === 1 && r.servicios.sinCerrar === 1);
}

// ══ 8 · Combustible y CO₂ de lo comprado ═══════════════════════════════════════════════════════════
console.log("\n8 · combustible: gasto y CO₂ de lo comprado");
{
  const hoy = "2026-09-14";
  const c = (fecha: string, tipo: string | null, galones: number | null, unidad: string | null, total: number | null, veh: number | null = 1, ter: number | null = null): CargaUso =>
    ({ fecha, vehiculo_id: veh, vehiculo_tercero_id: ter, tipo_combustible: tipo, galones, unidad, total });
  const e = (cargas: CargaUso[] | null): EntradaUso => ({
    desde: "2026-09-08", hasta: hoy, hoy, ahoraMs: Date.parse("2026-09-14T20:00:00Z"),
    propios: [{ id: 1, placa: "AAA-111", estado: "disponible", categoria: null }], reservas: [], lecturas: [], paradasPorReserva: new Map(),
    kmGpsPorReserva: new Map(), cargas,
  });
  const GNV = 0.05444 * 35.3147;
  const base = [c("2026-09-08", "diesel", 10, "galones", 250)];
  const r0 = resumenUso(e(base)).combustible;
  chk("10 gal de diésel = 102.1 kg de CO₂ y S/ 250", cerca(r0.co2Kg, 102.1) && r0.gasto === 250);
  const r1 = resumenUso(e([...base, c("2026-09-08", "diesel", 10, "galones", 250, null, 7), c("2026-09-08", "diesel", 10, "galones", 250, 1, 7)])).combustible;
  chk("una carga de tercero (o de dos flotas a la vez) no suma gasto ni CO₂", cerca(r1.co2Kg, 102.1) && r1.gasto === 250 && r1.cargas === 1);
  const r2 = resumenUso(e([...base, c("2026-09-09", "urea", 20, "litros", 110)])).combustible;
  chk("la urea suma gasto y NO CO₂, y se cuenta como sin factor (aditivo)", cerca(r2.co2Kg, 102.1) && r2.gasto === 360 && r2.cargasSinFactor === 1 && r2.cargasAditivo === 1);
  const r3 = resumenUso(e([...base, c("2026-09-09", "gnv", 30, "m3", 60), c("2026-09-09", "GNV", 30, "galones", 60)])).combustible;
  chk("un GNV rotulado en galones son m³ (el defecto viejo del Radar)", cerca(r3.co2Kg, 102.1 + 60 * GNV) && r3.porFamilia.find((f) => f.familia === "gnv")?.cantidad === 60);
  chk("galones y m³ nunca se suman: diésel 10 gal y GNV 60 m³ en filas aparte",
    r3.porFamilia.length === 2 && r3.porFamilia.find((f) => f.familia === "diesel")?.cantidad === 10 && r3.porFamilia.find((f) => f.familia === "gnv")?.unidad === "m3");
  const r4 = resumenUso(e([c("2026-09-10", "diesel", 37.85, "litros", 250)])).combustible;
  chk("37.85 litros de diésel son 10 galones (102.1 kg)", cerca(r4.co2Kg, 102.1) && cerca(r4.porFamilia[0].cantidad, 10));
  const r5 = resumenUso(e([c("2026-09-10", "biodiesel", 10, "galones", 200), c("2026-09-10", "xyz", 10, "galones", 100), c("2026-09-10", null, 5, null, 50)]));
  chk("biodiésel, tipo desconocido y sin tipo: suman gasto, no CO₂, y el día sale «sin dato» (no 0)",
    r5.combustible.gasto === 350 && r5.combustible.co2Kg === null && r5.combustible.cargasSinFactor === 3 && r5.combustible.sinFamilia.cargas === 2
    && r5.serie.find((x) => x.fecha === "2026-09-10")?.co2 === null && r5.serie.find((x) => x.fecha === "2026-09-11")?.co2 === 0);
  const r6 = resumenUso(e([c("2026-09-10", "urea", 20, "litros", 110)]));
  chk("un día con solo urea tiene CO₂ 0 (no se quema), no «sin dato»", r6.serie.find((x) => x.fecha === "2026-09-10")?.co2 === 0 && r6.combustible.co2Kg === 0);
  const r7 = resumenUso(e([c("2026-09-10", "diesel", 10, "m3", 250)])).combustible;
  chk("un diésel en m³ no se convierte: sin cantidad, sin CO₂", r7.cargasSinCantidad === 1 && r7.co2Kg === null && r7.gasto === 250);
  const r8 = resumenUso(e(null));
  chk("cargas que no se pudieron leer: gasto y CO₂ null, la serie también — nunca 0",
    !r8.combustible.leido && r8.combustible.gasto === null && r8.combustible.co2Kg === null && r8.serie.every((x) => x.gasto === null && x.co2 === null));
  const r9 = resumenUso(e([c("2026-09-10", "diesel", 10, "galones", null)]));
  chk("una carga sin importe no suma gasto y su día va en null", r9.combustible.gasto === null && r9.combustible.cargasSinImporte === 1 && r9.serie.find((x) => x.fecha === "2026-09-10")?.gasto === null);
}

// ══ 9 · El sentido de cada métrica y la comparación ═══════════════════════════════════════════════
console.log("\n9 · SENTIDO_METRICA y compararUso");
{
  const neutras: MetricaUso[] = ["km", "servicios", "horas", "unidadesActivas", "gastoCombustible", "co2", "pctTercerizado"];
  chk("km, servicios, horas, unidades activas, gasto, CO₂ y % tercerizado son neutros", neutras.every((m) => SENTIDO_METRICA[m] === "neutro"));
  chk("más unidades sin uso es malo (es la única métrica que alarma; las activas no repiten el rojo)",
    SENTIDO_METRICA.unidadesSinUso === "subir_malo");
  chk("todas las métricas tienen sentido", METRICAS_USO.every((m) => SENTIDO_METRICA[m] != null) && Object.keys(SENTIDO_METRICA).length === METRICAS_USO.length);

  const hoy = "2026-09-14";
  const veh = (id: number, estado = "disponible"): PropiaUso => ({ id, placa: `V${id}`, estado, categoria: null });
  const res = (id: number, fecha: string, v: number | null, ter = false) => ({ id, fecha_servicio: fecha, hora_servicio: "06:00:00", estado: "finalizada", vehiculo_id: v, vehiculo_tercero_id: ter ? 9 : null, tipo_asignacion: ter ? "tercerizado" : "propio" });
  const propios = [veh(1), veh(2), veh(3)];
  const lecturas: LecturaCruda[] = [];
  for (const f of diasDelPeriodo("2026-09-01", "2026-09-14")) {
    lecturas.push(lec(1, f, 360, 1000 + diasEntreFechas("2026-09-01", f) * 100), lec(1, f, 1140, 1000 + diasEntreFechas("2026-09-01", f) * 100 + 80));
  }
  const reservas = [
    ...diasDelPeriodo("2026-09-01", "2026-09-07").map((f, i) => res(1000 + i, f, 1)),
    ...diasDelPeriodo("2026-09-08", "2026-09-14").map((f, i) => res(2000 + i, f, 1)),
    ...diasDelPeriodo("2026-09-08", "2026-09-14").map((f, i) => res(3000 + i, f, 2)),
    res(4000, "2026-09-09", null, true),
  ];
  const mk = (desde: string, hasta: string): EntradaUso => ({ desde, hasta, hoy, ahoraMs: Date.parse("2026-09-15T01:00:00Z"), propios, reservas, lecturas,
    paradasPorReserva: new Map(), kmGpsPorReserva: new Map([[3000, kmGps("medido", 50)]]), cargas: [] });
  const a = resumenUso(mk("2026-09-08", "2026-09-14")), p = resumenUso(mk("2026-09-01", "2026-09-07"));
  const cmp = compararUso(a, p);
  chk("servicios suben de 7 a 15 (+114 %) y el tono es neutro", cmp.variaciones.servicios.actual === 15 && cmp.variaciones.servicios.previa === 7 && cmp.variaciones.servicios.tono === "neutro");
  chk("unidades sin uso bajan de 2 a 1: tono bueno; activas suben de 1 a 2: tono neutro",
    cmp.variaciones.unidadesSinUso.tono === "bueno" && cmp.variaciones.unidadesActivas.tono === "neutro");
  chk("el tono sale de tonoVariacion con el sentido declarado", METRICAS_USO.every((m) => cmp.variaciones[m].tono === tonoVariacion(cmp.variaciones[m].pct, SENTIDO_METRICA[m])));
  chk("la cobertura del odómetro pasó de 100 % a 50 %: se avisa", cmp.avisos.some((x) => x.codigo === "cobertura_odometro_cambio") && cmp.motivo != null, cmp.motivo ?? "");
  chk("el km es un piso en el periodo actual: se avisa y la variación lo marca", cmp.variaciones.km.piso && cmp.avisos.some((x) => x.codigo === "km_es_piso"));
  chk("el % tercerizado se compara en puntos (diferencia) y en variación", cerca(cmp.variaciones.pctTercerizado.diferencia, (1 / 15) * 100) && cmp.variaciones.pctTercerizado.pct === null);
  const vacio = resumenUso({ ...mk("2026-08-01", "2026-08-07"), lecturas: [] });
  const cmpV = compararUso(a, vacio);
  chk("sin ninguna actividad en el periodo anterior no es comparable y se dice por qué", !cmpV.comparable && cmpV.avisos[0]?.codigo === "sin_actividad_previa" && cmpV.variaciones.servicios.pct === null);
  const sinLeer = compararUso(a, resumenUso({ ...mk("2026-09-01", "2026-09-07"), cargas: null }));
  chk("cargas no leídas en un periodo: aviso y variación del gasto sin dato", sinLeer.avisos.some((x) => x.codigo === "combustible_no_leido") && sinLeer.variaciones.gastoCombustible.pct === null);
}

// ══ 10 · Unidades sin uso ═════════════════════════════════════════════════════════════════════════
console.log("\n10 · unidades sin uso");
{
  const hoy = "2026-09-14";
  const propios: PropiaUso[] = [
    { id: 1, placa: "A", estado: "disponible", categoria: null },
    { id: 2, placa: "B", estado: "mantenimiento", categoria: null },
    { id: 3, placa: "C", estado: "inactivo", categoria: null },
    { id: 4, placa: "D", estado: null, categoria: null },
  ];
  const e: EntradaUso = {
    desde: "2026-09-08", hasta: hoy, hoy, ahoraMs: 0, propios, lecturas: [], paradasPorReserva: new Map(), kmGpsPorReserva: new Map(), cargas: [],
    reservas: [{ id: 1, fecha_servicio: "2026-09-09", estado: "finalizada", vehiculo_id: 1 }, { id: 2, fecha_servicio: "2026-09-09", estado: "cancelada", vehiculo_id: 4 }],
    ultimoServicio: new Map([[2, "2026-08-30"]]),
  };
  const r = resumenUso(e);
  const s = new Map(r.unidades.sinUso.map((x) => [x.placa, x]));
  chk("la inactiva no es «sin uso» y la cancelada no cuenta como uso", !s.has("C") && s.has("D") && r.unidades.flota === 3 && r.unidades.activas === 1);
  chk("en mantenimiento según la ficha → en_mantenimiento, con su último servicio", s.get("B")?.motivo === "en_mantenimiento" && s.get("B")?.ultimoServicio === "2026-08-30" && s.get("B")?.ultimoServicioLeido === true);
  chk("sin el último servicio leído no se afirma «nunca»", s.get("D")?.ultimoServicioLeido === false && s.get("D")?.ultimoServicio === null);
}

// ══ 11 · Corolario ════════════════════════════════════════════════════════════════════════════════
console.log("\n11 · corolario: una semana con actividad da números distintos de cero");
{
  const hoy = "2026-09-14";
  const propios: PropiaUso[] = [{ id: 1, placa: "CWZ-371", estado: "disponible", categoria: "VAN" }, { id: 2, placa: "B4N-968", estado: "disponible", categoria: "BUS" }];
  const lecturas: LecturaCruda[] = [];
  const reservas: any[] = [];
  const cargas: CargaUso[] = [];
  let k1 = 19_000;
  for (const f of diasDelPeriodo("2026-09-01", "2026-09-14")) {
    lecturas.push(lec(1, f, 360, k1, "aceptada", "checkin")); k1 += 120; lecturas.push(lec(1, f, 1140, k1, "aceptada", "checkout"));
    reservas.push({ id: idRes++, fecha_servicio: f, hora_servicio: "06:00:00", estado: "finalizada", vehiculo_id: 1, hora_real_inicio: "06:00:00", hora_real_fin: "09:00:00" });
    reservas.push({ id: idRes++, fecha_servicio: f, hora_servicio: "07:00:00", estado: "finalizada", vehiculo_id: 2, hora_real_inicio: "07:00:00", hora_real_fin: "08:00:00" });
    if (f.endsWith("0") || f.endsWith("5")) cargas.push({ fecha: f, vehiculo_id: 1, tipo_combustible: "gnv", galones: 40, unidad: "m3", total: 80 });
  }
  const e: EntradaUso = { desde: "2026-09-08", hasta: hoy, hoy, ahoraMs: Date.parse("2026-09-15T01:00:00Z"), propios, reservas, lecturas,
    paradasPorReserva: new Map(), kmGpsPorReserva: new Map(), cargas };
  const r = resumenUso(e);
  chk("km > 0, servicios > 0, horas > 0, gasto > 0 y CO₂ > 0",
    (r.km.total ?? 0) > 0 && r.servicios.noCancelados > 0 && (r.horas.total ?? 0) > 0 && (r.combustible.gasto ?? 0) > 0 && (r.combustible.co2Kg ?? 0) > 0,
    `km ${r.km.total} · serv ${r.servicios.noCancelados} · h ${r.horas.total} · S/ ${r.combustible.gasto} · ${r.combustible.co2Kg} kg`);
  chk("CWZ-371: 7 jornadas × 120 km por odómetro; la otra unidad sin odómetro deja el total como piso",
    r.porUnidad.find((u) => u.placa === "CWZ-371")?.km === 840 && r.km.esPiso && r.porUnidad.find((u) => u.placa === "B4N-968")?.km === null);
  chk("las dos unidades activas, ninguna sin uso", r.unidades.activas === 2 && r.unidades.sinUso.length === 0);
}

// ══ La ruta: los topes contra el abuso, contra un Supabase falso por HTTP ═══════════════════════
// `desde` no puede ser anterior a hoy − DIAS_ATRAS_MAX_USO (400 `rango_antiguo`, sin leer nada), y la
// cola es de 6. Los clientes de lib/api-auth.ts y lib/flota/uso-flota-datos.ts se crean al cargarse,
// así que el servidor falso se levanta antes de importar la ruta. Toda tabla responde vacía.
console.log("\nLa ruta /api/flota/uso: periodo antiguo y cola");
{
  const http = await import("node:http");
  const fs = await import("node:fs");
  const { DIAS_ATRAS_MAX_USO } = await import("../lib/flota/uso-flota");
  const fuente = fs.readFileSync(new URL("../app/api/flota/uso/route.ts", import.meta.url), "utf8");
  chk("la cola es de 6 (una de 20 no cabe en maxDuration = 60 s)", fuente.includes("crearTurno(2, 6)") && !/crearTurno\(2, 20\)/.test(fuente));
  const pedidas: string[] = [];
  const srv = http.createServer((req, res) => {
    req.on("data", () => {});
    req.on("end", () => {
      pedidas.push(`${req.method} ${req.url?.split("?")[0]}`);
      const json = (st: number, o: unknown) => { res.writeHead(st, { "content-type": "application/json" }); res.end(JSON.stringify(o)); };
      if (req.url?.startsWith("/auth/v1/user")) return json(200, { id: "u-admin", aud: "authenticated", role: "authenticated" });
      if (req.url?.startsWith("/rest/v1/usuarios")) {
        const o = { rol: "admin", activo: true };
        return json(200, String(req.headers.accept).includes("pgrst.object") ? o : [o]);
      }
      if (req.url?.startsWith("/rest/v1/")) return json(200, []);
      json(404, {});
    });
  });
  await new Promise<void>((ok) => srv.listen(0, "127.0.0.1", () => ok()));
  process.env.NEXT_PUBLIC_SUPABASE_URL = `http://127.0.0.1:${(srv.address() as { port: number }).port}`;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "prueba";
  try {
    const { GET } = await import("../app/api/flota/uso/route");
    const { NextRequest } = await import("next/server");
    const { fechaLima } = await import("../lib/alertas-horario");
    const pedir = async (q: string) => {
      const r = await GET(new NextRequest(`http://localhost/api/flota/uso${q}`, { headers: { authorization: "Bearer admin" } }));
      return { status: r.status, body: await r.json() as any };
    };
    const hoyR = fechaLima(Date.now());
    const minimo = sumarDias(hoyR, -DIAS_ATRAS_MAX_USO);
    const viejo = await pedir(`?desde=${sumarDias(minimo, -1)}&hasta=${sumarDias(minimo, 5)}`);
    chk("desde anterior a hoy − 400 días → 400 `rango_antiguo` que nombra el límite",
      viejo.status === 400 && viejo.body.codigo === "rango_antiguo" && viejo.body.ok === false && viejo.body.error.includes(minimo), viejo.body.error);
    chk("…sin leer ninguna tabla para rechazarlo", !pedidas.some((x) => x.startsWith("GET /rest/v1/") && !x.includes("/usuarios")));
    const borde = await pedir(`?desde=${minimo}&hasta=${sumarDias(minimo, 5)}`);
    chk("desde = hoy − 400 días → pasa la validación (no es `rango_antiguo`)", borde.body.codigo !== "rango_antiguo" && borde.status !== 400, `${borde.status} ${borde.body.codigo ?? "ok"}`);
  } finally {
    srv.close();
  }
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
