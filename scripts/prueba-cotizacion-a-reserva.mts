// npx tsx scripts/prueba-cotizacion-a-reserva.mts
// El plan de «→ Res.» (lib/cotizacion-a-reserva.ts) contra el algoritmo VIEJO de
// app/cotizaciones/page.tsx (`convertirAReserva`, copiado literal abajo): sobre la misma base falsa,
// el plan + un ejecutor que solo hace lo que el plan dice tienen que producir las MISMAS escrituras
// (tabla, fila, en el mismo orden), los mismos avisos, las mismas preguntas y el mismo refresco.
// Barre: aprobada o no, 0 / 1 / N vehículos (propios, tercerizados, sin vehículo), retorno (con
// lista, por sus extremos, sin hora, fecha anterior, solo ida), completar el retorno de una
// conversión de antes, USD (con y sin tipo de cambio, aceptando o no), y los fallos de la base
// (lectura, columna que falta, inserción N, paraderos, enlace).
import {
  alertaCreadaUna, alertaCreadasMulti, alertaFalloMulti, alertaRetornoCompletado, enlaceIda, filaRetorno,
  mensajeErrorComprobar, mensajeErrorRetornoAtras, paradasDeIda, paradasDeRetorno, planConversion, resultadoRetorno,
  type CotParaReserva, type IdaDelRetorno, type ItemCotReserva, type PlanConversion,
} from "../lib/cotizacion-a-reserva";
import { planRetorno } from "../lib/cotizacion-retorno";
import { insertarServicioNuevo } from "../lib/reservas-autoseleccion";
import { sugerirNombreRuta } from "../lib/nombre-ruta";
import { faltaColumna } from "../lib/columna-faltante";
import { aMonedaCot, normalizarMoneda, revisarTipoCambio, totalesEnMoneda, type Moneda } from "../lib/cotizacion-moneda";

let ok = 0, mal = 0;
const fallas: string[] = [];
const t = (n: string, c: boolean) => { if (c) ok++; else { mal++; if (fallas.length < 30) fallas.push(n); } };

// ── La base falsa ────────────────────────────────────────────────────────────
type Cfg = {
  existentes: Record<string, unknown>[]; atras: boolean;
  falloLectura?: boolean; falloAtras?: boolean; faltaDireccion?: boolean; faltaAutoseleccion?: boolean;
  falloInsertN?: number; falloParadas?: boolean; falloUpdate?: boolean;
};
type Registro = { op: string; tabla: string; datos: unknown; ok: boolean };
function base(cfg: Cfg) {
  const log: Registro[] = [];
  let id = 5000, nInsert = 0;
  const falta = (cols: string[], row: Record<string, unknown>) => {
    for (const k of Object.keys(row)) if (cols.includes(k)) return { code: "PGRST204", message: `Could not find the '${k}' column of 'reservas' in the schema cache` };
    return null;
  };
  const faltantes = [cfg.faltaDireccion ? "direccion_servicio" : "", cfg.faltaAutoseleccion ? "permite_autoseleccion" : ""].filter(Boolean);
  const from = (tabla: string) => {
    const st: Record<string, unknown> = {};
    const run = () => {
      if (st.insert !== undefined) {
        if (tabla === "paradas") {
          const e = cfg.falloParadas ? { message: "paradas caídas" } : null;
          log.push({ op: "insert", tabla, datos: st.insert, ok: !e });
          return { data: null, error: e };
        }
        const row = st.insert as Record<string, unknown>;
        let e: { code?: string; message: string } | null = falta(faltantes, row);
        if (!e) { nInsert++; if (cfg.falloInsertN === nInsert) e = { message: `inserción ${nInsert} falló` }; }
        log.push({ op: "insert", tabla, datos: row, ok: !e });
        return e ? { data: null, error: e } : { data: { ...row, id: ++id }, error: null };
      }
      if (st.update !== undefined) {
        const patch = st.update as Record<string, unknown>;
        let e: { code?: string; message: string } | null = falta(faltantes, patch);
        if (!e && cfg.falloUpdate) e = { message: "enlace falló" };
        log.push({ op: "update", tabla, datos: { patch, eq: st.eq }, ok: !e });
        return { data: null, error: e };
      }
      // select
      if (st.in) {
        log.push({ op: "select_in", tabla, datos: st.in, ok: !cfg.falloAtras });
        return cfg.falloAtras ? { data: null, error: { message: "lectura del retorno caída" } } : { data: cfg.atras ? [{ id: 1 }] : [], error: null };
      }
      log.push({ op: "select", tabla, datos: { cols: st.select, eq: st.eq, limit: st.limit }, ok: !cfg.falloLectura });
      return cfg.falloLectura ? { data: null, error: { message: "lectura caída" } } : { data: cfg.existentes, error: null };
    };
    const api: Record<string, unknown> = {
      select(c?: string) { st.select = c ?? "*"; return api; },
      eq(c: string, v: unknown) { st.eq = [c, v]; return api; },
      in(c: string, v: unknown) { st.in = [c, v]; return api; },
      limit(n: number) { st.limit = n; return api; },
      single() { return api; },
      insert(f: unknown) { st.insert = f; return api; },
      update(p: unknown) { st.update = p; return api; },
      then(res: (x: unknown) => unknown, rej: (e: unknown) => unknown) { return Promise.resolve(run()).then(res, rej); },
    };
    return api;
  };
  return { supabase: { from } as any, log }; // eslint-disable-line @typescript-eslint/no-explicit-any
}

