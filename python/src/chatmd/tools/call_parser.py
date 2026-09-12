"""Parsing and detection of ``<cmd:tool_call>`` blocks.

Port of ``src/tools/toolCallParser.ts``. This module is the single source of
truth for what a tool call *is*: the streamer (deciding when to stop emitting
tokens), the listener (collecting finished calls from a document) and the
parser (turning one call into a :class:`~chatmd.types.ToolCall`) all depend on
agreeing with the regex and completeness rules defined here.

The TS source spells its tags with ``\\u003c`` escapes so a naive scan of the
source file for a literal ``<cmd:tool_call>`` (e.g. chat.md's own block/tool
parser, or an editor extension that greps source trees) never mistakes this
file's own constant definitions for a real tool call. We get the same effect
by building each tag from two separate string literals, so the literal
substring never appears contiguously in this file's text either.
"""

from __future__ import annotations

import logging
import re
from dataclasses import dataclass
from xml.sax.saxutils import unescape

from chatmd.providers.native_tools import decode_tool_arguments, params_from_input
from chatmd.types import ToolCall

logger = logging.getLogger(__name__)

# --------------------------------------------------------------------------- #
# Tags
# --------------------------------------------------------------------------- #

#: Qualified tags of the only supported tool call format. Built from two
#: literals (see module docstring) rather than one contiguous string.
CMD_TOOL_CALL_OPEN_TAG = "<" + "cmd:tool_call>"
CMD_TOOL_CALL_CLOSE_TAG = "<" + "/cmd:tool_call>"

#: Marker the model emits once, after the last tool call of a batch, to say
#: "that is the whole batch, run it and give me the results".
#:
#: It is a stream-control signal, not part of the .chat.md format: it is never
#: written into the document and never parsed back out of one. The streamer
#: strips it while streaming, and parse_document re-synthesises it into the API
#: payload after each historical tool batch so the model always sees its own
#: past turns in the shape it is asked to produce.
CMD_WAIT_TOOL_RESULT_TAG = "<" + "cmd:wait-tool-result/>"

#: The single source of truth for what a complete tool call looks like: the
#: opening tag, any body, and a closing tag that starts its own line. The
#: newline keeps a closing tag mentioned inline inside a parameter value from
#: ending the call early.
#:
#: This is a regex *source string*, not a compiled pattern: callers must
#: compile it with re.DOTALL so ``.`` also matches newlines (the TS original
#: uses ``[\s\S]`` for the same reason, since JS regexes have no dotall-free
#: equivalent trick that reads as cleanly).
TOOL_CALL_PATTERN: str = CMD_TOOL_CALL_OPEN_TAG + r".*?\n\s*" + CMD_TOOL_CALL_CLOSE_TAG

_TOOL_CALL_FULL_RE = re.compile(TOOL_CALL_PATTERN, re.DOTALL)

# Same boundary as TOOL_CALL_PATTERN but with the body captured, and a
# permissive `\s*` right after the open tag (parseToolCall needs this looser
# variant to also locate a match when hunting through preprocessed text).
_TOOL_CALL_CONTENT_RE = re.compile(
    CMD_TOOL_CALL_OPEN_TAG + r"\s*(.*?)\n\s*" + CMD_TOOL_CALL_CLOSE_TAG, re.DOTALL
)

# Strips exactly the open tag (plus following whitespace) and the closing tag
# (plus preceding whitespace, which must start with the required newline) from
# a full tool-call match, leaving the inner body untouched.
_STRIP_CALL_TAGS_RE = re.compile(CMD_TOOL_CALL_OPEN_TAG + r"\s*|\n\s*" + CMD_TOOL_CALL_CLOSE_TAG)

_TOOL_NAME_RE = re.compile(r"<cmd:tool_name>\s*(.*?)\s*</cmd:tool_name>", re.DOTALL)
_TOOL_ID_RE = re.compile(r"<cmd:tool_id>\s*(.*?)\s*</cmd:tool_id>", re.DOTALL)
_ARGUMENTS_RE = re.compile(r"<cmd:arguments>(.*?)</cmd:arguments>", re.DOTALL)

# Used by parse_tool_call: value is trimmed by the surrounding `\s*`s before
# CDATA extraction happens on what remains.
_PARAM_VALUE_RE = re.compile(
    r"<cmd:param\s+name=[\"'](.*?)[\"']>\s*(.*?)\s*</cmd:param>", re.DOTALL
)

