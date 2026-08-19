package com.transportesafa.conductor;

import android.Manifest;
import android.content.Context;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.google.android.gms.common.api.ApiException;
import com.google.android.gms.common.api.ResolvableApiException;
import com.google.android.gms.location.LocationRequest;
import com.google.android.gms.location.LocationServices;
import com.google.android.gms.location.LocationSettingsRequest;
import com.google.android.gms.location.LocationSettingsStatusCodes;
import com.google.android.gms.location.Priority;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Plugin nativo propio de AFA. Expone:
//  • EXENCIÓN de optimización de batería (Doze/App Standby + battery savers del fabricante),
//    que el sistema solo permite pedir con un Intent nativo.
//  • AJUSTES DE UBICACIÓN DEL SISTEMA (SettingsClient): detecta que el interruptor de
//    Ubicación esté apagado o en modo "Ahorro de batería" (solo red, SIN satélite) y ofrece
//    corregirlo con el diálogo nativo de Google, sin sacar al conductor de la app. Esto es
//    complementario al parche que obliga a pedir GPS: por muy alto que el código pida la
//    calidad, si el AJUSTE DEL SISTEMA está en ahorro de batería el teléfono nunca encenderá
//    el GNSS y la posición sale por antena (±50-1350 m).
//  • UBICACIÓN "TODO EL TIEMPO" (ACCESS_BACKGROUND_LOCATION): NINGÚN plugin del app la pedía
//    explícitamente — en Android 11+ el diálogo normal ya NO ofrece "Permitir todo el tiempo";
//    la ÚNICA vía nativa es pedir el permiso de fondo por separado, con lo que el sistema abre
//    su pantalla de ajustes de ubicación de la app automáticamente (ahí está la opción).
// Ambos se invocan desde JS tras una ACCIÓN del conductor y tras la divulgación destacada
// (política de Google Play). Idempotentes: si ya están concedidos no hacen nada.
@CapacitorPlugin(name = "AfaNative")
public class AfaNativePlugin extends Plugin {

    @PluginMethod
    public void isIgnoringBatteryOptimizations(PluginCall call) {
        JSObject ret = new JSObject();
        ret.put("value", isExempt());
        call.resolve(ret);
    }

