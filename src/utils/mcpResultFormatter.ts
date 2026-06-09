import * as fs from "fs";
import * as path from "path";
import {
  McpPromptMessage,
  McpPromptResult,
  McpReadResourceResult,
  McpRenderableContent,
  McpToolExecutionResult,
} from "../types";
import { log } from "../extension";
import { ensureDirectoryExists, writeFile } from "./fileUtils";

/**
 * Formats a rich MCP tool execution result into markdown text,
 * saving any binary assets (images, audio, blobs) to the document's cmdassets/ folder.
 */
export async function formatMcpResult(
  result: McpToolExecutionResult,
  docDir: string,
): Promise<string> {
  const parts = await formatRenderableContent(
    result.content,
    docDir,
    result.toolName,
    result.serverId,
  );

  if (result.structuredContent !== undefined) {
    const structuredContentText = JSON.stringify(result.structuredContent, null, 2);
    parts.unshift(`\`\`\`json\n${structuredContentText}\n\`\`\``);
  }

  const finalMarkdown = joinMarkdownParts(parts);
  if (result.isError) {
    return `**Tool execution error**\n\n${finalMarkdown}`;
  }

  return finalMarkdown;
}

export async function formatPromptResult(
  result: McpPromptResult,
  docDir: string,
): Promise<string> {
  const messageBlocks: string[] = [];

  for (const message of result.messages) {
    const messageBody = await formatPromptMessage(message, docDir);
    if (messageBody.trim().length === 0) {
      continue;
    }

    if (message.role === "assistant") {
      messageBlocks.push(`# %% assistant\n${messageBody}`);
    } else {
      messageBlocks.push(messageBody);
    }
  }

  return joinMarkdownParts(messageBlocks);
}

export function formatReadResourceResult(result: McpReadResourceResult): string {
  const parts: string[] = [];

  for (const content of result.contents) {
    if (content.text !== undefined) {
      parts.push(content.text);
      continue;
    }

    if (content.blob !== undefined) {
      const binaryHeader = [
        `Binary resource: ${content.uri}`,
        `MIME type: ${content.mimeType || "unknown"}`,
        `Payload: base64 blob (${content.blob.length} chars)`
      ].join("\n");
      parts.push(binaryHeader);
    }
  }

  return joinMarkdownParts(parts);
}

async function formatPromptMessage(
  message: McpPromptMessage,
  docDir: string,
): Promise<string> {
  const messageParts = await formatRenderableContent(
    message.content,
    docDir,
    `prompt-${message.role}`,
    undefined,
  );
  return joinMarkdownParts(messageParts);
}

async function formatRenderableContent(
  content: McpRenderableContent[],
  docDir: string,
  assetLabel: string,
  sourceServerId: string | undefined,
): Promise<string[]> {
  const assetsDir = path.join(docDir, "cmdassets");
  ensureDirectoryExists(assetsDir);

  const parts: string[] = [];
  let imageCount = 0;
  let audioCount = 0;
  let resourceCount = 0;

  for (const item of content) {
    if (item.type === "text") {
      parts.push(item.text);
      continue;
    }

    if (item.type === "image") {
      imageCount += 1;
      parts.push(saveBinaryAsset(item.data, item.mimeType, assetsDir, `${assetLabel}-image`, `![${assetLabel} image ${imageCount}]`));
      continue;
    }

    if (item.type === "audio") {
      audioCount += 1;
      parts.push(saveBinaryAsset(item.data, item.mimeType, assetsDir, `${assetLabel}-audio`, `[${assetLabel} audio ${audioCount}]`));
      continue;
    }

    if (item.type === "resource_link") {
      const label = item.title || item.name || item.uri;
      const detailParts = [item.description, item.mimeType].filter(Boolean);
      const detail = detailParts.length > 0 ? ` - ${detailParts.join(" · ")}` : "";
      const fetchInstruction = sourceServerId
        ? `\nTo fetch this resource, call \`system.fetch_mcp_resource\` with \`serverId\` = \`${sourceServerId}\` and \`uri\` = \`${item.uri}\`.`
        : "";
      parts.push(`**Resource Link:** [${label}](${item.uri})${detail}${fetchInstruction}`);
      continue;
    }

    resourceCount += 1;
    const resourceLabel = `${assetLabel}-resource-${resourceCount}`;
    parts.push(renderEmbeddedResource(item.resource, assetsDir, resourceLabel));
  }

  return parts.filter((part) => part.trim().length > 0);
}

