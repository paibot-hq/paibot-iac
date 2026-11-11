/** A small builder for Terraform / OpenTofu JSON configuration (`*.tf.json`). */

type Json = null | boolean | number | string | Json[] | { [k: string]: Json | undefined };
export type Body = { [k: string]: Json | undefined };

export class TfDoc {
  private root: Record<string, Record<string, unknown>> = {};

  private section(name: string): Record<string, unknown> {
    return (this.root[name] ??= {});
  }

  terraform(body: Body): this {
    Object.assign(this.section("terraform"), body);
    return this;
  }

  provider(name: string, body: Body): this {
    this.section("provider")[name] = body;
    return this;
  }

  /** Adds a resource and returns its address, e.g. `aws_vpc.main`. */
  resource(type: string, name: string, body: Body): string {
    const byType = (this.section("resource")[type] ??= {}) as Record<string, unknown>;
    if (byType[name]) throw new Error(`internal: resource ${type}.${name} added twice`);
    byType[name] = clean(body);
    return `${type}.${name}`;
  }

  /** Adds a data source once and returns its address, e.g. `data.aws_ami.ubuntu_2404`. */
  data(type: string, name: string, body: Body): string {
    const byType = (this.section("data")[type] ??= {}) as Record<string, unknown>;
    byType[name] ??= clean(body);
    return `data.${type}.${name}`;
  }

  output(name: string, value: string, description?: string): this {
    this.section("output")[name] = clean({ value, description });
    return this;
  }

  /** Deep-merges raw tf.json (from `extra`) on top. */
  merge(extra: Record<string, unknown>): this {
    deepMerge(this.root, extra);
    return this;
  }

  toJSON(): unknown {
    return this.root;
  }
}

/** An expression: `ref("aws_vpc.main.id")` → `"${aws_vpc.main.id}"`. */
export function ref(expr: string): string {
  return "${" + expr + "}";
}

/** Escapes user text so `${` and `%{` stay literal instead of becoming template syntax. */
export function lit(s: string): string {
  // Replacement functions, because "$$" in a replacement string means a single "$".
  return s.replace(/\$\{/g, () => "$${").replace(/%\{/g, () => "%%{");
}

/** Terraform resource names allow letters, digits, `_` and `-`; we join our names with `_`. */
export function id(...parts: string[]): string {
  return parts.join("_");
}

function clean(body: Body): Body {
  const out: Body = {};
  for (const [k, v] of Object.entries(body)) if (v !== undefined) out[k] = v;
  return out;
}

function deepMerge(target: Record<string, unknown>, src: Record<string, unknown>) {
  for (const [k, v] of Object.entries(src)) {
    const cur = target[k];
    if (isPlain(cur) && isPlain(v)) deepMerge(cur, v);
    else target[k] = v;
  }
}

function isPlain(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
