import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

/** Read requested file effects; null means the file does not exist. */
export async function readFileEffects(root: string, paths: string[]) {
  return Object.fromEntries(await Promise.all(paths.map(async (path) => {
    try { return [path, await readFile(join(root, path), "utf8")]; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [path, null];
      throw error;
    }
  })));
}

export type WorkspaceFixture = AsyncDisposable & {
  root: string;
  writeFiles(files: Record<string, string>): Promise<void>;
};

/** Real paths and OS semantics, with cleanup even when seeding fails. */
export async function createWorkspace(options: {
  prefix?: string;
  files?: Record<string, string>;
} = {}): Promise<WorkspaceFixture> {
  const root = await realpath(await mkdtemp(join(tmpdir(), options.prefix ?? "pi-resolve-")));
  const workspace: WorkspaceFixture = {
    root,
    async writeFiles(files) {
      for (const [path, content] of Object.entries(files)) {
        await mkdir(dirname(join(root, path)), { recursive: true });
        await writeFile(join(root, path), content);
      }
    },
    async [Symbol.asyncDispose]() {
      await rm(root, { recursive: true, force: true });
    },
  };
  try {
    await workspace.writeFiles(options.files ?? {});
    return workspace;
  } catch (error) {
    await workspace[Symbol.asyncDispose]();
    throw error;
  }
}
