# Contratos Marco de Proveedores de Transporte — Arquitectura

> **Estado: PROPUESTA. Nada de esto está implementado todavía.**
> Este documento es el paso 15 del requerimiento ("analiza primero, implementa después").
> Léelo entero antes de escribir la primera línea de SQL.

---

## 0. Veredicto en una página

El requerimiento pide 11 cosas. **Ocho ya existen en el ERP** y lo que falta es
engancharlas; **tres son genuinamente nuevas**. El riesgo principal de este
proyecto no es construir de menos: es **construir de nuevo lo que ya está
construido** y terminar con dos verdades del mismo monto — exactamente lo que
prohíbe la regla de oro de `supabase/finanzas-00-fundacion.sql:22-24`.

| # | Lo que pide el requerimiento | Estado real | Qué se hace |
|---|---|---|---|
| 1 | Módulo Contratos | **No existe** | Crear `contratos_proveedor` |
| 2 | El contrato no genera OC/factura/pago | — | Se cumple *por omisión*: cero triggers salientes |
| 3 | Ver servicios/liquidaciones/facturas/pagos del contrato | Las 4 tablas existen | Una **vista** que las agrega por `contrato_id` |
| 4 | Liquidación de servicio | **Ya existe y es mejor de lo que se pide** | Añadir `contrato_id`. Nada más |
| 5 | Factura del proveedor | **Ya existe** (`documentos_compra`) | Añadir `contrato_id` + estado `anulada` |
| 6 | Utilidad bruta y margen % | Existe, pero **con IGV mezclado** | Vista nueva que neteo el IGV. No tocar lo viejo |
| 7 | Documentación del proveedor | **Ya existe con alertas y portal** | Reubicarla: hoy cuelga de la entidad equivocada |
| 8 | Cláusulas de confidencialidad / no captación | **No existe** | `contrato_plantillas` versionadas |
| 9 | Botón "Generar contrato" (PDF) | Pipeline PDF existe | Reusar `lib/pdf-chrome.ts` |
| 10 | Alertas 90/60/30/vencido | Motor de alertas existe | Umbrales propios + cron existente |
| 11 | Dashboard de contratos | Patrón de KPI existe | Vista + tarjetas |

**Las tres cosas realmente nuevas son:** la entidad contrato, las cláusulas
versionadas y el margen sin IGV. Todo lo demás es una columna `contrato_id` y una
vista.

---

## 1. El hallazgo crítico: el proveedor tiene DOS identidades

Esto es lo que hay que decidir antes que nada, porque de aquí cuelga todo lo demás.

En el ERP conviven **dos tablas** que describen "empresa que le presta servicio de
transporte a AFA":

```
proveedores                          empresas_tercerizadas
─────────────                        ─────────────────────
id, nombre, ruc, tipo,               id, razon_social, ruc, estado,
telefono, email, direccion,          cochera, contacto_*, …
contacto_*, estado                   + vehiculos_tercero
+ cuenta_bancaria, cci,              + conductores_tercero
  condicion_pago_dias,               + documentos_tercero
  detraccion_pct, retencion_pct      + proveedor_tokens (portal)

IDENTIDAD FISCAL / COMERCIAL          IDENTIDAD OPERATIVA
apunta aquí:                          apunta aquí:
  documentos_compra.proveedor_id        reservas.empresa_tercerizada_id
  ordenes_compra.proveedor_id           documentos_tercero.empresa_id
  pagos.contraparte_id                  vehiculos_tercero.empresa_id
  gastos.proveedor_id                   liquidacion_proveedor.empresa_tercerizada_id
```

**El puente ya existe** — `supabase/finanzas-02-compras-cxp.sql:133` agregó
`empresas_tercerizadas.proveedor_id → proveedores(id)`. Pero es **opcional y
probablemente esté vacío**: se creó con el helper `_fin_add_fk()`, que ni siquiera
aborta si falla, y nunca hubo un backfill ni una UI que lo llene.

`liquidacion_proveedor` es el síntoma: tiene **las dos** FK (`proveedor_id` *y*
`empresa_tercerizada_id`, `liquidaciones-v2.sql:354-355`) porque nadie se decidió.

### Decisión propuesta

**El contrato cuelga de `proveedores`.** Un contrato marco se firma con una
persona jurídica con RUC, no con una flota. Y es la entidad a la que ya apuntan
la factura, la OC y el pago — es decir, el lado del requerimiento que habla de
dinero.

**El lado operativo se alcanza navegando** `empresas_tercerizadas.proveedor_id`.

**Consecuencia obligatoria — esto es Fase 0, no es opcional:** hay que llenar
`empresas_tercerizadas.proveedor_id`. Sin eso, un contrato firmado con
"Transportes XYZ S.A.C." no puede ver ni un solo servicio ejecutado, porque los
servicios cuelgan de la otra tabla. El módulo se vería vacío y funcionando.

> **Alternativa que NO recomiendo:** colgar el contrato de `empresas_tercerizadas`.
> Es más corto hoy (los servicios se ven de una) y rompe mañana: la factura y el
> pago quedarían sin camino al contrato, y habría que duplicar el vínculo.

---

## 2. Inventario: lo que ya existe y hay que reusar

