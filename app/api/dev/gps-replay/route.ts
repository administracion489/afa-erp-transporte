// app/api/dev/gps-replay/route.ts
// Reproductor OFFLINE de GPS (banco de pruebas del modal de seguimiento), servido como HTML
// directo desde un API route. NO pasa por el layout de React (sin auth de cliente, sin
// hidratación, sin posibilidad de redirect): un GET devuelve una página autocontenida.
//
// Toma los puntos REALES ya guardados de un servicio y los pasa por la MISMA lógica pura del
// modal (lib/huella.ts): limpieza de jitter + velocidad por ventana. Dibuja el trazo en SVG
// (sin Mapbox) y el perfil de velocidad, con un control de tiempo para rebobinar el viaje.
//
// Uso:  /api/dev/gps-replay?reserva=1140   ·   ?vehiculo=12   ·   ?tercero=5
// Solo LEE ubicaciones_gps (datos ya expuestos por /api/cliente/gps).

import { NextRequest } from "next/server";
import { createClient } from "@supabase/supabase-js";
import { distM, limpiarHuella, filasAPuntos, velocidadPorVentana, paginarFilas, type FixVel } from "@/lib/huella";

const admin = () =>
  createClient(process.env.NEXT_PUBLIC_SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!, {
    auth: { autoRefreshToken: false, persistSession: false },
  });

const HCOLS = "lat,lng,velocidad,created_at,timestamp,reserva_id,vehiculo_id,vehiculo_tercero_id,precision_m,fix_ts";

type Row = { lat: number; lng: number; ts: number; acc: number; dev: number };

