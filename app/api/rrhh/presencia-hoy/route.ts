// app/api/rrhh/presencia-hoy/route.ts — Panel "¿Quién está?" en vivo (solo RRHH).
//
//   GET (módulo `rrhh`): → { ok, empleados, resumen, fecha, ahora_min,
//                            sin_migracion?, campo_sin_migracion? }
//
// Para cada empleado RELEVANTE hoy, su estado de presencia AHORA. El JUICIO lo hace el motor
// PURO lib/rrhh/estado-presencia.ts → estadoPresencia; NO se reimplementa aquí. Este endpoint
// solo JUNTA los datos EN LOTE (sin N+1) y se los entrega por empleado: la clase, las marcas de
// hoy, si hay ventana de campo vigente AHORA y la presencia por servicios del conductor.
//
// EL CONJUNTO de empleados es la UNIÓN (todo en lote, nunca por usuario):
//   · FICHADORES               empleado_perfil.marca_asistencia = true
//   · con MARCA hoy            rrhh_marca del día de Lima (marcasPorRango desde=hasta=hoy)
//   · en CAMPO vigente         rrhh_autorizacion_campo cuya ventana contiene AHORA
//   · CONDUCTOR con servicio   reservas.fecha_servicio = hoy con conductor_id → usuario_id
// Las cuatro ramas se incluyen: los conductores con servicio se derivan en lote (reservas del día
// + un mapeo conductor_id→usuario_id), que es barato.
//
// Lee con service-role tras verificar el permiso `rrhh` (la UI es evadible; el permiso se
// re-verifica en el servidor). SOLO se exponen los campos del contrato: usuario_id, nombre, clase,
// estado, codigo, llego_tarde, entrada_en. NUNCA sueldo, PIN, foto ni teléfono — el nombre sale de
// `usuarios`, y la clase se DERIVA de existir en conductores / personal_administrativo (se
// seleccionan solo id/usuario_id, nada sensible; lista blanca como en perfil-datos.ts).
//
// DEGRADACIÓN: sin rrhh-01 (rrhh_config / empleado_perfil / rrhh_marca ausentes, o sin el puente
// conductores.usuario_id) → { ok:true, empleados:[], sin_migracion } en vez de 500. Sin rrhh-02
// (campo), solo deja de haber ventanas de campo (campo_sin_migracion informativo). Sin rrhh-04, el
// horario cae al global (lo maneja cfgsEfectivasDe). Una lectura que falla por OTRA causa (red,
// permiso, CHECK) LANZA → 500 con mensaje: tratarla como lista vacía marcaría a alguien "ausente"
// sin saberlo.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { estadoPresencia } from "@/lib/rrhh/estado-presencia";
import { cargarConfigRrhh, hoyLimaFecha } from "@/lib/rrhh/marcacion-datos";
import { marcasPorRango, type MarcaConUsuario } from "@/lib/rrhh/jornada-datos";
import { cfgsEfectivasDe } from "@/lib/rrhh/horario-datos";
import { ventanaCampoVigente } from "@/lib/rrhh/campo";
import { listarAutorizaciones, SQL_CAMPO, type FilaAutorizacionCampo } from "@/lib/rrhh/campo-datos";
import { presenciaDeServicios } from "@/lib/rrhh/asistencia-conductor";
import { minutoDelDiaLima } from "@/lib/alertas-horario";
import { tablaFaltante, faltaColumna } from "@/lib/columna-faltante";
import type { ClaseFicha } from "@/lib/rrhh/perfil-datos";

export const maxDuration = 30;

// La migración que crea el perfil/opt-in, las marcas, la config de sede y el puente
// conductores.usuario_id. El deploy NO la corre: sin ella, se DICE en vez de un 500.
const SQL = "supabase/rrhh-01-perfil-asistencia.sql";
const PAGINA = 1000;

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type SB = { from: (t: string) => any };

