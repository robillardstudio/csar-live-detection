# Cursor Build Spec — Live Object Detection Prototype

**Project:** Situated Seeing (live-input extension)
**Base:** fork of `visual-analysis-tool` (Transformers.js, client-side, no server)
**Goal of this build:** replace static image-upload analysis with a **live camera object-detection loop** that (a) draws bounding boxes in real time, (b) measures true inference rate (FPS), and (c) logs each detection with GPS to an exportable CSV/JSON dataset.

This document is written to be pasted into Cursor as the build brief. Feed it in sections if the context gets large. Each numbered requirement is meant to be individually verifiable.

---

## 0. Context Cursor needs

We are extending a browser-based visual analysis tool into a field data-collection instrument for an AR research project about **geographic bias in machine vision**. A researcher walks a path, the phone/tablet camera runs object detection continuously, and every detection is logged with GPS coordinates and a timestamp. That log will later feed a 3D/AR pipeline (out of scope for this build — do **not** add any 3D, Blender, or AR code yet).

The intellectual point of the project is that the model *mislabels* the environment (calls a lamppost a "traffic light", a lawn a "bench"). So **do not filter out low-confidence or "wrong-looking" detections** — those are the data. Preserve them.

The predecessor sketch (ml5.js + MobileNet) logged only `{classification, confidence, lat, lon}` as top-1 classification. We are upgrading to **object detection** (multiple objects per frame, each with a bounding box) via **Transformers.js**, and enriching the schema with timestamp, model name, bbox, and GPS accuracy.

---

## 1. Tech stack (do not substitute)

- **Detection library:** `@huggingface/transformers` (Transformers.js **v3 or later**). Import via CDN in the browser:
  ```js
  import { pipeline, env } from "https://cdn.jsdelivr.net/npm/@huggingface/transformers";
  ```
  (If the existing repo already pins a version / uses npm, keep that; just ensure it is v3+.)
- **Task:** `pipeline("object-detection", MODEL_ID, { device, dtype })`
- **Backend:** prefer **WebGPU**, fall back to **WASM** automatically (see §3).
- **Compressed model:** use a **quantized** model via the `dtype` option (the "compressed version" the professor referred to). See §2.
- Keep everything **client-side**. No server calls except the one-time model download from the HuggingFace CDN.
- Vanilla JS + ES modules + Canvas, consistent with the existing repo. No React, no build framework unless the repo already has one.

---

## 2. Model selection

Make the model a single top-of-file constant so it's easy to swap during testing:

```js
const MODEL_ID = "Xenova/yolos-tiny";   // fast, good default for real-time
const DTYPE    = "q8";                   // quantized / "compressed"
```

Provide a small dropdown in the UI to switch between these three at runtime (reload the pipeline on change):

| Model ID | Character | Use |
|---|---|---|
| `Xenova/yolos-tiny` | lightest, fastest | **default** — real-time on iPad/laptop |
| `Xenova/detr-resnet-50` | heavier, more accurate | quality comparison |
| `Xenova/yolos-small` | middle ground | fallback |

All three expose the COCO 80-class label set, so downstream schema is identical regardless of choice. Log which model produced each row (see §6).

**Important about `dtype`:** `"fp32"` is the WebGPU default, `"q8"` is the WASM default. For the "compressed" real-time target, set `dtype: "q8"` explicitly. Also expose `fp16` as an option — on some WebGPU devices fp16 is faster than q8. Make `DTYPE` a UI dropdown too (q8 / fp16 / fp32).

---

## 3. Backend detection & fallback

On startup, detect WebGPU and configure the pipeline accordingly:

```js
async function pickDevice() {
  if (navigator.gpu) {
    try { await navigator.gpu.requestAdapter(); return "webgpu"; }
    catch { return "wasm"; }
  }
  return "wasm";
}
```

- Create the pipeline with `{ device, dtype }`.
- Show the resolved backend in the UI status line (e.g. `Backend: webgpu · Model: yolos-tiny · dtype: q8`). This matters for the FPS study — WebGPU vs WASM is one of the variables being measured.
- **Note for Safari/iPad:** WebGPU may be behind a feature flag. The WASM fallback must work without any flags so field testing on an unmodified iPad is possible.

---

## 4. Live camera loop

Replace the upload-driven analysis with a continuous loop.

1. **Camera:** `getUserMedia({ video: { facingMode: "environment" }, audio: false })` — rear camera, matching the predecessor sketch. Keep the existing "capture from camera" plumbing if the repo already has it; just make it continuous instead of single-shot.
2. **Single-in-flight guard** (critical — copy this pattern from the predecessor sketch): never start a new inference while one is running.
   ```js
   let busy = false;
   async function tick() {
     if (busy) return;
     busy = true;
     const t0 = performance.now();
     const detections = await detector(frameCanvas, { threshold: CONF_THRESHOLD });
     const t1 = performance.now();
     recordFrame(detections, t0, t1);   // §5, §6
     busy = false;
   }
   ```
