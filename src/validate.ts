import { image, machineType, IMAGES, RUNTIMES, SIZES } from "./catalog.ts";
import { CLOUDS, type Cloud, type Infra, type Instance, type Network, type Subnet } from "./types.ts";

export class InfraError extends Error {
  readonly problems: string[];
  constructor(problems: string[]) {
    super(problems.map((p) => `  - ${p}`).join("\n"));
    this.name = "InfraError";
    this.problems = problems;
  }
}

type Obj = Record<string, unknown>;

/**
 * Checks the shape (for YAML/JSON input) and the meaning (for every input) of a definition.
 * Collects every problem instead of stopping at the first.
 */
export function validate(input: unknown): Infra {
  const p: string[] = [];
  const err = (msg: string) => p.push(msg);

  if (!isObj(input)) throw new InfraError(["the definition must be an object"]);
  keys(input, "definition", ["name", "targets", "sshKey", "networks", "instances", "buckets", "functions", "extra"], err);
  str(input.name, "name", err) && checkName("name", input.name as string, err);

  const targets = arr(input.targets, "targets", err);
  if (targets && targets.length === 0) err("`targets` is empty: list at least one of aws, gcp, azure");
  const labels = new Set<string>();
  targets?.forEach((t, i) => {
    const at = `targets[${i}]`;
    if (!isObj(t)) return err(`${at} must be an object`);
    keys(t, at, ["name", "cloud", "region", "project", "zone"], err);
    if (!CLOUDS.includes(t.cloud as Cloud)) err(`${at}.cloud must be one of ${CLOUDS.join(", ")}`);
    str(t.region, `${at}.region`, err);
    optStr(t.project, `${at}.project`, err);
    optStr(t.zone, `${at}.zone`, err);
    optStr(t.name, `${at}.name`, err);
    const label = (t.name as string | undefined) ?? (t.cloud as string);
    if (typeof label === "string") {
      checkName(`${at}.name`, label, err);
      if (labels.has(label)) err(`two targets are both named \`${label}\`; give one a \`name\``);
      labels.add(label);
    }
    if (t.cloud === "gcp" && !t.project) err(`${at}: gcp needs \`project\``);
  });
  const clouds = new Set((targets ?? []).filter(isObj).map((t) => t.cloud as Cloud));

  optStr(input.sshKey, "sshKey", err);

  // networks
  const networks = (input.networks === undefined ? [] : arr(input.networks, "networks", err)) ?? [];
  const netByName = new Map<string, Network>();
  networks.forEach((n, i) => {
    const at = `networks[${i}]`;
    if (!isObj(n)) return err(`${at} must be an object`);
    keys(n, at, ["name", "cidr", "nat", "subnets"], err);
    if (!str(n.name, `${at}.name`, err)) return;
    const name = n.name as string;
    checkName(`network ${name}`, name, err);
    if (netByName.has(name)) err(`network \`${name}\` is defined twice`);
    netByName.set(name, n as unknown as Network);
    optBool(n.nat, `network ${name}.nat`, err);
    const outer = str(n.cidr, `network ${name}.cidr`, err) ? cidr(n.cidr as string, `network ${name}`, err) : undefined;
    const subnets = arr(n.subnets, `network ${name}.subnets`, err) ?? [];
    if (subnets.length === 0) err(`network \`${name}\` has no subnets`);
    const seen: { name: string; r: Range }[] = [];
    subnets.forEach((s, j) => {
      const sat = `network ${name}.subnets[${j}]`;
      if (!isObj(s)) return err(`${sat} must be an object`);
      keys(s, sat, ["name", "cidr", "public"], err);
      optBool(s.public, `${sat}.public`, err);
      if (!str(s.name, `${sat}.name`, err) || !str(s.cidr, `${sat}.cidr`, err)) return;
      const sname = `${name}/${s.name}`;
      checkName(`subnet ${sname}`, s.name as string, err);
      if (seen.some((x) => x.name === s.name)) err(`subnet \`${sname}\` is defined twice`);
      const r = cidr(s.cidr as string, `subnet ${sname}`, err);
      if (!r) return;
      if (outer && (r[0] < outer[0] || r[1] > outer[1])) err(`subnet ${sname} (${s.cidr}) is outside ${name} (${n.cidr})`);
      const clash = seen.find((x) => r[0] <= x.r[1] && x.r[0] <= r[1]);
      if (clash) err(`subnets ${sname} and ${name}/${clash.name} overlap`);
      seen.push({ name: s.name as string, r });
    });
    if (n.nat && !subnets.some((s) => isObj(s) && s.public)) {
      err(`network \`${name}\` has \`nat: true\` but no public subnet to put the NAT in`);
    }
  });

  // instances
  const instances = (input.instances === undefined ? [] : arr(input.instances, "instances", err)) ?? [];
  const instNames = new Set<string>();
  instances.forEach((inst, i) => {
    const at = `instances[${i}]`;
    if (!isObj(inst)) return err(`${at} must be an object`);
    keys(
      inst,
      at,
      ["name", "size", "image", "subnet", "diskGb", "publicIp", "ingress", "userData", "userDataFile", "overrides"],
      err,
    );
    if (!str(inst.name, `${at}.name`, err)) return;
    const name = inst.name as string;
    const it = `instance ${name}`;
    checkName(it, name, err);
    if (instNames.has(name)) err(`instance \`${name}\` is defined twice`);
    instNames.add(name);
    optStr(inst.size, `${it}.size`, err);
    optStr(inst.image, `${it}.image`, err);
    optStr(inst.userData, `${it}.userData`, err);
    optStr(inst.userDataFile, `${it}.userDataFile`, err);
    optBool(inst.publicIp, `${it}.publicIp`, err);
    if (inst.userData !== undefined && inst.userDataFile !== undefined) err(`${it}: set userData or userDataFile, not both`);
    if (inst.diskGb !== undefined && (!Number.isInteger(inst.diskGb) || (inst.diskGb as number) < 10)) {
      err(`${it}.diskGb must be a whole number of at least 10`);
    }

    if (str(inst.subnet, `${it}.subnet`, err)) {
      const sub = locate(netByName, inst.subnet as string);
      if (!sub) err(`${it}: subnet \`${inst.subnet}\` not found (write it as network/subnet)`);
      else if (inst.publicIp && !sub.public) {
        err(`${it}: \`publicIp: true\` needs a public subnet, but ${inst.subnet} is private`);
      }
    }

    const overrides = inst.overrides;
    if (overrides !== undefined) {
      if (!isObj(overrides)) err(`${it}.overrides must be an object`);
      else {
        keys(overrides, `${it}.overrides`, [...CLOUDS], err);
        for (const [c, o] of Object.entries(overrides)) {
          if (!isObj(o)) err(`${it}.overrides.${c} must be an object`);
          else {
            keys(o, `${it}.overrides.${c}`, ["type", "image"], err);
            optStr(o.type, `${it}.overrides.${c}.type`, err);
            optStr(o.image, `${it}.overrides.${c}.image`, err);
          }
        }
      }
    }
    const ov = (c: Cloud) => (isObj(overrides) && isObj(overrides[c]) ? (overrides[c] as Obj) : {});
    for (const c of clouds) {
      if (!ov(c).type) {
        if (typeof inst.size !== "string") err(`${it}: set \`size\`, or \`overrides.${c}.type\``);
        else if (!machineType(c, inst.size)) {
          err(`${it}: unknown size \`${inst.size}\` (${SIZES.map((s) => s.name).join(", ")})`);
        }
      }
      const img = (inst.image as string | undefined) ?? "ubuntu-24.04";
      if (!ov(c).image && !image(img)) {
        err(`${it}: \`${img}\` is not a common image (${IMAGES.map((x) => x.name).join(", ")}); set \`overrides.${c}.image\``);
      }
    }

    if (inst.ingress !== undefined) {
      (arr(inst.ingress, `${it}.ingress`, err) ?? []).forEach((r, k) => {
        const rat = `${it}.ingress[${k}]`;
        if (!isObj(r)) return err(`${rat} must be an object`);
        keys(r, rat, ["protocol", "ports", "from"], err);
        if (r.protocol !== undefined && r.protocol !== "tcp" && r.protocol !== "udp") err(`${rat}.protocol must be tcp or udp`);
        const ports = arr(r.ports, `${rat}.ports`, err);
        if (ports?.length === 0) err(`${rat}.ports is empty`);
        ports?.forEach((x) => portRange(x, rat, err));
        const from = arr(r.from, `${rat}.from`, err);
        if (from?.length === 0) err(`${rat}.from is empty`);
        from?.forEach((f) => (typeof f === "string" ? cidr(f, `${rat}.from`, err) : err(`${rat}.from must be CIDR strings`)));
      });
    }
  });
  if (clouds.has("azure") && instances.length > 0 && !input.sshKey) {
    err("azure VMs need `sshKey` (password login is never generated)");
  }

  // functions
  const functions = (input.functions === undefined ? [] : arr(input.functions, "functions", err)) ?? [];
  const fnNames = new Set<string>();
  functions.forEach((f, i) => {
    const at = `functions[${i}]`;
    if (!isObj(f)) return err(`${at} must be an object`);
    keys(f, at, ["name", "source", "runtime", "command", "memoryMb", "timeoutSeconds", "env", "access", "subnet"], err);
    if (!str(f.name, `${at}.name`, err)) return;
    const name = f.name as string;
    const ft = `function ${name}`;
    checkName(ft, name, err);
    if (fnNames.has(name)) err(`function \`${name}\` is defined twice`);
    fnNames.add(name);
    str(f.source, `${ft}.source`, err);
    if (!RUNTIMES.some((r) => r.name === f.runtime)) err(`${ft}.runtime must be one of ${RUNTIMES.map((r) => r.name).join(", ")}`);
    const cmd = arr(f.command, `${ft}.command`, err);
    if (cmd && (cmd.length === 0 || cmd.some((c) => typeof c !== "string" || c === ""))) {
      err(`${ft}.command must be a non-empty list of strings, e.g. ["node", "server.js"]`);
    }
    if (f.memoryMb !== undefined && (!Number.isInteger(f.memoryMb) || (f.memoryMb as number) < 512 || (f.memoryMb as number) > 4096)) {
      err(`${ft}.memoryMb must be a whole number from 512 to 4096`);
    }
    if (
      f.timeoutSeconds !== undefined &&
      (!Number.isInteger(f.timeoutSeconds) || (f.timeoutSeconds as number) < 1 || (f.timeoutSeconds as number) > 900)
    ) {
      err(`${ft}.timeoutSeconds must be a whole number from 1 to 900`);
    }
    if (f.env !== undefined) {
      if (!isObj(f.env)) err(`${ft}.env must be a map of strings`);
      else
        for (const [k, v] of Object.entries(f.env)) {
          if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(k)) err(`${ft}.env: \`${k}\` is not a valid variable name`);
          if (k === "PORT" || k.startsWith("AWS_") || k.startsWith("FUNCTIONS_")) err(`${ft}.env: \`${k}\` is set by the platform`);
          if (typeof v !== "string") err(`${ft}.env.${k} must be a string`);
        }
    }
    const access = (f.access as string | undefined) ?? "iam";
    if (!["public", "iam", "private"].includes(access)) err(`${ft}.access must be public, iam or private`);
    optStr(f.subnet, `${ft}.subnet`, err);
    if (typeof f.subnet === "string") {
      if (!locate(netByName, f.subnet)) err(`${ft}: subnet \`${f.subnet}\` not found (write it as network/subnet)`);
    } else if (access === "private") {
      err(`${ft}: \`access: private\` needs \`subnet\` (the network it can be called from)`);
    }

    if (clouds.has("aws") && access === "private" && typeof f.subnet === "string") {
      const net = netByName.get(f.subnet.split("/")[0]);
      const sub = locate(netByName, f.subnet);
      const same = net?.subnets?.filter((s) => isObj(s) && !!s.public === !!sub?.public) ?? [];
      if (sub && same.length < 2) {
        err(
          `${ft}: on aws a private function sits behind an internal load balancer, which needs two ` +
            `${sub.public ? "public" : "private"} subnets in \`${f.subnet.split("/")[0]}\``,
        );
      }
      if (typeof input.name === "string" && `${input.name}-${name}`.length > 32) {
        err(`${ft}: on aws the load balancer name \`${input.name}-${name}\` must be 32 characters or fewer`);
      }
    }
    if (clouds.has("azure")) {
      if (access !== "public") {
        err(`${ft}: \`access: ${access}\` is not supported on azure yet (only public)`);
      }
      if (typeof f.subnet === "string") {
        const used = instances.find((x) => isObj(x) && x.subnet === f.subnet);
        if (used) {
          err(`${ft}: on azure a function's subnet is reserved for functions, but instance ${(used as Obj).name} is also in ${f.subnet}`);
        }
      }
    }
  });
  if (clouds.has("gcp") && functions.length && typeof input.name === "string") {
    for (const t of (targets ?? []).filter((t) => isObj(t) && t.cloud === "gcp") as Obj[]) {
      const bucket = `${t.project}-${input.name}-src`;
      if (bucket.length > 63) err(`on gcp the function source bucket \`${bucket}\` would be longer than 63 characters`);
    }
  }

  // buckets
  const buckets = (input.buckets === undefined ? [] : arr(input.buckets, "buckets", err)) ?? [];
  const bucketNames = new Set<string>();
  buckets.forEach((b, i) => {
    const at = `buckets[${i}]`;
    if (!isObj(b)) return err(`${at} must be an object`);
    keys(b, at, ["name", "versioning"], err);
    optBool(b.versioning, `${at}.versioning`, err);
    if (!str(b.name, `${at}.name`, err)) return;
    const name = b.name as string;
    if (!/^[a-z0-9][a-z0-9-]{1,61}[a-z0-9]$/.test(name)) err(`bucket \`${name}\`: use 3-63 lowercase letters, digits and hyphens`);
    if (bucketNames.has(name)) err(`bucket \`${name}\` is defined twice`);
    bucketNames.add(name);
    if (clouds.has("azure")) {
      const acct = azureAccountName(name);
      if (acct.length < 3 || acct.length > 24) {
        err(`bucket ${name}: on azure the storage account would be \`${acct}\`, which must be 3-24 letters and digits`);
      }
    }
  });

  if (input.extra !== undefined) {
    if (!isObj(input.extra)) err("`extra` must be an object");
    else
      for (const [c, v] of Object.entries(input.extra)) {
        if (!CLOUDS.includes(c as Cloud)) err(`extra.${c}: unknown cloud`);
        else if (!clouds.has(c as Cloud)) err(`\`extra.${c}\` is set, but there is no ${c} target`);
        if (!isObj(v)) err(`extra.${c} must be an object (tf.json)`);
      }
  }

  if (p.length) throw new InfraError(p);
  return input as unknown as Infra;
}

