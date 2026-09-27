import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { computed, ref } from 'vue';
import { MODEL_GROUPS, type BrowserModelConfig } from '../shared/types.ts';
import { MODEL_STORAGE_KEY, readLocalModels } from '../src/localModels.ts';

const file = readFileSync(new URL('../src/App.vue', import.meta.url), 'utf8');
const script = file.slice(file.indexOf('>', file.indexOf('<script')) + 1, file.indexOf('</script>'))
  .split(String.fromCharCode(10)).filter(line => !line.startsWith('import ')).join(String.fromCharCode(10));
const expose = ';globalThis.state = { ownRun, activeRunId, details, setAutoTestEnabled, startGeneration, selectedConfigId };';
const compiled = ts.transpileModule(script + expose, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None } }).outputText;
const target: BrowserModelConfig = {
  id: 'target', name: 'GRT-PRO稳定', group: 'GRT-PRO稳定', model: 'gpt-6-astra',
  baseUrl: 'https://provider.example/v1', apiKey: 'TEST_ONLY', protocol: 'responses', stream: true,
  isDefault: false, hasKey: true, keyMask: '****', createdAt: '2026-09-27T00:00:00.000Z', updatedAt: '2026-09-27T00:00:00.000Z',
};
const minute = 60_000;
const flush = () => new Promise<void>(resolve => setImmediate(resolve));

async function browser(clock: { now: number }, saved = new Map<string, string>()) {
  let mounted: () => Promise<void>;
  let unmounted: () => void;
  let timer: { callback: () => void; due: number; interval: number } | undefined;
  const requests: any[] = [];
  const storage = { getItem: (key: string) => saved.get(key) ?? null, setItem: (key: string, value: string) => saved.set(key, value), removeItem: (key: string) => saved.delete(key) };
  if (!saved.has(MODEL_STORAGE_KEY)) storage.setItem(MODEL_STORAGE_KEY, JSON.stringify([target, { ...target, id: 'manual', group: 'GPT-企业级', isDefault: true }]));
  class Clock extends Date {
    constructor(value?: string | number) { super(value ?? clock.now); }
    static now() { return clock.now; }
  }
  const context: any = {
    ref, computed, MODEL_GROUPS, MODEL_STORAGE_KEY, Date: Clock, Headers, crypto, localStorage: storage,
    readLocalModels: () => readLocalModels(storage),
    onMounted: (fn: () => Promise<void>) => { mounted = fn; },
    onUnmounted: (fn: () => void) => { unmounted = fn; },
    window: {
      setInterval(callback: () => void, interval: number) { timer = { callback, interval, due: clock.now + interval }; return 1; },
      clearInterval() { timer = undefined; }, setTimeout() { return 2; }, clearTimeout() {}, addEventListener() {}, removeEventListener() {},
    },
    fetch: async (url: string, options?: RequestInit) => {
      let data: unknown;
      if (url === '/api/admin/session') data = { configured: false, authenticated: false };
      else if (url === '/api/runs' && options?.method === 'POST') {
        requests.push(JSON.parse(String(options.body)));
        data = { id: 'run-' + requests.length };
      } else if (url.startsWith('/api/runs?')) data = { items: [], total: 0, activeRun: null };
      else if (url.startsWith('/api/runs/')) data = {
        id: url.split('/').at(-1), prompt: '测试', constraint: '', rawOutput: '', html: null, status: 'succeeded',
        createdAt: new Date(clock.now).toISOString(), completedAt: new Date(clock.now).toISOString(), elapsedMs: 100,
        usage: null, error: null, hasHtml: false, snapshot: { group: target.group, model: target.model, protocol: target.protocol, stream: true, timeoutMs: 600000 },
      };
      else throw new Error('Unexpected URL: ' + url);
      return new Response(JSON.stringify(data), { status: options?.method === 'POST' ? 202 : 200 });
    },
  };
  vm.createContext(context);
  vm.runInContext(compiled, context);
  await mounted!();
  await flush();
  return {
    saved, requests, state: context.state, close: () => unmounted!(),
    async advance(milliseconds: number) {
      clock.now += milliseconds;
      if (timer && clock.now >= timer.due) { timer.due = clock.now + timer.interval; timer.callback(); }
      await flush();
    },
  };
}

test('刷新页面不重置剩余等待时间，仍按原定时间使用固定模型生成', async () => {
  const clock = { now: new Date(2026, 8, 27, 20).valueOf() };
  const first = await browser(clock);
  await first.advance(6 * minute);
  assert.equal(first.requests.length, 0);
  first.close();
  const second = await browser(clock, first.saved);
  await second.advance(4 * minute);
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].modelConfig.group, 'GRT-PRO稳定');
  assert.equal(second.requests[0].modelConfig.model, 'gpt-6-astra');
  assert.equal(second.state.selectedConfigId.value, 'manual');
  second.close();
});

test('重新打开页面时已到执行时间，只补发一次，不重新等待十分钟', async () => {
  const clock = { now: new Date(2026, 8, 27, 20).valueOf() };
  const first = await browser(clock);
  first.close();
  clock.now += 12 * minute;
  const second = await browser(clock, first.saved);
  assert.equal(second.requests.length, 1);
  await second.advance(minute);
  assert.equal(second.requests.length, 1);
  second.close();
});

test('服务端任务已结束时清理残留状态，不永久阻塞自动生成', async () => {
  const clock = { now: new Date(2026, 8, 27, 20).valueOf() };
  const app = await browser(clock);
  app.state.ownRun.value = { id: 'finished', requestId: 'owner' };
  app.state.activeRunId.value = 'finished';
  app.state.details.value.finished = { status: 'running' };
  await app.advance(10 * minute);
  assert.equal(app.requests.length, 1);
  app.close();
});

test('夜间不补发，次日八点恢复自动生成', async () => {
  const clock = { now: new Date(2026, 8, 27, 21, 50).valueOf() };
  const app = await browser(clock);
  await app.advance(10 * minute);
  assert.equal(app.requests.length, 0);
  await app.advance(10 * 60 * minute - 1000);
  assert.equal(app.requests.length, 0);
  await app.advance(1000);
  assert.equal(app.requests.length, 1);
  app.close();
});

test('暂停后刷新页面也不生成，手动生成仍使用所选模型', async () => {
  const clock = { now: new Date(2026, 8, 27, 20).valueOf() };
  const first = await browser(clock);
  first.state.setAutoTestEnabled(false);
  first.close();
  const second = await browser(clock, first.saved);
  await second.advance(20 * minute);
  assert.equal(second.requests.length, 0);
  await second.state.startGeneration();
  assert.equal(second.requests.length, 1);
  assert.equal(second.requests[0].modelConfig.group, 'GPT-企业级');
  second.close();
});
