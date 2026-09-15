// Pruebas de QUIÉN PUEDE ENTRAR AL MANIFIESTO Y POR QUÉ. NO tocan la base: datos en
// memoria contra el módulo puro (lib/manifiesto-nomina.ts).
// Uso:  npx tsx scripts/prueba-manifiesto-nomina.mts   (sale con código 1 si algo falla)
//
// EL CASO REAL (15-09-2026, reportado por el dueño). VELIZ QUEZADA GIANFRANCO y CHAVEZ
// ROJAS CHRIS estaban dados de alta en la nómina de SNACKS AMERICA LATINA y el manifiesto
// de la reserva #25525 —15 de 30 asientos ocupados, o sea con sitio de sobra— no dejaba
// agregarlos por ninguna puerta. Al buscarlos en «Agregar desde nómina» la pantalla
// contestaba: «Todos los pasajeros de la nómina ya están en este servicio».
//
// LA CAUSA es `uq_pasajero_cliente_dni`, único sobre (dni, cliente_id) SIN `reserva_id`:
// la ficha de una persona es UNA, y o es de nómina (`reserva_id` null) o la ocupa un
// servicio concreto. El panel pedía solo las de nómina, y las dos altas del manifiesto
// insertaban una segunda fila con la misma pareja — que la unique rechaza siempre.
//
// LO QUE FIJA ESTA MATRIZ, y la segunda mitad es la que importa:
//
//   · Que el defecto se reproduce con el algoritmo VIEJO, copiado literal más abajo. Si
//     deja de reproducirlo, el escenario dejó de ser el que se rompió.
//   · EL LADO QUE NO SE PUEDE AFLOJAR: no se puede ofrecer a quien ya viaja (sería
//     duplicarlo en el manifiesto) ni dar por buena una alta que duplicaría una ficha
//     (sería el error de Postgres otra vez). Un motor que ofreciera a todo el mundo
//     cumpliría de forma trivial todo lo demás.
import {
  clasificarPadron, filtrarCandidatos, motivoPanelVacio, planDeAlta, claveTexto, claveDni,
  type PersonaCliente, type EnManifiesto,
} from "../lib/manifiesto-nomina";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const sec = (t: string) => console.log(`\n── ${t} ${"─".repeat(Math.max(0, 74 - t.length))}`);

const RESERVA = 25525;
const OTRO_SERVICIO = 25400;

const persona = (p: Partial<PersonaCliente> & { id: number; nombre: string }): PersonaCliente => ({
  dni: null, empresa: null, telefono: null, reserva_id: null, ...p,
});

// El manifiesto real de la #25525: 15 pasajeros de SNACKS, fichas ad-hoc de ese servicio.
const EN_MANIFIESTO: EnManifiesto[] = [
  { id: 1, nombre: "ALVARADO ESTRELLA ROHNNY SAUL",  dni: "72955401" },
  { id: 2, nombre: "SERRANO GUTIERREZ FRANCISCO J.", dni: "41165632" },
  { id: 3, nombre: "CABEZAS OTAROLA OLIMPIA E.",     dni: "45697050" },
  { id: 4, nombre: "HUAMANI PERALTA ORLANDO MARTIN", dni: "45770330" },
];

const VELIZ  = persona({ id: 90, nombre: "VELIZ QUEZADA GIANFRANCO", dni: "70123456", empresa: "SNACKS AMERICA LATINA S.R.L." });
const CHAVEZ = persona({ id: 91, nombre: "CHAVEZ ROJAS CHRIS",       dni: "70765432", empresa: "SNACKS AMERICA LATINA S.R.L." });

// ── El algoritmo VIEJO, copiado literal de ModalManifiesto.tsx ────────────────────────
// (1) el panel pedía `.is("reserva_id", null)` — aquí, el filtro equivalente sobre el
// padrón; (2) descartaba por DNI ya embarcado y (3) filtraba por texto en minúsculas.
// Se conserva para que la matriz DEMUESTRE el defecto en vez de describirlo.
const VIEJO_panel = (padron: PersonaCliente[], enManifiesto: EnManifiesto[], busq: string) => {
  const soloNomina = padron.filter((p) => p.reserva_id == null);          // la consulta
  const dnis = new Set(enManifiesto.map((p) => p.dni).filter(Boolean));
  const disponibles = soloNomina.filter((p) => !dnis.has(p.dni));
  const q = busq.toLowerCase().trim();
  if (!q) return disponibles;
  return disponibles.filter((p) =>
    p.nombre.toLowerCase().includes(q) ||
    (p.dni || "").toLowerCase().includes(q) ||
    (p.empresa || "").toLowerCase().includes(q));
};
const VIEJO_mensajeVacio = (padronNomina: number) =>
  padronNomina === 0 ? "La nómina de este cliente está vacía."
                     : "Todos los pasajeros de la nómina ya están en este servicio.";

