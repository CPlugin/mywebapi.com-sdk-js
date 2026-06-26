// * paginate — async iterable walking a v2 cursor-paged endpoint. The cursor
// lives in the response envelope's meta.paging ({ nextCursor, hasMore }); the
// caller supplies a fetchPage callback surfacing both items + paging.
import type { PagingMeta } from './errors';

export interface PagedResult<T> {
  items: T[];
  paging?: PagingMeta | null;
}

/**
 * Walk a cursor-paged endpoint as an async iterable, yielding one page of
 * items at a time.
 *
 * @example
 * ```ts
 * for await (const page of paginate((cursor) => client.paged(() =>
 *   client.mt4.getUserRecordsRequest('my-tp', { cursor })
 * ))) {
 *   process(page);
 * }
 * ```
 */
export async function* paginate<T>(
  fetchPage: (cursor: string | undefined) => Promise<PagedResult<T>>,
): AsyncIterable<T[]> {
  let cursor: string | undefined = undefined;
  while (true) {
    const page = await fetchPage(cursor);
    yield page.items;
    if (!page.paging?.hasMore) return;
    cursor = page.paging.nextCursor ?? undefined;
    // ! Defensive: hasMore=true but no cursor → stop to avoid an infinite loop.
    if (!cursor) return;
  }
}

/**
 * Collect all pages into a single array by exhausting the async iterable.
 *
 * ! Memory-bounded only by total result size — prefer the async iterable
 *   (`paginate`) for large collections to process pages one at a time without
 *   accumulating the full dataset in memory.
 */
export async function collectAll<T>(
  fetchPage: (cursor: string | undefined) => Promise<PagedResult<T>>,
): Promise<T[]> {
  const all: T[] = [];
  for await (const page of paginate(fetchPage)) all.push(...page);
  return all;
}
