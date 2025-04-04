import { log } from '../extension';

/**
 * Represents the structure of a parsed tool call
 */
export interface ParsedToolCall {
  name: string;
  params: Record<string, string>;
}

/**
 * Represents the results of checking for completed tool calls
 */
export type ToolCallCheckResult = 
  | { isComplete: false }
  | { isComplete: true, endIndex: number };

/**
 * Types of code fencing in tool calls
 */
export enum ToolCallFormatType {
  PROPERLY_FENCED = 'properly-fenced',
  PARTIALLY_FENCED = 'partially-fenced',
  NON_FENCED = 'non-fenced',
  UNKNOWN = 'unknown'
}

/**
 * Extracts XML content from a fenced or non-fenced tool call
 * @param toolCallXml The raw tool call XML string
 * @returns The extracted XML content with fencing removed
 */
export function extractXmlContent(toolCallXml: string): string {
  // First check if the input directly starts with <tool_call>
  const directToolCallMatch = /^\s*<tool_call>/.test(toolCallXml);
  if (directToolCallMatch) {
    log(`Tool call format: ${ToolCallFormatType.NON_FENCED} (direct)`);
    return toolCallXml;
  }
  
  // Check if the tool call has a proper opening and closing fence
  // Support any language annotation such as xml, tool_call, tool_code, etc.
  const properFenceMatch = /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)([\s\S]*?)\n\s*```/s.exec(toolCallXml);
  
  // If not, check if it has just an opening fence (partially fenced)
  const partialFenceMatch = !properFenceMatch ? /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)([\s\S]*?)$/s.exec(toolCallXml) : null;
  
  // Extract the actual XML content based on the fence status
  const xmlContent = properFenceMatch ? properFenceMatch[1] : 
                    partialFenceMatch ? partialFenceMatch[1] : 
                    toolCallXml;
  
  // Log the detected format for debugging
  const formatType = properFenceMatch ? ToolCallFormatType.PROPERLY_FENCED : 
                     partialFenceMatch ? ToolCallFormatType.PARTIALLY_FENCED : 
                     ToolCallFormatType.NON_FENCED;
  
  log(`Tool call format: ${formatType}`);
  
  return xmlContent;
}

/**
 * Preprocesses XML content with CDATA sections to handle special cases
 * This helps ensure that XML tags inside CDATA sections don't interfere with parsing
 * @param xml The XML content to preprocess
 * @returns The preprocessed XML
 */
export function preprocessXmlWithCdata(xml: string): string {
  const cdataSections: string[] = [];
  let index = 0;
  
  // Replace CDATA sections with placeholders
  const processedXml = xml.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/sg, (match, content) => {
    const placeholder = `__CDATA_PLACEHOLDER_${index}__`;
    cdataSections[index] = content;
    index++;
    return placeholder;
  });
  
  // No need to restore placeholders as we're just using this for tag matching
  // The actual CDATA content will be processed separately when parsing parameters
  
  return processedXml;
}

/**
 * Checks if CDATA tags are balanced in the given text
 * @param text The text to check for balanced CDATA tags
 * @returns True if CDATA tags are balanced, false otherwise
 */
export function areCdataTagsBalanced(text: string): boolean {
  // Track CDATA tag states by parsing character by character
  // This is more accurate than just counting tags as it respects nesting order
  let isInsideCdata = false;
  let i = 0;
  
  while (i < text.length) {
    if (!isInsideCdata) {
      // Look for opening CDATA tag when not inside CDATA
      if (i + 8 < text.length && text.substring(i, i + 9) === '<![CDATA[') {
        isInsideCdata = true;
        i += 9; // Skip the CDATA opening tag
      } else {
        i++; // Move to next character
      }
    } else {
      // Look for closing CDATA tag when inside CDATA
      if (i + 2 < text.length && text.substring(i, i + 3) === ']]>') {
        isInsideCdata = false;
        i += 3; // Skip the CDATA closing tag
      } else {
        i++; // Move to next character
      }
    }
  }
  
  // If we're still inside CDATA at the end, tags are not balanced
  if (isInsideCdata) {
    log('CDATA tags are not balanced: missing closing tag');
    return false;
  }
  
  return true;
}

/**
 * Checks if all parameter blocks have balanced CDATA tags
 * @param text The text containing parameter blocks
 * @returns True if all parameter blocks have balanced CDATA tags, false otherwise
 */
export function areParamsComplete(text: string): boolean {
  // Extract each param block and verify it's properly formed
  const paramBlocks: string[] = [];
  const paramRegex = /<param\s+name=["'](.*?)["']>([\s\S]*?)<\/param>/sg;
  let paramMatch;
  
  while ((paramMatch = paramRegex.exec(text)) !== null) {
    paramBlocks.push(paramMatch[0]);
  }
  
  // Check each param block for balanced CDATA tags using the improved checking logic
  for (const block of paramBlocks) {
    if (!areCdataTagsBalanced(block)) {
      log(`Param block has unbalanced CDATA tags: ${block.substring(0, 50)}...`);
      return false;
    }
  }
  
  return true;
}

/**
 * Preprocess text for safe matching, handling CDATA sections
 * @param text The text to preprocess
 * @returns The preprocessed text
 */
export function preprocessCdataForMatching(text: string): string {
  // More robust CDATA preprocessing that handles nested tags correctly
  // This prevents XML-like content inside CDATA from being interpreted as actual XML
  
  let processedText = '';
  let isInsideCdata = false;
  let cdataContent = '';
  let i = 0;
  
  while (i < text.length) {
    if (!isInsideCdata) {
      // Look for opening CDATA tag when not inside CDATA
      if (i + 8 < text.length && text.substring(i, i + 9) === '<![CDATA[') {
        isInsideCdata = true;
        cdataContent = '';
        i += 9; // Skip the CDATA opening tag
        processedText += '<![CDATA['; // Keep the opening tag in the processed text
      } else {
        processedText += text[i];
        i++;
      }
    } else {
      // Look for closing CDATA tag when inside CDATA
      if (i + 2 < text.length && text.substring(i, i + 3) === ']]>') {
        isInsideCdata = false;
        // Replace XML-like tags in the CDATA content with placeholders
        // This ensures they don't interfere with XML parsing
        const safeContent = cdataContent.replace(/<\/?[^>]+(>|$)/g, match => {
          // Create a distinctive placeholder that won't be confused with actual content
          return `__XML_TAG_PLACEHOLDER_${Buffer.from(match).toString('base64')}__`;
        });
        processedText += safeContent + ']]>'; // Add safe content and closing tag
        i += 3; // Skip the CDATA closing tag
      } else {
        cdataContent += text[i];
        i++;
      }
    }
  }
  
  return processedText;
}

/**
 * Extracts the content of a CDATA section if present
 * @param text The text possibly containing a CDATA section
 * @returns The content inside the CDATA tags if present, or the original text if not
 */
export function extractCdataContent(text: string): string {
  // Handle the case where text contains CDATA sections
  if (text.includes('<![CDATA[')) {
    log('Found CDATA section, extracting content');
    // Handle multiple CDATA sections if present
    return text.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/gs, (match, content) => {
      // Return just the content inside the CDATA tags
      return content;
    });
  }
  return text; // Return original if no CDATA
}

/**
 * Parses a tool call XML string into a structured object
 * Handles CDATA tags in parameters
 * @param toolCallXml The raw tool call XML string
 * @returns A parsed tool call object or null if parsing fails
 */
export function parseToolCall(toolCallXml: string): ParsedToolCall | null {
  try {
    // Extract the XML content
    const xmlContent = extractXmlContent(toolCallXml);
    
    // Process XML content to handle CDATA sections and regular XML
    // This custom preprocessing helps prevent issues when XML tags are inside CDATA
    const preprocessedXml = preprocessXmlWithCdata(xmlContent);
    
    // Focus on the part between <tool_call> and </tool_call> tags
    // Use the preprocessed XML which handles CDATA sections properly
    const toolCallContentMatch = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/s.exec(preprocessedXml);
    
    // If we can't find the tool_call tags, try on the original string as a fallback
    const toolCallContent = toolCallContentMatch 
      ? toolCallContentMatch[1] 
      : (/<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/s.exec(toolCallXml)?.[1] || '');
    
    if (!toolCallContent) {
      log('Could not extract tool call content');
      return null;
    }
    
    // Simple XML parser for tool calls - allow indentation with more flexible whitespace
    const nameMatch = /<tool_name>\s*(.*?)\s*<\/tool_name>/s.exec(toolCallContent);
    if (!nameMatch) {
      log('Could not find tool_name tag');
      return null;
    }
    
    const toolName = nameMatch[1].trim();
    const params: Record<string, string> = {};
    
    // Extract parameters with more precise formatting
    // Updated regex to require quotes around parameter names and be flexible with whitespace
    const paramRegex = /<param\s+name=["'](.*?)["']>\s*([\s\S]*?)\s*<\/param>/sg;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(toolCallContent)) !== null) {
      const paramName = paramMatch[1].trim(); // No need to replace quotes, they're already handled in the regex
      let paramValue = paramMatch[2].trim();
      
      // Check for CDATA sections in the parameter value using our improved extractor
      // This will handle multiple CDATA sections and strip only the CDATA tags, preserving content
      paramValue = extractCdataContent(paramValue);
      
      // Store all parameter values as strings, even JSON objects or arrays
      params[paramName] = paramValue;
      
      // Log the parameter type for debugging
      if (paramValue.trim().startsWith('{') || paramValue.trim().startsWith('[')) {
        log(`Parameter "${paramName}" appears to be JSON, storing as string: ${paramValue.substring(0, 50)}${paramValue.length > 50 ? '...' : ''}`);
      }
    }
    
    log(`Parsed tool call with parameters: ${JSON.stringify(Object.keys(params))}`);
    return { name: toolName, params };
  } catch (error) {
    log(`Error parsing tool call: ${error}`);
    return null;
  }
}

/**
 * Finds tool call patterns in text with regexes for different formats
 * @param text The text to check for tool calls
 * @returns An array of matches by format type
 */
export function findToolCallPatterns(text: string): Array<{ type: ToolCallFormatType, match: RegExpExecArray }> {
  const patterns = [];
  
  // First try to match the simplest and most direct case - just the tool_call tags without any context
  // This is the most permissive pattern and will work in direct messages
  const directToolCallRegex = /<tool_call>[\s\S]*?<\/tool_call>/s;
  const directMatch = directToolCallRegex.exec(text);
  
  // First try to match properly fenced tool calls (with opening and closing fences)
  // Allow for any annotation after the triple backticks (xml, tool_call, tool_code, etc.)
  const properlyFencedToolCallRegex = /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)(?:\s*)<tool_call>[\s\S]*?<\/tool_call>(?:\s*)\n\s*```/s;
  const properlyFencedMatch = properlyFencedToolCallRegex.exec(text);
  
  // Then try to match partially fenced tool calls (with opening fence but missing closing fence)
  // Allow for any annotation after the triple backticks
  const partiallyFencedToolCallRegex = /```(?:[a-zA-Z0-9_\-]*)?(?:\s*\n|\s+)(?:\s*)<tool_call>[\s\S]*?<\/tool_call>(?!\s*\n\s*```)/s;
  const partiallyFencedMatch = partiallyFencedToolCallRegex.exec(text);
  
  // Then try to match non-fenced tool calls with newlines around them
  const nonFencedToolCallRegex = /\n\s*<tool_call>[\s\S]*?\n\s*<\/tool_call>/s;
  const nonFencedMatch = nonFencedToolCallRegex.exec(text);
  
  // Collect all matches with their types
  if (directMatch) {
    patterns.push({ type: ToolCallFormatType.NON_FENCED, match: directMatch });
  }
  
  if (properlyFencedMatch) {
    patterns.push({ type: ToolCallFormatType.PROPERLY_FENCED, match: properlyFencedMatch });
  }
  
  if (partiallyFencedMatch) {
    patterns.push({ type: ToolCallFormatType.PARTIALLY_FENCED, match: partiallyFencedMatch });
  }
  
  if (nonFencedMatch) {
    patterns.push({ type: ToolCallFormatType.NON_FENCED, match: nonFencedMatch });
  }
  
  return patterns;
}

