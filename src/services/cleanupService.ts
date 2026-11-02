import { stableHash } from '../domain/identity';
import { JoplinGateway, StorageError, type NativeNote } from '../adapters/joplin/gateway';
import { LocalIntentStore } from '../adapters/joplin/localIntentStore';
import { readNamespace } from '../adapters/joplin/userDataStore';
import type { CleanupPlan, CleanupResult, CleanupFailure } from './cleanupTypes';

interface CleanupState { noteIds: string[]; folderIds: string[]; lastFailure?: CleanupFailure }
interface Scan {
  plan: Omit<CleanupPlan, 'token' | 'confirmation' | 'expiresAt'>;
  digest: string; notes: NativeNote[];
  keys: Map<string, string[]>; folderKeys: Map<string, string[]>;
  folders: Awaited<ReturnType<JoplinGateway['folders']>>;
}

/** Compare business fields, not endpoint-added model metadata or host write timestamps. */
function semanticUserData(raw: string | undefined): unknown {
  const namespaces = JSON.parse(raw || '{}') as Record<string, unknown>;
  return Object.fromEntries(Object.entries(namespaces).map(([name, values]) => [name,
    values && typeof values === 'object' && !Array.isArray(values) ? Object.fromEntries(Object.entries(values).map(([key, entry]) => {
      const item = entry as { v?: unknown; d?: number; t?: number } | null;
      return [key, item && typeof item === 'object' && 't' in item ? (item.d ? { deleted: true } : { value: item.v }) : entry];
    })) : values,
  ]));
}
function noteContent(note: NativeNote): unknown {
  return { id: note.id, parentId: note.parent_id || '', title: note.title || '', body: note.body || '',
    isTodo: Number(note.is_todo || 0), due: Number(note.todo_due || 0), completed: Number(note.todo_completed || 0),
    deleted: Number(note.deleted_time || 0), encrypted: Number(note.encryption_applied || 0),
    conflict: Number(note.is_conflict || 0), markup: Number(note.markup_language ?? 1) };
}
function noteState(note: NativeNote): unknown { return { id: note.id, content: noteContent(note), userData: semanticUserData(note.user_data) }; }
function foreignUserData(note: { user_data?: string }, pluginId: string): unknown {
  const data = semanticUserData(note.user_data) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(data).filter(([key]) => key !== pluginId));
}

/** Resets managed tasks and removes the running plugin's namespaced metadata. */
export class CleanupService {
  private previews = new Map<string, { scan: Scan; expiresAt: number }>();
  constructor(private readonly gateway: JoplinGateway, private readonly local: LocalIntentStore,
    private readonly pluginId: string, private readonly now: () => number = Date.now) {}

  async preview(): Promise<CleanupPlan> {
    const scan = await this.scan();
    const expiresAt = this.now() + 5 * 60_000;
    const token = stableHash(['cleanup', scan.digest, this.now(), Math.random()]);
    this.previews.clear(); this.previews.set(token, { scan, expiresAt });
    return { ...scan.plan, token, expiresAt, confirmation: 'RESET' };
  }

