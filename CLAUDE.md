I want you to plan a vscode extension.

# What is the extension about?

Any file with extension .chat.md

is used as chat interface with an LLM

# Theory

The file is a view of MessageParam data structure which is the chat conversation history with role user or assistant and content a list of text type or image type.

# States

The extension doesn't have any long term state, it only has configuration which is part of vscode settings

At any given point of time there's a listener running that listens to keystrokes, and decides to call an LLM for streaming or not.

At any given of point of time there are one or more streamers running.

A "streamer" is a thread that's streaming from LLM a set of tokens at a time.

# .chat.md parsing

# %% user
Hi
# %% assistant
hello

# %% line is treated as describing a role and starting a text block.

In user block a md like relative url is resolved for text or image file.

All text and image files are parsed as attachment of user message at the beginning of the user turn with file paths introduced in one of two formats:

1. Using the "Attached file at" syntax:
Attached file at /Users/arusia/test.ts
```
// content
```
Attached file at /Users/arusia/image.png
[image content]

2. Using Markdown-style links with #file tag:
[#file](test.py)
[#file](/absolute/path/to/image.png)

Both relative and absolute paths are supported in either format. Home directory paths using tilde (~) are also supported.

# When to trigger streaming

If the file ends with an empty assistant block # %% assistant\s* without case match the streaming starts

# How to stream idempotentically

At each loop step of the streamer there are a list of tokens received.

The history of tokens of current streamer (a single turn) is also saved in the streamer.

The past text is searched for in the last non-empty assistant block and if found the new tokens are appended regardless of presence of any subsequent text.

If no such text is found (say user deleted), the streamer should abort and cancelled. The streamer's data deleted.

# Locks

A lock on the file is shared between streamer and the listener, only is allowed to run at a time.

# Configuration

Anthropic api and openai api (with custom url) are supported.
