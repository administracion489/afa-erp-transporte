"use client";
// ──────────────────────────────────────────────────────────────────────────────
// components/rrhh/MarcarAsistencia.tsx — El gate de la cámara de la marcación facial.
//
// EL JUICIO LO HACEN LOS MOTORES PUROS YA COMMITTEADOS, no esta pantalla: qué hito toca
// (`tipoSiguiente`) y si el punto cae en la geocerca (`validarMarca`). La UI solo PINTA ese
// juicio (verde/ámbar) y manda la foto al servidor, que lo RECOMPUTA todo y tiene la última
// palabra — un `dentro_geocerca` del cliente no autoriza nada.
//
// EL CONSENTIMIENTO BIOMÉTRICO VA PRIMERO (Ley 29733): la foto del rostro es dato sensible.
// Sin consentimiento otorgado NO se enciende la cámara; se ofrece el método alterno (PIN con
// RRHH). La detección de rostro es local (@vladmandic/face-api, tinyFaceDetector desde
// /public/models) y solo HABILITA el botón cuando la caja del rostro supera el umbral.
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { validarMarca, tipoSiguiente } from "@/lib/rrhh/marcacion";
import { cargarConfigRrhh, marcasDeHoy, hoyLimaFecha } from "@/lib/rrhh/marcacion-datos";
import { coordValida } from "@/lib/cotizacion-ruta-coords";
import { cabecerasErp } from "@/lib/fetch-erp";
import type { ConfigRrhh, Marca, ResultadoJornada, TipoMarca } from "@/lib/rrhh/tipos";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";
/** Umbral del score de la caja de rostro para habilitar el botón (ámbar por debajo). */
const UMBRAL_ROSTRO = 0.5;

const TIPO_LABEL: Record<TipoMarca, string> = {
  entrada: "Marcar entrada",
  salida_almuerzo: "Salida a almuerzo",
  regreso_almuerzo: "Regreso de almuerzo",
  salida: "Marcar salida",
};

type Geo = { lat: number; lng: number; precision_m: number | null };

