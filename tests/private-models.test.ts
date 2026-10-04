import assert from 'node:assert/strict';
import { test } from 'node:test';
import { DatabaseSync } from 'node:sqlite';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { deleteLocalModel, readLocalModels, saveLocalModel } from '../src/localModels.ts';
import { parseGenerationModel, publicModelSnapshot } from '../server/modelInput.ts';
import { Store } from '../server/db.ts';
import type { ModelInput } from '../shared/types.ts';

function browserStorage() {
  const values = new Map<string, string>();
  return { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => { values.set(key, value); } };
}

const config: ModelInput = {
  name: '本机配置', group: '自定义', baseUrl: 'https://provider.example/v1', model: 'example-model',
  protocol: 'chat-completions', stream: true, isDefault: true, apiKey: 'TEST_ONLY_FAKE_API_KEY',
};

test('不同浏览器的模型配置相互隔离，编辑留空保留 Key', () => {
  const first = browserStorage();
  const second = browserStorage();
  const saved = saveLocalModel(config, null, first);
  assert.equal(readLocalModels(first).length, 1);
  assert.deepEqual(readLocalModels(second), []);
  const edited = saveLocalModel({ ...config, name: '新名称', apiKey: '' }, saved.id, first);
  assert.equal(edited.apiKey, config.apiKey);
  assert.throws(() => saveLocalModel({ ...config, group: 'GRT-PRO稳定' }, null, first), /服务器保存/);
  saveLocalModel({ ...config, model: 'another-model', name: '第二个自定义' }, null, first);
  assert.equal(readLocalModels(first).length, 2);
  saveLocalModel({ ...config, name: '另一浏览器' }, null, second);
  deleteLocalModel(saved.id, first);
  assert.equal(readLocalModels(first).length, 1);
  assert.equal(readLocalModels(second)[0].name, '另一浏览器');
});

test('不再读取旧浏览器模型配置', () => {
  const storage = browserStorage();
  const { group: _group, ...legacyConfig } = config;
  storage.setItem('html-workbench.models.v1', JSON.stringify([{ ...legacyConfig, id: 'legacy', hasKey: true, keyMask: '••••••••', createdAt: '2026-09-26', updatedAt: '2026-09-26' }]));
  assert.deepEqual(readLocalModels(storage), []);
});

test('缺少本次配置不能回退共享 Key，公开快照不包含私有配置', () => {
  assert.throws(() => parseGenerationModel(undefined));
  assert.throws(() => parseGenerationModel({ ...config, apiKey: '' }));
  assert.throws(() => parseGenerationModel({ ...config, baseUrl: 'https://provider.example/v1?key=TEST_ONLY_FAKE_API_KEY' }));
  const parsed = parseGenerationModel(config);
  const snapshot = publicModelSnapshot(parsed);
  assert.deepEqual(Object.keys(snapshot).sort(), ['group', 'model', 'protocol', 'stream', 'timeoutMs']);
  assert.equal(JSON.stringify(snapshot).includes(config.apiKey!), false);
  assert.equal(JSON.stringify(snapshot).includes(config.baseUrl), false);
});

test('支持 Claude 原生 Messages 协议配置', () => {
  const parsed = parseGenerationModel({ ...config, protocol: 'anthropic-messages' });
  assert.equal(parsed.protocol, 'anthropic-messages');
  assert.equal(publicModelSnapshot(parsed).protocol, 'anthropic-messages');
});

test('固定分组使用服务器 Key，忽略浏览器提交的地址和 Key', () => {
  const previous = {
    grt: process.env.MODEL_KEY_GRT_PRO,
    claude: process.env.MODEL_KEY_CLAUDE_OPUS_5_5,
  };
  process.env.MODEL_KEY_GRT_PRO = 'SERVER_ONLY_GRT_KEY';
  process.env.MODEL_KEY_CLAUDE_OPUS_5_5 = 'SERVER_ONLY_CLAUDE_KEY';
  try {
    assert.throws(() => parseGenerationModel({ group: 'GRT-PRO稳定', model: 'gpt-6-astra', protocol: 'responses' }), /仅管理员/);
    const parsed = parseGenerationModel({ group: 'GRT-PRO稳定', model: 'gpt-6-astra', protocol: 'responses', apiKey: 'CLIENT_KEY', baseUrl: 'https://evil.example/v1' }, { allowFixedGroups: true });
    assert.equal(parsed.apiKey, 'SERVER_ONLY_GRT_KEY');
    assert.equal(parsed.baseUrl, 'https://api.opens.chat/v1');
    assert.equal(parsed.stream, true);
    const claude = parseGenerationModel({ group: 'claude-opus-5-5', model: 'claude-opus-5-5', protocol: 'anthropic-messages' }, { allowFixedGroups: true });
    assert.equal(claude.apiKey, 'SERVER_ONLY_CLAUDE_KEY');
    assert.equal(claude.protocol, 'anthropic-messages');
    assert.equal(JSON.stringify(publicModelSnapshot(claude)).includes('SERVER_ONLY_CLAUDE_KEY'), false);
    assert.throws(() => parseGenerationModel({ group: 'GRT-PRO稳定', model: 'not-a-model', protocol: 'responses' }, { allowFixedGroups: true }));
    delete process.env.MODEL_KEY_GRT_PRO;
    assert.throws(() => parseGenerationModel({ group: 'GRT-PRO稳定', model: 'gpt-6-astra', protocol: 'responses' }, { allowFixedGroups: true }));
  } finally {
    if (previous.grt === undefined) delete process.env.MODEL_KEY_GRT_PRO;
    else process.env.MODEL_KEY_GRT_PRO = previous.grt;
    if (previous.claude === undefined) delete process.env.MODEL_KEY_CLAUDE_OPUS_5_5;
    else process.env.MODEL_KEY_CLAUDE_OPUS_5_5 = previous.claude;
  }
});

