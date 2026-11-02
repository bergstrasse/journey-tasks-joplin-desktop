import { BODY_TEMPLATE_MARKERS, parseArchiveBody } from './domain/bodyTemplate';
import { createTranslator, resolveLanguage } from './i18n';
import { TaskApplication } from './services/taskApplication';
import { PanelController, type RuntimeApi } from './panel/controller';
export async function startPlugin(api: RuntimeApi): Promise<{ app: TaskApplication; panel: PanelController; dispose(): void }> {
  let panel: PanelController | undefined;
  const notices = new Set<string>();
  const app = new TaskApplication(api, { onChange: () => panel?.invalidate(), onNotice: message => {
    if (notices.has(message)) return;
    notices.add(message);
    void api.views.dialogs?.showMessageBox(message).catch(() => {}).finally(() => notices.delete(message));
  } });
  await app.initialize();
  const initial = await app.snapshot();
  const t = createTranslator(resolveLanguage(initial.preferences.language, initial.systemLocale || Intl.DateTimeFormat().resolvedOptions().locale));
  panel = new PanelController(api, app);
  await panel.initialize();
  const disposables: { dispose?(): void }[] = [];
  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  let stopped = false;
  const changedNotes = new Set<string>();
  let fullRefresh = false;
  const refresh = (event?: { id?: string; noteId?: string }) => {
    if (stopped) return;
    const id = event?.id || event?.noteId;
    if (id) changedNotes.add(id); else fullRefresh = true;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => {
      const noteIds = fullRefresh ? undefined : [...changedNotes];
      changedNotes.clear(); fullRefresh = false;
      void app.dispatch({ requestId: `host-refresh:${Date.now()}`, action: 'refresh', noteIds })
        .catch(error => console.warn('Journey refresh failed', error?.code || error?.name));
    }, 350);
  };
  if (api.workspace?.onNoteChange) {
    const d = await api.workspace.onNoteChange(refresh); if (d) disposables.push(d);
  }
  if (api.workspace?.onSyncComplete) {
    const d = await api.workspace.onSyncComplete(() => refresh()); if (d) disposables.push(d);
  }
  if (api.workspace?.onNoteSelectionChange) {
    const d = await api.workspace.onNoteSelectionChange(async event => {
      try {
        const ids = event?.value;
        if (ids?.length) { for (const id of ids) refresh({ id }); }
        else {
          const selected = await api.workspace?.selectedNote?.();
          if (selected?.id) refresh({ id: selected.id });
        }
      } catch (error) { console.warn('Journey selection refresh failed', (error as Error)?.name); }
    });
    if (d) disposables.push(d);
  }
  const lastCommands = new Map<string, number>();
  const invokeSelected = async (action: 'complete' | 'abandonTask' | 'openNote' | 'setFields') => {
    const note = await api.workspace?.selectedNote?.();
    if (!note) { await panel?.show(); return; }
    const key = `${action}:${note.id}`; if (Date.now() - (lastCommands.get(key) || 0) < 1000) return; lastCommands.set(key, Date.now());
    const snapshot = await app.snapshot();
    const task = snapshot.tasks.find(t => t.noteId === note.id && !t.historical);
    if (!task) { await panel?.show(); return; }
    return app.dispatch({ requestId: `command:${action}:${Date.now()}`, action, noteId: task.noteId,
      ...(action === 'setFields' ? { pinned: !task.pinned } : {}),
      ...(action === 'complete' || action === 'abandonTask' ? { seriesId: task.seriesId, occurrenceId: task.occurrenceId } : {}) } as any);
  };
  const selectedEditor = async (type: 'series') => { const note = await api.workspace?.selectedNote?.(); if (note) await panel?.openEditor(type, note.id); else await panel?.show(); };
  const commands = [
    { name: 'journey.insertTemplateBlock', label: t('actions.insertTemplateBlock'), execute: async () => {
      const note = await api.workspace?.selectedNote?.();
      if (!note) { await panel?.show(); return; }
      if (typeof note.body !== 'string') throw new Error(t('error.templateBodyUnavailable'));
      if (parseArchiveBody(note.body)) return;
      const selection = await api.commands.execute('selectedText');
      const content = typeof selection === 'string' ? selection : '';
      const block = `\n${BODY_TEMPLATE_MARKERS.templateStart}\n${content}\n${BODY_TEMPLATE_MARKERS.templateEnd}\n`;
      await api.commands.execute('insertText', block);
    } },
    { name: 'journey.newTask', label: t('commands.newTask'), execute: async () => panel?.openEditor('new') },
    { name: 'journey.editSeries', label: t('commands.editSeries'), execute: async () => selectedEditor('series') },
    { name: 'journey.showTasks', label: t('commands.showTasks'), execute: async () => panel?.show() },
    { name: 'journey.refreshTasks', label: t('commands.refreshTasks'), execute: async () => { refresh(); return panel?.show(); } },
    { name: 'journey.completeSelected', label: t('commands.completeSelected'), execute: async () => invokeSelected('complete') },
    { name: 'journey.abandonSelected', label: t('commands.skipSelected'), execute: async () => invokeSelected('abandonTask') },
    { name: 'journey.pinSelected', label: t('commands.pinSelected'), execute: async () => invokeSelected('setFields') },
  ];
  if (api.commands.register) for (const c of commands) await api.commands.register({ ...c, iconName: 'fas fa-calendar-check' });
  if (api.views.menus) { try { await api.views.menus.create('journey.tasks.menu', 'Journey Tasks', commands.map(c => ({ commandName: c.name })), 'tools'); } catch { /* Desktop-only menu; mobile has visible panel actions. */ } }
  // A single next-boundary timer, not a recurring full-database polling loop.
  let boundaryTimer: ReturnType<typeof setTimeout> | undefined;
  const nextBoundary = () => {
    if (stopped) return;
    const d = new Date(); d.setHours(24, 0, 1, 0);
    boundaryTimer = setTimeout(() => { refresh(); nextBoundary(); }, Math.max(1000, d.getTime() - Date.now()));
  };
  nextBoundary();
  await panel.show();
  return { app, panel, dispose() { stopped = true; if (refreshTimer) clearTimeout(refreshTimer); if (boundaryTimer) clearTimeout(boundaryTimer); for (const d of disposables) d.dispose?.(); app.dispose(); } };
}
