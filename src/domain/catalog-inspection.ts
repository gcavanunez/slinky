export type LiveEntry =
  | { readonly kind: "missing" }
  | { readonly kind: "symlink"; readonly resolved: string }
  | { readonly kind: "broken-symlink"; readonly resolved: string }
  | { readonly kind: "dir" }
  | { readonly kind: "file" };

export type LiveKind = LiveEntry["kind"];

export type Placement = "missing" | "expected-symlink" | "wrong-symlink" | "broken-symlink" | "dir" | "file";

export type VendorHashState = { readonly kind: "pending" } | { readonly kind: "verified"; readonly matches: boolean };

export type CatalogLiveStatus = "ok" | "drift" | "missing" | "off" | "stale" | "checking" | "unowned";

export interface CatalogInspection {
  readonly live: LiveEntry;
  readonly placement: Placement;
  readonly vendorHash: VendorHashState;
  readonly status: CatalogLiveStatus;
}

export interface CatalogInspectionInput {
  readonly origin: "local" | "vendor";
  readonly enabled: boolean;
  readonly live: LiveEntry;
  readonly expectedTarget: string;
  readonly vendorHash: VendorHashState;
}

export function classifyPlacement(live: LiveEntry, expectedTarget: string): Placement {
  if (live.kind === "symlink") return live.resolved === expectedTarget ? "expected-symlink" : "wrong-symlink";
  if (live.kind === "broken-symlink") return live.resolved === expectedTarget ? "broken-symlink" : "wrong-symlink";
  return live.kind;
}

export function isDiscoverablePlacement(placement: Placement): boolean {
  return placement === "expected-symlink" || placement === "dir";
}

/** Pure semantic inspection; callers decide how to render or act on the result. */
export function inspectCatalogEntry(input: CatalogInspectionInput): CatalogInspection {
  const placement = classifyPlacement(input.live, input.expectedTarget);
  let status: CatalogLiveStatus;

  if (placement === "wrong-symlink") {
    status = "unowned";
  } else if (!input.enabled) {
    status = placement === "missing" ? "off" : "stale";
  } else if (input.origin === "local") {
    status = placement === "expected-symlink" ? "ok" : "missing";
  } else if (placement !== "dir") {
    status = "missing";
  } else if (input.vendorHash.kind === "pending") {
    status = "checking";
  } else {
    status = input.vendorHash.matches ? "ok" : "drift";
  }

  return { live: input.live, placement, vendorHash: input.vendorHash, status };
}
