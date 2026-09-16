// Pruebas del MOTOR de publicación en redes sociales. NO tocan la base ni ninguna API:
// datos en memoria contra el módulo puro `lib/redes/plan.ts`.
// Uso:  npx tsx scripts/prueba-redes.mts   (sale con código 1 si algo falla)
//
// Lo que fijan, que es lo que duele si se rompe:
//
//   · NADA sale sin que una persona lo apruebe. Es el trato del módulo entero, y es la
//     única garantía que separa "el agente publica todos los días" de "el agente puede
//     poner cualquier cosa en la cara del cliente". Un post no se des-publica.
//   · El ESTADO DE WHATSAPP no se publica JAMÁS por API, pase lo que pase. No es
//     prudencia: no existe el endpoint, y un motor que algún día devolviera `listo` ahí
//     haría que el despachador intentara una llamada que no existe y diera la pieza por
//     publicada cuando nadie la vio.
//   · Lo ya publicado no se vuelve a publicar. El cron reintenta y el operador hace
//     doble clic; las dos cosas pasan.
//   · Los motivos de CONTENIDO ganan a `sin_aprobar`. Si no, la pantalla de revisión
//     diría "esperando aprobación" en las cinco filas y el texto que no cabe en
//     Instagram se descubriría de madrugada, ya aprobado y sin nadie mirando.
//   · Instagram nunca publica sin pieza, y YouTube/TikTok nunca publican con una imagen.

import {
  planDePublicacion,
  hhmm,
  type CuentaConectada,
  type EntradaPlan,
  type Media,
  type PublicacionEnPlan,
} from "../lib/redes/plan";
import {
  CAPACIDADES,
  MOTIVO_TEXTO,
  REDES,
  REDES_AUTOMATICAS,
  contarHashtags,
  largoTexto,
  motivoEsProblema,
  type ModoVideo,
  type MotivoDestino,
  type Red,
} from "../lib/redes/tipos";

import {
  AVISO_GUION,
  MAX_ESCENAS,
  MAX_ESCENA_SEG,
  MAX_SUBTEXTO,
  MAX_TITULO,
  MIN_ESCENA_SEG,
  MIN_TOTAL_SEG,
  MOVIMIENTOS,
  TRANSICIONES,
  describirEscena,
  duracionGuion,
  frasesDe,
  guionPorDefecto,
  normalizarGuion,
  recortarPalabras,
  type CodigoGuion,
  type Guion,
} from "../lib/redes/guion";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const IMG: Media = { tipo: "imagen", url: "https://cdn.afa/pieza.jpg", publica: true };
const VID: Media = { tipo: "video", url: "https://cdn.afa/reel.mp4", publica: true, duracion_seg: 22 };

const TODAS = [...REDES];

function pub(over: Partial<PublicacionEnPlan> = {}): PublicacionEnPlan {
  return {
    texto: "Hoy movemos al personal de SNACKS con unidades full equipo. #transporte",
    imagen: IMG,
    video: null,
    modo_video: "ninguno",
    redes: TODAS,
    aprobada: true,
    hora_programada_min: 8 * 60,
    ya_publicadas: [],
    ...over,
  };
}

const TODAS_CUENTAS: CuentaConectada[] = REDES.map((red) => ({ red, vigente: true, publicadas_hoy: 0 }));

function entrada(over: Partial<EntradaPlan> = {}): EntradaPlan {
  return { publicacion: pub(), cuentas: TODAS_CUENTAS, ahora_min: 9 * 60, ...over };
}

const motivoDe = (e: EntradaPlan, red: Red): MotivoDestino =>
  planDePublicacion(e).destinos.find((d) => d.red === red)!.motivo;

// ── 1 · Lo que no se puede aflojar ────────────────────────────────────────────
console.log("\n1 · Las garantías duras\n");

