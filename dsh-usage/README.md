# dsh-usage

DeepSeek 用量卡片，挂在左侧边栏最底部、**设置按钮上方**（槽位 `sidebar.footer.action`）。
卡片只有一行余额；点击后弹出一个浮窗显示更多信息。

卡片文案按赠送余额状态切换：

| 情况 | 卡片显示 | 悬浮提示 / 浮窗标题 |
| --- | --- | --- |
| 赠送余额为 0 | `¥18.37` | `余额 - ¥18.37` |
| 赠送余额 > 0 | `¥18.37 / ¥5.00` | `充值 / 赠送余额 - ¥18.37 / ¥5.00` |

浮窗沿用 dsh 通用皮肤（menu 表面、r12 圆角、prominent 阴影、标题 + 分隔线 + 两列明细），并且：

- **浮窗标题 = 卡片余额**，点击标题在浏览器打开 <https://platform.deepseek.com/usage>
- **浮窗内容**：本日 Token 用量、本日缓存命中率、本日消耗估算
- 缓存命中率保留一位小数（`99.7%`），与会话底部统计浮窗的口径一致；取整会把
  99.74% 显示成 `100%`，看起来像"全部命中"
- 消耗估算为真实的 0 元时显示 `¥0.00`，只有 host 没有该字段时才显示 `—`
- 点击浮窗外部或按 Esc 关闭；浮窗通过 portal 挂到 `body`、用 `position: fixed`
  定位在触发器上方，四周保留 12px 视口边距，因此不会被侧栏的 `overflow` 裁掉
- 余额低于 ¥10 时，卡片与浮窗标题都用主题的错误色（浅色/深色各自跟随）

侧栏收成 56px 轨道时只显示一个 token 用量图标（沿用会话底部「token 用量」的数据库图标），
不再显示数字；余额挪进悬浮提示，点击同样弹出浮窗。

## 数据来源

| 指标 | 来源 |
| --- | --- |
| 余额 / 充值 / 赠送 | `https://api.deepseek.com/user/balance`，复用 DSH 的 `DEEPSEEK_API_KEY` |
| 本日 / 本月 Token、缓存命中率 | DSH 会话日志回放 + `session/event` 实时计量 |

1. **回放**：`$DSH_HOME/sessions/*/*/session.v3.jsonl.zstd` 里每个
   `assistant/message` 都带 `time` 与 `usage`，按自然日回放即可补齐插件启用前的历史。
   日志是逐帧追加的 zstd，Node 的同步解码器只解第一帧，所以按 magic 切帧逐个解。
   已处理文件的**大小**作为标记，日志增长时才重读。
2. **实时**：host 侧监听 `session/event`，把每次模型调用的 usage 累加进当天的桶。

两者按「同一天取较大值」合并（都是只增的累计量），并用 `session:seq` 去重，
所以回放与实时不会重复计数。

口径仅覆盖**这台机器上的 Harness 调用**；网页版、其他客户端、其他机器的用量不在其中。

## 结构与接口

| 文件 | 作用 |
| --- | --- |
| `package.json` | 包清单：`dsh.bundle.patch` 指向组合补丁，`dsh.client` 声明浏览器半边 |
| `cordis.patch.yml` | 把本包作为一行 `insert` 挂进 profile |
| `index.js` | host 半边：状态存储、日志回放、余额抓取、价格估算、一条回环路由 |
| `client.js` | client 半边：`sidebar.footer.action` 里的卡片与浮窗组件 |

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| `GET` | `/dsh-usage/api/usage?force=1` | 余额 + 本日/本月 Token 与命中率（含更多派生维度） |

路由仅接受回环地址与同源请求（校验 `remoteAddress`、`Host`、`Origin`、
`Sec-Fetch-Site`）。没有写入型路由，插件不接收任何凭据输入。

## 改样式

`client.js` 顶部的 `STYLESHEET` 是一整段可读的 CSS，按阅读顺序分段并带注释：

| 选择器 | 控制的东西 |
| --- | --- |
| `.dsh-usage-card` | 卡片本体：边框、圆角、内边距、底色 |
| `.dsh-usage-card:hover` | hover / 展开时的底色 |
| `.dsh-usage-card-label` | 左侧标题（`余额` / `充值 / 赠送余额`） |
| `.dsh-usage-card-value` | 右侧金额 |
| `.dsh-usage-card[data-low='true']` | 低余额变红（标题与金额一起继承） |
| `.dsh-usage-panel` | 浮窗表面：宽度、内边距、圆角、阴影、字号 |
| `.dsh-usage-title` / `-rule` / `-details` | 浮窗内部：标题行、分隔线、两列明细 |
| `.dsh-usage-rail-*` | 侧栏收起成 56px 轨道时的降级样式 |

两条约定让 CSS 与逻辑解耦：

1. **颜色一律用主题 token**（`--dsw-alias-*`，alias 层本身已同时定义浅色/深色），
   每个 token 后面跟一个字面量兜底；改主题时不需要动这个文件。
2. **布局值不来自 JavaScript**。状态差异通过 `data-low="true"` 这类 data attribute
   落到 CSS 选择器上，所以整份文件只有一处 inline style —— 浮窗的 `left/top`
   坐标，那是运行时测量出来的值。

## 状态文件

`$DSH_HOME/storages/dsh-usage-meter.json`：按自然日分桶
（`hitOff/hitPeak/missOff/missPeak/outOff/outPeak/calls` + 每模型子桶），
另有 `logs` 记录已回放日志的大小。保留 92 天，`version: 2`
（v1 的 `i/c/o` 会按低谷价迁移）。

文件在**首次请求**时异步读入，读取窗口内到达的事件先记进内存 `pending`，
再与读到的状态合并，因此不会因为读取竞态丢数；首次请求同时完成日志回放
（本机 7 个会话、约 4MB 日志实测 ~200–300ms）。

## 本日消耗估算口径

价目表直接使用官方中文页
<https://api-docs.deepseek.com/zh-cn/quick_start/pricing>（元/百万 tokens）：

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash` | 0.02 / 0.04 | 1 / 2 | 4 / 8 |
| `deepseek-v4-pro` | 0.15 / 0.3 | 4.5 / 9 | 13.5 / 27 |

（每格为 **空闲时段 / 高峰时段**，高峰价恰为空闲价的 2 倍。）

- **高峰时段按北京时间判定**：周一至周五 **09:00–12:00、14:00–18:00**
  （即 UTC 01:00–04:00、06:00–10:00）。本插件余额（`api.deepseek.com` 也返回 CNY）、
  估算、可用天数全部使用人民币进行计算。
- **中国法定节假日不计入高峰**，官方表里的例外没有建模，节假日的估算偏高。
- 平台账单（`usage/cost`）才是权威花费。

## 安装

```
plugin_manager install_bundle target=/Users/dss886/Workspace/FE/dsh-plugins/dsh-usage
```

本包以 `link:` 方式装进 `web` profile（`~/.dsh/profiles/web`）。`client.js` 改动会被
客户端按内容+修改时间生成的版本号自动加载；`index.js`（host 半边）改动后需要
重启 DSH 进程，因为 Node 的 ESM 缓存按文件 URL 生效。
