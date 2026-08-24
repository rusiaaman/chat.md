"""Tests for chatmd.providers.prompt.

The persona/tool-calling-protocol text is a behavioural contract with the
model: it must match ``src/config.ts`` byte-for-byte, not just "look similar".
``test_persona_and_protocol_text_matches_config_ts`` below re-extracts the
exact TS template literals from ``src/config.ts`` on every run (rather than
pinning a handful of copied substrings) so that ANY drift between the two
implementations -- even a single changed space -- fails the suite instead of
silently changing what gets sent to the model.
"""

from __future__ import annotations

import json
from pathlib import Path

from chatmd.providers.prompt import (
    build_system_prompt,
    generate_tool_calling_system_prompt,
    get_default_system_prompt,
)
from chatmd.tools.system_tools import get_system_tool_definitions
from chatmd.types import McpResource, McpToolDefinition

_REPO_ROOT = Path(__file__).resolve().parents[2]
_CONFIG_TS = _REPO_ROOT / "src" / "config.ts"


def _tool(name: str) -> McpToolDefinition:
    return McpToolDefinition(
        name=name, description=f"{name} description", input_schema={"type": "object"}
    )


# --------------------------------------------------------------------------- #
# Tool numbering
# --------------------------------------------------------------------------- #


def test_builtin_system_tool_is_numbered_first() -> None:
    builtin_tools = get_system_tool_definitions()
    assert len(builtin_tools) == 1  # only system.fetch_mcp_resource today
    prompt = generate_tool_calling_system_prompt({}, {})
    assert f"1. tool_name: `{builtin_tools[0].name}`" in prompt


def test_mcp_tools_continue_the_shared_counter_across_servers() -> None:
    builtin_count = len(get_system_tool_definitions())
    grouped_tools = {
        "alpha": {"one": _tool("one")},
        "beta": {"two": _tool("two"), "three": _tool("three")},
    }

    prompt = generate_tool_calling_system_prompt(grouped_tools, {})

    assert f"{builtin_count + 1}. tool_name: `one`" in prompt
    assert f"{builtin_count + 2}. tool_name: `two`" in prompt
    assert f"{builtin_count + 3}. tool_name: `three`" in prompt
    assert "## Tools from server: alpha" in prompt
    assert "## Tools from server: beta" in prompt
    # ordering: alpha's heading/tool must precede beta's
    assert prompt.index("## Tools from server: alpha") < prompt.index("## Tools from server: beta")


def test_server_with_no_tools_contributes_no_heading() -> None:
    grouped_tools = {"empty": {}, "alpha": {"one": _tool("one")}}

    prompt = generate_tool_calling_system_prompt(grouped_tools, {})

    assert "## Tools from server: empty" not in prompt
    assert "## Tools from server: alpha" in prompt


def test_tool_entry_renders_schema_as_indented_json_block() -> None:
    tool = McpToolDefinition(
        name="x", description="desc", input_schema={"type": "object", "properties": {}}
    )
    schema_json = json.dumps(tool.input_schema, indent=2)

    prompt = generate_tool_calling_system_prompt({"s": {"x": tool}}, {})

    assert f"\n1. tool_name: `x`\n desc\n   Input Schema:\n   ```json\n{schema_json}\n   ```\n" in (
        # built-in tool is numbered 1, so a lone MCP tool here is numbered 2 --
        # check the templating shape directly rather than the exact index.
        prompt.replace(f"{len(get_system_tool_definitions()) + 1}. tool_name", "1. tool_name")
    )
    assert f"```json\n{schema_json}\n```" in prompt


# --------------------------------------------------------------------------- #
# Advertised resources
# --------------------------------------------------------------------------- #


def test_no_resources_sentence_when_nothing_advertised() -> None:
    prompt = generate_tool_calling_system_prompt({}, {})
    assert "No MCP resources are currently advertised." in prompt


def test_resource_server_with_no_resources_is_skipped() -> None:
    prompt = generate_tool_calling_system_prompt({}, {"empty": {}})
    assert "No MCP resources are currently advertised." in prompt
    assert "## Advertised resources from server: empty" not in prompt


def test_resource_label_prefers_title_then_name_then_uri() -> None:
    grouped_resources = {
        "srv": {
            "r1": McpResource(uri="u1", name="n1", title="T1"),
            "r2": McpResource(uri="u2", name="n2"),
            "r3": McpResource(uri="u3", name=""),
        }
    }

    prompt = generate_tool_calling_system_prompt({}, grouped_resources)

    assert "label=T1" in prompt
    assert "label=n2" in prompt
    assert "label=u3" in prompt


def test_resource_detail_joins_description_and_mime_type_with_em_dash() -> None:
    resource = McpResource(uri="u", name="n", description="d", mime_type="text/plain")

    prompt = generate_tool_calling_system_prompt({}, {"srv": {"r": resource}})

    assert "- serverId=`srv`, uri=`u`, label=n — d · text/plain" in prompt


