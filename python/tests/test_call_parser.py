"""Tests for chatmd.tools.call_parser.

Tool call XML is built from the module's own tag constants (rather than
hardcoded literals) so these tests stay in lockstep with the tags the module
actually uses.
"""

from __future__ import annotations

from chatmd.tools.call_parser import (
    CMD_TOOL_CALL_CLOSE_TAG,
    CMD_TOOL_CALL_OPEN_TAG,
    CMD_WAIT_TOOL_RESULT_TAG,
    CompletedToolCall,
    append_wait_marker_after_last_tool_call,
    are_cdata_tags_balanced,
    check_for_completed_tool_call,
    find_all_tool_calls,
    find_wait_marker,
    parse_tool_call,
    preprocess_cdata_for_matching,
    wait_marker_prefix_length,
)


def make_call(name: str, body: str = "") -> str:
    """Builds a well-formed, multi-line tool call with the given tool name and
    extra body (e.g. ``<cmd:param>`` blocks) inserted before the closing tag."""
    return (
        CMD_TOOL_CALL_OPEN_TAG
        + "\n<cmd:tool_name>"
        + name
        + "</cmd:tool_name>\n"
        + body
        + CMD_TOOL_CALL_CLOSE_TAG
    )


# --------------------------------------------------------------------------- #
# check_for_completed_tool_call
# --------------------------------------------------------------------------- #


def test_one_line_tool_call_is_not_complete() -> None:
    # No newline before the closing tag: TOOL_CALL_PATTERN requires the closing
    # tag to start its own line, so this must not be recognised.
    text = CMD_TOOL_CALL_OPEN_TAG + "<cmd:tool_name>foo</cmd:tool_name>" + CMD_TOOL_CALL_CLOSE_TAG
    assert check_for_completed_tool_call(text) is None


def test_multi_line_tool_call_is_complete() -> None:
    text = make_call("foo")
    result = check_for_completed_tool_call(text)
    assert result == CompletedToolCall(end_index=len(text), tool_name="foo")


def test_closing_tag_mentioned_inside_param_value_does_not_end_call_early() -> None:
    # A fake "</cmd:tool_call>\n" sitting inside a CDATA-wrapped param value must
    # not be mistaken for the real closing tag: CDATA content is hidden from the
    # tag-boundary scanner before matching (preprocess_cdata_for_matching).
    fake_tag_mention = "before\n" + CMD_TOOL_CALL_CLOSE_TAG + "\nafter"
    text = make_call(
        "foo",
        '<cmd:param name="value"><![CDATA[' + fake_tag_mention + "]]></cmd:param>\n",
    )
    result = check_for_completed_tool_call(text)
    assert result is not None
    assert result.tool_name == "foo"
    # The match must reach (at least) all the way to the real closing tag, i.e.
    # it did not stop early at the fake mention buried inside the CDATA section.
    assert text[: result.end_index] == text


def test_unbalanced_cdata_in_param_means_not_complete() -> None:
    text = make_call(
        "foo",
        '<cmd:param name="x"><![CDATA[ unterminated</cmd:param>\n',
    )
    assert check_for_completed_tool_call(text) is None


def test_no_tool_call_is_not_complete() -> None:
    assert check_for_completed_tool_call("just some plain assistant text") is None


# --------------------------------------------------------------------------- #
# are_cdata_tags_balanced
# --------------------------------------------------------------------------- #


def test_cdata_balanced_simple() -> None:
    assert are_cdata_tags_balanced("<![CDATA[hello world]]>") is True


def test_cdata_unbalanced_missing_close() -> None:
    assert are_cdata_tags_balanced("<![CDATA[hello world") is False


def test_cdata_with_xml_tags_and_nested_looking_open_is_balanced() -> None:
    # A literal "<![CDATA[" appearing *inside* an already-open CDATA section is
    # just text, not a second nesting level: naive open/close *counting* would
    # see 2 opens vs 1 close and wrongly call this unbalanced. The character
    # scan correctly tracks state and calls it balanced.
    text = "<![CDATA[outer <foo>tag</foo> <![CDATA[ nested-looking start]]>"
    assert are_cdata_tags_balanced(text) is True


def test_cdata_no_cdata_at_all_is_balanced() -> None:
    assert are_cdata_tags_balanced("plain text, no cdata here") is True


# --------------------------------------------------------------------------- #
# preprocess_cdata_for_matching
# --------------------------------------------------------------------------- #


def test_preprocess_cdata_for_matching_hides_xml_like_tags() -> None:
    text = "<![CDATA[<foo>bar</foo>]]>"
    result = preprocess_cdata_for_matching(text)
    assert result.startswith("<![CDATA[")
    assert result.endswith("]]>")
    assert "<foo>" not in result
    assert "</foo>" not in result
    assert "bar" in result
    assert "__XML_TAG_PLACEHOLDER_" in result


def test_preprocess_cdata_for_matching_leaves_non_cdata_text_untouched() -> None:
    text = "before <tag>middle</tag> after, no cdata"
    assert preprocess_cdata_for_matching(text) == text


# --------------------------------------------------------------------------- #
# parse_tool_call
# --------------------------------------------------------------------------- #


