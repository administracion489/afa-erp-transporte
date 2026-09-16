"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /redes — El agente que publica todos los días.
//
// LA PANTALLA NO JUZGA NADA POR SU CUENTA: importa `planDePublicacion`, el MISMO motor
// puro que usa el cron (lib/redes/despachar.ts). Lo que se lee aquí —«va a salir en
// tres de cinco, y en Instagram no porque sobran 340 caracteres»— es literalmente lo que
// va a pasar de madrugada. Una pantalla con su propia lógica de «esto saldrá» es el bug
// del semáforo de puntualidad: las dos mitades del tablero contradiciéndose.
//
// Y ENRUTA POR CÓDIGO, NO POR TEXTO: el título y el arreglo de cada motivo salen de
// `MOTIVO_TEXTO` en el catálogo. Redactarlos aquí sería una segunda versión que envejece
// sola y que acaba explicando distinto el mismo estado.
// ──────────────────────────────────────────────────────────────────────────────

import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabase";
import { fechaLima, minutoDelDiaLima } from "@/lib/alertas-horario";
import { planDePublicacion, hhmm, type CuentaConectada, type Media } from "@/lib/redes/plan";
import {
  ETIQUETA_MODO_VIDEO,
  ETIQUETA_RED,
  MODOS_VIDEO,
  MOTIVO_TEXTO,
  contarHashtags,
  largoTexto,
  type ModoVideo,
  type Red,
} from "@/lib/redes/tipos";
import { armarVideo, formatoDisponible, sirveParaInstagram } from "@/lib/redes/video";
import {
  AVISO_GUION,
  describirEscena,
  duracionGuion,
  guionPorDefecto,
  normalizarGuion,
  type Guion,
} from "@/lib/redes/guion";
import { empresaConDefectos } from "@/lib/empresa-perfil";
import PanelCuentas from "./PanelCuentas";
import PanelAjustes from "./PanelAjustes";

const input =
  "w-full border border-gray-200 rounded-xl px-3 py-2.5 text-sm focus:outline-none focus:ring-2 focus:ring-[#0b315f]/20";
const label = "block text-xs font-semibold text-gray-500 mb-1.5";
const btn = "px-4 py-2.5 rounded-xl text-sm font-semibold transition disabled:opacity-40";

const ICONO: Record<Red, string> = {
  facebook: "📘",
  instagram: "📸",
  tiktok: "🎵",
  youtube: "▶️",
  whatsapp_estado: "💬",
};

type Publicacion = {
  id: number;
  fecha: string;
  hora_programada_min: number;
  texto: string;
  titulo: string | null;
  imagen_url: string | null;
  /** Fotos ADICIONALES (columna de redes-02). La principal sigue siendo `imagen_url`. */
  imagenes: string[] | null;
  /** El storyboard normalizado (columna de redes-02). `null` = se monta el de defecto. */
  guion: Guion | null;
  guion_modelo: string | null;
  video_url: string | null;
  video_duracion_seg: number | null;
  modo_video: ModoVideo;
  redes: Red[];
  estado: "propuesta" | "aprobada" | "cerrada" | "descartada";
  origen: string;
  ia_tema: string | null;
};

type DestinoFila = {
  red: Red;
  estado: string;
  motivo: string | null;
  detalle: string | null;
  url_publicacion: string | null;
  error: string | null;
};

