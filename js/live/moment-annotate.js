// Background queue: independent transcript + description jobs per moment (never cross inputs).

import {
  getRecordingById,
  getRecordings,
  patchRecordingAnnotation,
} from "./detection-log.js";
import {
  describeFrames,
  transcribeAudioBlob,
} from "./gemini-client.js";
import {
  DESCRIPTION_PROMPT,
  getGeminiModelId,
  hasGeminiApiKey,
} from "./gemini-settings.js";

const queue = [];
const inFlight = new Set();
let pumping = false;

function overallStatus(recording) {
  const statuses = [
    recording.transcript_status,
    recording.description_status,
  ].filter((status) => status && status !== "skipped");
  if (!statuses.length) {
    return "skipped";
  }
  if (statuses.some((status) => status === "pending")) {
    return "pending";
  }
  if (statuses.some((status) => status === "failed")) {
    return "failed";
  }
  return "done";
}

function syncOverall(recordingId) {
  const recording = getRecordingById(recordingId);
  if (!recording) {
    return;
  }
  patchRecordingAnnotation(recordingId, {
    annotation_status: overallStatus(recording),
  });
}

function formatJobError(error) {
  return error?.message || String(error) || "request_failed";
}

async function runTranscript(recording) {
  if (!recording.audio_blob) {
    patchRecordingAnnotation(recording.recording_id, {
      transcript: null,
      transcript_status: "skipped",
      transcript_error: null,
    });
    return;
  }
  patchRecordingAnnotation(recording.recording_id, {
    transcript_status: "pending",
    transcript_error: null,
    annotation_status: "pending",
  });
  try {
    const transcript = await transcribeAudioBlob(
      recording.audio_blob,
      recording.audio_mime,
    );
    patchRecordingAnnotation(recording.recording_id, {
      transcript,
      transcript_status: "done",
      transcript_error: null,
    });
  } catch (error) {
    const message = formatJobError(error);
    console.error("[GEMINI] transcript failed:", message);
    patchRecordingAnnotation(recording.recording_id, {
      transcript_status: "failed",
      transcript_error: message,
    });
  }
}

async function runDescription(recording) {
  const frames = recording.frames ?? [];
  if (!frames.some((frame) => frame?.jpeg instanceof Blob)) {
    patchRecordingAnnotation(recording.recording_id, {
      ai_description: null,
      description_status: "skipped",
      description_error: null,
    });
    return;
  }
  const modelId = getGeminiModelId();
  patchRecordingAnnotation(recording.recording_id, {
    description_status: "pending",
    description_error: null,
    description_model: modelId,
    description_prompt: DESCRIPTION_PROMPT,
    annotation_status: "pending",
  });
  try {
    const ai_description = await describeFrames(frames);
    patchRecordingAnnotation(recording.recording_id, {
      ai_description,
      description_status: "done",
      description_error: null,
      description_model: modelId,
      description_prompt: DESCRIPTION_PROMPT,
      description_timestamp: Date.now(),
    });
  } catch (error) {
    const message = formatJobError(error);
    console.error("[GEMINI] description failed:", message);
    patchRecordingAnnotation(recording.recording_id, {
      description_status: "failed",
      description_error: message,
    });
  }
}

async function processItem(recordingId) {
  if (inFlight.has(recordingId)) {
    return;
  }
  const recording = getRecordingById(recordingId);
  if (!recording) {
    return;
  }
  if (!hasGeminiApiKey()) {
    patchRecordingAnnotation(recordingId, {
      annotation_status: "failed",
      transcript_status: recording.audio_blob ? "failed" : "skipped",
      description_status:
        (recording.frames?.length ?? 0) > 0 ? "failed" : "skipped",
      transcript_error: "missing_api_key",
      description_error: "missing_api_key",
    });
    return;
  }

  inFlight.add(recordingId);
  try {
    // Independent calls — never share inputs or await in a chain that passes text across.
    const fresh = getRecordingById(recordingId) ?? recording;
    const jobs = [];
    if (fresh.transcript_status !== "done") {
      jobs.push(runTranscript(fresh));
    }
    if (fresh.description_status !== "done") {
      jobs.push(runDescription(fresh));
    }
    await Promise.all(jobs);
    syncOverall(recordingId);
  } finally {
    inFlight.delete(recordingId);
  }
}

async function pump() {
  if (pumping) {
    return;
  }
  pumping = true;
  try {
    while (queue.length) {
      const recordingId = queue.shift();
      await processItem(recordingId);
    }
  } finally {
    pumping = false;
    // Drain anything enqueued while this pump was winding down.
    if (queue.length) {
      void pump();
    }
  }
}

export function enqueueMomentAnnotation(recordingId, { force = false } = {}) {
  const recording = getRecordingById(recordingId);
  if (!recording) {
    return;
  }
  patchRecordingAnnotation(recordingId, {
    transcript_status: recording.audio_blob ? "pending" : "skipped",
    description_status:
      (recording.frames?.length ?? 0) > 0 ? "pending" : "skipped",
    annotation_status: "pending",
    transcript_error: null,
    description_error: null,
  });
  if (!queue.includes(recordingId)) {
    queue.push(recordingId);
  }
  console.log(
    "[GEMINI] enqueue recording",
    recordingId,
    force ? "(retry)" : "",
    "queue=",
    queue.length,
  );
  void pump();
}

export function retryMomentAnnotation(recordingId) {
  enqueueMomentAnnotation(recordingId, { force: true });
}

export function initMomentAnnotate() {
  window.addEventListener("online", () => {
    for (const recording of getRecordings()) {
      const status = recording.annotation_status;
      if (status === "pending" || status === "failed") {
        if (!queue.includes(recording.recording_id) && !inFlight.has(recording.recording_id)) {
          queue.push(recording.recording_id);
        }
      }
    }
    void pump();
  });
}
