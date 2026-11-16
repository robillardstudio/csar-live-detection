// Continuous GPS tracking. Keeps the latest good fix for live use
// and the full track for interpolation at export time.
export const MAX_ACCURACY_M = 10; // reject fixes worse than this

const GEO_OPTIONS = {
  enableHighAccuracy: true,
  timeout: 15000,
  maximumAge: 0, // never accept cached positions
};

export function createGpsTracker(onFix, onError) {
  let cachedFix = null;
  let watchId = null;
  const track = []; // every fix, for diagnostics
  const goodTrack = []; // fixes within MAX_ACCURACY_M

  function applyPosition(position) {
    const c = position.coords;
    const fix = {
      lat: c.latitude,
      lon: c.longitude,
      accuracy: c.accuracy,
      timestamp: position.timestamp,
    };
    track.push(fix);
    if (fix.accuracy > MAX_ACCURACY_M) return;
    if (cachedFix && fix.timestamp === cachedFix.timestamp) return;
    goodTrack.push(fix);
    cachedFix = fix;
    onFix?.(fix);
  }

  return {
    start() {
      if (!navigator.geolocation || watchId !== null) return;
      watchId = navigator.geolocation.watchPosition(
        applyPosition,
        (err) => onError?.(err),
        GEO_OPTIONS,
      );
    },
    stop() {
      if (watchId !== null) {
        navigator.geolocation.clearWatch(watchId);
        watchId = null;
      }
    },
    getFix() {
      return cachedFix
        ? { ...cachedFix, ageMs: Date.now() - cachedFix.timestamp }
        : null;
    },
    getTrack() {
      return track.slice();
    },
    // Interpolated position at time t (ms). Use at export, not live.
    positionAt(t) {
      const g = goodTrack;
      if (g.length === 0) return null;
      if (t <= g[0].timestamp) return g[0];
      if (t >= g[g.length - 1].timestamp) return g[g.length - 1];
      const i = g.findIndex((f) => f.timestamp > t);
      const a = g[i - 1];
      const b = g[i];
      const k = (t - a.timestamp) / (b.timestamp - a.timestamp);
      return {
        lat: a.lat + k * (b.lat - a.lat),
        lon: a.lon + k * (b.lon - a.lon),
        accuracy: Math.max(a.accuracy, b.accuracy),
        timestamp: t,
      };
    },
  };
}
