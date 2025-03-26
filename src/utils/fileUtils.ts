import * as path from 'path';
import * as fs from 'fs';
import * as vscode from 'vscode';

/**
 * Resolves file paths that may be relative to the current document
 */
export function resolveFilePath(filePath: string, document: vscode.TextDocument): string {
  // If path starts with ~ replace with home dir
  if (filePath.startsWith('~')) {
    return filePath.replace(/^~/, process.env.HOME || '');
  }
  
  // If it's an absolute path, return as is
  if (path.isAbsolute(filePath)) {
    return filePath;
  }
  
  // Try to resolve relative to the document
  const documentDir = path.dirname(document.uri.fsPath);
  const resolvedPath = path.resolve(documentDir, filePath);
  
  return resolvedPath;
}

/**
 * Check if a file exists and is accessible
 */
export function fileExists(filePath: string): boolean {
  try {
    fs.accessSync(filePath, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

/**
 * Read file as a buffer, handling errors gracefully
 * Returns undefined if file can't be read
 */
export function readFileAsBuffer(filePath: string): Buffer | undefined {
  try {
    return fs.readFileSync(filePath);
  } catch (error) {
    console.error(`Error reading file ${filePath}:`, error);
    return undefined;
  }
}