export default function MarcarAsistencia({
  biometrico,
  onPedirConsentimiento,
  onMarcada,
}: {
  biometrico: boolean;
  /** El padre otorga el consentimiento (POST /api/rrhh/consentimiento) y actualiza su estado. */
  onPedirConsentimiento: () => void;
  /** Aviso al padre de que se registró una marca, para refrescar "Mis asistencias". */
  onMarcada?: (jornada: ResultadoJornada | null) => void;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const faceapiRef = useRef<typeof import("@vladmandic/face-api") | null>(null);
  const detLoopRef = useRef<ReturnType<typeof setInterval> | null>(null);

  const [cfg, setCfg] = useState<ConfigRrhh | null>(null);
  const [marcas, setMarcas] = useState<Marca[]>([]);
  const [sinMigracion, setSinMigracion] = useState(false);
  const [cargandoDatos, setCargandoDatos] = useState(true);

  const [camaraOn, setCamaraOn] = useState(false);
  const [cargandoModelos, setCargandoModelos] = useState(false);
  const [errorCamara, setErrorCamara] = useState<string | null>(null);
  const [rostroScore, setRostroScore] = useState<number | null>(null);

  const [geo, setGeo] = useState<Geo | null>(null);
  const [geoEstado, setGeoEstado] = useState<"idle" | "midiendo" | "ok" | "error">("idle");
  const [geoError, setGeoError] = useState<string | null>(null);

  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState<
    | { ok: true; tipo: TipoMarca; dentro: boolean; distancia: number | null; fotoOmitida: boolean; jornada: ResultadoJornada | null }
    | { ok: false; mensaje: string }
    | null
  >(null);

  // ── Config de sede + marcas de hoy (para derivar el hito y pintar la geocerca) ──────────
  const recargar = useCallback(async () => {
    setCargandoDatos(true);
    try {
      const { cfg, sinMigracion: sm1 } = await cargarConfigRrhh(supabase);
      const { data: ses } = await supabase.auth.getSession();
      const uid = ses.session?.user.id;
      let marcasHoy: Marca[] = [];
      let sm2 = false;
      if (uid) {
        const r = await marcasDeHoy(supabase, uid, hoyLimaFecha());
        marcasHoy = r.marcas;
        sm2 = r.sinMigracion;
      }
      setCfg(cfg);
      setMarcas(marcasHoy);
      setSinMigracion(sm1 || sm2);
    } catch {
      // Una lectura que falla no es "sin marcas": no se afirma el vacío, se deja como está.
    } finally {
      setCargandoDatos(false);
    }
  }, []);

  useEffect(() => { void recargar(); }, [recargar]);

  const tipo = tipoSiguiente(marcas);

  // ── Cámara + modelos de face-api (solo con consentimiento otorgado) ─────────────────────
  const detenerCamara = useCallback(() => {
    if (detLoopRef.current) { clearInterval(detLoopRef.current); detLoopRef.current = null; }
    if (streamRef.current) { streamRef.current.getTracks().forEach((t) => t.stop()); streamRef.current = null; }
    if (videoRef.current) videoRef.current.srcObject = null;
    setCamaraOn(false);
    setRostroScore(null);
  }, []);

  // Ubicación (GPS) — declarada antes de `encenderCamara`, que la invoca.
  const pedirUbicacion = useCallback(() => {
    if (!navigator.geolocation) { setGeoEstado("error"); setGeoError("Este dispositivo no permite ubicación."); return; }
    setGeoEstado("midiendo"); setGeoError(null);
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setGeo({ lat: pos.coords.latitude, lng: pos.coords.longitude, precision_m: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null });
        setGeoEstado("ok");
      },
      () => { setGeoEstado("error"); setGeoError("No se pudo obtener tu ubicación. Puedes marcar igual si RRHH no exige geocerca."); },
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 },
    );
  }, []);

  const encenderCamara = useCallback(async () => {
    setErrorCamara(null);
    if (!biometrico) { onPedirConsentimiento(); return; }
    setCargandoModelos(true);
    try {
      // Import dinámico: face-api toca `window`/`document`, solo existe en el navegador.
      if (!faceapiRef.current) {
        const faceapi = await import("@vladmandic/face-api");
        await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
        faceapiRef.current = faceapi;
      }
      const stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
      streamRef.current = stream;
      if (videoRef.current) {
        videoRef.current.srcObject = stream;
        await videoRef.current.play().catch(() => {});
      }
      setCamaraOn(true);
      setCargandoModelos(false);
      // Bucle de detección: actualiza el score de la caja de rostro.
      const faceapi = faceapiRef.current;
      const opts = new faceapi.TinyFaceDetectorOptions({ inputSize: 224, scoreThreshold: 0.3 });
      detLoopRef.current = setInterval(async () => {
        const v = videoRef.current;
        if (!v || v.readyState < 2) return;
        try {
          const det = await faceapi.detectSingleFace(v, opts);
          setRostroScore(det ? Number(det.score) : 0);
        } catch {
          /* un frame fallido no apaga la cámara */
        }
      }, 450);
      // Pide la ubicación en paralelo.
      pedirUbicacion();
    } catch (e) {
      setCargandoModelos(false);
      const nombre = (e as { name?: string } | null)?.name;
      const msg = nombre === "NotAllowedError"
        ? "No diste permiso de cámara. Habilítalo en el navegador, o pídele a Recursos Humanos que te marque por PIN."
        : nombre === "NotFoundError"
        ? "No se encontró una cámara en este dispositivo. Pídele a Recursos Humanos que te marque por PIN."
        : "No se pudo abrir la cámara. Puedes pedirle a Recursos Humanos que te marque por PIN.";
      setErrorCamara(msg);
    }
  }, [biometrico, onPedirConsentimiento, pedirUbicacion]);

  useEffect(() => () => detenerCamara(), [detenerCamara]);

  // ── Geocerca (pintado; el servidor la recomputa) ────────────────────────────────────────
  const sedeConfigurada = !!cfg && coordValida(cfg.sede_lat, cfg.sede_lng);
  const geocerca = geo && cfg ? validarMarca(geo, cfg) : null;
  const rostroOk = rostroScore != null && rostroScore >= UMBRAL_ROSTRO;
  const fueraBloquea = !!cfg?.geocerca_bloquea && !!geocerca && !geocerca.dentro_geocerca && sedeConfigurada;

  // El botón habilita con rostro válido y ubicación lista; la geocerca que BLOQUEA lo frena.
  const puedeMarcar = !!tipo && rostroOk && geoEstado === "ok" && !fueraBloquea && !enviando;

  // ── Capturar frame y enviar ─────────────────────────────────────────────────────────────
  async function marcar() {
    if (!tipo || !geo) return;
    setEnviando(true); setResultado(null);
    try {
      const v = videoRef.current;
      let foto = "";
      if (v && v.videoWidth > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); foto = canvas.toDataURL("image/jpeg", 0.8); }
      }
      const res = await fetch("/api/rrhh/marcar", {
        method: "POST",
        headers: await cabecerasErp(),
        body: JSON.stringify({ tipo, lat: geo.lat, lng: geo.lng, precision_m: geo.precision_m, rostro_detectado: rostroOk, foto }),
      });
      const data = await res.json().catch(() => ({}));
      if (res.status === 422 || data?.sin_migracion) { setSinMigracion(true); setResultado({ ok: false, mensaje: `Falta correr ${SQL}.` }); return; }
      if (res.status === 403 && data?.requiere_consentimiento === "biometrico") {
        setResultado({ ok: false, mensaje: "Necesitas dar tu consentimiento biométrico. También puedes pedirle a RRHH que te marque por PIN." });
        onPedirConsentimiento();
        return;
      }
      if (res.status === 403) { // geocerca
        setResultado({ ok: false, mensaje: data?.error ?? "Estás fuera del área de la sede. Acércate para marcar." });
        return;
      }
      if (res.status === 409) { setResultado({ ok: false, mensaje: data?.error ?? "No corresponde marcar ahora." }); await recargar(); return; }
      if (!res.ok || !data?.ok) { setResultado({ ok: false, mensaje: data?.error ?? "No se pudo registrar la marca." }); return; }

      setResultado({
        ok: true, tipo: data.tipo, dentro: !!data.dentro_geocerca,
        distancia: data.distancia_m ?? null, fotoOmitida: !!data.foto_omitida, jornada: data.jornada ?? null,
      });
      onMarcada?.(data.jornada ?? null);
      detenerCamara();
      await recargar();
    } catch {
      setResultado({ ok: false, mensaje: "Error de red al registrar la marca." });
    } finally {
      setEnviando(false);
    }
  }

  // ── Render ──────────────────────────────────────────────────────────────────────────────
  if (sinMigracion) {
    return (
      <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
        La marcación de asistencia aún no está disponible: falta correr <code className="font-mono">{SQL}</code> en Supabase.
        También hay que crear a mano el bucket privado <code className="font-mono">rrhh</code> (Storage, Public = OFF) para guardar las fotos.
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Consentimiento biométrico: va PRIMERO y sin él no se abre la cámara */}
      {!biometrico && (
        <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-indigo-800">🔒 Antes de marcar: consentimiento biométrico</p>
          <p className="text-xs text-indigo-900 leading-relaxed">
            Marcar por reconocimiento facial trata tu <b>imagen del rostro</b>, que la Ley N.º 29733 de Protección de Datos Personales
            considera un <b>dato sensible</b>. La foto se usa solo para verificar tu identidad al fichar, se guarda cifrada y de acceso
            restringido, y <b>puedes revocar</b> este permiso cuando quieras desde tu perfil.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={onPedirConsentimiento} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:opacity-90">
              Doy mi consentimiento y activo la cámara
            </button>
          </div>
          <p className="text-[11px] text-indigo-700">
            ¿Prefieres no usar la cámara? Recursos Humanos puede marcar tu asistencia por <b>PIN</b> — no necesitas este consentimiento para eso.
          </p>
        </div>
      )}

      {cargandoDatos ? (
        <p className="text-xs text-gray-500">Cargando la configuración de marcación…</p>
      ) : !cfg ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">
          Recursos Humanos aún no configuró la sede ni el horario. Avísales para poder marcar; mientras tanto, pueden marcarte por PIN.
        </div>
      ) : !tipo ? (
        <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 font-semibold">
          ✓ Ya cerraste tu jornada de hoy. Nada más que marcar.
        </div>
      ) : (
        <>
          {/* Qué hito toca */}
          <div className="rounded-xl border border-gray-200 bg-white p-4">
            <p className="text-[11px] font-bold uppercase tracking-wide text-gray-400">Ahora te toca</p>
            <p className="text-2xl font-black text-gray-900">{TIPO_LABEL[tipo]}</p>
            {marcas.length > 0 && (
              <p className="text-[11px] text-gray-400 mt-1">
                Hoy ya marcaste: {marcas.map((m) => TIPO_LABEL[m.tipo as TipoMarca] ?? m.tipo).join(" · ")}
              </p>
            )}
          </div>

          {/* Cámara */}
          {biometrico && (
            <div className="rounded-xl border border-gray-200 bg-black/90 overflow-hidden relative">
              <video ref={videoRef} playsInline muted className="w-full max-h-80 object-contain bg-black" style={{ transform: "scaleX(-1)" }} />
              {!camaraOn && (
                <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-white">
                  {cargandoModelos
                    ? <p className="text-sm">Preparando la cámara…</p>
                    : <button onClick={encenderCamara} className="px-5 py-2.5 rounded-xl bg-white text-gray-900 text-sm font-bold hover:opacity-90">📷 Encender cámara</button>}
                </div>
              )}
            </div>
          )}

          {errorCamara && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-800">{errorCamara}</div>
          )}

          {/* Semáforo del gate: rostro + geocerca */}
          {camaraOn && (
            <div className="grid grid-cols-2 gap-2">
              <Chip
                ok={rostroOk}
                titulo="Rostro"
                detalle={rostroScore == null ? "detectando…" : rostroOk ? "detectado" : "acércate y mira a la cámara"}
              />
              <Chip
                ok={geoEstado === "ok" && (!cfg.geocerca_bloquea || !geocerca || geocerca.dentro_geocerca || !sedeConfigurada)}
                neutro={geoEstado !== "ok" || !sedeConfigurada}
                titulo="Ubicación"
                detalle={
                  geoEstado === "midiendo" ? "midiendo…"
                  : geoEstado === "error" ? (geoError ?? "sin ubicación")
                  : !sedeConfigurada ? "sede sin configurar (informativo)"
                  : geocerca ? (geocerca.dentro_geocerca ? "dentro de la sede" : `a ${Number.isFinite(geocerca.distancia_m) ? geocerca.distancia_m : "—"} m de la sede`)
                  : "—"
                }
              />
            </div>
          )}

          {camaraOn && geoEstado === "error" && (
            <button onClick={pedirUbicacion} className="text-xs text-indigo-600 font-semibold underline">Reintentar ubicación</button>
          )}

          {/* Botón de marcar */}
          {camaraOn && (
            <div className="space-y-1">
              <button
                onClick={marcar}
                disabled={!puedeMarcar}
                className={`w-full px-5 py-3 rounded-xl text-sm font-black text-white ${puedeMarcar ? "bg-emerald-600 hover:opacity-90" : "bg-gray-300 cursor-not-allowed"}`}
              >
                {enviando ? "Registrando…" : TIPO_LABEL[tipo]}
              </button>
              {/* Un botón deshabilitado dice QUÉ le falta (fijo, no en un toast que se va) */}
              {!puedeMarcar && !enviando && (
                <p className="text-[11px] text-gray-500 text-center">
                  {!rostroOk ? "Esperando que la cámara detecte tu rostro." : geoEstado !== "ok" ? "Esperando tu ubicación." : fueraBloquea ? "Estás fuera del área de la sede: acércate para marcar." : "—"}
                </p>
              )}
            </div>
          )}
        </>
      )}

      {/* Resultado de la última marca */}
      {resultado && (
        resultado.ok ? (
          <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-3 text-sm text-emerald-800 space-y-1">
            <p className="font-bold">✓ {TIPO_LABEL[resultado.tipo] ?? resultado.tipo} registrada {new Date().toLocaleTimeString("es-PE", { hour: "2-digit", minute: "2-digit" })}</p>
            <p className="text-xs">
              {resultado.dentro ? "Dentro de la sede." : `Fuera de la sede${resultado.distancia != null ? ` (a ${resultado.distancia} m)` : ""}.`}
              {resultado.fotoOmitida ? " · Se registró sin foto." : ""}
            </p>
            {resultado.jornada && resultado.jornada.estado === "completa" && (
              <p className="text-xs">Jornada de hoy: <b>{resultado.jornada.horas_trabajadas} h</b>{resultado.jornada.tardanza_min > 0 ? ` · tardanza ${resultado.jornada.tardanza_min} min` : ""}.</p>
            )}
          </div>
        ) : (
          <div className="rounded-xl border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{resultado.mensaje}</div>
        )
      )}
    </div>
  );
}

function Chip({ ok, neutro, titulo, detalle }: { ok: boolean; neutro?: boolean; titulo: string; detalle: string }) {
  const bg = neutro ? "bg-gray-50 border-gray-200 text-gray-600" : ok ? "bg-emerald-50 border-emerald-200 text-emerald-800" : "bg-amber-50 border-amber-200 text-amber-800";
  return (
    <div className={`rounded-lg border px-3 py-2 ${bg}`}>
      <p className="text-[10px] font-black uppercase tracking-widest">{titulo}</p>
      <p className="text-xs font-semibold">{neutro ? "•" : ok ? "✓" : "⚠"} {detalle}</p>
    </div>
  );
}