{
  // Sin aprobar no sale NADA, con todo lo demás perfecto.
  const e = entrada({ publicacion: pub({ aprobada: false, video: VID, modo_video: "propio" }) });
  const p = planDePublicacion(e);
  chk("sin aprobación no publica ninguna red", p.publican.length === 0, p.publican.join(","));
  chk(
    "y el motivo de las automáticas es 'sin_aprobar', no un fallo",
    REDES_AUTOMATICAS.every((r) => motivoDe(e, r) === "sin_aprobar"),
    REDES_AUTOMATICAS.map((r) => `${r}:${motivoDe(e, r)}`).join(" "),
  );

  // Aprobada y con video propio: salen las cuatro automáticas y el estado NO.
  const ok = entrada({ publicacion: pub({ video: VID, modo_video: "propio" }) });
  const po = planDePublicacion(ok);
  chk(
    "aprobada con video propio publica en las CUATRO redes con API",
    po.publican.length === 4 && REDES_AUTOMATICAS.every((r) => po.publican.includes(r)),
    po.publican.join(","),
  );
  chk(
    "el estado de WhatsApp queda en 'publicacion_manual' aunque esté todo listo",
    motivoDe(ok, "whatsapp_estado") === "publicacion_manual",
    motivoDe(ok, "whatsapp_estado"),
  );
}

{
  // Idempotencia: lo ya publicado no se repite ni forzando la hora.
  const e = entrada({
    publicacion: pub({ video: VID, modo_video: "propio", ya_publicadas: ["facebook", "instagram"] }),
    ahora_min: 23 * 60,
  });
  const p = planDePublicacion(e);
  chk(
    "lo ya publicado no vuelve a salir",
    !p.publican.includes("facebook") && !p.publican.includes("instagram"),
    p.publican.join(","),
  );
  chk(
    "y 'ya_publicada' gana incluso a la red apagada y a la falta de aprobación",
    motivoDe(
      entrada({
        publicacion: pub({ aprobada: false, redes: [], ya_publicadas: ["facebook"] }),
      }),
      "facebook",
    ) === "ya_publicada",
  );
}

{
  // El contenido se avisa ANTES de la aprobación. Es la decisión de orden del motor.
  const largo = "x".repeat(3000);
  const e = entrada({ publicacion: pub({ aprobada: false, texto: largo }) });
  chk(
    "un caption que no cabe en Instagram se dice aunque todavía no esté aprobada",
    motivoDe(e, "instagram") === "texto_largo",
    motivoDe(e, "instagram"),
  );
  chk(
    "y en Facebook, que sí lo admite, el motivo sigue siendo 'sin_aprobar'",
    motivoDe(e, "facebook") === "sin_aprobar",
    motivoDe(e, "facebook"),
  );
}

// ── 2 · Las tres opciones de video conviven ───────────────────────────────────
console.log("\n2 · Los tres modos de video\n");

{
  const sinVideo = entrada({ publicacion: pub({ modo_video: "ninguno" }) });
  const p = planDePublicacion(sinVideo);
  chk(
    "modo «sin video»: publican Facebook e Instagram con la imagen",
    p.publican.includes("facebook") && p.publican.includes("instagram"),
    p.publican.join(","),
  );
  chk(
    "y YouTube/TikTok se saltan DICIÉNDOLO ('falta_video'), sin inventar relleno",
    motivoDe(sinVideo, "youtube") === "falta_video" && motivoDe(sinVideo, "tiktok") === "falta_video",
    `yt:${motivoDe(sinVideo, "youtube")} tt:${motivoDe(sinVideo, "tiktok")}`,
  );
  chk(
    "'falta_video' NO alarma: es la elección del operador, no un fallo",
    !p.con_problema.includes("youtube") && !p.con_problema.includes("tiktok"),
    p.con_problema.join(","),
  );

  // Modo generado, todavía sin armar: motivo propio, distinto de 'falta_video'.
  const porArmar = entrada({ publicacion: pub({ modo_video: "generado", video: null }) });
  chk(
    "modo «generado» sin el archivo todavía → 'video_no_armado', no 'falta_video'",
    motivoDe(porArmar, "youtube") === "video_no_armado",
    motivoDe(porArmar, "youtube"),
  );
  chk(
    "modo «propio» sin archivo cargado → también 'video_no_armado', con otro detalle",
    motivoDe(entrada({ publicacion: pub({ modo_video: "propio", video: null }) }), "tiktok") ===
      "video_no_armado",
  );

  // Con el video ya armado, las cuatro salen.
  const armado = entrada({ publicacion: pub({ modo_video: "generado", video: VID }) });
  chk(
    "modo «generado» con el video ya montado publica en las cuatro",
    planDePublicacion(armado).publican.length === 4,
    planDePublicacion(armado).publican.join(","),
  );
}

