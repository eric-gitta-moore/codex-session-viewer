# Codex Session Viewer

[中文说明](./README.zh-CN.md)

Codex Session Viewer is a local web app for replaying Codex session logs as a chat-style timeline.
Instead of browsing raw JSONL files directly, you upload a single session file and inspect the conversation, tool calls, and system events in a UI that feels closer to a real chat product.

## What It Does

- Upload a single Codex session `.jsonl` file from your machine
- Replay the session as a message stream instead of a raw event table
- Show user messages, assistant replies, and compact tool cards in chronological order
- Hide noisy debug frames by default, with an option to reveal them
- Load large files in the browser without freezing the UI
- Expand any event on demand to inspect full content and raw JSON

## Current Product Shape

This project is intentionally local-first and file-based:

- It does **not** scan your `~/.codex/sessions` directory
- It processes **only the file you explicitly choose**
- It runs as a Vue + Vite app in the browser
- It keeps heavy parsing work off the main thread

## Large File Strategy

The viewer is designed to handle larger session files, including multi-megabyte JSONL logs.

Key implementation choices:

- **Streaming parse in a Web Worker**
  The app reads the uploaded file with `File.stream()` and parses JSONL incrementally in a worker.

- **Lightweight event index on the main thread**
  The main UI receives compact event objects instead of full raw records.

- **Virtualized chat list**
  The message stream uses `@tanstack/vue-virtual`, so only the visible rows are rendered.

- **Lazy event detail loading**
  Full event body and raw JSON are loaded only when the user expands a specific item.

These choices help reduce UI jank, memory duplication, and DOM pressure for large files.

## Main Features

### Chat-style replay

The session is rendered as a conversational flow:

- user messages as chat bubbles
- assistant replies as chat bubbles
- tools and debug events as compact expandable rows

### Compact tool cards

Tool-related events are intentionally minimized by default:

- one-line summary when collapsed
- full payload only when expanded

### Progressive parsing feedback

While a large file is being processed, the UI shows:

- parse progress
- parsed line count
- extracted record count

### Search and filtering

The viewer supports:

- keyword search across visible message summaries
- toggling debug/system events on and off

## Tech Stack

- Vue 3
- TypeScript
- Vite
- Web Workers
- `@tanstack/vue-virtual`

## Project Structure

```text
src/
  App.vue                          Main screen and upload flow
  components/
    ChatMessageRow.vue             Single rendered chat/tool row
    ChatStream.vue                 Virtualized message stream
    FileDropzone.vue               File selection UI
  types/
    session.ts                     Shared data types
  utils/
    sessionParser.ts               Main-thread worker bridge
  workers/
    sessionParser.worker.ts        Streaming JSONL parser
```

## Getting Started

### Install dependencies

```bash
npm install
```

### Start development server

```bash
npm run dev
```

### Build for production

```bash
npm run build
```

### Preview production build

```bash
npm run preview
```

## Supported Input

Expected input is a Codex session JSONL file, for example:

```text
~/.codex/sessions/2026/03/30/rollout-2026-03-30T15-20-01-....jsonl
```

Each line should be a valid JSON object.

## Notes

- This project currently focuses on **single-file inspection**
- Search is optimized for the lightweight in-memory index, not full-text raw payload search
- Raw event details are loaded lazily from worker-held data

## Roadmap Ideas

- move search fully into the worker
- add cancel parsing for very large files
- cache parsed indexes with IndexedDB
- support session comparison across multiple uploaded files
