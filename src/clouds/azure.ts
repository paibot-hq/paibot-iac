import { ADMIN_USER, image } from "../catalog.ts";
import { id, lit, ref, TfDoc } from "../tf.ts";
import { azureAccountName } from "../validate.ts";
import {
  bucketId,
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

export function azure({ infra, target }: Ctx): TfDoc {
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

  return doc;
}
