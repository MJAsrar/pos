import { useQuery } from '@tanstack/react-query';
import { api } from '@/lib/api';

/**
 * An item's picture.
 *
 * Fetched one item at a time and cached, rather than loaded with the whole
 * catalogue: a thousand pictures in one reply would make every item list slow
 * for the sake of the twenty tiles actually on screen.
 */
export function ItemPhoto({
  itemId,
  hasPhoto,
  size = 44,
  className = '',
}: {
  itemId: string;
  /** Skips the lookup entirely for the items that have none. */
  hasPhoto: boolean;
  size?: number;
  className?: string;
}): React.JSX.Element {
  const photo = useQuery({
    queryKey: ['itemPhoto', itemId],
    queryFn: () => api.itemPhoto(itemId),
    enabled: hasPhoto,
    staleTime: 5 * 60_000,
  });

  const url = photo.data?.dataUrl ?? null;

  // The slot is reserved whether or not there is a picture, so names stay in
  // line across the grid — but an item without one shows empty space, not a
  // grey box. A shop photographs its stock gradually, so a part-filled
  // category is the normal state for a long time, not a brief one.
  return (
    <span
      className={[
        'block shrink-0 overflow-hidden rounded',
        url ? 'border border-rule bg-sunk' : '',
        className,
      ].join(' ')}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      {url && <img src={url} alt="" className="h-full w-full object-cover" />}
    </span>
  );
}
