import { stableHash } from '../../domain/identity';
import { initializeArchiveBody, parseArchiveBody } from '../../domain/bodyTemplate';
import { JournalRepository } from './repositories';
import { StorageError, type NativeNote } from './gateway';

/** Only a fresh read from the native first note supplies business template content. */
export interface TemplateSource { title: string; body: string; sourceHash: string; sourceNoteId: string }
function templateResourceIds(body: string): string[] {
  return [...new Set(Array.from(body.matchAll(/:\/([0-9a-f]{32})(?=[\s)\]"'>?#]|$)/gi), match => match[1]!.toLowerCase()))].sort();
}
export class TemplateRepository {
  constructor(private readonly journal: JournalRepository, _now: () => number = Date.now) {}

  async ensureSource(seriesId: string): Promise<TemplateSource> {
    const note = await this.anchor(seriesId);
    const source = await this.source(note, parseArchiveBody(note.body)?.templateBody ?? ''); // Validate before changing native content.
    if (!source.body) return source;
    const key = this.initializationKey(seriesId);
    if (await this.journal.userData.get(note.id, key + ':done')) return source;
    const body = initializeArchiveBody(note.body);
    type Preparation = { beforeHash: string; afterHash: string };
    const prepared = await this.journal.userData.get<Preparation>(note.id, key + ':prepare');
    const receipt = prepared ?? { beforeHash: stableHash(note.body), afterHash: stableHash(body) };
    if (!prepared) await this.journal.userData.append(note.id, key + ':prepare', receipt);
    const fresh = await this.anchor(seriesId);
    const hash = stableHash(fresh.body);
    if (hash !== receipt.afterHash) {
      if (hash !== receipt.beforeHash || stableHash(body) !== receipt.afterHash)
        throw new StorageError('TEMPLATE_SOURCE_CHANGED', '初始化过程中首篇已变化，请检查原文后重试。');
      const saved = await this.journal.gateway.patchNote(note.id, { body });
      if (stableHash(saved.body) !== receipt.afterHash)
        throw new StorageError('TEMPLATE_SOURCE_CHANGED', '模板初始化读回不一致，已停止处理以保护原文。');
    }
    await this.markInitialized(seriesId);
    return this.readSource(seriesId);
  }

  /** New roots already contain their execution copy in the initial POST. */
  async markInitialized(seriesId: string): Promise<void> {
    const source = await this.readSource(seriesId);
    if (source.body) await this.journal.userData.append(source.sourceNoteId, this.initializationKey(seriesId) + ':done', true);
  }

  private initializationKey(seriesId: string): string {
    return `v3:archive-init:${stableHash(seriesId)}`;
  }

  async readSource(seriesId: string): Promise<TemplateSource> {
    const note = await this.anchor(seriesId);
    const parsed = parseArchiveBody(note.body);
    // Unstructured execution text stays on the first note; only explicit templates are copied.
    return this.source(note, parsed?.templateBody ?? '');
  }

  private async source(note: NativeNote, body: string): Promise<TemplateSource> {
    if (!note.title.trim()) throw new StorageError('TEMPLATE_TITLE', '归档首篇标题不能为空。');
    await this.verifyReferences(body);
    return { title: note.title, body, sourceHash: stableHash({ title: note.title, body }), sourceNoteId: note.id };
  }
  private async anchor(seriesId: string): Promise<NativeNote> {
    const id = this.journal.controlId(seriesId), note = await this.journal.gateway.getNote(id);
    if (!note || note.deleted_time || note.encryption_applied || note.is_conflict) throw new StorageError('TEMPLATE_UNAVAILABLE', '归档首篇尚未同步、已删除或不可用，后续生成已暂停。', { noteId: id });
    return note;
  }

  async verifyReferences(body: string): Promise<string[]> {
    // Archive templates deliberately do not support embedded attachments; reject rather than silently strip content.
    // Ignore code fences/inline code: examples containing Markdown are not actual embeds.
    const content = body.replace(/```[\s\S]*?```|~~~[\s\S]*?~~~/g, '').replace(/`[^`\n]*`/g, '');
    const hasImage = [...content.matchAll(/!\[[^\]]*\]/g)].some(match => {
      let slashes = 0;
      for (let i = match.index! - 1; i >= 0 && content[i] === '\\'; i--) slashes++;
      return slashes % 2 === 0;
    });
    if (hasImage || /<\s*(?:img|audio|video|iframe|object|embed)\b|\bdata\s*:\s*(?:[a-z0-9.+-]+\/[a-z0-9.+-]+|;[^\s,]*,|,)/im.test(content)) {
      throw new StorageError('TEMPLATE_ATTACHMENTS_UNSUPPORTED', '周期模板不支持内嵌图片或附件，请改用独立资料笔记链接。');
    }
    const noteIds = templateResourceIds(content);
    for (const id of noteIds) {
      const resource = await this.journal.gateway.getResource(id);
      if (resource) throw new StorageError('TEMPLATE_ATTACHMENTS_UNSUPPORTED', '周期模板不支持附件资源引用，请改用独立资料笔记链接。', { resourceId: id });
      const note = await this.journal.gateway.getNote(id);
      if (!note || note.deleted_time || note.encryption_applied || note.is_conflict)
        throw new StorageError('TEMPLATE_REFERENCE_MISSING', '模板链接的资料笔记尚未同步、已删除或不可用，请恢复后再保存。', { noteId: id });
    }
    return noteIds;
  }

}
