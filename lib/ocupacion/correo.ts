// ══════════════════════════════════════════════════════════════════════════════
// lib/ocupacion/correo.ts
// El cuerpo del correo semanal y su Excel. Módulo PURO: recibe las filas ya
// analizadas y devuelve cadenas. No lee la base y no vuelve a juzgar nada.
//
// ─── LA DECISIÓN QUE SEPARA ESTE MÓDULO EN DOS DESTINATARIOS ────────────────
//
// El cliente y AFA reciben el MISMO análisis, pero no el mismo correo. Los DATOS
// de ocupación son hechos sobre el servicio del cliente y se le pueden mandar
// siempre; la SUGERENCIA de bajar de vehículo es una propuesta comercial —
// ofrecerle pagar menos— y eso se decide cliente por cliente
// (`clientes.reporte_ocupacion_sugerencias`).
//
// Con las sugerencias apagadas, la fila NO desaparece: se enseña su ocupación y
// se calla la propuesta. Esconder la fila entera le quitaría al cliente un dato
// suyo para protegerle a AFA un margen, que es exactamente al revés.
//
// `CODIGO_RECOMIENDA` (lib/ocupacion/semanal.ts) es quien decide qué cae de ese
// lado, y vive pegado al código y no en una lista aparte que haya que acordarse
// de actualizar — misma razón que `problema` en el catálogo de /redes. Calla los
// DOS sentidos: ni «cabría en una unidad menor» ni «conviene revisar el
// contrato». Lo que nunca se calla son los NÚMEROS.
// ══════════════════════════════════════════════════════════════════════════════

import * as XLSX from "xlsx";
import type { Ventana } from "@/lib/ocupacion/cadencia";
import {
  CODIGO_RECOMIENDA, ETIQUETA_RECOMIENDA, ETIQUETA_OCUPACION,
  motivoOcupacion, motivoSinRecomendacion, rotuloFila,
  type FilaOcupacion,
} from "@/lib/ocupacion/semanal";

export type MetaReporte = {
  empresaNombre: string;
  clienteNombre: string;
  inicio: string;
  fin: string;
  /** false = falta correr `liquidaciones-03`: el denominador no se pudo leer. */
  hayCapacidad: boolean;
  /** Para AFA va true siempre; para el cliente lo dice su ficha. */
  incluirSugerencias: boolean;
  /** Qué periodo abarca, para titular el correo con lo que de verdad se midió. */
  ventana: Ventana;
};

/**
 * El título del correo se DERIVA de la ventana configurada. Estaba escrito
 * «Ocupación de los últimos 7 días» como literal, y con las ventanas
 * configurables eso habría encabezado un reporte de 30 días diciendo 7 — la
 * pantalla mintiendo sobre lo que hay debajo, que es el defecto que este ERP ya
 * pagó con la etiqueta del horario del conductor.
 */
export const tituloVentana = (v: Ventana): string =>
  v === "mes" ? "Ocupación del mes" : `Ocupación de los últimos ${v} días`;

