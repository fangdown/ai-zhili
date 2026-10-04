import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { Store } from '../server/db.ts';
import { AUTO_TEST_INTERVAL_MS, createAutoTestScheduler, isAutoTestQuietTime } from '../server/autoTest.ts';

function memoryStore() {
  const directory = mkdtempSync(join(tmpdir(), 'ai-zhili-auto-test-'));
  const path = join(directory, 'history.sqlite');
  new Store(path).close();
  const store = new Store(path);
  return { directory, store, close: () => { store.close(); rmSync(directory, { recursive: true }); } };
}

test('北京时间 23 点到次日 8 点不自动测试', () => {
  assert.equal(isAutoTestQuietTime(Date.parse('2026-10-04T14:59:00Z')), false);
  assert.equal(isAutoTestQuietTime(Date.parse('2026-10-04T15:00:00Z')), true);
  assert.equal(isAutoTestQuietTime(Date.parse('2026-10-04T23:59:00Z')), true);
  assert.equal(isAutoTestQuietTime(Date.parse('2026-10-05T00:00:00Z')), false);
});

test('服务器按保存的时间每 10 分钟只生成一次', async () => {
  const clock = { now: Date.parse('2026-10-04T04:00:00Z') };
  const { store, close } = memoryStore();
  const prompts: string[] = [];
  try {
    const scheduler = createAutoTestScheduler({
      store, now: () => clock.now, defaultPrompt: '默认提示词',
      startRun: prompt => { prompts.push(prompt); },
    });
    await scheduler.tick();
    assert.deepEqual(prompts, []);
    clock.now += AUTO_TEST_INTERVAL_MS;
    await scheduler.tick();
    await scheduler.tick();
    assert.deepEqual(prompts, ['默认提示词']);
    const reopened = createAutoTestScheduler({
      store, now: () => clock.now, defaultPrompt: '默认提示词',
      startRun: prompt => { prompts.push(prompt); },
    });
    await reopened.tick();
    assert.equal(prompts.length, 1);
    clock.now += AUTO_TEST_INTERVAL_MS;
    await reopened.tick();
    assert.equal(prompts.length, 2);
  } finally { close(); }
});

test('管理员暂停后不再生成，恢复后重新等待 10 分钟', async () => {
  const clock = { now: Date.parse('2026-10-04T04:00:00Z') };
  const { store, close } = memoryStore();
  const prompts: string[] = [];
  try {
    const scheduler = createAutoTestScheduler({
      store, now: () => clock.now, defaultPrompt: '默认提示词',
      startRun: prompt => { prompts.push(prompt); },
    });
    scheduler.setEnabled(false);
    clock.now += AUTO_TEST_INTERVAL_MS * 3;
    await scheduler.tick();
    assert.deepEqual(prompts, []);
    scheduler.setPrompt('页面上的提示词');
    scheduler.setEnabled(true);
    await scheduler.tick();
    assert.deepEqual(prompts, []);
    clock.now += AUTO_TEST_INTERVAL_MS;
    await scheduler.tick();
    assert.deepEqual(prompts, ['页面上的提示词']);
  } finally { close(); }
});

test('已有任务进行中时跳过本次，不重复提交', async () => {
  const clock = { now: Date.parse('2026-10-04T04:00:00Z') };
  const { store, close } = memoryStore();
  const prompts: string[] = [];
  try {
    const busy = store.createRun({ requestId: 'busy', prompt: '进行中', constraintText: '约束', snapshot: { group: 'GRT-PRO稳定', model: 'gpt-6-astra', protocol: 'responses', stream: true, timeoutMs: 600000 } });
    assert.equal(busy.status, 'running');
    const scheduler = createAutoTestScheduler({
      store, now: () => clock.now, defaultPrompt: '默认提示词',
      startRun: prompt => { prompts.push(prompt); },
    });
    clock.now += AUTO_TEST_INTERVAL_MS;
    await scheduler.tick();
    assert.deepEqual(prompts, []);
    assert.match(scheduler.state().lastMessage, /尚未结束/);
  } finally { close(); }
});
