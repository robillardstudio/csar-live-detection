// Caches the latest device orientation (compass heading + tilt) so detections can log it without blocking inference.
// Heading is raw magnetic degrees clockwise from north; no declination is applied.
// cameraHeading corrects it for screen rotation so it is the direction the back camera faces.

// webkitCompassHeading (and 360 - alpha) follow the device's portrait top edge, not the back camera,
// so camera = raw - (screenAngle - PORTRAIT_SCREEN_ANGLE).
// PORTRAIT_SCREEN_ANGLE is the angle the device reports when held upright in portrait, measured on the
// M1 iPad Pro (iPadOS 26), whose natural orientation is landscape. Other devices (e.g. an M4 iPad Pro)
// may report a different value and need their own check.
const PORTRAIT_SCREEN_ANGLE = 90;

// iOS only delivers orientation events after requestPermission() runs inside a user gesture,
// so call this synchronously from the click handler, before any await.
// Android has no requestPermission — that missing method must NOT be treated as "unsupported".
export function requestCompassPermission() {
  const OrientationEvent = window.DeviceOrientationEvent;
  if (!OrientationEvent) {
    return Promise.resolve("unavailable");
  }
  if (typeof OrientationEvent.requestPermission !== "function") {
    return Promise.resolve("granted");
  }
  return OrientationEvent.requestPermission()
    .then((state) => (state === "granted" || state === "denied" ? state : "granted"))
    .catch(() => "denied");
}

function normalizeDegrees(value) {
  return ((value % 360) + 360) % 360;
}

function finiteOrNull(value) {
  return Number.isFinite(value) ? value : null;
}

function readScreenAngle() {
  return finiteOrNull(screen.orientation?.angle ?? window.orientation);
}

function readScreenOrientationType() {
  return screen.orientation?.type ?? null;
}

// window.orientation reports -90 where screen.orientation reports 270; normalizing handles both.
function toCameraHeading(heading, screenAngle) {
  if (heading == null || screenAngle == null) {
    return null;
  }
  return normalizeDegrees(
    heading - (normalizeDegrees(screenAngle) - PORTRAIT_SCREEN_ANGLE),
  );
}

export function createCompassTracker(onReading) {
  let cachedReading = null;
  const fired = {
    deviceorientationabsolute: 0,
    deviceorientation: 0,
  };
  let absoluteLogged = false;
  let relativeLogged = false;
  let lastDebug = {
    events: "none",
    alpha: "—",
    absolute: "—",
    type: "—",
  };

  function publish(partial) {
    const screenAngle = readScreenAngle();
    const heading = partial.heading;
    cachedReading = {
      heading,
      cameraHeading: toCameraHeading(heading, screenAngle),
      accuracy: partial.accuracy ?? null,
      accuracySupported: partial.accuracySupported ?? false,
      beta: partial.beta ?? null,
      gamma: partial.gamma ?? null,
      screenAngle,
      screenOrientationType: readScreenOrientationType(),
      receivedEvent: true,
      relativeOnly: partial.relativeOnly === true,
      debug: lastDebug,
    };
    onReading?.(cachedReading);
  }

  function updateDebug(event, type) {
    lastDebug = {
      events: `abs=${fired.deviceorientationabsolute} ori=${fired.deviceorientation}`,
      alpha: Number.isFinite(event.alpha) ? String(Math.round(event.alpha)) : "—",
      absolute: String(event.absolute),
      type,
    };
  }

  // Chrome Android: north-referenced alpha arrives on this event (deviceorientation stays absolute=false).
  function handleAbsolute(event) {
    fired.deviceorientationabsolute += 1;
    if (!absoluteLogged) {
      absoluteLogged = true;
      console.log(
        "[COMPASS] deviceorientationabsolute fired",
        `alpha=${event.alpha}`,
        `absolute=${event.absolute}`,
      );
    }
    updateDebug(event, "deviceorientationabsolute");

    let heading = null;
    let accuracy = null;
    const accuracySupported = Number.isFinite(event.webkitCompassHeading);
    if (accuracySupported) {
      heading = normalizeDegrees(event.webkitCompassHeading);
      accuracy =
        event.webkitCompassAccuracy >= 0 ? event.webkitCompassAccuracy : null;
    } else if (Number.isFinite(event.alpha)) {
      heading = normalizeDegrees(360 - event.alpha);
    }

    publish({
      heading,
      accuracy,
      accuracySupported,
      beta: finiteOrNull(event.beta),
      gamma: finiteOrNull(event.gamma),
      relativeOnly: false,
    });
  }

  function handleOrientation(event) {
    fired.deviceorientation += 1;
    if (!relativeLogged) {
      relativeLogged = true;
      console.log(
        "[COMPASS] deviceorientation fired",
        `alpha=${event.alpha}`,
        `absolute=${event.absolute}`,
      );
    }
    updateDebug(event, "deviceorientation");

    // Absolute event already provides a north reference — don't let relative overwrite it.
    if (fired.deviceorientationabsolute > 0 || cachedReading?.heading != null) {
      if (cachedReading) {
        cachedReading = { ...cachedReading, debug: lastDebug };
        onReading?.(cachedReading);
      }
      return;
    }

    // iOS: heading lives on deviceorientation via webkitCompassHeading.
    if (Number.isFinite(event.webkitCompassHeading)) {
      const accuracy =
        event.webkitCompassAccuracy >= 0 ? event.webkitCompassAccuracy : null;
      publish({
        heading: normalizeDegrees(event.webkitCompassHeading),
        accuracy,
        accuracySupported: true,
        beta: finiteOrNull(event.beta),
        gamma: finiteOrNull(event.gamma),
        relativeOnly: false,
      });
      return;
    }

    // Some browsers set absolute=true on plain deviceorientation.
    if (event.absolute === true && Number.isFinite(event.alpha)) {
      publish({
        heading: normalizeDegrees(360 - event.alpha),
        accuracy: null,
        accuracySupported: false,
        beta: finiteOrNull(event.beta),
        gamma: finiteOrNull(event.gamma),
        relativeOnly: false,
      });
      return;
    }

    // Relative-only: tilt is fine, but alpha is not north-referenced — do not use for bearings.
    publish({
      heading: null,
      accuracy: null,
      accuracySupported: false,
      beta: finiteOrNull(event.beta),
      gamma: finiteOrNull(event.gamma),
      relativeOnly: true,
    });
  }

  return {
    start() {
      // Always attach both; Chrome Android needs the absolute event name for north-referenced alpha.
      window.addEventListener("deviceorientationabsolute", handleAbsolute);
      window.addEventListener("deviceorientation", handleOrientation);
      console.log(
        "[COMPASS] listening for deviceorientationabsolute + deviceorientation",
      );
    },
    stop() {
      window.removeEventListener("deviceorientationabsolute", handleAbsolute);
      window.removeEventListener("deviceorientation", handleOrientation);
    },
    getReading() {
      return cachedReading;
    },
    hasReceivedEvent() {
      return (
        fired.deviceorientationabsolute > 0 || fired.deviceorientation > 0
      );
    },
    hasAbsoluteEvent() {
      return fired.deviceorientationabsolute > 0;
    },
    isRelativeOnly() {
      return (
        fired.deviceorientation > 0 &&
        fired.deviceorientationabsolute === 0 &&
        cachedReading?.heading == null
      );
    },
    getDebug() {
      return { ...lastDebug, ...fired };
    },
  };
}
