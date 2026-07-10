import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { expect, test } from "bun:test";
import { detectProject } from "../server/src/detect";

async function withPackageJson(
  pkg: Record<string, unknown>,
  fn: (dir: string) => Promise<void>,
): Promise<void> {
  const dir = await mkdtemp(path.join(tmpdir(), "devwebui-detect-"));
  try {
    await writeFile(path.join(dir, "package.json"), `${JSON.stringify(pkg, null, 2)}\n`);
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

test("detectProject scaffolds a Next.js dev server", async () => {
  await withPackageJson(
    {
      name: "site",
      scripts: { dev: "next dev" },
    },
    async (dir) => {
      const detected = await detectProject(dir);
      expect(detected?.framework).toBe("Next.js");
      expect(detected?.processes).toMatchObject([
        { id: "dev", name: "Dev", command: "npm run dev", port: 3000 },
      ]);
    },
  );
});

test("detectProject scaffolds a React scripts server with the CRA default port", async () => {
  await withPackageJson(
    {
      name: "dashboard",
      scripts: { start: "react-scripts start" },
    },
    async (dir) => {
      const detected = await detectProject(dir);
      expect(detected?.framework).toBe("React");
      expect(detected?.processes).toMatchObject([
        { id: "start", name: "Start", command: "npm run start", port: 3000 },
      ]);
    },
  );
});

test("detectProject scaffolds a Webpack dev server and honors explicit ports", async () => {
  await withPackageJson(
    {
      name: "legacy-web",
      scripts: { dev: "webpack serve --mode development --port 8081" },
    },
    async (dir) => {
      const detected = await detectProject(dir);
      expect(detected?.framework).toBe("Webpack");
      expect(detected?.processes).toMatchObject([
        { id: "dev", name: "Dev", command: "npm run dev", port: 8081 },
      ]);
    },
  );
});