type Deps = { supabase: any; alert: (s?: unknown) => void; confirm: (s: string) => boolean; refrescar: () => void; hoyLima: () => string }; // eslint-disable-line @typescript-eslint/no-explicit-any

// ── El algoritmo VIEJO, copiado literal de app/cotizaciones/page.tsx ──────────
type Cotizacion = CotParaReserva; type ItemCot = ItemCotReserva;
const fmtS=(n:number)=>`S/ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`;
const fmtM=(n:number,m:Moneda)=>m==="USD"?`US$ ${n.toLocaleString("es-PE",{minimumFractionDigits:2,maximumFractionDigits:2})}`:fmtS(n);
const fmtCot=(pen:number,m:Moneda,tc:unknown)=>{const v=aMonedaCot(pen,m,tc);return v==null?fmtS(pen):fmtM(v,m);};
function crearViejo(d: Deps) {
  const { supabase, alert, confirm, refrescar, hoyLima } = d;
  // ↓↓↓ copiado LITERAL de app/cotizaciones/page.tsx (convertirAReserva) ↓↓↓
  const convertirAReserva=async(cot:Cotizacion)=>{
    if(cot.estado!=="aprobado"){alert("Solo cotizaciones aprobadas");return;}
    // `limit(1)` y no `maybeSingle()`: con más de una reserva ya creada (una por vehículo),
    // `maybeSingle` da error, `existe` queda en null y se volvían a crear todas. Y una lectura que
    // falla no es «todavía no tiene reservas».
    const{data:existentes,error:eExiste}=await supabase.from("reservas").select("id,fecha_servicio,vehiculo_id,vehiculo_tercero_id,reserva_vinculada_id,estado").eq("cotizacion_id",cot.id).limit(20);
    if(eExiste){alert(`No se pudo comprobar si la cotización ya tiene reservas, así que no se creó ninguna: ${eExiste.message}`);return;}
    const ps=cot.paradas_json||[];const pI=ps.find(p=>p.tipo==="inicio");
    const fechaIda=cot.fecha_servicio||hoyLima();
    const planRet=planRetorno(cot,fechaIda);
    // El retorno es su PROPIA reserva (lib/cotizacion-retorno.ts): nace en S/ 0.00 —el importe va en
    // la ida— y enlazado a ella por los dos lados. Devuelve null si salió, o el motivo si no.
    const crearRetorno=async(ida:{id:number;vehiculo_id:number|null;vehiculo_tercero_id:number|null}):Promise<string|null>=>{
      if(planRet.codigo!=="ok")return null;
      const paradasSemilla=planRet.paradas.map((p,i,a)=>({id:`ret${i}`,tipo:i===0?"inicio":i===a.length-1?"destino":"intermedia",nombre:p.nombre,direccion:p.direccion||"",lat:p.lat!=null?String(p.lat):"",lng:p.lng!=null?String(p.lng):"",hora:p.hora||""}));
      const fila:Record<string,unknown>={cliente_id:cot.cliente_id,cotizacion_id:cot.id,origen:planRet.origen,destino:planRet.destino,fecha_servicio:planRet.fecha,hora_servicio:planRet.hora,estado:"pendiente",tipo:"propia",tipo_servicio_detalle:cot.tipo_servicio||null,paradas_json:paradasSemilla,costo_proveedor:0,precio_cliente:0,vehiculo_id:ida.vehiculo_id,vehiculo_tercero_id:ida.vehiculo_tercero_id,reserva_vinculada_id:ida.id,direccion_servicio:"retorno",ruta_nombre:sugerirNombreRuta({asunto:cot.asunto,paradas:paradasSemilla,hora:planRet.hora,sentido:"retorno"})||null};
      let ins=await insertarServicioNuevo((f)=>supabase.from("reservas").insert(f).select().single(),fila);
      if(ins.error&&faltaColumna(ins.error,"direccion_servicio")){delete fila.direccion_servicio;ins=await insertarServicioNuevo((f)=>supabase.from("reservas").insert(f).select().single(),fila);}
      if(ins.error||!ins.data)return ins.error?.message||"sin respuesta";
      const retId=ins.data.id as number;
      let up=await supabase.from("reservas").update({reserva_vinculada_id:retId,direccion_servicio:"ida"}).eq("id",ida.id);
      if(up.error&&faltaColumna(up.error,"direccion_servicio"))up=await supabase.from("reservas").update({reserva_vinculada_id:retId}).eq("id",ida.id);
      const{error:eP}=await supabase.from("paradas").insert(planRet.paradas.map(p=>({reserva_id:retId,orden:p.orden,nombre:p.nombre,direccion:p.direccion,lat:p.lat,lng:p.lng,hora_estimada:p.hora,estado:"pendiente"})));
      const avisos=[up.error?`no se pudo enlazar a la ida (${up.error.message}): enlázalos desde Liquidaciones o Programación`:"",eP?`sus paradas no se crearon (${eP.message})`:""].filter(Boolean);
      return avisos.length?`retorno creado, pero ${avisos.join(" y ")}`:null;
    };
    const textoRetorno=(errores:(string|null)[],n:number)=>{
      if(planRet.codigo==="no_aplica")return"";
      if(planRet.codigo!=="ok")return `\n⚠️ No se creó el RETORNO: ${planRet.motivo} Créalo desde Programación.`;
      const e=errores.filter(Boolean);
      return e.length?`\n⚠️ Retorno: ${e.join(" · ")}`:`\n↩ Y ${n>1?`${n} retornos`:"su retorno"} del ${planRet.fecha.split("-").reverse().join("/")} a las ${planRet.hora} (${planRet.origen} → ${planRet.destino}), en S/ 0.00: el importe va en la ida.`;
    };
    if(existentes?.length){
      // Convertida antes de que «→ Res.» creara el retorno: se completa SOLO si ninguna ida tiene ya
      // su hermano (por ninguno de los dos lados del enlace) y ninguna está cancelada.
      const idas=existentes as {id:number;fecha_servicio:string;vehiculo_id:number|null;vehiculo_tercero_id:number|null;reserva_vinculada_id:number|null;estado:string}[];
      if(planRet.codigo==="no_aplica"||idas.some(r=>r.reserva_vinculada_id!=null||r.estado==="cancelada")){alert("Ya fue convertida en reserva");return;}
      const{data:atras,error:eAt}=await supabase.from("reservas").select("id").in("reserva_vinculada_id",idas.map(r=>r.id)).limit(1);
      if(eAt){alert(`No se pudo comprobar si ya tiene retorno, así que no se creó nada: ${eAt.message}`);return;}
      if(atras?.length){alert("Ya fue convertida en reserva");return;}
      if(planRet.codigo!=="ok"){alert(`Ya fue convertida en reserva, pero le falta el RETORNO y no se puede crear: ${planRet.motivo} Créalo desde Programación.`);return;}
      if(!confirm(`La cotización #${cot.numero_cotizacion||cot.id} ya tiene ${idas.length} reserva(s) de IDA, pero no su RETORNO.\n¿Crear ${idas.length>1?`${idas.length} retornos`:"el retorno"}: ${planRet.fecha.split("-").reverse().join("/")} ${planRet.hora} · ${planRet.origen} → ${planRet.destino}, en S/ 0.00 (el importe sigue en la ida)?`))return;
      const errs:(string|null)[]=[];
      for(const ida of idas)errs.push(await crearRetorno(ida));
      alert(`✅ Retorno completado${textoRetorno(errs,idas.length)}`);
      refrescar();return;
    }
    const its=cot.items_json||[];
    const vehKey=(it:ItemCot)=>it.vehiculo_flota_id?`f_${it.vehiculo_flota_id}`:it.vehiculo_tercero_id?`t_${it.vehiculo_tercero_id}`:"sin";
    const grupos=its.reduce((m,it)=>{const k=vehKey(it);if(!m[k])m[k]=[];m[k].push(it);return m;},{} as Record<string,ItemCot[]>);
    const keys=Object.keys(grupos);
    const useMulti=keys.length>1||(keys.length===1&&keys[0]!=="sin"&&(keys[0].startsWith("f_")||keys[0].startsWith("t_")));
    const basePayload={cliente_id:cot.cliente_id,cotizacion_id:cot.id,origen:pI?.nombre||cot.origen,destino:cot.destino,fecha_servicio:fechaIda,hora_servicio:pI?.hora||cot.hora_ida||"06:00",estado:"pendiente",tipo:"propia",tipo_servicio_detalle:cot.tipo_servicio||null,paradas_json:cot.paradas_json||null,costo_proveedor:0,ruta_nombre:sugerirNombreRuta({asunto:cot.asunto,paradas:cot.paradas_json,hora:pI?.hora||cot.hora_ida,sentido:"ida"})||null};
    const insertParadas=async(reservaId:number):Promise<string|null>=>{if(ps.length<1)return null;const{error}=await supabase.from("paradas").insert([...ps.filter(p=>p.tipo==="inicio"),...ps.filter(p=>p.tipo==="intermedia"),...ps.filter(p=>p.tipo==="destino")].map((p,i)=>({reserva_id:reservaId,orden:i+1,nombre:p.nombre,direccion:p.direccion||null,lat:p.lat?Number(p.lat):null,lng:p.lng?Number(p.lng):null,hora_estimada:p.hora||null,estado:"pendiente"})));return error?error.message:null;};
    const avisoParadas=(e:string|null)=>e?`\n⚠️ Pero sus ${ps.length} paradas no se pudieron crear (${e}): agrégalas desde Programación.`:"";
    // La reserva lleva el precio EN SOLES (la fila autoritativa). En una cotización en dólares se
    // dice a qué tipo de cambio: la reserva y la liquidación ya no hablan de dólares.
    const monCot=normalizarMoneda(cot.moneda);
    if(monCot==="USD"&&!confirm(`La cotización #${cot.numero_cotizacion||cot.id} está en dólares (${fmtCot(Number(cot.precio_cliente||0),"USD",cot.tipo_cambio)}).\nLa reserva se crea con el precio EN SOLES: ${fmtS(Number(cot.precio_cliente||0))} al tipo de cambio de la cotización (S/ ${revisarTipoCambio(cot.tipo_cambio).tc??"—"} por US$).\n¿Crear la reserva?`))return;
    const notaTc=monCot==="USD"?`\nℹ️ La cotización está en dólares: la reserva queda con el precio EN SOLES al tipo de cambio de la cotización (S/ ${revisarTipoCambio(cot.tipo_cambio).tc??"—"} por US$).`:"";
    if(!useMulti){
      // Nace con «Permitir autoselección» (lib/reservas-autoseleccion.ts).
      const{data:r,error}=await insertarServicioNuevo((fila)=>supabase.from("reservas").insert(fila).select().single(),{...basePayload,precio_cliente:cot.precio_cliente,vehiculo_id:cot.vehiculo_flota_id||null,vehiculo_tercero_id:cot.vehiculo_tercero_id||null});
      if(error){alert(error.message);return;}
      const eParadas=r?await insertParadas(r.id):null;
      const eRet=r?await crearRetorno(r):null;
      alert(`✅ Reserva creada${ps.length>0&&!eParadas?` con ${ps.length} paradas`:""}${avisoParadas(eParadas)}${textoRetorno([eRet],1)}${notaTc}`);
    } else {
      let count=0;let eParadas:string|null=null;const errsRet:(string|null)[]=[];
      for(const k of keys){
        const gItems=grupos[k];
        const gTotal=totalesEnMoneda(gItems,"PEN",null,cot.incluye_igv!==false)!.total;
        const vehFlotaId=k.startsWith("f_")?Number(k.slice(2)):(k==="sin"?cot.vehiculo_flota_id||null:null);
        const vehTercId=k.startsWith("t_")?Number(k.slice(2)):(k==="sin"?cot.vehiculo_tercero_id||null:null);
        const{data:r,error}=await insertarServicioNuevo((fila)=>supabase.from("reservas").insert(fila).select().single(),{...basePayload,precio_cliente:gTotal,vehiculo_id:vehFlotaId,vehiculo_tercero_id:vehTercId});
        if(error){
          // Las ya creadas se quedan, y «→ Res.» ya no vuelve a convertir esta cotización: se dice cuántas faltan.
          alert(count>0?`⚠️ Se crearon ${count} de ${keys.length} reservas y la siguiente falló: ${error.message}\nLas que faltan créalas desde Programación (esta cotización ya figura como convertida).${avisoParadas(eParadas)}`:error.message);
          refrescar();return;
        }
        if(r&&count===0)eParadas=await insertParadas(r.id);
        if(r)errsRet.push(await crearRetorno(r));
        count++;
      }
      alert(`✅ ${count} reserva${count>1?"s creadas (una por vehículo)":"creada"}${avisoParadas(eParadas)}${textoRetorno(errsRet,count)}${notaTc}`);
    }
    refrescar();
  };
  // ↑↑↑ fin de la copia literal ↑↑↑
  return convertirAReserva;
}

