// El número de quien escribe, resuelto en un solo sitio.
//
// El webhook de Meta guarda el número del cliente en `wa_id` (es la clave con la que
// Meta identifica al remitente y con la que hay que responderle), y NUNCA escribía
// `telefono`. Como el Inbox y el Pipeline sólo pintaban `telefono`, todo contacto
// creado automáticamente por WhatsApp aparecía sin número: el operador veía "Alan" y
// no tenía forma de llamarlo. De ahí este módulo.
//
// Regla: `telefono` manda (lo escribe un humano y puede corregir al de WhatsApp);
// `wa_id` es el respaldo. NO se toca `wa_id` al formatear — Meta lo exige literal.
//
// OJO con los otros canales: `fb_psid` e `ig_id` son identificadores OPACOS de Meta,
// no teléfonos. Nunca entran aquí: un contacto de Messenger tiene `wa_id` NULL, así
// que el respaldo no puede pintar un id como si fuera un número al que llamar — que
// sería el peor error posible en esta pantalla.

export type ContactoConTelefono = {
  telefono?: string | null;
  wa_id?: string | null;
  nombre?: string | null;
};

/** Últimos 9 dígitos — la forma canónica de comparar teléfonos peruanos en el repo. */
export const tel9 = (s?: string | null) => (s ?? "").replace(/\D/g, "").slice(-9);

/**
 * Número crudo del contacto, sin formato, o null si no hay ninguno utilizable.
 * Se descartan los valores sin dígitos suficientes para ser un teléfono real.
 */
export function telefonoDeContacto(c?: ContactoConTelefono | null): string | null {
  for (const bruto of [c?.telefono, c?.wa_id]) {
    const digitos = (bruto ?? "").replace(/\D/g, "");
    // Menos de 7 dígitos no es un número al que se pueda llamar (y descarta basura
    // tipo un nombre que se coló en el campo).
    if (digitos.length >= 7) return digitos;
  }
  return null;
}

/**
 * Formato legible. Perú (+51 + 9 dígitos) se agrupa 3-3-3, que es como lo lee
 * cualquiera aquí. Lo que no encaje se muestra tal cual con "+" — un número corto o
 * extranjero se prefiere crudo antes que recortado a la fuerza.
 */
export function formatearTelefono(bruto?: string | null): string {
  const d = (bruto ?? "").replace(/\D/g, "");
  if (!d) return "";
  if (d.startsWith("51") && d.length === 11) {
    const n = d.slice(2);
    return `+51 ${n.slice(0, 3)} ${n.slice(3, 6)} ${n.slice(6)}`;
  }
  if (d.length === 9) return `+51 ${d.slice(0, 3)} ${d.slice(3, 6)} ${d.slice(6)}`;
  return `+${d}`;
}

/** Número del contacto ya formateado, o null si no hay. */
export function telefonoLegible(c?: ContactoConTelefono | null): string | null {
  const bruto = telefonoDeContacto(c);
  return bruto ? formatearTelefono(bruto) : null;
}

/**
 * ¿El nombre del contacto ES su propio número? Pasa siempre que el perfil de WhatsApp
 * no tiene nombre público: el webhook usa `profile.name ?? msg.from`, así que el
 * "nombre" acaba siendo el número. Sin esto la pantalla lo pintaría dos veces.
 */
export function nombreEsElNumero(c?: ContactoConTelefono | null): boolean {
  const tel = telefonoDeContacto(c);
  if (!tel) return false;
  const nombre = (c?.nombre ?? "").trim();
  // Sólo si el nombre es *puramente* el número; "Alan 987654321" sí es un nombre.
  if (!/^[\d\s+()-]+$/.test(nombre)) return false;
  return tel9(nombre) === tel9(tel);
}

/** Enlace wa.me (requiere E.164 sin "+"), o null si no aplica. */
export function enlaceWhatsApp(c?: ContactoConTelefono | null): string | null {
  const d = telefonoDeContacto(c);
  if (!d) return null;
  // wa.me exige el código de país. Un número peruano de 9 dígitos lo lleva implícito.
  const e164 = d.length === 9 ? `51${d}` : d;
  return `https://wa.me/${e164}`;
}

/** ¿Coincide el número del contacto con lo que se está buscando? */
export function coincideBusquedaTelefono(c: ContactoConTelefono | null | undefined, consulta: string): boolean {
  const digitosConsulta = consulta.replace(/\D/g, "");
  if (digitosConsulta.length < 3) return false;   // "51" haría match con medio Perú
  const tel = telefonoDeContacto(c);
  return !!tel && tel.includes(digitosConsulta);
}