{
  // Una red de imagen prefiere la IMAGEN aunque haya video.
  const ambos = entrada({ publicacion: pub({ imagen: IMG, video: VID, modo_video: "propio" }) });
  const d = planDePublicacion(ambos).destinos;
  chk(
    "con imagen y video, Facebook publica la imagen y YouTube el video",
    d.find((x) => x.red === "facebook")!.lleva === "imagen" &&
      d.find((x) => x.red === "youtube")!.lleva === "video",
    d.map((x) => `${x.red}:${x.lleva}`).join(" "),
  );
}

// ── 3 · Cuentas, cuota, horario y URL pública ─────────────────────────────────
console.log("\n3 · Cuenta, cuota, horario y descarga del archivo\n");

{
  const sinIg = entrada({ cuentas: TODAS_CUENTAS.filter((c) => c.red !== "instagram") });
  chk("una red sin conectar dice 'sin_cuenta'", motivoDe(sinIg, "instagram") === "sin_cuenta");

  const caducada = entrada({
    cuentas: TODAS_CUENTAS.map((c) => (c.red === "youtube" ? { ...c, vigente: false } : c)),
    publicacion: pub({ video: VID, modo_video: "propio" }),
  });
  chk("un token revocado dice 'cuenta_caducada'", motivoDe(caducada, "youtube") === "cuenta_caducada");
  chk(
    "y la cuenta caducada SÍ es un problema que se pinta en ámbar",
    planDePublicacion(caducada).con_problema.includes("youtube"),
  );

  const cuota = entrada({
    cuentas: TODAS_CUENTAS.map((c) => (c.red === "youtube" ? { ...c, publicadas_hoy: 6 } : c)),
    publicacion: pub({ video: VID, modo_video: "propio" }),
  });
  chk(
    "agotada la cuota diaria de YouTube (6 subidas = 10 000 unidades) no se intenta",
    motivoDe(cuota, "youtube") === "cuota_agotada",
    motivoDe(cuota, "youtube"),
  );
  chk(
    "y la cuota agotada NO alarma: se publica mañana y no hay nada que arreglar",
    !planDePublicacion(cuota).con_problema.includes("youtube"),
  );

  const temprano = entrada({ ahora_min: 7 * 60, publicacion: pub({ hora_programada_min: 8 * 60 }) });
  chk("antes de su hora dice 'fuera_de_horario'", motivoDe(temprano, "facebook") === "fuera_de_horario");
  chk("y el detalle nombra la hora", /08:00/.test(planDePublicacion(temprano).destinos[0].detalle ?? ""));

  const privada = entrada({
    publicacion: pub({ imagen: { ...IMG, publica: false } }),
  });
  chk(
    "una URL que Meta no puede descargar se detiene ANTES de la llamada",
    motivoDe(privada, "instagram") === "media_no_publica" &&
      motivoDe(privada, "facebook") === "media_no_publica",
  );
  chk(
    "pero TikTok y YouTube, que reciben el archivo, no se bloquean por eso",
    motivoDe(
      entrada({
        publicacion: pub({ video: { ...VID, publica: false }, modo_video: "propio" }),
      }),
      "youtube",
    ) === "listo",
  );
}

