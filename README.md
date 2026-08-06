# Ichnaea Android

Android port of [Ichnaea](https://github.com/aquamammal/ichnaea-v2) — a privacy-first, peer-to-peer location check-in app with end-to-end encryption.

Runs the full Hyperswarm/Hypercore P2P stack on Android via **NodeJS-Mobile** (embedded Node) with a **Capacitor WebView** UI. The renderer talks to the Node P2P process over a localhost WebSocket bridge.

## How it works

```
┌────────────────────────────────────────────────────────┐
│ Capacitor WebView (http://localhost)                    │
│  src/index.html + src/main.bundle.js (globe UI)         │
│  geolocation via navigator.geolocation                  │
│         │  ws://localhost:14770                         │
├─────────▼──────────────────────────────────────────────┤
│ NodeJS-Mobile (embedded Node, runs in a ForegroundService) │
│  src/node/server.js  → WebSocket bridge                 │
│  src/main/           → P2P stack (Hyperswarm, Hypercore, │
│                         identity, contacts, E2E crypto)  │
│  libnode.so + udx-native.node (native DHT/UDP addon)    │
└────────────────────────────────────────────────────────┘
```

## Requirements

- Node.js LTS (18+)
- Android SDK (API 34), NDK, CMake
- Android Studio (recommended) or `adb` + gradle CLI

## Setup

```bash
git clone https://github.com/aquamammal/ichnaea-android.git
cd ichnaea-android
npm install
npx cap add android   # generates android/ locally (gitignored; see the regeneration caveats below)
```

## Build & install (CLI)

```bash
export ANDROID_HOME=$HOME/Android/Sdk
npm run build:apk     # bundles Node + renderer, syncs, builds debug APK
adb install -r android/app/build/outputs/apk/debug/app-debug.apk
```

Or open `android/` in Android Studio and press Run.

## Development

- `npm run build:node` — bundle the Node P2P stack (`src/node/server.js`) → `android/app/src/main/assets/nodejs-project/bundle.cjs`.
- `npm run build:renderer` — bundle the WebView renderer (`src/main.js` + globe.gl + d3-geo-polygon) → `src/main.bundle.js`.
- `npm run node:start` — run the Node bridge on desktop (test with a browser pointed at `ws://localhost:14770`).
- `npm test` — shared unit tests (crypto, staleness).

## Architecture

- `src/node/server.js` — NodeJS-Mobile entrypoint: WebSocket server on `localhost:14770`, boots the P2P app once, re-targets the pipe per renderer connection.
- `src/main/` — shared P2P stack (Hyperswarm, Hypercore, identity, contacts, settings, scheduler, E2E encryption). Same code as the desktop version, bundled for Node 12.
- `src/main.js`, `src/index.html`, `src/staleness.js`, `src/renderer.js`, `src/map-styles.js`, `src/globe-renderer.js`, `src/map2d.js`, `src/assets/` — WebView UI, bundled with esbuild (browsers can't resolve bare imports like `globe.gl`). `src/renderer.js` dispatches on the user-selected **map style** (`src/map-styles.js`): three 3D globe looks (wireframe / full-color Blue Marble / colored countries + blue water) and three 2D maps (world / Taiwan-centered / Dymaxion, via `d3-geo` + `d3-geo-polygon`). Picked in Settings, persisted in localStorage, applied on reload.
- `android/app/src/main/cpp/` — JNI bridge: starts Node via the embedder API, redirects stdout/stderr to logcat.
- `android/app/src/main/jniLibs/arm64-v8a/` — `libnode.so`, `libc++_shared.so`, plus the compiled JNI lib.
- `android/app/src/main/assets/nodejs-project/` — the bundled Node stack.
- `android/app/src/main/assets/nodejs-native-assets-arm64-v8a/` — native addons for Node's `require()` (udx-native + deps).

## Mobile lifecycle & networking (Android)

The app runs the P2P stack in a **ForegroundService** (persistent notification) so Android doesn't kill it or throttle its UDP sockets:

- **Connectivity hooks** — a `ConnectivityManager.NetworkCallback` in `NodeService.java` watches the network. On connectivity loss it sends `suspend` to Node; on a Wi-Fi ↔ cellular transport switch it "bounces" the swarm (`suspend` then `resume` ~2.5s later). Node receives these over a **stdin control channel** (a socketpair wired in the JNI bridge) and calls Hyperswarm's `swarm.suspend()` / `swarm.resume()`, so the DHT re-binds sockets and re-announces topics instead of silently dropping off.
- **Multicast lock** — `WifiManager.MulticastLock` is held so local-area UDP multicast (Hyperswarm's LAN peer discovery) works.
- **Battery exemption** — `MainActivity` asks the user to disable battery optimization (`ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS`) so Doze doesn't freeze the service.

## Map styles

The renderer supports six user-selectable views, picked in **Settings → Map style** (persisted in localStorage, applied on reload; the hidden dev panel has a "Next map" cycler):

| Style | Kind | Look |
|---|---|---|
| Globe — Wireframe | 3D | dark sphere + country border lines (default) |
| Globe — Full Color | 3D | bundled Blue Marble earth texture |
| Globe — Colored Countries | 3D | distinct country fills over blue water |
| Map | 2D | equirectangular centered on Taiwan (~121°E) |
| Map — Centered on Me | 2D | equirectangular centered on your current check-in location |
| Map — Dymaxion | 2D | Buckminster Fuller's Airocean ("Dymaxion") projection |

- `src/map-styles.js` — the style registry + persistence (`mapStyle` key, backward-compatible with the old `globe` 3d/2d key and the older `map-world`/`map-taiwan` ids) + the **colored-countries** toggle persistence (`coloredCountries` key).
- `src/renderer.js` — the dispatcher: picks 3D vs 2D from the chosen style; if a globe style is selected but WebGL is unavailable, it transparently falls back to the 2D map.
- `src/globe-renderer.js` — the 3D globe, styled by id (wireframe / texture / colored countries).
- `src/map2d.js` — the 2D canvas map, using `d3-geo` projections (`geoEquirectangular` for Map / Centered-on-Me, `geoAirocean` for Dymaxion) with pan, pinch/wheel zoom, and pin hit-testing via `projection.invert`. The Centered-on-Me style re-centers on the self pin whenever you check in.
- `src/country-colors.js` — the shared per-country color palette used by both the 2D maps and the 3D globe, so a country looks the same in every projection.
- `src/scanner.js` — the camera QR scanner (`getUserMedia` + `jsqr`, fully on-device) that powers Add Contact's **Scan QR code** button.
- `src/updates.js` — the manual update check (Settings → **Check for updates**): fetches the latest GitHub Release tag only when tapped and compares versions.

**Colored countries toggle** — a live button on the Check-In Beacon tile (`Colored countries` On/Off) fills each country with its own hue. It applies to **every** view: all three 2D maps and all three 3D globe styles (including the wireframe globe). The toggle is persisted (`coloredCountries`), applied at boot via `createRenderer({ colored })`, and toggles in place via the renderer's `setColored()` — no reload needed.

**QR code sharing** — the `QR` button next to your public key renders it as a scannable QR code (locally via the bundled `qrcode` lib — no network), with the key text underneath for manual copy. A friend scans it with their camera (or any QR reader) to get your Base64 public key — or just taps the key text to copy it.

**QR code scanning** — **Add Contact** has a **Scan QR code** button that opens the camera (back-facing), decodes the friend's QR on-device with the bundled `jsqr` lib (zero telemetry), and fills the public-key field automatically. Requires the **Camera** permission (declared in the manifest; Android prompts on first use).**Rename contacts** — long-press a contact in the list to rename them. Local-only (never sent to the peer); their check-ins never overwrite your nickname.

**Name yourself** — **Settings → Your name** is sent with every check-in, so contacts see who you are. They can still rename you locally; your name appears under whatever nickname they chose.

**Safety-number fingerprint verification** — every contact shows a short **4-word fingerprint** (`src/fingerprint.js`): in the contacts list, on the pin overlay, and **live in the Add Contact modal** as you type/scan a key. It's derived purely from the contact's public key, so you can compare it with your friend over a second, independent channel *before* sharing real location — this catches a key substituted during the out-of-band exchange.

**Location precision dial** — **Settings → Location precision** snaps your broadcast coordinates onto a **~5 / 10 / 25 / 50 km grid** (Off = exact position), applied to both scheduled and manual check-ins, so you can share only an approximate area.

**Log-key rotation (forward secrecy)** — your symmetric log key is rotated on every log rotation and re-shared with contacts over the handshake; a short windowed history is kept then dropped, so a device compromise exposes at most recent history.

**Encrypt local data** — **Settings → Encrypt local data** protects `identity.json`, `contacts.json`, and `settings.json` with a passphrase. On launch the app asks you to unlock. A forgotten passphrase means unrecoverable data.

**Reliability** — contact discovery runs in parallel at startup, the peer-status line shows **Connecting to contacts…** while discovery is in progress, and the app auto-reconnects with exponential backoff (capped at 30s) if the connection drops. The DHT can be pointed at known bootstrap nodes via the `ICHNAEA_BOOTSTRAP` env var.

**Check-in history & NEW badges** — tap a contact to open their **recent check-in history** (times + coordinates). Contacts that checked in since you last opened the app get a **NEW** badge, cleared when you view their history.

**Your name at your pin** — tapping your own pin shows your self-chosen name (**Settings → Your name**) instead of just "You".

**Offline check-in queue** — if a check-in fires while no contact is connected, a status line shows **"N check-ins queued (offline)"**; once a contact connects, the check-ins sync and it briefly shows **"Synced N offline check-ins"**.

**Quiet-contact notifications** — when a contact goes stale/offline, a **local-only** notification says "X went quiet — last check-in …" (no coordinates, nothing sent). Toggle it in **Settings → Notify when a contact goes quiet** (default on).

**Click to center** — tap a contact in the list or a pin on the map/globe to center the view on them.

**Update check** — **Settings → Check for updates** fetches the latest **GitHub Release** for this repo and reports if a newer build exists. When one is available it shows an **Update now** button that downloads the new APK **in the app** and hands it to the Android package installer (via the native `IchnaeaUpdater` plugin), so you can update without leaving Ichnaea. It is **manual and opt-in**: no network request happens on boot or in the background (preserves zero-telemetry). On the first in-app update Android 8+ will ask you to allow Ichnaea to "Install unknown apps" — enable it, then tap Update again.

**Connecting-lines toggle** — a "Connecting lines" On/Off button on the beacon tile shows/hides the dotted arcs from your pin to each contact. Works on every map style and the 3D globe; persisted.

**Broadcast frequency, your way** — the beacon header reads **Ichnaea Ver. X.Y.Z**, the tile shows your current frequency ("Broadcast: every 6 hours"), and **Settings → Broadcast frequency** is a free choice of **minutes / hours / days** rather than a fixed list. The main button is **Broadcast coordinates**.

All surfaces derive from the bundled Natural Earth data + Blue Marble texture — no CDN, no tile servers.

## Native addon fixes (important for rebuilds)

The NodeJS-Mobile runtime is Node 12; the modern holepunch stack (udx-native) needs a few fixes to load:

1. **`udx-native.node` must be patched to declare `libnode.so` (and the JNI shim lib) as dependencies**, so N-API symbols resolve past Android's linker namespaces:
   ```bash
   patchelf --add-needed libnode.so android/app/src/main/assets/nodejs-native-assets-arm64-v8a/udx-native/prebuilds/android-arm64/udx-native.node
   patchelf --add-needed libichnaea-nodejs-mobile.so android/app/src/main/assets/nodejs-native-assets-arm64-v8a/udx-native/prebuilds/android-arm64/udx-native.node
   ```
2. **`uv_timer_get_due_in`** (added in libuv 1.45, missing in Node 12's libuv 1.39) is provided by a shim in `android/app/src/main/cpp/native-lib.cpp`, exported from the JNI lib linked above.
3. `sodium-native` is shipped as a native addon (android-arm64 prebuild, patched like udx-native) and loaded at runtime — it must **not** be aliased to `sodium-javascript` (that pure-JS fallback is missing `crypto_scalarmult_ed25519_noclamp`, which breaks the DHT noise handshake).

## Sideload (how people install it)

The APK is a self-signed **debug** build — Android treats it as an "unknown app", so people just need to allow that. No Play Store, no signing certificate needed.

### 1. Get the APK

**Download the prebuilt APK** (recommended for testers):

- Direct: https://github.com/aquamammal/ichnaea-android/raw/main/dist/ichnaea-android-v0.2.15-debug.apk
- SHA-256: `93cb8e0b3d01561c76aa494ced39084e14447b856e04c2aa239878c58890e4b4`

> **Keep the dist APK in sync with `main` (mandatory).** The GitHub link above is the
> distribution artifact — it must always be the **current build**, not a stale one.
> After every code change that affects the app (renderer, node process, assets,
> version bump), **rebuild and re-publish it in the same commit**:
>
> ```bash
> npm run build:apk
> cp android/app/build/outputs/apk/debug/app-debug.apk dist/ichnaea-android-v0.2.15-debug.apk
> sha256sum dist/ichnaea-android-v0.2.15-debug.apk   # update the SHA-256 above
> ```
>
> A stale dist APK silently ships old behavior — e.g. the QR share feature was
> committed before the artifact was refreshed, so the GitHub link served a build
> without it. Commit the refreshed APK + new SHA with the feature change, then
> push. Do not land a feature without its updated artifact.
>
> **Also publish a GitHub Release per version** — the in-app **Check for updates**
> reads `releases/latest`, so a new version is only detected once it's tagged and
> the APK attached:
>
> ```bash
> gh release create v0.2.15 dist/ichnaea-android-v0.2.15-debug.apk --title "Ichnaea Android v0.2.15"
> ```
>
> Bump `package.json` + `versionName`/`versionCode` in the same change so the
> release tag, the APK, and the in-app version all agree.
>
> **Note:** the `android/` platform directory is gitignored (it's regenerated
> locally by Capacitor); the committed artifact is the `dist/` APK. The native
> layer lives only in the locally-generated `android/` and is **not** in git, so
> if you ever regenerate the platform (`npx cap add android`) you must re-apply
> all of the following by hand:
>
> - Re-add `<uses-permission android:name="android.permission.CAMERA" />` (QR scanning).
> - Re-add `<uses-permission android:name="android.permission.REQUEST_INSTALL_PACKAGES" />` (in-app update install).
> - Re-add `IchnaeaUpdaterPlugin.java` + `IchnaeaNotifyPlugin.java` classes. They are auto-discovered via `android/app/src/main/assets/capacitor.plugins.json`, which `cap sync` regenerates — so `scripts/plugins.mjs` re-appends them to that file automatically during `npm run build:apk` (no manual `registerPlugin` in `MainActivity`). `IchnaeaUpdater` relies on the existing `FileProvider` (`${applicationId}.fileprovider`) + `res/xml/file_paths.xml` `cache-path` (already in the generated manifest); `IchnaeaNotify` uses the `POST_NOTIFICATIONS` permission (already in the manifest).
> - Re-apply any other `android/` customizations from `scripts/native-assets.mjs` notes (e.g. `NodeService.java`, the `CAMERA`/`POST_NOTIFICATIONS` permissions, the JNI bridge).

Or build it yourself from this repo:

```bash
npm run build:apk
# → android/app/build/outputs/apk/debug/app-debug.apk  (~30 MB)
```

Build it once (this repo), then share the file:

```bash
npm run build:apk
# → android/app/build/outputs/apk/debug/app-debug.apk  (~30 MB)
```

Send it by USB, a cloud link (Drive/Dropbox), or a messenger app that allows files.

### 2. Allow "install unknown apps"

On their phone (varies by Android version):

- **Android 8+:** open the app they'll install from (Files / browser / messenger) → **Settings → Install unknown apps** → allow it.
- Or: **Settings → Apps → Special app access → Install unknown apps** → pick the source app → **Allow**.

### 3. Tap the APK and install

- Open the APK file → **Install**.
- **Play Protect may warn** "app not recognized by Google / unknown developer." Tap **Install anyway** / **More details → Install anyway**. (Expected — it's a self-signed dev APK.)

### 4. Requirements

- **Android 5.1+** (minSdk 22) — the Note 10 and anything newer is fine.
- **~100 MB free** on internal storage (app is 30 MB, but install + Hypercore log need room).
- **Internet** (Wi-Fi or cellular) — the P2P DHT needs it to find contacts.

### 5. Pair with someone

Two ways to exchange public keys:

- **QR scan (phone-to-phone):** one person taps **QR** next to their public key (top-left panel) to show it as a scannable code. The other person taps **Add Contact → Scan QR code**, points the camera at it, and the key fills in automatically.
- **Copy / paste (phone-to-phone or phone-to-desktop):** each person copies their **public key** (tap it in the top-left panel), swaps keys **out-of-band** (any trusted channel — messaging app, in person, etc.), then taps **Add Contact** and pastes the other's key.

**Both must add each other.** Same Wi-Fi connects fast; over the internet allow 10–30 s for DHT discovery.

### Notes for testers

- A **persistent notification** ("Running P2P check-in service") keeps the P2P stack alive — don't swipe it away.
- A **battery optimization** prompt appears on first launch — accept it so Doze doesn't freeze the P2P service.
- First run asks for **location permission** — needed for GPS check-ins (or use **Settings → Manual location**).
- **Camera permission** is asked the first time you use **Add Contact → Scan QR code** — only used for scanning a friend's QR on-device; the stream never leaves the phone.

## Verified: live E2E encrypted sync (phone <-> desktop)

`test/live-sync.mjs` spawns a Linux peer running the same P2P stack, adds it as a contact on the phone (via `adb forward tcp:14771 tcp:14770`), and verifies both directions over the live Hyperswarm DHT:

- Both peers connect (`peers 1` on each side).
- The phone's encrypted check-in is received **and decrypted** by the Linux peer (`contact:update ... lat=37.77`).
- The Linux peer's encrypted check-in is received **and decrypted** by the phone (`contact:update ... lat=48.85`; the phone's persisted `contacts.json` shows the peer's `coreKeyHex`, `logKeyHex`, and advancing `lastSeenTs`).

This confirms the full path: pair-topic discovery over the DHT → protomux handshake → X25519 sealed-box log-key exchange → encrypted Hypercore replication → secretbox decryption.

## License

Apache-2.0
