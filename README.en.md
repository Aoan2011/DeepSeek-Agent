# DeepSeek Agent

English | [简体中文](README.md)

An agentic fork of [deepseek-ai/chat-demo](https://github.com/deepseek-ai/chat-demo): tool calling, in-browser tools, MCP servers, a Python desktop bridge, a Chrome extension, and a workspace with branch-aware Monaco diffs — on top of the original interface and design system.

> The Chinese [README.md](README.md) is the primary document and includes setup, deployment, security notes and screenshots. This file only keeps the upstream description of the base app.

A static chat demo powered by the DeepSeek API. No application backend is required: the browser connects directly to the configured API service.

Enter your API key in Settings before your first chat.

## Getting started

Install Node.js 22.12+ and pnpm, then run:

```sh
git clone https://github.com/aoan2011/DeepSeek-Agent.git
cd DeepSeek-Agent
pnpm install
pnpm dev
```

Open http://localhost:8090.

To build the static site:

```sh
pnpm build
```

The output is written to `dist/`. It is deployed to https://aoan2011.github.io/DeepSeek-Agent/ by the bundled Pages workflow; relative asset paths mean it also works from a root domain or `file://`. Opening the file directly requires browser support for storage on `file://` pages and an API service that permits their cross-origin requests.

## Features

- Multiple conversations with automatic titles, renaming, and deletion; edit prompts, regenerate replies, and switch between message branches.
- Streaming replies, deep thinking, smart search, link reading, and source citations; stop generation or continue eligible replies.
- Upload, paste, or drag and drop attachments; use voice input and read replies aloud. A live audio spectrum appears in the first row of the input area while recording on mobile.
- Markdown, syntax highlighting, KaTeX math, and Mermaid diagrams.
- Markdown extensions: `==text==` / `==red:text==` color highlights, `~wavy~` underlines, and GitHub-style `> [!IMPORTANT]` alerts.
- Workspace panel (`Ctrl/Cmd + Shift + E`): file tree of changes, branch switcher backed by `.git`, and a lazily loaded Monaco diff editor with red deletions and green additions.
- Workspace tools for the agent: list, read, write (approval required) and diff files; changes show up in the panel immediately.
- Live stats bar under the composer: input/output tokens, first-token latency, cache hit rate, throughput and elapsed time, refreshed every second with a blur-and-bounce number transition.
- Streaming characters rise from slightly below with a heavy blur and settle with a small bounce; CJK animates per character, Latin per word.
- Model picker with remote `/models` discovery (cached for an hour) and a built-in fallback when the API is unreachable.
- Thinking intensity slider with five levels that sends real `reasoning_effort` and `thinking.budget_tokens`, plus a quota warning at the maximum level.
- Agent tools: in-browser tools, remote MCP servers, a Python desktop bridge with sandboxed file/shell/python plus screen, mouse and keyboard control, and a Chrome extension.
- Subagents via `spawn_subagent`: independent context, read-only tools by default, only the conclusion comes back.
- Questions via `ask_user`: the model pauses and asks above the composer with options or free text; the answer returns as a `tool_result` and the same turn continues.
- Widgets via `show_widget`: the model can render an interactive HTML card inline, sandboxed in an iframe.
- Simplified Chinese and English, light and dark themes, mobile layouts, location settings, and chat history import and export.

## Data and storage

Your API key and settings are stored in the browser's localStorage. Conversations and original attachments are stored in IndexedDB. Local data is isolated by browser profile and site origin. Sending messages, uploading attachments, and using speech features sends the relevant content to the configured API service.

History import and export in Settings use ZIP archives. After confirmation and successful validation, importing replaces all local conversations and attachments. Exports include conversations and locally available original images, but exclude API keys, settings, and original non-image attachments. See the [history import/export documentation (Chinese)](src/services/chat/history/README.md) for the archive format and preservation details.

Settings → Data → Delete all chats clears all local conversations, original attachments, and unsent drafts after confirmation. It stops ongoing replies and returns to a new chat. Your API key and settings are preserved; files already uploaded to the API service are not deleted.

## Development

| Command       | Description                  |
| ------------- | ---------------------------- |
| `pnpm dev`    | Start the development server |
| `pnpm build`  | Build into `dist/`           |
| `pnpm type`   | Run TypeScript type checks   |
| `pnpm lint`   | Lint with oxlint             |
| `pnpm format` | Format with oxfmt            |

[rspack.config.ts](rspack.config.ts) uses `https://api.deepseek.com` by default. Use `createConfig({ apiOrigin, devServer })` to customize the API origin and development server proxy.

Chat uses `deepseek-flash` by default through Anthropic-compatible Messages / Files APIs. Speech features use ASR / TTS endpoints. Requests include extensions for search, link reading, titles, and `latest_reminder`, so the configured service must support the corresponding capabilities. Supported attachment formats are determined by server-side validation.

```text
src/
  app/                 Application layout, themes, and global styles
  components/          Chat, settings, Markdown, and other UI components
  i18n/                English and Chinese translations
  services/
    api/               API requests, SSE, and protocol types
    chat/              Conversations, message branches, storage, and history import/export
    markdown/          Markdown parsing, syntax highlighting, and diagrams
    speech/            Audio recording and read-aloud playback
  utils/               Shared utilities
```

## License

[MIT](LICENSE). The build copies the license to `dist/LICENSE`; include it when distributing the app. Third-party dependencies are subject to their own licenses.