{
  // Duración fuera de rango, y el tri-estado del `null`.
  //
  // OJO con el montaje del caso: la duración solo se juzga sobre la pieza que ESA red
  // va a recibir, y con imagen cargada Instagram recibe la imagen. Sin `imagen: null`
  // esta prueba pasaba en verde sin haber llegado nunca al control de duración — que
  // es la forma más fácil de creer que una regla está probada cuando no lo está.
  const corto = entrada({
    publicacion: pub({ imagen: null, video: { ...VID, duracion_seg: 2 }, modo_video: "propio" }),
  });
  const detalleIg = planDePublicacion(corto).destinos.find((d) => d.red === "instagram")!.detalle;
  chk(
    "un video de 2 s no entra en Instagram (mínimo 3) y se dice con los números",
    motivoDe(corto, "instagram") === "duracion_video" && /2 s.*3.*900/.test(detalleIg ?? ""),
    `${motivoDe(corto, "instagram")} · ${detalleIg}`,
  );
  chk(
    "el mismo video de 2 s SÍ entra en Facebook, que admite desde 1 s",
    motivoDe(corto, "facebook") === "listo",
    motivoDe(corto, "facebook"),
  );
  chk(
    "con imagen cargada, Instagram publica la imagen y el video corto no la bloquea",
    motivoDe(
      entrada({ publicacion: pub({ video: { ...VID, duracion_seg: 2 }, modo_video: "propio" }) }),
      "instagram",
    ) === "listo",
  );
  chk(
    "sin duración medida NO se afirma que dure mal: se deja opinar a la red",
    motivoDe(
      entrada({
        publicacion: pub({ imagen: null, video: { ...VID, duracion_seg: null }, modo_video: "propio" }),
      }),
      "instagram",
    ) === "listo",
  );
}

{
  // Hashtags: se cuentan como los cuenta la red.
  chk("'#uno #dos' son 2 hashtags", contarHashtags("hola #uno #dos") === 2);
  chk("un '#' suelto y un 'a#b' no son hashtags", contarHashtags("# suelto a#b") === 0);
  const muchos = entrada({ publicacion: pub({ texto: Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" ") }) });
  chk(
    "31 hashtags no entran en Instagram (tope 30) y sí en Facebook",
    motivoDe(muchos, "instagram") === "exceso_hashtags" && motivoDe(muchos, "facebook") === "listo",
    `ig:${motivoDe(muchos, "instagram")} fb:${motivoDe(muchos, "facebook")}`,
  );
  chk("las tildes se cuentan como un carácter (NFC)", largoTexto("camión".normalize("NFD")) === 6);
}

// ── 4 · Invariantes por barrido ───────────────────────────────────────────────
console.log("\n4 · Invariantes por barrido\n");