export function azureAccountName(bucket: string): string {
  return bucket.replace(/[^a-z0-9]/g, "");
}

export function locate(nets: Map<string, Network> | Network[], path: string): Subnet | undefined {
  const [n, s, ...rest] = path.split("/");
  if (rest.length) return undefined;
  const net = Array.isArray(nets) ? nets.find((x) => x.name === n) : nets.get(n);
  return Array.isArray(net?.subnets) ? net.subnets.find((x) => x?.name === s) : undefined;
}

export function splitSubnet(path: string): [string, string] {
  const [n, s] = path.split("/");
  return [n, s];
}

export function instanceSubnet(infra: Infra, inst: Instance): Subnet {
  return locate(infra.networks ?? [], inst.subnet)!;
}

type Range = [number, number];

/** Parses an IPv4 CIDR into its first and last address. */
export function cidr(s: string, at: string, err: (m: string) => void): Range | undefined {
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\/(\d{1,2})$/.exec(s);
  if (!m) return void err(`${at}: \`${s}\` is not an IPv4 CIDR like 10.0.0.0/16`);
  const octets = m.slice(1, 5).map(Number);
  const len = Number(m[5]);
  if (octets.some((o) => o > 255) || len > 32) return void err(`${at}: \`${s}\` is not a valid CIDR`);
  const ip = octets.reduce((a, o) => a * 256 + o, 0);
  const size = 2 ** (32 - len);
  if (ip % size !== 0) {
    const base = ip - (ip % size);
    const dotted = [24, 16, 8, 0].map((sh) => Math.floor(base / 2 ** sh) % 256).join(".");
    return void err(`${at}: \`${s}\` has host bits set; did you mean ${dotted}/${len}?`);
  }
  return [ip, ip + size - 1];
}

