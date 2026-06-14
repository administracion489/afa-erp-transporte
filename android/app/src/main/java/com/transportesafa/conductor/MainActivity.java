package com.transportesafa.conductor;

import android.Manifest;
import android.content.pm.PackageManager;
import android.os.Build;
import android.os.Bundle;

import androidx.core.app.ActivityCompat;
import androidx.core.content.ContextCompat;

import com.getcapacitor.BridgeActivity;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends BridgeActivity {

    // Pide los permisos NATIVAMENTE al primer arranque (como Uber/inDrive),
    // sin depender de que cargue la web. Si ya están concedidos, no muestra nada.
    @Override
    public void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        List<String> permisos = new ArrayList<>();

        if (ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION)
                != PackageManager.PERMISSION_GRANTED) {
            permisos.add(Manifest.permission.ACCESS_FINE_LOCATION);
            permisos.add(Manifest.permission.ACCESS_COARSE_LOCATION);
        }

        // Cámara: requerida para escanear el QR del pasajero
        if (ContextCompat.checkSelfPermission(this, Manifest.permission.CAMERA)
                != PackageManager.PERMISSION_GRANTED) {
            permisos.add(Manifest.permission.CAMERA);
        }

        // Android 13+ requiere permiso explícito para notificaciones
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            if (ContextCompat.checkSelfPermission(this, Manifest.permission.POST_NOTIFICATIONS)
                    != PackageManager.PERMISSION_GRANTED) {
                permisos.add(Manifest.permission.POST_NOTIFICATIONS);
            }
        }

        if (!permisos.isEmpty()) {
            ActivityCompat.requestPermissions(this, permisos.toArray(new String[0]), 1001);
        }
    }
}
