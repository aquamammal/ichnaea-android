# Ichnaea Android

Android port of [Ichnaea](https://github.com/aquamammal/ichnaea-v2) — a privacy-first, peer-to-peer location check-in app with end-to-end encryption.

Runs the full Hyperswarm/Hypercore P2P stack on Android via NodeJS-Mobile with a Capacitor WebView UI.

## Requirements

- Node.js LTS (18+)
- Android SDK (API 24+)
- Android Studio (recommended for building the APK)

## Setup

```bash
git clone https://github.com/aquamammal/ichnaea-android.git
cd ichnaea-android
npm install
npx cap add android
```

## Development

- `npm run node:start` — Start just the Node P2P stack (useful for testing the WebSocket bridge with a local browser).
- `npm run dev` — Sync the WebView and open in Android Studio.
- `npm test` — Run the shared unit tests.

## Architecture

- `src/node/server.js` — NodeJS-Mobile entrypoint. Starts a WebSocket server on localhost and boots the P2P orchestrator.
- `src/main/` — Shared P2P stack (Hyperswarm, Hypercore, identity, contacts, E2E encryption). Same code as the desktop version.
- `src/webview/` — Capacitor WebView. Same globe/UI as the desktop version, adapted to use WebSocket instead of pear-pipe.

## Sideload

Build an APK in Android Studio, enable "Install unknown apps" on the device, and install.

## License

Apache-2.0
