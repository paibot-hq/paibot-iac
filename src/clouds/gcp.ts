import { image, runtime } from "../catalog.ts";
import { id, lit, ref, TfDoc } from "../tf.ts";
import {
  archive,
  bucketId,
  fnAccess,
  fnMemory,
  fnTimeout,
  diskGb,
  flatIngress,
  imageName,
  portString,
  sshKey,
  subnetOf,
  TAGS,
  typeFor,
  userData,
  type Ctx,
} from "./common.ts";
import { ADMIN_USER } from "../catalog.ts";

/** Accelerator-optimized families must stop (not live-migrate) for host maintenance. */
const GPU_FAMILIES = /^(a2|a3|a4|g2|g4)-/;

export function gcp(ctx: Ctx): TfDoc {
  const { infra, target } = ctx;
  const doc = new TfDoc();
  const name = infra.name;
  const zone = target.zone ?? `${target.region}-a`;

  doc.terraform({
    required_version: ">= 1.6",
    required_providers: { google: { source: "hashicorp/google", version: ">= 6.0, < 8.0" } },
  });
  doc.provider("google", {
    project: target.project!,
    region: target.region,
    zone,
    default_labels: TAGS(infra),
  });

  for (const net of infra.networks ?? []) {
    const n = net.name;
    // A custom-mode VPC has no firewall rules: all ingress is denied, even inside the network.
    // Without an external IP or Cloud NAT an instance cannot reach the internet.
    const vpc = doc.resource("google_compute_network", n, {
      name: `${name}-${n}`,
      auto_create_subnetworks: false,
    });
    for (const s of net.subnets) {
      doc.resource("google_compute_subnetwork", id(n, s.name), {
        name: `${name}-${n}-${s.name}`,
        network: ref(`${vpc}.id`),
        region: target.region,
        ip_cidr_range: s.cidr,
        private_ip_google_access: true,
      });
    }
    const privates = net.subnets.filter((s) => !s.public);
    if (net.nat && privates.length) {
      const router = doc.resource("google_compute_router", n, {
        name: `${name}-${n}`,
        network: ref(`${vpc}.id`),
        region: target.region,
      });
      doc.resource("google_compute_router_nat", n, {
        name: `${name}-${n}`,
        router: ref(`${router}.name`),
        region: target.region,
        nat_ip_allocate_option: "AUTO_ONLY",
        source_subnetwork_ip_ranges_to_nat: "LIST_OF_SUBNETWORKS",
        subnetwork: privates.map((s) => ({
          name: ref(`google_compute_subnetwork.${id(n, s.name)}.id`),
          source_ip_ranges_to_nat: ["ALL_IP_RANGES"],
        })),
      });
    }
  }

  const key = sshKey(infra);
  for (const inst of infra.instances ?? []) {
    const i = inst.name;
    const { net, sub } = subnetOf(infra, inst);
    const netTag = `${name}-${i}`;

    flatIngress(inst).forEach((r, k) => {
      doc.resource("google_compute_firewall", id(i, "in", String(k)), {
        name: `${name}-${i}-in-${k}`,
        network: ref(`google_compute_network.${net.name}.id`),
        direction: "INGRESS",
        source_ranges: r.cidrs,
        target_tags: [netTag],
        allow: [{ protocol: r.protocol, ports: [portString(r)] }],
      });
    });

    const type = typeFor("gcp", inst);
    const metadata: Record<string, string> = {};
    if (key) metadata["ssh-keys"] = lit(`${ADMIN_USER}:${key}`);
    const ud = userData(inst);
    // Ubuntu images run cloud-init from `user-data`, the same as AWS user data and Azure custom data.
    if (ud !== undefined) metadata["user-data"] = lit(ud);

    const vm = doc.resource("google_compute_instance", i, {
      name: `${name}-${i}`,
      machine_type: type,
      zone,
      tags: [netTag],
      boot_disk: {
        initialize_params: {
          image: inst.overrides?.gcp?.image ?? image(imageName(inst))!.gcp,
          size: diskGb(inst),
          type: "pd-balanced",
        },
      },
      network_interface: [
        {
          subnetwork: ref(`google_compute_subnetwork.${id(net.name, sub.name)}.id`),
          access_config: inst.publicIp ? [{}] : undefined,
        },
      ],
      metadata: Object.keys(metadata).length ? metadata : undefined,
      scheduling: GPU_FAMILIES.test(type) ? { on_host_maintenance: "TERMINATE", automatic_restart: true } : undefined,
      shielded_instance_config: GPU_FAMILIES.test(type) ? undefined : { enable_secure_boot: true },
    });
    doc.output(`${i}_private_ip`, ref(`${vm}.network_interface[0].network_ip`));
    if (inst.publicIp) doc.output(`${i}_public_ip`, ref(`${vm}.network_interface[0].access_config[0].nat_ip`));
  }

  for (const b of infra.buckets ?? []) {
    const g = doc.resource("google_storage_bucket", bucketId(b.name), {
      name: b.name,
      location: target.region.toUpperCase(),
      uniform_bucket_level_access: true,
      public_access_prevention: "enforced",
      versioning: b.versioning ? { enabled: true } : undefined,
    });
    doc.output(`${bucketId(b.name)}_bucket`, ref(`${g}.name`));
  }

  functions(doc, ctx, zone);
  return doc;
}

