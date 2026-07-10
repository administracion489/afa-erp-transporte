"use client";

export default function Page() {
  return (
    <>
      <title>Manual App Conductor · AFA Transportes</title>
      <style jsx global>{`

  :root{
    --c-navy:#0b315f; --c-navy-deep:#071f3d; --c-navy-tint:#EEF2F8; --c-blue:#2563eb;
    --c-ink:#0E1320; --c-ink-2:#1a2233; --c-mute:#6B7280; --c-mute-2:#9AA1AC;
    --c-line:#E7E5DD; --c-line-2:#EFEEE6;
    --c-paper:#FAF8F2; --c-surface:#FFFFFF; --c-soft:#F4F2EA;
    --c-success:#16a34a; --c-success-tint:#E8F5E9;
    --c-warn:#B45309; --c-warn-tint:#FDF3D7; --c-warn-ink:#92400E;
    --c-danger:#B91C1C; --c-danger-tint:#FCEBEA;
    --c-coral:#E26B47; --c-coral-tint:#FCEEE6;
    --c-gold:#B4790E; --c-gold-tint:#FBEED2; --c-gold-deep:#8a5c09;
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
      --c-coral:#fb7c5b; --c-coral-tint:rgba(251,124,91,.18);
      --c-gold:#F0B429; --c-gold-tint:rgba(240,180,41,.16); --c-gold-deep:#F0B429;
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
    --c-coral:#fb7c5b; --c-coral-tint:rgba(251,124,91,.18);
    --c-gold:#F0B429; --c-gold-tint:rgba(240,180,41,.16); --c-gold-deep:#F0B429;
  }
  :root[data-theme="light"]{
    --c-navy:#0b315f; --c-navy-deep:#071f3d; --c-navy-tint:#EEF2F8; --c-blue:#2563eb;
    --c-ink:#0E1320; --c-ink-2:#1a2233; --c-mute:#6B7280; --c-mute-2:#9AA1AC;
    --c-line:#E7E5DD; --c-line-2:#EFEEE6;
    --c-paper:#FAF8F2; --c-surface:#FFFFFF; --c-soft:#F4F2EA;
    --c-success:#16a34a; --c-success-tint:#E8F5E9;
    --c-warn:#B45309; --c-warn-tint:#FDF3D7; --c-warn-ink:#92400E;
    --c-danger:#B91C1C; --c-danger-tint:#FCEBEA;
    --c-coral:#E26B47; --c-coral-tint:#FCEEE6;
    --c-gold:#B4790E; --c-gold-tint:#FBEED2; --c-gold-deep:#8a5c09;
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

  /* ---------- Hero / brand header ---------- */
  .hero{
    background:linear-gradient(160deg, var(--c-navy) 0%, var(--c-navy-deep) 100%);
    color:#fff; padding:36px 20px 30px; margin-bottom:28px;
  }
  .hero-inner{max-width:820px; margin:0 auto; display:flex; flex-direction:column; gap:16px;}
  .brandmark{display:flex; align-items:center; gap:14px;}
  .brandmark .word{
    font-size:26px; font-weight:800; letter-spacing:.01em; line-height:1;
    display:flex; flex-direction:column; gap:5px;
  }
  .brandmark .word b{font-size:26px;}
  .brandmark .word span{font-size:12px; font-weight:600; letter-spacing:.14em; text-transform:uppercase; color:rgba(255,255,255,.72);}
  .role-tag{
    display:inline-flex; align-items:center; gap:6px; align-self:flex-start;
    background:var(--c-gold); color:#2b1c00; font-weight:700; font-size:12px;
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

  /* ---------- TOC ---------- */
  .toc{
    display:flex; flex-wrap:wrap; gap:8px; margin:0 0 34px; padding:14px;
    background:var(--c-surface); border:1px solid var(--c-line); border-radius:14px;
  }
  .toc a{
    font-size:13.5px; font-weight:600; color:var(--c-ink-2); text-decoration:none;
    background:var(--c-soft); padding:6px 12px; border-radius:99px; border:1px solid var(--c-line);
  }
  .toc a:hover{border-color:var(--c-gold); color:var(--c-gold-deep);}

  /* ---------- Sections ---------- */
  section.block{margin-bottom:46px; scroll-margin-top:20px;}
  .eyebrow{
    font-size:12px; font-weight:700; letter-spacing:.12em; text-transform:uppercase;
    color:var(--c-gold-deep); margin:0 0 6px;
  }
  section.block h2{font-size:22px; margin:0 0 14px;}
  section.block > p.intro{color:var(--c-mute); margin:-6px 0 20px; max-width:64ch;}

  /* ---------- Step cards ---------- */
  .steps{display:flex; flex-direction:column; gap:12px;}
  .step{
    display:flex; gap:14px; background:var(--c-surface); border:1px solid var(--c-line);
    border-radius:14px; padding:16px 18px;
  }
  .step-num{
    flex:none; width:30px; height:30px; border-radius:50%; background:var(--c-gold-tint);
    color:var(--c-gold-deep); font-weight:800; font-size:14px; display:flex; align-items:center;
    justify-content:center; font-variant-numeric:tabular-nums;
  }
  .step-body h3{font-size:15.5px; margin:2px 0 4px;}
  .step-body p{margin:0; color:var(--c-ink-2); font-size:14.5px;}
  .step-body p + p{margin-top:6px;}

  /* ---------- UI quote (mimics real in-app text) ---------- */
  .ui{
    display:inline-flex; align-items:center; gap:5px; font-weight:700; font-size:12.5px;
    padding:3px 9px; border-radius:8px; font-family:ui-monospace, SFMono-Regular, Menlo, monospace;
    white-space:nowrap;
  }
  .ui.navy{background:var(--c-navy-tint); color:var(--c-navy);}
  .ui.success{background:var(--c-success-tint); color:var(--c-success);}
  .ui.warn{background:var(--c-warn-tint); color:var(--c-warn-ink);}
  .ui.danger{background:var(--c-danger-tint); color:var(--c-danger);}
  .ui.gold{background:var(--c-gold-tint); color:var(--c-gold-deep);}
  .ui.neutral{background:var(--c-soft); color:var(--c-mute);}

  /* ---------- Semaphore legend ---------- */
  .legend{display:grid; grid-template-columns:repeat(auto-fit,minmax(220px,1fr)); gap:12px; margin-top:6px;}
  .legend-item{
    background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:14px 16px;
  }
  .legend-item .dot-row{display:flex; align-items:center; gap:8px; margin-bottom:6px;}
  .dot{width:11px; height:11px; border-radius:50%; flex:none;}
  .dot.success{background:var(--c-success);} .dot.warn{background:var(--c-warn);} .dot.neutral{background:var(--c-mute-2);}
  .legend-item strong{font-size:14px;}
  .legend-item p{margin:0; font-size:13.5px; color:var(--c-mute);}

  /* ---------- Callouts ---------- */
  .callout{
    border-radius:12px; padding:14px 16px; font-size:14.5px; margin-top:16px;
    display:flex; gap:10px; align-items:flex-start;
  }
  .callout.info{background:var(--c-navy-tint); color:var(--c-navy);}
  .callout.warn{background:var(--c-warn-tint); color:var(--c-warn-ink);}
  .callout .ic{flex:none; font-size:16px; line-height:1.3;}

  /* ---------- Scan result grid ---------- */
  .scan-grid{display:grid; grid-template-columns:repeat(auto-fit,minmax(230px,1fr)); gap:12px; margin-top:6px;}
  .scan-card{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:14px 16px;}
  .scan-card p{margin:8px 0 0; font-size:13.5px; color:var(--c-mute);}

  /* ---------- Screen tour (Hoy) ---------- */
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

  /* ---------- Other screens grid ---------- */
  .screens{display:grid; grid-template-columns:repeat(auto-fit,minmax(180px,1fr)); gap:12px;}
  .screen-card{background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px; padding:16px;}
  .screen-card .tag{font-size:11.5px; font-weight:700; letter-spacing:.08em; text-transform:uppercase; color:var(--c-gold-deep);}
  .screen-card h3{margin:4px 0 6px; font-size:15px;}
  .screen-card p{margin:0; font-size:13.5px; color:var(--c-mute);}

  /* ---------- FAQ ---------- */
  .faq details{
    background:var(--c-surface); border:1px solid var(--c-line); border-radius:12px;
    padding:4px 16px; margin-bottom:10px;
  }
  .faq summary{
    cursor:pointer; font-weight:700; font-size:15px; padding:12px 0; list-style:none;
    display:flex; justify-content:space-between; align-items:center; gap:12px;
  }
  .faq summary::-webkit-details-marker{display:none;}
  .faq summary::after{content:"+"; color:var(--c-gold-deep); font-size:20px; font-weight:400; flex:none;}
  .faq details[open] summary::after{content:"–";}
  .faq .a{margin:0 0 14px; color:var(--c-ink-2); font-size:14.5px;}
  .faq .a b{color:var(--c-ink);}

  /* ---------- Cheat sheet ---------- */
  .cheatsheet{
    background:var(--c-navy); color:#fff; border-radius:18px; padding:26px 26px 22px;
    position:relative;
  }
  .cheatsheet h2{color:#fff; font-size:21px; margin:0 0 2px;}
  .cheatsheet .sub{color:rgba(255,255,255,.68); font-size:13.5px; margin:0 0 18px;}
  .cs-list{list-style:none; margin:0; padding:0; display:flex; flex-direction:column; gap:10px;}
  .cs-list li{display:flex; gap:12px; align-items:flex-start; font-size:14.5px;}
  .cs-list .n{
    flex:none; width:24px; height:24px; border-radius:50%; background:var(--c-gold); color:#2b1c00;
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
    margin-top:18px; background:var(--c-gold); color:#2b1c00; border:none; font-weight:700;
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

  :focus-visible{outline:2px solid var(--c-gold); outline-offset:2px;}

      `}</style>
      <div dangerouslySetInnerHTML={{ __html: `

<header class="hero">
  <div class="hero-inner">
    <div class="brandmark">
      <div class="word"><b>AFA <span style="font-weight:600;">Transportes</span></b></div>
    </div>
    <span class="role-tag">App Conductor</span>
    <h1>Manual de uso — App Conductor</h1>
    <p class="lead">Guía paso a paso de la aplicación que usas en tu celular para conectarte, iniciar tus recorridos y embarcar pasajeros.</p>
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
    <a href="#pantalla-hoy">2 · Pantalla “Hoy”</a>
    <a href="#iniciar">3 · Iniciar el recorrido</a>
    <a href="#durante">4 · Durante el viaje</a>
    <a href="#finalizar">5 · Finalizar</a>
    <a href="#equivoco">6 · Si me equivoco</a>
    <a href="#otras">7 · Otras pantallas</a>
    <a href="#faq">Preguntas frecuentes</a>
    <a href="#hoja-bolsillo">Hoja de bolsillo</a>
  </nav>

  <section class="block" id="antes">
    <p class="eyebrow">Antes de empezar</p>
    <h2>Qué es y qué necesitas</h2>
    <p class="intro">La app Conductor es tu herramienta de trabajo diario: en ella te conectas, revisas tu ruta del día, inicias el viaje y embarcas a cada pasajero con su código QR.</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">✓</div>
        <div class="step-body">
          <h3>Tu acceso</h3>
          <p>Tu <b>DNI</b> y un <b>PIN de 4 dígitos</b> que te entrega el administrador. No necesitas correo ni contraseña larga.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">✓</div>
        <div class="step-body">
          <h3>Ubicación en modo preciso</h3>
          <p>Antes de salir, revisa que la <b>Ubicación</b> de tu celular esté activada en modo <b>“Ubicación exacta / precisa”</b> (no “aproximada”). Esto evita bloqueos al iniciar el viaje.</p>
        </div>
      </div>
      <div class="step">
        <div class="step-num">✓</div>
        <div class="step-body">
          <h3>Batería</h3>
          <p>Sal con buena carga. La app te avisa con un semáforo de colores si tu equipo puede cortar el rastreo en segundo plano.</p>
        </div>
      </div>
    </div>
  </section>

  <section class="block" id="ingresar">
    <p class="eyebrow">Paso 1</p>
    <h2>Ingresar a la app</h2>
    <p class="intro">Se abre siempre en la pantalla de acceso. La sesión dura <b>12 horas</b>; pasado ese tiempo te pedirá ingresar de nuevo.</p>
    <div class="steps">
      <div class="step">
        <div class="step-num">1</div>
        <div class="step-body"><h3>Escribe tu DNI</h3><p>El mismo número con el que te registró AFA.</p></div>
      </div>
      <div class="step">
        <div class="step-num">2</div>
        <div class="step-body"><h3>Escribe tu PIN de 4 dígitos</h3><p>Toca <span class="ui navy">Ingresar</span>.</p></div>
      </div>
      <div class="step">
        <div class="step-num">3</div>
        <div class="step-body"><h3>¿Olvidaste tu PIN o quieres cambiarlo?</h3><p>Ve a la pestaña <b>Perfil</b> → <span class="ui navy">Cambiar PIN</span>. Si no puedes entrar, avisa al administrador.</p></div>
      </div>
    </div>
    <div class="shots one">
      <figure class="shot"><img src="/manuales/conductor/01-login.jpg" alt="Pantalla real de ingreso del conductor"><figcaption>Pantalla real de ingreso</figcaption></figure>
    </div>
  </section>

  <section class="block" id="pantalla-hoy">
    <p class="eyebrow">Tu pantalla principal</p>
    <h2>Pantalla “Hoy”</h2>
    <p class="intro">Todo lo que necesitas para arrancar el día vive aquí. Recorre cada elemento de arriba hacia abajo:</p>
    <div class="tour">
      <div class="tour-row">
        <div class="letter">A</div>
        <div><h3>Tu vehículo</h3><p>Botón con placa y modelo. Si solo tienes una unidad asignada ese día, ya aparece marcada sola; si tienes más de una, tócalo para elegir.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">B</div>
        <div><h3>Chip “Pre‑viaje”</h3><p><span class="ui success">Listo</span> cuando ya completaste la revisión previa del vehículo, o <span class="ui warn">Pendiente</span> si aún falta. Tócalo para abrir el checklist.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">C</div>
        <div><h3>“Desliza para conectarte”</h3><p>Es el interruptor maestro del GPS: mientras no lo deslizas, el sistema no te ubica ni te marca disponible. Al conectarte aparece la tarjeta <span class="ui success">Conectado · GPS activo</span>. Para desconectarte, tócala y confirma.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">D</div>
        <div><h3>Semáforo de rastreo</h3><p>Te dice si tu celular puede mantener el GPS encendido en segundo plano sin que Android lo apague (ver leyenda abajo).</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">E</div>
        <div><h3>Agenda del día</h3><p>Usa las flechas para moverte entre días. La <b>tarjeta azul grande</b> es tu próximo viaje, con cuenta regresiva y el botón <span class="ui navy">Iniciar recorrido</span>.</p></div>
      </div>
    </div>

    <div class="legend">
      <div class="legend-item">
        <div class="dot-row"><span class="dot success"></span><strong>Verde — Rastreo protegido</strong></div>
        <p>Batería exenta de ahorro de energía + ubicación precisa. Todo listo.</p>
      </div>
      <div class="legend-item">
        <div class="dot-row"><span class="dot warn"></span><strong>Ámbar — Revisar</strong></div>
        <p>Falta exentar la batería, la ubicación está en “aproximada”, o la señal GPS es débil.</p>
      </div>
      <div class="legend-item">
        <div class="dot-row"><span class="dot neutral"></span><strong>Gris — Ajustes de rastreo</strong></div>
        <p>Tu equipo aún no tiene el chequeo automático instalado. No es un error tuyo; solo informa.</p>
      </div>
    </div>
    <div class="shots">
      <figure class="shot"><img src="/manuales/conductor/02-hoy.jpg" alt="Pantalla Hoy antes de conectarte"><figcaption>“Hoy” recién ingresado</figcaption></figure>
      <figure class="shot"><img src="/manuales/conductor/03-conectado.jpg" alt="Pantalla Hoy ya conectado, GPS activo"><figcaption>Ya conectado · GPS activo</figcaption></figure>
    </div>
  </section>

  <section class="block" id="iniciar">
    <p class="eyebrow">Paso 2</p>
    <h2>Iniciar el recorrido</h2>
    <p class="intro">El botón <span class="ui navy">Iniciar recorrido</span> solo avanza si se cumple todo esto:</p>
    <div class="steps">
      <div class="step"><div class="step-num">✓</div><div class="step-body"><h3>Vehículo elegido</h3><p>Placa confirmada en la pantalla “Hoy”.</p></div></div>
      <div class="step"><div class="step-num">✓</div><div class="step-body"><h3>Checklist de pre‑viaje completo</h3><p>Chip en <span class="ui success">Listo</span>.</p></div></div>
      <div class="step"><div class="step-num">✓</div><div class="step-body"><h3>Ubicación</h3><p>Si tu GPS está en modo “aproximada” (±150 m), la app te muestra un aviso antes de dejarte avanzar.</p></div></div>
    </div>
    <div class="callout warn">
      <span class="ic">⚠️</span>
      <div><b>Si tu ubicación está en “aproximada”</b>, aparece un mensaje con dos botones: <span class="ui gold">Activar ubicación precisa</span> (recomendado, actívalo siempre que puedas) o <span class="ui neutral">Iniciar de todos modos</span> (te deja continuar igual, con rastreo menos exacto — úsalo solo si de verdad no puedes corregir la ubicación en ese momento).</div>
    </div>
    <div class="callout info">
      <span class="ic">ℹ️</span>
      <div>Al iniciar, el viaje pasa a <b>“en curso”</b> y ya puedes ver y marcar tus paraderos.</div>
    </div>
  </section>

  <section class="block" id="durante">
    <p class="eyebrow">Paso 3</p>
    <h2>Durante el viaje</h2>
    <p class="intro">Con el viaje “en curso”, tu trabajo se concentra en dos cosas: marcar cada parada y embarcar pasajeros con su QR.</p>

    <div class="tour">
      <div class="tour-row">
        <div class="letter">1</div>
        <div><h3>Marcar llegada a cada paradero</h3><p>Cuando llegas físicamente a una parada, tócala y confirma <b>“Marcar llegada”</b>.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">2</div>
        <div><h3>Escanear el QR del pasajero</h3><p>Dos formas: (a) <b>lector Bluetooth NETUM</b> emparejado — apunta y dispara solo, sin tocar la pantalla; (b) botón <b>“Cámara QR”</b> si no tienes lector a mano. No existe forma de escribir el código a mano: siempre es cámara o lector.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">3</div>
        <div><h3>Chat con el pasajero</h3><p>Burbuja 💬 flotante, visible solo con un viaje activo. Tiene respuestas rápidas y texto libre.</p></div>
      </div>
      <div class="tour-row">
        <div class="letter">4</div>
        <div><h3>Reportar una incidencia</h3><p>Botón disponible en la pestaña “Ruta” si algo se sale de lo normal (avería, accidente, retraso fuerte).</p></div>
      </div>
    </div>

    <h3 style="margin:26px 0 10px; font-size:16px;">Qué puede aparecer al escanear (se cierra solo a los 3 segundos)</h3>
    <div class="scan-grid">
      <div class="scan-card"><span class="ui success">✅ EMBARCADO</span><p>Pasajero correcto, todo en orden.</p></div>
      <div class="scan-card"><span class="ui warn">⚠️ FUERA DE LISTA</span><p>El pasajero existe en el sistema pero no estaba asignado a este horario/parada. Igual queda registrado como “caminante”; avisa a central.</p></div>
      <div class="scan-card"><span class="ui warn">⚠️ CAMBIÓ DE BUS/PARADERO</span><p>El pasajero corresponde a otra unidad u otro paradero del mismo servicio.</p></div>
      <div class="scan-card"><span class="ui danger">⛔ OTRA EMPRESA</span><p>El código no pertenece a un pasajero de AFA para este servicio.</p></div>
      <div class="scan-card"><span class="ui neutral">QR no reconocido</span><p>El código no existe en el sistema. Vuelve a intentar o avisa a central.</p></div>
      <div class="scan-card"><span class="ui neutral">Ya está registrado</span><p>Ese pasajero ya fue escaneado antes en este viaje.</p></div>
    </div>
    <div class="shots one">
      <figure class="shot"><img src="/manuales/conductor/04-ruta.jpg" alt="Pantalla de paraderos y escaneo QR en curso"><figcaption>Pestaña “Ruta” con el viaje en curso</figcaption></figure>
    </div>
  </section>

  <section class="block" id="finalizar">
    <p class="eyebrow">Paso 4</p>
    <h2>Finalizar el viaje</h2>
    <p class="intro">No existe un botón “Finalizar” aparte: el viaje pasa a <b>“Finalizada”</b> automáticamente en cuanto marcas llegada en la <b>última</b> parada de tu ruta.</p>
  </section>

  <section class="block" id="equivoco">
    <p class="eyebrow">Si te equivocaste</p>
    <h2>“Aún no estoy listo · volver a pendientes”</h2>
    <p class="intro">Este botón vive en la pestaña “Ruta”. Úsalo únicamente si <b>iniciaste el viaje por error</b>: regresa el servicio a su estado anterior (programada/confirmada) para que lo vuelvas a iniciar bien.</p>
    <div class="callout warn">
      <span class="ic">⚠️</span>
      <div>No lo uses para <b>cancelar</b> un viaje real — eso lo define el operador desde el sistema central, no desde tu celular.</div>
    </div>
  </section>

  <section class="block" id="otras">
    <p class="eyebrow">Para explorar con calma</p>
    <h2>Otras pantallas de la app</h2>
    <div class="screens">
      <div class="screen-card"><span class="tag">Ruta</span><h3>Paraderos y navegación</h3><p>Paraderos activos, botones directos a Waze/Maps, reportar incidencia, indicador de escáner Bluetooth activo.</p></div>
      <div class="screen-card"><span class="tag">Manifiesto</span><h3>Conteo de pasajeros</h3><p>Cuántos reservados, a bordo, esperando y no-show tienes en el viaje actual.</p></div>
      <div class="screen-card"><span class="tag">Docs</span><h3>Tus documentos</h3><p>Tus documentos como conductor registrados en el sistema.</p></div>
      <div class="screen-card"><span class="tag">Perfil</span><h3>Tus datos</h3><p>Tu información, cambiar PIN, y soporte.</p></div>
    </div>
    <div class="shots">
      <figure class="shot"><img src="/manuales/conductor/05-previaje.jpg" alt="Pantalla de checklist pre-viaje completado"><figcaption>Checklist “Pre-viaje” completado</figcaption></figure>
      <figure class="shot"><img src="/manuales/conductor/06-perfil.jpg" alt="Pantalla de perfil del conductor"><figcaption>Pestaña “Perfil”</figcaption></figure>
    </div>
  </section>

  <section class="block" id="faq">
    <p class="eyebrow">Resolver dudas rápido</p>
    <h2>Preguntas frecuentes y errores comunes</h2>
    <div class="faq">
      <details open>
        <summary>No puedo tocar “Iniciar recorrido”, no responde</summary>
        <p class="a">Revisa en orden: <b>1)</b> ¿elegiste tu vehículo? <b>2)</b> ¿el chip “Pre‑viaje” está en verde “Listo”? <b>3)</b> ¿tu ubicación está en modo preciso? Si todo está correcto y sigue sin responder, cierra y vuelve a abrir la app.</p>
      </details>
      <details>
        <summary>El semáforo de batería se ve gris, no verde ni ámbar</summary>
        <p class="a">No es un error tuyo: significa que tu equipo todavía no tiene instalado el chequeo automático de batería. Avisa a soporte para que lo revisen, pero puedes seguir trabajando con normalidad.</p>
      </details>
      <details>
        <summary>Escaneo el QR y no pasa nada</summary>
        <p class="a">Confirma que estés en la pestaña de paraderos con el viaje ya <b>en curso</b>. Si usas el lector Bluetooth, cierra primero la cámara (no pueden estar activos los dos a la vez).</p>
      </details>
      <details>
        <summary>Me sale “FUERA DE LISTA” al escanear</summary>
        <p class="a">El pasajero existe en el sistema pero no estaba asignado a este horario o paradero. Déjalo subir igual — ya quedó registrado — y avisa a central para que lo revisen.</p>
      </details>
      <details>
        <summary>Se cerró mi sesión sola</summary>
        <p class="a">La sesión dura 12 horas por seguridad. Vuelve a ingresar con tu DNI y tu PIN.</p>
      </details>
      <details>
        <summary>Inicié el viaje por error</summary>
        <p class="a">Usa <b>“Aún no estoy listo · volver a pendientes”</b> en la pestaña Ruta. Esto no cancela el servicio, solo lo regresa para que lo inicies bien.</p>
      </details>
    </div>
  </section>

  <section class="block" id="hoja-bolsillo">
    <p class="eyebrow">Para imprimir y pegar en la unidad</p>
    <h2>Hoja de bolsillo</h2>
    <div class="cheatsheet">
      <h2>App Conductor — pasos del día</h2>
      <p class="sub">Resumen de 6 pasos. Imprime esta tarjeta y pégala cerca de tu asiento.</p>
      <ol class="cs-list">
        <li><span class="n">1</span><div><b>Ingresa</b> <span>con tu DNI y PIN.</span></div></li>
        <li><span class="n">2</span><div><b>Conéctate</b> <span>deslizando el botón (activa el GPS) antes de salir.</span></div></li>
        <li><span class="n">3</span><div><b>Confirma tu vehículo</b> <span>y completa el checklist de pre‑viaje.</span></div></li>
        <li><span class="n">4</span><div><b>Inicia el recorrido</b> <span>cuando el semáforo esté en verde o ámbar controlado.</span></div></li>
        <li><span class="n">5</span><div><b>Marca cada parada</b> <span>y escanea el QR de cada pasajero al subir.</span></div></li>
        <li><span class="n">6</span><div><b>Termina solo</b> <span>al marcar la última parada — no hay botón de “Finalizar”.</span></div></li>
      </ol>
      <div class="cs-warn">¿Ubicación en “aproximada”? Actívala en modo preciso antes de iniciar. ¿QR que no cuadra? Igual deja subir y avisa a central.</div>
      <button class="print-btn no-print" onclick="window.print()">Imprimir esta hoja</button>
    </div>
  </section>

  <footer class="no-print">AFA Transportes — Manual interno de capacitación · App Conductor</footer>
</div>
` }} />
    </>
  );
}
