// Touch-first devices (phones, iPad). Laptops with touchscreens still report a fine pointer.
export function isCoarsePointer() {
  return typeof window.matchMedia === "function" && window.matchMedia("(pointer: coarse)").matches;
}

// Phones only: coarse pointer and a short screen side within the phone layout width, in either orientation.
export function isPhone() {
  return isCoarsePointer() && Math.min(screen.width, screen.height) <= 640;
}
