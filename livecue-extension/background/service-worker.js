const STORAGE_KEYS = {
  config: "livecue.config",
  sessions: "livecue.sessions",
  skillAgentRuns: "livecue.skillAgentRuns"
};

const DEFAULT_CONFIG = {
  visionProvider: "ark",
  visionBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  visionApiKey: "",
  visionModel: "doubao-seed-2-0-lite-260215",
  asrProvider: "volcengine",
  asrApiKey: "",
  asrRelayUrl: "http://127.0.0.1:17395/asr",
  skillAgentProvider: "ark",
  skillAgentBaseUrl: "https://ark.cn-beijing.volces.com/api/v3",
  skillAgentApiKey: "",
  skillAgentModel: "doubao-seed-2-0-lite-260215"
};

const BUILD_INFO = {
  label: "LiveCue public v1.0.0",
  promptVersion: "skill-agent-balanced-visual-v0.3",
  builtAt: "2026-06-06T08:36:23.078Z"
};

const sessions = new Map();

chrome.runtime.onInstalled.addListener(async (details) => {
  const { [STORAGE_KEYS.config]: config } = await chrome.storage.local.get(STORAGE_KEYS.config);
  if (!config) {
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: DEFAULT_CONFIG });
  }
  if (details.reason === chrome.runtime.OnInstalledReason.INSTALL) {
    await chrome.runtime.openOptionsPage();
  }
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.target === "offscreen") return false;
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => {
      sendResponse({ ok: false, error: normalizeError(error) });
    });
  return true;
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!sessions.has(tabId)) return;
  if (changeInfo.url && !isTikTokLiveUrl(changeInfo.url)) {
    stopLearning(tabId, "tab_left_live");
  } else if (changeInfo.url) {
    const nextRoom = resolveRoomFromUrl(changeInfo.url);
    const session = sessions.get(tabId);
    if (session?.room?.handle && nextRoom.handle && session.room.handle !== nextRoom.handle) {
      stopLearning(tabId, "room_changed");
    }
  } else if (changeInfo.status === "loading" && tab?.url && !isTikTokLiveUrl(tab.url)) {
    stopLearning(tabId, "tab_left_live");
  }
});

chrome.tabs.onRemoved.addListener((tabId) => {
  if (sessions.has(tabId)) stopLearning(tabId, "tab_closed");
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;
  if (!isTikTokLiveUrl(tab.url || "")) {
    if (isTikTokUrl(tab.url || "")) {
      try {
        await chrome.tabs.sendMessage(tab.id, {
          type: "LIVE_CUE_OPEN_PANEL",
          payload: { invokedByAction: true }
        });
      } catch {
        // Content script may not be ready yet; refreshing the TikTok tab will inject it.
      }
      return;
    }
    await chrome.runtime.openOptionsPage();
    return;
  }
  const room = resolveRoomFromUrl(tab.url);
  try {
    await chrome.tabs.sendMessage(tab.id, {
      type: "LIVE_CUE_OPEN_PANEL",
      payload: { invokedByAction: true }
    });
  } catch {
    // Content script may not be ready yet; reloading the live tab will inject it.
  }
  if (!sessions.has(tab.id)) {
    await startLearning(tab.id, {
      ...room,
      liveUrl: tab.url,
      pageTitle: tab.title || ""
    }, { invokedByAction: true });
  }
});

async function handleMessage(message, sender) {
  const tabId = sender?.tab?.id ?? message?.tabId;
  switch (message?.type) {
    case "LIVE_CUE_GET_STATE":
      return { ok: true, state: getPublicState(tabId) };
    case "LIVE_CUE_START_LEARNING":
      return startLearning(tabId, message.room, { invokedByAction: false });
    case "LIVE_CUE_STOP_LEARNING":
      return stopLearning(tabId, message.reason || "manual_stop");
    case "LIVE_CUE_ROOM_CONTEXT_CHANGED":
      return handleRoomContextChanged(tabId, message.room);
    case "LIVE_CUE_HEARTBEAT":
      return handleHeartbeat(tabId, message.room);
    case "LIVE_CUE_SAVE_CONFIG":
      return saveConfig(message.config || {});
    case "LIVE_CUE_GET_CONFIG":
      return { ok: true, config: await getConfig() };
    case "LIVE_CUE_TEST_CONFIG":
      return testConfig(message.config || await getConfig());
    case "LIVE_CUE_OPEN_OPTIONS":
      await chrome.runtime.openOptionsPage();
      return { ok: true };
    case "LIVE_CUE_EXPORT_DEBUG":
      return { ok: true, debug: buildDebugSnapshot(tabId) };
    case "LIVE_CUE_ASR_RESULT":
      return handleAsrResult(message);
    case "LIVE_CUE_ASR_ERROR":
      return handleAsrError(message);
    case "LIVE_CUE_ASR_DIAGNOSTIC":
      return handleAsrDiagnostic(message);
    default:
      return { ok: false, error: { message: `Unknown message type: ${message?.type}` } };
  }
}

async function startLearning(tabId, room = {}, options = {}) {
  assertTab(tabId);
  const existing = sessions.get(tabId);
  if (existing && ["learning_starting", "learning_active"].includes(existing.status)) {
    trace(existing, "start_learning_ignored", "ok", { reason: "already_learning" });
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
    return { ok: true, state: getPublicState(tabId) };
  }

  const config = await getConfig();
  const missingKeys = getMissingKeys(config);
  if (missingKeys.length) {
    const blocked = createSession(tabId, room, "idle");
    trace(blocked, "start_learning_blocked", "failed", { missingKeys });
    await broadcast(tabId, "LIVE_CUE_CONFIG_REQUIRED", { missingKeys, state: getPublicState(tabId) });
    if (options.invokedByAction) await chrome.runtime.openOptionsPage();
    return { ok: false, needsConfig: true, missingKeys, state: getPublicState(tabId) };
  }

  const session = createSession(tabId, room, "learning_starting");
  trace(session, "start_learning_requested", "ok", { room, invokedByAction: Boolean(options.invokedByAction) });
  await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));

  session.status = "learning_active";
  trace(session, "coordinator_started", "ok", {
    cadence: { visualMs: 10000, asrMs: 20000, htmlMs: 60000, skillMs: 60000 }
  });
  startCoordinatorTimers(tabId, session, options);
  await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  return { ok: true, state: getPublicState(tabId) };
}

async function stopLearning(tabId, reason = "manual_stop") {
  const session = sessions.get(tabId);
  if (!session) {
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", { status: "idle", reason });
    return { ok: true, state: { status: "idle", reason } };
  }

  session.status = "learning_stopping";
  trace(session, "stop_learning_requested", "ok", { reason });
  clearCoordinatorTimers(session);
  await stopContinuousAsr(session);
  session.status = "stopped";
  session.stoppedAt = new Date().toISOString();
  session.stopReason = reason;
  trace(session, "coordinator_stopped", "ok", { reason });
  await persistSession(session);
  await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  sessions.delete(tabId);
  await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", { status: "idle", reason });
  return { ok: true, state: { status: "idle", reason } };
}

async function handleRoomContextChanged(tabId, room = {}) {
  const session = sessions.get(tabId);
  if (!session) return { ok: true, ignored: true };

  if (!isTikTokLiveUrl(room.liveUrl || "")) {
    return stopLearning(tabId, "tab_left_live");
  }
  const roomChanged = isDifferentRoom(session.room, room);
  if (roomChanged) return stopLearning(tabId, "room_changed");

  session.room = { ...session.room, ...room };
  trace(session, "room_context_refreshed", "ok", {
    handle: session.room.handle,
    roomId: session.room.roomId || null
  });
  await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  return { ok: true, state: getPublicState(tabId) };
}