  async execute(token: string, confirmation: string): Promise<CleanupResult> {
    const entry = this.previews.get(token);
    if (!entry || this.now() > entry.expiresAt) throw new StorageError('CLEANUP_EXPIRED', '清理预览已过期，请重新预览。');
    if (confirmation !== 'RESET') throw new StorageError('CLEANUP_CONFIRMATION', '确认文字不匹配，尚未执行清理。');
    const current = await this.scan();
    if (current.digest !== entry.scan.digest) throw new StorageError('CLEANUP_CHANGED', '预览后数据已变化，请重新检查清理范围。');
    if (current.plan.blocked) throw new StorageError('CLEANUP_ENCRYPTED', '部分笔记尚未解密，请完成同步和解密后再清理。');
    const state: CleanupState = { noteIds: current.plan.notes.map(n => n.id), folderIds: current.plan.folders.map(f => f.id) };
    await this.local.setCleanupState(state);
    this.previews.clear();
    let stage = 'clear-local-recovery';
    let itemId: string | undefined;
    const remainingData = (raw: string | undefined, removed: Set<string>) => Object.fromEntries(Object.entries(readNamespace(raw, this.pluginId))
      .filter(([key, value]) => !value.d && !removed.has(key)).map(([key, value]) => [key, value.v]));
    const result: CleanupResult = { cleanedNotes: 0, cleanedFolders: 0, removedKeys: 0 };
    try {
      await this.local.clearOutbox();
      for (const item of current.plan.notes) {
        itemId = item.id; stage = 'check-note';
        let before = current.notes.find(n => n.id === item.id)!;
        const note = await this.gateway.getNote(item.id);
        if (!note || stableHash(noteState(note)) !== stableHash(noteState(before)))
          throw new StorageError('CLEANUP_CHANGED', '清理期间笔记发生变化，已停止。');
        // Clear the native alarm before deleting ownership metadata. The durable guard
        // prevents recovery/reconciliation from restoring it if this step fails.
        if (before.todo_due) {
          stage = 'clear-note-reminder';
          const expected = { ...before, todo_due: 0 };
          const updated = await this.gateway.patchNote(item.id, { todo_due: 0 });
          if (stableHash(noteState(updated)) !== stableHash(noteState(expected)))
            throw new StorageError('CLEANUP_READBACK', '原生提醒清理读回不一致，已停止。');
          before = updated;
        }
        stage = 'remove-note-metadata';
        const removed = new Set<string>();
        for (const key of current.keys.get(item.id) || []) {
          const fresh = await this.gateway.getNote(item.id);
          if (!fresh || stableHash(remainingData(fresh.user_data, new Set())) !== stableHash(remainingData(before.user_data, removed)))
            throw new StorageError('CLEANUP_CHANGED', '清理期间插件数据发生变化，已停止。');
          await this.gateway.api.data.userDataDelete(1, item.id, key);
          removed.add(key);
          const after = await this.gateway.getNote(item.id);
          if (!after || stableHash(noteContent(after)) !== stableHash(noteContent(before)) ||
              stableHash(foreignUserData(after, this.pluginId)) !== stableHash(foreignUserData(before, this.pluginId)))
            throw new StorageError('CLEANUP_CHANGED', '清理期间笔记内容或其他插件数据发生变化，已停止。');
          if (stableHash(remainingData(after.user_data, new Set())) !== stableHash(remainingData(before.user_data, removed)))
            throw new StorageError('CLEANUP_CHANGED', '清理期间插件数据发生变化，已停止。');
          const value = readNamespace(after.user_data, this.pluginId)[key];
          if (value && !value.d) throw new StorageError('CLEANUP_READBACK', '元数据清理读回不一致，请重新预览后重试。');
          result.removedKeys++;
        }
        const after = await this.gateway.getNote(item.id);
        if (!after || after.todo_due || this.activeKeys(after.user_data).length) throw new StorageError('CLEANUP_CHANGED', '清理期间新增了插件数据，请重新预览。');
        result.cleanedNotes++;
      }
      for (const item of current.plan.folders) {
        itemId = item.id; stage = 'remove-folder-metadata';
        const before = current.folders.find(f => f.id === item.id)!;
        let folder = (await this.gateway.folders()).find(f => f.id === item.id);
        if (!folder || stableHash({ ...folder, user_data: semanticUserData(folder.user_data) }) !== stableHash({ ...before, user_data: semanticUserData(before.user_data) })) throw new StorageError('CLEANUP_CHANGED', '清理期间笔记本发生变化，已停止。');
        const removed = new Set<string>();
        for (const key of current.folderKeys.get(item.id) || []) {
          const fresh = (await this.gateway.folders()).find(f => f.id === item.id);
          if (!fresh || stableHash(remainingData(fresh.user_data, new Set())) !== stableHash(remainingData(before.user_data, removed)))
            throw new StorageError('CLEANUP_CHANGED', '清理期间插件数据发生变化，已停止。');
          await this.gateway.api.data.userDataDelete(2, item.id, key);
          removed.add(key);
          folder = (await this.gateway.folders()).find(f => f.id === item.id);
          if (!folder || folder.title !== before.title || folder.parent_id !== before.parent_id ||
              stableHash(foreignUserData(folder, this.pluginId)) !== stableHash(foreignUserData(before, this.pluginId)))
            throw new StorageError('CLEANUP_CHANGED', '清理期间笔记本内容或其他插件数据发生变化，已停止。');
          if (stableHash(remainingData(folder.user_data, new Set())) !== stableHash(remainingData(before.user_data, removed)))
            throw new StorageError('CLEANUP_CHANGED', '清理期间插件数据发生变化，已停止。');
          const value = readNamespace(folder.user_data, this.pluginId)[key];
          if (value && !value.d) throw new StorageError('CLEANUP_READBACK', '笔记本元数据清理读回不一致。');
          result.removedKeys++;
        }
        if (this.activeKeys(folder!.user_data).length) throw new StorageError('CLEANUP_CHANGED', '清理期间新增了插件数据，请重新预览。');
        result.cleanedFolders++;
      }
      stage = 'verify-cleanup'; itemId = undefined;
      const final = await this.scan();
      if (final.plan.blocked || final.plan.metadataKeys || final.notes.some(note => !!note.todo_due)) throw new StorageError('CLEANUP_CHANGED', '清理期间数据发生变化，请重新预览。');
      stage = 'reset-local-state';
      await this.local.reset();
      await this.local.setCleanupState(undefined);
      return result;
    } catch (error) {
      const failure: CleanupFailure = { stage, itemId, code: error instanceof StorageError ? error.code : 'HOST_API_ERROR', detail: error instanceof Error ? error.message : String(error) };
      try { await this.local.setCleanupState({ ...state, lastFailure: failure }); } catch { /* Keep the original durable guard. */ }
      throw new StorageError('CLEANUP_INCOMPLETE', `清理未全部完成，已暂停任务自动写入。请重新预览并重试清理。 [${stage}${itemId ? ':' + itemId : ''}] ${failure.code}: ${failure.detail}`, failure as unknown as Record<string, unknown>);
    }
  }

