/**
 * Pure browser-side TikTok LIVE extractor.
 *
 * Intended for Chrome extension content scripts. It relies only on the running
 * page's document/window and does not use screenshots or visual recognition.
 */

function extractTikTokLive(doc = document, win = window, options = {}) {
  const maxComments = clampNumber(options.maxComments ?? 30, 0, 200);
  const includeRaw = Boolean(options.includeRaw);
  const clean = (value) => String(value || "").replace(/\s+/g, " ").trim();

  const jsonLd = parseJsonLd(doc);
  const webPage = jsonLd.find((item) => item?.["@type"] === "WebPage");
  const profile = jsonLd.find((item) => item?.["@type"] === "ProfilePage");
  const video = jsonLd.find((item) => item?.["@type"] === "VideoObject");
  const person = profile?.mainEntity || webPage?.creator || {};

  const avatarUrl = person.image || null;
  const coverOrOgImageUrl =
    doc.querySelector('meta[property="og:image"]')?.content ||
    firstArrayItem(video?.thumbnailUrl) ||
    null;
  const imageForUserId = avatarUrl || coverOrOgImageUrl || "";
  const tiktokUserId = imageForUserId.match(/userId=(\d+)/)?.[1] || null;
  const webAppContext = extractWebAppContext(doc);
  const domViewerText = findDomViewerText(doc, clean);
  const domViewerCount = domViewerText?.match(/(\d[\d,]*)/)?.[1]?.replace(/,/g, "") || null;
  const schemaProfileViewer = readInteractionCount(person, "WatchAction");
  const schemaVideoViewer = readInteractionCount(video, "WatchAction");

  const primaryHost = {
    name: person.name || webPage?.creator?.name || null,
    handle: person.alternateName || person.identifier || null,
    tags: ["所在直播间主播"],
    score: null
  };

  const multiguestParticipants = extractMultiGuestParticipants(doc, clean, { includeRaw });
  const cohost = extractCohost(doc, clean, {
    includeRaw,
    primaryHost,
    primaryHandle: primaryHost.handle
  });
  const networkSignals = extractNetworkSignals(win, options);
  const mergedCohost = mergeNetworkCohostSignals(cohost, networkSignals, primaryHost.handle);

  const snapshot = {
    capturedAt: new Date().toISOString(),
    title: doc.title,
    streamerDisplayName: person.name || webPage?.creator?.name || null,
    handle: person.alternateName || person.identifier || null,
    tiktokUserId,
    pageStatus: video?.publication?.isLiveBroadcast
      ? "live"
      : /正在直播|LIVE/i.test(doc.title)
        ? "live"
        : "unknown",
    liveUrl: win.location.href,
    profileUrl: firstArrayItem(person.sameAs) || webPage?.creator?.url || null,
    avatarUrl,
    coverOrOgImageUrl,
    description:
      doc.querySelector('meta[name="description"]')?.content ||
      person.description ||
      video?.description ||
      null,
    followerCount:
      readInteractionCount(person, "FollowAction") ??
      readInteractionCount(webPage?.creator, "FollowAction"),
    currentViewerCount: domViewerCount
      ? Number(domViewerCount)
      : schemaProfileViewer ?? schemaVideoViewer,
    viewerCountSources: {
      domChatHeader: domViewerCount,
      schemaProfile: schemaProfileViewer,
      schemaVideo: schemaVideoViewer
    },
    liveStartTime: video?.publication?.startDate || video?.uploadDate || null,
    liveEndTimeFromSchema: video?.publication?.endDate || null,
    pageLanguageRegionContext: webAppContext
      ? {
          language: webAppContext.language,
          region: webAppContext.region,
          clusterRegion: webAppContext.clusterRegion
        }
      : null,
    webAppContext,
    comments: extractComments(doc, clean, { maxComments, includeRaw }),
    multiguest: {
      isActive: multiguestParticipants.length > 0,
      participants: multiguestParticipants
    },
    cohost: mergedCohost,
    networkSignals,
    diagnostics: buildDiagnostics(doc, clean)
  };

  return snapshot;
}

function waitForTikTokLiveHydration(doc = document, timeoutMs = 12000) {
  const ready = () =>
    Boolean(doc.querySelector('[data-e2e="live-chat-container"]')) ||
    Boolean(doc.querySelector('[data-e2e="live-room-content"]')?.textContent?.match(/主播|host|guest|cohost/i));

  if (ready()) return Promise.resolve(true);

  return new Promise((resolve) => {
    const deadline = Date.now() + timeoutMs;
    const observer = new MutationObserver(() => {
      if (ready()) {
        observer.disconnect();
        resolve(true);
      } else if (Date.now() > deadline) {
        observer.disconnect();
        resolve(false);
      }
    });
    observer.observe(doc.documentElement, { childList: true, subtree: true, characterData: true });
    setTimeout(() => {
      observer.disconnect();
      resolve(ready());
    }, timeoutMs);
  });
}

