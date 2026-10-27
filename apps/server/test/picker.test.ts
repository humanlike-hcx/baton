import { describe, expect, it } from "vitest";
import { chooseDirectory } from "../src/picker.ts";

type Run = (file: string, args: string[], options: { timeout: number }, callback: (error: Error | null, stdout: string, stderr: string) => void) => void;

function scripted(result: { error?: Error; stdout?: string; stderr?: string }, seen: { file?: string; args?: string[] }): Run {
  return (file, args, _options, callback) => {
    seen.file = file;
    seen.args = args;
    callback(result.error ?? null, result.stdout ?? "", result.stderr ?? "");
  };
}

describe("system folder dialog (US-97)", () => {
  it("asks Windows PowerShell for a folder and treats an empty result as cancel", async () => {
    const seen: { file?: string; args?: string[] } = {};
    const picked = await chooseDirectory({ platform: "win32", execFile: scripted({ stdout: "D:\\work\\proj\r\n" }, seen) });
    expect(picked).toBe("D:\\work\\proj");
    expect(seen.file).toBe("powershell.exe");
    expect(seen.args?.slice(0, 3)).toEqual(["-NoProfile", "-STA", "-EncodedCommand"]);
    const script = Buffer.from(seen.args![3]!, "base64").toString("utf16le");
    expect(script).toContain("FolderBrowserDialog");
    expect(script).toContain("ShowNewFolderButton = $true");
    expect(script).toContain("选择要在 Baton 里打开的项目目录");

    const cancelled = await chooseDirectory({ platform: "win32", execFile: scripted({ stdout: "  \n" }, seen) });
    expect(cancelled).toBeUndefined();
    await expect(chooseDirectory({ platform: "win32", execFile: scripted({ error: new Error("powershell missing") }, seen) })).rejects.toThrow("手填目录路径");
  });

  it("keeps the macOS folder dialog and still refuses other systems", async () => {
    const seen: { file?: string; args?: string[] } = {};
    const picked = await chooseDirectory({ platform: "darwin", execFile: scripted({ stdout: "/Users/me/proj/\n" }, seen) });
    expect(picked).toBe("/Users/me/proj/");
    expect(seen.file).toBe("osascript");
    expect(seen.args?.[1]).toContain("choose folder");
    expect(seen.args?.[1]).toContain("Finder");

    const cancelled = await chooseDirectory({
      platform: "darwin",
      execFile: scripted({ error: new Error("cancelled"), stderr: "execution error: User canceled. (-128)" }, seen),
    });
    expect(cancelled).toBeUndefined();
    await expect(chooseDirectory({ platform: "linux", execFile: scripted({}, seen) })).rejects.toThrow("这个系统没有文件夹选择框");
  });
});
