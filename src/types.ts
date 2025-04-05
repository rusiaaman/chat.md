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
   * Function to cancel the stream. This can be called externally
   * by components holding a reference to the streamer.
   */
  cancel?: () => void;
}
