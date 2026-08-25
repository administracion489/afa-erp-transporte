# Conectar el WhatsApp del celular al CRM (coexistencia)

Guía para dejar funcionando el **+51 966 707 225** en el CRM **sin desvincularlo del
celular**: el equipo sigue contestando desde la app WhatsApp Business como siempre, y
esas mismas conversaciones aparecen en el Inbox del ERP, donde el agente IA puede
atenderlas.

El código ya está. Lo que **no se puede hacer desde el repositorio** es tocar el panel
de Meta y correr la migración en Supabase. Eso es lo que explica esta guía.

---

## 0. Lo primero: esto no es el QR de WhatsApp Web

Hay dos cosas distintas que la gente llama "conectar WhatsApp con un QR":

| | **Coexistencia** (lo que usa este ERP) | **WhatsApp Web / Baileys** (lo que usan muchas herramientas) |
|---|---|---|
| Quién lo autoriza | Meta, oficialmente | Nadie: es ingeniería inversa del protocolo |
| ¿Se escanea un QR? | **Sí**, uno que muestra Meta | Sí |
| ¿El celular sigue funcionando? | **Sí** | Sí, pero como "dispositivo vinculado" |
| Riesgo de baneo del número | **Ninguno** | Real, y sin aviso previo |
| ¿Se puede vender como producto? | **Sí** | No sin exponerse |
| Requisito | Ser **Tech Provider** aprobado | Ninguno |

El gesto es el mismo — escanear un QR con el celular — pero por debajo no se parecen en
nada. AFA es Tech Provider aprobado desde agosto de 2026, así que le corresponde el
camino de la izquierda.

### Los tres números de AFA

| Número | Uso | Conexión |
|---|---|---|
| **+51 966 707 225** | Atención al cliente (CRM) | API oficial · **coexistencia** |
| **+51 905 438 216** | Notificaciones y avisos | API oficial |
| **+51 997 683 199** | Radar IA (grupos) | Baileys/QR · número **dedicado** |

> ⚠️ Los dos primeros están dados de alta en la Cloud API. **Nunca** escanear un QR de
> WhatsApp Web con ellos: rompería la integración oficial y pondría en riesgo el número
> por el que escriben los clientes. El Radar tiene su propio número justamente por eso
> (ver `radar-worker/README.md`).

---

## 1. Arreglar el error que aparece hoy

Al tocar **Conectar WhatsApp** sale una ventana de Meta con:

> **Dominio de host desconocido de JSSDK**
> El dominio en el que alojas el SDK de Facebook para Javascript está en la lista de
> dominios de host del SDK de Javascript de tu app.

La traducción de Meta está mal redactada: el mensaje original dice que el dominio **NO**
está en la lista. Es configuración del panel, no un problema del código.

### Paso a paso

1. Entrar a <https://developers.facebook.com/apps/1776032736701552/>
2. Menú lateral → **Inicio de sesión con Facebook para empresas** → **Configuración**
3. Confirmar que estén activados:
   - *Inicio de sesión con OAuth del cliente*
   - *Inicio de sesión con OAuth web*
   - *Aplicar HTTPS*
   - **Iniciar sesión con el SDK de JavaScript**
4. En **Dominios permitidos para el SDK de JavaScript**, agregar:

   ```
   transportesafa.com
   www.transportesafa.com
   ```

   Y el dominio de Vercel, si desde ahí también se abre el CRM (p. ej.
   `afa-erp-transporte.vercel.app`).

5. En **URI de redireccionamiento de OAuth válidos**, agregar las mismas con `https://`:

   ```
   https://transportesafa.com/
   https://www.transportesafa.com/
   ```

6. **Guardar cambios.**

Detalles que hacen fallar esto en silencio:

- Solo se admiten dominios con **HTTPS**. `http://` o `localhost` sin certificado no pasan.
- El dominio debe ser **exacto**. `transportesafa.com` no cubre `www.transportesafa.com`.
- Nada de comodines (`*.transportesafa.com`): Meta los acepta pero luego los rechaza en la
  comprobación.
- Los cambios tardan un par de minutos y conviene recargar el CRM con **Ctrl+Shift+R**.

Si el error persiste, el modal del CRM ahora lo detecta solo y muestra en pantalla el
dominio exacto que hay que pegar en el panel.

