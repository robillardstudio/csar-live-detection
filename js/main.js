// App entry: boots the live-detection page and preloads the object detector in the background.
import { loadModel } from "./models.js";
import { initLiveDetectionPage } from "./ui/live-detection.js";
import { initSessionSummary } from "./ui/session-summary.js";
import { initSessionMap } from "./ui/session-map.js";
import { initAppMode } from "./ui/app-mode.js";

document.addEventListener("DOMContentLoaded", () => {
  initLiveDetectionPage();
  const map = initSessionMap();
  const summary = initSessionSummary();
  if (map && summary) {
    initAppMode({ map, summary });
  }

  loadModel("objectDetector").catch(() => {
    // Preload runs in background; errors surface when live detection starts.
  });
});
