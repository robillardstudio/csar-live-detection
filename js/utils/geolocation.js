// Caches the latest GPS fix from a continuous watch so detections can log location without blocking inference.
// A watch lets iOS settle on a satellite fix; repeated getCurrentPosition calls tend to get quick, coarse Wi-Fi answers.
const WATCH_OPTIONS = {
  enableHighAccuracy: true,
  maximumAge: 0,
  timeout: 15000,
};

// Fallback only: polled while the watch is reporting errors, and stopped as soon as it delivers again.
export const GPS_REFRESH_MS = 3000;

const POLL_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 8000,
  maximumAge: 2000,
};

export function createGpsTracker(onFix) {
  let cachedFix = null;
  let active = false;
  let watchId = null;
  let fallbackId = null;

  function applyPosition(position) {
    // A poll that was already in flight when tracking stopped must not update the cache.
    if (!active) {
      return;
    }
    cachedFix = {
      lat: position.coords.latitude,
      lon: position.coords.longitude,
      accuracy: position.coords.accuracy,
      timestamp: position.timestamp,
    };
    onFix?.(cachedFix);
  }

  function poll() {
    navigator.geolocation.getCurrentPosition(applyPosition, () => {}, POLL_OPTIONS);
  }

  function startFallback() {
    if (fallbackId !== null) {
      return;
    }
    poll();
    fallbackId = window.setInterval(poll, GPS_REFRESH_MS);
  }

  function stopFallback() {
    if (fallbackId !== null) {
      window.clearInterval(fallbackId);
      fallbackId = null;
    }
  }

  function handleWatchPosition(position) {
    stopFallback();
    applyPosition(position);
  }

  // The watch keeps running after a timeout or unavailable error, so polling only fills the gap.
  // Polling cannot help when permission is denied.
  function handleWatchError(error) {
    if (error.code === error.PERMISSION_DENIED) {
      return;
    }
    startFallback();
  }

  return {
    start() {
      if (!navigator.geolocation || active) {
        return;
      }
      active = true;
      watchId = navigator.geolocation.watchPosition(
        handleWatchPosition,
        handleWatchError,
        WATCH_OPTIONS,
      );
    },
    stop() {
      active = false;
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
      stopFallback();
    },
    getFix() {
      return cachedFix;
    },
  };
}
