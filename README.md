# chat.md: The engineer's AI Conversation Interface

**Finally, a fully editable chat interface with MCP support on any LLM.**

chat.md is a Visual Studio Code extension that reimagines AI interaction through plain text files. Unlike ephemeral web interfaces or proprietary chat windows, chat.md embraces a file-first approach where your conversations with AI are just markdown files with a `.chat.md` extension. Edit them, version control them, share them - they're your files.

Any '*.chat.md' file is now an AI agent hackable by you.

<img width="1005" alt="image" src="https://github.com/user-attachments/assets/67983da2-6046-4ba8-bc8c-16944a5476fd" />

## Why chat.md?

| Other AI Tools | chat.md |
|----------------|---------|
| ❌ Linear conversations or limited editing | ✅ Non-linear editing - rewrite history, branch conversations |
| ❌ Tool execution tied to proprietary implementations | ✅ Any LLM model can do tool calling |
| ❌ MCP not supported in many LLMs | ✅ Any LLM model can use MCP servers |
| ❌ Can't manually edit AI responses | ✅ Put words in LLM's mouth - edit and have it continue from there |
| ❌ Max token limit for assistant response can't be resumed | ✅ Resume incomplete AI responses at any point |
| ❌ Conversations live in the cloud or inaccessible | ✅ Files stored locally alongside your code in human readable format |
| ❌ Separate context from your workspace | ✅ Attach files directly from your project |

## Features

### 🗣️ File-Based Conversations

Unlike Copilot's inline suggestions, ChatGPT's web interface, or Cursor's side panel, chat.md treats conversations as *first-class files* in your workspace:

```markdown
# %% user
How can I optimize this function?

[#file](src/utils.js)

# %% assistant
Looking at your utils.js file, I see several opportunities for optimization:

1. The loop on line 24 could be replaced with a more efficient map/reduce pattern
2. The repetitive string concatenation can be improved with template literals
...
```

### 🔌 Universal Model Support

- **Anthropic Claude**: All models (Opus, Sonnet, Haiku)
- **OpenAI**: GPT-4, GPT-3.5, and future models
- **Custom APIs**: Any OpenAI-compatible endpoint (Azure, Google Gemini, etc.)
- **Quick Switching**: Toggle between different models in between a conversation.

### 🛠️ Universal Tool Ecosystem with MCP

Chat.md is a **Model Context Protocol (MCP)**  client  - an open standard for tool execution that works with any LLM.

Chat.md doesn't restrict any LLM from tool calling unlike many chat applications.

- **Truly Universal**: Any AI model (Claude, GPT, open-source models) can use any MCP tool
- **Model Agnostic**: Tools work identically regardless of which AI powers your conversation
- **No Vendor Lock-in**: Switch models without losing tool functionality

```
<tool_call>
<tool_name>filesystem.searchFiles</tool_name>
<param name="pattern">*.js</param>
<param name="directory">src</param>
</tool_call>
```

### 📎 Contextual File Attachments

- Attach text files and images directly in your conversations (paste any copied image)
- Link files using familiar markdown syntax: `[file](path/to/file)`
- Files are resolved relative to the chat document - perfect for project context (or use absolute paths)

### 💾 Editable Conversations

Since chat.md files are just text, you have complete control over your AI interactions:

- **Non-linear Editing**: Rewrite history by editing earlier parts of the conversation
- **Conversation Hacking**: Put words in the AI's mouth by editing its responses
- **Continuation Control**: Have the AI continue from any edited point
- **Resume Truncated Outputs**: If an AI response gets cut off, just add a new assistant block and continue
- **Git-Friendly**: Track conversation changes, collaborate on prompts, and branch conversations
- **Conversation Templates**: Create reusable conversation starters for common tasks

## Getting Started

1. Install 'chat.md' from the VS Code marketplace
2. Configure your API key(s):
   - Command Palette → "Add or Edit API Configuration"
3. Create a new chat:
   - `Opt+Cmd+'` (Mac) / `Alt+Ctrl+'` (Windows/Linux) to create a new '.chat.md' file with workspace information populated in a user block.
   - Or create any file with the `.chat.md` extension anywhere and open it in vscode.
4. In a '# %% user' block write your query and press 'Shift + Enter' (or just create a new '# %% assistant' block and press enter)
5. Watch the assistant stream its response and do any tool call.

Optionally you can start a markdown preview side by side to get live markdown preview of the chat which is more user friendly.

## Configuration

Access these settings through VS Code's settings UI or settings.json:

- `chatmd.apiConfigs`: Named API configurations (provider, API key, model, base URL)
- `chatmd.selectedConfig`: Active API configuration
- `chatmd.mcpServers`: Configure MCP tool servers

## Keyboard Shortcuts

- `Shift+Enter`: Insert next block (alternates between user/assistant)
- `Opt+Cmd+'` (Mac) / `Alt+Ctrl+'` (Windows/Linux): Create new context chat or cancel existing streaming

## MCP Tool Integration

Connect any Model Context Protocol server to extend AI capabilities:

```json
"chatmd.mcpServers": {
  "wcgw": {
    "command": "uvx",
    "args": [
      "--python",
      "3.12",
      "--from",
      "wcgw@latest",
      "wcgw_mcp"
    ]
  }
}
```

The AI will automatically discover available tools and know how to use them!

## The Philosophy

chat.md breaks away from the artificial "chat" paradigm and acknowledges that AI interaction is fundamentally about text processing. By treating conversations as files:

1. **Persistence becomes trivial** - no special cloud sync or proprietary formats
2. **Collaboration is built-in** - share, diff, and merge like any other code
3. **Version control is natural** - track changes over time
4. **Customization is unlimited** - edit the file however you want

## Limitations
1. MCP -- only tools supported, prompts and resources will be supported in the future.
2. Caching not yet supported in anthropic api.
3. Gemini, ollama, llm studio and other moels have to be accessed using openai-api only.

## License

MIT License - see the LICENSE file for details.

## Feedback & Contributions

- File issues on the GitHub repository
- Contributions welcome via pull requests
