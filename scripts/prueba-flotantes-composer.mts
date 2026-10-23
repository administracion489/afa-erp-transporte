// Pruebas de los dos motores PUROS de la tanda «CRM en celular»:
//   · lib/flotante-arrastrable.ts — ELIA y el «?» se arrastran y nunca quedan fuera de la pantalla.
//   · lib/useAltoAutomatico.ts    — el cuadro de respuesta del CRM crece con el texto hasta un tope.
// Uso:  npx tsx scripts/prueba-flotantes-composer.mts   (sale con código 1 si algo falla)

import {
  ANCHO_CELULAR, INICIAL_AYUDA as AYUDA, INICIAL_ELIA as ELIA, MARGEN_FLOTANTE, TAMANO_FLOTANTE, UMBRAL_ARRASTRE_PX,
  esArrastre, ladoEtiqueta, leerPosicionGuardada, limitarPosicion, moverDesde, posicionInicial,
  type PosFlotante, type Ventana,
} from "../lib/flotante-arrastrable";
import { altoAutomatico } from "../lib/useAltoAutomatico";

let fallos = 0;
const chk = (nombre: string, ok: boolean, detalle?: unknown) => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${!ok && detalle !== undefined ? `  → ${JSON.stringify(detalle)}` : ""}`);
  if (!ok) fallos++;
};
const igual = (a: PosFlotante, b: PosFlotante) => a.right === b.right && a.bottom === b.bottom;

const ESCRITORIO: Ventana = { ancho: 1920, alto: 1080 };
const CELULAR: Ventana = { ancho: 375, alto: 740 };
const T = 54;

// ── 1. La posición de siempre no se mueve ─────────────────────────────────────
console.log("\n— 1. Donde nacían, se quedan (bottom-5 right-5 y bottom-5 right-24) —");
chk("ELIA en escritorio", igual(limitarPosicion({ right: 20, bottom: 20 }, ESCRITORIO, T), { right: 20, bottom: 20 }));
chk("ELIA en celular", igual(limitarPosicion({ right: 20, bottom: 20 }, CELULAR, T), { right: 20, bottom: 20 }));
chk("«?» en celular", igual(limitarPosicion({ right: 96, bottom: 20 }, CELULAR, T), { right: 96, bottom: 20 }));

// Las que usan app/_components/elia.tsx y AyudaModulo.tsx: en escritorio, donde estaban (bottom-5
// right-5 y right-24); en el celular, apiladas en el borde derecho por encima del cuadro de respuesta.
chk("escritorio: las mismas de antes (Tailwind bottom-5 right-5 / right-24)",
  igual(ELIA.escritorio, { right: 20, bottom: 20 }) && igual(AYUDA.escritorio, { right: 96, bottom: 20 }) && TAMANO_FLOTANTE === T);
chk("escritorio: ELIA nace abajo a la derecha, como antes", igual(posicionInicial(ESCRITORIO, ELIA), ELIA.escritorio));
chk("escritorio: el «?» a su izquierda, como antes", igual(posicionInicial(ESCRITORIO, AYUDA), AYUDA.escritorio));
chk("tableta (768 px) cuenta como escritorio", igual(posicionInicial({ ancho: ANCHO_CELULAR, alto: 1024 }, ELIA), ELIA.escritorio));
chk("celular: ELIA más arriba, sin tapar «Enviar»", igual(posicionInicial(CELULAR, ELIA), ELIA.celular) && ELIA.celular.bottom > 110);
chk("celular: el «?» encima de ELIA, sin pisarla",
  posicionInicial(CELULAR, AYUDA).bottom >= posicionInicial(CELULAR, ELIA).bottom + T);
chk("ventana sin medir (0 px) no es celular", igual(posicionInicial({ ancho: 0, alto: 0 }, ELIA), ELIA.escritorio));

// ── 2. Nunca fuera de la pantalla ─────────────────────────────────────────────
console.log("\n— 2. Ninguna posición deja el botón fuera de la pantalla (barrido) —");
{
  let malas = 0;
  let ejemplo: unknown = null;
  const ventanas: Ventana[] = [ESCRITORIO, CELULAR, { ancho: 320, alto: 480 }, { ancho: 40, alto: 40 }, { ancho: 0, alto: 0 }];
  const valores = [-5000, -1, 0, 7, 8, 20, 300, 1000, 1859, 1866, 5000, NaN, Infinity];
  for (const v of ventanas) for (const r of valores) for (const b of valores) {
    const p = limitarPosicion({ right: r, bottom: b }, v, T);
    const cabe = v.ancho >= T + 2 * MARGEN_FLOTANTE && v.alto >= T + 2 * MARGEN_FLOTANTE;
    const dentro =
      Number.isFinite(p.right) && Number.isFinite(p.bottom) &&
      p.right >= MARGEN_FLOTANTE && p.bottom >= MARGEN_FLOTANTE &&
      (!cabe || (p.right + T + MARGEN_FLOTANTE <= v.ancho && p.bottom + T + MARGEN_FLOTANTE <= v.alto));
    if (!dentro) { malas++; ejemplo ??= { v, r, b, p }; }
  }
  chk(`${ventanas.length * valores.length ** 2} combinaciones: siempre dentro y con su margen`, malas === 0, ejemplo);
}
chk("guardada en un monitor grande, abierta en el celular: se acerca al borde",
  igual(limitarPosicion({ right: 1500, bottom: 900 }, CELULAR, T), { right: CELULAR.ancho - T - MARGEN_FLOTANTE, bottom: CELULAR.alto - T - MARGEN_FLOTANTE }));
chk("es idempotente", (() => {
  const a = limitarPosicion({ right: 1234.6, bottom: -3 }, CELULAR, T);
  return igual(a, limitarPosicion(a, CELULAR, T));
})());

// ── 3. Toque vs. arrastre ─────────────────────────────────────────────────────
console.log("\n— 3. Un dedo que tiembla sigue siendo un toque; pasado el umbral, es arrastre —");
chk("quieto = toque", !esArrastre(0, 0));
chk(`${UMBRAL_ARRASTRE_PX - 1} px = toque`, !esArrastre(UMBRAL_ARRASTRE_PX - 1, 0));
chk("diagonal corta (3,4 → 5 px) = toque", !esArrastre(3, 4));
chk(`${UMBRAL_ARRASTRE_PX} px = arrastre`, esArrastre(0, -UMBRAL_ARRASTRE_PX));
chk("40 px = arrastre", esArrastre(-40, 12));

// ── 4. El sentido del movimiento ──────────────────────────────────────────────
console.log("\n— 4. Mover a la derecha/abajo ACERCA el botón a esos bordes —");
chk("derecha 30 px → right baja 30", moverDesde({ right: 100, bottom: 100 }, 30, 0).right === 70);
chk("abajo 50 px → bottom baja 50", moverDesde({ right: 100, bottom: 100 }, 0, 50).bottom === 50);
chk("izquierda y arriba lo alejan", igual(moverDesde({ right: 20, bottom: 20 }, -200, -300), { right: 220, bottom: 320 }));
chk("arrastrarlo a la otra punta del celular cae dentro", (() => {
  const p = limitarPosicion(moverDesde({ right: 20, bottom: 20 }, -10_000, -10_000), CELULAR, T);
  return p.right === CELULAR.ancho - T - MARGEN_FLOTANTE && p.bottom === CELULAR.alto - T - MARGEN_FLOTANTE;
})());

// ── 5. Lo guardado ────────────────────────────────────────────────────────────
console.log("\n— 5. Lo guardado en localStorage: solo una posición de verdad —");
chk("válida", igual(leerPosicionGuardada('{"right":40,"bottom":300}')!, { right: 40, bottom: 300 }));
for (const crudo of [null, undefined, "", "no-json", "null", "[]", "{}", '{"right":"40","bottom":3}', '{"right":-1,"bottom":3}', '{"right":3}', '{"right":1e999,"bottom":3}'])
  chk(`rechaza ${JSON.stringify(crudo)}`, leerPosicionGuardada(crudo as string | null) === null);

// ── 6. La etiqueta «Hola, soy ELIA» sale hacia el centro ──────────────────────
console.log("\n— 6. La etiqueta del hover sale hacia el centro de la pantalla —");
chk("abajo a la derecha → etiqueta a la izquierda", ladoEtiqueta({ right: 20, bottom: 20 }, ESCRITORIO, T) === "izquierda");
chk("arrastrado al borde izquierdo → etiqueta a la derecha", ladoEtiqueta({ right: 1850, bottom: 20 }, ESCRITORIO, T) === "derecha");

// ── 7. El cuadro de respuesta crece con el texto ──────────────────────────────
console.log("\n— 7. El cuadro de respuesta crece renglón a renglón hasta su tope —");
// text-sm (20 px de renglón) + py-2.5 (10 + 10) + borde de 1 px arriba y abajo: lo del CRM.
const LINEA = 20, RELLENO = 20, BORDE = 2;
const medir = (renglones: number, minFilas: number, maxFilas: number) =>
  altoAutomatico({ contenido: renglones * LINEA + RELLENO, linea: LINEA, relleno: RELLENO, borde: BORDE, minFilas, maxFilas });
chk("vacío en escritorio = 2 renglones (lo de antes: rows=2)", medir(1, 2, 9).alto === 2 * LINEA + RELLENO + BORDE && !medir(1, 2, 9).conScroll);
chk("vacío en celular = 1 renglón", medir(1, 1, 6).alto === LINEA + RELLENO + BORDE);
{
  let malas = 0;
  let ejemplo: unknown = null;
  for (const [min, max] of [[2, 9], [1, 6], [1, 1], [3, 3]] as const) {
    let anterior = 0;
    for (let n = 1; n <= 30; n++) {
      const { alto, conScroll } = medir(n, min, max);
      const esperado = Math.min(Math.max(n, min), max) * LINEA + RELLENO + BORDE;
      if (alto !== esperado || conScroll !== (n > max) || alto < anterior) { malas++; ejemplo ??= { min, max, n, alto, conScroll, esperado }; }
      anterior = alto;
    }
  }
  chk("barrido (4 configuraciones × 30 renglones): crece de a un renglón, para en el tope y recién ahí hay barra", malas === 0, ejemplo);
}
chk("7 renglones MÁS que el inicial en escritorio (2 → 9), como WhatsApp Web", medir(9, 2, 9).alto === 9 * LINEA + RELLENO + BORDE && !medir(9, 2, 9).conScroll);
chk("el renglón 10 ya no agranda: aparece la barra", medir(10, 2, 9).alto === medir(9, 2, 9).alto && medir(10, 2, 9).conScroll);
chk("el redondeo de subpíxeles no es «hay más texto»",
  !altoAutomatico({ contenido: 9 * LINEA + RELLENO + 0.6, linea: LINEA, relleno: RELLENO, borde: BORDE, minFilas: 2, maxFilas: 9 }).conScroll);
chk("sin line-height medible no se rompe (cae a 20 px)", Number.isFinite(altoAutomatico({ contenido: 0, linea: 0, relleno: 0, borde: 0, minFilas: 1, maxFilas: 8 }).alto));
chk("un máximo menor que el mínimo no achica por debajo del mínimo", medir(1, 3, 1).alto === 3 * LINEA + RELLENO + BORDE);

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