{
  const textos = [
    "corto",
    "x".repeat(2500), // pasa IG, entra en FB y YT
    "x".repeat(6000), // pasa IG y YT, entra en FB
    Array.from({ length: 31 }, (_, i) => `#t${i}`).join(" "),
  ];
  const imagenes: (Media | null)[] = [null, IMG, { ...IMG, publica: false }];
  const videos: (Media | null)[] = [null, VID, { ...VID, duracion_seg: 1 }, { ...VID, publica: false }];
  const modos: ModoVideo[] = ["ninguno", "generado", "propio"];
  const setsRedes: Red[][] = [[], ["facebook"], ["instagram", "youtube"], TODAS];
  const setsCuentas: CuentaConectada[][] = [
    [],
    TODAS_CUENTAS,
    TODAS_CUENTAS.map((c) => ({ ...c, vigente: false })),
    TODAS_CUENTAS.map((c) => ({ ...c, publicadas_hoy: 99 })),
  ];
  const yaPub: Red[][] = [[], ["facebook", "youtube"]];

  let n = 0;
  let malPublica = 0;
  let malWhatsapp = 0;
  let malSinAprobar = 0;
  let malCobertura = 0;
  let malDisjunto = 0;
  let malProblema = 0;
  let malIgSinPieza = 0;
  let malVideoConImagen = 0;
  let malSinMotivo = 0;

  for (const texto of textos)
    for (const imagen of imagenes)
      for (const video of videos)
        for (const modo_video of modos)
          for (const redes of setsRedes)
            for (const cuentas of setsCuentas)
              for (const ya_publicadas of yaPub)
                for (const aprobada of [true, false])
                  for (const ahora_min of [7 * 60, 9 * 60]) {
                    n++;
                    const e: EntradaPlan = {
                      publicacion: pub({
                        texto,
                        imagen,
                        video,
                        modo_video,
                        redes,
                        aprobada,
                        ya_publicadas,
                      }),
                      cuentas,
                      ahora_min,
                    };
                    const p = planDePublicacion(e);

                    // (a) `publica` ⟺ motivo `listo`.
                    if (p.destinos.some((d) => d.publica !== (d.motivo === "listo"))) malPublica++;

                    // (b) El estado de WhatsApp NUNCA publica por API.
                    if (p.publican.includes("whatsapp_estado")) malWhatsapp++;

                    // (c) Sin aprobación no publica nadie.
                    if (!aprobada && p.publican.length > 0) malSinAprobar++;

                    // (d) Las cinco redes salen siempre, exactamente una vez.
                    if (
                      p.destinos.length !== REDES.length ||
                      new Set(p.destinos.map((d) => d.red)).size !== REDES.length
                    )
                      malCobertura++;

                    // (e) publican ∪ retenidos = todas, y son disjuntos.
                    if (
                      p.publican.length + p.retenidos.length !== REDES.length ||
                      p.publican.some((r) => p.retenidos.includes(r))
                    )
                      malDisjunto++;

                    // (f) con_problema ⊆ retenidos.
                    if (p.con_problema.some((r) => !p.retenidos.includes(r))) malProblema++;

                    // (g) Instagram no publica sin pieza.
                    const ig = p.destinos.find((d) => d.red === "instagram")!;
                    if (ig.publica && ig.lleva === "ninguna") malIgSinPieza++;

                    // (h) Las redes de solo video no publican una imagen.
                    for (const r of ["youtube", "tiktok"] as Red[]) {
                      const d = p.destinos.find((x) => x.red === r)!;
                      if (d.publica && d.lleva !== "video") malVideoConImagen++;
                    }

                    // (i) Todo motivo tiene texto en el catálogo.
                    if (p.destinos.some((d) => !MOTIVO_TEXTO[d.motivo])) malSinMotivo++;
                  }

  console.log(`  (${n.toLocaleString("es-PE")} combinaciones)`);
  chk("(a) publica ⟺ motivo 'listo'", malPublica === 0, `${malPublica} fallos`);
  chk("(b) el estado de WhatsApp NUNCA sale por API", malWhatsapp === 0, `${malWhatsapp} fallos`);
  chk("(c) sin aprobación no publica nadie, nunca", malSinAprobar === 0, `${malSinAprobar} fallos`);
  chk("(d) las cinco redes aparecen siempre, una vez cada una", malCobertura === 0, `${malCobertura} fallos`);
  chk("(e) publican/retenidos: disjuntos y exhaustivos", malDisjunto === 0, `${malDisjunto} fallos`);
  chk("(f) con_problema ⊆ retenidos", malProblema === 0, `${malProblema} fallos`);
  chk("(g) Instagram nunca publica sin pieza", malIgSinPieza === 0, `${malIgSinPieza} fallos`);
  chk("(h) YouTube y TikTok nunca publican una imagen", malVideoConImagen === 0, `${malVideoConImagen} fallos`);
  chk("(i) todo motivo emitido tiene texto y arreglo en el catálogo", malSinMotivo === 0, `${malSinMotivo} fallos`);
}

// ── 5 · Coherencia del catálogo ───────────────────────────────────────────────
console.log("\n5 · El catálogo se describe a sí mismo\n");

