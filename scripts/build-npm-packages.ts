import { chmod, cp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Schema } from "effect";
import { requireReleaseBinary } from "./release-artifact-identity.ts";
import { binaryPackageName, currentReleaseTargetId, findReleaseTarget, releaseTargets, standaloneCompileCommand, type ReleaseTarget } from "./release-targets.ts";

const root = process.cwd();
const RootPackage = Schema.Struct({
  name: Schema.String,
  version: Schema.String,
  description: Schema.String,
  license: Schema.String,
  engines: Schema.Struct({ node: Schema.String }),
  repository: Schema.Struct({ type: Schema.String, url: Schema.String }),
  bugs: Schema.Struct({ url: Schema.String }),
  homepage: Schema.String,
});
const rootPackage = Schema.decodeUnknownSync(RootPackage)(await Bun.file(join(root, "package.json")).json());

const outDir = join(root, "dist", "npm");
const requested = process.argv[2];
const reuseReleaseBinary = process.env.SLINKY_REUSE_RELEASE_BINARY === "1";

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

function selectedTargets(): ReadonlyArray<ReleaseTarget> {
  if (requested === "main") return [];
  if (requested === "all") return releaseTargets;

  const targetId = requested ?? currentReleaseTargetId();
  const target = findReleaseTarget(targetId);
  if (!target) throw new Error(`Unsupported npm binary target: ${targetId ?? "unknown"}`);
  return [target];
}

const writeJson = (path: string, value: Schema.Json) => writeFile(path, `${JSON.stringify(value, null, 2)}\n`);

function packageMetadata(target: ReleaseTarget) {
  const base = {
    name: binaryPackageName(rootPackage.name, target),
    version: rootPackage.version,
    description: `${rootPackage.description} (${target.id} binary)`,
    license: rootPackage.license,
    repository: rootPackage.repository,
    bugs: rootPackage.bugs,
    homepage: rootPackage.homepage,
    os: [target.os],
    cpu: [target.cpu],
  };
  const trailing = {
    files: ["bin", "LICENSE"],
    publishConfig: {
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
    },
  };
  return target.os === "linux" ? { ...base, libc: ["glibc"], ...trailing } : { ...base, ...trailing };
}

async function buildBinaryPackage(target: ReleaseTarget): Promise<void> {
  const packageDir = join(outDir, "binaries", target.id);
  const binDir = join(packageDir, "bin");
  const binaryPath = join(binDir, "slinky");
  const releaseBinaryPath = join(root, "dist", "release", target.id, "slinky");

  if (reuseReleaseBinary) await requireReleaseBinary(releaseBinaryPath, target.id);
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(binDir, { recursive: true });
  if (reuseReleaseBinary) {
    await cp(releaseBinaryPath, binaryPath);
  } else {
    run(standaloneCompileCommand(target, binaryPath));
  }
  await chmod(binaryPath, 0o755);
  await cp(join(root, "LICENSE"), join(packageDir, "LICENSE"));
  await writeJson(join(packageDir, "package.json"), packageMetadata(target));

  if (target.id === currentReleaseTargetId()) {
    const version = Bun.spawnSync({
      cmd: [binaryPath, "--version"],
      cwd: root,
      stdout: "pipe",
      stderr: "pipe",
    });
    if (version.exitCode !== 0) {
      throw new Error(`Binary package smoke failed for ${target.id}: ${version.stderr.toString()}`);
    }
  }
}

async function buildMainPackage(): Promise<void> {
  const packageDir = join(outDir, "main");
  await rm(packageDir, { recursive: true, force: true });
  await mkdir(join(packageDir, "bin"), { recursive: true });
  await cp(join(root, "bin", "slinky.js"), join(packageDir, "bin", "slinky.js"));
  await cp(join(root, "README.md"), join(packageDir, "README.md"));
  await cp(join(root, "LICENSE"), join(packageDir, "LICENSE"));

  await writeJson(join(packageDir, "package.json"), {
    name: rootPackage.name,
    version: rootPackage.version,
    description: rootPackage.description,
    type: "module",
    license: rootPackage.license,
    engines: rootPackage.engines,
    repository: rootPackage.repository,
    bugs: rootPackage.bugs,
    homepage: rootPackage.homepage,
    keywords: ["agents", "skills", "terminal", "tui", "bun"],
    bin: { slinky: "bin/slinky.js" },
    files: ["bin", "README.md", "LICENSE"],
    optionalDependencies: Object.fromEntries(releaseTargets.map((target) => [binaryPackageName(rootPackage.name, target), rootPackage.version])),
    publishConfig: {
      access: "public",
      provenance: true,
      registry: "https://registry.npmjs.org/",
    },
  });
}

if (requested === undefined) await rm(outDir, { recursive: true, force: true });
for (const target of selectedTargets()) await buildBinaryPackage(target);
if (requested === undefined || requested === "main") await buildMainPackage();
