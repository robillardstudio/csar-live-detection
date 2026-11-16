// Background queue: independent transcript + description jobs per moment (never cross inputs),
// then a text-only compare once both accounts exist.

import {
  getRecordingById,
  getRecordings,
  patchRecordingAnnotation,
} from "./detection-log.js";
import {
  compareAccounts,
  describeFrames,
  transcribeAudioBlob,
} from "./gemini-client.js";
import {
  ANALYSIS_METHOD,
  DESCRIPTION_PROMPT,
  getGeminiModelId,
  hasGeminiApiKey,
} from "./gemini-settings.js";

const queue = [];
const inFlight = new Set();
const followUp = new Map(); // recordingId → { analysisOnly } if enqueued while in flight
let pumping = false;

function overallStatus(recording) {
  const statuses = [
    recording.transcript_status,
    recording.description_status,
    recording.analysis_status,
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

function hasBothAccounts(recording) {
  return (
    recording?.transcript_status === "done" &&
    recording?.description_status === "done" &&
    Boolean(String(recording.transcript ?? "").trim()) &&
    Boolean(String(recording.ai_description ?? "").trim())
  );
}

function enqueueJob(recordingId, { analysisOnly = false } = {}) {
  if (inFlight.has(recordingId)) {
    const prev = followUp.get(recordingId);
    followUp.set(recordingId, {
      analysisOnly: prev ? prev.analysisOnly && analysisOnly : analysisOnly,
    });
    return;
  }
  const existing = queue.find((item) => item.recordingId === recordingId);
  if (existing) {
    // Full annotate supersedes analysis-only; analysis-only upgrades nothing.
    if (!analysisOnly) {
      existing.analysisOnly = false;
    }
    return;
  }
  queue.push({ recordingId, analysisOnly });
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

async function runAnalysis(recording) {
  if (!hasBothAccounts(recording)) {
    patchRecordingAnnotation(recording.recording_id, {
      analysis: null,
      analysis_status: "skipped",
      analysis_error: null,
    });
    return;
  }
  const modelId = getGeminiModelId();
  patchRecordingAnnotation(recording.recording_id, {
    analysis_status: "pending",
    analysis_error: null,
    annotation_status: "pending",
  });
  try {
    const result = await compareAccounts(
      recording.transcript,
      recording.ai_description,
    );
    patchRecordingAnnotation(recording.recording_id, {
      analysis: {
        model: modelId,
        method: ANALYSIS_METHOD,
        observations: result.observations,
        ai_only: result.ai_only,
      },
      analysis_status: "done",
      analysis_error: null,
      analysis_timestamp: Date.now(),
    });
  } catch (error) {
    const message = formatJobError(error);
    console.error("[GEMINI] analysis failed:", message);
    patchRecordingAnnotation(recording.recording_id, {
      analysis_status: "failed",
      analysis_error: message,
    });
  }
}

async function processItem(recordingId, { analysisOnly = false } = {}) {
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
      analysis_status: "failed",
      transcript_error: "missing_api_key",
      description_error: "missing_api_key",
      analysis_error: "missing_api_key",
    });
    return;
  }

  inFlight.add(recordingId);
  try {
    if (!analysisOnly) {
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
    }

    const after = getRecordingById(recordingId) ?? recording;
    if (
      analysisOnly ||
      after.analysis_status !== "done" ||
      !after.analysis
    ) {
      if (hasBothAccounts(after) || analysisOnly) {
        await runAnalysis(after);
      } else if (
        after.transcript_status &&
        after.transcript_status !== "pending" &&
        after.description_status &&
        after.description_status !== "pending" &&
        after.analysis_status !== "done"
      ) {
        patchRecordingAnnotation(recordingId, {
          analysis: null,
          analysis_status: "skipped",
          analysis_error: null,
        });
      }
    }
    syncOverall(recordingId);
  } finally {
    inFlight.delete(recordingId);
    const next = followUp.get(recordingId);
    if (next) {
      followUp.delete(recordingId);
      enqueueJob(recordingId, next);
    }
  }
}

async function pump() {
  if (pumping) {
    return;
  }
  pumping = true;
  try {
    while (queue.length) {
      const job = queue.shift();
      await processItem(job.recordingId, {
        analysisOnly: Boolean(job.analysisOnly),
      });
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
    analysis_status: "pending",
    annotation_status: "pending",
    transcript_error: null,
    description_error: null,
    analysis_error: null,
    ...(force ? { analysis: null } : {}),
  });
  enqueueJob(recordingId, { analysisOnly: false });
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

export function enqueueMomentAnalysis(recordingId) {
  const recording = getRecordingById(recordingId);
  if (!recording || !hasBothAccounts(recording)) {
    return;
  }
  patchRecordingAnnotation(recordingId, {
    analysis: null,
    analysis_status: "pending",
    analysis_error: null,
    annotation_status: "pending",
  });
  enqueueJob(recordingId, { analysisOnly: true });
  console.log("[GEMINI] enqueue analysis", recordingId, "queue=", queue.length);
  void pump();
}

export function reanalyseMoment(recordingId) {
  enqueueMomentAnalysis(recordingId);
}

export function initMomentAnnotate() {
  window.addEventListener("online", () => {
    for (const recording of getRecordings()) {
      const status = recording.annotation_status;
      if (status === "pending" || status === "failed") {
        if (!inFlight.has(recording.recording_id)) {
          const analysisOnly =
            recording.transcript_status === "done" &&
            recording.description_status === "done" &&
            (recording.analysis_status === "pending" ||
              recording.analysis_status === "failed");
          enqueueJob(recording.recording_id, { analysisOnly });
        }
      }
    }
    void pump();
  });
}
