// Live-loop settings (confidence / max objects / still skip) + model pickers.
import { MODEL_OPTIONS, getModelId } from "../models.js";

const SENSITIVITY_LEVELS = ["low", "medium", "high"];

const settings = {
  confidence: 0.2,
  maxObjects: 10,
  skipWhenStill: true,
  stillSensitivity: "medium",
};

export function getSettings() {
  return {
    analysisSettings: {},
    parameters: { ...settings },
  };
}

export function initStillSettings() {
  const skips = [
    document.getElementById("skip-when-still"),
    document.getElementById("skip-when-still-mobile"),
  ].filter(Boolean);
  const sliders = [
    document.getElementById("still-sensitivity"),
    document.getElementById("still-sensitivity-mobile"),
  ].filter(Boolean);
  const labels = [
    document.getElementById("still-sensitivity-label"),
    document.getElementById("still-sensitivity-label-mobile"),
  ].filter(Boolean);

  if (!skips.length || !sliders.length) {
    return;
  }

  function syncSensitivityLabel() {
    const level = SENSITIVITY_LEVELS[Number(sliders[0].value)] ?? "medium";
    settings.stillSensitivity = level;
    const text = level.charAt(0).toUpperCase() + level.slice(1);
    for (const label of labels) {
      label.textContent = text;
    }
  }

  function syncSkip(checked) {
    settings.skipWhenStill = checked;
    for (const skip of skips) {
      skip.checked = checked;
    }
  }

  function syncSlider(value) {
    for (const slider of sliders) {
      slider.value = value;
    }
    syncSensitivityLabel();
  }

  const index = SENSITIVITY_LEVELS.indexOf(settings.stillSensitivity);
  syncSkip(settings.skipWhenStill);
  syncSlider(String(index < 0 ? 1 : index));

  for (const skip of skips) {
    skip.addEventListener("change", () => syncSkip(skip.checked));
  }
  for (const slider of sliders) {
    slider.addEventListener("input", () => syncSlider(slider.value));
  }
}

// Sidebar, start screen, and mobile session card share the same model pickers.
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