async function handleHeartbeat(tabId, room = {}) {
  const session = sessions.get(tabId);
  if (!session) return { ok: true, status: "idle" };
  if (!isTikTokLiveUrl(room.liveUrl || "")) return stopLearning(tabId, "tab_left_live");
  if (isDifferentRoom(session.room, room)) {
    return stopLearning(tabId, "room_changed");
  }
  session.lastHeartbeatAt = new Date().toISOString();
  return { ok: true, state: getPublicState(tabId) };
}

function createSession(tabId, room, status) {
  const startedAt = new Date().toISOString();
  const resolvedRoom = {
    ...resolveRoomFromUrl(room?.liveUrl || ""),
    ...room
  };
  const session = {
    tabId,
    sessionId: `learn_${startedAt.replace(/[:.]/g, "-")}_${resolvedRoom.handle || "unknown"}`,
    status,
    startedAt,
    room: resolvedRoom,
    skills: [],
    events: [],
    visualEvents: [],
    asrEvents: [],
    asrInFlight: false,
    latestSkillUpdate: null,
    latestSkillAgentInput: null,
    trace: [],
    timers: {}
  };
  sessions.set(tabId, session);
  trace(session, "session_created", "ok", { status, room: resolvedRoom });
  return session;
}

function startCoordinatorTimers(tabId, session, options = {}) {
  trace(session, "html_snapshot_scheduled", "ok", { intervalMs: 60000 });
  trace(session, "vision_capture_scheduled", "ok", { intervalMs: 10000 });
  trace(session, "asr_batch_scheduled", "ok", { intervalMs: 20000 });
  trace(session, "skill_evaluation_scheduled", "ok", { intervalMs: 60000 });

  runHtmlSnapshot(tabId, session, "initial");
  runVisionSnapshot(tabId, session, "initial");

  session.timers.visual = setInterval(() => {
    runVisionSnapshot(tabId, session, "scheduled_10s");
  }, 10000);
  startPageAsr(tabId, session, options);
  session.timers.html = setInterval(() => {
    runHtmlSnapshot(tabId, session, "scheduled_60s");
  }, 60000);
  session.timers.skill = setInterval(() => {
    runSkillEvaluation(tabId, session, "scheduled_minute");
  }, 60000);
}

async function runHtmlSnapshot(tabId, session, trigger) {
  try {
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "LIVE_CUE_COLLECT_HTML",
      payload: { maxComments: 40, waitMs: 1500 }
    });
    if (!response?.ok) throw new Error(response?.error?.message || "HTML snapshot failed.");
    const snapshot = response.snapshot;
    session.room = {
      ...session.room,
      roomId: snapshot.tiktokUserId || session.room.roomId || session.room.handle,
      handle: normalizeHandle(snapshot.handle || session.room.handle),
      liveUrl: snapshot.liveUrl || session.room.liveUrl,
      streamerDisplayName: snapshot.streamerDisplayName || session.room.streamerDisplayName || null
    };
    const events = eventsFromHtmlSnapshot(session, snapshot);
    session.events.push(...events);
    trace(session, "html_snapshot", "ok", {
      trigger,
      commentCount: snapshot.comments?.length || 0,
      cohostCount: snapshot.cohost?.hosts?.length || snapshot.cohost?.cohosts?.length || 0,
      hasMultiguest: Boolean(snapshot.multiguest?.isActive),
      pageStatus: snapshot.pageStatus || null
    });
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
    return snapshot;
  } catch (error) {
    trace(session, "html_snapshot", "failed", { trigger }, error);
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  }
}

async function runVisionSnapshot(tabId, session, trigger) {
  try {
    const config = await getConfig();
    const capture = await captureVisionImage(tabId);
    const imageDataUrl = capture.imageDataUrl;
    trace(session, "vision_capture", "ok", {
      trigger,
      source: capture.source,
      imageBytesApprox: Math.round((imageDataUrl.length * 3) / 4)
    });
    const analysis = await analyzeImageWithProvider({
      imageDataUrl,
      config,
      maxTokens: 1400
    });
    const event = {
      eventId: `visual_snapshot_${Date.now()}`,
      type: "visual_snapshot",
      source: "vision",
      capturedAt: new Date().toISOString(),
      text: summarizeVision(analysis.result),
      metadata: {
        providerModel: analysis.model,
        responseId: analysis.responseId,
        structuredDescription: analysis.result?.structured_description || null,
        subjectiveJudgment: analysis.result?.subjective_judgment || null
      }
    };
    session.events.push(event);
    session.visualEvents.push(event);
    trace(session, "vision_llm", "ok", { trigger, model: analysis.model });
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  } catch (error) {
    trace(session, "vision_pipeline", "failed", { trigger }, error);
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  }
}

async function captureVisionImage(tabId) {
  try {
    const tab = await chrome.tabs.get(tabId);
    const imageDataUrl = await chrome.tabs.captureVisibleTab(tab.windowId, {
      format: "jpeg",
      quality: 68
    });
    return { imageDataUrl, source: "visible_tab" };
  } catch (error) {
    if (!isCapturePermissionError(error)) throw error;
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "LIVE_CUE_CAPTURE_VIDEO_FRAME",
      payload: { maxWidth: 1024, quality: 0.72 }
    });
    if (!response?.ok || !response.imageDataUrl) {
      throw new Error(response?.error?.message || "Video frame capture fallback failed.");
    }
    return { imageDataUrl: response.imageDataUrl, source: response.source || "page_video_frame" };
  }
}

function isCapturePermissionError(error) {
  return /activeTab|<all_urls>|capture/i.test(error?.message || String(error || ""));
}

async function startContinuousAsr(tabId, session, options = {}) {
  try {
    const config = await getConfig();
    await ensureOffscreenDocument();
    const streamId = await chrome.tabCapture.getMediaStreamId({ targetTabId: tabId });
    session.asrStreamActive = true;
    trace(session, "asr_tab_capture_stream", "ok", {
      trigger: "continuous_start",
      invokedByAction: Boolean(options.invokedByAction)
    });
    const response = await chrome.runtime.sendMessage({
      target: "offscreen",
      type: "LIVE_CUE_START_TAB_AUDIO_STREAM",
      payload: {
        tabId,
        sessionId: session.sessionId,
        streamId,
        segmentMs: 20000,
        relayUrl: config.asrRelayUrl,
        asrApiKey: config.asrApiKey,
        language: "zh-CN"
      }
    });
    if (!response?.ok) throw new Error(response?.error?.message || "Offscreen ASR stream failed.");
    trace(session, "asr_stream_started", "ok", { segmentMs: 20000, relayUrl: config.asrRelayUrl });
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  } catch (error) {
    trace(session, "asr_stream_started", "failed", {
      reason: "tab_capture_permission_or_offscreen_failure"
    }, error);
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  }
}

async function startPageAsr(tabId, session, options = {}) {
  try {
    const config = await getConfig();
    const response = await chrome.tabs.sendMessage(tabId, {
      type: "LIVE_CUE_START_PAGE_ASR",
      payload: {
        sessionId: session.sessionId,
        segmentMs: 20000,
        relayUrl: config.asrRelayUrl,
        asrApiKey: config.asrApiKey,
        language: "zh-CN"
      }
    });
    if (!response?.ok) throw new Error(response?.error?.message || "Page ASR failed to start.");
    session.asrStreamActive = true;
    session.asrMode = "page_video_capture";
    trace(session, "asr_stream_started", "ok", {
      mode: "page_video_capture",
      segmentMs: 20000,
      relayUrl: config.asrRelayUrl,
      invokedByAction: Boolean(options.invokedByAction)
    });
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  } catch (error) {
    trace(session, "asr_stream_started", "failed", {
      mode: "page_video_capture",
      fallback: options.invokedByAction ? "tab_capture" : "none"
    }, error);
    if (options.invokedByAction) {
      await startContinuousAsr(tabId, session, options);
    } else {
      await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
    }
  }
}

