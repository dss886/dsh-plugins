// dss886-dsh-usage — client half.
//
// `sidebar.footer.action` holds one balance card; clicking it opens the same
// kind of trigger-anchored stat dialog the composer's turn/step pill uses
// (menu surface, r12, prominent elevation, heading + rule + two-column detail
// rows), portaled to the body so the sidebar's overflow cannot clip it.
// The dialog's heading is the balance itself and opens the official usage page.
//
// ── Editing the look ────────────────────────────────────────────────────────
// Everything visual lives in STYLESHEET below, in reading order:
//
//   .dss886-dsh-usage-card                the trigger card (border, radius, padding)
//   .dss886-dsh-usage-card:hover           hover / open affordance
//   .dss886-dsh-usage-card-label           left column ("余额" or "充值 / 赠送余额")
//   .dss886-dsh-usage-card-value           right column (the amount)
//   .dss886-dsh-usage-card[data-low]       low-balance recolor (both columns inherit)
//   .dss886-dsh-usage-panel                the popover surface
//   .dss886-dsh-usage-title / -rule / -details   the popover's inner structure
//   .dss886-dsh-usage-rail                 the 56px collapsed-sidebar token glyph
//
// Two rules of the house style apply: colors are theme tokens from the host's
// alias layer (`--dsw-alias-*`, which already carries both palettes) each with
// a literal fallback, and no layout value is ever set from JavaScript. The one
// inline style in this file is the popover's runtime position.

const STYLESHEET = `
/* ── trigger card: the balance row sitting above the Settings row ────────── */
.dss886-dsh-usage-card {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  box-sizing: border-box;
  width: 100%;
  min-width: 0;
  margin-bottom: 6px;
  padding: 8px 10px;
  border: .5px solid var(--dsw-alias-border-l3);
  border-radius: 10px;
  background: var(--dsw-alias-button-elevated-fill);
  font: inherit;
  font-size: 12px;
  color: var(--dsw-alias-label-primary);
  font-weight: 500;
  text-align: left;
  cursor: pointer;
  user-select: none;
}

.dss886-dsh-usage-card:hover,
.dss886-dsh-usage-card[aria-expanded='true'] {
  background: var(--dsw-alias-button-floating-hover);
}

.dss886-dsh-usage-card-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  display: flex;
  align-items: center;
  gap: 6px;
}

.dss886-dsh-usage-card-label svg {
  width: 14px;
  height: 14px;
}

.dss886-dsh-usage-card-value {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}

/* A balance under the low threshold recolors the amount (and the popover
   heading, which carries the same class). */
.dss886-dsh-usage-card[data-low='true'] .dss886-dsh-usage-card-value,
.dss886-dsh-usage-title-open[data-low='true'] {
  color: var(--dsw-alias-state-error-primary);
}

/* ── collapsed sidebar (56px rail): the token-usage glyph ───────────────── */
.dss886-dsh-usage-rail {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 36px;
  height: 36px;
  padding: 0;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--dsw-alias-label-primary);
  cursor: pointer;
  user-select: none;
}

.dss886-dsh-usage-rail:hover {
  background: var(--dsw-alias-interactive-bg-hover);
}

.dss886-dsh-usage-rail svg {
  display: block;
}

/* The rail keeps a warning affordance even though it shows no number. */
.dss886-dsh-usage-rail[data-low='true'] {
  color: var(--dsw-alias-state-error-primary);
}

/* ── popover: same skin as the composer's stat dialog ────────────────────── */
/* Placement (left/top/visibility) is the one value JavaScript supplies. */
.dss886-dsh-usage-panel {
  position: fixed;
  z-index: 1100;
  box-sizing: border-box;
  width: min(256px, calc(100vw - 24px));
  padding: 16px;
  border: 0;
  border-radius: 12px;
  background: var(--dsw-specific-menu, var(--dsw-alias-bg-overlay, #fff));
  box-shadow: var(--dsw-elevation-prominent, 0 8px 32px rgba(0, 0, 0, 0.2));
  font-size: 12px;
  line-height: 18px;
  color: var(--dsw-alias-label-secondary, #8a8f98);
  cursor: default;
  user-select: none;
}

.dss886-dsh-usage-title {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  margin-bottom: 8px;
  color: var(--dsw-alias-label-primary, inherit);
  font-weight: 500;
}

/* The heading is a button: it opens the official usage page. */
.dss886-dsh-usage-title-open {
  display: inline-flex;
  align-items: center;
  justify-content: space-between;
  gap: 6px;
  width: 100%;
  padding: 0;
  border: none;
  background: transparent;
  color: inherit;
  font: inherit;
  font-weight: 500;
  cursor: pointer;
  text-align: left;
}

.dss886-dsh-usage-title-open svg {
  width: 14px;
  height: 14px;
}

.dss886-dsh-usage-title-kind {
  display: flex;
  font-weight: 500;
  align-items: center;
  gap: 6px;
}

.dss886-dsh-usage-title-value {
  font-variant-numeric: tabular-nums;
}

.dss886-dsh-usage-rule {
  margin-bottom: 10px;
  border-top: 0.5px solid var(--dsw-alias-border-l2, #e0e0e0);
}

/* Two-column detail rows: label left, amount right. */
.dss886-dsh-usage-details {
  display: grid;
  grid-template-columns: minmax(88px, auto) minmax(0, 1fr);
  gap: 6px 16px;
  margin: 0;
  color: var(--dsw-alias-label-tertiary, #9aa0a6);
}

.dss886-dsh-usage-details dt,
.dss886-dsh-usage-details dd {
  min-width: 0;
  margin: 0;
}

.dss886-dsh-usage-details dd {
  color: var(--dsw-alias-label-secondary, #8a8f98);
  font-variant-numeric: tabular-nums;
  text-align: right;
}
`

