// Live-loop defaults (confidence / max objects) plus recording preferences.
import { MODEL_OPTIONS, getModelId } from "../models.js";

const DEFAULT_PARAMETERS = {
  confidence: 0.5,
  maxObjects: 10,
};

const recordingSettings = {
  showAiWhileRecording: false,
};

export function getSettings() {
  return {
    analysisSettings: {},
    parameters: { ...DEFAULT_PARAMETERS },
    showAiWhileRecording: recordingSettings.showAiWhileRecording,
  };
}

export function initRecordingSettings() {
  const checkbox = document.getElementById("setting-show-ai-while-recording");
  if (!checkbox) {
    return;
  }
  checkbox.checked = recordingSettings.showAiWhileRecording;
  checkbox.addEventListener("change", () => {
    recordingSettings.showAiWhileRecording = checkbox.checked;
  });
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
      syncModelPickers(select.value);
      onSelect?.(select.value);
    });
  }
  syncModelPickers();
  return selects;
}
