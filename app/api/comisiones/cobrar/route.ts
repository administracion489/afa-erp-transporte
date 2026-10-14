// ══════════════════════════════════════════════════════════════════════════════
// app/api/comisiones/cobrar/route.ts
// MARCAR COBRADO con pruebas. El dinero del vendedor se reconoce cuando el servicio está
// COBRADO, y «marcar cobrado» exige las TRES pruebas: depósito + factura PDF + factura XML.
// El SERVIDOR las sube al bucket PRIVADO `documentos`, guarda la RUTA en
// `comisiones_cobro_prueba.archivo_url` (nunca una URL pública: un depósito/factura trae
// datos comerciales; se lee con createSignedUrl) y SOLO con las tres pone
// `reservas.estado_admin='cobrada'` + `fecha_cobro`. Sin las tres → 400 que dice cuál falta.
//
// Envío: multipart/form-data con `reservaId` y los archivos `deposito`, `factura_pdf`,
// `factura_xml`. Idempotente: re-enviar reemplaza las pruebas de esa reserva.
//
// QUIÉN: un rol aprobador (admin/gerente). Flipea el estado AUTORITATIVO del cobro, que
// alimenta todo el cálculo; no es una acción de un vendedor sobre su propio servicio.
// ══════════════════════════════════════════════════════════════════════════════

import { NextRequest, NextResponse } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { tablaFaltante } from "@/lib/columna-faltante";

export const maxDuration = 60;

const admin = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL!,
  process.env.SUPABASE_SERVICE_ROLE_KEY!,
  { auth: { autoRefreshToken: false, persistSession: false } },
);

const BUCKET = "documentos";
const MAX_BYTES = 15 * 1024 * 1024;
const TIPOS = ["deposito", "factura_pdf", "factura_xml"] as const;
type TipoPrueba = (typeof TIPOS)[number];
const ETIQUETA: Record<TipoPrueba, string> = {
  deposito: "el depósito",
  factura_pdf: "la factura en PDF",
  factura_xml: "la factura en XML",
};

/** La extensión de un archivo subido, acotada y sin puntos ajenos. */
function extensionDe(nombre: string, tipo: string): string {
  const porNombre = (nombre.split(".").pop() || "").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 5);
  if (porNombre) return porNombre;
  if (tipo.includes("pdf")) return "pdf";
  if (tipo.includes("xml")) return "xml";
  if (tipo.includes("png")) return "png";
  return "bin";
}

export async function POST(req: NextRequest) {
  const auth = await verificarUsuarioApi(req, "comisiones");
  if (!auth.ok) return NextResponse.json({ error: auth.error }, { status: auth.status });
  if (!["admin", "gerente"].includes(auth.rol)) {
    return NextResponse.json({ error: "Solo un administrador o gerente puede marcar un servicio como cobrado." }, { status: 403 });
  }

  const subidas: string[] = []; // rutas subidas, para poder revertir si algo falla después
  try {
    const form = await req.formData().catch(() => null);
    if (!form) return NextResponse.json({ error: "Envía las pruebas como multipart/form-data." }, { status: 400 });

    const reservaId = Number(form.get("reservaId"));
    if (!Number.isFinite(reservaId) || reservaId <= 0) {
      return NextResponse.json({ error: "Falta la reserva a marcar como cobrada." }, { status: 400 });
    }

    // Las TRES pruebas, obligatorias. Falta una → 400 nombrándola.
    const archivos: Record<TipoPrueba, File> = {} as any;
    for (const t of TIPOS) {
      const f = form.get(t);
      if (!(f instanceof File) || f.size === 0) {
        return NextResponse.json({ error: `Falta ${ETIQUETA[t]}. Se necesitan las tres pruebas (depósito, factura PDF y factura XML).` }, { status: 400 });
      }
      if (f.size > MAX_BYTES) {
        return NextResponse.json({ error: `${ETIQUETA[t]} pesa demasiado (máx. 15 MB).` }, { status: 400 });
      }
      archivos[t] = f;
    }

    // La reserva tiene que existir.
    const { data: reserva, error: eRes } = await admin.from("reservas").select("id").eq("id", reservaId).maybeSingle();
    if (eRes) throw eRes;
    if (!reserva) return NextResponse.json({ error: "La reserva no existe." }, { status: 404 });

    // Idempotencia: retira las pruebas anteriores de esta reserva (y sus archivos).
    const { data: previas } = await admin
      .from("comisiones_cobro_prueba")
      .select("id,archivo_url")
      .eq("reserva_id", reservaId);
    const rutasPrevias = ((previas as any[]) ?? []).map((p) => String(p.archivo_url)).filter(Boolean);
    if (rutasPrevias.length) {
      await admin.from("comisiones_cobro_prueba").delete().eq("reserva_id", reservaId);
      try { await admin.storage.from(BUCKET).remove(rutasPrevias); } catch { /* best-effort */ }
    }

    // Subir las tres al bucket PRIVADO y armar las filas con la RUTA (no URL pública).
    const filas: Record<string, unknown>[] = [];
    for (const t of TIPOS) {
      const f = archivos[t];
      const ext = extensionDe(f.name, f.type);
      const ruta = `comisiones/cobro/reserva-${reservaId}/${t}-${crypto.randomUUID()}.${ext}`;
      const buf = Buffer.from(await f.arrayBuffer());
      const { error: eUp } = await admin.storage
        .from(BUCKET)
        .upload(ruta, buf, { contentType: f.type || "application/octet-stream", upsert: false });
      if (eUp) throw new Error(`No se pudo subir ${ETIQUETA[t]}: ${eUp.message}`);
      subidas.push(ruta);
      filas.push({
        reserva_id: reservaId,
        tipo_prueba: t,
        archivo_url: ruta,
        registrado_por: auth.userId,
        registrado_en: new Date().toISOString(),
      });
    }

    const { error: eIns } = await admin.from("comisiones_cobro_prueba").insert(filas);
    if (eIns) throw eIns;

    // SOLO con las tres: marcar la reserva como cobrada.
    const { error: eUpd } = await admin
      .from("reservas")
      .update({ estado_admin: "cobrada", fecha_cobro: new Date().toISOString() })
      .eq("id", reservaId);
    if (eUpd) throw eUpd;

    return NextResponse.json({ ok: true, reservaId, pruebas: TIPOS });
  } catch (e: any) {
    // Revertir los archivos ya subidos: una fila sin prueba (o al revés) sería basura.
    if (subidas.length) { try { await admin.storage.from(BUCKET).remove(subidas); } catch { /* */ } }
    if (tablaFaltante(e, "comisiones_cobro_prueba")) {
      return NextResponse.json({ error: "sin_migracion: falta correr supabase/comisiones-03-clasificaciones-y-pruebas.sql" }, { status: 422 });
    }
    console.error("[comisiones/cobrar]", e);
    return NextResponse.json({ error: String(e?.message ?? e) }, { status: 500 });
  }
}
