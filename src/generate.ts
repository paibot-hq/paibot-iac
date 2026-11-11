import { aws } from "./clouds/aws.ts";
import { azure } from "./clouds/azure.ts";
import { gcp } from "./clouds/gcp.ts";
import type { Ctx, Package } from "./clouds/common.ts";
import type { TfDoc } from "./tf.ts";
import type { Cloud, Infra, Target } from "./types.ts";
import { validate } from "./validate.ts";

const BACKENDS: Record<Cloud, (ctx: Ctx) => TfDoc> = { aws, gcp, azure };

export interface Output {
  /** Target name: the output directory. */
  target: string;
  cloud: Cloud;
  /** Contents of `main.tf.json`. */
  json: unknown;
  /** Function folders to copy next to `main.tf.json` (see `writeOutputs`). */
  packages: Package[];
}

export function targetName(t: Target): string {
  return t.name ?? t.cloud;
}

/**
 * Turns a definition into one tf.json document per target.
 * `userDataFile` and a key path in `sshKey` must already be read (see `resolveFiles`).
 */
export function generate(infra: Infra, only?: string): Output[] {
  validate(infra);
  const targets = infra.targets.filter((t) => !only || targetName(t) === only);
  if (only && targets.length === 0) {
    throw new Error(`no target named \`${only}\` (have: ${infra.targets.map(targetName).join(", ")})`);
  }
  return targets.map((target) => {
    const packages: Package[] = [];
    const doc = BACKENDS[target.cloud]({ infra, target, packages });
    const extra = infra.extra?.[target.cloud];
    if (extra) doc.merge(extra);
    return { target: targetName(target), cloud: target.cloud, json: doc.toJSON(), packages };
  });
}
