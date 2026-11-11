import { machineType } from "../catalog.ts";
import type { Cloud, Infra, Instance, Network, Subnet, Target } from "../types.ts";
import { portRange } from "../validate.ts";

export interface Ctx {
  infra: Infra;
  target: Target;
}

export const TAGS = (infra: Infra) => ({ "managed-by": "paibot-iac", stack: infra.name });

export function typeFor(cloud: Cloud, inst: Instance): string {
  const t = inst.overrides?.[cloud]?.type ?? machineType(cloud, inst.size ?? "");
  if (!t) throw new Error(`internal: no machine type for ${inst.name} on ${cloud}`);
  return t;
}

export function imageName(inst: Instance): string {
  return inst.image ?? "ubuntu-24.04";
}

export function diskGb(inst: Instance): number {
  return inst.diskGb ?? 30;
}

export function subnetOf(infra: Infra, inst: Instance): { net: Network; sub: Subnet } {
  const [n, s] = inst.subnet.split("/");
  const net = (infra.networks ?? []).find((x) => x.name === n)!;
  return { net, sub: net.subnets.find((x) => x.name === s)! };
}

export interface FlatRule {
  protocol: "tcp" | "udp";
  from: number;
  to: number;
  cidrs: string[];
}

/** One entry per (rule, port range). */
export function flatIngress(inst: Instance): FlatRule[] {
  const out: FlatRule[] = [];
  for (const r of inst.ingress ?? []) {
    for (const p of r.ports) {
      const [from, to] = portRange(p, inst.name)!;
      out.push({ protocol: r.protocol ?? "tcp", from, to, cidrs: [...new Set(r.from)] });
    }
  }
  return out;
}

export function portString(r: FlatRule): string {
  return r.from === r.to ? String(r.from) : `${r.from}-${r.to}`;
}

export function userData(inst: Instance): string | undefined {
  if (inst.userDataFile !== undefined) {
    throw new Error(`instance ${inst.name}: userDataFile must be read first (use loadInfra or resolveFiles)`);
  }
  return inst.userData;
}

export function sshKey(infra: Infra): string | undefined {
  const k = infra.sshKey?.trim();
  if (k && !/^(ssh-|ecdsa-|sk-)/.test(k)) {
    throw new Error("sshKey must be read first (use loadInfra or resolveFiles)");
  }
  return k;
}

/** Terraform names must start with a letter or `_`; bucket names may start with a digit. */
export function bucketId(bucket: string): string {
  return /^[0-9]/.test(bucket) ? `_${bucket}` : bucket;
}
