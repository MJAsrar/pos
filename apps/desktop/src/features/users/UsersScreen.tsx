import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  DEFAULT_STAFF_PERMISSIONS,
  PERMISSION_LABELS,
  formatDateTime,
  type Permission,
  type Role,
} from '@pos/shared';
import { Button } from '@/components/Button';
import { Field } from '@/components/Field';
import { Modal } from '@/components/Modal';
import { PageHeader } from '@/components/PageHeader';
import { PinPad } from '@/components/PinPad';
import { ApiError, api, type UserRecord } from '@/lib/api';
import { useSession } from '@/lib/session';

/**
 * Staff accounts and what each of them may do.
 *
 * The permission list is a plain checklist rather than named roles, because a
 * shop's arrangement is particular: one person can be trusted to bargain but not
 * to see cost, another the other way round.
 */
export function UsersScreen(): React.JSX.Element {
  const { user: me } = useSession();
  const [editing, setEditing] = useState<UserRecord | null | 'new'>(null);
  const [pinFor, setPinFor] = useState<UserRecord | null>(null);

  const users = useQuery({ queryKey: ['users'], queryFn: api.users });

  return (
    <div className="flex h-full min-h-0 flex-col">
      <PageHeader
        title="Users"
        subtitle="Everyone who can sign in at the counter"
        actions={
          <Button variant="primary" onClick={() => setEditing('new')}>
            Add a person
          </Button>
        }
      />

      {users.isPending && <p className="px-6 py-8 text-ink-soft">Loading…</p>}

      <div className="min-h-0 flex-1 overflow-y-auto">
        <ul className="divide-y divide-rule">
          {users.data?.map((person) => (
            <li key={person.id} className="flex items-start justify-between gap-6 px-6 py-4">
              <div className="min-w-0">
                <p className="text-row font-medium text-ink">
                  {person.fullName}
                  {person.id === me.id && (
                    <span className="ml-2 text-meta font-normal text-ink-soft">you</span>
                  )}
                  {!person.isActive && (
                    <span className="ml-2 rounded bg-sunk px-1.5 py-0.5 text-micro text-ink-soft">
                      switched off
                    </span>
                  )}
                </p>
                <p className="text-meta text-ink-soft">
                  {person.role === 'admin' ? 'Owner — can do everything' : `Staff — ${person.username}`}
                </p>

                {person.role === 'staff' && (
                  <p className="mt-1.5 text-meta text-ink-faint">
                    {person.permissions.length === 0
                      ? 'Cannot do anything yet'
                      : person.permissions.map((code) => PERMISSION_LABELS[code]).join(', ')}
                  </p>
                )}

                <p className="mt-1.5 text-micro text-ink-faint">
                  {person.lastLoginAt
                    ? `Last signed in ${formatDateTime(person.lastLoginAt)}`
                    : 'Has never signed in'}
                  {person.lockedUntil && new Date(person.lockedUntil) > new Date() && (
                    <span className="ml-2 text-due">locked after wrong PINs</span>
                  )}
                </p>
              </div>

              <div className="flex shrink-0 gap-2">
                <Button onClick={() => setPinFor(person)}>Change PIN</Button>
                <Button onClick={() => setEditing(person)}>Edit</Button>
              </div>
            </li>
          ))}
        </ul>
      </div>

      <UserEditorDialog
        open={editing !== null}
        user={editing === 'new' ? null : editing}
        isSelf={editing !== null && editing !== 'new' && editing.id === me.id}
        onClose={() => setEditing(null)}
      />

      <ChangePinDialog open={pinFor !== null} user={pinFor} onClose={() => setPinFor(null)} />
    </div>
  );
}

