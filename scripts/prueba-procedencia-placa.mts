// Matriz: la placa de una foto de tablero NO la decide la IA.
// Casos reales: "~Cerna" (+51 961 097 763) manda fotos de tablero con "Kilometraje final / unidad
// en la cochera / fin de servicio", sin placa. El Radar grabó 24,484 km (12/09) y 24,736 km
// (16/09) en la CWZ-371 porque la IA eligió la placa por el parecido del tablero. Lo correcto:
// asociarlo por su NÚMERO a la unidad que tenía en servicio ese día; si no se puede, no grabar.
// Ejecutar: npx tsx scripts/prueba-procedencia-placa.mts
import {
  placaEnTexto, escritasEnTexto, decidirUnidad, auditarUnidadLectura, motivoDecision, motivoAuditoria,
  mismaUnidad, telefonoLegible, confirmacionDe, confirmaUnidad, resultadoConConfirmacion,
  type Remitente, type UnidadRef, type DecisionUnidad,
} from "../lib/radar/procedencia-placa";
import { telefonoDeRemitente, telefonosDeFicha } from "../lib/radar/cluster-remitente";

let fallos = 0;
const ok = (c: boolean, m: string) => { console.log(`${c ? "✓" : "✗"} ${m}`); if (!c) fallos++; };

const CWZ: UnidadRef = { flota: "propia", id: 7, placa: "CWZ-371" };
const BUI: UnidadRef = { flota: "propia", id: 3, placa: "BUI-272" };
const CUP: UnidadRef = { flota: "tercero", id: 7, placa: "CUP-435" }; // mismo id que la CWZ, otra flota
const ERA: UnidadRef = { flota: "tercero", id: 9, placa: "ERA-247" };
const FLOTA = [CWZ, BUI, CUP, ERA];
const TEXTO_CERNA = ["Kilometraje final\nUnidad en la cochera\nFin de servicio", null];
const cerna = (asignadas: UnidadRef[]): Remitente => ({ codigo: "identificado", telefono: "51961097763", conductores: ["Cerna"], asignadas });

// ── 1) El caso que se rompió ────────────────────────────────────────────────
{
  const d = decidirUnidad({ escritas: escritasEnTexto(FLOTA, TEXTO_CERNA), unidadIA: CWZ, remitente: cerna([CUP]) });
  ok(d.codigo === "asignacion" && mismaUnidad(d.unidad, CUP) && d.auto,
    "Cerna 16/09: sin placa escrita y con la CUP-435 en servicio → se graba en la CUP-435, no en la CWZ-371");
  ok(mismaUnidad(d.propuestaIA, CWZ), "la CWZ-371 que propuso la IA queda solo como dato");

  const sinFicha = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: { codigo: "no_registrado", telefono: "51961097763" } });
  ok(sinFicha.unidad === null && !sinFicha.auto, "número que no está en ninguna ficha → sin unidad, no se graba");
  const lid = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: { codigo: "sin_telefono" } });
  ok(lid.codigo === "sin_telefono" && lid.unidad === null, "WhatsApp entregó un @lid → sin unidad (no se adivina)");
  const sinServicio = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: cerna([]) });
  ok(sinServicio.codigo === "sin_servicio" && sinServicio.unidad === null, "conductor sin servicio ese día → sin unidad");
  const caido = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: { codigo: "no_se_pudo_leer" } });
  ok(caido.unidad === null && !caido.auto, "la base no contestó → nunca se graba solo");
  const sinIA = decidirUnidad({ escritas: [], unidadIA: null, remitente: cerna([CUP]) });
  ok(mismaUnidad(sinIA.unidad, CUP) && sinIA.auto, "la IA no dio placa: igual sale la unidad del servicio del remitente");
}

