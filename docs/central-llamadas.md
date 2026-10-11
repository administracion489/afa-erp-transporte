# Central de llamadas propia (sin Twilio)

La llamada automática al conductor que **no pulsó INICIAR**: si a los 3 minutos de la hora
del servicio sigue sin iniciar, el teléfono le suena y una voz le pide abrir el app.

La parte del ERP **ya está hecha** (la cola, el paso de la escalera, la puerta por donde la
central toma las llamadas, y el resultado en la ficha del servicio y en el aviso al
coordinador). Lo que falta es **la central**: un equipo con un chip que haga las llamadas.
Esta guía dice qué comprar, cómo se conecta y qué tiene que hacer su programa.

---

## 0. Lo que se puede y lo que no

**Una llamada telefónica normal siempre sale por la línea de un operador** (un chip de
Claro, Movistar, Entel o Bitel). Eso no lo evita nadie: Twilio también usa la línea de un
operador, solo que cobra por minuto encima.

Lo que sí se evita es el **intermediario**: en vez de pagarle a Twilio por cada llamada,
AFA tiene su **propia central** — un equipo con un chip de **llamadas ilimitadas** — y el
costo es el plan del chip, fijo al mes. El programa de la central es libre y gratuito.

¿Por qué una llamada normal y no una de WhatsApp o del app? Porque el caso que más la
necesita es el **teléfono sin datos**: sin datos no le llega el WhatsApp ni la notificación
del app, pero una llamada normal sí.

---

## 1. Qué hace el ERP (ya está)

- **Paso «Llamada: aún no inicia»** en la escalera de inicio (tarjeta en
  Configuración → Alertas y Mensajes). Si el servicio sigue sin iniciar **3 minutos después
  de la hora** (2 después del WhatsApp «ya debió iniciar»), pone la llamada en cola.
- **Antes de marcar vuelve a mirar el servicio**: si ya se inició, la llamada se cancela.
  A un conductor que ya va manejando no se le hace sonar el teléfono.
- **Si no contesta, se reintenta una vez** a los 2 minutos. La llamada **vence** a los
  15 minutos de la hora: para entonces ya le avisó el sistema al coordinador.
- **Si el conductor marca 2** («hablar con el coordinador»), los contactos marcados en la
  tarjeta reciben un WhatsApp para llamarlo.
- **El resultado se ve** en Seguimiento → ficha del servicio → «Avisos al conductor»
  («Llamada 06:33: no contestó (2 intentos)») y va dentro del aviso al coordinador.
- **La tarjeta nace APAGADA**: sin central conectada, las llamadas se quedarían en cola y
  vencerían sin salir. Se enciende cuando la central esté instalada. Mientras esté
  encendida y la central no se conecte, la tarjeta lo dice en ámbar.

---

## 2. Qué comprar

Hay dos centrales posibles y **el ERP es el mismo para las dos**: se puede empezar con una y
pasar a la otra sin tocar nada del sistema.

Precios consultados el **11-10-2026**. Son referenciales y cambian seguido.

### Para empezar (recomendado): un celular Android, que solo hace sonar

| Qué | Para qué | Costo aprox. |
|---|---|---|
| **Un celular Android 10 o más nuevo, comprado en una tienda en Perú** (o uno que la empresa ya tenga) | Hace las llamadas. Queda **solo para esto**, en la oficina | El que haya, o uno básico nuevo |
| **Chip nuevo con llamadas ilimitadas**, a nombre de la empresa | La línea por donde salen las llamadas. **No** el de avisos ni el del Radar | Desde ~S/ 29.90 al mes en los cuatro operadores |
| **La app «AFA Central»** | Pregunta al ERP a quién llamar, marca y cuenta si contestó | No se compra. **Pendiente de programar** cuando se elija esta opción |

**Qué hace**: hace sonar el teléfono del conductor y sabe si contestó. **No le habla**:
Android no deja que una app ponga una voz dentro de una llamada.

**Para que el timbre ya diga qué hacer**, cada conductor guarda el número de la central en
sus contactos como **«AFA – PULSA INICIAR»**. Aunque no conteste, la pantalla de la llamada
ya le dice qué hacer.

**Por qué conviene empezar por aquí:**

- **Cuesta casi nada y no necesita técnico**: se instala la app, se pone la clave y se deja
  enchufado.
- **Aguanta un corte de luz**, porque tiene batería, **y un corte de internet**: si se cae el
  WiFi de la oficina, usa los datos de su propio chip. Los servicios empiezan de madrugada.
- **Para el operador es un celular común.** Si se compró en una tienda formal en Perú, la
  tienda lo registra en la lista blanca de OSIPTEL (ver el punto 3 de la lista del gateway).