def test_parse_tool_call_single_and_double_quoted_param_names() -> None:
    text = make_call(
        "foo",
        '<cmd:param name="path">/tmp/x.txt</cmd:param>\n'
        "<cmd:param name='mode'>rw</cmd:param>\n",
    )
    parsed = parse_tool_call(text)
    assert parsed is not None
    assert parsed.name == "foo"
    assert parsed.params == {"path": "/tmp/x.txt", "mode": "rw"}
    assert parsed.raw_xml == text


def test_parse_tool_call_json_object_param_stays_a_string() -> None:
    json_value = '{"a": 1, "b": [1, 2, 3]}'
    text = make_call("foo", f'<cmd:param name="data">{json_value}</cmd:param>\n')
    parsed = parse_tool_call(text)
    assert parsed is not None
    assert parsed.params["data"] == json_value
    assert isinstance(parsed.params["data"], str)


def test_parse_tool_call_cdata_wrapped_param_value() -> None:
    text = make_call(
        "foo",
        '<cmd:param name="code"><![CDATA[if (a < b) { return "</weird>"; }]]></cmd:param>\n',
    )
    parsed = parse_tool_call(text)
    assert parsed is not None
    assert parsed.params["code"] == 'if (a < b) { return "</weird>"; }'


def test_parse_tool_call_missing_tool_name_returns_none() -> None:
    text = (
        CMD_TOOL_CALL_OPEN_TAG
        + '\n<cmd:param name="x">y</cmd:param>\n'
        + CMD_TOOL_CALL_CLOSE_TAG
    )
    assert parse_tool_call(text) is None


def test_parse_tool_call_not_unfenced_format_returns_none() -> None:
    assert parse_tool_call("some text with no tool call tags at all") is None


# --------------------------------------------------------------------------- #
# find_all_tool_calls
# --------------------------------------------------------------------------- #


def test_find_all_tool_calls_zero() -> None:
    assert find_all_tool_calls("no tool calls in this text") == []


def test_find_all_tool_calls_one() -> None:
    call = make_call("foo")
    assert find_all_tool_calls(f"some preamble\n{call}\nsome epilogue") == [call]


def test_find_all_tool_calls_three() -> None:
    calls = [make_call("a"), make_call("b"), make_call("c")]
    text = "\n\nbetween\n\n".join(calls)
    assert find_all_tool_calls(text) == calls


# --------------------------------------------------------------------------- #
# find_wait_marker
# --------------------------------------------------------------------------- #


def test_find_wait_marker_present() -> None:
    text = f"some text {CMD_WAIT_TOOL_RESULT_TAG} more text"
    assert find_wait_marker(text) == text.index(CMD_WAIT_TOOL_RESULT_TAG)


def test_find_wait_marker_absent() -> None:
    assert find_wait_marker("no marker here") == -1


# --------------------------------------------------------------------------- #
# wait_marker_prefix_length
# --------------------------------------------------------------------------- #


def test_wait_marker_prefix_length_for_every_proper_prefix() -> None:
    marker = CMD_WAIT_TOOL_RESULT_TAG
    # Length 0 (empty text) through len(marker) - 1 (every proper prefix).
    for length in range(len(marker)):
        text = marker[:length]
        assert wait_marker_prefix_length(text) == length, f"failed for length={length}"


def test_wait_marker_prefix_length_with_preceding_text() -> None:
    marker = CMD_WAIT_TOOL_RESULT_TAG
    for length in range(1, len(marker)):
        text = "some streamed tokens " + marker[:length]
        assert wait_marker_prefix_length(text) == length


def test_wait_marker_prefix_length_full_marker_is_not_a_proper_prefix() -> None:
    # The full marker itself is not a *proper* prefix of itself, and this
    # function is only meant to catch an in-progress (incomplete) tail.
    assert wait_marker_prefix_length(CMD_WAIT_TOOL_RESULT_TAG) == 0


def test_wait_marker_prefix_length_non_prefix_case() -> None:
    assert wait_marker_prefix_length("hello world") == 0
    # Ends in text that occurs inside the marker but is not a prefix of it.
    assert wait_marker_prefix_length("some text cmd:") == 0


def test_wait_marker_prefix_length_empty_text() -> None:
    assert wait_marker_prefix_length("") == 0


# --------------------------------------------------------------------------- #
# append_wait_marker_after_last_tool_call
# --------------------------------------------------------------------------- #


def test_append_wait_marker_zero_calls_returns_unchanged() -> None:
    text = "plain assistant text, no tool calls"
    assert append_wait_marker_after_last_tool_call(text) == text


def test_append_wait_marker_one_call() -> None:
    call = make_call("foo")
    result = append_wait_marker_after_last_tool_call(call)
    assert result == call + "\n" + CMD_WAIT_TOOL_RESULT_TAG


def test_append_wait_marker_two_calls_inserts_after_last_only() -> None:
    first = make_call("a")
    second = make_call("b")
    text = f"{first}\ntext between\n{second}"
    result = append_wait_marker_after_last_tool_call(text)
    assert result == text + "\n" + CMD_WAIT_TOOL_RESULT_TAG
    # The marker must not have been inserted after the first call.
    assert first + "\n" + CMD_WAIT_TOOL_RESULT_TAG not in result
