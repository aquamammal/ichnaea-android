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
npx cap add android   # generates android/ once (already committed)
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
- `npm run build:renderer` — bundle the WebView renderer (`src/main.js` + globe.gl) → `src/main.bundle.js`.
- `npm run node:start` — run the Node bridge on desktop (test with a browser pointed at `ws://localhost:14770`).
- `npm test` — shared unit tests (crypto, staleness).

## Architecture

- `src/node/server.js` — NodeJS-Mobile entrypoint: WebSocket server on `localhost:14770`, boots the P2P app once, re-targets the pipe per renderer connection.
- `src/main/` — shared P2P stack (Hyperswarm, Hypercore, identity, contacts, settings, scheduler, E2E encryption). Same code as the desktop version, bundled for Node 12.
- `src/main.js`, `src/index.html`, `src/staleness.js`, `src/globe-renderer.js`, `src/map2d.js`, `src/assets/` — WebView UI, bundled with esbuild (browsers can't resolve bare imports like `globe.gl`).
- `android/app/src/main/cpp/` — JNI bridge: starts Node via the embedder API, redirects stdout/stderr to logcat.
- `android/app/src/main/jniLibs/arm64-v8a/` — `libnode.so`, `libc++_shared.so`, plus the compiled JNI lib.
- `android/app/src/main/assets/nodejs-project/` — the bundled Node stack.
- `android/app/src/main/assets/nodejs-native-assets-arm64-v8a/` — native addons for Node's `require()` (udx-native + deps).

## Native addon fixes (important for rebuilds)

The NodeJS-Mobile runtime is Node 12; the modern holepunch stack (udx-native) needs a few fixes to load:

1. **`udx-native.node` must be patched to declare `libnode.so` (and the JNI shim lib) as dependencies**, so N-API symbols resolve past Android's linker namespaces:
   ```bash
   patchelf --add-needed libnode.so android/app/src/main/assets/nodejs-native-assets-arm64-v8a/udx-native/prebuilds/android-arm64/udx-native.node
   patchelf --add-needed libichnaea-nodejs-mobile.so android/app/src/main/assets/nodejs-native-assets-arm64-v8a/udx-native/prebuilds/android-arm64/udx-native.node
   ```
2. **`uv_timer_get_due_in`** (added in libuv 1.45, missing in Node 12's libuv 1.39) is provided by a shim in `android/app/src/main/cpp/native-lib.cpp`, exported from the JNI lib linked above.
3. `sodium-native` is aliased to the pure-JS `sodium-javascript` at bundle time (`--alias:sodium-native=sodium-javascript` in `build:node`).

## Sideload

Build the debug APK, enable **Install unknown apps** on the device, and install. The app runs a **ForegroundService** (with a persistent notification) so the P2P stack keeps running and UDP/DHT sockets stay alive.

## License

Apache-2.0