# Used by are_params_complete: only the block boundaries matter here, so no
# trimming of the captured value.
_PARAM_BLOCK_RE = re.compile(r"<cmd:param\s+name=[\"'](.*?)[\"']>(.*?)</cmd:param>", re.DOTALL)

_CDATA_SECTION_RE = re.compile(r"<!\[CDATA\[(.*?)\]\]>", re.DOTALL)
_FULL_CDATA_RE = re.compile(r"^<!\[CDATA\[(.*?)\]\]>$", re.DOTALL)

# Matches an XML-like tag (open, close, or an unterminated one running to end
# of string) so preprocess_cdata_for_matching can hide tag-shaped text found
# inside CDATA from the tag-boundary scanners. No DOTALL: `[^>]` already
# spans newlines on its own, matching the TS regex's lack of an `s` flag here.
_XML_LIKE_TAG_RE = re.compile(r"</?[^>]+(>|$)")


@dataclass(frozen=True)
class CompletedToolCall:
    """A tool call whose opening tag, body and closing tag are all present."""

    end_index: int
    tool_name: str


def find_wait_marker(text: str) -> int:
    """Index of the first complete wait marker in `text`, or -1 when there is none."""
    return text.find(CMD_WAIT_TOOL_RESULT_TAG)


def wait_marker_prefix_length(text: str) -> int:
    """Length of the longest suffix of `text` that is a proper prefix of the wait
    marker, or 0 when the text does not end mid-marker.

    Used to hold back the tail of a batch that may still turn into a marker, so a
    marker split across two token batches is never written to the document.
    """
    max_len = min(len(text), len(CMD_WAIT_TOOL_RESULT_TAG) - 1)
    for length in range(max_len, 0, -1):
        if CMD_WAIT_TOOL_RESULT_TAG.startswith(text[len(text) - length :]):
            return length
    return 0


def append_wait_marker_after_last_tool_call(text: str) -> str:
    """Appends the wait marker after the last complete tool call in `text`.

    Used when replaying a finished assistant turn to the API: the document holds
    the tool calls without the marker, and the model is asked to always end a
    batch with one, so history has to carry it too.

    Returns `text` unchanged when it holds no complete tool call.
    """
    matches = list(_TOOL_CALL_FULL_RE.finditer(text))
    if not matches:
        return text
    insert_at = matches[-1].end()
    return text[:insert_at] + "\n" + CMD_WAIT_TOOL_RESULT_TAG + text[insert_at:]


def _extract_xml_content(tool_call_xml: str) -> str:
    """Extracts the raw XML content of a tool call. Only the un-fenced
    ``<cmd:tool_call>`` format is supported."""
    content = tool_call_xml.strip()
    if content.startswith(CMD_TOOL_CALL_OPEN_TAG):
        logger.debug("Tool call format: non-fenced")
        return content
    logger.debug("Tool call must use the un-fenced cmd format")
    return ""


def preprocess_xml_with_cdata(xml: str) -> str:
    """Replaces each CDATA section with a placeholder so tag-boundary matching
    (finding where ``<cmd:tool_call>``/``</cmd:tool_call>`` actually start and end)
    is not confused by XML-like text sitting inside a CDATA payload.

    Only used for locating boundaries: parameter extraction always happens against
    the original, un-substituted text so CDATA content survives intact.

    The filler is exactly as long as what it replaces. That is load-bearing: the
    offsets a boundary match reports are used to slice the *original* text, and the
    TypeScript version's variable-length placeholders made those offsets wrong
    whenever a CDATA payload was present — far enough wrong to run past the end of
    the text. Underscores also cannot reintroduce a tag-shaped substring.
    """

    def _replace(match: re.Match[str]) -> str:
        return "_" * len(match.group(0))

    return _CDATA_SECTION_RE.sub(_replace, xml)


def are_cdata_tags_balanced(text: str) -> bool:
    """Checks that every ``<![CDATA[`` in `text` has a matching ``]]>``.

    Walks the text character by character rather than counting open/close tags,
    because counting alone can't tell a genuinely unbalanced pair from one that
    merely appears out of nesting order.
    """
    is_inside_cdata = False
    i = 0
    n = len(text)
    while i < n:
        if not is_inside_cdata:
            if i + 8 < n and text[i : i + 9] == "<![CDATA[":
                is_inside_cdata = True
                i += 9
            else:
                i += 1
        else:
            if i + 2 < n and text[i : i + 3] == "]]>":
                is_inside_cdata = False
                i += 3
            else:
                i += 1

    if is_inside_cdata:
        logger.debug("CDATA tags are not balanced: missing closing tag")
        return False
    return True


