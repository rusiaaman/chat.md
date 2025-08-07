// Script to test if logs are displayed
const vscode = require('vscode');

async function testLogs() {
  // Activate the extension
  await vscode.commands.executeCommand('filechat.refreshMcpTools');
  
  console.log('Log test completed');
}

testLogs().catch(err => {
  console.error('Error in test:', err);
});
