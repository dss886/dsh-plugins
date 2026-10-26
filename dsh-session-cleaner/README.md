# dsh-session-cleaner

归档会话保留 **N 天**（默认 30）后，在**下一次 DSH 启动**时永久删除：

- 会话日志目录（`session.v*.jsonl.zstd` / `session.lock`）；
- 它拥有的子代理会话日志（按 header 的 `origin: subagent` + `parentSession` 血缘，不依赖子代理 catalog）；
- 投影缓存行（`session_projcache`）及其 `.bak` 文件；
- workspace 记账（`sessionIds`、归档、置顶）；
- 向界面广播 `api-session/removed`。

**不删**：附件（`$DSH_HOME/attachments/v1` 是内容寻址、跨会话共享的）、搜索索引（派生库，下一次搜索时收敛）、用户导出的文件、APFS/Time Machine 快照。

> 没有回收站、没有撤销。删除是永久的。附件不删，所以“彻底清除”在隐私层面并不完整。

## 设置

Settings → General → 「自动清理已归档会话」：

- 保留时长下拉选择器：**关闭 / 7 天 / 14 天 / 30 天**（默认 30），选择后自动保存；
- 显示已跟踪的归档会话数、下次启动将删除的数量、待续清理数量。

选择「关闭」即停用自动清理。**下次启动生效**。设置文件：

```
$DSH_HOME/storages/dss886-dsh-session-cleaner-settings.json
```

## 时间语义（重要）

DSH 的 `archivedSessionIds` **没有归档时间戳**。本插件记录自己**首次观察到该会话处于归档状态**的时间 `firstSeenAt`，删除条件为：

```
now - firstSeenAt >= retentionDays
```

因此：

- 插件安装时已经存在的归档：首次运行 `firstSeenAt = now`，要再等 N 天，**不会立刻删**；
- 运行期归档：通过 `domain/changed` 实时记录，接近真实归档时间；
- 其他 profile 归档、而本 profile 没运行时：下次启动才记录（会晚 N 天）；
- 取消归档 → 删除记录；重新归档 → 重新计时；
- 状态文件损坏/丢失 → 全部按 `now` 重新计时（只会晚删，不会早删）。

## 删除流程

1. 启动后读设置与状态，拿 `dss886-dsh-session-cleaner.lock`（另一个实例在跑就跳过）；
2. 对齐 `archivedSessionIds`，记录 new / 清理 unarchived；
3. 处理上次未完成的 `pending`（崩溃、占用）；
4. 到期会话：用 header 建子树 → 对每个 id `persistence.stat` 定位 → `open(id,'write')` 做写所有权探针（任一被占用则整棵树跳过，保留归档，下次再试）→ 先写 pending → 子先父后 `rm` → 删缓存行 → 清 workspace 记账 → 广播；
5. 任何一步失败都保留 `pending`，下次启动续做；不会“删一半就忘”。

如果会话在启动时仍然 pending/被本进程持有（`stat` 只返回 header、没有 `location`），本次会**整棵树跳过**并在 `lastRun.skippedReasons` 里留下 `unmaterialized` / `live-pending`，下次启动再试。这是故意的：没有 `location` 时无法安全定位文件，宁可晚删也不能清掉记账却留下日志。

所有写只在启动 pass 中进行；运行期只记录归档时间变化。

## 安装（desktop）

```json
{
  "dependencies": {
    "@dss886/dsh-session-cleaner": "link:/Users/dss886/Workspace/FE/dsh-plugins/dsh-session-cleaner"
  },
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "@dss886/dsh-session-cleaner"
      ]
    }
  }
}
```

```bash
cd "$DSH_HOME/profiles/desktop" && pnpm install
```

然后重启 DSH。验证：

```bash
ls -l ~/.dsh/profiles/desktop/node_modules/@dss886/
curl -s http://127.0.0.1:<port>/dss886-dsh-session-cleaner/api/status
```

## 文件

| 文件 | 作用 |
| --- | --- |
| `dss886-dsh-session-cleaner-settings.json` | `{ enabled, retentionDays }` |
| `dss886-dsh-session-cleaner-state.json` | `firstSeenAt`、pending 日志、lastRun |
| `dss886-dsh-session-cleaner-audit.jsonl` | 删除审计（每棵树一行，>5MB 轮转 `.1`） |
| `dss886-dsh-session-cleaner.lock` | 启动 pass 的跨进程锁 |

状态/缓存的第一次启动只会记录、不会删除。

## 安全边界

- 只删 `archivedSessionIds` 里的会话；启动时现查归档集合，删除前再查一次（防止另一个窗口刚取消归档）；
- 只用 `stat().location` 定位，不从 header/catalog 拼路径；id 必须匹配 `^(session-)?<uuid>$`；
- `open(id,'write')` 拿跨进程 flock；删除期间保持句柄，直到目录 unlink，避免 `close → rm` 的竞态；
- 子代理用 header 血缘，`origin !== 'subagent'` 的 fork 永远不删；
- 内网/本机路由：复用 `connection.requestRejection`；没有 connection 时 fail-closed 到 loopback + 同源；
- 无 agent 工具、无删除 HTTP 接口；删除只发生在启动 pass。
