// Pruebas del RESPALDO de un registro manual (lib/evidencia.ts).
// NO tocan la base ni Storage: el cliente es falso y en memoria.
// Uso:  npx tsx scripts/prueba-evidencia.mts   (sale con código 1 si algo falla)
//
// Lo que fijan: (1) un archivo que no sirve se rechaza CON su motivo antes de subirlo; (2) una
// subida que falla se DICE —nunca se pierde callada, que era el defecto del odómetro manual—;
// (3) voucher y constancia van al bucket PRIVADO y el tablero al de las fotos de odómetro;
// (4) lo guardado se lee sin confiar en su forma; (5) el ciclo subir → retirar borra lo mismo
// que subió.
import {
  revisarArchivo, mimeDe, rutaEvidencia, normalizarEvidencias, fotoDeTablero, esImagenEvidencia,
  subirEvidencias, retirarSubidas, preguntaSinRespaldo, bucketDe, MAX_BYTES_EVIDENCIA, motivoDeSubida,
} from "../lib/evidencia";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};
const arch = (name: string, type: string, size = 1000) => ({ name, type, size });

// ── 1. Qué se acepta ─────────────────────────────────────────────────────────
{
  chk("JPG se acepta", revisarArchivo(arch("v.jpg", "image/jpeg")).ok);
  chk("PDF se acepta como voucher", revisarArchivo(arch("c.pdf", "application/pdf")).ok);
  const pdfTablero = revisarArchivo(arch("c.pdf", "application/pdf"), { soloImagen: true });
  chk("PDF NO se acepta donde va una foto (tablero), con su motivo", !pdfTablero.ok && /FOTO/.test((pdfTablero as any).motivo));
  const heic = revisarArchivo(arch("IMG_1.HEIC", ""));
  chk("HEIC sin tipo se reconoce por la extensión y se rechaza diciendo por qué", !heic.ok && /HEIC/.test((heic as any).motivo));
  chk("vacío se rechaza", !revisarArchivo(arch("x.jpg", "image/jpeg", 0)).ok);
  chk("más de 20 MB se rechaza", !revisarArchivo(arch("x.jpg", "image/jpeg", MAX_BYTES_EVIDENCIA + 1)).ok);
  chk("justo 20 MB pasa", revisarArchivo(arch("x.jpg", "image/jpeg", MAX_BYTES_EVIDENCIA)).ok);
  chk("Word no", !revisarArchivo(arch("x.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document")).ok);
  chk("sin tipo pero .pdf → application/pdf", mimeDe(arch("A.PDF", "")) === "application/pdf");
}

// ── 2. La ruta: no pisa otra y no lleva caracteres raros ────────────────────
{
  const r = rutaEvidencia("/combustible/p12/", "Voucher Ñandú #3 (copia).JPG", 1700000000000, "ab12cd");
  chk("ruta limpia y con la extensión en minúsculas", r === "combustible/p12/1700000000000-ab12cd-Voucher-Nandu-3-copia.jpg", r);
  const a = rutaEvidencia("x", "foto.jpg", 1, "aaa"), b = rutaEvidencia("x", "foto.jpg", 1, "bbb");
  chk("el mismo nombre en el mismo instante NO se pisa (azar)", a !== b);
  chk("sin nombre no queda vacía", rutaEvidencia("x", ".jpg", 1, "z").includes("archivo"));
}

// ── 3. Leer lo guardado sin confiar en su forma ─────────────────────────────
{
  chk("null → []", normalizarEvidencias(null).length === 0);
  chk("no-array → []", normalizarEvidencias({ url: "x" }).length === 0);
  const evs = normalizarEvidencias([
    { url: "https://p/v.jpg", nombre: "v.jpg", mime: "image/jpeg", clase: "voucher" },
    { url: "", nombre: "sin url" },
    { url: "https://p/t.png", clase: "tablero", mime: "image/png" },
    { url: "https://p/c.pdf", clase: "rara", mime: "application/pdf" },
    7,
  ]);
  chk("descarta lo que no tiene URL", evs.length === 3);
  chk("clase desconocida cae a voucher, no se inventa otra", evs[2].clase === "voucher");
  chk("la foto del tablero es la que acompaña a la lectura", fotoDeTablero(evs) === "https://p/t.png");
  chk("un PDF no es imagen", !esImagenEvidencia(evs[2]));
  chk("sin tablero no hay foto de lectura", fotoDeTablero(evs.filter((e) => e.clase !== "tablero")) === null);
}

