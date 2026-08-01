# Activar las notificaciones push en el APK del conductor

Guía para completar lo único que **no se puede resolver desde el código**: conectar la app
Android con Firebase y publicar la nueva versión.

## Qué funciona ya y qué falta

El push al conductor está **completo en el ERP**: motor de envío, suscripciones, canales
por tipo de mensaje y la pantalla "Notificaciones → Activar" en el perfil del conductor.

| Superficie | Estado |
|---|---|
| Chrome / navegador Android | ✅ Funciona en cuanto corras el SQL |
| PWA instalada | ✅ Funciona |
| **APK de Play Store** | ❌ Falta Firebase + republicar (esta guía) |
| iPhone | ❌ Sin camino hoy (el proyecto `ios/` apunta a otra app) |

**Importante:** tus conductores trabajan dentro del APK (lo necesitan para el GPS en
segundo plano), así que en la práctica **el push les llegará recién al terminar esta guía**.
Mientras tanto siguen recibiendo WhatsApp con normalidad.

Estado verificado del proyecto Android:

- `applicationId`: `com.transportesafa.conductor` · variante debug: `com.transportesafa.conductor.debug`
- `versionCode` actual: **31** (`versionName` 2.3)
- Classpath de Google ya declarado: `com.google.gms:google-services:4.4.4` (`android/build.gradle:11`)
- Plugin `@capacitor/push-notifications` ya incluido en el build
- **Falta `android/app/google-services.json`** → `android/app/build.gradle:73-80` cae al
  `catch` y registra en silencio *"Push Notifications won't work"*. Ese es el bloqueo real.

---

## Paso 1 — Crear la app Android en Firebase

1. Entra a [console.firebase.google.com](https://console.firebase.google.com) con la
   cuenta de la empresa. Usa el **mismo proyecto** donde ya vive la app del pasajero (así
   se reutiliza la credencial del servidor); si no existe, crea uno nuevo.
2. **Agregar app → Android**.
3. Nombre del paquete, exactamente:
   ```
   com.transportesafa.conductor
   ```
4. Repite el paso 2-3 para la variante de desarrollo:
   ```
   com.transportesafa.conductor.debug
   ```
   > **Por qué:** el build de debug usa `applicationIdSuffix ".debug"`. Si esa app no está
   > registrada, `gradlew assembleDebug` **empezará a fallar** en cuanto añadas el JSON.
   > El build de release no se ve afectado, pero te bloquearía las pruebas locales.
5. Descarga **`google-services.json`** y colócalo en:
   ```
   android/app/google-services.json
   ```
   > Ese archivo no contiene secretos de servidor (todo lo que trae se puede extraer del
   > APK). Conviene commitearlo para que el build sea reproducible. Hoy **no** está
   > ignorado: en `android/.gitignore:65` la línea está comentada. Si prefieres no
   > versionarlo, descomenta esa línea.

## Paso 2 — Credenciales del servidor (para poder enviar)

En Firebase: **⚙️ Configuración del proyecto → Cuentas de servicio → Generar nueva clave
privada**. Descarga el JSON y saca tres valores:

```bash
FIREBASE_PROJECT_ID=<project_id>
FIREBASE_CLIENT_EMAIL=<client_email>
FIREBASE_PRIVATE_KEY="<private_key>"
```

Ponlos en `.env.local` **y** en Vercel (*Settings → Environment Variables → Production*).

> **Cuidado con la clave privada:** viene con saltos de línea escritos como `\n`. Déjalos
> tal cual y entre comillas — el código ya hace `.replace(/\\n/g, "\n")`. Si los conviertes
> a saltos reales, la firma falla.

Sin estas tres variables, `enviarFcm()` corta en seco y no manda nada, **incluso para los
pasajeros**. Vale la pena revisar si ya estaban en Vercel: no están en tu `.env.local`.

## Paso 3 — Reconstruir y publicar

```bash
npx cap sync android
```

Sube el `versionCode` en `android/app/build.gradle` (línea 17): **31 → 32**. Play rechaza
un AAB con un `versionCode` ya usado.

```bash
# JAVA_HOME="D:\APLICACIONES ANDROID\jbr"
cd android
gradlew bundleRelease
```

El AAB queda en `android/app/build/outputs/bundle/release/`. Súbelo a Play Console.

> **Requisito:** `android/keystore.properties` debe existir localmente (está gitignorado).
> Sin él, la firma queda con contraseñas vacías y `bundleRelease` falla. El keystore
> `afa-keystore.jks` sí está en la raíz del repo.

## Paso 4 — Verificar

1. Instala la versión nueva desde Play en un teléfono de prueba.
2. Entra a la app → **Perfil → Notificaciones → Activar**. Acepta el permiso.
3. Confirma en Supabase que se guardó la suscripción:
   ```sql
   select id, conductor_id, conductor_tabla, tipo, plataforma, activo
     from push_suscripciones where conductor_id is not null;
   ```
4. En **Configuración → Alertas y Mensajes**, enciende 📲 Push en algún tipo de mensaje
   (por ejemplo "Servicio asignado") y provoca ese evento.

---

## Si el push no llega — en este orden

1. **¿Corriste `supabase/push-conductor.sql`?** Sin las columnas `conductor_id` /
   `conductor_tabla`, el envío **degrada en silencio**: devuelve cero y solo deja un
   `console.warn`. Es la causa más fácil de pasar por alto.
2. **¿Está el `google-services.json` en el AAB publicado?** Es una pieza **nativa**: no
   viaja por el `server.url` remoto. Si actualizaste solo la web, el APK sigue sin FCM.
3. **¿Están las tres `FIREBASE_*` en Vercel?** Si faltan, `fcmCliente()` devuelve `null`.
4. **¿El conductor pulsó "Activar"?** Sin permiso concedido no hay suscripción. Si aparece
   "Bloqueadas", debe habilitarlas en los ajustes de Android (no se puede volver a pedir).
5. **¿La sesión es nueva?** Las suscripciones exigen el token firmado que se emite al
   iniciar sesión. Un conductor con sesión anterior a esta versión debe volver a entrar;
   la app se lo indica ("Vuelve a iniciar sesión para activarlas").

## Nota sobre los canales de Android

El servidor manda los avisos del conductor por el canal `afa_conductor`. **En Android 8+,
una notificación cuyo canal no existe en el dispositivo no se muestra** (sin error visible).
Ese canal ya se crea desde el código web (`lib/push-cliente.ts`), así que **llega al APK sin
republicar**. Si algún día cambias el nombre del canal en `lib/push.ts`, hay que crearlo
también ahí o las notificaciones desaparecen en silencio.
