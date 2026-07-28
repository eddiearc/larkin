export interface FreshnessTarget {
  provider: string;
  resourceKind: string;
  resourceId: string;
}

export interface FreshnessAdapter<Cursor, Snapshot, Context> {
  cursor(snapshot: Snapshot): Cursor | null;
  compare(seen: Cursor | null, current: Cursor | null): "fresh" | "conflict" | "gap";
  unseen(seen: Cursor | null, snapshot: Snapshot): Context;
}

export type FreshnessGateDecision<Cursor, Snapshot, Context> =
  | { status: "fresh"; current: Cursor | null; snapshot: Snapshot }
  | { status: "conflict"; current: Cursor; snapshot: Snapshot; context: Context }
  | { status: "unavailable"; reason: string };

/** Provider-neutral optimistic gate. Provider fields and cursor ordering stay adapter-owned. */
export function evaluateFreshness<Cursor, Snapshot, Context>(input: {
  seen: Cursor | null;
  probe(): Snapshot;
  adapter: FreshnessAdapter<Cursor, Snapshot, Context>;
}): FreshnessGateDecision<Cursor, Snapshot, Context> {
  let snapshot: Snapshot;
  try {
    snapshot = input.probe();
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
  try {
    const current = input.adapter.cursor(snapshot);
    const comparison = input.adapter.compare(input.seen, current);
    if (comparison === "gap") return { status: "unavailable", reason: "authoritative history cannot establish a comparable head" };
    if (comparison === "fresh") return { status: "fresh", current, snapshot };
    if (!current) return { status: "unavailable", reason: "authoritative history returned an invalid empty cursor" };
    return { status: "conflict", current, snapshot, context: input.adapter.unseen(input.seen, snapshot) };
  } catch (error) {
    return { status: "unavailable", reason: error instanceof Error ? error.message : String(error) };
  }
}
