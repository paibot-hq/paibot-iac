import assert from "node:assert/strict";
import { test } from "node:test";
import { generate, type Infra } from "../src/index.ts";
import { lit } from "../src/tf.ts";

const KEY = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIPY1joKA/RkxSPtgiFiz2GrPhChFLloacPEEZLM9jM+m test";

function base(over: Partial<Infra> = {}): Infra {
  return {
    name: "t",
    sshKey: KEY,
    targets: [
      { cloud: "aws", region: "ap-northeast-1" },
      { cloud: "gcp", region: "asia-northeast1", project: "p" },
      { cloud: "azure", region: "japaneast" },
    ],
    networks: [
      {
        name: "main",
        cidr: "10.0.0.0/16",
        subnets: [
          { name: "edge", cidr: "10.0.0.0/24", public: true },
          { name: "app", cidr: "10.0.1.0/24" },
        ],
      },
    ],
    instances: [
      {
        name: "api",
        size: "medium",
        subnet: "main/app",
        ingress: [{ ports: [443, "8000-8100"], from: ["10.0.0.0/24"] }],
        userData: 'echo "${HOME}" %{x}',
      },
    ],
    buckets: [{ name: "9-data", versioning: true }],
    ...over,
  };
}

type J = any;
const byCloud = (infra: Infra) => Object.fromEntries(generate(infra).map((o) => [o.cloud, o.json as J]));

test("one output per target, named after the cloud", () => {
  assert.deepEqual(
    generate(base()).map((o) => o.target),
    ["aws", "gcp", "azure"],
  );
  assert.deepEqual(
    generate(base(), "gcp").map((o) => o.target),
    ["gcp"],
  );
  assert.throws(() => generate(base(), "nope"), /no target named/);
});

test("sizes map to each cloud's machine type", () => {
  const o = byCloud(base());
  assert.equal(o.aws.resource.aws_instance.api.instance_type, "m6i.large");
  assert.equal(o.gcp.resource.google_compute_instance.api.machine_type, "e2-standard-2");
  assert.equal(o.azure.resource.azurerm_linux_virtual_machine.api.size, "Standard_D2s_v5");
});

test("overrides win over sizes and images", () => {
  const infra = base();
  infra.instances![0].overrides = { aws: { type: "g6.xlarge", image: "ami-123" }, azure: { image: "a:b:c:d" } };
  const o = byCloud(infra);
  assert.equal(o.aws.resource.aws_instance.api.instance_type, "g6.xlarge");
  assert.equal(o.aws.resource.aws_instance.api.ami, "ami-123");
  assert.equal(o.aws.data.aws_ami, undefined, "a given AMI needs no lookup");
  assert.deepEqual(o.azure.resource.azurerm_linux_virtual_machine.api.source_image_reference, {
    publisher: "a",
    offer: "b",
    sku: "c",
    version: "d",
  });
});

test("without nat, private subnets have no way out on any cloud", () => {
  const o = byCloud(base());
  const routes = Object.values(o.aws.resource.aws_route ?? {}) as J[];
  assert.ok(routes.every((r) => r.route_table_id.includes("_public")), "only the public table routes to the internet");
  assert.equal(o.aws.resource.aws_nat_gateway, undefined);
  assert.equal(o.gcp.resource.google_compute_router_nat, undefined);
  assert.equal(o.azure.resource.azurerm_nat_gateway, undefined);
  for (const s of Object.values(o.azure.resource.azurerm_subnet) as J[]) {
    assert.equal(s.default_outbound_access_enabled, false);
  }
  assert.equal(o.gcp.resource.google_compute_instance.api.network_interface[0].access_config, undefined);
  assert.equal(o.aws.resource.aws_instance.api.associate_public_ip_address, false);
});

test("nat gives private subnets a way out on every cloud", () => {
  const infra = base();
  infra.networks![0].nat = true;
  const o = byCloud(infra);
  assert.equal(o.aws.resource.aws_nat_gateway.main.subnet_id, "${aws_subnet.main_edge.id}");
  assert.equal(o.aws.resource.aws_route.main_private_nat.route_table_id, "${aws_route_table.main_private.id}");
  const nat = o.gcp.resource.google_compute_router_nat.main;
  assert.deepEqual(
    nat.subnetwork.map((s: J) => s.name),
    ["${google_compute_subnetwork.main_app.id}"],
  );
  assert.deepEqual(Object.keys(o.azure.resource.azurerm_subnet_nat_gateway_association), ["main_app"]);
});

test("ingress: same rules everywhere, and nothing else gets in", () => {
  const o = byCloud(base());
  const awsRules = Object.values(o.aws.resource.aws_vpc_security_group_ingress_rule) as J[];
  assert.deepEqual(
    awsRules.map((r) => [r.from_port, r.to_port, r.cidr_ipv4]),
    [
      [443, 443, "10.0.0.0/24"],
      [8000, 8100, "10.0.0.0/24"],
    ],
  );
  const fw = Object.values(o.gcp.resource.google_compute_firewall) as J[];
  assert.deepEqual(
    fw.map((r) => r.allow[0].ports[0]),
    ["443", "8000-8100"],
  );
  assert.deepEqual(fw[0].target_tags, o.gcp.resource.google_compute_instance.api.tags);
  const az = o.azure.resource.azurerm_network_security_rule;
  assert.equal(az.api_in_1.destination_port_range, "8000-8100");
  // Azure lets the whole VNet in by default; we close it to match AWS and GCP.
  assert.equal(az.api_deny_other.access, "Deny");
  assert.ok(az.api_deny_other.priority > az.api_in_1.priority);
});

