import type { DomainOperation, Occurrence, SeriesDefinition } from '../../src/shared/models';
import { candidateSlotKey, occurrenceKey, stableHash } from '../../src/domain/identity';
import { definition } from './series';

export function operation<K extends DomainOperation['kind']>(
  opId: string, kind: K, payload: Extract<DomainOperation, { kind: K }>['payload'],
  parents: string[] = ['create'], recordedAt = 100,
): Extract<DomainOperation, { kind: K }> {
  return { schemaVersion: 1, opId, deviceId: opId.startsWith('B') ? 'B' : 'A', deviceSeq: 1,
    seriesId: 'series-one', parents, recordedAt, kind, payload, payloadHash: stableHash(payload) } as Extract<DomainOperation, { kind: K }>;
}

export function initialSeries(def: SeriesDefinition = definition()) {
  const first: Occurrence = {
    occurrenceId: occurrenceKey(def.seriesId), seriesId: def.seriesId,
    originatingRevisionId: def.revisionId, originSlotKey: candidateSlotKey(def, def.anchor),
    suppressedSlotKeys: [], scheduled: def.anchor, resolution: 'open', consumed: false,
    carrierNoteId: 'carrier', carrierGeneration: 0, mode: def.modeForNext,
  };
  const create = operation('create', 'CreateSeries', { definition: def, first }, []);
  return { def, first, create };
}

export function nextOccurrence(first: Occurrence, def: SeriesDefinition, date = '2024-02-29'): Occurrence {
  const scheduled = { ...first.scheduled, date };
  return {
    ...first, occurrenceId: occurrenceKey(def.seriesId, first.occurrenceId), predecessorId: first.occurrenceId,
    scheduled, originSlotKey: candidateSlotKey(def, scheduled), carrierGeneration: first.carrierGeneration + 1,
  };
}
