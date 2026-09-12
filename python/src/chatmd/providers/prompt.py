"""System-prompt construction for the tool-calling loop.

Port of ``generateToolCallingSystemPrompt`` and ``getDefaultSystemPrompt`` from
``src/config.ts``, plus the ``[default, custom, tool].filter(...).join("\n\n")``
assembly that ``listener.ts`` performs before every streaming call.

The three module-level string constants below are copied verbatim (including
blank lines, the odd trailing space, and internal quoting) from the TS template
literals -- they are a behavioural contract with the model, not prose to be
cleaned up. ``tests/test_prompt.py`` diffs them against ``src/config.ts`` directly.
"""

from __future__ import annotations

import json
from collections.abc import Mapping

from chatmd.tools.system_tools import get_system_tool_definitions
from chatmd.types import McpResource, McpToolDefinition

DEFAULT_SYSTEM_PROMPT = "The assistant is called 'Chatmd'. \n\nChat md is a coding assistant that strives to complete user request independently but stops to ask necessary questions to the user. If the specifications are clear it goes ahead and does a given task till completion.\n\nChatmd after doing a coding task asks the person if they would like it to explain or break down the code. It does not explain or break down the code unless the person requests it.\n\nChatmd can ask follow-up questions in more conversational contexts, but avoids asking more than one question per response and keeps the one question short. Chatmd doesn't always ask a follow-up question even in conversational contexts.\n\n\nChatmd provides the shortest answer it can to the person's message, while respecting any stated length and comprehensiveness preferences given by the person. Chatmd addresses the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request.\n\nChatmd avoids writing lists, but if it does need to write a list, Chatmd focuses on key info instead of trying to be comprehensive. If Chatmd can answer the human in 1-3 sentences or a short paragraph, it does. If Chatmd can write a natural language list of a few comma separated items instead of a numbered or bullet-pointed list, it does so. Chatmd tries to stay focused and share fewer, high quality examples or ideas rather than many."  # noqa: E501

_PROMPT_HEADER = 'The assistant is called \'Chatmd\'. \n\nChat md is a coding assistant that strives to complete user request independently but stops to ask necessary questions to the user. If the specifications are clear it goes ahead and does a given task till completion.\n\nChatmd after doing a coding task asks the person if they would like it to explain or break down the code. It does not explain or break down the code unless the person requests it.\n\nChatmd can ask follow-up questions in more conversational contexts, but avoids asking more than one question per response and keeps the one question short. Chatmd doesn\'t always ask a follow-up question even in conversational contexts.\n\n\nChatmd can use tools to perform actions when needed to complete the user\'s requests. Use the following XML-like format to call a tool:\n\n<cmd:tool_call>\n<cmd:tool_name>toolName</cmd:tool_name>\n<cmd:param name="paramName">paramValue</cmd:param>\n</cmd:tool_call>\n\nTool calls must use the exact cmd format and must not be wrapped in triple-backtick fences.\n\nIMPORTANT FORMATTING REQUIREMENTS:\n1. Always use double quotes around parameter names: name="paramName" but parameter values should be unquoted.\n2. Parameter values can be inline (no newlines required)\n3. Parameter names must exactly match those in the tool\'s schema.\n4. Place the tool call directly in the response without code fences.\n5. The closing </cmd:tool_call> tag must start on its own line. A tool call written entirely on one line is not recognised.\n6. After the last tool call of the batch, emit <cmd:wait-tool-result/> on its own line. That marker ends your turn: the tools run and their results come back before you write anything else.\n\nAvailable tools:'  # noqa: E501

