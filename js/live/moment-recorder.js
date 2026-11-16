// Mic + JPEG frame capture for one Start→Stop Recording "moment". In-memory only.

const FRAME_INTERVAL_MS = 5000;
const FRAME_MAX_EDGE = 768;
const FRAME_QUALITY = 0.7;

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

function captureJpegFromVideo(video) {
  const videoW = video.videoWidth;
  const videoH = video.videoHeight;
  if (!videoW || !videoH) {
    return null;
  }
  const longest = Math.max(videoW, videoH);
  const scale = longest > FRAME_MAX_EDGE ? FRAME_MAX_EDGE / longest : 1;
  const width = Math.max(1, Math.round(videoW * scale));
  const height = Math.max(1, Math.round(videoH * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) {
    return null;
  }
  ctx.drawImage(video, 0, 0, width, height);
  return canvas.toDataURL("image/jpeg", FRAME_QUALITY);
}

export function createMomentRecorder({
  getVideo,
  getGpsFix,
  getHeading,
  onFrame,
  onLevel,
}) {
  let micStream = null;
  let mediaRecorder = null;
  let audioChunks = [];
  let audioMime = "";
  let audioContext = null;
  let analyser = null;
  let levelRaf = null;
  let frameTimer = null;
  let active = false;
  let stopPromise = null;

  function readLevel() {
    if (!analyser || !active) {
      onLevel?.(0);
      return;
    }
    const data = new Uint8Array(analyser.fftSize);
    analyser.getByteTimeDomainData(data);
    let sum = 0;
    for (const sample of data) {
      const v = (sample - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / data.length);
    onLevel?.(Math.min(1, rms * 4));
    levelRaf = requestAnimationFrame(readLevel);
  }

  function stopLevelMeter() {
    if (levelRaf != null) {
      cancelAnimationFrame(levelRaf);
      levelRaf = null;
    }
    onLevel?.(0);
  }

  function captureFrame() {
    const video = getVideo?.();
    if (!video) {
      return;
    }
    const jpeg = captureJpegFromVideo(video);
    if (!jpeg) {
      return;
    }
    const fix = getGpsFix?.() ?? null;
    onFrame?.({
      timestamp: Date.now(),
      lat: fix?.lat ?? null,
      lon: fix?.lon ?? null,
      heading: getHeading?.() ?? null,
      jpeg,
    });
  }

  function stopMicTracks() {
    for (const track of micStream?.getTracks?.() ?? []) {
      track.stop();
    }
    micStream = null;
  }

  function closeAudioContext() {
    stopLevelMeter();
    analyser = null;
    if (audioContext) {
      audioContext.close().catch(() => {});
      audioContext = null;
    }
  }

  async function startMic() {
    if (!navigator.mediaDevices?.getUserMedia) {
      return { ok: false, reason: "unsupported" };
    }
    try {
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: false,
      });
    } catch {
      return { ok: false, reason: "denied" };
    }

    audioMime = pickAudioMime();
    audioChunks = [];
    try {
      mediaRecorder = audioMime
        ? new MediaRecorder(micStream, { mimeType: audioMime })
        : new MediaRecorder(micStream);
      audioMime = mediaRecorder.mimeType || audioMime || "audio/webm";
    } catch {
      stopMicTracks();
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
      const source = audioContext.createMediaStreamSource(micStream);
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

  async function start() {
    if (active) {
      return { mic: { ok: true } };
    }
    active = true;
    const mic = await startMic();
    if (!mic.ok) {
      stopMicTracks();
      closeAudioContext();
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
      active = false;
      if (frameTimer != null) {
        clearInterval(frameTimer);
        frameTimer = null;
      }
      captureFrame();
      const audio_blob = await stopMediaRecorder();
      stopMicTracks();
      closeAudioContext();
      const result = {
        audio_blob,
        audio_mime: audio_blob ? audioMime || null : null,
      };
      stopPromise = null;
      return result;
    })();
    return stopPromise;
  }

  async function cancel() {
    if (!active && !mediaRecorder) {
      return;
    }
    active = false;
    if (frameTimer != null) {
      clearInterval(frameTimer);
      frameTimer = null;
    }
    await stopMediaRecorder();
    stopMicTracks();
    closeAudioContext();
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
