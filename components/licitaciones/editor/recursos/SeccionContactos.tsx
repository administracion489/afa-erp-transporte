"use client";
// components/licitaciones/editor/recursos/SeccionContactos.tsx — Los contactos del contrato (gobierno del
// contrato: quién atiende, quién responde una emergencia). Lo que se imprime lo arma `tablaContactos`
// (lib/licitaciones/tablas), la MISMA tabla de la propuesta y del expediente: la vista previa la usa.
//
// Un contacto enlazado al personal administrativo (personalId) deriva sus datos de esa ficha; esta
// pantalla todavía no ofrece elegir a una persona del personal (no hay lector para eso en datos.ts), así
// que los contactos nuevos se escriben. Uno enlazado (copiado de otra licitación) se respeta y se puede
// pasar a «escrito a mano».

import { contactoDe } from "@/lib/licitaciones/texto";
import { tablaContactos } from "@/lib/licitaciones/tablas";
import type { Contacto, Hallazgo } from "@/lib/licitaciones/tipos";
import { anclaDe, type PasoProps } from "../contrato-editor";
import { Boton, CampoTexto, Etiqueta, ListaHallazgos, Nota, Seccion } from "./comun";
import { generalesDe } from "./hallazgos";

/** Tope de contactos (el de normalizarDoc, T.maxContactos). */
const MAX_CONTACTOS = 40;
const ROLES_SUGERIDOS = ["Gerente de cuenta", "Coordinador de operaciones", "Supervisor del servicio", "Emergencias (24 h)", "Facturación y cobranza"];

