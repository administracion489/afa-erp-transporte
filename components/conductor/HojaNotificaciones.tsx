"use client";
// components/conductor/HojaNotificaciones.tsx — Pedir las notificaciones del app como lo hace
// Uber: al entrar, en una hoja que explica PARA QUÉ sirven, en vez de un «Activar» escondido
// en Perfil que casi ningún conductor abría. Sin la notificación del sistema, los avisos de
// inicio («Tu servicio empieza en 5 min», «Ya debiste INICIAR») solo llegan por WhatsApp.
//
// Cada estado tiene su salida, y ninguno promete lo que no puede hacer:
//   · inactivo           → «Activar notificaciones» (pide el permiso, gesto del usuario).
//   · bloqueado          → el permiso se negó: el app ya no puede volver a preguntarlo, así
//                          que se dice DÓNDE se enciende (Ajustes del teléfono).
//   · app-desactualizada → este APK no trae el módulo de notificaciones: hay que actualizarlo.
//   · ios-instalar       → en iPhone solo funciona instalada en la pantalla de inicio.
// «Ahora no» la pospone (12 h): una hoja que vuelve en cada apertura se aprende a cerrar sin leer.

import { IconBell, IconClose } from "@/app/_components/icons";
import { PrimaryBtn, SecondaryBtn, FONT_SANS } from "@/app/_components/ui";
import type { SoportePush } from "@/lib/push-cliente";

export type EstadoPushConductor = "desconocido" | "activo" | "inactivo" | "bloqueado";

const CLAVE_POSPUESTA = "afa_cond_push_hoja_hasta";
const POSPONER_MS = 12 * 3_600_000;

export function hojaPospuesta(): boolean {
  try { return Number(localStorage.getItem(CLAVE_POSPUESTA) || 0) > Date.now(); } catch { return false; }
}
export function posponerHoja(): void {
  try { localStorage.setItem(CLAVE_POSPUESTA, String(Date.now() + POSPONER_MS)); } catch { /* sin storage */ }
}

/** ¿Hay algo que el conductor pueda hacer para recibir las notificaciones? */
export function pushPendiente(estado: EstadoPushConductor, soporte: SoportePush | null): boolean {
  if (estado === "activo" || estado === "desconocido") return false;
  return soporte !== null && soporte !== "no-soportado";
}

const EJEMPLOS = [
  { t: "🚨 Tu servicio empieza en 5 min", s: "Toca y pulsa INICIAR" },
  { t: "⛔ Ya debiste INICIAR tu servicio", s: "Si se te pasó la hora" },
  { t: "🚌 Servicio asignado o cambiado", s: "Al instante, aunque el app esté cerrada" },
];

