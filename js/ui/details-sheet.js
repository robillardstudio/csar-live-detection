// Phones only: the sidebar opens as a bottom sheet; the camera keeps running behind it.
const PHONE_QUERY = "(max-width: 640px)";

export function initDetailsSheet() {
  const sidebar = document.getElementById("sidebar");
  const openButton = document.getElementById("btn-details");
  const closeButton = document.getElementById("btn-details-close");
  const backdrop = document.getElementById("details-backdrop");
  const background = [
    document.querySelector(".top-nav"),
    document.getElementById("main-content"),
  ];

  if (!sidebar || !openButton || !closeButton || !backdrop) {
    return;
  }

  let open = false;

  function setOpen(next, { restoreFocus = true } = {}) {
    open = next;
    sidebar.classList.toggle("sidebar--open", open);
    backdrop.hidden = !open;
    openButton.setAttribute("aria-expanded", String(open));
    // Keeps taps and focus in the sheet; inert does not pause the video.
    for (const node of background) {
      if (node) {
        node.inert = open;
      }
    }
    if (open) {
      closeButton.focus();
    } else if (restoreFocus) {
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
  // Wider screens show the sidebar as a column again.
  window.matchMedia(PHONE_QUERY).addEventListener("change", (event) => {
    if (!event.matches && open) {
      setOpen(false, { restoreFocus: false });
    }
  });
}
