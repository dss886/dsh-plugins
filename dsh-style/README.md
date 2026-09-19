# @dss886/dsh-style

以 Cordis profile bundle 形式安装的 DSH Web UI 全局样式微调插件。

## v1 — 悬停背景渐变

所有在悬停时改变背景色的元素，现在从“瞬间跳变”变为渐变过渡：

```css
transition: background 0.15s ease;
```

覆盖范围包括各类按钮（`Button` 的 toolbar/ghost/outline/primary 变体）、菜单与选择器条目、会话/项目/工作区行、标签页、树节点、折叠行，以及所有弹出层触发器——只有一条规则，且选择器只依赖语义，不依赖会被哈希的 class 名。

## 文件

| 文件 | 作用 |
| --- | --- |
| `client.js` | 插件的全部行为：生成样式表、挂载到 `<head>`、暴露 `window.__DSS886_DSH_STYLE__`，并在该行被禁用时把两者一并撤销。 |
| `index.js` | 空的 Host 半边——该行存在的意义是让 bundle 能被挂载和开关。 |
| `cordis.patch.yml` | 插入唯一的 `dss886-dsh-style` 行。 |
| `package.json` | 声明 `dsh.bundle.patch` 与 `dsh.client`（`platform: web`、`immediately: true`）。 |

## 调参

两个旋钮都是 `client.js` 顶部的常量：

- `TARGETS` — 哪些元素算作“可悬停”。要扩展请加自己的 `[data-*]` 钩子，不要改用哈希 class 名，那些名字下次改版就会失效。
- `TRANSITION` — 声明本身。`background 0.15s ease` 会同时覆盖 `background-color`、`background-image` 与 `background-position`；若只想限制为纯色变化，改成 `background-color 0.15s ease`。

规则里刻意带了 `!important`：像 `.primary:hover { … }` 这样自带 `transition` 简写的组件规则特异性更高，否则会直接重置掉这个过渡。在 `prefers-reduced-motion: reduce` 下，做法是把时长压到 `0.001ms` 而不是删除声明——因为空 `transition` 无法撤销带 `!important` 的声明。

## 验证是否生效

在已打开的应用控制台里执行：

```js
document.documentElement.dataset.dss886DshStyle        // "dss886-dsh-style"
document.getElementById('dss886-dsh-style').textContent // 实际注入的 CSS
window.__DSS886_DSH_STYLE__.countTargets()              // 当前参与过渡的元素数量
window.__DSS886_DSH_STYLE__.read(document.querySelector('button')) // 解析后的 transition
```

## 安装 / 移除

```js
plugin_manager({ action: 'install_bundle', target: '/Users/dss886/Workspace/FE/dsh-plugins/dsh-style' })
plugin_manager({ action: 'remove_bundle', target: '@dss886/dsh-style' })
```

替换已安装包的 JavaScript 需要重启才能加载新的模块代次；首次安装可通过 HMR 生效，另需刷新页面以拉取新的客户端模块。
