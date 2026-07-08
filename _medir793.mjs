import { readFileSync } from 'node:fs';
import { createClient } from '@supabase/supabase-js';

const env = Object.fromEntries(
  readFileSync('.env.local', 'utf8').split(/\r?\n/).filter(l => l.includes('='))
    .map(l => { const i = l.indexOf('='); return [l.slice(0, i).trim(), l.slice(i + 1).trim()]; })
);
const sb = createClient(env.NEXT_PUBLIC_SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY);

// ── helpers verbatim de lib/huella.ts ──
function distM(aLat, aLng, bLat, bLng) {
  const R = 6371000;
  const dLa = (bLat - aLat) * Math.PI / 180, dLo = (bLng - aLng) * Math.PI / 180;
  const la1 = aLat * Math.PI / 180, la2 = bLat * Math.PI / 180;
  const h = Math.sin(dLa / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLo / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}
function proyectarEnSegmento(lat, lng, A, B) {
  const mLat = 111320, mLng = 111320 * Math.cos(lat * Math.PI / 180);
  const ax = A.lng * mLng, ay = A.lat * mLat, bx = B.lng * mLng, by = B.lat * mLat;
  const px = lng * mLng, py = lat * mLat;
  const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
  let t = L2 > 0 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0;
  t = Math.max(0, Math.min(1, t));
  const qx = ax + t * dx, qy = ay + t * dy;
  return { dist: Math.hypot(px - qx, py - qy) };
}
const radioArco = (A, B, perp) => (perp > 0 ? (A * B) / (2 * perp) : Infinity);
const pct = (arr, p) => { const s = [...arr].sort((a, b) => a - b); return s[Math.floor((s.length - 1) * p)]; };

async function main() {
  // intenta por reserva_id; si vacío, por vehiculo_tercero_id (BVI124 = vt 1 según memoria)
  let { data } = await sb.from('ubicaciones_gps')
    .select('lat,lng,precision_m,velocidad,rumbo,created_at,timestamp')
    .eq('reserva_id', 793).order('timestamp', { ascending: true }).limit(6000);
  let fuente = 'reserva_id=793';
  if (!data || data.length === 0) {
    ({ data } = await sb.from('ubicaciones_gps')
      .select('lat,lng,precision_m,velocidad,rumbo,created_at,timestamp,reserva_id')
      .eq('vehiculo_tercero_id', 1).order('timestamp', { ascending: true }).limit(6000));
    fuente = 'vehiculo_tercero_id=1 (fallback)';
  }
  if (!data || data.length === 0) { console.log('SIN DATOS'); return; }

  const pts = data.map(d => ({
    lat: +d.lat, lng: +d.lng,
    acc: d.precision_m != null ? +d.precision_m : 25,
    vel: +d.velocidad || 0,
    rumbo: +d.rumbo || 0,
    ts: d.created_at ? new Date(d.created_at).getTime() : new Date(d.timestamp).getTime(),
  })).filter(p => Number.isFinite(p.lat) && Number.isFinite(p.lng));

  console.log(`\n=== #793 (${fuente}) — ${pts.length} fixes ===`);
  const accs = pts.map(p => p.acc);
  console.log(`precisión: p50=${pct(accs,.5)}  p90=${pct(accs,.9)}  máx=${Math.max(...accs)}  |  acc<=20 (chip): ${pts.filter(p=>p.acc<=20).length}  acc>300 (descarta trazo): ${pts.filter(p=>p.acc>300).length}`);
  console.log(`velocidad Doppler: ${pts.filter(p=>p.vel>0).length}/${pts.length} con vel>0  |  rumbo>0: ${pts.filter(p=>p.rumbo>0).length}`);
  const span = (pts[pts.length-1].ts - pts[0].ts)/60000;
  console.log(`duración: ${span.toFixed(0)} min`);

  // espaciado y velocidad implícita entre fixes consecutivos
  const gaps = [], vimp = [];
  for (let i = 1; i < pts.length; i++) {
    const d = distM(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
    const dt = Math.max(1, (pts[i].ts - pts[i-1].ts)/1000);
    gaps.push(d); vimp.push(d/dt*3.6);
  }
  console.log(`espaciado consecutivo: p50=${pct(gaps,.5).toFixed(0)}m  p90=${pct(gaps,.9).toFixed(0)}m  máx=${Math.max(...gaps).toFixed(0)}m`);
  console.log(`saltos >300m: ${gaps.filter(g=>g>300).length}  |  vel implícita >130km/h: ${vimp.filter(v=>v>130).length}`);

  // FASE 9 quitarExcursiones: perp>max(60,1.2acc) && latAccel>3 (radio exacto)
  let exc = 0, excPerp = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i].acc <= 20) continue;
    const perp = proyectarEnSegmento(pts[i].lat, pts[i].lng, pts[i-1], pts[i+1]).dist;
    const A = distM(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
    const B = distM(pts[i].lat, pts[i].lng, pts[i+1].lat, pts[i+1].lng);
    const dtA = Math.max(1, (pts[i].ts - pts[i-1].ts)/1000);
    const dtB = Math.max(1, (pts[i+1].ts - pts[i].ts)/1000);
    const v = Math.max(A/dtA, B/dtB);
    const latA = (v*v)/radioArco(A, B, perp);
    if (perp > Math.max(60, 1.2*pts[i].acc) && latA > 3.0) { exc++; excPerp.push(perp); }
  }
  console.log(`\nFASE 9 quitarExcursiones (1 pasada): ${exc} vértices borrados  |  perp de esos: ${excPerp.length?`p50=${pct(excPerp,.5).toFixed(0)}m máx=${Math.max(...excPerp).toFixed(0)}m`:'—'}`);

  // Residuo tras quitar excursiones: vértices con desvío lateral perp>60 pero latAccel<=3 (LENTOS → sobreviven = la "estrella")
  let resid = 0, residPerp = [];
  for (let i = 1; i < pts.length - 1; i++) {
    if (pts[i].acc <= 20) continue;
    const perp = proyectarEnSegmento(pts[i].lat, pts[i].lng, pts[i-1], pts[i+1]).dist;
    const A = distM(pts[i-1].lat, pts[i-1].lng, pts[i].lat, pts[i].lng);
    const B = distM(pts[i].lat, pts[i].lng, pts[i+1].lat, pts[i+1].lng);
    const dtA = Math.max(1, (pts[i].ts - pts[i-1].ts)/1000);
    const dtB = Math.max(1, (pts[i+1].ts - pts[i].ts)/1000);
    const v = Math.max(A/dtA, B/dtB);
    const latA = (v*v)/radioArco(A, B, perp);
    if (perp > Math.max(60, 1.2*pts[i].acc) && latA <= 3.0) { resid++; residPerp.push(perp); }
  }
  console.log(`RESIDUO (desvío lateral >60m pero LENTO → sobrevive FASE 9 = "estrella"): ${resid} vértices  |  perp: ${residPerp.length?`p50=${pct(residPerp,.5).toFixed(0)}m máx=${Math.max(...residPerp).toFixed(0)}m`:'—'}`);
}
main().catch(e => { console.error(e.message); process.exit(1); });