- **Mide antes de invertir.** Si en un mes la ficha de cada servicio muestra que los
  conductores contestan y aun así no pulsan INICIAR, recién vale la pena pagar la voz. En
  ese caso el celular queda de respaldo.

**Cómo dejarlo instalado:**

- Siempre enchufado y con WiFi.
- La app como **app de teléfono predeterminada** de ese celular. Así sabe con exactitud
  cuándo contestaron.
- La app **sin ahorro de batería**. Si no, Android la duerme y deja de preguntar.

### Con voz: gateway celular + Asterisk

Un **gateway** es una cajita con una ranura para un chip, como un celular sin pantalla. Se
conecta por cable a la red de la oficina y deja que una computadora haga llamadas normales
por ese chip.

La computadora corre **Asterisk**, la central telefónica (libre y gratuita), y con eso hace
exactamente lo pedido:

- Llama y dice con voz: *«Hola Sergio. Te llama la central de AFA. Tu servicio de las seis
  y treinta de la mañana, desde Puente Santa Anita, ya debió iniciar. Abre el app del
  conductor y pulsa INICIAR»*.
- Lee *«marca 1 si ya estás en ruta, marca 2 para hablar con el coordinador»*.
- Sabe si contestó y cuánto duró.

| Qué | Costo aprox. |
|---|---|
| **Gateway 4G** (ver la lista de abajo) | De S/ 2,900 a 3,300 en Lima. Importado: ~€ 300 (Portech) o ~US$ 550 (Yeastar 4G), más envío e impuestos |
| **Computadora pequeña con disco SSD** (una mini-PC, o una PC vieja con Linux) | La que haya. Mejor con SSD que un Raspberry Pi con tarjeta de memoria, que se daña con los cortes de luz |
| **Chip con llamadas ilimitadas**, a nombre de la empresa | Desde ~S/ 29.90 al mes |
| **Un UPS pequeño** para el gateway, la computadora y el router | Los servicios empiezan de madrugada |
| **Un técnico de Asterisk o Issabel** que lo instale | Cotizar |

El gateway y la computadora van juntos en la oficina, en la misma red.

**Lo que se encontró a la venta (octubre 2026):**

- **Yeastar TG200** (2 chips): **S/ 2,906 a 3,301 en Lima**, en Arteus (Cyber Plaza) y en
  Tienda de Cómputo Perú. Es una marca conocida y compatible con Asterisk. **Confirmar con el
  vendedor si es la versión 3G o la 4G (LTE)**: las de Lima se anuncian como GSM/3G.
- **Yeastar TG200 LTE-A** (4G; el fabricante anuncia VoLTE): **~US$ 549 en EE. UU.**, más
  envío e impuestos. Sus bandas 4G son la 2, la 4 y la 12: sirven para Movistar, Entel y
  Claro, no para Bitel.
- **Portech MV-370-4G** (1 chip, 4G): **~€ 293 a 337 sin IVA en Alemania**, más envío e
  impuestos. Tiene bandas 4G amplias (incluye la 2, 4, 7 y 28). **No dice si hace VoLTE**:
  hay que preguntarlo.
- **Yeastar TG100** (1 chip): **solo 2G/3G, no 4G**.
- **GoIP-1** (S/ 780 a 899 en Mercado Libre Perú): **no comprar**. Los que se ofrecen son 2G
  (GSM), la red más vieja y la primera que se apaga en todo el mundo.

**Antes de comprar un gateway, preguntarle al vendedor:**

1. **¿Hace las llamadas por 4G (VoLTE) o necesita 3G?** El 2G y el 3G se están apagando en
   el mundo. No se encontró un calendario de apagado en Perú, pero un equipo que depende del
   3G se queda mudo el día que lo apaguen.
2. **¿Funciona con las bandas 4G de mi operador?** Movistar y Entel usan la banda 4 (y la
   28); Claro, la 2 (y la 28 y la 7); Bitel usa otras.
3. **¿Su IMEI está en la lista blanca de OSIPTEL (RENTESEG)?** OSIPTEL bloquea los equipos
   que no están en esa lista o tienen el IMEI alterado: en 2026 ya van más de un millón.
   - Si se compra en Perú, lo registra el vendedor formal.
   - Si se importa, se registra con el operador.
   - Se comprueba en <https://checatuimei.renteseg.osiptel.gob.pe>.
4. **¿Es compatible con Asterisk (SIP)?** Los modelos de arriba lo son.

