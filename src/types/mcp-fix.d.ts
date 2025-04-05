// Fix for @modelcontextprotocol/sdk IOType issue
declare module "node:child_process" {
  export type IOType = "pipe" | "ignore" | "inherit";
}
