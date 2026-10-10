import { hash } from '@node-rs/argon2';
import {
  DEFAULT_STAFF_PERMISSIONS,
  PIN_HASH_COST,
  nowIso,
  pinWeakness,
  sanitizePermissions,
  uuidv7,
  type Permission,
} from '@pos/shared';
import { SUPABASE_PUBLISHABLE_KEY, SUPABASE_URL } from '@/lib/shop';

/**
 * The one thing the website needs a server for.
 *
 * Everything else the owner does from their phone goes straight from the
 * browser to the database, because row-level security is already the boundary
 * and a server in the middle could only add a second one to disagree with.
 * Setting a cashier's PIN is different: the PIN must be turned into an Argon2
 * hash somewhere the browser cannot be made to skip, and the plain PIN must
 * never reach the database. So it is sent here over HTTPS, hashed, and
 * forgotten; only the hash is stored, and the counter verifies against it.
 *
 * What this route deliberately does *not* have is any authority of its own. It
 * carries the caller's own sign-in through to the database and writes with
 * that, so it can do nothing the person could not do themselves. There is no
 * service key here, and adding one would quietly make this route the weakest
 * part of the system.
 */

// Argon2 is a native module, so this cannot run on an edge runtime.
export const runtime = 'nodejs';

interface CreateStaff {
  fullName: string;
  username: string;
  pin: string;
  permissions?: Permission[];
}

interface ResetPin {
  userId: string;
  pin: string;
}

function refuse(message: string, status = 400): Response {
  return Response.json({ error: message }, { status });
}

/** The caller's own sign-in, carried through rather than replaced. */
function bearer(request: Request): string | null {
  const header = request.headers.get('authorization') ?? '';
  const match = /^Bearer (.+)$/.exec(header);
  return match?.[1] ?? null;
}

async function push(jwt: string, changes: unknown[]): Promise<{ ok: boolean; reason?: string }> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/rpc/sync_v1`, {
    method: 'POST',
    headers: {
      apikey: SUPABASE_PUBLISHABLE_KEY,
      Authorization: `Bearer ${jwt}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      payload: {
        deviceId: 'the-website',
        clientTime: nowIso(),
        cursor: 0,
        pullLimit: 0,
        changes,
      },
    }),
  });

  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { message?: string };
    return { ok: false, reason: detail.message ?? `The database refused the change (${response.status}).` };
  }

  const reply = (await response.json()) as { results?: Array<{ status: string; reason?: string }> };
  const refused = (reply.results ?? []).filter((row) => row.status !== 'ok');
  if (refused.length) {
    return { ok: false, reason: refused.map((row) => row.reason).filter(Boolean).join(' ') };
  }
  return { ok: true };
}

async function readUsers(jwt: string, query: string): Promise<Array<Record<string, unknown>>> {
  const response = await fetch(`${SUPABASE_URL}/rest/v1/users?${query}`, {
    headers: { apikey: SUPABASE_PUBLISHABLE_KEY, Authorization: `Bearer ${jwt}` },
  });
  if (!response.ok) return [];
  return (await response.json()) as Array<Record<string, unknown>>;
}

export async function POST(request: Request): Promise<Response> {
  const jwt = bearer(request);
  if (!jwt) return refuse('Sign in again and try once more.', 401);

  const body = (await request.json().catch(() => null)) as (CreateStaff & ResetPin) | null;
  if (!body) return refuse('That request did not make sense.');

  // The same rules the counter applies. Checked here rather than trusted from
  // the page, because the page can be bypassed and this cannot.
  const weakness = pinWeakness(String(body.pin ?? ''));
  if (weakness) return refuse(weakness);

  // Hashed before anything else is done with it, and never logged.
  const pinHash = await hash(body.pin, PIN_HASH_COST);
  const when = nowIso();

  // ----- changing an existing person's PIN -----------------------------
  if (body.userId) {
    const [existing] = await readUsers(jwt, `select=id,full_name&id=eq.${body.userId}&limit=1`);
    if (!existing) return refuse('That person is no longer on the list.', 404);

    const result = await push(jwt, [
      {
        table: 'users',
        id: body.userId,
        deleted: false,
        updatedAt: when,
        // Only the two columns that change. Everything else about them,
        // including what they are allowed to do, is left exactly as it was.
        data: { id: body.userId, pin_hash: pinHash, updated_at: when },
      },
    ]);

    if (!result.ok) return refuse(result.reason ?? 'The new PIN was not saved.', 409);
    return Response.json({ ok: true, fullName: existing.full_name });
  }

  // ----- adding a cashier ----------------------------------------------
  const fullName = String(body.fullName ?? '').trim();
  const username = String(body.username ?? '').trim().toLowerCase();

  if (fullName.length < 2) return refuse('Enter the person’s name.');
  if (!/^[a-z0-9_.-]{3,32}$/.test(username)) {
    return refuse('The sign-in name needs 3 to 32 letters, numbers, dots or dashes.');
  }

  const taken = await readUsers(jwt, `select=id&username=eq.${username}&deleted_at=is.null&limit=1`);
  if (taken.length) return refuse('Somebody already signs in with that name.', 409);

  // `sanitizePermissions` keeps only what an owner may hand out — it drops the
  // ones that would let a cashier grant themselves more, which is the whole
  // point of having permissions. It also discards anything unrecognised, so a
  // hand-made request cannot invent one.
  const asked = Array.isArray(body.permissions) ? body.permissions : [...DEFAULT_STAFF_PERMISSIONS];
  const allowed = sanitizePermissions(asked);

  const id = uuidv7();
  const result = await push(jwt, [
    {
      table: 'users',
      id,
      deleted: false,
      updatedAt: when,
      data: {
        id,
        username,
        full_name: fullName,
        pin_hash: pinHash,
        role: 'staff',
        permissions_json: JSON.stringify(allowed),
        is_active: 1,
        failed_attempts: 0,
        created_at: when,
        updated_at: when,
      },
    },
  ]);

  if (!result.ok) return refuse(result.reason ?? 'The new person was not saved.', 409);

  return Response.json({
    ok: true,
    user: { id, username, fullName, role: 'staff', permissions: allowed },
  });
}
