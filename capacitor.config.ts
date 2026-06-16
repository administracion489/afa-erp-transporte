import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.transportesafa.conductor',
  appName: 'AFA Conductores',
  webDir: 'out',
  server: {
    url: 'https://www.transportesafa.com/conductor',
    cleartext: false,
  },
  android: {
    // Requerido por @capgo/background-geolocation: sin el bridge legacy, Android
    // suspende el WebView en segundo plano (~5 min) y el rastreo se corta.
    useLegacyBridge: true,
  },
};

export default config;