sec("1 · EL CASO #25525 SE REPRODUCE CON EL ALGORITMO VIEJO");
{
  // Las dos fichas existen, pero las ocupa OTRO servicio: es como quedan cuando se dieron
  // de alta desde el manifiesto de aquel (la fila de nómina que el ERP decía crear jamás
  // llegó a existir, la rechazaba la unique).
  const padron = [
    { ...VELIZ,  reserva_id: OTRO_SERVICIO },
    { ...CHAVEZ, reserva_id: OTRO_SERVICIO },
    persona({ id: 1, nombre: "ALVARADO ESTRELLA ROHNNY SAUL", dni: "72955401" }),
  ];

  const viejo = VIEJO_panel(padron, EN_MANIFIESTO, "chavez rojas chris");
  chk("VIEJO: buscar «chavez rojas chris» no devuelve a nadie", viejo.length === 0);
  chk("VIEJO: y el vacío afirma que ya están todos en el servicio",
      VIEJO_mensajeVacio(padron.filter(p => p.reserva_id == null).length)
        === "Todos los pasajeros de la nómina ya están en este servicio.");

  const { todos } = clasificarPadron(padron, EN_MANIFIESTO, RESERVA);
  const hoy = filtrarCandidatos(todos, "chavez rojas chris");
  chk("AHORA: aparece, y es agregable", hoy.length === 1 && hoy[0].ofrecible === true);
  chk("AHORA: con su código y el servicio que tiene la ficha",
      hoy[0].codigo === "en_otro_servicio" && hoy[0].detalle.includes("#" + OTRO_SERVICIO),
      hoy[0].detalle);

  const veliz = filtrarCandidatos(todos, "VELIZ QUEZADA GIANFRANC");
  chk("AHORA: VELIZ igual, con el nombre tecleado en MAYÚSCULAS y a medias",
      veliz.length === 1 && veliz[0].persona.id === VELIZ.id && veliz[0].ofrecible);
}

sec("2 · EL VACÍO NOMBRA SU CAUSA (la frase que mentía)");
{
  const m = (args: Parameters<typeof motivoPanelVacio>[0]) => motivoPanelVacio(args);
  chk("con búsqueda sin coincidencias NO dice «ya están todos»",
      m({ hayCliente: true, padron: 120, busqueda: "chavez rojas chris" }).codigo === "sin_coincidencias");
  chk("…y el texto repite lo tecleado y dónde seguir",
      m({ hayCliente: true, padron: 120, busqueda: "chavez" }).texto.includes("«chavez»") &&
      m({ hayCliente: true, padron: 120, busqueda: "chavez" }).texto.includes("+ Agregar 1 pasajero"));
  chk("sin búsqueda y con padrón sí es «todos en el servicio»",
      m({ hayCliente: true, padron: 120, busqueda: "" }).codigo === "todos_en_servicio");
  chk("padrón vacío se distingue de sin coincidencias",
      m({ hayCliente: true, padron: 0, busqueda: "" }).codigo === "padron_vacio" &&
      m({ hayCliente: true, padron: 0, busqueda: "x" }).codigo === "padron_vacio");
  chk("sin cliente no se culpa a la nómina",
      m({ hayCliente: false, padron: 0, busqueda: "" }).codigo === "sin_cliente");
  chk("los espacios no cuentan como búsqueda",
      m({ hayCliente: true, padron: 9, busqueda: "   " }).codigo === "todos_en_servicio");
}

