// ─── DETECTOR DE ESCÁNER HID (Bluetooth / 2.4G en modo teclado) ────────────────
//
// Un escáner de código de barras/QR en modo HID se comporta como un teclado: al
// escanear, "tipea" los caracteres del código a ráfaga (~5–15 ms/char) y normalmente
// termina con Enter (algunos modelos usan Tab según configuración). Este módulo
// distingue esa ráfaga del tecleo humano y entrega el código completo de una vez.
//
// Lo usan tanto app/conductor (celular, pistola en mano) como app/lector (tablet).
// La detección, el anti-rebote y la robustez de timing viven AQUÍ para que ambos
// caminos compartan el mismo comportamiento ya endurecido.
//
// RECOMENDACIÓN DE CONFIGURACIÓN DEL EQUIPO: dejar el sufijo en Enter/CR (lo normal
// por defecto). Con Enter, cada código se delimita de forma fiable y los respaldos
// por tiempo de abajo ni siquiera entran en juego. El layout debe ser US ($LAN#EN):
// el contenido del QR de pasajero es un UUID (0-9, a-f, '-'), estable entre layouts.

export type HidScannerOpts = {
  // Se invoca con el código completo. Puede ser async; mientras su promesa no resuelva,
  // los escaneos siguientes se descartan (anti-reentrada interno).
  onScan: (code: string) => void | Promise<void>;
  // Compuerta dinámica: el listener solo procesa cuando devuelve true (p. ej. la
  // pestaña/estado correcto). Se reevalúa en cada tecla. Si se omite, siempre activo.
  enabled?: () => boolean;
  // Candado de la tubería externa (cámara + BT comparten pipeline): si devuelve true,
  // se descarta el escaneo para no pisar uno en curso.
  isBusy?: () => boolean;
  // Largo mínimo del código. Filtra teclas sueltas (ruido) y asume que el código es
  // un token largo. Default 3.
  minLength?: number;
  // Ignora el MISMO código repetido dentro de esta ventana — absorbe el gatillo
  // sostenido que reenvía el código. Default 1500 ms.
  dedupeMs?: number;
};

// Respaldo de cierre cuando el escáner NO manda Enter/Tab (sufijo). GENEROSO a propósito:
// dentro de un WebView con carga (la app conductor corre GPS, timers, mapa) el event loop
// puede trabarse cientos de ms entre teclas; un umbral corto cerraría el código a la mitad.
// El terminador real es Enter (lo manda el RED-L8BLS/NETUM por defecto), así que esto casi
// nunca entra en juego. NO segmentamos por gaps entre teclas: eso partía el UUID en el WebView.
const QUIET_MS = 600;

const ahora = () => (typeof performance !== "undefined" ? performance.now() : Date.now());

/**
 * Engancha el detector a `document` y devuelve la función de limpieza.
 * Llamar desde un useEffect y retornar el resultado como cleanup.
 */
export function attachHidScanner(opts: HidScannerOpts): () => void {
  const minLength = opts.minLength ?? 3;
  const dedupeMs  = opts.dedupeMs ?? 1500;

  let buffer = "";
  let lastKeyTs = 0;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let procesando = false;            // reentrada local (cubre onScan async)
  let ultimoCode = "";
  let ultimoCodeTs = 0;

  const limpiarTimer = () => { if (timer) { clearTimeout(timer); timer = null; } };

  const emitir = async () => {
    const val = buffer.trim();
    buffer = "";
    limpiarTimer();
    // minLength: ignora keypresses sueltos (ruido) y asume que el código es un token
    // largo (el qr_code del pasajero se genera en BD/import, nunca < minLength).
    if (val.length < minLength) return;
    if (opts.enabled && !opts.enabled()) return;
    if (procesando) return;                       // ya hay un escaneo en vuelo (local)
    if (opts.isBusy && opts.isBusy()) return;     // tubería externa ocupada
    const t = ahora();
    if (val === ultimoCode && t - ultimoCodeTs < dedupeMs) return; // gatillo sostenido
    ultimoCode = val; ultimoCodeTs = t;
    // Saca el foco de cualquier botón para que un Enter/Space residual no lo active.
    try { (document.activeElement as HTMLElement | null)?.blur?.(); } catch { /* noop */ }
    procesando = true;
    try { await opts.onScan(val); } finally { procesando = false; }
  };

  // Cierre por respaldo (sin Enter): re-verifica que de verdad hubo quietud real. Si el
  // timer "expiró" por un stall del event loop pero acaba de llegar un char, re-arma en
  // vez de cortar el código a la mitad.
  const cerrarPorQuietud = () => {
    const idle = ahora() - lastKeyTs;
    if (idle < QUIET_MS) {
      limpiarTimer();
      timer = setTimeout(cerrarPorQuietud, Math.max(0, QUIET_MS - idle));
      return;
    }
    void emitir();
  };

  const onKey = (e: KeyboardEvent) => {
    if (opts.enabled && !opts.enabled()) return;
    // No interferir con campos editables: el texto debe ir al input, no al escaneo.
    const tag = (e.target as HTMLElement | null)?.tagName ?? "";
    if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
    // IME / dead keys: no acumular composición.
    if (e.isComposing || e.key === "Process") return;

    // Terminadores: Enter (sufijo por defecto) y Tab (config alterna). preventDefault en
    // Tab evita que el foco salte a un botón/campo y rompa el siguiente escaneo.
    if (e.key === "Enter" || e.key === "Tab") {
      if (e.key === "Tab") e.preventDefault();
      limpiarTimer();
      void emitir();
      return;
    }
    if (e.key.length !== 1) return; // ignora modificadores (Shift, Control…) y teclas de control

    // Acumular SIEMPRE: nunca cerramos por gap entre teclas. El WebView puede entregar las
    // teclas con stalls largos; lo único que cierra el código es el Enter/Tab (o el respaldo
    // de quietud generoso). Así un UUID nunca se parte aunque el event loop se trabe a mitad.
    buffer += e.key;
    lastKeyTs = ahora();
    limpiarTimer();
    timer = setTimeout(cerrarPorQuietud, QUIET_MS); // respaldo SOLO si nunca llega Enter/Tab
  };

  document.addEventListener("keydown", onKey);
  return () => {
    document.removeEventListener("keydown", onKey);
    limpiarTimer();
  };
}
