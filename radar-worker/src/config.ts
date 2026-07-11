// radar-worker/src/config.ts — Carga y validación de variables de entorno del worker. SOLO servidor.
//
// Lee el .env local (dotenv) y valida que estén las variables obligatorias.
// Si falta alguna, imprime un error claro en español y termina el proceso:
// mejor morir al arrancar que fallar en silencio a mitad de la noche.

import "dotenv/config";

const REQUERIDAS = [
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "ERP_URL",
  "RADAR_WORKER_SECRET",
] as const;

const faltantes = REQUERIDAS.filter((nombre) => !process.env[nombre]?.trim());
if (faltantes.length > 0) {
  console.error("");
  console.error("[radar-worker] ERROR: faltan variables de entorno obligatorias:");
  for (const nombre of faltantes) console.error(`  - ${nombre}`);
  console.error("");
  console.error("Copia .env.example a .env y completa los valores (ver README.md).");
  process.exit(1);
}

export const config = {
  /** URL del proyecto Supabase (misma que usa el ERP). */
  supabaseUrl: process.env.SUPABASE_URL!.trim(),
  /** Clave service_role de Supabase (acceso total, solo servidor). */
  supabaseServiceKey: process.env.SUPABASE_SERVICE_ROLE_KEY!.trim(),
  /** URL pública del ERP en Vercel, sin barra final. */
  erpUrl: process.env.ERP_URL!.trim().replace(/\/+$/, ""),
  /** Secreto compartido con /api/radar/procesar del ERP. */
  workerSecret: process.env.RADAR_WORKER_SECRET!.trim(),
  /** Carpeta donde Baileys persiste la sesión de WhatsApp (escanear QR una sola vez). */
  authDir: process.env.AUTH_DIR?.trim() || "./auth",
  /** Versión del worker (se reporta a radar_estado.version_worker). */
  version: "1.0.0",
};
