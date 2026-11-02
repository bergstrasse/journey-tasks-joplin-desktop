import type { ListSort } from '../adapters/joplin/localIntentStore';
import { useEffect, useRef, useState } from 'react';
import { useTranslation } from '../i18n/react';
import { Icon } from './Icons';
import type { ListGrouping } from './viewModel';

export function ListSortMenu({ grouping, direction, busy, onChange }: {
  grouping: ListGrouping; direction: ListSort; busy: boolean;
  onChange: (patch: { listGrouping?: ListGrouping; listSort?: ListSort }) => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [submenu, setSubmenu] = useState<'grouping' | 'order'>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); trigger.current?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const select = (patch: Parameters<typeof onChange>[0]) => { onChange(patch); setOpen(false); trigger.current?.focus(); };
  return <div className="list-sort" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }}>
    <button ref={trigger} title={t('sort.title')} aria-label={t('sort.title')} aria-expanded={open} onClick={() => { setOpen(!open); setSubmenu(undefined); }}><Icon name="sort" /></button>
    {open && <div className="list-sort-menu" aria-label={t('sort.title')}>
      <button aria-expanded={submenu === 'grouping'} onClick={() => setSubmenu(submenu === 'grouping' ? undefined : 'grouping')}><Icon name="folder" /><span>{t('sort.grouping')}</span><span className="sort-value">{t(`sort.${grouping}`)}</span><Icon name="chevronRight" size={14} /></button>
      {submenu === 'grouping' && <div className="sort-choices">{(['time', 'notebook'] as const).map(value => <button key={value} disabled={busy} aria-pressed={grouping === value} onClick={() => select({ listGrouping: value })}>{t(`sort.${value}`)}<span>{grouping === value ? '✓' : ''}</span></button>)}</div>}
      <button aria-expanded={submenu === 'order'} onClick={() => setSubmenu(submenu === 'order' ? undefined : 'order')}><Icon name="sort" /><span>{t('sort.order')}</span><span className="sort-value" title={t(`sort.${direction}`)}>{t(`sort.${direction}`)}</span><Icon name="chevronRight" size={14} /></button>
      {submenu === 'order' && <div className="sort-choices">{(['nameAsc', 'nameDesc', 'createdAsc', 'createdDesc', 'scheduledAsc', 'scheduledDesc'] as const).map(value => <button key={value} disabled={busy} aria-pressed={direction === value} onClick={() => select({ listSort: value })}><span className="sort-choice-label" title={t(`sort.${value}`)}>{t(`sort.${value}`)}</span><span>{direction === value ? '✓' : ''}</span></button>)}</div>}
    </div>}
  </div>;
}