export default function SeccionContactos({ p, hallazgos }: { p: PasoProps; hallazgos: Hallazgo[] }) {
  const { lic, doc, ctx, soloLectura } = p;
  const lleno = doc.contactos.length >= MAX_CONTACTOS;
  const tabla = ctx ? tablaContactos(lic, ctx) : null;

  const cambiar = (id: string, cambio: Partial<Contacto>) =>
    p.cambiarDoc((d) => ({ ...d, contactos: d.contactos.map((c) => (c.id === id ? { ...c, ...cambio } : c)) }));
  const agregar = () => {
    if (lleno) return;
    const id = p.nuevoId();
    p.cambiarDoc((d) => ({ ...d, contactos: [...d.contactos, { id, rol: "", personalId: null, nombre: "", cargo: "", telefono: "", email: "", emergencia: false }] }));
    window.setTimeout(() => document.getElementById(anclaDe("contacto", id))?.querySelector("input")?.focus(), 50);
  };
  const quitar = (c: Contacto) => {
    const d = ctx ? contactoDe(c, ctx) : c;
    const quien = [d.rol, d.nombre].filter((x) => x && x.trim()).join(" – ");
    if (quien && !window.confirm(`¿Quitar el contacto «${quien}» de esta licitación?`)) return;
    p.cambiarDoc((x) => ({ ...x, contactos: x.contactos.filter((y) => y.id !== c.id) }));
  };
  const mover = (k: number, dir: -1 | 1) => p.cambiarDoc((d) => {
    const arr = [...d.contactos];
    const j = k + dir;
    if (j < 0 || j >= arr.length) return d;
    [arr[k], arr[j]] = [arr[j], arr[k]];
    return { ...d, contactos: arr };
  });
  /** Deja de leer los datos del personal: copia lo que hoy dice su ficha y queda escrito a mano. */
  const desenlazar = (c: Contacto) => {
    if (!ctx) return;
    const d = contactoDe(c, ctx);
    if (!window.confirm("Este contacto dejará de leer sus datos del personal administrativo y quedará escrito a mano con lo que dice hoy su ficha. ¿Seguir?")) return;
    cambiar(c.id, { personalId: null, nombre: d.nombre, cargo: d.cargo, telefono: d.telefono, email: d.email });
  };

  return (
    <Seccion id="contactos" titulo="Contactos del contrato"
      subtitulo="Quién atiende al cliente durante el servicio. Salen en la tabla de contactos de la propuesta."
      acciones={!soloLectura ? <Boton chico onClick={agregar} disabled={lleno}>+ Agregar contacto</Boton> : null}>
      <ListaHallazgos hallazgos={generalesDe(hallazgos, "contactos")} irA={p.irA} />
      {lleno && !soloLectura && <p className="text-[11px] text-gray-600">No se pueden agregar más: el tope es de {MAX_CONTACTOS} contactos.</p>}
      <datalist id="lic-roles-contacto">{ROLES_SUGERIDOS.map((r) => <option key={r} value={r} />)}</datalist>

      {!doc.contactos.length ? (
        <p className="text-sm text-gray-500">Sin contactos. Agrega al menos quién coordina el servicio y a quién llamar en una emergencia.</p>
      ) : (
        <ol className="space-y-2">
          {doc.contactos.map((c, k) => {
            const enlazado = c.personalId != null;
            const d = ctx ? contactoDe(c, ctx) : null;
            const personalLeido = ctx?.lecturas.personal === "ok";
            return (
              <li key={c.id} id={anclaDe("contacto", c.id)} className="scroll-mt-24 rounded-xl border border-gray-200 p-3">
                <div className="grid gap-2 sm:grid-cols-6">
                  <div className="sm:col-span-2">
                    <Etiqueta texto="Rol">
                      <CampoTexto valor={c.rol} onCambio={(v) => cambiar(c.id, { rol: v })} maxLength={120} disabled={soloLectura} placeholder="p. ej. Coordinador de operaciones" list="lic-roles-contacto" />
                    </Etiqueta>
                  </div>
                  {enlazado ? (
                    <div className="sm:col-span-4">
                      <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Persona del personal administrativo</p>
                      {!ctx ? <p className="text-xs text-gray-500">Comprobando…</p>
                        : !personalLeido ? <Nota tono="ambar">No se pudo leer el personal administrativo: no se muestran sus datos (no es que falten).</Nota>
                        : d?.personalNoEncontrado ? <Nota tono="rojo">La persona enlazada (#{c.personalId}) ya no está en el personal administrativo.</Nota>
                        : <p className="text-sm text-gray-800">{[d?.nombre, d?.cargo, d?.telefono, d?.email].filter(Boolean).join(" · ") || "—"}</p>}
                      {!soloLectura && ctx && personalLeido && <button type="button" onClick={() => desenlazar(c)} className="mt-1 text-xs font-semibold text-[#0b315f] underline">Escribir a mano</button>}
                    </div>
                  ) : (
                    <>
                      <div className="sm:col-span-2"><Etiqueta texto="Nombre"><CampoTexto valor={c.nombre} onCambio={(v) => cambiar(c.id, { nombre: v })} maxLength={120} disabled={soloLectura} /></Etiqueta></div>
                      <div className="sm:col-span-2"><Etiqueta texto="Cargo (no se imprime en la tabla)"><CampoTexto valor={c.cargo} onCambio={(v) => cambiar(c.id, { cargo: v })} maxLength={120} disabled={soloLectura} /></Etiqueta></div>
                      <div className="sm:col-span-3"><Etiqueta texto="Teléfono"><CampoTexto valor={c.telefono} onCambio={(v) => cambiar(c.id, { telefono: v })} maxLength={120} inputMode="tel" disabled={soloLectura} /></Etiqueta></div>
                      <div className="sm:col-span-3"><Etiqueta texto="Correo"><CampoTexto valor={c.email} onCambio={(v) => cambiar(c.id, { email: v })} maxLength={120} inputMode="email" disabled={soloLectura} /></Etiqueta></div>
                    </>
                  )}
                </div>
                <div className="mt-2 flex flex-wrap items-center justify-between gap-2">
                  <label className="flex items-center gap-2 text-sm text-gray-700">
                    <input type="checkbox" className="h-4 w-4" disabled={soloLectura} checked={c.emergencia} onChange={(e) => cambiar(c.id, { emergencia: e.target.checked })} />
                    Contacto de emergencia
                  </label>
                  {!soloLectura && (
                    <span className="flex items-center gap-1">
                      <Boton chico tono="suave" onClick={() => mover(k, -1)} disabled={k === 0} title="Subir">↑</Boton>
                      <Boton chico tono="suave" onClick={() => mover(k, 1)} disabled={k === doc.contactos.length - 1} title="Bajar">↓</Boton>
                      <Boton chico tono="peligro" onClick={() => quitar(c)}>Quitar</Boton>
                    </span>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {tabla && tabla.filas.length > 0 && (
        <div>
          <p className="mb-1 text-[11px] font-semibold uppercase tracking-wide text-gray-500">Así sale impreso</p>
          <div className="overflow-x-auto rounded-lg border border-gray-200">
            <table className="w-full min-w-[480px] text-xs">
              <thead className="bg-gray-50 text-left text-[10px] uppercase tracking-wide text-gray-500">
                <tr>{tabla.columnas.map((c) => <th key={c} className="px-2 py-1.5 font-semibold">{c}</th>)}</tr>
              </thead>
              <tbody>
                {tabla.filas.map((f, i) => <tr key={i} className="border-t border-gray-100">{f.map((x, j) => <td key={j} className="px-2 py-1.5 text-gray-700">{x}</td>)}</tr>)}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </Seccion>
  );
}
