import { REPORT_ISSUE_URL, SUPPORT_AUTHOR_URL } from '../shared/externalLinks';
import type { ApplicationCommand, ViewQuery } from '../services/applicationTypes';
import type { TaskApplication } from '../services/taskApplication';
import { StorageError } from '../adapters/joplin/gateway';
import type { JoplinApiLike } from '../adapters/joplin/gateway';
export interface RuntimeApi extends JoplinApiLike {
  views: {
    dialogs?: { showMessageBox(message: string): Promise<number> };
    panels: { create(id: string): Promise<string>; setHtml(id: string, html: string): Promise<unknown>;
      addScript(id: string, path: string): Promise<void>; onMessage(id: string, handler: (message: any) => Promise<any>): Promise<void>;
      postMessage(id: string, message: unknown): void; show(id: string, visible?: boolean): Promise<void> };
    menus?: { create(id: string, label: string, items: unknown[], location?: string): Promise<void> };
  };
  commands: { register?(command: { name: string; label: string; iconName?: string; execute: (...args: any[]) => Promise<unknown> }): Promise<void>; execute(name: string, ...args: any[]): Promise<any> };
  workspace?: {
    selectedNote?(): Promise<{ id: string; body?: string } | null>;
    onNoteChange?(handler: (event?: { id?: string; noteId?: string }) => void): Promise<{ dispose?(): void }>;
    onSyncComplete?(handler: () => void): Promise<{ dispose?(): void }>;
    onNoteSelectionChange?(handler: (event?: { value?: string[] }) => void): Promise<{ dispose?(): void }>;
  };
}
const actions = new Set(['insertTemplateBlock', 'changeDate', 'abandonTask', 'moveTask', 'deleteNativeTask', 'createTask', 'editTask', 'complete', 'skip', 'reopen', 'snooze', 'reviseSeries', 'switchMode', 'deleteTask', 'setFields', 'adoptNativeDate', 'resolveConflict', 'restoreSeries', 'openNote', 'savePreferences', 'refresh', 'retrySeries', 'previewCleanup', 'executeCleanup']);
const views = new Set(['inbox', 'today', 'tomorrow', 'sevenDays', 'week', 'month', 'year', 'all', 'day']);
export class PanelController {
  private handle = '';
  private pendingUiAction?: { type: 'new' | 'series'; noteId?: string };
  constructor(private readonly api: RuntimeApi, private readonly app: TaskApplication) {}
  async initialize(): Promise<void> {
    this.handle = await this.api.views.panels.create('journey.tasks.panel');
    await this.api.views.panels.setHtml(this.handle, '<div id="root" lang="zh-CN"></div>');
    await this.api.views.panels.onMessage(this.handle, message => this.handleMessage(message));
    await this.api.views.panels.addScript(this.handle, 'panel.css');
    await this.api.views.panels.addScript(this.handle, 'panel.js');
  }
  async show(): Promise<void> { if (this.handle) await this.api.views.panels.show(this.handle, true); }
  async openEditor(type: 'new' | 'series', noteId?: string): Promise<void> { this.pendingUiAction = { type, noteId }; await this.show(); this.invalidate(); }
  invalidate(): void { if (this.handle) this.api.views.panels.postMessage(this.handle, { type: 'invalidate', protocolVersion: 1 }); }
  async handleMessage(message: any): Promise<any> {
    try {
      if (!message || message.protocolVersion !== 1 || typeof message.requestId !== 'string' || message.requestId.length > 200 || JSON.stringify(message).length > 2_000_000) throw new StorageError('INVALID_REQUEST', '无效的面板请求');
      if (message.action === 'reportIssue' || message.action === 'supportAuthor') {
        await this.api.commands.execute('openItem', message.action === 'reportIssue' ? REPORT_ISSUE_URL : SUPPORT_AUTHOR_URL);
        return { ok: true };
      }
      if (message.action === 'ready' || message.action === 'snapshot') {
        const q = message.query ?? {};
        if ((q.search !== undefined && typeof q.search !== 'string') || (q.notebookIds !== undefined && (!Array.isArray(q.notebookIds) || q.notebookIds.some((id: unknown) => typeof id !== 'string'))) || (q.view && !views.has(q.view)) || (q.date && (typeof q.date !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(q.date))) || (q.showCompleted !== undefined && typeof q.showCompleted !== 'boolean') || (q.notebookId !== undefined && typeof q.notebookId !== 'string') || (q.tagId !== undefined && typeof q.tagId !== 'string') || (q.deviceZone && typeof q.deviceZone !== 'string')) throw new StorageError('INVALID_VIEW', '无效的视图参数');
        const query: ViewQuery = { search: q.search, notebookIds: q.notebookIds, view: q.view, date: q.date, showCompleted: q.showCompleted, notebookId: q.notebookId, tagId: q.tagId, deviceZone: q.deviceZone };
        const snapshot = await this.app.snapshot(query); const uiAction = this.pendingUiAction; this.pendingUiAction = undefined;
        return { ok: true, snapshot, ...(uiAction ? { uiAction } : {}) };
      }
      if (message.action !== 'command' || !message.command || !actions.has(message.command.action) || message.command.requestId !== message.requestId) throw new StorageError('UNSUPPORTED_ACTION', '不支持的操作');
      return { ok: true, result: await this.app.dispatch(message.command as ApplicationCommand) };
    } catch (error) { return { ok: false, error: (error as Error).message || '操作失败', code: error instanceof StorageError ? error.code : 'COMMAND_FAILED' }; }
  }
}