### 2.1 Liquidación de servicio al proveedor — **ya construida**

`supabase/liquidaciones-v2.sql:297` define `liquidacion_proveedor`. Comparado
campo por campo con lo que pide el punto 4 del requerimiento:

| Campo pedido | ¿Existe? | Dónde |
|---|---|---|
| Proveedor | Sí | `proveedor_id` + `empresa_tercerizada_id` |
| **Contrato marco** | **NO** | ← lo único que falta |
| Servicio | Sí | `liquidacion_proveedor_linea_reserva` (N:M real) |
| Cliente de AFA | Derivable | vía `reservas.cliente_id` |
| Fecha | Sí | `fecha`, `periodo_desde/hasta`, `fecha_valorizacion` |
| Ruta | Derivable | vía `reservas.ruta_nombre / origen / destino` |
| Vehículo | Derivable | vía `reservas.vehiculo_tercero_id` |
| Conductor | Derivable | vía `reservas.conductor_tercero_id` |
| Importe del servicio | Sí | `subtotal`, `igv`, `total_comprobante`, `total` |
| **Estado de conformidad** | **Sí** | `conformidad_estado` + sello + IP + canal + token público |

También trae, gratis: correlativo `LQP-AAAA-NNNNNN`, detracción, anticipos,
bitácora de envíos (`liquidacion_envio`) y de eventos (`liquidacion_evento`),
`pdf_url`, y estados `borrador→emitida→conformada→por_pagar→pagada|anulada`.

**Acción: añadir `contrato_id`. Nada más.** Crear una tabla de liquidaciones nueva
sería el peor error posible de este proyecto.

> Ojo: `supabase/finanzas-03-liquidaciones.sql` define una versión **anterior** de
> estas mismas tablas (con `_detalle` en vez de `_linea`). `liquidaciones-v2.sql`
> la sustituye. Trabajar siempre contra la v2.

### 2.2 Factura del proveedor — **ya construida**

`supabase/finanzas-02-compras-cxp.sql:23` define `documentos_compra`. **No existe
—ni debe existir— una tabla `cuentas_por_pagar`:** el comprobante es la fuente
única del monto y el saldo se deriva de `pagos_aplicacion`.

| Campo pedido | ¿Existe? |
|---|---|
| Proveedor | `proveedor_id`, `ruc_emisor`, `razon_social` |
| **Contrato marco** | **NO** ← falta |
| **Una o varias liquidaciones** | Parcial: `liquidacion_proveedor_id` es **1:1** ← falta N:M |
| Servicios realizados | `documentos_compra_detalle.reserva_id` |
| Importe / IGV / Total | `subtotal`, `igv`, `total` (+ detracción, retención) |
| Fecha factura / vencimiento | `fecha_emision`, `fecha_vencimiento` |
| Estado Pendiente/Parcial/Pagada | `estado_pago in (impaga, parcial, pagada)` — `finanzas-02:67` |
| Estado **Anulada** | **NO en `estado_pago`** — vive en el otro eje, `estado_conciliacion` |

**Sobre "Anulada":** `documentos_compra` tiene **tres ejes ortogonales** de estado
y hay que respetarlos:

- `estado_pago` — impaga · parcial · pagada → **tesorería**
- `estado_conciliacion` — pendiente · conciliado · con_diferencia · **anulado** → **fiscal**
- `estado_aprobacion` — pendiente · aprobado_gerencia · incluido_lote · rechazado → **gasto**

El requerimiento mezcla los cuatro estados en una sola lista. **No los fusiones.**
"Anulada" se representa con `estado_conciliacion='anulado'`; la UI puede mostrar
un solo chip que los combine, pero la base guarda los tres por separado.

> **Cuidado con `/facturacion`:** ese módulo emite comprobantes de **venta al
> cliente** (tabla `facturas`). No tiene nada que ver con la factura del
> proveedor. No lo toques.

### 2.3 Pago — **ya construido**

`supabase/finanzas-01-tesoreria-pagos.sql:44` (`pagos`) y `:71`
(`pagos_aplicacion`). El saldo de una factura **se deriva**
(`total − Σ monto_aplicado`), nunca se guarda. `pagos_aplicacion.documento_tipo`
ya admite `'liquidacion_proveedor'` y `'documento_compra'`.

**El contrato no toca nada de esto.** Solo lo lee.

### 2.4 Documentación del proveedor — **ya construida, pero colgada del lado equivocado**

Existe el ciclo completo, y es bueno:

- `documentos_tercero` — tipo, número, `fecha_vencimiento`, entidad emisora, archivo
- `documentos_tercero_revisiones` (`proveedor-documentos-autoservicio.sql:36`) — cola de revisión: lo que sube el proveedor **no** reemplaza al vigente hasta que un operador lo aprueba
- `documentos_tercero_avisos` (`:61`) — log de avisos con dedupe
- `proveedor_tokens` (`:23`) — portal público del proveedor, `app/proveedor/[token]`
- Cron diario ya en `vercel.json` → `/api/notificaciones/proveedores-documentos`
- Umbrales en `lib/proveedor-documentos.ts:51` — `[30,15,7,3,1,0]` días, y cada 7 días vencido
- Semáforo `vigente/por_vencer/vencido` en `app/tercerizadas/page.tsx:97`
- 10 tipos ya definidos (`app/tercerizadas/page.tsx:78`): SOAT, CITV, SUTRAN, MTC, Tarjeta de Propiedad, SCTR Salud, SCTR Pensión, Todo Riesgo, Responsabilidad Civil, Otro