// ── El ejecutor del plan (solo hace lo que el plan dice) ─────────────────────
async function convertirNuevo(cot: CotParaReserva, d: Deps) {
  const sb = d.supabase;
  const hoy = d.hoyLima();
  let plan: PlanConversion = planConversion(cot, { existentes: null, hoy });
  if (plan.codigo === "no_aprobada") { d.alert(plan.mensaje); return; }
  const { data: existentes, error: eEx } = await sb.from("reservas").select("id,fecha_servicio,vehiculo_id,vehiculo_tercero_id,reserva_vinculada_id,estado").eq("cotizacion_id", cot.id).limit(20);
  if (eEx) { d.alert(mensajeErrorComprobar(eEx.message)); return; }
  plan = planConversion(cot, { existentes: existentes ?? [], hoy });
  if (plan.codigo === "comprobar_retorno") {
    const { data: atras, error: eAt } = await sb.from("reservas").select("id").in("reserva_vinculada_id", plan.ids).limit(1);
    if (eAt) { d.alert(mensajeErrorRetornoAtras(eAt.message)); return; }
    plan = planConversion(cot, { existentes: existentes ?? [], hoy, retornoAtras: !!atras?.length });
  }
  const insertar = (f: Record<string, unknown>) => insertarServicioNuevo((x) => sb.from("reservas").insert(x).select().single(), f);
  const crearRetorno = async (ida: IdaDelRetorno, retorno: ReturnType<typeof planRetorno>): Promise<string | null> => {
    if (retorno.codigo !== "ok") return null;
    const fila = filaRetorno(cot, retorno, ida);
    let ins = await insertar(fila);
    if (ins.error && faltaColumna(ins.error, "direccion_servicio")) { const { direccion_servicio: _d, ...sin } = fila; void _d; ins = await insertar(sin); }
    if (ins.error || !ins.data) return resultadoRetorno({ insertError: ins.error?.message || "sin respuesta", enlaceError: null, paradasError: null });
    const retId = ins.data.id as number;
    let up = await sb.from("reservas").update(enlaceIda(retId)).eq("id", ida.id);
    if (up.error && faltaColumna(up.error, "direccion_servicio")) up = await sb.from("reservas").update(enlaceIda(retId, false)).eq("id", ida.id);
    const { error: eP } = await sb.from("paradas").insert(paradasDeRetorno(retorno, retId));
    return resultadoRetorno({ insertError: null, enlaceError: up.error?.message ?? null, paradasError: eP?.message ?? null });
  };
  switch (plan.codigo) {
    case "ya_convertida": case "retorno_imposible": d.alert(plan.mensaje); return;
    case "completar_retorno": {
      if (!d.confirm(plan.confirmar)) return;
      const errs: (string | null)[] = [];
      for (const ida of plan.idas) errs.push(await crearRetorno(ida, plan.retorno));
      d.alert(alertaRetornoCompletado(plan.retorno, errs, plan.idas.length));
      d.refrescar(); return;
    }
    case "crear": {
      if (plan.confirmar && !d.confirm(plan.confirmar)) return;
      const insertParadas = async (id: number): Promise<string | null> => {
        if (plan.codigo !== "crear" || plan.paradas.length < 1) return null;
        const { error } = await sb.from("paradas").insert(paradasDeIda(plan.paradas, id));
        return error ? error.message : null;
      };
      if (!plan.multi) {
        const { data: r, error } = await insertar(plan.idas[0].fila);
        if (error) { d.alert(error.message); return; }
        const eParadas = r ? await insertParadas(r.id) : null;
        const eRet = r ? await crearRetorno(r, plan.retorno) : null;
        d.alert(alertaCreadaUna({ nParadas: plan.paradas.length, eParadas, eRet, retorno: plan.retorno, notaTc: plan.notaTc }));
      } else {
        let count = 0; let eParadas: string | null = null; const errsRet: (string | null)[] = [];
        for (const ida of plan.idas) {
          const { data: r, error } = await insertar(ida.fila);
          if (error) { d.alert(alertaFalloMulti({ count, total: plan.idas.length, error: `${error.message}`, nParadas: plan.paradas.length, eParadas })); d.refrescar(); return; }
          if (r && ida.conParadas) eParadas = await insertParadas(r.id);
          if (r) errsRet.push(await crearRetorno(r, plan.retorno));
          count++;
        }
        d.alert(alertaCreadasMulti({ count, nParadas: plan.paradas.length, eParadas, errsRet, retorno: plan.retorno, notaTc: plan.notaTc }));
      }
      d.refrescar(); return;
    }
    default: return;
  }
}

