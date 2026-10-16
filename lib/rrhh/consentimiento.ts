// ──────────────────────────────────────────────────────────────────────────────
// lib/rrhh/consentimiento.ts — los consentimientos biométrico, de monitoreo y facial, declarados.
//
// La marcación FACIAL procesa un dato biométrico (el rostro): en Perú la Ley 29733 de
// Protección de Datos Personales exige consentimiento PREVIO, LIBRE, INFORMADO y REVOCABLE
// para tratar datos sensibles. Por eso /api/rrhh/marcar lo exige vigente, y sin él ofrece un
// método alterno (PIN con RRHH) en vez de bloquear a la persona.
//
// DOS CONSENTIMIENTOS DISTINTOS SOBRE EL ROSTRO, Y NO SE PUEDEN FUNDIR. El `biometrico` autoriza
// guardar una FOTO como evidencia y PROMETE que no se hace reconocimiento facial automático. El
// `facial` autoriza algo que ese texto niega: calcular una PLANTILLA facial (un vector numérico)
// para VERIFICAR la identidad 1:1 al marcar. Reutilizar `biometrico` para eso contradiría el
// consentimiento ya otorgado, así que la verificación facial lleva su propio tipo, texto y versión.
//
// La VERSIÓN es un identificador del texto vigente: se guarda en `consentimiento_*_version`
// para poder probar QUÉ aceptó la persona y cuándo. Si el texto legal cambia, se sube la
// versión aquí (no se reescribe la vieja): un consentimiento firmado contra un texto es un
// hecho histórico. El texto lo muestra la pantalla; aquí vive el identificador y el resumen.
// ──────────────────────────────────────────────────────────────────────────────

export type TipoConsentimiento = "biometrico" | "monitoreo" | "facial";

export const TIPOS_CONSENTIMIENTO: readonly TipoConsentimiento[] = ["biometrico", "monitoreo", "facial"] as const;

export function esTipoConsentimiento(t: unknown): t is TipoConsentimiento {
  return t === "biometrico" || t === "monitoreo" || t === "facial";
}

/** Versión vigente del texto de cada consentimiento. Subirla = nuevo texto; no se reescribe. */
export const VERSION_CONSENTIMIENTO: Record<TipoConsentimiento, string> = {
  biometrico: "2026-10-biometrico-v1",
  monitoreo: "2026-10-monitoreo-v1",
  facial: "2026-10-facial-v1",
};

/** Resumen informativo (la pantalla muestra el texto completo). */
export const RESUMEN_CONSENTIMIENTO: Record<TipoConsentimiento, string> = {
  biometrico:
    "Autorizo que, al marcar asistencia, la cámara detecte un rostro y se guarde mi foto como " +
    "evidencia, para que Recursos Humanos verifique la marca. No se hace reconocimiento facial " +
    "automático. La foto se guarda cifrada y de acceso restringido. Puedo revocar este " +
    "consentimiento cuando quiera.",
  monitoreo:
    "Autorizo el registro de mi ubicación y asistencia durante mi jornada con fines laborales. " +
    "Puedo revocar este consentimiento cuando quiera.",
  facial:
    "Autorizo que, al marcar asistencia, se calcule una PLANTILLA FACIAL (una HUELLA FACIAL: un " +
    "vector numérico derivado de mi rostro) y se guarde CIFRADA, para usarla SOLO para VERIFICAR " +
    "MI IDENTIDAD al registrar mi asistencia (confirmar que soy yo quien marca). La plantilla " +
    "facial es un dato biométrico sensible (Ley N.º 29733). Verifica identidad, no es una prueba " +
    "de vida: no detecta si el rostro es de una persona presente o una foto. Puedo revocar este " +
    "consentimiento cuando quiera.",
};

/** Las columnas de `empleado_perfil` que guardan cada consentimiento. */
export function columnasConsentimiento(tipo: TipoConsentimiento): { en: string; version: string } {
  return { en: `consentimiento_${tipo}_en`, version: `consentimiento_${tipo}_version` };
}

/** ¿Está vigente el consentimiento de este tipo? = tiene instante de otorgamiento y no fue revocado
 *  (revocar = poner `_en` a null). No exige que la versión coincida con la vigente: endurecer eso
 *  bloquearía a quien ya consintió el día que cambia el texto; esa es una decisión de pantalla. */
export function consentimientoVigente(
  perfil: Record<string, unknown> | null | undefined,
  tipo: TipoConsentimiento,
): boolean {
  const { en } = columnasConsentimiento(tipo);
  const v = perfil?.[en];
  return v != null && v !== "";
}

/** Estado de los dos consentimientos para la respuesta del perfil. */
export function estadoConsentimientos(perfil: Record<string, unknown> | null | undefined) {
  const out: Record<string, { otorgado: boolean; en: string | null; version: string | null; vigente_version: string }> = {};
  for (const tipo of TIPOS_CONSENTIMIENTO) {
    const { en, version } = columnasConsentimiento(tipo);
    out[tipo] = {
      otorgado: consentimientoVigente(perfil, tipo),
      en: (perfil?.[en] as string | null) ?? null,
      version: (perfil?.[version] as string | null) ?? null,
      vigente_version: VERSION_CONSENTIMIENTO[tipo],
    };
  }
  return out;
}
