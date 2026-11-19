// App entry: boots the live-detection page and preloads the object detector in the background.
import { loadModel } from "./models.js";
import { isCoarsePointer } from "./utils/device.js";
import { initLiveDetectionPage } from "./ui/live-detection.js";
import { initLiveAnnotate } from "./ui/live-annotate.js";
import { initSessionSummary } from "./ui/session-summary.js";
import { initSessionMap } from "./ui/session-map.js";
import { initAppMode } from "./ui/app-mode.js";
import { initDetailsSheet } from "./ui/details-sheet.js";

function syncNavHeight() {
  const nav = document.querySelector(".top-nav");
  if (!nav) {
    return;
  }
  const height = Math.ceil(nav.getBoundingClientRect().height);
  if (height > 0) {
    document.documentElement.style.setProperty("--nav-height", `${height}px`);
  }
}

document.addEventListener("DOMContentLoaded", () => {
  syncNavHeight();
  window.addEventListener("resize", syncNavHeight);
  if (typeof ResizeObserver === "function") {
    const nav = document.querySelector(".top-nav");
    if (nav) {
      new ResizeObserver(syncNavHeight).observe(nav);
    }
  }

  const annotate = initLiveAnnotate();
  initLiveDetectionPage(annotate);
  initDetailsSheet();
  const map = initSessionMap();
  const summary = initSessionSummary();
  if (map && summary) {
    initAppMode({ map, summary });
  }

  // Phones and tablets load the model on Start; a background GPU load on page open can crash mobile Chrome.
  if (!isCoarsePointer()) {
    loadModel("objectDetector").catch(() => {
      // Preload runs in background; errors surface when live detection starts.
    });
  }
});