const esc = (v: unknown): string =>
  String(v ?? "").replace(/[&<>"']/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c] as string));

const fecha = (f: string | null | undefined): string =>
  f ? new Date(f + "T00:00:00").toLocaleDateString("es-PE", { day: "2-digit", month: "2-digit", year: "numeric" }) : "—";

/**
 * El motivo tal como lo va a leer ESTE destinatario. Con las sugerencias apagadas,
 * la fila conserva sus NÚMEROS y pierde la conclusión — en los dos sentidos: ni
 * «cabría en una unidad menor» ni «conviene revisar el contrato».
 *
 * El texto neutro lo compone el MOTOR (`motivoSinRecomendacion`), no este módulo:
 * dos redacciones del mismo hecho terminan diciendo cifras distintas el día que
 * una se queda atrás.
 */
export function motivoParaDestinatario(f: FilaOcupacion, incluirSugerencias: boolean): string {
  if (!incluirSugerencias && CODIGO_RECOMIENDA[f.codigo]) {
    return motivoSinRecomendacion(f) ?? motivoOcupacion(f);
  }
  return motivoOcupacion(f);
}

/**
 * La etiqueta del chip. Aquí la regla NO es la misma: «Cabe en una unidad menor»
 * ES la propuesta y se calla, pero «Superó lo contratado» es un HECHO medido que
 * el cliente tiene derecho a leer con o sin sugerencias. Callarlo escondería que
 * 32 personas viajaron sobre 30 asientos, que es justo lo que no se puede callar.
 */
export function etiquetaParaDestinatario(f: FilaOcupacion, incluirSugerencias: boolean): string {
  if (!incluirSugerencias && ETIQUETA_RECOMIENDA[f.codigo]) return "Ocupación del periodo";
  return ETIQUETA_OCUPACION[f.codigo];
}

const COLOR: Record<string, string> = {
  sugiere_cambio: "#0369a1",
  excede_contratado: "#991b1b",
  sin_contratado: "#854d0e",
  cobertura_baja: "#854d0e",
  sin_manifiesto: "#854d0e",
  no_hay_menor: "#475569",
  ya_es_la_menor: "#475569",
  pocos_dias: "#475569",
  sin_flota: "#475569",
};

// ─── El cuerpo del correo ────────────────────────────────────────────────────

export function htmlReporte(filas: FilaOcupacion[], meta: MetaReporte): string {
  const inc = meta.incluirSugerencias;
  const propuestas = inc ? filas.filter((f) => f.codigo === "sugiere_cambio") : [];
  const excesos = filas.filter((f) => f.codigo === "excede_contratado");
  const totalServicios = filas.reduce((a, f) => a + f.servicios, 0);
  const totalTramos = filas.reduce((a, f) => a + f.tramos, 0);
  const sinManifiesto = filas.reduce((a, f) => a + f.sin_manifiesto, 0);

  const fila = (f: FilaOcupacion) => {
    const color = (!inc && ETIQUETA_RECOMIENDA[f.codigo]) ? "#475569" : (COLOR[f.codigo] ?? "#475569");
    // Sin pico no se imprime un 0: un cero se lee como «no viajó nadie».
    const ocupacion = f.pico === null
      ? "—"
      : `${f.pico} / ${f.contratado ?? "—"}`;
    return `<tr>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;">
        <div style="font-weight:700;color:#0f172a;font-size:12.5px;">${esc(rotuloFila(f))}</div>
        ${f.recorrido && f.ruta_nombre ? `<div style="color:#64748b;font-size:10.5px;margin-top:2px;">${esc(f.recorrido)}</div>` : ""}
      </td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;text-align:center;font-family:ui-monospace,Menlo,monospace;font-weight:700;font-size:13px;color:#0f172a;white-space:nowrap;">
        ${esc(ocupacion)}
        <div style="font-weight:400;font-size:9.5px;color:#94a3b8;">pico / contratados</div>
      </td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;text-align:center;font-family:ui-monospace,Menlo,monospace;font-size:12px;color:#475569;white-space:nowrap;">
        ${f.promedio ?? "—"}
        <div style="font-weight:400;font-size:9.5px;color:#94a3b8;">promedio</div>
      </td>
      <td style="padding:9px 10px;border-bottom:1px solid #e5e7eb;font-size:11.5px;color:#334155;">
        <span style="display:inline-block;font-size:9.5px;font-weight:800;letter-spacing:.04em;color:${color};margin-bottom:3px;">
          ${esc(etiquetaParaDestinatario(f, inc).toUpperCase())}
        </span>
        <div>${esc(motivoParaDestinatario(f, inc))}</div>
      </td>
    </tr>`;
  };

  const aviso = (texto: string, color: string, fondo: string) =>
    `<div style="background:${fondo};border-left:3px solid ${color};padding:10px 12px;margin:0 0 14px;border-radius:0 6px 6px 0;font-size:12px;color:#334155;">${texto}</div>`;

  return `<!doctype html><html lang="es"><body style="margin:0;padding:0;background:#f1f5f9;">
<div style="max-width:760px;margin:0 auto;padding:22px 16px;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;">

  <div style="background:#0b315f;border-radius:12px 12px 0 0;padding:18px 20px;">
    <p style="margin:0;color:#fff;font-size:16px;font-weight:800;">${esc(tituloVentana(meta.ventana))}</p>
    <p style="margin:5px 0 0;color:rgba(255,255,255,.72);font-size:12px;">
      ${esc(meta.clienteNombre)} · del ${fecha(meta.inicio)} al ${fecha(meta.fin)}
    </p>
  </div>

  <div style="background:#fff;padding:18px 20px;border-radius:0 0 12px 12px;">

    <p style="margin:0 0 14px;font-size:12.5px;color:#475569;line-height:1.55;">
      Cuántas personas viajaron de verdad en cada ruta, frente a los asientos contratados.
      <b>Se mide el día de MÁS afluencia</b>, no el promedio: es el que tiene que caber.
      La <b>ida y su retorno son UN servicio</b> de la misma ruta — se mide el tramo más
      lleno del día, nunca la suma, porque son los mismos asientos contratados.
    </p>

    ${!meta.hayCapacidad ? aviso(
      "<b>No se pudieron leer los asientos contratados</b> de estos servicios, así que la comparación sale sin denominador.",
      "#b45309", "#fffbeb") : ""}

    ${excesos.length ? aviso(
      `<b>${excesos.length} ruta(s) superaron los asientos contratados</b> en al menos un día del periodo. `
      + "Cuando eso pasa, alguien viaja de pie o se queda en el paradero.", "#991b1b", "#fef2f2") : ""}

    ${propuestas.length ? aviso(
      `<b>${propuestas.length} ruta(s) podrían cubrirse con una unidad más pequeña</b> sin dejar a nadie fuera, `
      + "según lo que viajó esta semana. Es una propuesta: la decide usted.", "#0369a1", "#eff6ff") : ""}

    ${sinManifiesto > 0 ? aviso(
      `<b>${sinManifiesto} servicio(s) no tienen el manifiesto cargado.</b> Esos no se pudieron medir — `
      + "no se cuentan como «no viajó nadie», se dejan fuera.", "#b45309", "#fffbeb") : ""}

    <table style="width:100%;border-collapse:collapse;font-size:12px;">
      <thead>
        <tr style="background:#f8fafc;">
          <th style="padding:8px 10px;text-align:left;font-size:9.5px;font-weight:800;color:#64748b;letter-spacing:.06em;border-bottom:1.5px solid #e2e8f0;">RUTA</th>
          <th style="padding:8px 10px;text-align:center;font-size:9.5px;font-weight:800;color:#64748b;letter-spacing:.06em;border-bottom:1.5px solid #e2e8f0;">OCUPACIÓN</th>
          <th style="padding:8px 10px;text-align:center;font-size:9.5px;font-weight:800;color:#64748b;letter-spacing:.06em;border-bottom:1.5px solid #e2e8f0;">MEDIA</th>
          <th style="padding:8px 10px;text-align:left;font-size:9.5px;font-weight:800;color:#64748b;letter-spacing:.06em;border-bottom:1.5px solid #e2e8f0;">OBSERVACIÓN</th>
        </tr>
      </thead>
      <tbody>${filas.map(fila).join("")}</tbody>
    </table>

    <p style="margin:16px 0 0;font-size:11px;color:#64748b;line-height:1.55;">
      ${filas.length} ruta(s) · ${totalServicios} servicio(s) en el periodo${
        totalTramos > totalServicios ? ` (${totalTramos} tramos de ida y retorno)` : ""}.
      El detalle día por día va en el Excel adjunto, junto con los manifiestos de pasajeros
      y los reportes de servicio de la semana.
    </p>

  </div>

  <p style="margin:14px 0 0;text-align:center;font-size:10.5px;color:#94a3b8;">
    ${esc(meta.empresaNombre)} · reporte automático de los sábados
  </p>
</div></body></html>`;
}

/** Asunto del correo. Nombra lo accionable: un asunto genérico se deja de abrir. */
export function asuntoReporte(filas: FilaOcupacion[], meta: MetaReporte): string {
  const excesos = filas.filter((f) => f.codigo === "excede_contratado").length;
  const props = meta.incluirSugerencias ? filas.filter((f) => f.codigo === "sugiere_cambio").length : 0;
  const cola = excesos
    ? ` · ${excesos} ruta(s) por encima de lo contratado`
    : props ? ` · ${props} ruta(s) podrían usar una unidad menor` : "";
  return `${tituloVentana(meta.ventana)} · ${fecha(meta.inicio)} al ${fecha(meta.fin)}${cola} — ${meta.empresaNombre}`;
}

// ─── El Excel ────────────────────────────────────────────────────────────────

/**
 * Dos hojas: el resumen por ruta y el detalle tramo por tramo. Se devuelve en
 * base64 porque es lo que pide el adjunto de Resend.
 *
 * En el detalle, un servicio SIN manifiesto va con la celda de embarcados VACÍA,
 * jamás con un 0. En una hoja que alguien va a sumar o graficar, ese cero se
 * convierte en «ese día no viajó nadie» — el mismo error que el Anexo 1 tuvo que
 * dejar de imprimir, por la puerta de la hoja de cálculo.
 */
export function xlsxReporteBase64(filas: FilaOcupacion[], meta: MetaReporte): string {
  const inc = meta.incluirSugerencias;

  const resumen = filas.map((f) => ({
    "Ruta": rotuloFila(f),
    "Ruta (ida)": f.ruta_nombre ?? "",
    "Ruta (retorno)": f.ruta_retorno ?? "",
    "Origen → destino": f.recorrido ?? "",
    "Asientos contratados": f.contratado ?? "",
    "Pico de pasajeros": f.pico ?? "",
    "Día del pico": f.dia_pico ?? "",
    "Promedio": f.promedio ?? "",
    "Servicios (ida+retorno = 1)": f.servicios,
    "Tramos": f.tramos,
    "Cancelados": f.cancelados,
    "Medidos": f.medidos,
    "Sin manifiesto": f.sin_manifiesto,
    "Situación": etiquetaParaDestinatario(f, inc),
    "Unidad sugerida": inc && f.propuesta ? f.propuesta.nombre : "",
    "Asientos que libera": inc && f.asientos_liberados != null ? f.asientos_liberados : "",
    "Observación": motivoParaDestinatario(f, inc),
  }));

  // El detalle va por TRAMO, no por día: es lo que de verdad hay en la operación y
  // es lo que alguien coteja contra su calendario. El día se ve igual — sus dos
  // tramos comparten fecha y «Pico del día».
  const detalle = filas.flatMap((f) =>
    f.dias.flatMap((d) =>
      d.tramos.map((t) => ({
        "Ruta": rotuloFila(f),
        "Fecha": d.fecha,
        "Tramo": t.sentido === "RETORNO" ? "Retorno" : t.sentido === "IDA" ? "Ida" : "",
        "Ruta del tramo": t.ruta_nombre ?? "",
        "Hora": t.hora ?? "",
        "Placa": t.placa ?? "",
        "Estado": t.cancelado ? "Cancelado" : "Prestado",
        // Vacío, NUNCA 0: ver la cabecera de esta función.
        "Embarcados": t.medido ? t.embarcados : "",
        "En el manifiesto": t.medido ? t.esperados : "",
        "Asientos contratados": f.contratado ?? "",
        // El pico del DÍA es el MÁXIMO de sus tramos, jamás la suma: son los mismos
        // asientos contratados, ocupados por las mismas personas yendo y volviendo.
        "Pico del día": d.medido ? d.embarcados : "",
        "Se midió": t.medido ? "Sí" : (t.cancelado ? "No — cancelado" : "No — sin manifiesto"),
      }))
    )
  );

  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(resumen), "Resumen por ruta");
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(detalle), "Detalle por tramo");
  return XLSX.write(wb, { type: "base64", bookType: "xlsx" }) as string;
}

/** Nombre de archivo estable y legible: `Ocupacion-2026-09-13_al_2026-09-19.xlsx`. */
export const nombreArchivo = (prefijo: string, meta: MetaReporte, ext: string): string =>
  `${prefijo}-${meta.inicio}_al_${meta.fin}.${ext}`;
