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

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Plugin nativo propio de AFA. Expone:
//  • EXENCIÓN de optimización de batería (Doze/App Standby + battery savers del fabricante),
//    que el sistema solo permite pedir con un Intent nativo.
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
