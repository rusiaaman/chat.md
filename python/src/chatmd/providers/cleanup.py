"""Message cleanup performed immediately before an API call.

A port of ``src/utils/messageCleanup.ts``. Modelled on provider-specific message
cleanup that real chat.md deployments need before requests are sent.

Invariants:
 - the number of messages never changes (a message emptied by cleanup gets a
   "[continuing]" text block instead of being dropped)
 - at most one thinking block survives per assistant message, and it is moved to
   the front of the content
 - thinking produced by a different model, or a payload that the target API
   cannot replay, is dropped (the payload only; the text may survive as raw)

Kept free of vscode/extension-equivalent imports so it can be tested standalone.
"""

from __future__ import annotations

from collections.abc import Sequence

from ..types import ApiStyle, Content, MessageParam, TextContent, ThinkingContent

CONTINUING_PLACEHOLDER = "[continuing]"


def payload_usable_for_api(block: ThinkingContent, api_style: ApiStyle) -> bool:
    """A payload can only be replayed to the API family that produced it.

    On a mismatch (for instance the same model switched from the Responses API to
    chat completions) the payload is dropped and the block degrades to raw text.
    """
    kind = block.payload.kind if block.payload else None
    if not kind or kind == "raw":
        return False
    if api_style == "anthropic":
        return kind in ("anthropic_signature", "anthropic_redacted")
    if api_style == "openai_responses":
        return kind == "openai_encrypted"
    return kind == "reasoning_details"  # openai_chat


def thinking_matches_model(block: ThinkingContent, model_name: str) -> bool:
    """Thinking from another model must not be replayed.

    A block with no model attribution (hand written, or written before this
    feature existed) is kept as raw text.
    """
    if not block.model:
        return True
    return block.model == model_name


def _strip_trailing_whitespace(blocks: list[Content]) -> list[Content]:
    """Trailing whitespace in the final assistant text block breaks the Anthropic API."""
    result = list(blocks)
    for i in range(len(result) - 1, -1, -1):
        block = result[i]
        if not isinstance(block, TextContent):
            break
        trimmed = block.value.rstrip()
        if trimmed == "":
            del result[i]
            continue
        result[i] = TextContent(value=trimmed)
        break
    return result


def clean_messages_for_api(
    messages: Sequence[MessageParam],
    *,
    model_name: str,
    thinking_enabled: bool,
    api_style: ApiStyle,
) -> list[MessageParam]:
    """Normalise thinking blocks and drop blank text, without changing message count."""
    cleaned: list[MessageParam] = []
    for message in messages:
        blocks: list[Content] = [
            block
            for block in message.content
            if not (isinstance(block, TextContent) and block.value.strip() == "")
        ]

        thinking_blocks = [b for b in blocks if isinstance(b, ThinkingContent)]

        if thinking_blocks:
            # Thinking only belongs to assistant turns
            if message.role != "assistant" or not thinking_enabled:
                blocks = [b for b in blocks if not isinstance(b, ThinkingContent)]
            else:
                candidates = [
                    b for b in thinking_blocks if thinking_matches_model(b, model_name)
                ]

                # Find the first thinking block with non-empty opaque/encrypted content
                with_opaque = next(
                    (
                        b
                        for b in candidates
                        if b.payload and payload_usable_for_api(b, api_style)
                    ),
                    None,
                )

                others: list[Content] = [
                    b for b in blocks if not isinstance(b, ThinkingContent)
                ]

                if with_opaque is not None:
                    # Opaque content exists - text is irrelevant, set it to empty string
                    normalised = ThinkingContent(
                        value="",
                        model=with_opaque.model,
                        hash=with_opaque.hash,
                        payload=with_opaque.payload,
                    )
                    blocks = [normalised, *others]
                else:
                    # No opaque content - use the first thinking block as raw text
                    first = candidates[0] if candidates else None
                    if first is not None and first.value.strip() != "":
                        normalised = ThinkingContent(value=first.value, model=first.model)
                        blocks = [normalised, *others]
                    else:
                        blocks = others

        if message.role == "assistant":
            blocks = _strip_trailing_whitespace(blocks)

        if not blocks:
            blocks = [TextContent(value=CONTINUING_PLACEHOLDER)]

        cleaned.append(MessageParam(role=message.role, content=blocks))

    return cleaned
