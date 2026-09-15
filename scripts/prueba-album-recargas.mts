// Pruebas de CUÁNTOS DESPACHOS trae un álbum de fotos. NO tocan la base: datos en memoria
// contra el módulo puro lib/radar/album-recargas.ts.
// Uso:  npx tsx scripts/prueba-album-recargas.mts   (sale con código 1 si algo falla)
//
// El caso que lo motivó, del 20-08-2026: el conductor mandó juntas las dos notas del día y el
// Radar las fusionó en una sola recarga.
//
//     V70S-00043064 · 05:36 · CTV370 · 7.430 gal × 24.230 = S/ 180.03 · km 27,834
//     V70S-00043083 · 17:08 · BUI272 · 9.928 gal × 24.230 = S/ 240.56 · km 175,112
//
// Dos placas, dos comprobantes, once horas de diferencia. Salió UNA fila con la placa de un
// voucher y los números del otro, y los S/ 240.56 del segundo no quedaron en ninguna parte.
// El prompt lo ordenaba ("combínalos en UNA sola extracción — no los trates por separado") y
// `multiples_recargas_en_cluster` existía como código… sin que ningún código lo levantara.
import { leerAlbumRecargas, buscarDuplicado, type DespachoGuardado } from "../lib/radar/album-recargas";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

// El principal, tal como queda en los campos planos de la extracción.
const CTV = { comprobante: "V70S-00043064", placa: "CTV-370", monto: 180.03 };

// ── 1. El caso real: dos notas en la misma ráfaga ───────────────────────────
{
  const a = leerAlbumRecargas(
    {
      recargas_adicionales: [
        {
          placa: "BUI272",
          comprobante: "V70S-00043083",
          fecha: "2026-08-20",
          hora: "17:08",
          galones: 9.928,
          precio_galon: 24.23,
          monto_total: 240.56,
          kilometraje: 175112,
        },
      ],
      comprobantes_vistos: ["V70S-00043064", "V70S-00043083"],
    },
    CTV
  );
  chk("el álbum se declara múltiple", a.multiple, `total=${a.total}`);
  chk("son dos despachos", a.total === 2, String(a.total));
  chk("la segunda recarga se conserva entera", a.adicionales.length === 1 && a.adicionales[0].montoTotal === 240.56);
  chk("con su placa, no la del principal", a.adicionales[0].placa === "BUI272", a.adicionales[0].placa ?? "—");
  chk("y su kilometraje", a.adicionales[0].kilometraje === 175112);
  chk("no se marca incompleto: se extrajeron las dos", a.incompleto === false);
  console.log(`        ${a.detalle}`);
}

// ── 2. Un reporte normal (una sola recarga, varias fotos) no se toca ────────
{
  const a = leerAlbumRecargas({ comprobantes_vistos: ["V70S-00043064"] }, CTV);
  chk("un solo despacho no es múltiple", a.multiple === false, `total=${a.total}`);
  chk("sin adicionales", a.adicionales.length === 0);
  chk("y sin detalle que mostrar", a.detalle === "");
}
{
  const a = leerAlbumRecargas({}, CTV);
  chk("sin ninguno de los dos campos, tampoco", a.multiple === false && a.detalle === "");
}

// ── 3. LA IA VIO DOS Y EXTRAJO UNA: el dato se pierde igual ─────────────────
{
  const a = leerAlbumRecargas({ comprobantes_vistos: ["V70S-00043064", "V70S-00043083"] }, CTV);
  chk("dos comprobantes vistos ya es múltiple", a.multiple, `total=${a.total}`);
  chk("y se marca incompleto", a.incompleto);
  chk("el detalle avisa que faltan por cargar", a.detalle.includes("a mano"));
  console.log(`        ${a.detalle}`);
}

// ── 4. El principal repetido dentro de los adicionales NO cuenta dos veces ──
{
  const a = leerAlbumRecargas(
    {
      recargas_adicionales: [
        { placa: "CTV-370", comprobante: "V70S-00043064", galones: 7.43, monto_total: 180.03 },
      ],
      comprobantes_vistos: ["V70S-00043064"],
    },
    CTV
  );
  chk("el eco del principal se descarta", a.multiple === false, `total=${a.total}`);
  chk("y no deja fila adicional", a.adicionales.length === 0);
}
{
  // Sin comprobante en la copia: se reconoce por placa + importe.
  const a = leerAlbumRecargas(
    { recargas_adicionales: [{ placa: "CTV370", galones: 7.43, monto_total: 180.03 }] },
    CTV
  );
  chk("el eco sin comprobante también, por placa e importe", a.multiple === false, `total=${a.total}`);
}

// ── 5. Dos adicionales iguales entre sí se cuentan una vez ──────────────────
{
  const dup = { placa: "BUI272", comprobante: "V70S-00043083", galones: 9.928, monto_total: 240.56 };
  const a = leerAlbumRecargas({ recargas_adicionales: [dup, { ...dup }] }, CTV);
  chk("el adicional duplicado se colapsa", a.adicionales.length === 1, String(a.adicionales.length));
  chk("y el total son dos despachos", a.total === 2, String(a.total));
}

// ── 6. Una entrada sin ningún dato es ruido, no una recarga ─────────────────
{
  const a = leerAlbumRecargas(
    { recargas_adicionales: [{ placa: "BUI272" }, null, "texto", { galones: null, monto_total: null }] },
    CTV
  );
  chk("las entradas sin números se descartan", a.adicionales.length === 0, String(a.adicionales.length));
  chk("y el álbum sigue siendo de un despacho", a.multiple === false);
}

