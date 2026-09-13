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
  telefono?: string | null;
  email?: string | null;
  direccion?: string | null;
  web?: string | null;
  /** Autorización del regulador de transporte, para el pie de los documentos operativos. */
  autorizacion_mtc?: string | null;
};

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
    faltan,
    sinConfigurar: !nombre,
  };
}
