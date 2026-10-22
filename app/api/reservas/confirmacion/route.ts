// app/api/reservas/confirmacion/route.ts
// La CONFIRMACIÓN DE RESERVA (el documento para el cliente) y el adelanto que la habilita.
//
//   GET  ?reserva_id=N                       → el juicio (qué falta o qué avisa), la vista previa,
//                                             los cobros y el historial de versiones.
//   GET  ?version_id=N&idioma=es|en&pdf=1    → el PDF de ESA versión, dibujado desde su foto.
//   POST { accion: "emitir", reserva_id, extras }        → emite (o reusa) la versión vigente.
//   POST { accion: "adelanto", reserva_id, monto, fecha, metodo, referencia } → registra el cobro.
//   POST { accion: "anular_adelanto", reserva_id, pago_id }
//
// Permisos: ver y emitir exigen el módulo «programacion». REGISTRAR o ANULAR un adelanto exige
// «tesoreria» o «finanzas»: quien vende no es quien valida que el dinero entró, y una captura del
// cliente no es un cobro. Ningún endpoint cambia el estado de la reserva.
// Las reglas viven en lib/confirmacion-reserva.ts (PURO); aquí solo se lee, se autoriza y se escribe.

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi, verificarUsuarioApiAlguno } from "@/lib/api-auth";
import { guardarGasto } from "@/lib/api-guard";
import { cobradoEn, fechaValida, docConfirmacion, importeDelDia, juzgarConfirmacion, mensajeWhatsApp, nombreArchivo, normalizarIdioma,
  telefonoWa, type DatosConfirmacion, type ExtrasConf } from "@/lib/confirmacion-reserva";
import { anularAdelanto, emitirVersion, leerEntrada, leerVersion, leerVersiones, registrarAdelanto, SQL_CONFIRMACION } from "@/lib/confirmacion-reserva-datos";
import { dibujarConfirmacion } from "@/lib/confirmacion-reserva-pdf";
import { bajarLogo, leerPerfilPdf } from "@/lib/traslados/enviar-cotizacion-datos";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import { fechaLima } from "@/lib/alertas-horario";

export const dynamic = "force-dynamic";

const MODULOS_COBRO = ["tesoreria", "finanzas"];
const METODOS = new Set(["transferencia", "deposito", "yape", "plin", "efectivo", "tarjeta"]);

function admin() {
  return createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, { auth: { autoRefreshToken: false, persistSession: false } });
}
const err = (status: number, detalle: string, extra: Record<string, unknown> = {}) => NextResponse.json({ ok: false, detalle, ...extra }, { status });
const idDe = (v: unknown): number | null => { const n = Number(v); return Number.isInteger(n) && n > 0 ? n : null; };

function extrasDe(v: unknown): ExtrasConf {
  const o = (v && typeof v === "object" ? v : {}) as Record<string, unknown>;
  const s = (x: unknown, max: number) => (typeof x === "string" ? x.slice(0, max) : null);
  return { vuelo: s(o.vuelo, 40), punto_encuentro: s(o.punto_encuentro, 120), nota: s(o.nota, 300), incluir_telefono_conductor: o.incluir_telefono_conductor === true };
}

/**
 * Los mensajes que escribe este módulo (reglas de negocio) se enseñan; un error crudo de la base
 * no: va al log y el navegador recibe uno genérico.
 */
function mensajeSeguro(e: unknown): string {
  const m = (e as Error)?.message ?? "";
  return /^(Ese cobro|Otra persona|Falta correr)/.test(m) ? m : "No se pudo completar la operación. Vuelve a intentar en un momento.";
}

async function puedeCobrar(req: NextRequest): Promise<boolean> {
  return (await verificarUsuarioApiAlguno(req, MODULOS_COBRO)).ok;
}