// ── Los casos ────────────────────────────────────────────────────────────────
const canon = (v: unknown): string => JSON.stringify(v, (_k, x) => (x && typeof x === "object" && !Array.isArray(x) ? Object.fromEntries(Object.entries(x).sort(([a], [b]) => a.localeCompare(b))) : x));

async function correr(f: (d: Deps) => Promise<void>, cfg: Cfg, respuesta: boolean) {
  const b = base(cfg);
  const alertas: string[] = [], preguntas: string[] = [];
  let refrescos = 0;
  await f({ supabase: b.supabase, alert: (s) => alertas.push(String(s)), confirm: (s) => { preguntas.push(s); return respuesta; }, refrescar: () => { refrescos++; }, hoyLima: () => "2026-10-22" });
  return { log: b.log, alertas, preguntas, refrescos };
}

const ITEMS: Record<string, unknown[]> = {
  ninguno: [],
  sin: [{ descripcion: "Bus", dias: 1, cantidad: 1, precio_unit: 500, descuento_pct: 0 }],
  propio: [{ descripcion: "Bus", dias: 1, cantidad: 2, precio_unit: 300, descuento_pct: 10, vehiculo_flota_id: 5 }],
  dos_propio: [{ descripcion: "A", dias: 1, cantidad: 1, precio_unit: 300, descuento_pct: 0, vehiculo_flota_id: 5 }, { descripcion: "B", dias: 2, cantidad: 1, precio_unit: 120.5, descuento_pct: 0, vehiculo_flota_id: 5 }],
  propio_tercero: [{ descripcion: "A", dias: 1, cantidad: 1, precio_unit: 300, descuento_pct: 0, vehiculo_flota_id: 5 }, { descripcion: "B", dias: 1, cantidad: 1, precio_unit: 410, descuento_pct: 5, vehiculo_tercero_id: 9 }],
  tres: [{ descripcion: "A", dias: 1, cantidad: 1, precio_unit: 100, descuento_pct: 0 }, { descripcion: "B", dias: 1, cantidad: 1, precio_unit: 200, descuento_pct: 0, vehiculo_flota_id: 5 }, { descripcion: "C", dias: 1, cantidad: 3, precio_unit: 50, descuento_pct: 0, vehiculo_tercero_id: 9 }],
};
const PARADAS: Record<string, unknown> = {
  ninguna: null,
  tres: [{ id: "p1", tipo: "destino", nombre: "Hotel", direccion: "", lat: "", lng: "", hora: "" }, { id: "p0", tipo: "inicio", nombre: "Aeropuerto", direccion: "Av. Faucett", lat: "-12.02", lng: "-77.11", hora: "06:15" }, { id: "pm", tipo: "intermedia", nombre: "Parada", direccion: "", lat: "-12.1", lng: "", hora: "" }],
  rara: [{ id: "x", tipo: "otro", nombre: "Raro", direccion: "", lat: "", lng: "", hora: "" }],
};
const RETORNOS: Record<string, Partial<CotParaReserva>> = {
  solo_ida: { tipo_servicio: "solo_ida" },
  extremos: { tipo_servicio: "ida_retorno", fecha_retorno: "2026-11-03", hora_retorno: "18:00", punto_retorno: "Miraflores", ruta_coords_json: { destino: { lat: -13.8, lng: -76.2 }, retorno: { lat: -12.12, lng: -77.03 } } },
  lista: { tipo_servicio: "ida_retorno_paradas", fecha_retorno: null, paradas_retorno_json: [{ tipo: "inicio", nombre: "Hotel", hora: "17:00", lat: "-13.8", lng: "-76.2" }, { tipo: "destino", nombre: "Aeropuerto" }] },
  sin_hora: { tipo_servicio: "ida_retorno", fecha_retorno: "2026-11-03", hora_retorno: null },
  fecha_anterior: { tipo_servicio: "ida_retorno", fecha_retorno: "2026-10-01", hora_retorno: "18:00" },
};
const EXISTENTES: Record<string, Record<string, unknown>[]> = {
  ninguna: [],
  una: [{ id: 101, fecha_servicio: "2026-11-02", vehiculo_id: 5, vehiculo_tercero_id: null, reserva_vinculada_id: null, estado: "pendiente" }],
  dos: [{ id: 101, fecha_servicio: "2026-11-02", vehiculo_id: 5, vehiculo_tercero_id: null, reserva_vinculada_id: null, estado: "pendiente" }, { id: 102, fecha_servicio: "2026-11-02", vehiculo_id: null, vehiculo_tercero_id: 9, reserva_vinculada_id: null, estado: "programada" }],
  enlazada: [{ id: 101, fecha_servicio: "2026-11-02", vehiculo_id: 5, vehiculo_tercero_id: null, reserva_vinculada_id: 77, estado: "pendiente" }],
  cancelada: [{ id: 101, fecha_servicio: "2026-11-02", vehiculo_id: 5, vehiculo_tercero_id: null, reserva_vinculada_id: null, estado: "cancelada" }],
};
const FALLOS: Record<string, Partial<Cfg>> = {
  ninguno: {}, lectura: { falloLectura: true }, atras: { falloAtras: true }, direccion: { faltaDireccion: true }, autoseleccion: { faltaAutoseleccion: true },
  ambas: { faltaDireccion: true, faltaAutoseleccion: true }, insert1: { falloInsertN: 1 }, insert2: { falloInsertN: 2 }, insert3: { falloInsertN: 3 },
  paradas: { falloParadas: true }, enlace: { falloUpdate: true },
};

