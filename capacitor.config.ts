import { CapacitorConfig } from '@capacitor/cli'

const config: CapacitorConfig = {
  appId: 'com.ichnaea.android',
  appName: 'Ichnaea',
  webDir: 'src/webview',
  server: {
    androidScheme: 'https'
  }
}

export default config
