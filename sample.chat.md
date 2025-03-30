#%% user
Hello, I'd like to learn about how to use this chat interface.

#%% assistant
Hello! I'd be happy to help you learn about using this chat interface.

This is a specialized Markdown file (with .chat.md extension) that acts as an interactive interface with an AI assistant.

Here's how to use it:

1. User sections start with `#%% user` and contain your messages
2. Assistant sections start with `#%% assistant` and contain AI responses
3. To get a response, just add a new `#%% assistant` line after your message
4. You can attach files or images to your messages

Is there anything specific you'd like to know about this interface?

#%% user
How do I attach files to my messages?

#%% assistant
To attach files to your messages, you can use this format:

```
#%% user
Attached file at /path/to/file.txt
```
followed by the file's content in a code block like:
```
file content here
```

For images, the format is:
```
#%% user
Attached file at /path/to/image.png
[image content]
```

The extension will automatically process these attachments when sending them to the AI.

Some important notes:
- The path can be absolute or relative to the current file
- For text files, the content is displayed in a code block
- For images, the placeholder "[image content]" is used
- Supported image formats include PNG, JPEG, GIF, and WebP

You can also include regular text before or after the attachments in your message.

#%% user
Can I have multiple files in one message?

#%% assistant
Yes, you can definitely include multiple files in a single message. Here's how you can format a message with multiple attachments:

```
#%% user
Here's my question about these files:

Attached file at /path/to/first_file.py
```python
def hello_world():
    print("Hello, world!")
```

Attached file at /path/to/image.png
[image content]

Attached file at /path/to/another_file.json
```json
{
  "name": "Example",
  "value": 42
}
```

Can you explain the relationship between these files?
```

The format for each attachment remains the same:
1. Start with "Attached file at" followed by the file path
2. For text files, include the content in a code block
3. For images, use the "[image content]" placeholder

You can mix text, code files, and images in any order within your message, and the assistant will process all of them together when generating a response.

#%% user
Is there a simpler way to attach files using Markdown-style links?

#%% assistant
Yes! There's a simpler way to attach files using Markdown-style links with the `#file` tag. Here's how it works:

```
#%% user
Here's my code file:

[#file](src/main.js)

And here's an image:

[#file](assets/diagram.png)
```

Benefits of using this format:
1. It's more concise than the "Attached file at" syntax
2. It uses familiar Markdown link syntax
3. It works with both relative and absolute paths
4. It supports the same file types (text and images)

The extension will automatically detect these links and convert them to the appropriate file attachments when sending them to the AI. Both formats are supported, so you can use whichever you prefer.
