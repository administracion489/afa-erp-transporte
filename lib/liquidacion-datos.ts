// ──────────────────────────────────────────────────────────────────────────────
// lib/liquidacion-datos.ts — De la base de datos al documento imprimible.
//
// Una sola función arma el `DocLiquidacion` que pinta lib/liquidacion-doc.ts, y la
// usan los tres consumidores: la pantalla /liquidaciones (botón PDF), el correo/
// WhatsApp de conformidad y la página pública donde el cliente aprueba. Si cada uno
// armara el documento por su cuenta, el cliente vería una versión distinta según por
// dónde entró — que es justamente el problema que este módulo viene a eliminar.
//
// Funciona con cualquier cliente Supabase: el browser (anon, usuario logueado) o el
// service-role de una API route.
// ──────────────────────────────────────────────────────────────────────────────

import type { DocLiquidacion, FilaAnexo, LineaDoc, ControlDoc, Anexo2 } from "./liquidacion-doc";
import { fechaFormato } from "./liquidacion-agrupacion";
import { empresaConDefectos } from "./empresa-perfil";
import { esAbordado } from "./documentos-servicio";
import type { Lado } from "./liquidaciones";

const TABLAS = {
  cliente: { cab: "liquidacion_cliente", linea: "liquidacion_cliente_linea", puente: "liquidacion_cliente_linea_reserva" },
  proveedor: { cab: "liquidacion_proveedor", linea: "liquidacion_proveedor_linea", puente: "liquidacion_proveedor_linea_reserva" },
} as const;

const ESTADO_LABEL: Record<string, string> = {
  borrador: "BORRADOR",
  emitida: "EMITIDA",
  conformada: "CONFORMADA",
  observada: "OBSERVADA",
  facturada: "FACTURADA",
  por_pagar: "POR PAGAR",
  pagada: "PAGADA",
  anulada: "ANULADA",
};

const fFecha = (iso: string | null | undefined) => {
  const s = String(iso ?? "").slice(0, 10);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  return m ? `${m[3]}/${m[2]}/${m[1]}` : "";
};

