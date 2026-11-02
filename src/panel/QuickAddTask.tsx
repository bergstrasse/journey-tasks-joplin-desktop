import { NotebookPicker } from './NotebookPicker';
import { notebookRows, type Notebook } from './notebookTree';
import { DateTimeInput } from './DateTimeInput';
import { useEffect, useMemo, useRef, useState } from 'react';
import { Icon } from './Icons';
import { useTranslation } from '../i18n/react';
import { addDays } from '../domain/dates';
import type { TaskInput } from '../services/applicationTypes';
import type { ViewPreferences } from '../adapters/joplin/localIntentStore';

interface Props {
  folders: Notebook[];
  preferences: ViewPreferences;
  busy: boolean;
  today: string;
  onPreferences: (patch: Partial<ViewPreferences>) => Promise<unknown>;
  onCreate: (input: TaskInput) => Promise<unknown>;
}

export function QuickAddTask({ folders, preferences, busy, today, onPreferences, onCreate }: Props) {
  const { t, locale } = useTranslation();
  const folderRows = useMemo(() => notebookRows(folders), [folders]);
  const [title, setTitle] = useState('');
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const pending = useRef(false);
  const dateChoice = preferences.quickAddDate ?? 'today';
  const date = dateChoice === 'none' ? '' : dateChoice === 'today' ? today : dateChoice === 'tomorrow' ? addDays(today, 1) : dateChoice;
  const folder = folderRows.find(f => f.id === preferences.quickAddNotebookId) ?? folderRows[0];
  const dateLabel = dateChoice === 'none' ? t('quickAdd.noDate') : dateChoice === 'today' ? t('view.today') : dateChoice === 'tomorrow' ? t('view.tomorrow') : new Intl.DateTimeFormat(locale, { month: 'short', day: 'numeric', timeZone: 'UTC' }).format(new Date(date + 'T12:00:00Z'));
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); root.current?.querySelector<HTMLButtonElement>('.quick-add-options')?.focus(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  return <div className="quick-add" ref={root}>
    <form className="quick-add-bar" onSubmit={async event => {
      event.preventDefault();
      if (busy || pending.current || !folder || !title.trim()) return;
      pending.current = true;
      try {
        const result = await onCreate({ title: title.trim(), notebookId: folder.id,
          schedule: date ? { kind: 'allDay', date, zone: Intl.DateTimeFormat().resolvedOptions().timeZone } : { kind: 'none' },
          reminder: { enabled: false } });
        if (result) { setTitle(''); setOpen(false); }
      } finally { pending.current = false; input.current?.focus(); }
    }}>
      <button className="quick-add-submit" type="submit" disabled={busy || !folder || !title.trim()} aria-label={t('quickAdd.submit')} title={t('quickAdd.submit')}><Icon name="plus" /></button>
      <input ref={input} aria-label={t('quickAdd.title')} placeholder={folder ? t('quickAdd.placeholder', { notebook: folder.title }) : t('field.chooseNotebook')} maxLength={1000} value={title} disabled={busy || !folder} onChange={event => setTitle(event.target.value)} onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }} />
      <button type="button" className="quick-add-options" aria-label={t('quickAdd.options')} aria-expanded={open} disabled={busy} onClick={() => setOpen(value => !value)}><Icon name="calendar" size={18} /><span>{dateLabel}</span><span className="quick-add-divider" aria-hidden="true" /><Icon name="folder" size={18} /><span className="quick-add-notebook" title={folder?.path}>{folder?.title ?? t('field.chooseNotebook')}</span><Icon name="chevronDown" /></button>
    </form>
    {open && <section className="quick-add-popover" aria-label={t('quickAdd.options')}>
      <label>{t('quickAdd.defaultDate')}<select disabled={busy} value={['today', 'tomorrow', 'none'].includes(dateChoice) ? dateChoice : 'custom'} onChange={event => void onPreferences({ quickAddDate: event.target.value === 'custom' ? today : event.target.value })}>
        <option value="today">{t('view.today')}</option><option value="tomorrow">{t('view.tomorrow')}</option><option value="none">{t('quickAdd.noDate')}</option><option value="custom">{t('quickAdd.customDate')}</option>
      </select></label>
      {!['today', 'tomorrow', 'none'].includes(dateChoice) && <label>{t('field.scheduleDate')}<DateTimeInput type="date" required disabled={busy} value={date} onChange={event => { if (event.target.validity.valid && event.target.value) void onPreferences({ quickAddDate: event.target.value }); }} /></label>}
      <NotebookPicker label={t('quickAdd.defaultNotebook')} folders={folders} value={folder?.id ?? ''} disabled={busy} onChange={id => void onPreferences({ quickAddNotebookId: id })} />
    </section>}
  </div>;
}
