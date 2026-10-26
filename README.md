# dsh-plugins

自建 DSH(DeepSeek Harness)Web 插件的 monorepo。每个子目录是一个独立的 npm 包,以 `link:` 方式装进 `web` profile。

| 插件 | 包名 | row id | 作用 |
| --- | --- | --- | --- |
| [`dsh-usage/`](dsh-usage/) | `@dss886/dsh-usage` | `dss886-dsh-usage` | 侧边栏底部余额 / 用量卡片 + 浮窗 |
| [`dsh-style/`](dsh-style/) | `@dss886/dsh-style` | `dss886-dsh-style` | 全局样式微调(悬停过渡) |
| [`dsh-session-cleaner/`](dsh-session-cleaner/) | `@dss886/dsh-session-cleaner` | `dss886-dsh-session-cleaner` | 归档会话保留期到期后，下次启动自动永久删除 |

目录名沿用短名(`dsh-usage/`),与包名解耦 —— 官方也是这么做的(`@deepseek-ai/dsh-base` 住在 `packages/bundle/base`)。

---

## 1. 命名规范

### 1.1 三段式 token

所有对外可见的标识都保留三段:**`<scope>` + `dsh` + `<module>`**。

| 段 | 值 | 含义 |
| --- | --- | --- |
| `scope` | `dss886` | npm scope,独占且全局唯一,用来锚定归属 |
| `dsh` | `dsh` | 表明这是 DSH 生态插件,与官方 `@deepseek-ai/` 同族但可区分 |
| `module` | 如 `usage`、`style` | 这个插件具体做什么 |

### 1.2 各层面的取值

新建插件时照抄这张表(`<m>` = module 名):

| 层面 | 取值 | 是否带 scope | 说明 |
| --- | --- | --- | --- |
| package name | `@dss886/dsh-<m>` | ✅ | npm 依赖键、`resolveBundleDir` 的查找键 |
| directory | `dsh-<m>/` | ❌ | 仅本地目录名,不参与任何解析 |
| **row id** | `dss886-dsh-<m>` | ❌ | `cordis.patch.yml` 的 `insert.id`,**全局唯一** |
| host `export const name` | `dss886-dsh-<m>` | ❌ | 与 row id 一致 |
| **route 前缀** | `/dss886-dsh-<m>/…` | ❌ | 与 row id 一致 |
| **client module id** | `@dss886/dsh-<m>` | ✅ | 见 §1.4,**必须等于包名** |
| **CSS / DOM 前缀** | `dss886-dsh-<m>-*` | ❌ | class、`<style>` id、`data-*`、slot id |
| **状态文件** | `dss886-dsh-<m>-<what>.json` | ❌ | 落在 `$DSH_HOME/storages/` |
| 控制台全局 | `__DSS886_DSH_<M>__` | — | 诊断用,如 `__DSS886_DSH_STYLE__` |
| dataset 属性 | `data-dss886-dsh-<m>` | — | 对应 `dataset.dss886Dsh<M>` |

### 1.3 为什么要带 scope

`dsh-*` 在 npm 上是公地,已被大量占用。实测(2026-09):

| 包名 | 状态 |
| --- | --- |
| `dsh-usage` | 已被第三方发布(8 个版本,功能与我们的高度重合) |
| `dsh-style` | 已被第三方占位("name reserved") |
| `dsh-session-control` / `dsh-session-delete` / `dsh-session-manager` | 均已被占用 |

scope 在 npm 上归你独占,不存在被抢或重名。**建插件前先确认**:

```bash
npm view @dss886/dsh-<m> version    # 自己的 scope 一般没人占
npm view dsh-<m> version            # 反例:unscoped 名字随时可能被抢
```

### 1.4 client module id 是唯一例外

它**不能**跟 row id 走,必须等于包名。这是构建与运行时的硬契约:

- [`tsdown.client.ts`](../deepseek-harness/packages/client/tsdown.client.ts) 注释:`@param id - plugin id (package name)`
- [`client/modules`](../deepseek-harness/packages/client/modules/src/index.ts) 按**包名**建索引并派生 `/plugins/<packageName>/client.js`
- boot 阶段按包名 require 模块

官方也是如此:`@deepseek-ai/dsh-client-ui-theme` 的 client bundle 里写 `id: "@deepseek-ai/dsh-client-ui-theme"`。

---

## 2. 冲突语义:为什么 row id 最危险

DSH 有三套独立命名空间,撞了之后的后果完全不同:

| 命名空间 | 冲突表现 | 可发现性 |
| --- | --- | --- |
| npm package name | registry 先到先得,装到别人的包 | 中(装错才发现) |
| **loader row id** | 同一 id 只保留一个 entry,**后声明的层静默覆盖** | ⚠️ **低,不报错** |
| HTTP route `(kind, path)` | 抛 `webserver: duplicate exact route "<path>"` | 高,启动即失败 |
| client module | `client-modules: package X resolves from multiple active Loader sources` | 高 |

所以**个人 token 必须放进 row id**(进而带进路由、CSS、状态文件)。哪怕裸的 `usage` 更好看,也不能用 —— 第三方 `dsh-usage` 的 row id 恰好就是裸的 `usage`,同装即静默打架。

