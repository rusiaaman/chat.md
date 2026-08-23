# chat.md Python engine — implementation plan

A Python library (`chatmd`) and CLI (`chatmd`) that speak the exact same `.chat.md`
format as the VS Code extension, so a single file can be driven by either side
interchangeably. Same block markers, same `## %%` sub-sections, same
`cmd:tool_call` format, same `cmdassets/` + `thinking_map.json` artifacts, same
system prompt, same agentic loop.

## Decisions

| Area | Decision |
| --- | --- |
| LLM clients | Official `anthropic` + `openai` SDKs (Responses API included) |
| Config | Own `~/.config/chat.md/config.json`, one-time copy from editor settings at setup |
| Daemon control plane | Filesystem only — no socket, no port |
| Dashboard | Terminal: live TUI (`chatmd live`) + summary tables (`chatmd stats`), `--json` everywhere |
| Tool safety | Full extension parity: every tool auto-executes, no cap, no allowlist |
| Library API | Async-first; pure file-free core + file-driven engine on top |
| MCP lifecycle | Lazy connect (list tools at startup, disconnect), then keep alive after first real call |
| MCP scope | One shared pool per daemon, across all chats. `chatmd mcp status` reports it |
| Location | `python/` subdir of this repo |

Python >= 3.11, `uv` for env/lock, `hatchling` build backend.

Runtime deps: `anthropic`, `openai`, `mcp`, `watchfiles`, `typer`, `rich`.
Dev: `pytest`, `pytest-asyncio`, `ruff`, `mypy`.

## Format contract being ported

Everything below is what the TS implementation does today; the Python port must
match it byte for byte.

### Blocks

- `^# %% (user|assistant|system|tool_execute|settings)\s*$`, case-insensitive.
- `system` blocks are concatenated raw (newline-joined, then trimmed) into the
  system prompt. An image reference inside a system block is a hard error.
- `tool_execute` blocks parse as **user** messages.
- `settings` blocks are parsed by the extension but never consumed — port the
  parse (so the block is tolerated) and likewise ignore it.
- A trailing **empty** `assistant` or `tool_execute` block is the action trigger
  and is excluded from parsed history.
- New markers are written through `block_marker_prefix(text_before)`: exactly one
  blank line above, nothing extra if one is already there.

### Preamble

`.env`-style `key=value` lines before the first marker. Allowed keys:
`selectedConfig`, `reasoningEffort`, `maxTokens`, `maxThinkingTokens`,
`openaiApi`. Forbidden: `type`, `apiKey`, `base_url`, `model_name`, `apiConfigs`
(raise `ForbiddenInlineConfigKey`). Any other non-blank, non-`#` line that is not
`key=value` raises `InvalidStartContent`. Unquoted values get `#` comments
stripped; surrounding quotes removed; `maxTokens`/`maxThinkingTokens` coerced to int.

### User content

Resolved in document order, interleaved with the surrounding text:

- `[#file](path)` or `[label](path.ext)` where the extension heuristic matches
  (`link text == "#file"` or path ends in `.xx`–`.xxxxx`).
- `[MCP Prompt: name](path)` — file content inlined raw, no wrapper.
- `Attached file at <path>` optionally followed by a fenced block, which is
  swallowed by the match.
- Images (`.png .jpg .jpeg .gif .webp`) become image content keeping the
  **original** (unresolved) path; text files become
  `Attached file: <path>\n```\n<content>\n``` `; missing files become
  `[File not found: <path>]`.
- `~` expansion, absolute and document-relative paths.

### Assistant content

- Sub-sections split on `^## %% (thinking|text)[ \t]*$`. No marker anywhere means
  the whole block is plain text; content before the first marker is text.
- In a thinking section, the last non-empty line matching `<model>::<hash8>` is a
  signature line, not thinking text. The hash resolves against
  `cmdassets/thinking_map.json` to a payload
  (`anthropic_signature` | `anthropic_redacted` | `openai_encrypted` |
  `reasoning_details` | `raw`). A missing entry degrades to display-only text.
- Hash = first 8 hex of sha256 over a stable-stringified entry excluding
  `createdAt`, including `model` and `kind` — must reproduce the TS
  `stableStringify` exactly (sorted keys, `null` for undefined).

### Tool calls

- Only `<cmd:tool_call> … \n</cmd:tool_call>` with the closing tag starting its
  own line (`TOOL_CALL_PATTERN = open + "[\s\S]*?\n\s*" + close`), no fences.