def are_params_complete(text: str) -> bool:
    """Checks that every ``<cmd:param>`` block in `text` has balanced CDATA tags."""
    param_blocks = [m.group(0) for m in _PARAM_BLOCK_RE.finditer(text)]

    for block in param_blocks:
        if not are_cdata_tags_balanced(block):
            logger.debug("Param block has unbalanced CDATA tags: %s...", block[:50])
            return False

    return True


def preprocess_cdata_for_matching(text: str) -> str:
    """Masks XML-like tags found *inside* CDATA sections, so a stray closing tag
    (or a nested-looking ``]]>``) written inside a parameter's CDATA payload can
    never be mistaken for a real structural tag by the boundary scanners that run
    on the result.

    Walks character by character (see :func:`are_cdata_tags_balanced`) so nesting
    order, not just tag counts, determines what counts as "inside" CDATA.

    Masking is length preserving, unlike the base64 placeholders the TypeScript
    version substitutes. Callers map the offsets a match reports back onto the
    original text, and inflating the text shifts every offset after the first
    CDATA payload — enough to push a reported end index past the end of the input,
    which then lets stream-control text leak into the document.
    """
    processed: list[str] = []
    is_inside_cdata = False
    cdata_content = ""
    i = 0
    n = len(text)

    while i < n:
        if not is_inside_cdata:
            if i + 8 < n and text[i : i + 9] == "<![CDATA[":
                is_inside_cdata = True
                cdata_content = ""
                i += 9
                processed.append("<![CDATA[")
            else:
                processed.append(text[i])
                i += 1
        else:
            if i + 2 < n and text[i : i + 3] == "]]>":
                is_inside_cdata = False

                def _mask_tag(match: re.Match[str]) -> str:
                    return "_" * len(match.group(0))

                safe_content = _XML_LIKE_TAG_RE.sub(_mask_tag, cdata_content)
                processed.append(safe_content)
                processed.append("]]>")
                i += 3
            else:
                cdata_content += text[i]
                i += 1

    return "".join(processed)


def extract_cdata_content(text: str) -> str:
    """Extracts the content of a CDATA section from a parameter value, if present.

    Tries a whole-value CDATA match first (the common case: the entire trimmed
    value is one CDATA block). Falls back to replacing any CDATA section found
    within surrounding text (against the original, untrimmed text, so characters
    around the section are preserved). Returns the text unchanged if there is no
    CDATA at all.
    """
    trimmed = text.strip()
    full_match = _FULL_CDATA_RE.match(trimmed)
    if full_match:
        logger.debug("Found parameter value fully wrapped in CDATA, extracting content.")
        return full_match.group(1)

    if "<![CDATA[" in text:
        logger.debug("Found CDATA section within parameter value, attempting replacement.")
        return _CDATA_SECTION_RE.sub(lambda m: m.group(1), text)

    logger.debug("No CDATA found in parameter value.")
    return text


