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
| Pie | ninguno |

Los botones de mapa se omiten a propósito: son por servicio, y aquí hay varios. El
detalle de cada uno está en la app del conductor.

## Cuerpo

```
Hola {{1}}, se te asignaron {{2}} servicios para el {{3}}:

{{4}}

Revisa el detalle de cada uno en la app. Ante cualquier duda: {{5}}
```

## Variables

| Var | Contenido | Ejemplo |
|---|---|---|
| `{{1}}` | Nombre corto del conductor | `Peter` |
| `{{2}}` | Cantidad de servicios | `4` |
| `{{3}}` | Fecha, o `varias fechas` si no coinciden | `viernes 28 de agosto` |
| `{{4}}` | Listado en UNA línea, separado por ` • ` | `06:35 El Agustino → Punta Hermosa • 10:35 Primero de Mayo → Villa` |
| `{{5}}` | Teléfono de contingencia (del directorio, `es_contingencia=true`) | `+51 999 888 777` |

### Ejemplos que pide Meta al crear la plantilla

Meta exige valores de muestra para aprobar. Usa estos:

- `{{1}}` → `Peter`
- `{{2}}` → `4`
- `{{3}}` → `viernes 28 de agosto`
- `{{4}}` → `06:35 El Agustino → Punta Hermosa • 10:35 Primero de Mayo → Villa El Salvador`
- `{{5}}` → `+51 999 888 777`

## Por qué `{{4}}` va en una sola línea

**Meta rechaza los parámetros de plantilla que contengan saltos de línea, tabulaciones o
más de 4 espacios seguidos.** No se puede maquetar la lista con `\n` desde el código: el
envío fallaría entero. Por eso el listado viaja en una línea con ` • ` como separador
(`unaLinea()` en `lib/notificaciones.ts` lo garantiza) y WhatsApp lo ajusta solo.

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
