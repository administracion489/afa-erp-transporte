// lib/html-escape.ts
// Escape para interpolar texto en el HTML de un correo. Todo lo que llega de un formulario
// (un motivo de rechazo, un nombre, un mensaje de SOS) se escapa antes de ir al cuerpo: sin
// esto, quien escribe el texto escribe también el HTML del correo (enlaces falsos de phishing
// con el remitente de la empresa).
export function escHtml(s: unknown): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
