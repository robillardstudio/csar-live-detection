// Live (camera) and Review (Map and Summary tabs). Switching never touches the camera, model, sensors, or log.
import {
  getLiveDetectionLogCount,
  onLiveDetectionLogCleared,
} from "../live/detection-log.js";

export function initAppMode(views) {
  const modeButtons = [...document.querySelectorAll("[data-app-mode]")];
  const liveOnly = document.querySelectorAll('[data-show-in="live"]');
  const reviewOnly = document.querySelectorAll('[data-show-in="review"]');
  const reviewPanel = document.getElementById("review-panel");
  const reviewEmpty = document.getElementById("review-empty");
  const reviewBody = document.getElementById("review-body");
  const tablist = document.getElementById("review-tabs");
  const tabs = [...(tablist?.querySelectorAll('[role="tab"]') ?? [])];

  if (
    !modeButtons.length ||
    !reviewPanel ||
    !reviewEmpty ||
    !reviewBody ||
    !tabs.length
  ) {
    return;
  }

  let mode = "live";
  let activeTab = "map";
  // Tabs built since entering Review; the rest build from the log when first shown.
  const built = new Set();

  function setVisible(nodes, visible) {
    for (const node of nodes) {
      node.classList.toggle("hidden", !visible);
    }
  }

  function closeViews() {
    built.clear();
    views.map.close();
    views.summary.close();
  }

  function showTab(name) {
    activeTab = name;
    for (const tab of tabs) {
      const selected = tab.dataset.reviewTab === name;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      document
        .getElementById(tab.getAttribute("aria-controls"))
        ?.classList.toggle("hidden", !selected);
    }
    if (built.has(name)) {
      views[name].resize();
    } else {
      built.add(name);
      views[name].open();
    }
  }

  function renderReview() {
    closeViews();
    const hasRows = getLiveDetectionLogCount() > 0;
    reviewEmpty.classList.toggle("hidden", hasRows);
    reviewBody.classList.toggle("hidden", !hasRows);
    if (hasRows) {
      showTab(activeTab);
    }
  }

  function setMode(next) {
    if (next === mode) {
      return;
    }
    mode = next;
    for (const button of modeButtons) {
      button.setAttribute(
        "aria-pressed",
        String(button.dataset.appMode === mode),
      );
    }
    setVisible(liveOnly, mode === "live");
    setVisible(reviewOnly, mode === "review");
    reviewPanel.classList.toggle("hidden", mode !== "review");
    if (mode === "review") {
      renderReview();
    } else {
      closeViews();
    }
  }

  for (const button of modeButtons) {
    button.addEventListener("click", () => setMode(button.dataset.appMode));
  }

  for (const tab of tabs) {
    tab.addEventListener("click", () => {
      if (tab.dataset.reviewTab !== activeTab) {
        showTab(tab.dataset.reviewTab);
      }
    });
  }

  tablist.addEventListener("keydown", (event) => {
    const index = tabs.indexOf(document.activeElement);
    const targets = {
      ArrowLeft: index - 1,
      ArrowRight: index + 1,
      Home: 0,
      End: tabs.length - 1,
    };
    if (index === -1 || !(event.key in targets)) {
      return;
    }
    event.preventDefault();
    const next = tabs[(targets[event.key] + tabs.length) % tabs.length];
    next.focus();
    showTab(next.dataset.reviewTab);
  });

  onLiveDetectionLogCleared(() => {
    if (mode === "review") {
      renderReview();
    }
  });
}
