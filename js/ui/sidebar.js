// Live-loop defaults (confidence / max objects) plus recording and Gemini preferences.
import { MODEL_OPTIONS, getModelId } from "../models.js";
import {
  DEFAULT_GEMINI_MODEL,
  getGeminiApiKey,
  getGeminiModelId,
  setGeminiApiKey,
  setGeminiModelId,
} from "../live/gemini-settings.js";
import { showCameraFeedback } from "../utils/camera.js";

const DEFAULT_PARAMETERS = {
  confidence: 0.5,
  maxObjects: 10,
};

const recordingSettings = {
  showAiWhileRecording: false,
  descriptionSource: "gemini:online",
};

export function getSettings() {
  return {
    analysisSettings: {},
    parameters: { ...DEFAULT_PARAMETERS },
    showAiWhileRecording: recordingSettings.showAiWhileRecording,
    descriptionSource: recordingSettings.descriptionSource,
  };
}

export function initRecordingSettings() {
  const checkbox = document.getElementById("setting-show-ai-while-recording");
  if (checkbox) {
    checkbox.checked = recordingSettings.showAiWhileRecording;
    checkbox.addEventListener("change", () => {
      recordingSettings.showAiWhileRecording = checkbox.checked;
    });
  }

  const keyInput = document.getElementById("setting-gemini-api-key");
  if (keyInput) {
    keyInput.value = getGeminiApiKey();
    keyInput.addEventListener("change", () => {
      setGeminiApiKey(keyInput.value);
      keyInput.value = getGeminiApiKey();
    });
  }

  const modelInput = document.getElementById("setting-gemini-model");
  if (modelInput) {
    modelInput.value = getGeminiModelId() || DEFAULT_GEMINI_MODEL;
    modelInput.addEventListener("change", () => {
      setGeminiModelId(modelInput.value);
      modelInput.value = getGeminiModelId();
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
        syncModelPickers(getModelId());
        showCameraFeedback(
          "Gemini (online) describes moments after Stop Recording",
        );
        return;
      }
      syncModelPickers(select.value);
      onSelect?.(select.value);
    });
  }
  syncModelPickers();
  return selects;
}