function parseJsonLd(doc) {
  return Array.from(doc.querySelectorAll('script[type="application/ld+json"]'))
    .map((script) => {
      try {
        return JSON.parse(script.textContent);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function extractWebAppContext(doc) {
  const universalEl = doc.getElementById("__UNIVERSAL_DATA_FOR_REHYDRATION__");
  if (!universalEl) return null;

  try {
    const data = JSON.parse(universalEl.textContent);
    const ctx = data.__DEFAULT_SCOPE__?.["webapp.app-context"];
    if (!ctx) return null;
    return {
      language: ctx.language,
      region: ctx.region,
      appId: ctx.appId,
      appType: ctx.appType,
      wid: ctx.wid,
      requestId: ctx.requestId,
      clusterRegion: ctx.clusterRegion,
      botType: ctx.botType
    };
  } catch {
    return null;
  }
}

function findDomViewerText(doc, clean) {
  return Array.from(doc.querySelectorAll('[data-e2e="live-chat-container"] div'))
    .map((el) => clean(el.textContent))
    .filter((text) => /^观众·\s*\d+/.test(text) || /^Viewers?\s*·?\s*\d+/i.test(text))
    .sort((a, b) => a.length - b.length)[0];
}

function extractComments(doc, clean, options) {
  const selector = [
    '[data-e2e="chat-message"]',
    '[data-e2e="social-message"]',
    '[data-e2e="enter-message"]'
  ].join(", ");

  return Array.from(doc.querySelectorAll(selector))
    .slice(0, options.maxComments)
    .map((el) => extractMessage(el, clean, options));
}

function extractMessage(el, clean, options) {
  const type = el.getAttribute("data-e2e");
  const commenterName = clean(el.querySelector('[data-e2e="message-owner-name"]')?.textContent) || null;
  const rawText = clean(el.textContent);
  const textNode = Array.from(el.querySelectorAll("div")).find((node) =>
    /w-full break-words align-middle/.test(String(node.className || ""))
  );
  let text = clean(textNode?.textContent);

  if (!text) {
    text = commenterName && rawText.includes(commenterName)
      ? clean(rawText.slice(rawText.indexOf(commenterName) + commenterName.length))
      : rawText;
  }

  const parts = Array.from(el.querySelectorAll("div, span"))
    .map((node) => clean(node.textContent))
    .filter(Boolean);

  const commenterTags = [];
  const level = parts.find((part) => /^\d{1,3}$/.test(part));
  if (level) commenterTags.push({ type: "level", value: level });

  const badge = parts.find(
    (part) => /^[A-Z0-9_]{2,}$/.test(part) && part !== commenterName && part !== text && part !== level
  );
  if (badge) commenterTags.push({ type: "badge", value: badge });

  const rank = parts.find((part) => /^第\s*\d+/.test(part));
  if (rank) commenterTags.push({ type: "rank", value: rank });

  const output = { type, commenterName, commenterTags, text: text || null };
  if (options.includeRaw) output.rawText = rawText;
  return output;
}

function extractMultiGuestParticipants(doc, clean, options) {
  const root = doc.querySelector('[data-e2e="live-room-content"]');
  if (!root) return [];

  const tileEls = findMultiGuestTileElements(root, clean);
  const seen = new Set();

  return tileEls
    .map((el) => extractMultiGuestTile(el, clean, options))
    .filter((tile) => {
      const key = [tile.role, tile.name, tile.score].join("|");
      if (!tile.name || seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function findMultiGuestTileElements(root, clean) {
  const generatedTileMatches = Array.from(root.querySelectorAll("div")).filter((el) => {
    const cls = String(el.className || "");
    const rect = el.getBoundingClientRect();
    const text = clean(el.textContent);
    return cls.includes("tiktok-7jlshd") && rect.width > 80 && rect.height > 50 && text;
  });

  if (generatedTileMatches.length) return generatedTileMatches;

  // Fallback when generated class changes: find large leaf-ish tiles with host text,
  // an avatar image, or a visible numeric score plus name text.
  return Array.from(root.querySelectorAll("div")).filter((el) => {
    const rect = el.getBoundingClientRect();
    const text = clean(el.textContent);
    if (rect.width < 80 || rect.height < 50 || !text) return false;
    const hasAvatar = Boolean(el.querySelector("img"));
    const hasHost = text.includes("主播") || /\bhost\b/i.test(text);
    const hasScoreName = /^\d+/.test(text) && /[^\d\s]/.test(text.replace(/^\d+/, ""));
    return hasHost || hasAvatar || hasScoreName;
  });
}

function extractMultiGuestTile(el, clean, options) {
  const rect = el.getBoundingClientRect();
  const rawText = clean(el.textContent);
  const avatar = el.querySelector("img")?.src || null;
  const leafs = Array.from(el.querySelectorAll("div"))
    .map((node) => ({
      text: clean(node.textContent),
      className: String(node.className || ""),
      rect: node.getBoundingClientRect()
    }))
    .filter((item) => item.text && item.rect.width > 0 && item.rect.height > 0);

  const role = rawText.includes("主播") || /\bhost\b/i.test(rawText) ? "host" : "guest";
  let score = null;
  let name = null;
  const tags = [];

  if (role === "host") {
    tags.push("主播");
    name =
      leafs.map((item) => item.text).find((text) => text && text !== "主播" && !/^\d+$/.test(text)) ||
      rawText.replace("主播", "");
  } else {
    score = leafs.find((item) => /^\d+$/.test(item.text))?.text || rawText.match(/^(\d+)/)?.[1] || null;
    name =
      leafs.slice().reverse().find((item) => item.text && item.text !== score && !/^\d+$/.test(item.text))?.text ||
      rawText.replace(score || "", "");
  }

  const output = { role, name: name || null, tags, score, avatar };
  if (options.includeRaw) {
    output.rawText = rawText;
    output.rect = {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height)
    };
  }
  return output;
}

function extractNetworkSignals(win, options) {
  const signals = options.networkSignals || win.__tiktokLiveNetworkSignals || null;
  if (!signals) {
    return {
      isInstalled: false,
      webcastRequestCount: 0,
      websocketFrameCount: 0,
      cohostCandidates: []
    };
  }

  const webcastRequests = Array.isArray(signals.webcastRequests) ? signals.webcastRequests : [];
  const websocketFrames = Array.isArray(signals.websocketFrames) ? signals.websocketFrames : [];
  const cohostCandidates = dedupeBy(
    (Array.isArray(signals.cohostCandidates) ? signals.cohostCandidates : [])
      .map(normalizeNetworkCohostCandidate)
      .filter((candidate) => candidate.name || candidate.handle || candidate.userId),
    (candidate) => candidate.handle || candidate.userId || candidate.name
  );

  return {
    isInstalled: true,
    installedAt: signals.installedAt || null,
    webcastRequestCount: webcastRequests.length,
    websocketFrameCount: websocketFrames.length,
    cohostCandidates
  };
}

function normalizeNetworkCohostCandidate(candidate) {
  const user = candidate.user || candidate.anchor || candidate;
  const handle =
    user.handle ||
    user.uniqueId ||
    user.unique_id ||
    user.displayId ||
    user.display_id ||
    user.secUid ||
    null;
  const name =
    user.name ||
    user.nickname ||
    user.nickName ||
    user.displayName ||
    user.display_name ||
    candidate.name ||
    null;
  const score = candidate.score ?? candidate.integral ?? candidate.points ?? user.score ?? null;
  const userId = String(user.userId || user.user_id || user.id || candidate.userId || "").trim() || null;

  return {
    name,
    handle,
    userId,
    tags: candidate.tags || ["cohost", "webcast"],
    score: score == null ? null : String(score),
    avatar: user.avatar || user.avatarThumb || user.avatar_thumb || candidate.avatar || null,
    source: candidate.source || "webcast"
  };
}

function mergeNetworkCohostSignals(cohost, networkSignals, primaryHandle) {
  if (!networkSignals?.cohostCandidates?.length) return cohost;

  const cohostHosts = [...cohost.cohostHosts];
  for (const candidate of networkSignals.cohostCandidates) {
    if (candidate.handle && candidate.handle === primaryHandle) {
      cohost.roomHost.score = candidate.score ?? cohost.roomHost.score ?? null;
      continue;
    }

    const existing = cohostHosts.find((host) =>
      (candidate.handle && host.handle === candidate.handle) ||
      (candidate.userId && host.userId === candidate.userId) ||
      (candidate.name && host.name === candidate.name)
    );

    if (existing) {
      existing.score = existing.score ?? candidate.score ?? null;
      existing.tags = dedupeBy([...(existing.tags || []), ...(candidate.tags || [])], (tag) => tag);
      existing.source = existing.source || "dom+webcast";
    } else {
      cohostHosts.push(candidate);
    }
  }

  return {
    ...cohost,
    isActive: cohost.isActive || cohostHosts.length > 0,
    cohostHosts
  };
}

function extractCohost(doc, clean, options) {
  const root = doc.querySelector('[data-e2e="live-room-content"]');
  const empty = {
    isActive: false,
    roomHost: { ...options.primaryHost },
    cohostHosts: []
  };
  if (!root) return empty;

  const text = clean(root.textContent);
  const hasCohostSignal = /\b(cohost|co-host|pk|battle|match|vs)\b|连线|对战|PK/i.test(text);
  const multiguestCount = findMultiGuestTileElements(root, clean).length;
  const anchorCandidates = extractVisibleAnchorCandidates(root, clean, options.primaryHandle);
  const cohostHosts = anchorCandidates
    .filter((candidate) => candidate.handle !== options.primaryHandle)
    .map((candidate) => ({
      name: candidate.name,
      handle: candidate.handle,
      tags: candidate.tags,
      score: null,
      avatar: candidate.avatar || null,
      ...(options.includeRaw ? { rawText: candidate.rawText, rect: candidate.rect } : {})
    }));

  const pkScores = extractVisiblePkScores(root, clean);
  const roomHost = { ...options.primaryHost };
  if (pkScores.length >= 2 && (cohostHosts.length || hasCohostSignal)) {
    roomHost.score = pkScores[0]?.value ?? null;
    cohostHosts.forEach((host, index) => {
      host.score = pkScores[index + 1]?.value ?? host.score ?? null;
    });
  }

  const isActive = cohostHosts.length > 0 || (hasCohostSignal && multiguestCount === 0);
  const output = {
    isActive,
    roomHost,
    cohostHosts
  };

  if (options.includeRaw) {
    output.rawSignals = {
      hasCohostSignal,
      multiguestCandidateCount: multiguestCount,
      anchorCandidateCount: anchorCandidates.length,
      pkScores
    };
  }

  return output;
}

function extractVisibleAnchorCandidates(root, clean, primaryHandle) {
  const candidates = [];
  for (const link of root.querySelectorAll('a[href*="/@"]')) {
    const rect = link.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) continue;

    const href = link.getAttribute("href") || "";
    const handle = href.match(/\/@([^/?#]+)/)?.[1] || null;
    const rawText = clean(link.textContent);
    const aria = clean(link.getAttribute("aria-label"));
    const name = rawText || aria.replace(/^@/, "") || handle;
    if (!name && !handle) continue;

    const nearby = clean(link.parentElement?.textContent);
    const tags = [];
    if (nearby.includes("主播") || handle === primaryHandle) tags.push("主播");
    if (/\b(cohost|co-host)\b|连线/i.test(nearby)) tags.push("cohost");

    candidates.push({
      name,
      handle,
      tags,
      avatar: link.querySelector("img")?.src || link.closest("div")?.querySelector("img")?.src || null,
      rawText: nearby || rawText,
      rect: {
        x: Math.round(rect.x),
        y: Math.round(rect.y),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      }
    });
  }

  return dedupeBy(candidates, (item) => item.handle || item.name);
}

function extractVisiblePkScores(root, clean) {
  const numericNodes = Array.from(root.querySelectorAll("div, span"))
    .map((node) => {
      const rect = node.getBoundingClientRect();
      return {
        value: clean(node.textContent),
        rect: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height)
        }
      };
    })
    .filter((item) => {
      if (!/^\d{1,8}$/.test(item.value)) return false;
      if (item.rect.width <= 0 || item.rect.height <= 0) return false;
      return true;
    });

  // Avoid treating multiguest per-seat score as cohost PK score unless the room
  // also exposes a cohost/PK signal. Caller decides whether to use these.
  return dedupeBy(numericNodes, (item) => `${item.value}|${item.rect.x}|${item.rect.y}`)
    .sort((a, b) => a.rect.x - b.rect.x || a.rect.y - b.rect.y);
}

function buildDiagnostics(doc, clean) {
  const cohostRoot = doc.querySelector('[data-e2e="live-room-content"]');
  return {
    hasLiveRoomContent: Boolean(cohostRoot),
    hasLiveChatContainer: Boolean(doc.querySelector('[data-e2e="live-chat-container"]')),
    bodyTextLength: clean(doc.body?.textContent).length,
    commentNodeCount: doc.querySelectorAll(
      '[data-e2e="chat-message"], [data-e2e="social-message"], [data-e2e="enter-message"]'
    ).length,
    multiguestTileCandidateCount: cohostRoot ? findMultiGuestTileElements(cohostRoot, clean).length : 0,
    cohostAnchorCandidateCount: cohostRoot ? extractVisibleAnchorCandidates(cohostRoot, clean).length : 0
  };
}

function readInteractionCount(obj, actionName) {
  return (obj?.interactionStatistic || []).find((stat) =>
    String(stat.interactionType?.["@type"] || "").includes(actionName)
  )?.userInteractionCount ?? null;
}

function firstArrayItem(value) {
  return Array.isArray(value) ? value[0] : value;
}

function clampNumber(value, min, max) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return min;
  return Math.max(min, Math.min(max, parsed));
}

function dedupeBy(items, keyFn) {
  const seen = new Set();
  return items.filter((item) => {
    const key = keyFn(item);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

window.LiveCueTikTokExtractor = {
  extractTikTokLive,
  waitForTikTokLiveHydration
};
