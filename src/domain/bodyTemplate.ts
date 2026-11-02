import { StorageError } from '../adapters/joplin/gateway';

export const BODY_TEMPLATE_MARKERS = {
  templateStart: '<!-- template:start -->',
  templateEnd: '<!-- template:end -->',
} as const;
type MarkerName = keyof typeof BODY_TEMPLATE_MARKERS;
interface Line { text: string; start: number; contentEnd: number; end: number; eol: string }
export interface ParsedArchiveBody {
  templateBody: string;
  prefix: string;
  suffix: string;
}
function formatError(): never { throw new StorageError('TEMPLATE_FORMAT', '归档任务的模板标记已损坏，请在原笔记中修复；不会猜测或丢弃正文。'); }
function lines(body: string): Line[] {
  const result: Line[] = [];
  const pattern = /([^\r\n]*)(\r\n|\n|\r|$)/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    if (!match[0].length) break;
    result.push({ text: match[1]!, start: match.index, contentEnd: match.index + match[1]!.length, end: pattern.lastIndex, eol: match[2]! });
  }
  return result;
}
function markerLines(body: string): Partial<Record<MarkerName, Line>> {
  const found: Partial<Record<MarkerName, Line>> = {};
  let fence: { character: string; length: number } | undefined;
  for (const line of lines(body)) {
    const opening = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line.text);
    if (fence) {
      const closing = /^ {0,3}(`+|~+)[ \t]*$/.exec(line.text);
      if (closing && closing[1]![0] === fence.character && closing[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    if (/^(?: {4}|\t)/.test(line.text)) continue;
    if (opening && !(opening[1]![0] === '`' && opening[2]!.includes('`'))) { fence = { character: opening[1]![0]!, length: opening[1]!.length }; continue; }
    const trimmed = line.text.trim();
    if (!trimmed.includes('template:') && !trimmed.includes('journey-tasks:v3:')) continue;
    // Reserved standalone comments outside code are structural, including damaged/unknown markers.
    if (!/^ {0,3}<!--\s*(?:template:|journey-tasks:v3:)/.test(line.text)) continue;
    const name = (Object.keys(BODY_TEMPLATE_MARKERS) as MarkerName[]).find(key => BODY_TEMPLATE_MARKERS[key] === trimmed);
    if (!name || found[name]) formatError();
    found[name] = line;
  }
  return found;
}
function interior(body: string, start: Line, end: Line): string {
  if (!start.eol || start.end > end.start) formatError();
  const value = body.slice(start.end, end.start);
  // Remove exactly the structural delimiter, retaining every newline in the original payload.
  if (!value) return '';
  if (!value.endsWith(start.eol)) formatError();
  return value.slice(0, -start.eol.length);
}
/** null means genuinely unstructured text; malformed reserved markers always fail closed. */
export function parseArchiveBody(body: string): ParsedArchiveBody | null {
  const found = markerLines(body);
  if (!Object.keys(found).length) return null;
  const { templateStart, templateEnd } = found;
  if (!templateStart || !templateEnd || templateStart.start >= templateEnd.start) formatError();
  return { templateBody: interior(body, templateStart, templateEnd),
    prefix: body.slice(0, templateStart.start), suffix: body.slice(templateEnd.contentEnd) };
}
/** Caller must persist an initialization receipt; this pure conversion intentionally has no hidden state. */
export function initializeArchiveBody(body: string): string {
  const parsed = parseArchiveBody(body);
  if (!parsed) return body;
  const separator = parsed.templateBody && !/[\r\n]$/.test(parsed.templateBody) ? '\n' : '';
  return parsed.prefix + parsed.templateBody + separator + body.slice(parsed.prefix.length);
}

/** Insert an empty editable template while retaining all existing execution text. */
export function insertTemplateBlock(body: string): string {
  if (parseArchiveBody(body)) return body;
  const separator = body && !/[\r\n]$/.test(body) ? '\n' : '';
  const result = `${body}${separator}${BODY_TEMPLATE_MARKERS.templateStart}\n\n${BODY_TEMPLATE_MARKERS.templateEnd}`;
  // An unclosed code fence would hide the appended markers; leave that body untouched.
  if (!parseArchiveBody(result)) formatError();
  return result;
}
