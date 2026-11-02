import { BODY_TEMPLATE_MARKERS, parseArchiveBody } from '../../src/domain/bodyTemplate';
import { StorageError } from '../../src/adapters/joplin/gateway';
function formatError(): never { throw new StorageError('TEMPLATE_FORMAT', 'Invalid template markers'); }
export function buildArchiveBody(executionBody: string, templateBody = executionBody, _locale = 'zh-CN'): string {
  if (parseArchiveBody(executionBody)) formatError();
  const separator = executionBody && !/[\r\n]$/.test(executionBody) ? '\n' : '';
  const body = `${executionBody}${separator}${BODY_TEMPLATE_MARKERS.templateStart}\n${templateBody}\n${BODY_TEMPLATE_MARKERS.templateEnd}`;
  const parsed = parseArchiveBody(body);
  if (!parsed || parsed.templateBody !== templateBody) formatError();
  return body;
}
export function stripBodyTemplate(body: string): string {
  const parsed = parseArchiveBody(body);
  return parsed ? parsed.prefix + parsed.suffix : body;
}

