package com.transportesafa.conductor;

import android.content.Context;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.PowerManager;
import android.provider.Settings;

import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

// Plugin nativo propio de AFA. Hoy expone solo la EXENCIÓN de optimización de batería
// (Doze/App Standby + battery savers del fabricante), que el sistema solo permite pedir
// con un Intent nativo. Se invoca desde JS por un BOTÓN EXPLÍCITO del conductor (cumple la
// política de Google Play de "solicitar en respuesta a una acción del usuario"), no en el
// arranque. Idempotente: si ya está exenta no hace nada.
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
}
