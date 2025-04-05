import {
  parseToolCall,
  checkForCompletedToolCall,
  extractCdataContent,
  areCdataTagsBalanced,
} from "./toolCallParser";

// Test function to verify CDATA parsing
export function testCdataFunctionality() {
  // Test case 1: Basic CDATA extraction
  const simpleParam = `<param name="content"><![CDATA[This is content]]></param>`;
  console.log(
    "Test 1 - Simple CDATA content:",
    extractCdataContent(simpleParam),
  );

  // Test case 2: CDATA with XML-like content
  const xmlInCdata = `<param name="content"><![CDATA[This contains <tool_call> and </tool_call> tags]]></param>`;
  console.log("Test 2 - CDATA with XML tags:", extractCdataContent(xmlInCdata));

  // Test case 3: Multiple CDATA sections
  const multipleCdata = `<param name="content"><![CDATA[Section 1]]></param><![CDATA[Section 2]]></param>`;
  console.log(
    "Test 3 - Multiple CDATA sections:",
    extractCdataContent(multipleCdata),
  );

  // Test case 4: CDATA balance check
  console.log(
    "Test 4 - Balanced CDATA:",
    areCdataTagsBalanced(`<![CDATA[Test]]>`),
  );
  console.log(
    "Test 5 - Unbalanced CDATA:",
    areCdataTagsBalanced(`<![CDATA[Test`),
  );

  // Test case 5: Complete tool call with CDATA
  const completeToolCall = `
<tool_call>
<tool_name>FileWriteOrEdit</tool_name>
<param name="file_path">/test/path.txt</param>
<param name="percentage_to_change">5</param>
<param name="file_content_or_search_replace_blocks"><![CDATA[This content has XML-like tags such as </tool_call> that should be treated as text]]></param>
</tool_call>
  `;

  const parsedCall = parseToolCall(completeToolCall);
  console.log("Test 6 - Parsed tool call:", parsedCall);

  // Test case 6: Check for completed tool call with CDATA
  const incompleteToolCall = `
<tool_call>
<tool_name>FileWriteOrEdit</tool_name>
<param name="file_path">/test/path.txt</param>
<param name="percentage_to_change">5</param>
<param name="file_content_or_search_replace_blocks"><![CDATA[This content has XML-like tags
  `;

  console.log(
    "Test 7 - Complete tool call check:",
    checkForCompletedToolCall(completeToolCall).isComplete,
  );
  console.log(
    "Test 8 - Incomplete tool call check:",
    checkForCompletedToolCall(incompleteToolCall).isComplete,
  );

  // Test case 7: Tool call with CDATA containing search/replace markers
  const searchReplaceToolCall = `
<tool_call>
<tool_name>FileWriteOrEdit</tool_name>
<param name="file_path">/test/path.txt</param>
<param name="percentage_to_change">5</param>
<param name="file_content_or_search_replace_blocks"><![CDATA[<<<<<<< SEARCH
<div>Original content</div>
=======
<div>New content with XML tags</div>
>>>>>>> REPLACE]]></param>
</tool_call>
  `;

  const parsedSearchReplace = parseToolCall(searchReplaceToolCall);
  console.log(
    "Test 9 - Search/Replace tool call:",
    parsedSearchReplace?.params.file_content_or_search_replace_blocks.substring(
      0,
      50,
    ) + "...",
  );
}

// Run the tests if executed directly
if (require.main === module) {
  testCdataFunctionality();
}