De los 10 tipos que pide el punto 7 del requerimiento, **7 ya existen**. Faltan:
Ficha RUC, Autorizaciones (genérico) y "Contrato vigente" — que no es un documento
suelto sino el PDF firmado del contrato, y va en `contratos_proveedor.pdf_firmado_url`.

**El problema real:** `documentos_tercero.empresa_id` apunta a
`empresas_tercerizadas`. **Un proveedor de transporte sin flota registrada no
tiene dónde archivar su Ficha RUC.** Y el requerimiento pide la sección
"DOCUMENTACIÓN" *dentro de cada proveedor*.

**Acción:** añadir `documentos_tercero.proveedor_id` (nullable) con un CHECK de
coherencia — al estilo de `cc_fondos_responsable_coherente` en
`finanzas-08` — para que un documento cuelgue de la empresa **o** del proveedor,
nunca de ambos ni de ninguno. Y una vista que, dado un `proveedor_id`, devuelva
los documentos propios **más** los de sus empresas tercerizadas.

### 2.5 Rentabilidad — existe, pero con el IGV mezclado

Aquí está la trampa más cara del requerimiento.

**Ya hay dos márgenes calculados, y no coinciden:**

1. `reservas.margen` — **columna guardada**, calculada en el navegador como
   `precio_cliente − costo_proveedor` (`app/programacion/page.tsx:2809`). Es el
   margen **pactado**.
2. `v_costo_servicio.margen_real` (`supabase/finanzas-06:1059`) — `precio_cliente`
   menos los costos **reales** (gastos + combustible + mantenimiento + caja chica
   + lo facturado por el tercero).

**Los dos están CON IGV.** La prueba: `app/facturacion/page.tsx:208` hace
`Number(cot.precio_cliente) / 1.18` para obtener el neto — con el 1.18 tecleado a
mano, ignorando `config_tributaria.igv_pct` que existe justamente para eso
(`finanzas-00:91`). Y `liquidaciones-v2.sql:201-205` lo dice con todas sus letras:

> *"`precios_incluyen_igv` resuelve la ambigüedad de `reservas.precio_cliente`: en
> el ERP el precio puede haberse cargado con IGV incluido (ver
> `cotizaciones.incluye_igv`)."*

O sea: **no se sabe fila por fila si `precio_cliente` lleva IGV.** Depende de cómo
se cargó la cotización.

El requerimiento es tajante: *"Utilizar siempre importes sin IGV para calcular
margen y utilidad"*.

**Propuesta — un tercer margen NO, una vista SÍ:**

Crear `v_rentabilidad_servicio` que **derive** el neto sin tocar ninguna columna:

```
venta_neta  = precio_cliente / (1 + igv_pct/100)   si el origen marca incluye_igv
            = precio_cliente                        si no
costo_neto  = costo_proveedor neteado igual, o el subtotal de la liquidación
              del proveedor cuando existe (que YA es neto y está firmado)
utilidad_bruta = venta_neta − costo_neto
margen_pct     = utilidad_bruta / venta_neta * 100    (null si venta_neta = 0)
```

Tres reglas que hacen esto correcto y no una cuarta verdad:

1. **El IGV sale de `config_tributaria.igv_pct`**, nunca de un `1.18` literal.
2. **Cuando existe liquidación del proveedor aprobada, su `subtotal` gana** sobre
   `reservas.costo_proveedor`: es un neto explícito, revisado y con conformidad.
   `costo_proveedor` es una estimación tecleada al programar.
3. **`reservas.margen` no se toca ni se borra** (lo leen `/programacion`,
   `/calendario`, `/dashboard`). Pero **nada nuevo se construye sobre él**, y la
   ficha de ayuda debe decir que es el margen *pactado con IGV*, no la utilidad
   bruta. Unificarlos es un proyecto aparte, con migración de datos, y no
   pertenece a este requerimiento.

**Nunca dividir entre 0.** Un servicio de cortesía con `precio_cliente = 0` debe
dar `margen_pct = null`, no infinito.

### 2.6 Lo que existe para el resto

| Necesidad | Qué reusar |
|---|---|
| Generar PDF | `lib/pdf-chrome.ts` (`buildHeaderPDFHtml`, `sharedCSS`, `esc`), patrón datos→HTML→ventana→imprimir de `lib/liquidacion-doc.ts` |
| Plantillas editables | `cotizacion_plantillas` (`app/cotizaciones/plantillas/page.tsx:59`) — mismo patrón |
| Datos de AFA | `empresa_perfil` id=1 (`app/configuracion/perfil/page.tsx:40`) |
| Correlativo `CM-AAAA-NNNNNN` | `fn_liq_set_codigo()` (`liquidaciones-v2.sql:434`), patrón SECURITY DEFINER |
| Bitácora de auditoría | `liquidacion_evento` (`liquidaciones-v2.sql:412`) |
| Alertas + dedupe + cron | `documentos_tercero_avisos` + `/api/notificaciones/proveedores-documentos` |
| Semáforo de vencimiento | `estadoDoc()` y `ESTADO_DOC_CFG` (`app/tercerizadas/page.tsx:97,136`) |
| KPIs del dashboard | `KpiCard` (`app/dashboard/page.tsx:236`) |
| Aprobación por gerencia | `fn_es_aprobador(uuid)` (`finanzas-06:34`), rol `gerente` |
| Ocultar costos por rol | Precedente ya en producción: `FichaServicio.tsx:42` oculta precio/costo/margen a quien no es admin |
| Almacenamiento | Bucket `documentos`, prefijo `proveedores/<id>/` |