- `<cmd:tool_name>`, `<cmd:param name="x">value</cmd:param>`; CDATA-aware
  (balanced-tag check, placeholder substitution for structural matching, content
  extraction for values).
- `<cmd:wait-tool-result/>` is a control signal: stripped while streaming, never
  written to the document, but re-appended after the last tool call of any
  assistant block that is followed by a `tool_execute` block when replaying
  history to the API.
- Partial-marker hold-back: a trailing suffix of the stream that is a proper
  prefix of the marker is withheld and prepended to the next batch, so a marker
  split across two batches never lands in the file.

### Tool results

- Wrapped `<tool_result>\n…\n</tool_result>`.
- Rich MCP results are formatted to markdown; images/audio/blobs are written into
  the assets dir and referenced by relative markdown links.
- More than 30 lines → written to `cmdassets/tool-result-<ts>-<rand>.{txt,md}`
  and replaced in the document by `[Tool Result](rel/path)`.
- At parse time, a `<tool_result>` whose entire body is a single markdown link to
  an existing local file is re-inlined (or becomes image content); embedded
  `![alt](img)` links become image content blocks.

### The loop

1. File ends with empty `# %% assistant` → stream.
2. Streaming is append-only and idempotent: target the **first empty** assistant
   block on the first write, the **last** assistant block afterwards; assert
   `text[block_start:].startswith(tokens_so_far)`; a mismatch aborts the streamer
   permanently.
3. Tool-call detection scans only `[scan_offset, text_section_end)` so `<cmd:`
   inside thinking is never a call.
4. On a completed call: buffering mode — further complete calls are written but
   not executed; the turn ends on the wait marker, or on prose (a model that
   forgot the marker still gets its batch run), or on an invalid buffer.
5. One `# %% tool_execute` block is appended.
6. Trigger 2: file ends with empty `# %% tool_execute` → run tool number *N*,
   where *N* = count of `tool_execute` markers between the governing assistant
   block and this one. Insert the result, then append either another
   `# %% tool_execute` (calls still pending) or `# %% assistant` — which
   re-triggers step 1. This is the agentic loop, entirely file-state-driven.
7. Natural finish with no tool call → append `# %% user`.
8. Turn mentioned `<cmd:` but produced no valid call → append a correction user
   turn plus an empty assistant block (auto-retry). Same for a stray wait marker.
9. `max_tokens` → restart with the partial assistant text appended to context
   (10 retries). 5xx / 429 / ECONNRESET → exponential backoff, 5 retries.

### Request shaping

- System prompt = built-in persona + all `# %% system` blocks + generated tool
  prompt (`system.fetch_mcp_resource` first, then MCP tools grouped per server as
  `serverId.toolName` with JSON schemas, then advertised resources).
- `clean_messages_for_api`: at most one thinking block per assistant message,
  moved to the front; payloads dropped when the model or API family does not
  match; text-only thinking kept as raw where the API allows; emptied messages
  get a `[continuing]` text block; trailing whitespace stripped from the last
  assistant text block.
- Anthropic: adaptive thinking (`{type:"adaptive"}` + `output_config.effort`) for
  4.6+/5.x/fable, `display:"summarized"` for 4.7+, omit entirely for always-on
  models, `budget_tokens` for older ones with `max_tokens` raised above the
  budget, interleaved-thinking beta header for <= 4.5.
- OpenAI: Responses API when `openaiApi == "responses"`, or `auto` + gpt-/o-series
  model + an api.openai.com base URL; chat completions otherwise. Responses uses
  `store: false` and `include: ["reasoning.encrypted_content"]`.
- Precedence for `reasoningEffort` / `maxTokens` / `maxThinkingTokens` /
  `openaiApi`: file preamble > named api config > global.

## Package layout

```
python/
  pyproject.toml
  src/chatmd/
    types.py              MessageParam, Content, ThinkingPayload, ...
    parser/               blocks, document, preamble, user_content,
                          assistant_content, tool_result
    render.py             block_marker_prefix, render_stream_tokens, SectionState
    thinking_map.py       stable hash, read/put/get
    assets.py             assets dir, tool-result files, .gitignore upkeep
    tools/                call_parser, system_tools, executor, result_format
    providers/            base (StreamEvent), anthropic, openai_chat,
                          openai_responses, capabilities, cleanup, prompt
    mcp/                  manager (shared pool), transport
    engine/              streamer, driver, locks
    daemon/              supervisor, registry, watcher, events
    stats/               store (jsonl -> sqlite), views (rich), pricing
    config/              model, discovery, setup
    cli/                 typer app
  tests/
```

