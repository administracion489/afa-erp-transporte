import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.transportesafa.pasajero',
  appName: 'AFA Pasajeros',
  webDir: 'out',
  server: {
    url: 'https://transportesafa.com/pasajero',
    cleartext: false,
  },
};

export default config;
