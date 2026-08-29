# Plantilla `conductor_asignacion_multiple` (WhatsApp / Meta)

## Cómo crearla (sin salir del ERP)

**ERP → Configuración → Operaciones** (`/configuracion/operaciones`), bloque
**"Crear plantilla nueva"** → botón **"Prellenar: varios servicios asignados"** → revisa
y pulsa crear. Sale ya rellenada con todo lo de abajo y se manda sola a revisión de Meta.

Alternativa manual: **WhatsApp Manager → Plantillas**, en la cuenta **Afa Notificaciones
(+51 905438216)** — la WABA de avisos (`1336334522036982`), que es de donde salen los
mensajes a conductores y pasajeros.

Mientras no exista y esté **aprobada**, no se rompe nada: el motor detecta que el envío
agrupado falló y cae automáticamente a los mensajes de siempre, uno por servicio
(`app/api/alertas-flota/tick/route.ts`, bloque "RESPALDO"). En cuanto Meta la apruebe,
el agrupado empieza a usarse solo, sin desplegar nada.

## Configuración

| Campo | Valor |
|---|---|
| Nombre | `conductor_asignacion_multiple` |
| Categoría | **Utility** (no Marketing — es operativo) |
| Idioma | Español (`es`) |
| Encabezado | ninguno |
| Botones | **ninguno** |
| Pie de página | `AFA Notificaciones · Mensaje automático, no respondas aquí.` (59 de 60 caracteres) |

Los botones de mapa se omiten a propósito: son por servicio, y aquí hay varios. El
detalle de cada uno está en la app del conductor.

## Cuerpo

```
Hola {{1}} 👋

📋 *{{2}} servicios asignados* para el {{3}}

{{4}}

☎️ Coordinador de Operaciones: {{5}}
📱 Ruta y detalle de cada servicio en la app AFA conductor.
```

Los iconos van en el texto FIJO, uno por bloque, para que el conductor localice de un
vistazo qué es cada parte. El listado (`{{4}}`) va numerado con emoji desde el código.

**El orden de las dos últimas líneas no es estético:** Meta rechaza las plantillas cuyo
cuerpo TERMINA en una variable. Con `{{5}}` al final, la plantilla queda bloqueada al
enviarla a revisión. Por eso cierra la línea de la app, que es texto fijo.

## Variables

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre corto del conductor | `Peter` |
| `{{2}}` | Cantidad de servicios | `4` |
| `{{3}}` | Fecha, o `varias fechas` si no coinciden | `viernes 28 de agosto` |
| `{{4}}` | Listado en UNA línea, numerado con emoji y separado por 4 espacios | `1️⃣ 06:35 El Agustino → Punta Hermosa    2️⃣ 10:35 Primero de Mayo → Villa` |
| `{{5}}` | Teléfono de contingencia (del directorio, `es_contingencia=true`) | `+51 999 888 777` |

**Ojo con `{{5}}`:** el texto fijo lo presenta como *"Coordinador de Operaciones"*, pero el
valor sale de `alerta_destinatarios` donde `es_contingencia = true`. Verifica que esa ficha
del directorio sea esa persona; si la tabla está vacía, el código cae al respaldo fijo
`+51 912 569 005` (`telefonoContingencia()` en `lib/alertas.ts`).

### Ejemplos que pide Meta al crear la plantilla

Meta exige valores de muestra para aprobar. Usa estos:

- `{{1}}` → `Peter`
- `{{2}}` → `4`
- `{{3}}` → `viernes 28 de agosto`
- `{{4}}` → `1️⃣ 06:35 El Agustino → Punta Hermosa    2️⃣ 10:35 Primero de Mayo → Villa El Salvador`
- `{{5}}` → `+51 999 888 777`

## Por qué `{{4}}` va en una sola línea

**Meta rechaza los parámetros de plantilla que contengan saltos de línea, tabulaciones o
más de 4 espacios seguidos.** No se puede maquetar la lista con `\n` desde el código: el
envío fallaría entero. Verificado contra la API: devuelve `Param text cannot have new-line/tab characters or
more than 4 consecutive spaces`. No hay truco que lo esquive — ni `<br>`, ni entidades.

Lo que sí se permite son **hasta 4 espacios seguidos**, y eso es justo lo que se usa para
separar los servicios (`SEP_SERVICIOS` en `lib/notificaciones.ts`). Por eso `unaLinea()`
sólo recorta las rachas de 5 o más: colapsarlas todas a un espacio, como hacía antes,
dejaba la lista apelmazada. Cada item se limpia por separado y se unen después, para que
esa limpieza no se coma el propio separador.

La numeración con emoji (1️⃣ 2️⃣ 3️⃣…) refuerza la lectura como lista; a partir del 11 no
hay emoji de teclado y se cae a `11.`.

Los saltos de línea que sí se ven en el mensaje son los del **texto fijo** de la
plantilla, alrededor de `{{4}}` — esos sí están permitidos.

## Correo

No hay que hacer nada aparte. `lib/plantilla-texto.ts` lee el body aprobado desde la
Graph API y lo reutiliza como cuerpo del correo, así que el email dice exactamente lo
mismo que el WhatsApp en cuanto la plantilla exista.

## Qué agrupa y qué no

Sólo la **asignación** de servicios. Se dejó fuera a propósito:

- **cambio** de hora o vehículo,
- **cancelación**,
- **desasignación**,
- recordatorios y aviso de llegada.

Cada uno de esos informa un hecho distinto sobre un servicio concreto; agruparlos
escondería el que importa.
