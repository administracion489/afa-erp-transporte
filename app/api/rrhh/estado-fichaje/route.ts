// app/api/rrhh/estado-fichaje/route.ts — ¿este usuario DEBE fichar, y ya marcó ENTRADA hoy?
//
//   GET (módulo `mi-perfil`): → { ok, es_fichador, marco_entrada_hoy, sin_migracion? }
//
// El layout la consulta en el login de CADA usuario para, tras entrar, llevar a los fichadores
// directo a marcar. La identidad es SIEMPRE la del token (igual que /api/rrhh/perfil): esto es
// sobre el PROPIO usuario que llama, su estado de fichaje. El veredicto de "¿ficha?" lo da el
// motor puro lib/rrhh/fichador.ts → debeFichar, que NO se reimplementa aquí: recibe la clase
// derivada, el opt-in `marca_asistencia` y si hay ventana de campo vigente AHORA.
//
// REGLA DURA — FAIL-OPEN. Esto es un gate de login: si algo falla (tabla/migración ausente,
// error de lectura, excepción), se responde `es_fichador: false` en vez de lanzar. NUNCA debe
// atrapar a nadie fuera del ERP por un fallo de este endpoint; lo peor que puede pasar es que a
// un fichador no se le lleve a marcar (entra al ERP normal). Toda la lectura va en try/catch y
// cualquier error de lectura degrada a es_fichador:false (las lecturas que no son "falta la
// migración" LANZAN a propósito en sus helpers → caen al catch). Solo se exponen los campos del
// contrato: nunca sueldo, PIN ni foto.

import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { adminRrhh } from "@/lib/rrhh/server";
import { debeFichar } from "@/lib/rrhh/fichador";
import { fichaDeUsuario } from "@/lib/rrhh/perfil-datos";
import { ventanaCampoVigente } from "@/lib/rrhh/campo";
import { autorizacionesCampoDe, SQL_CAMPO } from "@/lib/rrhh/campo-datos";
import { marcasDeHoy } from "@/lib/rrhh/marcacion-datos";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

// La migración que gobierna el opt-in `marca_asistencia` y las marcas del día (rrhh_marca).
const SQL = "supabase/rrhh-01-perfil-asistencia.sql";

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "mi-perfil");
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });
  const usuarioId = auth.userId;

  try {
    const sb = adminRrhh();

    // Las cuatro lecturas en paralelo (es un gate de login, la latencia importa). Los helpers
    // de RRHH LANZAN ante un error que no sea "falta la migración" (red/permiso); esa rechaza el
    // Promise.all y cae al catch → es_fichador:false, que es justo la degradación pedida.
    const [perfilRes, ficha, campo, marcas] = await Promise.all([
      sb.from("empleado_perfil").select("*").eq("usuario_id", usuarioId).maybeSingle(),
      fichaDeUsuario(sb, usuarioId),
      autorizacionesCampoDe(sb, usuarioId),
      marcasDeHoy(sb, usuarioId),
    ]);

    let sinMigracion: string | null = null;

    // Opt-in autoritativo del perfil (nace en false). Sin la tabla → falta rrhh-01; un error de
    // OTRA cosa sí aborta (no inventa un opt-in): el catch lo degrada a es_fichador:false.
    let marcaAsistencia = false;
    if (perfilRes.error) {
      if (tablaFaltante(perfilRes.error, "empleado_perfil")) sinMigracion = SQL;
      else throw perfilRes.error;
    } else {
      marcaAsistencia = !!(perfilRes.data as { marca_asistencia?: boolean } | null)?.marca_asistencia;
    }

    // Clase derivada (conductor / administrativo / null). Sin el puente de rrhh-01 → clase null.
    if (ficha.sinMigracion) sinMigracion = SQL;

    // ¿Ventana de campo vigente AHORA? Sin la migración de campo no hay autorización que valga
    // (campo_vigente=false): no exime, solo deja de ofrecer la ruta de campo. Se nombra su SQL
    // únicamente si rrhh-01 no reclamó ya el aviso.
    const campoVigente = campo.sinMigracion
      ? false
      : ventanaCampoVigente(campo.autorizaciones, Date.now()).vigente;
    if (campo.sinMigracion && !sinMigracion) sinMigracion = SQL_CAMPO;

    // ¿Ya marcó ENTRADA hoy (día de Lima, lo resuelve marcasDeHoy)? Sin rrhh_marca → falta rrhh-01.
    if (marcas.sinMigracion) sinMigracion = SQL;
    const marcoEntradaHoy = marcas.marcas.some((m) => m.tipo === "entrada");

    const veredicto = debeFichar({
      clase: ficha.clase,
      marca_asistencia: marcaAsistencia,
      campo_vigente: campoVigente,
    });

    return NextResponse.json({
      ok: true,
      es_fichador: veredicto.ficha,
      marco_entrada_hoy: marcoEntradaHoy,
      ...(sinMigracion ? { sin_migracion: sinMigracion } : {}),
    });
  } catch (e: unknown) {
    // FAIL-OPEN: ningún fallo de este endpoint puede trabar el login. Se degrada a no-fichador.
    console.error("[rrhh/estado-fichaje]", e);
    return NextResponse.json({ ok: true, es_fichador: false, marco_entrada_hoy: false });
  }
}
