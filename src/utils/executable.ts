import * as fs from "fs";
import * as path from "path";

export function executableOnPath(name: string): string | undefined {
  const directories = (process.env.PATH ?? "")
    .split(path.delimiter)
    .filter(Boolean);
  const extensions =
    process.platform === "win32"
      ? (process.env.PATHEXT ?? ".EXE;.CMD;.BAT;.COM").split(";")
      : [""];
  for (const directory of directories) {
    for (const extension of extensions) {
      const candidate = path.join(directory, name + extension.toLowerCase());
      try {
        fs.accessSync(
          candidate,
          process.platform === "win32"
            ? fs.constants.F_OK
            : fs.constants.X_OK,
        );
        if (fs.statSync(candidate).isFile()) return candidate;
      } catch {
        continue;
      }
    }
  }
  return undefined;
}