export function portRange(x: unknown, at: string, err: (m: string) => void = () => {}): [number, number] | undefined {
  const ok = (n: number) => Number.isInteger(n) && n >= 1 && n <= 65535;
  if (typeof x === "number") return ok(x) ? [x, x] : void err(`${at}: port ${x} is out of range`);
  if (typeof x === "string") {
    const m = /^(\d+)(?:-(\d+))?$/.exec(x.trim());
    if (m) {
      const a = Number(m[1]);
      const b = Number(m[2] ?? m[1]);
      if (ok(a) && ok(b) && a <= b) return [a, b];
    }
  }
  return void err(`${at}: \`${String(x)}\` is not a port or a range like 8000-8100`);
}

function checkName(what: string, s: string, err: (m: string) => void) {
  if (!/^[a-z](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(s)) {
    err(`${what} \`${s}\`: use lowercase letters, digits and hyphens, starting with a letter (max 40)`);
  }
}

function isObj(x: unknown): x is Obj {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}
function keys(o: Obj, at: string, allowed: string[], err: (m: string) => void) {
  for (const k of Object.keys(o)) if (!allowed.includes(k)) err(`${at}: unknown key \`${k}\` (allowed: ${allowed.join(", ")})`);
}
function str(x: unknown, at: string, err: (m: string) => void): boolean {
  if (typeof x === "string" && x.length > 0) return true;
  err(`${at} must be a non-empty string`);
  return false;
}
function optStr(x: unknown, at: string, err: (m: string) => void) {
  if (x !== undefined && typeof x !== "string") err(`${at} must be a string`);
}
function optBool(x: unknown, at: string, err: (m: string) => void) {
  if (x !== undefined && typeof x !== "boolean") err(`${at} must be true or false`);
}
function arr(x: unknown, at: string, err: (m: string) => void): unknown[] | undefined {
  if (Array.isArray(x)) return x;
  err(`${at} must be a list`);
  return undefined;
}
