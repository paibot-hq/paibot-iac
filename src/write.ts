import { chmodSync, cpSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { Output } from "./generate.ts";

const SKIP = new Set([".git", ".terraform", ".DS_Store"]);

/**
 * Writes `<outDir>/<target>/main.tf.json` and stages each function folder at `<outDir>/<target>/build/<name>`,
 * where Terraform zips it. Returns the target directories.
 */
export function writeOutputs(outputs: Output[], outDir: string): string[] {
  const outAbs = resolve(outDir);
  return outputs.map((o) => {
    const dir = join(outDir, o.target);
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "main.tf.json"), JSON.stringify(o.json, null, 2) + "\n");

    for (const p of o.packages) {
      const dest = resolve(dir, p.dir);
      // Only ever clear our own staging folder.
      if (!dest.startsWith(resolve(dir, "build") + sep)) throw new Error(`internal: bad package dir ${p.dir}`);
      rmSync(dest, { recursive: true, force: true });
      const src = resolve(p.source);
      cpSync(src, dest, {
        recursive: true,
        filter: (from) => {
          const abs = resolve(from);
          if (abs === outAbs || abs.startsWith(outAbs + sep)) return false; // out/ inside the source
          return !relative(src, abs).split(sep).some((part) => SKIP.has(part));
        },
      });
      for (const f of p.files) {
        const path = join(dest, f.path);
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, f.content);
        if (f.mode !== undefined) chmodSync(path, f.mode);
      }
    }
    return dir;
  });
}
