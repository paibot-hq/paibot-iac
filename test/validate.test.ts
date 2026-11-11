import assert from "node:assert/strict";
import { test } from "node:test";
import { InfraError, validate } from "../src/index.ts";

const ok = {
  name: "t",
  targets: [{ cloud: "aws", region: "us-east-1" }],
  networks: [{ name: "n", cidr: "10.0.0.0/16", subnets: [{ name: "a", cidr: "10.0.1.0/24" }] }],
  instances: [{ name: "vm", size: "small", subnet: "n/a" }],
};

function problems(x: unknown): string[] {
  try {
    validate(x);
    return [];
  } catch (e) {
    assert.ok(e instanceof InfraError);
    return e.problems;
  }
}
const clone = () => structuredClone(ok) as any;

test("a minimal definition passes", () => {
  assert.deepEqual(problems(ok), []);
});

test("reports every problem at once", () => {
  const x = clone();
  x.name = "Bad_Name";
  x.instances[0].subnet = "n/missing";
  x.instances[0].size = "huge";
  const p = problems(x);
  assert.equal(p.length, 3, p.join("\n"));
});

test("typos in keys are caught", () => {
  const x = clone();
  x.instances[0].publicIP = true;
  assert.match(problems(x).join(), /unknown key `publicIP`/);
});

test("cidr checks: host bits, outside the network, overlap", () => {
  const x = clone();
  x.networks[0].subnets = [
    { name: "a", cidr: "10.0.1.5/24" },
    { name: "b", cidr: "10.1.0.0/24" },
    { name: "c", cidr: "10.0.2.0/23" },
    { name: "d", cidr: "10.0.3.0/24" },
  ];
  x.instances = [];
  const p = problems(x).join("\n");
  assert.match(p, /host bits set; did you mean 10\.0\.1\.0\/24/);
  assert.match(p, /outside n/);
  assert.match(p, /n\/d and n\/c overlap/);
});

test("rules that only some clouds could honour are rejected", () => {
  const x = clone();
  x.instances[0].publicIp = true;
  assert.match(problems(x).join(), /needs a public subnet/);

  const y = clone();
  y.networks[0].nat = true;
  assert.match(problems(y).join(), /no public subnet to put the NAT in/);
});

test("cloud-specific requirements", () => {
  const x = clone();
  x.targets.push({ cloud: "gcp", region: "us-central1" }, { cloud: "azure", region: "eastus" });
  const p = problems(x).join("\n");
  assert.match(p, /gcp needs `project`/);
  assert.match(p, /azure VMs need `sshKey`/);
});

test("size can be left out only when every target names its own type", () => {
  const x = clone();
  delete x.instances[0].size;
  assert.match(problems(x).join(), /set `size`, or `overrides.aws.type`/);
  x.instances[0].overrides = { aws: { type: "c7g.large" } };
  assert.deepEqual(problems(x), []);
});

test("ports and protocols", () => {
  const x = clone();
  x.instances[0].ingress = [{ protocol: "icmp", ports: [0, "9-1", "22"], from: ["0.0.0.0/0"] }];
  const p = problems(x).join("\n");
  assert.match(p, /protocol must be tcp or udp/);
  assert.match(p, /port 0 is out of range/);
  assert.match(p, /`9-1` is not a port/);
});

test("azure storage account names", () => {
  const x = clone();
  x.targets.push({ cloud: "azure", region: "eastus" });
  x.sshKey = "ssh-ed25519 AAAA";
  x.buckets = [{ name: "a-b" }, { name: "this-name-is-way-too-long-for-azure-storage" }];
  const p = problems(x).join("\n");
  assert.match(p, /storage account would be `ab`/);
  assert.match(p, /storage account would be `thisnameiswaytoolongforazurestorage`/);
});

test("two targets on one cloud need distinct names", () => {
  const x = clone();
  x.targets.push({ cloud: "aws", region: "us-west-2" });
  assert.match(problems(x).join(), /both named `aws`/);
  x.targets[1].name = "aws-west";
  assert.deepEqual(problems(x), []);
});