async function stopContinuousAsr(session) {
  if (!session?.asrStreamActive) return;
  try {
    if (session.asrMode === "page_video_capture") {
      await chrome.tabs.sendMessage(session.tabId, {
        type: "LIVE_CUE_STOP_PAGE_ASR",
        payload: { sessionId: session.sessionId }
      });
    } else {
      await chrome.runtime.sendMessage({
        target: "offscreen",
        type: "LIVE_CUE_STOP_TAB_AUDIO_STREAM",
        payload: { sessionId: session.sessionId }
      });
    }
    trace(session, "asr_stream_stopped", "ok", {});
  } catch (error) {
    trace(session, "asr_stream_stopped", "failed", {}, error);
  } finally {
    session.asrStreamActive = false;
  }
}

async function handleAsrResult(message) {
  const session = [...sessions.values()].find((item) => item.sessionId === message.sessionId);
  if (!session) return { ok: false, ignored: true, reason: "session_not_found" };
  const events = eventsFromAsrResult(session, message.result);
  session.events.push(...events);
  session.asrEvents.push(...events);
  trace(session, "asr_batch", "ok", {
    trigger: message.trigger || "offscreen_segment",
    utteranceCount: message.result?.utterances?.length || 0
  });
  await broadcast(session.tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(session.tabId));
  return { ok: true };
}

async function handleAsrError(message) {
  const session = [...sessions.values()].find((item) => item.sessionId === message.sessionId);
  if (!session) return { ok: false, ignored: true, reason: "session_not_found" };
  trace(session, "asr_batch", "failed", {
    trigger: message.trigger || "offscreen_segment"
  }, message.error || new Error("Unknown ASR error"));
  await broadcast(session.tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(session.tabId));
  return { ok: true };
}

async function handleAsrDiagnostic(message) {
  const session = [...sessions.values()].find((item) => item.sessionId === message.sessionId);
  if (!session) return { ok: false, ignored: true, reason: "session_not_found" };
  trace(session, message.step || "asr_diagnostic", message.status || "ok", message.metadata || {});
  await broadcast(session.tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(session.tabId));
  return { ok: true };
}

async function runSkillEvaluation(tabId, session, trigger) {
  try {
    if (!session.events.length) {
      trace(session, "skill_evaluation", "failed", { trigger, reason: "no_events_yet" });
      return;
    }
    const config = await getConfig();
    const windowPayload = buildLatestWindow(session);
    const recentSkillMemory = buildRecentSkillMemory(session);
    windowPayload.recentSkillMemory = recentSkillMemory;
    session.latestSkillAgentInput = windowPayload;
    trace(session, "skill_agent_input_prepared", "ok", {
      ...summarizeSkillAgentInput(windowPayload),
      recentSkillCount: recentSkillMemory.length
    });
    const agentRun = await analyzeSkillWithProvider({
      payload: windowPayload,
      config
    });
    const skill = agentRun.result;
    const normalized = skill ? normalizeSkillInsight(skill, session) : null;
    const isDuplicate = normalized ? isDuplicateSkill(normalized, session.skills) : false;
    const skills = normalized && !isDuplicate ? [normalized] : [];
    if (isDuplicate) {
      trace(session, "skill_deduped", "ok", {
        title: normalized.title,
        category: normalized.category,
        reason: "similar_to_existing_skill"
      });
    }
    session.skills = mergeSkills(session.skills, skills);
    session.latestSkillUpdate = {
      eventType: "skill_insights_update",
      schemaVersion: "skill-insights-update-v0.1",
      roomId: session.room?.roomId || session.room?.handle || "unknown",
      sessionId: session.sessionId,
      liveUrl: session.room?.liveUrl || "",
      evaluationId: `eval_${Date.now()}`,
      capturedAt: new Date().toISOString(),
      trigger,
      skills
    };
    await persistSkillAgentRun(session, {
      trigger,
      evaluationId: session.latestSkillUpdate.evaluationId,
      input: windowPayload,
      output: {
        model: agentRun.model,
        responseId: agentRun.responseId,
        systemPrompt: agentRun.systemPrompt,
        userPrompt: agentRun.userPrompt,
        rawText: agentRun.rawText,
        result: agentRun.result,
        normalizedSkills: skills,
        deduped: isDuplicate
      }
    });
    trace(session, "skill_evaluation", "ok", {
      trigger,
      eventCount: windowPayload.liveEvents.length,
      speechEventCount: countEvents(windowPayload.liveEvents, "speech"),
      commentEventCount: countEvents(windowPayload.liveEvents, "comment"),
      visualEventCount: countEvents(windowPayload.liveEvents, "visual_snapshot"),
      hasVisualObservation: Boolean(windowPayload.visualObservation),
      skillCount: skills.length
    });
    await broadcast(tabId, "LIVE_CUE_SKILL_UPDATE", session.latestSkillUpdate);
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  } catch (error) {
    trace(session, "skill_evaluation", "failed", { trigger }, error);
    await broadcast(tabId, "LIVE_CUE_STATUS_UPDATE", getPublicState(tabId));
  }
}

function mergeSkills(previous, next) {
  const byId = new Map();
  for (const item of next) byId.set(item.skillId, item);
  for (const item of previous) {
    if (!byId.has(item.skillId)) byId.set(item.skillId, item);
  }
  return [...byId.values()];
}

function buildRecentSkillMemory(session) {
  return (session.skills || []).slice(0, 12).map((skill) => ({
    skillId: skill.skillId || null,
    title: skill.title || "",
    category: skill.category || "",
    secondaryCategories: Array.isArray(skill.secondaryCategories) ? skill.secondaryCategories : [],
    scenario: truncateText(skill.scenario, 120),
    action: truncateText(skill.action, 180),
    effect: truncateText(skill.effect, 160),
    timestamp: skill.timestamp || "",
    confidence: skill.confidence ?? null
  }));
}

function isDuplicateSkill(candidate, existingSkills = []) {
  if (!candidate || !existingSkills.length) return false;
  const candidateMain = comparableSkillText(candidate);
  const candidateAction = comparableText(candidate.action);
  return existingSkills.some((existing) => {
    const sameCategory = existing.category && existing.category === candidate.category;
    const mainSimilarity = textSimilarity(candidateMain, comparableSkillText(existing));
    const actionSimilarity = textSimilarity(candidateAction, comparableText(existing.action));
    return (sameCategory && mainSimilarity >= 0.62) || actionSimilarity >= 0.76;
  });
}

function comparableSkillText(skill) {
  return comparableText([
    skill?.title,
    skill?.category,
    skill?.scenario,
    skill?.action,
    skill?.effect
  ].filter(Boolean).join(" "));
}

function comparableText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[^\w\u4e00-\u9fa5]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function textSimilarity(left, right) {
  const leftTokens = tokenSet(left);
  const rightTokens = tokenSet(right);
  if (!leftTokens.size || !rightTokens.size) return 0;
  let intersection = 0;
  for (const token of leftTokens) {
    if (rightTokens.has(token)) intersection += 1;
  }
  return intersection / Math.min(leftTokens.size, rightTokens.size);
}

function tokenSet(value) {
  const text = comparableText(value);
  const latinWords = text.match(/[a-z0-9_]+/g) || [];
  const cjkChars = text.replace(/[a-z0-9_\s]+/g, "").split("");
  return new Set([...latinWords, ...cjkChars].filter(Boolean));
}

function truncateText(value, maxLength) {
  const text = String(value || "");
  return text.length > maxLength ? `${text.slice(0, maxLength)}...` : text;
}

function clearCoordinatorTimers(session) {
  for (const timer of Object.values(session.timers || {})) {
    clearInterval(timer);
    clearTimeout(timer);
  }
  session.timers = {};
}

