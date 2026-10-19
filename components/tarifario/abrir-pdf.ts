// components/tarifario/abrir-pdf.ts — SOLO NAVEGADOR. Abre en otra pestaña un PDF que arma el
// servidor: el ejemplo del simulador de traslados (/tarifario) y la vista previa de la cotización
// de traslado en el inbox del CRM (components/crm/BandejaCRM.tsx).
//
// LA PESTAÑA SE ABRE EN EL MISMO CLIC, ANTES DE PEDIR EL PDF: abrirla después de un `await` la
// bloquea el navegador como ventana emergente, y el botón parecería no hacer nada.
// EL TIPO CON QUE SE ENSEÑA LO PONE LA PANTALLA (`application/pdf`), y solo si los bytes EMPIEZAN
// por «%PDF-»: cualquier otra respuesta se dice como error, nunca se pinta como documento.

export type ResultadoPdf = { ok: true } | { ok: false; detalle: string };

/** Vida del enlace del PDF: lo bastante para que la pestaña lo cargue y se pueda guardar. */
const VIDA_URL_MS = 10 * 60_000;

/**
 * Pide el PDF con `pedir` (un fetch con `cabecerasErp()`) y lo abre en otra pestaña.
 * `permiso` nombra lo que falta ante un 403 («el permiso del módulo CRM»).
 */
export async function abrirPdf(pedir: () => Promise<Response>, permiso: string): Promise<ResultadoPdf> {
  let w: Window | null = null;
  try { w = window.open("", "_blank"); } catch { w = null; }
  if (w) {
    try { w.document.title = "Armando el PDF…"; w.document.body.textContent = "Armando el PDF…"; } catch { /* la pestaña es una comodidad */ }
  }
  const cerrar = () => { try { w?.close(); } catch { /* ya cerrada */ } };
  try {
    const res = await pedir();
    const esPdf = /application\/pdf/i.test(res.headers.get("content-type") ?? "");
    if (!res.ok || !esPdf) {
      cerrar();
      const d = (await res.json().catch(() => null)) as { detalle?: string; error?: string } | null;
      if (res.status === 401) return { ok: false, detalle: "Tu sesión venció o no se pudo verificar: vuelve a ingresar." };
      if (res.status === 403) {
        return { ok: false, detalle: /origen/i.test(d?.error ?? "") ? "El servidor rechazó la llamada (origen no permitido). Abre el ERP desde su dirección oficial." : `Te falta ${permiso} (lo da un administrador en Usuarios).` };
      }
      if (res.status === 404 && !d) return { ok: false, detalle: "La vista del PDF todavía no está desplegada en el servidor." };
      return { ok: false, detalle: d?.detalle || d?.error || `El servidor respondió ${res.status} sin un PDF.` };
    }
    const bytes = await res.arrayBuffer();
    if (new TextDecoder().decode(new Uint8Array(bytes.slice(0, 5))) !== "%PDF-") {
      cerrar();
      return { ok: false, detalle: "Lo que devolvió el servidor no es un PDF." };
    }
    const url = URL.createObjectURL(new Blob([bytes], { type: "application/pdf" }));
    setTimeout(() => URL.revokeObjectURL(url), VIDA_URL_MS);
    if (w && !w.closed) { w.location.href = url; return { ok: true }; }
    if (window.open(url, "_blank")) return { ok: true };
    return { ok: false, detalle: "El navegador bloqueó la pestaña del PDF: permite las ventanas emergentes de este sitio y vuelve a pulsar." };
  } catch (e) {
    cerrar();
    return { ok: false, detalle: `No se pudo traer el PDF: ${(e as Error)?.message ?? "sin conexión"}.` };
  }
}
