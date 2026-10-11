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

### Recomendado: central con voz

| Qué | Para qué | Costo |
|---|---|---|
| **Gateway celular de 1 chip** (VoIP-GSM/4G) | Convierte un chip en una línea que una computadora puede marcar | Una vez, ~US$ 100–250 |
| **Chip nuevo con llamadas ilimitadas** | La línea por donde salen las llamadas. **Solo para esto**: no el de avisos ni el del Radar | Plan mensual, ~S/ 30–50 |
| **Una computadora pequeña** (mini-PC, Raspberry Pi o una PC vieja con Linux) | Corre **Asterisk**, la central telefónica (libre y gratuita), y el programa que habla con el ERP | La que haya, o ~US$ 80–150 |

Hace exactamente lo pedido: llama, dice con voz *«Hola Sergio. Te llama la central de AFA.
Tu servicio de las seis y treinta de la mañana, desde Puente Santa Anita, ya debió iniciar.
Abre el app del conductor y pulsa INICIAR»*, lee *«marca 1 si ya estás en ruta, marca 2 para
hablar con el coordinador»* y sabe si contestó y cuánto duró.

El gateway y la computadora van juntos en la oficina, en la misma red, con corriente
estable (mejor con un pequeño UPS: los servicios empiezan de madrugada).

### Alternativa sin comprar equipo: un celular Android

Un celular Android viejo con el chip y una app de AFA instalada. **Solo hace sonar** el
teléfono del conductor («AFA Central» llamando) y sabe si contestó o no: **no puede
hablarle ni leer teclas**, porque Android no deja que una app ponga una voz dentro de una
llamada. Sirve como primer paso si el conductor ya sabe que «si me llama la Central, tengo
que pulsar INICIAR».

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
