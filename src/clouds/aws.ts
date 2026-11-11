import { FUNCTION_PORT, image, LWA_LAYER, runtime } from "../catalog.ts";
import type { Network } from "../types.ts";
import { id, lit, ref, TfDoc } from "../tf.ts";
import {
  archive,
  bucketId,
  diskGb,
  flatIngress,
  fnAccess,
  fnMemory,
  fnTimeout,
  imageName,
  sshKey,
  startScript,
  subnetOf,
  TAGS,
  typeFor,
  userData,
  type Ctx,
} from "./common.ts";

export function aws(ctx: Ctx): TfDoc {
  const { infra, target } = ctx;
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

  functions(doc, ctx);
  return doc;
}

/**
 * Plain HTTP servers on classic Lambda with the Lambda Web Adapter layer.
 * public/iam: a function URL. private: an internal ALB in the function's network.
 */
function functions(doc: TfDoc, { infra, target, packages }: Ctx) {
  const fns = infra.functions ?? [];
  if (!fns.length) return;
  const name = infra.name;
  doc.terraform({
    required_version: ">= 1.6",
    required_providers: {
      aws: { source: "hashicorp/aws", version: ">= 6.0, < 7.0" },
      archive: { source: "hashicorp/archive", version: ">= 2.4" },
    },
  });
  const partition = doc.data("aws_partition", "current", {});
  const policy = (p: string) => `arn:${ref(`${partition}.partition`)}:iam::aws:policy/service-role/${p}`;

  for (const f of fns) {
    const fid = id("fn", f.name);
    packages.push({
      dir: `build/${f.name}`,
      source: f.source,
      files: [{ path: "paibot-run.sh", content: startScript(f), mode: 0o755 }],
    });
    // The bootstrap execs the handler directly, so every file is zipped as executable.
    const zip = doc.data("archive_file", fid, archive(f, "0755"));

    const role = doc.resource("aws_iam_role", fid, {
      name: `${name}-${f.name}`,
      assume_role_policy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }],
      }),
    });
    const attachments = [
      doc.resource("aws_iam_role_policy_attachment", id(fid, "logs"), {
        role: ref(`${role}.name`),
        policy_arn: policy("AWSLambdaBasicExecutionRole"),
      }),
    ];

    let vpc: Record<string, unknown> | undefined;
    let net: Network | undefined;
    if (f.subnet) {
      const [n, s] = f.subnet.split("/");
      net = infra.networks!.find((x) => x.name === n)!;
      const sg = doc.resource("aws_security_group", fid, {
        name: `${name}-fn-${f.name}`,
        description: `paibot-iac: function ${name}/${f.name}`,
        vpc_id: ref(`aws_vpc.${n}.id`),
        tags: { Name: `${name}-fn-${f.name}` },
      });
      doc.resource("aws_vpc_security_group_egress_rule", id(fid, "all"), {
        security_group_id: ref(`${sg}.id`),
        ip_protocol: "-1",
        cidr_ipv4: "0.0.0.0/0",
      });
      attachments.push(
        doc.resource("aws_iam_role_policy_attachment", id(fid, "vpc"), {
          role: ref(`${role}.name`),
          policy_arn: policy("AWSLambdaVPCAccessExecutionRole"),
        }),
      );
      vpc = { subnet_ids: [ref(`aws_subnet.${id(n, s)}.id`)], security_group_ids: [ref(`${sg}.id`)] };
    }

    const lambda = doc.resource("aws_lambda_function", f.name, {
      function_name: `${name}-${f.name}`,
      role: ref(`${role}.arn`),
      runtime: runtime(f.runtime)!.aws,
      architectures: ["x86_64"],
      handler: "paibot-run.sh",
      filename: ref(`${zip}.output_path`),
      source_code_hash: ref(`${zip}.output_base64sha256`),
      layers: [LWA_LAYER(target.region)],
      memory_size: fnMemory(f),
      timeout: fnTimeout(f),
      environment: {
        variables: {
          ...Object.fromEntries(Object.entries(f.env ?? {}).map(([k, v]) => [k, lit(v)])),
          AWS_LAMBDA_EXEC_WRAPPER: "/opt/bootstrap",
          AWS_LWA_PORT: FUNCTION_PORT,
          PORT: FUNCTION_PORT,
        },
      },
      vpc_config: vpc as never,
      depends_on: attachments,
    });

    const access = fnAccess(f);
    if (access === "public" || access === "iam") {
      const url = doc.resource("aws_lambda_function_url", f.name, {
        function_name: ref(`${lambda}.function_name`),
        authorization_type: access === "public" ? "NONE" : "AWS_IAM",
      });
      if (access === "public") {
        // A public URL needs both statements since October 2025.
        doc.resource("aws_lambda_permission", id(fid, "url"), {
          function_name: ref(`${lambda}.function_name`),
          statement_id: "PublicFunctionUrl",
          action: "lambda:InvokeFunctionUrl",
          principal: "*",
          function_url_auth_type: "NONE",
        });
        doc.resource("aws_lambda_permission", id(fid, "invoke"), {
          function_name: ref(`${lambda}.function_name`),
          statement_id: "PublicFunctionUrlInvoke",
          action: "lambda:InvokeFunction",
          principal: "*",
          invoked_via_function_url: true,
        });
      }
      doc.output(`${f.name}_url`, ref(`${url}.function_url`));
    } else {
      // private: an internal ALB, reachable only from inside the network.
      const sub = net!.subnets.find((s) => s.name === f.subnet!.split("/")[1])!;
      const albSubnets = net!.subnets.filter((s) => !!s.public === !!sub.public);
      const albSg = doc.resource("aws_security_group", id(fid, "lb"), {
        name: `${name}-fn-${f.name}-lb`,
        description: `paibot-iac: load balancer for ${name}/${f.name}`,
        vpc_id: ref(`aws_vpc.${net!.name}.id`),
        tags: { Name: `${name}-fn-${f.name}-lb` },
      });
      doc.resource("aws_vpc_security_group_ingress_rule", id(fid, "lb_in"), {
        security_group_id: ref(`${albSg}.id`),
        ip_protocol: "tcp",
        from_port: 80,
        to_port: 80,
        cidr_ipv4: net!.cidr,
      });
      doc.resource("aws_vpc_security_group_egress_rule", id(fid, "lb_out"), {
        security_group_id: ref(`${albSg}.id`),
        ip_protocol: "-1",
        cidr_ipv4: "0.0.0.0/0",
      });
      const lb = doc.resource("aws_lb", fid, {
        name: `${name}-${f.name}`,
        internal: true,
        load_balancer_type: "application",
        security_groups: [ref(`${albSg}.id`)],
        subnets: albSubnets.map((s) => ref(`aws_subnet.${id(net!.name, s.name)}.id`)),
      });
      const tg = doc.resource("aws_lb_target_group", fid, { name: `${name}-${f.name}`, target_type: "lambda" });
      const perm = doc.resource("aws_lambda_permission", id(fid, "lb"), {
        function_name: ref(`${lambda}.function_name`),
        statement_id: "InternalLoadBalancer",
        action: "lambda:InvokeFunction",
        principal: "elasticloadbalancing.amazonaws.com",
        source_arn: ref(`${tg}.arn`),
      });
      doc.resource("aws_lb_target_group_attachment", fid, {
        target_group_arn: ref(`${tg}.arn`),
        target_id: ref(`${lambda}.arn`),
        depends_on: [perm],
      });
      doc.resource("aws_lb_listener", fid, {
        load_balancer_arn: ref(`${lb}.arn`),
        port: 80,
        protocol: "HTTP",
        default_action: [{ type: "forward", target_group_arn: ref(`${tg}.arn`) }],
      });
      doc.output(`${f.name}_url`, `http://${ref(`${lb}.dns_name`)}`);
    }
  }
}
