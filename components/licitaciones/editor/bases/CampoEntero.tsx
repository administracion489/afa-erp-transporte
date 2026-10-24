"use client";
// components/licitaciones/editor/bases/CampoEntero.tsx — Un número tecleado que solo se entrega cuando
// vale. Mientras el texto no es un entero del rango, se conserva en pantalla con su motivo y NO se
// entrega nada (ni un cero ni un número inventado). Vacío = null: así se borra un dato mal puesto.
// El borrador se deriva en el render (sin efectos): si el valor cambia desde fuera, manda el de fuera.
import { useState } from "react";
import { INPUT } from "./ui";

type Props = {
  valor: number | null;
  min: number;
  max: number;
  /** Se llama solo con un entero del rango o con null (campo vacío). */
  onCambio: (n: number | null) => void;
  disabled?: boolean;
  placeholder?: string;
  className?: string;
  /** Permite decimales (montos): hasta dos, con coma de miles opcional. */
  decimales?: boolean;
  ariaLabel?: string;
  onInvalido?: (motivo: string | null) => void;
};

/** "150,000.50" → 150000.5 · "150000" → 150000 · lo demás → NaN. */
export function leerNumero(txt: string, decimales: boolean): number {
  const t = txt.trim();
  if (!t) return NaN;
  const re = decimales ? /^(\d{1,3}(,\d{3})+|\d+)(\.\d{1,2})?$/ : /^\d+$/;
  if (!re.test(t)) return NaN;
  return Number(t.replace(/,/g, ""));
}

export function motivoNumero(txt: string, min: number, max: number, decimales: boolean): string | null {
  if (!txt.trim()) return null;
  const n = leerNumero(txt, decimales);
  if (Number.isNaN(n)) return decimales ? "Escribe el número sin letras, p. ej. 150000 o 150,000.00." : "Escribe un número entero, sin decimales ni letras.";
  if (n < min || n > max) return `Tiene que estar entre ${min.toLocaleString("es-PE")} y ${max.toLocaleString("es-PE")}.`;
  return null;
}

export default function CampoEntero({ valor, min, max, onCambio, disabled, placeholder, className, decimales = false, ariaLabel, onInvalido }: Props) {
  const [st, setSt] = useState<{ txt: string; base: number | null }>({ txt: valor == null ? "" : String(valor), base: valor });
  const txt = st.base === valor ? st.txt : (valor == null ? "" : String(valor));
  const motivo = motivoNumero(txt, min, max, decimales);
  return (
    <>
      <input
        type="text"
        inputMode={decimales ? "decimal" : "numeric"}
        value={txt}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={ariaLabel}
        aria-invalid={motivo ? true : undefined}
        className={`${INPUT} ${motivo ? "border-red-400" : ""} ${className ?? ""}`}
        onChange={(e) => {
          const t = e.target.value;
          if (!t.trim()) { setSt({ txt: t, base: null }); onCambio(null); onInvalido?.(null); return; }
          const m = motivoNumero(t, min, max, decimales);
          if (m) { setSt({ txt: t, base: valor }); onInvalido?.(m); return; }
          const n = leerNumero(t, decimales);
          setSt({ txt: t, base: n });
          onCambio(n);
          onInvalido?.(null);
        }}
      />
      {motivo && !onInvalido && <span className="block text-[11px] text-red-700 mt-0.5">{motivo} No se guarda hasta corregirlo.</span>}
    </>
  );
}
