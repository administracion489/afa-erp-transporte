"use client";
// components/licitaciones/editor/LimitePaso.tsx — Si un paso falla al dibujarse, cae SOLO ese paso: el
// editor (y los cambios sin guardar, que viven en él) sigue en pie. Los cinco pasos los escriben
// agentes distintos; un error en uno no puede tumbar la pantalla con el trabajo de los otros.
import { Component, type ReactNode } from "react";

type Props = { nombre: string; children: ReactNode; reintentoClave: string };
type Estado = { error: string | null; clave: string };

export default class LimitePaso extends Component<Props, Estado> {
  state: Estado = { error: null, clave: this.props.reintentoClave };

  static getDerivedStateFromError(e: unknown): Partial<Estado> {
    return { error: e instanceof Error ? e.message : String(e ?? "error desconocido") };
  }

  static getDerivedStateFromProps(p: Props, s: Estado): Partial<Estado> | null {
    // Cambiar de paso (o reintentar) vuelve a probar.
    return p.reintentoClave !== s.clave ? { error: null, clave: p.reintentoClave } : null;
  }

  componentDidCatch(e: unknown) {
    console.error(`[licitaciones/editor] el paso «${this.props.nombre}» falló al dibujarse:`, e);
  }

  render() {
    if (!this.state.error) return this.props.children;
    return (
      <div className="rounded-2xl border border-red-300 bg-red-50 px-4 py-3 text-sm text-red-800 space-y-2">
        <p className="font-bold">El paso «{this.props.nombre}» falló al dibujarse.</p>
        <p className="text-xs">Tus cambios siguen en el editor y el guardado automático sigue funcionando. Cambia de paso o recarga la página; si se repite, avisa a soporte con este detalle:</p>
        <p className="text-[11px] font-mono break-words">{this.state.error}</p>
        <button type="button" onClick={() => this.setState({ error: null })} className="px-3 py-1.5 rounded-lg border border-red-300 bg-white text-xs font-bold hover:bg-red-100">Reintentar</button>
      </div>
    );
  }
}