sec("3 · CLASIFICAR: disjunto, exhaustivo y con el motivo declarado");
{
  const padron: PersonaCliente[] = [
    persona({ id: 1, nombre: "ALVARADO ESTRELLA ROHNNY SAUL", dni: "72955401" }),           // ya viaja (por id)
    persona({ id: 20, nombre: "OTRO QUE NO VIAJA", dni: "45770330" }),                       // DNI de HUAMANI
    persona({ id: 30, nombre: "LIBRE EN NOMINA", dni: "10101010" }),
    { ...VELIZ, reserva_id: OTRO_SERVICIO },
    persona({ id: 40, nombre: "AD-HOC DE ESTE SERVICIO", dni: "20202020", reserva_id: RESERVA }),
    persona({ id: 50, nombre: "SIN DNI", dni: null }),
  ];
  const { ofrecibles, observados, todos } = clasificarPadron(padron, EN_MANIFIESTO, RESERVA);

  chk("ofrecibles ∪ observados = padrón, sin solapes",
      ofrecibles.length + observados.length === padron.length && todos.length === padron.length &&
      ofrecibles.every((c) => !observados.some((o) => o.persona.id === c.persona.id)));
  chk("ofrecible ⇔ código agregable",
      todos.every((c) => c.ofrecible === (c.codigo === "en_nomina" || c.codigo === "en_otro_servicio")));
  chk("todo candidato trae detalle no vacío", todos.every((c) => c.detalle.trim() !== ""));

  const por = (id: number) => todos.find((c) => c.persona.id === id)!;
  chk("quien ya viaja no se ofrece (por id)", por(1).codigo === "ya_en_este_servicio" && !por(1).ofrecible);
  chk("la ficha ad-hoc de ESTE servicio tampoco", por(40).codigo === "ya_en_este_servicio");
  chk("el DNI ocupado por otro se ve, no se esconde, y NOMBRA al otro",
      por(20).codigo === "dni_ocupado_por_otro" && !por(20).ofrecible &&
      por(20).detalle.includes("HUAMANI PERALTA ORLANDO MARTIN"), por(20).detalle);
  chk("la fila de nómina libre se ofrece", por(30).codigo === "en_nomina" && por(30).ofrecible);
  chk("la ficha de otro servicio se ofrece", por(90).codigo === "en_otro_servicio" && por(90).ofrecible);
  chk("sin DNI no choca con nadie y se ofrece", por(50).codigo === "en_nomina" && por(50).ofrecible);
}

sec("4 · BUSCAR: acentos, mayúsculas y espacios de más no pueden esconder a nadie");
{
  const padron = [
    persona({ id: 60, nombre: "CHÁVEZ ROJAS CHRISTIAN", dni: "70765432", empresa: "SNACKS AMÉRICA LATINA S.R.L." }),
    persona({ id: 61, nombre: "PEREZ  GOMEZ   ANA", dni: "80808080" }),
  ];
  const { todos } = clasificarPadron(padron, [], RESERVA);

  chk("VIEJO: «chavez» no encuentra a «CHÁVEZ»", VIEJO_panel(padron, [], "chavez").length === 0);
  chk("AHORA: sí lo encuentra", filtrarCandidatos(todos, "chavez").length === 1);
  chk("busca por DNI", filtrarCandidatos(todos, "70765432").length === 1);
  chk("busca por empresa, con y sin tilde", filtrarCandidatos(todos, "america latina").length === 1);
  chk("el nombre con espacios dobles se encuentra tecleado normal",
      filtrarCandidatos(todos, "perez gomez ana").length === 1);
  chk("búsqueda vacía no filtra", filtrarCandidatos(todos, "").length === 2);
  chk("claveTexto no se persiste jamás (solo compara)",
      claveTexto(" ÁÉÍ  ó ") === "aei o" && claveDni(" 123 ") === "123");
}