// ── 4. Subir: lo que falla se DICE, y cada clase va a su bucket ──────────────
function clienteFalso(opts: { fallaEn?: string } = {}) {
  const subidos: { bucket: string; ruta: string }[] = [];
  const borrados: { bucket: string; rutas: string[] }[] = [];
  return {
    subidos, borrados,
    storage: {
      from: (bucket: string) => ({
        upload: async (ruta: string) => {
          if (opts.fallaEn && ruta.includes(opts.fallaEn)) return { error: { message: "Payload too large" } };
          subidos.push({ bucket, ruta });
          return { error: null };
        },
        getPublicUrl: (ruta: string) => ({ data: { publicUrl: `https://x.supabase.co/storage/v1/object/public/${bucket}/${encodeURI(ruta)}` } }),
        remove: async (rutas: string[]) => { borrados.push({ bucket, rutas }); return { error: null }; },
      }),
    },
  };
}
{
  chk("voucher → bucket privado documentos", bucketDe("voucher") === "documentos");
  chk("constancia → documentos", bucketDe("constancia") === "documentos");
  chk("tablero → vehiculos-fotos (donde viven las fotos de odómetro)", bucketDe("tablero") === "vehiculos-fotos");

  const c = clienteFalso({ fallaEn: "malo" });
  const r = await subirEvidencias(c, [
    { archivo: arch("voucher.jpg", "image/jpeg"), clase: "voucher" },
    { archivo: arch("malo.jpg", "image/jpeg"), clase: "voucher" },
    { archivo: arch("tablero.pdf", "application/pdf"), clase: "tablero" },
    { archivo: arch("tablero.jpg", "image/jpeg"), clase: "tablero" },
  ], "combustible/p1", { ahora: () => 1, azar: () => "z" });
  chk("sube los buenos", r.subidas.length === 2, r.subidas.map((s) => s.nombre).join(","));
  chk("nombra los que fallaron, con su motivo", r.fallidas.length === 2
    && r.fallidas.some((f) => f.nombre === "malo.jpg" && /too large/.test(f.motivo))
    && r.fallidas.some((f) => f.nombre === "tablero.pdf" && /FOTO/.test(f.motivo)));
  chk("el PDF de tablero NI se intentó subir (solo la foto llegó al bucket)", c.subidos.filter((s) => s.bucket === "vehiculos-fotos").length === 1);
  chk("cada clase cayó en su bucket",
    c.subidos.find((s) => s.ruta.includes("voucher"))?.bucket === "documentos"
    && c.subidos.find((s) => s.ruta.includes("tablero"))?.bucket === "vehiculos-fotos");
  const p = preguntaSinRespaldo(r.fallidas, "la carga");
  chk("la pregunta nombra cada archivo y deja cancelar", /malo\.jpg/.test(p) && /tablero\.pdf/.test(p) && /Cancelar/.test(p));

  // Ciclo subir → retirar: borra EXACTAMENTE lo que subió (las rutas se decodifican igual que se codificaron).
  const c2 = clienteFalso();
  const r2 = await subirEvidencias(c2, [{ archivo: arch("vóucher ñ.jpg", "image/jpeg"), clase: "voucher" }], "combustible/p1", { ahora: () => 5, azar: () => "q" });
  await retirarSubidas(c2, r2.subidas);
  chk("retirar borra la misma ruta que se subió", c2.borrados.length === 1 && c2.borrados[0].bucket === "documentos"
    && c2.borrados[0].rutas[0] === c2.subidos[0].ruta, JSON.stringify(c2.borrados));

  const c3 = { storage: { from: () => ({ upload: async () => { throw new Error("Failed to fetch"); }, getPublicUrl: () => ({ data: {} }) }) } };
  const r3 = await subirEvidencias(c3, [{ archivo: arch("a.jpg", "image/jpeg"), clase: "voucher" }], "x");
  chk("sin conexión NO lanza: lo dice", r3.subidas.length === 0 && /Failed to fetch/.test(r3.fallidas[0]?.motivo ?? ""));
}

// ── 5. El rechazo de Storage por permisos se NOMBRA, no se pinta crudo ─────────
{
  const m = motivoDeSubida("new row violates row-level security policy", "documentos");
  chk("RLS de Storage → dice qué bucket y qué SQL lo arregla", /documentos/.test(m) && /seguridad-02/.test(m) && !/row-level/.test(m), m);
  chk("otro error pasa tal cual", motivoDeSubida("Payload too large", "documentos") === "Payload too large");
  chk("sin mensaje no queda vacío", motivoDeSubida("", "documentos") === "no se pudo subir");
}

console.log(fallos ? `\n${fallos} FALLA(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