{
  chk(
    "toda red del catálogo declara etiqueta, topes y qué acepta",
    REDES.every((r) => CAPACIDADES[r].etiqueta && CAPACIDADES[r].maxTexto > 0 && CAPACIDADES[r].acepta.length > 0),
  );
  chk(
    "las redes automáticas son exactamente las que publican por API",
    REDES_AUTOMATICAS.length === 4 && !REDES_AUTOMATICAS.includes("whatsapp_estado"),
    REDES_AUTOMATICAS.join(","),
  );
  chk(
    "toda red que publica video declara su rango de duración",
    REDES.every((r) => !CAPACIDADES[r].acepta.includes("video") || CAPACIDADES[r].duracionVideoSeg !== null),
  );
  chk(
    "las tres redes con trámite pendiente lo DICEN en su advertencia",
    (["instagram", "tiktok", "youtube"] as Red[]).every((r) => (CAPACIDADES[r].advertencia ?? "").length > 40),
  );
  chk(
    "'listo' es el único motivo que no es problema y tampoco necesita arreglo",
    MOTIVO_TEXTO.listo.arreglo === "" && !motivoEsProblema("listo"),
  );
  const conArreglo: MotivoDestino[] = [
    "sin_cuenta",
    "cuenta_caducada",
    "falta_media",
    "falta_video",
    "video_no_armado",
    "texto_largo",
    "exceso_hashtags",
    "duracion_video",
    "media_no_publica",
  ];
  chk(
    "todo motivo accionable nombra DÓNDE se arregla",
    conArreglo.every((m) => MOTIVO_TEXTO[m].arreglo.length > 20),
    conArreglo.filter((m) => MOTIVO_TEXTO[m].arreglo.length <= 20).join(","),
  );
  chk("hhmm redondea bien", hhmm(0) === "00:00" && hhmm(8 * 60) === "08:00" && hhmm(23 * 60 + 59) === "23:59");
}

// ── 6 · El GUION del video ────────────────────────────────────────────────────
//
// Lo que fija, y por qué duele si se rompe:
//
//   · EL TEXTO DE PANTALLA NO ES EL CAPTION. Es el defecto que este módulo vino a
//     corregir: la versión anterior pegaba el caption entero —hashtags incluidos— sobre
//     una foto fija. Ninguna escena puede pasar de `MAX_TITULO` ni llevar un hashtag.
//   · NORMALIZAR ES IDEMPOTENTE. Se llama en tres sitios (al recibirlo del modelo, al
//     leerlo de la base y antes de montar); si no lo fuera, cada guardado añadiría otra
//     tarjeta de cierre y el video crecería solo.
//   · TODO LO QUE SALE ES MONTABLE. Un guion del modelo con basura dentro no puede llegar
//     al canvas con un índice de foto que no existe, una duración de 40 s o un movimiento
//     inventado: ahí no falla la prueba, falla el video que se publica.
//   · TODO ARREGLO DEJA SU CÓDIGO. Corregir en silencio es que nadie sepa que se corrigió.
console.log("\n6 · El guion del video\n");

