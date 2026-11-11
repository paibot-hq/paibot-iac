# Paibot IaC

**English** | [日本語](README.ja.md)

Write your infrastructure once and generate Terraform / OpenTofu for **AWS, Google Cloud and Azure**. The same file means the same thing on every cloud: which subnets can reach the internet, what traffic is allowed in, and which buckets are private.

```yaml
# infra.yaml
name: demo
sshKey: ~/.ssh/id_ed25519.pub
targets:
  - { cloud: aws, region: ap-northeast-1 }
  - { cloud: gcp, region: asia-northeast1, project: my-project }
  - { cloud: azure, region: japaneast }

networks:
  - name: main
    cidr: 10.20.0.0/16
    nat: true                       # private subnets can go out, nothing comes in
    subnets:
      - { name: edge, cidr: 10.20.0.0/24, public: true }
      - { name: app,  cidr: 10.20.1.0/24 }

instances:
  - name: web
    size: small
    subnet: main/edge
    publicIp: true
    ingress: [{ ports: [80, 443], from: [0.0.0.0/0] }]
  - name: worker
    size: medium
    subnet: main/app
    ingress: [{ ports: [8080], from: [10.20.0.0/24] }]

buckets:
  - { name: demo-artifacts-20261112, versioning: true }
```

```sh
npx @paibot/iac gen          # writes out/aws, out/gcp, out/azure (main.tf.json)
npx @paibot/iac plan aws     # gen + tofu init + tofu plan in out/aws
npx @paibot/iac apply gcp
```

Planning, applying and state are left to OpenTofu or Terraform. The output is plain `main.tf.json`, so you can also run `tofu` / `terraform` yourself.

## What "the same meaning" covers

| You write | AWS | Google Cloud | Azure |
|---|---|---|---|
| `network` | VPC | custom-mode VPC | resource group + VNet |
| `public: true` subnet | route to an internet gateway | (instances may get an external IP) | (instances may get a public IP) |
| private subnet | no route out | no external IP | default outbound access **turned off** |
| `nat: true` | NAT gateway in the first public subnet + route | Cloud Router + Cloud NAT for private subnets | NAT gateway on private subnets |
| `ingress` | security group rules | firewall rules targeted by network tag | NSG rules + **deny everything else**, including the VNet |
| `size` | see `paibot-iac sizes` | | |
| `userData` | cloud-init user data | cloud-init `user-data` metadata | cloud-init custom data |
| bucket | S3, public access blocked | GCS, uniform access, public access prevented | storage account + private container |

So on every cloud:

- An instance reaches the internet only with `publicIp: true`, or from a private subnet of a network with `nat: true`.
- Only the `ingress` you list gets in. Traffic from elsewhere in the same network is denied too (Azure allows it by default; Paibot IaC closes it).
- Outbound traffic from an instance is not filtered.

Definitions that only some clouds could honour are rejected — for example a public IP in a private subnet, or a NAT with no public subnet to sit in. `paibot-iac check` lists every problem at once.

## Sizes and images

```
$ paibot-iac sizes
size        aws            gcp             azure
small       t3.medium      e2-medium       Standard_B2s            2 vCPU, 4 GB (burstable)
medium      m6i.large      e2-standard-2   Standard_D2s_v5         2 vCPU, 8 GB
large       m6i.xlarge     e2-standard-4   Standard_D4s_v5         4 vCPU, 16 GB
xlarge      m6i.2xlarge    e2-standard-8   Standard_D8s_v5         8 vCPU, 32 GB
gpu-small   g6.xlarge      g2-standard-4   Standard_NC4as_T4_v3    1 GPU, 4 vCPU (L4 24 GB on AWS/GCP, T4 16 GB on Azure)

images: ubuntu-24.04, ubuntu-22.04
```

The login user is `ubuntu` everywhere. GPU images do not include drivers.

## When the common words are not enough

```yaml
instances:
  - name: llm
    size: gpu-small
    overrides:
      azure: { type: Standard_NV36ads_A10_v5 }            # native machine type
      aws:   { image: ami-0123456789abcdef0 }              # native image
extra:
  aws:                                                     # raw tf.json, merged into out/aws only
    resource:
      aws_flow_log: { main: { vpc_id: "${aws_vpc.main.id}", traffic_type: ALL, log_destination: "..." } }
```

## Writing it in TypeScript

`infra.ts` gets type checking and completion. It needs Node 22.18 or later (type stripping), and an ES module project (`"type": "module"`) — otherwise name it `infra.mts`.

```ts
import { defineInfra } from "@paibot/iac";

export default defineInfra({
  name: "closed-llm",
  sshKey: "~/.ssh/id_ed25519.pub",
  targets: [
    { cloud: "aws", region: "us-east-1" },
    { cloud: "gcp", region: "us-central1", project: "my-project", zone: "us-central1-c" },
  ],
  networks: [{ name: "vpc", cidr: "10.50.0.0/16", subnets: [{ name: "gpu", cidr: "10.50.10.0/24" }] }],
  instances: [{ name: "llm", size: "gpu-small", subnet: "vpc/gpu", diskGb: 200 }],
});
```

The library is also usable directly: `generate(infra)` returns one tf.json object per target.

## Reference

### `Infra`

| key | |
|---|---|
| `name` | stack name; prefix for cloud resource names |
| `targets[]` | `cloud` (`aws` / `gcp` / `azure`), `region`, `project` (gcp), `zone` (gcp, default `<region>-a`), `name` (output directory, default the cloud) |
| `sshKey` | public key, or a path to one (relative to the definition, or `~/`). Required for Azure VMs |
| `networks[]` | `name`, `cidr`, `nat`, `subnets[]` (`name`, `cidr`, `public`) |
| `instances[]` | `name`, `size`, `image`, `subnet` (`network/subnet`), `diskGb` (default 30), `publicIp`, `ingress[]` (`protocol` tcp/udp, `ports` like `22` or `"8000-8100"`, `from` CIDRs), `userData` or `userDataFile`, `overrides.<cloud>` (`type`, `image`) |
| `buckets[]` | `name`, `versioning`. On Azure the storage account name is the bucket name without hyphens (3–24 chars) |
| `extra.<cloud>` | raw tf.json merged into that cloud's output |

### Credentials

The generated code uses each provider's normal credentials: `AWS_PROFILE` etc., `gcloud auth application-default login`, and `az login` + `ARM_SUBSCRIPTION_ID`.

### State

State lives in `out/<target>/` unless you add a backend through `extra`. Do not delete that directory while resources exist.

## Status

0.1 covers networks, NAT, VMs, firewalls and buckets. Every example is checked with `tofu validate` and `terraform validate` on all three clouds (`npm run validate:examples`). Next: load balancers, managed Postgres, DNS, and read-only access from instances to buckets.

## License

MIT
