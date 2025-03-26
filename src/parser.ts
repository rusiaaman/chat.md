import { MessageParam, Content, Role } from './types';
import { log } from './extension';

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
  // Log the exact document text for debugging (truncated)
  const displayText = text.length > 100 ? text.substring(text.length - 100) : text;
  log(`Checking for empty assistant block in: "${displayText.replace(/\n/g, '\\n')}"`);
  
  // Look for "#%% assistant" near the end followed by no content
  // We'll be more lenient with this test to catch more cases
  const normalizedText = text.trim() + '\n';
  const lastBlockPos = normalizedText.lastIndexOf('#%% assistant');
  
  if (lastBlockPos === -1) {
    log('No assistant block found');
    return false;
  }
  
  // Check if there's any significant content after the last #%% assistant
  const textAfterBlock = normalizedText.substring(lastBlockPos + 13).trim();
  const isEmpty = textAfterBlock.length === 0;
  
  log(`Last assistant block at position ${lastBlockPos}, content after: "${textAfterBlock.substring(0, 20)}", isEmpty: ${isEmpty}`);
  return isEmpty;
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