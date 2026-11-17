// Live-loop defaults (confidence / max objects) plus recording and Gemini preferences.
import { MODEL_OPTIONS, getModelId } from "../models.js";
import {
  DEFAULT_GEMINI_MODEL,
  getGeminiApiKey,
  getGeminiModelId,
  setGeminiApiKey,
  setGeminiModelId,
} from "../live/gemini-settings.js";
import {
  clearGeminiModelCache,
  listDescriptionModels,
} from "../live/gemini-client.js";

const DEFAULT_PARAMETERS = {
  confidence: 0.5,
  maxObjects: 10,
};

const liveSettings = {
  analysesPerSecond: 2,
  minConfidence: 0.2,
};

const recordingSettings = {
  // Blind mode is opt-in: AI labels stay visible while recording unless unchecked.
  showAiWhileRecording: true,
  descriptionSource: "gemini:online",
};

export function getSettings() {
  return {
    analysisSettings: {},
    parameters: {
      ...DEFAULT_PARAMETERS,
      confidence: liveSettings.minConfidence,
    },
    analysesPerSecond: liveSettings.analysesPerSecond,
    minConfidence: liveSettings.minConfidence,
    showAiWhileRecording: recordingSettings.showAiWhileRecording,
    descriptionSource: recordingSettings.descriptionSource,
  };
}

function showGeminiModelSelect(select, fallback) {
  select.hidden = false;
  fallback.hidden = true;
}

function showGeminiModelFallback(select, fallback) {
  select.hidden = true;
  fallback.hidden = false;
  fallback.value = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
}

async function refreshGeminiModelPicker(select, fallback) {
  const key = getGeminiApiKey();
  if (!key) {
    showGeminiModelFallback(select, fallback);
    return;
  }
  try {
    const models = await listDescriptionModels(key);
    if (!models.length) {
      throw new Error("no_models");
    }
    const saved = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
    select.replaceChildren();
    for (const model of models) {
      const option = document.createElement("option");
      option.value = model.id;
      option.textContent = model.label;
      select.appendChild(option);
    }
    if (models.some((model) => model.id === saved)) {
      select.value = saved;
    } else if (models.some((model) => model.id === DEFAULT_GEMINI_MODEL)) {
      select.value = DEFAULT_GEMINI_MODEL;
      setGeminiModelId(DEFAULT_GEMINI_MODEL);
    } else {
      select.value = models[0].id;
      setGeminiModelId(models[0].id);
    }
    showGeminiModelSelect(select, fallback);
  } catch (error) {
    console.error("[GEMINI] model list failed:", error?.message || error);
    showGeminiModelFallback(select, fallback);
  }
}

export function initRecordingSettings() {
  const rateSelect = document.getElementById("setting-analyses-per-second");
  if (rateSelect) {
    rateSelect.value = String(liveSettings.analysesPerSecond);
    rateSelect.addEventListener("change", () => {
      const value = Number(rateSelect.value);
      liveSettings.analysesPerSecond = [1, 2, 5, 10].includes(value) ? value : 2;
      rateSelect.value = String(liveSettings.analysesPerSecond);
    });
  }

  const confidenceInput = document.getElementById("setting-min-confidence");
  const confidenceValue = document.getElementById("setting-min-confidence-value");
  if (confidenceInput) {
    confidenceInput.value = String(liveSettings.minConfidence);
    if (confidenceValue) {
      confidenceValue.textContent = liveSettings.minConfidence.toFixed(2);
    }
    confidenceInput.addEventListener("input", () => {
      const value = Math.min(0.9, Math.max(0.05, Number(confidenceInput.value) || 0.2));
      liveSettings.minConfidence = value;
      if (confidenceValue) {
        confidenceValue.textContent = value.toFixed(2);
      }
    });
  }

  const checkbox = document.getElementById("setting-show-ai-while-recording");
  if (checkbox) {
    checkbox.checked = recordingSettings.showAiWhileRecording;
    checkbox.addEventListener("change", () => {
      recordingSettings.showAiWhileRecording = checkbox.checked;
    });
  }

  const keyInput = document.getElementById("setting-gemini-api-key");
  const modelSelect = document.getElementById("setting-gemini-model");
  const modelFallback = document.getElementById("setting-gemini-model-fallback");

  if (modelSelect && modelFallback) {
    modelFallback.value = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
    modelSelect.addEventListener("change", () => {
      setGeminiModelId(modelSelect.value);
      clearGeminiModelCache();
    });
    modelFallback.addEventListener("change", () => {
      setGeminiModelId(modelFallback.value);
      modelFallback.value = getGeminiModelId();
      clearGeminiModelCache();
    });
    void refreshGeminiModelPicker(modelSelect, modelFallback);
  }

  if (keyInput) {
    keyInput.value = getGeminiApiKey();
    keyInput.addEventListener("change", () => {
      setGeminiApiKey(keyInput.value);
      keyInput.value = getGeminiApiKey();
      clearGeminiModelCache();
      if (modelSelect && modelFallback) {
        void refreshGeminiModelPicker(modelSelect, modelFallback);
      }
    });
  }
}

// The sidebar and the start screen each have a picker; both show the same model.
function getModelPickers() {
  return [...document.querySelectorAll("[data-model-picker]")];
}

export function syncModelPickers(modelId = getModelId()) {
  for (const select of getModelPickers()) {
    select.value = modelId;
  }
}

export function setModelPickersDisabled(disabled) {
  for (const select of getModelPickers()) {
    select.disabled = disabled;
  }
}

export function initModelPicker(onSelect) {
  const selects = getModelPickers();
  for (const select of selects) {
    select.replaceChildren();
    for (const option of MODEL_OPTIONS) {
      const el = document.createElement("option");
      el.value = option.id;
      el.textContent = option.label;
      el.disabled = !option.enabled;
      select.appendChild(el);
    }

    select.addEventListener("change", () => {
      const option = MODEL_OPTIONS.find((item) => item.id === select.value);
      if (!option?.enabled) {
        syncModelPickers();
        return;
      }
      if (option.task === "description") {
        recordingSettings.descriptionSource = option.id;
        syncModelPickers(select.value);
        onSelect?.(select.value);
        return;
      }
      syncModelPickers(select.value);
      onSelect?.(select.value);
    });
  }
  syncModelPickers();
  return selects;
}
