// Matriz de lib/clientes-buscador.ts. Uso: npx tsx scripts/prueba-clientes-buscador.mts
import {
  buscarClientes, coincideCliente, documentoCliente, recientesDe, rotuloCliente,
  rotuloClienteDocumento, tramosResaltados, usoPorCliente, type ClienteBuscable,
} from "../lib/clientes-buscador";
import { terminosBusqueda } from "../lib/busqueda-texto";

let ok = 0, fallo = 0;
const check = (cond: boolean, nombre: string, detalle?: unknown) => {
  if (cond) { ok++; console.log(`✓ ${nombre}`); }
  else { fallo++; console.log(`✗ ${nombre}${detalle !== undefined ? " → " + JSON.stringify(detalle) : ""}`); }
};
const ids = (r: ClienteBuscable[]) => r.map(c => c.id);
const igual = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/* ── Datos ── */
const CL: ClienteBuscable[] = [
  { id: 1, nombre: "Rosa Quispe", empresa: "COMPAÑÍA HARD S.A.C.", tipo: "b2b", ruc: "20123456789", telefono: "987 654 321", estado: "activo", email: "compras@hard.pe" },
  { id: 2, nombre: "Pedro Ruiz", empresa: "SNACKS AMERICA LATINA S.R.L.", tipo: "b2b", ruc: "20555666777", estado: "activo", ciudad: "Lima" },
  { id: 3, nombre: "María Núñez", tipo: "b2c", dni: "45678912", telefono: "+51 912 345 678", estado: "activo" },
  { id: 4, nombre: "Compañía Bloqueada", empresa: "COMPAÑÍA HARD BLOQUEADA", tipo: "b2b", ruc: "20999888777", estado: "bloqueado" },
  { id: 5, nombre: "Carlos Inactivo", empresa: "HARDWARE PERU", tipo: "b2b", ruc: "20111222333", estado: "inactivo" },
  { id: 6, nombre: "Ana Torres", tipo: "b2c", dni: "20123456", estado: "activo", nombre_comercial: "Turismo Ana" },
  { id: 7, nombre: "Beta Logística", empresa: "", tipo: "b2b", ruc: "20444555666", estado: "activo" },
  { id: 8, nombre: "Zeta Corp", empresa: null, tipo: "b2b", estado: null },
  { id: 9, nombre: "Ángel Bloqueado", tipo: "b2c", dni: "12345678", estado: "bloqueado" },
  { id: 10, nombre: "Compañero SAC", empresa: "COMPAÑERO SAC", tipo: "b2b", ruc: "20777888999", estado: "activo" },
];

/* ── 1. Tildes, ñ y signos ── */
{
  const r = buscarClientes(CL, "compania hard");
  check(ids(r.resultados).includes(1), "«compania hard» encuentra «COMPAÑÍA HARD S.A.C.»", ids(r.resultados));
  check(!ids(r.resultados).includes(4), "el bloqueado que coincide no se ofrece");
  check(r.bloqueadosCoinciden === 1, "y se cuenta en bloqueadosCoinciden", r.bloqueadosCoinciden);
  check(ids(buscarClientes(CL, "COMPAÑIA HARD SAC").resultados).includes(1), "«COMPAÑIA HARD SAC» (sin tilde en í) encuentra al cliente 1");
  check(ids(buscarClientes(CL, "nunez").resultados).includes(3), "«nunez» encuentra «María Núñez»");
  check(ids(buscarClientes(CL, "turismo ana").resultados).includes(6), "busca por nombre comercial");
  check(ids(buscarClientes(CL, "compras@hard").resultados).includes(1), "busca por correo");
  check(ids(buscarClientes(CL, "lima").resultados).includes(2), "busca por ciudad (como /clientes)");
}

