export default function PrivacidadPage() {
  return (
    <div style={{ maxWidth: 800, margin: "0 auto", padding: "40px 24px", fontFamily: "sans-serif", lineHeight: 1.8, color: "#222" }}>
      <h1 style={{ borderBottom: "2px solid #222", paddingBottom: 12 }}>Política de Privacidad y Protección de Datos Personales</h1>
      <p><strong>AFA TOURS PERU S.A.C.</strong><br />
      RUC: 20602117091 — Lima, Perú<br />
      Correo: admin@transportesafa.com<br />
      Última actualización: mayo de 2026</p>

      <h2>1. Introducción y Marco Legal</h2>
      <p>AFA TOURS PERU S.A.C. (en adelante "AFA Transportes"), en cumplimiento de la <strong>Ley N° 29733 — Ley de Protección de Datos Personales del Perú</strong> y su Reglamento aprobado por <strong>Decreto Supremo N° 003-2013-JUS</strong>, así como en concordancia con el <strong>Reglamento General de Protección de Datos (RGPD) de la Unión Europea (UE) 2016/679</strong>, la <strong>Ley de Privacidad del Consumidor de California (CCPA)</strong> y demás normativas internacionales aplicables, ha elaborado la presente Política de Privacidad con el propósito de informar con total transparencia a los usuarios sobre el tratamiento de sus datos personales en el marco del ecosistema digital de AFA Transportes.</p>
      <p>El ecosistema digital de AFA Transportes comprende tres aplicaciones móviles y un sistema ERP web:</p>
      <ul>
        <li><strong>AFA Conductor</strong> — aplicación destinada a los conductores de la flota.</li>
        <li><strong>AFA Pasajero</strong> — aplicación destinada a los pasajeros y usuarios del servicio.</li>
        <li><strong>Portal Empresarial AFA</strong> — plataforma destinada a clientes corporativos y empresas contratantes.</li>
        <li><strong>ERP AFA Transportes</strong> — sistema de gestión interna para el personal administrativo.</li>
      </ul>
      <p>El uso de cualquiera de estas plataformas implica la aceptación expresa e inequívoca de los términos contenidos en la presente política.</p>

      <h2>2. Responsable del Tratamiento de Datos</h2>
      <p>El responsable del banco de datos personales es <strong>AFA TOURS PERU S.A.C.</strong>, inscrita en los Registros Públicos del Perú con RUC N° 20602117091, domiciliada en la ciudad de Lima. El banco de datos se encuentra registrado ante la <strong>Autoridad Nacional de Protección de Datos Personales (ANPDP)</strong> del Ministerio de Justicia y Derechos Humanos del Perú.</p>

      <h2>3. Descripción de cada Aplicación y Datos que Recopila</h2>

      <h3>3.1 AFA Conductor</h3>
      <p>Aplicación móvil de uso exclusivo para los conductores de AFA Transportes. Sus funcionalidades incluyen:</p>
      <ul>
        <li><strong>Visualización de ruta asignada</strong> con redirección automática a Google Maps o Waze para navegación hacia cada parada.</li>
        <li><strong>Escáner de código QR</strong> de pasajeros para validar el abordaje en cada punto de recogida.</li>
        <li><strong>Subida de documentos obligatorios</strong> para conducir: licencia de conducir, SOAT, revisión técnica, brevete, entre otros.</li>
        <li><strong>Registro de rutas</strong> completadas con hora de inicio, paradas y hora de llegada.</li>
        <li><strong>Checklist de vehículo</strong> previo a la salida: revisión de llantas, frenos, luces, combustible y estado general.</li>
        <li><strong>Reporte de incidencias</strong> durante la ruta: accidentes, fallas mecánicas, retrasos u otras novedades operativas.</li>
        <li><strong>Consulta de pagos</strong>: visualización del historial de remuneraciones y liquidaciones.</li>
        <li><strong>Edición de perfil</strong>: actualización de datos personales, foto de perfil y datos de contacto.</li>
      </ul>
      <p><strong>Datos recopilados:</strong> nombre completo, DNI, foto de perfil, número de licencia, documentos vehiculares, geolocalización durante rutas activas, registros de escaneo QR, reportes de incidencias, historial de pagos y logs de acceso al sistema.</p>
      <p><strong>Permisos requeridos:</strong></p>
      <ul>
        <li><strong>Cámara:</strong> para escaneo de QR de pasajeros y fotografía de documentos e incidencias.</li>
        <li><strong>Ubicación:</strong> para seguimiento de ruta en tiempo real durante servicios activos.</li>
        <li><strong>Almacenamiento:</strong> para carga de documentos obligatorios.</li>
        <li><strong>Notificaciones push:</strong> para alertas de inicio de ruta, novedades operativas y vencimiento de documentos.</li>
        <li><strong>Apertura de apps externas:</strong> redirección a Google Maps o Waze para navegación.</li>
      </ul>

      <h3>3.2 AFA Pasajero</h3>
      <p>Aplicación móvil destinada a los pasajeros que utilizan los servicios de transporte contratados por empresas clientes de AFA Transportes. Sus funcionalidades incluyen:</p>
      <ul>
        <li><strong>Revisión de reservas de viaje</strong>: consulta de servicios asignados, horarios, puntos de recogida y destino.</li>
        <li><strong>Código QR personal</strong>: generación y visualización del QR único del pasajero para ser escaneado por el conductor al momento del abordaje.</li>
        <li><strong>Compartir ubicación</strong>: el pasajero puede compartir su ubicación en tiempo real para que el conductor lo localice en el punto de recogida.</li>
        <li><strong>Visualización de ubicación del bus</strong>: seguimiento en tiempo real del vehículo asignado al servicio.</li>
        <li><strong>Calificación del servicio</strong>: evaluación del conductor y del viaje al finalizar el servicio.</li>
        <li><strong>Edición de perfil</strong>: actualización de datos personales y foto de perfil.</li>
      </ul>
      <p><strong>Datos recopilados:</strong> nombre completo, DNI, correo electrónico, número de teléfono, foto de perfil, geolocalización cuando es compartida voluntariamente, historial de viajes, calificaciones emitidas y logs de acceso.</p>
      <p><strong>Permisos requeridos:</strong></p>
      <ul>
        <li><strong>Ubicación:</strong> únicamente cuando el pasajero activa voluntariamente la función de compartir ubicación. No se recopila en segundo plano.</li>
        <li><strong>Notificaciones push:</strong> para alertas de confirmación de reserva, proximidad del vehículo e inicio de servicio.</li>
        <li><strong>Cámara:</strong> opcional, para actualización de foto de perfil.</li>
      </ul>

      <h3>3.3 Portal Empresarial AFA (Cliente Corporativo)</h3>
      <p>Plataforma web y móvil destinada a las empresas y clientes corporativos que contratan los servicios de transporte de AFA Transportes. Sus funcionalidades incluyen:</p>
      <ul>
        <li><strong>Solicitud de servicios de transporte</strong>: creación y envío de solicitudes de servicio con detalle de rutas, fechas, número de pasajeros y requisitos especiales.</li>
        <li><strong>Visualización de cotizaciones</strong>: acceso a propuestas económicas generadas por AFA Transportes para cada solicitud.</li>
        <li><strong>Seguimiento de servicios</strong>: monitoreo en tiempo real del estado de cada servicio contratado.</li>
        <li><strong>Visualización de ubicación del bus</strong>: seguimiento en mapa del vehículo asignado al servicio activo.</li>
        <li><strong>Carga de pasajeros</strong>: registro y gestión de la lista de pasajeros asignados a cada servicio, incluyendo sus datos de contacto y puntos de recogida.</li>
        <li><strong>Descarga de manifiesto final</strong>: obtención del documento oficial que certifica la ejecución del servicio, incluyendo listado de pasajeros transportados, rutas recorridas, horarios y firma del conductor.</li>
        <li><strong>Seguimiento de cargas</strong>: monitoreo del estado y ubicación de cargas o encomiendas transportadas por AFA.</li>
      </ul>
      <p><strong>Datos recopilados:</strong> razón social, RUC, nombre del representante, correo electrónico corporativo, número de teléfono, datos de pasajeros registrados por la empresa, historial de servicios contratados y documentos descargados.</p>
      <p><strong>Permisos requeridos:</strong></p>
      <ul>
        <li><strong>Notificaciones push:</strong> para alertas de confirmación de servicio, inicio de ruta y entrega de manifiesto.</li>
        <li><strong>Almacenamiento:</strong> para descarga de manifiestos y documentos del servicio.</li>
      </ul>

      <h2>4. Finalidad del Tratamiento de Datos</h2>
      <p>Los datos personales recopilados en las distintas plataformas de AFA Transportes serán tratados para las siguientes finalidades:</p>
      <ul>
        <li>Prestación y gestión integral de servicios de transporte de personas y carga.</li>
        <li>Verificación de identidad de conductores y pasajeros mediante código QR.</li>
        <li>Navegación y optimización de rutas de transporte.</li>
        <li>Control de documentación habilitante para la conducción de vehículos.</li>
        <li>Emisión de manifiestos de servicio con valor legal y operativo.</li>
        <li>Facturación electrónica conforme a las normas de SUNAT.</li>
        <li>Gestión de incidencias, accidentes y novedades operativas.</li>
        <li>Mejora continua de la calidad del servicio mediante calificaciones.</li>
        <li>Cumplimiento de obligaciones legales ante SUNAFIL, MTC, SUNAT y otras autoridades peruanas.</li>
        <li>Comunicación operativa entre conductores, pasajeros, clientes y personal administrativo.</li>
      </ul>

      <h2>5. Base Legal del Tratamiento</h2>
      <ul>
        <li><strong>Consentimiento del titular:</strong> otorgado al momento del registro en cada plataforma.</li>
        <li><strong>Ejecución de contrato:</strong> para cumplir la relación laboral con conductores o el contrato de servicio con clientes.</li>
        <li><strong>Obligación legal:</strong> cuando la normativa peruana exige el tratamiento de ciertos datos.</li>
        <li><strong>Interés legítimo:</strong> para fines operativos internos que no comprometan los derechos del titular.</li>
      </ul>

      <h2>6. Transferencia Internacional de Datos</h2>
      <p>AFA Transportes utiliza los siguientes servicios tecnológicos de terceros con sede fuera del Perú:</p>
      <ul>
        <li><strong>Supabase Inc.</strong> (EE.UU.) — base de datos PostgreSQL y autenticación segura, certificado SOC 2 Type II.</li>
        <li><strong>Vercel Inc.</strong> (EE.UU.) — alojamiento de la plataforma web con infraestructura de alta disponibilidad.</li>
        <li><strong>Google LLC</strong> (EE.UU.) — Firebase Cloud Messaging para notificaciones push; Google Maps y Waze para navegación.</li>
      </ul>
      <p>Todas las transferencias internacionales se realizan bajo garantías adecuadas de protección, en cumplimiento del artículo 15° de la Ley N° 29733 y el Capítulo V del RGPD europeo.</p>

      <h2>7. Conservación de los Datos</h2>
      <p>Los datos personales serán conservados durante el tiempo necesario para cumplir con las finalidades descritas y los plazos legales establecidos por la normativa peruana (tributaria, laboral y comercial). Finalizada la relación con el usuario, los datos serán bloqueados y posteriormente eliminados de forma segura, salvo obligación legal de conservación.</p>

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
      <p>Las aplicaciones de AFA Transportes están destinadas a personas mayores de 18 años. No recopilamos intencionalmente datos de menores de edad. Si detectamos que un menor ha proporcionado datos sin autorización, procederemos a su eliminación inmediata.</p>

      <h2>12. Modificaciones a esta Política</h2>
      <p>AFA Transportes se reserva el derecho de modificar esta política en cualquier momento, notificando a los usuarios con al menos <strong>15 días de anticipación</strong> mediante la aplicación o correo electrónico. El uso continuado de las plataformas tras la notificación implicará la aceptación de los cambios.</p>

      <h2>13. Autoridad de Control</h2>
      <p>Si considera que sus derechos han sido vulnerados, puede presentar una reclamación ante la <strong>Autoridad Nacional de Protección de Datos Personales (ANPDP)</strong>, Jr. Scipión Llona N° 350, Miraflores, Lima, Perú.</p>

      <h2>14. Ley Aplicable y Jurisdicción</h2>
      <p>Esta política se rige por las leyes de la República del Perú. Cualquier controversia se somete a los jueces y tribunales de Lima, renunciando a cualquier otro fuero.</p>

      <hr style={{ margin: "40px 0" }} />
      <p style={{ fontSize: 13, color: "#666" }}>© 2026 AFA TOURS PERU S.A.C. — Todos los derechos reservados.<br />
      Ley N° 29733 · D.S. N° 003-2013-JUS · RGPD (UE) 2016/679</p>
    </div>
  )
}