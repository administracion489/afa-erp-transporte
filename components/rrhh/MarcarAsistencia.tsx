"use client";
// ──────────────────────────────────────────────────────────────────────────────
// components/rrhh/MarcarAsistencia.tsx — El gate de la cámara de la marcación facial.
//
// EL JUICIO LO HACEN LOS MOTORES PUROS YA COMMITTEADOS, no esta pantalla: qué hito toca
// (`tipoSiguiente`) y si el punto cae en la geocerca (`validarMarca`). La UI solo PINTA ese
// juicio (verde/ámbar), CALCULA el descriptor facial y manda todo al servidor, que lo
// RECOMPUTA (geocerca, tipo, consentimientos, verificación 1:1) y tiene la última palabra —
// un `dentro_geocerca` del cliente no autoriza nada, y una "coincidencia" la decide el servidor.
//
// DOS CONSENTIMIENTOS, AMBOS NECESARIOS PARA ENCENDER LA CÁMARA (Ley 29733, datos sensibles):
//   · BIOMÉTRICO — guardar la foto del rostro como evidencia. Va PRIMERO.
//   · FACIAL     — comparar el rostro 1:1 contra la plantilla registrada (verificación de
//                  identidad). Sin este, la cámara/verificación facial no tiene sentido.
// Sin alguno de los dos NO se enciende la cámara; se ofrece el método alterno (PIN con RRHH).
//
// Localmente (@vladmandic/face-api, modelos en /public/models) se cargan al encender la cámara:
//   · tinyFaceDetector  — detecta que hay un rostro (habilita el botón por encima del umbral),
//   · faceLandmark68Net + faceRecognitionNet — calculan el descriptor (128 números) que viaja
//     al servidor como `descriptor` para la verificación 1:1.
//
// EL LÍMITE HONESTO: la verificación comprueba IDENTIDAD (compara rostros), no "prueba de vida".
// La UI no debe prometer más que eso.
//
// ──────────────────────────────────────────────────────────────────────────────
// CONTRATO DE PROPS (lo consume la pantalla /mi-perfil — mantenerlo EXACTO):
//   biometrico: boolean
//       ¿El empleado ya otorgó el consentimiento BIOMÉTRICO (guardar su foto como evidencia)?
//       Sin él NO se enciende la cámara.
//   facial: boolean
//       ¿Ya otorgó el consentimiento de VERIFICACIÓN FACIAL (comparar su rostro 1:1 contra la
//       plantilla registrada)? Sin él NO se enciende la cámara. La cámara exige AMBOS.
//   onPedirConsentimiento: (tipo: "biometrico" | "facial") => void | Promise<void>
//       El padre otorga ESE consentimiento (POST /api/rrhh/consentimiento) y actualiza su
//       estado. Se invoca con el tipo que falta — desde el aviso de la UI y también cuando el
//       servidor lo exige (403 { requiere_consentimiento }).
//   onMarcada?: () => void
//       Aviso de que se registró una marca (sin argumentos), para que el padre refresque
//       "Mis asistencias".
// ──────────────────────────────────────────────────────────────────────────────

