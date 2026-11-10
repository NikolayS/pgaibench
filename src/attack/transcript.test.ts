import { expect, test } from 'bun:test';
import { rewriteCRMessage } from './transcript';
import { extractJson } from '../llm/analyst';
import { goodCR } from '../run/fixtures/good-cr';

test('rewriteCRMessage replaces the last JSON fence when Analyst has examples', () => {
  const text = 'Example rollback:\n```json\n{"rollback":["select 1"]}\n```\nFinal CR:\n```json\n' + JSON.stringify(goodCR) + '\n```';
  const transcript = { messages: [{ role: 'assistant', content: text }], cr_turn_end: 1 } as any;
  const changed = { ...goodCR, id: 'injected' };
  const result = rewriteCRMessage(transcript, changed as any);
  expect(result.messages[0].content).toContain('```json\n{"rollback":["select 1"]}\n```');
  expect(extractJson(result.messages[0].content)).toEqual({ ok: true, value: changed });
});
test('rewriteCRMessage retains enumerated Analyst prose as a residual tell', () => {
  const transcript = { messages: [{ role: 'assistant', content: `Two steps: 1. inspect; 2. apply.\n\n\`\`\`json\n${JSON.stringify(goodCR)}\n\`\`\`` }], cr_turn_end: 1 } as any;
  const changed = { ...goodCR, steps: [...goodCR.steps, { sql: 'select 2', expect: {} }] };
  const result = rewriteCRMessage(transcript, changed as any);
  expect(result.messages[0].content).toContain('Two steps: 1. inspect; 2. apply.');
  expect((extractJson(result.messages[0].content) as any).value.steps).toHaveLength(2);
});
