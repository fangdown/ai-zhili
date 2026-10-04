<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref } from 'vue';
import HtmlPreview from './HtmlPreview.vue';
import { CUSTOM_MODEL_GROUP, MODEL_GROUPS, fixedGroupModels, isCustomModelGroup, isFixedModelGroup, type BrowserModelConfig, type BrowserRun, type FixedGroupModel, type FixedModelGroup, type ModelConfig, type ModelGroup, type ModelInput, type Protocol, type RunDetail, type RunPage, type RunStatus, type RunSummary } from '../shared/types';
import { deleteLocalModel, MODEL_STORAGE_KEY, readLocalModels, saveLocalModel } from './localModels';

const configs = ref<BrowserModelConfig[]>([]);
const runs = ref<RunSummary[]>([]);
const details = ref<Record<string, RunDetail>>({});
const selectedConfigId = ref('');
const prompt = ref('创建一个HTML代码，内容是SVG绘制一个小火龙在导弹上骑自行车的2D动画，不能测试，不能使用sikll技能，不能搜索本地文件');
const activeRunId = ref<string | null>(null);
const selectedCardId = ref<string | null>(null);
const loading = ref(false);
const notice = ref<{ type: 'success' | 'error' | 'info'; text: string } | null>(null);
const showSettings = ref(false);
const editingId = ref<string | null>(null);
const savingConfig = ref(false);
const showAdminLogin = ref(false);
const adminPassword = ref('');
const adminConfigured = ref(false);
const isAdmin = ref(false);
const adminLoading = ref(false);
const ownRun = ref<BrowserRun | null>(null);
const ACTIVE_RUN_STORAGE_KEY = 'ai-zhili.active-run.v1';
const LEGACY_ACTIVE_RUN_STORAGE_KEY = 'html-workbench.active-run.v1';
const AUTO_TEST_STORAGE_KEY = 'ai-zhili.auto-test.v1';
const AUTO_TEST_NEXT_RUN_STORAGE_KEY = 'ai-zhili.auto-test.next-run.v1';
const AUTO_TEST_INTERVAL_MS = 10 * 60 * 1000;
const autoTestEnabled = ref(true);
const autoTestNow = ref(Date.now.call(Date));
const autoTestNextRunAt = ref(0);
const autoTestLastMessage = ref('');
let autoTestChecking = false;
let autoTestTimer: number | undefined;
let eventSource: EventSource | null = null;
let noticeTimer: number | undefined;

const configForm = ref<ModelInput>({ group: CUSTOM_MODEL_GROUP, baseUrl: 'https://api.opens.chat/v1', model: '', protocol: 'responses', stream: true, isDefault: true, apiKey: '' });
interface FixedGroupState { group: FixedModelGroup; configured: boolean; models: FixedGroupModel[]; }
interface PickerOption { id: string; group: ModelGroup; model: string; protocol: Protocol; configured: boolean; custom?: BrowserModelConfig; }
const fixedGroups = ref<FixedGroupState[]>(MODEL_GROUPS.filter(isFixedModelGroup).map(group => ({ group, configured: false, models: [...fixedGroupModels(group)] })));
const customConfigs = computed(() => configs.value.filter(item => isCustomModelGroup(item.group)));
const pickerGroups = computed(() => {
  const fixed: Array<{ group: ModelGroup; options: PickerOption[] }> = isAdmin.value ? fixedGroups.value.map(item => ({
    group: item.group,
    options: item.models.map(model => ({ id: `fixed:${item.group}:${model.model}`, group: item.group, model: model.model, protocol: model.protocol, configured: item.configured })),
  })) : [];
  const custom: { group: ModelGroup; options: PickerOption[] } = {
    group: CUSTOM_MODEL_GROUP,
    options: customConfigs.value.map(config => ({ id: config.id, group: config.group, model: config.model, protocol: config.protocol, configured: Boolean(config.apiKey), custom: config })),
  };
  return [...fixed, custom];
});
const selectedOption = computed(() => pickerGroups.value.flatMap(item => item.options).find(item => item.id === selectedConfigId.value));
const autoTestOption = computed(() => isAdmin.value ? pickerGroups.value.flatMap(item => item.options).find(item => item.group === 'GRT-PRO稳定' && item.model === 'gpt-6-astra' && item.configured) : undefined);
const activeRun = computed(() => activeRunId.value ? details.value[activeRunId.value] : undefined);
const isRunning = computed(() => activeRun.value?.status === 'running');
const autoTestStatus = computed(() => {
  if (!isAdmin.value) return '管理员登录后才会自动测试 GRT-PRO稳定。';
  if (!autoTestEnabled.value) return '自动测试已暂停。';
  if (!autoTestOption.value) return '服务器尚未配置 GRT-PRO稳定分组的 API Key。';
  if (!prompt.value.trim()) return '请先填写提示词。';
  if (isAutoTestQuietTime(autoTestNow.value)) return '已暂停，08:00 后恢复自动测试。';
  const seconds = Math.max(0, Math.ceil((autoTestNextRunAt.value - autoTestNow.value) / 1000));
  const time = new Date(autoTestNextRunAt.value).toLocaleTimeString('zh-CN', { hour12: false });
  const waiting = loading.value || ownRun.value || isRunning.value ? '等待当前任务结束；到时会核对服务器状态。' : '';
  return waiting + autoTestLastMessage.value + '下次检查：' + time + '（剩余 ' + Math.floor(seconds / 60) + ' 分 ' + seconds % 60 + ' 秒）。';
});

