// Bottom sheet for session details (all viewports). Camera keeps running behind it.

function setFabHidden(hidden) {
  document.getElementById("btn-add-label")?.classList.toggle("is-hidden", hidden);
}

export function initDetailsSheet() {
  const sheet = document.getElementById("details-sheet");
  const openButton = document.getElementById("btn-details");
  const closeButton = document.getElementById("btn-details-close");
  const backdrop = document.getElementById("details-backdrop");
  const background = [
    document.querySelector(".top-nav"),
    document.getElementById("main-content"),
  ];

  if (!sheet || !openButton || !closeButton || !backdrop) {
    return null;
  }

  let open = false;

  function setOpen(next, { restoreFocus = true } = {}) {
    open = next;
    openButton.setAttribute("aria-expanded", String(open));
    setFabHidden(open);

    for (const node of background) {
      if (node) {
        node.inert = open;
      }
    }

    if (open) {
      sheet.hidden = false;
      backdrop.hidden = false;
      sheet.classList.add("is-mounted");
      backdrop.classList.add("is-mounted");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sheet.classList.add("open");
          backdrop.classList.add("on");
        });
      });
      closeButton.focus();
      return;
    }

    sheet.classList.remove("open");
    backdrop.classList.remove("on");
    const finish = () => {
      if (!open) {
        sheet.classList.remove("is-mounted");
        backdrop.classList.remove("is-mounted");
        sheet.hidden = true;
        backdrop.hidden = true;
      }
    };
    sheet.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 360);
    if (restoreFocus) {
      openButton.focus();
    }
  }

  openButton.addEventListener("click", () => setOpen(true));
  closeButton.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));
  document.addEventListener("keydown", (event) => {
    if (open && event.key === "Escape") {
      setOpen(false);
    }
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
  };
}

export function initModelsSheet({ getModels, getSelectedId, onSelect }) {
  const sheet = document.getElementById("models-sheet");
  const backdrop = document.getElementById("models-backdrop");
  const closeButton = document.getElementById("btn-models-close");
  const list = document.getElementById("models-list");
  const openButton = document.getElementById("btn-change-model");

  if (!sheet || !backdrop || !closeButton || !list || !openButton) {
    return null;
  }

  let open = false;
  const checkSvg =
    '<svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3.5" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l5 5 9-10"/></svg>';

  function modelBlurb(option) {
    if (option.engine === "gemini") {
      return "On demand · Look freezes a frame for boxes";
    }
    if (option.id === "yolov8n-oiv7") {
      return "Detection · Open Images V7, 601 classes";
    }
    if (option.task === "classification") {
      return "Classification · names the whole frame";
    }
    if (option.task === "detection") {
      return "Detection · draws a box per object";
    }
    return option.task;
  }

  function renderList() {
    const selected = getSelectedId();
    const models = getModels().filter((item) => item.enabled);
    list.replaceChildren(
      ...models.map((option) => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "mopt";
        button.setAttribute("role", "radio");
        button.setAttribute("aria-checked", String(option.id === selected));
        button.dataset.modelId = option.id;
        button.innerHTML = `<div><b>${option.label.replace(/\s*\([^)]*\)\s*$/, "")}</b><small>${modelBlurb(option)}</small></div><span class="check">${option.id === selected ? checkSvg : ""}</span>`;
        return button;
      }),
    );
  }

  function setOpen(next) {
    open = next;
    setFabHidden(open);
    if (open) {
      renderList();
      sheet.hidden = false;
      backdrop.hidden = false;
      sheet.classList.add("is-mounted");
      backdrop.classList.add("is-mounted");
      requestAnimationFrame(() => {
        requestAnimationFrame(() => {
          sheet.classList.add("open");
          backdrop.classList.add("on");
        });
      });
      closeButton.focus();
      return;
    }
    sheet.classList.remove("open");
    backdrop.classList.remove("on");
    const finish = () => {
      if (!open) {
        sheet.classList.remove("is-mounted");
        backdrop.classList.remove("is-mounted");
        sheet.hidden = true;
        backdrop.hidden = true;
      }
    };
    sheet.addEventListener("transitionend", finish, { once: true });
    window.setTimeout(finish, 360);
  }

  openButton.addEventListener("click", () => setOpen(true));
  closeButton.addEventListener("click", () => setOpen(false));
  backdrop.addEventListener("click", () => setOpen(false));
  list.addEventListener("click", (event) => {
    const button = event.target.closest("[data-model-id]");
    if (!button) {
      return;
    }
    const modelId = button.dataset.modelId;
    setOpen(false);
    if (modelId && modelId !== getSelectedId()) {
      onSelect?.(modelId);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (open && event.key === "Escape") {
      setOpen(false);
    }
  });

  return {
    open: () => setOpen(true),
    close: () => setOpen(false),
    isOpen: () => open,
    refresh: renderList,
  };
}
