import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { useTranslation } from '../i18n/react';
import { notebookRows, type Notebook } from './notebookTree';

export function NotebookTree({ folders, selected, disabled = false, search = '', multiple = false, onSelect }: {
  folders: Notebook[]; selected: string[]; disabled?: boolean; search?: string; multiple?: boolean; onSelect: (id: string) => void;
}) {
  const { t } = useTranslation();
  const rows = useMemo(() => notebookRows(folders), [folders]);
  const [collapsed, setCollapsed] = useState<Set<string>>(() => new Set());
  const query = search.trim().toLocaleLowerCase();
  const [searchFold, setSearchFold] = useState<{ query: string; ids: Set<string> }>({ query: '', ids: new Set() });
  const folded = query ? searchFold.query === query ? searchFold.ids : new Set<string>() : collapsed;
  const matches = new Set<string>();
  if (query) rows.forEach((row, index) => {
    if (!row.path.toLocaleLowerCase().includes(query)) return;
    matches.add(row.id);
    for (let ancestor = index - 1, depth = row.depth; ancestor >= 0 && depth > 0; ancestor--) {
      if (rows[ancestor].depth < depth) { matches.add(rows[ancestor].id); depth = rows[ancestor].depth; }
    }
  });
  const filtered = query ? rows.filter(row => matches.has(row.id)) : rows;
  const visible = filtered.filter((row, index) => {
    for (let ancestor = index - 1, depth = row.depth; ancestor >= 0 && depth > 0; ancestor--) {
      if (filtered[ancestor].depth < depth) {
        if (folded.has(filtered[ancestor].id)) return false;
        depth = filtered[ancestor].depth;
      }
    }
    return true;
  });
  const toggle = (id: string) => {
    const next = new Set(folded);
    if (next.has(id)) next.delete(id); else next.add(id);
    if (query) setSearchFold({ query, ids: next }); else setCollapsed(next);
  };
  const parents = new Set(filtered.filter((row, index) => filtered[index + 1]?.depth > row.depth).map(row => row.id));
  return <div className="notebook-tree" role="tree" aria-label={t('field.notebook')} aria-multiselectable={multiple || undefined}>
    {visible.map(row => {
      const branch = parents.has(row.id), expanded = !folded.has(row.id);
      return <div key={row.id} className="notebook-tree-row" role="treeitem" aria-level={row.depth + 1} aria-selected={selected.includes(row.id)} aria-expanded={branch ? expanded : undefined} style={{ paddingInlineStart: row.depth * 16 }}>
        {branch ? <button type="button" className="notebook-toggle" aria-label={row.title} title={row.path} aria-expanded={expanded} disabled={disabled} onClick={() => toggle(row.id)}><Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} /></button> : <span className="notebook-toggle-spacer" />}
        <button type="button" className="notebook-choice" data-notebook-id={row.id} title={row.path} disabled={disabled} aria-pressed={selected.includes(row.id)} onClick={() => onSelect(row.id)} onKeyDown={event => {
          if (branch && ['ArrowLeft', 'ArrowRight'].includes(event.key)) {
            event.preventDefault();
            if ((event.key === 'ArrowRight') !== expanded) toggle(row.id);
          }
          if (['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) {
            event.preventDefault();
            const buttons = Array.from(event.currentTarget.closest('.notebook-tree')!.querySelectorAll<HTMLButtonElement>('.notebook-choice:not(:disabled)'));
            const index = buttons.indexOf(event.currentTarget);
            buttons[event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : Math.max(0, Math.min(buttons.length - 1, index + (event.key === 'ArrowDown' ? 1 : -1)))]?.focus();
          }
        }}>
          <Icon name={multiple && selected.includes(row.id) ? 'check' : 'folder'} size={16} /><span>{row.title}</span>{!multiple && selected.includes(row.id) && <Icon name="check" size={14} />}
        </button>
      </div>;
    })}
    {!visible.length && <p className="muted" role="status">{t('menu.noNotebooks')}</p>}
  </div>;
}

export function NotebookPicker({ folders, value, onChange, label, disabled = false }: {
  folders: Notebook[]; value: string; onChange: (id: string) => void; label: string; disabled?: boolean;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null), trigger = useRef<HTMLButtonElement>(null);
  const selected = useMemo(() => notebookRows(folders).find(row => row.id === value), [folders, value]);
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [open]);
  return <div className="notebook-picker" ref={root} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setOpen(false); }} onKeyDown={event => {
    if (event.key === 'Escape' && open) { event.preventDefault(); event.stopPropagation(); setOpen(false); trigger.current?.focus(); }
  }}><span className="notebook-picker-label">{label}</span>
    <button ref={trigger} type="button" className="notebook-picker-trigger" aria-label={label} aria-haspopup="tree" aria-expanded={open} title={selected?.path} disabled={disabled || !folders.length} onClick={() => setOpen(previous => !previous)}><Icon name="folder" size={16} /><span>{selected?.title ?? t('field.chooseNotebook')}</span><Icon name={open ? 'chevronDown' : 'chevronRight'} size={14} /></button>
    {open && <div className="notebook-picker-menu"><NotebookTree folders={folders} selected={[value]} disabled={disabled} onSelect={id => { onChange(id); setOpen(false); trigger.current?.focus(); }} /></div>}
  </div>;
}
