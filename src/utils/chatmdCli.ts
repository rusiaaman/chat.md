/**
 * Locating the chat.md CLI, and the system prompt section that depends on it.
 *
 * The prompt tells the model how to hand work to other chat.md agents, and that
 * section is only included when there is a command it can actually run. A wrong
 * path would be worse than no section at all: the model would try, fail, and have
 * no way to tell whether the capability exists.
 *
 * The template must stay byte-identical to `_AGENT_SECTION` in
 * chatmd/providers/prompt.py — both engines describe the same CLI.
 */

import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";

const EXECUTABLE_NAME = "chatmd";

/** Resolved once: a PATH scan per system prompt would be wasteful. */
let cached: { command: string | undefined } | undefined;

function isExecutable(candidate: string): boolean {
  try {
    const stats = fs.statSync(candidate);
    if (!stats.isFile()) {
      return false;
    }
    fs.accessSync(candidate, fs.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function quote(candidate: string): string {
  return candidate.includes(" ") ? `"${candidate}"` : candidate;
}

/**
 * The command that runs the chat.md CLI, or undefined when it cannot be
 * established.
 *
 * A configured path wins, since a GUI editor often starts with a narrower PATH
 * than a shell and the person may know better than we can detect.
 */
export function findChatmdCommand(): string | undefined {
  if (cached) {
    return cached.command;
  }

  const configured = vscode.workspace
    .getConfiguration("chatmd")
    .get<string>("cliPath");
  if (configured && configured.trim() !== "") {
    const resolved = configured.trim();
    cached = { command: isExecutable(resolved) ? quote(resolved) : undefined };
    return cached.command;
  }

  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  for (const directory of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!directory) {
      continue;
    }
    for (const extension of extensions) {
      const candidate = path.join(directory, EXECUTABLE_NAME + extension);
      if (isExecutable(candidate)) {
        cached = { command: quote(candidate) };
        return cached.command;
      }
    }
  }

  cached = { command: undefined };
  return undefined;
}

/** Forgets the cached lookup, so a settings change takes effect. */
export function resetChatmdCommandCache(): void {
  cached = undefined;
}

const AGENT_SECTION = "## Handing work to other chat.md agents\n\nIndependent pieces of work can be run in parallel by other chat.md agents, each with the same tools and configuration as this one. An agent is a .chat.md file: writing one starts it, and reading it back shows how far it has got, because the file is both the instruction and the transcript.\n\nOnly worth doing for parts that genuinely do not depend on each other. Work that has to happen in order is quicker done here.\n\nStarting them:\n\n1. Make a folder for the run, under the system temporary directory unless the person asked for the work to live somewhere specific.\n2. Write one .chat.md file per agent. Each file is the whole brief:\n\n# %% user\nEverything the agent needs to know, and exactly what to produce.\n\n# %% assistant\n\nEnding on an empty \"# %% assistant\" line is what asks for a reply, so nothing may come after it. An optional \"# %% system\" block above the user block sets that agent's persona.\n\n3. Register the folder once, with: {command} watch /path/to/the/folder\nFiles already in it are picked up, and so are any written afterwards.\n\nFollowing one: read its file and look at how it ends.\n\n- an empty \"# %% user\" block - finished. The answer is the \"# %% assistant\" block above it.\n- \"# %% assistant\" followed by text - still writing.\n- a \"# %% tool_execute\" block - running a tool, more to come.\n- an empty \"# %% assistant\" block - not started yet.\n\nReading the file again is what makes progress visible; there is nothing else to wait on.\n\nTelling stuck from merely slow:\n\n- `{command} status` - whether a listener is running, which files are in flight and for how long, and the state of each tool server. A file shown as \"locked\" is held by another process. A file that is not listed is not being worked on.\n- `{command} status --json` - the same, machine readable.\n- `{command} mcp status` - the tool servers alone, with the last error for any that failed.\n- `{command} stats --since 1h` - what has been spent.\n\nA file that has not changed and does not appear in the status is not running: either no listener is up, its folder was never registered, or the turn ended in an error recorded in the file itself. Reading the file says which.\n\nWrite each brief so it can be answered without asking anything back: an agent cannot ask follow-up questions and does not see this conversation. Ask for the result in the reply itself, or for the path of a file it has written.\n\nThese same instructions reach every agent, so say in the brief when one should not start agents of its own.\n";

/**
 * The subagent instructions, or an empty string when no command is known.
 *
 * Omitted rather than guessed, for the reason in the module comment.
 */
export function chatmdAgentSection(command: string | undefined): string {
  if (!command) {
    return "";
  }
  return AGENT_SECTION.split("{command}").join(command);
}