### 2.7 Dos cosas rotas que este trabajo debería arreglar de paso

1. **`/vencimientos` es un enlace muerto.** `app/layout.tsx:376` lo publica en el
   menú y **no existe `app/vencimientos/`** → 404. Es el sitio natural para
   "contratos por vencer".
2. **`proveedores.tipo` admite `'transporte'`** desde
   `proveedores-tipo-concesionario.sql:21`, pero el selector de la UI
   (`app/proveedores/page.tsx:18-31`) **no lo ofrece**. Hoy no se puede dar de
   alta un proveedor de transporte desde la pantalla de proveedores.

---

## 3. Modelo de datos propuesto

Un solo archivo nuevo: `supabase/contratos-09-marco-proveedores.sql`, idempotente,
en el estilo de las fases financieras.

### 3.1 Tabla nueva — `contratos_proveedor`

```sql
create table if not exists public.contratos_proveedor (
  id                   bigserial primary key,
  numero               text unique,              -- CM-AAAA-NNNNNN (trigger)
  proveedor_id         int not null references public.proveedores(id),
  ruc                  text,                     -- SNAPSHOT al firmar, no un join

  -- Vigencia
  fecha_inicio         date not null,
  vigencia_anios       numeric(4,2) not null default 3,
  fecha_vencimiento    date not null,            -- explícita: admite prórrogas
                                                 -- que no son inicio + N años exactos

  estado               text not null default 'borrador'
    check (estado in ('borrador','pendiente_firma','vigente',
                      'vencido','resuelto','cancelado')),

  -- Firma
  fecha_firma          date,
  representante_proveedor        text,
  representante_proveedor_doc    text,   -- DNI/CE
  representante_proveedor_cargo  text,
  representante_afa              text,
  representante_afa_doc          text,
  representante_afa_cargo        text,

  -- Documentos
  plantilla_id         bigint references public.contrato_plantillas(id),
  clausulas_snapshot   jsonb not null default '[]'::jsonb,  -- ver §5
  pdf_generado_url     text,
  pdf_firmado_url      text,

  observaciones        text,
  motivo_resolucion    text,

  -- Auditoría (punto 13 del requerimiento)
  creado_por           text,
  actualizado_por      text,
  created_at           timestamptz not null default now(),
  updated_at           timestamptz not null default now(),

  constraint contrato_vigencia_coherente
    check (fecha_vencimiento > fecha_inicio),
  constraint contrato_firmado_tiene_fecha
    check (estado <> 'vigente' or fecha_firma is not null)
);
```

**Nota sobre `por_vencer`:** el requerimiento lo lista como estado. **No lo
guardes.** Es una función de `fecha_vencimiento` y de hoy: guardarlo obliga a un
cron que lo mantenga y crea una segunda verdad de la vigencia. Se **deriva** en la
vista (§3.4), igual que `estadoDoc()` deriva el semáforo de documentos.

Los estados que sí se guardan son los que dependen de una **decisión humana**:
borrador, pendiente_firma, vigente, resuelto, cancelado. `vencido` se guarda solo
como cierre formal opcional; la vista lo calcula igual.

**Un contrato vigente por proveedor a la vez** (mismo patrón que
`uq_cc_rend_abierta` en caja chica):

```sql
create unique index if not exists uq_contrato_vigente_por_proveedor
  on public.contratos_proveedor (proveedor_id)
  where estado in ('vigente','pendiente_firma');
```

### 3.2 Tabla nueva — `contrato_plantillas`

Las cláusulas **no pueden vivir solo en el código.** Un contrato firmado en 2026
tiene que poder reimprimirse idéntico en 2029, aunque las cláusulas hayan cambiado
tres veces. Por eso: plantilla versionada **más** snapshot en el contrato.

```sql
create table if not exists public.contrato_plantillas (
  id            bigserial primary key,
  nombre        text not null,
  version       int  not null default 1,
  activa        boolean not null default true,
  vigencia_anios_default numeric(4,2) not null default 3,
  clausulas_json jsonb not null default '[]'::jsonb,
  -- [{ orden, titulo, texto, obligatoria }]  con {{variables}}
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  unique (nombre, version)
);
```

Semilla con las 5 cláusulas del punto 8: confidencialidad, protección de
información de clientes, no captación, no desviación de servicios, prohibición de
subcontratación no autorizada.

> **Las cláusulas las redacta o valida un abogado.** El ERP las almacena y las
> imprime; no las inventa. Sembrarlas con texto generado sin revisión legal es un
> riesgo real, no una formalidad.

