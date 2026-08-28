"use client";
// ──────────────────────────────────────────────────────────────────────────────
// /conformidad-cambio/[token] — lo que ve el CLIENTE cuando AFA le cambia el servicio.
//
// Sin cuenta, sin contraseña, sin app. Recibe el enlace por WhatsApp o correo, ve en
// una pantalla qué cambió y cuánto cuesta la diferencia, y firma con su nombre y cargo.
//
// Ese papel es lo que vuelve COBRABLE el mayor precio. Sin él, el diferencial se
// discute al cierre del mes contra un cliente que ya no recuerda haber pedido el bus
// grande — y en la práctica se regala.
//
// Por eso la pantalla es deliberadamente simple y honesta: el antes, el después, la
// diferencia en grande, y dos botones. Nada de letra chica; si el cliente siente que
// se le está colando algo, no firma ninguno y llama por teléfono.
//
// El token viaja en la URL y es la única autorización. Todo lo resuelve
// /api/pactos/conformidad con service-role: esta pantalla no toca Supabase.
// ──────────────────────────────────────────────────────────────────────────────
import { useEffect, useState } from "react";
import { useParams } from "next/navigation";

type Cambio = {
  codigo: string; os: string | null; fecha_servicio: string | null;
  ruta: string | null; origen: string | null; destino: string | null;
  unidad_antes: string | null; unidad_despues: string | null;
  precio_antes: number; precio_despues: number; diferencia: number;
  motivo: string | null; motivo_nota: string | null;
  estado: "pendiente" | "conforme" | "observada" | "no_aplica";
  respondido_por: string | null; respondido_cargo: string | null;
  respondido_at: string | null; comentario: string | null;
  cliente: string | null; empresa: string;
};

