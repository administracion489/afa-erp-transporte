"use client";
// components/combustible/FacturaDelCorreo.tsx — LA FACTURA DEL CORREO que respalda una carga (o que
// espera a una recarga del Radar), con su documento a un clic (lib/combustible/factura-de-carga.ts).
//
// Lo pidió el dueño sobre el recuadro de fusión del Radar: «falta un link hacia el correo que se leyó,
// para poder revisar el documento». Tres piezas:
//   • `FacturaDelCorreo`: QUÉ factura es (comprobante, emisor, emisión, cuándo llegó, de dónde salieron
//     los números) y SU línea, buscada con lo que la conciliación dejó escrito — nunca por parecido.
//   • `BotonesFactura`: «📄 Ver la factura» (el ERP baja el PDF del correo con su credencial: sirve a
//     cualquier operador, tenga o no esa cuenta abierta) y «✉ Abrir el correo en Gmail» (en la cuenta
//     del buzón conectado, no en la primera del navegador).
//   • `VisorFactura`: el documento en la misma pantalla. El TIPO con que se enseña lo pone la pantalla
//     (tipoParaMostrar): un PDF como PDF y un XML como texto, nunca lo que diga el archivo.

import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { supabase } from "@/lib/supabase";
import { cabecerasErp } from "@/lib/fetch-erp";
import {
  elegirFacturaDeCarga, elegirFacturaQueEspera, filtroFacturaQueEspera, referenciaFacturaDeCarga,
  enlaceGmail, fuenteDeLectura, rotuloFactura, tipoParaMostrar,
  type FacturaGuardada, type FacturaYLinea,
} from "@/lib/combustible/factura-de-carga";