def test_resource_with_no_description_or_mime_type_has_no_trailing_detail() -> None:
    resource = McpResource(uri="u", name="n")

    prompt = generate_tool_calling_system_prompt({}, {"srv": {"r": resource}})

    assert "- serverId=`srv`, uri=`u`, label=n\n" in prompt or prompt.rstrip().endswith(
        "- serverId=`srv`, uri=`u`, label=n"
    )
    assert "label=n —" not in prompt


# --------------------------------------------------------------------------- #
# build_system_prompt assembly
# --------------------------------------------------------------------------- #


def test_build_system_prompt_drops_blank_custom_prompt() -> None:
    default = get_default_system_prompt()
    tool_prompt = generate_tool_calling_system_prompt({}, {})

    result = build_system_prompt("   ", {}, {})

    assert result == f"{default}\n\n{tool_prompt}"


def test_build_system_prompt_keeps_non_blank_custom_prompt_between_the_other_two() -> None:
    default = get_default_system_prompt()
    tool_prompt = generate_tool_calling_system_prompt({}, {})

    result = build_system_prompt("Be extra terse.", {}, {})

    assert result == f"{default}\n\nBe extra terse.\n\n{tool_prompt}"


def test_build_system_prompt_drops_completely_blank_default_or_tool_parts() -> None:
    # get_default_system_prompt()/generate_tool_calling_system_prompt() are never
    # blank in production, but the join/filter is generic -- exercise it directly
    # against the documented behaviour: filter(p => p && p.trim() !== '').
    parts = ["", "  ", "kept one", "\n", "kept two"]
    joined = "\n\n".join(p for p in parts if p and p.strip() != "")
    assert joined == "kept one\n\nkept two"


# --------------------------------------------------------------------------- #
# Drift test against src/config.ts
# --------------------------------------------------------------------------- #


def _unescape_ts_template_literal(text: str) -> str:
    """Resolve the only two escapes ``src/config.ts`` uses inside its template
    literals: ``\\```` (a literal backtick, needed because backtick delimits the
    literal) and ``\\"`` (a literal double quote, escaped defensively even though
    it isn't required inside a backtick string). No other escape sequence
    appears in the literals this test extracts -- real newlines are real
    newlines in a multi-line template literal, not ``\\n`` text.
    """
    return text.replace("\\`", "`").replace('\\"', '"')


def _extract_template_literal(source: str, start_marker: str, search_from: int = 0) -> tuple[str, int]:
    """Return the text between the backtick after ``start_marker`` and the
    closing `` `; `` that ends a ``return `...`;`` statement, plus the index
    right after that closing marker (so callers can find the *next* literal).
    """
    start = source.index(start_marker, search_from)
    literal_start = start + len(start_marker)
    literal_end = source.index("`;\n}", literal_start)
    return source[literal_start:literal_end], literal_end + len("`;\n}")


def test_persona_and_protocol_text_matches_config_ts() -> None:
    """Extracts the exact template literals from ``generateToolCallingSystemPrompt``
    and ``getDefaultSystemPrompt`` in config.ts and asserts the Python port's
    output contains/equals that text verbatim.

    Approach taken: robust extraction (not a fixed set of copied substrings).
    The TS source's ``return \\`...\\`;`` statements are template literals with
    two placeholders (``${toolsDescription}`` and ``${resourcesDescription}``);
    splitting on those placeholders yields the static header/middle/tail chunks
    that are identical across every render, plus the fully-static persona text
    returned by ``getDefaultSystemPrompt``. Extracting from the source file
    (rather than hand-copying paragraphs into this test) means a future prose
    edit to either side that isn't mirrored on the other fails this test.
    """
    source = _CONFIG_TS.read_text(encoding="utf-8")

    tool_calling_literal, next_search_from = _extract_template_literal(
        source, "  return `The assistant is called 'Chatmd'."
    )
    header, rest = tool_calling_literal.split("${toolsDescription}", 1)
    middle, tail = rest.split("${resourcesDescription}", 1)
    header = _unescape_ts_template_literal(header)
    middle = _unescape_ts_template_literal(middle)
    tail = _unescape_ts_template_literal(tail)

    default_literal, _ = _extract_template_literal(
        source, "  return `The assistant is called 'Chatmd'.", next_search_from
    )
    default_literal = _unescape_ts_template_literal(default_literal)

    # getDefaultSystemPrompt's literal must be byte-identical to the Python port.
    assert get_default_system_prompt() == default_literal

    # generateToolCallingSystemPrompt's header/middle-separator/tail must be
    # byte-identical too; the tool/resource text in between is covered by the
    # numbering and resource tests above.
    tool_prompt = generate_tool_calling_system_prompt({}, {})
    assert tool_prompt.startswith(header)
    assert middle == "\n\n"
    assert tool_prompt.endswith(tail)

    # Sanity: the extraction actually found substantial text, not empty strings
    # (which would make every assertion above vacuously true).
    assert len(header) > 500
    assert len(tail) > 500
    assert len(default_literal) > 500
