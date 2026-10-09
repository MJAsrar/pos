import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@/components/Button';
import { Modal } from '@/components/Modal';
import { ApiError, api } from '@/lib/api';

/**
 * Categories.
 *
 * Deleting one never deletes items — they simply become uncategorised, which
 * is what somebody tidying up their list actually expects.
 */
export function CategoriesDialog({
  open,
  onClose,
}: {
  open: boolean;
  onClose: () => void;
}): React.JSX.Element {
  const queryClient = useQueryClient();
  const [newName, setNewName] = useState('');
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null);

  const categories = useQuery({ queryKey: ['categories'], queryFn: api.categories, enabled: open });

  const refresh = (): void => {
    void queryClient.invalidateQueries({ queryKey: ['categories'] });
    void queryClient.invalidateQueries({ queryKey: ['items'] });
  };

  const add = useMutation({
    mutationFn: () => api.createCategory(newName.trim()),
    onSuccess: () => {
      setNewName('');
      refresh();
    },
  });

  const rename = useMutation({
    mutationFn: () => api.renameCategory(editing!.id, editing!.name.trim()),
    onSuccess: () => {
      setEditing(null);
      refresh();
    },
  });

  const remove = useMutation({ mutationFn: api.removeCategory, onSuccess: refresh });

  const error = [add.error, rename.error, remove.error].find(
    (candidate): candidate is ApiError => candidate instanceof ApiError,
  )?.message;

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Categories"
      description="Used to group items and to browse them while billing."
      width="sm"
      footer={<Button onClick={onClose}>Done</Button>}
    >
      <form
        className="flex gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (newName.trim().length >= 2) add.mutate();
        }}
      >
        <input
          data-autofocus
          value={newName}
          onChange={(event) => setNewName(event.target.value)}
          placeholder="New category name"
          maxLength={60}
          className="h-10 flex-1 rounded border border-rule-strong bg-surface px-3 text-row focus:border-board focus:outline-none focus:ring-2 focus:ring-board/20"
        />
        <Button
          type="submit"
          variant="primary"
          disabled={newName.trim().length < 2 || add.isPending}
        >
          Add
        </Button>
      </form>

      {error && (
        <p className="mt-3 rounded border border-due/30 bg-due-tint px-3 py-2.5 text-meta text-due">
          {error}
        </p>
      )}

      <ul className="mt-4 divide-y divide-rule border-y border-rule">
        {categories.data?.length === 0 && (
          <li className="py-4 text-center text-meta text-ink-soft">No categories yet.</li>
        )}
        {categories.data?.map((category) => (
          <li key={category.id} className="flex items-center justify-between gap-3 py-2.5">
            {editing?.id === category.id ? (
              <>
                <input
                  autoFocus
                  value={editing.name}
                  onChange={(event) => setEditing({ ...editing, name: event.target.value })}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter') rename.mutate();
                    if (event.key === 'Escape') setEditing(null);
                  }}
                  maxLength={60}
                  className="h-9 flex-1 rounded border border-board bg-surface px-2 text-base focus:outline-none"
                />
                <Button variant="primary" onClick={() => rename.mutate()} disabled={rename.isPending}>
                  Save
                </Button>
              </>
            ) : (
              <>
                <span className="min-w-0">
                  <span className="block truncate text-row text-ink">{category.name}</span>
                  <span className="block text-meta text-ink-soft">
                    {category.itemCount} {category.itemCount === 1 ? 'item' : 'items'}
                  </span>
                </span>
                <span className="flex shrink-0 gap-1">
                  <Button
                    variant="quiet"
                    onClick={() => setEditing({ id: category.id, name: category.name })}
                  >
                    Rename
                  </Button>
                  <Button
                    variant="quiet"
                    onClick={() => remove.mutate(category.id)}
                    disabled={remove.isPending}
                  >
                    Delete
                  </Button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>

      <p className="mt-3 text-meta text-ink-faint">
        Deleting a category leaves its items in place, without a category.
      </p>
    </Modal>
  );
}
