import {
  SyncAuthError,
  SyncServerError,
  type PullRow,
  type SyncRequest,
  type SyncResponse,
  type SyncTransport,
} from '@pos/shared';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from './supabaseConfig.js';

/**
 * The real round trip: one HTTP call to one database function.
 *
 * Everything this file does is translation. The rules are in Postgres, the
 * engine is in `services/syncEngine.ts`, and the only job here is to turn one
 * into the other — including turning failures into the right *kind* of
 * failure, because that is what decides whether a row is held against itself:
 *
 *   Unreachable (no DNS, no route, timeout) — a plain Error. Costs the queue
 *   nothing. A shop with a week of bad internet must not come back to a queue
 *   full of rows marked dead.
 *
 *   Refused, with a row named — `SyncServerError` carrying `hint`. That row is
 *   set aside and the rest go.
 *
 *   Sign-in lapsed — `SyncAuthError`. Sync stops and asks for a person; the
 *   till carries on regardless.
 */

/** Long enough for a slow connection, short enough not to hang the loop. */
const REQUEST_TIMEOUT_MS = 45_000;

interface PostgrestError {
  code?: string;
  message?: string;
  details?: string;
  hint?: string;
}

interface RawResponse {
  serverTime: string;
  results: SyncResponse['results'];
  changes: Array<{
    table_name: string;
    id: string;
    server_seq: number;
    data: Record<string, unknown>;
    deleted: boolean;
  }>;
  cursor: number;
  hasMore: boolean;
}

export interface SupabaseTransportDeps {
  /** Supplies a valid access token, renewing it when needed. */
  accessToken: () => Promise<string>;
}

export function createSupabaseTransport(deps: SupabaseTransportDeps): SyncTransport {
  return {
    async exchange(request: SyncRequest): Promise<SyncResponse> {
      const token = await deps.accessToken();

      let response: Response;
      try {
        response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_v1`, {
          method: 'POST',
          headers: {
            apikey: SUPABASE_PUBLISHABLE_KEY,
            Authorization: `Bearer ${token}`,
            'Content-Type': 'application/json',
          },
          // The function takes one argument, named `payload`.
          body: JSON.stringify({ payload: request }),
          signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
        });
      } catch (cause) {
        // Thrown before any reply: no connection, or it gave up waiting.
        throw new Error(
          cause instanceof Error ? `Could not reach the cloud: ${cause.message}` : 'Could not reach the cloud.',
        );
      }

      if (!response.ok) {
        const error = (await response.json().catch(() => ({}))) as PostgrestError;

        // Not a member of this shop. A real refusal, not an expired sign-in —
        // signing in again would change nothing.
        if (error.code === '42501') {
          throw new SyncServerError(
            'This computer is not allowed to sync with the shop account yet.',
            { code: error.code },
          );
        }

        if (response.status === 401 || response.status === 403) {
          throw new SyncAuthError();
        }

        if (response.status >= 500) {
          throw new SyncServerError('The cloud is not answering right now. It will try again.', {
            code: String(response.status),
          });
        }

        throw new SyncServerError(error.message ?? `The cloud refused the request (${response.status}).`, {
          code: error.code ?? null,
          rowKey: error.hint ?? null,
        });
      }

      const raw = (await response.json()) as RawResponse;

      const changes: PullRow[] = (raw.changes ?? []).map((row) => ({
        table: row.table_name,
        id: row.id,
        deleted: row.deleted,
        serverSeq: row.server_seq,
        data: row.data,
      }));

      return {
        serverTime: raw.serverTime,
        results: raw.results ?? [],
        changes,
        cursor: raw.cursor,
        hasMore: raw.hasMore,
      };
    },
  };
}
