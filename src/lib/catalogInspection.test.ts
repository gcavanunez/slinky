import { describe, expect, test } from "bun:test";
import type { CatalogLiveStatus, LiveEntry, Placement, VendorHashState } from "./catalogInspection.ts";
import { inspectCatalogEntry } from "./catalogInspection.ts";

const EXPECTED = "/repo/skills/example";

interface Case {
  readonly name: string;
  readonly origin: "local" | "vendor";
  readonly enabled: boolean;
  readonly live: LiveEntry;
  readonly hash?: VendorHashState;
  readonly placement: Placement;
  readonly status: CatalogLiveStatus;
}

const cases: Case[] = [
  { name: "enabled local expected symlink", origin: "local", enabled: true, live: { kind: "symlink", resolved: EXPECTED }, placement: "expected-symlink", status: "ok" },
  { name: "enabled local wrong symlink", origin: "local", enabled: true, live: { kind: "symlink", resolved: "/elsewhere/example" }, placement: "wrong-symlink", status: "unowned" },
  { name: "enabled local missing", origin: "local", enabled: true, live: { kind: "missing" }, placement: "missing", status: "missing" },
  { name: "enabled local directory", origin: "local", enabled: true, live: { kind: "dir" }, placement: "dir", status: "missing" },
  { name: "enabled local file", origin: "local", enabled: true, live: { kind: "file" }, placement: "file", status: "missing" },
  { name: "enabled local broken symlink", origin: "local", enabled: true, live: { kind: "broken-symlink", resolved: EXPECTED }, placement: "broken-symlink", status: "missing" },
  {
    name: "enabled local broken wrong symlink",
    origin: "local",
    enabled: true,
    live: { kind: "broken-symlink", resolved: "/elsewhere/example" },
    placement: "wrong-symlink",
    status: "unowned",
  },
  { name: "disabled local missing", origin: "local", enabled: false, live: { kind: "missing" }, placement: "missing", status: "off" },
  { name: "disabled local symlink", origin: "local", enabled: false, live: { kind: "symlink", resolved: EXPECTED }, placement: "expected-symlink", status: "stale" },
  {
    name: "disabled local wrong symlink",
    origin: "local",
    enabled: false,
    live: { kind: "symlink", resolved: "/elsewhere/example" },
    placement: "wrong-symlink",
    status: "unowned",
  },
  { name: "disabled local directory", origin: "local", enabled: false, live: { kind: "dir" }, placement: "dir", status: "stale" },
  { name: "disabled local file", origin: "local", enabled: false, live: { kind: "file" }, placement: "file", status: "stale" },
  { name: "disabled local broken symlink", origin: "local", enabled: false, live: { kind: "broken-symlink", resolved: EXPECTED }, placement: "broken-symlink", status: "stale" },
  { name: "enabled vendor missing", origin: "vendor", enabled: true, live: { kind: "missing" }, placement: "missing", status: "missing" },
  { name: "enabled vendor directory pending hash", origin: "vendor", enabled: true, live: { kind: "dir" }, hash: { kind: "pending" }, placement: "dir", status: "checking" },
  {
    name: "enabled vendor directory verified matching",
    origin: "vendor",
    enabled: true,
    live: { kind: "dir" },
    hash: { kind: "verified", matches: true },
    placement: "dir",
    status: "ok",
  },
  {
    name: "enabled vendor directory verified drifted",
    origin: "vendor",
    enabled: true,
    live: { kind: "dir" },
    hash: { kind: "verified", matches: false },
    placement: "dir",
    status: "drift",
  },
  { name: "enabled vendor expected symlink", origin: "vendor", enabled: true, live: { kind: "symlink", resolved: EXPECTED }, placement: "expected-symlink", status: "missing" },
  {
    name: "enabled vendor wrong symlink",
    origin: "vendor",
    enabled: true,
    live: { kind: "symlink", resolved: "/elsewhere/example" },
    placement: "wrong-symlink",
    status: "unowned",
  },
  { name: "enabled vendor file", origin: "vendor", enabled: true, live: { kind: "file" }, placement: "file", status: "missing" },
  { name: "enabled vendor broken symlink", origin: "vendor", enabled: true, live: { kind: "broken-symlink", resolved: EXPECTED }, placement: "broken-symlink", status: "missing" },
  { name: "disabled vendor missing", origin: "vendor", enabled: false, live: { kind: "missing" }, placement: "missing", status: "off" },
  {
    name: "disabled vendor verified directory",
    origin: "vendor",
    enabled: false,
    live: { kind: "dir" },
    hash: { kind: "verified", matches: true },
    placement: "dir",
    status: "stale",
  },
  { name: "disabled vendor pending directory", origin: "vendor", enabled: false, live: { kind: "dir" }, hash: { kind: "pending" }, placement: "dir", status: "stale" },
  {
    name: "disabled vendor wrong symlink",
    origin: "vendor",
    enabled: false,
    live: { kind: "symlink", resolved: "/elsewhere/example" },
    placement: "wrong-symlink",
    status: "unowned",
  },
  { name: "disabled vendor file", origin: "vendor", enabled: false, live: { kind: "file" }, placement: "file", status: "stale" },
  { name: "disabled vendor broken symlink", origin: "vendor", enabled: false, live: { kind: "broken-symlink", resolved: EXPECTED }, placement: "broken-symlink", status: "stale" },
];

describe("inspectCatalogEntry", () => {
  test.each(cases)("$name", ({ origin, enabled, live, hash, placement, status }) => {
    const inspection = inspectCatalogEntry({
      origin,
      enabled,
      live,
      expectedTarget: EXPECTED,
      vendorHash: hash ?? { kind: "pending" },
    });

    expect(inspection).toMatchObject({ live, placement, status, vendorHash: hash ?? { kind: "pending" } });
  });
});