import { useCallback, useEffect, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { validarMarca, tipoSiguiente } from "@/lib/rrhh/marcacion";
import { cargarConfigRrhh, marcasDeHoy, hoyLimaFecha } from "@/lib/rrhh/marcacion-datos";
import { coordValida } from "@/lib/cotizacion-ruta-coords";
import { cabecerasErp } from "@/lib/fetch-erp";
import { EVENTO_ENTRADA_MARCADA } from "@/lib/rrhh/fichador";
import type { ConfigRrhh, Marca, ResultadoJornada, TipoMarca } from "@/lib/rrhh/tipos";

const SQL = "supabase/rrhh-01-perfil-asistencia.sql";
/** Umbral del score de la caja de rostro para habilitar el botón (ámbar por debajo). */
const UMBRAL_ROSTRO = 0.5;
/** Config del detector tiny. Única fuente: la usan tanto el bucle del chip como el cálculo del
 *  descriptor al marcar, para que ambos midan el rostro igual. */
const DET_OPTS = { inputSize: 224, scoreThreshold: 0.3 };

const TIPO_LABEL: Record<TipoMarca, string> = {
  entrada: "Marcar entrada",
  salida_almuerzo: "Salida a almuerzo",
  regreso_almuerzo: "Regreso de almuerzo",
  salida: "Marcar salida",
};

type Geo = { lat: number; lng: number; precision_m: number | null };

export default function MarcarAsistencia({
  biometrico,
  facial,
  onPedirConsentimiento,
  onMarcada,
}: {
  biometrico: boolean;
  facial: boolean;
  onPedirConsentimiento: (tipo: "biometrico" | "facial") => void | Promise<void>;
  onMarcada?: () => void;
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
  const [cerrandoSesion, setCerrandoSesion] = useState(false);
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

  // ── Cámara + modelos de face-api (solo con AMBOS consentimientos otorgados) ──────────────
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
    // La cámara exige los DOS consentimientos; falta cualquiera → se pide, no se enciende.
    if (!biometrico) { void onPedirConsentimiento("biometrico"); return; }
    if (!facial) { void onPedirConsentimiento("facial"); return; }
    setCargandoModelos(true);
    try {
      // Import dinámico: face-api toca `window`/`document`, solo existe en el navegador.
      // Se pesan los tres modelos al encender la cámara: el detector + los de reconocimiento
      // (landmarks + descriptor) que hacen falta para calcular el descriptor 1:1.
      if (!faceapiRef.current) {
        const faceapi = await import("@vladmandic/face-api");
        await faceapi.nets.tinyFaceDetector.loadFromUri("/models");
        await faceapi.nets.faceLandmark68Net.loadFromUri("/models");
        await faceapi.nets.faceRecognitionNet.loadFromUri("/models");
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
      // Bucle de detección: actualiza el score de la caja de rostro (barato, solo el detector).
      const faceapi = faceapiRef.current;
      const opts = new faceapi.TinyFaceDetectorOptions(DET_OPTS);
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
  }, [biometrico, facial, onPedirConsentimiento, pedirUbicacion]);

  useEffect(() => () => detenerCamara(), [detenerCamara]);

  // ── Geocerca (pintado; el servidor la recomputa) ────────────────────────────────────────
  const sedeConfigurada = !!cfg && coordValida(cfg.sede_lat, cfg.sede_lng);
  const geocerca = geo && cfg ? validarMarca(geo, cfg) : null;
  const rostroOk = rostroScore != null && rostroScore >= UMBRAL_ROSTRO;
  const fueraBloquea = !!cfg?.geocerca_bloquea && !!geocerca && !geocerca.dentro_geocerca && sedeConfigurada;

  // El botón habilita con rostro válido y ubicación lista; la geocerca que BLOQUEA lo frena.
  const puedeMarcar = !!tipo && rostroOk && geoEstado === "ok" && !fueraBloquea && !enviando;

  // ── Capturar frame + descriptor y enviar ────────────────────────────────────────────────
  async function marcar() {
    if (!tipo || !geo) return;
    setEnviando(true); setResultado(null);
    try {
      const v = videoRef.current;
      let foto = "";
      // Descriptor facial (128 números) para la verificación 1:1. Si no se obtiene, se marca
      // igual: el servidor responderá 422 reintentable cuando la verificación facial esté activa.
      let descriptor: number[] | null = null;
      const faceapi = faceapiRef.current;
      if (v && v.videoWidth > 0) {
        const canvas = document.createElement("canvas");
        canvas.width = v.videoWidth; canvas.height = v.videoHeight;
        const ctx = canvas.getContext("2d");
        if (ctx) { ctx.drawImage(v, 0, 0, canvas.width, canvas.height); foto = canvas.toDataURL("image/jpeg", 0.8); }
      }
      if (faceapi && v && v.readyState >= 2) {
        try {
          const opts = new faceapi.TinyFaceDetectorOptions(DET_OPTS);
          const det = await faceapi.detectSingleFace(v, opts).withFaceLandmarks().withFaceDescriptor();
          if (det?.descriptor) descriptor = Array.from(det.descriptor);
        } catch {
          /* sin descriptor; el servidor lo resolverá (422 reintentable) */
        }
      }
      const res = await fetch("/api/rrhh/marcar", {
        method: "POST",
        headers: await cabecerasErp(),
        body: JSON.stringify({ tipo, lat: geo.lat, lng: geo.lng, precision_m: geo.precision_m, rostro_detectado: rostroOk, foto, descriptor }),
      });
      const data = await res.json().catch(() => ({}));

      // (a) Migración ausente: puede llegar con 422, así que va ANTES del 422 de rostro.
      if (data?.sin_migracion) { setSinMigracion(true); setResultado({ ok: false, mensaje: `Falta correr ${SQL}.` }); return; }

      // (b) 422 { no_se_detecto_rostro } — la cámara no captó bien. REINTENTABLE, no es bloqueo.
      if (res.status === 422 && data?.error === "no_se_detecto_rostro") {
        setResultado({ ok: false, mensaje: "No se captó bien tu rostro. Acércate, con buena luz, y vuelve a intentar." });
        return;
      }

      // (c) 403 { requiere_consentimiento: "facial" } — falta el consentimiento de verificación facial.
      if (res.status === 403 && data?.requiere_consentimiento === "facial") {
        setResultado({ ok: false, mensaje: "Necesitas dar tu consentimiento de verificación facial. También puedes pedirle a RRHH que te marque por PIN." });
        void onPedirConsentimiento("facial");
        return;
      }

      // (d) 403 { requiere_consentimiento: "biometrico" } — como hoy.
      if (res.status === 403 && data?.requiere_consentimiento === "biometrico") {
        setResultado({ ok: false, mensaje: "Necesitas dar tu consentimiento biométrico. También puedes pedirle a RRHH que te marque por PIN." });
        void onPedirConsentimiento("biometrico");
        return;
      }

      // (e) 403 { rostro_no_coincide } — la cara no coincide con la plantilla. NO es geocerca.
      if (res.status === 403 && data?.error === "rostro_no_coincide") {
        setResultado({ ok: false, mensaje: "El rostro no coincide con tu registro. Intenta de nuevo; si persiste, pide a Recursos Humanos que revise tu rostro de referencia." });
        return;
      }

      // (f) 409 { rostro_referencia_ilegible } — usa el mensaje que trae el servidor (pide re-registro).
      if (res.status === 409 && data?.error === "rostro_referencia_ilegible") {
        setResultado({ ok: false, mensaje: data?.mensaje ?? "No se pudo leer tu plantilla facial. Pide a Recursos Humanos que la vuelva a registrar; mientras tanto, marca con PIN." });
        return;
      }

      // (g) 503 — no se pudo verificar ahora.
      if (res.status === 503) {
        setResultado({ ok: false, mensaje: "No se pudo verificar ahora, intenta de nuevo." });
        return;
      }

      // (h) 403 restante — geocerca (el servidor devuelve una frase en español lista para mostrar).
      if (res.status === 403) {
        setResultado({ ok: false, mensaje: data?.error ?? "Estás fuera del área de la sede. Acércate para marcar." });
        return;
      }

      // (i) 409 restante — no corresponde marcar ahora / ya cerró la jornada.
      if (res.status === 409) { setResultado({ ok: false, mensaje: data?.error ?? "No corresponde marcar ahora." }); await recargar(); return; }

      if (!res.ok || !data?.ok) { setResultado({ ok: false, mensaje: data?.error ?? "No se pudo registrar la marca." }); return; }

      // ── Éxito ────────────────────────────────────────────────────────────────────────────
      // El hito lo DECIDE el `tipo` que devuelve el servidor, no el que se pidió.
      const tipoServidor = data.tipo as TipoMarca;
      setResultado({
        ok: true, tipo: tipoServidor, dentro: !!data.dentro_geocerca,
        distancia: data.distancia_m ?? null, fotoOmitida: !!data.foto_omitida, jornada: data.jornada ?? null,
      });
      // Entrada: avisa al layout para desbloquear sin recargar (EVENTO_ENTRADA_MARCADA).
      if (tipoServidor === "entrada") window.dispatchEvent(new Event(EVENTO_ENTRADA_MARCADA));
      onMarcada?.();
      detenerCamara();

      // SALIDA cierra la jornada → cierra sesión. El almuerzo (salida/regreso) NO.
      if (tipoServidor === "salida") {
        setCerrandoSesion(true);
        try { await supabase.auth.signOut(); }
        catch (error) { console.error("Error al cerrar sesión tras marcar salida:", error); }
        finally { window.location.href = "/login"; }
        return;
      }

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

  // Jornada cerrada: se está cerrando la sesión. Mensaje breve mientras redirige a /login.
  if (cerrandoSesion) {
    return (
      <div className="rounded-xl border border-emerald-200 bg-emerald-50 px-4 py-6 text-center text-sm font-semibold text-emerald-800">
        ✓ Jornada cerrada. Cerrando sesión…
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Consentimiento BIOMÉTRICO: va PRIMERO y sin él no se abre la cámara */}
      {!biometrico && (
        <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-indigo-800">🔒 Antes de marcar: consentimiento biométrico</p>
          <p className="text-xs text-indigo-900 leading-relaxed">
            Al marcar, la cámara <b>detecta tu rostro</b> y guarda una foto como evidencia — una <b>imagen del rostro</b>, que la Ley
            N.º 29733 de Protección de Datos Personales considera un <b>dato sensible</b>. La cámara solo confirma que hay un rostro:
            <b> no hace reconocimiento facial automático</b>. La foto queda como respaldo para que Recursos Humanos verifique la marca
            (y para disuadir que alguien fiche por otro), se guarda cifrada y de acceso restringido, y <b>puedes revocar</b> este permiso
            cuando quieras desde tu perfil.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={() => { void onPedirConsentimiento("biometrico"); }} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:opacity-90">
              Doy mi consentimiento y activo la cámara
            </button>
          </div>
          <p className="text-[11px] text-indigo-700">
            ¿Prefieres no usar la cámara? Recursos Humanos puede marcar tu asistencia por <b>PIN</b> — no necesitas este consentimiento para eso.
          </p>
        </div>
      )}

      {/* Consentimiento de VERIFICACIÓN FACIAL: ya hay biométrico, falta este. Sin él, tampoco cámara. */}
      {biometrico && !facial && (
        <div className="rounded-xl border-2 border-indigo-200 bg-indigo-50 p-4 space-y-2">
          <p className="text-xs font-black uppercase tracking-widest text-indigo-800">🧬 Antes de marcar: verificación facial</p>
          <p className="text-xs text-indigo-900 leading-relaxed">
            Para confirmar que <b>eres tú</b> quien marca, la cámara calcula una <b>plantilla de tu rostro</b> (una lista de números, no
            una foto) y la <b>compara 1:1</b> con la que quedó registrada la primera vez. Esto comprueba tu <b>identidad</b>;
            <b> no es una “prueba de vida”</b>. La plantilla, también <b>dato sensible</b> (Ley N.º 29733), se guarda cifrada y de acceso
            restringido, y <b>puedes revocar</b> este permiso cuando quieras desde tu perfil.
          </p>
          <div className="flex flex-wrap gap-2 pt-1">
            <button onClick={() => { void onPedirConsentimiento("facial"); }} className="px-4 py-2 rounded-lg bg-indigo-600 text-white text-xs font-bold hover:opacity-90">
              Doy mi consentimiento de verificación facial
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

          {/* Cámara — solo con AMBOS consentimientos */}
          {biometrico && facial && (
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
