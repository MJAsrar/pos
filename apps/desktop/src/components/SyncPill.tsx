import { useEffect } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { api, type SyncStatus } from '@/lib/api';

/**
 * One line in the rail saying whether the shop's phone is seeing today.
 *
 * Written for the owner, not an administrator: the question in their head is
 * "is what I see on my phone current?", not "what is the state of the
 * replication queue". So it never says sync, queue or conflict — it says what
 * is waiting, or that everything is through.
 *
 * It polls rather than being pushed to. The numbers come from a count on a
 * tiny indexed table in the same process, so asking every few seconds costs
 * less than a channel to keep in step.
 */
export function SyncPill(): React.JSX.Element | null {
  const queryClient = useQueryClient();

  // The moment the connection is back, rather than waiting out whatever
  // backoff the last failure earned. Shop internet comes and goes, and a
  // cashier watching the line should see it clear.
  useEffect(() => {
    const resume = (): void => {
      void api
        .syncResumed()
        .catch(() => undefined)
        .finally(() => void queryClient.invalidateQueries({ queryKey: ['syncStatus'] }));
    };
    window.addEventListener('online', resume);
    return () => window.removeEventListener('online', resume);
  }, [queryClient]);

  const status = useQuery({
    queryKey: ['syncStatus'],
    queryFn: api.syncStatus,
    refetchInterval: 5_000,
    // The counter watches this change while a batch goes out.
    refetchIntervalInBackground: false,
  });

  if (!status.data) return null;

  const look = describe(status.data);

  return (
    <div className="px-4 pb-3">
      <div className="flex items-center gap-2">
        <span className={`size-1.5 shrink-0 rounded-full ${look.dot}`} aria-hidden="true" />
        <p className={`truncate text-meta ${look.text}`} title={look.title}>
          {look.label}
        </p>
      </div>
    </div>
  );
}

interface Look {
  label: string;
  title: string;
  dot: string;
  text: string;
}

function describe(status: SyncStatus): Look {
  const waiting = status.pending + status.failed;

  if (!status.configured) {
    return {
      label: 'Phone view not set up',
      title: 'Nobody can see this shop from a phone or laptop yet. Settings has the sign-in.',
      dot: 'bg-white/25',
      text: 'text-white/40',
    };
  }

  if (status.dead > 0) {
    return {
      label: `${status.dead} ${status.dead === 1 ? 'change' : 'changes'} need attention`,
      title: 'Some changes could not be saved online. Open Settings to see them.',
      dot: 'bg-due',
      text: 'text-due',
    };
  }

  if (status.busy) {
    return {
      label: 'Sending…',
      title: 'Saving the latest changes online.',
      dot: 'bg-amber-400 animate-pulse',
      text: 'text-white/70',
    };
  }

  if (waiting > 0) {
    const offline = Boolean(status.lastError);
    return {
      label: offline
        ? `Offline — ${waiting} waiting`
        : `${waiting} ${waiting === 1 ? 'change' : 'changes'} waiting`,
      title: offline
        ? `${status.lastError} Everything is safe on this computer and will go up when the internet is back.`
        : 'These will be saved online shortly.',
      dot: 'bg-amber-400',
      text: 'text-white/60',
    };
  }

  return {
    label: status.lastSyncedAt ? `Up to date ${ago(status.lastSyncedAt)}` : 'Up to date',
    title: 'Everything on this computer has been saved online.',
    dot: 'bg-emerald-400',
    text: 'text-white/55',
  };
}

/** "just now", "4 min ago", "2 hours ago" — enough to judge, no more. */
function ago(timestamp: string): string {
  const then = Date.parse(timestamp);
  if (!Number.isFinite(then)) return '';

  const minutes = Math.floor((Date.now() - then) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;

  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} ${hours === 1 ? 'hour' : 'hours'} ago`;

  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}
