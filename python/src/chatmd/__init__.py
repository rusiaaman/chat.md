"""chat.md — a plain-text chat interface to any LLM.

A ``.chat.md`` file *is* the conversation: block markers separate the turns, and
the engine reads the file to decide what to do next. That makes the whole thing
inspectable, editable and diffable, and it is why the agentic loop needs no state
beyond the document.

Two ways in:

* :func:`chatmd.parse_document` plus :class:`chatmd.ChatDriver` to work on files.
* :class:`chatmd.ChatSession` to hold a conversation in memory with no file at all.

```python
from chatmd import ChatSession, McpPool, MessageParam, TextContent, load_config

config = load_config()
pool = McpPool(config.mcp_servers)
await pool.start()

session = ChatSession(config, pool)
history = await session.run([MessageParam("user", [TextContent("List this folder")])])
print(assistant_text(history))
```
"""

from .api import (
    ChatSession,
    assistant_text,
    complete_turn,
    run_tool_calls,
    stream_turn,
)
from .config.loader import config_exists, load_config, save_config
from .config.model import ApiConfig, ChatmdConfig, McpServerConfig, ResolvedConfig
from .engine.driver import ChatDriver, StepAction, StepResult
from .engine.locks import chat_file_lock, lock_holder
from .engine.streamer import FileStreamer, StreamOutcome, StreamResult
from .errors import (
    ChatmdError,
    ConfigError,
    ForbiddenInlineConfigKey,
    InvalidStartContent,
    LockHeld,
)
from .mcp.manager import McpPool
from .parser import (
    has_empty_assistant_block,
    has_empty_tool_execute_block,
    parse_assistant_content,
    parse_document,
    parse_user_content,
)
from .providers.prompt import build_system_prompt, generate_tool_calling_system_prompt
from .types import (
    Content,
    ImageContent,
    MessageParam,
    ParsedDocument,
    StreamEvent,
    TextContent,
    TextDelta,
    ThinkingContent,
    ThinkingDelta,
    ThinkingPayload,
    ThinkingPayloadDelta,
    ToolCall,
    TurnResult,
    Usage,
    UsageDelta,
)

__version__ = "0.1.0"

__all__ = [
    "ApiConfig",
    "ChatDriver",
    "ChatSession",
    "ChatmdConfig",
    "ChatmdError",
    "ConfigError",
    "Content",
    "FileStreamer",
    "ForbiddenInlineConfigKey",
    "ImageContent",
    "InvalidStartContent",
    "LockHeld",
    "McpPool",
    "McpServerConfig",
    "MessageParam",
    "ParsedDocument",
    "ResolvedConfig",
    "StepAction",
    "StepResult",
    "StreamEvent",
    "StreamOutcome",
    "StreamResult",
    "TextContent",
    "TextDelta",
    "ThinkingContent",
    "ThinkingDelta",
    "ThinkingPayload",
    "ThinkingPayloadDelta",
    "ToolCall",
    "TurnResult",
    "Usage",
    "UsageDelta",
    "__version__",
    "assistant_text",
    "build_system_prompt",
    "chat_file_lock",
    "complete_turn",
    "config_exists",
    "generate_tool_calling_system_prompt",
    "has_empty_assistant_block",
    "has_empty_tool_execute_block",
    "load_config",
    "lock_holder",
    "parse_assistant_content",
    "parse_document",
    "parse_user_content",
    "run_tool_calls",
    "save_config",
    "stream_turn",
]