test('迁移保留旧历史，新增记录无需共享模型且只保存公开快照', () => {
  const directory = mkdtempSync(join(tmpdir(), 'ai-zhili-private-models-'));
  const path = join(directory, 'history.sqlite');
  let legacy: DatabaseSync | undefined;
  let store: Store | undefined;
  try {
    legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE model_configs (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, base_url TEXT NOT NULL, api_key TEXT NOT NULL,
        model TEXT NOT NULL, protocol TEXT NOT NULL, stream INTEGER NOT NULL, is_default INTEGER NOT NULL,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE runs (
        id TEXT PRIMARY KEY, request_id TEXT NOT NULL UNIQUE, config_id TEXT NOT NULL,
        prompt TEXT NOT NULL, constraint_text TEXT NOT NULL, snapshot_json TEXT NOT NULL,
        status TEXT NOT NULL, raw_output TEXT NOT NULL DEFAULT '', html TEXT,
        created_at TEXT NOT NULL, completed_at TEXT, elapsed_ms INTEGER NOT NULL DEFAULT 0,
        usage_json TEXT, error TEXT, source_run_id TEXT,
        FOREIGN KEY(config_id) REFERENCES model_configs(id)
      );
    `);
    legacy.prepare('INSERT INTO model_configs VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy-config', '旧私有名称', config.baseUrl, 'LEGACY_ENCRYPTED_KEY', config.model, config.protocol, 1, 1, '2026-09-24', '2026-09-24');
    const html = '<!DOCTYPE html><html><body>历史画面</body></html>';
    const oldSnapshot = JSON.stringify({ configId: 'legacy-config', name: '旧私有名称', baseUrl: config.baseUrl, ...publicModelSnapshot(parseGenerationModel(config)) });
    legacy.prepare('INSERT INTO runs(id,request_id,config_id,prompt,constraint_text,snapshot_json,status,raw_output,html,created_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('legacy-run', 'legacy-request', 'legacy-config', '旧提示词', '旧约束', oldSnapshot, 'succeeded', html, html, '2026-09-24');
    const original = legacy.prepare('SELECT * FROM runs').all();
    legacy.close(); legacy = undefined;

    store = new Store(path);
    const migrated = store.db.prepare('SELECT * FROM runs').all() as Array<Record<string, unknown>>;
    assert.equal(migrated[0].run_number, 1);
    assert.deepEqual(migrated.map(({ run_number: _number, ...row }) => row), original.map(row => ({ ...row })));
    assert.equal(store.getRun('legacy-run')?.html, html);
    assert.equal('baseUrl' in store.getRun('legacy-run')!.snapshot, false);
    assert.equal('name' in store.getRun('legacy-run')!.snapshot, false);
    const input = { requestId: 'browser-request', prompt: '新提示词', constraintText: '新约束', snapshot: publicModelSnapshot(parseGenerationModel(config)) };
    const run = store.createRun(input);
    assert.equal(run.number, 'A0002');
    const next = store.createRun({ ...input, requestId: 'another-request' });
    assert.equal(next.number, 'A0003');
    assert.equal(store.createRun(input).id, run.id);
    assert.equal(store.ownsRun(run.id, input.requestId), true);
    assert.equal(store.ownsRun(run.id, 'another-browser'), false);
    const row = store.db.prepare('SELECT config_id, snapshot_json FROM runs WHERE id = ?').get(run.id)!;
    assert.equal(row.config_id, null);
    assert.deepEqual(JSON.parse(String(row.snapshot_json)), input.snapshot);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM model_configs').get()!.count, 1);
    store.close(); store = new Store(path);
    assert.equal(store.getRun('legacy-run')?.html, html);
    assert.equal(store.getRun(run.id)?.status, 'interrupted');
    assert.equal(store.deleteRun(run.id), true);
    assert.equal(store.getRun(run.id), null);
    store.close(); store = undefined;
    rmSync(path);
    store = new Store(path);
    for (let index = 0; index < 32; index += 1) {
      const created = store.createRun({ ...input, requestId: `keep-${index}` });
      store.finishRun(created.id, { status: 'succeeded', rawOutput: `<html>${index}</html>`, html: `<html>${index}</html>`, elapsedMs: 1, usage: null, error: null });
    }
    store.close(); store = new Store(path);
    const kept = store.listRuns(100);
    const numbers = kept.items.map(item => item.number);
    assert.equal(kept.total, 30);
    assert.equal(kept.items.length, 30);
    assert.equal(numbers[0] > numbers.at(-1)!, true);
    assert.equal(numbers.includes('A0001'), false);
    assert.equal(store.getRun(kept.items[0].id)?.html?.includes('html'), true);
    assert.equal(store.db.prepare('SELECT COUNT(*) AS count FROM runs').get()!.count, 30);
    const extra = store.createRun({ ...input, requestId: 'after-limit' });
    store.finishRun(extra.id, { status: 'failed', rawOutput: '', html: null, elapsedMs: 1, usage: null, error: '失败' });
    store.pruneRuns();
    assert.equal(store.listRuns().total, 30);
    assert.equal(store.getRun(extra.id)?.number, store.listRuns().items[0].number);
  } finally {
    legacy?.close(); store?.close();
    rmSync(directory, { recursive: true });
  }
});
