// lib/radar/tipo-voucher.ts — QUÉ COMBUSTIBLE SE COMPRÓ: la conclusión de la IA contra el PAPEL.
// Módulo PURO: no lee la base, igual que coherencia-voucher.ts e identidad-voucher.ts.
//
// EL CASO REAL (nota V97T-00001413 de COESTI, 07/09/2026 17:24, CWQ400). El papel imprime:
//
//     040002072 UGL   9.417x      7.550
//       GLP-G                       71.10
//
// y la recarga entró al ERP como **DIÉSEL**. Los tres números estaban bien y cuadraban
// (9.417 × 7.550 = 71.10); lo único equivocado era el producto — y el producto estaba impreso
// en la foto, transcrito en el JSON y encima delatado por el precio: S/ 7.55 es GLP, el diésel
// de esa misma pantalla iba a S/ 23.88 y S/ 25.74.
//
// LA CAUSA NO FUE LA LECTURA, FUE EL `??`. `acciones.ts` resolvía el tipo así:
//
//     normalizarTipoCombustible(d.tipo_combustible) ?? normalizarTipoCombustible(d.producto_voucher)
//
// `tipo_combustible` es la CONCLUSIÓN de la IA; `producto_voucher` es la TRANSCRIPCIÓN del papel.
// El `??` convierte la transcripción en un RESPALDO que solo se consulta cuando la conclusión
// viene vacía — o sea, casi nunca. Con "diesel" ya concluido, el "GLP-G" impreso no se miraba
// jamás. Es el mismo error que este ERP ya arregló dos veces en otros campos: `esFalsaDiscrepancia`
// y `cantidad_no_coincide_texto` existen porque tener DOS lecturas del mismo hecho y no cotejarlas
// es peor que tener una sola — la segunda da la sensación de estar verificando algo.
//
// DOS REGLAS, Y HACEN TRABAJOS DISTINTOS:
//
//   · **EL PAPEL MANDA SOBRE LA CONCLUSIÓN.** Transcribir es copiar; tipificar es decidir. Cuando
//     el producto impreso nombra un combustible y la IA guardó otro, gana el impreso — es
//     exactamente lo que la doctrina del módulo ya declara ("EL TIPO SALE DEL PRODUCTO"), solo
//     que hasta ahora nadie lo verificaba del lado del ERP.
//
//   · **EL PRECIO SOLO AVISA, JAMÁS DECIDE.** Un GLP guardado como diésel deja un precio unitario
//     que se le va un 69 % al referencial del diésel y clava el del GLP al 1 %. Esa asimetría es
//     la misma firma que usa `detectarInversionCantidadPrecio`, y por eso comparte sus constantes.
//     Pero el tipo NO se reescribe desde el precio: el tipo sale del producto, y un precio no es
//     un producto. Los precios se mueven por resolución, hay promociones y hay grifos caros; lo
//     que se hace es NOMBRAR la sospecha y mandar la fila a revisión, que es donde el selector de
//     tipo ya existe y es obligatorio.
//
// LO QUE NO SE HACE, A PROPÓSITO: deducir el tipo de la UNIDAD. El ERP sabe qué combustible usa
// cada vehículo y da la tentación de zanjar con eso, pero una unidad con kit GLP carga GLP y
// gasolina, y el día que cargue lo otro el ERP lo "corregiría" al revés. El tipo es del despacho,
// no del bus.

import { normalizarTipoCombustible, familiaCombustible } from "@/lib/combustible-tipos";
import { CERCA_REFERENCIAL, LEJOS_REFERENCIAL } from "./coherencia-voucher";

/** De dónde salió el tipo que se va a guardar. Cada fuente se corrige en otro sitio. */
export type FuenteTipo = "producto" | "declarado" | "sin_dato";

export type AnomaliaTipo = {
  codigo:
    /** El producto impreso dice otro combustible que el que la IA concluyó: manda el papel. */
    | "tipo_corregido_por_producto"
    /** El papel contradice a la IA pero nombra más de un producto: no se adivina cuál. */
    | "tipo_no_coincide_con_producto"
    /** El precio pagado es el de otro combustible. Se avisa; no se reescribe nada. */
    | "tipo_no_coincide_con_precio";
  detalle: string;
  bloquea: true;
  correccion?: { campo: "tipo_combustible"; leido: string | null; corregido: string };
};

export type VeredictoTipo = {
  /** El tipo a guardar. `null` = sin señal: la columna sale vacía, que es lo honesto. */
  tipo: string | null;
  fuente: FuenteTipo;
  anomalia: AnomaliaTipo | null;
};

const etiqueta = (t: string) => t.replace(/_/g, " ");
const soles = (n: number) => `S/ ${n.toFixed(2)}`;

