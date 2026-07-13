import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { dataDir } from "../data-dir";
import type { LoadedProject, ProcessDef } from "../types";
import { DevWebUIFileSchema, ProcessSchema, type DevWebUIProcess } from "../../../shared/schema";

/**
 * Canonicalize a path for hashing/comparison: absolute, forward slashes (so an
 * identical path never hashes differently depending on which separator style it
 * was typed with), and lowercased ONLY on case-insensitive filesystems (Windows,
 * default macOS) — never on Linux, where `Foo` and `foo` are genuinely different
 * files. The single normalizer both projectIdFromPath and samePath below build on.
 */
function normalizePath(filePath: string): string {
  const abs = path.resolve(filePath).replace(/\\/g, "/");
  return process.platform === "linux" ? abs : abs.toLowerCase();
}

/** Stable id for a project, derived from its absolute path (survives restarts). */
export function projectIdFromPath(filePath: string): string {
  return `p${createHash("sha1").update(normalizePath(filePath)).digest("hex").slice(0, 8)}`;
}

/** Read + validate a .devwebui file into a registerable project. Throws on bad input. */
export function readDevWebUIFile(filePath: string): LoadedProject {
  const abs = path.resolve(filePath);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(abs, "utf8"));
  } catch (e) {
    throw new Error(`Could not read ${abs}: ${(e as Error).message}`);
  }
  const parsed = DevWebUIFileSchema.parse(raw);
  const id = projectIdFromPath(abs);
  const dir = path.dirname(abs);

  const seen = new Set<string>();
  const processes: ProcessDef[] = parsed.processes.map((p) => {
    if (seen.has(p.id)) throw new Error(`Duplicate process id "${p.id}" in ${abs}`);
    seen.add(p.id);
    return {
      id: `${id}.${p.id}`,
      localId: p.id,
      name: p.name,
      command: p.command,
      cwd: path.resolve(dir, p.cwd ?? "."),
      cwdRaw: p.cwd,
      color: p.color,
      env: p.env,
      autostart: p.autostart,
      starred: p.starred,
      port: p.port,
      url: p.url,
      runtime: p.runtime,
      waitForPort: p.waitForPort,
      links: p.links,
      companion: p.companion,
      projectId: id,
      projectName: parsed.name,
    };
  });

  return { id, name: parsed.name, color: parsed.color, path: abs, dir, processes };
}

// ---------------------------------------------------------------------------
// Edit the .devwebui file on disk (the source of truth) for GUI-driven changes.
// Every write is validated against the schema first, so the file is never left
// invalid. `localId` is the process `id` as written in the file.
// ---------------------------------------------------------------------------
function readRaw(filePath: string): { name: string; color?: string; processes: DevWebUIProcess[] } {
  const abs = path.resolve(filePath);
  return DevWebUIFileSchema.parse(JSON.parse(readFileSync(abs, "utf8")));
}

function writeRaw(filePath: string, data: unknown): void {
  const valid = DevWebUIFileSchema.parse(data);
  writeFileSync(path.resolve(filePath), `${JSON.stringify(valid, null, 2)}\n`);
}

function clean(proc: DevWebUIProcess): DevWebUIProcess {
  // Drop empty optional fields so the file stays tidy.
  const out: DevWebUIProcess = { id: proc.id, name: proc.name, command: proc.command };
  if (proc.cwd) out.cwd = proc.cwd;
  if (proc.color) out.color = proc.color;
  if (proc.env && Object.keys(proc.env).length) out.env = proc.env;
  if (proc.autostart) out.autostart = true;
  if (proc.starred) out.starred = true;
  if (proc.port) out.port = proc.port;
  if (proc.url) out.url = proc.url;
  if (proc.runtime) out.runtime = proc.runtime;
  if (proc.waitForPort !== undefined) out.waitForPort = proc.waitForPort;
  // De-dupe and drop self-references so a linked group never lists itself.
  const links = [...new Set(proc.links ?? [])].filter((l) => l !== proc.id);
  if (links.length) out.links = links;
  if (proc.companion) out.companion = true;
  return out;
}

export function addProcessToFile(filePath: string, proc: DevWebUIProcess): void {
  const raw = readRaw(filePath);
  if (raw.processes.some((p) => p.id === proc.id))
    throw new Error(`A process with id "${proc.id}" already exists in this project.`);
  raw.processes.push(clean(ProcessSchema.parse(proc)));
  writeRaw(filePath, raw);
}

