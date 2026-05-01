const roomId = location.pathname.split("/").filter(Boolean).pop();
const state = {
  socket: null,
  peer: null,
  stream: null,
  facingMode: "environment",
  torchOn: false
};

const els = {
  video: document.querySelector("#localVideo"),
  status: document.querySelector("#mobileStatus"),
  badge: document.querySelector("#mobileBadge"),
  torch: document.querySelector("#torchBtn"),
  flip: document.querySelector("#flipBtn"),
  error: document.querySelector("#mobileError")
};

els.torch.addEventListener("click", toggleTorch);
els.flip.addEventListener("click", flipCamera);
els.video.addEventListener("click", focusCamera);

start();

async function start() {
  try {
    await startCamera();
    openSocket();
  } catch (error) {
    showError(error.message || "Camera failed to start.");
  }
}

async function startCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  setStatus("Requesting camera permission...", "waiting");
  state.stream = await navigator.mediaDevices.getUserMedia({
    video: {
      facingMode: { ideal: state.facingMode },
      width: { ideal: 1920 },
      height: { ideal: 1080 }
    },
    audio: false
  });

  els.video.srcObject = state.stream;
  await els.video.play().catch(() => {});
  updateTorchSupport();
  setStatus("Camera ready", "waiting");
}

function openSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?room=${roomId}&role=phone`);
  state.socket.addEventListener("open", createOffer);
  state.socket.addEventListener("close", () => setStatus("Disconnected", "error"));
  state.socket.addEventListener("error", () => setStatus("Connection error", "error"));
  state.socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "peer-answer" && state.peer) {
      await state.peer.setRemoteDescription(message.answer);
      setStatus("Streaming to desktop", "connected");
    }

    if (message.type === "ice-candidate" && message.candidate && state.peer) {
      await state.peer.addIceCandidate(message.candidate).catch(() => {});
    }

    if (message.type === "peer-left") {
      setStatus("Desktop disconnected", "error");
    }
  });
}

async function createOffer() {
  state.peer?.close();
  state.peer = new RTCPeerConnection({ iceServers: [] });

  for (const track of state.stream.getTracks()) {
    state.peer.addTrack(track, state.stream);
  }

  state.peer.addEventListener("icecandidate", (event) => {
    if (event.candidate) send({ type: "ice-candidate", candidate: event.candidate });
  });

  state.peer.addEventListener("connectionstatechange", () => {
    const status = state.peer.connectionState;
    if (status === "connected") setStatus("Streaming to desktop", "connected");
    if (status === "connecting") setStatus("Connecting to desktop", "waiting");
    if (status === "failed" || status === "disconnected" || status === "closed") {
      setStatus("Disconnected", "error");
    }
  });

  const offer = await state.peer.createOffer();
  await state.peer.setLocalDescription(offer);
  send({ type: "peer-offer", offer });
  setStatus("Connecting to desktop", "waiting");
}

async function toggleTorch() {
  const track = state.stream?.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  if (!track || !capabilities?.torch) return;

  state.torchOn = !state.torchOn;
  await track.applyConstraints({ advanced: [{ torch: state.torchOn }] }).catch(() => {
    state.torchOn = false;
  });
  els.torch.textContent = state.torchOn ? "Torch On" : "Torch Off";
}

async function flipCamera() {
  state.facingMode = state.facingMode === "environment" ? "user" : "environment";
  els.flip.textContent = state.facingMode === "environment" ? "Use Front" : "Use Rear";
  await startCamera();
  if (state.socket?.readyState === WebSocket.OPEN) await createOffer();
}

async function focusCamera() {
  const track = state.stream?.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  if (!track || !capabilities?.focusMode?.includes?.("continuous")) return;
  await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
}

function updateTorchSupport() {
  const track = state.stream?.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  const supported = Boolean(capabilities?.torch);
  els.torch.disabled = !supported;
  els.torch.textContent = supported ? "Torch Off" : "No Torch";
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

function setStatus(label, kind) {
  els.status.textContent = label;
  els.badge.textContent = label.split(" ")[0];
  els.badge.className = `status-badge ${kind}`;
}

function showError(message) {
  setStatus("Camera error", "error");
  els.error.hidden = false;
  els.error.textContent = message;
}
