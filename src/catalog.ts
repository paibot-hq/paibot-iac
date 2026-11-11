import type { Cloud } from "./types.ts";

export interface Size {
  name: string;
  summary: string;
  types: Record<Cloud, string>;
}

/** Common sizes. Close, not identical: each cloud's nearest general-purpose type. */
export const SIZES: Size[] = [
  {
    name: "small",
    summary: "2 vCPU, 4 GB (burstable)",
    types: { aws: "t3.medium", gcp: "e2-medium", azure: "Standard_B2s" },
  },
  {
    name: "medium",
    summary: "2 vCPU, 8 GB",
    types: { aws: "m6i.large", gcp: "e2-standard-2", azure: "Standard_D2s_v5" },
  },
  {
    name: "large",
    summary: "4 vCPU, 16 GB",
    types: { aws: "m6i.xlarge", gcp: "e2-standard-4", azure: "Standard_D4s_v5" },
  },
  {
    name: "xlarge",
    summary: "8 vCPU, 32 GB",
    types: { aws: "m6i.2xlarge", gcp: "e2-standard-8", azure: "Standard_D8s_v5" },
  },
  {
    name: "gpu-small",
    summary: "1 GPU, 4 vCPU (L4 24 GB on AWS/GCP, T4 16 GB on Azure)",
    types: { aws: "g6.xlarge", gcp: "g2-standard-4", azure: "Standard_NC4as_T4_v3" },
  },
];

export function machineType(cloud: Cloud, size: string): string | undefined {
  return SIZES.find((s) => s.name === size)?.types[cloud];
}

export interface AwsImage {
  owner: string;
  namePattern: string;
}
export interface AzureImage {
  publisher: string;
  offer: string;
  sku: string;
  version: string;
}

export interface Image {
  name: string;
  aws: AwsImage;
  gcp: string;
  azure: AzureImage;
}

const CANONICAL_AWS = "099720109477";

export const IMAGES: Image[] = [
  {
    name: "ubuntu-24.04",
    aws: { owner: CANONICAL_AWS, namePattern: "ubuntu/images/hvm-ssd-gp3/ubuntu-noble-24.04-amd64-server-*" },
    gcp: "ubuntu-os-cloud/ubuntu-2404-lts-amd64",
    azure: { publisher: "Canonical", offer: "ubuntu-24_04-lts", sku: "server", version: "latest" },
  },
  {
    name: "ubuntu-22.04",
    aws: { owner: CANONICAL_AWS, namePattern: "ubuntu/images/hvm-ssd/ubuntu-jammy-22.04-amd64-server-*" },
    gcp: "ubuntu-os-cloud/ubuntu-2204-lts",
    azure: { publisher: "Canonical", offer: "0001-com-ubuntu-server-jammy", sku: "22_04-lts-gen2", version: "latest" },
  },
];

export function image(name: string): Image | undefined {
  return IMAGES.find((i) => i.name === name);
}

/** The login user on every common image. */
export const ADMIN_USER = "ubuntu";

export interface RuntimeInfo {
  name: string;
  /** AWS Lambda managed runtime that provides the interpreter. */
  aws: string;
  /** Cloud Run base image path under `<region>-docker.pkg.dev/serverless-runtimes/`. */
  gcp: string;
}

export const RUNTIMES: RuntimeInfo[] = [
  { name: "node22", aws: "nodejs22.x", gcp: "google-22-full/runtimes/nodejs22" },
  { name: "node24", aws: "nodejs24.x", gcp: "google-24-full/runtimes/nodejs24" },
  { name: "python3.12", aws: "python3.12", gcp: "google-22-full/runtimes/python312" },
];

export function runtime(name: string): RuntimeInfo | undefined {
  return RUNTIMES.find((r) => r.name === name);
}

/** AWS Lambda Web Adapter layer (awslabs/aws-lambda-web-adapter), x86_64. */
export const LWA_LAYER = (region: string) => `arn:aws:lambda:${region}:753240598075:layer:LambdaAdapterLayerX86:30`;

/** Port the app listens on where the platform does not choose one. */
export const FUNCTION_PORT = "8080";
