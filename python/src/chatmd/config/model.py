"""Configuration model and resolution precedence.

Key names are deliberately identical to the ``chatmd.*`` VS Code settings, so
``chatmd setup`` can copy them straight across. Note the TypeScript settings mix
conventions: ``apiKey``/``reasoningEffort``/``maxTokens``/``maxThinkingTokens``/
``openaiApi`` are camelCase while ``model_name``/``base_url``/``type`` are not.
Both are preserved exactly.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Any

from ..errors import ConfigError
from ..types import OpenaiApiStyle, ProviderType, ReasoningEffort

DEFAULT_MAX_TOKENS = 8000
DEFAULT_MAX_THINKING_TOKENS = 16000
DEFAULT_ASSETS_PATH = "cmdassets"

#: Keys a ``.chat.md`` preamble may set.
ALLOWED_FILE_CONFIG_KEYS = frozenset(
    {"selectedConfig", "reasoningEffort", "maxTokens", "maxThinkingTokens", "openaiApi"}
)
#: Keys that must come from the global config only.
FORBIDDEN_FILE_CONFIG_KEYS = frozenset(
    {"type", "apiKey", "base_url", "model_name", "apiConfigs"}
)


@dataclass
class ApiConfig:
    """One named provider configuration."""

    type: ProviderType
    api_key: str
    model_name: str | None = None
    base_url: str | None = None
    reasoning_effort: ReasoningEffort | None = None
    max_tokens: int | None = None
    max_thinking_tokens: int | None = None
    openai_api: OpenaiApiStyle | None = None

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ApiConfig:
        return cls(
            type=data.get("type", "anthropic"),
            api_key=data.get("apiKey", ""),
            model_name=data.get("model_name") or None,
            base_url=(data.get("base_url") or None),
            reasoning_effort=data.get("reasoningEffort") or None,
            max_tokens=data.get("maxTokens"),
            max_thinking_tokens=data.get("maxThinkingTokens"),
            openai_api=data.get("openaiApi") or None,
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {"type": self.type, "apiKey": self.api_key}
        for attr, key in (
            ("model_name", "model_name"),
            ("base_url", "base_url"),
            ("reasoning_effort", "reasoningEffort"),
            ("max_tokens", "maxTokens"),
            ("max_thinking_tokens", "maxThinkingTokens"),
            ("openai_api", "openaiApi"),
        ):
            value = getattr(self, attr)
            if value is not None:
                out[key] = value
        return out


@dataclass
class McpServerConfig:
    """A stdio, Streamable HTTP or legacy SSE MCP server."""

    command: str | None = None
    args: list[str] = field(default_factory=list)
    url: str | None = None
    transport: str = "auto"
    headers: dict[str, str] = field(default_factory=dict)
    env: dict[str, str] = field(default_factory=dict)

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> McpServerConfig:
        return cls(
            command=data.get("command") or None,
            args=list(data.get("args") or []),
            url=data.get("url") or None,
            transport=data.get("transport") or "auto",
            headers=dict(data.get("headers") or {}),
            env=dict(data.get("env") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        out: dict[str, Any] = {}
        if self.command:
            out["command"] = self.command
            out["args"] = list(self.args)
        if self.url:
            out["url"] = self.url
            if self.transport and self.transport != "auto":
                out["transport"] = self.transport
            if self.headers:
                out["headers"] = dict(self.headers)
        if self.env:
            out["env"] = dict(self.env)
        return out

    @property
    def is_stdio(self) -> bool:
        return bool(self.command)


@dataclass
class DaemonConfig:
    debounce_ms: int = 300

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> DaemonConfig:
        return cls(debounce_ms=int(data.get("debounceMs", 300)))

    def to_dict(self) -> dict[str, Any]:
        return {"debounceMs": self.debounce_ms}


@dataclass
class ResolvedConfig:
    """Everything one request needs, after applying the precedence rules."""

    provider: ProviderType
    api_key: str
    config_name: str | None = None
    model_name: str | None = None
    base_url: str | None = None
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_thinking_tokens: int = DEFAULT_MAX_THINKING_TOKENS
    reasoning_effort: ReasoningEffort | None = None
    openai_api: OpenaiApiStyle = "auto"
    assets_path: str = DEFAULT_ASSETS_PATH

    @property
    def thinking_enabled(self) -> bool:
        return self.reasoning_effort != "none"


@dataclass
class ChatmdConfig:
    """On-disk global configuration (``~/.config/chat.md/config.json``)."""

    version: int = 1
    api_configs: dict[str, ApiConfig] = field(default_factory=dict)
    selected_config: str | None = None
    mcp_servers: dict[str, McpServerConfig] = field(default_factory=dict)
    max_tokens: int = DEFAULT_MAX_TOKENS
    max_thinking_tokens: int = DEFAULT_MAX_THINKING_TOKENS
    reasoning_effort: ReasoningEffort | None = None
    assets_path: str = DEFAULT_ASSETS_PATH
    openai_api: OpenaiApiStyle = "auto"
    daemon: DaemonConfig = field(default_factory=DaemonConfig)
    pricing: dict[str, Any] = field(default_factory=dict)

    # -- serialisation ----------------------------------------------------- #

    @classmethod
    def from_dict(cls, data: dict[str, Any]) -> ChatmdConfig:
        return cls(
            version=int(data.get("version", 1)),
            api_configs={
                name: ApiConfig.from_dict(value)
                for name, value in (data.get("apiConfigs") or {}).items()
                if isinstance(value, dict)
            },
            selected_config=data.get("selectedConfig") or None,
            mcp_servers={
                name: McpServerConfig.from_dict(value)
                for name, value in (data.get("mcpServers") or {}).items()
                if isinstance(value, dict)
            },
            max_tokens=int(data.get("maxTokens") or DEFAULT_MAX_TOKENS),
            max_thinking_tokens=int(
                data.get("maxThinkingTokens") or DEFAULT_MAX_THINKING_TOKENS
            ),
            reasoning_effort=data.get("reasoningEffort") or None,
            assets_path=data.get("assetsPath") or DEFAULT_ASSETS_PATH,
            openai_api=data.get("openaiApi") or "auto",
            daemon=DaemonConfig.from_dict(data.get("daemon") or {}),
            pricing=dict(data.get("pricing") or {}),
        )

    def to_dict(self) -> dict[str, Any]:
        return {
            "version": self.version,
            "apiConfigs": {n: c.to_dict() for n, c in self.api_configs.items()},
            "selectedConfig": self.selected_config,
            "mcpServers": {n: c.to_dict() for n, c in self.mcp_servers.items()},
            "maxTokens": self.max_tokens,
            "maxThinkingTokens": self.max_thinking_tokens,
            "reasoningEffort": self.reasoning_effort,
            "assetsPath": self.assets_path,
            "openaiApi": self.openai_api,
            "daemon": self.daemon.to_dict(),
            "pricing": self.pricing,
        }

    # -- resolution -------------------------------------------------------- #

    def resolve(
        self,
        config_name: str | None = None,
        overrides: dict[str, Any] | None = None,
    ) -> ResolvedConfig:
        """Apply the three-level precedence: file preamble > named config > global.

        ``overrides`` is the ``.chat.md`` preamble. Its ``selectedConfig`` picks the
        named config, beating the explicit ``config_name`` argument, which in turn
        beats the globally selected one.
        """
        overrides = overrides or {}
        name = overrides.get("selectedConfig") or config_name or self.selected_config
        if not name:
            raise ConfigError(
                "No API configuration selected. Set 'selectedConfig' in the config "
                "file, in the chat file preamble, or pass one explicitly."
            )

        api_config = self.api_configs.get(name)
        if api_config is None:
            available = ", ".join(sorted(self.api_configs)) or "none"
            raise ConfigError(
                f"Configuration '{name}' not found. Available configurations: {available}"
            )
        if not api_config.api_key:
            raise ConfigError(f"Configuration '{name}' has no apiKey.")

        def pick(key: str, from_config: Any, global_value: Any) -> Any:
            if overrides.get(key) is not None:
                return overrides[key]
            if from_config is not None:
                return from_config
            return global_value

        base_url = api_config.base_url
        if base_url is not None and not base_url.strip():
            base_url = None

        return ResolvedConfig(
            provider=api_config.type,
            api_key=api_config.api_key,
            config_name=name,
            model_name=api_config.model_name,
            base_url=base_url,
            max_tokens=int(pick("maxTokens", api_config.max_tokens, self.max_tokens)),
            max_thinking_tokens=int(
                pick(
                    "maxThinkingTokens",
                    api_config.max_thinking_tokens,
                    self.max_thinking_tokens,
                )
            ),
            reasoning_effort=pick(
                "reasoningEffort", api_config.reasoning_effort, self.reasoning_effort
            ),
            openai_api=pick("openaiApi", api_config.openai_api, self.openai_api) or "auto",
            assets_path=self.assets_path,
        )
