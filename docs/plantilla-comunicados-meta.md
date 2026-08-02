# Crear la plantilla `comunicado_afa` en Meta

Necesaria **solo** para mandar los comunicados por WhatsApp con el PDF adjunto.
El canal **correo funciona sin esto**: si aún no está aprobada, manda solo por correo.

## Por qué hace falta

WhatsApp no permite escribirle a alguien que no te escribió en las últimas 24 h, salvo
con una **plantilla aprobada por Meta**. Como los cuadros de horarios van como documento,
la plantilla necesita un **encabezado de tipo Documento**. Meta la revisa en minutos u horas.

---

## Paso a paso

### 1. Abrir el WhatsApp Manager correcto

[business.facebook.com](https://business.facebook.com) → **WhatsApp Manager** →
**Plantillas de mensajes** → **Crear plantilla**.

> ⚠️ **Elige la cuenta correcta.** Tienes dos números con API oficial:
> - **Afa Notificaciones — +51 905438216** ← **esta**, la de avisos a pasajeros/conductores
> - Afa Transporte — +51 966707225 (CRM/campañas)
>
> Los comunicados salen del número de **avisos**. Si creas la plantilla en la cuenta del
> CRM, el envío fallará con *"template not found"* aunque la veas aprobada.

### 2. Datos de la plantilla

| Campo | Valor exacto |
|---|---|
| **Categoría** | `Utilidad` (Utility) |
| **Nombre** | `comunicado_afa` |
| **Idioma** | **Español** → código `es` |

> ⚠️ **La trampa más común es el idioma.** Debe quedar como **`es`**, no `es_LA`,
> `es_MX` ni `es_AR`. Si eliges "Español (Latinoamérica)" Meta guarda `es_LA` y el envío
> falla, porque el ERP pide `es`. Al elegir el idioma verás el código junto al nombre:
> confirma que dice `es` a secas.
>
> **Categoría Utilidad, no Marketing:** los mensajes de Marketing exigen que el
> destinatario haya aceptado publicidad, y tus pasajeros no lo hicieron. Además Utilidad
> es más barata. Si Meta te la reclasifica a Marketing, revisa que el texto no suene
> promocional.

### 3. Encabezado

Selecciona **Encabezado → Documento**.

Meta pedirá un **archivo de ejemplo**: sube cualquier PDF (por ejemplo uno de los cuadros
de horarios). Es solo para la revisión — en cada envío el ERP manda el PDF real.

### 4. Cuerpo

Pega este texto tal cual:

```
Estimado(a) {{1}}:

{{2}}

Adjuntamos el documento con la información. Si tiene consultas, puede responder a este mensaje.

Atentamente, AFA Transportes.
```

Meta pedirá un **ejemplo por cada variable**, en orden:

- `{{1}}` → `Carlos Ramírez`  *(nombre del pasajero, lo pone el sistema)*
- `{{2}}` → `Le compartimos los horarios actualizados de sus paraderos.`  *(el mensaje que escribas en el ERP)*

### 5. Botones

**Ninguno.** Déjalo vacío — el ERP no envía parámetros de botón para esta plantilla y
agregar uno dinámico haría fallar el envío.

### 6. Enviar y esperar

**Enviar para revisión.** Estado `PENDING` → `APPROVED` en minutos u horas.

Puedes seguir el estado sin salir del ERP: **Configuración → Alertas y Mensajes →
"Textos de los mensajes" → Cargar plantillas desde Meta**.

---

## Comprobar que quedó bien

1. **Comunicados** → crear uno de prueba, subir un cuadro, marcar solo WhatsApp.
2. **Probar** → tu propio número.
3. Debe llegar un mensaje con **`Horarios.pdf`** adjunto arriba y el texto debajo.

## Si falla

| Mensaje de error | Causa | Solución |
|---|---|---|
| `template name does not exist` | Idioma `es_LA` en vez de `es`, o creada en la cuenta del CRM | Revisa idioma y cuenta; el nombre se compara junto con el idioma |
| `Template is not approved` | Sigue en revisión | Espera; mientras tanto usa solo correo |
| `Number of parameters does not match` | Se editó el cuerpo y cambió la cantidad de `{{n}}` | El cuerpo debe tener exactamente `{{1}}` y `{{2}}` |
| `document link is not accessible` | El bucket no es público | Ejecuta `supabase/comunicados.sql`, que crea `comunicados-media` público |

## Si prefieres otro nombre

El ERP busca `comunicado_afa` por defecto. Para usar otro, define la variable de entorno:

```bash
META_TEMPLATE_COMUNICADO=el_nombre_que_elegiste
```

en `.env.local` y en Vercel. No hace falta tocar código.
