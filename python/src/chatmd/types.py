"""Core data types for chat.md.

A port of ``src/types.ts`` from the VS Code extension. Attribute names are
snake_case, but every value that is persisted to disk or sent to a provider keeps
the exact key the TypeScript implementation uses, so the artifacts the two write
(``cmdassets/thinking_map.json`` above all) stay byte-compatible.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any, Literal

Role = Literal["user", "assistant"]
BlockType = Literal["user", "assistant", "system", "tool_execute", "settings"]
ReasoningEffort = Literal["none", "minimal", "low", "medium", "high", "max"]
OpenaiApiStyle = Literal["auto", "chat", "responses"]
ProviderType = Literal["anthropic", "openai"]
ApiStyle = Literal["anthropic", "openai_chat", "openai_responses"]

ThinkingPayloadKind = Literal[
    "anthropic_signature",
    "anthropic_redacted",
    "openai_encrypted",
    "reasoning_details",
    "raw",
]

ReasoningFieldName = Literal["reasoning", "reasoning_content", "reasoning_summary"]


# --------------------------------------------------------------------------- #
# Message content
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class TextContent:
    value: str
    type: Literal["text"] = "text"


@dataclass(frozen=True)
class ImageContent:
    """An image attachment, holding the path exactly as it was written."""

    path: str
    type: Literal["image"] = "image"


#: snake_case attribute -> key used in thinking_map.json and by the TS port.
#: Order matters only for readability; hashing sorts keys.
_PAYLOAD_KEY_MAP: tuple[tuple[str, str], ...] = (
    ("kind", "kind"),
    ("signature", "signature"),
    ("data", "data"),
    ("item_id", "itemId"),
    ("encrypted_content", "encryptedContent"),
    ("reasoning_details", "reasoningDetails"),
    ("reasoning_field", "field"),
)


@dataclass(frozen=True)
class ThinkingPayload:
    """Provider-specific reasoning payload referenced by an 8-char hash.

    ``kind == "raw"`` means there is no opaque payload, only readable text.
    """

    kind: ThinkingPayloadKind
    #: Anthropic: opaque signature closing a thinking block.
    signature: str | None = None
    #: Anthropic: opaque data of a redacted_thinking block.
    data: str | None = None
    #: OpenAI Responses: reasoning item id (``rs_...``).
    item_id: str | None = None
    #: OpenAI Responses: encrypted reasoning content.
    encrypted_content: str | None = None
    #: OpenAI chat completions (OpenRouter et al): the reasoning_details array.
    reasoning_details: list[Any] | None = None
    #: OpenAI chat completions: which field carried the reasoning text.
    reasoning_field: ReasoningFieldName | None = None

    def to_map_dict(self) -> dict[str, Any]:
        """camelCase dict for thinking_map.json, omitting unset fields."""
        out: dict[str, Any] = {}
        for attr, key in _PAYLOAD_KEY_MAP:
            value = getattr(self, attr)
            if value is not None:
                out[key] = value
        return out

    @classmethod
    def from_map_dict(cls, data: dict[str, Any]) -> ThinkingPayload:
        kwargs: dict[str, Any] = {}
        for attr, key in _PAYLOAD_KEY_MAP:
            if data.get(key) is not None:
                kwargs[attr] = data[key]
        kwargs.setdefault("kind", "raw")
        return cls(**kwargs)


@dataclass(frozen=True)
class ThinkingContent:
    """Reasoning content of an assistant message."""

    #: Readable thinking text (summary or raw), without the signature line.
    value: str
    #: Qualified model name from the signature line, if present.
    model: str | None = None
    #: 8-char hash referencing an entry in thinking_map.json.
    hash: str | None = None
    #: Payload resolved from thinking_map.json, when the entry could be read.
    payload: ThinkingPayload | None = None
    type: Literal["thinking"] = "thinking"


Content = TextContent | ImageContent | ThinkingContent


@dataclass
class MessageParam:
    """One turn of the conversation."""

    role: Role
    content: list[Content] = field(default_factory=list)


# --------------------------------------------------------------------------- #
# Parsing results
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class ParsedDocument:
    messages: list[MessageParam]
    system_prompt: str
    has_image_in_system_block: bool = False
    #: Parsed ``key=value`` preamble before the first block marker.
    file_config: dict[str, Any] = field(default_factory=dict)
    #: Parsed ``# %% settings`` block. Accepted for tolerance, never consumed.
    settings: dict[str, Any] | None = None
    has_configuration_block: bool = False


@dataclass(frozen=True)
class ToolCall:
    name: str
    params: dict[str, str] = field(default_factory=dict)
    #: The raw ``<cmd:tool_call>`` text this was parsed from.
    raw_xml: str = ""


# --------------------------------------------------------------------------- #
# Streaming
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class Usage:
    input_tokens: int | None = None
    output_tokens: int | None = None
    cache_read_tokens: int | None = None
    cache_write_tokens: int | None = None

    def to_dict(self) -> dict[str, Any]:
        """camelCase dict matching the TS chat-history usage shape."""
        out: dict[str, Any] = {}
        for attr, key in (
            ("input_tokens", "inputTokens"),
            ("output_tokens", "outputTokens"),
            ("cache_read_tokens", "cacheReadTokens"),
            ("cache_write_tokens", "cacheWriteTokens"),
        ):
            value = getattr(self, attr)
            if value is not None:
                out[key] = value
        return out

    def merge(self, other: Usage) -> Usage:
        """Later non-None values win, which is how the SSE deltas arrive."""
        return Usage(
            input_tokens=(
                other.input_tokens if other.input_tokens is not None else self.input_tokens
            ),
            output_tokens=(
                other.output_tokens if other.output_tokens is not None else self.output_tokens
            ),
            cache_read_tokens=(
                other.cache_read_tokens
                if other.cache_read_tokens is not None
                else self.cache_read_tokens
            ),
            cache_write_tokens=(
                other.cache_write_tokens
                if other.cache_write_tokens is not None
                else self.cache_write_tokens
            ),
        )


@dataclass(frozen=True)
class TextDelta:
    """A chunk of ordinary assistant text."""

    text: str


@dataclass(frozen=True)
class ThinkingDelta:
    """A chunk of readable reasoning text."""

    text: str


@dataclass(frozen=True)
class ThinkingPayloadDelta:
    """Closes a reasoning run: the opaque payload plus the model that made it."""

    model: str
    payload: ThinkingPayload


@dataclass(frozen=True)
class UsageDelta:
    usage: Usage


StreamEvent = TextDelta | ThinkingDelta | ThinkingPayloadDelta | UsageDelta


@dataclass
class TurnResult:
    """A completed (non-streaming) assistant turn."""

    #: Assistant text with the end-of-batch marker already stripped.
    text: str = ""
    thinking: list[ThinkingContent] = field(default_factory=list)
    tool_calls: list[ToolCall] = field(default_factory=list)
    #: Assembled assistant content blocks, ready to append to history.
    content: list[Content] = field(default_factory=list)
    usage: Usage | None = None
    #: True when the turn ended on ``<cmd:wait-tool-result/>``.
    ended_on_wait_marker: bool = False


# --------------------------------------------------------------------------- #
# MCP
# --------------------------------------------------------------------------- #


@dataclass(frozen=True)
class McpTextContent:
    text: str
    annotations: Any | None = None
    type: Literal["text"] = "text"


@dataclass(frozen=True)
class McpImageContent:
    data: str
    mime_type: str
    annotations: Any | None = None
    type: Literal["image"] = "image"


@dataclass(frozen=True)
class McpAudioContent:
    data: str
    mime_type: str
    annotations: Any | None = None
    type: Literal["audio"] = "audio"


@dataclass(frozen=True)
class McpResourceLink:
    uri: str
    name: str
    title: str | None = None
    description: str | None = None
    mime_type: str | None = None
    annotations: Any | None = None
    type: Literal["resource_link"] = "resource_link"


@dataclass(frozen=True)
class McpResourceContents:
    uri: str
    mime_type: str | None = None
    text: str | None = None
    blob: str | None = None
    annotations: Any | None = None


@dataclass(frozen=True)
class McpEmbeddedResource:
    resource: McpResourceContents
    type: Literal["resource"] = "resource"


McpRenderableContent = (
    McpTextContent | McpImageContent | McpAudioContent | McpResourceLink | McpEmbeddedResource
)


@dataclass(frozen=True)
class McpToolExecutionResult:
    server_id: str
    tool_name: str
    is_error: bool = False
    content: list[McpRenderableContent] = field(default_factory=list)
    structured_content: Any | None = None


@dataclass(frozen=True)
class McpResource:
    uri: str
    name: str
    title: str | None = None
    description: str | None = None
    mime_type: str | None = None
    size: int | None = None
    annotations: Any | None = None


@dataclass(frozen=True)
class McpResourceTemplate:
    uri_template: str
    name: str
    title: str | None = None
    description: str | None = None
    mime_type: str | None = None
    annotations: Any | None = None


@dataclass(frozen=True)
class McpReadResourceResult:
    contents: list[McpResourceContents] = field(default_factory=list)


@dataclass(frozen=True)
class McpPromptMessage:
    role: Role
    content: list[McpRenderableContent] = field(default_factory=list)


@dataclass(frozen=True)
class McpPromptResult:
    messages: list[McpPromptMessage] = field(default_factory=list)
    description: str | None = None


@dataclass(frozen=True)
class McpToolDefinition:
    """A tool as advertised by a server, keyed by its bare name."""

    name: str
    description: str | None = None
    input_schema: dict[str, Any] = field(default_factory=dict)


McpServerState = Literal["not-started", "connecting", "connected", "errored"]


@dataclass(frozen=True)
class McpServerStatus:
    server_id: str
    state: McpServerState
    tool_count: int = 0
    prompt_count: int = 0
    resource_count: int = 0
    last_error: str | None = None
    connected_since: float | None = None
