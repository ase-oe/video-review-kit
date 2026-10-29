# Video Review Kit

A small tool that hands a video to Google's Gemini, picture and sound together, and brings Gemini's read back to Claude. Claude takes in pictures, not sound, so on video it only sees a few still frames. This tool lets Gemini do the watching while Claude stays in charge of the conversation.

It works two ways:

- `watch.js`: a command line tool.
- `watch-mcp-server.js`: an MCP server named `video-review` with one tool, `watch_media`, for Claude Code or any Claude app that can use MCP tools.

Both call `watch-core.js`, which holds all the logic. The full guide, including the routing rule, honest limits and fixes for common errors, is here:

**https://olympusengine.io/care-package/video-review**

Read the code before you run it. What you send goes to Google, so read the guide's "Honest limits" section first.

## What you need

- Node 20 or newer.
- A Gemini API key. Make one in Google AI Studio (https://aistudio.google.com). It is free to start.
- For the MCP part: Claude Code, or another Claude app that can use MCP tools.

## Setup

1. Get the code and install its two packages:

   ```
   git clone https://github.com/ase-oe/video-review-kit.git
   cd video-review-kit
   npm install
   ```

2. Make your `.env` file from the example:

   ```
   cp .env.example .env
   ```

   On Windows Command Prompt use `copy .env.example .env`.

3. Open `.env` and replace both placeholder values:

   - `GEMINI_API_KEY=` followed by your key.
   - `GEMINI_MODEL=` followed by a current Flash model name from Google's models page (https://ai.google.dev/gemini-api/docs/models). The tool has no built in default on purpose: model names go stale, and a retired name fails with a 404.

   `.gitignore` already lists `.env`, so the key never gets committed. You can set `GEMINI_API_KEY` and `GEMINI_MODEL` as environment variables instead; those win over `.env`. Never put the key in Claude's MCP settings, and never paste it into a chat.

4. Run the quick test on the sample files that ship in `samples/` (see "Quick test" below).

## Quick test

The `samples/` folder holds two small, neutral test files:

- `sample-clip.mp4`: three seconds, a plain title card, and a synthetic voice saying "The blue kite flies over the quiet green hill."
- `sample-image.png`: a red square, a blue square, and the words "RED AND BLUE".

Hear the clip:

```
node watch.js -q "What is said in this video? Quote it exactly." samples/sample-clip.mp4
```

If the answer quotes the sentence about the blue kite, sight and sound are working.

See the image (images work too, even though single images belong with Claude):

```
node watch.js -q "What shapes, colors and words are in this image?" samples/sample-image.png
```

Then try it on a short video of your own with someone talking, using the full path to the file.

## Command line usage

```
node watch.js -q "your question" [--each] [--json] [--model NAME] <file or folder> [more...]
```

| Option | Meaning |
|---|---|
| `-q` | Required. What to ask about the files. |
| paths | Required. Files or folders. A folder expands to the images and videos directly inside it. |
| `--each` | One request and one answer per file, good for scoring a batch. Without it, all files go in one request with one answer, good for comparing. |
| `--json` | Adds "Respond only with valid JSON." to the question. |
| `--model` | Overrides the model for this call. |

Examples:

```
node watch.js -q "Score each video from 1 to 10 on how well the first three seconds stop the scroll, with one line on why." --each /full/path/to/folder
node watch.js -q "List every on-screen text overlay with its start time, end time and exact words." --json /full/path/to/reel.mp4
```

## Connect it to Claude Code

Register the server once, for your user, with the full path to the server file:

```
claude mcp add --scope user video-review -- node "/full/path/to/video-review-kit/watch-mcp-server.js"
```

Do not add your key to this command. The server reads it from the `.env` file next to the script (found by the script's location, not the folder Claude starts it from) or from your environment.

Then quit Claude Code and open it again. A running Claude Code does not pick up a new tool or a new environment variable until it starts fresh. Check the connection with:

```
claude mcp get video-review
```

Then ask Claude something like:

```
Use the watch_media tool on /path/to/reel.mp4. Ask it: "Watch this video with the sound on. Give me a timestamped breakdown of the hook, every cut, every piece of on-screen text, the voiceover and the music." Then give me your notes on what to keep and what to change.
```

The `watch_media` tool takes `question` (required), `paths` (required), `mode` (`together` or `each`), `json` (true or false) and `model` (optional).

## How it works

- An image under 18MB goes inside the request itself.
- A video of any size, or any file of 18MB or more, goes through Google's Files API. The tool uploads it, checks its state every 3 seconds until it is ready, and stops after 8 minutes with "timeout processing" and the file name. If Google reports the file as failed, it stops with "Gemini failed to process" and the file name.
- In `each` mode, a failure on one file is reported for that file and the rest still run.
- Only 429 (too many requests) and 5xx (busy or server error) are retried, up to four more times with a longer wait before each. A 400 or 403 is never retried; it means a bad key or a bad request.
- It never switches to a different model on its own. If the model fails, it says so and names the model.
- Errors print as one plain line with no stack trace, and the process sets its exit code and ends by itself.
- The key comes only from `GEMINI_API_KEY` in your environment or the `.env` file next to the scripts. It is never printed or logged.
- It talks only to the Gemini API. No analytics, no other network calls. The MCP server talks to Claude over stdio and writes any log lines to stderr.

## When it breaks

- **"No Gemini API key found" or "No Gemini model set."** Fill in `.env` as in Setup step 3.
- **"Gemini rejected the API key."** The key is wrong or was revoked. Make a new one in Google AI Studio.
- **A 404 that says the model is not available.** Pick a current model from Google's models page and set `GEMINI_MODEL`.
- **"timeout processing" or "Gemini failed to process."** Try a shorter file, or export it again as a standard MP4.
- **A batch stops with 429.** You probably hit the free plan's daily cap. Wait, add billing, or use contact sheets for big image batches.

More fixes are in the guide: https://olympusengine.io/care-package/video-review

## License

MIT. See `LICENSE`.
