// Live-loop defaults (confidence / max objects). No settings UI yet; getSettings() is the seam for one later.
import { MODEL_OPTIONS, getModelId } from "../models.js";

const DEFAULT_PARAMETERS = {
  confidence: 0.5,
  maxObjects: 10,
};

export function getSettings() {
  return {
    analysisSettings: {},
    parameters: { ...DEFAULT_PARAMETERS },
  };
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
