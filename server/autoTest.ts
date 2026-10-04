import type { Store } from './db.js';

export const AUTO_TEST_INTERVAL_MS = 10 * 60 * 1000;

const ENABLED_KEY = 'auto_test_enabled';
const NEXT_KEY = 'auto_test_next_run_at';
const PROMPT_KEY = 'auto_test_prompt';
const LAST_KEY = 'auto_test_last_message';
const CLAIM_KEY = 'auto_test_claim';

export interface AutoTestState {
  enabled: boolean;
  nextRunAt: number | null;
  lastMessage: string;
  quiet: boolean;
  serverNow: number;
  prompt: string;
}

/** Quiet hours follow Beijing time, independent of the browser timezone. */
export function isAutoTestQuietTime(timestamp: number) {
  const hour = new Date(timestamp + 8 * 60 * 60 * 1000).getUTCHours();
  return hour >= 23 || hour < 8;
}

export function createAutoTestScheduler(options: {
  store: Pick<Store, 'getMeta' | 'setMeta' | 'db'>;
  now?: () => number;
  intervalMs?: number;
  defaultPrompt: string;
  startRun: (prompt: string, claim: string) => Promise<void> | void;
}) {
  const now = options.now ?? Date.now;
  const intervalMs = options.intervalMs ?? AUTO_TEST_INTERVAL_MS;
  let ticking = false;

  function enabled() { return options.store.getMeta(ENABLED_KEY) !== 'false'; }
  function prompt() {
    const saved = options.store.getMeta(PROMPT_KEY)?.trim();
    return saved || options.defaultPrompt;
  }
  function nextRunAt() {
    const next = Number(options.store.getMeta(NEXT_KEY) || 0);
    return Number.isFinite(next) && next > 0 ? next : null;
  }
  function state(): AutoTestState {
    const current = now();
    return {
      enabled: enabled(),
      nextRunAt: nextRunAt(),
      lastMessage: options.store.getMeta(LAST_KEY) ?? '',
      quiet: isAutoTestQuietTime(current),
      serverNow: current,
      prompt: prompt(),
    };
  }
  function setEnabled(value: boolean) {
    options.store.setMeta(ENABLED_KEY, String(value));
    options.store.setMeta(LAST_KEY, '');
    if (value) options.store.setMeta(NEXT_KEY, String(now() + intervalMs));
  }
  function setPrompt(value: string) { options.store.setMeta(PROMPT_KEY, value); }
  function consumeClaim(claim: string) {
    if (!claim || options.store.getMeta(CLAIM_KEY) !== claim) return false;
    options.store.setMeta(CLAIM_KEY, '');
    return true;
  }

  async function tick() {
    if (ticking) return;
    const current = now();
    if (!enabled() || isAutoTestQuietTime(current)) return;
    const next = nextRunAt();
    if (next && current < next) return;
    ticking = true;
    try {
      const active = options.store.db.prepare("SELECT 1 FROM runs WHERE status = 'running' LIMIT 1").get();
      if (active) {
        options.store.setMeta(NEXT_KEY, String(current + intervalMs));
        options.store.setMeta(LAST_KEY, '本次跳过：当前任务尚未结束。');
        return;
      }
      options.store.setMeta(NEXT_KEY, String(current + intervalMs));
      if (!next) return;
      const text = prompt();
      if (!text.trim()) {
        options.store.setMeta(LAST_KEY, '本次跳过：没有提示词。');
        return;
      }
      const claim = crypto.randomUUID();
      options.store.setMeta(CLAIM_KEY, claim);
      await options.startRun(text, claim);
      options.store.setMeta(LAST_KEY, '上次自动测试已提交。');
    } catch (error) {
      const message = error instanceof Error ? error.message : '自动测试未能开始。';
      options.store.setMeta(LAST_KEY, `上次自动测试未提交：${message}`);
    } finally {
      ticking = false;
    }
  }

  return { state, setEnabled, setPrompt, prompt, tick, consumeClaim };
}
