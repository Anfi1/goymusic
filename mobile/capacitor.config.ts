import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'com.goymusic.app',
  appName: 'GoyMusic',
  webDir: 'dist',
  android: {
    // Тёмная тема приложения -- фон вебвью не должен мигать белым при старте.
    backgroundColor: '#0b0b0f',
  },
};

export default config;
