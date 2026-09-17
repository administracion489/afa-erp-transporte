# Pedirle a Tracklink que retransmita el GPS al ERP

Guía para solicitar a **Tracklink Perú** (el proveedor de GPS de AFA) que retransmita las
tramas de los equipos directamente al ERP, y el análisis de qué cambia y qué NO cambia con
eso. Incluye el correo listo para enviar y el anexo técnico para su área de sistemas.

---

## 1. La respuesta corta

**Sí se puede pedir, y vale la pena pedirlo. Pero no ahorra la API de Google, y esa es la
parte que hay que tener clara antes de negociarlo.**

Son dos cosas que no se tocan entre sí:

| | Qué contesta | Quién lo provee hoy | ¿Lo puede dar Tracklink? |
|---|---|---|---|
| **Posición** | ¿Dónde está el bus AHORA? | El **celular del conductor** (app conductor / enlace del tercero) — costo S/ 0 | **Sí, es exactamente lo que vende** |
| **Ruta dibujada** | ¿Por qué calles va el recorrido? | Google Directions (`/api/ruta`) | No |
| **ETA con tráfico** | ¿A qué hora llega con el tráfico de ahora? | Google Directions Advanced (`lib/eta-trafico.ts`) | Difícilmente, y con pérdida (ver §4) |
| **Geocodificación** | ¿Qué coordenada es "Mz. F Lt. 12"? | Google Geocoding (`/api/geocodificar`) | No |
| **Autocompletado de direcciones** | El buscador de direcciones del cotizador | Google Places (`app/cotizador/page.tsx`) | No |
| **Km entre dos puntos** | ¿Cuántos km tiene el tramo cotizado? | Google Distance Matrix (cotizador) | No |

**Google no cobra por saber dónde está el bus.** Cobra por las otras cinco, y ninguna de
ellas la puede contestar un equipo GPS: un tracker manda `lat, lng, velocidad, rumbo, hora`
— no dibuja rutas, no conoce direcciones y no sabe del tráfico.

O sea: la posición, que es lo único que Tracklink puede mandar, **hoy ya es gratis** (la pone
el celular del conductor). Y lo que sí se le paga a Google **seguiría pagándose igual**.

Eso no anula la idea — la reorienta. Lo que la retransmisión arregla de verdad está en §3,
y es un problema real que el ERP ya mide y hoy no puede resolver.

---

## 2. Nada de lo que hoy funciona se rompe, y esta es la razón

La preocupación es correcta y la respuesta es concreta: **la app del pasajero, la app del
conductor, `/seguimiento`, `/monitoreo`, el portal del cliente y el semáforo de puntualidad
leen TODOS la misma tabla, `ubicaciones_gps`.** Ninguno habla con el celular del conductor
ni con Google para saber dónde está el bus: leen filas de esa tabla.

```
                        ┌───────────────────────┐
 celular del conductor ─┤                       ├─ /monitoreo
 enlace del tercero    ─┤    ubicaciones_gps    ├─ /seguimiento/[token]
 ► Tracklink (nuevo)   ─┤                       ├─ app pasajero · portal cliente
                        └───────────────────────┘  ModalGps · retrasos · gps-salud · km-servicio
```

Una fuente nueva que **INSERTA en esa misma tabla** es invisible para todas esas pantallas:
siguen leyendo lo mismo, del mismo sitio, con el mismo código. No hay que tocar ni una.

Es la regla que este ERP ya aplica en el semáforo de puntualidad —*«es ADITIVO, nunca
sustractivo»*— y la que explica por qué **no se crea una tabla `gps_tracklink` aparte**: dos
tablas serían dos motores contestando la misma pregunta, y terminarían contestando distinto.
Una fila de GPS es una fila de GPS, venga del teléfono o del equipo del vehículo.

Lo único que hace falta es **declarar de dónde vino cada fila**: una columna `fuente`
(`app_conductor` · `enlace_tercero` · `tracklink`), nullable y sin default — sin la
migración, el comportamiento es byte a byte el de hoy.

