// Re-add Ichnaea's custom plugins to capacitor.plugins.json AFTER `cap sync`,
// which regenerates that file from the installed Capacitor plugins and would
// otherwise drop our locally-registered plugins (IchnaeaUpdater, IchnaeaNotify).
import { readFileSync, writeFileSync } from 'fs'

const file = 'android/app/src/main/assets/capacitor.plugins.json'
const custom = [
  { pkg: 'com.ichnaea.android', classpath: 'com.ichnaea.android.IchnaeaUpdaterPlugin' },
  { pkg: 'com.ichnaea.android', classpath: 'com.ichnaea.android.IchnaeaNotifyPlugin' }
]

const list = JSON.parse(readFileSync(file, 'utf8'))
for (const c of custom) {
  if (!list.some((x) => x.classpath === c.classpath)) list.push(c)
}
writeFileSync(file, JSON.stringify(list, null, '\t') + '\n')
console.log('[plugins] capacitor.plugins.json:', list.map((x) => x.classpath.split('.').pop()).join(', '))