def parse_tool_call(tool_call_xml: str) -> ToolCall | None:
    """Parses a raw ``<cmd:tool_call>...</cmd:tool_call>`` string into a
    :class:`~chatmd.types.ToolCall`, or ``None`` if it can't be parsed.

    Tag boundaries are found against a CDATA-placeholder-substituted copy (see
    :func:`preprocess_xml_with_cdata`) so a closing-tag-shaped string inside a
    parameter's CDATA can't be mistaken for the real closing tag. Parameter names
    and values are then read back out of the *original* text so CDATA content
    survives intact, and CDATA-wrapped values are unwrapped via
    :func:`extract_cdata_content`. Every value is kept as a string, even one that
    looks like a JSON object or array.
    """
    try:
        xml_content = _extract_xml_content(tool_call_xml)
        preprocessed_xml = preprocess_xml_with_cdata(xml_content)

        tool_call_content_match = _TOOL_CALL_CONTENT_RE.search(preprocessed_xml)

        original_tool_call_content = ""
        if tool_call_content_match:
            # Slice the body straight out of the original text using the span the
            # boundary match reported. Masking is length preserving, so the two
            # texts share coordinates. Re-searching the original instead — what the
            # TypeScript version does — lets a closing-tag-shaped string inside a
            # CDATA payload end the lazy match early and silently truncate the
            # parameters, which is exactly what the masking exists to prevent.
            start, end = tool_call_content_match.span(1)
            original_tool_call_content = xml_content[start:end]
        else:
            # Fallback: preprocessed matching failed (e.g. no newline before the
            # closing tag survived substitution) — try the original text directly.
            fallback_match = _TOOL_CALL_CONTENT_RE.search(xml_content)
            original_tool_call_content = fallback_match.group(1) if fallback_match else ""

        if not original_tool_call_content:
            logger.debug("Could not extract tool call content")
            return None

        name_match = _TOOL_NAME_RE.search(original_tool_call_content)
        if not name_match:
            logger.debug("Could not find tool_name tag")
            return None

        tool_name = unescape(name_match.group(1).strip())
        id_match = _TOOL_ID_RE.search(original_tool_call_content)
        tool_id = unescape(id_match.group(1).strip()) if id_match else None
        arguments_match = _ARGUMENTS_RE.search(original_tool_call_content)
        native_input = (
            decode_tool_arguments(arguments_match.group(1)) if arguments_match else None
        )
        params: dict[str, str] = {}

        for param_match in _PARAM_VALUE_RE.finditer(original_tool_call_content):
            param_name = param_match.group(1).strip()
            param_value = param_match.group(2).strip()

            # Handles multiple/partial CDATA sections, stripping only the CDATA
            # tags themselves and preserving the content.
            param_value = extract_cdata_content(param_value)

            params[param_name] = param_value

            stripped_value = param_value.strip()
            if stripped_value.startswith("{") or stripped_value.startswith("["):
                logger.debug(
                    'Parameter "%s" appears to be JSON, storing as string: %s%s',
                    param_name,
                    param_value[:50],
                    "..." if len(param_value) > 50 else "",
                )

        if native_input is not None:
            params = params_from_input(native_input)

        logger.debug("Parsed tool call with parameters: %s", list(params.keys()))
        return ToolCall(
            name=tool_name,
            params=params,
            id=tool_id,
            input=native_input,
            raw_xml=tool_call_xml,
        )
    except Exception as error:  # noqa: BLE001 - mirrors the TS catch-and-log-null
        logger.debug("Error parsing tool call: %s", error)
        return None


def find_all_tool_calls(text: str) -> list[str]:
    """Finds every complete tool call in a finished assistant block, in order.

    Shares TOOL_CALL_PATTERN with the streaming detector and parse_tool_call, so a
    call collected here is always a call the parser accepts. Divergence here would
    break the positional matching of tool calls to tool_execute blocks.
    """
    return [m.group(0) for m in _TOOL_CALL_FULL_RE.finditer(text)]


def check_for_completed_tool_call(text: str) -> CompletedToolCall | None:
    """Checks whether `text` contains a complete tool call, handling CDATA
    sections in parameters, and returns its end index and tool name if so.

    The search itself runs against a CDATA-preprocessed copy of `text` (see
    :func:`preprocess_cdata_for_matching`) so tag-shaped text inside CDATA can't
    end the match early. Completeness (balanced CDATA, complete `<cmd:param>`
    blocks) is then re-checked against the *original* `text`, sliced up to the
    match's end index — exactly as the TS implementation does, including using an
    end index found in the preprocessed copy to slice the original text.
    """
    logger.debug("Checking for completed tool call in text of length %d", len(text))

    preprocessed_text = preprocess_cdata_for_matching(text)
    match = _TOOL_CALL_FULL_RE.search(preprocessed_text)
    if match is None:
        return None

    match_end_index = match.end()
    original_text_portion = text[:match_end_index]

    if not are_cdata_tags_balanced(original_text_portion):
        logger.debug("Tool call has unbalanced CDATA tags, not considering it complete")
        return None

    if not are_params_complete(original_text_portion):
        logger.debug("Tool call has incomplete parameter sections, not considering it complete")
        return None

    tool_name_match = _TOOL_NAME_RE.search(original_text_portion)
    tool_name = tool_name_match.group(1).strip() if tool_name_match else ""

    logger.debug('Found completed tool call for tool "%s"', tool_name)
    logger.debug("Stopping streaming at completed tool call")

    return CompletedToolCall(end_index=match_end_index, tool_name=tool_name)