### Y el respaldo del GPS de Tracklink no es Google: es el celular

Aquí hay que corregir una pieza del planteamiento, y es la que hace segura toda la
operación. **Google nunca dio posición**, así que no puede ser el respaldo de un GPS que
falle. El respaldo ya existe y ya está funcionando: **la app del conductor**.

Eso es lo bueno del diseño: quedan **dos fuentes independientes** escribiendo en la misma
tabla. Si el equipo de Tracklink se queda sin señal, el celular sigue reportando; si el
conductor apaga el celular o Android le mata el servicio en segundo plano —que es el defecto
que `/api/gps-salud` existe para medir— el equipo del vehículo sigue reportando. Hoy hay una
sola fuente y cuando falla, no hay traza.

---

## 3. Lo que la retransmisión SÍ arregla (y es la razón de verdad para pedirla)

1. **El rastreo depende hoy del celular del conductor, y se cae.** El panel
   `/api/gps-salud` existe precisamente para eso: mide qué porcentaje de la ventana del
   servicio tuvo GPS llegando, porque *«Android mata el servicio y no rearranca»*. Un equipo
   instalado en el vehículo no se queda sin batería, no depende del plan de datos del
   conductor ni de que abra la app.
2. **El GPS falso.** La columna `ubicaciones_gps.simulado` existe porque hubo que detectar
   apps de ubicación simulada. Un equipo cableado al vehículo no se puede falsear desde un
   teléfono.
3. **El odómetro.** Hoy el kilometraje se lee **de fotos del tablero con IA**, con toda la
   maquinaria de `lib/odometro-seleccion.ts` para atrapar el dígito de más (la CUP-435 que
   leyó 239 980 donde el tablero decía 23 980). Si el equipo reporta odómetro —**y sobre
   todo si lo toma del CAN bus del vehículo y no de un cálculo por GPS**— ese problema
   desaparece en las unidades que lo tengan.
4. **Encendido del motor.** Permite saber cuándo arrancó y paró de verdad, sin depender de
   que el conductor pulse un botón.
5. **Las horas reales del servicio** (`supabase/servicio-horas-reales.sql`) y el km por
   servicio (`lib/km-servicio.ts`) dejan de subestimarse por cortes del teléfono.

### El límite que hay que tener presente antes de negociar

**86 de las 89 unidades del ERP son de terceros** (`vehiculos_tercero`). Tracklink puede
retransmitir los equipos **de AFA**; los de las tercerizadas son de sus dueños y cada una
tendría que autorizar lo mismo con su propio proveedor. Para esas unidades el celular del
conductor seguirá siendo la fuente — por eso el enlace `/conductor-tercero/[token]` no se
toca ni se jubila.

Conviene decirlo al negociar: el volumen inicial es la flota propia, no 89 unidades.

---

## 4. La única puerta por la que SÍ podría bajar la factura de Google

La llamada cara es el **ETA con tráfico**: `departure_time` mete la consulta en el SKU
"Directions Advanced" — según la cabecera de `app/api/ruta/route.ts`, el doble de precio y
con la mitad de cuota gratuita que el SKU normal. Por eso `lib/eta-trafico.ts` tiene tres
frenos (filtro de duda, caché de 3 min y techo de 300 llamadas/día).

Si la plataforma de Tracklink expone un ETA propio, técnicamente podría sustituirlo. **Pero
casi ningún ETA de plataforma de rastreo lleva tráfico en vivo**, y el semáforo de
puntualidad está construido sobre medir contra un ETA real: cambiarlo por uno sin tráfico
haría que el veredicto *«llegará tarde»* empeorara **en silencio**, que es justo lo que este
ERP evita en todos sus módulos.

Se pregunta (está en el anexo) y se decide con la respuesta delante. No se asume.

**Y el gasto real conviene medirlo antes de negociar nada**: si el ahorro posible son unas
decenas de dólares al mes y la integración se cobra por unidad, la retransmisión puede
costar más de lo que ahorra. Lo cual no la invalida — la justifican los cinco puntos de §3,
no el recibo de Google.

---

