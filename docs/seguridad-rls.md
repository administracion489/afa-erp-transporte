# Cerrar la base de datos: RLS y los avisos críticos de Supabase

Guía para resolver los dos avisos **críticos** que manda el asesor de seguridad de Supabase
(`rls_disabled_in_public` y `columnas_sensibles_expuestas`) y para entender qué queda
pendiente después.

El código ya está. Lo único que **no se puede hacer desde el repositorio** es correr la
migración en Supabase. Eso es lo que explica esta guía.

---

## 1. Qué está pasando, en una frase

La clave `anon` viaja dentro del JavaScript del sitio: es **pública por diseño**. Cualquiera
abre las herramientas de desarrollador del navegador y la copia. Lo único que separa esa
clave de la base de datos es **RLS** (Row Level Security). Con RLS apagado, esa clave es una
llave maestra.

Al momento de esta revisión, **106 tablas creadas por migración y ~130 tablas en uso** estaban
sin RLS. Sin iniciar sesión, desde una consola cualquiera, se podía:

- volcar `pasajeros` (nombre + DNI), `conductores` (DNI, teléfono, `pin_acceso`),
  `portal_usuarios` (`codigo_acceso` en claro) y toda la contabilidad;
- seguir cualquier bus en vivo leyendo `ubicaciones_gps`;
- y lo más grave: **`update usuarios set rol='admin'`** sobre la propia fila.

Ese último punto merece detenerse. `app/usuarios/page.tsx` escribe `usuarios.rol` y
`permisos_usuario` **desde el navegador**. Sin RLS eso no es "una pantalla de administrador":
es una escalada de privilegios de una línea, disponible para cualquiera. El gate de módulos
del menú (`app/layout.tsx`) sirve para no pintar botones; **no autoriza nada**.

---

## 2. Correr la migración (una sola vez, ~10 segundos)

Supabase → **SQL Editor** → pegar el contenido de `supabase/seguridad-09-rls-global.sql` →
**Run**.

Es idempotente: se puede correr las veces que haga falta. Solo toca tablas que hoy tienen el
RLS **apagado**, así que nunca pisa una política afinada a mano ni ensancha una que ya exista.

### Qué hace

1. Crea `fn_es_admin()` y `fn_usuario_activo()`. Son `SECURITY DEFINER` a propósito: sin eso,
   una política sobre `usuarios` que consulte `usuarios` recursa infinitamente.
2. Le quita a `anon` los permisos sobre el esquema `public` — y también sobre las tablas
   futuras (`alter default privileges`), para que la próxima tabla nazca cerrada.
3. Enciende RLS y crea una política base para `authenticated` en toda tabla que hoy no la tenga.
4. Blinda `usuarios` y `permisos_usuario`: **leer** sigue abierto a cualquier operador
   (el menú lo necesita en cada navegación), **escribir** pasa a ser exclusivo de admin.
   Ahí muere la escalada de privilegios.
5. Pone las vistas (`v_egresos`, `v_cuentas_por_pagar`, …) en `security_invoker`. Una vista de
   Postgres corre, por omisión, con los permisos de **su dueño**, así que se salta el RLS de
   las tablas que lee: sin este paso las vistas serían un túnel alrededor de todo lo anterior.

### Verificar

La migración termina con una consulta que debe devolver **cero filas**. Cada fila es una tabla
que sigue abierta al mundo:

```sql
select c.relname
from pg_class c join pg_namespace n on n.oid = c.relnamespace
where n.nspname = 'public' and c.relkind = 'r' and c.relrowsecurity = false;
```

Después, en Supabase → **Advisors** → **Security**, los dos avisos críticos deben desaparecer.

---

## 3. Qué NO se rompe (verificado contra el código)

| Superficie | Cómo consulta | Efecto |
|---|---|---|
| ERP web (todas las pantallas) | como `authenticated`, con la sesión de Supabase | La política base le da lo mismo que ya tenía |
| App del conductor (`/conductor`) | 0 consultas directas — todo por `/api/conductor` con service_role | Ninguno (service_role se salta RLS por diseño) |
| Portal del proveedor, `/lector`, `/registro`, `/conformidad` | 0 consultas directas | Ninguno |
| Portal del cliente (`/cliente`) | sus últimas lecturas anon se portaron a `/api/cliente` en este mismo cambio | Ninguno |
| `/privacidad` y el logo del login | `empresa_perfil` y `paginas_legales` | Siguen legibles por `anon` a propósito: son contenido público |

**Un matiz honesto sobre el tiempo real.** Los canales `realtime` que el portal del cliente
abría como `anon` dejan de entregar filas. No es un problema: el portal ya refresca por
`setInterval` cada 5–30 s y esas llamadas van por `/api/cliente/gps`. El mapa en vivo sigue
funcionando, con el refresco del sondeo en lugar del empujón instantáneo.

---

## 4. Lo que la política base **no** hace

La política base concede a cualquier usuario autenticado el mismo acceso que ya tenía de
hecho. **No** implementa autorización por módulo dentro de Postgres.