function trace(session, step, status = "ok", metadata = {}, error = null) {
  const entry = {
    at: new Date().toISOString(),
    step,
    status,
    metadata,
    error: error ? normalizeError(error) : null
  };
  session.trace.push(entry);
  if (session.trace.length > 200) session.trace.splice(0, session.trace.length - 200);
  return entry;
}

function getPublicState(tabId) {
  const session = sessions.get(tabId);
  if (!session) return { status: "idle", skills: [], trace: [] };
  return {
    buildInfo: BUILD_INFO,
    status: session.status,
    sessionId: session.sessionId,
    room: session.room,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt || null,
    stopReason: session.stopReason || null,
    lastHeartbeatAt: session.lastHeartbeatAt || null,
    skills: session.skills,
    latestSkillUpdate: session.latestSkillUpdate,
    latestSkillAgentRun: session.latestSkillAgentRun || null,
    eventCount: session.events.length,
    visualCount: session.visualEvents.length,
    asrCount: session.asrEvents.length,
    trace: session.trace.slice(-30)
  };
}

function buildDebugSnapshot(tabId) {
  const session = sessions.get(tabId);
  if (!session) return { buildInfo: BUILD_INFO, status: "idle", exportedAt: new Date().toISOString() };
  return {
    exportedAt: new Date().toISOString(),
    ...getPublicState(tabId),
    latestSkillAgentInput: session.latestSkillAgentInput,
    latestSkillAgentRun: session.latestSkillAgentRun || null,
    trace: session.trace
  };
}

async function getConfig() {
  const { [STORAGE_KEYS.config]: config } = await chrome.storage.local.get(STORAGE_KEYS.config);
  const merged = normalizeConfig({ ...DEFAULT_CONFIG, ...(config || {}) });
  if (merged.skillAgentModel === "doubao-seed-1-6-250615") {
    merged.skillAgentModel = DEFAULT_CONFIG.skillAgentModel;
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: merged });
  }
  if (JSON.stringify(merged) !== JSON.stringify({ ...DEFAULT_CONFIG, ...(config || {}) })) {
    await chrome.storage.local.set({ [STORAGE_KEYS.config]: merged });
  }
  return merged;
}

async function saveConfig(config) {
  const merged = normalizeConfig({ ...(await getConfig()), ...config });
  await chrome.storage.local.set({ [STORAGE_KEYS.config]: merged });
  return { ok: true, config: merged };
}

async function testConfig(config) {
  const normalized = normalizeConfig({ ...DEFAULT_CONFIG, ...(config || {}) });
  const checks = {};
  checks.asrRelay = await runSetupCheck(() => testAsrRelay(normalized));
  checks.asrKey = normalized.asrApiKey
    ? { ok: true, message: "ASR key is configured. Full validation happens during a live 20s batch." }
    : { ok: false, message: "Missing Volcengine ASR API key." };
  checks.vision = await runSetupCheck(() => testVisionProvider(normalized));
  checks.skillAgent = await runSetupCheck(() => testSkillAgentProvider(normalized));
  const ok = Object.values(checks).every((check) => check.ok);
  return { ok, checks, config: normalized };
}

async function runSetupCheck(fn) {
  try {
    return await fn();
  } catch (error) {
    return {
      ok: false,
      message: error?.message || String(error),
      error: normalizeError(error)
    };
  }
}

async function testAsrRelay(config) {
  const relayUrl = new URL(config.asrRelayUrl || DEFAULT_CONFIG.asrRelayUrl);
  relayUrl.pathname = "/health";
  relayUrl.search = "";
  const response = await fetch(relayUrl.toString(), { method: "GET" });
  const body = await response.json().catch(() => null);
  if (!response.ok || !body?.ok) {
    throw new Error(body?.error?.message || `ASR relay health failed: HTTP ${response.status}`);
  }
  return { ok: true, message: "Local ASR relay is running.", metadata: body };
}

