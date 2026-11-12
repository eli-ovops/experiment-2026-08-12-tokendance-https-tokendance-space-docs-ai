#!/usr/bin/env node

/**
 * A zero-dependency CLI for TokenDance's MiniMax video_generation_v2 protocol.
 * The API key is intentionally read only from TOKENDANCE_API_KEY.
 */

import { mkdir, writeFile } from "node:fs/promises";
import { basename, resolve } from "node:path";

const BASE_URL = "https://tokendance.space/gateway/minimax/v2";
const MODEL = "minimax-h3";

const usage = `
TokenDance MiniMax H3 CLI

Usage:
  TOKENDANCE_API_KEY=... node td-minimax-h3.mjs models
  TOKENDANCE_API_KEY=... node td-minimax-h3.mjs submit --prompt "..." [options]
  TOKENDANCE_API_KEY=... node td-minimax-h3.mjs status TASK_ID
  TOKENDANCE_API_KEY=... node td-minimax-h3.mjs wait TASK_ID [--interval 10] [--download-dir ./videos]

submit options:
  --ratio 16:9                 Text-to-video only; default: 16:9
  --resolution 2K              Default: 2K
  --duration 6                 Default: 6 seconds
  --first-frame URL            Image-to-video first frame
  --last-frame URL             Image-to-video last frame
  --reference-image URL        Repeatable reference image
  --reference-video URL        Repeatable reference video
  --reference-audio URL        Repeatable reference audio

Examples:
  TOKENDANCE_API_KEY=... node td-minimax-h3.mjs submit \\
    --prompt "A slow dolly through a rainy neon alley, cinematic ambience" \\
    --ratio 16:9 --resolution 2K --duration 6

  TOKENDANCE_API_KEY=... node td-minimax-h3.mjs submit \\
    --prompt "The character turns and smiles" \\
    --first-frame https://example.com/first.jpg
`;

function fail(message) {
  console.error(`Error: ${message}`);
  process.exit(1);
}

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = { referenceImage: [], referenceVideo: [], referenceAudio: [] };
  const positional = [];
  const aliases = {
    "first-frame": "firstFrame",
    "last-frame": "lastFrame",
    "reference-image": "referenceImage",
    "reference-video": "referenceVideo",
    "reference-audio": "referenceAudio",
    "download-dir": "downloadDir",
  };

  for (let index = 0; index < rest.length; index += 1) {
    const token = rest[index];
    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }
    const rawKey = token.slice(2);
    const key = aliases[rawKey] ?? rawKey;
    const value = rest[index + 1];
    if (!value || value.startsWith("--")) fail(`Missing value for --${rawKey}`);
    index += 1;
    if (Array.isArray(options[key])) options[key].push(value);
    else options[key] = value;
  }
  return { command, positional, options };
}

async function request(path, init = {}) {
  const apiKey = process.env.TOKENDANCE_API_KEY;
  if (!apiKey) fail("Set TOKENDANCE_API_KEY before calling the gateway.");
  const response = await fetch(`${BASE_URL}${path}`, {
    ...init,
    headers: { Authorization: `Bearer ${apiKey}`, ...(init.headers ?? {}) },
  });
  const body = await response.text();
  let data;
  try { data = JSON.parse(body); } catch { data = body; }
  if (!response.ok) {
    console.error(JSON.stringify(data, null, 2));
    fail(`Gateway returned HTTP ${response.status}`);
  }
  return data;
}

function image(url, role) {
  return { type: "image_url", image_url: { url }, ...(role ? { role } : {}) };
}

function media(url, type, role) {
  return { type, [type]: { url }, role };
}

async function submit(options) {
  if (!options.prompt) fail("submit requires --prompt.");
  const hasImageMode = options.firstFrame || options.lastFrame;
  const hasReferences = options.referenceImage.length || options.referenceVideo.length || options.referenceAudio.length;
  if ((options.firstFrame || options.lastFrame) && hasReferences) {
    fail("Use first/last frames or reference media in one request, not both.");
  }
  if (options.lastFrame && !options.firstFrame) fail("--last-frame requires --first-frame.");

  const content = [{ type: "text", text: options.prompt }];
  if (hasImageMode) {
    content.push(image(options.firstFrame, "first_frame"));
    if (options.lastFrame) content.push(image(options.lastFrame, "last_frame"));
  } else if (hasReferences) {
    for (const url of options.referenceImage) content.push(image(url, "reference_image"));
    for (const url of options.referenceVideo) content.push(media(url, "video_url", "reference_video"));
    for (const url of options.referenceAudio) content.push(media(url, "audio_url", "reference_audio"));
  }

  const payload = {
    model: MODEL,
    resolution: options.resolution ?? "2K",
    duration: Number(options.duration ?? 6),
    content,
  };
  if (!hasImageMode && !hasReferences) payload.ratio = options.ratio ?? "16:9";

  const result = await request("/video_generation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  console.log(JSON.stringify(result, null, 2));
}

async function status(taskId) {
  if (!taskId) fail("status requires TASK_ID.");
  const result = await request(`/query/video_generation/${encodeURIComponent(taskId)}`);
  console.log(JSON.stringify(result, null, 2));
  return result;
}

async function download(url, directory) {
  await mkdir(directory, { recursive: true });
  const response = await fetch(url);
  if (!response.ok) fail(`Video download returned HTTP ${response.status}`);
  const target = resolve(directory, basename(new URL(url).pathname) || "minimax-h3.mp4");
  await writeFile(target, Buffer.from(await response.arrayBuffer()));
  console.log(`Downloaded: ${target}`);
}

async function waitForTask(taskId, options) {
  const interval = Number(options.interval ?? 10);
  if (!Number.isFinite(interval) || interval < 1) fail("--interval must be at least 1 second.");
  for (;;) {
    const result = await status(taskId);
    const task = result.task;
    if (!task?.status) fail("Response has no task.status; inspect the JSON above.");
    if (task.status === "succeeded") {
      const url = task.content?.url;
      if (!url) fail("Task succeeded but task.content.url is missing.");
      console.log(`Video URL (expires in 24 hours): ${url}`);
      if (options.downloadDir) await download(url, options.downloadDir);
      return;
    }
    if (["failed", "cancelled", "expired"].includes(task.status)) fail(`Task ended as ${task.status}.`);
    await new Promise((resolve) => setTimeout(resolve, interval * 1_000));
  }
}

const { command, positional, options } = parseArgs(process.argv.slice(2));
if (!command || command === "help" || command === "--help") {
  console.log(usage);
} else if (command === "models") {
  const apiKey = process.env.TOKENDANCE_API_KEY;
  if (!apiKey) fail("Set TOKENDANCE_API_KEY before calling the gateway.");
  const response = await fetch("https://tokendance.space/gateway/v1/models", { headers: { Authorization: `Bearer ${apiKey}` } });
  if (!response.ok) fail(`Model directory returned HTTP ${response.status}`);
  const { data } = await response.json();
  console.log(JSON.stringify(data.filter((model) => model.id === MODEL), null, 2));
} else if (command === "submit") {
  await submit(options);
} else if (command === "status") {
  await status(positional[0]);
} else if (command === "wait") {
  await waitForTask(positional[0], options);
} else {
  console.log(usage);
  fail(`Unknown command: ${command}`);
}
