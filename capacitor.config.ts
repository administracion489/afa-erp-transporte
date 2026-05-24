import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.transportesafa.conductor',
  appName: 'AFA Conductores',
  webDir: 'out',
  server: {
    url: 'https://www.transportesafa.com/conductor',
    cleartext: false,
  },
};

export default config;
