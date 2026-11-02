import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';

// Dynamic key families, with the production caller that constructs or resolves them.
export const dynamicTranslationKeys = [
  { pattern: /^(backend|diagnostic|error)\./, caller: 'src/i18n/index.ts' }, // translateMessage also resolves full message text.
  { pattern: /^history\./, caller: 'src/panel/TaskHistory.tsx' },
  { pattern: /^weekday\.[1-7]$/, caller: 'src/panel/TaskViews.tsx' },
  { pattern: /^month\.([1-9]|1[0-2])$/, caller: 'src/panel/TaskViews.tsx' },
  { pattern: /^rule\.unit\.(daily|weekly|monthly|yearly)\.(one|other)$/, caller: 'src/panel/App.tsx' },
  { pattern: /^rule\.(gregorian|lunar|day|lastDay|nthWeekday|lunarYearEnd)$/, caller: 'src/panel/TaskHistory.tsx' },
  { pattern: /^priority\.(none|low|medium|high)$/, caller: 'src/panel/TaskHistory.tsx' },
  { pattern: /^view\.(inbox|today|tomorrow|sevenDays|all|day|week|month|year)$/, caller: 'src/panel/CalendarViewPicker.tsx' },
  { pattern: /^group\.(pinned|overdue|inbox)$/, caller: 'src/panel/TaskViews.tsx' },
  { pattern: /^navigation\.(previous|next)(Day|Week|Month|Year)$/, caller: 'src/panel/TaskViews.tsx' },
  { pattern: /^navigation\.current\.(day|week|month|year)$/, caller: 'src/panel/TaskViews.tsx' },
  { pattern: /^sort\.(time|notebook|ascending|descending|nameAsc|nameDesc|createdAsc|createdDesc|scheduledAsc|scheduledDesc)$/, caller: 'src/panel/ListSortMenu.tsx' },
];
export function sourceTranslationLiterals(directory = 'src'): Set<string> {
  const literals = new Set<string>();
  function walk(dir: string) {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (/\.tsx?$/.test(path)) {
        const source = ts.createSourceFile(path, readFileSync(path, 'utf8'), ts.ScriptTarget.Latest, true);
        function visit(node: ts.Node) {
          if (ts.isStringLiteralLike(node)) literals.add(node.text);
          ts.forEachChild(node, visit);
        }
        visit(source);
      }
    }
  }
  walk(directory);
  return literals;
}
export function unusedTranslationKeys(keys: string[]): string[] {
  const literals = sourceTranslationLiterals();
  return keys.filter(key => !literals.has(key) && !dynamicTranslationKeys.some(({ pattern }) => pattern.test(key)));
}
