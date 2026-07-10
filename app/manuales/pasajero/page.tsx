"use client";

export default function Page() {
  return (
    <>
      <title>Manual App Pasajero · AFA Transportes</title>
      <style jsx global>{`

  :root{
    --c-navy:#0b315f; --c-navy-deep:#071f3d; --c-navy-tint:#EEF2F8; --c-blue:#2563eb;
    --c-ink:#0E1320; --c-ink-2:#1a2233; --c-mute:#6B7280; --c-mute-2:#9AA1AC;
    --c-line:#E7E5DD; --c-line-2:#EFEEE6;
    --c-paper:#FAF8F2; --c-surface:#FFFFFF; --c-soft:#F4F2EA;
    --c-success:#16a34a; --c-success-tint:#E8F5E9;
    --c-warn:#B45309; --c-warn-tint:#FDF3D7; --c-warn-ink:#92400E;
    --c-danger:#B91C1C; --c-danger-tint:#FCEBEA;
    --c-teal:#12876F; --c-teal-tint:#DCF3EE; --c-teal-deep:#0d6455;
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
      --c-teal:#2FD8B8; --c-teal-tint:rgba(47,216,184,.16); --c-teal-deep:#2FD8B8;
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
    --c-teal:#2FD8B8; --c-teal-tint:rgba(47,216,184,.16); --c-teal-deep:#2FD8B8;
  }
  :root[data-theme="light"]{
    --c-navy:#0b315f; --c-navy-deep:#071f3d; --c-navy-tint:#EEF2F8; --c-blue:#2563eb;
    --c-ink:#0E1320; --c-ink-2:#1a2233; --c-mute:#6B7280; --c-mute-2:#9AA1AC;
    --c-line:#E7E5DD; --c-line-2:#EFEEE6;
    --c-paper:#FAF8F2; --c-surface:#FFFFFF; --c-soft:#F4F2EA;
    --c-success:#16a34a; --c-success-tint:#E8F5E9;
    --c-warn:#B45309; --c-warn-tint:#FDF3D7; --c-warn-ink:#92400E;
    --c-danger:#B91C1C; --c-danger-tint:#FCEBEA;
    --c-teal:#12876F; --c-teal-tint:#DCF3EE; --c-teal-deep:#0d6455;
  }

  *{box-sizing:border-box;}
  html,body{margin:0;padding:0;}
  body{
    background:var(--c-paper); color:var(--c-ink); font-family:var(--font);
    line-height:1.55; -webkit-font-smoothing:antialiased;
  }
  h1,h2,h3{text-wrap:balance; font-weight:800; letter-spacing:-.01em; color:var(--c-ink);}
  a{color:var(--c-navy);}
  .shell{max-width:820px; margin:0 auto; padding:0 20px 80px;}

  .hero{
    background:linear-gradient(160deg, var(--c-navy) 0%, var(--c-navy-deep) 100%);
    color:#fff; padding:36px 20px 30px; margin-bottom:28px;
  }
  .hero-inner{max-width:820px; margin:0 auto; display:flex; flex-direction:column; gap:16px;}
  .brandmark .word{font-size:26px; font-weight:800; letter-spacing:.01em; line-height:1;}
  .role-tag{
    display:inline-flex; align-items:center; gap:6px; align-self:flex-start;
    background:var(--c-teal); color:#00251d; font-weight:700; font-size:12px;
    letter-spacing:.08em; text-transform:uppercase; padding:4px 10px 4px 8px; border-radius:99px;
  }
  .role-tag::before{content:"●"; font-size:8px;}
  .hero h1{color:#fff; font-size:clamp(26px,4vw,36px); margin:6px 0 2px;}
  .hero p.lead{margin:0; color:rgba(255,255,255,.8); font-size:16px; max-width:56ch;}
  .hero .meta{display:flex; gap:10px; flex-wrap:wrap; margin-top:6px;}
  .meta-chip{
    background:rgba(255,255,255,.1); border:1px solid rgba(255,255,255,.16);
    color:rgba(255,255,255,.85); font-size:12.5px; padding:4px 10px; border-radius:99px;
    font-variant-numeric:tabular-nums;
  }

  .toc{
    display:flex; flex-wrap:wrap; gap:8px; margin:0 0 34px; padding:14px;
    background:var(--c-surface); border:1px solid var(--c-line); border-radius:14px;
  }
  .toc a{
    font-size:13.5px; font-weight:600; color:var(--c-ink-2); text-decoration:none;
    background:var(--c-soft); padding:6px 12px; border-radius:99px; border:1px solid var(--c-line);
  }
  .toc a:hover{border-color:var(--c-teal); color:var(--c-teal-deep);}

  section.block{margin-bottom:46px; scroll-margin-top:20px;}
  .eyebrow{
    font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase;
    color:var(--c-teal-deep); margin:0 0 6px;
  }
  section.block h2{font-size:22px; margin:0 0 14px;}
  section.block > p.intro{color:var(--c-mute); margin:-6px 0 20px; max-width:64ch;}

  .steps{display:flex; flex-direction:column; gap:12px;}
  .step{
    display:flex; gap:14px; background:var(--c-surface); border:1px solid var(--c-line);
    border-radius:14px; padding:16px 18px;
  }
  .step-num{
    flex:none; width:30px; height:30px; border-radius:50%; background:var(--c-teal-tint);
    color:var(--c-teal-deep); font-weight:800; font-size:14px; display:flex; align-items:center;
    justify-content:center; font-variant-numeric:tabular-nums;
  }
  .step-body h3{font-size:15.5px; margin:2px 0 4px;}
  .step-body p{margin:0; color:var(--c-ink-2); font-size:14.5px;}
  .step-body p + p{margin-top:6px;}

  .ui{
    display:inline-flex; align-items:center; gap:5px; font-weight:700; font-size:12.5px;
    padding:3px 9px; border-radius:8px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space:nowrap;
  }
  .ui.navy{background:var(--c-navy-tint); color:var(--c-navy);}
  .ui.success{background:var(--c-success-tint); color:var(--c-success);}
  .ui.warn{background:var(--c-warn-tint); color:var(--c-warn-ink);}
  .ui.danger{background:var(--c-danger-tint); color:var(--c-danger);}
  .ui.teal{background:var(--c-teal-tint); color:var(--c-teal-deep);}
  .ui.neutral{background:var(--c-soft); color:var(--c-mute);}

  .legend{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:6px;}
  .legend-item{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:14px 16px;}
  .legend-item .dot-row{display:flex; align-items:center; gap:8px; margin-bottom:6px;}
  .dot{width:11px; height:11px; border-radius:50%; flex:none;}
  .dot.success{background:var(--c-success);} .dot.danger{background:var(--c-danger);} .dot.neutral{background:var(--c-mute-2);}
  .legend-item strong{font-size:14px;}
  .legend-item p{margin:0; font-size:13.5px; color:var(--c-mute);}

  .callout{
    border-radius:12px; padding:14px 16px; font-size:14.5px; margin-top:16px;
    display:flex; gap:10px; align-items:flex-start;
  }
  .callout.info{background:var(--c-navy-tint); color:var(--c-navy);}
  .callout.warn{background:var(--c-warn-tint); color:var(--c-warn-ink);}
  .callout .ic{flex:none; font-size:16px; line-height:1.3;}

  .tour{display:flex; flex-direction:column; gap:10px;}
  .tour-row{
    display:grid; grid-template-columns:28px 1fr; gap:12px; background:var(--c-surface);
    border:1px solid var(--c-line); border-radius:12px; padding:14px 16px;
  }
  .tour-row .letter{
    width:28px; height:28px; border-radius:8px; background:var(--c-navy); color:#fff;
    font-weight:800; font-size:13px; display:flex; align-items:center; justify-content:center;
  }
  .tour-row h3{margin:0 0 4px; font-size:15px;}
  .tour-row p{margin:0; font-size:14px; color:var(--c-ink-2);}

  .screens{display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;}
  .screen-card{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:16px;}
  .screen-card .tag{font-size:11.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--c-teal-deep);}
  .screen-card h3{margin:4px 0 6px; font-size:15px;}
  .screen-card p{margin:0; font-size:13.5px; color:var(--c-mute);}

  .status-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:6px;}
  .status-card{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:14px 16px;}
  .status-card p{margin:8px 0 0; font-size:13.5px; color:var(--c-mute);}

  .faq details{
    background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px;
    padding:4px 16px; margin-bottom:10px;
  }
  .faq summary{
    cursor:pointer; font-weight:700; font-size:15px; padding:12px 0; list-style:none;
    display:flex; justify-content:space-between; align-items:center; gap:12px;
  }
  .faq summary::-webkit-details-marker{display:none;}
  .faq summary::after{content:"+"; color:var(--c-teal-deep); font-size:20px; font-weight:400; flex:none;}
  .faq details[open] summary::after{content:"–";}
  .faq .a{margin:0 0 14px; color:var(--c-ink-2); font-size:14.5px;}
  .faq .a b{color:var(--c-ink);}

  .cheatsheet{
    background:var(--c-navy); color:#fff; border-radius:18px; padding:26px 26px 22px;
    position:relative;
  }
  .cheatsheet h2{color:#fff; font-size:21px; margin:0 0 2px;}
  .cheatsheet .sub{color:rgba(255,255,255,.68); font-size:13.5px; margin:0 0 18px;}
  .cs-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px;}
  .cs-list li{display:flex; gap:12px; align-items:flex-start; font-size:14.5px;}
  .cs-list .n{
    flex:none; width:24px; height:24px; border-radius:50%; background:var(--c-teal); color:#00251d;
    font-weight:800; font-size:12.5px; display:flex; align-items:center; justify-content:center;
    font-variant-numeric:tabular-nums;
  }
  .cs-list b{color:#fff;}
  .cs-list span{color:rgba(255,255,255,.75);}
  .cs-warn{
    margin-top:18px; background:rgba(255,255,255,.08); border:1px solid rgba(255,255,255,.14);
    border-radius:10px; padding:12px 14px; font-size:13.5px; color:rgba(255,255,255,.85);
  }
  .print-btn{
    margin-top:18px; background:var(--c-teal); color:#00251d; border:none; font-weight:700;
    font-size:13.5px; padding:9px 16px; border-radius:99px; cursor:pointer;
  }
  .print-btn:hover{filter:brightness(1.05);}

  footer{text-align:center; color:var(--c-mute); font-size:12.5px; margin-top:40px;}

  /* ---------- Real screenshots ---------- */
  .shots{display:flex; gap:18px; flex-wrap:wrap; margin:18px 0 6px; justify-content:center;}
  .shots.one{justify-content:flex-start;}
  figure.shot{
    margin:0; flex:0 0 auto; width:230px; text-align:center;
  }
  figure.shot img{
    width:100%; display:block; border-radius:16px; border:1px solid var(--c-line);
    box-shadow:0 10px 28px rgba(11,49,95,.14);
  }
  figure.shot figcaption{
    margin-top:9px; font-size:12px; color:var(--c-mute); font-style:italic;
  }
  @media print{ .shots{display:none !important;} }

  @media print{
    body{background:#fff;}
    .no-print, .hero, .toc{display:none !important;}
    section.block{display:none !important;}
    #hoja-bolsillo{display:block !important; margin:0;}
    .cheatsheet{background:#fff !important; color:#000 !important; border:2px solid #000;}
    .cheatsheet h2, .cs-list b{color:#000 !important;}
    .cheatsheet .sub, .cs-list span, .cs-warn{color:#333 !important;}
    .cs-list .n{background:#000 !important; color:#fff !important;}
    .print-btn{display:none !important;}
  }

  :focus-visible{outline:2px solid var(--c-teal); outline-offset:2px;}

      `}</style>
      <div dangerouslySetInnerHTML={{ __html: `

<header class="hero">
  <div class="hero-inner">
    <div class="brandmark">
      <div class="word"><b>AFA <span style="font-weight:600;">Transportes</span></b></div>
    </div>
    <span class="role-tag">App Pasajero</span>
    <h1>Manual de uso — App Pasajero</h1>
    <p class="lead">Guía paso a paso de la aplicación que usan tus pasajeros para ver su bus en vivo, elegir paradero y avisar cualquier problema.</p>
    <div class="meta">
      <span class="meta-chip">Capacitación · 09/07/2026</span>
      <span class="meta-chip">Basado en la versión actual de la app</span>
    </div>
  </div>
</header>

<div class="shell">

  <nav class="toc no-print">
    <a href="#antes">0 · Antes de empezar</a>
    <a href="#ingresar">1 · Ingresar</a>
    <a href="#mi-ruta">2 · Pantalla “Mi ruta”</a>
    <a href="#paradero">3 · Elegir paradero</a>
    <a href="#estados">4 · Estados del viaje</a>
    <a href="#notificaciones">5 · Notificaciones</a>
    <a href="#chat-qr">6 · Chat y código QR</a>
    <a href="#perfil">7 · Mis datos</a>
    <a href="#faq">Preguntas frecuentes</a>
    <a href="#hoja-bolsillo">Hoja de bolsillo</a>
  </nav>

  <section class="block" id="antes">
    <p class="eyebrow">Antes de empezar</p>
    <h2>Qué es y qué necesita el pasajero</h2>
    <p class="intro">La app Pasajero le permite a cada persona ver en tiempo real dónde está su bus, confirmar su paradero, chatear con la central y mostrar su código QR al subir.</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">✓</div>
        <div class="step-body"><h3>Su acceso</h3><p>Usuario = <b>número de documento (DNI)</b>. PIN = <b>4 dígitos</b> (por defecto los últimos 4 del DNI, salvo que el operador lo haya cambiado).</p></div>
      </div>
      <div class="step">
        <div class="step-num">✓</div>
        <div class="step-body"><h3>Su reserva</h3><p>Debe tener una reserva o servicio asignado para ese día; si no la tiene, la app le ofrece elegirla.</p></div>
      </div>
    </div>
    <div class="callout info">
      <span class="ic">ℹ️</span>
      <div>No confundir con el <b>Portal Cliente</b> (login por empresa/RUC): esa es otra aplicación, para la empresa que contrata el servicio, no para el pasajero final.</div>
    </div>
  </section>

  <section class="block" id="ingresar">
    <p class="eyebrow">Paso 1</p>
    <h2>Ingresar a la app</h2>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body"><h3>Escribe tu número de documento</h3><p>Es tu usuario. No se puede cambiar después: también sirve para cruzarte con el manifiesto oficial.</p></div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body"><h3>Escribe tu PIN de 4 dígitos</h3><p>Si nunca lo cambiaste, son los <b>últimos 4 números de tu documento</b>.</p></div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body"><h3>Tu sesión</h3><p>Queda guardada por 24 horas en el celular; luego te pedirá volver a ingresar.</p></div>
      </div>
    </div>
    <div class="shots one">
      <figure class="shot"><img src="/manuales/pasajero/01-login.jpg" alt="Pantalla real de ingreso del pasajero"><figcaption>Pantalla real de ingreso</figcaption></figure>
    </div>
  </section>

  <section class="block" id="mi-ruta">
    <p class="eyebrow">Tu pantalla principal</p>
    <h2>Pantalla “Mi ruta”</h2>
    <p class="intro">Es la pestaña con la que abre la app. Muestra todo lo relacionado a tu viaje de hoy:</p>
    <div class="tour">
      <div class="tour-row">
        <div class="letter">A</div>
        <div><h3>Mapa en vivo</h3><p>Ubicación del bus, tu paradero y el resto de paraderos de la ruta. Se actualiza cada pocos segundos mientras el viaje está en curso.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">B</div>
        <div><h3>Tu paradero</h3><p>El punto donde te recogen o te dejan, con el vehículo y el conductor asignado.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">C</div>
        <div><h3>Sin ruta asignada</h3><p>Si todavía no tienes un servicio o paradero asignado, la app te ofrece elegir uno disponible ese día.</p></div>
      </div>
    </div>
    <div class="shots one">
      <figure class="shot"><img src="/manuales/pasajero/02-mi-ruta.jpg" alt="Pantalla Mi ruta con mapa en vivo del bus"><figcaption>“Mi ruta” con el bus en vivo</figcaption></figure>
    </div>
  </section>

  <section class="block" id="paradero">
    <p class="eyebrow">Paso 2 (cuando el bus ya salió)</p>
    <h2>Elegir o cambiar tu paradero</h2>
    <p class="intro">Esta opción solo aparece si el operador la habilitó para tu reserva. Si no la ves, significa que tu paradero ya está fijo para ese viaje.</p>
    <div class="callout info">
      <span class="ic">ℹ️</span>
      <div>Los paraderos por los que el bus <b>ya pasó</b> se muestran tachados con <span class="ui neutral">YA PASÓ</span> y no se pueden elegir — con una excepción: tu propio paradero asignado nunca se bloquea, por si el bus ya pasó por ahí sin recogerte.</div>
    </div>
  </section>

  <section class="block" id="estados">
    <p class="eyebrow">Durante el viaje</p>
    <h2>Estados que puedes ver</h2>
    <div class="status-grid">
      <div class="status-card"><span class="ui neutral">Pendiente</span><p>Estás esperando; el bus aún no te ha recogido.</p></div>
      <div class="status-card"><span class="ui success">Embarcado</span><p>Ya subiste. El destino en el mapa cambia a tu última parada y el tiempo estimado se recalcula hacia allá.</p></div>
      <div class="status-card"><span class="ui danger">No abordó / No Show</span><p>El sistema registró que no subiste. Verás un aviso con botones para llamar al conductor o a central, o abrir el chat.</p></div>
      <div class="status-card"><span class="ui neutral">Cancelado</span><p>Tu servicio fue cancelado. Verás un aviso con botón para llamar a central.</p></div>
    </div>
    <div class="callout info">
      <span class="ic">ℹ️</span>
      <div>El estado oficial de “No Show” siempre lo define el despachador desde el sistema central, no la app por sí sola.</div>
    </div>
  </section>

  <section class="block" id="notificaciones">
    <p class="eyebrow">Avisos automáticos</p>
    <h2>Notificaciones</h2>
    <p class="intro">Si el pasajero aceptó recibir notificaciones en su celular, puede recibir avisos como:</p>
    <div class="steps">
      <div class="step"><div class="step-num">🔔</div><div class="step-body"><h3>“Ya salió”</h3><p>Cuando el conductor inicia el recorrido.</p></div></div>
      <div class="step"><div class="step-num">🔔</div><div class="step-body"><h3>“Quedan 2 paradas”</h3><p>A medida que el bus avanza y se acerca.</p></div></div>
      <div class="step"><div class="step-num">🔔</div><div class="step-body"><h3>“Llega en ~5 min” y “TU BUS YA LLEGÓ”</h3><p>Calculado con la posición y velocidad real del vehículo, no con un temporizador fijo.</p></div></div>
      <div class="step"><div class="step-num">🔔</div><div class="step-body"><h3>“Embarque confirmado”</h3><p>Al momento en que el conductor escanea su QR.</p></div></div>
    </div>
    <div class="callout warn">
      <span class="ic">⚠️</span>
      <div>Si un pasajero dice que <b>no le llegan</b> notificaciones, revisa primero que tenga los permisos de notificaciones activados en su celular para la app.</div>
    </div>
  </section>

  <section class="block" id="chat-qr">
    <p class="eyebrow">Herramientas dentro de “Mi ruta”</p>
    <h2>Chat con la central y tu código QR</h2>
    <div class="tour">
      <div class="tour-row">
        <div class="letter">1</div>
        <div><h3>Chat</h3><p>Botón dentro de “Mi ruta” para escribir directo a central o al conductor. Es un chat de ida y vuelta: te pueden responder desde el mismo hilo.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">2</div>
        <div><h3>Pestaña “Pase”</h3><p>Muestra tu pase de embarque con código QR. Al subir al bus, se lo acercas al conductor para que te escanee ahí.</p></div>
      </div>
    </div>
    <div class="shots one">
      <figure class="shot"><img src="/manuales/pasajero/03-pase-qr.jpg" alt="Pantalla del pase de embarque con código QR"><figcaption>Pestaña “Pase” con el QR</figcaption></figure>
    </div>
  </section>

  <section class="block" id="perfil">
    <p class="eyebrow">Pestaña “Perfil”</p>
    <h2>“Mis datos”</h2>
    <p class="intro">El pasajero puede editar: <b>nombre</b>, <b>tipo de documento</b>, <b>edad</b> y <b>correo</b>.</p>
    <div class="callout info">
      <span class="ic">ℹ️</span>
      <div>El <b>número de documento no se puede editar desde la app</b>: es su usuario de acceso y la referencia oficial para el manifiesto. Si está mal, se corrige desde el sistema central, no desde el celular del pasajero.</div>
    </div>
    <div class="shots one">
      <figure class="shot"><img src="/manuales/pasajero/04-perfil.jpg" alt="Pantalla de Mis datos del pasajero"><figcaption>Perfil → “Mis datos”</figcaption></figure>
    </div>
  </section>

  <section class="block" id="faq">
    <p class="eyebrow">Resolver dudas rápido</p>
    <h2>Preguntas frecuentes y errores comunes</h2>
    <div class="faq">
      <details open>
        <summary>El pasajero no puede ingresar</summary>
        <p class="a">Confirma el número de documento exacto y que el PIN sean los <b>últimos 4 dígitos</b> del documento (salvo que ya lo haya cambiado antes). El mensaje de error es igual para “documento no existe” y “PIN incorrecto” por seguridad — no da pistas de cuál es el problema.</p>
      </details>
      <details>
        <summary>No le aparece la opción de cambiar de paradero</summary>
        <p class="a">Es normal: esa opción solo se activa si el operador la habilitó para esa reserva en particular. Si necesita cambiar de paradero, contáctalo por el chat o con central.</p>
      </details>
      <details>
        <summary>No le llegan las notificaciones push</summary>
        <p class="a">Revisa primero los permisos de notificaciones del celular. Si están bien y aun así no llegan, repórtalo — puede requerir revisión desde el sistema.</p>
      </details>
      <details>
        <summary>Quiere ver su historial de viajes anteriores</summary>
        <p class="a">Hoy la app solo tiene 3 pantallas: “Mi ruta”, “Pase” y “Perfil”. Todavía no existe una pantalla de historial de viajes ni bandeja de notificaciones separada — no ofrecer esa función.</p>
      </details>
      <details>
        <summary>Su nombre o correo están mal</summary>
        <p class="a">Puede corregirlos él mismo en Perfil → “Mis datos”. Lo único que no puede tocar ahí es su número de documento.</p>
      </details>
    </div>
  </section>

  <section class="block" id="hoja-bolsillo">
    <p class="eyebrow">Para imprimir y entregar al pasajero</p>
    <h2>Hoja de bolsillo</h2>
    <div class="cheatsheet">
      <h2>App Pasajero — cómo usarla</h2>
      <p class="sub">Resumen de 5 pasos. Imprime esta tarjeta para dejarla en el paradero o entregarla al pasajero nuevo.</p>
      <ol class="cs-list">
        <li><span class="n">1</span><div><b>Ingresa</b> <span>con tu número de documento y tu PIN de 4 dígitos.</span></div></li>
        <li><span class="n">2</span><div><b>Revisa “Mi ruta”</b> <span>para ver en el mapa dónde está tu bus en vivo.</span></div></li>
        <li><span class="n">3</span><div><b>Activa las notificaciones</b> <span>para saber cuándo sale, cuándo se acerca y cuándo llega.</span></div></li>
        <li><span class="n">4</span><div><b>Muestra tu código QR</b> <span>al conductor al subir (pestaña “Pase”).</span></div></li>
        <li><span class="n">5</span><div><b>Usa el chat</b> <span>si tienes un problema o necesitas avisar algo a central.</span></div></li>
      </ol>
      <div class="cs-warn">¿No puedes ingresar? Tu PIN por defecto son los últimos 4 dígitos de tu documento. ¿Problemas? Escribe por el chat o llama a central.</div>
      <button class="print-btn no-print" onclick="window.print()">Imprimir esta hoja</button>
    </div>
  </section>

  <footer class="no-print">AFA Transportes — Manual interno de capacitación · App Pasajero</footer>
</div>
` }} />
    </>
  );
}