    @PluginMethod
    public void requestBatteryExemption(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M || isExempt()) {
                ret.put("opened", false);
                call.resolve(ret);
                return;
            }
            Intent intent = new Intent(Settings.ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS);
            intent.setData(Uri.parse("package:" + getContext().getPackageName()));
            // Lanzar como Activity. getActivity() existe mientras el WebView está vivo; si por
            // alguna razón es null, NEW_TASK permite arrancar desde el contexto de aplicación.
            if (getActivity() != null) {
                getActivity().startActivity(intent);
            } else {
                intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
                getContext().startActivity(intent);
            }
            ret.put("opened", true);
            call.resolve(ret);
        } catch (Exception e) {
            // ROM que no expone el intent (ActivityNotFoundException) u otra restricción →
            // NO romper: el conductor puede activarlo manualmente desde la guía de ajustes.
            ret.put("opened", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }

    // ── Ajustes de ubicación del sistema (GPS encendido + alta precisión) ───────────────
    //
    // POR QUÉ NO BASTA CON LOS PERMISOS: el permiso dice si la APP puede leer la ubicación;
    // estos ajustes dicen qué SENSORES enciende el sistema. Un conductor puede tener el
    // permiso perfecto ("Permitir todo el tiempo" + Preciso) y aun así emitir por antena
    // porque el teléfono está en modo ahorro. Ese caso es invisible para checkPermissions().
    //
    // El resultado del diálogo NO se espera aquí (llegaría a onActivityResult): se resuelve
    // de inmediato y JS re-consulta `checkLocationSettings` al volver a primer plano, que es
    // el mismo patrón que usa requestBackgroundLocation más abajo.

    /** LocationRequest de alta precisión; es lo que se le pide al sistema que pueda satisfacer. */
    private LocationSettingsRequest buildSettingsRequest(boolean alwaysShow) {
        LocationRequest req = new LocationRequest.Builder(Priority.PRIORITY_HIGH_ACCURACY, 2000L).build();
        return new LocationSettingsRequest.Builder()
                .addLocationRequest(req)
                // alwaysShow=true hace que el diálogo aparezca aunque el usuario lo haya
                // rechazado antes; sin esto, un "no" previo lo silencia para siempre.
                .setAlwaysShow(alwaysShow)
                .build();
    }

    /**
     * SOLO LECTURA: ¿el sistema puede darnos alta precisión ahora mismo?
     *   satisfecho=true  → GPS encendido y en alta precisión; no hay nada que pedir.
     *   resoluble=true   → se puede arreglar con el diálogo (llamar requestLocationSettings).
     *   disponible=false → sin Google Play Services (o error): caer a la guía manual.
     */
    @PluginMethod
    public void checkLocationSettings(PluginCall call) {
        try {
            LocationServices.getSettingsClient(getContext())
                .checkLocationSettings(buildSettingsRequest(false))
                .addOnSuccessListener(r -> {
                    JSObject ret = new JSObject();
                    ret.put("disponible", true);
                    ret.put("satisfecho", true);
                    ret.put("resoluble", false);
                    call.resolve(ret);
                })
                .addOnFailureListener(e -> {
                    JSObject ret = new JSObject();
                    ret.put("disponible", true);
                    ret.put("satisfecho", false);
                    // RESOLUTION_REQUIRED = el usuario puede arreglarlo desde el diálogo.
                    // SETTINGS_CHANGE_UNAVAILABLE = la ROM no lo permite (ej. modo avión, o
                    // fabricante que bloquea el cambio) → solo queda la guía manual.
                    boolean resoluble = (e instanceof ResolvableApiException)
                            && ((ApiException) e).getStatusCode() == LocationSettingsStatusCodes.RESOLUTION_REQUIRED;
                    ret.put("resoluble", resoluble);
                    call.resolve(ret);
                });
        } catch (Throwable t) {
            // Dispositivo sin Play Services: no romper, degradar a la guía manual.
            JSObject ret = new JSObject();
            ret.put("disponible", false);
            ret.put("satisfecho", false);
            ret.put("resoluble", false);
            ret.put("error", t.getMessage());
            call.resolve(ret);
        }
    }

    /**
     * Muestra el diálogo NATIVO de Google ("Para continuar, activa la ubicación del
     * dispositivo") con su botón de aceptar: un toque y el sistema enciende el GPS y sube el
     * modo a alta precisión, sin que el conductor tenga que buscar nada en Ajustes.
     * DEBE invocarse tras una acción del conductor. Idempotente: si ya está bien, no muestra nada.
     */
    @PluginMethod
    public void requestLocationSettings(PluginCall call) {
        try {
            if (getActivity() == null) {
                JSObject ret = new JSObject();
                ret.put("mostrado", false);
                ret.put("satisfecho", false);
                call.resolve(ret);
                return;
            }
            LocationServices.getSettingsClient(getActivity())
                .checkLocationSettings(buildSettingsRequest(true))
                .addOnSuccessListener(r -> {
                    JSObject ret = new JSObject();
                    ret.put("mostrado", false);
                    ret.put("satisfecho", true);   // ya estaba correcto
                    call.resolve(ret);
                })
                .addOnFailureListener(e -> {
                    JSObject ret = new JSObject();
                    ret.put("satisfecho", false);
                    boolean mostrado = false;
                    if (e instanceof ResolvableApiException) {
                        try {
                            // Lanza el diálogo del sistema. El resultado lo verifica JS
                            // re-consultando checkLocationSettings al volver a 1er plano.
                            ((ResolvableApiException) e).startResolutionForResult(getActivity(), 1003);
                            mostrado = true;
                        } catch (Exception ex) {
                            ret.put("error", ex.getMessage());
                        }
                    }
                    ret.put("mostrado", mostrado);
                    call.resolve(ret);
                });
        } catch (Throwable t) {
            JSObject ret = new JSObject();
            ret.put("mostrado", false);
            ret.put("satisfecho", false);
            ret.put("error", t.getMessage());
            call.resolve(ret);
        }
    }

    private boolean isExempt() {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.M) return true;
        PowerManager pm = (PowerManager) getContext().getSystemService(Context.POWER_SERVICE);
        return pm != null && pm.isIgnoringBatteryOptimizations(getContext().getPackageName());
    }

    // ── Ubicación "todo el tiempo" (ACCESS_BACKGROUND_LOCATION) ─────────────────────────

    private boolean tienePermiso(String permiso) {
        return ContextCompat.checkSelfPermission(getContext(), permiso) == PackageManager.PERMISSION_GRANTED;
    }

    /** ¿La app ya tiene ubicación en segundo plano ("Permitir todo el tiempo")? */
    @PluginMethod
    public void hasBackgroundLocation(PluginCall call) {
        JSObject ret = new JSObject();
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.Q) {
            // Antes de Android 10 no existe el permiso de fondo: tener FINE ya cubre todo.
            ret.put("value", tienePermiso(Manifest.permission.ACCESS_FINE_LOCATION));
        } else {
            ret.put("value", tienePermiso(Manifest.permission.ACCESS_BACKGROUND_LOCATION));
        }
        call.resolve(ret);
    }

    /**
     * Pide ACCESS_BACKGROUND_LOCATION de forma nativa. En Android 11+ el sistema NO muestra un
     * diálogo: abre AUTOMÁTICAMENTE la pantalla de ajustes de ubicación de la app, donde el
     * conductor toca "Permitir todo el tiempo" — el flujo nativo que antes solo aparecía en
     * MIUI viejos. Requiere tener ya el permiso de 1er plano (petición incremental, requisito
     * de Android). Idempotente: si ya está concedido no hace nada. El resultado se verifica
     * desde JS re-consultando hasBackgroundLocation al volver a 1er plano.
     */
    @PluginMethod
    public void requestBackgroundLocation(PluginCall call) {
        JSObject ret = new JSObject();
        try {
            boolean primerPlano = tienePermiso(Manifest.permission.ACCESS_FINE_LOCATION)
                    || tienePermiso(Manifest.permission.ACCESS_COARSE_LOCATION);
            boolean yaConcedido = Build.VERSION.SDK_INT < Build.VERSION_CODES.Q
                    || tienePermiso(Manifest.permission.ACCESS_BACKGROUND_LOCATION);
            if (yaConcedido || !primerPlano || getActivity() == null) {
                ret.put("requested", false);
                call.resolve(ret);
                return;
            }
            ActivityCompat.requestPermissions(
                getActivity(),
                new String[] { Manifest.permission.ACCESS_BACKGROUND_LOCATION },
                1002
            );
            ret.put("requested", true);
            call.resolve(ret);
        } catch (Exception e) {
            // No romper nunca: la guía de ajustes cubre el camino manual.
            ret.put("requested", false);
            ret.put("error", e.getMessage());
            call.resolve(ret);
        }
    }
}
