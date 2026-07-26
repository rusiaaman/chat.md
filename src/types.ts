/**
 * Core type definitions for the filechat extension
 */

/**
 * Represents the type of content in a message
 */
export type ContentType = "text" | "image" | "thinking";

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
 * Kinds of provider reasoning payload that can be replayed to an API.
 * "raw" means there is no opaque payload, only human readable thinking text.
 */
export type ThinkingPayloadKind =
  | "anthropic_signature"
  | "anthropic_redacted"
  | "openai_encrypted"
  | "reasoning_details"
  | "raw";

/**
 * Provider specific reasoning payload, stored in cmdassets/thinking_map.json and
 * referenced from the document by an 8 character hash.
 */
export interface ThinkingPayload {
  kind: ThinkingPayloadKind;
  /** Anthropic: opaque signature for a thinking block */
  signature?: string;
  /** Anthropic: opaque data of a redacted_thinking block */
  data?: string;
  /** OpenAI Responses: reasoning item id (rs_...) */
  itemId?: string;
  /** OpenAI Responses: encrypted reasoning content */
  encryptedContent?: string;
  /** OpenAI chat completions (OpenRouter et al): reasoning_details array */
  reasoningDetails?: any[];
  /** OpenAI chat completions: which field the reasoning text came in */
  field?: "reasoning" | "reasoning_content" | "reasoning_summary";
}

/**
 * A thinking payload as stored in the map, qualified by the model that produced it
 */
export interface ThinkingMapEntry extends ThinkingPayload {
  model: string;
  createdAt: string;
}

/**
 * On disk shape of cmdassets/thinking_map.json
 */
export interface ThinkingMapFile {
  version: 1;
  entries: Record<string, ThinkingMapEntry>;
}

/**
 * Thinking (reasoning) content of an assistant message
 */
export interface ThinkingContent {
  type: "thinking";
  /** Human readable thinking text (summary or raw), without the signature line */
  value: string;
  /** Qualified model name from the signature line, if present */
  model?: string;
  /** 8 character hash referencing an entry in thinking_map.json */
  hash?: string;
  /** Payload resolved from thinking_map.json, if the entry could be read */
  payload?: ThinkingPayload;
}

/**
 * Union type for different types of content
 */
export type Content = TextContent | ImageContent | ThinkingContent;

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
   * Whether a "## %% thinking" section is currently open in the document
   */
  thinkingOpen?: boolean;

  /**
   * Whether a "## %% text" section is currently open in the document
   */
  textOpen?: boolean;

  /**
   * Whether any thinking section was written during this turn. Once true, all
   * normal assistant content has to live under a "## %% text" marker.
   */
  sawThinking?: boolean;

  /**
   * Offset within the joined tokens where the current text section starts.
   * Tool call detection only scans from here, so thinking text and signature
   * lines can never be mistaken for a tool call.
   */
  scanOffset?: number;

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