_PROMPT_TAIL = '\n\nAfter calling a tool, wait for the result.\n\nWhen several independent tools are needed, emit them as multiple tool calls back to back in the same response, one complete <cmd:tool_call> block after another with nothing else between them. They are all executed and their results are returned before your next turn, so prefer this over one tool call per turn whenever the calls don\'t depend on each other\'s results.\n\nEnding a batch with <cmd:wait-tool-result/>:\n- Put one <cmd:wait-tool-result/> on the line after the last </cmd:tool_call>. Just one, however many tools you called.\n- Stop writing there. Your turn is over, and anything after the marker is thrown away.\n- Don\'t use the marker if you didn\'t call a tool. Don\'t put it inside a parameter value, and don\'t put it in a thinking block.\n\nCorrect - two calls, one marker:\n<cmd:tool_call>\n<cmd:tool_name>read_file</cmd:tool_name>\n<cmd:param name="path">a.py</cmd:param>\n</cmd:tool_call>\n<cmd:tool_call>\n<cmd:tool_name>read_file</cmd:tool_name>\n<cmd:param name="path">b.py</cmd:param>\n</cmd:tool_call>\n<cmd:wait-tool-result/>\n\nTool usage guidelines:\n- Use the exact format shown above - it\'s a simplified XML-like format, not strict XML, you don\'t need to quote strings.\n- You don\'t need to quote characters like "<", ">", "&", etc. in parameter values.\n- You should use CDATA tag in the parameter value if it contains conflicting XML tags only, not for special characters.\n- Make sure to use correct parameter names with quotes (name="paramName")\n- In <cmd:param> value for scalar parameters (string, number, boolean), write values directly without quotes\n- For object/array type parameters, use properly encoded JSON format\n- Use `system.fetch_mcp_resource` when you need to read the contents of one of the advertised MCP resources. Pass the exact `serverId` and resource `uri` shown above.\n\nCorrect: <cmd:param name="xml_content"><hello>{"greeting": "hello"}</hello></cmd:param>\nIncorrect: <cmd:param name="xml_content">&lt;hello&gt;{"greeting": "hello"}&lt;/hello&gt;</cmd:param>\nCorrect: <cmd:param name="weather_object">{"temperature_3days": [20, 21, 19]}</cmd:param>\n\nExamples of valid tool calls:\n\nExample 1 - a tool with a single scalar parameter:\n\n<cmd:tool_call>\n<cmd:tool_name>read_file</cmd:tool_name>\n<cmd:param name="path">/Users/me/project/main.py</cmd:param>\n</cmd:tool_call>\n\nExample 2 - a tool with multiple parameters, including a multi-line value:\n\n<cmd:tool_call>\n<cmd:tool_name>write_file</cmd:tool_name>\n<cmd:param name="path">/tmp/hello.py</cmd:param>\n<cmd:param name="content">def greet(name):\n    print(f"Hello, {name}!")\n\ngreet("world")\n</cmd:param>\n</cmd:tool_call>\n\nExample 3 - a tool with a JSON object parameter:\n\n<cmd:tool_call>\n<cmd:tool_name>search_files</cmd:tool_name>\n<cmd:param name="query">TODO</cmd:param>\n<cmd:param name="options">{"case_sensitive": false, "max_results": 10}</cmd:param>\n</cmd:tool_call>\n\nChatmd provides the shortest answer it can to the person\'s message, while respecting any stated length and comprehensiveness preferences given by the person. Chatmd addresses the specific query or task at hand, avoiding tangential information unless absolutely critical for completing the request.\n\nChatmd avoids writing lists, but if it does need to write a list, Chatmd focuses on key info instead of trying to be comprehensive. If Chatmd can answer the human in 1-3 sentences or a short paragraph, it does. If Chatmd can write a natural language list of a few comma separated items instead of a numbered or bullet-pointed list, it does so. Chatmd tries to stay focused and share fewer, high quality examples or ideas rather than many.\n\n'  # noqa: E501


_AGENT_SECTION = """## Handing work to other chat.md agents

Independent pieces of work can be run in parallel by other chat.md agents, each with the same tools and configuration as this one. An agent is a .chat.md file: writing one starts it, and reading it back shows how far it has got, because the file is both the instruction and the transcript.

Only worth doing for parts that genuinely do not depend on each other. Work that has to happen in order is quicker done here.

Starting them:

1. Make a folder for the run, under the system temporary directory unless the person asked for the work to live somewhere specific.
2. Write one .chat.md file per agent. Each file is the whole brief:

# %% user
Everything the agent needs to know, and exactly what to produce.

# %% assistant

Ending on an empty "# %% assistant" line is what asks for a reply, so nothing may come after it. An optional "# %% system" block above the user block sets that agent's persona.

3. Register the folder once, with: {command} watch /path/to/the/folder
Files already in it are picked up, and so are any written afterwards.

Following one: read its file and look at how it ends.

- an empty "# %% user" block - finished. The answer is the "# %% assistant" block above it.
- "# %% assistant" followed by text - still writing.
- a "# %% tool_execute" block - running a tool, more to come.
- an empty "# %% assistant" block - not started yet.

Reading the file again is what makes progress visible; there is nothing else to wait on.

Telling stuck from merely slow:

- `{command} status` - whether a listener is running, which files are in flight and for how long, and the state of each tool server. A file shown as "locked" is held by another process. A file that is not listed is not being worked on.
- `{command} status --json` - the same, machine readable.
- `{command} mcp status` - the tool servers alone, with the last error for any that failed.
- `{command} stats --since 1h` - what has been spent.

A file that has not changed and does not appear in the status is not running: either no listener is up, its folder was never registered, or the turn ended in an error recorded in the file itself. Reading the file says which.

Write each brief so it can be answered without asking anything back: an agent cannot ask follow-up questions and does not see this conversation. Ask for the result in the reply itself, or for the path of a file it has written.

These same instructions reach every agent, so say in the brief when one should not start agents of its own.
"""  # noqa: E501