sec("5 · ALTA: nunca se duplica una ficha (el error crudo de Postgres)");
{
  const base = { enManifiesto: EN_MANIFIESTO, reservaId: RESERVA };

  const nuevo = planDeAlta({ ...base, dni: "99999999", nombre: "ALGUIEN NUEVO", existente: null });
  chk("sin ficha previa se CREA", nuevo.codigo === "crear" && nuevo.puede && nuevo.pasajeroId === null);

  const conNomina = planDeAlta({ ...base, dni: "10101010", nombre: "LIBRE EN NOMINA",
    existente: persona({ id: 30, nombre: "LIBRE EN NOMINA", dni: "10101010" }) });
  chk("con ficha de nómina se REUSA su id, no se inserta",
      conNomina.codigo === "reusar" && conNomina.puede && conNomina.pasajeroId === 30);

  const conOtra = planDeAlta({ ...base, dni: VELIZ.dni!, nombre: VELIZ.nombre,
    existente: { ...VELIZ, reserva_id: OTRO_SERVICIO } });
  chk("con ficha tomada por otro servicio TAMBIÉN se reusa (era el 23505)",
      conOtra.codigo === "reusar" && conOtra.puede && conOtra.pasajeroId === VELIZ.id);
  chk("…y el aviso nombra al servicio que la tiene", conOtra.aviso.includes("#" + OTRO_SERVICIO), conOtra.aviso);

  const yaViaja = planDeAlta({ ...base, dni: "72955401", nombre: "ALVARADO ESTRELLA ROHNNY SAUL",
    existente: persona({ id: 1, nombre: "ALVARADO ESTRELLA ROHNNY SAUL", dni: "72955401" }) });
  chk("quien ya viaja NO se vuelve a agregar", yaViaja.codigo === "ya_en_este_servicio" && !yaViaja.puede);

  const dniDeOtro = planDeAlta({ ...base, dni: "45770330", nombre: "HOMONIMO MAL TECLEADO", existente: null });
  chk("un DNI que ya viaja a nombre de otro se RECHAZA y lo nombra",
      dniDeOtro.codigo === "dni_ocupado_por_otro" && !dniDeOtro.puede &&
      dniDeOtro.aviso.includes("HUAMANI PERALTA ORLANDO MARTIN"), dniDeOtro.aviso);

  const sinDni = planDeAlta({ ...base, dni: "", nombre: "SIN DOCUMENTO", existente: null });
  chk("DNI vacío no empareja con nadie: se crea", sinDni.codigo === "crear" && sinDni.puede);
}

sec("6 · INVARIANTES POR BARRIDO (lo que no se puede aflojar)");
{
  // Todas las combinaciones de: dónde vive la ficha × si su DNI ya viaja × si es la misma
  // persona que viaja. Lo que se fija es que JAMÁS se ofrezca ni se dé por buena un alta
  // que terminaría en fila duplicada (el 23505) o en pasajero repetido en el manifiesto.
  const ubicaciones: Array<number | null> = [null, RESERVA, OTRO_SERVICIO];
  let casos = 0;
  let ofreceAlgunoQueYaViaja = false;
  let permiteAltaQueDuplicaria = false;
  let algunSinCodigo = false;
  let seOfreceAlgo = false;

  for (const reserva_id of ubicaciones) {
    for (const dni of ["70123456", "72955401", "", null] as Array<string | null>) {
      for (const id of [900, 1]) {
        casos++;
        const p = persona({ id, nombre: "X", dni, reserva_id });
        const { todos } = clasificarPadron([p], EN_MANIFIESTO, RESERVA);
        const c = todos[0];
        if (!c.codigo) algunSinCodigo = true;
        if (c.ofrecible) {
          seOfreceAlgo = true;
          const yaPorId  = EN_MANIFIESTO.some((e) => e.id === p.id);
          const yaPorDni = !!claveDni(dni) && EN_MANIFIESTO.some((e) => claveDni(e.dni) === claveDni(dni));
          if (yaPorId || yaPorDni || reserva_id === RESERVA) ofreceAlgunoQueYaViaja = true;
        }

        const plan = planDeAlta({ dni: dni ?? "", nombre: "X", existente: p, enManifiesto: EN_MANIFIESTO, reservaId: RESERVA });
        // "crear" con ficha existente sería justo el INSERT que la unique rechaza.
        if (plan.puede && plan.codigo === "crear") permiteAltaQueDuplicaria = true;
        if (!plan.puede && plan.aviso.trim() === "") algunSinCodigo = true;
      }
    }
  }

  chk(`barrido de ${casos} combinaciones: ninguna ofrece a quien ya viaja`, !ofreceAlgunoQueYaViaja);
  chk("ninguna alta con ficha existente propone INSERTAR (sería el 23505)", !permiteAltaQueDuplicaria);
  chk("todo candidato sale con código, y todo rechazo con motivo", !algunSinCodigo);
  chk("y el motor NO es un «no ofrezcas nunca» (cumpliría lo anterior sin servir)", seOfreceAlgo);
}

console.log(`\n${fallos === 0 ? "TODO OK" : fallos + " FALLA(S)"}\n`);
process.exit(fallos === 0 ? 0 : 1);