---

## 3. 官方 / 三方对照

命名不是拍脑袋,是对着官方形状定的:

| 来源 | package name | row id | route |
| --- | --- | --- | --- |
| 官方 open-in-app | `@deepseek-ai/dsh-host-open-in-app` | `open-in-app` | `/open-in-app/apps`、`/open-in-app/icon` |
| 官方 session-log-export | `@deepseek-ai/dsh-session-log-export` | `session-log-download` | `/api/session.export` |
| 官方 client modules | `@deepseek-ai/dsh-client-modules` | `modules` | `/plugins` |
| 三方 dsh-usage | `dsh-usage` | `usage` | 无(走 Remote) |
| 三方 dsh-session-manager | `dsh-session-manager` | `dsh-session-manager` | `/dsh-session-manager/*` |
| 三方 dsh-session-control | `dsh-session-control` | `dsh-session-control` | `/dsh-sc/*` |

要点:

- **官方路由从不出现包名的 `@scope/` 前缀**,跟随的是短 slug(≈ row id)。三方则三种写法都有人用,所以没有"三方统一约定"。
- 官方**优先用 Remote 而不是手写路由**:32 个包用 `@Remote`,仅 13 个手动 `webServer.register`。手写路由只用于 HTML 注入、文件下载、upgrade、静态资源这类非 JSON 场景。
  - 结构化 JSON 的标准路径是 `TypertRemoteService` 命名空间 → `POST /api/<namespace>/<method>`,由 Connection 统一鉴权并做 namespace 冲突检查。代价是需要 Typert 构建/代码生成链路,手写 bundle 用不了,这才退而手搓路由。
- 状态持久化官方用 `ctx.storageDomain`;手写 `$DSH_HOME/storages/*.json` 是简化做法。

---

## 4. 插件骨架

### 4.1 目录

```
dsh-<m>/
├── package.json         # 包清单 + dsh.bundle / dsh.client 两处声明
├── cordis.patch.yml     # 把本包作为一行 insert 挂进 profile
├── index.js             # host 半边:服务、路由、持久化
├── client.js            # client 半边:浏览器 bundle
└── README.md
```

### 4.2 package.json

```json
{
  "name": "@dss886/dsh-<m>",
  "version": "0.1.0",
  "private": true,
  "description": "…",
  "type": "module",
  "main": "./index.js",
  "exports": {
    ".": "./index.js",
    "./client": "./client.js",
    "./cordis.patch.yml": "./cordis.patch.yml",
    "./package.json": "./package.json"
  },
  "dsh": {
    "bundle": { "patch": "./cordis.patch.yml" },
    "client": {
      "platform": "web",
      "immediately": true,
      "inject": ["slots"],
      "external": ["react-dom"]
    }
  }
}
```

`private: true` 防止误发布;`exports` 四个入口缺一不可(尤其 `./client` 与 `./cordis.patch.yml`,client-modules 与 plugin-manager 都按名解析)。

### 4.3 cordis.patch.yml

```yaml
# The @dss886/dsh-<m> bundle layer: one row that …
- insert:
    - id: dss886-dsh-<m>
      name: '@dss886/dsh-<m>'
```

> ⚠️ **`name` 必须加引号**。YAML 里 `@` 是保留起始符,`name: @dss886/dsh-<m>` 会解析失败。

### 4.4 index.js(host)

```js
export const name = 'dss886-dsh-<m>'          // = row id
export const inject = ['webServer']            // 硬依赖

const ROUTE = '/dss886-dsh-<m>/api/<verb>'

export function apply(ctx) {
  // 路由必须在 ctx.effect 内注册,否则重载会留下僵尸路由
  ctx.effect(() => ctx.webServer.register({
    kind: 'exact',
    path: ROUTE,
    handler: async (req, res) => { /* … */ },
  }), 'dss886-dsh-<m>: routes')
}
```

### 4.5 client.js(client)

```js
window.__ModuleLoader__.load({
  id: '@dss886/dsh-<m>',                       // = 包名,不是 row id
  factory(require) {
    const React = require('react')
    const h = React.createElement
    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dss886-dsh-<m>',                // slot 内唯一
          order: 10,
          label: '…',
        }, Component))
      },
    }
  },
})
```

---

## 5. 硬性规则(都是踩过的坑)

1. **路由必须包在 `ctx.effect` 里。**
   直接 `ctx.webServer.register(...)` 时 Cordis 不会执行 disposer,每次重载都留下同路径僵尸路由,下一次激活抛
   `webserver: duplicate exact route "…"`,页面则一直连着上一代旧代码。

2. **不要在状态加载完成前持久化。**
   典型写法是在 `apply()` 里 `let state = emptyState()`,然后事件置 `dirty` 触发去抖落盘。如果 `flush()` 没有
   `loaded` 守卫,重载后一个事件就能把**全 0 的状态写回磁盘,覆盖真实数据**(本仓库真实发生过)。
   守卫要写成 `if (!loaded || !dirty) return`,且**不要**在未加载时重置 `dirty`。

