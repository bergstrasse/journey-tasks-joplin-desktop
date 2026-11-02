/** Native Markdown entered by a user before enabling archive repetition. */
export const templateStart = '<!-- template:start -->';
export const templateEnd = '<!-- template:end -->';
export function templateNote(template: string, prefix = '', suffix = ''): string {
  return `${prefix}${templateStart}\n${template}\n${templateEnd}${suffix}`;
}
