#!/usr/bin/env node
// watch.js: command line way in to the Video Review Kit.
// Usage: node watch.js -q "question" [--each] [--json] [--model name] <file-or-folder> [...]

import { watchMedia } from "./watch-core.js";

const USAGE = `Usage: node watch.js -q "your question" [--each] [--json] [--model name] <file or folder> [more...]

  -q, --question   What to ask about the files (required)
  --each           One request and one answer per file (default: all files together)
  --json           Ask Gemini to respond only with valid JSON
  --model NAME     Use this model for this call instead of GEMINI_MODEL
  -h, --help       Show this help`;

function parseArgs(argv) {
  const opts = { paths: [], mode: "together", json: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "-q" || a === "--question") opts.question = argv[++i];
    else if (a === "--each") opts.mode = "each";
    else if (a === "--json") opts.json = true;
    else if (a === "--model") opts.model = argv[++i];
    else if (a === "-h" || a === "--help") opts.help = true;
    else if (a.startsWith("--")) throw new Error(`Unknown option: ${a}`);
    else opts.paths.push(a);
  }
  return opts;
}

async function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (err) {
    console.error(`Error: ${err.message}\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  if (opts.help) {
    console.log(USAGE);
    return;
  }
  if (!opts.question || opts.paths.length === 0) {
    console.error(`Error: a question (-q) and at least one file or folder are required.\n\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  try {
    const { results, mode } = await watchMedia(opts);
    let failed = 0;
    for (const r of results) {
      if (mode === "each") console.log(`=== ${r.file} ===`);
      if (r.ok) console.log(r.text);
      else {
        console.log(`Error: ${r.text}`);
        failed += 1;
      }
      if (mode === "each") console.log("");
    }
    if (failed) process.exitCode = 1;
  } catch (err) {
    // Print the message only, never a stack trace. Let the process end by itself.
    console.error(`Error: ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}

main();
