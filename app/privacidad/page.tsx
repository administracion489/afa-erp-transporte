"use client";
import { useEffect, useState } from "react";
import { supabase } from "@/lib/supabase";

// Contenido por defecto (se muestra si la tabla no existe o está vacía)
const CONTENIDO_DEFAULT = `
<h2>1. Introducción y Marco Legal</h2>
<p>AFA TOURS PERU S.A.C. (en adelante "AFA Transportes"), en cumplimiento de la <strong>Ley N° 29733 — Ley de Protección de Datos Personales del Perú</strong> y su Reglamento aprobado por <strong>Decreto Supremo N° 003-2013-JUS</strong>, así como en concordancia con el <strong>Reglamento General de Protección de Datos (RGPD) de la Unión Europea (UE) 2016/679</strong>, la <strong>Ley de Privacidad del Consumidor de California (CCPA)</strong> y demás normativas internacionales aplicables, ha elaborado la presente Política de Privacidad con el propósito de informar con total transparencia a los usuarios sobre el tratamiento de sus datos personales en el marco del ecosistema digital de AFA Transportes.</p>
<p>El ecosistema digital de AFA Transportes comprende tres aplicaciones móviles y un sistema ERP web:</p>
<ul>
  <li><strong>AFA Conductor</strong> — aplicación destinada a los conductores de la flota.</li>
  <li><strong>AFA Pasajero</strong> — aplicación destinada a los pasajeros y usuarios del servicio.</li>
  <li><strong>Portal Empresarial AFA</strong> — plataforma destinada a clientes corporativos y empresas contratantes.</li>
  <li><strong>ERP AFA Transportes</strong> — sistema de gestión interna para el personal administrativo.</li>
</ul>

<h2>2. Responsable del Tratamiento de Datos</h2>
<p>El responsable del banco de datos personales es <strong>AFA TOURS PERU S.A.C.</strong>, inscrita en los Registros Públicos del Perú con RUC N° 20602117091, domiciliada en la ciudad de Lima. El banco de datos se encuentra registrado ante la <strong>Autoridad Nacional de Protección de Datos Personales (ANPDP)</strong> del Ministerio de Justicia y Derechos Humanos del Perú.</p>

<h2>3. Descripción de cada Aplicación y Datos que Recopila</h2>
<h3>3.1 AFA Conductor</h3>
<p>Aplicación móvil de uso exclusivo para los conductores de AFA Transportes. Sus funcionalidades incluyen:</p>
<ul>
  <li><strong>Visualización de ruta asignada</strong> con redirección automática a Google Maps o Waze.</li>
  <li><strong>Escáner de código QR</strong> de pasajeros para validar el abordaje.</li>
  <li><strong>Subida de documentos obligatorios</strong>: licencia, SOAT, revisión técnica, etc.</li>
  <li><strong>Registro de rutas</strong> completadas con hora de inicio, paradas y llegada.</li>
  <li><strong>Checklist de vehículo</strong> previo a la salida.</li>
  <li><strong>Reporte de incidencias</strong> durante la ruta.</li>
  <li><strong>Consulta de pagos</strong> y liquidaciones.</li>
</ul>
<p><strong>Datos recopilados:</strong> nombre completo, DNI, foto de perfil, número de licencia, documentos vehiculares, geolocalización durante rutas activas, registros de escaneo QR, historial de pagos y logs de acceso.</p>
<p><strong>Permisos requeridos:</strong> Cámara (QR y documentos), Ubicación (seguimiento de ruta), Almacenamiento (documentos), Notificaciones push.</p>

<h3>3.2 AFA Pasajero</h3>
<p>Aplicación móvil destinada a los pasajeros de los servicios de transporte contratados por empresas clientes de AFA Transportes.</p>
<p><strong>Datos recopilados:</strong> nombre completo, DNI, correo electrónico, número de teléfono, foto de perfil, geolocalización (solo cuando se comparte voluntariamente), historial de viajes y calificaciones.</p>
<p><strong>Permisos requeridos:</strong> Ubicación (solo cuando se activa voluntariamente), Notificaciones push, Cámara (opcional para foto de perfil).</p>

<h3>3.3 Portal Empresarial AFA</h3>
<p>Plataforma web y móvil destinada a empresas y clientes corporativos.</p>
<p><strong>Datos recopilados:</strong> razón social, RUC, nombre del representante, correo corporativo, teléfono, datos de pasajeros registrados por la empresa y historial de servicios contratados.</p>

<h2>4. Finalidad del Tratamiento de Datos</h2>
<ul>
  <li>Prestación y gestión integral de servicios de transporte de personas y carga.</li>
  <li>Verificación de identidad mediante código QR.</li>
  <li>Navegación y optimización de rutas de transporte.</li>
  <li>Control de documentación habilitante para la conducción de vehículos.</li>
  <li>Emisión de manifiestos de servicio con valor legal y operativo.</li>
  <li>Facturación electrónica conforme a las normas de SUNAT.</li>
  <li>Gestión de incidencias, accidentes y novedades operativas.</li>
  <li>Mejora continua de la calidad del servicio mediante calificaciones.</li>
  <li>Cumplimiento de obligaciones legales ante SUNAFIL, MTC, SUNAT y otras autoridades peruanas.</li>
</ul>

<h2>5. Base Legal del Tratamiento</h2>
<ul>
  <li><strong>Consentimiento del titular:</strong> otorgado al momento del registro en cada plataforma.</li>
  <li><strong>Ejecución de contrato:</strong> para cumplir la relación laboral con conductores o el contrato de servicio con clientes.</li>
  <li><strong>Obligación legal:</strong> cuando la normativa peruana exige el tratamiento de ciertos datos.</li>
  <li><strong>Interés legítimo:</strong> para fines operativos internos que no comprometan los derechos del titular.</li>
</ul>

<h2>6. Transferencia Internacional de Datos</h2>
<p>AFA Transportes utiliza los siguientes servicios tecnológicos de terceros:</p>
<ul>
  <li><strong>Supabase Inc.</strong> (EE.UU.) — base de datos PostgreSQL y autenticación segura, certificado SOC 2 Type II.</li>
  <li><strong>Vercel Inc.</strong> (EE.UU.) — alojamiento de la plataforma web.</li>
  <li><strong>Google LLC</strong> (EE.UU.) — Firebase Cloud Messaging para notificaciones push; Google Maps y Waze para navegación.</li>
</ul>
<p>Todas las transferencias internacionales se realizan bajo garantías adecuadas de protección, en cumplimiento del artículo 15° de la Ley N° 29733 y el Capítulo V del RGPD europeo.</p>

<h2>7. Conservación de los Datos</h2>
<p>Los datos personales serán conservados durante el tiempo necesario para cumplir con las finalidades descritas y los plazos legales establecidos por la normativa peruana (tributaria, laboral y comercial). Finalizada la relación con el usuario, los datos serán bloqueados y posteriormente eliminados de forma segura.</p>

<h2>8. Derechos del Titular de los Datos</h2>
<p>Conforme a la Ley N° 29733 y el RGPD, el titular tiene derecho a:</p>
<ul>
  <li><strong>Acceso:</strong> conocer qué datos son tratados.</li>
  <li><strong>Rectificación:</strong> corregir datos inexactos o incompletos.</li>
  <li><strong>Cancelación:</strong> solicitar la supresión de sus datos.</li>
  <li><strong>Oposición:</strong> oponerse al tratamiento en determinadas circunstancias.</li>
  <li><strong>Portabilidad:</strong> recibir sus datos en formato estructurado.</li>
  <li><strong>Limitación:</strong> restringir el tratamiento en ciertos supuestos.</li>
</ul>
<p>Para ejercer estos derechos, envíe una solicitud a <strong>admin@transportesafa.com</strong> indicando su nombre, DNI y el derecho que desea ejercer. AFA Transportes responderá en un plazo máximo de <strong>20 días hábiles</strong> conforme al artículo 24° de la Ley N° 29733.</p>

<h2>9. Seguridad de la Información</h2>
<ul>
  <li>Cifrado TLS 1.2 o superior en todas las comunicaciones.</li>
  <li>Cifrado de datos en reposo en la base de datos.</li>
  <li>Autenticación segura con tokens JWT y gestión de sesiones.</li>
  <li>Control de acceso por roles (Row Level Security — RLS).</li>
  <li>Auditoría de accesos y registros de actividad.</li>
  <li>Copias de seguridad automáticas periódicas.</li>
</ul>

<h2>10. Cookies</h2>
<p>El sistema web utiliza únicamente cookies de sesión estrictamente necesarias para el funcionamiento de la autenticación. No se emplean cookies publicitarias ni de rastreo de terceros.</p>

<h2>11. Menores de Edad</h2>
<p>Las aplicaciones de AFA Transportes están destinadas a personas mayores de 18 años. No recopilamos intencionalmente datos de menores de edad.</p>

<h2>12. Modificaciones a esta Política</h2>
<p>AFA Transportes se reserva el derecho de modificar esta política en cualquier momento, notificando a los usuarios con al menos <strong>15 días de anticipación</strong> mediante la aplicación o correo electrónico.</p>

<h2>13. Autoridad de Control</h2>
<p>Si considera que sus derechos han sido vulnerados, puede presentar una reclamación ante la <strong>Autoridad Nacional de Protección de Datos Personales (ANPDP)</strong>, Jr. Scipión Llona N° 350, Miraflores, Lima, Perú.</p>

<h2>14. Ley Aplicable y Jurisdicción</h2>
<p>Esta política se rige por las leyes de la República del Perú. Cualquier controversia se somete a los jueces y tribunales de Lima.</p>
`;

