import type { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.zhenti.kaoyan',
  appName: '考研研习社',
  webDir: 'dist',
  android: {
    allowMixedContent: false,
    backgroundColor: '#f5f4ef',
  },
  server: {
    androidScheme: 'https',
  },
}

export default config
