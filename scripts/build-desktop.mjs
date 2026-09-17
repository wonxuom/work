// Builds the desktop app for the current OS: a macOS .app that replaces /Applications/Trace.app,
// or a Windows NSIS installer. Tauri can only bundle for the OS it runs on.
import { spawnSync } from "node:child_process";

const windows = process.platform === "win32";
const macos = process.platform === "darwin";

const run = (command, args) => {
  const result = spawnSync(command, args, { stdio: "inherit", shell: windows });
  if (result.status !== 0) process.exit(result.status ?? 1);
};

const bundles = macos ? ["--bundles", "app"] : windows ? ["--bundles", "nsis"] : [];
run("npx", ["tauri", "build", ...bundles]);

if (macos) run("sh", ["scripts/install-app.sh"]);
if (windows) console.log("\n설치 파일: src-tauri\\target\\release\\bundle\\nsis\\ 폴더의 Trace_*_x64-setup.exe를 실행하세요.");
