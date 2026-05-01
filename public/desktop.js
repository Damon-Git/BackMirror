const state = {
  socket: null,
  roomId: null,
  peer: null,
  remoteStream: null,
  mirrored: true
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
  canvas: document.querySelector("#captureCanvas"),
  photoPanel: document.querySelector("#photoPanel"),
  photoPreview: document.querySelector("#photoPreview"),
  download: document.querySelector("#downloadLink")
};

els.copy.addEventListener("click", copyMobileUrl);
els.capture.addEventListener("click", captureFrame);
els.mirror.addEventListener("click", toggleMirror);
els.newRoom.addEventListener("click", startRoom);

startRoom();

async function startRoom() {
  closeCurrent();
  setStatus("Waiting", "waiting");
  els.capture.disabled = true;
  els.empty.hidden = false;

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

    if (message.type === "peer-left") {
      setStatus("Disconnected", "error");
      els.capture.disabled = true;
    }
  });
}

function createPeer() {
  state.peer = new RTCPeerConnection({ iceServers: [] });

  state.peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) send({ type: "ice-candidate", candidate: event.candidate });
  });

  state.peer.addEventListener("track", (event) => {
    const [stream] = event.streams;
    state.remoteStream = stream;
    els.video.srcObject = stream;
    els.empty.hidden = true;
    els.capture.disabled = false;
    setStatus("Connected", "connected");
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

function captureFrame() {
  if (!els.video.videoWidth || !els.video.videoHeight) return;

  els.canvas.width = els.video.videoWidth;
  els.canvas.height = els.video.videoHeight;
  const context = els.canvas.getContext("2d");

  if (state.mirrored) {
    context.translate(els.canvas.width, 0);
    context.scale(-1, 1);
  }

  context.drawImage(els.video, 0, 0, els.canvas.width, els.canvas.height);
  const url = els.canvas.toDataURL("image/png");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  els.photoPreview.src = url;
  els.download.href = url;
  els.download.download = `backmirror-${timestamp}.png`;
  els.photoPanel.hidden = false;
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
  els.video.srcObject = null;
}