const cotDe = (o: { estado: string; moneda: string; tc: unknown; items: unknown[]; vf: number | null; vt: number | null; ret: Partial<CotParaReserva>; paradas: unknown; fecha: string | null; hora: string | null; igv: boolean; asunto: string | null }): CotParaReserva => ({
  id: 736, estado: o.estado, cliente_id: 12, numero_cotizacion: o.asunto ? "COT-736" : null,
  origen: "Aeropuerto Jorge Chávez", destino: "Hotel Paracas", fecha_servicio: o.fecha, hora_ida: o.hora,
  tipo_servicio: "solo_ida", asunto: o.asunto, paradas_json: o.paradas as CotParaReserva["paradas_json"], items_json: o.items as CotParaReserva["items_json"],
  incluye_igv: o.igv, precio_cliente: 590, vehiculo_flota_id: o.vf, vehiculo_tercero_id: o.vt, moneda: o.moneda, tipo_cambio: o.tc as number | null,
  modo_servicio: "eventual", punto_retorno: null, fecha_retorno: null, hora_retorno: null, paradas_retorno_json: null, ruta_coords_json: null,
  ...o.ret,
});

let semilla = 12345;
const azar = () => { semilla = (semilla * 1103515245 + 12345) % 2147483648; return semilla / 2147483648; };
const elegir = <T,>(xs: T[]) => xs[Math.floor(azar() * xs.length)];