/** Un empleado del panel, SOLO con los campos no sensibles del contrato. */
type EmpleadoPresencia = {
  usuario_id: string;
  nombre: string | null;
  clase: ClaseFicha;
  estado: ReturnType<typeof estadoPresencia>["estado"];
  codigo: ReturnType<typeof estadoPresencia>["codigo"];
  llego_tarde: boolean;
  /** Hora REAL de la entrada (ISO), si marcó, para que la UI la muestre; null si no. */
  entrada_en: string | null;
};

/** La respuesta de degradación: sin la migración no hay panel, pero tampoco un 500. */
function respuestaSinMigracion(fecha: string, ahoraMin: number) {
  return NextResponse.json({ ok: true, empleados: [], resumen: {}, fecha, ahora_min: ahoraMin, sin_migracion: SQL });
}

/** La hora de la ENTRADA más temprana de un día (ISO), o null si no marcó entrada. Se elige por
 *  timestamp, no por posición en el array (mismo criterio que el motor para la tardanza). */
function entradaEnDe(marcas: ReadonlyArray<MarcaConUsuario>): string | null {
  let best: string | null = null;
  let bestMs = Infinity;
  for (const m of marcas) {
    if (m?.tipo !== "entrada" || !m?.marcado_en) continue;
    const t = Date.parse(String(m.marcado_en));
    if (Number.isFinite(t) && t < bestMs) { bestMs = t; best = String(m.marcado_en); }
  }
  return best;
}

/** Reservas de HOY (día de Lima) agrupadas por conductor_id, con solo `estado` (lo único que lee
 *  `presenciaDeServicios`). Paginado con orden total (id) — PostgREST corta en 1000 y un día con
 *  muchos servicios las perdería en silencio. Un error LANZA (es una tabla núcleo; no es "sin
 *  servicios"): el día que una lectura falle no puede leerse como "ningún conductor trabajó". */
