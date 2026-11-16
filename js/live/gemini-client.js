// Gemini generateContent helpers. Callers pass the API key; this module never logs it.

import {
  DESCRIPTION_PROMPT,
  getGeminiApiKey,
  getGeminiModelId,
  TRANSCRIPT_PROMPT,
} from "./gemini-settings.js";

const REQUEST_TIMEOUT_MS = 60_000;
const GEMINI_AUDIO_MIMES = new Set([
  "audio/wav",
  "audio/mp3",
  "audio/mpeg",
  "audio/mp4",
  "audio/webm",
  "audio/aac",
  "audio/ogg",
  "audio/flac",
  "audio/m4a",
  "audio/opus",
  "audio/aiff",
  "audio/pcm",
  "audio/l16",
  "audio/mpga",
]);

let listedModelsPromise = null;

async function blobToBase64(blob) {
  const buffer = await blob.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  let binary = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(binary);
}

function extractText(payload) {
  const parts = payload?.candidates?.[0]?.content?.parts;
  if (!Array.isArray(parts)) {
    return "";
  }
  return parts
    .map((part) => (typeof part.text === "string" ? part.text : ""))
    .join("")
    .trim();
}

function normalizeAudioMime(mimeType) {
  return String(mimeType || "")
    .split(";")[0]
    .trim()
    .toLowerCase();
}

function encodeWav(audioBuffer) {
  const channels = audioBuffer.numberOfChannels;
  const sampleRate = audioBuffer.sampleRate;
  const length = audioBuffer.length;
  const bytesPerSample = 2;
  const blockAlign = channels * bytesPerSample;
  const dataSize = length * blockAlign;
  const buffer = new ArrayBuffer(44 + dataSize);
  const view = new DataView(buffer);
  const writeString = (offset, text) => {
    for (let i = 0; i < text.length; i += 1) {
      view.setUint8(offset + i, text.charCodeAt(i));
    }
  };
  writeString(0, "RIFF");
  view.setUint32(4, 36 + dataSize, true);
  writeString(8, "WAVE");
  writeString(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * blockAlign, true);
  view.setUint16(32, blockAlign, true);
  view.setUint16(34, 16, true);
  writeString(36, "data");
  view.setUint32(40, dataSize, true);

  const mixed = new Float32Array(length);
  for (let c = 0; c < channels; c += 1) {
    const data = audioBuffer.getChannelData(c);
    for (let i = 0; i < length; i += 1) {
      mixed[i] += data[i] / channels;
    }
  }
  let offset = 44;
  for (let i = 0; i < length; i += 1) {
    const sample = Math.max(-1, Math.min(1, mixed[i]));
    view.setInt16(
      offset,
      sample < 0 ? sample * 0x8000 : sample * 0x7fff,
      true,
    );
    offset += 2;
  }
  return new Blob([buffer], { type: "audio/wav" });
}

async function convertAudioToWav(blob) {
  const AudioCtx = window.AudioContext || window.webkitAudioContext;
  if (!AudioCtx) {
    throw new Error("Cannot convert audio: AudioContext unavailable");
  }
  const ctx = new AudioCtx();
  try {
    const arrayBuffer = await blob.arrayBuffer();
    const audioBuffer = await ctx.decodeAudioData(arrayBuffer.slice(0));
    return encodeWav(audioBuffer);
  } finally {
    await ctx.close().catch(() => {});
  }
}

async function prepareAudioForGemini(audioBlob, mimeType) {
  const rawMime = mimeType || audioBlob.type || "";
  let mime = normalizeAudioMime(rawMime) || "audio/webm";
  let blob = audioBlob;
  console.log(
    "[GEMINI] audio prepare input mime=",
    rawMime || "(empty)",
    "normalized=",
    mime,
    "size=",
    audioBlob.size,
  );
  if (!GEMINI_AUDIO_MIMES.has(mime)) {
    console.log("[GEMINI] unsupported audio mime; converting to audio/wav");
    blob = await convertAudioToWav(audioBlob);
    mime = "audio/wav";
  }
  console.log("[GEMINI] sending audio mime=", mime, "size=", blob.size);
  return { blob, mime };
}