## Library API

Pure core, no I/O beyond reading referenced attachments:

```python
parse_document(text, base_dir=None) -> ParsedDocument
    .messages, .system_prompt, .file_config, .has_image_in_system_block
has_empty_assistant_block(text) -> bool
has_empty_tool_execute_block(text) -> bool
```

Completions — config-driven, same structure as the VS Code settings:

```python
cfg = load_config()                       # ~/.config/chat.md/config.json
resolved = cfg.resolve(config_name=None, overrides=parsed.file_config)

client = ChatClient(resolved)
async for ev in client.stream(messages, system_prompt):   # TextDelta | ThinkingDelta
                                                          # | ThinkingPayload | Usage
    ...
turn = await client.complete(messages, system_prompt)
turn.text, turn.thinking, turn.tool_calls, turn.usage
```

Tools — one shared pool, initialized from the same `mcpServers` shape:

```python
pool = McpPool(cfg.mcp_servers)
await pool.start()                      # lazy: list tools, disconnect
new_messages = await run_tool_calls(turn, pool)   # -> list[MessageParam]
pool.status()                           # per-server state for `chatmd mcp status`
```

File engine — the same decide/act step the daemon uses:

```python
engine = FileEngine(cfg, pool)
await engine.step(path)   # one action: stream | execute tool | idle
await engine.run(path)    # loop until idle
```

Programmatic users can drive an in-memory message list and never touch a file;
the CLI is just one consumer of the same pieces.

## Config

`~/.config/chat.md/config.json` (honours `XDG_CONFIG_HOME`), keys named exactly
as the `chatmd.*` settings so import is a straight copy:

```json
{
  "version": 1,
  "apiConfigs": { "sonnet": { "type": "anthropic", "apiKey": "…",
    "model_name": "claude-sonnet-5", "base_url": "", "reasoningEffort": "high",
    "maxTokens": 8000, "maxThinkingTokens": 16000, "openaiApi": "auto" } },
  "selectedConfig": "sonnet",
  "mcpServers": { "wcgw": { "command": "uvx", "args": ["…"], "env": {} } },
  "maxTokens": 8000, "maxThinkingTokens": 16000, "reasoningEffort": null,
  "assetsPath": "cmdassets", "openaiApi": "auto",
  "daemon": { "debounceMs": 300 },
  "pricing": {}
}
```

`chatmd setup` (also run automatically on first use of any command when no config
exists):

1. Probe for editor settings on this platform — VS Code, VS Code Insiders,
   VSCodium, Cursor, Windsurf, Antigravity, Trae:
   - macOS `~/Library/Application Support/<App>/User/settings.json`
   - Linux `~/.config/<App>/User/settings.json`
   - Windows `%APPDATA%\<App>\User\settings.json`
   Only user-level settings; project-level `.vscode/settings.json` is
   deliberately ignored, since the listener is not project-scoped.
2. Show each candidate with what it contains (n api configs, n MCP servers) and
   let the user pick one, several (merged in pick order), or none.
3. Copy the `chatmd.*` keys in, write the config, then verify: list the resolved
   providers, and dry-connect each MCP server reporting ok/failed.

Reads must tolerate JSONC — comments and trailing commas — via a small
hand-rolled stripper rather than another dependency.

## Locking

Per chat file: hidden sibling `.<name>.chat.md.lock`.

Acquire: `os.open(O_CREAT|O_EXCL|O_RDWR)`; if it already exists, read the JSON
body and steal it when the recorded pid is dead (`os.kill(pid, 0)`) or the
heartbeat is older than 3× the interval. Then `fcntl.flock(LOCK_EX|LOCK_NB)`
(`msvcrt.locking` on Windows) on the fd, which gives kernel-enforced exclusion
between CLI processes and is released automatically if the process is killed —
so no deadlock on death, which was the open question. Body:
`{"owner": "chatmd-cli", "pid": …, "host": …, "started_at": …, "heartbeat": …}`,
heartbeat refreshed every 5 s while held. Release unlinks and closes.