// ── 2) El guard del 04/10 (copiado literal) no la asociaba nunca a la unidad del remitente ──
{
  function procedenciaPlacaVieja(o: { placa: string | null; unidadId: number | null; textos: (string | null)[]; asignadasAlRemitente: number[] }) {
    const soloAlnum = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]/g, "");
    const p = soloAlnum(o.placa ?? "");
    const enTexto = p.length >= 5 && /[A-Z]/.test(p) && /[0-9]/.test(p) && o.textos.some((t) => soloAlnum(String(t ?? "")).includes(p));
    if (enTexto) return "texto";
    if (o.unidadId != null && o.asignadasAlRemitente.includes(o.unidadId)) return "asignacion";
    return "sin_respaldo";
  }
  // El viejo solo podía decir sí/no sobre la placa de la IA: con la CUP-435 asignada (tercero, que
  // además no miraba), respondía «sin respaldo» y la lectura quedaba sin unidad.
  ok(procedenciaPlacaVieja({ placa: "CWZ-371", unidadId: 7, textos: TEXTO_CERNA, asignadasAlRemitente: [] }) === "sin_respaldo",
    "viejo: frenaba la CWZ-371 pero nunca proponía la unidad del remitente");
  // Y pegando las palabras, una placa que empieza con las letras finales de otra se "leía".
  ok(procedenciaPlacaVieja({ placa: "ERA-247", unidadId: 9, textos: ["en la cochera 24736"], asignadasAlRemitente: [] }) === "texto",
    "viejo: «cochera 24736» contenía «ERA247» (falso «escrita»)");
  ok(!placaEnTexto("ERA-247", ["en la cochera 24736"]), "nuevo: la placa exige bordes — «cochera 24736» no la contiene");

  // El teléfono de un @lid: el viejo recortaba 9 dígitos de un identificador interno.
  const telDeJidViejo = (jid: string) => jid.split("@")[0].split(":")[0].replace(/\D/g, "").slice(-9);
  ok(telDeJidViejo("204853968372154@lid") === "968372154", "viejo: un @lid daba un «teléfono» que no es de nadie");
  ok(telefonoDeRemitente("204853968372154@lid") === null, "nuevo: un @lid no tiene teléfono");
}

// ── 3) La placa escrita manda, y la lee el ERP (no la IA) ───────────────────
{
  const escrito = ["Buenas noches el kilometraje de la móvil placa BUI 2 7 2\nFin de jornada movil en la cochera"];
  const d1 = decidirUnidad({ escritas: escritasEnTexto(FLOTA, escrito), unidadIA: BUI, remitente: { codigo: "sin_telefono" } });
  ok(d1.codigo === "placa_escrita" && mismaUnidad(d1.unidad, BUI) && d1.auto, "'placa BUI 2 7 2' en la ráfaga → BUI-272, aunque no se sepa quién la mandó");
  const d2 = decidirUnidad({ escritas: escritasEnTexto(FLOTA, escrito), unidadIA: CWZ, remitente: { codigo: "sin_telefono" } });
  ok(mismaUnidad(d2.unidad, BUI), "la IA dijo CWZ-371 por el tablero, pero el texto dice BUI-272 → BUI-272");
  const d3 = decidirUnidad({ escritas: escritasEnTexto(FLOTA, escrito), unidadIA: null, remitente: { codigo: "sin_telefono" } });
  ok(mismaUnidad(d3.unidad, BUI) && d3.auto, "la IA no dio placa y el texto sí → BUI-272");
  const conflicto = decidirUnidad({ escritas: [BUI], unidadIA: BUI, remitente: cerna([CUP]) });
  ok(conflicto.codigo === "conflicto" && mismaUnidad(conflicto.unidad, BUI) && !conflicto.auto,
    "escrita BUI-272 pero el remitente manejaba la CUP-435 → se pregunta, no se graba sola");
  const misma = decidirUnidad({ escritas: [BUI], unidadIA: BUI, remitente: cerna([BUI]) });
  ok(misma.codigo === "placa_escrita" && misma.auto, "escrita y además asignada → se graba sola");
  const dos = decidirUnidad({ escritas: [BUI, CWZ], unidadIA: null, remitente: cerna([CWZ]) });
  ok(mismaUnidad(dos.unidad, CWZ) && dos.auto, "dos placas escritas: desempata la que manejaba ese día");
  const dosSinDesempate = decidirUnidad({ escritas: [BUI, CWZ], unidadIA: null, remitente: { codigo: "sin_telefono" } });
  ok(dosSinDesempate.codigo === "varias_escritas" && dosSinDesempate.unidad === null, "dos placas escritas y nada decide → sin unidad");
  const dosIA = decidirUnidad({ escritas: [BUI, CWZ], unidadIA: CWZ, remitente: { codigo: "sin_telefono" } });
  ok(mismaUnidad(dosIA.unidad, CWZ), "dos escritas y la IA eligió una de ELLAS: es lectura del texto, vale");
  const varias = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: cerna([CWZ, BUI]) });
  ok(varias.codigo === "varias_asignadas" && varias.unidad === null && varias.candidatas.length === 2,
    "sin placa y dos unidades en servicio → elige una persona (la IA eligió por parecido)");
}