/* ── 2. Documento exacto primero ── */
{
  // «20123456» es el DNI de Ana (exacto) y un trozo del RUC de Compañía Hard.
  const r = buscarClientes(CL, "20123456");
  check(r.resultados[0]?.id === 6, "DNI exacto va primero aunque otro RUC lo contenga", ids(r.resultados));
  check(ids(r.resultados).includes(1), "el RUC que contiene la consulta también aparece");
  const r2 = buscarClientes(CL, "20555666777");
  check(r2.resultados[0]?.id === 2, "RUC exacto primero", ids(r2.resultados));
  const r3 = buscarClientes(CL, "RUC 20555666777");
  check(r3.resultados[0]?.id === 2, "«RUC 2055…» también es documento exacto", ids(r3.resultados));
}

/* ── 3. Teléfono ── */
for (const q of ["+51987654321", "987654321", "987 654 321", "51 987 654 321"]) {
  check(ids(buscarClientes(CL, q).resultados).includes(1), `teléfono «987 654 321» se encuentra con «${q}»`);
}
for (const q of ["912345678", "+51912345678"]) {
  check(ids(buscarClientes(CL, q).resultados).includes(3), `teléfono «+51 912 345 678» se encuentra con «${q}»`);
}

/* ── 4. Bloqueados e inactivos ── */
{
  for (const q of ["", "bloqueado", "compania", "12345678", "angel"]) {
    const r = buscarClientes(CL, q);
    check(!r.resultados.some(c => c.estado === "bloqueado"), `«${q}»: ningún bloqueado en resultados`);
  }
  check(buscarClientes(CL, "").bloqueadosCoinciden === 2, "consulta vacía cuenta los 2 bloqueados");
  check(buscarClientes(CL, "angel").bloqueadosCoinciden === 1, "«angel» cuenta al bloqueado Ángel");
  check(ids(buscarClientes(CL, "hardware").resultados).includes(5), "un inactivo sí aparece");
  check(ids(buscarClientes(CL, "zeta").resultados).includes(8), "estado null aparece");
}

/* ── 5. Partición disjunta y exhaustiva ── */
for (const q of ["", "compania", "hard", "20", "a", "sac", "xyz", "+51", "bloqueado", "ana torres", "987"]) {
  const r = buscarClientes(CL, q);
  const t = terminosBusqueda(q);
  const noCoinciden = CL.filter(c => !coincideCliente(c, t));
  const rid = new Set(ids(r.resultados));
  const disj = r.resultados.every(c => coincideCliente(c, t) && c.estado !== "bloqueado")
    && noCoinciden.every(c => !rid.has(c.id));
  const bloqCo = CL.filter(c => c.estado === "bloqueado" && coincideCliente(c, t)).length;
  check(
    disj && rid.size === r.resultados.length && bloqCo === r.bloqueadosCoinciden
      && r.resultados.length + r.bloqueadosCoinciden + noCoinciden.length === CL.length
      && r.total === r.resultados.length,
    `partición «${q}»: resultados ∪ bloqueados ∪ no coinciden = todos (${r.resultados.length}+${r.bloqueadosCoinciden}+${noCoinciden.length})`,
  );
}

/* ── 6. Límite ── */
{
  const r = buscarClientes(CL, "", { limite: 3 });
  check(r.resultados.length === 3, "límite 3 respetado", r.resultados.length);
  check(r.total === CL.filter(c => c.estado !== "bloqueado").length, "total = elegibles antes del límite", r.total);
  const sin = buscarClientes(CL, "");
  check(igual(ids(r.resultados), ids(sin.resultados).slice(0, 3)), "el límite corta el mismo orden");
  check(buscarClientes(CL, "", { limite: 0 }).resultados.length === 0, "límite 0 no devuelve nada");
  check(buscarClientes(CL, "a", { limite: 100 }).resultados.length === buscarClientes(CL, "a").total, "límite mayor que el total devuelve todo");
}

