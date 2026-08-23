# Pinned module interfaces

Phase-1 modules are written in parallel, so every cross-module boundary is fixed
here. Implement these names with these signatures exactly; if a signature looks
wrong, implement it anyway and say so in your report rather than diverging.

Foundation already in place (do not modify): `chatmd.types`, `chatmd.errors`,
`chatmd.fileio`, `chatmd.paths`, `chatmd.config.model`, `chatmd.providers.base`.

## `chatmd.render` — port of `src/utils/thinkingBlocks.ts`

```python
THINKING_SECTION_MARKER = "## %% thinking"
TEXT_SECTION_MARKER = "## %% text"

@dataclass(frozen=True)
class AssistantSection:
    type: Literal["thinking", "text"]
    content: str

@dataclass(frozen=True)
class ParsedThinkingSection:
    text: str
    model: str | None = None
    hash: str | None = None

@dataclass
class SectionState:
    thinking_open: bool = False
    text_open: bool = False
    saw_thinking: bool = False
    scan_offset: int = 0
    text_section_end: int | None = None

def has_assistant_sections(text: str) -> bool
def split_assistant_sections(text: str) -> list[AssistantSection]
def parse_thinking_section(content: str) -> ParsedThinkingSection
def format_signature_line(model: str, hash_: str) -> str
def strip_thinking_sections(text: str) -> str
def block_marker_prefix(text_before: str) -> str
def render_stream_events(
    events: Sequence[StreamEvent],
    already_written: str,
    state: SectionState,
    record_payload: Callable[[str, ThinkingPayload], str | None],
) -> str
```

`record_payload(model, payload)` stores the payload and returns its
`"model::hash8"` line, or `None` when it could not be stored.

## `chatmd.tools.call_parser` — port of `src/tools/toolCallParser.ts`

```python
CMD_TOOL_CALL_OPEN_TAG = "<cmd:tool_call>"
CMD_TOOL_CALL_CLOSE_TAG = "</cmd:tool_call>"
CMD_WAIT_TOOL_RESULT_TAG = "<cmd:wait-tool-result/>"
TOOL_CALL_PATTERN: str    # regex source, closing tag must start its own line

@dataclass(frozen=True)
class CompletedToolCall:
    end_index: int
    tool_name: str

def find_wait_marker(text: str) -> int
def wait_marker_prefix_length(text: str) -> int
def append_wait_marker_after_last_tool_call(text: str) -> str
def parse_tool_call(tool_call_xml: str) -> ToolCall | None
def find_all_tool_calls(text: str) -> list[str]
def check_for_completed_tool_call(text: str) -> CompletedToolCall | None
def are_cdata_tags_balanced(text: str) -> bool
def are_params_complete(text: str) -> bool
def extract_cdata_content(text: str) -> str
```

## `chatmd.thinking_map` — port of `src/utils/thinkingMap.ts`

Takes the **assets directory** rather than the document directory, since the
assets path is configurable.

```python
MAP_FILE_NAME = "thinking_map.json"

def stable_stringify(value: Any) -> str
def compute_thinking_hash(entry: dict[str, Any]) -> str      # sha256 hex[:8]
def thinking_map_path(assets_dir: Path) -> Path
def read_thinking_map(assets_dir: Path) -> dict[str, dict[str, Any]]
def put_thinking_entry(assets_dir: Path, model: str, payload: ThinkingPayload) -> str
def get_thinking_entry(assets_dir: Path, hash_: str) -> tuple[str, ThinkingPayload] | None
```

## `chatmd.assets` — port of the asset half of `fileUtils.ts` + `mcpResultFormatter.ts` helpers

```python
TOOL_RESULT_LINE_THRESHOLD = 30

def assets_dir(doc_dir: Path, assets_path: str = "cmdassets") -> Path
def assets_relative_path(doc_dir: Path, file_name: str, assets_path: str = "cmdassets") -> str
def timestamp_string() -> str
def asset_file_name(label: str, extension: str) -> str
def extension_for_mime_type(mime_type: str, default: str) -> str
def write_tool_result_file(doc_dir: Path, content: str, *, extension: str = ".txt",
                           assets_path: str = "cmdassets") -> str      # -> relative path
def write_binary_asset(doc_dir: Path, data: bytes, mime_type: str, label: str,
                       assets_path: str = "cmdassets") -> str          # -> relative path
def ensure_chat_md_gitignore(start_dir: Path) -> None
```

