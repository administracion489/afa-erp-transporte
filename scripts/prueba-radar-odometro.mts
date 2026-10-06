// Pruebas de la tabla de /radar-ia → Odómetro (lib/radar/odometro-lecturas.ts).
// NO tocan la base. Uso:  npx tsx scripts/prueba-radar-odometro.mts   (exit 1 si algo falla)
//
// Lo que no se puede aflojar:
//   1. «Pendiente» es UNA definición: el contador de la pestaña, el chip «Por revisar» y el filtro
//      de estado cuentan lo mismo.
//   2. Ningún filtro pierde ni inventa filas: lo que sale cumple TODOS los filtros, y el conteo de
//      cada opción coincide con lo que de verdad sale al elegirla (barrido).
//   3. Con lecturas pendientes la pestaña abre en ellas; sin ninguna, en todas.
//   4. Un rango imposible se DICE: la tabla vacía no puede leerse como «no hay lecturas».

import {
  esPendiente, problemaDe, filtrarLecturas, ordenarLecturas, kmDeTexto, hayFiltroLecturas, dirInicial,
  FILTRO_LECTURAS_VACIO, ESTADOS_LECTURA, type FilaLectura, type FiltroLecturas, type FiltroEstado,
} from "../lib/radar/odometro-lecturas";
import { tipoDeRevision, placaComparable, TIPOS_REVISION, type TipoRevision } from "../lib/odometro-revision";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra ? " — " + extra : ""}`);
  if (!ok) fallos++;
};

const f = (over: Partial<FiltroLecturas>): FiltroLecturas => ({ ...FILTRO_LECTURAS_VACIO, ...over });
const L = (id: string, placa: string, fecha: string | null, km: number, estado: string, extra: Partial<FilaLectura> = {}): FilaLectura => ({
  id, placa, fecha, km, estado, motivo: null, foto_url: "https://x/f.jpg",
  created_at: `${fecha ?? "2026-10-06"}T12:00:00-05:00`, vehiculo_tercero_id: null, ...extra,
});

// La pantalla del reporte (06/10/2026), más pendientes con los motivos que escribe el ERP.
const tabla: FilaLectura[] = [
  L("1", "CNQ-396", "2026-10-06", 101655, "aceptada", { vehiculo_tercero_id: 7, created_at: "2026-10-06T16:50:00-05:00" }),
  L("2", "CWQ400", "2026-10-06", 12235, "aceptada", { motivo: "Lectura con solo fecha", created_at: "2026-10-06T16:49:00-05:00" }),
  L("3", "CWZ-371", "2026-10-06", 19814, "aceptada", { created_at: "2026-10-06T16:48:00-05:00" }),
  L("4", "CUP-435", "2026-09-11", 24382, "aceptada", { vehiculo_tercero_id: 3, created_at: "2026-10-06T16:47:00-05:00" }),
  L("5", "BUI-272", "2026-09-10", 176847, "aceptada", { vehiculo_tercero_id: 2, created_at: "2026-10-06T16:46:00-05:00" }),
  L("6", "CWQ400", "2026-09-10", 10910, "aceptada", { created_at: "2026-10-06T16:45:00-05:00" }),
  L("7", "CWQ400", "2026-09-26", 11806, "sospechosa", { motivo: "Retrocede 1,200 km frente a la lectura de las 10:24 (13,006 km) (posible manipulación)", created_at: "2026-10-06T16:44:00-05:00" }),
  L("8", "CWZ-371", "2026-09-26", 190490, "sospechosa", { motivo: "Salto ×10 (190,490): posible dígito de más", foto_url: null, created_at: "2026-10-06T16:43:00-05:00" }),
  L("9", "CUP-435", "2026-09-12", 24484, "rechazada", { motivo: "Lectura inválida", vehiculo_tercero_id: 3, created_at: "2026-10-06T16:42:00-05:00" }),
  L("10", "BUI-272", "2026-09-01", 175000, "anulada", { vehiculo_tercero_id: 2, created_at: "2026-09-01T10:00:00-05:00" }),
  L("11", "CWZ-371", null, 19000, "reinicio", { created_at: "2026-08-30T10:00:00-05:00" }),
  L("12", "", "2026-09-05", 5000, "sospechosa", { motivo: null, created_at: "2026-09-05T10:00:00-05:00" }),
];

console.log("\n1 · «Pendiente» es una sola definición");
{
  chk("sospechosa es pendiente", esPendiente("sospechosa"));
  chk("rechazada es pendiente (hay que corregirla)", esPendiente("rechazada"));
  for (const e of ["aceptada", "reinicio", "anulada", "", null, undefined]) chk(`${String(e)} no es pendiente`, !esPendiente(e));
  const r = filtrarLecturas(tabla, FILTRO_LECTURAS_VACIO);
  const contadorPestaña = tabla.filter((o) => o.estado === "sospechosa" || o.estado === "rechazada").length; // el de la página
  chk("pendientesTotal = contador de la pestaña", r.pendientesTotal === contadorPestaña, `${r.pendientesTotal} vs ${contadorPestaña}`);
  chk("el chip «Por revisar» cuenta lo mismo sin filtros", r.porEstado.pendientes === contadorPestaña);
  chk("una registrada no tiene problema", problemaDe(tabla[0]) === null && problemaDe(tabla[1]) === null);
  chk("el problema sale del MISMO clasificador de /mantenimiento", problemaDe(tabla[7]) === tipoDeRevision(tabla[7].motivo) && problemaDe(tabla[7]) === "digito_de_mas");
  chk("rechazada sin motivo reconocible → «otro», no desaparece", problemaDe(tabla[8]) === "otro");
}

console.log("\n2 · «Auto»: con pendientes abre en ellas; sin ninguna, en todas");
{
  const r = filtrarLecturas(tabla, FILTRO_LECTURAS_VACIO);
  chk("con pendientes → estadoAplicado = pendientes", r.estadoAplicado === "pendientes");
  chk("y salen solo las pendientes", r.filas.length === 4 && r.filas.every((l) => esPendiente(l.estado)));
  const sinPend = tabla.filter((l) => !esPendiente(l.estado));
  const r2 = filtrarLecturas(sinPend, FILTRO_LECTURAS_VACIO);
  chk("sin pendientes → todas", r2.estadoAplicado === "todos" && r2.filas.length === sinPend.length);
  chk("la elección de la persona manda sobre «auto»", filtrarLecturas(tabla, f({ estado: "todos" })).filas.length === tabla.length);
  chk("«auto» no cuenta como filtro puesto", !hayFiltroLecturas(FILTRO_LECTURAS_VACIO));
  chk("«todos» tampoco", !hayFiltroLecturas(f({ estado: "todos" })));
  chk("«pendientes» elegido a mano sí", hayFiltroLecturas(f({ estado: "pendientes" })));
}

console.log("\n3 · Cada columna filtra");
{
  const ids = (x: FiltroLecturas) => filtrarLecturas(tabla, { ...x, orden: "llegada" }).filas.map((l) => l.id).sort((a, b) => Number(a) - Number(b)).join(",");
  chk("placa sin guion ni mayúsculas: «cwq 400»", ids(f({ estado: "todos", placa: "cwq 400" })) === "2,6,7");
  chk("placa parcial: «cwz»", ids(f({ estado: "todos", placa: "cwz" })) === "3,8,11");
  chk("una lectura sin unidad no casa con ninguna placa", !ids(f({ estado: "todos", placa: "c" })).split(",").includes("12"));
  chk("flota tercero", ids(f({ estado: "todos", flota: "tercero" })) === "1,4,5,9,10");
  chk("flota propia", ids(f({ estado: "todos", flota: "propia" })) === "2,3,6,7,8,11,12");
  chk("rango de fechas", ids(f({ estado: "todos", desde: "2026-09-10", hasta: "2026-09-26" })) === "4,5,6,7,8,9");
  chk("sin fecha no entra a un rango", !ids(f({ estado: "todos", desde: "2026-01-01" })).split(",").includes("11"));
  chk("km mínimo con coma de miles «100,000»", ids(f({ estado: "todos", kmMin: "100,000" })) === "1,5,8,10");
  chk("km máximo con punto «12.235» (incluye el borde)", ids(f({ estado: "todos", kmMax: "12.235" })) === "2,6,7,12");
  chk("con foto", !ids(f({ estado: "todos", foto: "con" })).split(",").includes("8"));
  chk("sin foto", ids(f({ estado: "todos", foto: "sin" })) === "8");
  chk("estado puntual: anulada", ids(f({ estado: "anulada" })) === "10");
  chk("problema: dígito de más", ids(f({ estado: "todos", problema: "digito_de_mas" })) === "8");
  chk("elegir un problema deja fuera las registradas aunque el estado diga «todos»",
    filtrarLecturas(tabla, f({ estado: "todos", problema: "otro" })).filas.every((l) => esPendiente(l.estado)));
  chk("filtros combinados: CWQ400 pendientes", ids(f({ estado: "pendientes", placa: "CWQ400" })) === "7");
}

console.log("\n4 · Un rango imposible se dice");
{
  const r = filtrarLecturas(tabla, f({ estado: "todos", desde: "2026-10-01", hasta: "2026-09-01" }));
  chk("desde > hasta → aviso", r.filas.length === 0 && r.avisos.some((a) => a.codigo === "rango_fechas_invertido"));
  const r2 = filtrarLecturas(tabla, f({ estado: "todos", kmMin: "50000", kmMax: "1000" }));
  chk("km mín > máx → aviso", r2.filas.length === 0 && r2.avisos.some((a) => a.codigo === "rango_km_invertido"));
  chk("rango normal → sin avisos", filtrarLecturas(tabla, f({ desde: "2026-09-01", hasta: "2026-10-01", kmMin: "1", kmMax: "9" })).avisos.length === 0);
  chk("km «abc» no es un número (no filtra ni avisa)", kmDeTexto("abc") === null && filtrarLecturas(tabla, f({ estado: "todos", kmMin: "abc" })).filas.length === tabla.length);
  chk("kmDeTexto: «23,980» = «23.980» = 23980", kmDeTexto("23,980") === 23980 && kmDeTexto("23.980") === 23980 && kmDeTexto(" 23980 km") === 23980);
}

console.log("\n5 · Orden por columna");
{
  const orden = (col: FiltroLecturas["orden"], dir: "asc" | "desc") => ordenarLecturas(tabla, col, dir).map((l) => l.id);
  chk("llegada: la más reciente primero (lo de siempre)", orden("llegada", "desc").slice(0, 3).join(",") === "1,2,3");
  const porFecha = ordenarLecturas(tabla, "fecha", "desc");
  chk("fecha ↓: la más nueva primero", porFecha[0].fecha === "2026-10-06");
  chk("fecha: sin fecha al final en las dos direcciones",
    porFecha[porFecha.length - 1].fecha === null && ordenarLecturas(tabla, "fecha", "asc").slice(-1)[0].fecha === null);
  chk("fecha ↑: la más antigua primero", ordenarLecturas(tabla, "fecha", "asc")[0].fecha === "2026-09-01");
  chk("km ↓: el mayor primero", ordenarLecturas(tabla, "km", "desc")[0].km === 190490);
  chk("km ↑: el menor primero", ordenarLecturas(tabla, "km", "asc")[0].km === 5000);
  const porUnidad = ordenarLecturas(tabla, "unidad", "asc");
  chk("unidad A→Z, sin placa al final", porUnidad[0].placa === "BUI-272" && porUnidad[porUnidad.length - 1].placa === "");
  chk("estado ↑: pendientes primero", esPendiente(ordenarLecturas(tabla, "estado", "asc")[0].estado));
  chk("el orden no pierde ni duplica filas", (["llegada", "fecha", "unidad", "km", "estado"] as const)
    .every((c) => new Set(orden(c, "asc")).size === tabla.length && new Set(orden(c, "desc")).size === tabla.length));
  chk("dirección inicial: fecha y km ↓, unidad y estado ↑",
    dirInicial("fecha") === "desc" && dirInicial("km") === "desc" && dirInicial("unidad") === "asc" && dirInicial("estado") === "asc");
}

console.log("\n6 · Barrido: lo que sale cumple todo, y cada conteo es lo que sale al elegirlo");
{
  // Tabla sintética determinista.
  const placas = ["CWQ400", "CWZ-371", "CNQ-396", "BUI-272", ""];
  const estados = ["aceptada", "sospechosa", "rechazada", "reinicio", "anulada"];
  const motivos = [null, "Salto ×10 (190,490): posible dígito de más", "Retrocede 30 km frente a la lectura de las 08:00 (100 km)", "Duplicada", "Lectura inválida"];
  const grande: FilaLectura[] = [];
  for (let i = 0; i < 300; i++) {
    const dia = 1 + (i * 7) % 30;
    grande.push(L(String(i), placas[i % 5], i % 23 === 0 ? null : `2026-09-${String(dia).padStart(2, "0")}`, 1000 + ((i * 7919) % 200000),
      estados[(i * 3) % 5], { motivo: motivos[(i * 11) % 5], foto_url: i % 4 === 0 ? null : "u", vehiculo_tercero_id: i % 3 === 0 ? 9 : null,
        created_at: new Date(Date.UTC(2026, 8, 1) + i * 3600_000).toISOString() }));
  }
  const opcionesEstado: FiltroEstado[] = ["auto", "todos", "pendientes", ...ESTADOS_LECTURA.map((e) => e.codigo)];
  const opcionesProblema: (TipoRevision | "todos")[] = ["todos", "digito_de_mas", "retroceso", "otro"];
  const pasaTodo = (l: FilaLectura, x: FiltroLecturas, estado: string) => {
    if (estado === "pendientes" && !esPendiente(l.estado)) return false;
    if (estado !== "todos" && estado !== "pendientes" && l.estado !== estado) return false;
    if (x.problema !== "todos" && problemaDe(l) !== x.problema) return false;
    const q = placaComparable(x.placa);
    if (q && !placaComparable(l.placa).includes(q)) return false;
    if (x.flota === "tercero" && l.vehiculo_tercero_id == null) return false;
    if (x.flota === "propia" && l.vehiculo_tercero_id != null) return false;
    if (x.foto === "con" && !l.foto_url) return false;
    if (x.foto === "sin" && l.foto_url) return false;
    if (x.desde && (!l.fecha || l.fecha < x.desde)) return false;
    if (x.hasta && (!l.fecha || l.fecha > x.hasta)) return false;
    const mn = kmDeTexto(x.kmMin), mx = kmDeTexto(x.kmMax);
    if (mn != null && l.km < mn) return false;
    if (mx != null && l.km > mx) return false;
    return true;
  };
  let combinaciones = 0, malos = 0, conteosMalos = 0, noTriviales = 0;
  for (const estado of opcionesEstado)
    for (const problema of opcionesProblema)
      for (const placa of ["", "cwq", "BUI 272"])
        for (const flota of ["todas", "propia", "tercero"] as const)
          for (const foto of ["todas", "con", "sin"] as const)
            for (const [desde, hasta] of [["", ""], ["2026-09-10", "2026-09-20"]])
              for (const [kmMin, kmMax] of [["", ""], ["50,000", "150.000"]]) {
                combinaciones++;
                const x = f({ estado, problema, placa, flota, foto, desde, hasta, kmMin, kmMax });
                const r = filtrarLecturas(grande, x);
                const esperado = grande.filter((l) => pasaTodo(l, x, r.estadoAplicado));
                if (r.filas.length !== esperado.length || !r.filas.every((l) => pasaTodo(l, x, r.estadoAplicado))) malos++;
                if (r.filas.length > 0) noTriviales++;
                // El conteo de cada opción = lo que sale al elegirla, con los demás filtros iguales.
                for (const e of ESTADOS_LECTURA) {
                  if (r.porEstado[e.codigo] !== filtrarLecturas(grande, { ...x, estado: e.codigo }).filas.length) conteosMalos++;
                }
                if (r.porEstado.pendientes !== filtrarLecturas(grande, { ...x, estado: "pendientes" }).filas.length) conteosMalos++;
                if (r.porEstado.todos !== filtrarLecturas(grande, { ...x, estado: "todos" }).filas.length) conteosMalos++;
                for (const t of TIPOS_REVISION) {
                  if (r.porProblema[t.codigo] !== filtrarLecturas(grande, { ...x, problema: t.codigo }).filas.length) conteosMalos++;
                }
                if (r.porFoto.con !== filtrarLecturas(grande, { ...x, foto: "con" }).filas.length) conteosMalos++;
                if (r.porFoto.sin !== filtrarLecturas(grande, { ...x, foto: "sin" }).filas.length) conteosMalos++;
                if (r.porFlota.tercero !== filtrarLecturas(grande, { ...x, flota: "tercero" }).filas.length) conteosMalos++;
                if (r.porFlota.propia !== filtrarLecturas(grande, { ...x, flota: "propia" }).filas.length) conteosMalos++;
                // Las placas de la lista suman lo que pasa sin el filtro de placa (salvo las sin unidad).
                const sinPlaca = filtrarLecturas(grande, { ...x, placa: "" }).filas.filter((l) => l.placa).length;
                if (r.porPlaca.reduce((s, p) => s + p.n, 0) !== sinPlaca) conteosMalos++;
              }
  chk(`lo que sale = exactamente lo que cumple todos los filtros (${combinaciones} combinaciones)`, malos === 0, `${malos} mal`);
  chk("cada conteo coincide con lo que sale al elegir esa opción", conteosMalos === 0, `${conteosMalos} mal`);
  chk("corolario: el barrido no es trivial (hay combinaciones con filas)", noTriviales > combinaciones / 10, `${noTriviales}/${combinaciones}`);
}

console.log("\n9 · «Placa sin confirmar»: un eje aparte, en cualquier estado");
{
  // La lectura de Cerna del 16/09 quedó ACEPTADA en la CWZ-371: la auditoría la marca dudosa.
  const conAudit = tabla.map((l) => ({ ...l, placaDudosa: l.id === "3" || l.id === "7" ? true : l.id === "12" ? undefined : false }));
  const solo = (x: FiltroLecturas) => filtrarLecturas(conAudit, x).filas.map((l) => l.id).sort((a, b) => Number(a) - Number(b)).join(",");
  chk("sin el filtro no cambia nada", solo(f({ estado: "todos" })) === filtrarLecturas(tabla, f({ estado: "todos" })).filas.map((l) => l.id).sort((a, b) => Number(a) - Number(b)).join(","));
  chk("con el filtro: las dos dudosas, aceptada y pendiente", solo(f({ estado: "todos", identidad: "sin_confirmar" })) === "3,7");
  chk("una lectura aún sin auditar no cuenta como dudosa", !solo(f({ estado: "todos", identidad: "sin_confirmar" })).split(",").includes("12"));
  chk("el conteo se hace con los otros filtros y sin el suyo",
    filtrarLecturas(conAudit, f({ estado: "todos", identidad: "sin_confirmar", placa: "cw" })).placaSinConfirmar === 2 &&
    filtrarLecturas(conAudit, f({ estado: "todos", placa: "cwz" })).placaSinConfirmar === 1 &&
    filtrarLecturas(conAudit, f({ estado: "pendientes", identidad: "sin_confirmar" })).placaSinConfirmar === 1);
  chk("el conteo = lo que sale al elegirlo", filtrarLecturas(conAudit, f({ estado: "todos" })).placaSinConfirmar === filtrarLecturas(conAudit, f({ estado: "todos", identidad: "sin_confirmar" })).filas.length);
  chk("elegirlo cuenta como filtro puesto", hayFiltroLecturas(f({ identidad: "sin_confirmar" })));
}

console.log(fallos ? `\n${fallos} prueba(s) FALLARON` : "\nTodo en verde");
process.exit(fallos ? 1 : 0);
