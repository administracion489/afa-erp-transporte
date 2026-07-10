"use client";

export default function Page() {
  return (
    <>
      <title>Manual Portal Cliente · AFA Transportes</title>
      <style jsx global>{`

  :root{
    --c-navy:#0b315f; --c-navy-deep:#071f3d; --c-navy-tint:#EEF2F8; --c-blue:#2563eb;
    --c-ink:#0E1320; --c-ink-2:#1a2233; --c-mute:#6B7280; --c-mute-2:#9AA1AC;
    --c-line:#E7E5DD; --c-line-2:#EFEEE6;
    --c-paper:#FAF8F2; --c-surface:#FFFFFF; --c-soft:#F4F2EA;
    --c-success:#16a34a; --c-success-tint:#E8F5E9;
    --c-warn:#B45309; --c-warn-tint:#FDF3D7; --c-warn-ink:#92400E;
    --c-danger:#B91C1C; --c-danger-tint:#FCEBEA;
    --c-blueacc:#2563eb; --c-blueacc-tint:#E4ECFD; --c-blueacc-deep:#1d4fc4;
    --font: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
  }
  @media (prefers-color-scheme: dark){
    :root{
      --c-navy:#5b8def; --c-navy-deep:#3b5d9e; --c-navy-tint:rgba(91,141,239,.14); --c-blue:#7aa9ff;
      --c-ink:#F4F6FB; --c-ink-2:#DDE3EF; --c-mute:rgba(255,255,255,.62); --c-mute-2:rgba(255,255,255,.4);
      --c-line:rgba(255,255,255,.1); --c-line-2:rgba(255,255,255,.06);
      --c-paper:#0B0F1A; --c-surface:#141B2D; --c-soft:#1A2238;
      --c-success:#34d399; --c-success-tint:rgba(52,211,153,.15);
      --c-warn:#fbbf24; --c-warn-tint:rgba(251,191,36,.15); --c-warn-ink:#FCD34D;
      --c-danger:#f87171; --c-danger-tint:rgba(248,113,113,.18);
      --c-blueacc:#7aa9ff; --c-blueacc-tint:rgba(122,169,255,.16); --c-blueacc-deep:#7aa9ff;
    }
  }
  :root[data-theme="dark"]{
    --c-navy:#5b8def; --c-navy-deep:#3b5d9e; --c-navy-tint:rgba(91,141,239,.14); --c-blue:#7aa9ff;
    --c-ink:#F4F6FB; --c-ink-2:#DDE3EF; --c-mute:rgba(255,255,255,.62); --c-mute-2:rgba(255,255,255,.4);
    --c-line:rgba(255,255,255,.1); --c-line-2:rgba(255,255,255,.06);
    --c-paper:#0B0F1A; --c-surface:#141B2D; --c-soft:#1A2238;
    --c-success:#34d399; --c-success-tint:rgba(52,211,153,.15);
    --c-warn:#fbbf24; --c-warn-tint:rgba(251,191,36,.15); --c-warn-ink:#FCD34D;
    --c-danger:#f87171; --c-danger-tint:rgba(248,113,113,.18);
    --c-blueacc:#7aa9ff; --c-blueacc-tint:rgba(122,169,255,.16); --c-blueacc-deep:#7aa9ff;
  }
  :root[data-theme="light"]{
    --c-navy:#0b315f; --c-navy-deep:#071f3d; --c-navy-tint:#EEF2F8; --c-blue:#2563eb;
    --c-ink:#0E1320; --c-ink-2:#1a2233; --c-mute:#6B7280; --c-mute-2:#9AA1AC;
    --c-line:#E7E5DD; --c-line-2:#EFEEE6;
    --c-paper:#FAF8F2; --c-surface:#FFFFFF; --c-soft:#F4F2EA;
    --c-success:#16a34a; --c-success-tint:#E8F5E9;
    --c-warn:#B45309; --c-warn-tint:#FDF3D7; --c-warn-ink:#92400E;
    --c-danger:#B91C1C; --c-danger-tint:#FCEBEA;
    --c-blueacc:#2563eb; --c-blueacc-tint:#E4ECFD; --c-blueacc-deep:#1d4fc4;
  }

  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{background:var(--c-paper); color:var(--c-ink); font-family:var(--font); line-height:1.55; -webkit-font-smoothing:antialiased;}
  h1,h2,h3{text-wrap:balance; font-weight:800; letter-spacing:-.01em; color:var(--c-ink);}
  a{color:var(--c-navy);}
  .shell{max-width:820px; margin:0 auto; padding:0 20px 80px;}

  .hero{background:linear-gradient(160deg, var(--c-navy) 0%, var(--c-navy-deep) 100%); color:#fff; padding:36px 20px 30px; margin-bottom:28px;}
  .hero-inner{max-width:820px; margin:0 auto; display:flex; flex-direction:column; gap:16px;}
  .brandmark .word{font-size:26px; font-weight:800; letter-spacing:.01em; line-height:1;}
  .role-tag{display:inline-flex; align-items:center; gap:6px; align-self:flex-start; background:var(--c-blueacc); color:#fff; font-weight:700; font-size:12px; letter-spacing:.08em; text-transform:uppercase; padding:4px 10px 4px 8px; border-radius:99px;}
  .role-tag::before{content:"●"; font-size:8px;}
  .hero h1{color:#fff; font-size:clamp(26px,4vw,36px); margin:6px 0 2px;}
  .hero p.lead{margin:0; color:rgba(255,255,255,.8); font-size:16px; max-width:56ch;}
  .hero .meta{display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;}
  .meta-chip{background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.16); color:rgba(255,255,255,.85); font-size:12.5px; padding:4px 10px; border-radius:99px; font-variant-numeric:tabular-nums;}

  .toc{display:flex; flex-wrap:wrap; gap:8px; margin:0 0 34px; padding:14px; background:var(--c-surface); border:1px solid var(--c-line); border-radius:14px;}
  .toc a{font-size:13.5px; font-weight:600; color:var(--c-ink-2); text-decoration:none; background:var(--c-soft); padding:6px 12px; border-radius:99px; border:1px solid var(--c-line);}
  .toc a:hover{border-color:var(--c-blueacc); color:var(--c-blueacc-deep);}

  section.block{margin-bottom:46px; scroll-margin-top:20px;}
  .eyebrow{font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase; color:var(--c-blueacc-deep); margin:0 0 6px;}
  section.block h2{font-size:22px; margin:0 0 14px;}
  section.block > p.intro{color:var(--c-mute); margin:-6px 0 20px; max-width:64ch;}

  .steps{display:flex; flex-direction:column; gap:12px;}
  .step{display:flex; gap:14px; background:var(--c-surface); border:1px solid var(--c-line); border-radius:14px; padding:16px 18px;}
  .step-num{flex:none; width:30px; height:30px; border-radius:50%; background:var(--c-blueacc-tint); color:var(--c-blueacc-deep); font-weight:800; font-size:14px; display:flex; align-items:center; justify-content:center; font-variant-numeric:tabular-nums;}
  .step-body h3{font-size:15.5px; margin:2px 0 4px;}
  .step-body p{margin:0; color:var(--c-ink-2); font-size:14.5px;}
  .step-body p + p{margin-top:6px;}

  .ui{display:inline-flex; align-items:center; gap:5px; font-weight:700; font-size:12.5px; padding:3px 9px; border-radius:8px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace; white-space:nowrap;}
  .ui.navy{background:var(--c-navy-tint); color:var(--c-navy);}
  .ui.success{background:var(--c-success-tint); color:var(--c-success);}
  .ui.warn{background:var(--c-warn-tint); color:var(--c-warn-ink);}
  .ui.danger{background:var(--c-danger-tint); color:var(--c-danger);}
  .ui.blueacc{background:var(--c-blueacc-tint); color:var(--c-blueacc-deep);}
  .ui.neutral{background:var(--c-soft); color:var(--c-mute);}

  .callout{border-radius:12px; padding:14px 16px; font-size:14.5px; margin-top:16px; display:flex; gap:10px; align-items:flex-start;}
  .callout.info{background:var(--c-navy-tint); color:var(--c-navy);}
  .callout.warn{background:var(--c-warn-tint); color:var(--c-warn-ink);}
  .callout .ic{flex:none; font-size:16px; line-height:1.3;}

  .tour{display:flex; flex-direction:column; gap:10px;}
  .tour-row{display:grid; grid-template-columns:28px 1fr; gap:12px; background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:14px 16px;}
  .tour-row .letter{width:28px; height:28px; border-radius:8px; background:var(--c-navy); color:#fff; font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center;}
  .tour-row h3{margin:0 0 4px; font-size:15px;}
  .tour-row p{margin:0; font-size:14px; color:var(--c-ink-2);}

  .screens{display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;}
  .screen-card{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:16px;}
  .screen-card .tag{font-size:11.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--c-blueacc-deep);}
  .screen-card h3{margin:4px 0 6px; font-size:15px;}
  .screen-card p{margin:0; font-size:13.5px; color:var(--c-mute);}

  .faq details{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:4px 16px; margin-bottom:10px;}
  .faq summary{cursor:pointer; font-weight:700; font-size:15px; padding:12px 0; list-style:none; display:flex; justify-content:space-between; align-items:center; gap:12px;}
  .faq summary::-webkit-details-marker{display:none;}
  .faq summary::after{content:"+"; color:var(--c-blueacc-deep); font-size:20px; font-weight:400; flex:none;}
  .faq details[open] summary::after{content:"–";}
  .faq .a{margin:0 0 14px; color:var(--c-ink-2); font-size:14.5px;}
  .faq .a b{color:var(--c-ink);}

  .cheatsheet{background:var(--c-navy); color:#fff; border-radius:18px; padding:26px 26px 22px; position:relative;}
  .cheatsheet h2{color:#fff; font-size:21px; margin:0 0 2px;}
  .cheatsheet .sub{color:rgba(255,255,255,.68); font-size:13.5px; margin:0 0 18px;}
  .cs-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px;}
  .cs-list li{display:flex; gap:12px; align-items:flex-start; font-size:14.5px;}
  .cs-list .n{flex:none; width:24px; height:24px; border-radius:50%; background:var(--c-blueacc); color:#fff; font-weight:800; font-size:12.5px; display:flex; align-items:center; justify-content:center; font-variant-numeric:tabular-nums;}
  .cs-list b{color:#fff;}
  .cs-list span{color:rgba(255,255,255,.75);}
  .cs-warn{margin-top:18px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14); border-radius:10px; padding:12px 14px; font-size:13.5px; color:rgba(255,255,255,.85);}
  .print-btn{margin-top:18px; background:var(--c-blueacc); color:#fff; border:none; font-weight:700; font-size:13.5px; padding:9px 16px; border-radius:99px; cursor:pointer;}
  .print-btn:hover{filter:brightness(1.08);}

  .shots{display:flex; gap:18px; flex-wrap:wrap; margin:18px 0 6px; justify-content:center;}
  .shots.one{justify-content:flex-start;}
  figure.shot{margin:0; flex:0 0 auto; width:230px; text-align:center;}
  figure.shot img{width:100%; display:block; border-radius:16px; border:1px solid var(--c-line); box-shadow:0 10px 28px rgba(11,49,95,.14);}
  figure.shot figcaption{margin-top:9px; font-size:12px; color:var(--c-mute); font-style:italic;}

  footer{text-align:center; color:var(--c-mute); font-size:12.5px; margin-top:40px;}

  @media print{
    body{background:#fff;}
    .no-print, .hero, .toc, .shots{display:none !important;}
    section.block{display:none !important;}
    #hoja-bolsillo{display:block !important; margin:0;}
    .cheatsheet{background:#fff !important; color:#000 !important; border:2px solid #000;}
    .cheatsheet h2, .cs-list b{color:#000 !important;}
    .cheatsheet .sub, .cs-list span, .cs-warn{color:#333 !important;}
    .cs-list .n{background:#000 !important; color:#fff !important;}
    .print-btn{display:none !important;}
  }
  :focus-visible{outline:2px solid var(--c-blueacc); outline-offset:2px;}

      `}</style>
      <div dangerouslySetInnerHTML={{ __html: `

<header class="hero">
  <div class="hero-inner">
    <div class="brandmark"><div class="word"><b>AFA <span style="font-weight:600;">Transportes</span></b></div></div>
    <span class="role-tag">Portal Cliente</span>
    <h1>Manual de uso — Portal Cliente</h1>
    <p class="lead">Guía para la empresa que contrata el servicio: ver sus viajes en vivo, su historial, su facturación y sus documentos.</p>
    <div class="meta">
      <span class="meta-chip">Capacitación · 09/07/2026</span>
      <span class="meta-chip">Basado en la versión actual del portal</span>
    </div>
  </div>
</header>

<div class="shell">
  <nav class="toc no-print">
    <a href="#antes">0 · Antes de empezar</a>
    <a href="#ingresar">1 · Ingresar</a>
    <a href="#dashboard">2 · Dashboard</a>
    <a href="#envivo">3 · “En vivo”</a>
    <a href="#historial">4 · Historial</a>
    <a href="#facturacion">5 · Facturación</a>
    <a href="#documentos">6 · Documentos</a>
    <a href="#cuenta">7 · Cuenta</a>
    <a href="#faq">Preguntas frecuentes</a>
    <a href="#hoja-bolsillo">Hoja de bolsillo</a>
  </nav>

  <section class="block" id="antes">
    <p class="eyebrow">Antes de empezar</p>
    <h2>Qué es y quién lo usa</h2>
    <p class="intro">El Portal Cliente es para la <b>empresa que contrata</b> el servicio de transporte con AFA — no es la app que usan sus trabajadores para viajar (esa es la <a href="/manuales/pasajero" target="_blank">App Pasajero</a>). Aquí ve sus viajes en vivo, su historial, su facturación y sus documentos, todo en un solo lugar.</p>
    <div class="callout info"><span class="ic">ℹ️</span><div>Si tus trabajadores necesitan saber cómo usar su app cuando viajan, pásales el <a href="/manuales/pasajero" target="_blank">Manual de la App Pasajero</a> — está pensado para ellos, no para ti.</div></div>
  </section>

  <section class="block" id="ingresar">
    <p class="eyebrow">Paso 1</p>
    <h2>Ingresar al portal</h2>
    <div class="steps">
      <div class="step"><div class="step-num">1</div><div class="step-body"><h3>RUC de tu empresa</h3><p>El número con el que AFA registró tu contrato.</p></div></div>
      <div class="step"><div class="step-num">2</div><div class="step-body"><h3>Tu documento</h3><p>Elige el tipo (DNI, carné de extranjería o celular) y escribe el número — identifica a la persona, no solo a la empresa.</p></div></div>
      <div class="step"><div class="step-num">3</div><div class="step-body"><h3>Tu contraseña</h3><p>Toca <span class="ui navy">Ingresar</span>. ¿La olvidaste? Usa “¿Olvidaste tu contraseña?” para recuperarla en dos pasos.</p></div></div>
    </div>
    <div class="callout info"><span class="ic">ℹ️</span><div>Tu sesión dura <b>8 horas</b>. Si varias personas de tu empresa necesitan entrar, pide que te den de alta como usuario adicional (ver sección “Cuenta”).</div></div>
    <div class="shots one"><figure class="shot"><img src="/manuales/portal-cliente/01-login.jpg" alt="Pantalla de ingreso del Portal Cliente"><figcaption>Pantalla real de ingreso</figcaption></figure></div>
  </section>

  <section class="block" id="dashboard">
    <p class="eyebrow">Tu pantalla principal</p>
    <h2>Dashboard</h2>
    <p class="intro">Resumen ejecutivo de tu operación con AFA: cuántos servicios tienes hoy, cuáles están en curso, y accesos directos a lo que más usas.</p>
    <div class="tour">
      <div class="tour-row"><div class="letter">A</div><div><h3>Saludo y resumen</h3><p>Cuántos servicios están en ruta, cuántos programados esta semana, y si hay alguna alerta activa.</p></div></div>
      <div class="tour-row"><div class="letter">B</div><div><h3>Accesos rápidos</h3><p><span class="ui navy">Exportar resumen</span> y <span class="ui navy">Solicitar servicio</span>, arriba a la derecha.</p></div></div>
      <div class="tour-row"><div class="letter">C</div><div><h3>Tarjeta de servicio en curso</h3><p>Si tienes un viaje activo, aquí ves su ruta, hora, velocidad y un botón directo <span class="ui navy">Ver GPS</span>.</p></div></div>
    </div>
    <div class="shots one"><figure class="shot"><img src="/manuales/portal-cliente/02-dashboard.jpg" alt="Pantalla Dashboard del Portal Cliente"><figcaption>Dashboard con servicio en curso</figcaption></figure></div>
  </section>

  <section class="block" id="envivo">
    <p class="eyebrow">Pestaña “En vivo”</p>
    <h2>Ver tu vehículo en tiempo real</h2>
    <p class="intro">Mapa con la posición real de tu(s) vehículo(s) contratado(s), mientras el servicio está en curso.</p>
    <div class="steps">
      <div class="step"><div class="step-num">✓</div><div class="step-body"><h3>Lista de servicios en vivo</h3><p>Toca un servicio de la lista superior para centrar el mapa en esa unidad.</p></div></div>
      <div class="step"><div class="step-num">✓</div><div class="step-body"><h3>Velocidad y última señal</h3><p>Tarjetas con la velocidad actual y la hora de la última posición recibida — si la señal es vieja, lo vas a notar aquí.</p></div></div>
    </div>
    <div class="shots one"><figure class="shot"><img src="/manuales/portal-cliente/03-envivo.jpg" alt="Pantalla En vivo con mapa GPS del vehículo"><figcaption>Mapa en vivo del vehículo contratado</figcaption></figure></div>
  </section>

  <section class="block" id="historial">
    <p class="eyebrow">Pestaña “Historial”</p>
    <h2>Todos tus servicios contratados</h2>
    <p class="intro">Lista completa de tus reservas, con búsqueda y filtros por estado.</p>
    <div class="tour">
      <div class="tour-row"><div class="letter">1</div><div><h3>Exportar Excel</h3><p>Descarga tu historial completo en <span class="ui navy">.xlsx</span>, ya formateado.</p></div></div>
      <div class="tour-row"><div class="letter">2</div><div><h3>Manifiesto MTC</h3><p>Genera el manifiesto oficial (formato R.D. 1946-2009-MTC-15) de un servicio puntual, listo para imprimir.</p></div></div>
      <div class="tour-row"><div class="letter">3</div><div><h3>Editar manifiesto</h3><p>Dentro del detalle de un servicio puedes agregar o quitar pasajeros, o subir tu propio Excel/CSV con la lista.</p></div></div>
    </div>
    <div class="shots one"><figure class="shot"><img src="/manuales/portal-cliente/04-historial.jpg" alt="Pantalla Historial con lista de servicios"><figcaption>Historial de servicios contratados</figcaption></figure></div>
  </section>

  <section class="block" id="facturacion">
    <p class="eyebrow">Pestaña “Facturación”</p>
    <h2>Tus facturas, en un solo lugar</h2>
    <p class="intro">Consulta de facturas: cuánto pagaste, cuánto debes y qué está vencido.</p>
    <div class="callout info"><span class="ic">ℹ️</span><div>Es <b>solo consulta</b>: el portal no tiene pasarela de pago. Para pagar, sigue el medio que ya usas con AFA (transferencia, depósito, etc.).</div></div>
    <div class="shots one"><figure class="shot"><img src="/manuales/portal-cliente/05-facturacion.jpg" alt="Pantalla Facturación con KPIs de pagos"><figcaption>Resumen de facturación</figcaption></figure></div>
  </section>

  <section class="block" id="documentos">
    <p class="eyebrow">Pestaña “Documentos”</p>
    <h2>Tus contratos y cotizaciones</h2>
    <p class="intro">Documentos que AFA subió para tu empresa (contratos, cotizaciones). Es de <b>solo lectura</b>: tú no puedes subir archivos desde aquí.</p>
    <div class="callout info"><span class="ic">ℹ️</span><div>¿Necesitas un documento que no está aquí? Usa el botón de WhatsApp que aparece en esta misma pantalla — te lo envían directo.</div></div>
  </section>

  <section class="block" id="cuenta">
    <p class="eyebrow">Pestaña “Cuenta”</p>
    <h2>Tu empresa y tus accesos</h2>
    <div class="screens">
      <div class="screen-card"><span class="tag">Empresa</span><h3>Datos fiscales</h3><p>Razón social, RUC y datos de contacto de tu empresa.</p></div>
      <div class="screen-card"><span class="tag">Usuarios y accesos</span><h3>Da de alta a tus colegas</h3><p>Agrega otras personas de tu empresa con su propio usuario y permisos por sección.</p></div>
      <div class="screen-card"><span class="tag">Preferencias</span><h3>Ajustes generales</h3><p>Preferencias del portal para tu cuenta.</p></div>
    </div>
    <div class="callout warn"><span class="ic">⚠️</span><div>Las secciones <b>Notificaciones, Seguridad</b> e <b>Integraciones</b> muestran la interfaz pero todavía no guardan cambios reales ni conectan con sistemas externos — no las presentes como funcionales en la capacitación.</div></div>
  </section>

  <section class="block" id="faq">
    <p class="eyebrow">Resolver dudas rápido</p>
    <h2>Preguntas frecuentes</h2>
    <div class="faq">
      <details open><summary>No recuerdo mi contraseña</summary><p class="a">Usa “¿Olvidaste tu contraseña?” en la pantalla de ingreso — es un proceso de 2 pasos, sin llamar a nadie.</p></details>
      <details><summary>Necesito que otra persona de mi empresa tenga acceso</summary><p class="a">Ve a <b>Cuenta → Usuarios y accesos</b> y agrégala ahí con sus propios datos.</p></details>
      <details><summary>¿Puedo pagar mis facturas desde el portal?</summary><p class="a">No todavía: la pestaña Facturación es solo de consulta. Paga por el medio que ya usas con AFA.</p></details>
      <details><summary>No veo mi bus en el mapa de “En vivo”</summary><p class="a">Solo aparece mientras el servicio está en curso. Si ya inició y no aparece, revisa la hora de “última señal” — si es vieja, escríbenos.</p></details>
      <details><summary>¿Cómo descargo el manifiesto oficial?</summary><p class="a">Desde Historial, abre el servicio y toca “Manifiesto MTC”.</p></details>
    </div>
  </section>

  <section class="block" id="hoja-bolsillo">
    <p class="eyebrow">Para imprimir y dejar a mano</p>
    <h2>Hoja de bolsillo</h2>
    <div class="cheatsheet">
      <h2>Portal Cliente — lo esencial</h2>
      <p class="sub">Resumen de 5 pasos. Imprime esta tarjeta para tu equipo de operaciones.</p>
      <ol class="cs-list">
        <li><span class="n">1</span><div><b>Ingresa</b> <span>con el RUC de tu empresa, tu documento y tu contraseña.</span></div></li>
        <li><span class="n">2</span><div><b>Revisa el Dashboard</b> <span>para ver tus servicios de hoy de un vistazo.</span></div></li>
        <li><span class="n">3</span><div><b>Sigue el viaje en “En vivo”</b> <span>mientras el servicio está en curso.</span></div></li>
        <li><span class="n">4</span><div><b>Exporta o genera el manifiesto</b> <span>desde “Historial” cuando lo necesites.</span></div></li>
        <li><span class="n">5</span><div><b>Da de alta a tu equipo</b> <span>desde “Cuenta → Usuarios y accesos”.</span></div></li>
      </ol>
      <div class="cs-warn">¿Dudas o necesitas un documento? Botón “Ayuda” arriba a la derecha, o WhatsApp al 966 707 225.</div>
      <button class="print-btn no-print" onclick="window.print()">Imprimir esta hoja</button>
    </div>
  </section>

  <footer class="no-print">AFA Transportes — Manual interno de capacitación · Portal Cliente</footer>
</div>
` }} />
    </>
  );
}
