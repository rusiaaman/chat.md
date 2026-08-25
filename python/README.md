# chatmd

Python engine and CLI for `.chat.md` files — the same format the
[chat.md VS Code extension](../README.md) drives, so one file can be handled by
either side interchangeably. Same block markers, same tool-call syntax, same
`cmdassets/` and `thinking_map.json`, same system prompt.

- **Library** — parse a `.chat.md` file into a message history, stream a
  completion from Anthropic or OpenAI, run the MCP tool calls it makes, and get
  the new history back. Or skip files entirely and hold the conversation in
  memory.
- **CLI** — a background listener that watches folders of `.chat.md` files and
  streams straight into them, plus token and cost statistics.

## Install

```sh
uv tool install --from . chatmd     # or: pip install -e .
chatmd setup
```

`chatmd setup` looks for chat.md settings already configured in VS Code, VS Code
Insiders, VSCodium, Cursor, Windsurf, Antigravity or Trae and offers to import
them. The setting names are identical, so importing is a straight copy — no
retyping API keys. Everything lands in `~/.config/chat.md/config.json`, written
`0600` because it holds those keys.

## Using it

```sh
chatmd send notes.chat.md "What does config.py do?"   # append a turn
chatmd run notes.chat.md                              # answer it here and now

chatmd watch ~/chats                                  # or let the listener do it
chatmd status                                         # what is it doing?
chatmd live                                           # ...refreshing in place
chatmd stats --since 7d --timeline day                # tokens, cost, timing
chatmd mcp status                                     # are the tool servers up?
chatmd stop
```

`chatmd run` drives one file in the foreground with no listener involved, which
is the easiest way to see what the engine is doing. `chatmd watch` registers a
folder with the single system-wide listener, starting it if it is not running.

`chatmd parse <file>` shows how a document parses, which is the first thing to
reach for when a chat is not behaving.

### Cost

`chatmd stats` reports cost only for models you have priced yourself, under
`pricing` in the config — dollars per million tokens:

```json
"pricing": {
  "claude-opus-5": {"input": 5.0, "output": 25.0, "cacheRead": 0.5}
}
```

There is no built-in price table on purpose. Prices change and vary by host, and
a wrong number presented as a cost is worse than no number, so an unpriced model
shows a blank rather than zero.

## As a library

Against a file:

```python
from chatmd import ChatDriver, McpPool, load_config

config = load_config()
pool = McpPool(config.mcp_servers)
await pool.start()

driver = ChatDriver(config, pool)
for result in await driver.run("notes.chat.md"):
    print(result.action, result.outcome or result.tool_name or "")
```

Or with no file at all:

```python
from chatmd import ChatSession, McpPool, MessageParam, TextContent, assistant_text, load_config

config = load_config()
pool = McpPool(config.mcp_servers)
await pool.start()

session = ChatSession(config, pool)
history = await session.run([MessageParam("user", [TextContent("List this folder")])])
print(assistant_text(history))
```

`complete_turn` and `run_tool_calls` are the two halves underneath `ChatSession`,
if you want to run the loop yourself.

## How it works

The document is the whole state machine. A trailing empty `# %% assistant` block
means "stream a turn"; a trailing empty `# %% tool_execute` block means "run the
next tool call"; anything else means there is nothing to do. Each action leaves
the document in one of those states, which is what makes the loop agentic without
any state living outside the file.

Writes are append-only and idempotent: before every write the streamer checks that
what it wrote is still exactly what sits at the start of the block, and stops for
good if it is not — so editing a chat while it streams ends the stream instead of
corrupting the file.

### Sharing a file with the editor

Both sides take a lock on a hidden sibling (`.notes.chat.md.lock`). The CLI also
takes a kernel lock the OS releases even on `SIGKILL`; the extension cannot, so
the shared advisory body carries a pid and a heartbeat and each side treats a
holder whose process is gone, or that has been quiet for three intervals, as dead.
Whoever holds it owns the document until it releases.

## Development

```sh
uv venv --python 3.12
uv pip install -e ".[dev]"
.venv/bin/pytest
.venv/bin/mypy
.venv/bin/ruff check src tests
```

The package supports Python 3.11 upwards, so syntax is checked against the oldest
supported version too — the development venv runs 3.12, which happily accepts
syntax 3.11 rejects:

```sh
uv python install 3.11
"$(uv python find 3.11)" -m compileall -q src/chatmd tests
```

See [PLAN.md](PLAN.md) for the design and [INTERFACES.md](INTERFACES.md) for the
module contracts.
