const state = {
  socket: null,
  roomId: null,
  peer: null,
  remoteStream: null,
  mirrored: true,
  captureChannel: null,
  incomingCapture: null,
  lastCaptureName: "",
  lastCaptureUrl: "",
  phoneSaveTimer: null
};

const els = {
  video: document.querySelector("#remoteVideo"),
  empty: document.querySelector("#emptyState"),
  badge: document.querySelector("#statusBadge"),
  qr: document.querySelector("#qrImage"),
  mobileUrl: document.querySelector("#mobileUrl"),
  copy: document.querySelector("#copyLink"),
  capture: document.querySelector("#captureBtn"),
  mirror: document.querySelector("#mirrorBtn"),
  newRoom: document.querySelector("#newRoomBtn"),
  photoPanel: document.querySelector("#photoPanel"),
  photoPreview: document.querySelector("#photoPreview"),
  phoneSaveHint: document.querySelector("#phoneSaveHint"),
  download: document.querySelector("#downloadLink"),
  savePhone: document.querySelector("#savePhoneBtn"),
  cameraResolution: document.querySelector("#cameraResolution"),
  previewResolution: document.querySelector("#previewResolution")
};

els.copy.addEventListener("click", copyMobileUrl);
els.capture.addEventListener("click", requestPhoneCapture);
els.mirror.addEventListener("click", toggleMirror);
els.newRoom.addEventListener("click", startRoom);
els.savePhone.addEventListener("click", requestPhoneSave);

startRoom();

async function startRoom() {
  closeCurrent();
  setStatus("Waiting", "waiting");
  els.capture.disabled = true;
  els.empty.hidden = false;
  els.cameraResolution.textContent = "Waiting";
  els.previewResolution.textContent = "Waiting";
  els.photoPanel.hidden = true;
  els.phoneSaveHint.hidden = true;

  const res = await fetch("/api/room", { cache: "no-store" });
  const room = await res.json();
  state.roomId = room.roomId;
  els.mobileUrl.value = room.mobileUrl;
  els.qr.src = `/qr.svg?data=${encodeURIComponent(room.mobileUrl)}`;

  openSocket(room.roomId);
}

