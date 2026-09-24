import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { isMap, isScalar, parseDocument } from "yaml";
import { Schema } from "effect";
import { OperationFailed } from "../domain/model.ts";
import { contentHash } from "./hash.ts";
import { inspectCatalogEntry } from "../domain/catalog-inspection.ts";
import type { LiveEntry } from "../domain/catalog-inspection.ts";

const key = "opencode/autoinvoke";
const marker = "slinky:autoinvoke";

function split(text: string) {
  const match = text.match(/^(?:\uFEFF)?---\r?\n(?:([\s\S]*?)\r?\n)?---(?:\r?\n|$)/);
  return { header: match?.[0] ?? "", yaml: match?.[1] ?? "", body: match ? text.slice(match[0].length) : text };
}

function document(text: string) {
  const doc = parseDocument(text);
  if (doc.errors.length) throw new OperationFailed({ message: `invalid skill frontmatter: ${doc.errors[0]?.message}` });
  if (doc.contents !== null && !isMap(doc.contents)) throw new OperationFailed({ message: "skill frontmatter must be a YAML mapping" });
  return doc;
}

// YAML values enter here directly from the parser, before domain interpretation.
// oxlint-disable-next-line anti-slop/no-unknown-parameters
function boolean(value: unknown): boolean | undefined {
  return value === true || value === "true" ? true : value === false || value === "false" ? false : undefined;
}

export function invocationInfo(text: string, preference?: boolean) {
  const doc = document(split(text).yaml);
  const native = boolean(doc.getIn(["metadata", key]));
  const manual = boolean(doc.get("disable-model-invocation")) === true;
  return {
    automatic: preference ?? native ?? !manual,
    source: preference !== undefined ? "host" : native !== undefined ? "upstream" : manual ? "compatibility" : "default",
  } as const;
}

const InvocationReceipt = Schema.Struct({
  source: Schema.String,
  before: Schema.String,
  after: Schema.String,
  automatic: Schema.Boolean,
  generatedHash: Schema.optional(Schema.String),
});
export type InvocationReceipt = typeof InvocationReceipt.Type;
const decodeReceipt = Schema.decodeUnknownSync(InvocationReceipt);

/** Change only frontmatter; the Markdown body is byte-for-byte unchanged. */
export function renderInvocation(text: string, preference?: boolean) {
  const parts = split(text);
  const doc = document(parts.yaml);
  const info = invocationInfo(text, preference);
  const native = boolean(doc.getIn(["metadata", key]));
  if (native === info.automatic || (preference === undefined && info.source === "default")) return { text, info };
  const metadata = doc.get("metadata", true);
  if (metadata !== undefined && !isMap(metadata)) throw new OperationFailed({ message: "skill metadata must be a YAML mapping to set OpenCode invocation" });
  const node = doc.createNode(info.automatic);
  node.comment = ` ${marker}`;
  doc.setIn(["metadata", key], node);
  const newline = parts.header.includes("\r\n") ? "\r\n" : "\n";
  const header = `---\n${doc.toString()}---\n`.replaceAll("\n", newline);
  return { text: header + parts.body, info, receipt: { before: parts.header, after: header, automatic: info.automatic } };
}

/** Receipts and generated local copies live outside all skill discovery directories. */
export function installationPaths(live: string) {
  const root = resolve(dirname(live), "..", ".slinky");
  return { receipt: join(root, "receipts", `${basename(live)}.json`), generated: join(root, "rendered", basename(live)) };
}