// ── 4) Formas de escribir la placa ──────────────────────────────────────────
for (const t of ["CWZ-371", "cwz 371", "C W Z 3 7 1", "placa: Cwz371 llegando", "km de la cwz-371.", "(CWZ_371)"])
  ok(placaEnTexto("CWZ-371", [t]), `reconoce la placa escrita como "${t}"`);
ok(!placaEnTexto("CWZ-371", ["unidad 371 en cochera"]), "un '371' suelto no es la placa");
ok(!placaEnTexto("CWZ-371", ["CWZ-372"]), "otra placa parecida no cuenta");
ok(!placaEnTexto("CWZ-371", ["XCWZ3710"]), "pegada a otras letras o cifras no cuenta");
ok(!placaEnTexto(null, ["CWZ-371"]), "sin placa no hay nada que confirmar");
ok(escritasEnTexto(FLOTA, ["km de la BUI-272 y la cup 435"]).length === 2, "escritasEnTexto encuentra las dos");
ok(escritasEnTexto(FLOTA, TEXTO_CERNA).length === 0, "el mensaje de Cerna no nombra ninguna unidad");

// ── 5) Teléfonos ────────────────────────────────────────────────────────────
ok(telefonoDeRemitente("51961097763@s.whatsapp.net") === "51961097763", "jid de teléfono → sus dígitos");
ok(telefonoDeRemitente("51961097763:12@s.whatsapp.net") === "51961097763", "el sufijo de dispositivo no cambia el número");
ok(telefonoDeRemitente("51961097763") === "51961097763", "sin dominio también");
ok(telefonoDeRemitente("120363041234567890@g.us") === null, "un grupo no es un teléfono");
ok(telefonoDeRemitente("") === null && telefonoDeRemitente(null) === null, "vacío no es un teléfono");
ok(JSON.stringify(telefonosDeFicha("961 097 763 / 987654321")) === JSON.stringify(["961097763", "987654321"]), "una ficha con dos números da los dos");
ok(JSON.stringify(telefonosDeFicha("+51 961-097-763")) === JSON.stringify(["961097763"]), "el formato de la ficha no importa");
ok(telefonosDeFicha("—").length === 0, "una ficha sin número no da ninguno");
ok(telefonoLegible("51961097763") === "+51 961 097 763", "teléfono legible");

