import { describe, expect, test } from 'bun:test';
import { paginate, collectAll, type PagedResult } from '../src/pagination';

function pager(): (cursor: string | undefined) => Promise<PagedResult<number>> {
  const pages: Record<string, PagedResult<number>> = {
    '': { items: [1, 2], paging: { nextCursor: 'c1', hasMore: true } },
    c1: { items: [3, 4], paging: { nextCursor: 'c2', hasMore: true } },
    c2: { items: [5], paging: { nextCursor: null, hasMore: false } },
  };
  return async (cursor) => pages[cursor ?? '']!;
}

describe('pagination', () => {
  test('paginate yields each page until hasMore=false', async () => {
    const seen: number[][] = [];
    for await (const page of paginate(pager())) seen.push(page);
    expect(seen).toEqual([[1, 2], [3, 4], [5]]);
  });
  test('collectAll flattens every item', async () => {
    expect(await collectAll(pager())).toEqual([1, 2, 3, 4, 5]);
  });
  test('stops if hasMore=true but nextCursor missing (defensive)', async () => {
    const fetchPage = async (): Promise<PagedResult<number>> => ({ items: [9], paging: { hasMore: true, nextCursor: null } });
    expect(await collectAll(fetchPage)).toEqual([9]);
  });
});
