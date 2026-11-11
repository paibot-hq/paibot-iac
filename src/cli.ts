import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { SIZES, IMAGES } from "./catalog.ts";
import { generate, targetName } from "./generate.ts";
import { findDefinition, loadInfra } from "./load.ts";
import { InfraError } from "./validate.ts";
import { writeOutputs } from "./write.ts";

const HELP = `paibot-iac — write infrastructure once, generate Terraform / OpenTofu for AWS, Google Cloud and Azure

Usage:
  paibot-iac gen   [file] [-o out] [-t target]   Write out/<target>/main.tf.json
  paibot-iac check [file]                        Validate the definition only
  paibot-iac plan    <target> [file] [-o out] [-- args]   gen, init if needed, then plan
  paibot-iac apply   <target> [file] [-o out] [-- args]
  paibot-iac destroy <target> [file] [-o out] [-- args]
  paibot-iac sizes                               Show common sizes and images

The definition defaults to infra.ts / infra.yaml in the current directory.
plan/apply/destroy run \`tofu\`, or \`terraform\` if tofu is missing. Set PAIBOT_IAC_ENGINE to choose.
State is kept in out/<target>/ — do not delete it while resources exist.`;

async function main(argv: string[]): Promise<number> {
  const dashdash = argv.indexOf("--");
  const passthrough = dashdash >= 0 ? argv.slice(dashdash + 1) : [];
  const { values, positionals } = parseArgs({
    args: dashdash >= 0 ? argv.slice(0, dashdash) : argv,
    allowPositionals: true,
    options: {
      out: { type: "string", short: "o", default: "out" },
      target: { type: "string", short: "t" },
      help: { type: "boolean", short: "h" },
    },
  });
  const [cmd, ...rest] = positionals;
  if (values.help || !cmd || cmd === "help") {
    console.log(HELP);
    return cmd || values.help ? 0 : 1;
  }

  switch (cmd) {
    case "sizes": {
      console.log("size        aws            gcp             azure                   ");
      for (const s of SIZES) {
        console.log(`${s.name.padEnd(12)}${s.types.aws.padEnd(15)}${s.types.gcp.padEnd(16)}${s.types.azure.padEnd(24)}${s.summary}`);
      }
      console.log(`\nimages: ${IMAGES.map((i) => i.name).join(", ")}`);
      return 0;
    }
    case "check": {
      const file = rest[0] ?? findDefinition();
      const infra = await loadInfra(file);
      console.log(`ok: ${file} (${infra.targets.map(targetName).join(", ")})`);
      return 0;
    }
    case "gen": {
      const file = rest[0] ?? findDefinition();
      for (const dir of write(await loadInfra(file), values.out!, values.target)) console.log(`wrote ${dir}/main.tf.json`);
      return 0;
    }
    case "plan":
    case "apply":
    case "destroy": {
      const target = rest[0];
      if (!target) throw new Error(`usage: paibot-iac ${cmd} <target> [file]`);
      const file = rest[1] ?? findDefinition();
      const [dir] = write(await loadInfra(file), values.out!, target);
      const engine = pickEngine();
      if (!existsSync(join(dir, ".terraform"))) run(engine, dir, ["init", "-input=false"]);
      return run(engine, dir, [cmd, ...passthrough]);
    }
    default:
      console.error(`unknown command \`${cmd}\`\n\n${HELP}`);
      return 1;
  }
}

function write(infra: Awaited<ReturnType<typeof loadInfra>>, out: string, only?: string): string[] {
  return writeOutputs(generate(infra, only), out);
}

function pickEngine(): string {
  const want = process.env.PAIBOT_IAC_ENGINE;
  if (want) return want;
  for (const e of ["tofu", "terraform"]) {
    if (spawnSync(e, ["version"], { stdio: "ignore" }).status === 0) return e;
  }
  throw new Error("neither tofu nor terraform was found on PATH");
}

function run(engine: string, dir: string, args: string[]): number {
  console.error(`$ ${engine} -chdir=${dir} ${args.join(" ")}`);
  const r = spawnSync(engine, [`-chdir=${dir}`, ...args], { stdio: "inherit" });
  if (r.error) throw r.error;
  if (r.status !== 0 && args[0] === "init") throw new Error(`${engine} init failed`);
  return r.status ?? 1;
}

main(process.argv.slice(2)).then(
  (code) => process.exit(code),
  (e) => {
    if (e instanceof InfraError) console.error(`the definition has problems:\n${e.message}`);
    else console.error(`error: ${e instanceof Error ? e.message : e}`);
    process.exit(1);
  },
);
