// ──────────────────────────────────────────────────────────────────────────────
// lib/ayuda/modulos-rrhh.ts — Fichas de ayuda de RRHH: Mi Perfil y Control de Personal.
//
// Escrito para la persona que lo usa (el empleado que marca, el jefe de RRHH que aprueba),
// no como documentación técnica. Lo delicado —la foto del rostro es dato biométrico y se
// trata con consentimiento— se dice con esas palabras. Los términos se referencian por
// clave contra lib/ayuda/glosario.ts (marcacion, geocerca, jornada, vacaciones).
// ──────────────────────────────────────────────────────────────────────────────

import type { AyudaModulo } from "@/lib/ayuda/tipos";

export const MODULOS_RRHH: AyudaModulo[] = [
  {
    clave: "mi-perfil",
    rutas: ["/mi-perfil"],
    titulo: "Mi Perfil · tu ficha, tu asistencia y tus vacaciones",
    resumen:
      "Es tu espacio personal en el ERP. Aquí editas tus datos de contacto, marcas tu asistencia con la cámara, ves tu saldo de vacaciones y decides qué consentimientos das. Lo tiene todo usuario del sistema.",
    paraQueSirve: [
      "Mantener al día tu foto, tu teléfono, tu dirección y tu contacto de emergencia.",
      "Marcar entrada, almuerzo y salida desde tu celular con reconocimiento facial.",
      "Ver cuántas horas trabajaste cada día y si tuviste tardanza.",
      "Consultar tu saldo de vacaciones (ganadas por antigüedad menos gozadas).",
      "Otorgar o revocar tu consentimiento biométrico y de monitoreo cuando quieras.",
    ],
    conceptos: ["marcacion", "geocerca", "jornada", "vacaciones"],
    faqs: [
      {
        pregunta: "¿Por qué me pide consentimiento antes de encender la cámara?",
        respuesta:
          "Porque marcar por reconocimiento facial trata tu **imagen del rostro**, y la **Ley N.º 29733** de Protección de Datos Personales la considera un **dato sensible**. La ley exige que tú lo autorices antes: de forma **previa, libre, informada y revocable**.\n\nPor eso la cámara no se enciende hasta que das el consentimiento, y lo puedes **revocar** cuando quieras desde esta misma pantalla. La foto se usa solo para verificar tu identidad al fichar, se guarda cifrada y de acceso restringido.\n\nSi prefieres no usar la cámara, **no estás obligado**: pídele a Recursos Humanos que te marque por **PIN**. Esa marca no es facial y no necesita este consentimiento.",
      },
      {
        pregunta: "El botón para marcar no se activa. ¿Qué me falta?",
        respuesta:
          "El botón se enciende cuando se cumplen dos cosas, y debajo del botón dice cuál falta:\n\n• **Rostro detectado** — acércate y mira de frente a la cámara hasta que el recuadro “Rostro” se ponga en verde.\n• **Ubicación lista** — el celular tiene que darte permiso de ubicación. Si lo negaste, aparece un enlace para reintentarlo.\n\nAdemás, si Recursos Humanos configuró la geocerca en modo **bloquea**, tienes que estar dentro del área de la sede. Si solo avisa, puedes marcar igual y queda anotada la distancia.",
      },
      {
        pregunta: "¿Qué puedo editar de mi perfil y qué no?",
        respuesta:
          "Editas: tu **foto**, **fecha de nacimiento**, **teléfono personal**, **dirección** y tu **contacto de emergencia** (nombre, teléfono y parentesco).\n\nNo editas el **correo** ni el **sueldo**: aparecen en gris porque su fuente es otra (tu cuenta de acceso y Recursos Humanos). Si alguno está mal, avísale a RRHH.\n\nUn campo que vacías se **borra** (queda en blanco): sirve para quitar un dato mal puesto.",
      },
      {
        pregunta: "Mi saldo de vacaciones sale en negativo o dice que no se puede calcular. ¿Está mal?",
        respuesta:
          "**El negativo no es un error**: significa que adelantaste vacaciones (gozaste más de lo que llevas ganado). Es una deuda real y se muestra tal cual.\n\nSi dice que **no se pudo calcular**, casi siempre es porque no está registrada tu **fecha de ingreso** en tu ficha, o porque la empresa aún no tiene configurado su régimen laboral. En ese caso no te mostramos un 0 (que se leería como “sin derecho a vacaciones”): te decimos que falta el dato. Avísale a RRHH.",
      },
    ],
    comoHacer: [
      {
        titulo: "Marcar mi entrada del día",
        pasos: [
          "Entra a Mi Perfil → pestaña “Marcar asistencia”.",
          "Si es la primera vez, lee y otorga el consentimiento biométrico.",
          "Pulsa “Encender cámara” y permite cámara y ubicación.",
          "Mira de frente hasta que “Rostro” esté en verde y la ubicación lista.",
          "Pulsa el botón grande (dirá “Marcar entrada”, o el hito que toque).",
        ],
        advertencia: "Si no puedes usar la cámara, no insistas: pídele a RRHH que te marque por PIN.",
      },
    ],
    relacionadas: [{ etiqueta: "Control de Personal (RRHH)", href: "/rrhh" }],
  },
  {
    clave: "rrhh",
    rutas: ["/rrhh"],
    titulo: "Control de Personal · asistencia y ausencias del equipo",
    resumen:
      "Es la pantalla de Recursos Humanos: ver la asistencia del equipo día por día, aprobar o rechazar ausencias, marcar a un empleado que no pudo usar la cámara, y atar a un conductor con su cuenta de usuario. Solo la ve quien tiene el permiso RRHH.",
    paraQueSirve: [
      "Revisar las jornadas de todo el equipo en un día: horas, tardanza y estado.",
      "Aprobar o rechazar solicitudes de vacaciones, permisos y descansos médicos.",
      "Registrar una marca por un empleado (por PIN o manual) cuando falló la cámara.",
      "Vincular un conductor de la flota propia con su usuario del ERP, para que vea su perfil.",
    ],
    conceptos: ["jornada", "marcacion", "geocerca", "vacaciones"],
    faqs: [
      {
        pregunta: "¿De dónde salen las horas y la tardanza que veo en la asistencia del día?",
        respuesta:
          "Se **calculan** a partir de las marcaciones de cada empleado ese día: horas efectivas = (salida − entrada) − almuerzo. La tardanza se mide contra la hora de entrada de referencia más la tolerancia que RRHH configuró.\n\nUn almuerzo con un asterisco (*) significa que no se marcó el par completo (salida y regreso de almuerzo), así que se descontó el tiempo de almuerzo por defecto. Un día “En curso” es uno al que le falta la salida: todavía no cerró.",
      },
      {
        pregunta: "¿Cómo marco a alguien que no pudo usar la cámara?",
        respuesta:
          "En la pestaña **Marca manual**: elige al empleado, el método (**Manual** o **PIN**) y, si quieres, el tipo de marca (si no, el sistema pone el que toca). Esa marca **no es facial**, así que no exige el consentimiento biométrico del empleado.\n\nÚsalo cuando el empleado no dio su consentimiento, no tiene cámara, o la cámara falló. Queda registrada con el método, para que se note que la hizo RRHH y no el propio empleado.",
      },
      {
        pregunta: "¿Para qué sirve “Vincular conductor”? Lo marqué y nada cambia en pantalla.",
        respuesta:
          "Ata un **conductor** de la flota propia con su **cuenta de usuario** del ERP. A partir de ahí, cuando ese conductor entra al sistema, puede ver **su propio perfil** y marcar asistencia — antes el sistema no sabía que ese login correspondía a ese conductor.\n\nNo cambia nada visible en esta pantalla porque solo guarda el enlace; el efecto se nota cuando el conductor entra con su cuenta. Es idempotente: si ya estaba vinculado, te lo dice y no reescribe nada.",
      },
      {
        pregunta: "La pantalla me avisa en ámbar que falta una migración. ¿Qué hago?",
        respuesta:
          "El módulo necesita que alguien con acceso a Supabase corra, **a mano**, el archivo **supabase/rrhh-01-perfil-asistencia.sql** (el despliegue no lo corre solo). Mientras no se corra, las tablas de personal no existen y la pantalla se comporta como si no hubiera datos.\n\nAdemás, para que las **fotos** de marcación se guarden, hay que crear a mano un bucket **privado** llamado `rrhh` en Supabase → Storage (Public = OFF). Si las fotos no cargan, es casi seguro que falta ese bucket.",
      },
    ],
    relacionadas: [
      { etiqueta: "Mi Perfil", href: "/mi-perfil" },
      { etiqueta: "Personal Administrativo", href: "/personal-administrativo" },
      { etiqueta: "Conductores", href: "/conductores" },
    ],
  },
];