export function readReceipt(live: string): InvocationReceipt | undefined {
  const path = installationPaths(live).receipt;
  if (!existsSync(path)) return undefined;
  try {
    return decodeReceipt(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    throw new OperationFailed({ message: `invalid invocation receipt: ${path}` });
  }
}

/** Undo only the field identified by Slinky's marker and receipt. Fresh upstream metadata survives. */
export function undecorate(text: string, receipt?: InvocationReceipt): string {
  const parts = split(text);
  if (receipt && parts.header === receipt.after) return receipt.before + parts.body;
  if (!parts.yaml.includes(marker)) return text;
  const doc = document(parts.yaml);
  const node = doc.getIn(["metadata", key], true);
  if (!isScalar(node) || node.comment?.trim() !== marker) return text;
  if (!receipt) throw new OperationFailed({ message: "managed invocation metadata has no receipt; restore the skill from its catalog" });
  if (boolean(node.value) !== receipt.automatic) throw new OperationFailed({ message: "managed invocation metadata was edited; use slinky autoinvoke or restore the skill" });
  const original = document(split(receipt.before).yaml);
  const originalNode = original.getIn(["metadata", key], true);
  if (originalNode !== undefined) doc.setIn(["metadata", key], originalNode);
  else doc.deleteIn(["metadata", key]);
  const metadata = doc.get("metadata", true);
  if (!original.has("metadata") && isMap(metadata) && metadata.items.length === 0) doc.delete("metadata");
  return `---\n${doc.toString()}---\n${parts.body}`;
}

export function readInstalledFile(live: string, file: string): Buffer {
  const bytes = readFileSync(join(live, file));
  return file === "SKILL.md" ? Buffer.from(undecorate(bytes.toString("utf8"), readReceipt(live))) : bytes;
}

export function installedContentHash(live: string): string {
  return contentHash(live, (file) => readInstalledFile(live, file));
}

export function localInstallationTarget(source: string, live: string, preference?: boolean): string {
  const file = join(source, "SKILL.md");
  if (!existsSync(file)) return source;
  return renderInvocation(readFileSync(file, "utf8"), preference).receipt ? installationPaths(live).generated : source;
}

export function forgetInvocation(live: string): void {
  rmSync(installationPaths(live).receipt, { force: true });
}

export function renderedContentHash(source: string, preference?: boolean): string {
  return contentHash(source, (file) => {
    const bytes = readFileSync(join(source, file));
    return file === "SKILL.md" ? Buffer.from(renderInvocation(bytes.toString("utf8"), preference).text) : bytes;
  });
}

/** Placement and rendered bytes must agree before an installation is healthy. */
export function inspectInstallation(input: {
  origin: "local" | "vendor";
  enabled: boolean;
  live: LiveEntry;
  path: string;
  source: string;
  baselineHash: string;
  preference: boolean | undefined;
  verify: boolean;
}) {
  const generated =
    input.origin === "local" &&
    input.live.kind === "symlink" &&
    input.live.resolved === installationPaths(input.path).generated &&
    readReceipt(input.path)?.source === input.source;
  const inspection = inspectCatalogEntry({
    ...input,
    expectedTarget: generated ? installationPaths(input.path).generated : input.source,
    vendorHash: { kind: "pending" },
  });
  const materialized = generated || (input.origin === "vendor" && input.live.kind === "dir");
  let status = inspection.status;
  if (input.enabled && materialized) {
    status = "checking";
    if (input.verify) {
      const matches = existsSync(input.source)
        ? contentHash(input.path) === renderedContentHash(input.source, input.preference)
        : !generated && installedContentHash(input.path) === input.baselineHash;
      status = matches ? "ok" : "drift";
    }
  } else if (input.enabled && input.origin === "local" && inspection.status === "ok" && localInstallationTarget(input.source, input.path, input.preference) !== input.source) {
    status = "drift";
  }
  return { ...inspection, status };
}

/** Source view for vendor acceptance and diffs; does not mutate the global installation. */
export function withUndecoratedCopy<A>(live: string, use: (copy: string) => A): A {
  if (!readReceipt(live)) return use(live);
  const temp = mkdtempSync(join(tmpdir(), "slinky-source-"));
  const copy = join(temp, basename(live));
  try {
    cpSync(live, copy, { recursive: true, dereference: true });
    const file = join(copy, "SKILL.md");
    if (existsSync(file)) writeFileSync(file, readInstalledFile(live, "SKILL.md"));
    return use(copy);
  } finally {
    rmSync(temp, { recursive: true, force: true });
  }
}

/** Decorate a real installed directory, recording how to recover source bytes. */
export function decorateInstalled(live: string, source: string, preference?: boolean): void {
  const stat = lstatSync(live);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new OperationFailed({ message: `${live}: invocation requires an owned directory` });
  const file = join(live, "SKILL.md");
  if (!existsSync(file)) return;
  const raw = readFileSync(file, "utf8");
  const rendered = renderInvocation(undecorate(raw, readReceipt(live)), preference);
  if (raw === rendered.text) return;
  if (rendered.receipt) {
    const path = installationPaths(live).receipt;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(`${path}.tmp`, JSON.stringify({ ...rendered.receipt, source } satisfies InvocationReceipt));
    renameSync(`${path}.tmp`, path);
  }
  writeFileSync(file, rendered.text);
  if (!rendered.receipt) forgetInvocation(live);
}

/** Generate a local copy while keeping its receipt keyed by the public global path. */
export function generateLocal(source: string, live: string, preference?: boolean): string {
  const target = localInstallationTarget(source, live, preference);
  const generated = installationPaths(live).generated;
  if (existsSync(generated)) {
    const receipt = readReceipt(live);
    if (!receipt?.generatedHash || contentHash(generated) !== receipt.generatedHash) {
      throw new OperationFailed({ message: `${live}: generated local copy was edited; move edits to the catalog source first` });
    }
  }
  if (target === source) {
    rmSync(generated, { recursive: true, force: true });
    forgetInvocation(live);
    return target;
  }
  const rendered = renderInvocation(readFileSync(join(source, "SKILL.md"), "utf8"), preference);
  mkdirSync(dirname(target), { recursive: true });
  rmSync(target, { recursive: true, force: true });
  cpSync(source, target, { recursive: true });
  writeFileSync(join(target, "SKILL.md"), rendered.text);
  const path = installationPaths(live).receipt;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify({ ...rendered.receipt, source, generatedHash: contentHash(target) }));
  return target;
}

/** Remove decoration before skills.sh runs, so downloaded native metadata has clear ownership. */
export function prepareInvocationUpdate(live: string): void {
  if (!existsSync(live) || !readReceipt(live)) return;
  const stat = lstatSync(live);
  if (!stat.isDirectory() || stat.isSymbolicLink()) return;
  const file = join(live, "SKILL.md");
  if (existsSync(file)) writeFileSync(file, readInstalledFile(live, "SKILL.md"));
  forgetInvocation(live);
}