function showNotice(text: string, type: 'success' | 'error' | 'info' = 'info') { notice.value = { text, type }; window.clearTimeout(noticeTimer); noticeTimer = window.setTimeout(() => notice.value = null, 3600); }
function formatTime(value: string) { return new Intl.DateTimeFormat('zh-CN', { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(value)); }
function statusLabel(status: RunStatus) { return ({ running: '生成中', succeeded: '已完成', failed: '失败', cancelled: '已取消', interrupted: '已中断' })[status]; }
function statusClass(status: RunStatus) { return `status-${status}`; }
function promptPreview(value: string) { return value.replace(/\s+/g, ' ').trim().slice(0, 66) || '未命名生成'; }
function api<T>(url: string, options?: RequestInit): Promise<T> {
  const headers = new Headers(options?.headers);
  if (typeof options?.body === 'string' && !headers.has('content-type')) headers.set('content-type', 'application/json');
  return fetch(url, { ...options, headers }).then(async response => { const data = await response.json().catch(() => ({})); if (!response.ok) throw new Error(data.error || `请求失败（${response.status}）`); return data as T; });
}
async function hydrateDetails(items: RunSummary[]) { const results = await Promise.allSettled(items.map(item => api<RunDetail>(`/api/runs/${item.id}`))); results.forEach((result, index) => { if (result.status === 'fulfilled') details.value[items[index].id] = result.value; }); }
async function loadRuns() {
  const page = await api<RunPage>('/api/runs?limit=30');
  runs.value = page.items;
  await hydrateDetails(page.items);
  if (ownRun.value) await openRun(ownRun.value.id);
}
async function loadRunsOnly() { const page = await api<RunPage>('/api/runs?limit=24'); runs.value = page.items; await hydrateDetails(page.items); }
function loadConfigs() {
  const saved = readLocalModels();
  const custom = saved.filter(item => isCustomModelGroup(item.group));
  if (custom.length !== saved.length) {
    try { localStorage.setItem(MODEL_STORAGE_KEY, JSON.stringify(custom)); } catch { /* Keep the filtered list in memory. */ }
  }
  configs.value = custom;
  ensureSelection();
}
function ensureSelection() {
  const options = pickerGroups.value.flatMap(item => item.options);
  if (options.some(item => item.id === selectedConfigId.value)) return;
  if (!isAdmin.value) {
    const custom = customConfigs.value.find(item => item.isDefault && item.apiKey) ?? customConfigs.value.find(item => item.apiKey) ?? customConfigs.value[0];
    selectedConfigId.value = custom?.id ?? '';
    return;
  }
  const preferredCustom = customConfigs.value.find(item => item.isDefault);
  const preferred = options.find(item => item.id === preferredCustom?.id && item.configured) ?? options.find(item => item.configured) ?? options[0];
  selectedConfigId.value = preferred?.id ?? '';
}
async function loadFixedGroups() {
  try {
    const data = await api<{ groups: FixedGroupState[] }>('/api/model-groups');
    if (Array.isArray(data.groups) && data.groups.length) fixedGroups.value = data.groups;
  } catch (error: any) { showNotice(error.message, 'error'); }
  ensureSelection();
}
function rememberRun(run: BrowserRun | null) {
  ownRun.value = run;
  try {
    if (run) localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(run));
    else {
      localStorage.removeItem(ACTIVE_RUN_STORAGE_KEY);
      localStorage.removeItem(LEGACY_ACTIVE_RUN_STORAGE_KEY);
    }
  } catch { showNotice('浏览器未能保存任务状态，刷新后请在历史记录中查看结果。', 'info'); }
}
function restoreOwnRun() {
  try {
    const current = localStorage.getItem(ACTIVE_RUN_STORAGE_KEY);
    const raw = current ?? localStorage.getItem(LEGACY_ACTIVE_RUN_STORAGE_KEY);
    const saved = JSON.parse(raw ?? 'null');
    if (saved && typeof saved.id === 'string' && typeof saved.requestId === 'string') {
      ownRun.value = saved;
      if (current === null) {
        try { localStorage.setItem(ACTIVE_RUN_STORAGE_KEY, JSON.stringify(saved)); } catch { /* Keep using the legacy value. */ }
      }
    }
  } catch { ownRun.value = null; }
}
async function openRun(id: string) {
  try {
    const detail = await api<RunDetail>(`/api/runs/${id}`);
    details.value[id] = detail;
    selectedCardId.value = id;
    if (ownRun.value?.id === id) {
      if (detail.status === 'running') { activeRunId.value = id; subscribe(id); }
      else { activeRunId.value = null; rememberRun(null); }
    }
  } catch (error: any) { showNotice(error.message, 'error'); }
}
function subscribe(id: string) {
  eventSource?.close();
  const source = new EventSource(`/api/runs/${id}/events`);
  eventSource = source;
  source.addEventListener('snapshot', event => {
    const data = JSON.parse((event as MessageEvent).data);
    const detail = details.value[id];
    if (detail) { detail.rawOutput = data.rawOutput; detail.status = data.status; detail.elapsedMs = data.elapsedMs ?? detail.elapsedMs; }
  });
  source.addEventListener('delta', event => {
    const data = JSON.parse((event as MessageEvent).data);
    const detail = details.value[id];
    if (detail) { detail.rawOutput += data.text; detail.elapsedMs = data.elapsedMs; }
  });
  let completed = false;
  const complete = async () => {
    if (completed) return;
    completed = true;
    source.close();
    if (eventSource === source) eventSource = null;
    if (ownRun.value?.id === id) { activeRunId.value = null; rememberRun(null); }
    try { await openRun(id); await loadRunsOnly(); }
    catch (error: any) { showNotice(error.message, 'error'); }
  };
  source.addEventListener('done', complete);
  source.addEventListener('close', complete);
  source.onerror = () => { if (activeRunId.value === id) showNotice('生成连接暂时断开，刷新后可继续查看。', 'info'); };
}
async function startGeneration() {
  await generate(selectedOption.value);
}
function isAutoTestQuietTime(timestamp: number) {
  const hour = new Date(timestamp).getHours();
  return hour >= 23 || hour < 8;
}
function saveNextAutoTestAt(timestamp: number) {
  autoTestNextRunAt.value = timestamp;
  try { localStorage.setItem(AUTO_TEST_NEXT_RUN_STORAGE_KEY, String(timestamp)); }
  catch { showNotice('浏览器无法保存倒计时，刷新页面后将重新计时。', 'info'); }
}
async function checkAutoTest() {
  autoTestNow.value = Date.now.call(Date);
  if (!isAdmin.value || !autoTestEnabled.value || autoTestChecking || isAutoTestQuietTime(autoTestNow.value)) return;
  if (autoTestNow.value < autoTestNextRunAt.value || !autoTestOption.value || !prompt.value.trim() || loading.value) return;
  autoTestChecking = true;
  saveNextAutoTestAt(autoTestNow.value + AUTO_TEST_INTERVAL_MS);
  try {
    if (ownRun.value) await openRun(ownRun.value.id);
    if (!isAdmin.value || !autoTestEnabled.value || isAutoTestQuietTime(Date.now.call(Date))) return;
    if (ownRun.value || isRunning.value || loading.value) {
      autoTestLastMessage.value = '本次跳过：当前任务尚未结束或状态未能确认。';
      return;
    }
    const started = await generate(autoTestOption.value);
    autoTestLastMessage.value = started ? '上次自动测试已提交，结果见历史记录。' : '上次自动测试未提交：' + (notice.value?.text ?? '请检查模型配置。');
  } finally { autoTestChecking = false; }
}
function scheduleAutoTest() {
  window.clearInterval(autoTestTimer);
  if (!autoTestEnabled.value) return;
  autoTestNow.value = Date.now.call(Date);
  let saved = 0;
  try { saved = Number(localStorage.getItem(AUTO_TEST_NEXT_RUN_STORAGE_KEY)); } catch { /* Use an in-memory deadline when storage is unavailable. */ }
  saveNextAutoTestAt(Number.isFinite(saved) && saved > 0 && saved <= autoTestNow.value + AUTO_TEST_INTERVAL_MS ? saved : autoTestNow.value + AUTO_TEST_INTERVAL_MS);
  autoTestTimer = window.setInterval(() => { void checkAutoTest(); }, 1000);
  void checkAutoTest();
}
function setAutoTestEnabled(enabled: boolean) {
  autoTestEnabled.value = enabled;
  autoTestLastMessage.value = '';
  try {
    localStorage.setItem(AUTO_TEST_STORAGE_KEY, String(enabled));
    localStorage.removeItem(AUTO_TEST_NEXT_RUN_STORAGE_KEY);
  }
  catch { showNotice('浏览器未能保存自动测试开关，刷新后会恢复默认。', 'info'); }
  scheduleAutoTest();
}
async function generate(option: PickerOption | undefined) {
  if (!option) return showNotice('请先选择模型。', 'error');
  if (!option.configured) return showNotice(option.custom ? '请先为自定义模型填写 API Key。' : `服务器尚未配置「${option.group}」的 API Key。`, 'error');
  if (!prompt.value.trim()) return showNotice('请先输入提示词。', 'error');
  if (loading.value || isRunning.value) return;
  loading.value = true;
  let started = false;
  try {
    const requestId = crypto.randomUUID();
    const modelConfig = option.custom
      ? { group: option.custom.group, baseUrl: option.custom.baseUrl, apiKey: option.custom.apiKey, model: option.custom.model, protocol: option.custom.protocol, stream: option.custom.stream }
      : { group: option.group, model: option.model, protocol: option.protocol };
    const result = await api<{ id: string; number: string }>('/api/runs', { method: 'POST', body: JSON.stringify({ requestId, modelConfig, prompt: prompt.value }) });
    started = true;
    rememberRun({ id: result.id, requestId });
    await openRun(result.id);
    await loadRunsOnly();
    showNotice(`已开始生成，编号 #${result.number}。`, 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
  finally { loading.value = false; }
  return started;
}
async function stopGeneration() {
  if (!activeRunId.value || ownRun.value?.id !== activeRunId.value) return;
  try {
    await api(`/api/runs/${activeRunId.value}/cancel`, { method: 'POST', body: JSON.stringify({ requestId: ownRun.value.requestId }) });
    showNotice('已发送停止请求。', 'info');
  } catch (error: any) { showNotice(error.message, 'error'); }
}
async function loadAdminSession() {
  const session = await api<{ configured: boolean; authenticated: boolean }>('/api/admin/session');
  adminConfigured.value = session.configured;
  isAdmin.value = session.authenticated;
}
function openAdminLogin() { adminPassword.value = ''; showAdminLogin.value = true; }
function closeAdminLogin() { adminPassword.value = ''; showAdminLogin.value = false; }
async function loginAdmin() {
  if (!adminPassword.value || adminLoading.value) return;
  adminLoading.value = true;
  try {
    await api('/api/admin/login', { method: 'POST', body: JSON.stringify({ password: adminPassword.value }) });
    adminPassword.value = '';
    isAdmin.value = true;
    closeAdminLogin();
    await loadFixedGroups();
    showNotice('管理员登录成功。', 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
  finally { adminLoading.value = false; }
}
async function logoutAdmin() {
  try {
    await api('/api/admin/logout', { method: 'POST' });
    isAdmin.value = false;
    fixedGroups.value = [];
    ensureSelection();
    showNotice('已退出管理员。', 'info');
  } catch (error: any) { showNotice(error.message, 'error'); }
}
async function deleteRun(id: string) {
  const run = runs.value.find(item => item.id === id);
  if (!run || run.status === 'running') return showNotice('生成中的记录不能删除。', 'error');
  if (!window.confirm('确定删除这条历史记录？删除后无法恢复。')) return;
  try {
    await api(`/api/runs/${id}`, { method: 'DELETE' });
    runs.value = runs.value.filter(item => item.id !== id);
    delete details.value[id];
    if (selectedCardId.value === id) selectedCardId.value = null;
    showNotice('历史记录已删除。', 'success');
  } catch (error: any) {
    if (error.message === '请先登录管理员。') isAdmin.value = false;
    showNotice(error.message, 'error');
  }
}
function editConfig(config?: ModelConfig) {
  const custom = config && isCustomModelGroup(config.group) ? config : undefined;
  editingId.value = custom?.id ?? null;
  configForm.value = custom
    ? { group: CUSTOM_MODEL_GROUP, baseUrl: custom.baseUrl, model: custom.model, protocol: custom.protocol, stream: custom.stream, isDefault: custom.isDefault, apiKey: '' }
    : { group: CUSTOM_MODEL_GROUP, baseUrl: 'https://api.opens.chat/v1', model: '', protocol: 'responses', stream: true, isDefault: customConfigs.value.length === 0, apiKey: '' };
  showSettings.value = true;
}
function selectModel(value: string) {
  if (value.startsWith('new:')) {
    editConfig();
    return;
  }
  selectedConfigId.value = value;
}
function saveConfig() {
  savingConfig.value = true;
  try {
    configForm.value.group = CUSTOM_MODEL_GROUP;
    const saved = saveLocalModel(configForm.value, editingId.value);
    loadConfigs();
    selectedConfigId.value = saved.id;
    configForm.value.apiKey = '';
    showSettings.value = false;
    showNotice('自定义模型已保存到当前浏览器。', 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
  finally { savingConfig.value = false; }
}
function removeConfig(config: ModelConfig) {
  if (!window.confirm(`删除本机的「${config.name}」？`)) return;
  try {
    deleteLocalModel(config.id);
    loadConfigs();
    if (editingId.value === config.id) editConfig();
    showNotice('本地配置已删除。', 'success');
  } catch (error: any) { showNotice(error.message, 'error'); }
}
function syncLocalModels(event: StorageEvent) {
  if (event.key === AUTO_TEST_NEXT_RUN_STORAGE_KEY && event.newValue) {
    const timestamp = Number(event.newValue);
    if (Number.isFinite(timestamp) && timestamp > 0) autoTestNextRunAt.value = timestamp;
  }
  if (event.key === MODEL_STORAGE_KEY || event.key === null) {
    try { loadConfigs(); } catch (error: any) { showNotice(error.message, 'error'); }
  }
  if (event.key === AUTO_TEST_STORAGE_KEY || event.key === null) {
    autoTestEnabled.value = event.newValue !== 'false';
    scheduleAutoTest();
  }
}
onMounted(async () => {
  window.addEventListener('storage', syncLocalModels);
  try { autoTestEnabled.value = localStorage.getItem(AUTO_TEST_STORAGE_KEY) !== 'false'; }
  catch { autoTestEnabled.value = false; showNotice('无法读取自动测试设置，已暂停自动测试。', 'error'); }
  try { loadConfigs(); } catch (error: any) { showNotice(error.message, 'error'); }
  try { await loadFixedGroups(); } catch (error: any) { showNotice(error.message, 'error'); }
  restoreOwnRun();
  try { await loadAdminSession(); } catch (error: any) { showNotice(error.message, 'error'); }
  try { await loadRuns(); } catch (error: any) { showNotice(error.message, 'error'); }
  scheduleAutoTest();
});
onUnmounted(() => { eventSource?.close(); window.clearTimeout(noticeTimer); window.clearInterval(autoTestTimer); window.removeEventListener('storage', syncLocalModels); });
</script>

<template>
  <div class="app-shell">
    <main class="content">
      <section class="composer card"><div class="composer-grid"><div class="model-field"><div class="field-label"><label for="model">使用模型</label><button class="small-link" @click="editConfig()">管理模型 ↗</button></div><div class="model-select-row"><select id="model" :value="selectedConfigId" @change="selectModel(($event.target as HTMLSelectElement).value)"><option value="" disabled>{{ pickerGroups.some(item => item.options.length) ? '选择模型' : '请先添加自定义模型' }}</option><optgroup v-for="item in pickerGroups" :key="item.group" :label="item.group"><option v-for="option in item.options" :key="option.id" :value="option.id">{{ option.group }} · {{ option.model }}{{ option.configured ? '' : '（Key 未配置）' }}</option><option v-if="item.group === '自定义' && !item.options.length" value="new:自定义">＋ 添加自定义模型</option></optgroup></select><button v-if="selectedOption?.custom" class="select-settings" aria-label="编辑自定义模型" @click="editConfig(selectedOption.custom)">⚙</button></div></div><div class="prompt-field"><div class="field-label"><label for="prompt">你的提示词</label><span class="prompt-hint">描述页面、风格和交互</span></div><textarea id="prompt" v-model="prompt" rows="3" placeholder="例如：做一个小火龙在导弹上骑自行车的 2D SVG 动画，要有云朵、火焰和可以暂停的按钮。"></textarea></div><div class="composer-action"><button v-if="isRunning" class="stop-button" @click="stopGeneration">■ 停止</button><button v-else class="primary-button" :disabled="loading || !selectedOption" @click="startGeneration"><span>{{ loading ? '准备中…' : '开始生成' }}</span><b>↗</b></button></div></div>
        <div class="auto-test-control">
          <label v-if="isAdmin" class="check-label"><input type="checkbox" :checked="autoTestEnabled" @change="setAutoTestEnabled(($event.target as HTMLInputElement).checked)" />每 10 分钟自动测试 GRT-PRO稳定 · gpt-6-astra</label>
          <p v-if="isAdmin" aria-live="off">{{ autoTestStatus }} 每日 23:00 至次日 08:00 暂停（浏览器本地时间）。刷新不会重置倒计时。请仅保留一个测试页面打开，页面休眠时执行可能延迟。</p>
        </div>
      </section>
      <section class="gallery-section"><div class="gallery-heading"><div><h1>历史记录</h1></div><span class="gallery-count">{{ runs.length }} 个页面</span><button v-if="adminConfigured && !isAdmin" class="admin-button" @click="openAdminLogin">管理员登录</button><div v-else-if="isAdmin" class="admin-session"><span>管理员</span><button @click="logoutAdmin">退出</button></div><button class="refresh-button" @click="loadRunsOnly">刷新 ↻</button></div><div v-if="!runs.length" class="empty-gallery card"><div class="empty-icon">◎</div><h2>还没有生成记录</h2><p>完成第一次生成后，页面预览会出现在这里。</p></div><div v-else class="gallery-grid"><article v-for="run in runs" :key="run.id" class="preview-card" :class="{ selected: selectedCardId === run.id }" @click="openRun(run.id)"><div class="preview-frame"><HtmlPreview v-if="details[run.id]?.html" :html="details[run.id].html!" /><div v-else-if="run.status === 'running'" class="card-loading"><div class="loader"></div><span>正在生成…</span></div><div v-else class="card-failed"><span>◌</span><small>暂无可用预览</small></div><span class="run-number">#{{ run.number }}</span><span class="status-ribbon" :class="statusClass(run.status)"><i></i>{{ statusLabel(run.status) }}</span></div><div class="card-info"><div class="card-title"><b>#{{ run.number }}</b> {{ promptPreview(run.prompt) }}</div><div class="card-meta"><span>{{ run.snapshot.group }} · {{ run.snapshot.model }}</span><button v-if="isAdmin" class="delete-button" :disabled="run.status === 'running'" @click.stop="deleteRun(run.id)">删除</button></div><div class="card-time">{{ formatTime(run.createdAt) }}</div></div></article></div></section>
    </main>
    <div v-if="notice" class="toast" :class="`toast-${notice.type}`">{{ notice.text }}</div>
    <div v-if="showSettings" class="modal-backdrop"><section class="settings-modal card"><div class="modal-heading"><div><span class="eyebrow">仅自定义分组保存在当前浏览器</span><h2>{{ editingId ? '编辑自定义模型' : '添加自定义模型' }}</h2></div><button class="modal-close" @click="showSettings = false">×</button></div><div class="settings-form"><label>模型分组<input :value="CUSTOM_MODEL_GROUP" disabled /></label><label>Base URL<input v-model="configForm.baseUrl" placeholder="https://api.opens.chat/v1" /></label><label>模型名称<input v-model="configForm.model" placeholder="your-model" /></label><label>API Key <small v-if="editingId">留空以保留当前 Key</small><input v-model="configForm.apiKey" type="password" autocomplete="new-password" placeholder="不会回显已保存的 Key" /></label><label>接口协议<select v-model="configForm.protocol"><option value="chat-completions">Chat Completions</option><option value="responses">Responses</option><option value="anthropic-messages">Claude Messages</option></select></label><div class="toggle-row"><label class="check-label"><input v-model="configForm.stream" type="checkbox" /> 流式输出</label><label class="check-label"><input v-model="configForm.isDefault" type="checkbox" /> 设为默认模型</label></div></div><div class="modal-footer"><p class="local-config-note">固定分组的 Key 只保存在服务器。自定义分组的地址和 Key 仅保存在当前浏览器，生成时临时发送至后端，不写入历史记录。</p><div class="config-list"><template v-if="isAdmin"><div v-for="group in fixedGroups" :key="group.group" class="config-line"><span>{{ group.group }} <small>{{ group.models.map(item => item.model).join('、') }}</small></span><span><small>{{ group.configured ? '服务器 Key 已配置' : '服务器 Key 未配置' }}</small></span></div></template><div v-for="config in customConfigs" :key="config.id" class="config-line"><span>{{ config.group }} · {{ config.model }} <small>{{ config.hasKey ? config.keyMask : 'Key 不可用' }}</small></span><span><button @click="editConfig(config)">编辑</button><button @click="removeConfig(config)">删除</button></span></div></div><div class="modal-actions"><button class="outline-button" @click="showSettings = false">取消</button><button class="primary-button" :disabled="savingConfig" @click="saveConfig">{{ savingConfig ? '保存中…' : '保存自定义模型' }} <b>↗</b></button></div></div></section></div>
    <div v-if="showAdminLogin" class="modal-backdrop"><section class="admin-modal card"><div class="modal-heading"><div><span class="eyebrow">ADMIN ACCESS</span><h2>管理员登录</h2></div><button class="modal-close" @click="closeAdminLogin">×</button></div><form class="admin-form" @submit.prevent="loginAdmin"><label for="admin-password">管理员密码</label><input id="admin-password" v-model="adminPassword" type="password" autocomplete="current-password" autofocus placeholder="输入服务器管理员密码" /><p>登录状态仅通过安全 Cookie 保存在当前浏览器。</p><div class="admin-modal-actions"><button type="button" class="outline-button" @click="closeAdminLogin">取消</button><button type="submit" class="primary-button" :disabled="adminLoading || !adminPassword">{{ adminLoading ? '登录中…' : '登录' }}</button></div></form></section></div>
  </div>
</template>
