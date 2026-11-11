import { ADMIN_USER, image } from "../catalog.ts";
import { id, lit, ref, TfDoc } from "../tf.ts";
import { azureAccountName } from "../validate.ts";
import {
  archive,
  bucketId,
  fnMemory,
  fnTimeout,
  startScript,
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

export function azure(ctx: Ctx): TfDoc {
  const { infra, target } = ctx;
  const doc = new TfDoc();
  const name = infra.name;
  const tags = TAGS(infra);

  doc.terraform({
    required_version: ">= 1.6",
    required_providers: { azurerm: { source: "hashicorp/azurerm", version: ">= 4.0, < 5.0" } },
  });
  // The subscription comes from ARM_SUBSCRIPTION_ID or `az login`.
  doc.provider("azurerm", { features: {} });

  const rg = doc.resource("azurerm_resource_group", "main", { name, location: target.region, tags });
  const placed = {
    resource_group_name: ref(`${rg}.name`),
    location: ref(`${rg}.location`),
  };

  const fnSubnets = new Set((infra.functions ?? []).flatMap((f) => (f.subnet ? [f.subnet] : [])));
  for (const net of infra.networks ?? []) {
    const n = net.name;
    const vnet = doc.resource("azurerm_virtual_network", n, {
      name: `${name}-${n}`,
      ...placed,
      address_space: [net.cidr],
      tags,
    });
    for (const s of net.subnets) {
      doc.resource("azurerm_subnet", id(n, s.name), {
        name: s.name,
        resource_group_name: ref(`${rg}.name`),
        virtual_network_name: ref(`${vnet}.name`),
        address_prefixes: [s.cidr],
        // Azure otherwise gives every VM a hidden way out. Here only a public IP or the NAT does.
        default_outbound_access_enabled: false,
        delegation: fnSubnets.has(`${n}/${s.name}`)
          ? [
              {
                name: "flex-consumption",
                service_delegation: [
                  { name: "Microsoft.App/environments", actions: ["Microsoft.Network/virtualNetworks/subnets/join/action"] },
                ],
              },
            ]
          : undefined,
      });
    }
    const privates = net.subnets.filter((s) => !s.public);
    if (net.nat && privates.length) {
      const pip = doc.resource("azurerm_public_ip", id(n, "nat"), {
        name: `${name}-${n}-nat`,
        ...placed,
        allocation_method: "Static",
        sku: "Standard",
        tags,
      });
      const nat = doc.resource("azurerm_nat_gateway", n, { name: `${name}-${n}`, ...placed, sku_name: "Standard", tags });
      doc.resource("azurerm_nat_gateway_public_ip_association", n, {
        nat_gateway_id: ref(`${nat}.id`),
        public_ip_address_id: ref(`${pip}.id`),
      });
      for (const s of privates) {
        doc.resource("azurerm_subnet_nat_gateway_association", id(n, s.name), {
          subnet_id: ref(`azurerm_subnet.${id(n, s.name)}.id`),
          nat_gateway_id: ref(`${nat}.id`),
        });
      }
    }
  }

  const key = sshKey(infra);
  for (const inst of infra.instances ?? []) {
    const i = inst.name;
    const { net, sub } = subnetOf(infra, inst);

    const nsg = doc.resource("azurerm_network_security_group", i, { name: `${name}-${i}`, ...placed, tags });
    const rule = (k: string, body: Record<string, unknown>) =>
      doc.resource("azurerm_network_security_rule", id(i, k), {
        resource_group_name: ref(`${rg}.name`),
        network_security_group_name: ref(`${nsg}.name`),
        direction: "Inbound",
        source_port_range: "*",
        destination_address_prefix: "*",
        ...(body as Record<string, string>),
      });
    flatIngress(inst).forEach((r, k) => {
      rule(`in_${k}`, {
        name: `in-${k}`,
        priority: 100 + k,
        access: "Allow",
        protocol: r.protocol === "tcp" ? "Tcp" : "Udp",
        destination_port_range: portString(r),
        source_address_prefixes: r.cidrs,
      });
    });
    // Azure allows all traffic from inside the VNet by default. AWS and GCP do not, so close it here too.
    rule("deny_other", {
      name: "deny-other-inbound",
      priority: 4096,
      access: "Deny",
      protocol: "*",
      destination_port_range: "*",
      source_address_prefix: "*",
    });

    let pip: string | undefined;
    if (inst.publicIp) {
      pip = doc.resource("azurerm_public_ip", i, {
        name: `${name}-${i}`,
        ...placed,
        allocation_method: "Static",
        sku: "Standard",
        tags,
      });
    }
    const nic = doc.resource("azurerm_network_interface", i, {
      name: `${name}-${i}`,
      ...placed,
      ip_configuration: [
        {
          name: "primary",
          subnet_id: ref(`azurerm_subnet.${id(net.name, sub.name)}.id`),
          private_ip_address_allocation: "Dynamic",
          public_ip_address_id: pip ? ref(`${pip}.id`) : undefined,
        },
      ],
      tags,
    });
    doc.resource("azurerm_network_interface_security_group_association", i, {
      network_interface_id: ref(`${nic}.id`),
      network_security_group_id: ref(`${nsg}.id`),
    });

    const custom = inst.overrides?.azure?.image;
    let imageArgs: Record<string, unknown>;
    if (custom && custom.split(":").length === 4) {
      const [publisher, offer, sku, version] = custom.split(":");
      imageArgs = { source_image_reference: { publisher, offer, sku, version } };
    } else if (custom) {
      imageArgs = { source_image_id: custom };
    } else {
      imageArgs = { source_image_reference: { ...image(imageName(inst))!.azure } };
    }

    const ud = userData(inst);
    doc.resource("azurerm_linux_virtual_machine", i, {
      name: `${name}-${i}`,
      ...placed,
      size: typeFor("azure", inst),
      admin_username: ADMIN_USER,
      disable_password_authentication: true,
      admin_ssh_key: [{ username: ADMIN_USER, public_key: lit(key!) }],
      network_interface_ids: [ref(`${nic}.id`)],
      os_disk: { caching: "ReadWrite", storage_account_type: "StandardSSD_LRS", disk_size_gb: diskGb(inst) },
      custom_data: ud === undefined ? undefined : Buffer.from(ud, "utf8").toString("base64"),
      ...(imageArgs as Record<string, never>),
      tags,
    });
    doc.output(`${i}_private_ip`, ref(`${nic}.private_ip_address`));
    if (pip) doc.output(`${i}_public_ip`, ref(`${pip}.ip_address`));
  }

  for (const b of infra.buckets ?? []) {
    const bid = bucketId(b.name);
    const acct = doc.resource("azurerm_storage_account", bid, {
      name: azureAccountName(b.name),
      resource_group_name: ref(`${rg}.name`),
      location: ref(`${rg}.location`),
      account_tier: "Standard",
      account_replication_type: "LRS",
      min_tls_version: "TLS1_2",
      allow_nested_items_to_be_public: false,
      blob_properties: b.versioning ? { versioning_enabled: true } : undefined,
      tags,
    });
    doc.resource("azurerm_storage_container", bid, {
      name: b.name,
      storage_account_id: ref(`${acct}.id`),
      container_access_type: "private",
    });
    doc.output(`${bid}_bucket`, `${azureAccountName(b.name)}/${b.name}`);
  }

  functions(doc, ctx, rg);
  return doc;
}

/**
 * Plain HTTP servers on Azure Functions (Flex Consumption) as custom handlers that proxy every request.
 * Only `public` for now.
 */
function functions(doc: TfDoc, { infra, target, packages }: Ctx, rg: string) {
  const fns = infra.functions ?? [];
  if (!fns.length) return;
  const name = infra.name;
  const tags = TAGS(infra);
  doc.terraform({
    required_version: ">= 1.6",
    required_providers: {
      azurerm: { source: "hashicorp/azurerm", version: ">= 4.0, < 5.0" },
      archive: { source: "hashicorp/archive", version: ">= 2.4" },
    },
  });

  // Deployment packages live in a storage account of their own.
  const acct = doc.resource("azurerm_storage_account", "fn", {
    name: functionStorageName(name, target.region),
    resource_group_name: ref(`${rg}.name`),
    location: ref(`${rg}.location`),
    account_tier: "Standard",
    account_replication_type: "LRS",
    min_tls_version: "TLS1_2",
    allow_nested_items_to_be_public: false,
    tags,
  });

  for (const f of fns) {
    const fid = id("fn", f.name);
    packages.push({
      dir: `build/${f.name}`,
      source: f.source,
      files: [
        { path: "paibot-start.sh", content: startScript(f, "FUNCTIONS_CUSTOMHANDLER_PORT"), mode: 0o755 },
        {
          path: "host.json",
          content: JSON.stringify(
            {
              version: "2.0",
              functionTimeout: hms(fnTimeout(f)),
              extensions: { http: { routePrefix: "" } },
              customHandler: {
                description: { defaultExecutablePath: "/bin/sh", arguments: ["paibot-start.sh"] },
                enableProxyingHttpRequest: true,
              },
            },
            null,
            2,
          ),
        },
        {
          path: "paibot-http/function.json",
          content: JSON.stringify(
            {
              bindings: [
                {
                  type: "httpTrigger",
                  authLevel: "anonymous",
                  direction: "in",
                  name: "req",
                  methods: ["get", "post", "put", "patch", "delete", "head", "options"],
                  route: "{*path}",
                },
                { type: "http", direction: "out", name: "res" },
              ],
            },
            null,
            2,
          ),
        },
      ],
    });
    const zip = doc.data("archive_file", fid, archive(f));
    const container = doc.resource("azurerm_storage_container", fid, {
      name: `deploy-${f.name}`,
      storage_account_id: ref(`${acct}.id`),
      container_access_type: "private",
    });
    const plan = doc.resource("azurerm_service_plan", fid, {
      name: `${name}-${f.name}`,
      resource_group_name: ref(`${rg}.name`),
      location: ref(`${rg}.location`),
      os_type: "Linux",
      sku_name: "FC1",
      tags,
    });
    let subnetId: string | undefined;
    if (f.subnet) {
      const [n, s] = f.subnet.split("/");
      subnetId = ref(`azurerm_subnet.${id(n, s)}.id`);
    }
    const app = doc.resource("azurerm_function_app_flex_consumption", f.name, {
      name: `${name}-${f.name}`,
      resource_group_name: ref(`${rg}.name`),
      location: ref(`${rg}.location`),
      service_plan_id: ref(`${plan}.id`),
      storage_container_type: "blobContainer",
      storage_container_endpoint: `${ref(`${acct}.primary_blob_endpoint`)}${ref(`${container}.name`)}`,
      storage_authentication_type: "StorageAccountConnectionString",
      storage_access_key: ref(`${acct}.primary_access_key`),
      runtime_name: "custom",
      runtime_version: "1.0",
      instance_memory_in_mb: azureMemory(fnMemory(f)),
      zip_deploy_file: ref(`${zip}.output_path`),
      app_settings: Object.fromEntries(Object.entries(f.env ?? {}).map(([k, v]) => [k, lit(v)])),
      virtual_network_subnet_id: subnetId,
      https_only: true,
      site_config: [{}],
      tags,
    });
    doc.output(`${f.name}_url`, `https://${ref(`${app}.default_hostname`)}`);
  }
}

/** Flex Consumption instance sizes. */
function azureMemory(mb: number): number {
  return mb <= 512 ? 512 : mb <= 2048 ? 2048 : 4096;
}

function hms(seconds: number): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(Math.floor(seconds / 3600))}:${p(Math.floor((seconds % 3600) / 60))}:${p(seconds % 60)}`;
}

/** Storage account names are global, 3-24 lowercase letters and digits. */
export function functionStorageName(stack: string, region: string): string {
  let h = 0;
  for (const c of `${stack}/${region}`) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return `${stack.replace(/[^a-z0-9]/g, "").slice(0, 14)}fn${h.toString(36).padStart(7, "0").slice(-7)}`;
}