---

## 2. El segundo problema, que ya está arreglado en el código

Aunque arreglaras el dominio, la conexión **tampoco se completaba**, y esto no era
evidente: la ventana de Meta decía "listo" y el ERP mostraba un recuadro con el
"Código de autorización (guárdalo, aún falta activarlo)".

Ese código **vive 30 segundos**. Para cuando alguien lo copiaba, ya estaba vencido, así
que el número nunca llegaba a activarse: ni token, ni suscripción a los webhooks, ni
historial.

Ahora el modal manda el código al servidor **en el mismo instante** en que Meta lo
entrega (`POST /api/crm/whatsapp/activar`), y ese endpoint hace de una sola vez:

1. canjea el código por el **token de negocio** de la cuenta;
2. **suscribe el ERP** a los mensajes de ese WABA (sin esto el Inbox se queda vacío
   aunque el número figure conectado — es el paso que más se olvida);
3. verifica en Meta que el número quedó en coexistencia (`is_on_biz_app`, `platform_type`);
4. lo registra en `whatsapp_numeros`;
5. guarda su token **cifrado** en `whatsapp_tokens`;
6. pide los **contactos** y el **historial de hasta 6 meses**.

La pantalla muestra los seis pasos con ✓ o ✕, así que si algo falla se ve exactamente
cuál y por qué, en vez de un "no funcionó".

---

## 3. Variables de entorno (Vercel)

| Variable | Para qué | ¿Obligatoria? |
|---|---|---|
| `META_APP_SECRET` | Canjear el código por el token. **Sin esto no se conecta ningún número.** | Sí |
| `META_APP_ID` | Id de la app (`1776032736701552`). | Sí |
| `TOKEN_ENCRYPTION_KEY` | Cifra los tokens de negocio en la base. | Solo para vender el ERP |
| `NEXT_PUBLIC_META_APP_ID` | Id de la app en el navegador. Si falta se usa el valor por defecto. | No |
| `NEXT_PUBLIC_META_CONFIG_ID` | Id de la configuración del Embedded Signup. Igual. | No |

`META_APP_SECRET` está en el panel de Meta → **Configuración de la app** → **Básica** →
*Clave secreta de la app* → **Mostrar**.

`TOKEN_ENCRYPTION_KEY` puede ser cualquier frase larga, o mejor una clave aleatoria:

```bash
openssl rand -hex 32
```

Si no está configurada, AFA funciona igual (usa `META_WA_TOKEN` como siempre) y el ERP
avisa en pantalla. Hace falta el día que se conecte la cuenta de **otra** empresa.

---

## 4. Correr la migración

Supabase → **SQL Editor** → pegar `supabase/whatsapp-coexistencia.sql` → **Run**.
Es idempotente: correrla dos veces no rompe nada.

Crea `whatsapp_tokens`, añade el estado de coexistencia a `whatsapp_numeros`, la
columna `origen` a `crm_mensajes` y el interruptor `pausar_si_responde_humano` del
agente IA.

---

## 5. Suscribir los webhooks nuevos

Panel de Meta → **WhatsApp** → **Configuración** → **Webhooks** → *Administrar*.
Además de `messages`, que ya estaba, activar:

| Campo | Qué trae |
|---|---|
| `smb_message_echoes` | Lo que se responde **desde el celular** |
| `history` | Hasta 6 meses de conversaciones anteriores |
| `smb_app_state_sync` | Los contactos de la agenda del teléfono |

Sin `smb_message_echoes` el Inbox mostraría la pregunta del cliente y nunca la
respuesta, porque se dio por el teléfono. Es la mitad que faltaba.

---

## 6. Conectar el número

CRM → **Conectar WhatsApp** → botón verde.

1. Elegir el número **+51 966 707 225** en la ventana de Meta.
2. Meta muestra un **QR**: escanearlo con la app WhatsApp Business de ese mismo celular
   (Configuración → Dispositivos vinculados). Es el paso que hace la coexistencia.
3. **No cerrar la ventana**: el ERP activa la cuenta solo, en segundos.
4. Los seis pasos deben quedar en ✓.

Después, en **Configuración**, asignarle el uso **Atención** para que además de recibir
pueda enviar. El ERP no lo hace solo a propósito: activarlo automáticamente desplazaría
en silencio al número que hoy cumple ese papel.

