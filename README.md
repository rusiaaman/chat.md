# Chat Markdown

Chat Markdown is a Visual Studio Code extension that enables you to interact with Large Language Models (LLMs) directly in markdown files. Have conversations with models like Claude (Anthropic) and GPT (OpenAI) right within your text editor.

## Features

### 🗣️ Interactive Chat Interface
- Use `.chat.md` files with a simple format to structure conversations
- Sections start with `#%% user` or `#%% assistant` to define roles
- Supports streaming responses from the AI model
- Auto-scrolls to keep new content visible

### 🔌 Multi-Provider Support
- Works with Anthropic (Claude) models
- Works with OpenAI models (including GPT-4, GPT-3.5)
- Supports custom OpenAI-compatible APIs (like Azure OpenAI, Google Gemini)

### 📎 File Attachments
- Attach both text files and images to your messages
- Two syntax options:
  1. Traditional: `Attached file at /path/to/file`
  2. Markdown-style: `[#file](path/to/file)`
- Handles both relative and absolute paths

### 🛠️ Tool Calling
- Integrates with Model Context Protocol (MCP) tools
- Allows AI to execute external tools using a standardized XML format
- Supports dynamic registration of tool servers
- Handles tool results with proper formatting and linking

## Getting Started

1. Install the extension from the VS Code marketplace
2. Configure your API key(s):
   - Command Palette → "Configure Chat Markdown API Key"
3. Create a new chat file:
   - Command Palette → "New Chat Markdown"
   - Or create a file with the `.chat.md` extension
4. Start your conversation:
   ```
   #%% user
   Hello, can you help me with a coding question?

   #%% assistant
   
   ```
5. When you add an empty `#%% assistant` line, the AI will automatically start generating a response

## Configuration

Access these settings through VS Code's settings UI or settings.json:

- `filechat.provider`: AI provider to use ("anthropic" or "openai")
- `filechat.apiKey`: API key for the selected provider
- `filechat.model_name`: Specific model to use (optional)
- `filechat.base_url`: Custom API endpoint for OpenAI-compatible APIs (optional)
- `filechat.mcpServers`: Configuration for MCP tool servers (advanced)

## Chat File Format

Each `.chat.md` file consists of alternating user and assistant blocks:

```
#%% user
Your question or prompt goes here.
You can include multiple paragraphs.

[#file](path/to/file.js)

#%% assistant
The AI response appears here.
It can include code blocks, explanations, etc.

#%% user
Your follow-up question...

#%% assistant

```

## License

This extension is licensed under the MIT License. See the LICENSE file for details.

## Feedback & Contributions

- File issues on the GitHub repository
- Contributions are welcome via pull requests