## 5. Las tres formas de pedirlo, en orden de preferencia

**a) Webhook HTTP POST (la que conviene).** Su plataforma manda un POST con JSON a una URL
del ERP cada vez que hay posición nueva. No hay que abrir puertos, va por HTTPS y se
autentica con un token. Es el mismo patrón que ya usa el Radar IA (`/api/radar/procesar`
con `Bearer RADAR_WORKER_SECRET`).

**b) API de su plataforma, consultada por el ERP.** Si no pueden empujar, que den
credenciales de solo lectura y el ERP consulta cada N minutos. Funciona sin desarrollo de
su lado, pero es menos fresco y gasta una tarea programada.

**c) Retransmisión de tramas TCP/UDP (el "espejo").** Los equipos y las plataformas suelen
poder reenviar las tramas crudas a un segundo servidor. Es lo más fiel al dato, pero
**necesita un proceso escuchando en una IP pública con un puerto abierto**, y el ERP corre
en Vercel, que no admite eso. AFA sí tiene dónde: el droplet de DigitalOcean que sostiene
el `radar-worker` (`167.99.182.128`). Sería un servicio nuevo ahí, con su propio
mantenimiento — por eso va tercero, no porque no se pueda.

> **Ojo con (c):** algunos equipos solo admiten uno o dos servidores de destino. Si se
> apunta uno a AFA y el equipo solo soporta uno, **se rompe el monitoreo del propio
> proveedor**. Por eso la retransmisión se pide *desde la plataforma* (que sí duplica el
> flujo) y no reconfigurando el equipo.

---

## 6. A quién mandarlo

Tracklink Perú opera con **Octo Telematics** y tiene ~160 000 equipos instalados en el país:
es un proveedor grande, así que la integración no la resuelve el soporte de retail sino la
**cuenta corporativa / flotas**. Su producto de flota se llama **"Control Total"**.

Esperar: que exista como servicio (venden datos, es su negocio), que se cobre — probablemente
por unidad/mes — y que pidan un acuerdo de confidencialidad. Es una conversación comercial,
no un botón que alguien activa.

Canales publicados: **informes@tracklink.pe** · Ventas **+51 993 944 841** (también
WhatsApp) · Central **(01) 630-7575**.

Si AFA tiene ejecutivo de cuenta asignado, va directo a él con copia a ese correo.

---

## 7. El correo, listo para enviar

> **Asunto:** Solicitud de integración — retransmisión de datos GPS hacia nuestro sistema (AFA Tours Perú S.A.C.)
>
> Estimados señores de Tracklink:
>
> Somos **AFA Tours Perú S.A.C.**, cliente de Tracklink, operador de transporte de personal
> y turismo. Contamos con un sistema propio de gestión (ERP) en el que administramos
> programación de servicios, seguimiento en vivo, mantenimiento de flota y liquidación a
> clientes.
>
> Queremos **integrar la información de sus equipos GPS a nuestro sistema**, de modo que las
> posiciones de nuestras unidades lleguen automáticamente a nuestra plataforma además de
> seguir viéndose en la de ustedes. **No estamos pidiendo dejar de usar su plataforma**: la
> seguiremos usando para monitoreo y emergencias; lo que necesitamos es que el dato también
> alimente nuestros procesos internos.
>
> Les agradeceríamos indicarnos **cuál de estas modalidades pueden ofrecernos**:
>
> 1. **Webhook (preferida):** que su plataforma envíe un POST con JSON a una URL nuestra
>    cada vez que haya posición nueva, autenticado con un token que nosotros les entregamos.
> 2. **API de consulta:** credenciales de solo lectura para que nuestro sistema consulte
>    periódicamente las posiciones de nuestras unidades.
> 3. **Retransmisión de tramas (TCP/UDP):** reenvío del flujo de datos a un servidor nuestro
>    (tenemos IP pública disponible). Preferimos que se haga **desde la plataforma** y no
>    reconfigurando el equipo, para no afectar el monitoreo de ustedes.
>
> Los datos que necesitamos por cada posición son: **placa e identificador del equipo
> (IMEI), fecha y hora del posicionamiento tomada por el equipo (no la de envío), latitud,
> longitud, velocidad, rumbo, precisión, y —si el equipo lo reporta— odómetro y estado de
> encendido del motor.**
>
> Adjuntamos el **anexo técnico** con el detalle exacto para su área de sistemas.
>
> Sobre lo comercial, quedamos atentos a:
>
> - Si este servicio está incluido en nuestro contrato actual o tiene costo adicional.
> - El costo (por unidad/mes o tarifa única) y el plazo mínimo.
> - Si requieren acuerdo de confidencialidad, y el tiempo estimado de implementación.
> - La posibilidad de **habilitar primero una unidad de prueba** antes de extenderlo a la
>   flota.
>
> Quedamos a disposición para una reunión técnica entre su equipo y el nuestro.
>
> Cordialmente,
>
> **[Nombre]** — AFA Tours Perú S.A.C.
> [cargo] · [teléfono] · administracion@afatoursperu.com

