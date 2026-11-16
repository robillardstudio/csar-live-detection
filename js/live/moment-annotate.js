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
  const statuses = [recording.transcript_status, recording.description_status].filter(
    (status) => status && status !== "skipped",
  );
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

async function runTranscript(recording) {
  if (!recording.audio_blob) {
    patchRecordingAnnotation(recording.recording_id, {
      transcript: null,
      transcript_status: "skipped",
    });
    return;
  }
  patchRecordingAnnotation(recording.recording_id, {
    transcript_status: "pending",
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
    });
  } catch (error) {
    patchRecordingAnnotation(recording.recording_id, {
      transcript_status: "failed",
      transcript_error: error?.message ?? "transcript_failed",
    });
  }
}

async function runDescription(recording) {
  const frames = recording.frames ?? [];
  if (!frames.some((frame) => frame?.jpeg instanceof Blob)) {
    patchRecordingAnnotation(recording.recording_id, {
      ai_description: null,
      description_status: "skipped",
    });
    return;
  }
  const modelId = getGeminiModelId();
  patchRecordingAnnotation(recording.recording_id, {
    description_status: "pending",
    description_model: modelId,
    description_prompt: DESCRIPTION_PROMPT,
    annotation_status: "pending",
  });
  try {
    const ai_description = await describeFrames(frames);
    patchRecordingAnnotation(recording.recording_id, {
      ai_description,
      description_status: "done",
      description_model: modelId,
      description_prompt: DESCRIPTION_PROMPT,
      description_timestamp: Date.now(),
    });
  } catch (error) {
    patchRecordingAnnotation(recording.recording_id, {
      description_status: "failed",
      description_error: error?.message ?? "description_failed",
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
      description_status: (recording.frames?.length ?? 0) > 0 ? "failed" : "skipped",
      transcript_error: "missing_api_key",
      description_error: "missing_api_key",
    });
    return;
  }

  inFlight.add(recordingId);
  try {
    // Independent calls — never share inputs or await in a chain that passes text across.
    const jobs = [];
    if (recording.transcript_status !== "done") {
      jobs.push(runTranscript(recording));
    }
    if (recording.description_status !== "done") {
      jobs.push(runDescription(recording));
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
      if (!navigator.onLine) {
        break;
      }
      const recordingId = queue.shift();
      await processItem(recordingId);
    }
  } finally {
    pumping = false;
  }
}

export function enqueueMomentAnnotation(recordingId, { force = false } = {}) {
  const recording = getRecordingById(recordingId);
  if (!recording) {
    return;
  }
  if (force) {
    patchRecordingAnnotation(recordingId, {
      transcript_status: recording.audio_blob ? "pending" : "skipped",
      description_status:
        (recording.frames?.length ?? 0) > 0 ? "pending" : "skipped",
      annotation_status: "pending",
      transcript_error: null,
      description_error: null,
    });
  } else {
    patchRecordingAnnotation(recordingId, {
      transcript_status: recording.audio_blob ? "pending" : "skipped",
      description_status:
        (recording.frames?.length ?? 0) > 0 ? "pending" : "skipped",
      annotation_status: "pending",
    });
  }
  if (!queue.includes(recordingId)) {
    queue.push(recordingId);
  }
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
        if (!queue.includes(recording.recording_id)) {
          queue.push(recording.recording_id);
        }
      }
    }
    void pump();
  });
}