/**
 * TODOS los combustibles que nombra una descripción de producto, sin prioridades.
 *
 * `normalizarTipoCombustible` devuelve UNO —el primero por orden de prioridad—, que es lo correcto
 * cuando hay que elegir un valor para guardar y lo PELIGROSO cuando hay que decidir si el papel
 * contradice a la IA: un comprobante con dos líneas ("MAX-D DIESEL B5 S50" + "UREA") normaliza a
 * `urea` por el orden del catálogo, y "corregir" ahí un diésel bien leído sería inventar. Con la
 * lista completa se ve que el papel nombra dos cosas y que no hay un único producto que oponer.
 */
export function tiposEnTexto(texto?: string | null): string[] {
  const t = String(texto ?? "").trim();
  if (!t) return [];
  // Se parte por separadores de línea/ítem y se normaliza cada trozo: así "DIESEL + UREA" da los
  // dos, mientras que "MAX-D DIESEL B5 S50 UV" (un solo producto, varias palabras) sigue dando uno.
  const trozos = t.split(/[\n;,/|]+|\s+\+\s+/).map((s) => s.trim()).filter(Boolean);
  const vistos: string[] = [];
  for (const trozo of trozos.length > 1 ? trozos : [t]) {
    const tipo = normalizarTipoCombustible(trozo);
    if (tipo && !vistos.includes(tipo)) vistos.push(tipo);
  }
  return vistos;
}

/**
 * El tipo de combustible de una recarga, cotejando lo que la IA CONCLUYÓ contra lo que TRANSCRIBIÓ
 * del papel. Puro: los dos textos entran, el veredicto sale.
 */
export function resolverTipoCombustible(e: {
  /** `datos.tipo_combustible`: la clave que la IA eligió ("diesel", "glp"…). */
  declarado?: string | null;
  /** `datos.producto_voucher`: la descripción impresa, literal ("GLP-G", "MAX-D DIESEL B5 S50 UV"). */
  producto?: string | null;
}): VeredictoTipo {
  // El declarado se normaliza igual que antes: la IA puede mandar la clave del catálogo ("glp")
  // o la descripción entera, y las dos tienen que aterrizar en el mismo sitio.
  const declarado = normalizarTipoCombustible(e.declarado);
  const enProducto = tiposEnTexto(e.producto);

  // El papel no dice nada legible sobre el producto → queda lo que la IA concluyó, como siempre.
  // No hay con qué contradecirla, y callar aquí no es tragarse un error: es no inventarse uno.
  if (!enProducto.length) {
    return { tipo: declarado, fuente: declarado ? "declarado" : "sin_dato", anomalia: null };
  }

  // El papel nombra UNO SOLO. Es el caso de la nota de COESTI y el que importa.
  if (enProducto.length === 1) {
    const delPapel = enProducto[0];
    if (!declarado) {
      // La IA no concluyó nada pero transcribió el producto: esto es lo que el `??` sí hacía bien.
      return { tipo: delPapel, fuente: "producto", anomalia: null };
    }
    if (declarado === delPapel) return { tipo: declarado, fuente: "declarado", anomalia: null };
    return {
      tipo: delPapel,
      fuente: "producto",
      anomalia: {
        codigo: "tipo_corregido_por_producto",
        detalle:
          `La IA guardó "${etiqueta(declarado)}" pero el producto impreso en el voucher es ` +
          `"${String(e.producto).trim()}", que es ${etiqueta(delPapel)}. El tipo sale del PRODUCTO, ` +
          `no de la unidad ni del grifo, así que se corrigió a ${etiqueta(delPapel)} — confírmalo ` +
          `contra la foto. Registrarlo con el tipo equivocado ensucia la capacidad de tanque, el ` +
          `precio referencial y el rendimiento de esa unidad.`,
        bloquea: true,
        correccion: { campo: "tipo_combustible", leido: declarado, corregido: delPapel },
      },
    };
  }

  // El papel nombra VARIOS (un comprobante puede traer diésel + urea en dos líneas).
  // Si la IA eligió uno de ellos, es la línea principal y se respeta: para eso la eligió.
  if (declarado && enProducto.includes(declarado)) {
    return { tipo: declarado, fuente: "declarado", anomalia: null };
  }
  // Contradice al papel, pero el papel nombra más de un producto: NADIE ADIVINA CUÁL ES. Mismo
  // criterio que `cuadre_ambiguo` y que el dígito de más del odómetro — se nombra y decide una
  // persona, en vez de escribir un tipo al azar con cara de dato verificado.
  return {
    tipo: declarado ?? enProducto[0],
    fuente: declarado ? "declarado" : "producto",
    anomalia: {
      codigo: "tipo_no_coincide_con_producto",
      detalle:
        `El voucher nombra ${enProducto.map(etiqueta).join(" y ")} ("${String(e.producto).trim()}") ` +
        `y la IA guardó ${declarado ? `"${etiqueta(declarado)}"` : "nada"}, que no es ninguno de ellos. ` +
        `Como el comprobante trae más de un producto no se corrigió solo: elige cuál se despachó ` +
        `en esta carga.`,
      bloquea: true,
    },
  };
}

