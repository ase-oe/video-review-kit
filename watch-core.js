// watch-core.js: all the logic for the Video Review Kit.
// Sends images and videos to Gemini with a question and returns Gemini's read.
// Talks only to the Gemini API. Never prints, logs or stores the key.

import { readFileSync, statSync, readdirSync, existsSync } from "node:fs";
import { dirname, join, resolve, extname, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { GoogleGenAI, createPartFromUri } from "@google/genai";

const HERE = dirname(fileURLToPath(import.meta.url));

// The default model is left blank on purpose. Model names go stale, so pick a
// current Flash model from https://ai.google.dev/gemini-api/docs/models and set
// GEMINI_MODEL in your .env or your environment.
const DEFAULT_MODEL = "";

const INLINE_LIMIT = 18 * 1024 * 1024; // 18MB
const POLL_MS = 3000; // check upload state every 3 seconds
const PROCESS_TIMEOUT_MS = 8 * 60 * 1000; // give up after 8 minutes
const MAX_RETRIES = 4; // up to four more tries after the first

const IMAGE_TYPES = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".heic": "image/heic",
  ".heif": "image/heif",
};

const VIDEO_TYPES = {
  ".mp4": "video/mp4",
  ".mov": "video/quicktime",
  ".mpeg": "video/mpeg",
  ".mpg": "video/mpeg",
  ".avi": "video/x-msvideo",
  ".wmv": "video/x-ms-wmv",
  ".flv": "video/x-flv",
  ".webm": "video/webm",
  ".3gp": "video/3gpp",
};

// A friendly error: the CLI and the MCP server print only its message.
export class WatchError extends Error {}