let casos = 0, iguales = 0;
const vistos = new Set<string>();
const probar = async (nombre: string, cot: CotParaReserva, cfg: Cfg, respuesta: boolean) => {
  const v = await correr((d) => crearViejo(d)(cot), cfg, respuesta);
  const n = await correr((d) => convertirNuevo(cot, d), cfg, respuesta);
  casos++;
  if (canon(v) === canon(n)) iguales++;
  else if (fallas.length < 30) fallas.push(`${nombre}\n  viejo: ${canon(v).slice(0, 600)}\n  nuevo: ${canon(n).slice(0, 600)}`);
  vistos.add((n.alertas[n.alertas.length - 1] ?? "(sin aviso)").slice(0, 14));
};

// Barrido exhaustivo de lo que decide la estructura, y aleatorio de lo demás.
for (const estado of ["aprobado", "pendiente"]) for (const itemsK of Object.keys(ITEMS)) for (const retK of Object.keys(RETORNOS)) for (const exK of Object.keys(EXISTENTES)) for (const atras of [false, true]) for (const falloK of Object.keys(FALLOS)) {
  if (estado === "pendiente" && (exK !== "ninguna" || falloK !== "ninguno" || atras)) continue;
  const moneda = elegir(["PEN", "PEN", "USD"]);
  const cot = cotDe({
    estado, moneda, tc: moneda === "USD" ? elegir([3.75, null]) : null, items: ITEMS[itemsK], vf: elegir([null, 3]), vt: elegir([null, 4]),
    ret: RETORNOS[retK], paradas: PARADAS[elegir(Object.keys(PARADAS))], fecha: elegir(["2026-11-02", null]), hora: elegir(["07:30", null]),
    igv: azar() < 0.7, asunto: elegir(["Cot. RUTA B - personal", null]),
  });
  await probar(`${estado}/${itemsK}/${retK}/${exK}/atras${atras}/${falloK}`, cot, { existentes: EXISTENTES[exK], atras, ...FALLOS[falloK] }, azar() < 0.8);
}
// Más casos al azar (todas las combinaciones de paradas, moneda, respuesta).
for (let i = 0; i < 3000; i++) {
  const moneda = elegir(["PEN", "USD"]);
  const cot = cotDe({
    estado: elegir(["aprobado", "aprobado", "aprobado", "enviado"]), moneda, tc: moneda === "USD" ? elegir([3.75, "3,8", null, 99]) : null,
    items: ITEMS[elegir(Object.keys(ITEMS))], vf: elegir([null, 3]), vt: elegir([null, 4]), ret: RETORNOS[elegir(Object.keys(RETORNOS))],
    paradas: PARADAS[elegir(Object.keys(PARADAS))], fecha: elegir(["2026-11-02", null]), hora: elegir(["07:30", null, "23:59"]), igv: azar() < 0.5, asunto: elegir(["RUTA C", null]),
  });
  await probar(`azar ${i}`, cot, { existentes: EXISTENTES[elegir(Object.keys(EXISTENTES))], atras: azar() < 0.3, ...FALLOS[elegir(Object.keys(FALLOS))] }, azar() < 0.7);
}
t(`el plan ≡ el algoritmo viejo (${iguales}/${casos})`, iguales === casos && casos > 3000);
if (process.env.DETALLE) console.log([...vistos]);
t("corolario: salen los avisos de crear, completar, ya convertida y fallos", ["✅ Reserva crea", "✅ Retorno com", "Ya fue convert", "Solo cotizacio", "⚠️ Se crearon", "No se pudo co"].every((k) => [...vistos].some((v) => v.startsWith(k))) && [...vistos].some((k) => k.startsWith("✅ 2 reservas") || k.startsWith("✅ 3 reservas")));

