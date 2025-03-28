const fs = require('fs');
const path = require('path');

// Test the XML parsing
function parseToolCall(toolCallXml) {
  try {
    const nameMatch = /<tool_name>(.*?)<\/tool_name>/s.exec(toolCallXml);
    if (!nameMatch) {
      return null;
    }
    
    const toolName = nameMatch[1].trim();
    const params = {};
    
    const paramRegex = /<param\s+name=(.*?)>([\s\S]*?)<\/param>/sg;
    let paramMatch;
    
    while ((paramMatch = paramRegex.exec(toolCallXml)) !== null) {
      const paramName = paramMatch[1].trim().replace(/["']/g, '');
      const paramValue = paramMatch[2].trim();
      params[paramName] = paramValue;
    }
    
    return { name: toolName, params };
  } catch (error) {
    console.error(`Error parsing tool call: ${error}`);
    return null;
  }
}

// Test tool call XML
const testXml = `
<tool_call>
<tool_name>readFile</tool_name>
<param name="path">
package.json
</param>
</tool_call>
`;

// Test parsing
const parsed = parseToolCall(testXml);
console.log('Parsed tool call:', parsed);

// Test tool execution
function executeReadFileTool(params) {
  const filePath = params.path;
  
  if (!filePath) {
    return 'Error: No file path provided';
  }
  
  try {
    const resolvedPath = path.resolve(filePath);
    console.log('Reading file:', resolvedPath);
    const content = fs.readFileSync(resolvedPath, 'utf8');
    return content;
  } catch (error) {
    return `Error reading file: ${error}`;
  }
}

// Test execution
const result =