/** Espejo exacto de `esUrlPublica` en lib/redes/despachar.ts. Ver el comentario de allá. */
function esUrlPublica(url: string | null | undefined): boolean {
  if (!url) return false;
  if (!/^https?:\/\//i.test(url)) return false;
  if (url.includes("/object/sign/") || url.includes("token=")) return false;
  return true;
}

export default function RedesPage() {
  const [tab, setTab] = useState<"hoy" | "historial" | "cuentas" | "ajustes">("hoy");
  const [faltaTabla, setFaltaTabla] = useState(false);
  const [cargando, setCargando] = useState(true);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);
  const [ocupado, setOcupado] = useState<string | null>(null);

  const [pub, setPub] = useState<Publicacion | null>(null);
  const [destinos, setDestinos] = useState<DestinoFila[]>([]);
  const [cuentas, setCuentas] = useState<CuentaConectada[]>([]);
  const [historial, setHistorial] = useState<Publicacion[]>([]);

  // Borrador local: lo que se está editando antes de guardar.
  const [texto, setTexto] = useState("");
  const [titulo, setTitulo] = useState("");
  const [modoVideo, setModoVideo] = useState<ModoVideo>("ninguno");
  const [redesOn, setRedesOn] = useState<Red[]>([]);
  const [sucio, setSucio] = useState(false);

  const [pctVideo, setPctVideo] = useState<number | null>(null);
  /**
   * El nombre que se estampa en el video. Sale de `empresa_perfil`, NUNCA de un literal:
   * este ERP se vende y un «AFA Transportes» escrito en el código saldría impreso en el
   * video de quien lo compre. Sin perfil llenado queda en `null` y el video sale sin
   * marca — mejor sin nombre que con el de otra empresa, igual que la autorización MTC.
   */
  const [marca, setMarca] = useState<string | null>(null);
  /** Lo que el SQL accesorio no dejó guardar, con el archivo nombrado. */
  const [faltaGuionSql, setFaltaGuionSql] = useState(false);
  // La pieza ampliada. Aprobar algo que solo se ve en una miniatura de 96 px es aprobar
  // a ciegas, y este módulo entero se sostiene sobre que una persona LO HAYA VISTO.
  const [ampliada, setAmpliada] = useState<{ tipo: "imagen" | "video"; url: string } | null>(null);
  const fileImg = useRef<HTMLInputElement>(null);
  const fileFoto = useRef<HTMLInputElement>(null);
  const fileVid = useRef<HTMLInputElement>(null);

  const hoy = fechaLima(Date.now());
  const aviso = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 5000);
  };

  // ── Carga ──────────────────────────────────────────────────────────────────
  const cargar = useCallback(async () => {
    setCargando(true);
    const { data, error } = await supabase
      .from("redes_publicaciones")
      .select("*")
      .eq("fecha", hoy)
      .neq("estado", "descartada")
      .maybeSingle();

    // Sin la migración corrida, se DICE nombrando el SQL en vez de fingir una pantalla
    // vacía: mismo patrón que `faltaCanales` en /configuracion/operaciones.
    if (error && /relation .* does not exist|schema cache/i.test(error.message)) {
      setFaltaTabla(true);
      setCargando(false);
      return;
    }

    const p = (data ?? null) as Publicacion | null;
    setPub(p);
    if (p) {
      setTexto(p.texto ?? "");
      setTitulo(p.titulo ?? "");
      setModoVideo(p.modo_video ?? "ninguno");
      setRedesOn(p.redes ?? []);
      setSucio(false);
      const { data: d } = await supabase
        .from("redes_destinos")
        .select("red, estado, motivo, detalle, url_publicacion, error")
        .eq("publicacion_id", p.id);
      setDestinos((d ?? []) as DestinoFila[]);
    } else {
      setDestinos([]);
      setRedesOn([]);
    }

    const { data: emp } = await supabase
      .from("empresa_perfil")
      .select("nombre, razon_social")
      .eq("id", 1)
      .maybeSingle();
    const e = empresaConDefectos(emp as any);
    setMarca(e.sinConfigurar ? null : e.nombre);

    const { data: c } = await supabase.from("redes_cuentas").select("red, vigente").eq("vigente", true);
    // La pantalla no ve tokens (la tabla no tiene política RLS permisiva para ellos):
    // lo que llega es qué redes están conectadas, que es lo que el motor necesita.
    setCuentas(((c ?? []) as any[]).map((x) => ({ red: x.red as Red, vigente: true, publicadas_hoy: 0 })));

    const { data: h } = await supabase
      .from("redes_publicaciones")
      .select("*")
      .neq("estado", "descartada")
      .order("fecha", { ascending: false })
      .limit(30);
    setHistorial((h ?? []) as Publicacion[]);
    setCargando(false);
  }, [hoy]);

  useEffect(() => {
    cargar();
  }, [cargar]);

  // ── El plan, con lo que hay EN PANTALLA ────────────────────────────────────
  //
  // Se juzga el borrador que se está editando, no la fila guardada. Es lo mismo que hace
  // `avisosDe` en /programacion: avisar contra lo que va a quedar guardado, porque
  // avisar contra la base significa descubrir el problema después de guardar.
  const plan = useMemo(() => {
    const imagen: Media | null = pub?.imagen_url
      ? { tipo: "imagen", url: pub.imagen_url, publica: esUrlPublica(pub.imagen_url) }
      : null;
    const video: Media | null = pub?.video_url
      ? {
          tipo: "video",
          url: pub.video_url,
          publica: esUrlPublica(pub.video_url),
          duracion_seg: pub.video_duracion_seg,
        }
      : null;
    return planDePublicacion({
      publicacion: {
        texto,
        imagen,
        video,
        modo_video: modoVideo,
        redes: redesOn,
        aprobada: pub?.estado === "aprobada" || pub?.estado === "cerrada",
        hora_programada_min: pub?.hora_programada_min ?? 480,
        ya_publicadas: destinos
          .filter((d) => d.estado === "publicado" || d.estado === "preparado")
          .map((d) => d.red),
      },
      cuentas,
      ahora_min: minutoDelDiaLima(Date.now()),
    });
  }, [texto, modoVideo, redesOn, pub, destinos, cuentas]);

  // ── Acciones ───────────────────────────────────────────────────────────────
  async function llamar(ruta: string, body: any): Promise<any> {
    const { data: s } = await supabase.auth.getSession();
    const res = await fetch(ruta, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${s.session?.access_token ?? ""}`,
      },
      body: JSON.stringify(body),
    });
    return res.json();
  }

  async function proponer(instruccion?: string) {
    setOcupado("proponer");
    const r = await llamar("/api/redes/proponer", { fecha: hoy, instruccion, rehacer: true });
    setOcupado(null);
    if (r?.ok) {
      aviso("Propuesta lista. Revísala antes de aprobar.");
      cargar();
    } else aviso(r?.error ?? "No se pudo redactar la propuesta.", false);
  }

  async function guardarBorrador() {
    if (!pub) return;
    setOcupado("guardar");
    const { error } = await supabase
      .from("redes_publicaciones")
      .update({
        texto,
        titulo: titulo || null,
        modo_video: modoVideo,
        redes: redesOn,
        actualizado_en: new Date().toISOString(),
      })
      .eq("id", pub.id);
    setOcupado(null);
    if (error) aviso(error.message, false);
    else {
      setSucio(false);
      aviso("Guardado.");
      cargar();
    }
  }

  async function aprobarYPublicar() {
    if (!pub) return;
    if (sucio) {
      aviso("Guarda los cambios antes de aprobar: se publicaría el texto anterior.", false);
      return;
    }
    const salen = plan.publican.map((r) => ETIQUETA_RED[r]);
    const manual = plan.destinos.filter((d) => d.motivo === "publicacion_manual").map((d) => ETIQUETA_RED[d.red]);
    // Se NOMBRA lo que va a salir y dónde. «¿Estás seguro?» no da ninguna información;
    // esto deja ver si el operador esperaba cuatro redes y solo salen dos.
    const resumen =
      (salen.length ? `Se va a publicar en: ${salen.join(", ")}.` : "No hay ninguna red lista para publicar.") +
      (manual.length ? `\n\nSe te mandará al celular para publicar a mano: ${manual.join(", ")}.` : "");
    if (!confirm(`${resumen}\n\nUna publicación no se puede despublicar. ¿Continuar?`)) return;

    setOcupado("aprobar");
    const a = await llamar("/api/redes/aprobar", { publicacion_id: pub.id, accion: "aprobar" });
    if (!a?.ok) {
      setOcupado(null);
      aviso(a?.error ?? "No se pudo aprobar.", false);
      return;
    }
    const p = await llamar("/api/redes/publicar", { fecha: hoy, ahora: true });
    setOcupado(null);
    if (p?.error) aviso(p.error, false);
    else {
      const n = (p?.publicadas?.length ?? 0) + (p?.preparadas?.length ?? 0);
      aviso(n ? `Listo: ${n} salida(s).` : "Aprobada. Revisa el detalle por red.");
    }
    cargar();
  }

  async function descartar() {
    if (!pub) return;
    if (!confirm("La propuesta de hoy se descarta y podrás pedir otra. ¿Seguir?")) return;
    setOcupado("descartar");
    const r = await llamar("/api/redes/aprobar", { publicacion_id: pub.id, accion: "descartar" });
    setOcupado(null);
    if (r?.ok) {
      aviso("Descartada.");
      cargar();
    } else aviso(r?.error ?? "No se pudo descartar.", false);
  }

  // ── Piezas ─────────────────────────────────────────────────────────────────
  //
  // Las columnas de `redes-02` son ACCESORIAS: sin ellas la pantalla sigue entera y solo
  // se pierde guardar el guion y las fotos de más. Se SUELTA LA COLUMNA QUE EL ERROR
  // NOMBRA, no un juego fijo — mismo patrón que `COLUMNAS_OPCIONALES` en reservas: con un
  // juego fijo, cualquier otra columna opcional en el patch mataría el guardado entero y
  // el mensaje acusaría al SQL equivocado.
  const COLS_OPCIONALES = ["imagenes", "guion", "guion_modelo"] as const;

  async function guardarPub(
    patch: Record<string, any>,
  ): Promise<{ ok: boolean; error?: string; soltadas: string[] }> {
    if (!pub) return { ok: false, error: "No hay publicación de hoy.", soltadas: [] };
    let cuerpo: Record<string, any> = { ...patch, actualizado_en: new Date().toISOString() };
    const soltadas: string[] = [];
    for (let i = 0; i <= COLS_OPCIONALES.length; i++) {
      const { error } = await supabase.from("redes_publicaciones").update(cuerpo).eq("id", pub.id);
      if (!error) return { ok: true, soltadas };
      const col = COLS_OPCIONALES.find(
        (c) =>
          c in cuerpo &&
          new RegExp(`column .*${c}.* does not exist|'${c}' column`, "i").test(error.message),
      );
      if (!col) return { ok: false, error: error.message, soltadas };
      delete cuerpo[col];
      soltadas.push(col);
      if (!Object.keys(cuerpo).filter((k) => k !== "actualizado_en").length) break;
    }
    return { ok: false, error: "No se pudo guardar.", soltadas };
  }

  async function subirArchivo(file: File, tipo: "imagen" | "video"): Promise<string | null> {
    if (!pub) return null;
    const ext = file.name.split(".").pop() || (tipo === "imagen" ? "jpg" : "mp4");
    const ruta = `${pub.fecha}/${tipo}-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.${ext}`;
    const { error } = await supabase.storage
      .from("redes-publicaciones")
      .upload(ruta, file, { upsert: true, contentType: file.type || undefined });
    if (error) {
      aviso(`No se pudo subir: ${error.message}`, false);
      return null;
    }
    // URL PÚBLICA, no firmada: Facebook e Instagram DESCARGAN el archivo desde aquí, y
    // una signed URL caduca. Es la razón de que este bucket sea público (ver el SQL).
    return supabase.storage.from("redes-publicaciones").getPublicUrl(ruta).data.publicUrl;
  }

  async function subir(file: File, tipo: "imagen" | "video", duracionSeg?: number) {
    if (!pub) return;
    setOcupado("subir");
    const url = await subirArchivo(file, tipo);
    if (!url) {
      setOcupado(null);
      return;
    }
    const patch =
      tipo === "imagen"
        ? { imagen_url: url }
        : { video_url: url, video_duracion_seg: duracionSeg ?? null };
    const r = await guardarPub(patch);
    setOcupado(null);
    if (!r.ok) aviso(r.error ?? "No se pudo guardar.", false);
    else aviso(tipo === "imagen" ? "Imagen lista." : "Video listo.");
    cargar();
  }

  /**
   * Una foto MÁS para el video. No toca `imagen_url`: esa es la que se publica en
   * Facebook e Instagram cuando no hay video, y pisarla al añadir una foto de apoyo
   * cambiaría lo que sale publicado sin que nadie lo pidiera.
   */
  async function agregarFoto(file: File) {
    if (!pub) return;
    setOcupado("subir");
    const url = await subirArchivo(file, "imagen");
    if (!url) {
      setOcupado(null);
      return;
    }
    const r = await guardarPub({ imagenes: [...(pub.imagenes ?? []), url] });
    setOcupado(null);
    if (r.soltadas.includes("imagenes")) {
      setFaltaGuionSql(true);
      aviso(
        "La foto se subió pero no se pudo guardar: falta correr supabase/redes-02-guion-video.sql.",
        false,
      );
    } else if (!r.ok) aviso(r.error ?? "No se pudo guardar.", false);
    else aviso("Foto agregada al video.");
    cargar();
  }

  async function quitarFoto(url: string) {
    if (!pub) return;
    setOcupado("quitar");
    const r = await guardarPub({ imagenes: (pub.imagenes ?? []).filter((u) => u !== url) });
    setOcupado(null);
    if (!r.ok) aviso(r.error ?? "No se pudo guardar.", false);
    cargar();
  }

  /**
   * Quita el video del día. NO borra el archivo del bucket: la publicación puede estar
   * ya despachada en otra red y su enlace tiene que seguir sirviendo — borrar el objeto
   * dejaría un video roto en TikTok o en YouTube. Aquí solo se suelta la referencia.
   */
  async function quitarVideo() {
    if (!pub) return;
    if (!confirm("Se quita el video de esta publicación. Podrás armar otro o subir el tuyo. ¿Seguir?")) return;
    setOcupado("quitar");
    const { error } = await supabase
      .from("redes_publicaciones")
      .update({ video_url: null, video_duracion_seg: null, actualizado_en: new Date().toISOString() })
      .eq("id", pub.id);
    setOcupado(null);
    if (error) aviso(error.message, false);
    else {
      aviso("Video quitado.");
      cargar();
    }
  }

  const formatoVid = typeof window !== "undefined" ? formatoDisponible() : null;

  /** Las fotos del video: la principal primero, después las de apoyo, sin repetir. */
  const fotos = useMemo(
    () =>
      [pub?.imagen_url, ...(pub?.imagenes ?? [])]
        .filter((u): u is string => !!u)
        .filter((u, i, a) => a.indexOf(u) === i),
    [pub?.imagen_url, pub?.imagenes],
  );

  /**
   * El guion con el que se va a montar. Se resuelve AQUÍ y una sola vez, para que lo que
   * enseña el panel sea exactamente lo que va a pintar `armarVideo` — dos ideas distintas
   * de «cómo queda el video» es el bug del semáforo de puntualidad otra vez.
   *
   * Se normaliza también el guardado: el texto o las fotos pueden haber cambiado desde
   * que se escribió, y un índice que ya no existe tiene que darse la vuelta antes de
   * llegar al canvas, no dentro de él.
   */
  const guionInfo = useMemo(() => {
    const opts = { texto, imagenes: fotos, marca: marca ?? undefined };
    if (pub?.guion?.escenas?.length) {
      const n = normalizarGuion(pub.guion, opts);
      return { guion: n.guion, avisos: n.avisos, escrito: true };
    }
    return { guion: guionPorDefecto(opts), avisos: [], escrito: false };
  }, [pub?.guion, texto, fotos, marca]);

  async function escribirGuion(instruccion?: string) {
    if (!pub) return;
    setOcupado("guion");
    const r = await llamar("/api/redes/guion", { publicacion_id: pub.id, instruccion });
    setOcupado(null);
    if (!r?.ok) {
      aviso(r?.error ?? "No se pudo escribir el guion.", false);
      return;
    }
    if (r.no_guardado) {
      // El guion es bueno; lo que falta es dónde guardarlo. Se deja en memoria para poder
      // montarlo AHORA y se dice qué se pierde al recargar, en vez de callarlo.
      setFaltaGuionSql(true);
      setPub((p) => (p ? { ...p, guion: r.guion } : p));
      aviso(r.no_guardado, false);
      return;
    }
    setFaltaGuionSql(false);
    const extra = r.avisos?.length ? ` ${r.avisos.join(" ")}` : "";
    aviso(`Guion listo: ${r.guion?.escenas?.length ?? 0} escenas.${extra}`);
    cargar();
  }

  async function generarVideo() {
    if (!fotos.length) {
      aviso("Sube primero una foto: el video se monta sobre las imágenes.", false);
      return;
    }
    setOcupado("video");
    setPctVideo(0);
    const r = await armarVideo({
      guion: guionInfo.guion,
      imagenes: fotos,
      onProgreso: (p) => setPctVideo(p),
    });
    setPctVideo(null);
    if (!r.ok || !r.blob) {
      setOcupado(null);
      aviso(r.error ?? "No se pudo armar el video.", false);
      return;
    }
    setOcupado(null);
    // El aviso NO cancela la subida: el archivo existe y puede estar perfecto. Se dice y
    // se deja que lo juzgue quien lo va a ver, que es para lo que está el reproductor.
    if (r.aviso) aviso(r.aviso, false);
    await subir(
      new File([r.blob], `reel.${r.ext}`, { type: r.blob.type }),
      "video",
      r.duracionSeg ?? undefined,
    );
  }

  // ── Render ─────────────────────────────────────────────────────────────────
  if (faltaTabla) {
    return (
      <div className="p-6 max-w-3xl">
        <h1 className="text-2xl font-bold text-[#0b315f] mb-4">Redes sociales</h1>
        <div className="rounded-2xl border border-amber-200 bg-amber-50 p-5 text-sm text-amber-900">
          <p className="font-semibold mb-2">Falta correr la migración.</p>
          <p>
            Este módulo necesita <code className="bg-white px-1.5 py-0.5 rounded">supabase/redes-01-publicaciones.sql</code>.
            El despliegue no la corre: hay que ejecutarla una vez en Supabase → SQL Editor.
          </p>
          <p className="mt-2 text-amber-800">
            Hasta entonces la pantalla no puede guardar nada, y prefiere decirlo antes que aparentar que sí.
          </p>
        </div>
      </div>
    );
  }

  return (
    <div className="p-6 max-w-6xl">
      <div className="flex items-center justify-between mb-1">
        <h1 className="text-2xl font-bold text-[#0b315f]">Redes sociales</h1>
        <div className="text-xs text-gray-400">{hoy} · hora de Lima</div>
      </div>
      <p className="text-sm text-gray-500 mb-5">
        La IA propone el texto del día; tú lo apruebas y se publica. Nada sale sin tu firma.
      </p>

      <div className="flex gap-1 border-b border-gray-200 mb-5">
        {(
          [
            ["hoy", "Hoy"],
            ["historial", "Historial"],
            ["cuentas", "Cuentas"],
            ["ajustes", "Ajustes"],
          ] as const
        ).map(([k, t]) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={`px-4 py-2.5 text-sm font-semibold border-b-2 -mb-px transition ${
              tab === k ? "border-[#0b315f] text-[#0b315f]" : "border-transparent text-gray-400 hover:text-gray-600"
            }`}
          >
            {t}
          </button>
        ))}
      </div>

      {toast && (
        <div
          className={`mb-4 rounded-xl px-4 py-3 text-sm ${
            toast.ok ? "bg-green-50 text-green-800 border border-green-200" : "bg-red-50 text-red-800 border border-red-200"
          }`}
        >
          {toast.msg}
        </div>
      )}

      {tab === "cuentas" && <PanelCuentas onCambio={cargar} />}
      {tab === "ajustes" && <PanelAjustes />}

      {tab === "historial" && (
        <div className="rounded-2xl border border-gray-200 overflow-hidden">
          <table className="w-full text-sm">
            <thead className="bg-gray-50 text-gray-500 text-xs">
              <tr>
                <th className="text-left px-4 py-2.5">Fecha</th>
                <th className="text-left px-4 py-2.5">Tema</th>
                <th className="text-left px-4 py-2.5">Texto</th>
                <th className="text-left px-4 py-2.5">Estado</th>
              </tr>
            </thead>
            <tbody>
              {historial.map((h) => (
                <tr key={h.id} className="border-t border-gray-100">
                  <td className="px-4 py-2.5 whitespace-nowrap">{h.fecha}</td>
                  <td className="px-4 py-2.5 text-gray-500">{h.ia_tema ?? "—"}</td>
                  <td className="px-4 py-2.5 text-gray-600 max-w-md truncate">{h.texto}</td>
                  <td className="px-4 py-2.5">
                    <span className="text-xs px-2 py-1 rounded-lg bg-gray-100 text-gray-600">{h.estado}</span>
                  </td>
                </tr>
              ))}
              {!historial.length && (
                <tr>
                  <td colSpan={4} className="px-4 py-8 text-center text-gray-400">
                    Todavía no hay publicaciones.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}

      {tab === "hoy" && (
        <>
          {cargando && <div className="text-sm text-gray-400 py-8">Cargando…</div>}

          {!cargando && !pub && (
            <div className="rounded-2xl border border-gray-200 p-8 text-center">
              <p className="text-gray-500 mb-4">No hay propuesta para hoy.</p>
              <button
                onClick={() => proponer()}
                disabled={ocupado !== null}
                className={`${btn} bg-[#0b315f] text-white`}
              >
                {ocupado === "proponer" ? "Redactando…" : "Pedirle una a la IA"}
              </button>
              {!cuentas.length && (
                <p className="mt-4 text-xs text-amber-700">
                  Todavía no hay ninguna red conectada. Puedes redactar igual, pero no saldrá a ningún sitio
                  hasta que conectes al menos una en la pestaña <b>Cuentas</b>.
                </p>
              )}
            </div>
          )}

          {!cargando && pub && (
            <div className="grid lg:grid-cols-[1fr_380px] gap-5">
              {/* ── Editor ── */}
              <div className="space-y-4">
                <div className="rounded-2xl border border-gray-200 p-5">
                  <div className="flex items-center justify-between mb-3">
                    <label className={label + " mb-0"}>Texto de la publicación</label>
                    <span className="text-xs text-gray-400">
                      {largoTexto(texto)} car. · {contarHashtags(texto)} hashtags
                    </span>
                  </div>
                  <textarea
                    value={texto}
                    onChange={(e) => {
                      setTexto(e.target.value);
                      setSucio(true);
                    }}
                    rows={9}
                    className={input + " font-normal leading-relaxed"}
                    disabled={pub.estado === "cerrada"}
                  />

                  <div className="mt-4">
                    <label className={label}>Título (solo YouTube · máx. 100)</label>
                    <input
                      value={titulo}
                      onChange={(e) => {
                        setTitulo(e.target.value);
                        setSucio(true);
                      }}
                      maxLength={100}
                      className={input}
                      placeholder="Si lo dejas vacío se usa la primera línea del texto"
                      disabled={pub.estado === "cerrada"}
                    />
                  </div>
                </div>

                {/* ── Pieza ── */}
                <div className="rounded-2xl border border-gray-200 p-5">
                  <label className={label}>Imagen del día</label>
                  <div className="flex items-center gap-3">
                    {pub.imagen_url ? (
                      // Clicable: lo que se aprueba hay que poder VERLO al tamaño en que
                      // lo va a ver el cliente, no en una miniatura.
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={pub.imagen_url}
                        alt="Imagen de la publicación"
                        onClick={() => setAmpliada({ tipo: "imagen", url: pub.imagen_url! })}
                        className="h-24 w-24 object-cover rounded-xl border cursor-zoom-in hover:opacity-90 transition"
                      />
                    ) : (
                      <div className="h-24 w-24 rounded-xl border border-dashed grid place-items-center text-gray-300 text-xs">
                        sin imagen
                      </div>
                    )}
                    <div>
                      <input
                        ref={fileImg}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => e.target.files?.[0] && subir(e.target.files[0], "imagen")}
                      />
                      <button onClick={() => fileImg.current?.click()} className={`${btn} bg-gray-100 text-gray-700`}>
                        {pub.imagen_url ? "Cambiar" : "Subir imagen"}
                      </button>
                      {pub.imagen_url && (
                        <button
                          onClick={() => setAmpliada({ tipo: "imagen", url: pub.imagen_url! })}
                          className={`${btn} bg-transparent text-[#0b315f] underline px-2`}
                        >
                          Ver grande
                        </button>
                      )}
                      <p className="mt-1 text-xs text-gray-400">
                        Es la que se publica en Facebook e Instagram cuando no hay video.
                      </p>
                    </div>
                  </div>

                  {/* ── Fotos de apoyo: SOLO para el video ──
                      Un video de una sola foto es un póster con zoom, que es exactamente
                      lo que había. Cada foto de más es una escena que puede estrenar
                      imagen. No tocan lo que se publica como post: para eso está la de
                      arriba. */}
                  <div className="mt-4">
                    <label className={label}>Fotos de apoyo (solo para el video)</label>
                    <div className="flex flex-wrap items-center gap-2">
                      {(pub.imagenes ?? []).map((u) => (
                        <div key={u} className="relative">
                          {/* eslint-disable-next-line @next/next/no-img-element */}
                          <img
                            src={u}
                            alt="Foto de apoyo"
                            onClick={() => setAmpliada({ tipo: "imagen", url: u })}
                            className="h-16 w-16 object-cover rounded-lg border cursor-zoom-in"
                          />
                          <button
                            onClick={() => quitarFoto(u)}
                            disabled={ocupado !== null || pub.estado === "cerrada"}
                            title="Quitar esta foto"
                            className="absolute -top-1.5 -right-1.5 h-5 w-5 rounded-full bg-white border text-red-600 text-xs leading-none shadow"
                          >
                            ✕
                          </button>
                        </div>
                      ))}
                      <input
                        ref={fileFoto}
                        type="file"
                        accept="image/*"
                        hidden
                        onChange={(e) => {
                          const f = e.target.files?.[0];
                          e.target.value = "";
                          if (f) agregarFoto(f);
                        }}
                      />
                      <button
                        onClick={() => fileFoto.current?.click()}
                        disabled={ocupado !== null || pub.estado === "cerrada"}
                        className="h-16 w-16 rounded-lg border border-dashed text-gray-400 text-xl hover:text-gray-600 disabled:opacity-40"
                      >
                        +
                      </button>
                    </div>
                    <p className="mt-1.5 text-xs text-gray-400">
                      {fotos.length <= 1
                        ? "Con una sola foto el video es un zoom sobre ella. Con tres o cuatro, la IA puede repartir escenas."
                        : `${fotos.length} fotos disponibles para el guion.`}
                    </p>
                  </div>

                  <div className="mt-5 pt-5 border-t border-gray-100">
                    <label className={label}>Video de hoy</label>
                    <div className="space-y-2">
                      {MODOS_VIDEO.map((m) => (
                        <label key={m} className="flex items-start gap-2.5 cursor-pointer">
                          <input
                            type="radio"
                            checked={modoVideo === m}
                            onChange={() => {
                              setModoVideo(m);
                              setSucio(true);
                            }}
                            className="mt-1"
                            disabled={pub.estado === "cerrada"}
                          />
                          <div>
                            <div className="text-sm text-gray-700">{ETIQUETA_MODO_VIDEO[m]}</div>
                            <div className="text-xs text-gray-400">
                              {m === "ninguno" && "Salen Facebook e Instagram con la imagen. YouTube y TikTok no publican hoy."}
                              {m === "generado" &&
                                "Vertical 9:16 con varias escenas: la IA escribe el guion mirando tus fotos y se monta en este navegador."}
                              {m === "propio" && "Sube el archivo que grabaste. Es lo que mejor rinde en TikTok y Shorts."}
                            </div>
                          </div>
                        </label>
                      ))}
                    </div>

                    {modoVideo === "generado" && (
                      <div className="mt-3">
                        {!formatoVid ? (
                          <p className="text-xs text-amber-700">
                            Este navegador no puede grabar video. Usa Chrome o Edge, o elige «video propio».
                          </p>
                        ) : (
                          <>
                            {/* ── EL GUION ──
                                Ningún modelo de Anthropic genera video: lo que la IA
                                aporta es la DIRECCIÓN sobre las fotos que ya hay. El panel
                                enseña el guion ANTES de montar, porque es lo único que
                                permite corregirlo cuando cuesta un clic y no veinte
                                segundos de grabación. */}
                            <div className="rounded-xl border border-gray-200 bg-gray-50/70 p-4">
                              <div className="flex items-start justify-between gap-3">
                                <div>
                                  <div className="text-sm font-semibold text-gray-700">
                                    Guion del video
                                    <span className="ml-2 font-normal text-xs text-gray-500">
                                      {guionInfo.guion.escenas.length} escena(s) ·{" "}
                                      {duracionGuion(guionInfo.guion)} s
                                    </span>
                                  </div>
                                  <div className="text-xs text-gray-500 mt-0.5">
                                    {guionInfo.escrito
                                      ? "Escrito por la IA mirando tus fotos."
                                      : "Reparto automático del texto por frases. La IA no lo ha escrito todavía."}
                                  </div>
                                </div>
                                <button
                                  onClick={() => escribirGuion()}
                                  disabled={ocupado !== null || !fotos.length || pub.estado === "cerrada"}
                                  className={`${btn} bg-[#0b315f] text-white py-2 shrink-0`}
                                >
                                  {ocupado === "guion"
                                    ? "Escribiendo…"
                                    : guionInfo.escrito
                                      ? "Otro guion"
                                      : "✨ Escribir guion"}
                                </button>
                              </div>

                              {/* El guion se LEE antes de montar. `describirEscena` vive en
                                  el módulo puro: una frase compuesta aquí puede describir
                                  al revés lo que hace el motor sin que nada falle. */}
                              <ol className="mt-3 space-y-1">
                                {guionInfo.guion.escenas.map((e, i) => (
                                  <li
                                    key={i}
                                    className={`text-xs ${e.tipo === "cierre" ? "text-gray-400" : "text-gray-600"}`}
                                  >
                                    {describirEscena(e, i)}
                                  </li>
                                ))}
                              </ol>

                              {guionInfo.avisos.map((c) => (
                                <p key={c} className="mt-2 text-xs text-amber-700">
                                  {AVISO_GUION[c]}
                                </p>
                              ))}

                              {!guionInfo.escrito && fotos.length > 0 && (
                                <p className="mt-2 text-xs text-gray-500">
                                  Puedes armarlo así, pero con el guion escrito cada escena dice algo de
                                  SU foto en vez de repartir el caption.
                                </p>
                              )}
                              {!fotos.length && (
                                <p className="mt-2 text-xs text-amber-700">
                                  Sube al menos una foto: el guion se escribe mirándolas.
                                </p>
                              )}
                              {faltaGuionSql && (
                                <p className="mt-2 text-xs text-amber-700">
                                  Falta correr{" "}
                                  <code className="bg-white px-1 py-0.5 rounded">
                                    supabase/redes-02-guion-video.sql
                                  </code>
                                  : el guion y las fotos de apoyo no se guardan y hay que pedirlos otra vez
                                  al recargar.
                                </p>
                              )}
                            </div>

                            <button
                              onClick={generarVideo}
                              disabled={ocupado !== null || !fotos.length}
                              className={`${btn} bg-gray-100 text-gray-700 mt-3`}
                            >
                              {pctVideo !== null
                                ? `Armando… ${Math.round(pctVideo * 100)}%`
                                : pub.video_url
                                  ? "Rehacer video"
                                  : "Armar video"}
                            </button>
                            {/* El botón deshabilitado DICE qué le falta. Antes solo se
                                apagaba y, al pulsarlo, un toast que se iba a los 5 s — el
                                operador se quedaba sin saber por qué no pasaba nada. */}
                            {!fotos.length && (
                              <p className="mt-2 text-xs text-amber-700">
                                Sube primero la imagen del día: el video se monta sobre ella.
                              </p>
                            )}
                            {pctVideo !== null && (
                              <p className="mt-2 text-xs text-gray-500">
                                Deja esta pestaña a la vista mientras se graba: en segundo plano el navegador
                                deja de pintar y el video sale con tramos congelados.
                              </p>
                            )}
                            {!sirveParaInstagram(formatoVid) && (
                              <p className="mt-2 text-xs text-amber-700">
                                Este navegador graba <b>{formatoVid.ext}</b>, que TikTok y YouTube aceptan pero
                                Instagram no. Para que entre en Instagram, ármalo desde Chrome o Edge.
                              </p>
                            )}
                          </>
                        )}
                      </div>
                    )}

                    {modoVideo === "propio" && (
                      <div className="mt-3">
                        <input
                          ref={fileVid}
                          type="file"
                          accept="video/*"
                          hidden
                          onChange={(e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            // La duración se MIDE aquí: el motor la usa para saber si entra en
                            // cada red, y sin medirla no se afirma nada (queda en null).
                            const v = document.createElement("video");
                            v.preload = "metadata";
                            v.onloadedmetadata = () => {
                              URL.revokeObjectURL(v.src);
                              subir(f, "video", Math.round(v.duration) || undefined);
                            };
                            v.onerror = () => subir(f, "video");
                            v.src = URL.createObjectURL(f);
                          }}
                        />
                        <button onClick={() => fileVid.current?.click()} className={`${btn} bg-gray-100 text-gray-700`}>
                          {pub.video_url ? "Cambiar video" : "Subir video"}
                        </button>
                      </div>
                    )}

                    {/* EL VIDEO SE VE AQUÍ, no en otra pestaña.
                        Antes solo había un enlace «Verlo», y eso convertía «Aprobar y
                        publicar» en firmar algo que no se había mirado — que es
                        exactamente lo que este módulo existe para no hacer. El
                        `controls` deja reproducirlo en el sitio; `key` fuerza a recargar
                        el <video> cuando se rehace (misma etiqueta, otra URL). */}
                    {pub.video_url && (
                      <div className="mt-3 flex items-start gap-3">
                        <video
                          key={pub.video_url}
                          src={pub.video_url}
                          controls
                          playsInline
                          preload="metadata"
                          className="w-36 rounded-xl border bg-black aspect-[9/16] object-cover"
                        />
                        <div className="text-xs text-gray-500 space-y-1.5">
                          <div>
                            Video listo
                            {pub.video_duracion_seg ? ` · ${pub.video_duracion_seg} s` : ""} · vertical 9:16
                          </div>
                          <div className="text-gray-400">Revísalo antes de aprobar: es lo que va a salir.</div>
                          <div className="flex flex-wrap gap-2 pt-1">
                            <button
                              onClick={() => setAmpliada({ tipo: "video", url: pub.video_url! })}
                              className={`${btn} bg-gray-100 text-gray-700 py-1.5`}
                            >
                              Ver grande
                            </button>
                            <button
                              onClick={quitarVideo}
                              disabled={ocupado !== null || pub.estado === "cerrada"}
                              className={`${btn} bg-gray-100 text-red-600 py-1.5`}
                            >
                              Quitar
                            </button>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                </div>

                <div className="flex flex-wrap gap-2">
                  <button
                    onClick={guardarBorrador}
                    disabled={!sucio || ocupado !== null || pub.estado === "cerrada"}
                    className={`${btn} bg-gray-100 text-gray-700`}
                  >
                    {ocupado === "guardar" ? "Guardando…" : "Guardar cambios"}
                  </button>
                  <button
                    onClick={() => proponer()}
                    disabled={ocupado !== null || pub.estado === "cerrada"}
                    className={`${btn} bg-gray-100 text-gray-700`}
                  >
                    {ocupado === "proponer" ? "Redactando…" : "Proponer otro texto"}
                  </button>
                  <button
                    onClick={descartar}
                    disabled={ocupado !== null || pub.estado === "cerrada"}
                    className={`${btn} bg-gray-100 text-red-600`}
                  >
                    Descartar
                  </button>
                  <div className="flex-1" />
                  <button
                    onClick={aprobarYPublicar}
                    disabled={ocupado !== null || pub.estado === "cerrada"}
                    className={`${btn} bg-[#0b315f] text-white`}
                  >
                    {ocupado === "aprobar" ? "Publicando…" : "Aprobar y publicar"}
                  </button>
                </div>
                {sucio && (
                  <p className="text-xs text-amber-700">
                    Hay cambios sin guardar. El plan de la derecha ya los tiene en cuenta; lo que se publicaría
                    todavía no.
                  </p>
                )}
              </div>

              {/* ── El plan por red ── */}
              <div className="space-y-3">
                <div className="rounded-2xl border border-gray-200 overflow-hidden">
                  <div className="px-4 py-3 bg-gray-50 text-xs font-semibold text-gray-500">
                    QUÉ VA A PASAR EN CADA RED
                  </div>
                  <div className="divide-y divide-gray-100">
                    {plan.destinos.map((d) => {
                      const guardado = destinos.find((x) => x.red === d.red);
                      const txt = MOTIVO_TEXTO[d.motivo];
                      const problema = plan.con_problema.includes(d.red);
                      const salio = guardado?.estado === "publicado" || guardado?.estado === "preparado";
                      return (
                        <div key={d.red} className="px-4 py-3">
                          <div className="flex items-start gap-2.5">
                            <span className="text-lg leading-none mt-0.5">{ICONO[d.red]}</span>
                            <div className="flex-1 min-w-0">
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-sm font-semibold text-gray-700">{ETIQUETA_RED[d.red]}</span>
                                <label className="flex items-center gap-1.5 text-xs text-gray-400 cursor-pointer">
                                  <input
                                    type="checkbox"
                                    checked={redesOn.includes(d.red)}
                                    onChange={(e) => {
                                      setRedesOn((prev) =>
                                        e.target.checked ? [...prev, d.red] : prev.filter((x) => x !== d.red),
                                      );
                                      setSucio(true);
                                    }}
                                    disabled={pub.estado === "cerrada" || salio}
                                  />
                                  usar
                                </label>
                              </div>

                              <div
                                className={`mt-1 text-xs ${
                                  salio
                                    ? "text-green-700"
                                    : d.publica
                                      ? "text-green-700"
                                      : problema
                                        ? "text-amber-700"
                                        : "text-gray-400"
                                }`}
                              >
                                {salio
                                  ? guardado?.estado === "publicado"
                                    ? "✓ Publicado"
                                    : "✓ Pieza enviada a tu celular"
                                  : `${d.publica ? "✓ " : ""}${txt.titulo}`}
                              </div>

                              {!salio && d.detalle && <div className="mt-0.5 text-xs text-gray-400">{d.detalle}</div>}
                              {!salio && problema && txt.arreglo && (
                                <div className="mt-1 text-xs text-amber-600">{txt.arreglo}</div>
                              )}
                              {guardado?.error && (
                                <div className="mt-1 text-xs text-red-600 break-words">{guardado.error}</div>
                              )}
                              {guardado?.detalle && salio && (
                                <div className="mt-1 text-xs text-blue-700">{guardado.detalle}</div>
                              )}
                              {guardado?.url_publicacion && (
                                <a
                                  href={guardado.url_publicacion}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="mt-1 inline-block text-xs text-[#0b315f] underline"
                                >
                                  Ver publicación
                                </a>
                              )}
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                </div>

                <div className="rounded-2xl border border-gray-200 p-4 text-xs text-gray-500 space-y-1.5">
                  <div>
                    Hora programada: <b className="text-gray-700">{hhmm(pub.hora_programada_min ?? 480)}</b>
                  </div>
                  <div>
                    Estado: <b className="text-gray-700">{pub.estado}</b>
                    {pub.origen === "ia" && " · redactada por IA"}
                  </div>
                  <div className="pt-2 border-t border-gray-100 text-gray-400">
                    El estado de WhatsApp no tiene API: el agente te manda la pieza al celular y la publicas
                    desde el número de atención al cliente, que es el que tus clientes tienen guardado.
                  </div>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {/* ── La pieza a tamaño de revisión ──
          El video se pinta en 9:16 con alto acotado al viewport, que es la forma en la
          que lo va a ver quien lo reciba. `autoPlay` + `controls`: se aprueba lo que se
          acaba de ver, no lo que uno recuerda haber subido. */}
      {ampliada && (
        <div
          onClick={() => setAmpliada(null)}
          className="fixed inset-0 z-50 bg-black/80 grid place-items-center p-6"
        >
          <div onClick={(e) => e.stopPropagation()} className="max-h-full flex flex-col items-center gap-3">
            {ampliada.tipo === "video" ? (
              <video
                src={ampliada.url}
                controls
                autoPlay
                loop
                playsInline
                className="max-h-[80vh] rounded-2xl bg-black"
              />
            ) : (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={ampliada.url} alt="Pieza de la publicación" className="max-h-[80vh] rounded-2xl" />
            )}
            <div className="flex items-center gap-3">
              <a
                href={ampliada.url}
                target="_blank"
                rel="noreferrer"
                className="text-xs text-white/70 underline hover:text-white"
              >
                Abrir en otra pestaña
              </a>
              <button
                onClick={() => setAmpliada(null)}
                className="px-4 py-2 rounded-xl text-sm font-semibold bg-white text-gray-800"
              >
                Cerrar
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