### 3.3 Tabla nueva — `contrato_eventos`

Copia exacta del patrón `liquidacion_evento` (`liquidaciones-v2.sql:412`):

```sql
create table if not exists public.contrato_eventos (
  id          bigserial primary key,
  contrato_id bigint not null references public.contratos_proveedor(id) on delete cascade,
  evento      text not null,   -- creado|editado|generado_pdf|firmado|adjuntado|
                               -- vigente|resuelto|cancelado|aviso_enviado
  detalle     text,
  usuario     text,
  ip          text,
  created_at  timestamptz not null default now()
);
```

Cubre "registrar usuario, fecha y hora" del punto 13 con historial completo, no
solo el último `updated_at`.

### 3.4 Columnas añadidas a tablas existentes

Cinco columnas. **Todas nullable. Ningún default. Ningún trigger.**

```sql
select public._fin_add_fk('liquidacion_proveedor','contrato_id','contratos_proveedor');
select public._fin_add_fk('documentos_compra',    'contrato_id','contratos_proveedor');
select public._fin_add_fk('reservas',             'contrato_id','contratos_proveedor');
select public._fin_add_fk('ordenes_compra',       'contrato_id','contratos_proveedor');
select public._fin_add_fk('documentos_tercero',   'proveedor_id','proveedores');
```

Se usa `_fin_add_fk()` (`finanzas-00:35`) porque resuelve el tipo de la PK
dinámicamente — el esquema real solo vive en Supabase.

Y para la relación N:M factura↔liquidaciones que pide el punto 5:

```sql
create table if not exists public.documento_compra_liquidacion (
  documento_compra_id bigint not null references public.documentos_compra(id) on delete cascade,
  liquidacion_id      bigint not null references public.liquidacion_proveedor(id) on delete cascade,
  primary key (documento_compra_id, liquidacion_id)
);
```

`documentos_compra.liquidacion_proveedor_id` se mantiene (lo lee el código
existente); la tabla puente es aditiva.

### 3.5 Vistas — todo lo derivado vive aquí

**`v_contratos_proveedor`** — el contrato con su vigencia calculada:

```
dias_para_vencer  = fecha_vencimiento − hoy(Lima)
estado_vigencia   = 'vencido'      si dias < 0
                    'por_vencer_30' si dias <= 30
                    'por_vencer_60' si dias <= 60
                    'por_vencer_90' si dias <= 90
                    'vigente'
```

**`v_contrato_proveedor_resumen`** — los 8 totales del punto 3, **todos
derivados, ninguno guardado**:

| Total | De dónde sale |
|---|---|
| Servicios realizados | `count(reservas)` con `contrato_id`, `estado='finalizada'` |
| Servicios pendientes | idem, `estado <> finalizada/cancelada` |
| Total contratado | Σ `reservas.costo_proveedor` |
| Total liquidado | Σ `liquidacion_proveedor.total` en estado ≥ conformada |
| Total facturado | Σ `documentos_compra.total`, excluyendo `estado_conciliacion='anulado'` |
| Total pagado | Σ `pagos_aplicacion.monto_aplicado` sobre esas facturas |
| Venta relacionada | Σ venta neta de esas reservas |
| Utilidad / margen | de `v_rentabilidad_servicio` |

**`v_rentabilidad_servicio`** — §2.5. Es la única fuente de utilidad y margen sin
IGV que puede citar el dashboard, el reporte y la ficha de servicio.

### 3.6 Funciones

```sql
-- ¿Este proveedor tenía contrato vigente en esta fecha? Devuelve
-- (tiene_contrato, contrato_id, numero, estado_vigencia, dias_para_vencer, motivo).
create or replace function public.fn_contrato_vigente_al(
  p_proveedor_id int, p_fecha date default current_date) returns record …
```

Misma doctrina que `fn_caja_chica_puede_asignar()`: **la regla vive en Postgres**,
el cliente la envuelve (`lib/contratos/index.ts` → `contratoVigenteAl()`) y **no
la replica**.

### 3.7 RLS

Idéntico al resto: `enable row level security` + policy `<tabla>_auth` para
`authenticated`. El gate real vive en `permisos_usuario` y en la capa de
aplicación, como en todo el ERP.

---

## 4. La regla que define este módulo: el contrato no genera nada

El punto 2 del requerimiento es la restricción más importante y la más fácil de
violar sin darse cuenta.

**Se cumple estructuralmente, no por disciplina:**

- `contratos_proveedor` **no tiene ni un solo trigger que escriba en otra tabla.**
  El único trigger permitido es el del correlativo y el de `updated_at` — ambos
  escriben sobre la propia fila.
- La relación es siempre **desde el documento hacia el contrato** (el documento
  guarda `contrato_id`), nunca al revés. El contrato no sabe de nadie; lo
  descubren sus vistas.
- Todos los totales son **vistas**. Un contrato sin servicios devuelve ceros y eso
  es un estado perfectamente válido: *"un proveedor puede tener contrato vigente y
  cero servicios durante meses"* es literalmente lo que pide el requerimiento.
- No hay obligación de volumen mínimo en ningún lado: **no existe** columna de
  compromiso, ni de cuota, ni de mínimo facturable. Que no aparezca nunca.

