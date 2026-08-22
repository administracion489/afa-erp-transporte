# Poner en marcha el control de gastos y la caja chica

Guía para dejar funcionando el módulo financiero nuevo: cuentas por pagar, planilla,
detracciones, lotes de pago, conciliación bancaria y caja chica — más la subida y bajada
de tus hojas de Google Sheets.

Todo el código ya está. Lo único que **no se puede hacer desde el repositorio** es correr
la migración en Supabase y cargar tus datos. Eso es lo que explica esta guía.

---

## 1. Correr la migración (una sola vez, ~30 segundos)

Supabase → **SQL Editor** → pegar el contenido de
`supabase/finanzas-06-gastos-caja-chica.sql` → **Run**.

Es idempotente: si la corres dos veces no rompe nada.

**Antes de correrla**, confirma que ya corriste sus prerrequisitos. Si no estás seguro,
pega esto en el SQL Editor:

```sql
select table_name from information_schema.tables
 where table_schema = 'public'
   and table_name in ('documentos_compra','pagos','pagos_aplicacion','cuentas_tesoreria',
                      'movimientos_tesoreria','liquidacion_proveedor')
 order by 1;
```

Deben salir las **seis**. Si falta alguna, corre primero, en este orden:
`finanzas-00-fundacion.sql` → `finanzas-01-tesoreria-pagos.sql` →
`finanzas-02-compras-cxp.sql` → `liquidaciones-v2.sql`.

### Verificar que quedó bien

```sql
-- Las tablas nuevas
select table_name from information_schema.tables
 where table_schema='public' and table_name like 'caja_chica%' or table_name in
   ('gastos_generales','lotes_pago','lotes_pago_items','extractos_bancarios',
    'extractos_bancarios_movimientos','importaciones_finanzas')
 order by 1;

-- Las vistas nuevas
select table_name from information_schema.views
 where table_schema='public' and table_name in
   ('v_cuentas_por_pagar','v_caja_chica_rendiciones','v_caja_chica_saldos',
    'v_detracciones_pendientes','v_fugas_bancarias','v_costo_servicio','v_egresos')
 order by 1;

-- Que el gasto total sigue cuadrando (ahora con más fuentes que antes)
select fuente, count(*), sum(monto) from public.v_egresos group by 1 order by 3 desc;
```

> **Ojo con el bucket.** La migración intenta crear el bucket privado `comprobantes` y
> sus políticas. Si el `NOTICE` dice que no pudo, créalo a mano: Supabase → **Storage** →
> **New bucket** → nombre `comprobantes`, **Public: OFF**.
> Tiene que ser privado: un ticket de peaje trae la placa y la ubicación del vehículo.

---

## 2. Dar los permisos

Los dos módulos nuevos son **Cuentas por Pagar** (`tesoreria`) y **Caja Chica**
(`caja-chica`). Ve a **Configuración → Usuarios** y márcalos a quien corresponda.
Los administradores los ven automáticamente.

### El rol nuevo: Gerente

Se agregó un tercer rol entre Operador y Administrador:

| Rol | Ve el ERP | **Aprueba gasto** | Administra el sistema |
|---|---|---|---|
| Operador | según permisos | ❌ | ❌ |
| **Gerente** | según permisos | ✅ | ❌ |
| Administrador | todo | ✅ | ✅ |

"Aprobar gasto" es: aprobar cuentas por pagar y planilla, aprobar lotes de pago y
liquidar rendiciones de caja chica. Un gerente **no** puede crear usuarios ni deshacer
importaciones.

Asígnalo en **Configuración → Usuarios**, en el desplegable de rol de cada persona.

---

## 3. Configurar lo mínimo antes de cargar datos

### 3.1 Cuentas de tesorería

Sin al menos una cuenta no se puede conciliar el banco ni registrar salidas de efectivo.
Créalas en **Finanzas → Tesorería**, o directo:

```sql
insert into public.cuentas_tesoreria (nombre, tipo, moneda, banco, numero_cuenta, cci)
values ('BCP Corriente Soles', 'banco', 'PEN', 'BCP', '191-XXXXXXX-0-XX', '00219100XXXXXXXXXX'),
       ('Caja Chica Oficina',  'caja',  'PEN', null, null, null);
```

### 3.2 Confirmar la detracción con tu contador

Esto **no lo puede decidir el sistema**. El catálogo viene sembrado con tres códigos:

| Código | Servicio | % | Umbral |
|---|---|---|---|
| 027 | Transporte de **personas** | 10 % | S/ 700 |
| 026 | Transporte de bienes/carga | 4 % | S/ 400 |
| 037 | Demás servicios gravados | 12 % | S/ 700 |

Pregúntale a tu contador cuál aplica a AFA y si esas tasas siguen vigentes. Luego:

```sql
select * from public.cat_detraccion order by codigo;   -- ver
update public.cat_detraccion set porcentaje = 10, umbral_min = 700 where codigo = '027';
select * from public.config_tributaria;                 -- IGV vigente (default 18 %)
```

### 3.3 Fondos de caja chica

Un **fondo** es la bolsa asignada a una persona. Créalos en **Caja Chica → Fondos**.
Para cada conductor que maneja efectivo:

- **Responsable**: elige el conductor de la lista (autocompleta el nombre).
- **Tope**: máximo que puede tener en la calle sin rendir. `0` = sin tope.
- **Días para rendir**: a partir de la entrega, cuántos días tiene antes de que su
  rendición cuente como vencida. Por defecto 7.

> Si vas a importar el histórico de caja chica, **no hace falta** crear los fondos a mano:
> el importador crea uno por responsable que encuentre en la hoja.

---

## 4. Subir tus Google Sheets

Cada pantalla tiene su botón **Importar**. El flujo es el mismo en todas y tiene tres pasos.

### Paso 1 · De dónde viene

Dos opciones:

- **Subir el archivo**: descarga la hoja desde Google Sheets como `.xlsx` o `.csv` y
  arrástrala. También lee `.xls`.
- **Pegar el enlace**: copia la URL de la hoja y pégala. Para que funcione, la hoja debe
  estar compartida como **"Cualquier persona con el enlace · Lector"**
  (Google Sheets → Compartir → Acceso general). No hace falta ninguna credencial.
  Si no está compartida, el sistema te lo dice con esas palabras.

También puedes **descargar la plantilla** con las cabeceras exactas, llenarla en Sheets
y subirla.

### Paso 2 · Revisar antes de aplicar

Aquí está lo que antes no existía en el ERP: **nada se escribe hasta que confirmes.**

- Te dice **qué formato detectó** y con qué porcentaje de coincidencia. Reconoce el
  formato tradicional y el formato OSLO.