test("user data is cloud-init everywhere, with template syntax escaped", () => {
  const o = byCloud(base());
  const want = 'echo "$${HOME}" %%{x}';
  assert.equal(o.aws.resource.aws_instance.api.user_data, want);
  assert.equal(o.gcp.resource.google_compute_instance.api.metadata["user-data"], want);
  const b64 = o.azure.resource.azurerm_linux_virtual_machine.api.custom_data;
  assert.equal(Buffer.from(b64, "base64").toString(), 'echo "${HOME}" %{x}');
  assert.equal(lit("a ${b} c"), "a $${b} c");
});

test("buckets are private everywhere; names that start with a digit still make valid addresses", () => {
  const o = byCloud(base());
  assert.equal(o.aws.resource.aws_s3_bucket["_9-data"].bucket, "9-data");
  assert.equal(o.aws.resource.aws_s3_bucket_public_access_block["_9-data"].restrict_public_buckets, true);
  assert.equal(o.gcp.resource.google_storage_bucket["_9-data"].public_access_prevention, "enforced");
  assert.equal(o.azure.resource.azurerm_storage_account["_9-data"].name, "9data");
  assert.equal(o.azure.resource.azurerm_storage_account["_9-data"].allow_nested_items_to_be_public, false);
});

test("gpu machine types on gcp stop for maintenance", () => {
  const infra = base();
  infra.instances![0].size = "gpu-small";
  const o = byCloud(infra);
  assert.equal(o.gcp.resource.google_compute_instance.api.scheduling.on_host_maintenance, "TERMINATE");
});

test("extra is merged into its own cloud only", () => {
  const infra = base({ extra: { aws: { resource: { aws_s3_bucket: { logs: { bucket: "t-logs" } } } } } });
  const o = byCloud(infra);
  assert.equal(o.aws.resource.aws_s3_bucket.logs.bucket, "t-logs");
  assert.ok(o.aws.resource.aws_s3_bucket["_9-data"], "merging keeps generated resources");
  assert.equal(o.gcp.resource.aws_s3_bucket, undefined);
});

function withFn(access: "public" | "iam" | "private", subnet?: string, clouds: string[] = ["aws", "gcp"]): Infra {
  const infra = base();
  infra.targets = infra.targets.filter((t) => clouds.includes(t.cloud));
  infra.networks![0].subnets.push({ name: "app2", cidr: "10.0.2.0/24" });
  infra.functions = [
    { name: "api", source: "src", runtime: "node22", command: ["node", "server.js"], access, subnet, env: { A: "${x}" } },
  ];
  return infra;
}

test("functions: public on every cloud", () => {
  const o = byCloud(withFn("public", undefined, ["aws", "gcp", "azure"]));
  assert.equal(o.aws.resource.aws_lambda_function_url.api.authorization_type, "NONE");
  assert.equal(o.aws.resource.aws_lambda_permission.fn_api_invoke.invoked_via_function_url, true);
  assert.equal(o.gcp.resource.google_cloud_run_v2_service.api.ingress, "INGRESS_TRAFFIC_ALL");
  assert.equal(o.gcp.resource.google_cloud_run_v2_service.api.invoker_iam_disabled, true);
  assert.equal(o.azure.resource.azurerm_function_app_flex_consumption.api.runtime_name, "custom");
  for (const c of ["aws", "gcp", "azure"]) assert.ok(o[c].output.api_url, `${c} outputs the url`);
});

test("functions: iam keeps the URL but checks the caller", () => {
  const o = byCloud(withFn("iam"));
  assert.equal(o.aws.resource.aws_lambda_function_url.api.authorization_type, "AWS_IAM");
  assert.equal(o.aws.resource.aws_lambda_permission, undefined);
  assert.equal(o.gcp.resource.google_cloud_run_v2_service.api.invoker_iam_disabled, false);
});

test("functions: private has no internet-facing entry", () => {
  const o = byCloud(withFn("private", "main/app"));
  assert.equal(o.aws.resource.aws_lambda_function_url, undefined);
  assert.equal(o.aws.resource.aws_lb.fn_api.internal, true);
  assert.deepEqual(o.aws.resource.aws_lb.fn_api.subnets, ["${aws_subnet.main_app.id}", "${aws_subnet.main_app2.id}"]);
  assert.equal(o.aws.resource.aws_vpc_security_group_ingress_rule.fn_api_lb_in.cidr_ipv4, "10.0.0.0/16");
  assert.equal(o.aws.resource.aws_lb_target_group.fn_api.target_type, "lambda");
  assert.equal(o.gcp.resource.google_cloud_run_v2_service.api.ingress, "INGRESS_TRAFFIC_INTERNAL_ONLY");
});

test("functions: a subnet puts outbound traffic through the network", () => {
  const o = byCloud(withFn("iam", "main/app"));
  assert.deepEqual(o.aws.resource.aws_lambda_function.api.vpc_config.subnet_ids, ["${aws_subnet.main_app.id}"]);
  assert.equal(o.gcp.resource.google_cloud_run_v2_service.api.template[0].vpc_access[0].egress, "ALL_TRAFFIC");
});

test("functions: Web Adapter wiring and packages", () => {
  const [aws] = generate(withFn("public"), "aws");
  const fn = (aws.json as J).resource.aws_lambda_function.api;
  assert.equal(fn.handler, "paibot-run.sh");
  assert.match(fn.layers[0], /:layer:LambdaAdapterLayerX86:\d+$/);
  assert.equal(fn.environment.variables.AWS_LAMBDA_EXEC_WRAPPER, "/opt/bootstrap");
  assert.equal(fn.environment.variables.A, "$${x}", "env values are escaped");
  assert.deepEqual(
    aws.packages.map((p) => [p.dir, p.files.map((f) => f.path)]),
    [["build/api", ["paibot-run.sh"]]],
  );
  assert.match(aws.packages[0].files[0].content, /exec node server\.js\n$/);
});
