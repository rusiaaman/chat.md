import * as fs from "fs";
import * as os from "os";
import * as path from "path";

interface CapturedToolInput {
  cwd: string;
  tool_input: unknown;
  tool_name: string;
}

export interface IsolatedCodexHome {
  capturesToolInput: boolean;
  codexPath: string;
  environment: Record<string, string>;
  takeToolInput(
    toolName: string,
    fallback: Record<string, unknown>,
    changedPaths: readonly string[],
  ): Record<string, unknown>;
  dispose(): void;
}

function shareAuthFile(source: string, destination: string): void {
  try {
    fs.linkSync(source, destination);
    return;
  } catch {
    try {
      fs.symlinkSync(source, destination, "file");
      return;
    } catch {
      fs.copyFileSync(source, destination);
      fs.chmodSync(destination, 0o600);
    }
  }
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function capturedInputMatches(
  event: CapturedToolInput,
  changedPaths: readonly string[],
): boolean {
  if (
    !event.tool_input ||
    typeof event.tool_input !== "object" ||
    Array.isArray(event.tool_input)
  ) {
    return false;
  }
  const command = (event.tool_input as Record<string, unknown>).command;
  if (typeof command !== "string") return false;
  return changedPaths.every((changedPath) => {
    const relative = path.relative(event.cwd, changedPath);
    return command.includes(changedPath) || command.includes(relative);
  });
}

function readCapturedInputs(captureDirectory: string): CapturedToolInput[] {
  const filenames = fs
    .readdirSync(captureDirectory)
    .filter((filename) => /^\d+\.json$/.test(filename))
    .sort((left, right) => Number.parseInt(left) - Number.parseInt(right));
  return filenames.flatMap((filename) => {
    const capturePath = path.join(captureDirectory, filename);
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(capturePath, "utf8"));
      fs.unlinkSync(capturePath);
      return parsed && typeof parsed === "object" && !Array.isArray(parsed)
        ? [parsed as CapturedToolInput]
        : [];
    } catch {
      return [];
    }
  });
}

function createCaptureFiles(
  temporaryHome: string,
  codexPath: string,
): { captureDirectory: string; wrapperPath: string } {
  const captureDirectory = path.join(temporaryHome, "tool-inputs");
  fs.mkdirSync(captureDirectory, { mode: 0o700 });
  const capturePath = path.join(temporaryHome, "capture-tool-input.sh");
  fs.writeFileSync(
    capturePath,
    `#!/bin/sh
set -eu
capture_dir=${shellQuote(captureDirectory)}
lock_dir="$capture_dir/.lock"
while ! mkdir "$lock_dir" 2>/dev/null; do sleep 0.01; done
cleanup() { rmdir "$lock_dir"; }
trap cleanup EXIT HUP INT TERM
sequence_file="$capture_dir/.sequence"
sequence=0
if [ -f "$sequence_file" ]; then sequence=$(cat "$sequence_file"); fi
next=$((sequence + 1))
printf '%s\n' "$next" > "$sequence_file"
cat > "$capture_dir/$next.json"
`,
    { mode: 0o700 },
  );
  const wrapperPath = path.join(temporaryHome, "codex-with-chatmd-hook.sh");
  fs.writeFileSync(
    wrapperPath,
    `#!/bin/sh
exec ${shellQuote(codexPath)} --dangerously-bypass-hook-trust "$@"
`,
    { mode: 0o700 },
  );
  fs.writeFileSync(
    path.join(temporaryHome, "hooks.json"),
    `${JSON.stringify(
      {
        hooks: {
          PreToolUse: [
            {
              matcher: "^apply_patch$",
              hooks: [
                {
                  type: "command",
                  command: shellQuote(capturePath),
                  timeout: 10,
                },
              ],
            },
          ],
        },
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
  return { captureDirectory, wrapperPath };
}

export function isolatedCodexHome(
  environment: Record<string, string>,
  codexPath: string,
): IsolatedCodexHome {
  const sourceHome =
    environment.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatmd-codex-"));
  fs.chmodSync(temporaryHome, 0o700);
  const sourceAuth = path.join(sourceHome, "auth.json");
  if (fs.existsSync(sourceAuth)) {
    shareAuthFile(sourceAuth, path.join(temporaryHome, "auth.json"));
  }

  const capture =
    process.platform === "win32"
      ? undefined
      : createCaptureFiles(temporaryHome, codexPath);
  const pendingInputs: CapturedToolInput[] = [];
  return {
    capturesToolInput: capture !== undefined,
    codexPath: capture?.wrapperPath ?? codexPath,
    environment: {
      ...environment,
      CODEX_HOME: temporaryHome,
      CODEX_SQLITE_HOME: temporaryHome,
    },
    takeToolInput: (toolName, fallback, changedPaths) => {
      if (!capture || toolName !== "apply_patch") return fallback;
      pendingInputs.push(...readCapturedInputs(capture.captureDirectory));
      const matchingIndex = pendingInputs.findIndex(
        (event) =>
          event.tool_name === toolName &&
          capturedInputMatches(event, changedPaths),
      );
      const index = matchingIndex >= 0 ? matchingIndex : 0;
      const event = pendingInputs.splice(index, 1)[0];
      if (
        !event?.tool_input ||
        typeof event.tool_input !== "object" ||
        Array.isArray(event.tool_input)
      ) {
        return fallback;
      }
      return event.tool_input as Record<string, unknown>;
    },
    dispose: () => fs.rmSync(temporaryHome, { recursive: true, force: true }),
  };
}