async function reservasHoyPorConductor(sb: SB, hoy: string): Promise<Map<string, { estado?: string | null }[]>> {
  const map = new Map<string, { estado?: string | null }[]>();
  for (let off = 0; ; off += PAGINA) {
    const { data, error } = await sb
      .from("reservas")
      .select("id, conductor_id, estado")
      .eq("fecha_servicio", hoy)
      .not("conductor_id", "is", null)
      .order("id", { ascending: true })
      .range(off, off + PAGINA - 1);
    if (error) throw error;
    const rows = (data ?? []) as { conductor_id?: unknown; estado?: string | null }[];
    for (const r of rows) {
      if (r?.conductor_id == null) continue;
      const cid = String(r.conductor_id);
      const arr = map.get(cid);
      if (arr) arr.push({ estado: r.estado });
      else map.set(cid, [{ estado: r.estado }]);
    }
    if (rows.length < PAGINA) break;
  }
  return map;
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "rrhh");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const fecha = hoyLimaFecha();
  const ahoraMs = Date.now();
  const ahoraMin = minutoDelDiaLima(ahoraMs);

  try {
    const sb: SB = adminRrhh();

    // ── LOTE 1 (en paralelo): config global, fichadores, marcas de hoy, autorizaciones de campo
    //    y reservas del día. Los lectores puros devuelven `sinMigracion` ante una tabla ausente y
    //    LANZAN ante otro error (que rechaza el Promise.all → el catch externo lo vuelve 500).
    const [configR, fichadoresR, marksR, campoR, reservasMap] = await Promise.all([
      cargarConfigRrhh(sb),
      sb.from("empleado_perfil").select("usuario_id").eq("marca_asistencia", true),
      marcasPorRango(sb, { desde: fecha, hasta: fecha }),
      listarAutorizaciones(sb, {}),
      reservasHoyPorConductor(sb, fecha),
    ]);

    // Gate rrhh-01: sin la config, las marcas o el perfil, no hay panel → se DICE (no un 500).
    let sinMig = configR.sinMigracion || marksR.sinMigracion;
    const fichadorIds: string[] = [];
    if (fichadoresR.error) {
      if (tablaFaltante(fichadoresR.error, "empleado_perfil")) sinMig = true;
      else throw fichadoresR.error; // otra causa: no es "sin fichadores"
    } else {
      for (const r of (fichadoresR.data ?? []) as { usuario_id?: unknown }[]) {
        if (r?.usuario_id) fichadorIds.push(String(r.usuario_id));
      }
    }
    if (sinMig) return respuestaSinMigracion(fecha, ahoraMin);

    // Marcas de hoy, agrupadas por usuario (el CONJUNTO, no el orden, decide el estado).
    const marksByUser = new Map<string, MarcaConUsuario[]>();
    for (const m of marksR.marcas) {
      const uid = String(m.usuario_id);
      const arr = marksByUser.get(uid);
      if (arr) arr.push(m);
      else marksByUser.set(uid, [m]);
    }

    // Autorizaciones de campo por usuario → ¿hay una ventana vigente AHORA? (ventanaCampoVigente).
    // Sin rrhh-02 no hay campo que valga: el panel sigue, solo se informa `campo_sin_migracion`.
    const campoByUser = new Map<string, FilaAutorizacionCampo[]>();
    if (!campoR.sinMigracion) {
      for (const a of campoR.autorizaciones) {
        const uid = a?.usuario_id ? String(a.usuario_id) : null;
        if (!uid) continue;
        const arr = campoByUser.get(uid);
        if (arr) arr.push(a);
        else campoByUser.set(uid, [a]);
      }
    }
    const campoVigenteByUser = new Map<string, boolean>();
    for (const [uid, auths] of campoByUser) {
      campoVigenteByUser.set(uid, ventanaCampoVigente(auths, ahoraMs).vigente);
    }

    // Conductores CON servicio hoy → sus usuario_id (para incluirlos en el conjunto). Mapea los
    // conductor_id de las reservas del día a su usuario_id; un conductor sin usuario_id (sin login
    // en el ERP) no tiene lugar en un panel por usuario, así que se omite.
    const conductorServiceUids = new Set<string>();
    const conductorIdsHoy = [...reservasMap.keys()];
    if (conductorIdsHoy.length > 0) {
      const { data, error } = await sb.from("conductores").select("usuario_id").in("id", conductorIdsHoy);
      if (error) {
        // Sin el puente conductores.usuario_id (rrhh-01), no hay conductores que ubicar → se DICE.
        if (faltaColumna(error, "usuario_id") || tablaFaltante(error, "conductores")) {
          return respuestaSinMigracion(fecha, ahoraMin);
        }
        throw error;
      }
      for (const r of (data ?? []) as { usuario_id?: unknown }[]) {
        if (r?.usuario_id) conductorServiceUids.add(String(r.usuario_id));
      }
    }

    // El CONJUNTO: fichadores ∪ con marca ∪ campo vigente ∪ conductor con servicio.
    const setUids = new Set<string>([...fichadorIds, ...marksByUser.keys(), ...conductorServiceUids]);
    for (const [uid, vigente] of campoVigenteByUser) if (vigente) setUids.add(uid);

    if (setUids.size === 0) {
      return NextResponse.json({
        ok: true, empleados: [], resumen: {}, fecha, ahora_min: ahoraMin,
        ...(campoR.sinMigracion ? { campo_sin_migracion: SQL_CAMPO } : {}),
      });
    }
    const uids = [...setUids];

    // ── LOTE 2 (en paralelo): clase (conductores / personal_administrativo), nombres y la cfg
    //    efectiva por empleado. Todas acotadas al conjunto del día (nunca a toda la empresa).
    const [conductoresR, adminR, usuariosR, cfgByUser] = await Promise.all([
      sb.from("conductores").select("id, usuario_id").in("usuario_id", uids),
      sb.from("personal_administrativo").select("usuario_id").in("usuario_id", uids),
      sb.from("usuarios").select("id, nombre").in("id", uids),
      // Sin config global (fila no sembrada) no hay cfg por usuario: el motor recibe cfg=null y
      // declara `sin_dato` donde la necesite. Con config, cfgsEfectivasDe aplica los overrides.
      configR.cfg ? cfgsEfectivasDe(sb, uids, configR.cfg) : Promise.resolve(null),
    ]);

    // Conductores: su usuario_id ⇒ clase "conductor" y el conductor_id para su presencia.
    if (conductoresR.error) {
      if (faltaColumna(conductoresR.error, "usuario_id") || tablaFaltante(conductoresR.error, "conductores")) {
        return respuestaSinMigracion(fecha, ahoraMin);
      }
      throw conductoresR.error;
    }
    const conductorByUsuario = new Map<string, string>();
    for (const r of (conductoresR.data ?? []) as { id?: unknown; usuario_id?: unknown }[]) {
      if (r?.usuario_id && r?.id != null) conductorByUsuario.set(String(r.usuario_id), String(r.id));
    }

    // Administrativos: su usuario_id ⇒ clase "administrativo". `personal_administrativo.usuario_id`
    // es de otra migración (comisiones-03): si falta, nadie es administrativo — NO bloquea el panel.
    const adminUidSet = new Set<string>();
    if (adminR.error) {
      if (!(faltaColumna(adminR.error, "usuario_id") || tablaFaltante(adminR.error, "personal_administrativo"))) {
        throw adminR.error;
      }
    } else {
      for (const r of (adminR.data ?? []) as { usuario_id?: unknown }[]) {
        if (r?.usuario_id) adminUidSet.add(String(r.usuario_id));
      }
    }

    // Nombres (lista blanca: solo id + nombre; nunca sueldo/PIN/teléfono/foto).
    if (usuariosR.error) throw usuariosR.error;
    const nombreByUser = new Map<string, string | null>();
    for (const u of (usuariosR.data ?? []) as { id?: unknown; nombre?: string | null }[]) {
      if (u?.id != null) nombreByUser.set(String(u.id), u.nombre ?? null);
    }

    // Veredicto por empleado con el motor PURO.
    const empleados: EmpleadoPresencia[] = [];
    const resumen: Record<string, number> = {};
    for (const uid of uids) {
      const clase: ClaseFicha = conductorByUsuario.has(uid)
        ? "conductor"
        : adminUidSet.has(uid)
          ? "administrativo"
          : null;

      let presenciaConductor: boolean | undefined;
      if (clase === "conductor") {
        const cid = conductorByUsuario.get(uid)!;
        presenciaConductor = presenciaDeServicios(reservasMap.get(cid)).presente;
      }

      const marcas = marksByUser.get(uid) ?? [];
      const r = estadoPresencia({
        marcasHoy: marcas,
        cfg: cfgByUser?.get(uid) ?? configR.cfg, // efectiva por empleado; cae al global, y a null si no hay config
        ahoraMin,
        clase,
        campo_vigente: campoVigenteByUser.get(uid) ?? false,
        presenciaConductor,
      });

      empleados.push({
        usuario_id: uid,
        nombre: nombreByUser.get(uid) ?? null,
        clase,
        estado: r.estado,
        codigo: r.codigo,
        llego_tarde: r.llego_tarde,
        entrada_en: entradaEnDe(marcas),
      });
      resumen[r.estado] = (resumen[r.estado] ?? 0) + 1;
    }

    // Orden estable: por nombre (y a falta de él, por id), como el panel de campo.
    empleados.sort((a, b) => (a.nombre ?? a.usuario_id).localeCompare(b.nombre ?? b.usuario_id, "es"));

    return NextResponse.json({
      ok: true,
      empleados,
      resumen,
      fecha,
      ahora_min: ahoraMin,
      ...(campoR.sinMigracion ? { campo_sin_migracion: SQL_CAMPO } : {}),
    });
  } catch (e: unknown) {
    // No es un gate de login: un fallo NO se degrada a vacío (marcaría a alguien "ausente"). 500.
    console.error("[rrhh/presencia-hoy]", e);
    return NextResponse.json(
      { ok: false, error: (e as { message?: string })?.message ?? "No se pudo leer la presencia de hoy." },
      { status: 500 },
    );
  }
}
