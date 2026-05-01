const roomId = location.pathname.split("/").filter(Boolean).pop();
const state = {
  socket: null,
  peer: null,
  stream: null,
  facingMode: "environment",
  torchOn: false,
  captureChannel: null,
  lastCapture: null,
  socketOpened: false
};

const els = {
  video: document.querySelector("#localVideo"),
  gate: document.querySelector("#cameraGate"),
  gateText: document.querySelector("#cameraGateText"),
  startCamera: document.querySelector("#startCameraBtn"),
  status: document.querySelector("#mobileStatus"),
  resolution: document.querySelector("#mobileResolution"),
  badge: document.querySelector("#mobileBadge"),
  torch: document.querySelector("#torchBtn"),
  flip: document.querySelector("#flipBtn"),
  error: document.querySelector("#mobileError"),
  photoPanel: document.querySelector("#mobilePhotoPanel"),
  photoPreview: document.querySelector("#mobilePhotoPreview"),
  saveMobile: document.querySelector("#saveMobileBtn"),
  closePhoto: document.querySelector("#closePhotoBtn"),
  canvas: document.querySelector("#mobileCaptureCanvas")
};

els.startCamera.addEventListener("click", start);
els.torch.addEventListener("click", toggleTorch);
els.flip.addEventListener("click", flipCamera);
els.video.addEventListener("click", focusCamera);
els.saveMobile.addEventListener("click", saveLastCapture);
els.closePhoto.addEventListener("click", () => {
  els.photoPanel.hidden = true;
});

start();

async function start() {
  els.error.hidden = true;
  els.startCamera.disabled = true;
  els.startCamera.textContent = "Starting...";
  try {
    await startCamera();
    if (!state.socketOpened) openSocket();
  } catch (error) {
    showError(error.message || "Camera failed to start.");
  } finally {
    els.startCamera.disabled = false;
    els.startCamera.textContent = "Retry Camera";
  }
}

async function startCamera() {
  if (state.stream) {
    state.stream.getTracks().forEach((track) => track.stop());
    state.stream = null;
  }

  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("This browser does not support camera access. Try Safari, Chrome, or Edge.");
  }

  setStatus("Requesting camera permission...", "waiting");
  setGate("Requesting camera permission...");
  state.stream = await getCameraStream();

  els.video.srcObject = state.stream;
  await playVideoWithTimeout();
  await waitForVideoFrame();
  await preferContinuousFocus();
  updateTorchSupport();
  updateResolution();
  setStatus("Camera ready", "waiting");
  els.gate.hidden = true;
  sendCameraSettings();
}

