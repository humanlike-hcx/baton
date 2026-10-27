import { execFile as nodeExecFile } from "node:child_process";

/** Undefined means the user cancelled. */
export type DirectoryPicker = () => Promise<string | undefined>;

const PROMPT = "选择要在 Baton 里打开的项目目录";
const FAIL = "文件夹选择框没有打开，请手填目录路径";

const CHOOSE_DIRECTORY_SCRIPT = `
tell application "Finder" to activate
try
  set chosenFolder to choose folder with prompt "${PROMPT}"
  POSIX path of chosenFolder
on error number -128
  ""
end try
`;

/** Explorer-style folder dialog. New Folder stays available. An STA thread is required for WinForms. */
const WINDOWS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Windows.Forms
$owner = New-Object System.Windows.Forms.Form
$owner.TopMost = $true
$owner.ShowInTaskbar = $false
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '${PROMPT}'
$dialog.ShowNewFolderButton = $true
[void]$owner.Show()
[void]$owner.Activate()
$ok = $dialog.ShowDialog($owner)
$owner.Close()
if ($ok -eq [System.Windows.Forms.DialogResult]::OK) {
  [Console]::Out.Write($dialog.SelectedPath)
}
`.trim();

type ExecRunner = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;

function defaultExec(file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void): void {
  nodeExecFile(file, args, { timeout: options.timeout, encoding: "utf8" }, (error, stdout, stderr) => {
    callback(error, stdout ?? "", stderr ?? "");
  });
}

function runPicker(run: ExecRunner, file: string, args: string[], cancelled: (output: string) => boolean): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    run(file, args, { timeout: 10 * 60_000 }, (error, stdout, stderr) => {
      const output = `${stdout ?? ""}\n${stderr ?? ""}`;
      if (error) {
        if (cancelled(output)) return resolve(undefined);
        return reject(new Error(FAIL));
      }
      resolve((stdout ?? "").trim() || undefined);
    });
  });
}

/** System folder dialog. macOS uses `choose folder`; Windows uses the shell folder browser. */
export function chooseDirectory(overrides?: { platform?: NodeJS.Platform; execFile?: ExecRunner }): Promise<string | undefined> {
  const platform = overrides?.platform ?? process.platform;
  const run = overrides?.execFile ?? defaultExec;
  if (platform === "darwin") return runPicker(run, "osascript", ["-e", CHOOSE_DIRECTORY_SCRIPT], (output) => output.includes("-128") || /user canceled/i.test(output));
  if (platform === "win32") {
    const encoded = Buffer.from(WINDOWS_SCRIPT, "utf16le").toString("base64");
    return runPicker(run, "powershell.exe", ["-NoProfile", "-STA", "-EncodedCommand", encoded], () => false);
  }
  return Promise.reject(new Error("这个系统没有文件夹选择框，请手填目录路径"));
}