const F = (iso: string | null | undefined) => (iso ? iso.slice(0, 10).split("-").reverse().join("/") : "—");
const S = (n: number | null | undefined) =>
  n == null ? "—" : `S/ ${Number(n).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
const FH = (iso: string | null | undefined) => {
  if (!iso) return null;
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? null : d.toLocaleString("es-PE", { timeZone: "America/Lima", dateStyle: "short", timeStyle: "short" });
};
const comprobante = (f: Pick<FacturaGuardada, "serie" | "numero">) => (f.serie && f.numero ? `${f.serie}-${f.numero}` : "del correo");

const COLS = "id, gmail_message_id, serie, numero, razon_social, ruc_emisor, fecha_emision, recibido_en, total, fuente_extraccion, estado, lineas, conciliacion";

// ── Qué buzón se lee (una vez por página) ────────────────────────────────────

let buzonPromesa: Promise<string | null> | null = null;

/** La dirección del buzón que lee las facturas, para abrir sus correos en ESA cuenta. null = no se sabe. */
function buzonFacturas(): Promise<string | null> {
  buzonPromesa ??= (async () => {
    try {
      const r = await fetch("/api/combustible/facturas/documento?buzon=1", { headers: await cabecerasErp() });
      const j = await r.json().catch(() => null);
      return r.ok && j?.ok && typeof j.email === "string" ? j.email : null;
    } catch {
      return null;
    }
  })();
  return buzonPromesa;
}

/** undefined mientras se pregunta; después, la dirección o null. */
function useBuzonFacturas(): string | null | undefined {
  const [email, setEmail] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let vivo = true;
    buzonFacturas().then((e) => { if (vivo) setEmail(e); });
    return () => { vivo = false; };
  }, []);
  return email;
}

// ── El documento ─────────────────────────────────────────────────────────────

type Doc = { url: string; tipo: "pdf" | "xml"; nombre: string; texto: string | null };

export function VisorFactura({ factura, gmail, onCerrar }: {
  factura: Pick<FacturaGuardada, "id" | "serie" | "numero" | "razon_social">;
  gmail: string | null;
  onCerrar: () => void;
}) {
  const [estado, setEstado] = useState<{ cargando: true } | { error: string } | Doc>({ cargando: true });
  // Primitivos: la fila llega como objeto y una nueva identidad no puede volver a bajar el documento.
  const id = factura.id;
  const defecto = comprobante(factura);

  useEffect(() => {
    let vivo = true;
    let url: string | null = null;
    (async () => {
      try {
        const r = await fetch(`/api/combustible/facturas/documento?id=${id}`, { headers: await cabecerasErp() });
        if (!r.ok) {
          const j = await r.json().catch(() => null);
          if (vivo) setEstado({ error: j?.error ?? `El servidor respondió ${r.status}.` });
          return;
        }
        const tipo: Doc["tipo"] = r.headers.get("X-Documento-Tipo") === "xml" ? "xml" : "pdf";
        let nombre = "";
        try { nombre = decodeURIComponent(r.headers.get("X-Documento-Nombre") ?? ""); } catch { /* nombre ilegible: se usa el comprobante */ }
        const blob = new Blob([await r.arrayBuffer()], { type: tipoParaMostrar(tipo) });
        const texto = tipo === "xml" ? (await blob.text()).replace(/>\s*</g, ">\n<") : null;
        url = URL.createObjectURL(blob);
        if (vivo) setEstado({ url, tipo, nombre: nombre || `${defecto}.${tipo}`, texto });
        else URL.revokeObjectURL(url);
      } catch (e) {
        if (vivo) setEstado({ error: (e as { message?: string } | null)?.message ?? "No se pudo traer el documento." });
      }
    })();
    return () => { vivo = false; if (url) URL.revokeObjectURL(url); };
  }, [id, defecto]);

  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === "Escape") onCerrar(); };
    window.addEventListener("keydown", k);
    return () => window.removeEventListener("keydown", k);
  }, [onCerrar]);

  const doc = "url" in estado ? estado : null;
  const boton = "px-2.5 py-1.5 rounded-lg text-xs font-bold border border-gray-200 bg-white text-[#0b315f] hover:bg-gray-50";
  return createPortal(
    // El clic no sube a la fila que contiene el botón (los portales de React propagan por el árbol).
    <div className="fixed inset-0 z-[80] bg-black/60 flex items-center justify-center p-3" onClick={(e) => { e.stopPropagation(); onCerrar(); }}>
      <div className="bg-white rounded-2xl w-full max-w-5xl h-[92vh] flex flex-col overflow-hidden shadow-2xl" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b">
          <div className="min-w-0">
            <p className="font-black text-[#0b315f] text-sm">📄 Factura {comprobante(factura)}{factura.razon_social ? ` · ${factura.razon_social}` : ""}</p>
            <p className="text-[11px] text-gray-500 truncate">
              {doc ? `${doc.nombre}${doc.tipo === "xml" ? " — el correo no trae el PDF: este es el XML de SUNAT, como texto" : ""}` : "Se baja del correo con la credencial del ERP; no se guarda ninguna copia."}
            </p>
          </div>
          <div className="flex flex-wrap items-center gap-2 ml-auto">
            {doc && <a href={doc.url} target="_blank" rel="noreferrer" className={boton}>Abrir en otra pestaña</a>}
            {doc && <a href={doc.url} download={doc.nombre} className={boton}>Descargar</a>}
            {gmail && <a href={gmail} target="_blank" rel="noreferrer" className={boton}>✉ Correo en Gmail ↗</a>}
            <button type="button" onClick={onCerrar} className={boton} aria-label="Cerrar">✕</button>
          </div>
        </div>
        <div className="flex-1 min-h-0 bg-gray-100">
          {"cargando" in estado && <p className="p-6 text-sm text-gray-500">Trayendo la factura del correo…</p>}
          {"error" in estado && (
            <div className="p-6 text-sm text-[#7a5a00] space-y-2">
              <p className="font-bold">No se pudo traer el documento.</p>
              <p>{estado.error}</p>
              {gmail && <p>Puedes abrir el correo en Gmail con el botón de arriba (con la cuenta del buzón de facturas).</p>}
            </div>
          )}
          {doc?.tipo === "pdf" && <iframe src={doc.url} title={doc.nombre} className="w-full h-full border-0 bg-white" />}
          {doc?.tipo === "xml" && <pre className="w-full h-full overflow-auto p-4 text-[11px] leading-snug text-gray-800 bg-white whitespace-pre-wrap break-all">{doc.texto}</pre>}
        </div>
      </div>
    </div>,
    document.body,
  );
}

/** «📄 Ver la factura» y «✉ Abrir el correo en Gmail», para una factura ya leída. */
export function BotonesFactura({ factura, conDocumento = true }: {
  factura: Pick<FacturaGuardada, "id" | "gmail_message_id" | "serie" | "numero" | "razon_social">;
  /** false = el correo no trae la factura (`sin_adjunto`): solo el enlace al correo. */
  conDocumento?: boolean;
}) {
  const [ver, setVer] = useState(false);
  const email = useBuzonFacturas();
  // El enlace se arma cuando ya se sabe el buzón: armado antes, un clic rápido abriría la cuenta equivocada.
  const gmail = email === undefined ? null : enlaceGmail(factura.gmail_message_id, email);
  return (
    <div className="flex flex-wrap items-center gap-2" onClick={(e) => e.stopPropagation()}>
      {conDocumento && (
        <button type="button" onClick={() => setVer(true)}
          className="px-2.5 py-1 rounded-lg text-[11px] font-bold border border-[#93c5fd] bg-white text-[#1d4ed8] hover:bg-[#eff6ff]">
          📄 Ver la factura
        </button>
      )}
      {gmail && (
        <a href={gmail} target="_blank" rel="noreferrer"
          title={email ? `Se abre en ${email}: si tu navegador no tiene esa cuenta abierta, Gmail te pedirá entrar con ella.` : "Se abre en la primera cuenta de Gmail del navegador: tiene que ser la del buzón de facturas."}
          className="text-[11px] font-bold text-[#1d4ed8] hover:underline">
          ✉ Abrir el correo en Gmail ↗
        </a>
      )}
      {ver && <VisorFactura factura={factura} gmail={gmail} onCerrar={() => setVer(false)} />}
    </div>
  );
}

// ── Qué factura es, y su línea ───────────────────────────────────────────────

/** La carga de `combustible` con lo que identifica a su factura. */
export type CargaConFactura = {
  id: number;
  observaciones?: string | null;
  comprobante_serie?: string | null;
  comprobante_numero?: string | null;
};

export type BusquedaFactura = { carga: CargaConFactura } | { recarga: string };

/** null = no hay factura que la respalde; "error" = no se pudo preguntar. */
async function leerFactura(b: BusquedaFactura): Promise<FacturaYLinea | null | "error"> {
  try {
    if ("recarga" in b) {
      const { data, error } = await supabase.from("radar_facturas").select(COLS)
        .contains("conciliacion", filtroFacturaQueEspera(b.recarga)).limit(5);
      if (error) return "error";
      return elegirFacturaQueEspera(b.recarga, (data ?? []) as FacturaGuardada[]);
    }
    // La conciliación NOMBRA a la carga (registrar / ya_registrada), o la carga lleva su comprobante
    // escrito. Las consultas van como texto JSON (la trampa de `.contains()` con arrays).
    const c = b.carga;
    const ref = referenciaFacturaDeCarga(c);
    const consultas = [
      supabase.from("radar_facturas").select(COLS).contains("conciliacion", JSON.stringify([{ codigo: "registrar", combustible_id: c.id }])).limit(5),
      supabase.from("radar_facturas").select(COLS).contains("conciliacion", JSON.stringify([{ codigo: "ya_registrada", casa_con: c.id }])).limit(5),
      ...(ref ? [supabase.from("radar_facturas").select(COLS).eq("serie", ref.serie).eq("numero", ref.numero).limit(5)] : []),
    ];
    const rs = await Promise.all(consultas);
    if (rs.every((r) => r.error)) return "error";
    const filas = new Map<number, FacturaGuardada>();
    for (const r of rs) for (const f of ((r.data ?? []) as FacturaGuardada[])) filas.set(Number(f.id), f);
    return elegirFacturaDeCarga(c, [...filas.values()]);
  } catch {
    return "error";
  }
}

/**
 * La factura que respalda la carga (o espera a la recarga): qué es, su línea, y los dos botones. Sin
 * factura no pinta nada; mientras busca lo dice solo si la carga ya declara un comprobante —nunca se
 * afirma un vacío mientras se está buscando, y sin comprobante lo normal es que no haya ninguna—.
 */
export default function FacturaDelCorreo({ busqueda }: { busqueda: BusquedaFactura }) {
  const clave = "recarga" in busqueda ? `r:${busqueda.recarga}` : `c:${busqueda.carga.id}|${busqueda.carga.comprobante_serie ?? ""}|${busqueda.carga.comprobante_numero ?? ""}|${busqueda.carga.observaciones ?? ""}`;
  const [res, setRes] = useState<{ clave: string; r: FacturaYLinea | null | "error" } | null>(null);
  useEffect(() => {
    let vivo = true;
    leerFactura(busqueda).then((r) => { if (vivo) setRes({ clave, r }); });
    return () => { vivo = false; };
    // La búsqueda depende solo de lo que identifica a la factura (la clave).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [clave]);

  const r = res && res.clave === clave ? res.r : undefined;
  const esperaUna = "recarga" in busqueda || !!referenciaFacturaDeCarga(busqueda.carga);
  if (r === undefined) return esperaUna ? <p className="text-[11px] text-gray-500">Buscando la factura del correo…</p> : null;
  if (r === "error") return esperaUna ? <p className="text-[11px] text-[#7a5a00]">No se pudo buscar la factura del correo: ábrela en Combustible → Facturas.</p> : null;
  if (!r) return null;
  const f = r.factura, l = r.linea;
  const llego = FH(f.recibido_en);
  const fuente = fuenteDeLectura(f.fuente_extraccion);
  return (
    <div className="rounded-lg border border-[#c7d2fe] bg-white p-2 text-[11px] space-y-1.5">
      <p className="text-gray-700">
        <b className="text-[#1e3a8a]">📧 {rotuloFactura(r)} {comprobante(f)}</b>
        {f.razon_social ? ` · ${f.razon_social}` : ""}
        {f.fecha_emision ? ` · emitida ${F(f.fecha_emision)}` : ""}
        {llego ? ` · llegó al correo el ${llego}` : ""}
        {fuente ? ` · ${fuente}` : ""}
        {f.total != null ? ` · total ${S(f.total)}` : ""}
      </p>
      {l ? (
        <p className="text-gray-700">
          Su línea (#{l.n}): {l.descripcion || "—"} · {l.cantidad ?? "—"} {l.unidad_codigo ?? ""} × {l.precio_unitario ?? "—"} = <b>{S(l.total)}</b>
          {" · "}🚌 {l.placa ?? "sin placa"}{l.nota_despacho ? ` · nota ${l.nota_despacho}` : ""}
        </p>
      ) : r.por === "comprobante" ? (
        <p className="text-gray-500">La conciliación no nombra a esta carga en ninguna de sus líneas: compara el importe contra el documento.</p>
      ) : null}
      <BotonesFactura factura={f} />
    </div>
  );
}