const soles = (n: number) =>
  `S/ ${Number(n || 0).toLocaleString("es-PE", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

const fecha = (iso: string | null) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso ?? "");
  return m ? `${m[3]}/${m[2]}/${m[1]}` : (iso ?? "");
};

export default function ConformidadCambioPage() {
  const { token } = useParams<{ token: string }>();
  const [cambio, setCambio] = useState<Cambio | null>(null);
  const [error, setError] = useState("");
  const [cargando, setCargando] = useState(true);

  const [por, setPor] = useState("");
  const [cargo, setCargo] = useState("");
  const [comentario, setComentario] = useState("");
  const [observando, setObservando] = useState(false);
  const [enviando, setEnviando] = useState(false);

  async function cargar() {
    setCargando(true);
    try {
      const r = await fetch(`/api/pactos/conformidad?token=${encodeURIComponent(String(token))}`);
      const j = await r.json();
      if (!r.ok) { setError(j.error ?? "No se pudo cargar el cambio."); setCambio(null); }
      else { setCambio(j.cambio); setError(""); }
    } catch {
      setError("No hay conexión. Intenta de nuevo en un momento.");
    } finally { setCargando(false); }
  }

  useEffect(() => { cargar(); /* eslint-disable-next-line react-hooks/exhaustive-deps */ }, [token]);

  async function responder(decision: "conforme" | "observada") {
    if (!por.trim()) { setError("Escribe tu nombre para dejar constancia de quién responde."); return; }
    if (decision === "observada" && !comentario.trim()) {
      setError("Cuéntanos qué observas para que podamos corregirlo."); return;
    }
    setEnviando(true); setError("");
    try {
      const r = await fetch("/api/pactos/conformidad", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ token, decision, por, cargo, comentario }),
      });
      const j = await r.json();
      if (!r.ok) setError(j.error ?? "No se pudo registrar tu respuesta.");
      else await cargar();
    } catch {
      setError("No hay conexión. Tu respuesta no se registró: intenta de nuevo.");
    } finally { setEnviando(false); }
  }

  if (cargando)
    return <Marco><p className="text-center text-gray-400 py-16 text-sm">Cargando…</p></Marco>;

  if (!cambio)
    return (
      <Marco>
        <div className="text-center py-12">
          <p className="text-4xl mb-3">🔗</p>
          <p className="font-bold text-gray-800">{error || "Enlace no válido"}</p>
          <p className="text-sm text-gray-500 mt-2">
            Si crees que es un error, responde el mensaje por el que te llegó este enlace.
          </p>
        </div>
      </Marco>
    );

  const respondido = cambio.estado === "conforme" || cambio.estado === "observada";
  const sube = cambio.diferencia > 0;

  return (
    <Marco>
      <header className="mb-5">
        <p className="text-[11px] font-bold uppercase tracking-wider text-violet-600">{cambio.empresa}</p>
        <h1 className="text-xl font-black text-gray-900 mt-1">Cambio en tu servicio</h1>
        <p className="text-sm text-gray-500 mt-0.5">
          {cambio.cliente ? `${cambio.cliente} · ` : ""}{cambio.codigo}
        </p>
      </header>

      {/* ── El servicio ── */}
      <div className="rounded-xl border bg-gray-50 px-4 py-3 mb-4 text-sm">
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {cambio.os && <span className="font-mono text-xs text-gray-500">{cambio.os}</span>}
          {cambio.fecha_servicio && <span className="text-gray-700 font-bold">{fecha(cambio.fecha_servicio)}</span>}
          {cambio.ruta && <span className="text-gray-600">{cambio.ruta}</span>}
        </div>
        {(cambio.origen || cambio.destino) && (
          <p className="text-xs text-gray-500 mt-1">{cambio.origen} → {cambio.destino}</p>
        )}
      </div>

      {/* ── Qué cambió ── */}
      {(cambio.unidad_antes || cambio.unidad_despues) && (
        <div className="grid grid-cols-2 gap-3 mb-4">
          <Caja titulo="Unidad anterior" valor={cambio.unidad_antes ?? "—"} />
          <Caja titulo="Unidad nueva" valor={cambio.unidad_despues ?? "—"} destacado />
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        <Caja titulo="Precio acordado" valor={soles(cambio.precio_antes)} />
        <Caja titulo="Precio nuevo" valor={soles(cambio.precio_despues)} destacado />
      </div>

      <div className="rounded-xl border-2 px-4 py-4 my-4 text-center"
        style={{ borderColor: sube ? "#c2410c" : "#166534", background: sube ? "#fff7ed" : "#f0fdf4" }}>
        <p className="text-[11px] uppercase tracking-wide font-bold" style={{ color: sube ? "#9a3412" : "#166534" }}>
          {sube ? "Diferencia a facturar" : "Diferencia a tu favor"}
        </p>
        <p className="text-3xl font-black mt-0.5" style={{ color: sube ? "#c2410c" : "#166534" }}>
          {sube ? "+" : ""}{soles(cambio.diferencia)}
        </p>
      </div>

      {cambio.motivo && (
        <p className="text-sm text-gray-600 mb-4">
          <span className="text-gray-400">Motivo:</span> <b>{cambio.motivo}</b>
          {cambio.motivo_nota ? ` · ${cambio.motivo_nota}` : ""}
        </p>
      )}

      {/* ── Ya respondido ── */}
      {respondido ? (
        <div className="rounded-xl px-4 py-4 border"
          style={cambio.estado === "conforme"
            ? { background: "#f0fdf4", borderColor: "#bbf7d0" }
            : { background: "#fff7ed", borderColor: "#fed7aa" }}>
          <p className="font-black" style={{ color: cambio.estado === "conforme" ? "#166534" : "#9a3412" }}>
            {cambio.estado === "conforme" ? "✓ Conforme registrada" : "Observación registrada"}
          </p>
          <p className="text-sm text-gray-600 mt-1">
            {cambio.respondido_por}{cambio.respondido_cargo ? ` · ${cambio.respondido_cargo}` : ""}
            {cambio.respondido_at && ` · ${new Date(cambio.respondido_at).toLocaleString("es-PE", {
              day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" })}`}
          </p>
          {cambio.comentario && <p className="text-sm text-gray-600 mt-2 italic">“{cambio.comentario}”</p>}
          <p className="text-xs text-gray-400 mt-3">
            Ya no hace falta que hagas nada más. Guardamos esta constancia con tu nombre y la fecha.
          </p>
        </div>
      ) : cambio.estado !== "pendiente" ? (
        <p className="text-sm text-gray-500">Este cambio no requiere tu conformidad.</p>
      ) : (
        /* ── Firmar ── */
        <div className="space-y-3">
          <p className="text-sm text-gray-600">
            Si estás de acuerdo con el cambio y con la diferencia, déjanos tu conformidad.
            Si algo no calza, obsérvalo y lo revisamos antes de facturar.
          </p>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Tu nombre *</span>
              <input className="w-full mt-1 px-3 py-2 border rounded-xl text-sm"
                value={por} onChange={(e) => setPor(e.target.value)} placeholder="Nombre y apellido" />
            </label>
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">Tu cargo</span>
              <input className="w-full mt-1 px-3 py-2 border rounded-xl text-sm"
                value={cargo} onChange={(e) => setCargo(e.target.value)} placeholder="Jefe de Planta" />
            </label>
          </div>

          {observando && (
            <label className="block">
              <span className="text-[11px] font-bold uppercase tracking-wide text-gray-500">¿Qué observas? *</span>
              <textarea className="w-full mt-1 px-3 py-2 border rounded-xl text-sm" rows={3}
                value={comentario} onChange={(e) => setComentario(e.target.value)}
                placeholder="Cuéntanos qué no calza para corregirlo antes de facturar." />
            </label>
          )}

          {error && <p className="text-sm text-red-600">{error}</p>}

          <div className="flex flex-col sm:flex-row gap-2">
            <button disabled={enviando} onClick={() => responder("conforme")}
              className="flex-1 px-4 py-3 rounded-xl font-bold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50">
              {enviando ? "Registrando…" : "Estoy conforme"}
            </button>
            <button disabled={enviando}
              onClick={() => (observando ? responder("observada") : setObservando(true))}
              className="flex-1 px-4 py-3 rounded-xl font-bold border text-gray-700 hover:bg-gray-50 disabled:opacity-50">
              {observando ? "Enviar observación" : "Tengo una observación"}
            </button>
          </div>

          <p className="text-[11px] text-gray-400 text-center">
            Queda registrada la fecha y hora de tu respuesta. No necesitas crear ninguna cuenta.
          </p>
        </div>
      )}
    </Marco>
  );
}

function Marco({ children }: { children: React.ReactNode }) {
  return (
    <div className="min-h-screen bg-gray-100 py-6 px-4">
      <div className="max-w-lg mx-auto bg-white rounded-2xl border shadow-sm p-6">{children}</div>
    </div>
  );
}

function Caja({ titulo, valor, destacado }: { titulo: string; valor: string; destacado?: boolean }) {
  return (
    <div className={`rounded-xl border px-3 py-2.5 ${destacado ? "border-violet-300 bg-violet-50" : "bg-white"}`}>
      <p className="text-[10px] uppercase tracking-wide font-bold text-gray-400">{titulo}</p>
      <p className={`font-black mt-0.5 ${destacado ? "text-violet-800" : "text-gray-600"}`}>{valor}</p>
    </div>
  );
}