export default function PrivacidadPage() {
  const [empresa,    setEmpresa]    = useState<{nombre:string|null;logo_url:string|null;email:string|null;telefono:string|null;ruc:string|null} | null>(null);
  const [contenido,  setContenido]  = useState<string | null>(null);
  const [titulo,     setTitulo]     = useState("Política de Privacidad y Protección de Datos Personales");
  const [updatedAt,  setUpdatedAt]  = useState<string | null>(null);
  const [loading,    setLoading]    = useState(true);

  useEffect(() => {
    Promise.all([
      supabase.from("empresa_perfil").select("nombre,logo_url,email,telefono,ruc").eq("id", 1).maybeSingle(),
      supabase.from("paginas_legales").select("titulo,contenido,updated_at").eq("id", "privacidad").maybeSingle(),
    ]).then(([empRes, pgRes]) => {
      if (empRes.data) setEmpresa(empRes.data as any);
      if (pgRes.data?.contenido) {
        setContenido(pgRes.data.contenido);
        if (pgRes.data.titulo) setTitulo(pgRes.data.titulo);
        if (pgRes.data.updated_at) setUpdatedAt(pgRes.data.updated_at);
      } else {
        setContenido(CONTENIDO_DEFAULT);
      }
      setLoading(false);
    });
  }, []);

  const empNombre = empresa?.nombre || "AFA TOURS PERU S.A.C.";
  const empRuc    = empresa?.ruc    || "20602117091";
  const empEmail  = empresa?.email  || "admin@transportesafa.com";
  const updStr    = updatedAt
    ? new Date(updatedAt).toLocaleDateString("es-PE", { day: "2-digit", month: "long", year: "numeric" })
    : "mayo de 2026";

  return (
    <>
      <style>{`
        * { box-sizing: border-box; }
        body { margin: 0; background: #f8fafc; }

        .pv-wrap { min-height: 100vh; display: flex; flex-direction: column; font-family: "Segoe UI", system-ui, -apple-system, sans-serif; }

        /* ── HEADER ── */
        .pv-header {
          background: linear-gradient(135deg, #07203f 0%, #0b315f 60%, #1262bd 100%);
          padding: 28px 24px 32px;
          text-align: center;
          position: relative;
          overflow: hidden;
        }
        .pv-header::before {
          content: "";
          position: absolute; inset: 0;
          background: radial-gradient(ellipse at top right, rgba(255,255,255,0.06) 0%, transparent 60%);
        }
        .pv-logo { height: 52px; object-fit: contain; filter: brightness(0) invert(1); margin-bottom: 14px; }
        .pv-logo-fb { width: 52px; height: 52px; background: rgba(255,255,255,0.12); border-radius: 14px; display: inline-flex; align-items: center; justify-content: center; font-size: 26px; margin-bottom: 14px; }
        .pv-header h1 { color: white; font-size: clamp(18px, 4vw, 26px); font-weight: 900; margin: 0 0 8px; line-height: 1.3; }
        .pv-header p  { color: rgba(255,255,255,0.65); font-size: 13px; margin: 0; }

        /* ── PILL META ── */
        .pv-meta {
          display: flex; flex-wrap: wrap; justify-content: center; gap: 8px;
          padding: 14px 20px;
          background: white;
          border-bottom: 1px solid #e2e8f0;
        }
        .pv-pill {
          display: inline-flex; align-items: center; gap: 5px;
          font-size: 11px; font-weight: 700;
          background: #f1f5f9; color: #475569;
          padding: 5px 12px; border-radius: 20px;
        }

        /* ── CONTENT ── */
        .pv-body { flex: 1; }
        .pv-inner { max-width: 780px; margin: 0 auto; padding: 32px 20px 60px; }

        /* Estilos del contenido HTML */
        .pv-content h2 {
          font-size: clamp(15px, 2.5vw, 18px); font-weight: 900;
          color: #0b315f; margin: 36px 0 12px;
          padding-bottom: 8px; border-bottom: 2px solid #e2e8f0;
          display: flex; align-items: center; gap: 10px;
        }
        .pv-content h2::before {
          content: ""; display: inline-block;
          width: 4px; height: 20px; border-radius: 2px;
          background: linear-gradient(180deg, #1262bd, #0b315f);
          flex-shrink: 0;
        }
        .pv-content h3 {
          font-size: 14px; font-weight: 800; color: #1e293b;
          margin: 20px 0 8px;
        }
        .pv-content p {
          color: #374151; font-size: 14px; line-height: 1.8; margin: 0 0 12px;
        }
        .pv-content ul {
          margin: 0 0 14px; padding-left: 20px;
        }
        .pv-content li {
          color: #374151; font-size: 14px; line-height: 1.8; margin-bottom: 5px;
        }
        .pv-content strong { color: #1e293b; }

        /* ── FOOTER ── */
        .pv-footer {
          background: #0b315f; color: rgba(255,255,255,0.7);
          padding: 24px 20px; text-align: center;
        }
        .pv-footer p { margin: 4px 0; font-size: 12px; }
        .pv-footer a { color: rgba(255,255,255,0.9); text-decoration: none; font-weight: 700; }
        .pv-footer .laws { font-size: 11px; opacity: 0.5; margin-top: 10px; }

        /* ── RESPONSIVE ── */
        @media (max-width: 640px) {
          .pv-header { padding: 22px 16px 26px; }
          .pv-inner  { padding: 24px 16px 48px; }
          .pv-content h2 { font-size: 15px; }
        }

        /* ── LOADING SKELETON ── */
        .skel { background: linear-gradient(90deg, #f1f5f9 25%, #e2e8f0 50%, #f1f5f9 75%); background-size: 200% 100%; animation: shimmer 1.5s infinite; border-radius: 6px; }
        @keyframes shimmer { 0%{background-position:200% 0} 100%{background-position:-200% 0} }
      `}</style>

      <div className="pv-wrap">

        {/* ── HEADER ── */}
        <div className="pv-header">
          {empresa?.logo_url
            ? <img src={empresa.logo_url} alt={empNombre} className="pv-logo" />
            : <div className="pv-logo-fb">🚌</div>
          }
          <h1>{titulo}</h1>
          <p>{empNombre} · RUC {empRuc} · Lima, Perú</p>
        </div>

        {/* ── META PILLS ── */}
        <div className="pv-meta">
          <span className="pv-pill">📅 Última actualización: {updStr}</span>
          <span className="pv-pill">🇵🇪 Ley N° 29733</span>
          <span className="pv-pill">🇪🇺 RGPD (UE) 2016/679</span>
          <span className="pv-pill">✉️ {empEmail}</span>
        </div>

        {/* ── CONTENIDO ── */}
        <div className="pv-body">
          <div className="pv-inner">
            {loading ? (
              <div style={{ display: "flex", flexDirection: "column", gap: 16, paddingTop: 8 }}>
                {[320, 280, 200, 300, 180, 260].map((w, i) => (
                  <div key={i} className="skel" style={{ height: 16, width: `${w}px`, maxWidth: "100%" }} />
                ))}
              </div>
            ) : (
              <div
                className="pv-content"
                dangerouslySetInnerHTML={{ __html: contenido || CONTENIDO_DEFAULT }}
              />
            )}
          </div>
        </div>

        {/* ── FOOTER ── */}
        <div className="pv-footer">
          <p>© {new Date().getFullYear()} <strong style={{ color: "white" }}>{empNombre}</strong> — Todos los derechos reservados.</p>
          {empEmail && <p>Consultas: <a href={`mailto:${empEmail}`}>{empEmail}</a></p>}
          <p className="laws">Ley N° 29733 · D.S. N° 003-2013-JUS · RGPD (UE) 2016/679 · CCPA</p>
        </div>

      </div>
    </>
  );
}
