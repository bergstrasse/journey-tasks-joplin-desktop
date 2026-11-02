import type { RecurrenceRule, SeriesDefinition } from '../../src/shared/models';

export function definition(overrides: Partial<SeriesDefinition> = {}, rule: Partial<RecurrenceRule> = {}): SeriesDefinition {
  return {
    seriesId: 'series-one', revisionId: 'create', parentRevisionIds: [],
    anchor: { kind: 'allDay', date: '2024-01-31', zone: 'Asia/Shanghai' },
    priority: 'none', pinned: false, modeForNext: 'continuous',
    reminder: { enabled: false }, sourceNotebookId: 'notebook', sourceTagIds: [],
    ...overrides,
    rule: {
      calendar: 'gregorian', frequency: 'monthly', interval: 1,
      basis: 'scheduled', monthDay: 31, end: { kind: 'never' }, ...rule,
    },
  };
}
