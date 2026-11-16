// Device-local Gemini settings. API key never leaves localStorage except in request headers.

const KEY_STORAGE = "live-detection.geminiApiKey";
const MODEL_STORAGE = "live-detection.geminiModelId";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const TRANSCRIPT_PROMPT =
  "Transcribe this speech verbatim. Return only the transcript.";
export const DESCRIPTION_PROMPT =
  "Describe this scene as you see it, in 2–3 sentences. Mention what is there and what is happening.";

export function getGeminiApiKey() {
  try {
    return localStorage.getItem(KEY_STORAGE)?.trim() || "";
  } catch {
    return "";
  }
}

export function setGeminiApiKey(value) {
  const trimmed = String(value ?? "").trim();
  try {
    if (trimmed) {
      localStorage.setItem(KEY_STORAGE, trimmed);
    } else {
      localStorage.removeItem(KEY_STORAGE);
    }
  } catch {
    // Private mode / blocked storage — ignore.
  }
}

export function getGeminiModelId() {
  try {
    return localStorage.getItem(MODEL_STORAGE)?.trim() || DEFAULT_GEMINI_MODEL;
  } catch {
    return DEFAULT_GEMINI_MODEL;
  }
}

export function setGeminiModelId(value) {
  const trimmed = String(value ?? "").trim() || DEFAULT_GEMINI_MODEL;
  try {
    localStorage.setItem(MODEL_STORAGE, trimmed);
  } catch {
    // ignore
  }
}

export function hasGeminiApiKey() {
  return Boolean(getGeminiApiKey());
}
