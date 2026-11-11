// A GPU box in a closed network: no public IP, no NAT, nothing in or out except from inside.
// Use `import { defineInfra } from "@paibot/iac"` in your own project.
import { defineInfra } from "../../src/index.ts";

const regions = { aws: "us-east-1", gcp: "us-central1", azure: "eastus" } as const;

export default defineInfra({
  name: "closed-llm",
  sshKey: "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPY1joKA/RkxSPtgiFiz2GrPhChFLloacPEEZLM9jM+m paibot-iac-example",
  targets: [
    { cloud: "aws", region: regions.aws },
    { cloud: "gcp", region: regions.gcp, project: "my-project", zone: "us-central1-c" },
    { cloud: "azure", region: regions.azure },
  ],
  networks: [
    {
      name: "vpc",
      cidr: "10.50.0.0/16",
      subnets: [{ name: "gpu", cidr: "10.50.10.0/24" }],
    },
  ],
  instances: [
    {
      name: "llm",
      size: "gpu-small",
      subnet: "vpc/gpu",
      diskGb: 200,
      ingress: [{ ports: [8080], from: ["10.50.0.0/16"] }],
      overrides: { azure: { type: "Standard_NV36ads_A10_v5" } },
    },
  ],
  buckets: [{ name: "closed-llm-weights-20261112" }],
});
