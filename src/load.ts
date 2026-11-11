import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";
import type { Infra } from "./types.ts";
import { InfraError, validate } from "./validate.ts";

export const DEFAULT_FILES = ["infra.ts", "infra.mts", "infra.js", "infra.mjs", "infra.yaml", "infra.yml", "infra.json"];

export function findDefinition(dir = process.cwd()): string {
  const found = DEFAULT_FILES.map((f) => join(dir, f)).find((p) => existsSync(p));
  if (!found) throw new Error(`no definition found; create one of ${DEFAULT_FILES.join(", ")} or pass a path`);
  return found;
}

/** Reads a definition (`.ts`/`.js` default export, or YAML/JSON), checks it and reads the files it points to. */
export async function loadInfra(path: string): Promise<Infra> {
  const abs = resolve(path);
  const ext = extname(abs);
  let raw: unknown;
  if ([".ts", ".mts", ".js", ".mjs"].includes(ext)) {
    let mod: { default?: unknown };
    try {
      mod = await import(pathToFileURL(abs).href);
    } catch (e) {
      if (ext === ".ts" && /outside a module|Unexpected token 'export'/.test(String(e))) {
        throw new Error(
          `${path} was loaded as CommonJS. Rename it to infra.mts, or set "type": "module" in package.json`,
        );
      }
      throw e;
    }
    raw = mod.default;
    if (raw === undefined) throw new Error(`${path} has no default export (export default defineInfra({...}))`);
  } else {
    const text = readFileSync(abs, "utf8");
    try {
      raw = ext === ".json" ? JSON.parse(text) : parseYaml(text);
    } catch (e) {
      throw new Error(`${path} could not be parsed: ${(e as Error).message}`);
    }
  }
  try {
    return resolveFiles(validate(raw), dirname(abs));
  } catch (e) {
    if (e instanceof InfraError) throw new InfraError(e.problems.map((p) => `${path}: ${p}`));
    throw e;
  }
}

/** Replaces `userDataFile` and a key path in `sshKey` with their contents, relative to `baseDir`. */
export function resolveFiles(infra: Infra, baseDir: string): Infra {
  const read = (p: string, what: string) => {
    const full = p.startsWith("~/") ? join(homedir(), p.slice(2)) : isAbsolute(p) ? p : join(baseDir, p);
    try {
      return readFileSync(full, "utf8");
    } catch {
      throw new Error(`${what}: cannot read ${full}`);
    }
  };
  let sshKey = infra.sshKey?.trim();
  if (sshKey && !/^(ssh-|ecdsa-|sk-)/.test(sshKey)) sshKey = read(sshKey, "sshKey").trim();
  return {
    ...infra,
    sshKey,
    instances: infra.instances?.map((i) => {
      if (i.userDataFile === undefined) return i;
      const { userDataFile, ...rest } = i;
      return { ...rest, userData: read(userDataFile, `instance ${i.name}.userDataFile`) };
    }),
  };
}