**Reglas del punto 13, y dónde vive cada una:**

| Regla | Dónde se implementa |
|---|---|
| Advertir al asociar servicio a contrato vencido | `fn_contrato_vigente_al()` → aviso en UI. **Advierte, no bloquea** |
| Servicio eventual sin contrato solo con permiso | Capacidad `contratos-excepcion` (§6) |
| No crear OC ni facturas automáticamente | Cero triggers salientes (arriba) |
| No mezclar IGV con utilidad | `v_rentabilidad_servicio` netea antes de restar |
| Trazabilidad servicio→liquidación→factura→pago | Ya existe la cadena; `contrato_id` la etiqueta |
| No eliminar documentos con movimientos | Estados `resuelto`/`cancelado` + `on delete` restrictivo. **Nunca DELETE** |
| Registrar usuario/fecha/hora | `contrato_eventos` + `creado_por`/`actualizado_por` |

> **Advertir, no bloquear** es doctrina de la casa. `FichaServicio.tsx:35-40` lo
> dice para documentos vencidos: *"Documento obligatorio SIN CARGAR: avisa en
> ÁMBAR, NO bloquea"*. Un contrato vencido no puede impedir que salga un bus.

---

## 5. Generación del contrato en PDF

Reusa el pipeline existente, sin motor nuevo:

```
contratos_proveedor + proveedores + empresa_perfil + contrato_plantillas
        ↓  lib/contratos/documento.ts   (espejo de lib/liquidacion-doc.ts)
   interpolar {{variables}} en clausulas_json
        ↓  lib/pdf-chrome.ts  (buildHeaderPDFHtml · sharedCSS · esc)
   HTML  →  ventana  →  imprimir/guardar PDF
        ↓
   pdf_generado_url   →  se firma en papel  →  pdf_firmado_url
```

**Al generar, se congela `clausulas_snapshot`** con el texto ya interpolado. A
partir de ahí el contrato imprime *su* snapshot, no la plantilla viva. Es la misma
lógica por la que la liquidación guarda snapshot de totales al emitir
(`liquidaciones-v2.sql:200`): el documento que la contraparte vio no puede cambiar
bajo sus pies.

**Variables disponibles:** `{{afa_razon_social}}`, `{{afa_ruc}}`,
`{{afa_direccion}}`, `{{afa_representante}}`, `{{proveedor_razon_social}}`,
`{{proveedor_ruc}}`, `{{proveedor_direccion}}`, `{{proveedor_representante}}`,
`{{fecha_inicio}}`, `{{fecha_vencimiento}}`, `{{vigencia_anios}}`,
`{{numero_contrato}}`, `{{fecha_firma}}`.

### Bloqueo conocido

**`empresa_perfil` no tiene representante legal.** Sus columnas
(`app/configuracion/perfil/page.tsx:40-57`) son: nombre, razón social, RUC,
dirección, teléfono, email, web, slogan, logos, color, régimen, moneda, zona
horaria. **No hay representante, ni su DNI, ni partida registral** — datos
imprescindibles en la comparecencia de un contrato peruano.

Hay que añadir a `empresa_perfil`: `representante_legal`, `representante_dni`,
`representante_cargo`, `partida_registral`. Es la **única** modificación que este
proyecto hace a un módulo existente fuera de proveedores, y es aditiva.

---

## 6. Permisos — el punto que obliga a decidir

El requerimiento pide **9 permisos de acción** separados. El ERP hoy **no tiene
permisos de acción**: `permisos_usuario` es `(usuario_id, modulo, permitido)` —
un booleano por módulo (`lib/usePermiso.ts:22-27`).

Tres caminos:

| | Enfoque | Toca el motor de permisos | Veredicto |
|---|---|---|---|
| **a** | Módulos-capacidad: `contratos`, `contratos-aprobar`, `contratos-costos`, `contratos-margen`, `contratos-excepcion` | **No** | **Recomendado** |
| b | Columna `accion` en `permisos_usuario` | Sí — PK, `usePermiso`, layout, crear-usuario, usuarios | Alto riesgo |
| c | Tabla nueva de permisos de acción | Parcial, pero crea un segundo sistema | Duplica |

**Recomiendo (a).** Un "módulo" que no aparece en `menuGrupos` **nunca gatea una
ruta** — el layout solo verifica módulos de rutas registradas. Se comporta como
una bandera de capacidad y viaja gratis por toda la maquinaria existente: se
siembra en `MODULOS`, se administra en la pantalla de Usuarios, y `admin` la
recibe automáticamente.

Lo único nuevo que hace falta es un hook `useCapacidad(modulo)` que **lea sin
redirigir** (`usePermiso` manda a `/dashboard` cuando falta el permiso, que es lo
correcto para una ruta y lo incorrecto para ocultar una columna). Es aditivo:
`usePermiso` no se toca.

**Mapa de los 9 permisos:**

| Permiso pedido | Cómo se resuelve |
|---|---|
| Ver contratos | módulo `contratos` |
| Crear / Editar contratos | módulo `contratos` (quien entra, opera) |
| **Aprobar contratos** | `contratos-aprobar` + `fn_es_aprobador()` en SQL |
| Generar PDF | módulo `contratos` |
| Adjuntar contrato firmado | módulo `contratos` |
| **Anular contrato** | `contratos-aprobar` |
| **Ver costos de proveedores** | `contratos-costos` |
| **Ver utilidad / margen** | `contratos-margen` |
| (Servicio sin contrato) | `contratos-excepcion` — regla 2 del punto 13 |

