import { NextRequest, NextResponse } from "next/server";
import { verificarUsuarioApi } from "@/lib/api-auth";
import { guardarGasto, limitarTasa, segundosParaReintentar } from "@/lib/api-guard";
import { probarAgente } from "@/lib/crm-ia";

export const maxDuration = 60;

/** Pruebas por usuario y minuto (no medido): cada una gasta tokens de Claude y, con traslados, Google. */
const PRUEBAS_POR_MINUTO = 10;

// Prueba el agente con un mensaje suelto (no envía nada al cliente).
export async function POST(req: NextRequest) {
  try {
    // Desde otro sitio, no (un POST cross-origin lo delata el Origin).
    const bloqueo = guardarGasto(req, { etiqueta: "crm-probar" });
    if (bloqueo) return bloqueo;

    // Gasta tokens de Claude: solo el equipo del CRM.
    const auth = await verificarUsuarioApi(req, "crm");
    if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

    // Freno por usuario (en memoria, por instancia): un bucle en la pantalla no vacía la cuenta.
    const clave = `crm-probar:${auth.userId}`;
    if (!limitarTasa(clave, PRUEBAS_POR_MINUTO, 60_000)) {
      const seg = Math.max(1, segundosParaReintentar(clave));
      return NextResponse.json(
        { ok: false, error: `Hiciste ${PRUEBAS_POR_MINUTO} pruebas en un minuto: vuelve a intentarlo en ${seg} s.` },
        { status: 429, headers: { "Retry-After": String(seg) } },
      );
    }

    const { mensaje, historial = [] } = await req.json();
    if (!mensaje?.trim()) return NextResponse.json({ ok: false, error: "Falta mensaje" }, { status: 400 });
    const r = await probarAgente(mensaje.trim(), historial);
    return NextResponse.json(r, { status: r.ok ? 200 : 207 });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message }, { status: 500 });
  }
}
