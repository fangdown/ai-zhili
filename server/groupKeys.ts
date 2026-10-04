import { FIXED_GROUP_MODELS, isCustomModelGroup, type FixedGroupModel, type FixedModelGroup, type ModelGroup, type Protocol } from '../shared/types.js';
import { AppError } from './errors.js';

export const FIXED_GROUP_BASE_URL = 'https://api.opens.chat/v1';

const GROUP_KEY_ENV: Record<FixedModelGroup, string> = {
  'GRT-PRO稳定': 'MODEL_KEY_GRT_PRO',
  'GPT-企业级': 'MODEL_KEY_GPT_ENTERPRISE',
  'GPT-官key': 'MODEL_KEY_GPT_OFFICIAL',
  'GPT-福利': 'MODEL_KEY_GPT_WELFARE',
  'claude-opus-5-5': 'MODEL_KEY_CLAUDE_OPUS_5_5',
};

export interface FixedGroupStatus {
  group: FixedModelGroup;
  configured: boolean;
  models: readonly FixedGroupModel[];
}

export function fixedGroupKey(group: ModelGroup) {
  if (isCustomModelGroup(group)) return '';
  const name = GROUP_KEY_ENV[group];
  const value = process.env[name]?.trim() ?? '';
  if (!value || value.length > 10_000 || /[\r\n]/.test(value)) return '';
  return value;
}

export function fixedGroupCatalog(): FixedGroupStatus[] {
  return (Object.keys(FIXED_GROUP_MODELS) as FixedModelGroup[]).map(group => ({
    group,
    configured: Boolean(fixedGroupKey(group)),
    models: FIXED_GROUP_MODELS[group],
  }));
}

export function resolveFixedGroupModel(group: ModelGroup, model: string, protocol: Protocol) {
  if (isCustomModelGroup(group)) throw new AppError(400, '自定义分组需要提交浏览器中的模型配置。');
  const match = FIXED_GROUP_MODELS[group].find(item => item.model === model && item.protocol === protocol);
  if (!match) throw new AppError(400, '该固定分组不提供此模型。');
  const apiKey = fixedGroupKey(group);
  if (!apiKey) throw new AppError(503, `服务器尚未配置「${group}」的 API Key。`);
  return { group, baseUrl: FIXED_GROUP_BASE_URL, apiKey, model: match.model, protocol: match.protocol, stream: true as const };
}
