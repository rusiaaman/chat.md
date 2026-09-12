import * as fs from "fs";
import * as os from "os";
import * as path from "path";

export interface IsolatedCodexHome {
  environment: Record<string, string>;
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

export function isolatedCodexHome(
  environment: Record<string, string>,
): IsolatedCodexHome {
  const sourceHome =
    environment.CODEX_HOME ?? path.join(os.homedir(), ".codex");
  const temporaryHome = fs.mkdtempSync(path.join(os.tmpdir(), "chatmd-codex-"));
  fs.chmodSync(temporaryHome, 0o700);
  const sourceAuth = path.join(sourceHome, "auth.json");
  if (fs.existsSync(sourceAuth)) {
    shareAuthFile(sourceAuth, path.join(temporaryHome, "auth.json"));
  }
  return {
    environment: {
      ...environment,
      CODEX_HOME: temporaryHome,
      CODEX_SQLITE_HOME: temporaryHome,
    },
    dispose: () => fs.rmSync(temporaryHome, { recursive: true, force: true }),
  };
}