// ── 7. Tres vouchers del día ────────────────────────────────────────────────
{
  const a = leerAlbumRecargas(
    {
      recargas_adicionales: [
        { placa: "BUI272", comprobante: "V70S-00043083", galones: 9.928, monto_total: 240.56 },
        { placa: "CWZ371", comprobante: "V70S-00043099", galones: 12.5, monto_total: 302.88 },
      ],
      comprobantes_vistos: ["V70S-00043064", "V70S-00043083", "V70S-00043099"],
    },
    CTV
  );
  chk("tres despachos se cuentan bien", a.total === 3, String(a.total));
  chk("dos filas adicionales", a.adicionales.length === 2);
  chk("no es incompleto", a.incompleto === false);
  chk("el detalle nombra las dos placas", a.detalle.includes("BUI272") && a.detalle.includes("CWZ371"));
}

// ── 8. El comprobante se compara sin guiones ni mayúsculas ──────────────────
{
  const a = leerAlbumRecargas(
    { recargas_adicionales: [{ comprobante: "v70s 00043064", galones: 7.43, monto_total: 180.03 }] },
    CTV
  );
  chk("v70s 00043064 ≡ V70S-00043064", a.multiple === false, `total=${a.total}`);
}

// ── 9. Un álbum sin comprobantes pero con dos importes distintos ────────────
{
  // El grifo no siempre imprime un correlativo legible; la placa y el importe bastan.
  const a = leerAlbumRecargas(
    { recargas_adicionales: [{ placa: "BUI272", galones: 9.928, monto_total: 240.56 }] },
    { comprobante: null, placa: "CTV-370", monto: 180.03 }
  );
  chk("sin comprobantes, dos importes distintos siguen siendo dos", a.multiple, `total=${a.total}`);
  chk("y la segunda conserva su importe", a.adicionales[0].montoTotal === 240.56);
}

// ── 10. EL MISMO VOUCHER DOS VECES, CON PLACAS DISTINTAS ───────────────────
// El otro caso real: la nota V70S-00043064 (CTV370, 7.430 gal, S/ 180.03) entró DOS veces —
// una atribuida a BUI-272 y otra a CTV-370. El chequeo de duplicados exigía `.eq("placa", …)`,
// así que como las placas no coincidían nunca las comparó y no salió ninguna advertencia.
const YA_GUARDADO: DespachoGuardado[] = [
  { id: "rc-bui", placa: "BUI-272", fecha: "2026-08-20", comprobante: "U70S-00043064", monto: 180.03, cantidad: 7.43 },
];
{
  const d = buscarDuplicado(
    { placa: "CTV-370", fecha: "2026-08-20", comprobante: "U70S-00043064", monto: 180.03, cantidad: 7.43 },
    YA_GUARDADO
  );
  chk("el mismo comprobante se detecta aunque cambie la placa", d?.por === "comprobante", d?.por ?? "sin duplicado");
  chk("y apunta a la fila que ya estaba", d?.id === "rc-bui");
  console.log(`        ${d?.detalle}`);
}
{
  // Sin comprobante legible en ninguno: importe Y cantidad idénticos con OTRA placa.
  const d = buscarDuplicado(
    { placa: "CTV-370", fecha: "2026-08-20", comprobante: null, monto: 180.03, cantidad: 7.43 },
    [{ ...YA_GUARDADO[0], comprobante: null }]
  );
  chk("sin comprobante, importe + cantidad cruzando placas también", d?.por === "otra_placa", d?.por ?? "sin duplicado");
  console.log(`        ${d?.detalle}`);
}
{
  // El comprobante se compara normalizado: guiones y mayúsculas no lo cambian.
  const d = buscarDuplicado(
    { placa: "X", fecha: "2026-09-01", comprobante: "u70s 00043064", monto: 9, cantidad: 1 },
    YA_GUARDADO
  );
  chk("el comprobante normaliza guiones y mayúsculas", d?.por === "comprobante");
  chk("y NO exige que la fecha coincida (una foto reenviada después)", d != null);
}

// ── 11. Lo que NO se puede acusar de duplicado ─────────────────────────────
{
  // Dos unidades que llenan por el mismo importe el mismo día: pasa, y NO es duplicado
  // mientras las cantidades difieran. Llenar por S/ 100 redondos es lo normal.
  const d = buscarDuplicado(
    { placa: "CTV-370", fecha: "2026-08-20", comprobante: null, monto: 180.03, cantidad: 7.9 },
    [{ ...YA_GUARDADO[0], comprobante: null }]
  );
  chk("mismo importe pero otra cantidad y otra placa NO es duplicado", d === null, d?.por ?? "null");
}
{
  const d = buscarDuplicado(
    { placa: "CTV-370", fecha: "2026-08-21", comprobante: "U70S-99999999", monto: 180.03, cantidad: 7.43 },
    YA_GUARDADO
  );
  chk("otro día y otro comprobante no es duplicado", d === null, d?.por ?? "null");
}
{
  const d = buscarDuplicado({ placa: "BUI-272", fecha: "2026-08-20", comprobante: null, monto: 180.03, cantidad: null }, [
    { ...YA_GUARDADO[0], comprobante: null },
  ]);
  chk("la misma placa y el mismo importe siguen bastando", d?.por === "misma_placa", d?.por ?? "null");
}
{
  chk("sin nada guardado no hay duplicado", buscarDuplicado({ placa: "A", fecha: "2026-08-20", comprobante: "X", monto: 1, cantidad: 1 }, []) === null);
  chk("sin importe ni comprobante no se juzga", buscarDuplicado({ placa: "A", fecha: "2026-08-20", comprobante: null, monto: null, cantidad: 5 }, YA_GUARDADO) === null);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