export function updateProcessInFile(
  filePath: string,
  localId: string,
  proc: DevWebUIProcess,
): void {
  const raw = readRaw(filePath);
  const i = raw.processes.findIndex((p) => p.id === localId);
  if (i < 0) throw new Error(`Process "${localId}" not found.`);
  if (proc.id !== localId && raw.processes.some((p) => p.id === proc.id))
    throw new Error(`A process with id "${proc.id}" already exists in this project.`);
  const parsed = ProcessSchema.parse(proc);
  const env = Object.hasOwn(proc, "env") ? parsed.env : raw.processes[i].env;
  raw.processes[i] = clean({ ...parsed, env });
  // An id rename would dangle every sibling's link to the old id — follow the rename.
  if (proc.id !== localId) {
    raw.processes = raw.processes.map((p) =>
      p.links?.includes(localId)
        ? clean({ ...p, links: p.links.map((l) => (l === localId ? proc.id : l)) })
        : p,
    );
  }
  writeRaw(filePath, raw);
}

export function removeProcessFromFile(filePath: string, localId: string): void {
  const raw = readRaw(filePath);
  if (raw.processes.length <= 1)
    throw new Error("A project needs at least one process — remove the whole project instead.");
  raw.processes = raw.processes
    .filter((p) => p.id !== localId)
    // Prune links that pointed at the removed process (clean() drops emptied arrays).
    .map((p) =>
      p.links?.includes(localId) ? clean({ ...p, links: p.links.filter((l) => l !== localId) }) : p,
    );
  writeRaw(filePath, raw);
}

/** Set (or clear) one process's starred flag — starred processes float to the top. */
export function setProcessStarred(filePath: string, localId: string, starred: boolean): void {
  const raw = readRaw(filePath);
  const i = raw.processes.findIndex((p) => p.id === localId);
  if (i < 0) throw new Error(`Process "${localId}" not found.`);
  raw.processes[i] = clean({ ...raw.processes[i], starred });
  writeRaw(filePath, raw);
}

/**
 * Update a project's top-level metadata (rename + recolor) in place, leaving its
 * processes untouched. A provided-but-empty `name` is rejected (the schema needs a
 * non-empty name); an empty/omitted `color` clears the key so the file stays tidy
 * and the GUI falls back to the theme accent.
 */
export function updateProjectMeta(filePath: string, meta: { name?: string; color?: string }): void {
  const raw = readRaw(filePath);
  if (meta.name !== undefined) {
    const name = meta.name.trim();
    if (!name) throw new Error("A project name can't be empty.");
    raw.name = name;
  }
  if (meta.color !== undefined) {
    const color = meta.color.trim();
    if (color) raw.color = color;
    else delete raw.color;
  }
  writeRaw(filePath, raw);
}

// ---------------------------------------------------------------------------
// Registry — the list of loaded .devwebui files, persisted across restarts so
// DevWebUI auto-loads your codebases on launch.
// ---------------------------------------------------------------------------
const registryFile = (): string => path.join(dataDir(), "registry.json");

export function readRegistry(): string[] {
  try {
    const r = JSON.parse(readFileSync(registryFile(), "utf8"));
    return Array.isArray(r.projects) ? r.projects.map(String) : [];
  } catch {
    return [];
  }
}

function writeRegistry(paths: string[]): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(registryFile(), JSON.stringify({ projects: paths }, null, 2));
}

const samePath = (a: string, b: string) => normalizePath(a) === normalizePath(b);

export function registryAdd(filePath: string): void {
  const abs = path.resolve(filePath);
  const list = readRegistry();
  if (!list.some((x) => samePath(x, abs))) {
    list.push(abs);
    writeRegistry(list);
  }
}

export function registryRemove(filePath: string): void {
  writeRegistry(readRegistry().filter((x) => !samePath(x, filePath)));
}

// ---------------------------------------------------------------------------
// Ignore list — detected (not-yet-added) project folders the user dismissed, so
// the background scan stops surfacing them. Keyed by absolute directory path,
// the same space as the registry. Deliberately its OWN file, NOT `scanExclude`:
// the scan still walks into these folders, so the "show ignored" toggle can
// reveal them and un-ignoring is instant.
// ---------------------------------------------------------------------------
const ignoredFile = (): string => path.join(dataDir(), "ignored.json");

export function readIgnoredProjects(): string[] {
  try {
    const r = JSON.parse(readFileSync(ignoredFile(), "utf8"));
    return Array.isArray(r.ignored) ? r.ignored.map(String) : [];
  } catch {
    return [];
  }
}

function writeIgnoredProjects(dirs: string[]): void {
  mkdirSync(dataDir(), { recursive: true });
  writeFileSync(ignoredFile(), JSON.stringify({ ignored: dirs }, null, 2));
}

export function ignoreProject(dir: string): void {
  const abs = path.resolve(dir);
  const list = readIgnoredProjects();
  if (!list.some((x) => samePath(x, abs))) {
    list.push(abs);
    writeIgnoredProjects(list);
  }
}

export function unignoreProject(dir: string): void {
  writeIgnoredProjects(readIgnoredProjects().filter((x) => !samePath(x, dir)));
}
