// La copia interna de AFA: cuándo sale, a quién, y cuándo se dice que NO sale.
//
// ─── QUÉ SE ARREGLÓ ─────────────────────────────────────────────────────────
//
// La copia interna es el correo que le llega a AFA por cada cliente al que se le
// manda el reporte de ocupación, y es la ÚNICA que lleva las sugerencias completas
// aunque el cliente las tenga apagadas. Su destinatario vivía en
// `REPORTE_OCUPACION_CORREOS`, una variable de entorno de Vercel: un control que
// el sistema LEE y que nadie podía tocar desde una pantalla. Lo pidió el dueño:
// «mejor que esté detallado, o un botón para activar o desactivar el envío al área
// de operaciones de AFA».
//
// ─── LAS DOS INVARIANTES QUE FIJA EL BARRIDO ────────────────────────────────
//
// (1) SIN MIGRACIÓN, COMPORTAMIENTO ANTERIOR BYTE A BYTE. Con la fila ausente
//     —o con la recién creada por el default— el resultado tiene que ser idéntico
//     al del algoritmo VIEJO, que está copiado literal más abajo. Correr un SQL
//     accesorio no puede apagarle la copia a nadie.
// (2) `sale` ⟺ HAY AL MENOS UNA DIRECCIÓN. Nunca se declara que sale un correo
//     sin destinatario, ni se calla uno que sí tiene a dónde ir.
//
// Y su corolario, porque un motor que devolviera `sale: false` siempre cumpliría
// las dos de forma trivial: con la copia encendida y una dirección en cualquiera
// de los tres escalones, SALE.
//
// Correr:  npx tsx scripts/prueba-copia-interna.mts
import {
  resolverCopiaInterna, correosDeTexto, describirCopiaInterna,
  alarmaCopiaInterna, FUENTE_COPIA, planDeEnvio, MOTIVO_SIN_PRUEBA,
  type FilaCopia,
} from "../lib/ocupacion/copia-interna";

let fallos = 0;
const ok = (cond: boolean, que: string, detalle: unknown = "") => {
  console.log(`  ${cond ? "ok  " : "FALLA"}  ${que}${detalle === "" ? "" : ` — ${detalle}`}`);
  if (!cond) fallos++;
};
const titulo = (t: string) => console.log(`\n${t}\n${"─".repeat(t.length)}`);

// ─── EL ALGORITMO VIEJO, COPIADO LITERAL DEL ROUTE ──────────────────────────
// Así estaba escrito en app/api/reportes/ocupacion-semanal/route.ts antes de que
// existiera la tabla. Es la vara contra la que se mide la invariante (1).
const correosDeVIEJO = (txt: unknown): string[] =>
  String(txt ?? "").split(/[,;\s]+/).map((s) => s.trim()).filter((s) => s.includes("@"));

const copiaVIEJA = (env: string | null | undefined, emailEmpresa: string | null | undefined): string[] =>
  correosDeVIEJO(env).length ? correosDeVIEJO(env) : correosDeVIEJO(emailEmpresa);

// ════════════════════════════════════════════════════════════════════════════
titulo("1 · Sin la migración corrida no cambia NADA (la invariante que la hace segura)");
// ════════════════════════════════════════════════════════════════════════════

const ENVS = [
  undefined, null, "", "   ",
  "ops@afa.com",
  "ops@afa.com, gerencia@afa.com",
  "ops@afa.com gerencia@afa.com",   // separados por espacio, como admitía el viejo
  "ops@afa.com;gerencia@afa.com",
  "sin-arroba",
];
const EMAILS = [undefined, null, "", "empresa@afa.com", "empresa@afa.com, admin@afa.com", "nada"];
// `undefined` = la tabla no existe. `null` = existe y la fila no. `{}` = la fila
// recién creada por el default, que es lo que deja el `insert ... on conflict`.
const FILAS_NEUTRAS: (FilaCopia | null | undefined)[] = [
  undefined, null, {}, { copia_afa_activa: true }, { copia_afa_activa: null },
  { copia_afa_correos: "" }, { copia_afa_correos: "   " }, { copia_afa_activa: true, copia_afa_correos: null },
];

let iguales = 0, distintos = 0;
for (const env of ENVS) {
  for (const email of EMAILS) {
    for (const fila of FILAS_NEUTRAS) {
      const viejo = copiaVIEJA(env, email);
      const nuevo = resolverCopiaInterna({ fila, env, emailEmpresa: email });
      // El viejo mandaba si la lista traía algo; el nuevo, si `sale`.
      const mismoDestino = JSON.stringify(viejo) === JSON.stringify(nuevo.correos);
      const mismaDecision = (viejo.length > 0) === nuevo.sale;
      if (mismoDestino && mismaDecision) iguales++;
      else { distintos++; if (distintos <= 3) console.log(`      ↳ ${JSON.stringify({ env, email, fila })}: viejo=${JSON.stringify(viejo)} nuevo=${JSON.stringify(nuevo.correos)}`); }
    }
  }
}
ok(distintos === 0,
  `${iguales} combinaciones (env × correo de empresa × fila neutra): mismo destino y misma decisión que el algoritmo viejo`,
  distintos ? `${distintos} distintas` : "");

