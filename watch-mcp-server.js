#!/usr/bin/env node
// watch-mcp-server.js: MCP server "video-review" with one tool, watch_media.
// Talks to Claude over stdio only, so any log lines go to stderr, never stdout.

import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ListToolsRequestSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import { watchMedia } from "./watch-core.js";

const log = (...args) => console.error("[video-review]", ...args);

const TOOL = {
  name: "watch_media",
  description:
    "Send videos (with sound) or images to Gemini with a question and return Gemini's read. Use it for any video. Keep single images, screenshots and PDFs with Claude.",
  inputSchema: {
    type: "object",
    properties: {
      question: { type: "string", description: "What to ask about the files." },
      paths: {
        type: "array",
        items: { type: "string" },
        description: "Full paths to files or folders. A folder expands to the images and videos directly inside it.",
      },
      mode: {
        type: "string",
        enum: ["together", "each"],
        description: "together (default): all files in one request, one answer. each: one request and one answer per file.",
      },
      json: { type: "boolean", description: "When true, ask Gemini to respond only with valid JSON." },
      model: { type: "string", description: "Optional. Overrides the model for this call." },
    },
    required: ["question", "paths"],
  },
};

const server = new Server({ name: "video-review", version: "1.0.0" }, { capabilities: { tools: {} } });

server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: [TOOL] }));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  if (req.params.name !== TOOL.name) {
    return { isError: true, content: [{ type: "text", text: `Unknown tool: ${req.params.name}` }] };
  }
  const args = req.params.arguments || {};
  try {
    const { results, mode, model } = await watchMedia({
      question: args.question,
      paths: Array.isArray(args.paths) ? args.paths : args.paths ? [args.paths] : [],
      mode: args.mode || "together",
      json: Boolean(args.json),
      model: args.model,
    });
    const text =
      mode === "each"
        ? results.map((r) => `=== ${r.file} ===\n${r.ok ? r.text : "Error: " + r.text}`).join("\n\n")
        : results[0].text;
    const allFailed = results.every((r) => !r.ok);
    return { isError: allFailed, content: [{ type: "text", text: `${text}\n\n(model: ${model})` }] };
  } catch (err) {
    const msg = err && err.message ? err.message : String(err);
    log("watch_media failed:", msg);
    return { isError: true, content: [{ type: "text", text: `Error: ${msg}` }] };
  }
});

await server.connect(new StdioServerTransport());
log("ready");
