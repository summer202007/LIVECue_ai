const activeStreams = new Map();

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type === "LIVE_CUE_START_TAB_AUDIO_STREAM") {
    startTabAudioStream(message.payload)
      .then(sendResponse)
      .catch((error) => sendResponse({ ok: false, error: normalizeError(error) }));
    return true;
  }

  if (message?.type === "LIVE_CUE_STOP_TAB_AUDIO_STREAM") {
    stopTabAudioStream(message.payload?.sessionId);
    sendResponse({ ok: true });
    return true;
  }

  return false;
});

async function startTabAudioStream({ tabId, sessionId, streamId, segmentMs, relayUrl, asrApiKey, language }) {
  if (!sessionId) throw new Error("Missing session id.");
  if (!streamId) throw new Error("Missing tab capture stream id.");
  if (!relayUrl) throw new Error("Missing ASR relay URL.");
  if (!asrApiKey) throw new Error("Missing Doubao ASR API key.");

  stopTabAudioStream(sessionId);

  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: "tab",
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  const state = {
    tabId,
    sessionId,
    stream,
    segmentMs: segmentMs || 20000,
    relayUrl,
    asrApiKey,
    language: language || "zh-CN",
    stopped: false,
    index: 0
  };
  activeStreams.set(sessionId, state);
  recordLoop(state);
  return { ok: true };
}

function stopTabAudioStream(sessionId) {
  const state = activeStreams.get(sessionId);
  if (!state) return;
  state.stopped = true;
  try {
    state.recorder?.state !== "inactive" && state.recorder?.stop();
  } catch {
    // ignore
  }
  state.stream?.getTracks().forEach((track) => track.stop());
  activeStreams.delete(sessionId);
}

async function recordLoop(state) {
  while (!state.stopped) {
    const index = state.index++;
    try {
      const result = await recordOneSegment(state, index);
      await chrome.runtime.sendMessage({
        type: "LIVE_CUE_ASR_RESULT",
        tabId: state.tabId,
        sessionId: state.sessionId,
        trigger: `offscreen_segment_${index}`,
        result
      });
    } catch (error) {
      if (!state.stopped) {
        await chrome.runtime.sendMessage({
          type: "LIVE_CUE_ASR_ERROR",
          tabId: state.tabId,
          sessionId: state.sessionId,
          trigger: `offscreen_segment_${index}`,
          error: normalizeError(error)
        });
      }
    }
  }
}

async function recordOneSegment(state, index) {
  const chunks = [];
  const recorder = new MediaRecorder(state.stream, { mimeType: pickMimeType() });
  state.recorder = recorder;
  const startedAt = new Date().toISOString();

  recorder.addEventListener("dataavailable", (event) => {
    if (event.data?.size) chunks.push(event.data);
  });

  await new Promise((resolve, reject) => {
    recorder.addEventListener("stop", resolve, { once: true });
    recorder.addEventListener("error", () => reject(recorder.error || new Error("MediaRecorder error")), { once: true });
    recorder.start(1000);
    setTimeout(() => recorder.state !== "inactive" && recorder.stop(), state.segmentMs);
  });

  if (state.stopped) throw new Error("ASR stream stopped.");

  const blob = new Blob(chunks, { type: recorder.mimeType || "audio/webm" });
  const audioDataUrl = await blobToDataUrl(blob);
  const response = await fetch(state.relayUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      audioDataUrl,
      mimeType: blob.type,
      apiKey: state.asrApiKey,
      language: state.language,
      startedAt,
      index
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || `ASR relay failed: HTTP ${response.status}`);
  }
  return { ...body, index, startedAt: body.startedAt || startedAt };
}

function pickMimeType() {
  const candidates = [
    "audio/webm;codecs=opus",
    "audio/webm",
    "audio/mp4"
  ];
  return candidates.find((type) => MediaRecorder.isTypeSupported(type)) || "";
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error("Failed to read audio blob."));
    reader.readAsDataURL(blob);
  });
}

function normalizeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}
