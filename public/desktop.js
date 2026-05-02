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
  phoneSaveTimer: null,
  countdownTimer: null
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
  photoLoading: document.querySelector("#photoLoading"),
  photoPreview: document.querySelector("#photoPreview"),
  phoneSaveHint: document.querySelector("#phoneSaveHint"),
  download: document.querySelector("#downloadLink"),
  savePhone: document.querySelector("#savePhoneBtn"),
  cameraResolution: document.querySelector("#cameraResolution"),
  previewResolution: document.querySelector("#previewResolution"),
  countdown: document.querySelector("#desktopCountdown"),
  countdownNumber: document.querySelector("#desktopCountdownNumber")
};

els.copy.addEventListener("click", copyMobileUrl);
els.capture.addEventListener("click", requestPhoneCapture);
els.mirror.addEventListener("click", toggleMirror);
els.newRoom.addEventListener("click", startRoom);
els.savePhone.addEventListener("click", requestPhoneSave);

startRoom();

async function startRoom() {
  closeCurrent();
  document.body.classList.remove("phone-paired");
  setStatus("等待中", "waiting");
  els.capture.disabled = true;
  els.empty.hidden = false;
  els.cameraResolution.textContent = "等待中";
  els.previewResolution.textContent = "等待中";
  els.photoPanel.hidden = true;
  els.photoLoading.hidden = true;
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

  state.socket.addEventListener("open", () => setStatus("等待中", "waiting"));
  state.socket.addEventListener("close", () => setStatus("已断开", "error"));
  state.socket.addEventListener("error", () => setStatus("已断开", "error"));
  state.socket.addEventListener("message", async (event) => {
    const message = JSON.parse(event.data);

    if (message.type === "peer-joined" && message.role === "phone") {
      setStatus("配对中", "waiting");
      document.body.classList.add("phone-paired");
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
      setStatus("接收照片", "waiting");
      if (!state.incomingCapture || state.incomingCapture.id !== message.id) {
        state.incomingCapture = {
          id: message.id,
          chunks: [],
          fileName: message.fileName || makeCaptureName("jpg")
        };
      }
    }

    if (message.type === "capture-error") {
      setStatus("拍照失败", "error");
      els.capture.disabled = false;
    }

    if (message.type === "phone-save-ready") {
      confirmPhoneSaveReady();
    }

    if (message.type === "peer-left") {
      setStatus("已断开", "error");
      document.body.classList.remove("phone-paired");
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
    setStatus("已连接", "connected");
    updatePreviewResolution();
  });

  state.peer.addEventListener("connectionstatechange", () => {
    const status = state.peer.connectionState;
    if (status === "connected") setStatus("已连接", "connected");
    if (status === "connecting") setStatus("连接中", "waiting");
    if (status === "failed" || status === "disconnected" || status === "closed") {
      setStatus("已断开", "error");
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
    setStatus("摄像头未就绪", "error");
    return;
  }

  els.capture.disabled = true;
  els.photoPanel.hidden = false;
  els.photoLoading.hidden = true;
  els.photoPreview.hidden = true;
  els.phoneSaveHint.hidden = true;
  setStatus("倒计时", "waiting");
  const delaySeconds = 3;
  const id = crypto.randomUUID?.() || String(Date.now());
  runCountdown(delaySeconds);
  send({ type: "capture-request", id, delaySeconds });
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
  els.phoneSaveHint.textContent = "正在发送到手机...";
  els.savePhone.textContent = "发送中...";
  setStatus("发送中", "waiting");
  state.phoneSaveTimer = setTimeout(() => {
    els.phoneSaveHint.textContent =
      "手机暂未响应。请保持手机页面打开，然后再次点击“发送到手机”。";
    els.savePhone.textContent = "重试发送";
    setStatus("手机未响应", "error");
  }, 2500);
}

function showCapturedPhoto(dataUrl, fileName) {
  state.lastCaptureUrl = dataUrl;
  state.lastCaptureName = fileName || makeCaptureName("jpg");
  els.photoPreview.src = dataUrl;
  els.download.href = dataUrl;
  els.download.download = state.lastCaptureName;
  els.photoPanel.hidden = false;
  els.photoLoading.hidden = true;
  els.photoPreview.hidden = false;
  els.phoneSaveHint.hidden = true;
  els.phoneSaveHint.textContent =
    "照片已发送到手机。请在手机端点击“保存或分享”，保存图片或发送到其他 App。";
  els.savePhone.textContent = "发送到手机";
  els.capture.disabled = false;
  setStatus("照片已就绪", "connected");
}

function showPhotoLoading() {
  els.photoPanel.hidden = false;
  els.photoLoading.hidden = false;
  els.photoPreview.hidden = true;
  els.phoneSaveHint.hidden = true;
  els.savePhone.textContent = "发送到手机";
}

function confirmPhoneSaveReady() {
  clearTimeout(state.phoneSaveTimer);
  els.phoneSaveHint.hidden = false;
  els.phoneSaveHint.textContent =
    "照片已显示在手机上。请在手机端点击“保存或分享”，保存图片或发送到其他 App。";
  els.savePhone.textContent = "查看手机";
  setStatus("查看手机", "connected");
}

async function copyMobileUrl() {
  await navigator.clipboard.writeText(els.mobileUrl.value).catch(() => {});
  els.copy.textContent = "已复制";
  setTimeout(() => {
    els.copy.textContent = "复制";
  }, 1200);
}

function toggleMirror() {
  state.mirrored = !state.mirrored;
  els.video.classList.toggle("mirrored", state.mirrored);
  els.mirror.textContent = state.mirrored ? "镜像开启" : "镜像关闭";
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
  if (!settings.width || !settings.height) return "未知";
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

function runCountdown(seconds) {
  clearInterval(state.countdownTimer);
  let remaining = seconds;
  els.countdownNumber.textContent = String(remaining);
  els.countdown.hidden = false;

  state.countdownTimer = setInterval(() => {
    remaining -= 1;
    if (remaining <= 0) {
      clearInterval(state.countdownTimer);
      els.countdown.hidden = true;
      showPhotoLoading();
      setStatus("拍照中", "waiting");
      return;
    }
    els.countdownNumber.textContent = String(remaining);
  }, 1000);
}

function closeCurrent() {
  resetPeer();
  if (state.socket) state.socket.close();
}

function resetPeer() {
  clearInterval(state.countdownTimer);
  els.countdown.hidden = true;
  if (state.peer) state.peer.close();
  state.peer = null;
  state.remoteStream = null;
  state.captureChannel = null;
  state.incomingCapture = null;
  els.video.srcObject = null;
}