export async function GET(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "programacion");
  if (!auth.ok) return err(auth.status, auth.error);
  const sb = admin();
  const u = new URL(req.url);

  // ── El PDF de una versión ──
  const versionId = idDe(u.searchParams.get("version_id"));
  if (versionId) {
    try {
      const v = await leerVersion(sb, versionId);
      if (!v) return err(404, "Esa confirmación no existe.");
      const idioma = normalizarIdioma(u.searchParams.get("idioma"));
      const { perfil } = await leerPerfilPdf(sb);
      const emp = empresaConDefectos(perfil);
      const doc = docConfirmacion(v.datos as DatosConfirmacion, idioma, { version: v.version, emitidoEn: fechaLima(new Date(v.generado_en).getTime()) },
        { nombre: emp.nombre, telefono: emp.telefono, email: emp.email, web: emp.web, direccion: emp.direccion, ruc: emp.ruc });
      // La cabecera es azul oscuro: primero la versión clara del perfil; si no hay o no baja,
      // el principal dentro de su recuadro blanco (nunca la clara sobre blanco).
      const claro = String(perfil?.logo_claro_url ?? "").trim();
      const logoClaro = claro ? await bajarLogo(claro).catch(() => null) : null;
      const logo = logoClaro ?? await bajarLogo(emp.logo).catch(() => null);
      const bytes = await dibujarConfirmacion(doc, { logo, logoClaro: !!logoClaro, empresa: emp.nombre });
      return new NextResponse(Buffer.from(bytes), {
        headers: {
          "Content-Type": "application/pdf",
          "Content-Disposition": `inline; filename="${nombreArchivo(v.codigo, idioma)}"`,
          "Cache-Control": "private, no-store",
        },
      });
    } catch (e) {
      console.error("[reservas/confirmacion] pdf", e);
      return err(500, "No se pudo generar el PDF. Vuelve a intentar en un momento.");
    }
  }

  // ── El estado de la confirmación de una reserva ──
  const reservaId = idDe(u.searchParams.get("reserva_id"));
  if (!reservaId) return err(400, "Falta reserva_id.");
  try {
    const { entrada, sinMigracion } = await leerEntrada(sb, reservaId, null);
    const idDoc = entrada.tramos.length ? Math.min(...entrada.tramos.map((t) => t.id)) : null;
    const versionesPrevias = idDoc ? await leerVersiones(sb, idDoc) : [];
    // Las indicaciones (vuelo, encuentro, nota, teléfono) se proponen desde la última versión.
    const ultima = versionesPrevias?.[0]?.datos as DatosConfirmacion | undefined;
    const extras: ExtrasConf = {
      vuelo: ultima?.servicio.vuelo ?? null,
      punto_encuentro: ultima?.servicio.punto_encuentro ?? null,
      nota: ultima?.servicio.nota ?? null,
      incluir_telefono_conductor: !!ultima?.operacion.unidades.some((x) => x.conductor?.telefono),
    };
    entrada.extras = extras;
    const juicio = juzgarConfirmacion(entrada);
    const imp = importeDelDia(entrada.tramos, entrada.cotizacion);
    const { perfil } = await leerPerfilPdf(sb);
    const emp = empresaConDefectos(perfil);
    return NextResponse.json({
      ok: true,
      sinMigracion: sinMigracion || versionesPrevias === null,
      sql: SQL_CONFIRMACION,
      juicio,
      extras,
      importe: { total: imp.total, moneda: imp.moneda, cobrado: cobradoEn(entrada.pagos, imp.moneda) },
      pagos: entrada.pagos.map((p) => ({ id: p.id, codigo: p.codigo, fecha: p.fecha, monto: p.monto, moneda: p.moneda, metodo: p.metodo, anulado: !!p.anulado })),
      versiones: (versionesPrevias ?? []).map((v) => ({ id: v.id, version: v.version, codigo: v.codigo, cambios: v.cambios, generado_en: v.generado_en, generado_por_nombre: v.generado_por_nombre })),
      puedeCobrar: await puedeCobrar(req),
      cliente: { telefonoWa: telefonoWa(entrada.cliente?.operativo_celular || entrada.cliente?.telefono) },
      empresa: emp.nombre,
      mensajes: { es: mensajeWhatsApp("es", emp.nombre, "{codigo}"), en: mensajeWhatsApp("en", emp.nombre, "{codigo}") },
    });
  } catch (e) {
    console.error("[reservas/confirmacion] estado", e);
    return err(500, "No se pudo leer la reserva. Vuelve a intentar en un momento.");
  }
}