/* ── 7. Orden con consulta vacía: uso y luego alfabético ── */
{
  const cot = [
    { cliente_id: 3, created_at: "2026-09-01T10:00:00Z" },
    { cliente_id: 3, created_at: "2026-09-05T10:00:00Z" },
    { cliente_id: 3, created_at: "2026-09-03T10:00:00Z" },
    { cliente_id: 7, created_at: "2026-10-01T10:00:00Z" },
    { cliente_id: 7, created_at: "2026-10-02T10:00:00Z" },
    { cliente_id: 2, created_at: "2026-10-10T10:00:00Z" },
    { cliente_id: null, created_at: "2026-10-11T10:00:00Z" },
    { cliente_id: 4, created_at: "2026-10-12T10:00:00Z" },
    { cliente_id: 4, created_at: "2026-10-12T11:00:00Z" },
    { cliente_id: 4, created_at: "2026-10-12T12:00:00Z" },
    { cliente_id: 4, created_at: "2026-10-12T13:00:00Z" },
  ];
  const uso = usoPorCliente(cot);
  check(uso.get(3)?.cotizaciones === 3 && uso.get(3)?.ultima === "2026-09-05T10:00:00Z", "usoPorCliente cuenta y toma la última", uso.get(3));
  check(!uso.has(null as unknown as number), "usoPorCliente ignora cliente_id null");
  const r = buscarClientes(CL, "", { uso });
  const esperado = [3, 7, 2]; // 3 usos, 2 usos, 1 uso (el 4 está bloqueado)
  check(igual(ids(r.resultados).slice(0, 3), esperado), "consulta vacía: más cotizaciones primero", ids(r.resultados));
  const resto = r.resultados.slice(3).map(c => rotuloCliente(c));
  const ordenado = [...resto].sort((a, b) => a.localeCompare(b, "es"));
  check(igual(resto, ordenado), "y los sin uso en orden alfabético (es)", resto);

  // Con consulta: prefijo del rótulo gana sobre uso.
  const usoHard = usoPorCliente([...Array(5)].map(() => ({ cliente_id: 5, created_at: "2026-10-01T00:00:00Z" })));
  const rh = buscarClientes(CL, "hard", { uso: usoHard });
  check(rh.resultados[0]?.id === 5, "«hard»: HARDWARE PERU empieza por la consulta y tiene más uso → primero", ids(rh.resultados));
  const rc = buscarClientes(CL, "compan", { uso: usoPorCliente([...Array(9)].map(() => ({ cliente_id: 2, created_at: "2026-10-01T00:00:00Z" }))) });
  check(igual(ids(rc.resultados), [10, 1]), "«compan»: los dos que empiezan así (sin uso), en alfabético: COMPAÑERO antes que COMPAÑÍA", ids(rc.resultados));
  const alf = ["COMPAÑÍA HARD S.A.C.", "COMPAÑERO SAC"].sort((a, b) => a.localeCompare(b, "es"));
  check(igual(rc.resultados.map(rotuloCliente), alf), "orden alfabético entre empates usa localeCompare es", rc.resultados.map(rotuloCliente));

  // recientesDe
  const rec = recientesDe(cot, 10);
  check(igual(rec, [4, 2, 7, 3]), "recientesDe: distintos y del más reciente al más antiguo", rec);
  check(new Set(rec).size === rec.length, "recientesDe sin repetidos");
  check(igual(recientesDe(cot, 2), [4, 2]), "recientesDe respeta n");
  check(recientesDe(cot, 0).length === 0 && recientesDe([], 5).length === 0, "recientesDe vacío con n=0 o sin cotizaciones");
}

