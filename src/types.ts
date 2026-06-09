/**
 * Core type definitions for the filechat extension
 */

/**
 * Represents the type of content in a message
 */
export type ContentType = "text" | "image";

/**
 * Text content in a message
 */
export interface TextContent {
  type: "text";
  value: string;
}

/**
 * Image content in a message
 */
export interface ImageContent {
  type: "image";
  path: string;
}

/**
 * Union type for different types of content
 */
export type Content = TextContent | ImageContent;

/**
 * Discriminated union for raw/rich MCP content types returned by tools or prompts
 */
export interface McpTextContent {
  type: "text";
  text: string;
  annotations?: any;
}

export interface McpImageContent {
  type: "image";
  data: string;
  mimeType: string;
  annotations?: any;
}

export interface McpAudioContent {
  type: "audio";
  data: string;
  mimeType: string;
  annotations?: any;
}

export interface McpResourceLink {
  type: "resource_link";
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: any;
}

export interface McpEmbeddedResource {
  type: "resource";
  resource: {
    uri: string;
    mimeType?: string;
    text?: string;
    blob?: string;
    annotations?: any;
  };
}

export type McpRenderableContent =
  | McpTextContent
  | McpImageContent
  | McpAudioContent
  | McpResourceLink
  | McpEmbeddedResource;

/**
 * Rich result object from an MCP tool execution
 */
export interface McpToolExecutionResult {
  serverId: string;
  toolName: string;
  isError: boolean;
  content: McpRenderableContent[];
  structuredContent?: unknown;
}

export interface McpPromptMessage {
  role: Role;
  content: McpRenderableContent[];
}

export interface McpPromptResult {
  description?: string;
  messages: McpPromptMessage[];
}

export interface McpReadResourceContent {
  uri: string;
  mimeType?: string;
  text?: string;
  blob?: string;
}

export interface McpReadResourceResult {
  contents: McpReadResourceContent[];
}

/**
 * MCP Resource definition from servers
 */
export interface McpResource {
  uri: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  size?: number;
  annotations?: any;
}

/**
 * MCP Resource Template definition from servers
 */
export interface McpResourceTemplate {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
  annotations?: any;
}

/**
 * Roles in a chat conversation
 */
export type Role = "user" | "assistant";

/**
 * Structure of a message in the chat
 */
export interface MessageParam {
  role: Role;
  content: Content[];
}

/**
 * State of a streaming response
 */
export interface StreamerState {
  messageIndex: number;
  tokens: string[];
  isActive: boolean;

  /**
   * Path to the history file where chat context is saved
   * Used for debugging purposes
   */
  historyFilePath?: string;

  /**
   * Flag to indicate whether the streamer is handling a tool call
   * Used to determine whether to automatically add a user block after completion
   */
  isHandlingToolCall?: boolean;

  /**
   * Function to cancel the stream. This can be called externally
   * by components holding a reference to the streamer.
   */
  cancel?: () => void;
}

/**
 * Structure for storing tool auto-execute configuration for a file or globally
 */
export interface ToolAutoExecuteConfig {
  disabledTools: string[]; // List of tools for which auto-execution is disabled
}