const fFechaHora = (iso: string | null | undefined) => {
  if (!iso) return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  // Todo el ERP razona en hora de Perú; el timestamp viene en UTC.
  const l = new Date(d.getTime() - 5 * 3600 * 1000);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(l.getUTCDate())}/${p(l.getUTCMonth() + 1)}/${l.getUTCFullYear()} ${p(l.getUTCHours())}:${p(l.getUTCMinutes())}`;
};

const hhmm = (h: string | null | undefined) => {
  const s = String(h ?? "").trim();
  return /^\d{1,2}:\d{2}/.test(s) ? s.slice(0, 5) : "";
};

/** Lee filas en lotes; PostgREST corta en 1000 y un periodo largo pasa de eso. */
async function enLotes<T>(ids: number[], tam: number, fn: (chunk: number[]) => Promise<T[]>): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += tam) out.push(...(await fn(ids.slice(i, i + tam))));
  return out;
}

/**
 * Como `enLotes`, pero paginando también las FILAS de cada lote.
 *
 * `enLotes` reparte los ids y da por hecho que la respuesta cabe entera. Para las reservas
 * y los vehículos es cierto —una fila por id—, pero no para lo que se expande: 300
 * paraderos traen unos 3.000 registros y sus pasajeros pasan de 6.000, y PostgREST recorta
 * CUALQUIER respuesta a 1.000 filas sin avisar. Sin paginar, el conteo de embarcados del
 * Anexo 1 saldría corto y nadie lo notaría: el número es plausible, solo que menor.
 */
async function enLotesPaginado<T>(
  ids: number[],
  tam: number,
  fn: (chunk: number[], desde: number, hasta: number) => Promise<T[]>
): Promise<T[]> {
  const out: T[] = [];
  for (let i = 0; i < ids.length; i += tam) {
    const chunk = ids.slice(i, i + tam);
    for (let desde = 0; ; desde += 1000) {
      const filas = await fn(chunk, desde, desde + 999);
      out.push(...filas);
      if (filas.length < 1000) break;
    }
  }
  return out;
}

export type OpcionesDoc = {
  /** Incluir el Anexo 1 (detalle servicio por servicio). Por defecto sí. */
  anexoDetalle?: boolean;
  /** Incluir el Anexo 2 (evidencia operativa). Requiere las métricas ya calculadas. */
  anexo2?: Anexo2 | null;
  /** URL pública de conformidad/verificación (para el QR y el pie). */
  urlPublica?: string | null;
  /** Genera el QR como data URL. Se puede desactivar en entornos sin `qrcode`. */
  conQr?: boolean;
};

/**
 * Arma el documento completo de una liquidación.
 * Devuelve `null` si la liquidación no existe (enlace inválido o borrada).
 */
export async function cargarDocumentoLiquidacion(
  sb: any,
  lado: Lado,
  ref: { id?: number; token?: string },
  opts: OpcionesDoc = {}
): Promise<DocLiquidacion | null> {
  const t = TABLAS[lado];

  const q = sb.from(t.cab).select("*");
  const { data: cab } = await (ref.token ? q.eq("token", ref.token) : q.eq("id", ref.id)).maybeSingle();
  if (!cab) return null;
  const id = Number(cab.id);

  // ── Contraparte, sede, empresa y control del documento ───────────────────
  const [contraparteR, sedeR, empresaR, controlR] = await Promise.all([
    lado === "cliente"
      ? sb.from("clientes").select("nombre,empresa,ruc,dni,direccion,email,telefono,administrativo_nombre,administrativo_email,administrativo_celular").eq("id", cab.cliente_id).maybeSingle()
      : sb.from("empresas_tercerizadas").select("razon_social,ruc,email,telefono,contacto_nombre,contacto_telefono").eq("id", cab.empresa_tercerizada_id).maybeSingle(),
    cab.cliente_sede_id
      ? sb.from("cliente_sedes").select("*").eq("id", cab.cliente_sede_id).maybeSingle()
      : Promise.resolve({ data: null }),
    sb.from("empresa_perfil").select("nombre,razon_social,ruc,logo_url,telefono,email,direccion,web").eq("id", 1).maybeSingle(),
    sb.from("documento_control").select("*").eq("codigo", cab.documento_codigo || (lado === "cliente" ? "AFA-FL-07" : "AFA-FL-08")).maybeSingle(),
  ]);

  const cp: any = contraparteR?.data ?? {};
  const sede: any = sedeR?.data ?? null;
  const emp: any = empresaR?.data ?? {};
  const ctl: any = controlR?.data ?? {};

  const control: ControlDoc = {
    codigo: ctl.codigo || cab.documento_codigo || (lado === "cliente" ? "AFA-FL-07" : "AFA-FL-08"),
    titulo: ctl.titulo || "Formato de Liquidación y Conformidad del Servicio",
    macro_proceso: ctl.macro_proceso ?? "Gestión Logística",
    proceso: ctl.proceso ?? (lado === "cliente" ? "Venta de bienes y servicios" : "Compra de bienes y servicios"),
    subproceso: ctl.subproceso ?? "No aplica",
    version: ctl.version ?? "01",
    vigencia_desde: fFecha(ctl.vigencia_desde) || null,
  };

  // ── Líneas de la valorización ────────────────────────────────────────────
  const { data: lineasRaw } = await sb.from(t.linea).select("*").eq("liquidacion_id", id).order("item");
  const lineasBd = ((lineasRaw as any[]) ?? []);

  const lineas: LineaDoc[] = lineasBd.map((l) => ({
    item: Number(l.item ?? 0),
    tipo: l.tipo,
    descripcion: l.descripcion,
    unidad_medida: l.unidad_medida ?? "SERV.",
    cantidad_programada: l.cantidad_programada != null ? Number(l.cantidad_programada) : null,
    cantidad_ejecutada: l.cantidad_ejecutada != null ? Number(l.cantidad_ejecutada) : null,
    cantidad: Number(l.cantidad ?? 0),
    precio_unitario: Number(l.precio_unitario ?? 0),
    total_linea: Number(l.total_linea ?? 0),
    orden_compra: l.orden_compra ?? null,
    detalle: [
      l.referencia ? `ver Anexo 1 (ítems ${l.referencia})` : null,
      l.cantidad_motivo ? `Ajuste: ${l.cantidad_motivo}` : null,
    ].filter(Boolean).join(" · ") || null,
  }));

  // ── Anexo 1: los servicios que sustentan cada línea ──────────────────────
  let anexo1: FilaAnexo[] = [];
  if (opts.anexoDetalle !== false && lineasBd.length) {
    const lineaIds = lineasBd.map((l) => Number(l.id));
    const puente = await enLotes(lineaIds, 100, async (chunk) => {
      const { data } = await sb.from(t.puente).select("linea_id,reserva_id").in("linea_id", chunk);
      return ((data as any[]) ?? []);
    });

    const reservaIds = [...new Set(puente.map((p) => Number(p.reserva_id)))];
    if (reservaIds.length) {
      const reservas = await enLotes(reservaIds, 300, async (chunk) => {
        const { data } = await sb.from("reservas")
          .select("id,codigo,fecha_servicio,hora_servicio,ruta_nombre,direccion_servicio,origen,destino,vehiculo_id,vehiculo_tercero_id,conductor_id,conductor_tercero_id,pasajeros_abordados,capacidad_contratada,precio_cliente,costo_proveedor,estado,reserva_vinculada_id")
          .in("id", chunk);
        return ((data as any[]) ?? []);
      });
      const porId = new Map<number, any>(reservas.map((r) => [Number(r.id), r]));

      // Catálogos en una sola pasada (placas y nombres, flota propia y tercerizada).
      const vIds = [...new Set(reservas.map((r) => r.vehiculo_id).filter(Boolean))];
      const vtIds = [...new Set(reservas.map((r) => r.vehiculo_tercero_id).filter(Boolean))];
      const cIds = [...new Set(reservas.map((r) => r.conductor_id).filter(Boolean))];
      const ctIds = [...new Set(reservas.map((r) => r.conductor_tercero_id).filter(Boolean))];
      const [vs, vts, cs, cts] = await Promise.all([
        vIds.length ? sb.from("vehiculos").select("id,placa").in("id", vIds) : Promise.resolve({ data: [] }),
        vtIds.length ? sb.from("vehiculos_tercero").select("id,placa").in("id", vtIds) : Promise.resolve({ data: [] }),
        cIds.length ? sb.from("conductores").select("id,nombre").in("id", cIds) : Promise.resolve({ data: [] }),
        ctIds.length ? sb.from("conductores_tercero").select("id,nombre").in("id", ctIds) : Promise.resolve({ data: [] }),
      ]);
      // ── Los EMBARCADOS salen del manifiesto, no de la reserva ──────────────
      //
      // `reservas.pasajeros_abordados` existe como columna pero NO LA ESCRIBE NADIE: el
      // abordaje se registra en `pasajeros_parada` cuando el conductor escanea el QR. Por
      // eso la columna PAX del anexo salía en 0 con el manifiesto lleno — un cero que el
      // cliente lee como "no viajó nadie" en un servicio que sí se prestó y se le cobra.
      //
      // Se cuenta con `esAbordado` (lib/documentos-servicio.ts), que es la MISMA definición
      // que usan la app del conductor, el lector de QR y Seguimiento. Tener aquí un cuarto
      // criterio haría que el papel y la pantalla dieran cifras distintas del mismo día.
      const abordadosPorReserva = new Map<number, number>();
      try {
        const paradas = await enLotesPaginado(reservaIds, 300, async (chunk, desde, hasta) => {
          const { data } = await sb.from("paradas").select("id,reserva_id").in("reserva_id", chunk).range(desde, hasta);
          return ((data as any[]) ?? []);
        });
        const reservaDeParada = new Map<number, number>(paradas.map((p) => [Number(p.id), Number(p.reserva_id)]));
        if (reservaDeParada.size) {
          const pps = await enLotesPaginado([...reservaDeParada.keys()], 300, async (chunk, desde, hasta) => {
            const { data } = await sb.from("pasajeros_parada")
              .select("parada_id,pasajero_id,estado,estado_abordaje").in("parada_id", chunk).range(desde, hasta);
            return ((data as any[]) ?? []);
          });
          // Por pasajero DISTINTO: un mismo pasajero puede figurar en dos paraderos del
          // recorrido y contarlo dos veces inflaría el manifiesto.
          const vistos = new Map<number, Set<string>>();
          for (const pp of pps) {
            if (!esAbordado(pp)) continue;
            const rid = reservaDeParada.get(Number(pp.parada_id));
            if (!rid) continue;
            const set = vistos.get(rid) ?? new Set<string>();
            set.add(String(pp.pasajero_id ?? `pp-${pp.parada_id}-${set.size}`));
            vistos.set(rid, set);
          }
          for (const [rid, set] of vistos) abordadosPorReserva.set(rid, set.size);
        }
      } catch {
        // Sin manifiesto el anexo sale con el contratado y un "—" en los embarcados, que
        // es la verdad: no que viajaran cero.
      }

      const placa = new Map<string, string>();
      for (const v of ((vs.data as any[]) ?? [])) placa.set("p" + v.id, v.placa);
      for (const v of ((vts.data as any[]) ?? [])) placa.set("t" + v.id, v.placa);
      const chofer = new Map<string, string>();
      for (const c of ((cs.data as any[]) ?? [])) chofer.set("p" + c.id, c.nombre);
      for (const c of ((cts.data as any[]) ?? [])) chofer.set("t" + c.id, c.nombre);

      // Se recorre por línea para que la numeración del anexo (A-01, B-01…) coincida
      // exactamente con la referencia impresa en la valorización.
      const serieDe = (ref: string | null | undefined, i: number) => {
        const m = /^([A-Z]+)-/.exec(String(ref ?? ""));
        return `${m ? m[1] : "X"}-${String(i + 1).padStart(2, "0")}`;
      };
      const montoDe = (r: any) =>
        Number((lado === "cliente" ? r.precio_cliente : r.costo_proveedor) ?? 0);
      const diaHora = (r: any) =>
        `${String(r.fecha_servicio ?? "").slice(0, 10)}T${hhmm(r.hora_servicio) || "99:99"}`;

      // El anexo se imprime en orden de FECHA sobre todo el periodo (01-08 → 31-08),
      // no agrupado por línea: quien revisa la valorización compara contra su propio
      // calendario, y con una ruta por bloque el mismo día aparecía cuatro veces
      // separado por páginas. La numeración del ítem (A-01, B-01…) se sigue calculando
      // por línea, que es lo que la ata a la valorización; solo cambia el orden.
      const pendientes: { fila: FilaAnexo; grupo: string; sub: string }[] = [];

      for (const l of lineasBd) {
        const deLinea = puente.filter((p) => Number(p.linea_id) === Number(l.id));
        const filas = deLinea
          .map((p) => porId.get(Number(p.reserva_id)))
          .filter(Boolean)
          .sort((a, b) => String(a.fecha_servicio).localeCompare(String(b.fecha_servicio)) || a.id - b.id);

        // IDA y RETORNO comparten tarifa y comparten número de ítem: el cliente lee
        // "A-01" dos veces (ida e incluido) y entiende de un vistazo que una sola
        // tarifa cubrió los dos tramos. Numerar corrido sugeriría el doble de servicios.
        const numeroDe = new Map<number, number>();
        let n = 0;
        for (const r of filas) {
          if (numeroDe.has(r.id)) continue;
          n += 1;
          numeroDe.set(r.id, n);
          const parId = Number(r.reserva_vinculada_id ?? 0);
          if (parId && filas.some((x) => x.id === parId)) numeroDe.set(parId, n);
        }

        // Los dos tramos del día viajan JUNTOS aunque el retorno caiga en la
        // madrugada siguiente: comparten número de ítem y el importe se cobra una
        // vez, así que separarlos leería como dos servicios. El par se ubica en la
        // fecha de su primer tramo.
        const claveDe = new Map<number, string>();
        for (const r of filas) {
          const n = numeroDe.get(r.id) ?? 0;
          const k = diaHora(r);
          const previo = claveDe.get(n);
          if (previo === undefined || k < previo) claveDe.set(n, k);
        }

        for (const r of filas) {
          const esTercero = !!r.vehiculo_tercero_id;
          const incluida = montoDe(r) <= 0;   // el tramo que va dentro de la tarifa del par
          const ref = serieDe(l.referencia, (numeroDe.get(r.id) ?? 1) - 1);
          const fila: FilaAnexo = {
            ref,
            fecha: fechaFormato(r.fecha_servicio).slice(0, 5),
            codigo: r.codigo || `#${r.id}`,
            ruta: [r.ruta_nombre || [r.origen, r.destino].filter(Boolean).join(" → "),
                   r.direccion_servicio === "retorno" ? "(Retorno)" : "(Ida)"].filter(Boolean).join(" "),
            turno: hhmm(r.hora_servicio) || "—",
            placa: placa.get((esTercero ? "t" : "p") + (r.vehiculo_tercero_id ?? r.vehiculo_id)) ?? "",
            conductor: chofer.get((r.conductor_tercero_id ? "t" : "p") + (r.conductor_tercero_id ?? r.conductor_id)) ?? "",
            // Contratado / embarcados. El contratado sale del servicio y, si no lo trae,
            // del ítem que lo cobra (es el número que se imprimió en la valorización).
            paxContratado: Number(r.capacidad_contratada ?? 0) > 0
              ? Number(r.capacidad_contratada)
              : Number((l as any).pax_contratado ?? 0) > 0 ? Number((l as any).pax_contratado) : null,
            pax: abordadosPorReserva.get(Number(r.id))
              ?? (r.pasajeros_abordados != null ? Number(r.pasajeros_abordados) : null),
            estado: r.estado !== "finalizada" ? "No ejecutado"
              : incluida ? "Incluido"
              : l.tipo === "adicional" ? "Adicional" : "Conforme",
            // El importe va una sola vez por servicio: así la suma del anexo cuadra
            // exactamente con el total de la línea.
            importe: incluida ? 0 : Number(l.precio_unitario ?? 0),
            alerta: r.estado !== "finalizada",
          };
          pendientes.push({
            fila,
            // El ítem desempata a igual fecha y hora, para que dos rutas que salen
            // a la misma hora salgan siempre en el mismo orden.
            grupo: `${claveDe.get(numeroDe.get(r.id) ?? 0) ?? diaHora(r)}|${ref}`,
            sub: `${diaHora(r)}|${String(r.id).padStart(12, "0")}`,
          });
        }
      }

      // Comparación binaria, no `localeCompare`: las claves son fechas ISO con
      // separadores, y la colación del idioma ignora la puntuación.
      const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
      pendientes.sort((a, b) => cmp(a.grupo, b.grupo) || cmp(a.sub, b.sub));
      anexo1 = pendientes.map((p) => p.fila);
    }
  }

  // ── Documentación / requisitos ───────────────────────────────────────────
  const docJson = Array.isArray(cab.documentacion_json) ? cab.documentacion_json : [];
  const reqJson = Array.isArray(cab.requisitos_json) ? cab.requisitos_json : [];
  const documentacion = (lado === "cliente" ? docJson : reqJson).length
    ? (lado === "cliente" ? docJson : reqJson).map((d: any) => ({
        nombre: String(d.nombre ?? d.requisito ?? ""),
        estado: String(d.estado ?? "SÍ"),
        copias: d.copias ?? d.ref ?? 1,
      }))
    : lado === "cliente"
    ? [
        { nombre: "Formato de Liquidación y Conformidad del Servicio (este documento)", estado: "SÍ", copias: 1 },
        ...(anexo1.length ? [{ nombre: `Anexo 1 — Detalle de los ${anexo1.length} servicios ejecutados`, estado: "SÍ", copias: 1 }] : []),
        ...(opts.anexo2 ? [{ nombre: "Anexo 2 — Evidencia operativa del periodo", estado: "SÍ", copias: 1 }] : []),
        { nombre: "Factura electrónica del periodo", estado: cab.factura_id ? "EMITIDA" : "AL APROBAR", copias: 1 },
      ]
    : [
        { nombre: "Factura del proveedor por el importe conformado", estado: "PENDIENTE", copias: "—" },
        ...(Number(cab.detraccion_monto ?? 0) > 0
          ? [{ nombre: "Constancia de depósito de detracción", estado: "PENDIENTE", copias: `${Number(cab.detraccion_pct ?? 0)}%` }]
          : []),
        { nombre: "SOAT y revisión técnica vigentes de las unidades", estado: "CONFORME", copias: "OK" },
        { nombre: "Licencias y habilitación de conductores", estado: "CONFORME", copias: "OK" },
      ];

  // ── QR + enlace público ──────────────────────────────────────────────────
  const url = opts.urlPublica ?? null;
  let qr: string | null = null;
  if (url && opts.conQr !== false) {
    try {
      const QRCode = (await import("qrcode")).default as any;
      qr = await QRCode.toDataURL(url, { margin: 1, width: 240 });
    } catch {
      qr = null;
    }
  }

  const nombreContraparte =
    lado === "cliente"
      ? (cp.empresa || cp.nombre || `Cliente ${cab.cliente_id}`)
      : (cp.razon_social || `Empresa ${cab.empresa_tercerizada_id}`);

  const totales =
    lado === "cliente"
      ? {
          servicios: sumar(lineasBd, ["servicio"]),
          adicionales: sumar(lineasBd, ["adicional"]),
          descuentos: Math.abs(sumar(lineasBd, ["penalidad", "descuento"])),
          subtotal: Number(cab.subtotal ?? 0),
          igvPct: Number(cab.igv_pct ?? 18),
          igv: Number(cab.igv ?? 0),
          total: Number(cab.total ?? 0),
        }
      : {
          servicios: sumar(lineasBd, ["servicio"]),
          adicionales: sumar(lineasBd, ["adicional"]),
          descuentos: Math.abs(sumar(lineasBd, ["penalidad", "descuento"])),
          subtotal: Number(cab.subtotal ?? 0),
          igvPct: Number(cab.igv_pct ?? 18),
          igv: Number(cab.igv ?? 0),
          total: Number(cab.total ?? 0),
          totalComprobante: Number(cab.total_comprobante ?? 0),
          detraccionPct: cab.detraccion_pct != null ? Number(cab.detraccion_pct) : null,
          detraccionMonto: Number(cab.detraccion_monto ?? 0),
          anticipos: Number(cab.anticipos ?? 0),
        };

  return {
    lado,
    control,
    codigo: cab.codigo || `#${id}`,
    estadoLabel: ESTADO_LABEL[cab.estado] ?? String(cab.estado ?? "").toUpperCase(),
    emitido: fFechaHora(cab.created_at) || fFecha(cab.fecha),
    contraparte: {
      nombre: nombreContraparte,
      ruc: cp.ruc || cp.dni || null,
      area: lado === "cliente" ? (cab.area_solicitante || sede?.area_solicitante || null) : (cab.responsable_afa || null),
      usuario: lado === "cliente" ? (cab.usuario_solicita || sede?.usuario_solicita || null) : (emp.razon_social || emp.nombre || "AFA TOURS PERU S.A.C."),
      cargo: lado === "cliente" ? (cab.cargo_solicita || sede?.cargo_solicita || null) : (cab.cargo_responsable || null),
      cuentaDetraccion: cab.cuenta_detraccion || null,
    },
    servicio: {
      contratado: cab.servicio_contratado || sede?.servicio_contratado || null,
      ubicacion: cab.ubicacion_servicio || sede?.ubicacion_servicio || null,
      periodo: cab.periodo || `${fFecha(cab.periodo_desde)} AL ${fFecha(cab.periodo_hasta)}`,
      inicio: fFecha(cab.fecha_inicio_servicio || cab.periodo_desde),
      fin: fFecha(cab.fecha_fin_servicio || cab.periodo_hasta),
      fechaValorizacion: fFecha(cab.fecha_valorizacion || cab.fecha),
      moneda: cab.moneda || "PEN",
      ordenCompra: cab.orden_compra || sede?.orden_compra || null,
    },
    lineas,
    totales,
    documentacion,
    conformidad: {
      estado: cab.conformidad_estado ?? "pendiente",
      grado: lado === "cliente" ? cab.grado_satisfaccion : cab.evaluacion,
      por: cab.conformidad_por,
      cargo: cab.conformidad_cargo ?? null,
      fecha: fFechaHora(cab.conformidad_at),
      ip: cab.conformidad_ip,
      canal: cab.conformidad_canal,
      sello: cab.conformidad_sello,
      comentario: cab.conformidad_comentario,
    },
    comentarios: cab.comentarios ?? "",
    anexo1,
    anexo2: opts.anexo2 ?? null,
    firmas:
      lado === "cliente"
        ? [
            { rol: "Gerente General", entidad: (emp.razon_social || emp.nombre || "AFA TOURS PERU S.A.C.").toUpperCase() },
            { rol: "Usuario", entidad: String(nombreContraparte).toUpperCase() },
            { rol: "Área solicitante", entidad: String(cab.area_solicitante || sede?.nombre || "—").toUpperCase() },
          ]
        : [
            { rol: "Proveedor", entidad: String(nombreContraparte).toUpperCase() },
            { rol: "Jefe de Operaciones", entidad: (emp.razon_social || emp.nombre || "AFA TOURS PERU S.A.C.").toUpperCase() },
            { rol: "Administración", entidad: (emp.razon_social || emp.nombre || "AFA TOURS PERU S.A.C.").toUpperCase() },
          ],
    // Con los huecos rellenos: hoy `empresa_perfil` tiene la dirección, el teléfono y el
    // correo vacíos, y pasarlos tal cual dejaba el pie del documento con tres rayas. Los
    // valores son los que ya imprime el PDF de la cotización, para que los papeles que AFA
    // envía digan lo mismo salgan de donde salgan.
    empresa: (() => {
      const e = empresaConDefectos(emp);
      return { nombre: e.nombre, ruc: e.ruc, logo: e.logo, direccion: e.direccion,
               telefono: e.telefono, email: e.email, web: e.web };
    })(),
    qr,
    urlVerificacion: url,
    aviso:
      cab.estado === "borrador"
        ? "DOCUMENTO EN BORRADOR — todavía no ha sido emitido ni enviado al cliente."
        : cab.estado === "anulada"
        ? "DOCUMENTO ANULADO — no tiene validez."
        : null,
  };
}

function sumar(lineas: any[], tipos: string[]): number {
  const n = lineas
    .filter((l) => tipos.includes(l.tipo))
    .reduce((a, l) => a + Number(l.total_linea ?? 0), 0);
  return Math.round(n * 100) / 100;
}