/* ── 8. Resaltado ── */
{
  const sub = (t: string, q: string) => tramosResaltados(t, q).map(r => t.slice(r.desde, r.hasta));
  check(igual(sub("Compañía Hard", "compan"), ["Compañ"]), "«compan» resalta «Compañ» de «Compañía»", sub("Compañía Hard", "compan"));
  check(igual(sub("COMPAÑÍA HARD S.A.C.", "compania hard"), ["COMPAÑÍA", "HARD"]), "dos términos, dos tramos sobre las palabras correctas", sub("COMPAÑÍA HARD S.A.C.", "compania hard"));
  check(igual(sub("COMPAÑÍA HARD S.A.C.", "sac"), ["S.A.C"]), "«sac» resalta «S.A.C»", sub("COMPAÑÍA HARD S.A.C.", "sac"));
  check(igual(sub("María Núñez", "nunez"), ["Núñez"]), "«nunez» resalta «Núñez»", sub("María Núñez", "nunez"));
  const nfd = "Compañía";
  check(igual(sub(nfd, "compan"), ["Compañ"]), "texto en NFD: la virgulilla no se separa de su n", sub(nfd, "compan"));
  check(tramosResaltados("Compañía", "").length === 0, "consulta vacía no resalta");
  check(tramosResaltados("Compañía", "xyz").length === 0, "sin coincidencia no resalta");
  // Robustez: dentro de límites, ordenados, sin solaparse.
  const textos = ["COMPAÑÍA HARD S.A.C.", "María Núñez · DNI 45678912", "🚌 Ángel ñandú", "", "a.b.c a b c", "Compañía hard"];
  const consultas = ["a", "an", "nan", "compania", "abc", "45678", "hard a", "ñ", "c"];
  let bien = true;
  for (const t of textos) for (const q of consultas) {
    const tr = tramosResaltados(t, q);
    for (let k = 0; k < tr.length; k++) {
      const r = tr[k];
      if (!(r.desde >= 0 && r.hasta <= t.length && r.desde < r.hasta)) bien = false;
      if (k && tr[k - 1].hasta >= r.desde) bien = false;
    }
  }
  check(bien, "tramos siempre dentro de límites, ordenados y disjuntos (barrido)");
  check(igual(sub("Hard Hard", "hard"), ["Hard", "Hard"]), "resalta todas las apariciones");
}

/* ── 9. Rótulo: igual a la regla vieja de page.tsx ── */
{
  // Copiadas LITERAL de app/cotizaciones/page.tsx.
  const viejaLista = (c: ClienteBuscable) => c.tipo === "b2b" ? (c.empresa || c.nombre) : c.nombre;          // nomCl(id) ~:1678 y <option> ~:1760
  const viejaPdf = (cliente: ClienteBuscable | null | undefined) => cliente?.tipo === "b2b" ? (cliente.empresa || cliente.nombre) : cliente?.nombre || "—"; // PDF ~:489/506
  let iguales = true, igualesPdf = true, n = 0;
  for (const tipo of ["b2b", "b2c", null, undefined, "otro"]) {
    for (const empresa of ["", "ACME S.A.C.", null, undefined]) {
      for (const nombre of ["Juan", ""]) {
        const c = { id: ++n, nombre, empresa, tipo } as ClienteBuscable;
        if (rotuloCliente(c) !== viejaLista(c)) iguales = false;
        if (rotuloClienteDocumento(c) !== viejaPdf(c)) igualesPdf = false;
      }
    }
  }
  check(iguales, `rotuloCliente = regla vieja de lista/selector sobre ${n} combinaciones`);
  check(igualesPdf, `rotuloClienteDocumento = regla vieja del PDF sobre ${n} combinaciones`);
  check(rotuloClienteDocumento(null) === "—" && rotuloClienteDocumento(undefined) === "—", "rotuloClienteDocumento sin cliente = «—»");
}

/* ── 10. Documento ── */
check(documentoCliente(CL[0]) === "RUC 20123456789", "documentoCliente b2b → RUC");
check(documentoCliente(CL[2]) === "DNI 45678912", "documentoCliente b2c → DNI");
check(documentoCliente(CL[7]) === null, "documentoCliente sin documento → null");
check(documentoCliente({ id: 99, nombre: "x", ruc: "20100", dni: "1234" }) === "RUC 20100", "con RUC y DNI manda el RUC (como el PDF)");

console.log(`\n${ok} ok · ${fallo} fallo(s)`);
if (fallo) process.exit(1);
console.log("Todo verde");