function openSocket(roomId) {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?room=${roomId}&role=desktop`);

  state.socket.addEventListener("open", () => setStatus("Waiting", "waiting"));
  state.socket.addEventListener("close", () => setStatus("Disconnected", "error"));
  state.socket.addEventListener("error", () => setStatus("Disconnected", "error"));
  state.socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "peer-joined" && message.role === "phone") {
      setStatus("Pairing", "waiting");
      resetPeer();
      createPeer();
    }

    if (message.type === "peer-offer") {
      if (!state.peer) createPeer();
      await state.peer.setRemoteDescription(message.offer);
      const answer = await state.peer.createAnswer();
      await state.peer.setLocalDescription(answer);
      send({ type: "peer-answer", answer });
    }

    if (message.type === "ice-candidate" && message.candidate && state.peer) {
      await state.peer.addIceCandidate(message.candidate).catch(() => {});
    }

    if (message.type === "camera-settings") {
      els.cameraResolution.textContent = formatResolution(message.settings);
    }

    if (message.type === "capture-ready") {
      setStatus("Receiving Photo", "waiting");
      if (!state.incomingCapture || state.incomingCapture.id !== message.id) {
        state.incomingCapture = {
          id: message.id,
          chunks: [],
          fileName: message.fileName || makeCaptureName("jpg")
        };
      }
    }

    if (message.type === "capture-error") {
      setStatus("Capture Failed", "error");
      els.capture.disabled = false;
    }

    if (message.type === "phone-save-ready") {
      confirmPhoneSaveReady();
    }

    if (message.type === "peer-left") {
      setStatus("Disconnected", "error");
      els.capture.disabled = true;
    }
  });
}

function createPeer() {
  state.peer = new RTCPeerConnection({ iceServers: [] });

  state.peer.addEventListener("datachannel", (event) => {
    if (event.channel.label === "captures") setupCaptureChannel(event.channel);
  });

  state.peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) send({ type: "ice-candidate", candidate: event.candidate });
  });

  state.peer.addEventListener("track", (event) => {
    const [stream] = event.streams;
    state.remoteStream = stream;
    els.video.srcObject = stream;
    els.empty.hidden = true;
    els.capture.disabled = state.captureChannel?.readyState !== "open";
    setStatus("Connected", "connected");
    updatePreviewResolution();
  });

  state.peer.addEventListener("connectionstatechange", () => {
    const status = state.peer.connectionState;
    if (status === "connected") setStatus("Connected", "connected");
    if (status === "connecting") setStatus("Connecting", "waiting");
    if (status === "failed" || status === "disconnected" || status === "closed") {
      setStatus("Disconnected", "error");
      els.capture.disabled = true;
    }
  });
}

function setupCaptureChannel(channel) {
  state.captureChannel = channel;
  channel.addEventListener("open", () => {
    if (state.remoteStream) els.capture.disabled = false;
  });
  channel.addEventListener("message", (event) => handleCaptureData(event.data));
  channel.addEventListener("close", () => {
    if (state.captureChannel === channel) state.captureChannel = null;
    els.capture.disabled = true;
  });
}

function handleCaptureData(data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }

  if (message.type === "capture-meta") {
    state.incomingCapture = {
      id: message.id,
      chunks: [],
      fileName: message.fileName || makeCaptureName("jpg")
    };
    return;
  }

  if (message.type === "capture-chunk" && state.incomingCapture?.id === message.id) {
    state.incomingCapture.chunks[message.index] = message.chunk;
    return;
  }

  if (message.type === "capture-complete" && state.incomingCapture?.id === message.id) {
    const dataUrl = state.incomingCapture.chunks.join("");
    showCapturedPhoto(dataUrl, state.incomingCapture.fileName);
    state.incomingCapture = null;
    return;
  }

  if (message.type === "phone-save-ready") {
    confirmPhoneSaveReady();
  }
}

function requestPhoneCapture() {
  if (!state.captureChannel || state.captureChannel.readyState !== "open") {
    setStatus("Camera Not Ready", "error");
    return;
  }

  els.capture.disabled = true;
  els.photoPanel.hidden = true;
  els.phoneSaveHint.hidden = true;
  setStatus("Capturing", "waiting");
  send({ type: "capture-request", id: crypto.randomUUID?.() || String(Date.now()) });
}

function requestPhoneSave() {
  if (!state.lastCaptureUrl) return;
  const requestId = crypto.randomUUID?.() || String(Date.now());
  const payload = {
    type: "save-to-phone",
    id: requestId,
    fileName: state.lastCaptureName
  };

  send(payload);
  if (state.captureChannel?.readyState === "open") {
    state.captureChannel.send(JSON.stringify(payload));
  }

  clearTimeout(state.phoneSaveTimer);
  els.phoneSaveHint.hidden = false;
  els.phoneSaveHint.textContent = "Sending to phone...";
  els.savePhone.textContent = "Sending...";
  setStatus("Sending", "waiting");
  state.phoneSaveTimer = setTimeout(() => {
    els.phoneSaveHint.textContent =
      "No phone response yet. Keep the phone page open, then tap Show on Phone again.";
    els.savePhone.textContent = "Retry Phone";
    setStatus("Phone Not Ready", "error");
  }, 2500);
}

function showCapturedPhoto(dataUrl, fileName) {
  state.lastCaptureUrl = dataUrl;
  state.lastCaptureName = fileName || makeCaptureName("jpg");
  els.photoPreview.src = dataUrl;
  els.download.href = dataUrl;
  els.download.download = state.lastCaptureName;
  els.photoPanel.hidden = false;
  els.phoneSaveHint.hidden = true;
  els.phoneSaveHint.textContent =
    "Photo sent. On your phone, tap Save or Share to save it or send it to another app.";
  els.savePhone.textContent = "Show on Phone";
  els.capture.disabled = false;
  setStatus("Photo Ready", "connected");
}

function confirmPhoneSaveReady() {
  clearTimeout(state.phoneSaveTimer);
  els.phoneSaveHint.hidden = false;
  els.phoneSaveHint.textContent =
    "Photo is ready on your phone. Tap Save or Share there to save it or send it to another app.";
  els.savePhone.textContent = "Check Phone";
  setStatus("Check Phone", "connected");
}

async function copyMobileUrl() {
  await navigator.clipboard.writeText(els.mobileUrl.value).catch(() => {});
  els.copy.textContent = "Copied";
  setTimeout(() => {
    els.copy.textContent = "Copy";
  }, 1200);
}

function toggleMirror() {
  state.mirrored = !state.mirrored;
  els.video.classList.toggle("mirrored", state.mirrored);
  els.mirror.textContent = state.mirrored ? "Mirror On" : "Mirror Off";
}

function updatePreviewResolution() {
  const update = () => {
    if (els.video.videoWidth && els.video.videoHeight) {
      els.previewResolution.textContent = `${els.video.videoWidth} x ${els.video.videoHeight}`;
    }
  };
  update();
  els.video.addEventListener("loadedmetadata", update, { once: true });
  els.video.addEventListener("resize", update);
}

function formatResolution(settings = {}) {
  if (!settings.width || !settings.height) return "Unknown";
  const fps = settings.frameRate ? ` @ ${Math.round(settings.frameRate)} fps` : "";
  return `${settings.width} x ${settings.height}${fps}`;
}

function makeCaptureName(extension) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `backmirror-${timestamp}.${extension}`;
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

function setStatus(label, kind) {
  els.badge.textContent = label;
  els.badge.className = `status-badge ${kind}`;
}

function closeCurrent() {
  resetPeer();
  if (state.socket) state.socket.close();
}

function resetPeer() {
  if (state.peer) state.peer.close();
  state.peer = null;
  state.remoteStream = null;
  state.captureChannel = null;
  state.incomingCapture = null;
  els.video.srcObject = null;
}
