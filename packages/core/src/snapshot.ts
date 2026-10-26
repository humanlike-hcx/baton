import { execFile } from "node:child_process";
import fs from "node:fs";
import { promisify } from "node:util";

const exec = promisify(execFile);

const EXCLUDES = [".git/", ".workbench/", "node_modules/", ".env", ".env.*", "dist/", ".next/"];

/** A git repository outside the user's own `.git`, with the workspace as work tree. */
export class ShadowGit {
  constructor(
    private readonly root: string,
    private readonly gitDir: string,
  ) {}

  private async git(args: string[], options: { allowFail?: boolean } = {}): Promise<string> {
    try {
      const { stdout } = await exec(
        "git",
        [`--git-dir=${this.gitDir}`, `--work-tree=${this.root}`, "-c", "core.autocrlf=false", "-c", "core.quotepath=false", ...args],
        {
          cwd: this.root,
          maxBuffer: 64 * 1024 * 1024,
          env: {
            ...process.env,
            GIT_AUTHOR_NAME: "workbench",
            GIT_AUTHOR_EMAIL: "workbench@localhost",
            GIT_COMMITTER_NAME: "workbench",
            GIT_COMMITTER_EMAIL: "workbench@localhost",
          },
        },
      );
      return stdout;
    } catch (error) {
      if (options.allowFail) return "";
      throw error;
    }
  }

  async init(): Promise<void> {
    if (!fs.existsSync(`${this.gitDir}/HEAD`)) {
      fs.mkdirSync(this.gitDir, { recursive: true });
      await this.git(["init", "-q"]);
    }
    fs.mkdirSync(`${this.gitDir}/info`, { recursive: true });
    fs.writeFileSync(`${this.gitDir}/info/exclude`, `${EXCLUDES.join("\n")}\n`);
  }

  /** Commits the current work tree state and returns the commit sha. */
  async snapshot(message: string): Promise<string> {
    await this.init();
    await this.git(["add", "-A", "."]);
    await this.git(["commit", "-q", "--allow-empty", "--no-verify", "-m", message]);
    return (await this.git(["rev-parse", "HEAD"])).trim();
  }

  async changedFiles(from: string, to?: string): Promise<string[]> {
    const args = to ? ["diff", "--name-only", from, to] : ["diff", "--name-only", from];
    if (!to) await this.git(["add", "-A", "-N", "."], { allowFail: true });
    const out = await this.git(args, { allowFail: true });
    return out.split("\n").filter(Boolean);
  }

  async diff(from: string, to?: string): Promise<string> {
    if (!to) await this.git(["add", "-A", "-N", "."], { allowFail: true });
    return this.git(to ? ["diff", from, to] : ["diff", from], { allowFail: true });
  }

  async diffStat(from: string): Promise<string> {
    await this.git(["add", "-A", "-N", "."], { allowFail: true });
    return (await this.git(["diff", "--stat", from], { allowFail: true })).trim();
  }

  /** Restores the work tree to the given snapshot, removing files created after it. */
  async rollback(sha: string): Promise<string[]> {
    await this.init();
    const changed = await this.changedFiles(sha);
    await this.git(["read-tree", "-u", "--reset", sha]);
    await this.git(["clean", "-fdq"], { allowFail: true });
    return changed;
  }
}