function parseGeminiError(status, bodyText) {
  let message = bodyText?.trim() || "request failed";
  try {
    const json = JSON.parse(bodyText);
    message =
      json?.error?.message ||
      json?.message ||
      json?.error?.status ||
      message;
  } catch {
    // keep raw text
  }
  if (message.length > 240) {
    message = `${message.slice(0, 240)}…`;
  }
  return `${status} ${message}`;
}

async function listModelIds(apiKey) {
  const url =
    "https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000";
  const response = await fetch(url, {
    headers: { "x-goog-api-key": apiKey },
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(parseGeminiError(response.status, detail));
  }
  const payload = await response.json();
  return (payload.models ?? [])
    .map((model) => String(model.name || "").replace(/^models\//, ""))
    .filter(Boolean);
}

async function ensureValidModel(modelId, apiKey) {
  if (!listedModelsPromise) {
    listedModelsPromise = listModelIds(apiKey).catch((error) => {
      listedModelsPromise = null;
      throw error;
    });
  }
  const ids = await listedModelsPromise;
  if (ids.includes(modelId)) {
    return;
  }
  const flashIds = ids.filter((id) => /flash/i.test(id));
  const hint = flashIds.length
    ? flashIds.join(", ")
    : ids.slice(0, 12).join(", ") || "(none returned)";
  throw new Error(`Model not found: ${modelId}. Valid Flash ids: ${hint}`);
}

export function clearGeminiModelCache() {
  listedModelsPromise = null;
}

async function generateContent({ modelId, parts, apiKey }) {
  const model = modelId || getGeminiModelId();
  const key = apiKey || getGeminiApiKey();
  if (!key) {
    throw new Error("missing_api_key");
  }
  await ensureValidModel(model, key);

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  console.log("[GEMINI] request model=", model, "parts=", parts.length);
  try {
    const response = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ role: "user", parts }],
      }),
      signal: controller.signal,
    });
    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      const message = parseGeminiError(response.status, detail);
      console.error("[GEMINI]", message);
      throw new Error(message);
    }
    const payload = await response.json();
    const text = extractText(payload);
    if (!text) {
      const message = "empty_response";
      console.error("[GEMINI]", message, payload);
      throw new Error(message);
    }
    return text;
  } catch (error) {
    if (error?.name === "AbortError") {
      const message = `timeout after ${REQUEST_TIMEOUT_MS / 1000}s`;
      console.error("[GEMINI]", message);
      throw new Error(message);
    }
    if (error?.message) {
      console.error("[GEMINI]", error.message);
    }
    throw error;
  } finally {
    window.clearTimeout(timer);
  }
}

export async function transcribeAudioBlob(audioBlob, mimeType) {
  if (!audioBlob) {
    return null;
  }
  const prepared = await prepareAudioForGemini(audioBlob, mimeType);
  const data = await blobToBase64(prepared.blob);
  return generateContent({
    parts: [
      { text: TRANSCRIPT_PROMPT },
      {
        inline_data: {
          mime_type: prepared.mime,
          data,
        },
      },
    ],
  });
}

// Max 6 frames, evenly spaced across the moment.
export function pickEvenFrames(frames, max = 6) {
  const list = (frames ?? []).filter((frame) => frame?.jpeg instanceof Blob);
  if (list.length <= max) {
    return list;
  }
  const picked = [];
  for (let i = 0; i < max; i += 1) {
    const index = Math.round((i * (list.length - 1)) / (max - 1));
    picked.push(list[index]);
  }
  return picked;
}

export async function describeFrames(frames) {
  const selected = pickEvenFrames(frames, 6);
  if (!selected.length) {
    return null;
  }
  console.log("[GEMINI] description frames=", selected.length);
  const imageParts = [];
  for (const frame of selected) {
    const data = await blobToBase64(frame.jpeg);
    imageParts.push({
      inline_data: {
        mime_type: "image/jpeg",
        data,
      },
    });
  }
  return generateContent({
    modelId: getGeminiModelId(),
    parts: [{ text: DESCRIPTION_PROMPT }, ...imageParts],
  });
}