### Versión corta para WhatsApp

> Buenos días. Somos AFA Tours Perú S.A.C., clientes de Tracklink. Necesitamos integrar los
> datos GPS de nuestras unidades a nuestro sistema propio de gestión (sin dejar de usar la
> plataforma de ustedes). ¿Manejan integración por webhook, API o retransmisión de tramas
> hacia un servidor del cliente? ¿Con quién podemos ver el tema técnico y comercial? Les
> podemos enviar el detalle técnico por correo. Gracias.

---

## 8. Anexo técnico (para el área de sistemas del proveedor)

> **El PDF que se envía se genera desde `docs/anexo-gps-tracklink.html`**, con membrete y
> el logo de AFA embebido. Para regenerarlo tras editarlo (mismo motor que usan los
> documentos imprimibles del ERP — ver `lib/pdf-chrome.ts`):
>
> ```bash
> chrome --headless=new --no-pdf-header-footer \
>   --print-to-pdf=anexo.pdf file:///ruta/a/docs/anexo-gps-tracklink.html
> ```
>
> Dos cosas de su maquetación que no se pueden aflojar, y que costaron una revisión:
> el pie **cuelga de un `<tfoot>`**, no de un `position:fixed` — fijo se repite en cada
> hoja pero **no reserva su sitio** y se imprimió encima del bloque JSON de la página 2,
> el mismo defecto que documenta `CSS_IMPRESION` en `lib/liquidacion-doc.ts`; y el
> ejemplo JSON lleva `break-inside:avoid`, porque partido entre dos hojas dejaba un
> corchete solo al pie de la primera. **Se revisa mirando el PDF completo, nunca la
> primera página en pantalla.**

El texto del anexo, para referencia:

> **ANEXO TÉCNICO — Integración de datos GPS · AFA Tours Perú S.A.C.**
>
> **Modalidad preferida:** webhook HTTP POST sobre HTTPS.
>
> **Endpoint (lo entregamos al confirmar):** `POST https://transportesafa.com/api/gps/ingesta`
> **Autenticación:** cabecera `Authorization: Bearer <token>` (token que entregamos
> nosotros). Si pueden firmar el cuerpo con HMAC-SHA256, mejor; indíquennos el esquema.
> Podemos además restringir por IP de origen: háganos llegar el rango que usarán.
>
> **Cuerpo esperado** — un objeto o un arreglo de objetos (para envíos acumulados):
>
> ```json
> [
>   {
>     "placa": "CWZ-371",
>     "imei": "861234567890123",
>     "fix_ts": "2026-09-17T14:32:05-05:00",
>     "lat": -12.046374,
>     "lng": -77.042793,
>     "velocidad_kmh": 42.5,
>     "rumbo": 187,
>     "precision_m": 8,
>     "odometro_km": 175445,
>     "ignicion": true
>   }
> ]
> ```
>
> **Cinco puntos que para nosotros son críticos:**
>
> 1. **`fix_ts` debe ser la hora en que el EQUIPO tomó la posición, con zona horaria — no la
>    hora de envío ni la de recepción.** Cuando un equipo pierde señal y descarga después
>    las posiciones acumuladas, si todas llegan con la hora de envío nuestro sistema dibuja
>    un vehículo teletransportándose y calcula mal los tiempos de llegada. Es el dato más
>    importante de toda la integración.
> 2. **Placa e IMEI, los dos.** La placa es como identificamos la unidad; el IMEI es estable
>    aunque la placa cambie. Con ambos podemos mantener la correspondencia sin errores.
> 3. **Odómetro: indíquennos si proviene del CAN bus del vehículo o de un cálculo por GPS.**
>    No es lo mismo para nosotros: el primero es el número del tablero, el segundo acumula
>    desviación. Necesitamos saber cuál es para usarlo correctamente.
> 4. **Reintentos.** Si respondemos con un error o no respondemos (código 5xx o timeout),
>    ¿reintentan?, ¿cuántas veces?, ¿se pierde el dato? Respondemos `200` en cuanto
>    recibimos.
> 5. **Frecuencia.** ¿Cada cuántos segundos reportan en movimiento y en reposo? ¿Es
>    configurable? Para nuestro uso, cada 15–30 segundos en movimiento es suficiente.
>
> **Preguntas adicionales:**
>
> - ¿Su plataforma expone geocercas, tiempo estimado de llegada o eventos de
>   entrada/salida? Si el ETA existe, ¿considera tráfico en tiempo real?
> - ¿Reportan eventos de conducción (frenada brusca, exceso de velocidad, ralentí)?
> - ¿Volumen o tarifa por número de posiciones enviadas?
>
> **Si el webhook no es posible**, indíquennos cuál de estas sí:
> **(a)** credenciales de solo lectura de su API, con su documentación;
> **(b)** retransmisión TCP/UDP hacia un host y puerto que les proporcionamos, indicándonos
> el protocolo y formato de trama para poder decodificarla.
>
> Contacto técnico AFA: administracion@afatoursperu.com

---

## 9. Lo que falta del lado del ERP (y por qué no se construyó todavía)

El endpoint `/api/gps/ingesta` **no existe aún**. No se construye antes de la respuesta del
proveedor a propósito: la forma del receptor depende de qué modalidad ofrezcan (webhook,
API de consulta o tramas TCP), y escribir el de webhook antes de saberlo sería adivinar.

Cuando respondan, el trabajo del lado del ERP es:

1. **`supabase/ubicaciones-gps-fuente.sql`** — columna `fuente` nullable y sin default. Sin
   correrla, todo se comporta exactamente como hoy.
2. **El receptor**, que resuelve `placa → vehiculo_id / vehiculo_tercero_id` y, sobre todo,
   **`placa + fix_ts → reserva_id`**: una posición sin servicio asociado no sirve para el
   seguimiento (todas las pantallas filtran por `reserva_id`). Fuera de horario de servicio
   se guarda igual, con `reserva_id` nulo, y sirve para odómetro y auditoría.
3. **La decisión que hay que tomar con datos, no antes:** con las dos fuentes reportando a
   la vez, el celular del conductor (en la cabina) y el equipo (bajo el tablero) están a
   unos metros, y cada uno con su propio error. Intercalar las dos trazas fabrica un
   zigzag de decenas de metros que **`lib/km-servicio.ts` sumaría como kilómetros
   recorridos** — `limpiarHuella` solo descarta saltos mayores a 300 m, así que ese ruido
   pasa el filtro. Por eso la columna `fuente` no es decorativa: los lectores de traza
   deben **preferir una sola fuente por servicio** (el equipo cuando cubrió esa ventana, el
   celular cuando no), en vez de mezclarlas. Las dos se guardan siempre; lo que se elige es
   cuál se lee.
4. **`/api/gps-salud`** pasa a reportar la cobertura **por fuente**, que es lo que contesta
   «¿este servicio lo cubrió el equipo o el celular?» sin mirar la base.

Nada de esto toca Google, ni el cotizador, ni la geocodificación, ni el dibujo de rutas.
