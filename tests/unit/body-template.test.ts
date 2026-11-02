import test from 'node:test';
import assert from 'node:assert/strict';
import { BODY_TEMPLATE_MARKERS as m, initializeArchiveBody, parseArchiveBody } from '../../src/domain/bodyTemplate';
import { buildArchiveBody, stripBodyTemplate } from '../support/body-template';
import { templateNote } from '../support/template-note';

test('only the plain template pair is structural and its raw body is not wrapped or reset', () => {
  for (const original of ['', 'plain', '\n', '  ', '- [x] done\n- [ ] todo\n', '中文\r\n末行\r\n', '````md\n```code\n````']) {
    const native = templateNote(original, 'existing log\n', '\nsuffix user text');
    const parsed = parseArchiveBody(native)!;
    assert.equal(parsed.templateBody, original);
    assert.equal(parsed.prefix, 'existing log\n'); assert.equal(parsed.suffix, '\nsuffix user text');
    assert.equal(stripBodyTemplate(native), 'existing log\n\nsuffix user text');
    assert.ok(!native.includes('execution:start'));
  }
});

test('initialization copies template immediately above start and preserves all other native text', () => {
  const native = templateNote('- [x] keep checked\n- [ ] next', 'existing log\n', '\nuser suffix');
  const initialized = initializeArchiveBody(native);
  assert.equal(initialized, 'existing log\n- [x] keep checked\n- [ ] next\n' + templateNote('- [x] keep checked\n- [ ] next') + '\nuser suffix');
  assert.equal(parseArchiveBody(initialized)!.templateBody, '- [x] keep checked\n- [ ] next');
  assert.doesNotMatch(initialized, /journey-tasks:v3:execution|```markdown/);
});

test('markers inside fenced/indented code and prose are not owned structure', () => {
  for (const body of [`\`\`\`html\n${m.templateStart}\n\`\`\``, `~~~\n${m.templateEnd}\n~~~`, `    ${m.templateStart}`, `\t${m.templateStart}`, `Example ${m.templateEnd}`]) {
    assert.equal(parseArchiveBody(body), null); assert.equal(stripBodyTemplate(body), body);
  }
});

test('missing duplicate reversed and damaged pairs fail closed without treating arbitrary execution as template', () => {
  const good = templateNote('- [x] template');
  const bad = [good.replace(m.templateStart, ''), good.replace(m.templateEnd, ''), m.templateStart + '\n' + good,
    good.replace(m.templateStart, m.templateEnd), good.replace(m.templateEnd, '<!-- template:unknown -->')];
  for (const body of bad) {
    assert.throws(() => parseArchiveBody(body), { code: 'TEMPLATE_FORMAT' });
    assert.throws(() => stripBodyTemplate(body), { code: 'TEMPLATE_FORMAT' });
  }
  assert.equal(initializeArchiveBody('only execution logs'), 'only execution logs');
});

test('cleanup concatenates original prefix and suffix exactly and never merges template into execution', () => {
  const native = templateNote('template-only-secret', '- [x] execution\n\n', '\n\nsuffix');
  assert.equal(stripBodyTemplate(native), '- [x] execution\n\n\n\nsuffix');
  const built = buildArchiveBody('- [x] execution', 'ordinary raw template');
  assert.equal(built, '- [x] execution\n' + templateNote('ordinary raw template'));
});

test('native CRLF pairs and template code examples remain readable without adding a fence', () => {
  const native = templateNote('```md\n- [x] code example\n```').replaceAll('\n', '\r\n');
  assert.equal(parseArchiveBody(native)!.templateBody, '```md\r\n- [x] code example\r\n```');
  assert.equal(stripBodyTemplate(native), '');
});

test('one-click insertion preserves execution bytes, is idempotent and refuses damaged structure', async () => {
  const { insertTemplateBlock } = await import('../../src/domain/bodyTemplate');
  for (const body of ['', '- [x] done', '中文\r\n', '```md\nexample\n```']) {
    const inserted = insertTemplateBlock(body);
    assert.ok(inserted.startsWith(body));
    assert.equal(parseArchiveBody(inserted)!.templateBody, '');
    assert.equal(insertTemplateBlock(inserted), inserted);
  }
  for (const body of [m.templateStart, '```md\nunfinished']) {
    assert.throws(() => insertTemplateBlock(body), { code: 'TEMPLATE_FORMAT' });
  }
});