window.__ModuleLoader__.load({
  id: '@dss886/dsh-usage',
  factory(require) {
    const React = require('react')
    const ReactDom = require('react-dom')
    const h = React.createElement

    const API = '/dss886-dsh-usage/api/usage'
    const DASHBOARD_URL = 'https://platform.deepseek.com/usage'
    const REFRESH_MS = 60_000
    /** Viewport margin kept by the placement clamp (the Menu portal margin). */
    const PANEL_MARGIN = 12
    /** Distance between the trigger's top edge and the panel's bottom. */
    const PANEL_GAP = 8

    const styles = h('style', { key: 'dss886-dsh-usage-style', dangerouslySetInnerHTML: { __html: STYLESHEET } })

    /**
     * `IconDatabaseOutline16` from the harness icon set — the same glyph the
     * composer's token-usage pill wears — inlined because a hand-written bundle
     * cannot import `@deepseek-ai/dsh-client-ui-primitives`.
     */
    const TOKEN_ICON = h('svg', {
      width: 16,
      height: 16,
      viewBox: '0 0 16 16',
      fill: 'none',
      'aria-hidden': true,
      focusable: false,
    },
      h('ellipse', { cx: 8, cy: 3.6, rx: 5.75, ry: 2.4, stroke: 'currentColor', strokeWidth: 1.25 }),
      h('path', { d: 'M2.25 3.6V12.3A5.75 2.4 0 0 0 13.75 12.3V3.6', stroke: 'currentColor', strokeWidth: 1.25 }),
      h('path', { d: 'M2.25 7.95A5.75 2.4 0 0 0 13.75 7.95', stroke: 'currentColor', strokeWidth: 1.25 }))

    /** Tokens below a million keep exact digits; above that, one compact unit. */
    function fmtTokens(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return '0'
      if (n >= 1_000_000_000) return (n / 1_000_000_000).toFixed(2) + 'B'
      if (n >= 1_000_000) return (n / 1_000_000).toFixed(n >= 100_000_000 ? 0 : n >= 10_000_000 ? 1 : 2) + 'M'
      if (n >= 1_000) return (n / 1_000).toFixed(n >= 100_000 ? 0 : 1) + 'K'
      return String(Math.round(n))
    }

    /**
     * Integer percent with one decimal, e.g. 0.9974 → `99.7%`.
     *
     * Rounding to whole percent would show `100%` for 99.74%, which reads as
     * "every input was a cache hit" while the session dialog next to it reports
     * 99.8% — the same value at one decimal. Matching that precision keeps the
     * two readings consistent and never overstates the rate.
     */
    function fmtPercent(rate) {
      if (rate === null || rate === undefined || !Number.isFinite(Number(rate))) return '—'
      return (Number(rate) * 100).toFixed(1) + '%'
    }

    function fmtAmount(currency, amount) {
      const n = Number(amount)
      if (!Number.isFinite(n)) return '—'
      const symbol = currency === 'USD' ? '$' : currency === 'CNY' ? '¥' : ''
      return symbol + n.toFixed(2)
    }

    /** Money reading for the estimate: the card quotes CNY like the balance. */
    function fmtCny(value) {
      const n = Number(value)
      if (!Number.isFinite(n) || n < 0) return '—'
      return '¥' + (n < 0.01 && n > 0 ? n.toFixed(4) : n.toFixed(2))
    }

    /**
     * Today's estimated spend, in CNY.
     *
     * The host prices natively in 元, so this is a plain read. Only a missing
     * key means "no estimate": a spend of exactly zero is a real reading and is
     * reported as ¥0.00.
     * @returns CNY amount, or undefined when the host carries no estimate.
     */
    function estimateCny(usage) {
      if (usage === null || typeof usage !== 'object') return undefined
      if (!Object.hasOwn(usage, 'todayCostCny')) return undefined
      const cny = Number(usage.todayCostCny)
      return Number.isFinite(cny) ? cny : undefined
    }

    /**
     * Balance reading: a zero gift balance is dropped, so the label collapses
     * to `余额` and otherwise stays `充值 / 赠送余额`.
     * @returns the label, the amount text, and the low-balance flag.
     */
    function balanceReading(balance) {
      if (balance.status === 'missing-key') return { label: '余额', value: '未配置 API Key', low: false }
      if (balance.status === 'invalid-key') return { label: '余额', value: 'API Key 无效', low: false }
      if (balance.status === 'unreachable' || balance.status === 'error') return { label: '余额', value: '读取失败', low: false }
      const amount = fmtAmount(balance.currency, balance.total)
      const granted = Number(balance.granted)
      if (!Number.isFinite(granted) || granted <= 0) {
        return { label: '余额', value: amount, low: balance.low === true }
      }
      return {
        label: '充值 / 赠送余额',
        value: fmtAmount(balance.currency, balance.toppedUp) + ' / ' + fmtAmount(balance.currency, balance.granted),
        low: balance.low === true,
      }
    }

    /** Fixed placement above the trigger, clamped inside the viewport. */
    function usePlacement(open, triggerRef, panelRef) {
      const [pos, setPos] = React.useState(null)

      React.useEffect(function () {
        if (!open) {
          setPos(null)
          return undefined
        }
        function place() {
          const trigger = triggerRef.current
          const panel = panelRef.current
          if (!trigger) return
          const anchor = trigger.getBoundingClientRect()
          const width = panel ? panel.offsetWidth : 300
          const height = panel ? panel.offsetHeight : 140
          let left = anchor.right - width
          left = Math.min(Math.max(PANEL_MARGIN, left), window.innerWidth - width - PANEL_MARGIN)
          let top = anchor.top - height - PANEL_GAP
          top = Math.min(Math.max(PANEL_MARGIN, top), window.innerHeight - height - PANEL_MARGIN)
          setPos({ left: Math.round(left), top: Math.round(top) })
        }
        place()
        // The first pass runs before the panel reports its size, so place once
        // more on the next frame; resize keeps it inside the viewport.
        const frame = window.requestAnimationFrame(place)
        window.addEventListener('resize', place)
        return function () {
          window.cancelAnimationFrame(frame)
          window.removeEventListener('resize', place)
        }
      }, [open, triggerRef, panelRef])

      return pos
    }

    function DeepSeekUsage(props) {
      const wide = props.wide !== false
      const [data, setData] = React.useState(null)
      const [failed, setFailed] = React.useState(false)
      const [open, setOpen] = React.useState(false)
      const triggerRef = React.useRef(null)
      const panelRef = React.useRef(null)
      const pos = usePlacement(open, triggerRef, panelRef)

      React.useEffect(function () {
        let alive = true
        function pull() {
          fetch(API, { headers: { accept: 'application/json' } })
            .then(function (response) { return response.text() })
            .then(function (text) {
              if (!alive) return
              let body = null
              try { body = JSON.parse(text) } catch { body = null }
              if (body && body.ok) {
                setData(body)
                setFailed(false)
              } else {
                setFailed(true)
              }
            })
            .catch(function () { if (alive) setFailed(true) })
        }
        pull()
        const handle = setInterval(pull, REFRESH_MS)
        return function () {
          alive = false
          clearInterval(handle)
        }
      }, [])

      // Outside pointerdown closes; the portaled panel counts as inside.
      React.useEffect(function () {
        if (!open) return undefined
        function onPointerDown(event) {
          const trigger = triggerRef.current
          const panel = panelRef.current
          if (trigger && trigger.contains(event.target)) return
          if (panel && panel.contains(event.target)) return
          setOpen(false)
        }
        function onKeyDown(event) {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('pointerdown', onPointerDown, true)
        document.addEventListener('keydown', onKeyDown)
        return function () {
          document.removeEventListener('pointerdown', onPointerDown, true)
          document.removeEventListener('keydown', onKeyDown)
        }
      }, [open])

      const openDashboard = React.useCallback(function (event) {
        if (event) event.stopPropagation()
        window.open(DASHBOARD_URL, '_blank', 'noopener,noreferrer')
      }, [])

      const reading = data === null ? null : balanceReading(data.balance ?? {})
      const pendingText = failed ? '用量不可用' : '读取中…'
      const value = reading === null ? pendingText : reading.value
      const label = reading === null ? '余额' : reading.label
      const low = reading !== null && reading.low === true
      const estimate = data === null ? undefined : estimateCny(data.usage)
      const usage = data === null ? {} : (data.usage ?? {})

      const dialog = open && data !== null
        ? ReactDom.createPortal(
            h('div', {
              ref: panelRef,
              className: 'dss886-dsh-usage-panel',
              role: 'dialog',
              'aria-label': 'DeepSeek 用量',
              style: pos === null
                ? { left: 0, top: 0, visibility: 'hidden' }
                : { left: pos.left, top: pos.top },
            },
              h('div', { className: 'dss886-dsh-usage-title' },
                h('button', {
                  type: 'button',
                  className: 'dss886-dsh-usage-title-open',
                  'data-low': low ? 'true' : undefined,
                  onClick: openDashboard,
                  title: '在浏览器打开 ' + DASHBOARD_URL,
                },
                  h('span', { className: 'dss886-dsh-usage-title-kind' }, TOKEN_ICON, label),
                  h('span', { className: 'dss886-dsh-usage-title-value' }, value)),
                failed ? h('span', null, '刷新失败') : null),
              h('div', { className: 'dss886-dsh-usage-rule', 'aria-hidden': true }),
              h('dl', { className: 'dss886-dsh-usage-details' },
                h('dt', null, '今日Token用量'),
                h('dd', null, fmtTokens(usage.today)),
                h('dt', null, '今日缓存命中率'),
                h('dd', null, fmtPercent(usage.todayCacheRate)),
                h('dt', null, '今日消耗估算'),
                h('dd', { title: '按 DeepSeek 官方人民币价目表估算（区分高峰/空闲时段）' }, fmtCny(estimate)))),
            document.body)
        : null

      if (!wide) {
        return h(React.Fragment, null,
          styles,
          h('button', {
            ref: triggerRef,
            type: 'button',
            className: 'dss886-dsh-usage-rail',
            'data-low': low ? 'true' : undefined,
            'aria-haspopup': 'dialog',
            'aria-expanded': open,
            onClick: function () { setOpen(!open) },
            // The rail has no room for the reading, so the balance moves into
            // the tooltip and the glyph carries the meaning.
            title: 'DeepSeek 用量 · ' + label + ' ' + value,
          }, TOKEN_ICON),
          dialog)
      }

      return h(React.Fragment, null,
        styles,
        h('button', {
          ref: triggerRef,
          type: 'button',
          className: 'dss886-dsh-usage-card',
          'data-low': low ? 'true' : undefined,
          'aria-haspopup': 'dialog',
          'aria-expanded': open,
          onClick: function () { setOpen(!open) },
          title: label + ' - ' + value,
        },
          h('span', { className: 'dss886-dsh-usage-card-label' }, TOKEN_ICON, label),
          h('span', { className: 'dss886-dsh-usage-card-value' }, value)),
        dialog)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('sidebar.footer.action', () => ctx.slots.register({
          name: 'sidebar.footer.action',
          id: 'dss886-dsh-usage',
          order: 10,
          label: 'DeepSeek 用量',
        }, DeepSeekUsage))
      },
    }
  },
})