/**
 * Checks if text contains a complete tool call
 * Handles CDATA sections in parameters
 * @param text The text to check for completed tool calls
 * @returns A result indicating if a complete tool call was found and its position
 */
export function checkForCompletedToolCall(text: string): ToolCallCheckResult {
  // Log for debugging
  log(`Checking for completed tool call in text of length ${text.length}`);
  
  // First preprocess the text to handle CDATA sections
  // This ensures that XML-like content in CDATA sections doesn't interfere with tag matching
  const preprocessedText = preprocessCdataForMatching(text);
  
  // Find all potential tool call patterns in the preprocessed text
  const patterns = findToolCallPatterns(preprocessedText);
  
  // If no patterns found, return not complete
  if (patterns.length === 0) {
    return { isComplete: false };
  }
  
  // Sort patterns by their position in the text
  patterns.sort((a, b) => a.match.index - b.match.index);
  
  // Take the first (earliest) pattern
  const firstPattern = patterns[0];
  const { type, match } = firstPattern;
  
  // Get the full match and its end position
  const fullMatch = match[0];
  const matchEndIndex = match.index + fullMatch.length;
  
  // Now check the original text for completeness
  // Map the match to the original text
  const originalTextPortion = text.substring(0, matchEndIndex);
  
  // Enhanced check for balanced CDATA tags using our improved character-by-character checker
  if (!areCdataTagsBalanced(originalTextPortion)) {
    log(`Tool call has unbalanced CDATA tags, not considering it complete`);
    return { isComplete: false };
  }
  
  // Check for complete parameters with balanced CDATA using the improved checker
  if (!areParamsComplete(originalTextPortion)) {
    log(`Tool call has incomplete parameter sections, not considering it complete`);
    return { isComplete: false };
  }
  
  // Log the finding
  log(`Found completed tool call (${type}): "${fullMatch.substring(0, 50)}${fullMatch.length > 50 ? '...' : ''}"`);
  log('Stopping streaming at completed tool call');
  
  return { isComplete: true, endIndex: matchEndIndex };
}
