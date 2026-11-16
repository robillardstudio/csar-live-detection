export function showCameraFeedback(message) {
  const existing = document.getElementById("camera-feedback");
  if (existing) {
    existing.remove();
  }

  const feedback = document.createElement("p");
  feedback.id = "camera-feedback";
  feedback.className = "camera-feedback";
  feedback.textContent = message;
  document.body.appendChild(feedback);

  window.setTimeout(() => {
    feedback.remove();
  }, 4000);
}

function disableAudioTracks(stream) {
  for (const track of stream.getAudioTracks()) {
    track.enabled = false;
  }
}

export async function requestCameraStream() {
  if (!navigator.mediaDevices?.getUserMedia) {
    throw new Error("unsupported");
  }

  const videoPreferred = { facingMode: "environment" };

  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: videoPreferred,
      audio: true,
    });
    disableAudioTracks(stream);
    return stream;
  } catch {
    // Audio denied or unavailable — fall back to video-only.
  }

  try {
    return await navigator.mediaDevices.getUserMedia({
      video: videoPreferred,
      audio: false,
    });
  } catch {
    return navigator.mediaDevices.getUserMedia({
      video: true,
      audio: false,
    });
  }
}
