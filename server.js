import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { createServer as createHttpServer } from "node:http";
import { createServer as createHttpsServer } from "node:https";
import { extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { networkInterfaces } from "node:os";
import { spawnSync } from "node:child_process";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const publicDir = join(__dirname, "public");
const certDir = join(__dirname, ".cert");
const keyPath = join(certDir, "key.pem");
const certPath = join(certDir, "cert.pem");

const PORT = Number(process.env.PORT || 7443);
const HTTP_PORT = Number(process.env.HTTP_PORT || 7080);
const HOST = process.env.HOST || "0.0.0.0";
const IS_PRODUCTION = process.env.NODE_ENV === "production";
const ROOM_TTL_MS = 30 * 60 * 1000;
const rooms = new Map();
const iceServers = parseIceServers();

let appServer;

if (IS_PRODUCTION) {
  appServer = createHttpServer(handleRequest);
} else {
  ensureCertificate();
  appServer = createHttpsServer(
    {
      key: readFileSync(keyPath),
      cert: readFileSync(certPath)
    },
    handleRequest
  );
}

appServer.on("upgrade", handleUpgrade);
appServer.on("error", handleListenError);
appServer.listen(PORT, HOST, () => printStartup());

if (!IS_PRODUCTION) {
  createHttpServer((req, res) => {
    const host = (req.headers.host || "").replace(/:\d+$/, "");
    res.writeHead(302, { Location: `https://${host}:${PORT}${req.url || "/"}` });
    res.end();
  }).listen(HTTP_PORT, HOST);
}

setInterval(cleanupRooms, 60_000).unref();

function ensureCertificate() {
  if (existsSync(keyPath) && existsSync(certPath)) return;
  mkdirSync(certDir, { recursive: true });
  const result = spawnSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "365",
      "-subj",
      "/CN=BackMirror Local"
    ],
    { stdio: "pipe" }
  );

  if (result.status !== 0) {
    throw new Error(
      `Failed to create HTTPS certificate with openssl: ${result.stderr?.toString() || "unknown error"}`
    );
  }
}

async function handleRequest(req, res) {
  const url = new URL(req.url || "/", `https://${req.headers.host}`);

  if (url.pathname === "/api/room") {
    const roomId = createRoom();
    const mobileUrl = `${getPublicOrigin(req)}/room/${roomId}`;
    sendJson(res, { roomId, mobileUrl, expiresInSeconds: Math.round(ROOM_TTL_MS / 1000) });
    return;
  }

  if (url.pathname === "/api/config") {
    sendJson(res, { iceServers });
    return;
  }

  if (url.pathname === "/qr.svg") {
    const data = url.searchParams.get("data") || "";
    await sendQr(res, data);
    return;
  }

  if (url.pathname.startsWith("/room/")) {
    sendFile(res, join(publicDir, "mobile.html"));
    return;
  }

  const requested = url.pathname === "/" ? "/index.html" : url.pathname;
  const filePath = normalize(join(publicDir, requested));
  if (!filePath.startsWith(publicDir)) {
    res.writeHead(403);
    res.end("Forbidden");
    return;
  }
  sendFile(res, filePath);
}

function createRoom() {
  const roomId = randomBytes(4).toString("hex");
  rooms.set(roomId, { createdAt: Date.now(), clients: new Set() });
  return roomId;
}

