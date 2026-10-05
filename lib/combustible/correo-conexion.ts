// ──────────────────────────────────────────────────────────────────────────────
// lib/combustible/correo-conexion.ts — Motor PURO: ¿de QUÉ buzón se leen las facturas?
//
// Hay dos conexiones posibles con Google, y no son intercambiables:
//
//   · el CORREO DE FACTURAS, que se conecta en /combustible → Facturas, con permiso de SOLO
//     LECTURA, y es el buzón donde de verdad llegan las facturas de Primax (suele ser el de
//     administración, no el de atención al cliente);
//   · el GMAIL DEL CRM, que se conecta en /crm, lee y ENVÍA, y es el buzón de los clientes.
//
// LA REGLA QUE NO SE PUEDE AFLOJAR: si hay un correo de facturas conectado, se lee ESE o
// ninguno. Una conexión de facturas rota (token revocado, clave de cifrado cambiada) NO cae al
// Gmail del CRM: leería otro buzón en silencio, la pantalla seguiría diciendo «conectado» y las
// facturas de Primax dejarían de entrar sin que nada lo explique. Se declara `rota` y se dice
// por qué. El CRM es respaldo SOLO cuando nadie conectó un correo de facturas — que es el
// comportamiento con el que el módulo nació.
// ──────────────────────────────────────────────────────────────────────────────

export type CodigoConexion = "facturas" | "crm" | "rota" | "ninguna";

export type EstadoConexion = {
  codigo: CodigoConexion;
  email: string | null;
  /** Por qué no se puede leer (solo en `rota`). */
  detalle: string | null;
  /** En `rota`: de quién es la conexión que falló. Cada una se arregla en otro sitio. */
  de?: "facturas" | "crm";
};

export function elegirConexion(args: {
  facturas: { guardada: boolean; utilizable: boolean; email: string | null; error?: string | null };
  crm: { guardada: boolean; email?: string | null };
}): EstadoConexion {
  const { facturas, crm } = args;
  if (facturas.guardada) {
    if (facturas.utilizable) return { codigo: "facturas", email: facturas.email, detalle: null };
    return {
      codigo: "rota",
      email: facturas.email,
      detalle: facturas.error || "La conexión guardada ya no funciona.",
      de: "facturas",
    };
  }
  if (crm.guardada) return { codigo: "crm", email: crm.email ?? null, detalle: null };
  return { codigo: "ninguna", email: null, detalle: null };
}

/** ¿Se puede leer el correo con este estado? */
export function sePuedeLeer(e: EstadoConexion): boolean {
  return e.codigo === "facturas" || e.codigo === "crm";
}

/** La frase de la pantalla y del error del cron. Vive aquí para que las dos digan lo mismo. */
export function describirConexion(e: EstadoConexion): { titulo: string; detalle: string; tono: "ok" | "info" | "alerta" } {
  const quien = e.email ? e.email : "el buzón conectado";
  switch (e.codigo) {
    case "facturas":
      return {
        titulo: `Leyendo ${quien}`,
        detalle: "Correo de facturas conectado con permiso de solo lectura: el ERP no envía, no borra ni marca nada.",
        tono: "ok",
      };
    case "crm":
      return {
        titulo: `Leyendo el Gmail del CRM${e.email ? ` (${e.email})` : ""}`,
        detalle: "No hay un correo de facturas propio. Si las facturas de Primax llegan a otro correo (por ejemplo, el de administración), conéctalo aquí.",
        tono: "info",
      };
    case "rota":
      // Sin correo de facturas propio se estaba leyendo el del CRM, y es ESE el que falló: se
      // arregla en /crm (o conectando aquí el de facturas), no «volviendo a conectar» este.
      if (e.de === "crm") {
        return {
          titulo: "El Gmail del CRM no responde",
          detalle: `${e.detalle ?? ""} Reconéctalo en CRM, o conecta aquí el correo donde llegan las facturas.`.trim(),
          tono: "alerta",
        };
      }
      return {
        titulo: `La conexión con ${quien} dejó de funcionar`,
        detalle: `${e.detalle ?? ""} Vuelve a conectarla: mientras tanto NO se lee ningún correo (no se pasa al Gmail del CRM).`.trim(),
        tono: "alerta",
      };
    default:
      return {
        titulo: "No hay ningún correo conectado",
        detalle: "Conecta el correo donde llegan las facturas de Primax. Se abre Google, eliges la cuenta y aceptas; el ERP solo la lee.",
        tono: "alerta",
      };
  }
}
