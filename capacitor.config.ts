import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.transportesafa.erp',
  appName: 'AFA ERP Transporte',
  webDir: 'out',
  server: {
    url: 'https://transportesafa.com',
    cleartext: false,
  },
};

export default config;