#!/usr/bin/env node

import childProcess from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";

const filename = fileURLToPath(import.meta.url);
const requireFromHere = createRequire(import.meta.url);
const packageJson = requireFromHere("../package.json");

const platformMap = {
  darwin: "darwin",
  linux: "linux",
};

const archMap = {
  arm64: "arm64",
  x64: "x64",
};

const run = (target, args = process.argv.slice(2)) => {
  const result = childProcess.spawnSync(target, args, { stdio: "inherit" });
  if (result.error) {
    console.error(result.error.message);
    process.exit(1);
  }
  process.exit(result.status ?? 1);
};

if (process.env.SLINKY_BIN_PATH) run(process.env.SLINKY_BIN_PATH);

const platform = platformMap[os.platform()];
const arch = archMap[os.arch()];

const isMusl = () => {
  if (os.platform() !== "linux") return false;
  try {
    if (fs.existsSync("/etc/alpine-release")) return true;
  } catch {}
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    return `${result.stdout ?? ""}${result.stderr ?? ""}`.toLowerCase().includes("musl");
  } catch {
    return false;
  }
};

if (!platform || !arch) {
  console.error(`Unsupported platform for ${packageJson.name}: ${os.platform()}-${os.arch()}`);
  process.exit(1);
}

if (platform === "linux" && isMusl()) {
  console.error(`${packageJson.name} does not publish musl Linux binaries yet.`);
  console.error("Use a glibc-based Linux distribution or the source checkout with Bun.");
  process.exit(1);
}

const packageName = `${packageJson.name}-${platform}-${arch}`;

const resolveBinary = () => {
  try {
    const packageJsonPath = requireFromHere.resolve(`${packageName}/package.json`);
    return path.join(path.dirname(packageJsonPath), "bin", "slinky");
  } catch {
    return null;
  }
};

const binaryPath = resolveBinary();

if (!binaryPath || !fs.existsSync(binaryPath)) {
  const sourceEntry = path.join(path.dirname(fs.realpathSync(filename)), "..", "src", "standalone.ts");
  if (fs.existsSync(sourceEntry)) run("bun", [sourceEntry, ...process.argv.slice(2)]);

  console.error(`Could not find the ${packageName} binary package for this platform.`);
  console.error(`Try reinstalling ${packageJson.name}, or install ${packageName} manually.`);
  process.exit(1);
}

run(binaryPath);
