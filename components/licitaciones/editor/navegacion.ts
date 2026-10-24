// components/licitaciones/editor/navegacion.ts — De un `donde.ancla` de la revisión al elemento del DOM.
//
// Las anclas tienen UNA forma, la del contrato (contrato-editor.ts → ANCLAS), que es la misma con que
// lib/licitaciones/revision.ts escribe `Hallazgo.donde.ancla`:
//  · un PANEL: su nombre tal cual es el id del DOM ("datos", "requisitos", "unidades"…);
//  · un ELEMENTO: anclaDe(tipo, id) = "<tipo>:<id>" ("requisito:<uuid>", "unidad:p:12"…).
// El editor prueba, en orden: el elemento; si no está en pantalla, el panel de su tipo (panelDeAncla).
import { panelDeAncla } from "./contrato-editor";

/** Los ids del DOM a probar para un ancla, del más preciso al más general. */
export function candidatosAncla(ancla: string): string[] {
  const out: string[] = [ancla];
  const panel = panelDeAncla(ancla);
  if (panel) out.push(panel);
  return [...new Set(out)];
}
