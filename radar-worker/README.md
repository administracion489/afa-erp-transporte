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

## Correr 24/7

El worker debe quedar corriendo permanentemente. Dos opciones:

**En la PC de la oficina (Windows) con pm2:**

```bash
npm install -g pm2
cd radar-worker
pm2 start npm --name radar-worker -- start
pm2 save
```

`pm2 logs radar-worker` muestra la consola; `pm2 restart radar-worker` lo reinicia. Para que pm2 arranque con Windows, instalar además `pm2-windows-startup` (`npm i -g pm2-windows-startup && pm2-startup install`).

**En un VPS barato (recomendado para no depender de la PC encendida):** cualquier VPS de ~USD 5/mes con Node 20 sirve; mismo `npm install` + pm2 (`pm2 startup` configura el arranque automático en Linux).

## Solución de problemas

| Síntoma | Qué revisar |
|---|---|
| El QR no aparece en /radar-ia | Ver la fila única de `radar_estado` en Supabase (columnas `estado`, `qr_data_url`, `detalle`, `ultimo_latido`). Si `ultimo_latido` está viejo, el worker no está corriendo o no llega a Supabase (revisar `.env` y la consola/`pm2 logs`). El QR también sale en la consola. |
| Estado `esperando_qr` después de haber funcionado | La sesión fue revocada desde el teléfono (o WhatsApp la invalidó). El worker ya borró `auth/` solo; si no, borrarla a mano y volver a escanear el QR. |
| Los mensajes no llegan a `radar_mensajes` | 1) El **número dedicado debe ser miembro** del grupo. 2) El grupo debe estar **activo** en /radar-ia > Grupos (los grupos nuevos entran desactivados). 3) `radar_estado.estado` debe ser `conectado`. |
| Los mensajes quedan en `pendiente` y ELIA no los analiza | El aviso al ERP falla: revisar que `ERP_URL` apunte al deploy correcto y que `RADAR_WORKER_SECRET` coincida con el de Vercel. El cron del ERP igual barre los pendientes. |
| `Conexión cerrada (código …)` repetido en la consola | Normal en cortes de internet: reintenta con espera creciente (5 s → 60 s). Si nunca vuelve a `conectado`, reiniciar el worker; si tampoco, borrar `auth/` y re-escanear. |

## Cómo agregar el bot a un grupo

El Radar solo ve lo que ve su número: agregar el **número dedicado** como miembro del grupo de WhatsApp (como a cualquier contacto). A los pocos minutos el grupo aparece en **/radar-ia > Grupos** (o al reiniciar el worker); activarlo ahí para empezar a monitorearlo.
