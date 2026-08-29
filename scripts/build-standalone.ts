import { chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { currentReleaseTargetId, findReleaseTarget, releaseTargets } from "./release-targets.ts";

const root = process.cwd();
const requestedTargetId = process.argv[2];
const releaseDir = process.argv[3] ?? join(root, "dist", "release");

function run(command: ReadonlyArray<string>): void {
  const process = Bun.spawnSync({
    cmd: [...command],
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  });
  if (process.exitCode !== 0) {
    throw new Error(`Command failed (${process.exitCode}): ${command.join(" ")}`);
  }
}

async function sha256(path: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(await Bun.file(path).arrayBuffer());
  return hasher.digest("hex");
}

function selectedTargets() {
  if (requestedTargetId === "all") return releaseTargets;

  const targetId = requestedTargetId ?? currentReleaseTargetId();
  const target = findReleaseTarget(targetId);
  if (!target) throw new Error(`Unsupported standalone target: ${targetId ?? "unknown"}`);
  return [target];
}

await rm(releaseDir, { recursive: true, force: true });
await mkdir(releaseDir, { recursive: true });

const checksums: string[] = [];
const hostTargetId = currentReleaseTargetId();

for (const target of selectedTargets()) {
  const stageDir = join(releaseDir, target.id);
  const binaryPath = join(stageDir, "slinky");
  const assetName = `slinky-${target.id}.tar.gz`;
  const assetPath = join(releaseDir, assetName);

  await mkdir(stageDir, { recursive: true });
  run([
    "bun",
    "build",
    "--compile",
    "--bytecode",
    "--format=esm",
    `--target=${target.bunTarget}`,
    // OpenTUI picks its native package from OPENTUI_LIBC while its module graph
    // evaluates. Defining it at build time lets Bun drop the branch it does not
    // need; leaving it undefined keeps both, so a glibc build also wants the
    // musl native package present. We publish glibc only.
    ...(target.os === "linux" ? ["--define", `process.env.OPENTUI_LIBC=${JSON.stringify(target.libc)}`] : []),
    `--outfile=${binaryPath}`,
    "src/standalone.ts",
  ]);
  await chmod(binaryPath, 0o755);

  if (target.id === hostTargetId) {
    // --version returns before the CLI is imported, so on its own it proves
    // nothing about the embedded native library, parser worker or grammars.
    // --selftest drives the renderer the TUI actually uses.
    for (const argv of [["--version"], ["--selftest"]]) {
      const smoke = Bun.spawnSync({
        cmd: [binaryPath, ...argv],
        cwd: root,
        stdout: "pipe",
        stderr: "pipe",
      });
      if (smoke.exitCode !== 0) {
        throw new Error(`Standalone smoke ${argv[0]} failed for ${target.id}: ${smoke.stderr.toString()}`);
      }
    }
  }

  run(["tar", "-czf", assetPath, "-C", stageDir, "slinky"]);
  const checksumLine = `${await sha256(assetPath)}  ${assetName}`;
  checksums.push(checksumLine);
  await writeFile(join(releaseDir, `${assetName}.sha256`), `${checksumLine}\n`);
}

await writeFile(join(releaseDir, "checksums.txt"), `${checksums.join("\n")}\n`);
