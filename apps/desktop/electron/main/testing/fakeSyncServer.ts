import {
  SyncServerError,
  decideMasterWrite,
  nowIso,
  rowKey,
  tableKind,
  type PullRow,
  type RowResult,
  type SyncRequest,
  type SyncResponse,
  type SyncTransport,
} from '@pos/shared';

/**
 * A server that follows the same rules, in memory.
 *
 * Deliberately a second implementation rather than a stub. The real rules live
 * in Postgres, where a test cannot reach them, so this stands in for them —
 * and because it is written from the same contract in
 * `packages/shared/src/sync.ts`, the engine tests check the engine against the
 * protocol rather than against whatever the engine happens to do.
 *
 * The behaviours that matter and are easy to fake away:
 *
 *   A refused row aborts the whole request. Nothing is written. This is what
 *   the real function does, because a bill and its lines must land together,
 *   and it is what forces the engine to set the bad row aside rather than
 *   retrying the batch forever.
 *
 *   Every write takes a number from one global sequence, which is what the
 *   client's cursor follows. Not a timestamp: a row committed with a timestamp
 *   older than a watermark already passed would be skipped forever.
 */
export class FakeSyncServer implements SyncTransport {
  private readonly rows = new Map<
    string,
    { table: string; id: string; data: Record<string, unknown>; serverSeq: number; deviceId: string }
  >();

  private sequence = 0;

  /** Round trips attempted, including the ones that threw. */
  requests = 0;

  /** Everything each request carried, for checking order and payloads. */
  readonly received: SyncRequest[] = [];

  /** While true, every call fails the way an unreachable server does. */
  offline = false;

  /** A row the server will always refuse, as `table:id`. */
  poisonRow: string | null = null;

  /** Rows returned per page, so paging can be exercised. */
  pageSize = 500;

  /** The server's clock, so clock-skew rules can be tested. */
  now: () => string = nowIso;

  /** Runs just before the response is returned, to simulate a concurrent edit. */
  onExchange: ((request: SyncRequest) => void) | null = null;

  async exchange(request: SyncRequest): Promise<SyncResponse> {
    this.requests++;
    this.received.push(structuredClone(request));

    if (this.offline) {
      throw new Error('getaddrinfo ENOTFOUND tjanpttaenyqidoltlpk.supabase.co');
    }

    const serverTime = this.now();
    const results: RowResult[] = [];

    // Staged, not written, until the whole request is known to be good.
    const staged: Array<{
      key: string;
      table: string;
      id: string;
      data: Record<string, unknown>;
    }> = [];
    const stagedKeys = new Set<string>();

    for (const change of request.changes) {
      const key = rowKey(change.table, change.id);
      const kind = tableKind(change.table);

      if (this.poisonRow === key) {
        throw new SyncServerError(
          `Could not save ${change.table} ${change.id}: value too long for type character varying`,
          { code: '22023', rowKey: key },
        );
      }

      if (!kind) {
        results.push({
          table: change.table,
          id: change.id,
          status: 'rejected',
          reason: `${change.table} is not a table this shop syncs.`,
        });
        continue;
      }

      const existing = this.rows.get(key);

      if (change.deleted) {
        const base = existing?.data ?? { id: change.id };
        staged.push({
          key,
          table: change.table,
          id: change.id,
          data: { ...base, deleted_at: serverTime },
        });
        stagedKeys.add(key);
        results.push({ table: change.table, id: change.id, status: 'ok' });
        continue;
      }

      if (kind === 'event') {
        // Written once, never changed, so a second copy is a retry.
        if (!existing && !stagedKeys.has(key)) {
          staged.push({ key, table: change.table, id: change.id, data: { ...change.data } });
          stagedKeys.add(key);
        }
        results.push({ table: change.table, id: change.id, status: 'ok' });
        continue;
      }

      const decision = decideMasterWrite(
        { updatedAt: change.updatedAt },
        existing ? { updatedAt: String(existing.data.updated_at ?? '') } : null,
        serverTime,
      );

      if (decision.outcome === 'reject') {
        results.push({
          table: change.table,
          id: change.id,
          status: 'rejected',
          reason: decision.reason,
        });
        continue;
      }

      if (decision.outcome === 'conflict') {
        results.push({
          table: change.table,
          id: change.id,
          status: 'conflict',
          reason: decision.reason,
        });
        continue;
      }

      // Only the columns that were sent, same as the real function: a column
      // this client has never heard of keeps the value it already has.
      staged.push({
        key,
        table: change.table,
        id: change.id,
        data: { ...(existing?.data ?? {}), ...change.data },
      });
      stagedKeys.add(key);
      results.push({ table: change.table, id: change.id, status: 'ok' });
    }

    for (const write of staged) {
      this.sequence++;
      this.rows.set(write.key, {
        table: write.table,
        id: write.id,
        data: write.data,
        serverSeq: this.sequence,
        deviceId: request.deviceId,
      });
    }

    if (this.onExchange) this.onExchange(request);

    const cursor = request.cursor ?? 0;
    const waiting = [...this.rows.values()]
      .filter((row) => row.serverSeq > cursor)
      .sort((a, b) => a.serverSeq - b.serverSeq);

    const limit = Math.min(request.pullLimit, this.pageSize);
    const page = waiting.slice(0, limit);

    const changes: PullRow[] = page.map((row) => ({
      table: row.table,
      id: row.id,
      deleted: row.data.deleted_at != null,
      serverSeq: row.serverSeq,
      data: row.data,
    }));

    const nextCursor = page.at(-1)?.serverSeq ?? cursor;

    return {
      serverTime,
      results,
      changes,
      cursor: nextCursor,
      hasMore: waiting.length > page.length,
    };
  }

  // --- For assertions and for seeding the other side -----------------------

  /** Put a row in as though another device had sent it. */
  seed(table: string, id: string, data: Record<string, unknown>, from = 'website'): void {
    this.sequence++;
    this.rows.set(rowKey(table, id), { table, id, data, serverSeq: this.sequence, deviceId: from });
  }

  get(table: string, id: string): Record<string, unknown> | null {
    return this.rows.get(rowKey(table, id))?.data ?? null;
  }

  has(table: string, id: string): boolean {
    return this.rows.has(rowKey(table, id));
  }

  count(table?: string): number {
    if (!table) return this.rows.size;
    return [...this.rows.values()].filter((row) => row.table === table).length;
  }

  /** The order tables arrived in, across every request. */
  tableOrder(): string[] {
    return this.received.flatMap((request) => request.changes.map((change) => change.table));
  }
}
