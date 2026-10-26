import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveFixedGroupModel } from '../server/groupKeys.ts';
import { generate } from '../server/provider.ts';

async function requestBody(model: string, protocol: 'responses' | 'chat-completions') {
  const previousFetch = globalThis.fetch;
  const previousAllowLocal = process.env.ALLOW_LOCAL_MODEL;
  const previousKey = process.env.MODEL_KEY_GRT_PRO;
  let body: Record<string, unknown> | undefined;
  process.env.ALLOW_LOCAL_MODEL = 'true';
  process.env.MODEL_KEY_GRT_PRO = 'TEST_ONLY_FAKE_API_KEY';
  globalThis.fetch = async (_input, init) => {
    body = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({ output_text: 'ok', choices: [{ message: { content: 'ok' } }] }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const modelConfig = resolveFixedGroupModel('GRT-PRO稳定', model, protocol);
    await generate({
      modelConfig: { ...modelConfig, baseUrl: 'http://localhost/v1', stream: false },
      prompt: 'test',
      constraint: 'test',
      signal: new AbortController().signal,
      onDelta: () => undefined,
    });
    return body;
  } finally {
    globalThis.fetch = previousFetch;
    if (previousAllowLocal === undefined) delete process.env.ALLOW_LOCAL_MODEL;
    else process.env.ALLOW_LOCAL_MODEL = previousAllowLocal;
    if (previousKey === undefined) delete process.env.MODEL_KEY_GRT_PRO;
    else process.env.MODEL_KEY_GRT_PRO = previousKey;
  }
}

test('gpt-6.1-sol 使用 Responses high 推理强度', async () => {
  const body = await requestBody('gpt-6.1-sol', 'responses');
  assert.deepEqual(body?.reasoning, { effort: 'high' });
});

test('deepseek-v4.1-flash 使用 Chat Completions high 推理强度', async () => {
  const body = await requestBody('deepseek-v4.1-flash', 'chat-completions');
  assert.equal(body?.reasoning_effort, 'high');
});