Crear/editar/generar/adjuntar no se separan: son el trabajo cotidiano de quien
administra contratos, y nueve casillas por usuario en una empresa de este tamaño
es fricción sin control real. Se separa lo que **cambia dinero o revela márgenes**.

**Recordatorio de siempre:** hay **TRES** listas que sincronizar, no dos —
`menuGrupos` (`app/layout.tsx:289`), `MODULOS`
(`app/api/crear-usuario/route.ts:21`) y `GRUPOS_MODULOS` + `nombresModulo`
(`app/usuarios/page.tsx`). Las capacidades van en las **dos últimas**; solo
`contratos` va en el menú.

> Ya hay precedente de ocultar economía por rol: `FichaServicio.tsx:42` esconde
> precio, costo y margen a quien no es admin. `contratos-costos` /
> `contratos-margen` lo formalizan y lo hacen otorgable sin volver a nadie admin.

---

## 7. Alertas de vencimiento

**Reusar el cron que ya existe.** `vercel.json` ya corre
`/api/notificaciones/proveedores-documentos` a las 12:30 UTC (07:30 Lima). Se le
añade un bloque de contratos; **no se agrega un noveno cron.**

Umbrales propios — los de documentos (`[30,15,7,3,1,0]`,
`lib/proveedor-documentos.ts:51`) son para un SOAT anual; un contrato de 3 años
necesita más anticipación:

```ts
// lib/contratos/alertas.ts
export const UMBRALES_CONTRATO = [90, 60, 30, 15, 0];
export function esDiaGatilloContrato(dias: number): boolean {
  if (dias >= 0) return UMBRALES_CONTRATO.includes(dias);
  return Math.abs(dias) % 15 === 0;   // vencido: recordatorio quincenal
}
```

Dedupe con tabla propia `contratos_avisos`, calcada de
`documentos_tercero_avisos` (`proveedor-documentos-autoservicio.sql:61`): clave
`contrato_id + umbral`, para que un rebote de cron no mande el aviso dos veces.

Canales: los de siempre — Resend y Twilio vía `lib/notificaciones.ts`.

---

## 8. UI

### Rutas

```
/proveedores                    (existe)  → añadir pestañas
   ?tab=lista                             lo de hoy, intacto
   ?tab=contratos                         lista de contratos
   ?tab=documentacion                     punto 7
/proveedores/contratos/[id]     (nuevo)   ficha del contrato
/vencimientos                   (nuevo)   arregla el enlace muerto del menú
```

**Una sola entrada nueva de menú** (módulo `contratos`), bajo el grupo que ya
contiene Proveedores y Tercerizadas (`app/layout.tsx:351`).

### Ficha del contrato

```
┌─ CM-2026-000012 · Transportes XYZ S.A.C. · RUC 20xxxxxxxxx ────┐
│ [VIGENTE]   15/11/2026 → 15/11/2029   ·   Faltan 1 174 días    │
│ [Generar PDF] [Adjuntar firmado] [Resolver] [Anular]           │
├────────────────────────────────────────────────────────────────┤
│ Datos · Servicios · Liquidaciones · Facturas · Pagos · Docs.   │
│                                                                │
│  Contratado  S/  —      Liquidado  S/  —                       │
│  Facturado   S/  —      Pagado     S/  —                       │
│  ── solo con contratos-costos ──────────────────────────────   │
│  Venta relacionada  S/ —   Utilidad bruta  S/ —   Margen  — %  │
└────────────────────────────────────────────────────────────────┘
```

El bloque de utilidad/margen **no se renderiza** sin `contratos-margen`. No se
tacha ni se muestra en gris: no se pide al servidor.

### Dashboard

`KpiCard` (`app/dashboard/page.tsx:236`) tal cual, alimentado por las vistas:
contratos vigentes · por vencer · vencidos · proveedores con contrato · sin
contrato · servicios bajo contrato · costo de proveedores · venta relacionada ·
utilidad bruta · margen. Los últimos cuatro, condicionados por capacidad.

Y la lista que pide el punto 10, en `/vencimientos` y en el dashboard:

```
CONTRATOS POR VENCER
  Transportes XYZ S.A.C.   Vence 15/11/2029   Faltan 79 días
```

### Ayuda contextual

Obligatoria, según CLAUDE.md: ficha en `lib/ayuda/modulos-operaciones.ts`, rutas
`/proveedores/contratos` y `/vencimientos`, con conceptos del glosario. Términos
nuevos para `lib/ayuda/glosario.ts`: **contrato marco**, **utilidad bruta**,
**margen bruto**, **no captación**. Y `utilidad bruta` debe advertir explícitamente
que **no es** `reservas.margen`.

---

## 9. Plan de fases