export async function POST(req: NextRequest) {
  const bloqueo = guardarGasto(req, { etiqueta: "reservas-confirmacion" });
  if (bloqueo) return bloqueo;
  let cuerpo: Record<string, unknown>;
  try { cuerpo = (await req.json()) as Record<string, unknown>; } catch { return err(400, "Cuerpo inválido."); }
  const accion = String(cuerpo.accion ?? "");
  const reservaId = idDe(cuerpo.reserva_id);
  if (!reservaId) return err(400, "Falta reserva_id.");
  const sb = admin();

  if (accion === "emitir") {
    const auth = await verificarUsuarioApi(req, "programacion");
    if (!auth.ok) return err(auth.status, auth.error);
    try {
      const { entrada, sinMigracion } = await leerEntrada(sb, reservaId, extrasDe(cuerpo.extras));
      if (sinMigracion) return err(409, `Falta correr ${SQL_CONFIRMACION} en Supabase.`, { codigo: "sin_migracion" });
      const juicio = juzgarConfirmacion(entrada);
      if (!juicio.ok || !juicio.datos || !juicio.idDocumento) return err(409, "No se puede emitir todavía.", { codigo: "bloqueada", bloqueos: juicio.bloqueos });
      const { data: u } = await sb.from("usuarios").select("nombre").eq("id", auth.userId).maybeSingle();
      const v = await emitirVersion(sb, juicio.idDocumento, juicio.datos, { id: auth.userId, nombre: (u?.nombre as string | null) ?? null });
      return NextResponse.json({ ok: true, ...v });
    } catch (e) {
      console.error(`[reservas/confirmacion] ${accion}`, e);
      return err(500, mensajeSeguro(e));
    }
  }

  if (accion === "adelanto" || accion === "anular_adelanto") {
    const auth = await verificarUsuarioApiAlguno(req, MODULOS_COBRO);
    if (!auth.ok) return err(auth.status, auth.status === 403 ? "Registrar o anular un adelanto exige el módulo Finanzas o Cuentas por Pagar (Tesorería)." : auth.error);
    try {
      const { entrada, sinMigracion } = await leerEntrada(sb, reservaId, null);
      if (sinMigracion) return err(409, `Falta correr ${SQL_CONFIRMACION} en Supabase.`, { codigo: "sin_migracion" });
      if (!entrada.tramos.length) return err(404, "No se encontró la reserva.");
      const ids = entrada.tramos.map((t) => t.id);
      if (accion === "anular_adelanto") {
        const pagoId = idDe(cuerpo.pago_id);
        if (!pagoId) return err(400, "Falta pago_id.");
        await anularAdelanto(sb, pagoId, ids);
        return NextResponse.json({ ok: true });
      }
      if (entrada.tramos.every((t) => t.estado === "cancelada")) return err(409, "La reserva está cancelada.");
      const imp = importeDelDia(entrada.tramos, entrada.cotizacion);
      if (imp.total == null || !(imp.total > 0)) return err(409, "La reserva no tiene un precio registrado en su moneda: no se puede registrar un adelanto contra él.");
      const monto = Math.round(Number(cuerpo.monto) * 100) / 100;
      if (!(monto > 0)) return err(400, "El monto tiene que ser mayor que cero.");
      const ya = cobradoEn(entrada.pagos, imp.moneda);
      if (monto + ya > imp.total + 0.005) return err(409, `Con este cobro se pasaría del precio del servicio (${imp.moneda} ${imp.total.toFixed(2)}; ya cobrado ${ya.toFixed(2)}).`);
      const fecha = String(cuerpo.fecha ?? "").slice(0, 10);
      const hoy = fechaLima(Date.now());
      const haceUnAnio = fechaLima(Date.now() - 366 * 86_400_000);
      if (fechaValida(fecha) !== fecha || fecha > hoy || fecha < haceUnAnio) return err(400, "La fecha del cobro no es válida: tiene que existir, no ser futura ni de hace más de un año.");
      const metodo = METODOS.has(String(cuerpo.metodo)) ? String(cuerpo.metodo) : null;
      const referencia = typeof cuerpo.referencia === "string" ? cuerpo.referencia.trim().slice(0, 60) || null : null;
      if (!referencia && metodo !== "efectivo") return err(400, "Escribe el número de operación del pago (o elige efectivo).");
      const { data: u } = await sb.from("usuarios").select("nombre").eq("id", auth.userId).maybeSingle();
      const r = await registrarAdelanto(sb, Math.min(...ids), entrada.tramos[0].cliente_id, { monto, moneda: imp.moneda, fecha, metodo, referencia }, String(u?.nombre ?? auth.userId));
      // Dos registros a la vez pueden pasar los dos el tope: se relee y, si se pasó, se anula el propio.
      const { entrada: despues } = await leerEntrada(sb, reservaId, null);
      if (cobradoEn(despues.pagos, imp.moneda) > imp.total + 0.005) {
        await sb.from("pagos").update({ anulado: true }).eq("id", r.id);
        return err(409, "Otro cobro se registró a la vez y juntos superan el precio: este no se guardó. Revisa los cobros y vuelve a intentar.");
      }
      return NextResponse.json({ ok: true, ...r });
    } catch (e) {
      console.error(`[reservas/confirmacion] ${accion}`, e);
      return err(500, mensajeSeguro(e));
    }
  }

  return err(400, "Acción desconocida.");
}
