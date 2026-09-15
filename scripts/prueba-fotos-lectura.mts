// Pruebas de LA FOTO QUE LEYÓ LA IA (lib/radar/fotos-lectura.ts).
// NO tocan la base: datos en memoria.
// Uso:  npx tsx scripts/prueba-fotos-lectura.mts   (sale con código 1 si algo falla)
//
// Lo que fijan estas pruebas es la cascada y su respaldo. `radar_combustible.fotos` llegó con
// una migración accesoria (radar-ia-combustible-revision.sql), así que hay filas guardadas sin
// esa columna llena; para esas, lo único que queda es la media del mensaje de WhatsApp que las
// originó. Y el puente hacia una carga ya registrada es `combustible_id`, porque la tabla
// `combustible` no guarda nada del Radar: se lee al revés o no se lee.
import {
  esImagenLeida,
  fotosDeLectura,
  fotosPorCarga,
  type FotoLeida,
} from "../lib/radar/fotos-lectura";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const foto = (url: string, mime: string | null = "image/jpeg", nombre: string | null = null): FotoLeida => ({ url, mime, nombre });

// ── 1. La cascada: la fila manda, el mensaje es el respaldo ─────────────────
{
  const fila = { combustible_id: 10, mensaje_id: "m1", fotos: [{ url: "a.jpg", mime: "image/jpeg", nombre: "nota" }] };
  const conMedia = fotosDeLectura(fila, { media_url: "vieja.jpg" });
  chk("con `fotos` llena, el mensaje NO agrega nada",
    conMedia.length === 1 && conMedia[0].url === "a.jpg", conMedia.map((f) => f.url).join(","));
}
{
  // La fila vieja: `fotos` vacío (o ausente) y toda la evidencia en el mensaje de origen.
  const vieja = { combustible_id: 11, mensaje_id: "m2", fotos: [] };
  const r = fotosDeLectura(vieja, { media_url: "voucher.jpg", media_nombre: "V70S.jpg", media_mime: "image/jpeg" });
  chk("sin `fotos`, cae a la media del mensaje", r.length === 1 && r[0].url === "voucher.jpg" && r[0].nombre === "V70S.jpg");
  chk("y sin columna `fotos` del todo, igual",
    fotosDeLectura({ combustible_id: 11, mensaje_id: "m2" }, { media_url: "voucher.jpg" }).length === 1);
}
{
  chk("sin nada, la lista es vacía — no se inventa una foto",
    fotosDeLectura({ combustible_id: 12, mensaje_id: null, fotos: [] }, null).length === 0);
  chk("una fila nula no rompe", fotosDeLectura(null, null).length === 0);
  chk("una entrada sin url se descarta",
    fotosDeLectura({ fotos: [{ url: null }, { url: "" }, null, { url: "b.jpg" }] }).length === 1);
}

// ── 2. El índice por CARGA: el puente es combustible_id ─────────────────────
{
  const filas = [
    { combustible_id: 7, mensaje_id: "m1", fotos: [{ url: "nota.jpg" }, { url: "tablero.jpg" }] },
    { combustible_id: null, mensaje_id: "m9", fotos: [{ url: "suelta.jpg" }] },  // aún sin registrar
    { combustible_id: 8, mensaje_id: "m3", fotos: [] },                          // vieja, con respaldo
  ];
  const mapa = fotosPorCarga(filas, { m3: { media_url: "vieja.jpg" } });
  chk("la carga 7 recibe sus dos fotos", (mapa[7] ?? []).length === 2);
  chk("la carga 8 recibe la del mensaje", (mapa[8] ?? [])[0]?.url === "vieja.jpg");
  chk("la lectura sin registrar no entra al índice", Object.keys(mapa).length === 2, Object.keys(mapa).join(","));
}
{
  // Dos filas del Radar apuntando a la misma carga (un reproceso que volvió a proponerla, un
  // álbum con dos despachos). Se SUMAN: la pregunta es con qué papel se compara esta carga.
  const mapa = fotosPorCarga([
    { combustible_id: 5, fotos: [{ url: "a.jpg" }] },
    { combustible_id: 5, fotos: [{ url: "a.jpg" }, { url: "b.jpg" }] },
  ]);
  chk("dos filas sobre la misma carga suman sin repetir",
    (mapa[5] ?? []).map((f) => f.url).join(",") === "a.jpg,b.jpg", (mapa[5] ?? []).map((f) => f.url).join(","));
}
{
  // El id puede llegar como texto desde PostgREST (bigint). Un `combustible_id` que no es un
  // número no puede indexar nada, y silenciarlo es preferible a una clave NaN.
  const mapa = fotosPorCarga([
    { combustible_id: "42", fotos: [{ url: "a.jpg" }] },
    { combustible_id: "no-es-un-id", fotos: [{ url: "z.jpg" }] },
  ]);
  chk("un id en texto indexa igual", (mapa[42] ?? []).length === 1);
  chk("un id ilegible no crea una clave basura", Object.keys(mapa).join(",") === "42", Object.keys(mapa).join(","));
}
{
  chk("sin filas, el índice es vacío", Object.keys(fotosPorCarga([])).length === 0);
}

// ── 3. Qué se puede pintar con <img> ────────────────────────────────────────
{
  chk("image/* es foto", esImagenLeida(foto("x", "image/jpeg")));
  chk("application/pdf NO es foto", esImagenLeida(foto("x.pdf", "application/pdf")) === false);
  chk("audio tampoco", esImagenLeida(foto("nota.ogg", "audio/ogg")) === false);
}
{
  // Sin mime declarado —lo normal en las filas viejas, donde solo hay la URL— decide la
  // extensión; y sin ninguna de las dos se asume foto, que es lo que son casi todas.
  chk("sin mime, la extensión .jpg dice foto", esImagenLeida(foto("https://x/y/voucher.jpg", null)));
  chk("sin mime, la extensión .pdf dice documento", esImagenLeida(foto("https://x/y/nota.pdf", null)) === false);
  chk("sin mime ni extensión, se asume foto", esImagenLeida(foto("https://x/storage/abc123", null)));
  chk("la query de la URL no confunde la extensión",
    esImagenLeida(foto("https://x/y/nota.pdf?token=abc", null)) === false);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