  private activeKeys(raw: string | undefined): string[] {
    return Object.entries(readNamespace(raw, this.pluginId)).filter(([, e]) => !e.d).map(([k]) => k).sort();
  }
  private async scan(): Promise<Scan> {
    const previous = await this.local.cleanupState<CleanupState>();
    const all = await this.gateway.allNotes({ includeDeleted: true });
    const folders = await this.gateway.folders();
    const plan: Scan['plan'] = { notes: [], folders: [], metadataKeys: 0, blocked: all.some(n => !!n.encryption_applied) || folders.some(f => !!f.encryption_applied),
      warnings: ['cleanup.warningHistory', 'cleanup.warningOtherDevices'], ...(previous?.lastFailure ? { lastFailure: previous.lastFailure } : {}) };
    if (previous) plan.warnings.unshift('cleanup.warningResume');
    if (plan.blocked) plan.warnings.push('cleanup.warningEncrypted');
    const keys = new Map<string, string[]>(), folderKeys = new Map<string, string[]>();
    const notes: NativeNote[] = [], fingerprint: unknown[] = [];
    for (const note of all) {
      const active = this.activeKeys(note.user_data);
      // Older cleanup leaves namespace tombstones. Include those notes only when
      // an alarm remains, so an explicit preview can repair the old cleanup too.
      const legacyAlarm = !!note.todo_due && Object.keys(readNamespace(note.user_data, this.pluginId)).length > 0;
      if (!active.length && !legacyAlarm && !previous?.noteIds.includes(note.id)) continue;
      keys.set(note.id, active); notes.push(note);
      plan.notes.push({ id: note.id, title: note.title, inTrash: !!note.deleted_time });
      plan.metadataKeys += active.length; fingerprint.push(noteState(note));
    }
    for (const folder of folders) {
      const active = this.activeKeys(folder.user_data);
      if (!active.length && !previous?.folderIds.includes(folder.id)) continue;
      folderKeys.set(folder.id, active); plan.metadataKeys += active.length;
      plan.folders.push({ id: folder.id, title: folder.title });
      fingerprint.push({ ...folder, user_data: semanticUserData(folder.user_data) });
    }
    plan.notes.sort((a,b) => a.id.localeCompare(b.id)); plan.folders.sort((a,b) => a.id.localeCompare(b.id));
    return { plan, notes, folders, keys, folderKeys, digest: stableHash({ blocked: plan.blocked, fingerprint: fingerprint.sort((a:any,b:any) => a.id.localeCompare(b.id)) }) };
  }
}
