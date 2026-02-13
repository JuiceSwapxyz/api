import { PonderClient } from "../services/PonderClient";

/**
 * Generic paginated fetch for Ponder GraphQL queries.
 *
 * Handles cursor-based pagination using timestamp + id deduplication,
 * which is the standard pattern for Ponder `orderBy: "timestamp"` or
 * `orderBy: "blockTimestamp"` queries that may exceed the per-page limit.
 */
/**
 * The query string passed to ponderPaginate MUST use `limit: 1000` so the
 * early-exit heuristic (`rawItems.length < PAGE_LIMIT`) stays in sync.
 */
const PAGE_LIMIT = 1000;
const MAX_PAGES = 10; // Safety cap: 10k records max

export async function ponderPaginate<T extends { id: string }>(opts: {
  ponderClient: PonderClient;
  query: string;
  variables: Record<string, unknown>;
  /** Top-level field in the GraphQL response, e.g. "poolStats" or "poolActivitys" */
  itemsPath: string;
  /** Field used for cursor advancement, e.g. "timestamp" or "blockTimestamp" */
  timestampField: string;
  /** Name of the gte filter variable, e.g. "timestamp_gte" or "blockTimestamp_gte" */
  timestampFilterKey: string;
}): Promise<T[]> {
  const {
    ponderClient,
    query,
    variables,
    itemsPath,
    timestampField,
    timestampFilterKey,
  } = opts;

  const accumulated: T[] = [];
  let lastTimestamp = (variables.where as Record<string, unknown>)?.[
    timestampFilterKey
  ] as string;
  let lastId: string | undefined;

  for (let page = 0; page < MAX_PAGES; page++) {
    const where = {
      ...((variables.where as Record<string, unknown>) ?? {}),
      [timestampFilterKey]: lastTimestamp,
    };

    const result = await ponderClient.query(query, { ...variables, where });

    const rawItems: T[] =
      (result as Record<string, { items?: T[] }>)[itemsPath]?.items || [];
    if (rawItems.length === 0) break;

    // Deduplicate: when re-fetching from the same timestamp, skip already-seen records
    let items = rawItems;
    if (lastId) {
      const idx = items.findIndex((a) => a.id === lastId);
      if (idx >= 0) {
        items = items.slice(idx + 1);
      }
    }

    if (items.length > 0) {
      accumulated.push(...items);
    }

    // Stop if this page wasn't full (no more data)
    if (rawItems.length < PAGE_LIMIT) break;

    // No new items means all records at this timestamp were already seen
    if (items.length === 0) break;

    // Advance cursor using compound timestamp + id to avoid skipping same-block records
    const lastItem = items[items.length - 1];
    lastTimestamp = (lastItem as Record<string, unknown>)[
      timestampField
    ] as string;
    lastId = lastItem.id;
  }

  return accumulated;
}