function getPublicOrigin(req) {
  const hostHeader = req.headers.host || `localhost:${PORT}`;
  const forwardedProto = String(req.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  const protocol = forwardedProto || (IS_PRODUCTION ? "https" : "https");
  const hostname = hostHeader.split(":")[0];
  const ip = hostname === "localhost" || hostname === "127.0.0.1" ? getLanIp() : hostname;
  const host = IS_PRODUCTION ? hostHeader : `${ip}:${PORT}`;
  return `${protocol}://${host}`;
}

function getLanIp() {
  for (const entries of Object.values(networkInterfaces())) {
    for (const entry of entries || []) {
      if (entry.family === "IPv4" && !entry.internal) return entry.address;
    }
  }
  return "localhost";
}

function sendJson(res, payload) {
  res.writeHead(200, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(JSON.stringify(payload));
}

async function sendQr(res, data) {
  if (!data) {
    res.writeHead(400);
    res.end("Missing data");
    return;
  }

  try {
    const { default: QRCode } = await import("qrcode");
    const svg = await QRCode.toString(data, {
      type: "svg",
      errorCorrectionLevel: "M",
      margin: 1,
      width: 256
    });
    res.writeHead(200, {
      "content-type": "image/svg+xml; charset=utf-8",
      "cache-control": "no-store"
    });
    res.end(svg);
    return;
  } catch {
    // Fall back to the optional local CLI so the app still runs before npm install.
  }

  const qr = spawnSync("qrencode", ["-t", "SVG", "-o", "-", data], { encoding: "utf8" });
  if (qr.status !== 0) {
    res.writeHead(503, { "content-type": "text/plain; charset=utf-8" });
    res.end("QR generator unavailable. Use the mobile URL shown on the desktop page.");
    return;
  }

  res.writeHead(200, {
    "content-type": "image/svg+xml; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(qr.stdout);
}

function sendFile(res, filePath) {
  try {
    const body = readFileSync(filePath);
    res.writeHead(200, {
      "content-type": contentType(filePath),
      "cache-control": "no-store"
    });
    res.end(body);
  } catch {
    res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    res.end("Not found");
  }
}

function contentType(filePath) {
  return (
    {
      ".html": "text/html; charset=utf-8",
      ".js": "text/javascript; charset=utf-8",
      ".css": "text/css; charset=utf-8",
      ".svg": "image/svg+xml; charset=utf-8",
      ".json": "application/json; charset=utf-8"
    }[extname(filePath)] || "application/octet-stream"
  );
}

function handleUpgrade(req, socket) {
  const url = new URL(req.url || "/", `https://${req.headers.host}`);
  if (url.pathname !== "/ws") {
    socket.destroy();
    return;
  }

  const roomId = url.searchParams.get("room") || "";
  const role = url.searchParams.get("role") || "unknown";
  const room = rooms.get(roomId);
  if (!room) {
    socket.destroy();
    return;
  }

  const key = req.headers["sec-websocket-key"];
  const accept = createHash("sha1")
    .update(`${key}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest("base64");

  socket.write(
    [
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${accept}`,
      "",
      ""
    ].join("\r\n")
  );

  const client = { socket, roomId, role, alive: true };
  room.clients.add(client);
  broadcast(room, client, { type: "peer-joined", role });

  socket.on("data", (buffer) => {
    for (const message of decodeFrames(buffer)) {
      if (message === "__close__") {
        socket.end();
        return;
      }
      if (message === "__ping__") {
        socket.write(encodeFrame("", 0xA));
        continue;
      }
      try {
        const payload = JSON.parse(message);
        broadcast(room, client, payload);
      } catch {
        sendWs(client, { type: "error", message: "Invalid JSON message" });
      }
    }
  });

  socket.on("close", () => removeClient(room, client));
  socket.on("error", () => removeClient(room, client));
}

function broadcast(room, sender, payload) {
  for (const client of room.clients) {
    if (client !== sender) sendWs(client, payload);
  }
}

function sendWs(client, payload) {
  if (!client.socket.destroyed) client.socket.write(encodeFrame(JSON.stringify(payload)));
}

function removeClient(room, client) {
  if (!room.clients.has(client)) return;
  room.clients.delete(client);
  broadcast(room, client, { type: "peer-left", role: client.role });
}

function decodeFrames(buffer) {
  const messages = [];
  let offset = 0;

  while (offset + 2 <= buffer.length) {
    const first = buffer[offset++];
    const second = buffer[offset++];
    const opcode = first & 0x0f;
    const masked = (second & 0x80) === 0x80;
    let length = second & 0x7f;

    if (length === 126) {
      if (offset + 2 > buffer.length) break;
      length = buffer.readUInt16BE(offset);
      offset += 2;
    } else if (length === 127) {
      if (offset + 8 > buffer.length) break;
      const high = buffer.readUInt32BE(offset);
      const low = buffer.readUInt32BE(offset + 4);
      length = high * 2 ** 32 + low;
      offset += 8;
    }

    let mask;
    if (masked) {
      if (offset + 4 > buffer.length) break;
      mask = buffer.subarray(offset, offset + 4);
      offset += 4;
    }

    if (offset + length > buffer.length) break;
    const payload = Buffer.from(buffer.subarray(offset, offset + length));
    offset += length;

    if (masked && mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }

    if (opcode === 0x8) messages.push("__close__");
    else if (opcode === 0x9) messages.push("__ping__");
    else if (opcode === 0x1) messages.push(payload.toString("utf8"));
  }

  return messages;
}

function encodeFrame(message, opcode = 0x1) {
  const payload = Buffer.from(message);
  const length = payload.length;
  let header;

  if (length < 126) {
    header = Buffer.from([0x80 | opcode, length]);
  } else if (length < 65536) {
    header = Buffer.alloc(4);
    header[0] = 0x80 | opcode;
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[0] = 0x80 | opcode;
    header[1] = 127;
    header.writeUInt32BE(0, 2);
    header.writeUInt32BE(length, 6);
  }

  return Buffer.concat([header, payload]);
}

function cleanupRooms() {
  const now = Date.now();
  for (const [roomId, room] of rooms) {
    if (room.clients.size === 0 && now - room.createdAt > ROOM_TTL_MS) rooms.delete(roomId);
  }
}

function parseIceServers() {
  if (process.env.ICE_SERVERS) {
    try {
      const parsed = JSON.parse(process.env.ICE_SERVERS);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      return process.env.ICE_SERVERS.split(",")
        .map((url) => url.trim())
        .filter(Boolean)
        .map((urls) => ({ urls }));
    }
  }

  if (process.env.STUN_SERVERS) {
    return process.env.STUN_SERVERS.split(",")
      .map((url) => url.trim())
      .filter(Boolean)
      .map((urls) => ({ urls }));
  }

  return IS_PRODUCTION ? [{ urls: "stun:stun.l.google.com:19302" }] : [];
}

function printStartup() {
  const lan = getLanIp();
  console.log("");
  console.log("BackMirror is running.");
  console.log(`Mode:    ${IS_PRODUCTION ? "production HTTP behind platform HTTPS" : "local HTTPS"}`);
  console.log(`Desktop: ${IS_PRODUCTION ? `http://localhost:${PORT}` : `https://localhost:${PORT}`}`);
  if (!IS_PRODUCTION) console.log(`LAN:     https://${lan}:${PORT}`);
  console.log(`Host:    ${HOST}`);
  console.log(`ICE:     ${iceServers.length ? iceServers.map((server) => server.urls).join(", ") : "none"}`);
  console.log("");
  if (!IS_PRODUCTION) {
    console.log("The browser will warn about the local self-signed HTTPS certificate.");
    console.log("Accept it on both desktop and phone to allow camera access.");
  }
}

function handleListenError(error) {
  console.error("");
  console.error(`BackMirror failed to listen on ${HOST}:${PORT}.`);
  console.error(error.message);
  console.error("");
  console.error("For local-only testing, try: HOST=127.0.0.1 node server.js");
  process.exit(1);
}