async function testVisionProvider(config) {
  if (!config.visionApiKey) throw new Error("Missing vision API key.");
  const provider = normalizeProvider(config.visionProvider);
  if (!["ark", "openai-compatible"].includes(provider)) {
    throw new Error(`Unsupported vision provider: ${config.visionProvider}`);
  }
  const tinyImage = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAALElEQVR4nO3OoQEAAAwCIP//17ydYSHQSdtbioCAgICAgICAgICAgICAwDrwo0J44l1LvggAAAAASUVORK5CYII=";
  const response = await fetch(chatCompletionsUrl(config.visionBaseUrl || DEFAULT_CONFIG.visionBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.visionApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.visionModel || DEFAULT_CONFIG.visionModel,
      max_tokens: 20,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: tinyImage } },
            { type: "text", text: "Return only: ok" }
          ]
        }
      ]
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Vision check failed: HTTP ${response.status}`);
  }
  return { ok: true, message: "Vision provider responded.", metadata: { model: config.visionModel || DEFAULT_CONFIG.visionModel } };
}

async function testSkillAgentProvider(config) {
  const provider = normalizeProvider(config.skillAgentProvider);
  if (provider === "mock") return { ok: true, message: "Mock Skill Agent is ready." };
  if (provider === "claude") {
    if (!config.skillAgentApiKey) throw new Error("Missing Claude API key.");
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "x-api-key": config.skillAgentApiKey,
        "anthropic-version": "2023-06-01",
        "Content-Type": "application/json"
      },
      body: JSON.stringify({
        model: config.skillAgentModel || "claude-sonnet-4-5-20250929",
        max_tokens: 20,
        messages: [{ role: "user", content: "Return only: ok" }]
      })
    });
    const body = await response.json().catch(() => null);
    if (!response.ok) throw new Error(body?.error?.message || `Claude check failed: HTTP ${response.status}`);
    return { ok: true, message: "Claude Skill Agent provider responded." };
  }
  const apiKey = config.skillAgentApiKey || config.visionApiKey;
  if (!apiKey) throw new Error("Missing Skill Agent API key.");
  const response = await fetch(chatCompletionsUrl(config.skillAgentBaseUrl || config.visionBaseUrl || DEFAULT_CONFIG.skillAgentBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model: config.skillAgentModel || config.visionModel || DEFAULT_CONFIG.skillAgentModel,
      temperature: 0,
      max_tokens: 20,
      messages: [{ role: "user", content: "Return only: ok" }]
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) throw new Error(body?.error?.message || body?.message || `Skill Agent check failed: HTTP ${response.status}`);
  return { ok: true, message: "Skill Agent provider responded." };
}

function normalizeConfig(config) {
  const normalized = { ...config };
  if (normalized.visionProvider === "doubao") normalized.visionProvider = "ark";
  if (normalized.skillAgentProvider === "doubao") normalized.skillAgentProvider = "ark";
  if (normalized.asrProvider === "doubao") normalized.asrProvider = "volcengine";
  normalized.visionBaseUrl = normalizeBaseUrl(normalized.visionBaseUrl || DEFAULT_CONFIG.visionBaseUrl);
  normalized.skillAgentBaseUrl = normalizeBaseUrl(normalized.skillAgentBaseUrl || DEFAULT_CONFIG.skillAgentBaseUrl);
  try {
    const url = new URL(normalized.asrRelayUrl || DEFAULT_CONFIG.asrRelayUrl);
    const isLocalRelay = ["127.0.0.1", "localhost"].includes(url.hostname);
    if (isLocalRelay && url.pathname === "/asr" && url.port !== "17395") {
      normalized.asrRelayUrl = DEFAULT_CONFIG.asrRelayUrl;
    }
  } catch {
    normalized.asrRelayUrl = DEFAULT_CONFIG.asrRelayUrl;
  }
  if (normalized.skillAgentModel === "doubao-seed-1-6-250615") {
    normalized.skillAgentModel = DEFAULT_CONFIG.skillAgentModel;
  }
  return normalized;
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function getMissingKeys(config) {
  const missing = [];
  if (!config.visionApiKey) missing.push("visionApiKey");
  if (!config.asrApiKey) missing.push("asrApiKey");
  const skillProvider = normalizeProvider(config.skillAgentProvider);
  const canReuseVisionKey = ["ark", "openai-compatible"].includes(skillProvider);
  if (skillProvider !== "mock" && !config.skillAgentApiKey && !(canReuseVisionKey && config.visionApiKey)) {
    missing.push("skillAgentApiKey");
  }
  return missing;
}

async function persistSession(session) {
  const { [STORAGE_KEYS.sessions]: existing = [] } = await chrome.storage.local.get(STORAGE_KEYS.sessions);
  const stored = {
    sessionId: session.sessionId,
    room: session.room,
    startedAt: session.startedAt,
    stoppedAt: session.stoppedAt,
    stopReason: session.stopReason,
    skills: session.skills,
    latestSkillUpdate: session.latestSkillUpdate,
    latestSkillAgentInput: session.latestSkillAgentInput,
    latestSkillAgentRun: session.latestSkillAgentRun || null,
    trace: session.trace
  };
  await chrome.storage.local.set({
    [STORAGE_KEYS.sessions]: [stored, ...existing].slice(0, 20)
  });
}

async function persistSkillAgentRun(session, { trigger, evaluationId, input, output }) {
  const capturedAt = new Date().toISOString();
  const record = {
    schemaVersion: "livecue-skill-agent-run-v0.1",
    buildInfo: BUILD_INFO,
    capturedAt,
    trigger,
    evaluationId,
    room: session.room,
    sessionId: session.sessionId,
    summary: summarizeSkillAgentInput(input),
    input,
    output
  };
  session.latestSkillAgentRun = record;
  console.log("[LiveCue] skill_agent_run", record);

  const { [STORAGE_KEYS.skillAgentRuns]: existing = [] } = await chrome.storage.local.get(STORAGE_KEYS.skillAgentRuns);
  await chrome.storage.local.set({
    [STORAGE_KEYS.skillAgentRuns]: [record, ...existing].slice(0, 20)
  });
  trace(session, "skill_agent_run_saved", "ok", {
    destination: "chrome.storage.local",
    summary: record.summary
  });
  return record;
}

async function broadcast(tabId, type, payload) {
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type, payload });
  } catch {
    // The content script may be gone during navigation. The tab event will finish cleanup.
  }
}

function resolveRoomFromUrl(url) {
  const match = String(url || "").match(/tiktok\.com\/@([^/?#]+)\/live/i);
  return {
    liveUrl: url || "",
    handle: match ? decodeURIComponent(match[1]) : ""
  };
}

function isTikTokLiveUrl(url) {
  return /https:\/\/www\.tiktok\.com\/@[^/?#]+\/live/i.test(String(url || ""));
}

function isTikTokUrl(url) {
  return /^https:\/\/www\.tiktok\.com(\/|$)/i.test(String(url || ""));
}

function assertTab(tabId) {
  if (!tabId && tabId !== 0) throw new Error("No active tab id available.");
}

function normalizeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    stack: error?.stack || null
  };
}

function eventsFromHtmlSnapshot(session, snapshot) {
  const capturedAt = snapshot.capturedAt || new Date().toISOString();
  const roomId = session.room?.roomId || snapshot.tiktokUserId || session.room?.handle || "unknown";
  const base = {
    sessionId: session.sessionId,
    roomId,
    liveUrl: snapshot.liveUrl || session.room?.liveUrl || "",
    capturedAt
  };
  const events = [
    {
      ...base,
      eventId: `room_meta_${Date.now()}`,
      type: "room_meta",
      source: "html",
      text: `${snapshot.streamerDisplayName || snapshot.handle || "unknown"} live room metadata updated`,
      timestamp: secondsSince(session.startedAt, capturedAt),
      metadata: {
        streamerDisplayName: snapshot.streamerDisplayName || null,
        handle: normalizeHandle(snapshot.handle || session.room?.handle),
        tiktokUserId: snapshot.tiktokUserId || null,
        pageStatus: snapshot.pageStatus || null,
        followerCount: snapshot.followerCount ?? null,
        currentViewerCount: snapshot.currentViewerCount ?? null,
        liveStartTime: snapshot.liveStartTime || null,
        pageLanguageRegionContext: snapshot.pageLanguageRegionContext || null,
        cohost: snapshot.cohost || null,
        multiguest: snapshot.multiguest || null
      }
    }
  ];

  for (const [index, comment] of (snapshot.comments || []).entries()) {
    if (!comment.text) continue;
    events.push({
      ...base,
      eventId: `comment_${Date.now()}_${index}`,
      type: "comment",
      source: "html",
      text: comment.text,
      timestamp: secondsSince(session.startedAt, capturedAt),
      metadata: {
        commentId: comment.id || `visible_comment_${index}`,
        viewerName: comment.commenterName || comment.userName || null,
        viewerTags: comment.commenterTags || comment.tags || [],
        rawType: comment.type || null
      }
    });
  }
  return events;
}

function eventsFromAsrResult(session, result) {
  const capturedAt = result?.endedAt || new Date().toISOString();
  const roomId = session.room?.roomId || session.room?.handle || "unknown";
  return (result?.utterances || [])
    .filter((utterance) => utterance.text)
    .map((utterance, index) => {
      const absoluteStart = new Date(new Date(result.startedAt || capturedAt).getTime() + (utterance.startTimeMs || 0));
      return {
        eventId: `speech_${Date.now()}_${index}`,
        sessionId: session.sessionId,
        roomId,
        liveUrl: session.room?.liveUrl || "",
        capturedAt,
        type: "speech",
        source: "asr",
        text: utterance.text,
        timestamp: secondsSince(session.startedAt, absoluteStart.toISOString()),
        metadata: {
          segmentIndex: result.index || 0,
          utteranceIndex: index,
          speakerId: utterance.speaker || null,
          speakerRole: "unknown",
          startTimeMs: utterance.startTimeMs ?? null,
          endTimeMs: utterance.endTimeMs ?? null,
          definite: utterance.definite ?? null,
          asrProvider: "doubao",
          asrConfidence: utterance.confidence ?? null
        }
      };
    });
}

async function ensureOffscreenDocument() {
  if (!chrome.offscreen) throw new Error("chrome.offscreen is unavailable.");
  const existing = await chrome.runtime.getContexts?.({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL("offscreen/offscreen.html")]
  });
  if (existing?.length) return;
  await chrome.offscreen.createDocument({
    url: "offscreen/offscreen.html",
    reasons: ["USER_MEDIA"],
    justification: "Record the active TikTok LIVE tab audio for 20s ASR batches."
  });
}

function buildLatestWindow(session) {
  const to = new Date();
  const from = new Date(to.getTime() - 5 * 60 * 1000);
  const liveEvents = session.events.filter((event) => new Date(event.capturedAt).getTime() >= from.getTime());
  const visualEvents = session.visualEvents.filter((event) => new Date(event.capturedAt).getTime() >= from.getTime());
  return {
    roomId: session.room?.roomId || session.room?.handle || "unknown",
    sessionId: session.sessionId,
    liveUrl: session.room?.liveUrl || "",
    generatedAt: to.toISOString(),
    readWindow: {
      from: from.toISOString(),
      to: to.toISOString()
    },
    liveEvents,
    visualObservation: visualEvents.length ? buildVisualObservation(visualEvents, session.room?.liveUrl || "") : null,
    roomContext: {
      roomId: session.room?.roomId || null,
      handle: session.room?.handle || null,
      streamerDisplayName: session.room?.streamerDisplayName || null,
      liveUrl: session.room?.liveUrl || ""
    }
  };
}

function buildVisualObservation(visualEvents, liveUrl) {
  const latest = [...visualEvents].reverse().find((event) => event.metadata?.structuredDescription);
  return {
    provider: latest?.metadata?.providerModel || "doubao",
    capturedAt: visualEvents.at(-1)?.capturedAt || null,
    liveUrl,
    snapshotCount: visualEvents.length,
    confidence: null,
    frameSummary: visualEvents.map((event) => event.text).filter(Boolean).join(" "),
    structuredDescription: latest?.metadata?.structuredDescription || null,
    subjectiveJudgment: latest?.metadata?.subjectiveJudgment || null,
    rawSnapshots: visualEvents.map((event, index) => ({
      index,
      capturedAt: event.capturedAt,
      summary: event.text
    }))
  };
}

function summarizeSkillAgentInput(payload) {
  const events = payload.liveEvents || [];
  return {
    roomId: payload.roomId || null,
    sessionId: payload.sessionId || null,
    eventCount: events.length,
    speechEventCount: countEvents(events, "speech"),
    commentEventCount: countEvents(events, "comment"),
    visualEventCount: countEvents(events, "visual_snapshot"),
    roomMetaEventCount: countEvents(events, "room_meta"),
    hasVisualObservation: Boolean(payload.visualObservation),
    visualSnapshotCount: payload.visualObservation?.snapshotCount || 0,
    recentSkillCount: payload.recentSkillMemory?.length || 0,
    readWindow: payload.readWindow || null
  };
}

function countEvents(events, type) {
  return (events || []).filter((event) => event.type === type).length;
}

async function analyzeImageWithProvider({ imageDataUrl, config, maxTokens }) {
  const provider = normalizeProvider(config.visionProvider);
  if (!["ark", "openai-compatible"].includes(provider)) {
    throw new Error(`Unsupported vision provider: ${config.visionProvider}`);
  }
  const apiKey = config.visionApiKey;
  const model = config.visionModel || DEFAULT_CONFIG.visionModel;
  if (!apiKey) throw new Error("Missing vision API key.");
  const response = await fetch(chatCompletionsUrl(config.visionBaseUrl || DEFAULT_CONFIG.visionBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      messages: [
        {
          role: "user",
          content: [
            { type: "image_url", image_url: { url: imageDataUrl } },
            { type: "text", text: LIVE_VISUAL_BUSINESS_PROMPT }
          ]
        }
      ]
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Vision provider failed: HTTP ${response.status}`);
  }
  const text = body?.choices?.[0]?.message?.content || "";
  return {
    model,
    responseId: body?.id || null,
    outputText: text,
    result: parseJsonObject(text)
  };
}

