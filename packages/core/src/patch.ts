export type PatchOp =
  | { type: "add"; path: string; content: string }
  | { type: "delete"; path: string }
  | { type: "update"; path: string; moveTo?: string; chunks: { oldLines: string[]; newLines: string[]; eof: boolean }[] };

export class PatchError extends Error {}

export function parsePatch(text: string): PatchOp[] {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  let i = 0;
  while (i < lines.length && lines[i]!.trim() === "") i++;
  if (lines[i]?.trim() !== "*** Begin Patch") throw new PatchError("补丁必须以 *** Begin Patch 开头");
  i++;
  const ops: PatchOp[] = [];
  while (i < lines.length) {
    const line = lines[i]!;
    if (line.trim() === "*** End Patch") return ops;
    if (line.startsWith("*** Add File: ")) {
      const path = line.slice("*** Add File: ".length).trim();
      i++;
      const content: string[] = [];
      while (i < lines.length && !lines[i]!.startsWith("*** ")) {
        const l = lines[i]!;
        if (!l.startsWith("+")) throw new PatchError(`Add File 的每一行都要以 + 开头（${path}）`);
        content.push(l.slice(1));
        i++;
      }
      ops.push({ type: "add", path, content: content.length ? `${content.join("\n")}\n` : "" });
      continue;
    }
    if (line.startsWith("*** Delete File: ")) {
      ops.push({ type: "delete", path: line.slice("*** Delete File: ".length).trim() });
      i++;
      continue;
    }
    if (line.startsWith("*** Update File: ")) {
      const path = line.slice("*** Update File: ".length).trim();
      i++;
      let moveTo: string | undefined;
      if (lines[i]?.startsWith("*** Move to: ")) {
        moveTo = lines[i]!.slice("*** Move to: ".length).trim();
        i++;
      }
      const chunks: { oldLines: string[]; newLines: string[]; eof: boolean }[] = [];
      let current: { oldLines: string[]; newLines: string[]; eof: boolean } | undefined;
      while (i < lines.length && !(lines[i]!.startsWith("*** ") && lines[i]!.trim() !== "*** End of File")) {
        const l = lines[i]!;
        if (l.startsWith("@@")) {
          current = { oldLines: [], newLines: [], eof: false };
          chunks.push(current);
        } else if (l.trim() === "*** End of File") {
          if (current) current.eof = true;
        } else {
          if (!current) {
            current = { oldLines: [], newLines: [], eof: false };
            chunks.push(current);
          }
          const tag = l[0];
          const body = l.slice(1);
          if (tag === "+") current.newLines.push(body);
          else if (tag === "-") current.oldLines.push(body);
          else if (tag === " " || l === "") {
            current.oldLines.push(body);
            current.newLines.push(body);
          } else throw new PatchError(`无法识别的补丁行：${l}`);
        }
        i++;
      }
      ops.push({ type: "update", path, moveTo, chunks: chunks.filter((c) => c.oldLines.length || c.newLines.length) });
      continue;
    }
    if (line.trim() === "") {
      i++;
      continue;
    }
    throw new PatchError(`无法识别的补丁行：${line}`);
  }
  throw new PatchError("补丁缺少 *** End Patch");
}

function findSequence(haystack: string[], needle: string[], from: number): number {
  const comparers: ((a: string, b: string) => boolean)[] = [
    (a, b) => a === b,
    (a, b) => a.trimEnd() === b.trimEnd(),
    (a, b) => a.trim() === b.trim(),
  ];
  for (const eq of comparers) {
    for (let start = from; start <= haystack.length - needle.length; start++) {
      let ok = true;
      for (let j = 0; j < needle.length; j++) {
        if (!eq(haystack[start + j]!, needle[j]!)) {
          ok = false;
          break;
        }
      }
      if (ok) return start;
    }
  }
  return -1;
}

export function applyChunks(original: string, chunks: { oldLines: string[]; newLines: string[]; eof: boolean }[], label: string): string {
  const hadTrailingNewline = original.endsWith("\n");
  const lines = original.split("\n");
  if (hadTrailingNewline) lines.pop();
  let cursor = 0;
  for (const chunk of chunks) {
    if (chunk.oldLines.length === 0) {
      const at = chunk.eof ? lines.length : cursor;
      lines.splice(at, 0, ...chunk.newLines);
      cursor = at + chunk.newLines.length;
      continue;
    }
    let start = findSequence(lines, chunk.oldLines, cursor);
    if (start < 0) start = findSequence(lines, chunk.oldLines, 0);
    if (start < 0) {
      throw new PatchError(`在 ${label} 中找不到要替换的内容：\n${chunk.oldLines.slice(0, 6).join("\n")}`);
    }
    lines.splice(start, chunk.oldLines.length, ...chunk.newLines);
    cursor = start + chunk.newLines.length;
  }
  return lines.join("\n") + (hadTrailingNewline || lines.length ? "\n" : "");
}
