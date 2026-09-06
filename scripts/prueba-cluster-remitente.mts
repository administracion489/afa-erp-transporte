// Pruebas de QUIÉN REPORTÓ (lib/radar/cluster-remitente.ts) — el remitente que decide si dos
// fotos son el MISMO reporte de recarga o dos reportes de dos personas.
// NO tocan la base: datos en memoria.
// Uso:  npx tsx scripts/prueba-cluster-remitente.mts   (sale con código 1 si algo falla)
//
// El caso que motivó el módulo: en producción una fila de combustible salió con SEIS fotos de
// tablero de unidades distintas (odómetros 29117, 17238, 29113…), es decir de varios
// conductores, fusionadas como si fueran un solo reporte. `resolverCluster` filtraba por
// `remitente_wa` con un `.eq()` y nunca miraba el valor: basta con que el jid llegue vacío o
// con un relleno para que ese filtro empareje a TODO el grupo, porque un comodín compartido
// casa con todos.
import {
  mismoRemitente,
  miembrosDelMismoRemitente,
  normalizarNombreRemitente,
  normalizarRemitente,
  remitenteUtilizable,
} from "../lib/radar/cluster-remitente";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const JID_A = "51987654321@s.whatsapp.net";
const JID_B = "51912345678@s.whatsapp.net";

// ── 1. Un jid que no identifica a nadie NO agrupa a nadie ───────────────────
{
  // Éstos son el bug: todos IGUALES para todo el mundo. Si valen como remitente, el `.eq()`
  // empareja a todos los que compartan el relleno y sus fotos terminan en una sola recarga.
  for (const relleno of ["", "   ", "0", "undefined", "null", "NaN", "[object Object]"]) {
    chk(`"${relleno}" no identifica a nadie`, normalizarRemitente(relleno) === null,
      String(normalizarRemitente(relleno)));
  }
  chk("null/undefined tampoco", normalizarRemitente(null) === null && normalizarRemitente(undefined) === null);
}
{
  // Un jid de GRUPO es de todos los del grupo: agruparía a la sala entera.
  chk("el jid del grupo no es una persona", normalizarRemitente("120363111222333@g.us") === null);
  chk("la difusión tampoco", normalizarRemitente("status@broadcast") === null);
  chk("ni un boletín", normalizarRemitente("12345@newsletter") === null);
}
{
  // Un identificador de WhatsApp es numérico y largo; cualquier otra cosa es un resto de
  // serialización o una etiqueta, y creerle es lo que fusionó las fotos.
  chk("un nombre no es un jid", normalizarRemitente("Juan Pérez") === null);
  chk("un número corto tampoco", normalizarRemitente("12@s.whatsapp.net") === null);
  chk("un teléfono peruano sí", normalizarRemitente(JID_A) === JID_A);
  chk("un LID también", normalizarRemitente("204531234567890@lid") === "204531234567890@lid");
  chk("un número suelto, sin dominio, vale", normalizarRemitente("51987654321") === "51987654321");
}
{
  // El sufijo `:NN` es el APARATO desde el que se envió, no otra persona: el mismo conductor
  // manda el tablero desde el teléfono y la nota desde WhatsApp Web.
  chk("el sufijo de dispositivo se ignora",
    normalizarRemitente("51987654321:12@s.whatsapp.net") === JID_A,
    String(normalizarRemitente("51987654321:12@s.whatsapp.net")));
  chk("y con mayúsculas también", normalizarRemitente("51987654321@S.WHATSAPP.NET") === JID_A);
  chk("dos aparatos de la misma persona son la misma persona",
    mismoRemitente({ remitente_wa: "51987654321:12@s.whatsapp.net" }, { remitente_wa: JID_A }));
}
{
  chk("utilizable declara lo mismo",
    remitenteUtilizable({ remitente_wa: JID_A }) && !remitenteUtilizable({ remitente_wa: "" }));
}

