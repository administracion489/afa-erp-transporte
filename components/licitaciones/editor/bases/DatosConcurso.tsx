"use client";
// components/licitaciones/editor/bases/DatosConcurso.tsx — Las COLUMNAS de la licitación (D1: los datos
// del concurso viven solo en columnas, no en el doc). El cliente puede ser uno del ERP (cliente_id) o
// solo un nombre: el nombre es el que se imprime, y se puede ajustar aunque haya cliente del ERP.
import { useMemo, type ChangeEvent } from "react";
import SelectorCliente from "@/components/SelectorCliente";
import { rotuloCliente, type ClienteBuscable } from "@/lib/clientes-buscador";
import { ESTADOS_LICITACION, type EstadoLicitacion, type Licitacion } from "@/lib/licitaciones/tipos";
import type { ColumnasLic } from "../contrato-editor";
import { ETIQUETA_ESTADO } from "../etiquetas";
import CampoEntero from "./CampoEntero";
import { Campo, INPUT, Tarjeta, aTope } from "./ui";
import { useClientesErp } from "./useClientesErp";

type Props = { lic: Licitacion; cambiarColumnas: (c: ColumnasLic) => void; soloLectura: boolean };

export default function DatosConcurso({ lic, cambiarColumnas, soloLectura }: Props) {
  const cli = useClientesErp();
  const elegido = useMemo(() => (lic.cliente_id != null ? cli.clientes.find((c) => c.id === lic.cliente_id) ?? null : null), [cli.clientes, lic.cliente_id]);
  const nombreErp = elegido ? rotuloCliente(elegido) : null;

  const elegir = (c: ClienteBuscable | null) => {
    if (!c) { cambiarColumnas({ cliente_id: null }); return; }
    cambiarColumnas({ cliente_id: c.id, cliente_nombre: aTope(rotuloCliente(c), 200) });
  };
  const fecha = (k: "fecha_consultas" | "fecha_presentacion" | "fecha_inicio_servicio") => ({
    type: "date" as const, value: lic[k] ?? "", disabled: soloLectura, className: INPUT,
    onChange: (e: ChangeEvent<HTMLInputElement>) => cambiarColumnas({ [k]: e.target.value || null }),
  });
  const inicioAntes = lic.fecha_inicio_servicio && lic.fecha_presentacion && lic.fecha_inicio_servicio < lic.fecha_presentacion;
  const consultasDespues = lic.fecha_consultas && lic.fecha_presentacion && lic.fecha_consultas > lic.fecha_presentacion;

  return (
    <Tarjeta id="datos" titulo="📋 Datos del concurso" subtitulo="Salen en la portada, en la carta y en los datos de la propuesta. La fecha de presentación es la fecha contra la que se miden las vigencias.">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <Campo etiqueta="Nombre de la licitación *" error={!lic.nombre.trim() ? "Falta el nombre: sin él no se guarda nada." : undefined} className="md:col-span-2">
          <input className={INPUT} value={lic.nombre} maxLength={200} disabled={soloLectura} placeholder="p. ej. Transporte de personal · planta Lurín 2027"
            onChange={(e) => cambiarColumnas({ nombre: e.target.value })} />
        </Campo>

        <div className="md:col-span-2 grid grid-cols-1 md:grid-cols-2 gap-3 rounded-xl border border-gray-200 p-3">
          <Campo etiqueta="Cliente del ERP (opcional)"
            ayuda={cli.error ? undefined : lic.cliente_id != null && !cli.cargando && !elegido ? `El cliente N° ${lic.cliente_id} ya no está en la lista de clientes.` : "Si convoca un cliente que ya está en el ERP, elígelo."}
            error={cli.error ? <>No se pudieron leer los clientes del ERP ({cli.error}). Escribe el nombre a mano, o <button type="button" className="underline font-bold" onClick={cli.reintentar}>reintenta</button>.</> : undefined}>
            {soloLectura
              ? <input className={INPUT} disabled value={nombreErp ?? (lic.cliente_id != null ? `Cliente N° ${lic.cliente_id}` : "— ninguno")} />
              : <SelectorCliente clientes={cli.clientes} valor={lic.cliente_id != null ? String(lic.cliente_id) : ""} onElegir={elegir} cargando={cli.cargando} placeholder="Buscar cliente…" />}
          </Campo>
          <Campo etiqueta="Entidad que convoca (como se imprime) *"
            error={!lic.cliente_nombre.trim() ? "Falta el nombre de quien convoca." : undefined}
            ayuda={nombreErp && nombreErp !== lic.cliente_nombre.trim() ? `En el ERP se llama «${nombreErp}»; en la propuesta sale lo que escribas aquí.` : undefined}>
            <input className={INPUT} value={lic.cliente_nombre} maxLength={200} disabled={soloLectura} placeholder="p. ej. Empresa ABC S.A.C."
              onChange={(e) => cambiarColumnas({ cliente_nombre: e.target.value })} />
          </Campo>
        </div>

        <Campo etiqueta="Código del concurso">
          <input className={INPUT} value={lic.codigo ?? ""} maxLength={80} disabled={soloLectura} placeholder="p. ej. CP-012-2026"
            onChange={(e) => cambiarColumnas({ codigo: e.target.value || null })} />
        </Campo>
        <Campo etiqueta="Atención (a quién va dirigida)">
          <input className={INPUT} value={lic.atencion ?? ""} maxLength={200} disabled={soloLectura} placeholder="p. ej. Comité de selección"
            onChange={(e) => cambiarColumnas({ atencion: e.target.value || null })} />
        </Campo>
        <Campo etiqueta="Objeto del servicio" className="md:col-span-2">
          <textarea className={`${INPUT} min-h-[64px]`} value={lic.objeto ?? ""} maxLength={2000} disabled={soloLectura}
            placeholder="Lo que se contrata, como lo dicen las bases"
            onChange={(e) => cambiarColumnas({ objeto: e.target.value || null })} />
        </Campo>

        <Campo etiqueta="Fecha de consultas" error={consultasDespues ? "Es posterior a la fecha de presentación: revisa las dos." : undefined}>
          <input {...fecha("fecha_consultas")} />
        </Campo>
        <div className="grid grid-cols-[1fr_auto] gap-2">
          <Campo etiqueta="Fecha de presentación" ayuda={!lic.fecha_presentacion ? "Sin ella, las vigencias se miden contra hoy." : undefined}>
            <input {...fecha("fecha_presentacion")} />
          </Campo>
          <Campo etiqueta="Hora">
            <input type="time" className={INPUT} value={lic.hora_presentacion ?? ""} disabled={soloLectura}
              onChange={(e) => cambiarColumnas({ hora_presentacion: e.target.value ? e.target.value.slice(0, 5) : null })} />
          </Campo>
        </div>
        <Campo etiqueta="Inicio del servicio" error={inicioAntes ? "Es anterior a la fecha de presentación: revisa las dos." : undefined}
          ayuda={!lic.fecha_inicio_servicio ? "Con ella se comprueba qué documento vence antes de empezar." : undefined}>
          <input {...fecha("fecha_inicio_servicio")} />
        </Campo>
        <div className="grid grid-cols-2 gap-2">
          <Campo etiqueta="Plazo (meses)" ayuda="De 1 a 240. Vacío = no se sabe.">
            <CampoEntero valor={lic.plazo_meses} min={1} max={240} disabled={soloLectura} ariaLabel="Plazo en meses"
              onCambio={(n) => cambiarColumnas({ plazo_meses: n })} />
          </Campo>
          <Campo etiqueta="Estado">
            <select className={INPUT} value={lic.estado} disabled={soloLectura}
              onChange={(e) => cambiarColumnas({ estado: e.target.value as EstadoLicitacion })}>
              {ESTADOS_LICITACION.map((s) => <option key={s} value={s}>{ETIQUETA_ESTADO[s].texto}</option>)}
            </select>
          </Campo>
        </div>
      </div>
    </Tarjeta>
  );
}
