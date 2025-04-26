import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { log } from "../extension";
import { mcpClientManager } from "../extension";
import { ensureDirectoryExists, writeFile } from "../utils/fileUtils";

/**
 * Inserts a prompt into the current editor at the cursor position
 * If the prompt exceeds 30 lines, saves it to a file and inserts a markdown link
 * @param promptId The full ID of the prompt (serverName.promptName)
 * @param prompt The prompt object from the MCP client
 */
export async function insertPrompt(
  promptId: string,
  prompt: any
): Promise<void> {
  // Get the active text editor
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor found to insert prompt");
    return;
  }

  try {
    // Get any required arguments from the user
    log(`Requesting arguments for prompt ${promptId}`);
    const args = await promptForArguments(promptId, prompt);
    if (!args) {
      // User cancelled
      log(`User cancelled argument input for prompt ${promptId}`);
      return;
    }

    // Get the full prompt content from the MCP client
    log(`Getting prompt content from MCP for ${promptId} with args: ${JSON.stringify(args)}`);
    const promptText = await mcpClientManager.getPrompt(promptId, args);
    if (promptText.startsWith("Error:")) {
      log(`Error getting prompt content: ${promptText}`);
      vscode.window.showErrorMessage(promptText);
      return;
    }

    // Check if the prompt is large (exceeds 30 lines)
    const lineCountThreshold = 30;
    const lines = promptText.split("\n");
    
    if (lines.length > lineCountThreshold) {
      log(`Prompt exceeds ${lineCountThreshold} lines, saving to file.`);
      
      try {
        // Create cmdassets directory relative to the current document
        const docDir = path.dirname(editor.document.uri.fsPath);
        const assetsDir = path.join(docDir, "cmdassets");
        ensureDirectoryExists(assetsDir);

        // Generate a unique filename with timestamp and random string
        const timestamp = new Date()
          .toISOString()
          .replace(/:/g, "")
          .replace(/-/g, "")
          .replace("T", "-")
          .replace(/\..+Z/, "");
        const randomString = Math.random().toString(36).substring(2, 8);
        const promptName = promptId.split('.')[1];
        const sanitizedPromptName = promptName.replace(/[^a-zA-Z0-9-_]/g, "_");
        const filename = `mcp-prompt-${sanitizedPromptName}-${timestamp}-${randomString}.md`;
        const relativeFilePath = path.join("cmdassets", filename);
        const fullFilePath = path.join(assetsDir, filename);

        // Add prompt metadata as a header comment in the file
        const promptMetadata = `<!-- 
MCP Prompt: ${promptName}
Server: ${promptId.split('.')[0]}
Generated: ${new Date().toISOString()}
Arguments: ${JSON.stringify(args)}
-->

`;
        
        // Save the prompt content to the file
        writeFile(fullFilePath, promptMetadata + promptText);
        log(`Saved prompt content to: ${fullFilePath}`);

        // Create a markdown link pointing to the saved file
        const markdownLink = `[MCP Prompt: ${promptName}](${relativeFilePath.replace(/\\/g, "/")})\n\n`;
        
        // Insert the markdown link at the cursor position
        await editor.edit((editBuilder) => {
          for (const selection of editor.selections) {
            editBuilder.insert(selection.active, markdownLink);
          }
        });
        
        // Show success message with file info
        vscode.window.showInformationMessage(`Inserted link to large prompt: ${promptName} (content saved to file)`);
      } catch (fileError) {
        log(`Error saving prompt to file: ${fileError}`);
        
        // Fallback: Insert the prompt directly with a warning
        const warningMessage = `<!-- Warning: This prompt exceeded ${lineCountThreshold} lines but could not be saved to a file: ${fileError} -->\n\n`;
        await editor.edit((editBuilder) => {
          for (const selection of editor.selections) {
            editBuilder.insert(selection.active, warningMessage + promptText);
          }
        });
        
        vscode.window.showWarningMessage(`Inserted large prompt directly: ${promptId.split('.')[1]} (file save failed)`);
      }
    } else {
      // For smaller prompts, insert directly as before
      await editor.edit((editBuilder) => {
        for (const selection of editor.selections) {
          editBuilder.insert(selection.active, promptText);
        }
      });

      // Show success message
      const promptName = promptId.split('.')[1];
      vscode.window.showInformationMessage(`Inserted prompt: ${promptName}`);
    }
  } catch (error) {
    log(`Error inserting prompt ${promptId}: ${error}`);
    vscode.window.showErrorMessage(`Failed to insert prompt: ${error}`);
  }
}

/**
 * Prompts the user for any required arguments for the prompt
 * @param promptId The ID of the prompt (serverName.promptName)
 * @param prompt The prompt object from the MCP client
 * @returns A record of argument name to value, or undefined if cancelled
 */
async function promptForArguments(
  promptId: string,
  prompt: any
): Promise<Record<string, string> | undefined> {
  // If no arguments are required, return empty object
  if (!prompt.arguments || prompt.arguments.length === 0) {
    return {};
  }

  const args: Record<string, string> = {};
  
  // Get the server name and prompt name parts
  const [serverName, promptName] = promptId.split(".");

  // Prompt for each required argument
  for (const arg of prompt.arguments) {
    const value = await vscode.window.showInputBox({
      prompt: arg.description || `Enter value for ${arg.name}`,
      placeHolder: arg.name,
      title: `Prompt Argument for ${promptName}`,
      ignoreFocusOut: true, // Keep the input box open if focus is lost
      validateInput: (value) => {
        if (arg.required && !value) {
          return "This argument is required";
        }
        return null; // Validation passes
      }
    });
    
    // If user cancels any argument input, return undefined
    if (value === undefined) {
      return undefined;
    }

    // Add the argument value
    args[arg.name] = value;
  }

  return args;
}