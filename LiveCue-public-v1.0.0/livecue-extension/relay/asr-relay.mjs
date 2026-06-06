#!/usr/bin/env node
import { createServer } from "node:http";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { transcribePcmWithDoubao } from "../../live-asr/src/doubaoAsrClient.js";

const PORT = Number(process.env.LIVECUE_ASR_RELAY_PORT || 17395);

const server = createServer(async (req, res) => {
  setCors(res);
  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }
  if (req.method === "GET" && req.url === "/health") {
    sendJson(res, 200, {
      ok: true,
      service: "livecue-asr-relay",
      version: "1.0.0",
      asrPath: "/asr"
    });
    return;
  }
  if (req.method !== "POST" || req.url !== "/asr") {
    sendJson(res, 404, { error: { message: "Not found" } });
    return;
  }

  try {
    const body = JSON.parse(await readBody(req));
    const result = await transcribeAudioDataUrl(body);
    sendJson(res, 200, result);
  } catch (error) {
    sendJson(res, 500, {
      error: {
        name: error?.name || "Error",
        message: error?.message || String(error)
      }
    });
  }
});

server.on("error", (error) => {
  if (error?.code === "EADDRINUSE") {
    console.error(`LiveCue ASR relay could not start because port ${PORT} is already in use.`);
    console.error("Close the existing LiveCue relay window, or restart your computer, then try again.");
  } else if (error?.code === "EACCES" || error?.code === "EPERM") {
    console.error(`LiveCue ASR relay could not listen on 127.0.0.1:${PORT}.`);
    console.error("Please check local firewall/security settings, or try again after restarting your computer.");
  } else {
    console.error("LiveCue ASR relay failed to start.");
    console.error(error?.message || String(error));
  }
  setTimeout(() => process.exit(1), 100);
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`LiveCue ASR relay listening on http://127.0.0.1:${PORT}/asr`);
});

async function transcribeAudioDataUrl({ audioDataUrl, pcm16Base64, sampleRate = 16000, apiKey, language = "zh-CN", startedAt }) {
  if (!apiKey) throw new Error("apiKey is required.");
  if (pcm16Base64) {
    const pcmBytes = Buffer.from(pcm16Base64, "base64");
    const result = await transcribePcmWithDoubao({
      pcmBytes,
      language,
      apiKey,
      sampleRate,
      enableSpeakerInfo: true
    });
    return {
      ...result,
      startedAt: startedAt || new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
  }

  if (!audioDataUrl?.startsWith("data:audio/")) throw new Error("audioDataUrl or pcm16Base64 is required.");
  const tmp = await mkdtemp(join(tmpdir(), "livecue-asr-"));
  const input = join(tmp, "input.webm");
  const pcm = join(tmp, "audio.pcm");
  try {
    const base64 = audioDataUrl.slice(audioDataUrl.indexOf(",") + 1);
    await writeFile(input, Buffer.from(base64, "base64"));
    await runFfmpeg(input, pcm);
    const pcmBytes = await readFile(pcm);
    const result = await transcribePcmWithDoubao({
      pcmBytes,
      language,
      apiKey,
      sampleRate: 16000,
      enableSpeakerInfo: true
    });
    return {
      ...result,
      startedAt: startedAt || new Date().toISOString(),
      endedAt: new Date().toISOString()
    };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
}

function runFfmpeg(input, output) {
  return new Promise((resolve, reject) => {
    const ffmpeg = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      "-y",
      "-i", input,
      "-ac", "1",
      "-ar", "16000",
      "-f", "s16le",
      output
    ]);
    let stderr = "";
    ffmpeg.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    ffmpeg.on("error", reject);
    ffmpeg.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg failed with code ${code}: ${stderr.slice(-1000)}`));
    });
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (chunk) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function setCors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
}

function sendJson(res, status, body) {
  setCors(res);
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(body));
}
