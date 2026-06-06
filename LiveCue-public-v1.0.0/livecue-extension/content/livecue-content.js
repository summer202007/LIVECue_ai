(() => {
  if (window.__liveCueInjected) return;
  window.__liveCueInjected = true;

  const LIBRARY_STORAGE_KEY = "livecue.skillLibrary";
  const LANGUAGE_STORAGE_KEY = "livecue.language";

  const CATEGORY_LABELS = {
    welcome: { label: "Welcome viewers", cls: "welcome" },
    reply_comment: { label: "Comment response", cls: "reply" },
    room_atmosphere: { label: "Room energy", cls: "vibe" },
    gift_guidance: { label: "Gift guidance", cls: "gift" },
    pk_mobilization: { label: "PK mobilization", cls: "reply" },
    persona_design: { label: "Persona building", cls: "welcome" },
    scene_design: { label: "Scene design", cls: "vibe" },
    composition_lighting: { label: "Framing and lighting", cls: "vibe" },
    viewer_psychology: { label: "Audience psychology", cls: "reply" },
    host_commitment: { label: "Host promise", cls: "welcome" },
    scripted_room_event: { label: "Scripted event", cls: "gift" },
    content_richness: { label: "Content richness", cls: "vibe" },
    performance_interaction_loop: { label: "Performance interaction", cls: "gift" }
  };

  const FOCUS_TAGS = [
    { id: "interaction", label: "Interaction", hint: "评论承接、点名、互动循环" },
    { id: "comment_response", label: "Comment response", hint: "把评论转成对话" },
    { id: "welcome", label: "Welcome viewers", hint: "欢迎进房与破冰" },
    { id: "gift_guidance", label: "Gift guidance", hint: "礼物感谢与关系维护" },
    { id: "pk", label: "PK moments", hint: "PK 目标、倒计时、动员" },
    { id: "pet_hooks", label: "Pet hooks", hint: "宠物作为互动钩子" },
    { id: "persona", label: "Persona", hint: "人设感和记忆点" },
    { id: "scene", label: "Scene design", hint: "背景、道具、主题场景" },
    { id: "lighting", label: "Framing & lighting", hint: "构图、灯光、清晰度" },
    { id: "content_richness", label: "Content richness", hint: "信息量、主题切换、编排" }
  ];

  const state = {
    open: false,
    status: "idle",
    room: readRoomContext(),
    skills: [],
    activeSkillId: "",
    savedSkillIds: new Set(),
    librarySkills: [],
    libraryOpen: false,
    selectedFocusIds: new Set(["interaction", "pet_hooks"]),
    language: "en",
    focusDropdownOpen: false,
    debugOpen: false,
    configRequired: false,
    missingKeys: [],
    trace: [],
    latestSkillUpdate: null,
    lastUrl: location.href,
    lastRoomSignature: ""
  };

  const pageAsrStreams = new Map();

  const root = document.createElement("div");
  root.id = "livecue-root";
  document.documentElement.appendChild(root);

  chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
    if (message?.type === "LIVE_CUE_COLLECT_HTML") {
      collectHtmlSnapshot(message.payload || {}).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: { message: error.message } });
      });
      return true;
    }
    if (message?.type === "LIVE_CUE_START_PAGE_ASR") {
      startPageAsr(message.payload || {}).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: { message: error.message } });
      });
      return true;
    }
    if (message?.type === "LIVE_CUE_CAPTURE_VIDEO_FRAME") {
      captureVideoFrame(message.payload || {}).then(sendResponse).catch((error) => {
        sendResponse({ ok: false, error: { message: error.message } });
      });
      return true;
    }
    if (message?.type === "LIVE_CUE_STOP_PAGE_ASR") {
      stopPageAsr(message.payload?.sessionId);
      sendResponse({ ok: true });
      return true;
    }
    if (message?.type === "LIVE_CUE_STATUS_UPDATE") {
      const before = renderSignature();
      applyPublicState(message.payload);
      if (canPatchRender(before, renderSignature())) {
        refreshDebugTrace();
        refreshStatusBar();
        refreshCollapsedTab();
      } else {
        render();
      }
    }
    if (message?.type === "LIVE_CUE_OPEN_PANEL") {
      state.open = true;
      render();
    }
    if (message?.type === "LIVE_CUE_SKILL_UPDATE") {
      state.latestSkillUpdate = message.payload;
      state.skills = mergeSkills(state.skills, message.payload?.skills || [])
        .filter((skill) => !state.savedSkillIds.has(libraryIdForSkill(skill)));
      state.status = "learning_active";
      state.open = true;
      render();
    }
    if (message?.type === "LIVE_CUE_CONFIG_REQUIRED") {
      state.configRequired = true;
      state.missingKeys = message.payload?.missingKeys || [];
      state.open = true;
      applyPublicState(message.payload?.state);
      render();
    }
  });

  boot();

  async function boot() {
    await loadLibrary();
    await loadLanguage();
    const response = await send({ type: "LIVE_CUE_GET_STATE" });
    if (response?.ok) applyPublicState(response.state);
    state.lastRoomSignature = roomSignature(state.room);
    installUrlWatcher();
    render();
  }

  async function collectHtmlSnapshot(payload) {
    const extractor = window.LiveCueTikTokExtractor;
    if (!extractor?.extractTikTokLive) {
      throw new Error("TikTok extractor is not loaded in content script.");
    }
    await extractor.waitForTikTokLiveHydration?.(document, payload.waitMs || 1500);
    return {
      ok: true,
      snapshot: extractor.extractTikTokLive(document, window, {
        maxComments: payload.maxComments || 40,
        includeRaw: Boolean(payload.includeRaw)
      })
    };
  }

  async function startPageAsr({ sessionId, segmentMs, relayUrl, asrApiKey, language }) {
    if (!sessionId) throw new Error("Missing session id.");
    if (!relayUrl) throw new Error("Missing ASR relay URL.");
    if (!asrApiKey) throw new Error("Missing Doubao ASR API key.");
    const AudioContextCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioContextCtor) throw new Error("This browser does not support Web Audio API for page ASR.");
    stopPageAsr(sessionId);

    const video = findLiveVideoElement();
    if (!video) throw new Error("No playable TikTok LIVE video element found for ASR.");
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture) throw new Error("This browser does not support video.captureStream().");

    const capturedStream = capture.call(video);
    const audioTracks = capturedStream.getAudioTracks();
    if (!audioTracks.length) throw new Error("Captured video stream has no audio track.");
    const stream = new MediaStream(audioTracks);

    const asrState = {
      sessionId,
      stream,
      audioContext: null,
      AudioContextCtor,
      sourceNode: null,
      segmentMs: segmentMs || 20000,
      relayUrl,
      asrApiKey,
      language: language || "zh-CN",
      stopped: false,
      index: 0
    };
    pageAsrStreams.set(sessionId, asrState);
    recordPageAsrLoop(asrState);
    return { ok: true, mode: "page_video_capture", audioTrackCount: audioTracks.length };
  }

  async function captureVideoFrame({ maxWidth = 1024, quality = 0.72 }) {
    const video = findLiveVideoElement();
    if (!video) throw new Error("No playable TikTok LIVE video element found for vision capture.");
    const width = video.videoWidth || video.clientWidth;
    const height = video.videoHeight || video.clientHeight;
    if (!width || !height) throw new Error("Live video dimensions are not ready for vision capture.");
    const scale = Math.min(1, maxWidth / width);
    const canvas = document.createElement("canvas");
    canvas.width = Math.max(16, Math.round(width * scale));
    canvas.height = Math.max(16, Math.round(height * scale));
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas is unavailable for vision capture.");
    let imageDataUrl = "";
    try {
      context.drawImage(video, 0, 0, canvas.width, canvas.height);
      imageDataUrl = canvas.toDataURL("image/jpeg", quality);
    } catch (error) {
      imageDataUrl = await captureVideoFrameFromStream(video, canvas.width, canvas.height, quality, error);
    }
    if (!imageDataUrl || imageDataUrl.length < 200) throw new Error("Video frame capture produced an empty image.");
    return {
      ok: true,
      source: "page_video_frame",
      imageDataUrl,
      width: canvas.width,
      height: canvas.height
    };
  }

  async function captureVideoFrameFromStream(video, width, height, quality, originalError) {
    const capture = video.captureStream || video.mozCaptureStream;
    if (!capture || typeof ImageCapture === "undefined") {
      throw originalError;
    }
    const stream = capture.call(video);
    const [track] = stream.getVideoTracks();
    if (!track) throw originalError;
    try {
      const bitmap = await new ImageCapture(track).grabFrame();
      const canvas = document.createElement("canvas");
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext("2d");
      if (!context) throw originalError;
      context.drawImage(bitmap, 0, 0, width, height);
      return canvas.toDataURL("image/jpeg", quality);
    } finally {
      track.stop();
    }
  }

  function stopPageAsr(sessionId) {
    const asrState = pageAsrStreams.get(sessionId);
    if (!asrState) return;
    asrState.stopped = true;
    try {
      asrState.recorder?.state !== "inactive" && asrState.recorder?.stop();
    } catch {
      // ignore
    }
    asrState.stream?.getTracks().forEach((track) => track.stop());
    try {
      asrState.processor?.disconnect();
    } catch {
      // ignore
    }
    try {
      asrState.silentGain?.disconnect();
    } catch {
      // ignore
    }
    try {
      asrState.sourceNode?.disconnect();
    } catch {
      // ignore
    }
    try {
      asrState.audioContext?.close?.();
    } catch {
      // ignore
    }
    pageAsrStreams.delete(sessionId);
  }

  async function recordPageAsrLoop(asrState) {
    while (!asrState.stopped) {
      const index = asrState.index++;
      try {
        const result = await recordPageAsrSegment(asrState, index);
        await send({
          type: "LIVE_CUE_ASR_RESULT",
          sessionId: asrState.sessionId,
          trigger: `page_video_segment_${index}`,
          result
        });
      } catch (error) {
        if (!asrState.stopped) {
          const normalizedError = {
            name: error?.name || "Error",
            message: error?.message || String(error),
            stack: error?.stack || null
          };
          await sendAsrDiagnostic(asrState, "asr_page_segment_error", {
            index,
            errorName: normalizedError.name,
            errorMessage: normalizedError.message
          });
          await send({
            type: "LIVE_CUE_ASR_ERROR",
            sessionId: asrState.sessionId,
            trigger: `page_video_segment_${index}`,
            error: normalizedError
          }).catch(() => null);
          await sleep(1000);
        }
      }
    }
  }

  async function recordPageAsrSegment(asrState, index) {
    await sendAsrDiagnostic(asrState, "asr_page_segment_start", {
      index,
      segmentMs: asrState.segmentMs,
      relayUrl: asrState.relayUrl
    });
    if (!asrState.audioContext || asrState.audioContext.state === "closed") {
      asrState.audioContext = new asrState.AudioContextCtor();
      asrState.sourceNode = asrState.audioContext.createMediaStreamSource(asrState.stream);
    }
    if (asrState.audioContext.state === "suspended") {
      await asrState.audioContext.resume().catch(() => {});
    }
    if (asrState.audioContext.state === "closed") {
      throw new Error("Page ASR AudioContext is closed.");
    }

    const inputSampleRate = asrState.audioContext.sampleRate;
    await sendAsrDiagnostic(asrState, "asr_page_audio_context", {
      index,
      state: asrState.audioContext.state,
      inputSampleRate,
      audioTrackCount: asrState.stream?.getAudioTracks?.().length || 0
    });
    const chunks = [];
    const processor = asrState.audioContext.createScriptProcessor(4096, 1, 1);
    const silentGain = asrState.audioContext.createGain();
    silentGain.gain.value = 0;
    asrState.processor = processor;
    asrState.silentGain = silentGain;
    const startedAt = new Date().toISOString();
    processor.onaudioprocess = (event) => {
      if (!asrState.stopped) {
        chunks.push(new Float32Array(event.inputBuffer.getChannelData(0)));
      }
    };

    await new Promise((resolve, reject) => {
      try {
        asrState.sourceNode.connect(processor);
        processor.connect(silentGain);
        silentGain.connect(asrState.audioContext.destination);
        setTimeout(resolve, asrState.segmentMs);
      } catch (error) {
        reject(error);
      }
    });
    try {
      processor.disconnect();
    } catch {
      // ignore
    }
    try {
      silentGain.disconnect();
    } catch {
      // ignore
    }
    try {
      asrState.sourceNode.disconnect(processor);
    } catch {
      // ignore
    }
    asrState.processor = null;
    asrState.silentGain = null;

    if (asrState.stopped) throw new Error("Page ASR stopped.");
    await sendAsrDiagnostic(asrState, "asr_page_samples_collected", {
      index,
      chunkCount: chunks.length,
      sampleCount: chunks.reduce((sum, chunk) => sum + chunk.length, 0)
    });
    if (!chunks.length) throw new Error("Page ASR captured no audio samples.");
    const pcm16 = encodePcm16(downsampleTo16k(concatFloat32(chunks), inputSampleRate));
    await sendAsrDiagnostic(asrState, "asr_page_relay_request", {
      index,
      outputSampleRate: 16000,
      pcmBytes: pcm16.byteLength
    });
    const response = await fetch(asrState.relayUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pcm16Base64: arrayBufferToBase64(pcm16.buffer),
        sampleRate: 16000,
        apiKey: asrState.asrApiKey,
        language: asrState.language,
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

  function sendAsrDiagnostic(asrState, step, metadata) {
    return send({
      type: "LIVE_CUE_ASR_DIAGNOSTIC",
      sessionId: asrState.sessionId,
      step,
      status: "ok",
      metadata
    });
  }

  function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  function findLiveVideoElement() {
    return Array.from(document.querySelectorAll("video"))
      .filter((video) => video.readyState >= 2 && (!video.paused || video.clientWidth * video.clientHeight > 0) && (video.srcObject !== null || video.src || video.currentSrc))
      .sort((a, b) => (b.clientWidth * b.clientHeight) - (a.clientWidth * a.clientHeight))[0] || null;
  }

  function concatFloat32(chunks) {
    const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
    const output = new Float32Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  }

  function downsampleTo16k(samples, inputSampleRate) {
    const outputSampleRate = 16000;
    if (inputSampleRate === outputSampleRate) return samples;
    const ratio = inputSampleRate / outputSampleRate;
    const outputLength = Math.floor(samples.length / ratio);
    const output = new Float32Array(outputLength);
    for (let i = 0; i < outputLength; i += 1) {
      const start = Math.floor(i * ratio);
      const end = Math.min(Math.floor((i + 1) * ratio), samples.length);
      let sum = 0;
      for (let j = start; j < end; j += 1) sum += samples[j];
      output[i] = sum / Math.max(1, end - start);
    }
    return output;
  }

  function encodePcm16(samples) {
    const output = new Int16Array(samples.length);
    for (let i = 0; i < samples.length; i += 1) {
      const sample = Math.max(-1, Math.min(1, samples[i]));
      output[i] = sample < 0 ? sample * 0x8000 : sample * 0x7fff;
    }
    return output;
  }

  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    const chunkSize = 0x8000;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
  }

  function render() {
    root.innerHTML = "";
    root.appendChild(renderCollapsedTab());
    root.appendChild(renderPanel());
  }

  function renderCollapsedTab() {
    const tab = el("button", {
      class: `lc-collapsed-tab ${state.status === "learning_active" ? "ready" : ""}`,
      title: state.status === "learning_active" ? "View learnings" : "Learn from this creator",
      onclick: () => {
        state.open = true;
        render();
      }
    });
    tab.innerHTML = `
      <span class="lc-tab-mark"><b></b></span>
      <span class="lc-tab-label">${state.status === "learning_active" ? "View learnings" : "Learn from this creator"}</span>
      ${state.skills.length ? `<em>${state.skills.length}</em>` : ""}
    `;
    return tab;
  }

  function renderPanel() {
    const panel = el("aside", { class: `lc-panel ${state.open ? "open" : ""}` });
    panel.innerHTML = `
      <header class="lc-head">
        <div class="lc-brand">
          <strong>LiveCue</strong>
          <span>Watch & Learn</span>
        </div>
        <button class="lc-setup" aria-label="Open setup">Setup</button>
        <button class="lc-close" aria-label="Close">×</button>
      </header>
      <section class="lc-body"></section>
      <footer class="lc-status-bar"></footer>
    `;
    panel.querySelector(".lc-close").addEventListener("click", () => {
      state.open = false;
      state.activeSkillId = "";
      render();
    });
    panel.querySelector(".lc-setup").addEventListener("click", openSetup);
    const body = panel.querySelector(".lc-body");
    if (state.configRequired) body.appendChild(renderConfigPrompt());
    else if (state.activeSkillId) body.appendChild(renderDetail());
    else body.appendChild(renderSkillList());

    panel.querySelector(".lc-status-bar").appendChild(renderStatusBar());
    return panel;
  }

  function renderConfigPrompt() {
    const box = el("div", { class: "lc-config" });
    const missing = state.missingKeys.length
      ? `<p class="lc-config-missing">Missing: ${state.missingKeys.map(escapeHtml).join(", ")}</p>`
      : "";
    box.innerHTML = `
      <div class="lc-config-card">
        <span class="lc-mark lg"><b></b></span>
        <h3>Setup needed</h3>
        <p>Choose models, paste keys, and run readiness checks before LiveCue starts learning.</p>
        ${missing}
        <div class="lc-config-actions">
          <button class="primary">Open setup</button>
        </div>
      </div>
    `;
    box.querySelector(".primary").addEventListener("click", openSetup);
    return box;
  }

  function renderSkillList() {
    const wrap = el("div", { class: "lc-list-wrap" });
    wrap.innerHTML = `
      <section class="lc-library-card"></section>
      <section class="lc-focus-card"></section>
      <div class="lc-section-head">
        <h2>This stream · ${state.skills.length} skills</h2>
        <div class="lc-language-toggle" aria-label="Skill language">
          <button class="${state.language === "en" ? "on" : ""}" data-lang="en">EN</button>
          <button class="${state.language === "zh" ? "on" : ""}" data-lang="zh">CN</button>
        </div>
      </div>
      <div class="lc-chips">
        <button class="on">All</button>
        <button><i class="dot welcome"></i>Welcome viewers</button>
        <button><i class="dot reply"></i>Comment response</button>
        <button><i class="dot gift"></i>Gift guidance</button>
      </div>
      <div class="lc-skills"></div>
      <details class="lc-debug">
        <summary>Debug trace</summary>
        <div class="lc-debug-actions"><button class="export">Export JSON</button></div>
        <pre></pre>
      </details>
    `;
    const debug = wrap.querySelector(".lc-debug");
    debug.open = state.debugOpen;
    debug.addEventListener("toggle", () => {
      state.debugOpen = debug.open;
    });
    renderLibrary(wrap.querySelector(".lc-library-card"));
    renderFocusPicker(wrap.querySelector(".lc-focus-card"));
    wrap.querySelectorAll("[data-lang]").forEach((button) => {
      button.addEventListener("click", async () => {
        state.language = button.dataset.lang === "zh" ? "zh" : "en";
        await persistLanguage();
        render();
      });
    });
    const list = wrap.querySelector(".lc-skills");
    if (!state.skills.length) {
      list.appendChild(renderEmptyState());
    } else {
      state.skills.forEach((skill) => list.appendChild(renderSkillCard(skill)));
    }
    refreshDebugTrace(wrap);
    wrap.querySelector(".lc-debug .export").addEventListener("click", exportDebug);
    return wrap;
  }

  function renderLibrary(container) {
    const count = state.librarySkills.length;
    container.innerHTML = `
      <button class="lc-library-summary" aria-expanded="${state.libraryOpen ? "true" : "false"}">
        <span>
          <b>Saved skills</b>
          <em>${count ? `${count} high-value skills saved` : "No saved skills yet"}</em>
        </span>
        <strong>${state.libraryOpen ? "Hide" : "View"}</strong>
      </button>
      ${state.libraryOpen ? `
        <div class="lc-library-list">
          ${count ? state.librarySkills.map(renderLibraryItemHtml).join("") : `<p class="lc-library-empty">Saved skills will keep their creator source here.</p>`}
        </div>
      ` : ""}
    `;
    container.querySelector(".lc-library-summary").addEventListener("click", () => {
      state.libraryOpen = !state.libraryOpen;
      render();
    });
    container.querySelectorAll("[data-library-profile]").forEach((link) => {
      link.addEventListener("click", (event) => {
        event.stopPropagation();
      });
    });
  }

  function renderLibraryItemHtml(skill) {
    const category = CATEGORY_LABELS[skill.category] || { label: skill.category || "Skill", cls: "reply" };
    const source = sourceFromSkill(skill);
    const text = localizedSkillText(skill);
    return `
      <details class="lc-library-item ${category.cls}">
        <summary>
          <span><i class="dot ${category.cls}"></i>${escapeHtml(text.title || "Saved skill")}</span>
          <em>${escapeHtml(source.label)}</em>
        </summary>
        <div class="lc-library-detail">
          <p>${escapeHtml(text.action || "")}</p>
          <dl>
            <div><dt>${state.language === "zh" ? "场景" : "Scene"}</dt><dd>${escapeHtml(text.scenario || "")}</dd></div>
            <div><dt>${state.language === "zh" ? "效果" : "Effect"}</dt><dd>${escapeHtml(text.effect || "")}</dd></div>
          </dl>
          ${source.profileUrl ? `<a data-library-profile href="${escapeAttribute(source.profileUrl)}" target="_blank" rel="noreferrer">Go to creator profile →</a>` : ""}
        </div>
      </details>
    `;
  }

  function renderFocusPicker(container) {
    const selected = selectedFocusTags();
    container.innerHTML = `
      <div class="lc-focus-head">
        <div>
          <span>Learning focus</span>
          <h3>${selected.length ? selected.map((tag) => tag.label).join(", ") : "General"}</h3>
        </div>
        <button class="lc-focus-toggle" aria-expanded="${state.focusDropdownOpen ? "true" : "false"}">
          ${state.focusDropdownOpen ? "Close" : "Edit"}
        </button>
      </div>
      <div class="lc-focus-selected">
        ${selected.length
          ? selected.map((tag) => `<button class="lc-focus-pill" data-remove-focus="${tag.id}">${escapeHtml(tag.label)}<b>×</b></button>`).join("")
          : `<span class="lc-focus-placeholder">No focus selected. Skill extraction will stay general.</span>`}
      </div>
      ${state.focusDropdownOpen ? `
        <div class="lc-focus-menu">
          ${FOCUS_TAGS.map((tag) => {
            const checked = state.selectedFocusIds.has(tag.id);
            return `
              <label class="${checked ? "checked" : ""}">
                <input type="checkbox" data-focus-id="${tag.id}" ${checked ? "checked" : ""} />
                <span>
                  <b>${escapeHtml(tag.label)}</b>
                  <em>${escapeHtml(tag.hint)}</em>
                </span>
              </label>
            `;
          }).join("")}
        </div>
      ` : ""}
    `;

    container.querySelector(".lc-focus-toggle").addEventListener("click", () => {
      state.focusDropdownOpen = !state.focusDropdownOpen;
      render();
    });
    container.querySelectorAll("[data-remove-focus]").forEach((button) => {
      button.addEventListener("click", () => {
        state.selectedFocusIds.delete(button.dataset.removeFocus);
        render();
      });
    });
    container.querySelectorAll("[data-focus-id]").forEach((input) => {
      input.addEventListener("change", () => {
        if (input.checked) state.selectedFocusIds.add(input.dataset.focusId);
        else state.selectedFocusIds.delete(input.dataset.focusId);
        render();
      });
    });
  }

  function renderEmptyState() {
    const empty = el("div", { class: "lc-empty" });
    if (!isCurrentTikTokLiveRoom()) {
      empty.innerHTML = `
        <span class="lc-mark lg"><b></b></span>
        <h3>Pick a LIVE room first</h3>
        <p>LiveCue is ready on TikTok. Open a livestream, then start learning from that room.</p>
        <button class="lc-open-live-main">Open TikTok LIVE</button>
      `;
      empty.querySelector(".lc-open-live-main").addEventListener("click", openTikTokLive);
    } else if (state.status === "learning_active" || state.status === "learning_starting") {
      empty.innerHTML = `
        <div class="lc-learning-kid" aria-hidden="true">
          <span class="kid-head"></span>
          <span class="kid-body"></span>
          <span class="kid-book"></span>
          <span class="kid-lens"></span>
          <span class="kid-spark one"></span>
          <span class="kid-spark two"></span>
        </div>
        <h3>Looking for learnable moments</h3>
        <p>Watching the room, reading comments, listening to speech, and checking the scene. First cards usually appear after about a minute.</p>
        <div class="lc-progress-rail"><i></i></div>
        <ul class="lc-learning-steps">
          <li>HTML signals</li>
          <li>Visual frames</li>
          <li>ASR speech</li>
          <li>Skill agent</li>
        </ul>
      `;
    } else {
      empty.innerHTML = `
        <span class="lc-mark lg"><b></b></span>
        <h3>Ready to learn</h3>
        <p>Start learning from this LIVE room. LiveCue will reset automatically if you leave or switch rooms.</p>
        <button class="lc-start-main">Start learning</button>
      `;
      empty.querySelector(".lc-start-main").addEventListener("click", startLearning);
    }
    return empty;
  }

  function renderSkillCard(skill) {
    const category = CATEGORY_LABELS[skill.category] || { label: skill.category || "Skill", cls: "reply" };
    const text = localizedSkillText(skill);
    const card = el("article", { class: `lc-skill-card ${category.cls}` });
    card.innerHTML = `
      <div class="lc-card-top">
        <span><i class="dot ${category.cls}"></i>${escapeHtml(category.label)}</span>
        <time>${escapeHtml(skill.timestamp || "")}</time>
      </div>
      <h3>${escapeHtml(text.title || "")}</h3>
      <p>${escapeHtml(text.action || "")}</p>
      <div class="lc-card-foot">
        <button class="view">View more →</button>
        <button class="save" title="Save">◇</button>
      </div>
    `;
    card.querySelector(".view").addEventListener("click", () => {
      state.activeSkillId = skill.skillId;
      render();
    });
    card.querySelector(".save").addEventListener("click", async () => {
      await saveSkillToLibrary(skill);
    });
    card.addEventListener("click", (event) => {
      if (event.target.closest("button")) return;
      state.activeSkillId = skill.skillId;
      render();
    });
    return card;
  }

  function renderDetail() {
    const skill = state.skills.find((item) => item.skillId === state.activeSkillId);
    if (!skill) {
      state.activeSkillId = "";
      return renderSkillList();
    }
    const category = CATEGORY_LABELS[skill.category] || { label: skill.category || "Skill", cls: "reply" };
    const text = localizedSkillText(skill);
    const detail = el("div", { class: `lc-detail ${category.cls}` });
    detail.innerHTML = `
      <button class="lc-back">‹ Back</button>
      <span class="lc-detail-cat"><i class="dot ${category.cls}"></i>${escapeHtml(category.label)}</span>
      <h2>${escapeHtml(text.title || "")}</h2>
      <div class="lc-sae">
        <section><b>${state.language === "zh" ? "场景" : "Scene"}</b><p>${escapeHtml(text.scenario || "")}</p></section>
        <section><b>${state.language === "zh" ? "动作" : "Action"}</b><p>${escapeHtml(text.action || "")}</p></section>
        <section><b>${state.language === "zh" ? "效果" : "Effect"}</b><p>${escapeHtml(text.effect || "")}</p></section>
      </div>
      <button class="lc-save-big">Save to library</button>
    `;
    detail.querySelector(".lc-back").addEventListener("click", () => {
      state.activeSkillId = "";
      render();
    });
    detail.querySelector(".lc-save-big").addEventListener("click", async () => {
      await saveSkillToLibrary(skill);
      state.activeSkillId = "";
      render();
    });
    return detail;
  }

  async function saveSkillToLibrary(skill) {
    const saved = enrichSkillForLibrary(skill);
    if (!state.savedSkillIds.has(saved.libraryId)) {
      state.librarySkills = [saved, ...state.librarySkills].slice(0, 100);
      state.savedSkillIds.add(saved.libraryId);
      await persistLibrary();
    }
    state.skills = state.skills.filter((item) => libraryIdForSkill(item) !== saved.libraryId);
    if (state.activeSkillId === skill.skillId) state.activeSkillId = "";
    state.libraryOpen = true;
    render();
  }

  function enrichSkillForLibrary(skill) {
    const source = sourceFromSkill(skill);
    return {
      ...skill,
      libraryId: libraryIdForSkill(skill),
      savedAt: new Date().toISOString(),
      sourceLive: {
        ...(skill.sourceLive || {}),
        liveUrl: skill.sourceLive?.liveUrl || state.room?.liveUrl || "",
        hostName: skill.sourceLive?.hostName || state.room?.handle || source.handle || "",
        streamerDisplayName: skill.sourceLive?.streamerDisplayName || state.room?.streamerDisplayName || ""
      }
    };
  }

  function sourceFromSkill(skill) {
    const handle = normalizeHandle(skill.sourceLive?.hostName || state.room?.handle || "");
    const displayName = skill.sourceLive?.streamerDisplayName || "";
    const label = displayName
      ? `${displayName}${handle ? ` (@${handle})` : ""}`
      : handle
        ? `@${handle}`
        : "Unknown creator";
    return {
      handle,
      label,
      profileUrl: handle ? `https://www.tiktok.com/@${encodeURIComponent(handle)}` : ""
    };
  }

  function libraryIdForSkill(skill) {
    const handle = normalizeHandle(skill.sourceLive?.hostName || state.room?.handle || "");
    return `${handle || "unknown"}::${skill.skillId || skill.title || skill.timestamp || "skill"}`;
  }

  async function loadLibrary() {
    const stored = await storageGet(LIBRARY_STORAGE_KEY);
    state.librarySkills = Array.isArray(stored) ? stored : [];
    state.savedSkillIds = new Set(state.librarySkills.map((skill) => skill.libraryId || libraryIdForSkill(skill)));
  }

  async function loadLanguage() {
    const stored = await storageGet(LANGUAGE_STORAGE_KEY);
    state.language = stored === "zh" ? "zh" : "en";
  }

  async function persistLibrary() {
    await storageSet(LIBRARY_STORAGE_KEY, state.librarySkills);
  }

  async function persistLanguage() {
    await storageSet(LANGUAGE_STORAGE_KEY, state.language);
  }

  function localizedSkillText(skill) {
    const localized = skill?.localized && typeof skill.localized === "object" ? skill.localized : {};
    const preferred = localized[state.language] && typeof localized[state.language] === "object" ? localized[state.language] : {};
    const fallbackLanguage = state.language === "zh" ? "en" : "zh";
    const fallback = localized[fallbackLanguage] && typeof localized[fallbackLanguage] === "object" ? localized[fallbackLanguage] : {};
    return {
      title: preferred.title || fallback.title || skill?.title || "",
      scenario: preferred.scenario || fallback.scenario || skill?.scenario || "",
      action: preferred.action || fallback.action || skill?.action || "",
      effect: preferred.effect || fallback.effect || skill?.effect || ""
    };
  }

  function renderStatusBar() {
    const bar = el("div", { class: "lc-status-inner" });
    const isLearning = ["learning_starting", "learning_active"].includes(state.status);
    const isLiveRoom = isCurrentTikTokLiveRoom();
    bar.innerHTML = `
      <span class="${isLearning ? "active" : ""}"><i></i>${isLearning ? "Learning active" : "Not learning"}</span>
      ${isLearning
        ? `<button class="stop">Stop learning</button>`
        : isLiveRoom
          ? `<button class="start">Start learning</button>`
          : `<button class="start">Open LIVE</button>`}
    `;
    const button = bar.querySelector("button");
    button.addEventListener("click", () => {
      if (isLearning) stopLearning("manual_stop");
      else if (isLiveRoom) startLearning();
      else openTikTokLive();
    });
    return bar;
  }

  function refreshStatusBar() {
    const footer = root.querySelector(".lc-status-bar");
    if (!footer) return;
    footer.innerHTML = "";
    footer.appendChild(renderStatusBar());
  }

  function refreshCollapsedTab() {
    const oldTab = root.querySelector(".lc-collapsed-tab");
    if (!oldTab) return;
    oldTab.replaceWith(renderCollapsedTab());
  }

  async function startLearning() {
    if (!isCurrentTikTokLiveRoom()) {
      openTikTokLive();
      return;
    }
    state.room = readRoomContext();
    state.status = "learning_starting";
    state.open = true;
    render();
    const response = await send({ type: "LIVE_CUE_START_LEARNING", room: state.room });
    if (response?.needsConfig) {
      state.configRequired = true;
      state.missingKeys = response.missingKeys || [];
    }
    if (response?.state) applyPublicState(response.state);
    render();
  }

  async function stopLearning(reason) {
    const response = await send({ type: "LIVE_CUE_STOP_LEARNING", reason });
    if (response?.state) applyPublicState(response.state);
    state.status = "idle";
    state.activeSkillId = "";
    render();
  }

  async function exportDebug() {
    const response = await send({ type: "LIVE_CUE_EXPORT_DEBUG" });
    const text = JSON.stringify(response?.debug || {}, null, 2);
    await navigator.clipboard?.writeText(text).catch(() => {});
    const pre = root.querySelector(".lc-debug pre");
    if (pre) pre.textContent = text;
  }

  function refreshDebugTrace(scope = root) {
    const pre = scope.querySelector(".lc-debug pre");
    if (!pre) return;
    pre.textContent = JSON.stringify(debugPayload(), null, 2);
  }

  function debugPayload() {
    return {
      status: state.status,
      room: state.room,
      latestSkillUpdate: state.latestSkillUpdate,
      selectedFocus: selectedFocusTags().map((tag) => tag.id),
      trace: state.trace
    };
  }

  function renderSignature() {
    return {
      view: state.configRequired ? "config" : state.activeSkillId ? "detail" : "list",
      activeSkillId: state.activeSkillId || "",
      statusMode: ["learning_starting", "learning_active"].includes(state.status)
        ? "learning"
        : state.status === "idle"
          ? "idle"
          : "other",
      skills: state.skills.map((skill) => libraryIdForSkill(skill)).join("|"),
      saved: state.librarySkills.map((skill) => skill.libraryId || libraryIdForSkill(skill)).join("|"),
      focus: selectedFocusTags().map((tag) => tag.id).join("|"),
      language: state.language,
      room: roomSignature(state.room)
    };
  }

  function canPatchRender(before, after) {
    return before.view === "list" &&
      after.view === "list" &&
      before.statusMode !== "idle" &&
      after.statusMode !== "idle" &&
      before.skills === after.skills &&
      before.saved === after.saved &&
      before.focus === after.focus &&
      before.language === after.language &&
      before.room === after.room;
  }

  async function openSetup() {
    await send({ type: "LIVE_CUE_OPEN_OPTIONS" });
  }

  function openTikTokLive() {
    window.open("https://www.tiktok.com/live", "_blank", "noopener,noreferrer");
  }

  function applyPublicState(publicState) {
    if (!publicState) return;
    state.status = publicState.status || "idle";
    state.room = publicState.room || state.room || readRoomContext();
    state.trace = publicState.trace || state.trace || [];
    state.latestSkillUpdate = publicState.latestSkillUpdate || state.latestSkillUpdate;
    state.skills = mergeSkills(state.skills, publicState.skills || [])
      .filter((skill) => !state.savedSkillIds.has(libraryIdForSkill(skill)));
    if (state.status === "idle") {
      state.configRequired = false;
      state.activeSkillId = "";
      state.latestSkillUpdate = null;
      state.skills = [];
      state.trace = publicState.trace || [];
    }
  }

  function installUrlWatcher() {
    const tick = () => {
      const room = readRoomContext();
      const nextSignature = roomSignature(room);
      const roomChanged = state.lastRoomSignature && nextSignature && nextSignature !== state.lastRoomSignature;
      if (location.href !== state.lastUrl || roomChanged) {
        state.lastUrl = location.href;
        state.lastRoomSignature = nextSignature;
        state.room = room;
        if (roomChanged) resetLocalLearningStateForRoomChange(room);
        send({ type: "LIVE_CUE_ROOM_CONTEXT_CHANGED", room });
      }
    };
    setInterval(tick, 1000);
    setInterval(() => {
      if (["learning_starting", "learning_active"].includes(state.status)) {
        send({ type: "LIVE_CUE_HEARTBEAT", room: readRoomContext() });
      }
    }, 5000);
    const pushState = history.pushState;
    const replaceState = history.replaceState;
    history.pushState = function patchedPushState(...args) {
      const value = pushState.apply(this, args);
      setTimeout(tick, 0);
      return value;
    };
    history.replaceState = function patchedReplaceState(...args) {
      const value = replaceState.apply(this, args);
      setTimeout(tick, 0);
      return value;
    };
    window.addEventListener("popstate", tick);
  }

  function readRoomContext() {
    const urlHandle = (location.pathname.match(/@([^/]+)\/live/i) || [])[1] || "";
    const extracted = readExtractedRoomContext();
    const titleDisplayName = readDisplayNameFromTitle(document.title || "");
    const handle = normalizeHandle(extracted.handle || urlHandle);
    return {
      liveUrl: location.href,
      handle,
      pageTitle: document.title || "",
      roomId: extracted.roomId || null,
      streamerDisplayName: extracted.streamerDisplayName || titleDisplayName || null
    };
  }

  function isCurrentTikTokLiveRoom() {
    return /^https:\/\/www\.tiktok\.com\/@[^/?#]+\/live/i.test(location.href);
  }

  function readExtractedRoomContext() {
    const extractor = window.LiveCueTikTokExtractor;
    if (!extractor?.extractTikTokLive) return {};
    try {
      const snapshot = extractor.extractTikTokLive(document, window, { maxComments: 0 });
      return {
        roomId: snapshot.tiktokUserId || null,
        handle: snapshot.handle || null,
        streamerDisplayName: snapshot.streamerDisplayName || null
      };
    } catch {
      return {};
    }
  }

  function roomSignature(room) {
    return [
      normalizeHandle(room?.roomId),
      normalizeHandle(room?.handle),
      normalizeComparable(room?.streamerDisplayName),
      normalizeComparable(room?.pageTitle)
    ].join("|");
  }

  function resetLocalLearningStateForRoomChange(room) {
    state.status = "idle";
    state.room = room;
    state.skills = [];
    state.activeSkillId = "";
    state.configRequired = false;
    state.missingKeys = [];
    state.trace = [];
    state.latestSkillUpdate = null;
    render();
  }

  function normalizeHandle(handle) {
    return decodeURIComponent(String(handle || "").replace(/^@/, ""));
  }

  function normalizeComparable(value) {
    return String(value || "").replace(/\s+/g, " ").trim();
  }

  function readDisplayNameFromTitle(title) {
    const clean = normalizeComparable(title);
    return clean.match(/^(.+?)\s*\(@[^)]+\)\s*正在直播/)?.[1] ||
      clean.match(/^(.+?)\s*\(@[^)]+\)\s*is LIVE/i)?.[1] ||
      null;
  }

  function send(payload) {
    return new Promise((resolve) => {
      try {
        chrome.runtime.sendMessage(payload, (response) => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            resolve({ ok: false, error: { message: lastError.message } });
            return;
          }
          resolve(response || { ok: true });
        });
      } catch (error) {
        resolve({ ok: false, error: { message: error?.message || String(error) } });
      }
    });
  }

  function storageGet(key) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.get(key, (result) => resolve(result?.[key]));
      } catch {
        resolve(null);
      }
    });
  }

  function storageSet(key, value) {
    return new Promise((resolve) => {
      try {
        chrome.storage.local.set({ [key]: value }, resolve);
      } catch {
        resolve();
      }
    });
  }

  function mergeSkills(previous, next) {
    const byId = new Map();
    for (const item of next) byId.set(item.skillId, item);
    for (const item of previous) {
      if (!byId.has(item.skillId)) byId.set(item.skillId, item);
    }
    return [...byId.values()];
  }

  function selectedFocusTags() {
    return FOCUS_TAGS.filter((tag) => state.selectedFocusIds.has(tag.id));
  }

  function el(tag, props = {}) {
    const node = document.createElement(tag);
    Object.entries(props).forEach(([key, value]) => {
      if (key === "class") node.className = value;
      else if (key === "onclick") node.addEventListener("click", value);
      else node.setAttribute(key, value);
    });
    return node;
  }

  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function escapeAttribute(value) {
    return escapeHtml(value).replace(/'/g, "&#39;");
  }
})();