export default function HojaNotificaciones({
  abierta, estado, soporte, activando, error, onActivar, onCerrar, onReintentar,
}: {
  abierta: boolean;
  estado: EstadoPushConductor;
  soporte: SoportePush | null;
  activando: boolean;
  /** El último intento de activar falló (sin respuesta del servicio de notificaciones). */
  error?: boolean;
  onActivar: () => void;
  onCerrar: () => void;
  /** «Ya las activé»: vuelve a leer el permiso (después de ir a Ajustes). */
  onReintentar: () => void;
}) {
  if (!abierta || !pushPendiente(estado, soporte)) return null;

  const bloqueado = estado === "bloqueado";
  const desactualizada = soporte === "app-desactualizada";
  const iosInstalar = soporte === "ios-instalar";

  return (
    <div
      role="dialog" aria-modal="true" aria-label="Activar notificaciones"
      style={{
        position: "fixed", inset: 0, zIndex: 400, background: "rgba(8,20,40,0.55)",
        display: "flex", alignItems: "flex-end", justifyContent: "center", fontFamily: FONT_SANS,
      }}
    >
      <div style={{
        width: "100%", maxWidth: 520, background: "var(--c-surface)", color: "var(--c-ink)",
        borderRadius: "22px 22px 0 0", padding: "22px 20px 26px",
        boxShadow: "0 -10px 40px rgba(0,0,0,0.3)", animation: "sheetIn 0.22s ease-out",
      }}>
        <div style={{ display: "flex", justifyContent: "flex-end" }}>
          <button onClick={onCerrar} aria-label="Ahora no"
            style={{ background: "none", border: "none", color: "var(--c-mute)", cursor: "pointer", padding: 4 }}>
            <IconClose size={20} />
          </button>
        </div>
        <div style={{
          width: 64, height: 64, borderRadius: 20, margin: "0 auto 14px",
          background: bloqueado ? "var(--c-warn-tint)" : "var(--c-navy-tint)",
          display: "flex", alignItems: "center", justifyContent: "center",
        }}>
          <IconBell size={32} color={bloqueado ? "var(--c-warn)" : "var(--c-navy)"} />
        </div>
        <h2 style={{ margin: 0, fontSize: 20, fontWeight: 800, textAlign: "center" }}>
          {bloqueado ? "Tus notificaciones están bloqueadas" : "Activa las notificaciones"}
        </h2>
        <p style={{ margin: "8px 0 16px", fontSize: 13.5, lineHeight: 1.5, color: "var(--c-mute)", textAlign: "center" }}>
          {desactualizada
            ? "Esta versión del app no puede recibir notificaciones. Pide en operaciones la versión nueva de AFA Conductores."
            : iosInstalar
            ? "En iPhone, toca Compartir → «Añadir a pantalla de inicio» y abre el app desde ahí para recibir los avisos."
            : bloqueado
            ? "Sin ellas no te llegan los avisos de tus servicios. Ábrelas en Ajustes del teléfono → Apps → AFA Conductores → Notificaciones, y enciéndelas."
            : "Te avisamos antes de cada servicio para que no olvides pulsar INICIAR — aunque tengas el app cerrada, como Uber."}
        </p>

        {!desactualizada && !iosInstalar && (
          <div style={{ display: "flex", flexDirection: "column", gap: 8, marginBottom: 18 }}>
            {EJEMPLOS.map((e) => (
              <div key={e.t} style={{
                background: "var(--c-paper)", border: "1px solid var(--c-line)", borderRadius: 13,
                padding: "10px 12px",
              }}>
                <p style={{ margin: 0, fontSize: 13, fontWeight: 800 }}>{e.t}</p>
                <p style={{ margin: "2px 0 0", fontSize: 11.5, color: "var(--c-mute)" }}>{e.s}</p>
              </div>
            ))}
          </div>
        )}

        {error && !bloqueado && (
          <p style={{ margin: "0 0 12px", fontSize: 12.5, lineHeight: 1.45, color: "var(--c-warn)", textAlign: "center", fontWeight: 700 }}>
            No se pudieron activar en este teléfono. Revisa que tenga internet e inténtalo otra vez; si sigue, avísale a operaciones.
          </p>
        )}

        <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
          {!desactualizada && !iosInstalar && (bloqueado ? (
            <PrimaryBtn onClick={onReintentar} size="lg">Ya las activé</PrimaryBtn>
          ) : (
            <PrimaryBtn onClick={onActivar} size="lg" disabled={activando}>
              {activando ? "Activando…" : "Activar notificaciones"}
            </PrimaryBtn>
          ))}
          <SecondaryBtn onClick={onCerrar}>Ahora no</SecondaryBtn>
        </div>
      </div>
    </div>
  );
}

/** Franja fija en «Hoy» mientras no estén activas: la hoja se pospone, el recordatorio no. */
export function FranjaNotificacionesApagadas({ onAbrir }: { onAbrir: () => void }) {
  return (
    <button
      onClick={onAbrir}
      style={{
        width: "100%", display: "flex", alignItems: "center", gap: 10, textAlign: "left",
        background: "var(--c-warn-tint)", border: "1px solid var(--c-warn)", borderRadius: 13,
        padding: "10px 12px", marginBottom: 14, cursor: "pointer", fontFamily: FONT_SANS,
      }}
    >
      <IconBell size={18} color="var(--c-warn)" />
      <span style={{ flex: 1, minWidth: 0, fontSize: 12.5, lineHeight: 1.35, color: "var(--c-ink)" }}>
        <strong>Notificaciones apagadas:</strong> no te llegarán los avisos para iniciar tus servicios.
      </span>
      <span style={{ fontSize: 12.5, fontWeight: 800, color: "var(--c-warn)" }}>Activar</span>
    </button>
  );
}