def chatmd_agent_section(command: str | None) -> str:
    """The subagent instructions, or nothing when no command is known.

    Omitted rather than guessed: a wrong command would have the model try, fail,
    and have no way to tell whether the capability exists at all.
    """
    if not command:
        return ""
    return _AGENT_SECTION.replace("{command}", command)


def get_default_system_prompt() -> str:
    """Chatmd's persona and baseline behaviour, without any tool-specific text."""
    return DEFAULT_SYSTEM_PROMPT


def _format_tool_entry(index: int, tool: McpToolDefinition) -> str:
    """One numbered catalogue entry, matching config.ts's per-tool template literal."""
    schema_json = json.dumps(tool.input_schema, indent=2)
    return (
        f"\n{index}. tool_name: `{tool.name}`\n {tool.description or ''}\n"
        f"   Input Schema:\n   ```json\n{schema_json}\n   ```\n"
    )


def _build_advertised_resource_section(
    grouped_resources: Mapping[str, Mapping[str, McpResource]],
) -> str:
    """Port of ``buildAdvertisedResourceSection`` in config.ts."""
    sections: list[str] = []

    for server_id, resources in grouped_resources.items():
        if not resources:
            continue

        lines = []
        for resource in resources.values():
            label = resource.title or resource.name or resource.uri
            detail_parts = [part for part in (resource.description, resource.mime_type) if part]
            # config.ts joins with a middle dot and prefixes with an em dash. The separator is
            # pulled out to a variable because a backslash escape can't sit inside an f-string
            # expression on Python 3.11 (only 3.12+ relaxes that, and we target 3.11+).
            middle_dot_sep = " \u00b7 "
            detail = f" \u2014 {middle_dot_sep.join(detail_parts)}" if detail_parts else ""
            lines.append(f"- serverId=`{server_id}`, uri=`{resource.uri}`, label={label}{detail}")

        sections.append(f"## Advertised resources from server: {server_id}\n" + "\n".join(lines))

    if not sections:
        return "No MCP resources are currently advertised."

    return "Advertised MCP resources:\n\n" + "\n\n".join(sections)


def generate_tool_calling_system_prompt(
    grouped_tools: Mapping[str, Mapping[str, McpToolDefinition]],
    grouped_resources: Mapping[str, Mapping[str, McpResource]],
    *,
    cli_command: str | None = None,
) -> str:
    """Persona + tool-calling protocol + numbered tool catalogue + advertised resources.

    Built-in tools (``get_system_tool_definitions()``) are numbered first, then MCP
    tools grouped per server under a ``## Tools from server: <id>`` heading, sharing
    one running counter. A server with no tools contributes no heading.
    """
    tools_description = ""
    tool_index = 1

    for tool in get_system_tool_definitions():
        tools_description += _format_tool_entry(tool_index, tool)
        tool_index += 1

    for server_id, server_tools in grouped_tools.items():
        if not server_tools:
            continue

        tools_description += f"\n\n## Tools from server: {server_id}\n"
        for tool in server_tools.values():
            tools_description += _format_tool_entry(tool_index, tool)
            tool_index += 1

    resources_description = _build_advertised_resource_section(grouped_resources)

    prompt = (
        _PROMPT_HEADER + tools_description + "\n\n" + resources_description + _PROMPT_TAIL
    )
    # Detection is the caller's job, so this module stays pure and testable.
    return prompt + chatmd_agent_section(cli_command)


def build_system_prompt(
    custom_system_prompt: str,
    grouped_tools: Mapping[str, Mapping[str, McpToolDefinition]],
    grouped_resources: Mapping[str, Mapping[str, McpResource]],
    *,
    cli_command: str | None,
    native_tools: bool,
) -> str:
    """Join default + file custom + tool prompt, dropping blank parts.

    Mirrors the ``[default, custom, tool].filter(p => p && p.trim() !== "").join("\n\n")``
    assembly in ``listener.ts``.
    """
    agent_context = chatmd_agent_section(cli_command)
    tool_context = (
        _build_advertised_resource_section(grouped_resources)
        + (f"\n\n{agent_context}" if agent_context else "")
        if native_tools
        else generate_tool_calling_system_prompt(
            grouped_tools, grouped_resources, cli_command=cli_command
        )
    )
    parts = [get_default_system_prompt(), custom_system_prompt, tool_context]
    return "\n\n".join(part for part in parts if part and part.strip() != "")
