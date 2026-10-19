// lib/plantillas-sugeridas.ts — PURO. Las plantillas de WhatsApp que las alertas usan y que hay que
// CREAR en Meta (cuenta de avisos), listas para el botón «Prellenar» de /configuracion/operaciones.
//
// El caso (11-10-2026): la prueba de los avisos de inicio dio «#132001» en todas. En la cuenta de
// avisos (Afa Notificaciones) no existían conductor_recuerda_iniciar, conductor_no_inicio ni
// coordinador_alerta, aunque varias tarjetas de alertas las nombraban. Desde aquí se crean con un clic
// y con las variables en el orden EXACTO en que el motor las manda (lib/escalera-muestra.ts las arma
// igual que el tick y el cron de un minuto; scripts/prueba-plantilla-idioma.mts lo comprueba).
//
// Reglas de Meta que se respetan (si no, la plantilla vuelve rechazada):
//   · el cuerpo no puede EMPEZAR ni TERMINAR en una variable;
//   · las variables van numeradas {{1}}…{{n}} sin saltos y nunca pegadas una a otra;
//   · un ejemplo por variable;
//   · el botón es de enlace ESTÁTICO: no pide parámetros extra al enviar.

export type PlantillaSugerida = {
  name: string;
  category: "UTILITY" | "MARKETING";
  body: string;
  ejemplos: string[];
  botonTexto: string;
  botonUrl: string;
};

const BOTON_APP = { botonTexto: "Abrir app conductor", botonUrl: "https://transportesafa.com/conductor" };

/** Inicia ahora · Recuerda iniciar · En el punto, sin iniciar. {{1}} nombre · {{2}} hora · {{3}} origen. */
export const SUGERIDA_RECUERDA_INICIAR: PlantillaSugerida = {
  name: "conductor_recuerda_iniciar",
  category: "UTILITY",
  body: "Hola {{1}} 👋, tu servicio de las {{2}} desde {{3}} está por empezar.\n\n✅ Abre la app AFA Conductor, haz tu *CHECK-IN* y pulsa *INICIAR RECORRIDO* al salir de la cochera.\n📍 En cada paradero pulsa *MARCAR LLEGADA*: así tus pasajeros ven el bus en el mapa.",
  ejemplos: ["Carlos", "06:30", "Puente Santa Anita"],
  ...BOTON_APP,
};

/** Ya debió iniciar · No inició. {{1}} nombre · {{2}} hora · {{3}} ruta · {{4}} teléfono de contingencia. */
export const SUGERIDA_NO_INICIO: PlantillaSugerida = {
  name: "conductor_no_inicio",
  category: "UTILITY",
  body: "Hola {{1}}, tu servicio de las {{2}} ({{3}}) ya debió iniciar y todavía no está marcado en la app.\n\n🚨 Abre la app AFA Conductor, haz tu *CHECK-IN* y pulsa *INICIAR RECORRIDO* ahora.\n☎️ Si tienes algún problema, llama al Coordinador de Operaciones: {{4}}.\n\nGracias.",
  ejemplos: ["Carlos", "06:30", "Santa Anita → Planta Lurín", "+51 999 888 777"],
  ...BOTON_APP,
};

/**
 * TODA alerta al coordinador (el directorio de contactos), el saldo de combustible y el «marca 2» de
 * la llamada. {{1}} título · {{2}} quién · {{3}} servicio o referencia · {{4}} detalle.
 */
export const SUGERIDA_COORDINADOR_ALERTA: PlantillaSugerida = {
  name: "coordinador_alerta",
  category: "UTILITY",
  body: "⚠️ *Alerta de operaciones: {{1}}*\n\n👤 Conductor o cuenta: {{2}}\n🗓️ Servicio o referencia: {{3}}\n📝 Detalle: {{4}}\n\nRevísala en el ERP de operaciones para atenderla a tiempo.",
  ejemplos: ["No inició a tiempo", "Carlos Pérez", "Santa Anita → Planta Lurín 06:30", "Pasaron 10 min de la hora y no marcó inicio."],
  botonTexto: "",
  botonUrl: "",
};

/**
 * Invitación al pasajero CON IMAGEN. {{1}} nombre · {{2}} empresa del pasajero (o la de AFA).
 * NO se crea con «Prellenar»: lleva un HEADER de tipo IMAGEN, que se sube a mano en WhatsApp Manager
 * (de ejemplo, public/whatsapp-invitacion-pasajero.jpg). Al enviar, el código manda esa misma imagen
 * por enlace (lib/pasajero-invitacion.ts). Sin contraseñas: el PIN va por correo.
 */
export const SUGERIDA_INVITACION_PASAJERO: PlantillaSugerida = {
  name: "invitacion_pasajero_imagen",
  category: "UTILITY",
  body: "¡Hola {{1}}! 👋 Bienvenido al transporte de *{{2}}* 🚌✨\n\n📲 Descarga la app *AFA Pasajero* y ten todo en tu celular:\n\n📍 Tu bus en el mapa, en tiempo real\n🚏 Tu paradero y tu horario\n🎫 Tu QR para abordar\n🔔 Avisos cuando el bus está por llegar\n\n📧 En breve te llegan por correo tus datos de acceso.\n\n¡Buen viaje! 🙌",
  ejemplos: ["María López", "Compañía Hard Discount S.A.C."],
  botonTexto: "Descargar app Android",
  botonUrl: "https://play.google.com/store/apps/details?id=com.transportesafa.pasajero",
};

export const SUGERIDAS_ESCALERA: PlantillaSugerida[] = [
  SUGERIDA_RECUERDA_INICIAR, SUGERIDA_NO_INICIO, SUGERIDA_COORDINADOR_ALERTA,
];

/** Las variables {{n}} distintas del texto, en orden numérico. */
export function variablesDe(texto: string): number[] {
  return [...new Set((texto.match(/\{\{\s*(\d+)\s*\}\}/g) ?? []).map((v) => Number(v.replace(/\D/g, ""))))]
    .sort((a, b) => a - b);
}

/** Lo que Meta rechazaría de una plantilla, en castellano. Vacío = se puede mandar a revisión. */
export function problemasDePlantilla(p: PlantillaSugerida): string[] {
  const out: string[] = [];
  if (!/^[a-z0-9_]{1,512}$/.test(p.name)) out.push("nombre con caracteres no permitidos");
  const body = p.body;
  if (/^\s*\{\{\s*\d+\s*\}\}/.test(body)) out.push("empieza con una variable");
  if (/\{\{\s*\d+\s*\}\}\s*$/.test(body)) out.push("termina en una variable");
  if (/\}\}\s*\{\{/.test(body)) out.push("dos variables pegadas");
  const vars = variablesDe(body);
  if (vars.some((n, i) => n !== i + 1)) out.push(`variables con salto: ${vars.join(", ")}`);
  if (vars.length !== p.ejemplos.filter((e) => e.trim()).length) out.push(`${vars.length} variable(s) y ${p.ejemplos.length} ejemplo(s)`);
  if (p.ejemplos.some((e) => /[\n\t]| {4,}/.test(e))) out.push("un ejemplo con salto de línea o 4 espacios");
  if (p.botonUrl && !/^https?:\/\//i.test(p.botonUrl)) out.push("URL del botón sin http(s)");
  if (Boolean(p.botonTexto) !== Boolean(p.botonUrl)) out.push("botón a medias");
  return out;
}
