import { image } from "../catalog.ts";
import { id, lit, ref, TfDoc } from "../tf.ts";
import { bucketId, diskGb, flatIngress, imageName, sshKey, subnetOf, TAGS, typeFor, userData, type Ctx } from "./common.ts";

export function aws({ infra, target }: Ctx): TfDoc {
  const doc = new TfDoc();
  const name = infra.name;
  const tag = (n: string) => ({ Name: n });

  doc.terraform({
    required_version: ">= 1.6",
    required_providers: { aws: { source: "hashicorp/aws", version: ">= 6.0, < 7.0" } },
  });
  doc.provider("aws", { region: target.region, default_tags: { tags: TAGS(infra) } });

  const networks = infra.networks ?? [];
  const azs = "data.aws_availability_zones.available.names";
  if (networks.length) doc.data("aws_availability_zones", "available", { state: "available" });

  for (const net of networks) {
    const n = net.name;
    const vpc = doc.resource("aws_vpc", n, {
      cidr_block: net.cidr,
      enable_dns_support: true,
      enable_dns_hostnames: true,
      tags: tag(`${name}-${n}`),
    });
    const publics = net.subnets.filter((s) => s.public);
    const privates = net.subnets.filter((s) => !s.public);

    let igw: string | undefined;
    if (publics.length) {
      igw = doc.resource("aws_internet_gateway", n, { vpc_id: ref(`${vpc}.id`), tags: tag(`${name}-${n}`) });
      const rt = doc.resource("aws_route_table", id(n, "public"), {
        vpc_id: ref(`${vpc}.id`),
        tags: tag(`${name}-${n}-public`),
      });
      doc.resource("aws_route", id(n, "public_internet"), {
        route_table_id: ref(`${rt}.id`),
        destination_cidr_block: "0.0.0.0/0",
        gateway_id: ref(`${igw}.id`),
      });
    }
    if (privates.length) {
      // No route out. Only the NAT, if asked for, adds one.
      doc.resource("aws_route_table", id(n, "private"), { vpc_id: ref(`${vpc}.id`), tags: tag(`${name}-${n}-private`) });
    }

    net.subnets.forEach((s, i) => {
      const sn = doc.resource("aws_subnet", id(n, s.name), {
        vpc_id: ref(`${vpc}.id`),
        cidr_block: s.cidr,
        availability_zone: ref(`${azs}[${i} % length(${azs})]`),
        map_public_ip_on_launch: false,
        tags: tag(`${name}-${n}-${s.name}`),
      });
      doc.resource("aws_route_table_association", id(n, s.name), {
        subnet_id: ref(`${sn}.id`),
        route_table_id: ref(`aws_route_table.${id(n, s.public ? "public" : "private")}.id`),
      });
    });

    if (net.nat && privates.length) {
      const eip = doc.resource("aws_eip", id(n, "nat"), { domain: "vpc", tags: tag(`${name}-${n}-nat`) });
      const nat = doc.resource("aws_nat_gateway", n, {
        allocation_id: ref(`${eip}.id`),
        subnet_id: ref(`aws_subnet.${id(n, publics[0].name)}.id`),
        tags: tag(`${name}-${n}`),
        depends_on: [igw!],
      });
      doc.resource("aws_route", id(n, "private_nat"), {
        route_table_id: ref(`aws_route_table.${id(n, "private")}.id`),
        destination_cidr_block: "0.0.0.0/0",
        nat_gateway_id: ref(`${nat}.id`),
      });
    }
  }

  const key = sshKey(infra);
  const instances = infra.instances ?? [];
  let keyPair: string | undefined;
  if (key && instances.length) {
    keyPair = doc.resource("aws_key_pair", "main", { key_name: name, public_key: lit(key) });
  }

  for (const inst of instances) {
    const i = inst.name;
    const { net, sub } = subnetOf(infra, inst);
    const sg = doc.resource("aws_security_group", i, {
      name: `${name}-${i}`,
      description: `paibot-iac: ${name}/${i}`,
      vpc_id: ref(`aws_vpc.${net.name}.id`),
      tags: tag(`${name}-${i}`),
    });
    let k = 0;
    for (const r of flatIngress(inst)) {
      for (const c of r.cidrs) {
        doc.resource("aws_vpc_security_group_ingress_rule", id(i, String(k++)), {
          security_group_id: ref(`${sg}.id`),
          ip_protocol: r.protocol,
          from_port: r.from,
          to_port: r.to,
          cidr_ipv4: c,
        });
      }
    }
    doc.resource("aws_vpc_security_group_egress_rule", id(i, "all"), {
      security_group_id: ref(`${sg}.id`),
      ip_protocol: "-1",
      cidr_ipv4: "0.0.0.0/0",
    });

    const custom = inst.overrides?.aws?.image;
    let ami: string;
    if (custom) ami = custom;
    else {
      const img = image(imageName(inst))!;
      const d = doc.data("aws_ami", imageName(inst).replace(/[^a-z0-9]/g, "_"), {
        most_recent: true,
        owners: [img.aws.owner],
        filter: [
          { name: "name", values: [img.aws.namePattern] },
          { name: "virtualization-type", values: ["hvm"] },
        ],
      });
      ami = ref(`${d}.id`);
    }

    const ud = userData(inst);
    const vm = doc.resource("aws_instance", i, {
      ami,
      instance_type: typeFor("aws", inst),
      subnet_id: ref(`aws_subnet.${id(net.name, sub.name)}.id`),
      vpc_security_group_ids: [ref(`${sg}.id`)],
      associate_public_ip_address: inst.publicIp ?? false,
      key_name: keyPair ? ref(`${keyPair}.key_name`) : undefined,
      user_data: ud === undefined ? undefined : lit(ud),
      user_data_replace_on_change: ud === undefined ? undefined : true,
      root_block_device: { volume_size: diskGb(inst), volume_type: "gp3", encrypted: true },
      metadata_options: { http_tokens: "required", http_put_response_hop_limit: 1 },
      tags: tag(`${name}-${i}`),
    });
    doc.output(`${i}_private_ip`, ref(`${vm}.private_ip`));
    if (inst.publicIp) doc.output(`${i}_public_ip`, ref(`${vm}.public_ip`));
  }

  for (const b of infra.buckets ?? []) {
    const bid = bucketId(b.name);
    const s3 = doc.resource("aws_s3_bucket", bid, { bucket: b.name });
    doc.resource("aws_s3_bucket_public_access_block", bid, {
      bucket: ref(`${s3}.id`),
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    });
    if (b.versioning) {
      doc.resource("aws_s3_bucket_versioning", bid, {
        bucket: ref(`${s3}.id`),
        versioning_configuration: { status: "Enabled" },
      });
    }
    doc.output(`${bid}_bucket`, ref(`${s3}.bucket`));
  }

  return doc;
}
