# BackMirror

BackMirror is a local-first web app that turns a phone into a private camera and a computer into a large live preview screen. It is designed for solo use cases like checking hard-to-see skin areas, hair, or narrow spaces.

BackMirror helps capture images locally. It does not diagnose, treat, or replace medical advice.

## Features

- Same-LAN pairing with a QR code.
- Phone rear camera streams to the desktop via WebRTC.
- Desktop live preview with mirror toggle.
- One-click still image capture and local download.
- No cloud upload and no server-side image storage.
- HTTPS local server for mobile camera access.

## Requirements

- Node.js 20 or newer.
- `openssl` available on PATH for generating a local HTTPS certificate.
- Optional: `qrencode` available on PATH for QR code SVG generation. If it is missing, use the mobile URL shown on the desktop page.

This MVP has no npm dependencies, so it can run even when `npm`, `pnpm`, or `yarn` are unavailable.

## Run

```bash
node server.js
```

Then open:

```text
https://localhost:7443
```

For local-only development on machines that block binding to all interfaces, run:

```bash
HOST=127.0.0.1 node server.js
```

The server also prints a LAN URL such as:

```text
https://192.168.1.23:7443
```

Use that LAN URL from the phone, or scan the QR code shown on the desktop page.

## HTTPS Certificate

On first run, BackMirror creates a self-signed certificate in `.cert/`. Desktop and mobile browsers will show a certificate warning. Accept the warning on both devices so the browser allows camera access.

For smoother repeated use, trust the generated certificate on your development machine or replace `.cert/cert.pem` and `.cert/key.pem` with your own local certificate.

## Privacy Notes

- The media stream is sent through WebRTC between the phone and desktop.
- The Node server only handles static files and signaling messages.
- Captured images are generated in the desktop browser and downloaded locally.
- The server does not write photos or video frames to disk.

## Current Limitations

- Both devices should be on the same local network.
- WebRTC is configured without STUN/TURN servers for local-first behavior; unusual network setups may block the peer connection.
- Torch and focus controls depend on mobile browser support.
- iOS and Android camera behavior should be verified on real devices before calling this production-ready.
