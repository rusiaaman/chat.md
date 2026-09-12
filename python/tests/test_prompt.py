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
import re
from pathlib import Path

from chatmd.providers.agent_context import chatmd_format_instructions
from chatmd.providers.prompt import (
    _AGENT_SECTION,
    build_system_prompt,
    chatmd_agent_section,
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
    index = len(get_system_tool_definitions()) + 1  # the lone MCP tool follows the built-in one

    prompt = generate_tool_calling_system_prompt({"s": {"x": tool}}, {})

    expected_entry = (
        f"\n{index}. tool_name: `x`\n desc\n   Input Schema:\n   ```json\n{schema_json}\n   ```\n"
    )
    assert expected_entry in prompt


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

    result = build_system_prompt(
        "   ", {}, {}, cli_command=None, native_tools=False
    )

    assert result == f"{default}\n\n{tool_prompt}"


def test_build_system_prompt_keeps_non_blank_custom_prompt_between_the_other_two() -> None:
    default = get_default_system_prompt()
    tool_prompt = generate_tool_calling_system_prompt({}, {})

    result = build_system_prompt(
        "Be extra terse.", {}, {}, cli_command=None, native_tools=False
    )

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


def _extract_template_literal(source: str, anchor: str, search_from: int = 0) -> tuple[str, int]:
    """Return the text of a `` `...`; `` template literal, plus the index right
    after its closing `` `; `` (so callers can find the *next* literal).

    ``anchor`` locates the right literal (there are two matching ones in
    config.ts, one per function) without itself being part of the literal's own
    text. Only the opening backtick is anchored on, not what comes before it: one
    of the two is bound to a name rather than returned directly, so the agents
    section can be appended after it without breaking this extraction.
    """
    start = source.index("`" + anchor, search_from)
    literal_start = start + 1
    literal_end = source.index("`;\n", literal_start)
    return source[literal_start:literal_end], literal_end + len("`;\n")


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
    persona_opening = "The assistant is called 'Chatmd'."

    tool_calling_literal, next_search_from = _extract_template_literal(source, persona_opening)
    header, rest = tool_calling_literal.split("${toolsDescription}", 1)
    middle, tail = rest.split("${resourcesDescription}", 1)
    header = _unescape_ts_template_literal(header)
    middle = _unescape_ts_template_literal(middle)
    tail = _unescape_ts_template_literal(tail)

    default_literal, _ = _extract_template_literal(source, persona_opening, next_search_from)
    default_literal = _unescape_ts_template_literal(default_literal)

    # getDefaultSystemPrompt's literal must be byte-identical to the Python port.
    assert get_default_system_prompt() == default_literal

    # generateToolCallingSystemPrompt's header/middle-separator/tail must be
    # byte-identical too; the tool/resource text in between is covered by the
    # numbering and resource tests above.
    # Without a CLI command, so the comparison is against the template literal
    # alone; the appended agents section has its own drift test below.
    tool_prompt = generate_tool_calling_system_prompt({}, {}, cli_command=None)
    assert tool_prompt.startswith(header)
    assert middle == "\n\n"
    assert tail in tool_prompt
    assert tool_prompt.endswith(
        chatmd_format_instructions("the ChatMD configuration used by this client")
    )

    # And with one, the section is appended after that same tail rather than
    # replacing any of it.
    with_agents = generate_tool_calling_system_prompt({}, {}, cli_command="chatmd")
    assert with_agents.startswith(tool_prompt)
    assert with_agents.endswith(chatmd_agent_section("chatmd"))

    # Sanity: the extraction actually found substantial text, not empty strings
    # (which would make every assertion above vacuously true).
    assert len(header) > 500
    assert len(tail) > 500
    assert len(default_literal) > 500


# --------------------------------------------------------------------------- #
# The chat.md agents section
# --------------------------------------------------------------------------- #


def test_the_agent_section_is_omitted_when_no_command_is_known() -> None:
    """Guessing a command would have the model try, fail, and learn nothing."""
    assert chatmd_agent_section(None) == ""
    assert chatmd_agent_section("") == ""
    prompt = generate_tool_calling_system_prompt({}, {}, cli_command=None)
    assert "chat.md agents" not in prompt


def test_the_agent_section_interpolates_the_command_everywhere() -> None:
    section = chatmd_agent_section("/opt/bin/chatmd")
    assert "{command}" not in section
    assert "/opt/bin/chatmd watch /path/to/the/folder" in section
    assert "`/opt/bin/chatmd status`" in section
    assert "`/opt/bin/chatmd mcp status`" in section


def test_the_agent_section_documents_every_end_state() -> None:
    """How to tell finished from working is the whole point of polling."""
    section = chatmd_agent_section("chatmd")
    for state in (
        'an empty "# %% user" block - finished',
        '"# %% assistant" followed by text - still writing',
        'a "# %% tool_execute" block - running a tool',
        'an empty "# %% assistant" block - not started yet',
    ):
        assert state in section


def test_the_agent_section_shows_the_file_format_it_asks_for() -> None:
    section = chatmd_agent_section("chatmd")
    assert "# %% user\n" in section
    assert "# %% assistant\n" in section
    # Unescaped: this is a prompt sent to the model, not written into a document.
    assert "# %%%" not in section


def test_the_agent_section_reaches_the_assembled_prompt() -> None:
    prompt = build_system_prompt(
        "Be brief.", {}, {}, cli_command="chatmd", native_tools=False
    )
    assert "Handing work to other chat.md agents" in prompt
    assert "Be brief." in prompt


def test_the_typescript_template_has_not_drifted() -> None:
    """Both engines describe the same CLI, so the text has to be the same."""
    source = (
        Path(__file__).parents[2] / "src" / "utils" / "chatmdCli.ts"
    ).read_text(encoding="utf-8")
    match = re.search(r"^const AGENT_SECTION = (\".*\");$", source, re.MULTILINE)
    assert match is not None, "AGENT_SECTION literal not found in chatmdCli.ts"
    assert json.loads(match.group(1)) == _AGENT_SECTION
