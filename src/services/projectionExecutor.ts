import type { NativeFields, ProjectionPayload } from '../shared/models';
import { stableHash, stableStringify } from '../domain/identity';
import { JoplinGateway, NativeNote, StorageError } from '../adapters/joplin/gateway';

export function nativeFields(note: NativeFields): NativeFields {
  return { is_todo: note.is_todo || 0, todo_due: note.todo_due || 0, todo_completed: note.todo_completed || 0 };
}
export function sameNative(a: NativeFields, b: NativeFields): boolean { return stableStringify(nativeFields(a)) === stableStringify(nativeFields(b)); }
export interface ProjectionContext {
  noteId: string;
  occurrenceId: string;
  carrierGeneration: number;
  sourceOpId: string;
  phase: string;
  knownProjections: ProjectionPayload[];
  append(kind: 'ProjectionIntent' | 'ProjectionReceipt', payload: ProjectionPayload): Promise<void>;
}

/** Native writes are preceded by shared intents; no body PUT and no pretend atomic CAS. */
export class ProjectionExecutor {
  constructor(private readonly gateway: JoplinGateway) {}

  async execute(context: ProjectionContext, after: NativeFields): Promise<NativeNote> {
    const intentId = stableHash(['journey-projection', context.sourceOpId, context.noteId, context.carrierGeneration, context.phase]);
    const existing = context.knownProjections.find(item => item.intentId === intentId && !item.readbackHash);
    let note = await this.gateway.getNote(context.noteId);
    if (!note || note.deleted_time || note.encryption_applied) throw new StorageError('MISSING_CARRIER', '执行笔记正在等待同步、解密或已被删除；不会自动重建。', { noteId: context.noteId });
    const intent: ProjectionPayload = existing ?? {
      intentId, noteId: context.noteId, occurrenceId: context.occurrenceId, carrierGeneration: context.carrierGeneration,
      sourceOpId: context.sourceOpId, phase: context.phase, before: nativeFields(note), after,
    };
    if (existing && !sameNative(existing.after, after)) throw new StorageError('PROJECTION_CONFLICT', '同一投影意图出现不同结果，已暂停。');
    if (!existing) await context.append('ProjectionIntent', intent);
    note = await this.gateway.getNote(context.noteId);
    if (!note || note.deleted_time || note.encryption_applied) throw new StorageError('MISSING_CARRIER', '投影前笔记不可用。');
    if (!sameNative(note, intent.before) && !sameNative(note, intent.after)) {
      throw new StorageError('NATIVE_CHANGED', '原生提醒或任务状态在保存期间被修改，已保留修改并暂停，请刷新。', { noteId: note.id });
    }
    if (!sameNative(note, intent.after)) {
      const patch: Partial<NativeFields> = {};
      if (note.is_todo !== after.is_todo) patch.is_todo = after.is_todo;
      if ((note.todo_due || 0) !== after.todo_due) patch.todo_due = after.todo_due;
      if ((note.todo_completed || 0) !== after.todo_completed) patch.todo_completed = after.todo_completed;
      note = await this.gateway.patchNote(note.id, patch);
    }
    if (!sameNative(note, after)) throw new StorageError('PROJECTION_READBACK', '原生任务字段读回不一致，已停止重试以保护用户修改。', { noteId: note.id });
    if (!context.knownProjections.some(item => item.intentId === intentId && item.readbackHash === stableHash(after))) {
      await context.append('ProjectionReceipt', { ...intent, readbackHash: stableHash(after) });
    }
    return note;
  }
}