| Fase | Qué | Entregable | Riesgo |
|---|---|---|---|
| **0** | **Puente de identidad** | Backfill `empresas_tercerizadas.proveedor_id` + UI para mantenerlo + tipo `transporte` en el selector | **Alto.** Requiere revisión humana: emparejar por RUC y resolver a mano lo que quede |
| 1 | Datos | `contratos-09-marco-proveedores.sql`: tablas, columnas, vistas, funciones, RLS | Bajo (aditivo, idempotente) |
| 2 | Backend | `lib/contratos/*`, `/api/contratos/*`, `useCapacidad` | Bajo |
| 3 | Permisos | 5 capacidades en las 3 listas | Bajo |
| 4 | UI contratos | Pestaña + ficha + estados | Medio |
| 5 | PDF | Plantillas, snapshot, `empresa_perfil` + representante | Medio — **necesita revisión legal** |
| 6 | Documentación | `documentos_tercero.proveedor_id` + vista unificada + tipos nuevos | Medio |
| 7 | Rentabilidad | `v_rentabilidad_servicio` + bloques con permiso | **Alto.** Es donde se puede crear una cuarta verdad |
| 8 | Alertas | Umbrales + bloque en el cron + `contratos_avisos` | Bajo |
| 9 | Dashboard + `/vencimientos` | KPIs + arreglo del enlace muerto | Bajo |
| 10 | Ayuda | Fichas + glosario | Bajo |

**Fase 0 primero, sin excepción.** Si se construye el módulo sobre un puente
vacío, los contratos existirán y no verán ningún servicio: el módulo parecerá
funcionar y estará mintiendo.

### Pruebas de aceptación (punto 15)

Crear proveedor tipo transporte → crear contrato de 3 años → generar PDF →
adjuntar firmado → crear servicio asociado → crear liquidación → asociar factura →
registrar pago → verificar utilidad y margen **sin IGV** → verificar alertas a
90/60/30 → **y verificar que `/programacion`, `/liquidaciones`, `/tesoreria`,
`/facturacion` y `/gastos` siguen dando exactamente los mismos números que antes.**

Esta última es la que importa: el requerimiento dice "no modificar funcionalidades
existentes". Tomar una captura de los totales de esos cinco módulos **antes** de
empezar la fase 1.

---

## 10. Decisiones que necesito de AFA antes de la fase 1

1. **Identidad del proveedor.** ¿Se confirma que el contrato cuelga de
   `proveedores` y que se hará el backfill de la fase 0? ¿Cuántas empresas
   tercerizadas hay hoy y tienen todas RUC cargado?
2. **IGV en `precio_cliente`.** ¿Los precios de reserva se cargan **siempre** con
   IGV, **siempre** sin, o depende? De esto depende si `v_rentabilidad_servicio`
   puede netear con una regla o necesita mirar `cotizaciones.incluye_igv` fila por
   fila.
3. **Cláusulas.** ¿Existe ya un modelo de contrato revisado por el abogado de AFA?
   Si existe, se transcribe. Si no, hay que redactarlo y **revisarlo legalmente**
   antes de sembrarlo.
4. **Representante legal de AFA.** Nombre, DNI, cargo y partida registral, para
   `empresa_perfil`.
5. **Contratos vigentes hoy.** ¿Hay contratos en papel que haya que cargar como
   histórico, o se arranca en blanco?
6. **Quién aprueba.** ¿`contratos-aprobar` es solo gerencia, o también
   administración?

---

## 11. Riesgos

| Riesgo | Mitigación |
|---|---|
| **Duplicar la liquidación del proveedor** | Ya existe y es superior a lo pedido. Solo se le añade `contrato_id` |
| **Crear una tabla `cuentas_por_pagar`** | No existe a propósito. La CxP es `documentos_compra` |
| **Un cuarto margen** | Solo `v_rentabilidad_servicio` es fuente de utilidad/margen. Lo demás se marca como legado en la ayuda |
| **Guardar `por_vencer`** | Se deriva en vista. Nunca columna |
| **Guardar totales del contrato** | Todos derivados. Regla de oro `finanzas-00:22-24` |
| **Puente de identidad vacío** | Fase 0 bloqueante, con revisión humana |
| **Cláusulas sin revisión legal** | Fase 5 no cierra sin visto bueno del abogado |
| **Fusionar los 3 ejes de estado de la factura** | Un chip combinado en UI; tres columnas en base |
| **Romper `/programacion` o `/tesoreria`** | Todo es aditivo y nullable. Captura de totales antes y después |

---

## 12. Resumen del alcance

**Se crea:** 4 tablas (`contratos_proveedor`, `contrato_plantillas`,
`contrato_eventos`, `contratos_avisos`) + 1 puente
(`documento_compra_liquidacion`) + 3 vistas + 1 función + 5 capacidades de
permiso + 1 entrada de menú + la ruta `/vencimientos` que faltaba.

**Se añade (aditivo, nullable):** `contrato_id` en `liquidacion_proveedor`,
`documentos_compra`, `reservas` y `ordenes_compra`; `proveedor_id` en
`documentos_tercero`; 4 columnas de representante legal en `empresa_perfil`;
`transporte` en el selector de tipos de proveedor.

**No se toca:** liquidaciones, tesorería, facturación, pagos, caja chica,
contabilidad, programación, ni ningún cálculo existente.

**Nada de esto está codificado.** Es el plan para revisar antes de empezar.
