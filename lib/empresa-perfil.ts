// Quién EMITE los documentos del ERP, resuelto en un solo sitio.
//
// La fila única de `empresa_perfil` es la fuente de verdad y se edita en /configuracion/perfil.
// Este módulo solo rellena los huecos y DICE cuáles quedaron sin llenar.
//
// ══════════════════════════════════════════════════════════════════════════════
// LOS VALORES DE RESPALDO ERAN LOS DE AFA, Y ESO ROMPÍA LA VENTA DEL PRODUCTO
//
// Hasta hoy `EMPRESA_DEFECTO` traía el nombre, el RUC, el teléfono, el correo, la web y el
// domicilio fiscal de AFA — los mismos literales que el PDF de la cotización repetía cuatro
// veces dentro de su propio archivo. Tenía sentido mientras el perfil estaba vacío: los
// documentos salían con los datos buenos sin que nadie llenara nada.
//
// Pero este ERP se vende. Un comprador instala, no llena el perfil, imprime su primera
// cotización — y sale con el nombre y el RUC de otra empresa. Es el mismo defecto que los
// literales de los PDF de mantenimiento, una capa más abajo: ya no está en el TSX, está en
// el respaldo.
//
// ══════════════════════════════════════════════════════════════════════════════
// EL RESPALDO NO ES UN DATO MEJOR: ES UN AVISO
//
// Ninguna empresa se llama así, y esa es exactamente la intención. Un respaldo creíble —un
// nombre genérico plausible, un teléfono de ejemplo— se imprime, se envía y nadie lo nota
// hasta que el cliente pregunta. Uno que GRITA se corrige antes de que el papel salga.
//
// Y solo el NOMBRE tiene respaldo. El RUC, el teléfono, el correo, la web y el domicilio se
// quedan VACÍOS y el documento omite la línea entera, igual que la autorización del regulador:
// un RUC inventado en un papel que alguien firma es peor que un papel sin RUC. Es la misma
// regla del PAX contratado y del km vigente — sin dato no se cae a otro número, se calla.
// ══════════════════════════════════════════════════════════════════════════════

/** Lo único que se imprime cuando el perfil está vacío. No es un nombre: es un aviso. */
export const NOMBRE_SIN_CONFIGURAR = "«CONFIGURA EL PERFIL DE TU EMPRESA»";

export type PerfilEmpresa = {
  nombre?: string | null;
  razon_social?: string | null;
  ruc?: string | null;
  logo_url?: string | null;
  /** La versión para fondos OSCUROS. Ver `logoDeFondo`. */
  logo_claro_url?: string | null;
  telefono?: string | null;
  email?: string | null;
  direccion?: string | null;
  web?: string | null;
  /** Autorización del regulador de transporte, para el pie de los documentos operativos. */
  autorizacion_mtc?: string | null;
  /** Cuentas donde cobra la empresa, `[{banco, cuenta, cci}]`. De `empresa-02`. */
  cuentas_bancarias?: CuentaBancaria[] | null;
};

/** Una cuenta de cobro. `cuenta` y `cci` son texto: llevan guiones y ceros a la izquierda. */
export type CuentaBancaria = { banco: string; cuenta: string; cci: string };

// ══════════════════════════════════════════════════════════════════════════════
// SON DOS IMÁGENES Y EL ERP NO PUEDE DEDUCIR UNA DE LA OTRA
//
// `logo_url` es el que se imprime en papel: letras azules sobre fondo blanco.
// `logo_claro_url` es el mismo logo en blanco, para fondos oscuros, y
// /configuracion/perfil lo pide desde el día uno con ese rótulo exacto —
// «Logo Versión Clara · Para sidebar y fondos oscuros».
//
// **Y NINGUNA PANTALLA LO LEÍA.** La columna se escribía y no la consultaba nadie, así
// que el panel azul marino de /cliente pintaba el PRINCIPAL y en producción salía un
// parche blanco con letras azules sobre el fondo oscuro. Una columna que se puede
// llenar y que nadie lee es el mismo defecto que `vehiculos_tercero.capacidad_tanque`
// sin formulario, por la puerta contraria: ahí faltaba dónde escribirla, acá faltaba
// quién la leyera, y en los dos casos el operador configura algo que no hace nada.
//
// EL FONDO LO DECLARA LA PANTALLA. El ERP no puede mirar un PNG y decidir si se ve
// encima, así que `logoDeFondo` recibe "claro" | "oscuro" en vez de adivinarlo — mismo
// criterio que `respeta_horario`, que se declara por tipo en vez de deducirse de la clave.
//
// LAS DOS CASCADAS NO SON SIMÉTRICAS, y ahí está lo único delicado:
//   · sobre OSCURO: clara → principal. Sin versión clara se cae al principal porque ES
//     EL LOGO DE LA EMPRESA: se verá su fondo blanco, pero es suyo y se lee. Es además
//     el comportamiento que ya había, así que llenar el perfil solo puede mejorarlo.
//   · sobre CLARO: principal, y NUNCA la versión clara. Un logo blanco sobre papel
//     blanco no es un logo feo: es un logo invisible, el mismo error al revés.
//
// Sin ninguna de las dos devuelve `null` y **decide la pantalla** qué poner (su asset o
// nada). Aquí no se nombra ningún archivo: los del bundle son de AFA y este ERP se vende.
// ══════════════════════════════════════════════════════════════════════════════

