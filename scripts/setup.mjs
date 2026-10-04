import { randomBytes } from 'node:crypto';
import { writeFileSync } from 'node:fs';

try {
  writeFileSync(new URL('../.env', import.meta.url), [
    'HOST=127.0.0.1',
    'PORT=3200',
    'DATA_DIR=./data',
    `APP_KEY=${randomBytes(32).toString('hex')}`,
    '',
  ].join('\n'), { flag: 'wx', mode: 0o600 });
  console.log('已生成 .env。固定分组的 Key 写入服务器 .env；自定义分组仍只保存在各自浏览器。');
} catch (error) {
  if (error.code === 'EEXIST') console.log('.env 已存在，保留现有配置。');
  else throw error;
}
