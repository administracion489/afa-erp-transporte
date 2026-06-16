import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.transportesafa.conductor',
  appName: 'AFA Conductores',
  webDir: 'out',
  server: {
    url: 'https://www.transportesafa.com/conductor',
    cleartext: false,
  },
  // NOTA: NO usar `useLegacyBridge: true`. Con el server.url remoto bloqueaba el
  // hilo principal y causaba ANR ("AFA Conductor no responde") en el login. El
  // throttling de red en segundo plano se resuelve con CapacitorHttp (HTTP nativo)
  // en condApi(), que NO depende del bridge.
};

export default config;