// ── 6) Los motivos: dicen dónde se arregla y NUNCA nombran la placa del parecido ──
{
  const ctx = (r: Remitente) => ({ remitente: r, nombre: "Cerna", fecha: "2026-09-16" });
  const casos: [Remitente, RegExp][] = [
    [{ codigo: "no_registrado", telefono: "51961097763" }, /ficha/],
    [{ codigo: "sin_telefono" }, /1\.4\.0/],
    [cerna([]), /Programación/],
    [cerna([CUP, BUI]), /CUP-435.*BUI-272|BUI-272.*CUP-435/],
    [{ codigo: "no_se_pudo_leer" }, /a mano/],
  ];
  for (const [r, patron] of casos) {
    const d = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: r });
    const m = motivoDecision(d, ctx(r)) ?? "";
    ok(patron.test(m), `${d.codigo}: el motivo dice dónde se arregla`);
    ok(!m.includes("CWZ"), `${d.codigo}: el motivo no nombra la placa que la IA eligió por parecido`);
  }
  const conTel = motivoDecision(decidirUnidad({ escritas: [], unidadIA: null, remitente: { codigo: "no_registrado", telefono: "51961097763" } }), ctx({ codigo: "no_registrado", telefono: "51961097763" }));
  ok(!!conTel && conTel.includes("+51 961 097 763"), "no_registrado nombra el número que hay que agregar a la ficha");
  ok(motivoDecision(decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: cerna([CUP]) }), ctx(cerna([CUP]))) === null,
    "con la unidad decidida no hay motivo que decir");
}

// ── 7) La auditoría de lo ya grabado ────────────────────────────────────────
{
  const d = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: cerna([CUP]) });
  const a = auditarUnidadLectura(CWZ, d);
  ok(a.veredicto === "otra_unidad" && mismaUnidad(a.propuesta, CUP), "la lectura de Cerna en la CWZ-371 → se propone pasarla a la CUP-435");
  const m = motivoAuditoria(CWZ, d, { remitente: cerna([CUP]), nombre: "Cerna", fecha: "2026-09-16" }) ?? "";
  ok(m.includes("CUP-435") && m.includes("16/09/2026"), "el motivo nombra la unidad del servicio y el día");
  const sin = decidirUnidad({ escritas: [], unidadIA: CWZ, remitente: { codigo: "no_registrado", telefono: "51961097763" } });
  ok(auditarUnidadLectura(CWZ, sin).veredicto === "sin_respaldo", "sin poder identificar al remitente → sin respaldo, sin propuesta");
  ok(auditarUnidadLectura(CWZ, sin).propuesta === null, "…y no se inventa una unidad a la que pasarla");
  const bien = decidirUnidad({ escritas: [], unidadIA: CUP, remitente: cerna([CUP]) });
  ok(auditarUnidadLectura(CUP, bien).veredicto === "respaldada", "en la unidad que manejaba → respaldada");
  ok(motivoAuditoria(CUP, bien, { remitente: cerna([CUP]) }) === null, "respaldada no tiene motivo");
  const escrita = decidirUnidad({ escritas: [BUI], unidadIA: BUI, remitente: { codigo: "sin_telefono" } });
  ok(auditarUnidadLectura(BUI, escrita).veredicto === "respaldada", "placa escrita → respaldada aunque no se sepa quién la mandó");
  const conflicto = decidirUnidad({ escritas: [BUI], unidadIA: BUI, remitente: cerna([CUP]) });
  ok(auditarUnidadLectura(BUI, conflicto).veredicto === "respaldada", "escrita pero manejaba otra: la tecleó una persona → respaldada");
  ok(auditarUnidadLectura(CWZ, escrita).veredicto === "otra_unidad", "el mensaje dice BUI-272 y la lectura quedó en la CWZ-371 → otra unidad");
  ok(!mismaUnidad(CWZ, CUP), "mismo id en dos flotas NO es la misma unidad");
}