The VS Code extension cannot `flock` without a native module, so the lock is
advisory-but-robust for it: same path, same body (`"owner": "vscode"`), `O_EXCL`
create plus pid-liveness and heartbeat staleness. Python additionally flocks the
same file. Both sides therefore refuse to drive a file the other is driving.

Daemon singleton uses the same scheme on `~/.local/state/chat.md/daemon.lock`.

## Daemon — filesystem control plane

State dir `~/.local/state/chat.md/` (honours `XDG_STATE_HOME`):

| Path | Written by | Purpose |
| --- | --- | --- |
| `daemon.lock` | daemon | singleton, flock + pid/heartbeat |
| `daemon.json` | daemon | pid, version, started_at, watch roots |
| `paths.json` | CLI | registered folders / globs — watched, so registration is instant |
| `commands/<ulid>.json` | CLI | `reload-config`, `add-path`, `remove-path`, `stop-file`, `mcp-refresh`, `shutdown`; daemon replies `<ulid>.done.json` |
| `status.json` | daemon | ~1 Hz snapshot: per-file state, active streams, MCP server states, counters |
| `events.jsonl` | daemon | append-only: `turn_start`, `turn_end` (+usage), `tool_call`, `error` |
| `stats.db` | CLI/daemon | sqlite rollups, built from `events.jsonl` by byte offset |
| `daemon.log` | daemon | rotating log |

Watch loop: `watchfiles.awatch` over the registered roots, filtered to
`*.chat.md`, ignoring `cmdassets/` and `*.lock`, debounced ~300 ms per path. Each
changed file gets a serialized per-path task: read text → decide (empty assistant
→ stream, empty tool_execute → execute, else idle) → acquire the file lock →
act → release. The config file, `paths.json` and `commands/` are watched too, so
config edits reload live (MCP servers re-diffed like `checkConfigChanges`) with
no restart.

Writes into the chat file are read-modify-write in place while holding the lock
(no atomic rename — that would swap the inode out from under an editor watching
the file).

## CLI

```
chatmd setup                       first-run wizard / re-import
chatmd serve [--foreground]        start the singleton daemon (idempotent)
chatmd stop                        graceful shutdown
chatmd watch <path>…               register a folder or glob (starts daemon if needed)
chatmd unwatch <path>…
chatmd status [--json]             snapshot: daemon, paths, per-file state
chatmd live                        rich Live TUI: active streams, tokens/s, current tool
chatmd stats [--since] [--by model|day|file] [--json]
chatmd mcp status [--json]         per server: state, tool count, uptime, last error
chatmd mcp refresh
chatmd run <file.chat.md>          drive one file to completion in the foreground, no daemon
chatmd send <file.chat.md> "msg"   append a user block + empty assistant block
chatmd config show | set | import
chatmd parse <file> [--json]       debug dump of parsed messages + system prompt
```

`chatmd run` matters for development: it exercises the whole engine without the
daemon in the way.

## Extension changes

- New `src/utils/fileLock.ts`: `acquireChatFileLock(fsPath)` / `releaseChatFileLock`,
  `O_EXCL` + pid liveness + heartbeat, writing the body format above.
- `DocumentListener.startStreaming` and `executeToolFromPreviousBlock` acquire it
  before acting and skip (with a log line and a status-bar hint) when it is held
  by another owner; release on completion, cancel, and dispose.
- Heartbeat on a `setInterval` while held.

Contained change; no behaviour difference when the CLI is not running.

## Build order

1. Pure core: types, parser, render, tool-call parser, thinking map, cleanup,
   model capabilities. Golden tests against `samples/*.chat.md`.
2. Providers + prompt assembly + `ChatClient`.
3. MCP pool + tool executor + result formatter + assets.
4. File engine (streamer + driver) + locks → `chatmd run` works end to end.
5. Daemon: supervisor, registry, watcher, events.
6. Stats store + TUI + `mcp status`.
7. Config discovery + setup wizard.
8. Extension lock support.

## Tests

`pytest` + `pytest-asyncio`. Unit coverage on every pure module, with particular
attention to the parts most likely to drift from the TS behaviour: wait-marker
hold-back across batch boundaries, CDATA balance checks, the thinking/text
section state machine, the idempotent append check, and positional matching of
tool calls to `tool_execute` blocks. A fake provider replaying canned SSE drives
the streamer and the full agentic loop against a temp directory, so the loop is
tested without network access.
