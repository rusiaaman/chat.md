import { MessageParam, Content, Role } from './types';

/**
 * Parses a .chat.md file into structured messages
 * Returns a readonly array to prevent mutations
 * 
 * Note: Will exclude the last empty assistant block (used for triggering streaming)
 */
export function parseDocument(text: string): readonly MessageParam[] {
  const messages: MessageParam[] = [];
  const blocks = text.split(/^#%% (user|assistant)\s*$/im);
  
  // Skip first empty element if exists
  let startIdx = blocks[0].trim() === '' ? 1 : 0;
  
  // Check if the last block is an empty assistant block
  const hasEmptyLastAssistant = 
    blocks.length >= startIdx + 2 && 
    blocks[blocks.length - 2].toLowerCase().trim() === 'assistant' && 
    blocks[blocks.length - 1].trim() === '';
  
  // Determine endpoint for parsing (exclude empty last assistant block)
  const endIdx = hasEmptyLastAssistant ? blocks.length - 2 : blocks.length;
  
  for (let i = startIdx; i < endIdx; i += 2) {
    // If we have a role but no content block, skip
    if (i + 1 >= endIdx) {
      break;
    }
    
    const role = blocks[i].toLowerCase().trim() as Role;
    const content = blocks[i + 1].trim();
    
    // Skip empty assistant blocks entirely (they're just triggers)
    if (role === 'assistant' && content === '') {
      continue;
    }
    
    if (role === 'user') {
      // Only add user message if it has actual content
      const parsedContent = parseUserContent(content);
      if (parsedContent.length > 0) {
        messages.push({
          role,
          content: parsedContent
        });
      }
    } else if (role === 'assistant') {
      messages.push({
        role,
        content: [{ type: 'text', value: content }]
      });
    }
  }
  
  return Object.freeze(messages);
}

/**
 * Parses user content to extract text and file references
 */
function parseUserContent(text: string): Content[] {
  const content: Content[] = [];
  const fileAttachmentRegex = /^Attached file at ([^\n]+)\n(?:```[^\n]*\n([\s\S]*?)```|\[image content\])/gm;
  
  let lastIndex = 0;
  let match;
  
  while ((match = fileAttachmentRegex.exec(text)) !== null) {
    // Add text before the attachment
    const beforeText = text.substring(lastIndex, match.index).trim();
    if (beforeText) {
      content.push({ type: 'text', value: beforeText });
    }
    
    const path = match[1];
    if (path.endsWith('.png') || path.endsWith('.jpg') || path.endsWith('.jpeg') || 
        path.endsWith('.gif') || path.endsWith('.webp')) {
      content.push({ type: 'image', path });
    } else {
      // For non-image files, extract content from code block
      content.push({ type: 'text', value: match[2] || '' });
    }
    
    lastIndex = match.index + match[0].length;
  }
  
  // Add remaining text
  const remainingText = text.substring(lastIndex).trim();
  if (remainingText) {
    content.push({ type: 'text', value: remainingText });
  }
  
  // If no content was extracted, use the full text
  if (content.length === 0 && text.trim()) {
    content.push({ type: 'text', value: text });
  }
  
  return content;
}

/**
 * Checks if a document ends with an empty assistant block
 * Used to determine when to start streaming
 */
export function hasEmptyAssistantBlock(text: string): boolean {
  // Check for pattern of "#%% assistant" at the end with optional whitespace
  const emptyAssistantRegex = /#%% assistant\s*$/i;
  return emptyAssistantRegex.test(text.trim() + '\n');
}

/**
 * Gets all assistant block positions in a document
 * Used to find where to place streamed content
 */
export function findAssistantBlocks(text: string): {start: number, end: number}[] {
  const blocks: {start: number, end: number}[] = [];
  const regex = /^#%% assistant\s*$/im;
  
  let match;
  const lines = text.split('\n');
  
  for (let i = 0; i < lines.length; i++) {
    if (regex.test(lines[i])) {
      // Found an assistant block
      const start = lines.slice(0, i).join('\n').length + (i > 0 ? 1 : 0); // Add newline except for first line
      const end = start + lines[i].length;
      blocks.push({start, end});
    }
  }
  
  return blocks;
}