// ── 2. Se cruzan las DOS señales: número y pushName ─────────────────────────
{
  chk("mismo número y mismo nombre → misma persona",
    mismoRemitente({ remitente_wa: JID_A, remitente_nombre: "Luis" }, { remitente_wa: JID_A, remitente_nombre: "Luis" }));
  chk("números distintos → personas distintas",
    mismoRemitente({ remitente_wa: JID_A }, { remitente_wa: JID_B }) === false);
}
{
  // EL CASO DE PRODUCCIÓN: el jid guardado salió igual (o vacío y luego "igual") para dos
  // conductores. El pushName los separa, y por eso se cruzan las dos señales.
  chk("mismo número pero nombres distintos → NO se fusionan",
    mismoRemitente(
      { remitente_wa: JID_A, remitente_nombre: "Luis Quispe" },
      { remitente_wa: JID_A, remitente_nombre: "Marco Ríos" }
    ) === false);
  chk("el nombre se compara sin tildes ni mayúsculas ni espacios de más",
    mismoRemitente(
      { remitente_wa: JID_A, remitente_nombre: "  LUIS  QUISPE " },
      { remitente_wa: JID_A, remitente_nombre: "Luís Quispe" }
    ));
}
{
  // Un pushName ausente NO es evidencia de otra persona: WhatsApp no siempre lo manda, y
  // exigirlo partiría reportes legítimos en filas sueltas.
  chk("sin pushName de un lado, el número decide",
    mismoRemitente({ remitente_wa: JID_A, remitente_nombre: "Luis" }, { remitente_wa: JID_A, remitente_nombre: null }));
  chk("sin pushName de los dos lados, también",
    mismoRemitente({ remitente_wa: JID_A }, { remitente_wa: JID_A }));
  chk("un pushName en blanco es ausente, no otro nombre",
    mismoRemitente({ remitente_wa: JID_A, remitente_nombre: "Luis" }, { remitente_wa: JID_A, remitente_nombre: "   " }));
  chk("normalizarNombreRemitente devuelve null cuando no vino",
    normalizarNombreRemitente("  ") === null && normalizarNombreRemitente(null) === null);
}

// ── 3. El filtro del cluster ────────────────────────────────────────────────
{
  // La ráfaga legítima: un conductor manda tablero + surtidor + nota en tres mensajes.
  const ref = { remitente_wa: JID_A, remitente_nombre: "Luis" };
  const miembros = miembrosDelMismoRemitente(ref, [
    { id: "1", remitente_wa: JID_A, remitente_nombre: "Luis" },
    { id: "2", remitente_wa: "51987654321:3@s.whatsapp.net", remitente_nombre: "Luis" },
    { id: "3", remitente_wa: JID_A, remitente_nombre: null },
  ]);
  chk("los tres mensajes del mismo conductor quedan juntos", miembros.length === 3, String(miembros.length));
}
{
  // La ráfaga que NO es un reporte: tres personas subiendo su tablero en los mismos minutos.
  const ref = { remitente_wa: JID_A, remitente_nombre: "Luis" };
  const miembros = miembrosDelMismoRemitente(ref, [
    { id: "1", remitente_wa: JID_A, remitente_nombre: "Luis" },
    { id: "2", remitente_wa: JID_B, remitente_nombre: "Marco" },
    { id: "3", remitente_wa: JID_A, remitente_nombre: "Marco" }, // el jid coincide, la persona no
  ]);
  chk("solo entra lo del mismo celular", miembros.map((m) => m.id).join(",") === "1", miembros.map((m) => m.id).join(","));
}
{
  // Sin remitente utilizable no se agrupa NADA: perder el agrupado cuesta una fila de más en
  // revisión; fusionar de más pierde una recarga entera y nadie se entera.
  const miembros = miembrosDelMismoRemitente({ remitente_wa: "" }, [
    { id: "1", remitente_wa: "" },
    { id: "2", remitente_wa: "" },
  ]);
  chk("un remitente vacío no agrupa ni consigo mismo", miembros.length === 0, String(miembros.length));
  chk("un jid de grupo tampoco",
    miembrosDelMismoRemitente({ remitente_wa: "120363111@g.us" }, [{ id: "1", remitente_wa: "120363111@g.us" }]).length === 0);
}
{
  chk("sin candidatos, lista vacía", miembrosDelMismoRemitente({ remitente_wa: JID_A }, []).length === 0);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