/** Sobre qué está pintado el logo. Lo sabe la pantalla, no la base. */
export type FondoLogo = "claro" | "oscuro";

/** El logo que SÍ se ve sobre ese fondo, o `null` si el perfil no tiene ninguno. */
export function logoDeFondo(
  p: Pick<PerfilEmpresa, "logo_url" | "logo_claro_url"> | null | undefined,
  fondo: FondoLogo,
): string | null {
  const v = (x: unknown): string => String(x ?? "").trim();
  const principal = v(p?.logo_url);
  const claro = v(p?.logo_claro_url);
  if (fondo === "oscuro") return claro || principal || null;
  return principal || null;
}

/**
 * Las cuentas utilizables: las que tienen banco Y algún número.
 *
 * Una fila con solo el rótulo del banco no dice dónde pagar, así que no se imprime — el mismo
 * criterio que el resto del perfil: sin dato no se enseña el hueco donde iría.
 */
export function cuentasUtiles(v: unknown): CuentaBancaria[] {
  if (!Array.isArray(v)) return [];
  return v
    .map(c => ({
      banco:  String((c as any)?.banco  ?? "").trim(),
      cuenta: String((c as any)?.cuenta ?? "").trim(),
      cci:    String((c as any)?.cci    ?? "").trim(),
    }))
    .filter(c => c.banco && (c.cuenta || c.cci));
}

/** Los campos que salen impresos, con el rótulo que usa /configuracion/perfil. */
const CAMPOS_IMPRESOS: { clave: keyof PerfilEmpresa; label: string }[] = [
  { clave: "nombre",       label: "Nombre de la empresa" },
  { clave: "razon_social", label: "Razón social" },
  { clave: "ruc",          label: "RUC" },
  { clave: "direccion",    label: "Dirección" },
  { clave: "telefono",     label: "Teléfono" },
  { clave: "email",        label: "Email de contacto" },
  { clave: "web",          label: "Sitio web" },
];

export type EmpresaResuelta = {
  nombre: string;
  razonSocial: string;
  ruc: string;
  telefono: string;
  email: string;
  web: string;
  direccion: string;
  logo: string | null;
  autorizacion: string;
  /** Las cuentas de cobro que se pueden imprimir. Vacío = el PDF omite el bloque entero. */
  cuentas: CuentaBancaria[];
  /** Los campos impresos que siguen vacíos, con su rótulo. Vacío = el perfil está completo. */
  faltan: string[];
  /** `true` cuando el nombre que se va a imprimir es el aviso, no el de una empresa. */
  sinConfigurar: boolean;
};

/**
 * El perfil con los huecos rellenos, y la lista de lo que falta.
 *
 * Una cadena VACÍA cuenta como hueco: en la base esos campos están en `''`, no en null, y un
 * `??` los daría por buenos — que es exactamente por lo que el pie de la liquidación llegó a
 * imprimir tres rayas donde iban la dirección, el teléfono y el correo.
 */
export function empresaConDefectos(p?: PerfilEmpresa | null): EmpresaResuelta {
  const v = (x: unknown): string => String(x ?? "").trim();

  const nombre = v(p?.nombre) || v(p?.razon_social);
  const faltan = CAMPOS_IMPRESOS.filter(c => !v(p?.[c.clave])).map(c => c.label);

  return {
    // El único con respaldo, y el respaldo es un aviso: ver la cabecera.
    nombre: nombre || NOMBRE_SIN_CONFIGURAR,
    razonSocial: v(p?.razon_social) || nombre || NOMBRE_SIN_CONFIGURAR,
    // Los demás, vacíos. El documento omite la línea en vez de inventar el dato de otro.
    ruc: v(p?.ruc),
    telefono: v(p?.telefono),
    email: v(p?.email),
    web: v(p?.web),
    direccion: v(p?.direccion),
    logo: v(p?.logo_url) || null,
    /**
     * LA AUTORIZACIÓN DEL REGULADOR NUNCA TUVO RESPALDO, y ahora acompaña al resto.
     * Es un número legal: heredar el de otra empresa sería afirmar en un papel firmado una
     * habilitación que su emisor no tiene.
     */
    autorizacion: v(p?.autorizacion_mtc),
    cuentas: cuentasUtiles(p?.cuentas_bancarias),
    faltan,
    sinConfigurar: !nombre,
  };
}