**Con el operador**: conviene contarle para qué es la línea. Un equipo que solo hace
llamadas, siempre desde el mismo sitio, se parece a los «SIM box» que se usan para desviar
tráfico. El uso indebido es causal de suspensión de la línea.

---

## 3. Cómo se conecta

1. Correr **`supabase/llamadas-01-central.sql`** en el SQL Editor de Supabase.
2. En Vercel, agregar la variable **`CENTRAL_LLAMADAS_SECRET`** con una clave aleatoria de
   **24 caracteres o más** (sin ella, la puerta de la central no deja pasar a nadie).
   Redesplegar.
3. Instalar la central (ver el contrato abajo) con esa misma clave.
4. Comprobar que la tarjeta «Llamada: aún no inicia» dice **«Central de llamadas
   conectada»**, y recién entonces **encenderla**.

---

## 4. El contrato (para quien programa la central)

Una sola dirección: `POST https://transportesafa.com/api/llamadas/central`, con
`Authorization: Bearer <CENTRAL_LLAMADAS_SECRET>` y cuerpo JSON. La central **pregunta**;
el ERP nunca la llama a ella (así no hace falta abrir puertos en la oficina).

### Preguntar si hay a quién llamar (cada 5–10 segundos)

```json
{ "accion": "tomar", "equipo": "central-oficina", "version": "1.0.0" }
```

Respuesta sin nada que hacer: `{ "ok": true, "llamada": null }`. Con una llamada:

```json
{
  "ok": true,
  "llamada": {
    "id": 123,
    "telefono": "+51987654321",
    "mensaje": "Hola Sergio. Te llama la central de AFA. Tu servicio de las seis y treinta de la mañana, desde Puente Santa Anita, ya debió iniciar. Abre el app del conductor y pulsa INICIAR.",
    "menu": "Si ya estás en ruta, marca uno. Para hablar con el coordinador, marca dos.",
    "intento": 1,
    "max_intentos": 2
  }
}
```

La llamada queda **tomada** por esa central (nadie más la toma). Preguntar también cuenta
como latido: con eso la pantalla sabe que la central está conectada. Primero salen las
llamadas reales y después las de prueba.

### Marcar

- Llamar a `telefono`, esperar unos **30 segundos** de timbre.
- Si contesta: decir `mensaje` (voz sintética en español, p. ej. Piper, o grabaciones), y
  si la central lee teclas, decir `menu` y esperar 1 o 2 unos 5 segundos. Repetir el
  mensaje una vez si no marca nada.
- **No reintentar por su cuenta**: los reintentos los decide el ERP (vuelve a dar la
  llamada en `tomar` cuando toque).
- **Una central que solo hace sonar (Android)** ignora `mensaje` y `menu`, corta a los
  ~30 segundos de timbre (o a los pocos segundos de que contesten) y nunca manda `opcion`.

### Contar lo que pasó (siempre, también si falló)

```json
{ "accion": "resultado", "id": 123, "intento": 1, "estado": "contestada", "duracion_seg": 14, "opcion": "1" }
```

- `intento`: el que dio `tomar`. **Obligatorio**: un resultado atrasado del intento 1 que
  llega cuando ya se está marcando el 2 se rechaza (409) en vez de cerrar la llamada.
- `estado`: `contestada` · `no_contesto` · `ocupado` · `fallida` (no se pudo marcar: sin
  señal, sin saldo…; explicar en `detalle`, hasta 200 caracteres).
- `opcion`: `"1"` o `"2"`, solo en una `contestada`, y solo si la central lee teclas.
- Una llamada tomada que no recibe resultado en **5 minutos** se da por fallida («la central
  no informó el resultado»).

### Latido sin pedir llamadas (opcional)

```json
{ "accion": "latido", "equipo": "central-oficina", "version": "1.0.0", "detalle": "señal 4/5" }
```

### Seguridad del programa de la central

- **`mensaje` y `menu` son texto, nunca código.** El ERP ya deja solo letras, números y la
  puntuación de una dirección, y los acorta, pero la central igual debe pasarlos a la voz
  como texto: **nunca** interpolarlos en un comando de shell, en el dialplan de Asterisk ni
  en un AGI.
- El secreto vive solo en la central y en Vercel. Si se filtra, se cambia en los dos sitios.
  Mejor aún: que la central salga a internet desde una IP fija y limitar a ella la puerta.

---

## 5. Probar

En Configuración → Alertas y Mensajes, la tarjeta «Llamada: aún no inicia» muestra si la
central está conectada. Con la central instalada, un **administrador** pide una llamada de
prueba igual que los WhatsApp de prueba (🧪 Probar los avisos): una a la vez y hasta 5 al
día.