## `chatmd.providers.capabilities` — port of `src/utils/modelCapabilities.ts` (+ two helpers from `config.ts`)

```python
def is_adaptive_thinking_model(model: str) -> bool
def omits_thinking_by_default(model: str) -> bool
def requires_always_on_thinking(model: str) -> bool
def needs_interleaved_thinking_beta(model: str) -> bool
def to_adaptive_effort(effort: ReasoningEffort) -> Literal["low", "medium", "high"]
def is_responses_api_model(model: str) -> bool
def is_openai_base_url(base_url: str | None) -> bool
def calculate_thinking_tokens_from_effort(max_tokens: int, effort: ReasoningEffort) -> int
def resolve_openai_api_style(model_name: str | None, base_url: str | None,
                             openai_api: OpenaiApiStyle) -> Literal["chat", "responses"]
```

## `chatmd.providers.cleanup` — port of `src/utils/messageCleanup.ts`

```python
CONTINUING_PLACEHOLDER = "[continuing]"

def payload_usable_for_api(block: ThinkingContent, api_style: ApiStyle) -> bool
def thinking_matches_model(block: ThinkingContent, model_name: str) -> bool
def clean_messages_for_api(messages: Sequence[MessageParam], *, model_name: str,
                           thinking_enabled: bool, api_style: ApiStyle) -> list[MessageParam]
```

## `chatmd.parser` — port of `src/parser.ts`

```python
# chatmd.parser.blocks
BLOCK_MARKER_RE: re.Pattern            # ^# %% (user|assistant|system|tool_execute|settings)\s*$ , MULTILINE|IGNORECASE

@dataclass(frozen=True)
class Block:
    type: BlockType
    raw_content: str                   # content with original whitespace
    marker_start: int
    content_start: int

@dataclass(frozen=True)
class AssistantBlockPos:
    marker_start: int
    content_start: int

def split_blocks(text: str) -> list[Block]
def has_empty_assistant_block(text: str) -> bool
def has_empty_tool_execute_block(text: str) -> bool
def find_all_assistant_blocks(text: str) -> list[AssistantBlockPos]
def count_tool_execute_blocks(text: str) -> int

# chatmd.parser.preamble
def parse_preamble(text: str) -> tuple[dict[str, Any], bool]   # (file_config, has_configuration_block)

# chatmd.parser.settings
def parse_settings_block(settings_text: str) -> dict[str, Any] | None

# chatmd.parser.user_content
def parse_user_content(text: str, base_dir: Path | None = None) -> list[Content]
def contains_image_reference(text: str) -> bool

# chatmd.parser.assistant_content
def parse_assistant_content(content: str, base_dir: Path | None = None, *,
                            assets_path: str = "cmdassets",
                            append_wait_marker: bool = False) -> list[Content]

# chatmd.parser.tool_result
def process_tool_result_content(content: str, base_dir: Path | None = None) -> list[Content]

# chatmd.parser.document
def parse_document(text: str, base_dir: str | Path | None = None, *,
                   assets_path: str = "cmdassets") -> ParsedDocument
```

`chatmd.parser.__init__` is owned by the integrator; export nothing from it.

## `chatmd.config` — loader, discovery, JSONC

```python
# chatmd.config.jsonc
def strip_jsonc(text: str) -> str
def loads_jsonc(text: str) -> Any

# chatmd.config.discovery
@dataclass(frozen=True)
class EditorCandidate:
    editor: str                  # "VS Code", "Cursor", ...
    settings_path: Path
    settings: dict[str, Any]     # only the chatmd.* keys, un-prefixed
    api_config_count: int
    mcp_server_count: int

def editor_settings_locations() -> list[tuple[str, Path]]
def discover_editor_settings() -> list[EditorCandidate]
def extract_chatmd_settings(raw: dict[str, Any]) -> dict[str, Any]

# chatmd.config.loader
def config_exists(path: Path | None = None) -> bool
def load_config(path: Path | None = None) -> ChatmdConfig
def save_config(config: ChatmdConfig, path: Path | None = None) -> Path
def config_from_editor_candidates(candidates: Sequence[EditorCandidate]) -> ChatmdConfig
```