// Casos con nombre sobre el plan mismo.
{
  const c = cotDe({ estado: "aprobado", moneda: "PEN", tc: null, items: ITEMS.propio_tercero, vf: null, vt: null, ret: RETORNOS.extremos, paradas: PARADAS.tres, fecha: "2026-11-02", hora: "07:30", igv: true, asunto: "Cot. RUTA B" });
  const p = planConversion(c, { existentes: [], hoy: "2026-10-22" });
  t("dos vehículos → dos idas, paraderos solo en la primera", p.codigo === "crear" && p.multi && p.idas.length === 2 && p.idas[0].conParadas && !p.idas[1].conParadas);
  t("cada ida con el importe de su grupo (con IGV) y su vehículo", p.codigo === "crear" && p.idas[0].fila.precio_cliente === 354 && p.idas[0].fila.vehiculo_id === 5 && p.idas[1].fila.vehiculo_tercero_id === 9 && Math.abs(Number(p.idas[1].fila.precio_cliente) - 459.61) < 0.001);
  t("nace con autoselección y la hora del primer paradero", p.codigo === "crear" && p.idas.every((i) => i.fila.permite_autoseleccion === true && i.fila.hora_servicio === "06:15"));
  t("el retorno sale del plan, en S/ 0.00 y enlazado", p.codigo === "crear" && p.retorno.codigo === "ok" && (() => { const f = filaRetorno(c, p.retorno as never, { id: 1, vehiculo_id: 5, vehiculo_tercero_id: null }); return f.precio_cliente === 0 && f.reserva_vinculada_id === 1 && f.direccion_servicio === "retorno" && f.vehiculo_id === 5; })());
  t("pendiente → no_aprobada antes de leer", planConversion({ ...c, estado: "pendiente" }, { existentes: null, hoy: "2026-10-22" }).codigo === "no_aprobada");
  t("aprobada sin leer → leer_existentes", planConversion(c, { existentes: null, hoy: "2026-10-22" }).codigo === "leer_existentes");
  t("con idas sin enlace → comprobar_retorno con sus ids", (() => { const r = planConversion(c, { existentes: EXISTENTES.dos as never, hoy: "2026-10-22" }); return r.codigo === "comprobar_retorno" && r.ids.join() === "101,102"; })());
  t("USD con TC → pregunta y nota", (() => { const r = planConversion({ ...c, moneda: "USD", tipo_cambio: 3.75 }, { existentes: [], hoy: "2026-10-22" }); return r.codigo === "crear" && !!r.confirmar?.includes("US$ 157.33") && r.notaTc.includes("S/ 3.75 por US$"); })());
}

if (fallas.length) for (const f of fallas) console.log("✗", f);
console.log(`\n${ok} OK · ${mal} mal`);
if (mal > 0) process.exit(1);
console.log("Todo OK");
