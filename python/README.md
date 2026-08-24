# chatmd

Python engine and CLI for `.chat.md` files — the same format the
[chat.md VS Code extension](../README.md) drives, so a single file can be handled
by either side interchangeably.

- **Library**: parse a `.chat.md` file into a message history, stream a completion
  from Anthropic or OpenAI, run the resulting MCP tool calls, and get the new
  history back.
- **CLI**: a background listener that watches folders of `.chat.md` files and
  streams straight into them, plus token/model statistics.

See [PLAN.md](PLAN.md) for the design.

## Development

```sh
uv venv --python 3.12
uv pip install -e ".[dev]"
.venv/bin/pytest
.venv/bin/mypy
.venv/bin/ruff check src tests
```

The package supports Python 3.11 upwards, so syntax is checked against the
oldest supported version too — the development venv runs 3.12, which happily
accepts syntax 3.11 rejects:

```sh
uv python install 3.11
"$(uv python find 3.11)" -m compileall -q src/chatmd tests
```