Eso es deliberado: el objetivo de esta migración es que la clave anon deje de ser una llave
maestra, sin cambiar el comportamiento del ERP para los usuarios reales. La autorización por
módulo sigue viviendo donde ya vivía — `lib/api-auth.ts` en el servidor y el gate del layout
en la UI — y afinarla tabla por tabla dentro de Postgres es el siguiente paso natural, no
este.

Dicho de otro modo: esto cierra la puerta de calle. Las puertas interiores siguen como estaban.

---

## 5. Pendientes, por orden de importancia

Lo que esta revisión encontró y **no** arregló, con el motivo.

### 5.1 Buckets de Storage públicos — ALTO

`app/documentos/page.tsx`, `app/pasajero/page.tsx`, `app/vehiculos/page.tsx`,
`app/mantenimiento/*` y otros usan `getPublicUrl`. Un bucket público es legible por cualquiera
que tenga (o adivine) la URL, sin autenticación. Ahí hay fotos de pasajeros, licencias, SOAT y
documentos vehiculares.

El molde correcto ya existe en el repositorio: el bucket `comprobantes` es privado y se lee con
`createSignedUrl` (ver `app/caja-chica/ModalRendicion.tsx`). Migrar cada bucket exige cambiar a
todos sus consumidores, así que es un trabajo aparte.

### 5.2 PINs y contraseñas en claro — ALTO

`conductores.pin_acceso`, `pasajeros.pin_acceso` y `portal_usuarios.codigo_acceso` se guardan
sin cifrar, y las pantallas de administración los leen para rellenar el formulario de edición.
Tras esta migración ya no los alcanza `anon`, pero siguen legibles por cualquier operador y por
cualquiera que consiga una copia de la base.

Arreglarlo es migrar los tres flujos de login a un hash (bcrypt/argon2) — cambio de esquema y
de código, con una ventana de convivencia. Separado a propósito.

### 5.3 `afa-keystore.jks` está versionado — ALTO

Es la llave con la que se firma el APK de Android. `.gitignore` ya lista `*.jks`, pero el
archivo entró al repositorio antes de esa regla y sigue en el historial.

**No se borró en este cambio a propósito**: si esa es la única copia que existe, perderla
significa no poder volver a publicar una actualización de la app en Play Store, nunca. El orden
correcto es:

1. Respaldar el archivo fuera del repositorio (gestor de contraseñas o almacenamiento cifrado).
2. Confirmar que el respaldo abre, con su contraseña.
3. Recién entonces: `git rm --cached afa-keystore.jks` y commit.
4. Si el repositorio estuvo compartido con alguien fuera del equipo, considerar la llave
   comprometida y planificar el cambio de firma con Play App Signing.

### 5.4 Rutas API con service_role y sin verificar identidad — MEDIO

Corren con la llave de servicio, que se salta el RLS. Lo que RLS ya no permite desde el
navegador, estas lo siguen permitiendo desde `curl`:

| Ruta | Qué permite hoy sin autenticación |
|---|---|
| `/api/conductor-paradas` | crear paradas y geocodificar sobre cualquier reserva |
| `/api/conductor-alerta` | insertar alertas SOS / retraso de cualquier conductor |
| `/api/facturas/leer` | gastar créditos de OCR/IA a discreción |
| `/api/dev/gps-replay` | banco de pruebas de desarrollo servido en producción |
| `/api/mantenimiento/leer-odometro` | ídem OCR |

Las dos primeras las llama la app del conductor, que **ya tiene** un token firmado
(`lib/conductor-auth.ts`): el arreglo es exigirlo con `sesionDeToken` y derivar de ahí el
conductor. No se hizo aquí porque toca la app que usan los buses en ruta y merece su propia
ventana de prueba.

`/api/registro` también aparece sin autenticación, pero eso es correcto: es el formulario
público de alta. Vale ponerle límite de tasa, no autenticación.

---

## 6. Lo que sí se arregló en este cambio

Además de la migración:

- **IDOR en `/api/portal/manifiesto`** — el `cliente_id` llegaba en el cuerpo de la petición y
  se comparaba contra el de la reserva. Como quien llamaba controlaba los dos lados, bastaba
  probar `reserva_id=N` contra `cliente_id=1,2,3…` hasta que dejara de responder 403 para leer
  y **editar** el manifiesto —nombres y DNI— de cualquier empresa cliente. Ahora el
  `cliente_id` sale del token firmado y el del cuerpo se ignora.
- **`/api/pasajeros/credenciales` y `/api/pasajeros/upsert-nomina`** — corrían con service_role
  sin ninguna verificación. La primera disparaba correos de credenciales a pasajeros reales
  (un vector de phishing con el remitente legítimo de AFA); la segunda escribía la nómina de
  cualquier cliente. Ambas exigen ahora sesión válida y el módulo `clientes`.
- **Portal del cliente** — sus últimas lecturas con la clave anon (`conductores`,
  `conductores_tercero`, `vehiculos_tercero`, `ubicaciones_gps`) pasan por `/api/cliente` y
  `/api/cliente/gps`, que validan el token y comprueban que ese conductor, ese vehículo o esa
  reserva sean **de ese cliente**. Antes, con la clave anon, bastaba con conocer —o tantear—
  un `reservaId` para seguir en vivo el bus de otra empresa y bajar su recorrido completo.