3. **写型路由要做回环 + 同源校验。**
   校验 `remoteAddress`(仅 `127.0.0.1`/`::1`/`::ffff:127.0.0.1`)、无 `forwarded`/`x-forwarded-for`、
   `Origin` 的 host 等于 `Host`。只读路由只做同源即可。

4. **YAML 里以 `@` 开头的标量必须加引号**(见 §4.3)。

5. **client module id = 包名**(见 §1.4),不要跟 row id 走。

6. **请求体要有上限**,对未知 session id 等输入做白名单正则校验。

---

## 6. 状态文件规范

- 路径:`$DSH_HOME/storages/dss886-dsh-<m>-<what>.json`(`DSH_HOME` 缺省为 `~/.dsh`)。
- 写入用「临时文件 + 原子 rename」,不要原地改写。
- **改名时保留只读迁移链**,取第一个能读到的文件往前搬,避免计数归零:

```js
function statePaths() {
  const home = process.env.DSH_HOME?.trim() || join(homedir(), '.dsh')
  const names = [
    'dss886-dsh-<m>-<what>.json',   // 当前
    'dss886-<m>-<what>.json',       // 历史中间名(可选)
    'dsh-<m>-<what>.json',          // 更早
    '<m>-<what>.json',              // 最早
  ]
  return names.map((name) => join(home, 'storages', name))
}
```

```js
for (const candidate of files) {
  try { stored = parse(await readFile(candidate, 'utf8')); break }
  catch { /* 缺失或损坏,试下一个名字 */ }
}
```

迁移完成后,旧名字的文件成为冗余副本,确认新文件已在写即可删除。

---

## 7. 安装 / 链接

profile 位于 `$DSH_HOME/profiles/web`。安装 = 改它的 `package.json` + 跑 pnpm:

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dss886/dsh-usage",
        "@dss886/dsh-style"
      ]
    }
  },
  "dependencies": {
    "@dss886/dsh-usage": "link:/Users/dss886/Workspace/FE/dsh-plugins/dsh-usage",
    "@dss886/dsh-style": "link:/Users/dss886/Workspace/FE/dsh-plugins/dsh-style"
  }
}
```

```bash
cd "$DSH_HOME/profiles/web" && pnpm install   # pnpm 11.7.0 / node ≥ 22
ls node_modules/@dss886/                       # 软链应指向仓库目录
```

> ⚠️ **pnpm 的 hoisted linker 不会清理旧软链。** 依赖改名后,`node_modules/<旧名>` 会残留成断链,必须手动 `rm`。
> 另外 `pnpm install` 常输出 `Already up to date` 却仍正确重建了 scoped 软链,别只看这句话,要 `ls` 确认。

`cordis.patch.yml`(profile 的用户 patch 层)通常是 `[]`。只有需要**行级**开关覆盖时才加
`{ id: dss886-dsh-<m>, disabled: false }`;bundle 的启停由 `bundles` 列表决定。

---

## 8. 生效条件

| 改了什么 | 如何生效 |
| --- | --- |
| `client.js` | 刷新页面;若同时跑着 `pnpm run dev:web` 可免刷新热更 |
| `index.js`(host)` | 重启 `dsh web`(Node 的 ESM 缓存按文件 URL 生效;HMR 不保证重载 host 半边) |
| 包名 / `bundles` / row id / 路由 | **必须重启 `dsh web`** —— bundle 层与 row id 只在启动时组合 |
| profile `package.json` 依赖 | 先 `pnpm install`,再重启 |

验证:

```bash
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3080/dss886-dsh-<m>/api/<verb>
```

---

## 9. 新建插件 checklist

1. 选 `module` 名,确认 `npm view dss886-dsh-<m>` 与 `npm view dsh-<m>` 的占用情况。
2. 建目录 `dsh-<m>/`,按 §4.1 放 5 个文件;`package.json` 用 §4.2 模板。
3. 全库搜索确认新 token 没被用过:
   ```bash
   grep -rn "dss886-dsh-<m>" . "$DSH_HOME/profiles/web/package.json"
   ```
4. 逐个核对 §1.2 的每一层:row id、route 前缀、CSS 前缀、slot id、状态文件名、`export const name`。
5. 路由包 `ctx.effect`;持久化加 `loaded` 守卫;写型路由加回环 + 同源校验。
6. 加进 profile 的 `bundles` 与 `dependencies`,跑 `pnpm install`,确认 `node_modules/@dss886/` 软链无断链。
7. 重启 `dsh web`,硬刷新页面,按 §8 验证路由与前端表现。
8. 更新本 README 顶部的插件表。

---

## 10. 环境

| 项 | 值 |
| --- | --- |
| Node | v24.21.0(要求 ≥ 22) |
| pnpm | 11.7.0 |
| DSH_HOME | `/Users/dss886/.dsh` |
| profile | `$DSH_HOME/profiles/web` |
| 会话日志 | `$DSH_HOME/sessions/<encoded-cwd>/<session-id>/session.v3.jsonl.zstd` |
| DSH 源码 | `/Users/dss886/Workspace/FE/deepseek-harness` |
