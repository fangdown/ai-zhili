# AI Zhili · HTML 生成工作台

单项目、同域部署的 HTML 生成工作台：配置模型后输入提示词，生成结果会实时流入历史记录，并在隔离 iframe 中预览。

## 本机启动

```powershell
npm install
npm run setup
npm run dev:server
```

另开一个终端启动 Vite：

```powershell
npm run dev:client
```

打开 `http://127.0.0.1:5173`。首次使用在「设置」中添加模型配置。

## 生产部署

先生成 `.env`，再构建并启动：

```powershell
npm install
npm run setup
docker compose up -d --build
```

将反向代理指向 `127.0.0.1:3200`，对外使用 HTTPS。SQLite 历史记录保存在 `data/workbench.sqlite`。

默认只允许 HTTPS 模型地址。需要接入本机模型时，在 `.env` 设置 `ALLOW_LOCAL_MODEL=true`，并使用本机地址。

### us-38 部署

- 访问地址：`https://zhili.opens.chat`。
- 项目目录：`/opt/ai-zhili`；历史数据库：`/opt/ai-zhili/data/workbench.sqlite`。
- Docker 仅绑定 `127.0.0.1:3200`，由宿主机 Nginx 提供 HTTPS 和 SSE 转发。
- Nginx 模板：`deploy/nginx/zhili.opens.chat.conf`，安装到 `/etc/nginx/sites-available/zhili.opens.chat`。
- TLS 证书：`/etc/letsencrypt/live/zhili.opens.chat/`，由 Certbot 定时续期，续期后自动重载 Nginx。
- 固定分组的 API Key 写在服务器 `.env`，不随浏览器保存。自定义分组仍由每个浏览器保存。

在服务器更新：

```sh
cd /opt/ai-zhili
git pull --ff-only
docker compose up -d --build
```

`data` 通过目录挂载持久化；更新时保留该目录和服务器 `.env`。

### 管理员删除

管理员使用服务器密码登录后可以删除已结束的历史记录，生成中的记录不能删除。先生成密码哈希：

```sh
read -s ADMIN_PASSWORD
export ADMIN_PASSWORD
npm run admin:hash
unset ADMIN_PASSWORD
```

将输出的 `ADMIN_PASSWORD_HASH=...` 写入服务器 `.env`，并确保 `APP_KEY` 是 64 位十六进制随机值。重建容器后，页面历史记录区域会显示“管理员登录”。

## 接口

固定分组（GRT-PRO稳定、GPT-企业级、GPT-官key、GPT-福利、claude-opus-5-5）的 API Key 只放在服务器 `.env`：`MODEL_KEY_GRT_PRO`、`MODEL_KEY_GPT_ENTERPRISE`、`MODEL_KEY_GPT_OFFICIAL`、`MODEL_KEY_GPT_WELFARE`、`MODEL_KEY_CLAUDE_OPUS_5_5`。浏览器只提交分组和模型名称，后端临时注入对应 Key，不把 Key 或接口地址写入历史快照，也不返回给浏览器。

自定义分组仍由每个浏览器保存地址、Key 和模型名称，不与其他浏览器共享。换浏览器、换网站地址或清除网站数据后需要重新填写。点击生成时，只把当前选中的自定义配置提交给后端，在任务内存中临时使用。不要在配置名称、模型名称或提示词中粘贴 Key。

后端提供生成任务、SSE 增量事件、共享历史、取消和 HTML 下载接口。历史暂不允许删除；仅发起任务的浏览器持有停止该任务所需的请求凭证。旧 `/api/model-configs` 接口全部关闭，返回 410，旧的 `configId` 调用方式不再支持。

升级时保留已有历史记录。旧 `.env` 和 `APP_KEY` 保留，并补上固定分组的 Key。浏览器里以前保存的固定分组配置不再使用。