const tMs = (g: any) => {
  const a = g?.created_at ? new Date(g.created_at).getTime() : 0;
  const b = g?.timestamp ? new Date(g.timestamp).getTime() : 0;
  return Math.max(a || 0, b || 0);
};

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const reservaId = sp.get("reserva");
  const vehiculoId = sp.get("vehiculo");
  const terceroId = sp.get("tercero");

  let arr: any[] = [];
  let err: string | null = null;
  try {
    const sb = admin();
    // PAGINADO (paginarFilas): PostgREST recorta al max-rows del servidor (1000) aunque se
    // pida .limit(5000) → el replay perdía todo lo posterior al punto 1000 en viajes largos.
    if (reservaId) {
      arr = await paginarFilas(() =>
        sb.from("ubicaciones_gps").select(HCOLS)
          .eq("reserva_id", Number(reservaId))
          .order("created_at", { ascending: true }).order("id", { ascending: true }));
    } else if (vehiculoId || terceroId) {
      const desde = new Date(Date.now() - 12 * 60 * 60 * 1000).toISOString();
      arr = await paginarFilas(() => {
        const q = sb.from("ubicaciones_gps").select(HCOLS)
          .gte("created_at", desde)
          .order("created_at", { ascending: true }).order("id", { ascending: true });
        return terceroId ? q.eq("vehiculo_tercero_id", Number(terceroId)) : q.eq("vehiculo_id", Number(vehiculoId));
      });
      // Cortar al último tramo contiguo (la ventana de 12 h puede traer 2 servicios).
      if (arr.length > 1) {
        let ini = 0;
        for (let i = 1; i < arr.length; i++) if (tMs(arr[i]) - tMs(arr[i - 1]) > 30 * 60 * 1000) ini = i;
        arr = arr.slice(ini);
      }
    }
  } catch (e: any) {
    err = e?.message || "error";
  }

  const rows: Row[] = arr
    .map((d) => ({
      lat: Number(d.lat), lng: Number(d.lng),
      ts: new Date(d.created_at || d.timestamp || 0).getTime(),
      acc: d.precision_m != null ? Number(d.precision_m) : 30,
      dev: Number(d.velocidad) || 0,
    }))
    .filter((p) => Number.isFinite(p.lat) && Number.isFinite(p.lng) && Number.isFinite(p.ts))
    .sort((a, b) => a.ts - b.ts);

  return new Response(render(rows, { reservaId, vehiculoId, terceroId, err }), {
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

// ── Cálculo de perfiles (idéntico al modal) ────────────────────────────────────
function perfiles(rows: Row[]) {
  const HIST_MS = 45_000;
  const ventana: number[] = [];
  const cruda: number[] = [];
  const hist: FixVel[] = [];
  let cur = 0;
  let prev: Row | null = null;
  for (const p of rows) {
    const last = hist[hist.length - 1];
    if (!last || p.ts > last.ts + 500) {
      hist.push({ lat: p.lat, lng: p.lng, ts: p.ts, acc: p.acc });
      const corte = p.ts - HIST_MS;
      while (hist.length > 2 && hist[0].ts < corte) hist.shift();
    }
    const v = velocidadPorVentana(hist, p.dev);
    if (v != null) cur = v;
    ventana.push(cur);
    if (prev && p.ts > prev.ts) cruda.push(Math.round((distM(prev.lat, prev.lng, p.lat, p.lng) / ((p.ts - prev.ts) / 1000)) * 3.6));
    else cruda.push(0);
    prev = p;
  }
  return { ventana, cruda };
}

// ── Render del HTML autocontenido ──────────────────────────────────────────────
function render(rows: Row[], ctx: { reservaId: string | null; vehiculoId: string | null; terceroId: string | null; err: string | null }) {
  const filtro = ctx.reservaId ? `reserva=${ctx.reservaId}` : ctx.vehiculoId ? `vehiculo=${ctx.vehiculoId}` : ctx.terceroId ? `tercero=${ctx.terceroId}` : "(sin filtro)";

  if (rows.length === 0) {
    return shell(`<div style="padding:24px;color:#94a3b8">
      ${ctx.err ? `<p style="color:#f87171">⚠ ${esc(ctx.err)}</p>` : ""}
      <p>Sin puntos GPS para <b>${esc(filtro)}</b>.</p>
      <p style="font-size:13px">Prueba con <code>?reserva=ID</code>, <code>?vehiculo=ID</code> o <code>?tercero=ID</code>.</p>
    </div>`);
  }

  const W = 720, H = 520, PAD = 28;
  // Proyección equirectangular a coords SVG (norte arriba).
  const lats = rows.map((r) => r.lat), lngs = rows.map((r) => r.lng);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats), minLng = Math.min(...lngs), maxLng = Math.max(...lngs);
  const kx = Math.cos(((minLat + maxLat) / 2) * Math.PI / 180);
  const spanX = Math.max((maxLng - minLng) * kx, 1e-6), spanY = Math.max(maxLat - minLat, 1e-6);
  const s = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const offX = (W - spanX * s) / 2, offY = (H - spanY * s) / 2;
  const proj = (lat: number, lng: number): [number, number] => [offX + (lng - minLng) * kx * s, offY + (maxLat - lat) * s];

  const { ventana, cruda } = perfiles(rows);
  const cleaned = limpiarHuella(filasAPuntos(rows.map((p) => ({ lat: p.lat, lng: p.lng, velocidad: p.dev, precision_m: p.acc }))));
  const cleanedPath = cleaned.map((p, i) => { const [x, y] = proj(p.lat, p.lng); return `${i === 0 ? "M" : "L"}${x.toFixed(1)},${y.toFixed(1)}`; }).join(" ");

  const max = (a: number[]) => a.reduce((x, y) => Math.max(x, y), 0);
  const maxVent = max(ventana), maxCruda = max(cruda), absurdos = ventana.filter((v) => v > 130).length;

  // Datos pre-proyectados para el script (raw points + perfiles).
  const pts = rows.map((p, i) => { const [x, y] = proj(p.lat, p.lng); return { x: +x.toFixed(1), y: +y.toFixed(1), v: ventana[i], n: cruda[i], d: p.dev, a: Math.round(p.acc), t: p.ts }; });
  const data = JSON.stringify({ W, H, pts, cleanedPath, maxVent, maxCruda, absurdos }).replace(/</g, "\\u003c");

  return shell(`
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px;align-items:center">
      <span style="font-size:13px;color:#94a3b8">Filtro: <b style="color:#e2e8f0">${esc(filtro)}</b> · ${rows.length} puntos · limpio ${cleaned.length}</span>
      <span style="margin-left:auto;font-size:12px;color:#64748b">cambia con <code>?reserva=ID</code> en la URL</span>
    </div>
    <div style="display:flex;gap:10px;flex-wrap:wrap;margin-bottom:14px">
      ${card("Vel. máx (ventana)", maxVent + " km/h", "#16a34a")}
      ${card("Vel. máx (naive p2p)", maxCruda + " km/h", maxCruda > 130 ? "#f87171" : "#94a3b8")}
      ${card("Absurdos >130 (ventana)", String(absurdos), absurdos === 0 ? "#16a34a" : "#f87171", absurdos === 0 ? "✓ ninguno" : "✗ revisar")}
    </div>
    <div style="display:grid;grid-template-columns:minmax(0,1.4fr) minmax(0,1fr);gap:16px">
      <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:12px">
        <div style="font-size:11px;color:#64748b;margin-bottom:6px">
          <span style="color:#475569">●</span> crudo &nbsp; <span style="color:#38bdf8">▬</span> limpio (huella) &nbsp; <span style="color:#f59e0b">◆</span> posición
        </div>
        <svg id="map" viewBox="0 0 ${W} ${H}" style="width:100%;height:auto;background:#0b1220;border-radius:8px"></svg>
      </div>
      <div style="display:flex;flex-direction:column;gap:12px">
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:16px;text-align:center">
          <div style="font-size:11px;color:#64748b;text-transform:uppercase;letter-spacing:1px">Velocidad en este punto</div>
          <div id="vel" style="font-size:52px;font-weight:900;line-height:1.1;color:#16a34a">0</div>
          <div id="velsub" style="font-size:12px;color:#64748b">km/h</div>
        </div>
        <div style="background:#0f172a;border:1px solid #1e293b;border-radius:12px;padding:12px">
          <div style="font-size:11px;color:#64748b;margin-bottom:6px">
            <span style="color:#16a34a">▬</span> ventana (modal) &nbsp; <span style="color:#f87171">▬</span> naive p2p (antiguo)
          </div>
          <svg id="spark" viewBox="0 0 100 100" preserveAspectRatio="none" style="width:100%;height:130px;background:#0b1220;border-radius:8px"></svg>
          <div style="font-size:10px;color:#64748b;text-align:right">escala 0–${Math.max(maxVent, maxCruda, 1)} km/h</div>
        </div>
      </div>
    </div>
    <div style="display:flex;gap:12px;align-items:center;margin-top:16px">
      <button id="play" style="padding:8px 16px;border-radius:8px;border:none;background:#16a34a;color:#fff;font-weight:700;cursor:pointer;min-width:90px">▶ Play</button>
      <input id="slider" type="range" min="0" max="${rows.length - 1}" value="${rows.length - 1}" style="flex:1">
      <span id="kpos" style="font-size:12px;color:#94a3b8;min-width:120px;text-align:right"></span>
    </div>
    <script>
    (function(){
      var D = JSON.parse(${JSON.stringify(data)});
      var pts = D.pts, n = pts.length, esc = Math.max(D.maxVent, D.maxCruda, 1);
      var map = document.getElementById('map'), spark = document.getElementById('spark');
      var velEl = document.getElementById('vel'), velSub = document.getElementById('velsub');
      var slider = document.getElementById('slider'), kpos = document.getElementById('kpos'), play = document.getElementById('play');
      var SVGNS = 'http://www.w3.org/2000/svg';
      function col(v){ return v===0?'#dc2626':v<15?'#f59e0b':v<35?'#eab308':'#16a34a'; }
      function fmt(t){ var d=new Date(t); return d.toLocaleTimeString('es-PE',{hour:'2-digit',minute:'2-digit',second:'2-digit'}); }
      // sparkline estático (perfil completo)
      function path(get){ var d=''; for(var i=0;i<n;i++){ var x=(i/(n-1))*100, y=100-(Math.min(get(i),esc)/esc)*100; d+=(i?'L':'M')+x.toFixed(2)+','+y.toFixed(2);} return d; }
      function line(x1,y1,x2,y2,c,w,dash){ var l=document.createElementNS(SVGNS,'line'); l.setAttribute('x1',x1);l.setAttribute('y1',y1);l.setAttribute('x2',x2);l.setAttribute('y2',y2);l.setAttribute('stroke',c);l.setAttribute('stroke-width',w);l.setAttribute('vector-effect','non-scaling-stroke'); if(dash)l.setAttribute('stroke-dasharray',dash); return l; }
      function p(d,c,w){ var e=document.createElementNS(SVGNS,'path'); e.setAttribute('d',d);e.setAttribute('fill','none');e.setAttribute('stroke',c);e.setAttribute('stroke-width',w);e.setAttribute('vector-effect','non-scaling-stroke'); return e; }
      var y130 = 100-(Math.min(130,esc)/esc)*100;
      function drawSpark(k){
        spark.innerHTML='';
        spark.appendChild(line(0,y130,100,y130,'#7f1d1d',0.5,'2 2'));
        spark.appendChild(p(path(function(i){return pts[i].n;}),'#f87171',0.7));
        spark.appendChild(p(path(function(i){return pts[i].v;}),'#16a34a',1));
        spark.appendChild(line((k/(n-1))*100,0,(k/(n-1))*100,100,'#f59e0b',0.6));
      }
      function drawMap(k){
        map.innerHTML='';
        // huella limpia (completa, referencia)
        if(D.cleanedPath){ map.appendChild(p(D.cleanedPath,'#38bdf8',2.5)); }
        // puntos crudos hasta k
        for(var i=0;i<=k;i++){ var c=document.createElementNS(SVGNS,'circle'); c.setAttribute('cx',pts[i].x);c.setAttribute('cy',pts[i].y);c.setAttribute('r',1.6);c.setAttribute('fill','#475569'); map.appendChild(c); }
        // posición actual
        var cur=pts[k];
        var halo=document.createElementNS(SVGNS,'circle'); halo.setAttribute('cx',cur.x);halo.setAttribute('cy',cur.y);halo.setAttribute('r',9);halo.setAttribute('fill',col(cur.v));halo.setAttribute('opacity',0.25); map.appendChild(halo);
        var dot=document.createElementNS(SVGNS,'circle'); dot.setAttribute('cx',cur.x);dot.setAttribute('cy',cur.y);dot.setAttribute('r',4.5);dot.setAttribute('fill','#f59e0b');dot.setAttribute('stroke','#fff');dot.setAttribute('stroke-width',1.5); map.appendChild(dot);
      }
      function frame(k){
        var cur=pts[k];
        velEl.textContent=cur.v; velEl.style.color=col(cur.v);
        velSub.textContent='km/h · ±'+cur.a+'m · equipo='+cur.d;
        kpos.textContent=fmt(cur.t)+' ('+(k+1)+'/'+n+')';
        drawMap(k); drawSpark(k);
      }
      slider.addEventListener('input',function(){ stop(); frame(+slider.value); });
      var timer=null;
      function stop(){ if(timer){clearInterval(timer);timer=null;play.textContent='▶ Play';play.style.background='#16a34a';} }
      play.addEventListener('click',function(){
        if(timer){stop();return;}
        play.textContent='⏸ Pausa';play.style.background='#b45309';
        timer=setInterval(function(){ var k=+slider.value; if(k>=n-1){stop();return;} slider.value=k+1; frame(k+1); },100);
      });
      frame(n-1);
    })();
    </script>
  `);
}

function card(label: string, value: string, color: string, sub?: string) {
  return `<div style="background:#0f172a;border:1px solid #1e293b;border-radius:10px;padding:10px 14px;min-width:140px">
    <div style="font-size:10px;color:#64748b;text-transform:uppercase;letter-spacing:0.5px">${label}</div>
    <div style="font-size:20px;font-weight:900;color:${color}">${value}</div>
    ${sub ? `<div style="font-size:10px;color:#64748b">${sub}</div>` : ""}
  </div>`;
}

function esc(s: string) {
  return String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c] || c));
}

function shell(inner: string) {
  return `<!doctype html><html lang="es"><head><meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>GPS Replay · banco de pruebas</title></head>
  <body style="margin:0;background:#0b1220;color:#e2e8f0;font-family:system-ui;padding:20px">
    <div style="max-width:1180px;margin:0 auto">
      <h1 style="font-size:20px;font-weight:900;margin:0 0 4px">🛰️ Reproductor GPS offline</h1>
      <p style="color:#94a3b8;font-size:13px;margin:0 0 16px">Datos reales guardados → misma lógica del modal, sin bus en vivo. Rebobina con la barra.</p>
      ${inner}
    </div>
  </body></html>`;
}
