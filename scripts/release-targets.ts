export interface ReleaseTarget {
  readonly id: string;
  readonly bunTarget: string;
  readonly os: "darwin" | "linux";
  readonly cpu: "arm64" | "x64";
  /** Which OpenTUI native package to embed; Linux glibc and musl are separate targets. */
  readonly libc?: "glibc" | "musl";
}

export const releaseTargets: ReadonlyArray<ReleaseTarget> = [
  { id: "darwin-arm64", bunTarget: "bun-darwin-arm64", os: "darwin", cpu: "arm64" },
  { id: "darwin-x64", bunTarget: "bun-darwin-x64", os: "darwin", cpu: "x64" },
  { id: "linux-arm64", bunTarget: "bun-linux-arm64", os: "linux", cpu: "arm64", libc: "glibc" },
  { id: "linux-x64", bunTarget: "bun-linux-x64", os: "linux", cpu: "x64", libc: "glibc" },
];

export function currentReleaseTargetId(): string | null {
  const os = process.platform === "darwin" ? "darwin" : process.platform === "linux" ? "linux" : null;
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  return os && arch ? `${os}-${arch}` : null;
}

export function findReleaseTarget(id: string | null | undefined): ReleaseTarget | null {
  return releaseTargets.find((target) => target.id === id) ?? null;
}

export function binaryPackageName(packageName: string, target: ReleaseTarget): string {
  return `${packageName}-${target.id}`;
}

export function standaloneCompileCommand(target: ReleaseTarget, binaryPath: string): ReadonlyArray<string> {
  return [
    "bun",
    "build",
    "--compile",
    "--bytecode",
    "--format=esm",
    `--target=${target.bunTarget}`,
    // OpenTUI chooses its native package while Bun evaluates the module graph.
    ...(target.os === "linux" ? ["--define", `process.env.OPENTUI_LIBC=${JSON.stringify(target.libc)}`] : []),
    `--outfile=${binaryPath}`,
    "src/standalone.ts",
  ];
}
