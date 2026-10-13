// npx tsx scripts/prueba-plantillas-usadas.mts
// ¿Qué plantillas usa el ERP y cuáles faltan en Meta? + qué tarjetas le escriben al directorio.
import { PLANTILLAS_FIJAS, estadoEnMeta, plantillasQueUsa, revisarPlantillas, type TarjetaUso } from "../lib/plantillas-usadas";
import { LEE_DIRECTORIO, VIA_DE_ALERTA, leeElDirectorio } from "../lib/alertas-modo-tiempo";

let fallos = 0;
const chk = (nombre: string, ok: boolean, extra = "") => {
  if (!ok) fallos++;
  console.log(`${ok ? "  ok  " : "FALLA "} ${nombre}${extra && !ok ? ` — ${extra}` : ""}`);
};

const t = (x: Partial<TarjetaUso> & { clave: string }): TarjetaUso => ({
  nombre: x.clave, activo: true, plantilla: null, destinatarios: [], escribeAlDirectorio: true, ...x,
});

console.log("\n— Lo que el ERP manda —");
{
  const u = plantillasQueUsa([
    t({ clave: "no_inicio", nombre: "No inició a tiempo", plantilla: "conductor_no_inicio", destinatarios: [1] }),
    t({ clave: "debio_iniciar", nombre: "Ya debió iniciar", plantilla: "conductor_no_inicio", activo: false }),
    t({ clave: "alerta_no_inicio_previa", nombre: "Alerta previa", plantilla: null, destinatarios: [] }),
    t({ clave: "llamar_conductor", nombre: "Llamar", plantilla_directorio: "coordinador_llamar_conductor", destinatarios: [1] }),
    t({ clave: "proximo_inicio", nombre: "Próximo", plantilla: "conductor_proximo_inicio_es", destinatarios: [1], escribeAlDirectorio: false }),
  ]);
  const de = (n: string) => u.find((x) => x.nombre === n);
  chk("la plantilla del conductor, una vez aunque la usen dos tarjetas", de("conductor_no_inicio")?.usos.length === 2);
  chk("activa si ALGUNA tarjeta que la usa está encendida", de("conductor_no_inicio")?.activa === true);
  chk("la del directorio cae a coordinador_alerta, como el tick", !!de("coordinador_alerta")?.usos.some((x) => x.includes("No inició")));
  chk("sin nadie marcado, la tarjeta no usa la del directorio", !de("coordinador_alerta")?.usos.some((x) => x.includes("Alerta previa")));
  chk("una tarjeta que no le escribe al directorio no la cuenta aunque tenga marcados",
    !de("coordinador_alerta")?.usos.some((x) => x.includes("Próximo")));
  chk("«llamar al conductor» usa la suya y, con varios a la vez, la genérica",
    !!de("coordinador_llamar_conductor") && !!de("coordinador_alerta")?.usos.some((x) => x.includes("varios")));
  chk("las fijas del código siempre están, y activas", PLANTILLAS_FIJAS.every((f) => de(f.nombre)?.activa === true));
}

console.log("\n— Su estado en Meta —");
{
  const meta = [
    { name: "a", status: "APPROVED" }, { name: "b", status: "PENDING" }, { name: "c", status: "REJECTED" },
    { name: "d", status: "PAUSED" }, { name: "e", status: "REJECTED" }, { name: "e", status: "APPROVED" },
  ];
  chk("aprobada", estadoEnMeta("a", meta) === "aprobada");
  chk("en revisión", estadoEnMeta("b", meta) === "en_revision");
  chk("rechazada y pausada no salen", estadoEnMeta("c", meta) === "rechazada" && estadoEnMeta("d", meta) === "rechazada");
  chk("con un idioma aprobado basta (plantilla-idioma reintenta en ese)", estadoEnMeta("e", meta) === "aprobada");
  chk("no existe", estadoEnMeta("z", meta) === "no_existe");
  const r = revisarPlantillas([
    { nombre: "a", usos: ["x"], activa: true }, { nombre: "z", usos: ["x"], activa: false }, { nombre: "y", usos: ["x"], activa: true },
  ], meta);
  chk("primero lo que falta y está encendido", r[0].nombre === "y" && r[1].nombre === "z" && r[2].nombre === "a", r.map((x) => x.nombre).join(","));
}

console.log("\n— Quién le escribe al directorio —");
{
  const sinDeclarar = Object.keys(VIA_DE_ALERTA).filter((k) => leeElDirectorio(k) === null);
  chk("todo tipo que conoce el motor está declarado", sinDeclarar.length === 0, sinDeclarar.join(", "));
  chk("los de ciclo de vida no", ["asignacion", "cambio", "cancelacion", "desasignacion"].every((k) => LEE_DIRECTORIO[k] === false));
  chk("la escalera del conductor no; la del coordinador sí",
    ["proximo_inicio", "recuerda_iniciar", "inicia_ahora", "debio_iniciar"].every((k) => leeElDirectorio(k) === false)
    && ["alerta_no_inicio_previa", "no_inicio", "llamada_inicio", "llamar_conductor"].every((k) => leeElDirectorio(k) === true));
  chk("una clave desconocida conserva su selector (null)", leeElDirectorio("tipo_nuevo") === null);
}

console.log(fallos ? `\n${fallos} FALLO(S)` : "\nTODO OK");
process.exit(fallos ? 1 : 0);
