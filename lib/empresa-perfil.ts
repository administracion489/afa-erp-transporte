// Los datos de AFA que salen impresos, cuando `empresa_perfil` no los tiene.
//
// La fila única de `empresa_perfil` es la fuente de verdad y se edita desde el ERP. Pero
// hoy tiene la dirección, el teléfono y el correo VACÍOS, y cada documento resolvía eso por
// su cuenta: el PDF de la cotización cae a unos literales escritos a mano —repetidos en
// cuatro sitios del mismo archivo— y la liquidación no caía a nada, así que su pie de
// página salía con tres rayas donde deberían ir la dirección, el teléfono y el correo.
//
// Los valores son los que la cotización ya venía imprimiendo, así que los documentos que
// AFA envía dicen lo mismo se emitan desde donde se emitan. Cuando alguien llene el perfil
// en el ERP, estos dejan de usarse solos: son el último escalón, no una constante que pise
// al dato.
export const EMPRESA_DEFECTO = {
  nombre: "AFA Tours Peru S.A.C.",
  ruc: "20602117091",
  telefono: "966 707 225",
  email: "transporte@afatoursperu.com",
  web: "www.afatoursperu.com",
  direccion: "Mza. F Lote. 2 Asc. Trabajadores Unidos Chacrasana · Lima",
} as const;

export type PerfilEmpresa = {
  nombre?: string | null;
  razon_social?: string | null;
  ruc?: string | null;
  logo_url?: string | null;
  telefono?: string | null;
  email?: string | null;
  direccion?: string | null;
  web?: string | null;
};

/**
 * El perfil con los huecos rellenos. Una cadena vacía cuenta como hueco: en la base esos
 * campos están en `''`, no en null, y `?? ` los daría por buenos — que es exactamente por
 * lo que el pie de la liquidación imprimía tres rayas.
 */
export function empresaConDefectos(p?: PerfilEmpresa | null) {
  const v = (x: unknown, def: string) => {
    const s = String(x ?? "").trim();
    return s || def;
  };
  return {
    nombre: v(p?.nombre || p?.razon_social, EMPRESA_DEFECTO.nombre),
    razonSocial: v(p?.razon_social || p?.nombre, EMPRESA_DEFECTO.nombre),
    ruc: v(p?.ruc, EMPRESA_DEFECTO.ruc),
    telefono: v(p?.telefono, EMPRESA_DEFECTO.telefono),
    email: v(p?.email, EMPRESA_DEFECTO.email),
    web: v(p?.web, EMPRESA_DEFECTO.web),
    direccion: v(p?.direccion, EMPRESA_DEFECTO.direccion),
    logo: String(p?.logo_url ?? "").trim() || null,
  };
}
