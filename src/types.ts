/** The clouds Paibot IaC can generate for. */
export type Cloud = "aws" | "gcp" | "azure";
export const CLOUDS: readonly Cloud[] = ["aws", "gcp", "azure"];

/**
 * One cloud-neutral definition. Every target gets the same networks, instances and buckets,
 * with the same meaning: who can reach whom, and who can reach the internet.
 */
export interface Infra {
  /** Stack name. Lowercase letters, digits, hyphens. Used as a prefix for cloud resource names. */
  name: string;
  /** Where to generate for. Each target becomes `out/<target name>/main.tf.json`. */
  targets: Target[];
  /** Public key for the `ubuntu` user: the key itself (`ssh-ed25519 ...`) or a path to a `.pub` file. */
  sshKey?: string;
  networks?: Network[];
  instances?: Instance[];
  buckets?: Bucket[];
  /** HTTP servers run as serverless functions (AWS Lambda + Web Adapter, Cloud Run, Azure Functions). */
  functions?: Function[];
  /** Raw tf.json merged into one cloud's output, for what the common words cannot say. */
  extra?: Partial<Record<Cloud, Record<string, unknown>>>;
}

export interface Target {
  /** Output directory name. Defaults to the cloud name; set it to have two targets on one cloud. */
  name?: string;
  cloud: Cloud;
  /** AWS / GCP region, or Azure location. */
  region: string;
  /** GCP project id. Required for gcp. */
  project?: string;
  /** GCP zone for instances. Defaults to `<region>-a`. */
  zone?: string;
}

export interface Network {
  name: string;
  /** IPv4 range, e.g. `10.0.0.0/16`. Subnets must sit inside it. */
  cidr: string;
  /**
   * Let instances in private subnets reach the internet (outbound only) through a NAT.
   * The NAT is placed in the first public subnet, so one is required.
   */
  nat?: boolean;
  subnets: Subnet[];
}

export interface Subnet {
  name: string;
  cidr: string;
  /** Instances here may have a public IP. Without one they still cannot reach the internet. */
  public?: boolean;
}

export type Protocol = "tcp" | "udp";

export interface Rule {
  protocol?: Protocol;
  /** `22` or `"8000-8100"`. */
  ports: (number | string)[];
  /** IPv4 CIDRs allowed in, e.g. `0.0.0.0/0` or `10.0.0.0/16`. */
  from: string[];
}

export interface InstanceOverride {
  /** Native machine type, e.g. `g6.xlarge`, `a2-highgpu-1g`, `Standard_NC24ads_A100_v4`. */
  type?: string;
  /** Native image: an AMI id, a GCP image, or an Azure `publisher:offer:sku:version` / image id. */
  image?: string;
}

export interface Instance {
  name: string;
  /** Common size (see `paibot-iac sizes`). Optional when every target sets `overrides.<cloud>.type`. */
  size?: string;
  /** Common image. Defaults to `ubuntu-24.04`. */
  image?: string;
  /** `<network>/<subnet>` */
  subnet: string;
  /** Boot disk size. Defaults to 30. */
  diskGb?: number;
  /** Needs a public subnet. */
  publicIp?: boolean;
  /** Allowed inbound traffic. Everything else is denied, including from inside the network. */
  ingress?: Rule[];
  /** cloud-init user data (a shell script or `#cloud-config`), given inline. */
  userData?: string;
  /** cloud-init user data read from a file, relative to the definition file. */
  userDataFile?: string;
  overrides?: Partial<Record<Cloud, InstanceOverride>>;
}

export interface Bucket {
  /**
   * Globally unique on AWS and GCP. On Azure this becomes a storage account named without hyphens
   * (3-24 characters) holding one private container with this name.
   */
  name: string;
  versioning?: boolean;
}

export type Runtime = "node22" | "node24" | "python3.12";

/**
 * Who can call a function.
 * - `public`: anyone on the internet.
 * - `iam`: anyone on the internet whose request is signed by an identity allowed to call it.
 * - `private`: only from inside the function's network. There is no internet-facing entry at all.
 */
export type Access = "public" | "iam" | "private";

/**
 * A plain HTTP server, run as a serverless function. It must listen on `$PORT`.
 * The `source` folder is zipped as it is, so include dependencies (node_modules, vendored packages).
 */
export interface Function {
  name: string;
  /** Folder with the app, relative to the definition file. */
  source: string;
  runtime: Runtime;
  /** Start command, run from the folder root, e.g. `["node", "server.js"]`. */
  command: string[];
  /** 512 to 4096. Defaults to 512. */
  memoryMb?: number;
  /** Per request, 1 to 900. Defaults to 30. */
  timeoutSeconds?: number;
  env?: Record<string, string>;
  /** Defaults to `iam`. */
  access?: Access;
  /**
   * `<network>/<subnet>`. Outbound traffic then follows that subnet's rules (internet only through NAT).
   * Required for `private`. Without it the function can reach the internet but not the network.
   */
  subnet?: string;
}

/** Identity function that gives `infra.ts` files type checking and completion. */
export function defineInfra(infra: Infra): Infra {
  return infra;
}
