import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { scanForDevWebUI } from "../server/src/scan";

async function withTempDir(fn: (dir: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "devwebui-scan-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("scanForDevWebUI keeps package detection opt-in", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "next-site", scripts: { dev: "next dev" } }, null, 2)}\n`,
    );

    const result = await scanForDevWebUI({
      roots: [dir],
      maxDepth: 1,
      budgetMs: 5000,
      limit: 10,
    });

    expect(result.files).toEqual([]);
    expect(result.detected).toEqual([]);
  });
});

test("scanForDevWebUI can discover unconfigured dev-script projects", async () => {
  await withTempDir(async (dir) => {
    const app = path.join(dir, "app");
    await mkdir(app);
    await writeFile(
      path.join(app, "package.json"),
      `${JSON.stringify({ name: "react-app", scripts: { start: "react-scripts start" } }, null, 2)}\n`,
    );

    const result = await scanForDevWebUI({
      roots: [dir],
      maxDepth: 2,
      budgetMs: 5000,
      limit: 10,
      detectPackages: true,
    });

    expect(result.files).toEqual([]);
    expect(result.detected).toMatchObject([
      { path: app, name: "React App", framework: "React", processes: 1 },
    ]);
  });
});

test("scanForDevWebUI does not duplicate folders that already have a .devwebui", async () => {
  await withTempDir(async (dir) => {
    await writeFile(
      path.join(dir, "package.json"),
      `${JSON.stringify({ name: "configured", scripts: { dev: "webpack serve" } }, null, 2)}\n`,
    );
    await writeFile(
      path.join(dir, ".devwebui"),
      `${JSON.stringify(
        { name: "Configured", processes: [{ id: "dev", name: "Dev", command: "npm run dev" }] },
        null,
        2,
      )}\n`,
    );

    const result = await scanForDevWebUI({
      roots: [dir],
      maxDepth: 1,
      budgetMs: 5000,
      limit: 10,
      detectPackages: true,
    });

    expect(result.files).toHaveLength(1);
    expect(result.detected).toEqual([]);
  });
});
