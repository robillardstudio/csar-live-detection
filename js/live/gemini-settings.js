// Device-local Gemini settings. API key never leaves localStorage except in request headers.

const KEY_STORAGE = "live-detection.geminiApiKey";
const MODEL_STORAGE = "live-detection.geminiModelId";
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";

export const TRANSCRIPT_PROMPT =
  "Transcribe this speech verbatim. Return only the transcript.";
export const DESCRIPTION_PROMPT =
  "Describe this scene as you see it, in 2–3 sentences. Mention what is there and what is happening.";

export const ANALYSIS_CATEGORIES = [
  "objects",
  "activity",
  "condition",
  "weather",
  "sound",
  "smell",
  "feeling",
  "memory",
];

export const ANALYSIS_STATUSES = [
  "shared",
  "partly",
  "overlooked",
  "beyond",
];

export const ANALYSIS_METHOD = "AI-assisted coding";

export const ANALYSIS_PROMPT = `You compare two accounts of the same moment.
The transcript is what the person said (recorded blind). The AI description is from camera frames only — do not invent content from either.

Return JSON only with this shape:
{
  "observations": [
    { "text": "short phrase from the transcript", "category": "objects|activity|condition|weather|sound|smell|feeling|memory", "status": "shared|partly|overlooked|beyond" }
  ],
  "ai_only": [
    { "text": "short phrase from the AI description", "category": "objects|activity|condition|weather|sound|smell|feeling|memory" }
  ]
}

Rules:
- Split the transcript into short atomic observations. Keep the person's wording; do not paraphrase.
- category must be one of: objects, activity, condition, weather, sound, smell, feeling, memory.
- status vs the AI description:
  - shared: clearly mentioned in the AI description
  - partly: only partly / weakly reflected
  - overlooked: could reasonably be seen in the frames but the AI description did not mention it
  - beyond: not visual (sound, smell, feeling, memory, and most weather)
- ai_only: observations present in the AI description that the person did not mention.
- If one side is empty, return empty arrays as appropriate.`;

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

export const BOXES_PROMPT =
  "Detect the distinct objects and features in this image, including things like trees, buildings, paths, signs and people. Return JSON only: [{\"label\": short name, \"box_2d\": [ymin, xmin, ymax, xmax] scaled 0–1000}]. At most 15 items.";