3. **Drive the loop with `requestAnimationFrame`**, not a fixed `setInterval`. The guard makes the *effective* rate self-throttle to whatever the hardware sustains — which is exactly what we want to measure. (The old sketch used `setInterval(…, 200)` aiming for 5/s; we improve on this by letting it run as fast as it can and measuring the real rate.)
4. Feed the model a frame from an offscreen canvas sized to the video. Keep the canvas dimensions in a variable — bbox coordinates are relative to this size and we need it for normalization (§6).

---

## 5. FPS / inference-rate measurement (a research deliverable, not just a debug readout)

The professor explicitly asked "how fast can it classify — can it infer twice a second?" So make timing a first-class, visible, exportable metric.

Track and display:
- **Instantaneous inference time** per frame: `t1 - t0` (ms).
- **Rolling average inference time** over the last ~30 frames.
- **Effective FPS** = `1000 / rollingAvgMs` (this is the honest number — inferences actually completed per second).
- **Frame count** this session.

Show these live in an on-screen overlay panel. Also include per-row inference time in the exported data (§6) so the rate can be analyzed against location, model, and device after the fact.

---

## 6. Data logging & schema

Maintain an in-memory array `log[]`. **Log one row per detected object** (not per frame) — a frame with 3 detected objects produces 3 rows, each sharing the frame's timestamp/GPS but carrying its own label/confidence/bbox.

Target schema (this is the agreed target — build to it exactly):

```js
{
  timestamp,      // Date.now() — ms epoch, when the inference completed
  recording_id,   // 1, 2, 3… — which Start → Stop Recording this row belongs to; restarts at 1 after Clear recordings
  lat,            // number, 8 decimal places (match predecessor precision)
  lon,            // number, 8 decimal places
  gps_accuracy,   // meters, from position.coords.accuracy  (NEW — important, see note)
  gps_timestamp,  // ms epoch of the GPS fix itself (so staleness vs inference is knowable)
  model,          // MODEL_ID string
  dtype,          // "q8" | "fp16" | "fp32"
  device,         // "webgpu" | "wasm"
  label,          // detected class string
  confidence,     // number 0–1, 3 decimals on export
  bbox,           // { xmin, ymin, xmax, ymax } in PIXELS relative to canvas
  bbox_norm,      // { xmin, ymin, xmax, ymax } normalized 0–1 (divide by canvas w/h)
  frame_w,        // canvas width  in px  (so pixel bbox can be reinterpreted later)
  frame_h,        // canvas height in px
  inference_ms    // t1 - t0 for the frame this detection came from
}
```

Notes:
- **Transformers.js detection output shape** is an array of `{ score, label, box: { xmin, ymin, xmax, ymax } }`. Map `score → confidence`, `box → bbox`. The box is already in pixel coordinates relative to the input image, so also compute `bbox_norm` by dividing by `frame_w`/`frame_h`.
- Store **both** pixel and normalized bbox. Pixel is what the model gives; normalized is device/resolution-independent and is what the AR/3D stage will want.
- Keep `caption` out of scope for now (the schema allowed `caption?` as optional — leave a code comment noting it's a future field, don't implement it).
- **Recordings:** each Start Recording → Stop Recording is one recording. CSV and JSON carry `recording_id` right after `timestamp`. JSON exports also include a `recordings` array with one entry per exported recording: `{ recording_id, start_time, end_time, model, row_count }`. Times are ms epoch; `end_time` is `null` while recording; `model` is the model active at Start Recording.
- **GPS accuracy is new and matters:** browser GPS is often ±5–20 m. Logging `gps_accuracy` lets us (a) judge how trustworthy the coordinate is and (b) set movement-based sampling thresholds sensibly. Do not drop it.

### GPS handling
- Use `navigator.geolocation.getCurrentPosition` with `{ enableHighAccuracy: true, timeout: 8000, maximumAge: 2000 }`.
- Refresh on an interval (the old sketch used 5 s). **Make the interval a constant** `GPS_REFRESH_MS = 3000` and comment that lowering it gives denser spatial data at battery cost.
- Cache the latest fix (`lat`, `lon`, `accuracy`, fix timestamp) in module scope; each logged row reads the cached fix. Show current fix + accuracy in the status overlay.
- If no fix yet, log the row with `lat/lon = null` rather than skipping the detection.

---

## 7. Sampling policy (build the raw capture + filtered export model)