{
  const FOTOS = ["https://cdn.afa/1.jpg", "https://cdn.afa/2.jpg", "https://cdn.afa/3.jpg"];
  const CAPTION =
    "Cada mañana movemos al personal de nuestros clientes con unidades revisadas y " +
    "conductores con su documentación al día. Coordinamos rutas y horarios con cada " +
    "empresa para que nadie llegue tarde a su turno.\n\n#transporte #transportedepersonal #peru";
  const base = { texto: CAPTION, imagenes: FOTOS, marca: "AFA Transportes" };

  const valido = (g: Guion, nImg: number): string[] => {
    const malos: string[] = [];
    if (!g.escenas.length) malos.push("sin escenas");
    if (g.escenas.length > MAX_ESCENAS) malos.push("demasiadas escenas");
    g.escenas.forEach((e, i) => {
      if (e.duracion_seg < MIN_ESCENA_SEG || e.duracion_seg > MAX_ESCENA_SEG) {
        // La última puede haberse alargado para llegar al piso del total; aun así el
        // alargue jamás puede pasar de MAX_ESCENA_SEG, o normalizar dejaría de ser
        // idempotente (la segunda pasada la recortaría).
        malos.push(`duración fuera de banda en ${i}: ${e.duracion_seg}`);
      }
      if (e.imagen !== null && (e.imagen < 0 || e.imagen >= nImg || !Number.isInteger(e.imagen))) {
        malos.push(`imagen inválida en ${i}: ${e.imagen}`);
      }
      if (!MOVIMIENTOS.includes(e.movimiento)) malos.push(`movimiento inválido en ${i}`);
      if (!TRANSICIONES.includes(e.transicion)) malos.push(`transición inválida en ${i}`);
      if ((e.titulo?.length ?? 0) > MAX_TITULO) malos.push(`título largo en ${i}`);
      if ((e.texto?.length ?? 0) > MAX_SUBTEXTO) malos.push(`subtexto largo en ${i}`);
      if (/#/.test(e.titulo ?? "") || /#/.test(e.texto ?? "")) malos.push(`hashtag en pantalla en ${i}`);
    });
    if (g.escenas[0].transicion !== "corte") malos.push("la primera escena entra con transición");
    if (g.escenas.filter((e) => e.tipo === "cierre").length > 1) malos.push("más de un cierre");
    if (duracionGuion(g) < MIN_TOTAL_SEG) malos.push(`total corto: ${duracionGuion(g)}`);
    return malos;
  };

  // (a) El defecto que motivó el módulo: el caption NO se vuelca en pantalla.
  const porDefecto = guionPorDefecto(base);
  chk("el guion por defecto es montable", valido(porDefecto, FOTOS.length).length === 0, valido(porDefecto, FOTOS.length).join(" · "));
  chk(
    "ninguna escena repite el caption entero (es el defecto que se corrigió)",
    porDefecto.escenas.every((e) => (e.titulo ?? "").length <= MAX_TITULO && !(e.titulo ?? "").includes("#")),
  );
  chk("el guion por defecto estrena las fotos que hay", new Set(porDefecto.escenas.map((e) => e.imagen)).size >= 3);
  chk("frasesDe quita los hashtags", frasesDe(CAPTION).every((f) => !f.includes("#")));
  // El prompt ya se lo prohíbe al modelo, pero un prompt no es un guard: el ERP lo
  // comprueba por su cuenta, igual que con el cuadre del voucher.
  {
    const conTag = normalizarGuion({ escenas: [{ imagen: 0, titulo: "Rutas puntuales #AFA", duracion_seg: 3 }] }, base);
    chk("un hashtag en el texto de pantalla se limpia", conTag.guion.escenas[0].titulo === "Rutas puntuales AFA", conTag.guion.escenas[0].titulo);
    chk("…y se declara", conTag.avisos.includes("hashtag_quitado"));
  }

  // (b) Idempotencia — la que evita que el cierre se duplique en cada guardado.
  const n1 = normalizarGuion(porDefecto, base).guion;
  const n2 = normalizarGuion(n1, base).guion;
  const n3 = normalizarGuion(n2, base).guion;
  chk("normalizar es idempotente (3 pasadas dan lo mismo)", JSON.stringify(n1) === JSON.stringify(n3), `${n1.escenas.length} vs ${n3.escenas.length}`);
  chk("no se acumulan cierres al re-normalizar", n3.escenas.filter((e) => e.tipo === "cierre").length === 1);
  chk("re-normalizar un guion limpio no levanta avisos", normalizarGuion(n1, base).avisos.length === 0, normalizarGuion(n1, base).avisos.join(","));

  // (c) Basura del modelo: se arregla, se declara y sale montable.
  const basura = {
    escenas: [
      { imagen: 99, titulo: CAPTION, movimiento: "tiktok_cool", duracion_seg: 45, transicion: "explosion" },
      { imagen: "1", texto: CAPTION, duracion_seg: 0.05 },
      { imagen: null, titulo: "Remate", duracion_seg: "tres" },
      ...Array.from({ length: 12 }, (_, i) => ({ imagen: i, titulo: `escena ${i}`, duracion_seg: 3 })),
    ],
  };
  const sucio = normalizarGuion(basura, base);
  const malSucio = valido(sucio.guion, FOTOS.length);
  chk("un guion con basura dentro sale montable igual", malSucio.length === 0, malSucio.join(" · "));
  chk("…y DECLARA lo que arregló", ["escenas_recortadas", "duracion_ajustada", "imagen_fuera_de_rango", "texto_recortado", "valor_desconocido"].every((c) => sucio.avisos.includes(c as CodigoGuion)), sucio.avisos.join(","));
  chk("…y no se da por escrito por la IA cuando no quedó nada", normalizarGuion({}, base).usoDefecto === true);
  chk("un guion vacío declara sin_escenas", normalizarGuion({ escenas: [] }, base).avisos.includes("sin_escenas"));

  // (d) Sin fotos NO se afirma que todo está bien: se dice.
  chk("sin imágenes se declara sin_imagenes", normalizarGuion(basura, { ...base, imagenes: [] }).avisos.includes("sin_imagenes"));
  chk(
    "sin imágenes ninguna escena apunta a una foto",
    normalizarGuion(basura, { ...base, imagenes: [] }).guion.escenas.every((e) => e.imagen === null),
  );

  // (e) El piso del total. Un guion de una escena corta sería impublicable en Reels.
  const corto = normalizarGuion({ escenas: [{ imagen: 0, titulo: "Hola", duracion_seg: 1.2 }] }, { texto: "Hola", imagenes: FOTOS });
  chk("un guion demasiado corto se alarga hasta el mínimo publicable", duracionGuion(corto.guion) >= MIN_TOTAL_SEG, `${duracionGuion(corto.guion)} s`);
  chk("…y lo dice", corto.avisos.includes("total_alargado"));
  chk("…sin pasarse del tope por escena (o dejaría de ser idempotente)", corto.guion.escenas.every((e) => e.duracion_seg <= MAX_ESCENA_SEG));

  // (f) Barrido: ninguna combinación produce un guion que el canvas no pueda pintar.
  let malBarrido = 0;
  let malIdem = 0;
  let n = 0;
  const TITULOS = ["", "Corto", CAPTION, "#solohashtags #otro", "  espacios   raros  "];
  const DURS: any[] = [-3, 0, 0.4, 3, 9, 1e9, "x", null];
  const IMGS: any[] = [-1, 0, 2, 7, null, "1", undefined];
  const MOVS: any[] = ["zoom_in", "nope", undefined];
  const NFOTOS = [0, 1, 3];
  for (const t of TITULOS)
    for (const d of DURS)
      for (const im of IMGS)
        for (const mv of MOVS)
          for (const nf of NFOTOS) {
            n++;
            const opts = { texto: CAPTION, imagenes: FOTOS.slice(0, nf), marca: "AFA Transportes" };
            const r = normalizarGuion(
              { escenas: [{ imagen: im, titulo: t, movimiento: mv, duracion_seg: d }, { imagen: im, titulo: t, duracion_seg: d }] },
              opts,
            );
            if (valido(r.guion, Math.max(1, nf)).length) malBarrido++;
            // Idempotencia también sobre lo corregido: es donde se rompería.
            const otra = normalizarGuion(r.guion, opts).guion;
            if (JSON.stringify(otra) !== JSON.stringify(r.guion)) malIdem++;
          }
  console.log(`  (${n.toLocaleString("es-PE")} combinaciones)`);
  chk("(barrido) todo guion normalizado es montable", malBarrido === 0, `${malBarrido} fallos`);
  chk("(barrido) normalizar dos veces da lo mismo", malIdem === 0, `${malIdem} fallos`);

  // (g) El catálogo de avisos se describe a sí mismo.
  const CODIGOS: CodigoGuion[] = ["sin_escenas", "escenas_recortadas", "duracion_ajustada", "total_alargado", "imagen_fuera_de_rango", "texto_recortado", "valor_desconocido", "hashtag_quitado", "sin_imagenes"];
  chk("todo código de guion tiene texto para la pantalla", CODIGOS.every((c) => (AVISO_GUION[c] ?? "").length > 25));
  chk(
    "describirEscena nombra la foto, la duración y el texto",
    describirEscena({ imagen: 1, titulo: "Ruta lista", movimiento: "pan_der", duracion_seg: 3, transicion: "corte" }, 0)
      .includes("foto 2") &&
      describirEscena({ imagen: 1, titulo: "Ruta lista", movimiento: "pan_der", duracion_seg: 3, transicion: "corte" }, 0)
        .includes("3 s"),
  );
  chk(
    "recortarPalabras no parte palabras por la mitad",
    recortarPalabras("transporte de personal ejecutivo", 20) === "transporte de…",
    recortarPalabras("transporte de personal ejecutivo", 20),
  );
  chk("recortarPalabras nunca pasa del tope", [5, 12, 48].every((m) => recortarPalabras(CAPTION, m).length <= m));
}

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