---

## 7. Qué va a pasar (y qué no)

**El equipo sigue igual.** Nadie tiene que cambiar cómo trabaja: se contesta desde el
celular como siempre. La diferencia es que ahora el ERP también lo ve.

**La IA se aparta cuando entra una persona.** Si alguien responde desde el teléfono, ese
chat queda con la IA en pausa para que el cliente no reciba dos respuestas distintas al
mismo mensaje. Se reanuda desde el Inbox con el botón de siempre. Para desactivar ese
comportamiento: `crm_agentes_ia.pausar_si_responde_humano = false`.

**El historial tarda.** Los 6 meses llegan por webhook, en trozos. En una cuenta con
mucho tráfico puede tomar un rato. No marca nada como no leído: sería inservible tener
500 hilos en negrita el primer día.

**Hay 24 horas para el historial.** Meta solo acepta pedirlo dentro del día siguiente a
conectar el número. El ERP lo pide de inmediato y guarda la fecha; si el plazo vence,
hay que desconectar el número y volver a conectarlo.

**Lo que no llega:** mensajes enviados desde WhatsApp Web u otros clientes no oficiales
no generan echo, así que esos no se ven en el Inbox.

---

## 8. Cuando toque vender el ERP

Ser Tech Provider es el activo, y esto es lo que ya quedó listo para aprovecharlo:

- **Un token por empresa.** `whatsapp_tokens` guarda el business token de cada cliente,
  cifrado con AES-256-GCM. `lib/crm-meta.ts` usa el del número al que le está hablando y
  cae a `META_WA_TOKEN` si no hay. Sin esto un segundo cliente sería imposible: su cuenta
  no cuelga del system user de AFA y Meta rechazaría cada envío.
- **Columna `tenant`** en `whatsapp_numeros` y `whatsapp_tokens`, hoy toda en `'afa'`.
- **El onboarding es el mismo botón.** Un cliente nuevo entra al CRM, toca *Conectar
  WhatsApp*, escanea el QR con su celular y queda operando. Es el argumento de venta:
  **conserva su número, su historial y su forma de trabajar.** Nadie migra a un sistema
  que le pide cambiar el número que tiene impreso en sus buses.

Lo que **falta** el día que se venda de verdad, y conviene tenerlo dicho:

1. **Aislar los datos por empresa.** Hoy `crm_*`, `reservas`, `vehiculos` y el resto no
   tienen `tenant`: el ERP asume una sola empresa. Es el trabajo grande, no este módulo.
2. **App Review de Meta** con los permisos `whatsapp_business_management` y
   `whatsapp_business_messaging` en modo Live, y el caso de uso de Tech Provider.
3. **Facturación de las conversaciones.** Meta le cobra a la cuenta del cliente, no a
   AFA; hay que decidir si se factura aparte o se revende con margen.
4. **Rotación y revocación de tokens.** Ya hay `borrarToken()`; falta la pantalla y el
   aviso cuando Meta revoca uno.

---

## 9. Si algo falla

| Síntoma | Qué revisar |
|---|---|
| "Dominio de host desconocido de JSSDK" | Sección 1. El modal ahora te dice el dominio exacto. |
| "El código de autorización ya venció" | Volver a tocar el botón y **no cerrar la ventana**. Si se repite siempre, revisar que `META_APP_SECRET` sea la de la app `1776032736701552`. |
| Paso 2 en ✕ ("Suscribir el ERP…") | El token no tiene permiso sobre ese WABA, o falta App Review. Los mensajes **no van a entrar** hasta arreglarlo. |
| Conectado, pero el Inbox sigue vacío | Que `messages` y `smb_message_echoes` estén suscritos (sección 5) y que la URL del webhook apunte a `https://…/api/crm/webhook/meta`. |
| Aviso "NO quedó en coexistencia" | Meta devolvió `is_on_biz_app = false`. Revisar el celular: puede haber quedado desvinculado. |
| Conectado pero no envía | Falta asignarle el uso **Atención** en Configuración. |
| Lo que contesto del celular no aparece | Falta `smb_message_echoes`. Si se responde desde WhatsApp Web, no hay echo y no hay forma de verlo. |
| No llegó el historial | Se pasaron las 24 h. Desconectar y volver a conectar el número. |