function renderEmbeddedResource(
  resource: { uri: string; mimeType?: string; text?: string; blob?: string },
  assetsDir: string,
  resourceLabel: string,
): string {
  if (resource.text !== undefined) {
    const lineCount = resource.text.split("\n").length;
    if (lineCount <= 15) {
      return `**Embedded Resource: ${resource.uri}**\n\n\`\`\`\n${resource.text}\n\`\`\``;
    }

    const extension = getFileExtensionForMimeType(resource.mimeType || "text/plain", ".txt");
    const fileName = createAssetFileName(resourceLabel, extension);
    const filePath = path.join(assetsDir, fileName);
    writeFile(filePath, resource.text);
    log(`Saved embedded text resource to: ${filePath}`);
    return `[Embedded Resource: ${resource.uri}](cmdassets/${fileName})`;
  }

  if (resource.blob !== undefined) {
    const mimeType = resource.mimeType || "application/octet-stream";
    const extension = getFileExtensionForMimeType(mimeType, ".bin");
    const fileName = createAssetFileName(resourceLabel, extension);
    const filePath = path.join(assetsDir, fileName);
    const buffer = Buffer.from(resource.blob, "base64");
    fs.writeFileSync(filePath, buffer);
    log(`Saved embedded binary resource to: ${filePath}`);
    return `[Embedded Binary Resource: ${resource.uri}](cmdassets/${fileName})`;
  }

  return `[Embedded Resource: ${resource.uri}]`;
}

function saveBinaryAsset(
  data: string,
  mimeType: string,
  assetsDir: string,
  assetLabel: string,
  markdownPrefix: string,
): string {
  const extension = getFileExtensionForMimeType(mimeType, ".bin");
  const fileName = createAssetFileName(assetLabel, extension);
  const filePath = path.join(assetsDir, fileName);
  const buffer = Buffer.from(data, "base64");
  fs.writeFileSync(filePath, buffer);
  log(`Saved MCP asset to: ${filePath}`);
  return `${markdownPrefix}(cmdassets/${fileName})`;
}

function createAssetFileName(assetLabel: string, extension: string): string {
  const sanitizedLabel = assetLabel.replace(/[^a-zA-Z0-9-_]/g, "-");
  return `${sanitizedLabel}-${getTimestampString()}-${Math.random().toString(36).slice(2, 8)}${extension}`;
}

function joinMarkdownParts(parts: string[]): string {
  const nonEmptyParts = parts.filter((part) => part.trim().length > 0);
  return nonEmptyParts.join("\n\n");
}

function getTimestampString(): string {
  const date = new Date();
  return `${date.getFullYear()}${String(date.getMonth() + 1).padStart(2, "0")}${String(date.getDate()).padStart(2, "0")}-${String(date.getHours()).padStart(2, "0")}${String(date.getMinutes()).padStart(2, "0")}${String(date.getSeconds()).padStart(2, "0")}`;
}

function getFileExtensionForMimeType(mimeType: string, defaultExtension: string): string {
  const normalizedMimeType = mimeType.toLowerCase();
  if (normalizedMimeType.includes("png")) return ".png";
  if (normalizedMimeType.includes("jpeg") || normalizedMimeType.includes("jpg")) return ".jpg";
  if (normalizedMimeType.includes("gif")) return ".gif";
  if (normalizedMimeType.includes("webp")) return ".webp";
  if (normalizedMimeType.includes("mp3")) return ".mp3";
  if (normalizedMimeType.includes("wav")) return ".wav";
  if (normalizedMimeType.includes("ogg")) return ".ogg";
  if (normalizedMimeType.includes("json")) return ".json";
  if (normalizedMimeType.includes("xml")) return ".xml";
  if (normalizedMimeType.includes("html")) return ".html";
  if (normalizedMimeType.includes("pdf")) return ".pdf";
  if (normalizedMimeType.includes("markdown")) return ".md";
  if (normalizedMimeType.includes("plain")) return ".txt";
  return defaultExtension;
}