// Read only the GEMINI_API_KEY and GEMINI_MODEL lines from the .env file that
// sits next to this script (found by script location, not the working folder).
function readDotEnv() {
  const out = {};
  const file = join(HERE, ".env");
  if (!existsSync(file)) return out;
  for (const raw of readFileSync(file, "utf8").split(/\r?\n/)) {
    const m = raw.match(/^\s*(?:export\s+)?(GEMINI_API_KEY|GEMINI_MODEL)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    out[m[1]] = v;
  }
  return out;
}

function getSettings(modelOverride) {
  const dot = readDotEnv();
  const key = (process.env.GEMINI_API_KEY || dot.GEMINI_API_KEY || "").trim();
  const model = (modelOverride || process.env.GEMINI_MODEL || dot.GEMINI_MODEL || DEFAULT_MODEL).trim();
  if (!key) {
    throw new WatchError(
      "No Gemini API key found. Add a line GEMINI_API_KEY=your-key to the .env file in the tool's folder, or set GEMINI_API_KEY in your environment."
    );
  }
  if (/^your-.*-here$/.test(key)) {
    throw new WatchError(
      "GEMINI_API_KEY is still the placeholder from .env.example. Replace it in .env with your own key from Google AI Studio."
    );
  }
  if (/^your-.*-here$/.test(model)) {
    throw new WatchError(
      "GEMINI_MODEL is still the placeholder from .env.example. Replace it in .env with a current Flash model name from https://ai.google.dev/gemini-api/docs/models."
    );
  }
  if (!model) {
    throw new WatchError(
      "No Gemini model set. Pick a current Flash model from https://ai.google.dev/gemini-api/docs/models and add GEMINI_MODEL=model-name to your .env file (or your environment)."
    );
  }
  return { key, model };
}

function mimeFor(path) {
  const ext = extname(path).toLowerCase();
  if (IMAGE_TYPES[ext]) return { mime: IMAGE_TYPES[ext], kind: "image" };
  if (VIDEO_TYPES[ext]) return { mime: VIDEO_TYPES[ext], kind: "video" };
  return null;
}

// Turn the given files and folders into a list of media files.
// A folder expands to the images and videos directly inside it.
export function expandPaths(paths) {
  if (!Array.isArray(paths) || paths.length === 0) {
    throw new WatchError("No files given. Pass at least one image or video file, or a folder.");
  }
  const files = [];
  for (const p of paths) {
    const full = resolve(String(p));
    if (!existsSync(full)) throw new WatchError(`File or folder not found: ${p}`);
    const st = statSync(full);
    if (st.isDirectory()) {
      const inside = readdirSync(full)
        .map((name) => join(full, name))
        .filter((f) => statSync(f).isFile() && mimeFor(f))
        .sort();
      if (inside.length === 0) throw new WatchError(`No images or videos directly inside folder: ${p}`);
      files.push(...inside);
    } else {
      if (!mimeFor(full)) {
        throw new WatchError(`Not an image or video this tool knows: ${p}`);
      }
      files.push(full);
    }
  }
  return files;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function statusOf(err) {
  if (err && typeof err.status === "number") return err.status;
  const m = String(err && err.message).match(/\b(4\d\d|5\d\d)\b/);
  return m ? Number(m[1]) : 0;
}

// Retry only errors that say to try again: 429 and 5xx. Never 400 or 403.
async function withRetry(fn) {
  let attempt = 0;
  for (;;) {
    try {
      return await fn();
    } catch (err) {
      const s = statusOf(err);
      const retryable = s === 429 || (s >= 500 && s < 600);
      if (!retryable || attempt >= MAX_RETRIES) throw err;
      attempt += 1;
      await sleep(2000 * 2 ** (attempt - 1)); // 2s, 4s, 8s, 16s
    }
  }
}

// Turn an SDK or network error into one clear sentence, with no stack trace
// and never the key.
function friendly(err, model, key) {
  if (err instanceof WatchError) return err;
  const s = statusOf(err);
  let raw = String((err && err.message) || err || "Unknown error");
  if (key) raw = raw.split(key).join("[hidden]");
  const lower = raw.toLowerCase();
  let msg;
  if ((s === 400 || s === 401 || s === 403) && /api[ _-]?key|permission|unauth|credential/.test(lower)) {
    msg = `Gemini rejected the API key (${s}). Check that GEMINI_API_KEY is right. Retrying will not help.`;
  } else if (s === 404) {
    msg = `Model "${model}" was not found or is no longer available to new users (404). Pick a current model from https://ai.google.dev/gemini-api/docs/models and set GEMINI_MODEL.`;
  } else if (s === 400 || s === 403) {
    msg = `Gemini refused the request (${s}). Check the key and that the file path exists. Retrying will not help. Details: ${shorten(raw)}`;
  } else if (s === 429) {
    msg = `Gemini says too many requests (429) after ${MAX_RETRIES} retries. You may have hit your daily cap. Model: ${model}.`;
  } else if (s >= 500) {
    msg = `Gemini is busy or had a server error (${s}) after ${MAX_RETRIES} retries. Model: ${model}. Try again later.`;
  } else if (/fetch failed|enotfound|econnrefused|etimedout|network/.test(lower)) {
    msg = `Could not reach the Gemini API. Check your internet connection. Details: ${shorten(raw)}`;
  } else {
    msg = `The call to model "${model}" failed: ${shorten(raw)}`;
  }
  return new WatchError(msg);
}

function shorten(text) {
  // Gemini errors often arrive as a JSON blob; pull out the message if so.
  const m = text.match(/"message"\s*:\s*"([^"]+)"/);
  const t = (m ? m[1] : text).replace(/\s+/g, " ").trim();
  return t.length > 300 ? t.slice(0, 300) + "..." : t;
}

// Build the request part for one file: inline for small images, Files API
// for every video and for anything 18MB or more.
async function partFor(ai, file) {
  const { mime, kind } = mimeFor(file);
  const size = statSync(file).size;
  const name = basename(file);
  if (kind === "image" && size < INLINE_LIMIT) {
    return { inlineData: { mimeType: mime, data: readFileSync(file).toString("base64") } };
  }
  let uploaded = await withRetry(() =>
    ai.files.upload({ file, config: { mimeType: mime, displayName: name } })
  );
  const started = Date.now();
  while (uploaded.state === "PROCESSING" || uploaded.state === "STATE_UNSPECIFIED" || !uploaded.state) {
    if (Date.now() - started > PROCESS_TIMEOUT_MS) {
      throw new WatchError(`timeout processing: ${name}`);
    }
    await sleep(POLL_MS);
    uploaded = await withRetry(() => ai.files.get({ name: uploaded.name }));
  }
  if (uploaded.state === "FAILED") {
    throw new WatchError(`Gemini failed to process: ${name}`);
  }
  return createPartFromUri(uploaded.uri, uploaded.mimeType || mime);
}

async function ask(ai, model, parts, question) {
  const res = await withRetry(() =>
    ai.models.generateContent({
      model,
      contents: [{ role: "user", parts: [...parts, { text: question }] }],
    })
  );
  const text = res && res.text;
  if (!text) throw new WatchError(`Model "${model}" returned no text for this request.`);
  return text;
}

/**
 * Watch media with Gemini.
 * @param {object} opts
 * @param {string} opts.question  Required. What to ask about the files.
 * @param {string[]} opts.paths   Required. Files or folders.
 * @param {"together"|"each"} [opts.mode="together"]
 * @param {boolean} [opts.json=false]
 * @param {string} [opts.model]   Overrides the model for this call.
 * @returns {Promise<{model: string, mode: string, results: {file: string, ok: boolean, text: string}[]}>}
 */
export async function watchMedia({ question, paths, mode = "together", json = false, model } = {}) {
  if (!question || !String(question).trim()) {
    throw new WatchError("No question given. Say what you want to know about the files.");
  }
  if (mode !== "together" && mode !== "each") {
    throw new WatchError(`Unknown mode "${mode}". Use "together" or "each".`);
  }
  const files = expandPaths(paths);
  const settings = getSettings(model);
  const ai = new GoogleGenAI({ apiKey: settings.key });
  let q = String(question).trim();
  if (json) q += "\n\nRespond only with valid JSON.";

  const results = [];
  if (mode === "together") {
    try {
      const parts = [];
      for (const f of files) parts.push(await partFor(ai, f));
      const text = await ask(ai, settings.model, parts, q);
      results.push({ file: files.map((f) => basename(f)).join(", "), ok: true, text });
    } catch (err) {
      throw friendly(err, settings.model, settings.key);
    }
  } else {
    for (const f of files) {
      try {
        const text = await ask(ai, settings.model, [await partFor(ai, f)], q);
        results.push({ file: basename(f), ok: true, text });
      } catch (err) {
        results.push({ file: basename(f), ok: false, text: friendly(err, settings.model, settings.key).message });
      }
    }
  }
  return { model: settings.model, mode, results };
}
