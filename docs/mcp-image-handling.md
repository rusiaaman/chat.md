# MCP Tool Image Output Handling

This document describes how filechat handles image outputs from MCP tools.

## Overview

MCP (Model Context Protocol) tools can return both text and image content. When a tool returns image content, it's typically in the form of a base64-encoded string with a specified MIME type.

Filechat properly handles these image outputs by:
1. Detecting image content in tool results
2. Saving images to the `cmdassets` directory
3. Converting them to Markdown image links that are displayed in the chat
4. Sequentially numbering multiple images when they appear in a single result
5. Preserving text and image ordering in mixed-content results

## Implementation Details

### Image Output Detection

When a tool returns results, the `mcpClient.ts` file examines the content array to see if it contains any items with `type === "image"`. If it finds any image items, it triggers the mixed content processing workflow.

### Image Processing and Storage

Images are processed by the `processMixedToolResult` method in `mcpClient.ts`. For each image item:

1. The base64-encoded image data is decoded into a buffer
2. A unique filename is generated using a timestamp and random string
3. The image is saved to the `cmdassets` directory adjacent to the current chat file
   - If the document context is unavailable, falls back to `samples/cmdassets` in the extension root
4. A Markdown image link is created pointing to the saved image

### Inserting Images into the Chat

The `insertToolResult` method in `listener.ts` has been enhanced to recognize when tool results contain image Markdown links. When detected, it ensures these links are inserted into the document without code fences, allowing the images to be displayed properly in the chat.

## How to Use

When an MCP tool returns image content, it will automatically be processed and displayed in the chat. No additional user action is required.

### Multiple Images

When multiple images are returned by a tool:
- Each image is automatically numbered in its alt text (e.g., "Tool generated image 1", "Tool generated image 2")
- The original sequence of text and images from the tool response is preserved
- Proper spacing is maintained for optimal readability

## Supported Image Formats

The following image formats are supported:
- PNG (image/png)
- JPEG (image/jpeg, image/jpg)
- GIF (image/gif)
- WebP (image/webp)

For other formats, the extension will default to saving with a .png extension.

## Example MCP Tool Response

A tool can return multiple content items, mixing text and images:

```json
{
  "content": [
    { "type": "text", "text": "Here's the first generated image:" },
    { 
      "type": "image", 
      "data": "base64encodeddata...", 
      "mimeType": "image/png" 
    },
    { "type": "text", "text": "And here's another image showing a different view:" },
    {
      "type": "image",
      "data": "morebase64data...",
      "mimeType": "image/jpeg"
    },
    { "type": "text", "text": "Analysis of both images..." }
  ]
}
```

This will be rendered in the chat as:

```
Here's the first generated image:

![Tool generated image 1](cmdassets/tool-image-20240409-123456-abc123.png)

And here's another image showing a different view:

![Tool generated image 2](cmdassets/tool-image-20240409-123457-def456.jpg)

Analysis of both images...
```

The extension ensures proper spacing and sequencing between text and images while maintaining markdown compatibility.

## Implementation Notes

- Images are saved with unique filenames based on timestamps and random strings
- Multiple images in a single response are numbered sequentially
- Text formatting is preserved when possible
- The entire response maintains its original sequence
