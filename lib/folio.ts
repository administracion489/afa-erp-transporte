// ──────────────────────────────────────────────────────────────────────────────
// lib/folio.ts — formato del "ID AFA" (folio público estable de una reserva).
//
// El folio real vive en la columna reservas.codigo, generado en la BD con el
// formato PREFIJO-AAAA-NNNNNN (ej. "OS-2026-000123"). Ver supabase/reservas-folio-codigo.sql.
//
// REGLA: ninguna pantalla debe construir el folio a mano ni mostrar reservas.id
// como identificador de cara al usuario. Importa idAfa() desde "@/lib/folio".
// reservas.id sigue siendo SOLO la llave interna (joins, FKs, realtime).
// ──────────────────────────────────────────────────────────────────────────────

// Devuelve el folio público. Fallback defensivo (#id) por si alguna fila legada
// aún no tuviera codigo; en datos normales siempre habrá codigo.
export function idAfa(r: { codigo?: string | null; id: number }): string {
  const c = r.codigo?.trim();
  return c ? c : `#${r.id}`;
}
