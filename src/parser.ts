import { MessageParam, Content, Role } from './types';
import { log } from './extension';
import { isImageFile, resolveFilePath, readFileAsText, fileExists } from './utils/fileUtils';
import * as vscode from 'vscode';

/**
 * Parses a .chat.md file into structured messages
 * Returns a readonly array to prevent mutations
 * 
 * Note: Will exclude the last empty assistant block (used for triggering streaming)
 */
export function parseDocument(text: string, document?: vscode.TextDocument): readonly MessageParam[] {
  const messages: MessageParam[] = [];
  
  // Regex to split document on #%% markers - fixing the pattern to properly match all cases
  // We need to keep the original pattern that works, not the modified one that's causing issues
  const regex = /^#%% (user|assistant)\s*$/im;
  const blocks = text.split(regex);
  
  // Debug logging
  log(`Split document into ${blocks.length} blocks`);
  for (let i = 0; i < Math.min(blocks.length, 10); i++) {
    log(`Block ${i}: "${blocks[i].substring(0, 20).replace(/\n/g, '\\n')}${blocks[i].length > 20 ? '...' : ''}"`);
  }
  
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
      const parsedContent = parseUserContent(content, document);
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
function parseUserContent(text: string, document?: vscode.TextDocument): Content[] {
  const content: Content[] = [];
  
  // Original format: "Attached file at /path/to/file"
  const fileAttachmentRegex = /^Attached file at ([^\n]+)\n(?:```[^\n]*\n([\s\S]*?)```|\[image content\])/gm;
  
  // New format: Markdown-style links like [#file](test.py)
  const markdownLinkRegex = /\[#file\]\(([^)]+)\)/g;
  
  // Process any direct Markdown-style links first
  if (document) {
    const mdMatches: {index: number, path: string, isImage: boolean, content?: string}[] = [];
    let mdMatch;
    
    // First pass - collect all matches and resolve paths
    while ((mdMatch = markdownLinkRegex.exec(text)) !== null) {
      const filePath = mdMatch[1];
      const resolvedPath = resolveFilePath(filePath, document);
      const isImage = isImageFile(filePath);
      
      // For text files, read the content
      let fileContent;
      if (!isImage && fileExists(resolvedPath)) {
        fileContent = readFileAsText(resolvedPath);
      }
      
      mdMatches.push({
        index: mdMatch.index,
        path: filePath,
        isImage,
        content: fileContent
      });
    }
    
    // Sort matches in reverse order to avoid index shifts during replacement
    mdMatches.sort((a, b) => b.index - a.index);
    
    // Replace each match with the formatted content
    for (const match of mdMatches) {
      const replacement = match.isImage 
        ? `Attached file at ${match.path}\n[image content]`
        : `Attached file at ${match.path}\n\`\`\`\n${match.content || 'Unable to read file content'}\n\`\`\``;
        
      text = text.substring(0, match.index) + replacement + text.substring(match.index + `[#file](${match.path})`.length);
    }
  }
  
  let lastIndex = 0;
  let match;
  
  // Process original format first
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
  
  // Reset for processing Markdown-style links
  text = text.substring(0, lastIndex) + text.substring(lastIndex).replace(markdownLinkRegex, (match, filePath) => {
    log(`Found Markdown-style file link: ${filePath}`);
    
    // Determine if it's an image file based on extension
    if (filePath.endsWith('.png') || filePath.endsWith('.jpg') || filePath.endsWith('.jpeg') || 
        filePath.endsWith('.gif') || filePath.endsWith('.webp')) {
      // Convert to the format specified in CLAUDE.md for images
      return `\nAttached file at ${filePath}\n[image content]`;
    } else {
      // For text files, placeholder - actual content will be loaded when resolving paths
      return `\nAttached file at ${filePath}\n\`\`\`\nFile content will be loaded\n\`\`\``;
    }
  });
  
  // Process the updated text with any converted Markdown links
  lastIndex = 0;
  const updatedFileRegex = /^Attached file at ([^\n]+)\n(?:```[^\n]*\n([\s\S]*?)```|\[image content\])/gm;
  
  while ((match = updatedFileRegex.exec(text)) !== null) {
    // Skip matches that were already processed in the first pass
    if (match.index < lastIndex) continue;
    
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
  // Parse the document into blocks to properly identify the last one
  const lines = text.split('\n');
  let lastRole = '';
  let isEmptyBlock = false;
  
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line.toLowerCase().startsWith('#%% ')) {
      const role = line.substring(4).trim().toLowerCase();
      
      // If we just saw an assistant block and it was empty, record that
      if (lastRole === 'assistant' && isEmptyBlock) {
        log(`Found empty assistant block at line ${i-1}`);
      }
      
      lastRole = role;
      isEmptyBlock = true; // Start with assumption this block is empty
    } else if (line !== '') {
      // Non-empty content means the current block is not empty
      isEmptyBlock = false;
    }
  }
  
  // If the last block was an assistant block and it was empty, return true
  const isEmpty = (lastRole === 'assistant' && isEmptyBlock);
  log(`Last role block: ${lastRole}, isEmpty: ${isEmpty}`);
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

/**
 * Finds all assistant blocks with their content start positions
 * Used for more precise token insertion
 */
export function findAllAssistantBlocks(text: string): {markerStart: number, contentStart: number}[] {
  const blocks: {markerStart: number, contentStart: number}[] = [];
  const lines = text.split('\n');
  let lineOffset = 0;
  
  for (let i = 0; i < lines.length; i++) {
    if (/^#%% assistant\s*$/i.test(lines[i])) {
      // Found an assistant block
      const markerStart = lineOffset;
      
      // Calculate the content start (after the marker line)
      let contentStart = lineOffset + lines[i].length;
      
      // Skip any whitespace after the marker
      while (contentStart < text.length && 
             (text[contentStart] === ' ' || text[contentStart] === '\t')) {
        contentStart++;
      }
      
      // Skip newline if present
      if (contentStart < text.length && text[contentStart] === '\n') {
        contentStart++;
      }
      
      blocks.push({markerStart, contentStart});
    }
    
    lineOffset += lines[i].length + 1; // +1 for the newline
  }
  
  return blocks;
}