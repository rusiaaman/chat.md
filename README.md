# chat.md: The Hacker's AI Chat Interface [Experimental]

**Finally, a fully editable chat interface with MCP support on any LLM.**

chat.md is a Visual Studio Code extension that reimagines AI interaction through plain text files. Unlike ephemeral web interfaces or proprietary chat windows, chat.md embraces a file-first approach where your conversations with AI are just markdown files with a `.chat.md` extension. Edit them, version control them, share them - they're your files. The AI directly writes its response in the file.

Any '*.chat.md' file is now an AI agent hackable by you. Go crazy with non linear AI conversation.

<img width="1005" alt="image" src="https://github.com/user-attachments/assets/67983da2-6046-4ba8-bc8c-16944a5476fd" />

[Usage video](https://www.youtube.com/watch?v=DyYoZLmpzc0)

[Here's the chat I used to publish this vscode extension using gemini-2.5-pro and wcgw mcp](samples/publishing-help/chat.chat.md)

NOTE ⚠️: chat.md is 100% AI coded and should be treated as a feature rich POC.

## Why chat.md?

| Other AI Tools | chat.md |
|----------------|---------|
| ❌ Linear conversations or limited editing | ✅ Non-linear editing - rewrite history, branch conversations |
| ❌ Tool execution tied to proprietary implementations | ✅ Any LLM model can do tool calling |
| ❌ Can't manually edit AI responses | ✅ Put words in LLM's mouth - edit and have it continue from there |
| ❌ MCP not supported in many LLMs | ✅ Any LLM model can use MCP servers |
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
### Quick start
1. Install 'chat.md' from the VS Code marketplace
2. Configure your API key(s):
   - Command Palette → "Add or Edit API Configuration"
3. Create a new chat:
   - `Opt+Cmd+'` (Mac) / `Ctrl+k Ctrl+c` (Windows/Linux) to create a new '.chat.md' file with workspace information populated in a user block.
   - Or create any file with the `.chat.md` extension anywhere and open it in vscode.
4. In a '# %% user' block write your query and press 'Shift + Enter' (or just create a new '# %% assistant' block and press enter)
5. Watch the assistant stream its response and do any tool call.

Optionally you can start a markdown preview side by side to get live markdown preview of the chat which is more user friendly.
### Usage info
- You can insert a `# %% system` block to append any new instructions to the system prompt.
- You can manually add API configuration and MCP configuration in vscode settings. See [example settings](#example-vscode-settings)
- Click on the live status bar "Chat.md streaming" icon in the bottom or run "chat.md: Cancel streaming" command to interrupt
- You can also use the same shortcut "Opt+Cmd+'" to cancel streaming as for creating a new chat.
- You can run command "Refresh MCP Tools" to reload all mcp servers. Then run "MCP Diagnostics" to see available mcp servers.
- You can use "Select api configuration" command to switch between the API providers


## Configuration

Access these settings through VS Code's settings UI or settings.json:

- `chatmd.apiConfigs`: Named API configurations (provider, API key, model, base URL)
- `chatmd.selectedConfig`: Active API configuration
- `chatmd.mcpServers`: Configure MCP tool servers
- `chatmd.reasoningEffort`: Control reasoning depth (minimal, low, medium, high)

### Tool Execution

When an AI response includes a tool call, the extension will automatically:

1. Add a tool_execute block after the assistant's response
2. Execute the tool with the specified parameters
3. Insert the tool's result back into the document
4. Add a new assistant block for the AI to continue

You can also trigger tool execution manually by:
- Pressing Shift+Enter while positioned at the end of an assistant response containing a tool call
- This will insert a tool_execute block and execute the tool

## Keyboard Shortcuts

- `Shift+Enter`: Insert next block (alternates between user/assistant) or inserts a tool_execute block if the cursor is at the end of an assistant block containing a tool call
- `Opt+Cmd+'` (Mac) / `Ctrl+k Ctrl+c'` (Windows/Linux): Create new context chat or cancel existing streaming

## MCP Tool Integration

Connect any Model Context Protocol server to extend AI capabilities:

### Local MCP Servers (stdio)

For local MCP servers running in the same environment as VS Code:

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

### Remote MCP Servers (SSE)

For remote MCP servers accessible via HTTP/Server-Sent Events:

```json
"chatmd.mcpServers": {
  "remote-mcp": {
    "url": "http://localhost:3000/sse"
  }
}
```

You can also add environment variables if needed:

```json
"chatmd.mcpServers": {
  "remote-mcp": {
    "url": "http://localhost:3000/sse",
    "env": {
      "API_KEY": "your-api-key-here"
    }
  }
}
```

The AI will automatically discover available tools from both local and remote servers and know how to use them! Tool lists are refreshed automatically every 5 seconds to keep them up-to-date.

## The Philosophy

chat.md breaks away from the artificial "chat" paradigm and acknowledges that AI interaction is fundamentally about text processing. By treating conversations as files:

1. **Persistence becomes trivial** - no special cloud sync or proprietary formats
2. **Collaboration is built-in** - share, diff, and merge like any other code
3. **Version control is natural** - track changes over time
4. **Customization is unlimited** - edit the file however you want

## Limitations
1. MCP -- only tools supported, prompts and resources will be supported in the future.
2. Caching not yet supported in anthropic api.
3. Gemini, ollama, llm studio and other models have to be accessed using openai-api only.

## Example vscode settings

vscode json settings
```json
  "chatmd.apiConfigs": {
    "gemini-2.5pro": {
      "type": "openai",
      "apiKey": "",
      "base_url": "https://generativelanguage.googleapis.com/v1beta/openai/",
      "model_name": "gemini-2.5-pro-exp-03-25"
    },
    "anthropic-sonnet-3-7": {
      "type": "anthropic",
      "apiKey": "sk-ant-",
      "base_url": "",
      "model_name": "claude-3-7-sonnet-latest"
    },
    "openrouter-qasar": {
      "type": "openai",
      "apiKey": "sk-or-",
      "base_url": "https://openrouter.ai/api/v1",
      "model_name": "openrouter/quasar-alpha"
    },
    "groq-llam4": {
      "type": "openai",
      "apiKey": "",
      "base_url": "https://api.groq.com/openai/v1",
      "model_name": "meta-llama/llama-4-scout-17b-16e-instruct"
    },
    "together-llama4": {
      "type": "openai",
      "base_url": "https://api.together.xyz/v1",
      "apiKey": "",
      "model_name": "meta-llama/Llama-4-Maverick-17B-128E-Instruct-FP8"
    }
  },
  "chatmd.mcpServers": {
    
    "wcgw": {
      "command": "/opt/homebrew/bin/uv",
      "args": [
        "tool",
        "run",
        "--python",
        "3.12",
        "--from",
        "wcgw@latest",
        "wcgw_mcp"
      ]
    },
    "brave-search": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-brave-search"],
      "env": {
        "BRAVE_API_KEY": ""
      }
    },
    "fetch": {
      "command": "/opt/homebrew/bin/uvx",
      "args": ["mcp-server-fetch"]
    }
  },
  "chatmd.selectedConfig": "gemini-2.5pro",
  "chatmd.maxTokens": 8000,
  "chatmd.maxThinkingTokens": 16000,
  "chatmd.reasoningEffort": "medium"
```

Note: `maxTokens` (default: 8000) controls the maximum number of tokens for model responses.
For OpenAI reasoning models (GPT-5, o3, o1 series), `maxTokens` is used as the total `max_completion_tokens` budget (includes both thinking and response tokens).
For Anthropic models, `maxThinkingTokens` controls the thinking token budget separately, or can be calculated automatically from `reasoningEffort`.
## License

MIT License - see the LICENSE file for details.

## Feedback & Contributions

- File issues on the GitHub repository
- Contributions welcome via pull requests

## Credits
- Claude with wcgw mcp
- Gemini 2.5 pro with chat.md
