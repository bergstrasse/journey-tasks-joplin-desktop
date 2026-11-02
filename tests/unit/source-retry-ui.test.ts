import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import ts from 'typescript';

test('source failure diagnostics retain an enabled retrySeries UI path for a known series', () => {
  const source = readFileSync(new URL('../../src/panel/App.tsx', import.meta.url), 'utf8');
  const file = ts.createSourceFile('App.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let codes: string[] = [];
  let retryButton = '';
  function visit(node: ts.Node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === 'retryableSeriesDiagnostics') {
      const strings: string[] = [];
      const collect = (child: ts.Node) => { if (ts.isStringLiteral(child)) strings.push(child.text); ts.forEachChild(child, collect); };
      collect(node); codes = strings;
    }
    if (ts.isJsxElement(node) && node.openingElement.tagName.getText(file) === 'button' && node.getText(file).includes("action: 'retrySeries'")) retryButton = node.getText(file);
    ts.forEachChild(node, visit);
  }
  visit(file);
  for (const code of ['TEMPLATE_FORMAT', 'TEMPLATE_UNAVAILABLE', 'TEMPLATE_REFERENCE_MISSING', 'TEMPLATE_ATTACHMENTS_UNSUPPORTED', 'TEMPLATE_SOURCE_CHANGED', 'ANCHOR_MISSING_PENDING', 'CONTROL_READ_ONLY']) assert.ok(codes.includes(code), code);
  assert.match(source, /d\.seriesId && retryableSeriesDiagnostics\.has\(d\.code\)/);
  assert.match(retryButton, /disabled=\{busy\}/);
  assert.match(retryButton, /seriesId: d\.seriesId!/);
  assert.match(retryButton, /noteId: d\.noteId/);
  assert.match(retryButton, /t\('root\.retry'\)/);
});
