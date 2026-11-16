// Mic + JPEG frame capture for one Start→Stop Recording "moment". In-memory only.
// Audio comes from the existing camera stream (no second getUserMedia).

const FRAME_INTERVAL_MS = 5000;
const FRAME_MAX_EDGE = 768;
const FRAME_QUALITY = 0.7;
const LEVEL_INTERVAL_MS = 100;

function pickAudioMime() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4",
  ];
  for (const mime of candidates) {
    if (
      typeof MediaRecorder !== "undefined" &&
      MediaRecorder.isTypeSupported?.(mime)
    ) {
      return mime;
    }
  }
  return "";
}

export function createMomentRecorder({
  getVideo,
  getCameraStream,
  getGpsFix,
  getHeading,
  onFrame,
  onLevel,
}) {
  const frameCanvas = document.createElement("canvas");
  const frameCtx = frameCanvas.getContext("2d", { willReadFrequently: true });

  let mediaRecorder = null;
  let audioChunks = [];
  let audioMime = "";
  let audioContext = null;
  let analyser = null;
  let levelRaf = null;
  let lastLevelAt = 0;
  let frameTimer = null;
  let active = false;
  let stopPromise = null;
  let capturingFrame = false;

  function setAudioTracksEnabled(enabled) {
    const stream = getCameraStream?.();
    for (const track of stream?.getAudioTracks?.() ?? []) {
      track.enabled = enabled;
    }
  }

  function readLevel() {
    if (!analyser || !active) {
      onLevel?.(0);
      return;
    }
    levelRaf = requestAnimationFrame(readLevel);
    const now = performance.now();
    if (now - lastLevelAt < LEVEL_INTERVAL_MS) {
      return;
    }
    lastLevelAt = now;
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const v = (sample - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    onLevel?.(Math.min(1, rms * 4));
  }

  function stopLevelMeter() {
    if (levelRaf != null) {
      cancelAnimationFrame(levelRaf);
      levelRaf = null;
    }
    lastLevelAt = 0;
    onLevel?.(0);
  }

  function captureFrame() {
    if (capturingFrame || !frameCtx) {
      return Promise.resolve();
    }
    const video = getVideo?.();
    if (!video?.videoWidth || !video.videoHeight) {
      return Promise.resolve();
    }
    const videoW = video.videoWidth;
    const videoH = video.videoHeight;
    const longest = Math.max(videoW, videoH);
    const scale = longest > FRAME_MAX_EDGE ? FRAME_MAX_EDGE / longest : 1;
    const width = Math.max(1, Math.round(videoW * scale));
    const height = Math.max(1, Math.round(videoH * scale));
    if (frameCanvas.width !== width || frameCanvas.height !== height) {
      frameCanvas.width = width;
      frameCanvas.height = height;
    }
    frameCtx.drawImage(video, 0, 0, width, height);
    capturingFrame = true;
    return new Promise((resolve) => {
      frameCanvas.toBlob(
        (blob) => {
          capturingFrame = false;
          if (blob) {
            const fix = getGpsFix?.() ?? null;
            onFrame?.({
              timestamp: Date.now(),
              lat: fix?.lat ?? null,
              lon: fix?.lon ?? null,
              heading: getHeading?.() ?? null,
              jpeg: blob,
            });
          }
          resolve();
        },
        "image/jpeg",
        FRAME_QUALITY,
      );
    });
  }

  function closeAudioContext() {
    stopLevelMeter();
    analyser = null;
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  }

  function startAudioFromCamera() {
    const cameraStream = getCameraStream?.();
    const audioTracks = cameraStream?.getAudioTracks?.() ?? [];
    if (!audioTracks.length) {
      return { ok: false, reason: "denied" };
    }

    setAudioTracksEnabled(true);
    const audioStream = new MediaStream(audioTracks);
    audioMime = pickAudioMime();
    audioChunks = [];
    try {
      mediaRecorder = audioMime
        ? new MediaRecorder(audioStream, { mimeType: audioMime })
        : new MediaRecorder(audioStream);
      audioMime = mediaRecorder.mimeType || audioMime || "audio/webm";
    } catch {
      setAudioTracksEnabled(false);
      return { ok: false, reason: "unsupported" };
    }

    mediaRecorder.addEventListener("dataavailable", (event) => {
      if (event.data?.size > 0) {
        audioChunks.push(event.data);
      }
    });
    mediaRecorder.start(1000);

    try {
      audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(audioStream);
      analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      source.connect(analyser);
      readLevel();
    } catch {
      // Level meter is optional; recording can continue without it.
    }

    return { ok: true };
  }

  function stopMediaRecorder() {
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
      mediaRecorder = null;
      return Promise.resolve(null);
    }
    return new Promise((resolve) => {
      mediaRecorder.addEventListener(
        "stop",
        () => {
          const blob =
            audioChunks.length > 0
              ? new Blob(audioChunks, { type: audioMime || "audio/webm" })
              : null;
          mediaRecorder = null;
          audioChunks = [];
          resolve(blob);
        },
        { once: true },
      );
      mediaRecorder.stop();
    });
  }

  async function finishAudio() {
    const audio_blob = await stopMediaRecorder();
    closeAudioContext();
    setAudioTracksEnabled(false);
    return {
      audio_blob,
      audio_mime: audio_blob ? audioMime || null : null,
    };
  }

  async function start() {
    if (active) {
      return { mic: { ok: true } };
    }
    active = true;
    const mic = startAudioFromCamera();
    if (!mic.ok) {
      closeAudioContext();
      setAudioTracksEnabled(false);
    }
    captureFrame();
    frameTimer = window.setInterval(captureFrame, FRAME_INTERVAL_MS);
    return { mic };
  }

  async function stop() {
    if (!active) {
      return { audio_blob: null, audio_mime: null };
    }
    if (stopPromise) {
      return stopPromise;
    }
    stopPromise = (async () => {
      if (frameTimer != null) {
        clearInterval(frameTimer);
        frameTimer = null;
      }
      while (capturingFrame) {
        await new Promise((resolve) => requestAnimationFrame(resolve));
      }
      await captureFrame();
      active = false;
      const result = await finishAudio();
      stopPromise = null;
      return result;
    })();
    return stopPromise;
  }

  async function cancel() {
    if (!active && !mediaRecorder) {
      setAudioTracksEnabled(false);
      return;
    }
    active = false;
    if (frameTimer != null) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    await finishAudio();
    audioChunks = [];
    stopPromise = null;
  }

  return {
    start,
    stop,
    cancel,
    isActive: () => active,
  };
}