// ── 8) Barrido: el parecido no decide NUNCA ─────────────────────────────────
{
  const remitentes: Remitente[] = [
    { codigo: "sin_telefono" }, { codigo: "no_registrado", telefono: "51961097763" }, { codigo: "no_se_pudo_leer" },
    cerna([]), cerna([CUP]), cerna([CWZ]), cerna([BUI]), cerna([CUP, BUI]), cerna([CWZ, BUI]), cerna([CWZ, BUI, CUP]),
  ];
  const subconjuntos: UnidadRef[][] = [];
  for (let mask = 0; mask < 1 << FLOTA.length; mask++) subconjuntos.push(FLOTA.filter((_, i) => mask & (1 << i)));
  const ias: (UnidadRef | null)[] = [null, ...FLOTA];
  let combinaciones = 0, autos = 0, porParecido = 0, iaCambiaLaDecision = 0, autoSinUnidad = 0, fueraDeOrigen = 0, sinUnidadConServicio = 0;
  const firma = (d: DecisionUnidad) => `${d.codigo}|${d.unidad ? `${d.unidad.flota}:${d.unidad.id}` : "-"}|${d.auto}`;
  for (const escritas of subconjuntos) for (const r of remitentes) {
    const asignadas = r.codigo === "identificado" ? r.asignadas : [];
    // Con las placas que NO están escritas, la decisión tiene que ser la misma propongan lo que propongan.
    const firmasNoEscritas = new Set<string>();
    for (const ia of ias) {
      combinaciones++;
      const d = decidirUnidad({ escritas, unidadIA: ia, remitente: r });
      if (d.auto) autos++;
      if (d.auto && !d.unidad) autoSinUnidad++;
      if (d.unidad && !escritas.some((u) => mismaUnidad(u, d.unidad)) && !asignadas.some((u) => mismaUnidad(u, d.unidad))) fueraDeOrigen++;
      if (d.unidad && ia && mismaUnidad(d.unidad, ia) && !escritas.some((u) => mismaUnidad(u, ia)) && !(asignadas.length === 1 && mismaUnidad(asignadas[0], ia))) porParecido++;
      if (!ia || !escritas.some((u) => mismaUnidad(u, ia))) firmasNoEscritas.add(firma(d));
      if (!escritas.length && asignadas.length === 1 && !d.unidad) sinUnidadConServicio++;
    }
    if (firmasNoEscritas.size > 1) iaCambiaLaDecision++;
  }
  ok(porParecido === 0, `ninguna unidad sale de la propuesta de la IA sin estar escrita ni asignada (${combinaciones} combinaciones)`);
  ok(fueraDeOrigen === 0, "toda unidad decidida está escrita en el mensaje o en el servicio del remitente");
  ok(iaCambiaLaDecision === 0, "lo que proponga la IA fuera del texto no cambia la decisión");
  ok(autoSinUnidad === 0, "nunca se graba sola sin unidad");
  ok(sinUnidadConServicio === 0, "con una sola unidad en servicio y nada escrito, siempre hay unidad");
  ok(autos > combinaciones / 4, `corolario: sí se graba sola en los casos respaldados (${autos} de ${combinaciones})`);
}

// ── La persona CONFIRMA la unidad (sin respaldo escrito ni servicio) ─────────
{
  const cwz: UnidadRef = { flota: "propia", id: 7, placa: "CWZ-371" };
  const bui: UnidadRef = { flota: "tercero", id: 7, placa: "BUI-272" }; // mismo id, otra flota
  const previo = { accion: "lectura_registrada", lectura_id: "x" };
  const escrito = resultadoConConfirmacion(previo, cwz, "admin@afa", "2026-10-08T20:00:00Z");
  ok(escrito.accion === "lectura_registrada" && escrito.lectura_id === "x", "confirmar no pisa lo que el motor dejó en resultado");
  const leida = confirmacionDe(escrito);
  ok(!!leida && leida.placa === "CWZ-371" && leida.por === "admin@afa", "el ciclo escribir → leer devuelve la misma confirmación");
  ok(confirmaUnidad(leida, cwz), "la confirmación respalda la unidad donde está la lectura");
  ok(!confirmaUnidad(leida, bui), "…pero NO a la de otra flota con el mismo id (si la lectura se movió, se vuelve a auditar)");
  ok(!confirmaUnidad(leida, null), "sin unidad actual no hay nada que confirmar");
  ok(confirmacionDe(null) === null && confirmacionDe({}) === null && confirmacionDe({ unidad_confirmada: { flota: "x", id: 1 } }) === null,
    "un resultado sin confirmación (o mal formada) no confirma nada");
  ok(confirmacionDe(resultadoConConfirmacion(null, cwz, null, "t"))?.por === null, "sin usuario se guarda igual, con por = null");
}

console.log(fallos ? `\n${fallos} fallo(s)` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