/**
 * Plain HTTP servers on Cloud Run, deployed from a source zip onto a Google runtime base image (no build).
 * public: invoker check off. iam: invoker check on. private: internal ingress only.
 */
function functions(doc: TfDoc, { infra, target, packages }: Ctx, zone: string) {
  const fns = infra.functions ?? [];
  if (!fns.length) return;
  const name = infra.name;
  doc.terraform({
    required_version: ">= 1.6",
    required_providers: {
      google: { source: "hashicorp/google", version: ">= 6.0, < 8.0" },
      // Cloud Run source deploys (containers.source_code) are only in the beta provider.
      "google-beta": { source: "hashicorp/google-beta", version: ">= 6.0, < 8.0" },
      archive: { source: "hashicorp/archive", version: ">= 2.4" },
    },
  });
  doc.provider("google-beta", { project: target.project!, region: target.region, zone, default_labels: TAGS(infra) });

  const src = doc.resource("google_storage_bucket", "fn_src", {
    name: `${target.project}-${name}-src`,
    location: target.region.toUpperCase(),
    uniform_bucket_level_access: true,
    public_access_prevention: "enforced",
    force_destroy: true,
  });

  for (const f of fns) {
    const fid = id("fn", f.name);
    packages.push({ dir: `build/${f.name}`, source: f.source, files: [] });
    const zip = doc.data("archive_file", fid, archive(f));
    const obj = doc.resource("google_storage_bucket_object", fid, {
      bucket: ref(`${src}.name`),
      name: `${f.name}/${ref(`${zip}.output_md5`)}.zip`,
      source: ref(`${zip}.output_path`),
    });

    const access = fnAccess(f);
    let vpc: unknown;
    if (f.subnet) {
      const [n, s] = f.subnet.split("/");
      // All outbound traffic goes into the network, so the subnet's rules (NAT or not) apply.
      vpc = [
        {
          egress: "ALL_TRAFFIC",
          network_interfaces: [
            {
              network: ref(`google_compute_network.${n}.id`),
              subnetwork: ref(`google_compute_subnetwork.${id(n, s)}.id`),
            },
          ],
        },
      ];
    }
    const [cmd, ...args] = f.command;
    const svc = doc.resource("google_cloud_run_v2_service", f.name, {
      provider: "google-beta",
      name: `${name}-${f.name}`,
      location: target.region,
      launch_stage: "BETA",
      deletion_protection: false,
      ingress: access === "private" ? "INGRESS_TRAFFIC_INTERNAL_ONLY" : "INGRESS_TRAFFIC_ALL",
      invoker_iam_disabled: access !== "iam",
      template: [
        {
          timeout: `${fnTimeout(f)}s`,
          vpc_access: vpc as never,
          containers: [
            {
              image: "scratch",
              base_image_uri: `${target.region}-docker.pkg.dev/serverless-runtimes/${runtime(f.runtime)!.gcp}`,
              command: [cmd],
              args,
              source_code: [
                {
                  cloud_storage_source: [
                    { bucket: ref(`${src}.name`), object: ref(`${obj}.name`), generation: ref(`${obj}.generation`) },
                  ],
                },
              ],
              resources: [{ limits: { cpu: "1", memory: `${fnMemory(f)}Mi` } }],
              env: Object.entries(f.env ?? {}).map(([k, v]) => ({ name: k, value: lit(v) })),
            },
          ],
        },
      ],
    });
    doc.output(`${f.name}_url`, ref(`${svc}.uri`));
  }
}
