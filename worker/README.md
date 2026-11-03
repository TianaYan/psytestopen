# 线上版模型代理（Cloudflare Worker）

## 它解决什么

GitHub Pages 是**公开托管**的：任何人都能下载 `public/` 下的每个文件。
所以密钥不能写进前端——写进去就等于公开，而且会**永久留在 git 历史里**，事后删文件也还在。

这个 Worker 是中间的一层：

```
访客浏览器 ──提示词──▶ Worker ──加密钥──▶ 模型 API
             ◀─原始输出─┘
```

- **密钥在 Worker 的 secret 里**，不在代码、不在 GitHub、不在页面里。
- Worker 是**薄转发**：提示词由浏览器拼好（和本机版共用 `public/lib/prompts.js`），
  引文校验、类型派生、小传降级仍由前端跑同一份代码，所以线上线下的判型口径一致。
- 按 IP 记每日额度，防止额度被人刷爆。

## 部署

需要：一个 Cloudflare 账号（**免费版即可**）。

```bash
# 0) 装 wrangler 并登录（也可以全程用 npx wrangler@latest）
npm install -g wrangler
wrangler login

cd worker

# 1) 建限流用的 KV 命名空间（免费版：每天 10 万次读、1000 次写，够用）
wrangler kv namespace create PSYTEST_QUOTA
#    把命令输出的 id 填进 wrangler.toml 里的 [[kv_namespaces]]

# 2) 设置密钥 —— 这一步不会写进任何文件
wrangler secret put MODEL_API_KEY
#    粘贴你那把 MiniMax Key（回车结束，不显示）

# 3) 改 wrangler.toml：
#    ALLOWED_ORIGINS = "https://tianayan.github.io"   ← 你的 Pages 域名
#    MODEL / UPSTREAM_BASE / DAILY_LIMIT 按需调整

# 4) 部署
wrangler deploy
#    输出：https://psytest-proxy.<你的子域>.workers.dev

# 5) 把这个地址填进仓库的 public/config.js：
#    window.PSYTEST_CONFIG = { proxyBase: 'https://psytest-proxy.<你的子域>.workers.dev' };
#    然后 push，Pages 会自动重新部署
```

部署完，访客打开页面就**不用再填 API Key**了。

## 接口

| 接口 | 用途 |
|---|---|
| `POST /api/model` | 请求体 `{system, user, temperature, maxTokens}`；返回 `{content, model, remaining}`，`content` 是模型的原始输出 |
| `GET /api/health` | 返回 `{ok, model, upstream, dailyLimit, quotaEnabled}`，不含密钥 |

## 几个要注意的点

- **`ALLOWED_ORIGINS` 必须填**：没填时所有跨源请求都会被拒（这是有意的默认值，不是 bug）。
- **限流是按 IP 的**：免费版没有 Rate Limiting 绑定（那是付费功能），所以这里用 KV 自己记。
  一次完整测评约 5 次模型调用（4 次判型 + 1 次合成），`DAILY_LIMIT = 60` 大约够 12 次测评/人/天。
  KV 的写额度是每天 1000 次，所以别把 `DAILY_LIMIT` 调太大。
- **不配 KV 就不限流**：方便先跑通，之后再补上 KV。
- **换模型/换厂商**：改 `wrangler.toml` 里的 `MODEL` 与 `UPSTREAM_BASE` 即可，前端不用动。

## 本地测试

Worker 的逻辑（白名单、限流、转发、报错）都有离线测试，不需要部署：

```bash
node --test test/worker.test.mjs
```