- Si no reconoce el formato, **no aborta el archivo**: te muestra el ranking y te deja
  elegirlo a mano, y luego **mapear columna por columna** ("la columna `IMPORTE TOTAL`
  de tu hoja es el campo `Monto neto` del ERP").
- Tres contadores: filas válidas, filas con error, total leído.
- Vista previa de las primeras filas válidas.
- La lista de errores, fila por fila, con el motivo exacto
  (`Fila 47: Fecha de emisión ilegible ("31/02/2026")`).
- Botón **Descargar filas rechazadas**: te baja un Excel con las filas originales más una
  columna `MOTIVO DEL RECHAZO`. Corriges en Sheets, subes solo eso, y listo.

### Paso 3 · Importar

Sube en tandas y te muestra el resultado: creadas, omitidas (duplicados), con error.

**No duplica.** Cada perfil tiene su llave:

| Qué importas | No se repite si coincide |
|---|---|
| Cuentas por pagar | RUC + tipo + serie + número de factura |
| Extracto bancario | cuenta + fecha + nº operación + importe + descripción |
| Caja chica | la misma foto en la misma rendición |

Puedes volver a subir el mismo archivo sin miedo: lo ya cargado se omite.

### Si algo salió mal

Cada carga queda registrada. Un administrador puede deshacerla completa:

```sql
select id, perfil, destino_tabla, archivo_nombre, filas_creadas, importado_por, created_at
  from public.importaciones_finanzas order by id desc limit 20;
```

y luego, desde la pantalla, el botón de deshacer (o `DELETE /api/finanzas/importar?id=N`).
Las filas que ya tengan un pago aplicado **no se borran** — te dice cuáles quedaron.

### Cabeceras que reconoce

Da igual si están en mayúsculas, con tildes o con puntos: `N° FACTURA`, `Nro. Factura` y
`numero_factura` caen todas en el mismo campo. Estas son las principales:

**Cuentas por pagar (formato OSLO)**
`PROVEEDOR` / `RAZON SOCIAL` · `RUC` · `TITULAR DE LA CUENTA` · `BANCO` ·
`NUMERO DE CUENTA` · `CCI` · `CODIGO DE SERVICIO` · `DETALLE DEL SERVICIO` /
`FECHA Y TURNO` · `PLACA DE VEHICULO` · `FECHA DE SERVICIO` · `N FACTURA` ·
`NRO. DE RECIBO DE HONORARIOS` · `FECHA DE EMISION` · `MONTO NETO` ·
`MONTO A CANCELAR` · `ADELANTO 1` · `ADELANTO 2` / `ADELANTOS 2` · `DETRACCION` ·
`ESTADO DETRACCION` · `ESTADO` · `NRO. OPERACION` · `FECHA DE PAGO` · `VOUCHER` ·
`INFORMACIÓN ADICIONAL` / `COMENTARIO`

> Estas dos plantillas ya están probadas contra tus archivos reales
> (`SERVICIOS DIEGO GRIJALVA` y `PAGOS DE PROVEEDORES OSLO PIURA`) — ver §10.

**Planilla y gastos administrativos**
`BENEFICIARIO` · `DNI` / `RUC` · `CATEGORIA` · `CONCEPTO` · `PERIODO` · `FECHA` ·
`FECHA DE VENCIMIENTO` · `MONTO` · `BANCO` · `NUMERO DE CUENTA` · `CCI` · `ESTADO` ·
`NRO OPERACION` · `FECHA DE PAGO` · `RECIBO POR HONORARIOS`

**Caja chica**
`RESPONSABLE` / `CONDUCTOR` · `FECHA` · `CATEGORIA` · `DESCRIPCION` · `MONTO` ·
`PLACA` · `RUC` · `N COMPROBANTE`

**Extracto BCP**
`FECHA` · `NRO OPERACION` · `DESCRIPCION` · `CARGO` · `ABONO` · `SALDO`
(también funciona si trae una sola columna `IMPORTE` con signo).

El sistema entiende `S/ 1,234.56`, `1.234,56`, `(500.00)` como negativo, y las fechas
tanto en `31/12/2026` como en el formato interno de Excel.

---

## 5. Bajar a Excel

Todas las pantallas tienen **Exportar**. Baja un `.xlsx` con formato (cabecera azul,
montos como número con formato de soles, fechas como fecha real, filtro automático y
fila de totales) **usando las mismas cabeceras que reconoce el importador**.

Es a propósito: bajas, editas en Google Sheets, y vuelves a subir sin tocar nada.

---

## 6. Cómo funciona la caja chica

```
FONDO (permanente, uno por persona)
  └─ RENDICIÓN   abierta ──enviar──▶ por revisar ──aprobar──▶ liquidada
       │                                  │
       │                             observar ▼
       │                               observada ──corregir──▶ por revisar
       └─ COMPROBANTES (uno por foto):  pendiente → aprobado | rechazado
```

**La regla que pediste**: no se le entrega dinero a quien tiene una rendición abierta o
vencida. Al elegir un responsable en "Entregar dinero", el sistema te dice si puede o no,
**y por qué**: *"Tiene 1 rendición vencida sin liquidar por S/ 340.00"*. El botón queda
bloqueado hasta que se resuelva.

Está implementada en la base de datos, no en la pantalla, así que aplica igual desde la
app del conductor, desde la bandeja del contador y desde cualquier automatización futura.

### Desde el celular del conductor

El chofer abre su app en la pestaña **Gastos**, elige categoría (peaje, lavado,
estacionamiento, viáticos, movilidad), pone el monto y **fotografía el comprobante**.
La foto se guarda con su ubicación GPS y la hora real de captura.

- Si no hay señal, el gasto queda en cola en el celular y se sube solo al reconectar.
- La misma foto no se puede rendir dos veces (se compara el contenido de la imagen, no
  el nombre del archivo).
- El chofer puede rendir aunque no le hayas entregado plata: el saldo queda a su favor.

### La revisión

En **Caja Chica → Por revisar** ves cada comprobante con su foto y lo apruebas o lo
rechazas con motivo. Solo cuando no queda ninguno pendiente puedes liquidar la rendición.

Al liquidar, si marcas *"Promover gastos aprobados"*, cada comprobante pasa al módulo
**Gastos** como un gasto normal — y deja de contarse por el lado de caja chica, así que
el total nunca se duplica.

---

## 7. El circuito de pago

```
FACTURA DEL PROVEEDOR
  └─ registrada (a mano, importada o leída por IA)
       └─ APROBADA POR GERENCIA
            └─ metida en un LOTE DE PAGO
                 └─ archivo descargado y cargado en Telecrédito
                      └─ CONFIRMADA contra el extracto del banco
```

Cada paso es un estado distinto y **son independientes del estado de pago**: una factura
puede estar aprobada y aún impaga, o pagada parcialmente y con la detracción pendiente.
Esa separación es lo que evita que "aprobado" y "pagado" se pisen.

> ⚠️ **El archivo para Telecrédito hay que cotejarlo una vez.** El formato exacto lo
> define el convenio de cada empresa con el BCP. El sistema genera un CSV con las
> columnas del abono (tipo y nº de documento, beneficiario, banco, cuenta, CCI, moneda,
> importe, referencia). Pruébalo con **un lote pequeño** y, si el banco lo rechaza,
> avísame el orden exacto de columnas que pide tu convenio y lo ajusto.

---

## 8. La conciliación bancaria — "Regla Cero Fugas"

Descargas el extracto del BCP, lo subes en **Cuentas por Pagar → Conciliación**, y le das
a **Conciliar automáticamente**. El sistema cruza cada movimiento contra lo que el ERP
conoce:

| Cómo casó | Confianza | Qué hace |
|---|---|---|
| Mismo nº de operación | 100 % | Lo concilia solo |
| Mismo importe y misma fecha | 85 % | Lo **propone**, confirmas tú |
| Mismo importe, ±3 días | 65 % | Lo **propone**, confirmas tú |
| Comisión / ITF / portes | — | Lo marca ignorado |
| Nada | — | 🔴 **Fuga** |

Solo el primer caso se cierra solo, a propósito: dos servicios del mismo precio el mismo
día son lo normal en transporte, y dar por bueno un cruce por importe cerraría la factura
equivocada.

Lo que queda en rojo son **salidas de dinero del banco que el ERP no sabe justificar**.
Esa lista es el control que no tenías.

---

## 9. Gastos ligados a los servicios

`/gastos` ahora muestra, en cada gasto, **a qué servicio pertenece y en qué estado está**:
por liquidar, liquidado, facturado o cobrado. Y trae un filtro por ese estado, así que ya
se puede responder *"¿cuánto gasté en servicios que ya liquidé?"*.

Además hay una vista nueva de **rentabilidad por servicio**: ingreso contra costo real
(gastos + combustible + mantenimiento + caja chica + lo facturado por el tercero), con el
margen de verdad, no el pactado.

**Dos advertencias honestas sobre esa vista:**

1. Solo cuenta costos **directos** — los que tienen el servicio asignado. Combustible y
   mantenimiento recién ahora pueden atarse a un servicio, así que **el histórico anterior
   no lo tiene**: esos servicios viejos van a aparecer con margen inflado. La vista marca
   en ámbar los servicios sin ningún costo registrado justamente para que no te engañen.
2. Los **neumáticos no se reparten** entre servicios, a propósito: son costo de vehículo
   que se amortiza por kilómetro. Repartirlos es una decisión contable que hay que tomar
   con tu contador, no un dato que el sistema pueda inventar.

---

## 10. Tus dos planillas, ya probadas

Las plantillas de importación se ajustaron contra los archivos reales de dos proveedores.
Ambos entran completos, sin una sola fila rechazada:

| Archivo | Filas | Importe | Detracción | Resultado |
|---|---|---|---|---|
| `SERVICIOS DIEGO GRIJALVA` | 4 | S/ 6,720.00 | S/ 672.00 | 4 válidas · 0 errores |
| `PAGOS DE PROVEEDORES OSLO PIURA` | 108 | S/ 625,402.86 | S/ 57,971.00 | 108 válidas · 0 errores |

Los totales cuadran al céntimo con la suma de las hojas, y el sistema verificó fila por
fila que el `MONTO A CANCELAR` de tu Excel coincida con monto − adelantos − detracción
(si alguna fila no cuadrara, la rechazaría diciéndote exactamente cuánto sobra o falta).

**Lo que hubo que resolver de tus hojas**, por si te sirve saber qué reconoce el sistema:

- **Cabecera de dos pisos.** Las dos planillas agrupan columnas con celdas combinadas: una
  fila con el rótulo del grupo (`FACTURA`, `DETALLE DE PAGO`) y otra debajo con el de cada
  columna. El importador ahora las combina. Antes leía una sola fila y en Grijalva perdía
  PROVEEDOR, RUC, PLACA y FECHA — el archivo entero fallaba.
- **Recibo por honorarios o factura.** En OSLO, 47 filas usan `NRO. DE RECIBO DE HONORARIOS`
  y 61 usan `NUMERO FACTURA`, nunca las dos. El sistema toma la que tenga dato y marca el
  tipo de comprobante en consecuencia.
- **Dos columnas `MONTO NETO`.** Misma historia: cada fila llena solo una. Se leen ambas.
- **`FECHA DE SERVICIO` que no es una fecha.** En OSLO es texto libre con el rango y el
  turno (`14-19 DE OCTUBRE - TURNO DÍA`). Se guarda en el detalle del servicio y de ahí se
  deduce el turno: quedaron 83 de 108 filas con turno detectado.
- **Filas sin ninguna fecha.** 47 de 108. El importador pide una **fecha de referencia** y
  la aplica solo a esas; las demás conservan la suya.
- **`NUMERO DE CUENTA BCP/INTERBANK/BBVA`** es, en tu hoja, la columna del **banco**
  (los datos son BCP, INTERBANK, PICHINCHA…). Se reconoce como tal: 108 de 108 filas
  quedaron con banco.
- **`NRO. OPERACION / MONTO / FECHA`** viene con tres cosas juntas
  (`OP 12071844 / 18/08/2026`). Se separa el número de operación y, cuando hay una fecha
  dentro, se usa como fecha de pago.
- **`NO SE HA PAGADO DETRACCION`** en la columna de información adicional se lee como
  detracción **pendiente**, no pagada. Es una negación y el sistema la entiende.

Para volver a comprobarlo con cualquier archivo nuevo, sin tocar la base de datos:

```bash
npx tsx scripts/probar-importador.ts "ruta/al/archivo.xlsx"
```

Te muestra qué formato detectó, qué columna alimentó cada campo, cuántas filas entran y el
motivo exacto de cada rechazo.

---

## 11. Qué falta decidir contigo

| Tema | Por qué no lo decidí solo |
|---|---|
| Código y tasa de detracción | Es materia tributaria; lo confirma tu contador (§3.2) |
| Formato del archivo Telecrédito | Lo define tu convenio con el BCP (§7) |
| Prorrateo de costos de vehículo | Criterio contable, no dato (§9) |
| Tope y días de rendición por conductor | Política interna tuya (§3.3) |

Si me pasas una copia de tus Google Sheets reales (aunque sea con los montos cambiados),
ajusto los perfiles de importación a tus cabeceras exactas y te dejo la carga probada de
punta a punta.
