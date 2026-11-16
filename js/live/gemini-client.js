// Gemini generateContent helpers. Callers pass the API key; this module never logs it.

import {
  DESCRIPTION_PROMPT,
  getGeminiApiKey,
  getGeminiModelId,
  TRANSCRIPT_PROMPT,
} from "./gemini-settings.js";

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

async function generateContent({ modelId, parts, apiKey }) {
  const model = modelId || getGeminiModelId();
  const key = apiKey || getGeminiApiKey();
  if (!key) {
    throw new Error("missing_api_key");
  }
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": key,
    },
    body: JSON.stringify({
      contents: [{ role: "user", parts }],
    }),
  });
  if (!response.ok) {
    const detail = await response.text().catch(() => "");
    throw new Error(`gemini_http_${response.status}${detail ? `: ${detail.slice(0, 120)}` : ""}`);
  }
  const payload = await response.json();
  const text = extractText(payload);
  if (!text) {
    throw new Error("empty_response");
  }
  return text;
}

export async function transcribeAudioBlob(audioBlob, mimeType) {
  if (!audioBlob) {
    return null;
  }
  const data = await blobToBase64(audioBlob);
  return generateContent({
    parts: [
      { text: TRANSCRIPT_PROMPT },
      {
        inline_data: {
          mime_type: mimeType || audioBlob.type || "audio/webm",
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
