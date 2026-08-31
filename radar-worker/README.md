# AFA Radar IA — Worker de WhatsApp

Proceso Node independiente del ERP. Mantiene la sesión de **WhatsApp Web** (vía [Baileys](https://github.com/WhiskeySockets/Baileys), protocolo multi-device por WebSocket, sin navegador), escucha los **grupos activos** configurados en el ERP y va insertando cada mensaje crudo en la tabla `radar_mensajes` de Supabase. Después le avisa al ERP (`POST /api/radar/procesar`) para que ELIA clasifique los mensajes y ejecute las acciones del Radar (oportunidades, combustible, alertas, etc.).

> ⚠️ **ADVERTENCIA — LEER ANTES DE CONECTAR UN NÚMERO**
>
> Este worker usa un cliente **NO oficial** de WhatsApp (Baileys). WhatsApp puede
> **suspender o banear** el número conectado por usar clientes no oficiales — es un
> riesgo real. Por eso:
>
> - Usar un **CHIP / NÚMERO DEDICADO** comprado solo para el Radar IA.
> - **NUNCA** conectar el **+51 966 707 225** del CRM: está en **coexistencia** con la
>   API oficial de Meta y vincularle Baileys puede **romper esa integración**.
> - **NUNCA** conectar el 2do número de avisos a pasajeros (también registrado en Meta).
>
> Si el número dedicado llegara a caer, se pierde solo el Radar — el CRM y los avisos
> oficiales siguen intactos. Esa separación es intencional: mantenerla.

## Requisitos

- Node.js **20 o superior** (`node -v` para verificar).
- Un número de WhatsApp **dedicado** (ver advertencia) con la app WhatsApp instalada en un celular.
- Acceso al proyecto de Supabase del ERP (URL + clave `service_role`).

## Instalación

```bash
cd radar-worker
npm install
```

## Configuración

Copiar la plantilla y completar los valores:

```bash
copy .env.example .env    # en Windows (cp en Linux/Mac)
```

| Variable | De dónde sale |
|---|---|
| `SUPABASE_URL` | Supabase > Settings > API > Project URL (la misma del ERP). |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase > Settings > API > `service_role`. **Secreta: acceso total a la BD.** |
| `ERP_URL` | URL del ERP en Vercel, sin barra final (p.ej. `https://afa-erp.vercel.app`). |
| `RADAR_WORKER_SECRET` | Cadena larga aleatoria, **la misma** que la variable `RADAR_WORKER_SECRET` en Vercel. |
| `AUTH_DIR` | (Opcional) Carpeta de la sesión de WhatsApp. Por defecto `./auth`. |

## Primer arranque (escanear el QR una sola vez)

```bash
npm start
```

1. El worker genera un QR y lo publica en dos lados: en el **ERP → /radar-ia** (pestaña de conexión) y como respaldo en **ASCII en esta misma consola**.
2. En el celular del **número dedicado**: WhatsApp > **Dispositivos vinculados** > **Vincular un dispositivo** > escanear el QR.
3. Al conectar, el worker sincroniza la lista de grupos. En el ERP (**/radar-ia > Grupos**) hay que **activar** los grupos a monitorear — por seguridad, ningún grupo se monitorea hasta activarlo a mano.

La sesión queda guardada en la carpeta `auth/`. Mientras exista y sea válida, el worker se reconecta solo (caídas de internet, reinicios): **no hay que volver a escanear**. Respaldar `auth/` = poder mover el worker de máquina sin re-escanear. Nunca subir esa carpeta a git (ya está en `.gitignore`).

## Cambiar el número vinculado

**`auth/` ES la sesión, y Baileys solo emite el QR cuando esa carpeta está vacía.** Todo lo que sigue es una forma de dejarla vacía:

1. **Desde el ERP (lo normal):** /radar-ia → **"Generar QR nuevo"** (o "Vincular otro número" si está conectado). El worker desvincula el dispositivo si la sesión aún vive, borra `auth/` y publica un QR nuevo en la misma pantalla. Requiere el worker corriendo (versión **1.1.0+**).
2. **A mano en el servidor**, si el worker está en una versión vieja o no responde:

   ```bash
   cd /root/radar-worker    # la carpeta donde corre
   pm2 stop radar-worker
   rm -rf auth
   pm2 restart radar-worker
   pm2 logs radar-worker    # el QR sale acá y también en /radar-ia
   ```

Después de escanear con el número nuevo hay que **agregarlo a los grupos** (el Radar solo ve lo que ve su número).

### La lista de grupos después de cambiar de número

`radar_grupos` **no se borra ni se reemplaza**: los grupos del número anterior siguen en la tabla. Desde el worker **1.2.0** cada sincronización marca cuáles ve el número conectado (`visible`), y /radar-ia > Grupos los muestra tachados con la etiqueta *"Ya no se ve"* — o *"Activo pero sin acceso"* en rojo si además siguen en Monitorear, que es el caso peligroso: aparentan vigilancia sin que pueda llegar un mensaje. No se borran solos porque conservan el contexto escrito para ELIA, las categorías y los mensajes ya capturados; se quitan a mano con el enlace **Quitar** de la fila.

Requiere correr `supabase/radar-ia-grupos-vigencia.sql` una vez. Sin ese SQL el worker sigue sincronizando igual que antes, solo que sin poder marcar nada (lo avisa en los logs).

La lectura de la lista se hace al conectar y cada 30 min, **con 3 reintentos**: justo después de vincular, WhatsApp suele responder `408 Timed Out` a las consultas de inicialización, y antes eso dejaba la lista sin actualizar hasta media hora después sin ninguna señal. El botón **"Actualizar lista"** de la pestaña Grupos fuerza una lectura nueva, y arriba se ve cuándo fue la última que salió bien.

## Correr 24/7

El worker debe quedar corriendo permanentemente. Dos opciones:

**En la PC de la oficina (Windows) con pm2:**

```bash
npm install -g pm2
cd radar-worker
npm install
pm2 start node_modules/tsx/dist/cli.mjs --name radar-worker -- src/index.ts
pm2 save
```

⚠️ En Windows, `pm2 start npm -- start` falla (`SyntaxError: Unexpected token ':'`) por un bug conocido de pm2 con los wrappers `.cmd` de npm/npx — por eso se apunta directo al CLI de `tsx` (`node_modules/tsx/dist/cli.mjs`), que es un `.mjs` puro y evita el problema por completo.

`pm2 logs radar-worker` muestra la consola; `pm2 restart radar-worker` lo reinicia. Para que pm2 arranque solo con Windows: `npm i -g pm2-windows-startup && pm2-startup install` (crea una entrada en `HKCU\...\Run` que corre `pm2 resurrect` al iniciar sesión — necesita `pm2 save` hecho de antes).

**En un VPS barato (recomendado para no depender de la PC encendida):** cualquier VPS de ~USD 5/mes con Node 20 sirve; mismo `npm install` + pm2 (`pm2 startup` configura el arranque automático en Linux).

## Solución de problemas

| Síntoma | Qué revisar |
|---|---|
| El QR no aparece en /radar-ia | Ver la fila única de `radar_estado` en Supabase (columnas `estado`, `qr_data_url`, `detalle`, `ultimo_latido`). Si `ultimo_latido` está viejo, el worker no está corriendo o no llega a Supabase (revisar `.env` y la consola/`pm2 logs`). El QR también sale en la consola. Si el worker SÍ está vivo pero nunca llega un QR, ver la fila de abajo: Baileys solo emite el QR con `auth/` vacío. |
| **WhatsApp bloqueó el número y no sale el QR para cambiarlo** | Es el caso del código **403** (`forbidden`). Baileys **solo emite el evento `qr` cuando NO hay credenciales guardadas**, así que mientras `auth/` conserve la sesión del número bloqueado el worker reintenta para siempre y el QR no aparece nunca. Desde el worker **1.1.0** el 403 (y el 401/405/411) borra `auth/` solo y pide QR; con una versión anterior hay que forzarlo a mano: `pm2 stop radar-worker && rm -rf auth && pm2 restart radar-worker`. Escanear el QR nuevo con **otro chip dedicado**: el bloqueado no vuelve. |
| El botón "Generar QR nuevo" del ERP no hace nada | Hasta el worker 1.0.0 el botón dependía de que `sock.logout()` funcionara, y con el socket caído (justo el caso del número bloqueado) nunca completaba. Desde 1.1.0 el logout es best-effort con tope de 5 s y el QR se fuerza igual. Verificar la versión en /radar-ia → chip de conexión → "Versión del worker". Si el worker no está corriendo, nadie atiende la solicitud: encenderlo primero. |
| Estado `esperando_qr` después de haber funcionado | La sesión fue revocada desde el teléfono (o WhatsApp la invalidó). El worker ya borró `auth/` solo; si no, borrarla a mano y volver a escanear el QR. |
| Los mensajes no llegan a `radar_mensajes` | 1) El **número dedicado debe ser miembro** del grupo — si en /radar-ia > Grupos la fila sale tachada como *"Ya no se ve"*, quedó del número anterior y no llega nada por ahí. 2) El grupo debe estar **activo** en /radar-ia > Grupos (los grupos nuevos entran desactivados). 3) `radar_estado.estado` debe ser `conectado`. |
| Cambié de número y la pestaña Grupos sigue mostrando los del anterior | `radar_grupos` acumula: nunca se borra nada. Con el worker **1.2.0** los que el número actual no ve salen marcados; pulsa **"Actualizar lista"** para forzar una lectura nueva y mira la fecha de la última lectura correcta. Si la lista no cambia, casi siempre es que **al número nuevo todavía no lo agregaron a los grupos** de WhatsApp. |
| Los mensajes quedan en `pendiente` y ELIA no los analiza | El aviso al ERP falla: revisar que `ERP_URL` apunte al deploy correcto y que `RADAR_WORKER_SECRET` coincida con el de Vercel. El cron del ERP igual barre los pendientes. |
| `Conexión cerrada (código …)` repetido en la consola | Normal en cortes de internet: reintenta con espera creciente (5 s → 60 s). Si nunca vuelve a `conectado`, reiniciar el worker; si tampoco, borrar `auth/` y re-escanear. |
| Escaneas el QR y nunca conecta: `código 515` → `Sesión cerrada desde el teléfono` → QR nuevo, en bucle | **Bug corregido en ago-2026** — dejar el arreglo intacto. El `515` (`restartRequired`) no es un error: WhatsApp lo envía SIEMPRE tras emparejar, pidiendo recrear el socket de inmediato para completar la vinculación. Si se le aplica espera (el backoff llegaba a 60 s), el emparejamiento caduca y el teléfono descarta la sesión recién creada → vuelve a pedir QR, para siempre. Por eso `connection.update` trata el `515` aparte (reconecta en 500 ms, con tope de 3 seguidos por si se repite por otra causa) y el evento `qr` resetea el backoff para que el código publicado en /radar-ia no quede vencido. Ojo también: el código `500` (`badSession`) **no** significa sesión corrupta — en Baileys es el valor por defecto de cualquier error no mapeado, así que borrar `auth/` ante un `500` destruiría una sesión sana. |

## Cómo agregar el bot a un grupo

El Radar solo ve lo que ve su número: agregar el **número dedicado** como miembro del grupo de WhatsApp (como a cualquier contacto). A los pocos minutos el grupo aparece en **/radar-ia > Grupos** (o al reiniciar el worker); activarlo ahí para empezar a monitorearlo.