async function analyzeSkillWithProvider({ payload, config }) {
  const provider = normalizeProvider(config.skillAgentProvider);
  const systemPrompt = SKILL_AGENT_SYSTEM_PROMPT;
  const userPrompt = buildSkillAgentUserPrompt(payload);
  if (provider === "mock") {
    return mockSkillAgentRun({ payload, systemPrompt, userPrompt });
  }
  if (provider === "claude") {
    return analyzeSkillWithClaude({ config, systemPrompt, userPrompt });
  }
  return analyzeSkillWithOpenAICompatible({ config, systemPrompt, userPrompt });
}

async function analyzeSkillWithOpenAICompatible({ config, systemPrompt, userPrompt }) {
  const apiKey = config.skillAgentApiKey || config.visionApiKey;
  const model = config.skillAgentModel || config.visionModel || DEFAULT_CONFIG.skillAgentModel;
  if (!apiKey) throw new Error("Missing Skill Agent API key.");
  const response = await fetch(chatCompletionsUrl(config.skillAgentBaseUrl || config.visionBaseUrl || DEFAULT_CONFIG.skillAgentBaseUrl), {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      temperature: 0.2,
      max_tokens: 1200,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ]
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Skill Agent failed: HTTP ${response.status}`);
  }
  const text = body?.choices?.[0]?.message?.content || "";
  return {
    model,
    responseId: body?.id || null,
    systemPrompt,
    userPrompt,
    rawText: text,
    result: text.trim() === "null" ? null : parseJsonObject(text)
  };
}

async function analyzeSkillWithClaude({ config, systemPrompt, userPrompt }) {
  const apiKey = config.skillAgentApiKey;
  const model = config.skillAgentModel || "claude-sonnet-4-5-20250929";
  if (!apiKey) throw new Error("Missing Claude Skill Agent API key.");
  const response = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      model,
      system: systemPrompt,
      max_tokens: 1200,
      temperature: 0.2,
      messages: [{ role: "user", content: userPrompt }]
    })
  });
  const body = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(body?.error?.message || body?.message || `Claude Skill Agent failed: HTTP ${response.status}`);
  }
  const text = (body?.content || [])
    .filter((part) => part?.type === "text")
    .map((part) => part.text || "")
    .join("\n")
    .trim();
  return {
    model,
    responseId: body?.id || null,
    systemPrompt,
    userPrompt,
    rawText: text,
    result: text === "null" ? null : parseJsonObject(text)
  };
}

function mockSkillAgentRun({ payload, systemPrompt, userPrompt }) {
  const result = {
    schemaVersion: "skill-card-v0.1",
    rubricVersion: "pgc-v1.0",
    promptVersion: "livecue-extension-skill-agent-v0.1",
    skillId: `mock_skill_${Date.now()}`,
    title: "Turn viewer questions into warm name-call replies",
    category: "reply_comment",
    secondaryCategories: [],
    scenario: "A viewer asks an easy question in chat.",
    action: "The host calls the viewer by name, answers the question directly, then adds a light follow-up question to keep the conversation moving.",
    effect: "The viewer feels seen, while other viewers get a simple new topic they can join.",
    localized: {
      en: {
        title: "Turn viewer questions into warm name-call replies",
        scenario: "A viewer asks an easy question in chat.",
        action: "The host calls the viewer by name, answers the question directly, then adds a light follow-up question to keep the conversation moving.",
        effect: "The viewer feels seen, while other viewers get a simple new topic they can join."
      },
      zh: {
        title: "把观众问题转成点名回应",
        scenario: "观众在评论区提出低门槛问题时。",
        action: "主播先点名回应观众，再用一句具体回答承接问题，并补一个轻松追问延续对话。",
        effect: "让观众感到自己的评论被看见，同时给其他观众一个容易参与的新话题。"
      }
    },
    timestamp: "00:00",
    sourceLive: { liveUrl: payload.liveUrl || "", hostName: payload.roomContext?.handle || "" },
    confidence: 0.6
  };
  return {
    model: "mock",
    responseId: `mock_${Date.now()}`,
    systemPrompt,
    userPrompt,
    rawText: JSON.stringify(result, null, 2),
    result
  };
}

function normalizeProvider(provider) {
  const value = String(provider || "").trim().toLowerCase();
  if (["doubao", "volcano", "volcano-ark"].includes(value)) return "ark";
  if (["openai", "openai-compatible", "custom"].includes(value)) return "openai-compatible";
  if (["anthropic", "claude"].includes(value)) return "claude";
  if (value === "mock") return "mock";
  return value || "ark";
}

function chatCompletionsUrl(baseUrl) {
  const clean = normalizeBaseUrl(baseUrl);
  if (/\/chat\/completions$/i.test(clean)) return clean;
  return `${clean}/chat/completions`;
}

function normalizeSkillInsight(skill, session) {
  if (!skill || typeof skill !== "object") return null;
  const category = skill.category || "reply_comment";
  const localized = normalizeLocalizedSkill(skill);
  return {
    schemaVersion: "skill-card-v0.1",
    rubricVersion: skill.rubricVersion || "pgc-v1.0",
    promptVersion: skill.promptVersion || "livecue-extension-skill-agent-v0.1",
    skillId: skill.skillId || `skill_${category}_${Date.now()}`,
    title: skill.title || localized.en.title || localized.zh.title || "Learnable LIVE skill",
    category,
    secondaryCategories: Array.isArray(skill.secondaryCategories) ? skill.secondaryCategories : [],
    scenario: skill.scenario || localized.en.scenario || localized.zh.scenario || "",
    action: skill.action || localized.en.action || localized.zh.action || "",
    effect: skill.effect || localized.en.effect || localized.zh.effect || "",
    localized,
    timestamp: skill.timestamp || "00:00",
    sourceLive: {
      liveUrl: session.room?.liveUrl || skill.sourceLive?.liveUrl || "",
      hostName: session.room?.handle || skill.sourceLive?.hostName || ""
    },
    confidence: Number.isFinite(Number(skill.confidence)) ? Number(skill.confidence) : 0.75
  };
}

function normalizeLocalizedSkill(skill) {
  const localized = skill.localized && typeof skill.localized === "object" ? skill.localized : {};
  const en = localized.en && typeof localized.en === "object" ? localized.en : {};
  const zh = localized.zh && typeof localized.zh === "object" ? localized.zh : {};
  return {
    en: {
      title: en.title || skill.titleEn || skill.title || "",
      scenario: en.scenario || skill.scenarioEn || skill.scenario || "",
      action: en.action || skill.actionEn || skill.action || "",
      effect: en.effect || skill.effectEn || skill.effect || ""
    },
    zh: {
      title: zh.title || skill.titleZh || skill.titleCn || skill.title || "",
      scenario: zh.scenario || skill.scenarioZh || skill.scenarioCn || skill.scenario || "",
      action: zh.action || skill.actionZh || skill.actionCn || skill.action || "",
      effect: zh.effect || skill.effectZh || skill.effectCn || skill.effect || ""
    }
  };
}

function buildSkillAgentUserPrompt(payload) {
  return JSON.stringify({
    task: "基于最近观察窗口，返回一个新的 bilingual SkillInsight JSON 对象，或返回 null。不要输出 markdown。",
    selectionPriority: [
      "优先从 speech/ASR 中寻找主播明确说出的经营动作、话术、承接、引导或互动策略。",
      "其次从评论、礼物、PK、cohost/multiguest、房间机制等 liveEvents 中寻找经营动作和观众反馈。",
      "再次考虑内容编排、才艺展示后的互动闭环、直播间机制设计。",
      "同时不要压制高质量视觉 skill：如果 speech/comment 只是普通寒暄或信息量弱，而 visualObservation 呈现了清晰可迁移的场景、人设、构图、灯光或道具方法，可以选择视觉类 skill。",
      "视觉类 skill 的门槛是：视觉元素必须服务直播经营，例如帮助新观众快速理解直播间主题、强化主播定位、支撑互动机制、提升展示清晰度或形成记忆点。"
    ],
    positiveRubric: [
      "经营动作明确：能指出主播具体做了什么，而不是只描述画面或状态。",
      "观众心理明确：能说明动作如何带来被看见感、参与感、陪伴感、期待感、归属感或理解成本降低。",
      "内容结构明确：能说明主播如何把直播从单点展示变成可持续流程，如开场、互动、反馈、下一轮。",
      "可迁移方法明确：其他主播看完后能照着改自己的话术、流程、画面、机制或互动方式。",
      "PGC 导向明确：健康、克制、有职业感，不靠强刺激、强索取、低俗化或压迫观众。"
    ],
    visualUsePolicy: [
      "visualObservation 主要是辅助证据，用来理解场景、人设、画面状态，不默认作为最高优先级。",
      "不要仅因为主播穿搭整洁、背景好看、灯光清楚就输出视觉类 skill。",
      "视觉类 skill 必须说明视觉元素如何服务直播经营，例如降低新观众理解成本、强化内容定位、支撑互动机制、形成可复制的人设系统。",
      "如果 recentSkillMemory 已经有 scene_design、composition_lighting、persona_design、viewer_psychology 等视觉类 skill，本次优先寻找非视觉类经营 skill；但如果新的视觉证据属于不同方法论，且明显强于普通问答/寒暄，也可以输出视觉类 skill。",
      "优秀视觉 skill 示例：固定榜单/MVP展示区形成参与目标；道具与背景共同说明直播主题；镜头构图让才艺/商品/互动对象更清楚；服装妆发与直播主题形成稳定人设。"
    ],
    candidateSelectionPolicy: [
      "先在心里比较多个候选 skill，不要输出候选列表。",
      "选择最高优先级、证据最明确、与 recentSkillMemory 不重复的一条。",
      "如果最高优先级候选重复，不要直接返回 null，继续寻找下一个不同候选。",
      "不要为了每分钟都有更新而硬编。没有新的证据型 skill 时返回 null。"
    ],
    dedupePolicy: [
      "recentSkillMemory 是当前直播间已经输出给用户的技能列表。",
      "不要输出与 recentSkillMemory 在标题、动作、场景或效果上语义重复的 skill。",
      "如果当前最明显的技巧已经输出过，请继续寻找当前窗口中下一个有证据、可迁移、符合 PGC 导向的不同技巧。",
      "不要为了凑数硬编；只有没有新的证据型技巧时才返回 null。"
    ],
    nullWhen: [
      "只有普通寒暄、机械 CTA 或空泛感谢。",
      "证据不足，无法说明具体可学习动作。",
      "只有画面事实但无法说明动作和效果。",
      "存在安全、生态风险或低质挑逗。"
    ],
    categoryGuide: {
      welcome: "点名欢迎具体用户，并追加低门槛追问或破冰。",
      reply_comment: "把观众评论承接成一轮对话，延续直播主题。",
      room_atmosphere: "用具体问题、共同目标或低门槛参与动作活跃直播间。",
      gift_guidance: "感谢具体送礼用户，说明支持的意义，维护关系；不能是强交易索礼。",
      pk_mobilization: "围绕 PK 给出清晰目标、时间压力和团队参与方式。",
      persona_design: "服装、妆发、动作、表情、背景、道具共同形成主播人设或记忆点。",
      scene_design: "背景、道具、字幕、贴纸或装饰强化内容主题或直播间定位。",
      composition_lighting: "主体、构图、清晰度、灯光、镜头角度让观看体验更清楚舒服。",
      viewer_psychology: "画面氛围强化亲近感、情绪价值、记忆点或持续观看意愿。",
      host_commitment: "主播在当前片段中投入度高，持续面对镜头、回应评论、表情动作随互动变化。",
      scripted_room_event: "直播间有明确事件编排，如开场热场、PK 规则、挑战、表演预热、生日/周年庆。",
      content_richness: "当前片段有信息增量，不机械重复，能自然切换主题、道具、镜头、讲解或互动方式。",
      performance_interaction_loop: "才艺或主题内容结束后，主播承接评价、分享细节并引导下一轮互动。"
    },
    outputShape: {
      schemaVersion: "skill-card-v0.1",
      rubricVersion: "pgc-v1.0",
      promptVersion: "livecue-extension-skill-agent-v0.1",
      skillId: "稳定唯一 id",
      title: "English title, same as localized.en.title",
      category: "welcome|reply_comment|room_atmosphere|gift_guidance|pk_mobilization|persona_design|scene_design|composition_lighting|viewer_psychology|host_commitment|scripted_room_event|content_richness|performance_interaction_loop",
      secondaryCategories: [],
      scenario: "English scenario, same as localized.en.scenario",
      action: "English action, same as localized.en.action",
      effect: "English effect, same as localized.en.effect",
      localized: {
        en: {
          title: "Concise English skill title",
          scenario: "English scene/condition. Explain when this skill applies.",
          action: "English action. Describe the concrete host move other creators can copy.",
          effect: "English effect. Explain why it helps viewers or LIVE room operation."
        },
        zh: {
          title: "简洁中文技巧标题",
          scenario: "中文场景。说明这个技巧适用在什么情况下。",
          action: "中文动作。描述其他主播可复制的具体动作。",
          effect: "中文效果。说明它为什么对观众体验或直播间经营有效。"
        }
      },
      timestamp: "mm:ss",
      sourceLive: { liveUrl: payload.liveUrl, hostName: payload.roomContext?.handle || "" },
      confidence: 0.0
    },
    roomContext: payload.roomContext,
    recentSkillMemory: payload.recentSkillMemory || [],
    liveEvents: payload.liveEvents,
    visualObservation: payload.visualObservation
  }, null, 2);
}

function summarizeVision(result) {
  if (!result) return "";
  const structured = result.structured_description || {};
  return Object.values(structured).filter(Boolean).slice(0, 4).join(" ");
}

function parseJsonObject(text) {
  const clean = String(text || "").trim().replace(/^```(?:json)?/i, "").replace(/```$/i, "").trim();
  try {
    return JSON.parse(clean);
  } catch {
    const match = clean.match(/\{[\s\S]*\}|null/);
    if (!match) throw new Error("Model output is not valid JSON.");
    return JSON.parse(match[0]);
  }
}

function normalizeHandle(handle) {
  return String(handle || "").replace(/^@/, "");
}

function isDifferentRoom(previous = {}, next = {}) {
  const previousRoomId = normalizeRoomId(previous.roomId || previous.tiktokUserId);
  const nextRoomId = normalizeRoomId(next.roomId || next.tiktokUserId);
  if (previousRoomId && nextRoomId && previousRoomId !== nextRoomId) return true;

  const previousHandle = normalizeHandle(previous.handle);
  const nextHandle = normalizeHandle(next.handle);
  if (previousHandle && nextHandle && previousHandle !== nextHandle) return true;

  const previousName = normalizeComparable(previous.streamerDisplayName);
  const nextName = normalizeComparable(next.streamerDisplayName);
  if (previousName && nextName && previousName !== nextName) return true;

  const previousTitle = normalizeComparable(previous.pageTitle);
  const nextTitle = normalizeComparable(next.pageTitle);
  return Boolean(previousTitle && nextTitle && previousTitle !== nextTitle);
}

function normalizeRoomId(value) {
  return String(value || "").trim();
}

function normalizeComparable(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function safeFilename(value) {
  return String(value || "")
    .replace(/[:.]/g, "-")
    .replace(/[^a-zA-Z0-9_\-\u4e00-\u9fa5@]+/g, "_")
    .slice(0, 96) || "unknown";
}

function jsonDataUrl(value) {
  const json = JSON.stringify(value, null, 2);
  return `data:application/json;base64,${utf8ToBase64(json)}`;
}

function utf8ToBase64(value) {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  const chunkSize = 0x8000;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }
  return btoa(binary);
}

function secondsSince(startedAt, capturedAt) {
  return Math.max(0, Math.round((new Date(capturedAt).getTime() - new Date(startedAt).getTime()) / 1000));
}

const SKILL_AGENT_SYSTEM_PROMPT = `你是 TikTok LIVE PGC Skill Agent，也是一名资深直播运营专家。
你的任务不是泛泛总结直播内容，而是从当前直播间观察窗口中，提炼“可被更多主播理解、学习、迁移和复用”的优质直播技能，帮助更多主播通过看播成长为 PGC。

PGC 在这里指具备更高直播职业力、经营力、内容力和生态安全意识的优质主播。你判断 skill 时，必须同时满足两个原则：
1. 可迁移、可复用：skill 必须是主播可学习的具体动作或设计方法，而不是“这个主播很漂亮/这个房间很好看/观众很多”这类不可迁移结论。它应能被其他主播理解为“在什么场景下，做什么动作，为什么有效”。
2. 符合 PGC 导向：skill 应鼓励健康、可持续、有内容价值和互动价值的直播经营，包括欢迎新观众、承接评论、营造氛围、引导礼物但不强交易、PK 动员但不施压、稳定人设、清晰画面、内容编排、才艺或主题互动闭环等。

你只基于输入的 roomContext、liveEvents、visualObservation 和 recentSkillMemory 判断，不使用外部信息，不臆测截图或文本外的事实。

提炼 skill 时遵循：
- 先做负向过滤。普通寒暄、机械 CTA、空泛感谢、强交易索礼、低俗挑逗、生态或安全风险、证据不足，都返回 null。
- 正向 rubric：优先选择同时具备“经营动作明确、观众心理明确、内容结构明确、可迁移方法明确、PGC 导向明确”的技巧。
- 经营动作明确：主播做了具体动作，如点名欢迎、追问、承接评论、解释规则、设置挑战、引导参与、反馈礼物、复盘贡献、安排下一轮互动。
- 观众心理明确：动作能降低进入门槛，制造被看见感、参与感、陪伴感、期待感、归属感，或让新观众更快理解直播间。
- 内容结构明确：主播把直播从单点展示变成可持续流程，如开场-互动-反馈-下一轮，表演-评价-讲解-再互动，PK目标-时间压力-团队动员。
- 可迁移方法明确：其他主播看完后能照着改自己的话术、流程、画面、机制或互动方式。
- PGC 导向明确：健康、克制、有职业感，不靠强刺激、强索取、低俗化或压迫观众。
- 选择 skill 时优先考虑互动经营/评论承接/ASR口播、礼物/PK/房间机制、内容编排/才艺互动闭环；但不要机械排斥视觉类 skill。
- 当 speech/comment 只是普通寒暄或信息量弱，而画面里有清晰可迁移的场景、人设、构图、灯光或道具方法时，可以选择视觉类 skill。
- 视觉类 skill 必须说明视觉元素如何服务直播经营，例如帮助新观众快速理解直播间主题、强化主播定位、支撑互动机制、提升展示清晰度或形成记忆点；不要只因为画面好看、穿搭整洁、灯光清楚就输出。
- 用“场景-动作-效果”讲清楚：scenario 写发生条件，action 写主播可复制的具体做法，effect 写对观众/直播间经营的作用。
- 避免空泛评价词，不要只说“氛围好、互动强、画面好”，必须说清楚它是怎么做到的。
- recentSkillMemory 是本场直播已经输出给用户的技能。不要输出与它语义重复的 skill；如果最明显技巧重复，应寻找当前窗口中下一个有证据的不同技巧。只有确实没有新的证据型技巧时才返回 null。
- category 只能从用户给出的 categoryGuide 中选择一个。
- 输出必须支持中英双语。顶层 title/scenario/action/effect 使用英文，且与 localized.en 保持一致；localized.zh 中提供对应中文版本。
- 英文面向 GitHub/open-source 用户，要自然、简洁、产品化；中文面向中文主播运营，要清楚、可执行。

只输出合法 JSON 对象或 null，不要输出 markdown、解释文字或代码块。`;

const LIVE_VISUAL_BUSINESS_PROMPT = `你是一个直播间画面理解助手。请基于输入截图，对当前直播间画面进行两类输出。
总要求：
1. 只描述截图中可见的信息，不要臆测截图外的信息。
2. 如果某个维度因遮挡、模糊、主播未出镜、直播暂停、游戏画面占主导等原因无法判断，请明确写“画面中无法清晰判断……”。
3. 不要打分，不要输出“优质/普通/低质”等评分结论。
4. 输出必须是合法 JSON，不要输出 Markdown，不要添加解释文字，不要使用代码块。
5. structured_description 中每个维度描述控制在 200 字以内。
6. subjective_judgment 中每个字段描述 200-400 个中文字，基于画面证据。
请严格输出如下 JSON：
{
  "structured_description": {
    "背景": "",
    "前景": "",
    "灯光": "",
    "构图": "",
    "面部妆容": "",
    "服饰": "",
    "发型": ""
  },
  "subjective_judgment": {
    "first_impression": "",
    "visible_activity": "",
    "persona_feeling": "",
    "viewing_experience": ""
  }
}`;
