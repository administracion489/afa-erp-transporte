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

console.log(fallos === 0 ? "\nTODO OK" : `\n${fallos} FALLO(S)`);
process.exit(fallos === 0 ? 0 : 1);