async function getCameraStream() {
  const attempts = [
    {
      label: "high resolution",
      constraints: {
        video: {
          facingMode: { ideal: state.facingMode },
          width: { ideal: 3840 },
          height: { ideal: 2160 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      }
    },
    {
      label: "1080p",
      constraints: {
        video: {
          facingMode: { ideal: state.facingMode },
          width: { ideal: 1920 },
          height: { ideal: 1080 },
          frameRate: { ideal: 30, max: 30 }
        },
        audio: false
      }
    },
    {
      label: "default rear camera",
      constraints: {
        video: { facingMode: { ideal: state.facingMode } },
        audio: false
      }
    },
    {
      label: "any camera",
      constraints: { video: true, audio: false }
    }
  ];

  let lastError;
  for (const attempt of attempts) {
    try {
      setGate(`Opening ${attempt.label}...`);
      return await withTimeout(
        navigator.mediaDevices.getUserMedia(attempt.constraints),
        8000,
        `Timed out opening ${attempt.label}.`
      );
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError || new Error("Camera failed to start.");
}

async function playVideoWithTimeout() {
  await withTimeout(els.video.play(), 5000, "Camera preview could not start.");
}

async function waitForVideoFrame() {
  if (els.video.videoWidth && els.video.videoHeight) return;
  await withTimeout(
    new Promise((resolve) => {
      els.video.addEventListener("loadedmetadata", resolve, { once: true });
      els.video.addEventListener("playing", resolve, { once: true });
    }),
    5000,
    "Camera opened but no video frame was received."
  );
}

function withTimeout(promise, ms, message) {
  let timeoutId;
  const timeout = new Promise((_, reject) => {
    timeoutId = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timeoutId));
}

function openSocket() {
  const protocol = location.protocol === "https:" ? "wss" : "ws";
  state.socket = new WebSocket(`${protocol}://${location.host}/ws?room=${roomId}&role=phone`);
  state.socket.addEventListener("open", () => {
    state.socketOpened = true;
    createOffer();
  });
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

    if (message.type === "capture-request") {
      await captureLocalPhoto(message.id);
    }

    if (message.type === "save-to-phone") {
      showPhoneSavePanel(message.id);
    }

    if (message.type === "peer-left") {
      setStatus("Desktop disconnected", "error");
    }
  });
}

async function createOffer() {
  state.peer?.close();
  state.peer = new RTCPeerConnection({ iceServers: [] });
  state.captureChannel = state.peer.createDataChannel("captures");
  state.captureChannel.addEventListener("message", async (event) => {
    await handleDataChannelMessage(event.data);
  });

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
  await raisePreviewBitrate();
  send({ type: "peer-offer", offer });
  sendCameraSettings();
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

async function preferContinuousFocus() {
  const track = state.stream?.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  if (!track || !capabilities?.focusMode?.includes?.("continuous")) return;
  await track.applyConstraints({ advanced: [{ focusMode: "continuous" }] }).catch(() => {});
}

async function captureLocalPhoto(id = String(Date.now())) {
  try {
    if (!els.video.videoWidth || !els.video.videoHeight) {
      throw new Error("Camera video is not ready yet.");
    }

    els.canvas.width = els.video.videoWidth;
    els.canvas.height = els.video.videoHeight;
    const context = els.canvas.getContext("2d");
    context.drawImage(els.video, 0, 0, els.canvas.width, els.canvas.height);

    const dataUrl = els.canvas.toDataURL("image/jpeg", 0.94);
    const fileName = makeCaptureName("jpg");
    state.lastCapture = { dataUrl, fileName };
    showMobilePreview(dataUrl, false);
    send({ type: "capture-ready", id, fileName, width: els.canvas.width, height: els.canvas.height });
    await sendCaptureOverDataChannel(id, dataUrl);
    setStatus("Photo captured", "connected");
  } catch (error) {
    send({ type: "capture-error", message: error.message || "Capture failed" });
    showError(error.message || "Capture failed.");
  }
}

async function sendCaptureOverDataChannel(id, dataUrl) {
  const channel = state.captureChannel;
  if (!channel || channel.readyState !== "open") {
    throw new Error("Photo channel is not ready.");
  }

  const chunkSize = 32 * 1024;
  const total = Math.ceil(dataUrl.length / chunkSize);
  channel.send(
    JSON.stringify({
      type: "capture-meta",
      id,
      total,
      fileName: state.lastCapture?.fileName || makeCaptureName("jpg")
    })
  );
  for (let index = 0; index < total; index += 1) {
    while (channel.bufferedAmount > 512 * 1024) {
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    channel.send(
      JSON.stringify({
        type: "capture-chunk",
        id,
        index,
        total,
        chunk: dataUrl.slice(index * chunkSize, (index + 1) * chunkSize)
      })
    );
  }
  channel.send(JSON.stringify({ type: "capture-complete", id, total }));
}

async function handleDataChannelMessage(data) {
  let message;
  try {
    message = JSON.parse(data);
  } catch {
    return;
  }

  if (message.type === "save-to-phone") {
    showPhoneSavePanel(message.id);
  }
}

function showPhoneSavePanel(requestId) {
  if (!state.lastCapture) {
    showError("No photo is ready on this phone yet.");
    return;
  }
  showMobilePreview(state.lastCapture.dataUrl, true);
  setStatus("Tap Save or Share", "connected");
  send({ type: "phone-save-ready", id: requestId });
  if (state.captureChannel?.readyState === "open") {
    state.captureChannel.send(JSON.stringify({ type: "phone-save-ready", id: requestId }));
  }
  navigator.vibrate?.(80);
}

async function saveLastCapture() {
  if (!state.lastCapture) return;
  const file = dataUrlToFile(state.lastCapture.dataUrl, state.lastCapture.fileName);

  if (navigator.canShare?.({ files: [file] })) {
    await navigator.share({
      files: [file],
      title: "BackMirror photo",
      text: "Photo captured locally with BackMirror."
    });
    return;
  }

  const link = document.createElement("a");
  link.href = state.lastCapture.dataUrl;
  link.download = state.lastCapture.fileName;
  document.body.append(link);
  link.click();
  link.remove();
}

function showMobilePreview(dataUrl, highlight = false) {
  els.photoPreview.src = dataUrl;
  els.photoPanel.hidden = false;
  els.photoPanel.classList.toggle("attention", highlight);
  if (highlight) {
    setTimeout(() => els.photoPanel.classList.remove("attention"), 1400);
  }
}

function dataUrlToFile(dataUrl, fileName) {
  const [header, base64] = dataUrl.split(",");
  const mime = header.match(/data:(.*?);base64/)?.[1] || "image/jpeg";
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return new File([bytes], fileName, { type: mime });
}

async function raisePreviewBitrate() {
  const sender = state.peer?.getSenders().find((item) => item.track?.kind === "video");
  if (!sender?.getParameters || !sender.setParameters) return;
  const params = sender.getParameters();
  params.encodings = params.encodings?.length ? params.encodings : [{}];
  params.encodings[0].maxBitrate = 8_000_000;
  params.encodings[0].maxFramerate = 30;
  await sender.setParameters(params).catch(() => {});
}

function updateTorchSupport() {
  const track = state.stream?.getVideoTracks()[0];
  const capabilities = track?.getCapabilities?.();
  const supported = Boolean(capabilities?.torch);
  els.torch.disabled = !supported;
  els.torch.textContent = supported ? "Torch Off" : "No Torch";
}

function updateResolution() {
  const settings = state.stream?.getVideoTracks()[0]?.getSettings?.() || {};
  els.resolution.textContent =
    settings.width && settings.height
      ? `${settings.width} x ${settings.height}${settings.frameRate ? ` @ ${Math.round(settings.frameRate)} fps` : ""}`
      : "Resolution unknown";
}

function sendCameraSettings() {
  const settings = state.stream?.getVideoTracks()[0]?.getSettings?.() || {};
  if (settings.width && settings.height) {
    send({
      type: "camera-settings",
      settings: {
        width: settings.width,
        height: settings.height,
        frameRate: settings.frameRate,
        facingMode: settings.facingMode
      }
    });
  }
}

function makeCaptureName(extension) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  return `backmirror-${timestamp}.${extension}`;
}

function send(payload) {
  if (state.socket?.readyState === WebSocket.OPEN) state.socket.send(JSON.stringify(payload));
}

function setStatus(label, kind) {
  els.status.textContent = label;
  els.badge.textContent = label.split(" ")[0];
  els.badge.className = `status-badge ${kind}`;
  setGate(label);
}

function showError(message) {
  setStatus("Camera error", "error");
  els.error.hidden = false;
  els.error.textContent = message;
  els.gate.hidden = false;
  setGate(message);
}

function setGate(message) {
  els.gateText.textContent = message;
}
