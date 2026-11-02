import { useEffect, useRef, useState } from 'react';
import type { ActionResult } from '../services/applicationTypes';
import type { CleanupPlan, CleanupResult } from '../services/cleanupTypes';
import { useTranslation } from '../i18n/react';
import { lockPanelScroll } from './scroll';
import { Icon } from './Icons';

type Command = { action: 'previewCleanup' } | { action: 'executeCleanup'; token: string; confirmation: string };
export function CleanupSettings({ busy, onCommand, onCleared, error, errorCode }: {
  busy: boolean; onCommand: (command: Command) => Promise<ActionResult | undefined>; onCleared: () => void; error?: string; errorCode?: string;
}) {
  const { t, message } = useTranslation();
  const [open, setOpen] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [plan, setPlan] = useState<CleanupPlan>();
  const [confirmation, setConfirmation] = useState('');
  const [result, setResult] = useState<CleanupResult>();
  const dialog = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const busyRef = useRef(busy); busyRef.current = busy;
  const close = () => {
    if (busyRef.current) return;
    if (previewOpen && !result) { setPreviewOpen(false); setPlan(undefined); setConfirmation(''); }
    else setOpen(false);
  };
  useEffect(() => {
    if (!open) return;
    const unlock = lockPanelScroll(document.getElementById('root'));
    dialog.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); }
      if (event.key !== 'Tab') return;
      const nodes = Array.from(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled),input:not(:disabled)') || []);
      const first = nodes[0], last = nodes[nodes.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown);
    return () => { document.removeEventListener('keydown', keydown); unlock(); trigger.current?.focus(); };
  }, [open, previewOpen, !!result]);
  const preview = async () => {
    setResult(undefined); setPlan(undefined); setConfirmation('');
    const response = await onCommand({ action: 'previewCleanup' });
    if (response?.cleanupPlan) { setPlan(response.cleanupPlan); setPreviewOpen(true); }
  };
  const execute = async () => {
    if (!plan || plan.blocked || confirmation !== plan.confirmation) return;
    const response = await onCommand({ action: 'executeCleanup', token: plan.token, confirmation });
    setPlan(undefined); setConfirmation('');
    if (response?.cleanupResult) { setResult(response.cleanupResult); onCleared(); }
    else setPreviewOpen(false);
  };
  return <section className="cleanup-settings card">
    <h2 className="section-title">{t('cleanup.management')}</h2><p className="muted">{t('cleanup.scope')}</p>
    <button ref={trigger} className="danger" disabled={busy} onClick={() => { setPlan(undefined); setResult(undefined); setConfirmation(''); setPreviewOpen(false); setOpen(true); }}>{t('cleanup.title')}</button>
    {open && <div className="modal-backdrop cleanup-backdrop"><section ref={dialog} key={previewOpen ? 'preview' : 'overview'} className={`drawer cleanup-dialog${previewOpen ? ' cleanup-preview-dialog' : ''}`} role="dialog" aria-modal="true" aria-labelledby="cleanup-dialog-title" aria-describedby={previewOpen || result ? undefined : 'cleanup-dialog-warning'}>
      <header className="drawer-header"><h2 id="cleanup-dialog-title">{!previewOpen && <Icon name="warning" />}{t(previewOpen ? 'cleanup.plan' : 'cleanup.title')}</h2><button aria-label={t('actions.close')} disabled={busy} onClick={close}>✕</button></header>
      {!previewOpen && !result && <div className="cleanup-overview">
        <p id="cleanup-dialog-warning" className="warning">{t('cleanup.detachWarning')}</p>
        <dl className="cleanup-scope">
          <div><dt>{t('cleanup.removeTitle')}</dt><dd>{t('cleanup.remove')}</dd></div>
          <div><dt>{t('cleanup.keepTitle')}</dt><dd>{t('cleanup.keep')}</dd></div>
          <div><dt>{t('cleanup.syncTitle')}</dt><dd>{t('cleanup.warningOtherDevices')}</dd></div>
          <div><dt>{t('cleanup.uninstallTitle')}</dt><dd>{t('cleanup.uninstall')}</dd></div>
        </dl>
      </div>}
      {error && <p className="error" role="alert">{message(error, errorCode)}</p>}
      {!previewOpen && !result && <button disabled={busy} onClick={() => void preview()}>{t('cleanup.preview')}</button>}
      {plan && <section className="cleanup-plan" aria-label={t('cleanup.plan')}>
        <p>{t('cleanup.counts', { notes: plan.notes.length, keys: plan.metadataKeys, folders: plan.folders.length })}</p>
        {plan.lastFailure && <p className="warning" role="status">{t('cleanup.lastFailure', { stage: plan.lastFailure.stage, item: plan.lastFailure.itemId || '—', code: plan.lastFailure.code, detail: message(plan.lastFailure.detail, plan.lastFailure.code) })}</p>}
        {plan.warnings.filter(key => !['cleanup.warningHistory', 'cleanup.warningOtherDevices'].includes(key)).map(key => <p className="warning" key={key}>{t(key)}</p>)}
        <section className="cleanup-details"><h3>{t('cleanup.items')}</h3><ul className="cleanup-items">{plan.notes.map(note => <li key={note.id}>{note.title || note.id}<small> {note.id}{note.inTrash ? ` · ${t('cleanup.inTrash')}` : ''}</small></li>)}{plan.folders.map(folder => <li key={folder.id}>{t('cleanup.folderKeep')} · {folder.title}</li>)}</ul></section>
        <label>{t('cleanup.confirm', { text: plan.confirmation })}<input disabled={busy || plan.blocked} value={confirmation} autoComplete="off" spellCheck={false} onChange={e => setConfirmation(e.target.value)} /></label>
        <button className="danger" disabled={busy || plan.blocked || confirmation !== plan.confirmation} onClick={() => void execute()}>{t('cleanup.execute')}</button>
      </section>}
      {result && <><p role="status">{t('cleanup.done', { notes: result.cleanedNotes, folders: result.cleanedFolders, keys: result.removedKeys })}</p><p className="muted">{t('cleanup.after')}</p></>}
      <button disabled={busy} onClick={close}>{t(result ? 'actions.close' : 'actions.cancel')}</button>
    </section></div>}
  </section>;
}
