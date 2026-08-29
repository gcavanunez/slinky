import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Schema } from "effect";
import { binaryPackageName as binaryPackageNameForTarget, currentReleaseTargetId, findReleaseTarget } from "./release-targets.ts";

interface CommandResult {
  readonly stdout: string;
  readonly stderr: string;
}

const root = process.cwd();
const RootPackage = Schema.Struct({ name: Schema.String, version: Schema.String });
const InstalledPackage = Schema.Struct({
  optionalDependencies: Schema.optionalKey(Schema.Record(Schema.String, Schema.String)),
  version: Schema.String,
});
const rootPackage = Schema.decodeUnknownSync(RootPackage)(await Bun.file(join(root, "package.json")).json());
const targetId = currentReleaseTargetId();
const target = findReleaseTarget(targetId);
const binaryPackageName = target ? binaryPackageNameForTarget(rootPackage.name, target) : null;

function run(command: ReadonlyArray<string>, cwd: string): CommandResult {
  const process = Bun.spawnSync({
    cmd: [...command],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  const result = { stdout: process.stdout.toString(), stderr: process.stderr.toString() };
  if (process.exitCode !== 0) {
    throw new Error(`Command failed (${process.exitCode}): ${command.join(" ")}\n${result.stdout}${result.stderr}`);
  }
  return result;
}

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function assertInstalledPackage(projectDir: string): Promise<void> {
  const packageDir = join(projectDir, "node_modules", "@gcavanunez", "slinky");
  const binaryPackageDir = targetId ? join(projectDir, "node_modules", "@gcavanunez", `slinky-${targetId}`) : null;
  const packageJson = Schema.decodeUnknownSync(InstalledPackage)(JSON.parse(await readFile(join(packageDir, "package.json"), "utf8")));

  assert(packageJson.version === rootPackage.version, `Expected installed version ${rootPackage.version}`);
  assert(binaryPackageName !== null && packageJson.optionalDependencies?.[binaryPackageName] === rootPackage.version, `Published package must depend on ${binaryPackageName}`);
  assert(binaryPackageDir !== null && (await Bun.file(join(binaryPackageDir, "bin", "slinky")).exists()), "Installed package must include the platform binary");
  assert(!(await Bun.file(join(packageDir, "src", "cli.ts")).exists()), "Published package must not rely on TypeScript sources");

  const slinky = join(projectDir, "node_modules", ".bin", "slinky");
  const version = run([slinky, "--version"], projectDir);
  assert(version.stdout.trim() === rootPackage.version, `Expected slinky --version to print ${rootPackage.version}, got ${JSON.stringify(version.stdout.trim())}`);

  // --version short-circuits before OpenTUI is imported, so it would pass even
  // if the published binary could not load its native library. Exercise the
  // renderer through the npm wrapper the way a user reaches it.
  const selftest = run([slinky, "--selftest"], projectDir);
  assert(selftest.stdout.includes("ok  native renderer"), `Expected slinky --selftest to reach the native renderer, got ${JSON.stringify(selftest.stdout)}`);
}

async function pack(cwd: string, packDir: string): Promise<string> {
  const result = run(["npm", "pack", "--pack-destination", packDir], cwd);
  const lines = result.stdout.trim().split("\n");
  const tarballName = lines[lines.length - 1];
  if (!tarballName?.endsWith(".tgz")) {
    throw new Error(`Could not determine tarball name: ${result.stdout}`);
  }
  return join(packDir, tarballName);
}

const tempRoot = await mkdtemp(join(tmpdir(), "slinky-package-smoke-"));
try {
  assert(binaryPackageName !== null && targetId !== null, `Unsupported package smoke platform: ${process.platform}-${process.arch}`);

  const packDir = join(tempRoot, "pack");
  const npmProject = join(tempRoot, "npm-install");
  const bunProject = join(tempRoot, "bun-install");
  await Promise.all([mkdir(packDir, { recursive: true }), mkdir(npmProject, { recursive: true }), mkdir(bunProject, { recursive: true })]);

  run(["bun", "run", "build:npm-packages"], root);
  const binaryTarball = await pack(join(root, "dist", "npm", "binaries", targetId), packDir);
  const mainTarball = await pack(join(root, "dist", "npm", "main"), packDir);

  run(["npm", "install", binaryTarball, mainTarball], npmProject);
  await assertInstalledPackage(npmProject);

  run(["bun", "add", binaryTarball, mainTarball], bunProject);
  await assertInstalledPackage(bunProject);
} finally {
  await rm(tempRoot, { recursive: true, force: true });
}