**Capture everything raw. Sampling is an export-time filter, never a capture-time drop.** This preserves the label "flicker" that is the whole point of the study, while still letting us produce clean datasets.

Implement a **Recording toggle** (START/STOP), matching the predecessor UX. While recording, every detection row goes into `log[]` unfiltered (except the confidence threshold used for drawing, which should be low — e.g. 0.3 — and configurable).

On export, offer these **filter modes** (radio buttons or dropdown), applied as a pure function over `log[]`:

1. **Raw** — every row. (Always keep this available; it's the ground truth for the FPS/instability analysis.)
2. **Change-triggered** — keep a row only when the set of labels at that location changes from the previous frame. Best for a legible "what did it call things along the walk" map.
3. **Movement-triggered** — keep rows only when GPS has moved > `MOVE_THRESHOLD_M` meters since the last kept row. Default `MOVE_THRESHOLD_M = 5`. **Comment that this threshold should be tuned against `gps_accuracy`** — a 2 m threshold is meaningless if accuracy is ±15 m.
4. **Time-decimated** — cap at `MAX_ROWS_PER_SEC = 1` for even temporal spacing.

Default the UI to **Raw**, since this is the first field test and we want to see everything. The other modes are there to demonstrate the "label density" variable to the professor.

Use the haversine formula for the movement filter (small helper function; coordinates are close together so a simple equirectangular approximation is also fine — comment which one you used).

---

## 8. Export

Two buttons: **Export CSV** and **Export JSON**.

- **CSV:** flat columns in the schema order of §6. Quote the `label` field and escape embedded quotes (the old sketch did `""` escaping — keep that). `bbox` and `bbox_norm` should be split into columns (`bbox_xmin`, `bbox_ymin`, …, `bbox_norm_xmin`, …) so the CSV stays flat and spreadsheet/Blender-friendly. Confidence to 3 decimals, lat/lon to 8.
- **JSON:** the array of row objects exactly as in §6 (nested `bbox`/`bbox_norm` objects preserved). Also include a small **metadata header object**: `{ exported_at, model, dtype, device, filter_mode, row_count, session_start }`.
- Filenames: `live-detection-rec<N>-<YYYYMMDD-HHMMSS>.csv` / `.json` for one recording, `live-detection-all-<YYYYMMDD-HHMMSS>.csv` / `.json` for all recordings.
- Trigger download via Blob + object URL (same mechanism the old sketch used).

Both exports respect the currently selected filter mode (§7), except keep a dedicated **"Export Raw JSON"** path that always dumps everything regardless of filter, so raw data is never lost.

---

## 9. UI (keep it minimal, field-usable)

Full-viewport video with canvas overlay on top. Overlaid, semi-transparent info panels (reuse the existing tool's styling where possible):

- **Top-left status:** backend, model, dtype, GPS fix + accuracy.
- **Top-left metrics:** effective FPS, avg inference ms, frame count, detections-this-frame.
- **Controls:** model dropdown, dtype dropdown, confidence-threshold slider, GPS refresh (optional), Recording START/STOP, filter-mode selector, Export CSV / Export JSON / Export Raw JSON.
- **On the canvas:** draw each detection's bounding box + label + confidence. Use a legible color with a filled label background (the environment behind is a live camera feed, so ensure contrast). Boxes should be drawn every frame from the latest detections.

Design for **touch on iPad**: large tap targets, no hover-only controls.

---

## 10. Explicitly out of scope for this build

Do **not** add: Blender/Python export, USDZ/USD, any 3D scene, AR anchoring, captioning (BLIP), emotion/color/composition analysis from the old tool (can be stripped or hidden), or any server component. Those are later phases. Keep this build focused on: **live detection → measured FPS → GPS-tagged logging → CSV/JSON export.**

---

## 11. Acceptance checklist (Cursor should be able to answer "yes" to each)

- [ ] App loads a quantized Transformers.js object-detection model, WebGPU with WASM fallback, and shows which backend resolved.
- [ ] Rear camera runs a continuous detection loop with a single-in-flight guard; no queue build-up.
- [ ] Bounding boxes + labels + confidence render live on the video every frame.
- [ ] An on-screen panel shows effective FPS and average inference time; these update continuously.
- [ ] Each detected object logs a row matching the §6 schema, including timestamp, GPS + accuracy, model/dtype/device, pixel and normalized bbox, and per-frame inference time.
- [ ] Recording START/STOP works; low-confidence detections are preserved, not filtered.
- [ ] Export produces valid CSV and JSON; a raw-JSON path always dumps everything; filter modes (raw / change / movement / time) work at export time.
- [ ] Model and dtype can be switched at runtime and the change is reflected in logged rows.
- [ ] Runs on an unmodified iPad (via WASM fallback) without requiring any browser flags.