function UserEditorDialog({
  open,
  user,
  isSelf,
  onClose,
}: {
  open: boolean;
  user: UserRecord | null;
  isSelf: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [fullName, setFullName] = useState('');
  const [username, setUsername] = useState('');
  const [role, setRole] = useState<Role>('staff');
  const [permissions, setPermissions] = useState<Permission[]>([]);
  const [isActive, setIsActive] = useState(true);
  const [pin, setPin] = useState('');

  const isNew = user === null;
  const grantable = useQuery({
    queryKey: ['grantablePermissions'],
    queryFn: api.grantablePermissions,
    enabled: open,
  });

  useEffect(() => {
    if (!open) return;
    setFullName(user?.fullName ?? '');
    setUsername(user?.username ?? '');
    setRole(user?.role ?? 'staff');
    setPermissions(user?.permissions ?? [...DEFAULT_STAFF_PERMISSIONS]);
    setIsActive(user?.isActive ?? true);
    setPin('');
  }, [open, user]);

  const save = useMutation({
    mutationFn: () =>
      user
        ? api.saveUser({ id: user.id, fullName: fullName.trim(), username: username.trim(), role, permissions, isActive })
        : api.createUser({ fullName: fullName.trim(), username: username.trim(), pin, role, permissions }),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      void queryClient.invalidateQueries({ queryKey: ['app.status'] });
      onClose();
    },
  });

  const error = save.error instanceof ApiError ? save.error : null;
  const ready =
    fullName.trim().length >= 2 && username.trim().length >= 3 && (!isNew || pin.length === 4);

  function toggle(permission: Permission): void {
    setPermissions((current) =>
      current.includes(permission)
        ? current.filter((value) => value !== permission)
        : [...current, permission],
    );
  }

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={isNew ? 'Add a person' : fullName || 'Edit person'}
      width="md"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button variant="primary" onClick={() => save.mutate()} disabled={!ready || save.isPending}>
            {save.isPending ? 'Saving…' : isNew ? 'Add person' : 'Save changes'}
          </Button>
        </>
      }
    >
      <div className="space-y-5">
        <div className="grid grid-cols-2 gap-4">
          <Field
            label="Name"
            data-autofocus
            value={fullName}
            onChange={(event) => setFullName(event.target.value)}
            maxLength={60}
          />
          <Field
            label="Username"
            value={username}
            onChange={(event) => setUsername(event.target.value.toLowerCase())}
            hint="Letters and numbers, no spaces"
            error={error?.code === 'username_taken' ? error.message : undefined}
            maxLength={32}
          />
        </div>

        <div>
          <span className="mb-1.5 block text-meta font-medium text-ink-soft">What they are</span>
          <div className="grid grid-cols-2 gap-2">
            {(['staff', 'admin'] as Role[]).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setRole(option)}
                className={`rounded border px-3 py-2.5 text-left transition-colors duration-100 ${
                  role === option
                    ? 'border-board bg-board-tint text-ink'
                    : 'border-rule-strong bg-surface text-ink-soft hover:border-ink-soft'
                }`}
              >
                <span className="block text-base font-medium">
                  {option === 'admin' ? 'Owner' : 'Staff'}
                </span>
                <span className="block text-meta">
                  {option === 'admin' ? 'Can do everything' : 'Only what you tick below'}
                </span>
              </button>
            ))}
          </div>
        </div>

        {role === 'staff' && (
          <fieldset className="border-t border-rule pt-4">
            <legend className="text-meta font-medium text-ink-soft">What they can do</legend>
            <div className="mt-2 grid grid-cols-2 gap-x-6 gap-y-1.5">
              {grantable.data?.map((permission) => (
                <label key={permission} className="flex items-center gap-2 text-base text-ink">
                  <input
                    type="checkbox"
                    checked={permissions.includes(permission)}
                    onChange={() => toggle(permission)}
                    className="size-4 accent-board"
                  />
                  {PERMISSION_LABELS[permission]}
                </label>
              ))}
            </div>
          </fieldset>
        )}

        {isNew && (
          <div className="border-t border-rule pt-4">
            <p className="mb-3 text-meta font-medium text-ink-soft">
              Their PIN — they will type this to sign in
            </p>
            <PinPad value={pin} onChange={setPin} />
          </div>
        )}

        {!isNew && (
          <label className="flex items-center gap-2.5 border-t border-rule pt-4 text-base text-ink">
            <input
              type="checkbox"
              checked={isActive}
              onChange={(event) => setIsActive(event.target.checked)}
              disabled={isSelf}
              className="size-4 accent-board"
            />
            Can sign in
            {isSelf && <span className="text-meta text-ink-faint">— you cannot switch yourself off</span>}
          </label>
        )}

        {error && !error.fields['username'] && error.code !== 'username_taken' && (
          <p className="rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
            {error.message}
          </p>
        )}
      </div>
    </Modal>
  );
}

function ChangePinDialog({
  open,
  user,
  onClose,
}: {
  open: boolean;
  user: UserRecord | null;
  onClose: () => void;
}): React.JSX.Element | null {
  const queryClient = useQueryClient();
  const [pin, setPin] = useState('');

  useEffect(() => {
    if (open) setPin('');
  }, [open, user]);

  const save = useMutation({
    mutationFn: () => api.changeUserPin(user!.id, pin),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['users'] });
      onClose();
    },
    onError: () => setPin(''),
  });

  if (!user) return null;
  const error = save.error instanceof ApiError ? save.error.message : undefined;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title={`New PIN for ${user.fullName}`}
      description="Tell them the new PIN yourself — it is not shown again."
      width="sm"
      footer={
        <>
          <Button onClick={onClose} disabled={save.isPending}>
            Cancel
          </Button>
          <Button
            variant="primary"
            onClick={() => save.mutate()}
            disabled={pin.length !== 4 || save.isPending}
          >
            {save.isPending ? 'Saving…' : 'Set PIN'}
          </Button>
        </>
      }
    >
      <PinPad value={pin} onChange={setPin} error={error} />
    </Modal>
  );
}