// El corolario: que las combinaciones no sean todas vacías, o la igualdad sería trivial.
ok(ENVS.some(e => copiaVIEJA(e, null).length > 0) && EMAILS.some(m => copiaVIEJA(null, m).length > 0),
  "el barrido incluye casos que SÍ mandan por cada escalón (si no, la igualdad sería trivial)");

// ════════════════════════════════════════════════════════════════════════════
titulo("2 · Solo un `false` EXPLÍCITO apaga");
// ════════════════════════════════════════════════════════════════════════════

const conEnv = { env: "ops@afa.com", emailEmpresa: "empresa@afa.com" };

ok(resolverCopiaInterna({ ...conEnv, fila: { copia_afa_activa: false } }).sale === false,
  "`false` apaga");
ok(resolverCopiaInterna({ ...conEnv, fila: { copia_afa_activa: false } }).codigo === "apagada",
  "y el código lo DECLARA (`apagada`), no se deduce de una lista vacía");
ok(resolverCopiaInterna({ ...conEnv, fila: { copia_afa_activa: false } }).correos.length === 0,
  "apagada no devuelve destinatarios: nadie puede mandarle por descuido");
for (const v of [undefined, null, true] as const) {
  ok(resolverCopiaInterna({ ...conEnv, fila: { copia_afa_activa: v } }).sale === true,
    `\`${String(v)}\` NO apaga`);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("3 · La cascada, y cada escalón DECLARA su procedencia");
// ════════════════════════════════════════════════════════════════════════════

const c1 = resolverCopiaInterna({
  fila: { copia_afa_correos: "ops@afa.com" }, env: "vercel@afa.com", emailEmpresa: "empresa@afa.com",
});
ok(c1.correos.join() === "ops@afa.com" && c1.fuente === "configurada",
  "lo escrito en la pantalla gana sobre la variable de entorno y sobre el perfil");

const c2 = resolverCopiaInterna({
  fila: { copia_afa_correos: "  " }, env: "vercel@afa.com", emailEmpresa: "empresa@afa.com",
});
ok(c2.correos.join() === "vercel@afa.com" && c2.fuente === "variable_entorno",
  "sin nada escrito manda REPORTE_OCUPACION_CORREOS — lo ya configurado no se rompe");

const c3 = resolverCopiaInterna({ fila: {}, env: "", emailEmpresa: "empresa@afa.com" });
ok(c3.correos.join() === "empresa@afa.com" && c3.fuente === "perfil_empresa",
  "y sin variable, el correo del perfil de la empresa");

ok(Object.keys(FUENTE_COPIA).length === 3 &&
   (["configurada", "variable_entorno", "perfil_empresa"] as const).every(f => FUENTE_COPIA[f].length > 0),
  "las tres procedencias tienen texto: la pantalla no redacta ninguna");

// El texto de cada procedencia tiene que decir DÓNDE se corrige, no solo nombrarla.
ok(/vercel/i.test(FUENTE_COPIA.variable_entorno) && /perfil/i.test(FUENTE_COPIA.perfil_empresa),
  "cada procedencia nombra el sitio donde se corrige (Vercel · /configuracion/perfil)");

// ════════════════════════════════════════════════════════════════════════════
titulo("4 · `sale` significa «va a salir de verdad», no «la casilla está marcada»");
// ════════════════════════════════════════════════════════════════════════════

const sinNadie = resolverCopiaInterna({ fila: { copia_afa_activa: true }, env: "", emailEmpresa: "" });
ok(sinNadie.sale === false, "encendida y sin ninguna dirección en la cascada → NO sale");
ok(sinNadie.codigo === "sin_destinatario",
  "y tiene código propio: es la combinación que una pantalla vuelve mentirosa");
ok(alarmaCopiaInterna(sinNadie) === true,
  "ESA es la que pinta ámbar: el visto puesto y nada llegando, y nada más lo dice");
ok(alarmaCopiaInterna(resolverCopiaInterna({ fila: { copia_afa_activa: false }, ...conEnv })) === false,
  "apagarla a propósito NO alarma — lo acaba de hacer una persona mirando la casilla");
ok(alarmaCopiaInterna(resolverCopiaInterna({ fila: {}, ...conEnv })) === false,
  "y una copia que sale normalmente tampoco: un aviso que sale siempre se vuelve paisaje");

// ── Barrido de la invariante (2) ────────────────────────────────────────────
const FILAS: (FilaCopia | null | undefined)[] = [
  ...FILAS_NEUTRAS,
  { copia_afa_activa: false },
  { copia_afa_activa: false, copia_afa_correos: "ops@afa.com" },
  { copia_afa_correos: "ops@afa.com" },
  { copia_afa_correos: "ops@afa.com, ops@afa.com" },
  { copia_afa_correos: "basura" },
];
let casos = 0, saleSinCorreos = 0, calladoConCorreos = 0, codigoMalo = 0, salenTodos = 0;
for (const env of ENVS) {
  for (const email of EMAILS) {
    for (const fila of FILAS) {
      const r = resolverCopiaInterna({ fila, env, emailEmpresa: email });
      casos++;
      if (r.sale && r.correos.length === 0) saleSinCorreos++;
      if (!r.sale && r.correos.length > 0) calladoConCorreos++;
      if (r.sale) salenTodos++;
      // El código y el estado no pueden contradecirse.
      const coherente =
        (r.codigo === "activa" && r.sale && r.fuente !== null) ||
        (r.codigo === "apagada" && !r.sale && r.fuente === null && fila?.copia_afa_activa === false) ||
        (r.codigo === "sin_destinatario" && !r.sale && r.fuente === null);
      if (!coherente) codigoMalo++;
      // Sin duplicados: la misma dirección dos veces mandaría dos correos.
      if (new Set(r.correos).size !== r.correos.length) saleSinCorreos++;
    }
  }
}
ok(saleSinCorreos === 0, `${casos} combinaciones: jamás se declara que sale sin destinatario (ni con duplicados)`);
ok(calladoConCorreos === 0, "ni se devuelven destinatarios de una copia que no sale");
ok(codigoMalo === 0, "el código concuerda siempre con `sale` y con `fuente`");
ok(salenTodos > 0 && salenTodos < casos,
  "el barrido tiene casos de los dos lados — un motor que nunca mandara cumpliría todo esto de forma trivial",
  `${salenTodos}/${casos} salen`);

// ════════════════════════════════════════════════════════════════════════════
titulo("5 · Partir la lista de correos es UNA definición, la del route");
// ════════════════════════════════════════════════════════════════════════════

const LISTAS = [
  "a@b.com, c@d.com", "a@b.com;c@d.com", "a@b.com c@d.com", "a@b.com\nc@d.com",
  " a@b.com ,, c@d.com ", "", "   ", "sin arroba", "a@b.com, basura, c@d.com",
];
let difieren = 0;
for (const t of LISTAS) {
  if (JSON.stringify(correosDeTexto(t)) !== JSON.stringify(correosDeVIEJO(t))) difieren++;
}
ok(difieren === 0,
  `${LISTAS.length} listas: correosDeTexto parte exactamente igual que el correosDe del route`);
ok(correosDeTexto("a@b.com c@d.com").length === 2,
  "una lista pegada con ESPACIOS son dos direcciones, no una inexistente");
ok(correosDeTexto("a@b.com\nc@d.com").length === 2, "y con salto de línea también");
ok(correosDeTexto(undefined).length === 0 && correosDeTexto(null).length === 0,
  "sin texto no hay destinatarios (nunca una cadena vacía colada en la lista)");

// ════════════════════════════════════════════════════════════════════════════
titulo("6 · La frase de la pantalla la compone el MOTOR");
// ════════════════════════════════════════════════════════════════════════════

const fActiva = describirCopiaInterna(resolverCopiaInterna({ fila: { copia_afa_correos: "ops@afa.com" }, ...conEnv }));
ok(fActiva.includes("ops@afa.com"), "la frase de la copia activa NOMBRA a quién le llega");
ok(/sugerencias/i.test(fActiva),
  "y dice lo que la hace distinta: siempre lleva las sugerencias, aunque el cliente las tenga apagadas");

const fApagada = describirCopiaInterna(resolverCopiaInterna({ fila: { copia_afa_activa: false }, ...conEnv }));
ok(/cliente sigue recibiendo/i.test(fApagada),
  "apagarla no apaga el reporte del cliente, y la frase lo aclara antes de que alguien lo suponga");
ok(/no recibe copia|NO recibe/i.test(fApagada), "y dice qué se pierde");

const fSin = describirCopiaInterna(sinNadie);
ok(/no va a salir/i.test(fSin) && /escribe/i.test(fSin),
  "la del vacío nombra el problema Y el arreglo, no solo el problema");

// Ninguna de las tres puede quedar vacía: una frase en blanco se lee como pantalla rota.
for (const [nombre, f] of [["activa", fActiva], ["apagada", fApagada], ["sin_destinatario", fSin]] as const) {
  ok(f.trim().length > 20, `la frase de \`${nombre}\` existe y dice algo`);
}

// ════════════════════════════════════════════════════════════════════════════
titulo("7 · La PRUEBA: solo a AFA, y sin quemar el envío del sábado");
// ════════════════════════════════════════════════════════════════════════════

const copiaViva = resolverCopiaInterna({ fila: { copia_afa_correos: "ops@afa.com" }, ...conEnv });

const normal = planDeEnvio({ copia: copiaViva });
ok(normal.destinos.join() === "cliente,afa", "el envío de siempre va al cliente y a la copia interna");
ok(normal.consumen.join() === "cliente,afa", "y los DOS consumen el candado, que es lo que impide repetirlos");

const prueba = planDeEnvio({ prueba: true, copia: copiaViva });
ok(prueba.destinos.join() === "prueba_afa", "la prueba va a UN destino y no es el cliente");
ok(prueba.consumen.length === 0,
  "y NO consume el candado: con destino `afa` habría quemado la copia real de ese periodo");
ok(!prueba.destinos.includes("afa" as any),
  "su destino NO es `afa` — si lo fuera, el índice único bloquearía la copia del sábado");

const pruebaApagada = planDeEnvio({ prueba: true, copia: resolverCopiaInterna({ fila: { copia_afa_activa: false }, ...conEnv }) });
ok(pruebaApagada.destinos.length === 0 && pruebaApagada.motivo === "copia_apagada",
  "con la copia apagada la prueba NO sale, y dice cuál de los dos arreglos falta");
const pruebaSinDest = planDeEnvio({ prueba: true, copia: resolverCopiaInterna({ fila: {}, env: "", emailEmpresa: "" }) });
ok(pruebaSinDest.destinos.length === 0 && pruebaSinDest.motivo === "copia_sin_destinatario",
  "y sin ninguna dirección tampoco");
ok(MOTIVO_SIN_PRUEBA[pruebaApagada.motivo!].length > 20 && MOTIVO_SIN_PRUEBA[pruebaSinDest.motivo!].length > 20,
  "los dos motivos tienen texto: la pantalla no lo redacta");
for (const m of ["copia_apagada", "copia_sin_destinatario"] as const) {
  ok(/intentarlo|enciéndela|escribe/i.test(MOTIVO_SIN_PRUEBA[m]),
    `\`${m}\` nombra el problema Y el arreglo`);
}

// ── Barrido: las invariantes duras ──────────────────────────────────────────
let casos7 = 0, pruebaAlCliente = 0, pruebaQuemaCandado = 0, consumenFuera = 0;
let clienteFaltaEnNormal = 0, pruebasQueSalen = 0, normalesConCopia = 0;
for (const env of ENVS) {
  for (const email of EMAILS) {
    for (const fila of FILAS) {
      const copia = resolverCopiaInterna({ fila, env, emailEmpresa: email });
      for (const esPrueba of [false, true]) {
        const p = planDeEnvio({ prueba: esPrueba, copia });
        casos7++;
        // (1) y (2): lo que hace segura la prueba.
        if (esPrueba && p.destinos.includes("cliente")) pruebaAlCliente++;
        if (esPrueba && p.consumen.length) pruebaQuemaCandado++;
        // (5) `consumen` no puede nombrar a quien no se le manda.
        if (p.consumen.some((d) => !p.destinos.includes(d))) consumenFuera++;
        // (4) el corolario, o todo lo anterior se cumpliría sin mandar nunca nada.
        if (!esPrueba && !p.destinos.includes("cliente")) clienteFaltaEnNormal++;
        if (esPrueba && p.destinos.length) pruebasQueSalen++;
        if (!esPrueba && copia.sale && !p.destinos.includes("afa")) normalesConCopia++;
        // Un plan sin destinos solo se admite en una prueba, y DECLARANDO el motivo.
        if (!p.destinos.length && (!esPrueba || !p.motivo)) consumenFuera++;
      }
    }
  }
}
ok(pruebaAlCliente === 0, `${casos7} combinaciones: una prueba JAMÁS le escribe al cliente`);
ok(pruebaQuemaCandado === 0, "una prueba JAMÁS consume el envío programado");
ok(consumenFuera === 0, "`consumen ⊆ destinos`, y un plan vacío solo existe en una prueba que declara su motivo");
ok(clienteFaltaEnNormal === 0, "el envío de siempre NUNCA deja al cliente fuera");
ok(normalesConCopia === 0, "y con la copia interna viva SIEMPRE la incluye");
ok(pruebasQueSalen > 0,
  "hay pruebas que SÍ salen — un motor que no mandara nunca cumpliría todo lo anterior de forma trivial",
  `${pruebasQueSalen} de ${casos7 / 2}`);

// ─── Resultado ──────────────────────────────────────────────────────────────
console.log(`\n${fallos === 0 ? "✓ TODO EN VERDE" : `✗ ${fallos} FALLA(S)`}\n`);
process.exit(fallos === 0 ? 0 : 1);