/**
 * ¿El precio pagado es el de OTRO combustible? Segunda evidencia, independiente del papel.
 *
 * Existe porque la primera regla necesita que la IA haya transcrito el producto, y cuando no lo
 * transcribe el tipo declarado queda sin nada que lo contradiga. El precio unitario sí es un
 * hecho del ERP: con GLP a S/ 7.65 y diésel a S/ 24.64, una carga "de diésel" a S/ 7.55 se
 * explica sola.
 *
 * **No reescribe el tipo.** Devuelve la anomalía para que la revise una persona, y avisa a quien
 * llama de que el precio YA quedó explicado: `precio_fuera_de_rango` encima sería el síntoma
 * acusado como si fuese la causa, igual que pasaba con la inversión cantidad↔precio.
 */
export function revisarTipoContraPrecio(e: {
  /** El tipo contra el que se está midiendo (el resuelto, o el diésel de respaldo). */
  tipo: string;
  precio: number | null;
  /** Filas de `precios_combustible`: `{ tipo, precio }`. Sin referencial no se juzga. */
  referenciales: { tipo: string; precio: number }[];
  /**
   * `false` = del voucher no salió ningún tipo y `tipo` es el diésel de respaldo. Cambia lo que
   * se puede AFIRMAR: la fila no quedó "guardada como diésel" —su columna está vacía— pero el
   * tanque y el rendimiento sí se juzgaron contra el diésel, así que el aviso sigue haciendo
   * falta. Decir "se guardó como diesel" sobre una columna vacía mandaría a corregir un dato
   * que nadie escribió.
   */
  leido?: boolean;
}): { anomalia: AnomaliaTipo | null; precioExplicado: boolean } {
  const nada = { anomalia: null, precioExplicado: false };
  const precio = Number(e.precio);
  if (!Number.isFinite(precio) || precio <= 0) return nada;

  // Los referenciales se indexan por FAMILIA: `gasolina_premium` y `gasolina_regular` comparten
  // la fila de gasolina si el operador no cargó una por grado, igual que hace el resto del módulo.
  const porFamilia = new Map<string, number>();
  for (const f of e.referenciales) {
    const p = Number(f.precio);
    const t = String(f.tipo ?? "").trim().toLowerCase();
    if (!t || !Number.isFinite(p) || p <= 0) continue;
    if (!porFamilia.has(t)) porFamilia.set(t, p);
    const fam = familiaCombustible(t);
    if (!porFamilia.has(fam)) porFamilia.set(fam, p);
  }

  const familiaActual = familiaCombustible(e.tipo);
  const refActual = porFamilia.get(String(e.tipo).toLowerCase()) ?? porFamilia.get(familiaActual);
  // Sin referencial del tipo declarado no hay contra qué medir. No se juzga, igual que la inversión.
  if (refActual == null) return nada;

  const desvio = (ref: number) => Math.abs(precio - ref) / ref;
  // El precio calza con lo declarado → no hay nada que mirar.
  if (desvio(refActual) <= LEJOS_REFERENCIAL) return nada;

  // Se exige evidencia por los DOS lados, igual que la inversión: el declarado claramente fuera
  // Y exactamente UNA familia que lo explique bien. Con dos candidatas empatadas se calla: sería
  // proponer un tipo al azar sobre una carga que quizá solo salió cara.
  const candidatas = [...porFamilia.entries()]
    .filter(([fam]) => fam !== familiaActual && fam === familiaCombustible(fam))
    .filter(([, ref]) => desvio(ref) <= CERCA_REFERENCIAL)
    .map(([fam, ref]) => ({ fam, ref }));
  if (candidatas.length !== 1) return nada;

  const { fam, ref } = candidatas[0];
  return {
    anomalia: {
      codigo: "tipo_no_coincide_con_precio",
      detalle:
        (e.leido === false
          ? `Del voucher no salió el tipo de combustible y se está tomando ${etiqueta(e.tipo)} por defecto, `
          : `Se guardó como ${etiqueta(e.tipo)}, `) +
        `pero se pagó ${soles(precio)} por unidad: eso se aleja un ` +
        `${Math.round(desvio(refActual) * 100)} % del referencial de ${etiqueta(familiaActual)} ` +
        `(${soles(refActual)}) y es casi exactamente el de ${etiqueta(fam)} (${soles(ref)}). ` +
        `Revisa qué producto imprime el voucher — el tipo NO se cambió solo, porque un precio no ` +
        `es un producto.`,
      bloquea: true,
    },
    // El precio ya tiene explicación: levantar además `precio_fuera_de_rango` sería acusar al
    // síntoma. Mismo criterio que la inversión cantidad↔precio.
    precioExplicado: true,
  };
}
