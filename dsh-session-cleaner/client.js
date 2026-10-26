// @dss886/dsh-session-cleaner — browser half.
//
// One General settings row: enable/disable the cleaner and pick the retention
// window (7 / 14 / 30 days). Every change writes immediately — there is no
// Save button. The row reads and writes the Host's plugin settings document
// through the settings route; it never sees Sessions and never deletes
// anything.
//
// Bundle format: the client-modules protocol loads a lazy factory.
window.__ModuleLoader__.load({
  id: '@dss886/dsh-session-cleaner',
  factory(require) {
    const React = require('react')
    const { IconChevronDownOutlineRegular, Menu } = require('@deepseek-ai/dsh-client-ui-primitives')

    const NS = 'dss886-dsh-session-cleaner'
    const SETTINGS_ROUTE = '/dss886-dsh-session-cleaner/api/settings'
    const STATUS_ROUTE = '/dss886-dsh-session-cleaner/api/status'
    const RETENTION_OPTIONS = [7, 14, 30]
    const DEFAULT_RETENTION = 30

    const zh = {
      title: '自动清理已归档会话',
      desc: '归档超过所选天数后，在下次启动时永久删除会话日志。附件不会删除。',
      retention: '保留时长',
      offOption: '关闭',
      days7: '7 天',
      days14: '14 天',
      days30: '30 天',
      saving: '保存中…',
      saved: '已保存，下次启动生效',
      failed: '保存失败：{reason}',
      loadFailed: '读取设置失败：{reason}',
      tracked: '已跟踪 {tracked} 个归档会话',
      eligible: '其中 {eligible} 个将在下次启动删除',
      pending: '{pending} 个待续清理',
      skipped: '{skipped} 个本次跳过',
      off: '当前已关闭',
      invalid: '设置文件无效，自动清理已暂停；修改任意选项即可修复。',
    }

    const en = {
      title: 'Auto-delete archived sessions',
      desc: 'After the selected retention window, delete the session log, its subagent logs and the projection cache on the next start. Attachments are not deleted.',
      retention: 'Retention',
      offOption: 'Off',
      days7: '7 days',
      days14: '14 days',
      days30: '30 days',
      saving: 'Saving…',
      saved: 'Saved — applies on the next start',
      failed: 'Save failed: {reason}',
      loadFailed: 'Could not read settings: {reason}',
      tracked: '{tracked} archived session(s) tracked',
      eligible: '{eligible} due on the next start',
      pending: '{pending} pending',
      skipped: '{skipped} skipped this run',
      off: 'Currently disabled',
      invalid: 'The settings file is invalid, so auto-delete is paused. Change any option to repair it.',
    }

    let localeService = null

    function builtinLang() {
      if (typeof navigator === 'undefined') return 'zh'
      const tags = [].concat(navigator.languages || [], [navigator.language])
      for (const tag of tags) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    function builtinText(key, values) {
      const dict = builtinLang() === 'en' ? en : zh
      const template = dict[key]
      if (template === undefined) return key
      if (values === undefined) return template
      return template.replace(/\{(\w+)\}/g, (whole, name) => (name in values ? String(values[name]) : whole))
    }

    function resolveText(seat, key, values) {
      if (typeof seat === 'function') {
        try {
          const text = seat(key, values)
          if (typeof text === 'string' && text !== '' && text !== key) return text
        } catch {
          /* a broken seat must not blank the copy */
        }
      }
      return builtinText(key, values)
    }

    async function readJson(response) {
      let payload = {}
      try {
        payload = await response.json()
      } catch {
        /* keep the HTTP status as the reason */
      }
      if (!response.ok || payload?.ok !== true) {
        throw new Error(payload?.error || `HTTP ${response.status}`)
      }
      return payload
    }

    function retentionLabel(t, days) {
      if (days === 7) return t('days7')
      if (days === 14) return t('days14')
      return t('days30')
    }

    function CleanerRow(props) {
      const seat = props !== null && props !== undefined && typeof props.t === 'function' ? props.t : null
      const t = React.useCallback((key, values) => resolveText(seat, key, values), [seat])

      const [enabled, setEnabled] = React.useState(false)
      const [days, setDays] = React.useState(DEFAULT_RETENTION)
      const [status, setStatus] = React.useState(null)
      const [invalid, setInvalid] = React.useState(false)
      const [loaded, setLoaded] = React.useState(false)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [hover, setHover] = React.useState(false)
      const selectorRef = React.useRef(null)

      const load = React.useCallback(async () => {
        try {
          const [settings, info] = await Promise.all([
            fetch(SETTINGS_ROUTE, { headers: { accept: 'application/json' } }).then(readJson),
            fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } }).then(readJson),
          ])
          const stored = Number(settings.settings.retentionDays)
          setEnabled(settings.settings.enabled === true)
          setDays(RETENTION_OPTIONS.includes(stored) ? stored : DEFAULT_RETENTION)
          setInvalid(settings.invalid === true)
          setStatus(info)
          setLoaded(true)
          setNotice(null)
        } catch (reason) {
          setLoaded(true)
          setNotice({ kind: 'error', scope: 'load', reason: reason?.message ?? String(reason) })
        }
      }, [])

      React.useEffect(() => {
        void load()
      }, [load])

      const save = React.useCallback(async (nextEnabled, nextDays) => {
        if (busy) return
        const previous = { enabled, days }
        setBusy(true)
        setEnabled(nextEnabled)
        setDays(nextDays)
        setNotice({ kind: 'saving' })
        try {
          const response = await fetch(SETTINGS_ROUTE, {
            method: 'PUT',
            headers: { 'content-type': 'application/json', accept: 'application/json' },
            body: JSON.stringify({ enabled: nextEnabled, retentionDays: nextDays }),
          })
          const payload = await readJson(response)
          const stored = Number(payload.settings.retentionDays)
          setEnabled(payload.settings.enabled === true)
          setDays(RETENTION_OPTIONS.includes(stored) ? stored : DEFAULT_RETENTION)
          setInvalid(false)
          setNotice({ kind: 'saved' })
          try {
            const info = await fetch(STATUS_ROUTE, { headers: { accept: 'application/json' } }).then(readJson)
            setStatus(info)
          } catch {
            /* the write succeeded; a failed refresh is not a save failure */
          }
        } catch (reason) {
          setEnabled(previous.enabled)
          setDays(previous.days)
          setNotice({ kind: 'error', scope: 'save', reason: reason?.message ?? String(reason) })
        } finally {
          setBusy(false)
        }
      }, [busy, days, enabled])

      const selectMode = React.useCallback((next) => {
        selectorRef.current?.focus?.({ preventScroll: true })
        setOpen(false)
        if (next === 'off') {
          if (!enabled) return
          void save(false, days)
          return
        }
        const value = Number(next)
        if (!RETENTION_OPTIONS.includes(value)) return
        if (enabled && value === days) return
        void save(true, value)
      }, [days, enabled, save])

      const options = [
        { id: 'off', label: t('offOption') },
        ...RETENTION_OPTIONS.map(value => ({ id: String(value), label: retentionLabel(t, value) })),
      ]
      const selectedId = enabled ? String(days) : 'off'
      const selectedLabel = enabled ? retentionLabel(t, days) : t('offOption')

      const rowStyle = {
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        padding: '16px 0',
        borderBottom: '0.5px solid var(--dsw-alias-border-l2)',
      }
      const textStyle = {
        flex: 1,
        minWidth: 0,
        display: 'flex',
        flexDirection: 'column',
        gap: 4,
        paddingRight: 48,
      }
      const titleStyle = {
        fontSize: 14,
        fontWeight: 400,
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
      }
      const descStyle = {
        fontSize: 12,
        lineHeight: '18px',
        color: 'var(--dsw-alias-label-tertiary)',
      }
      const selectorStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        height: 36,
        padding: '0 14px',
        border: 'none',
        borderRadius: 'var(--dsw-radius-md)',
        background: hover && !busy && loaded
          ? 'var(--dsw-alias-interactive-bg-hover)'
          : 'var(--dsw-alias-bg-module-platform)',
        font: 'inherit',
        fontSize: 14,
        lineHeight: '22px',
        color: 'var(--dsw-alias-label-primary)',
        cursor: busy || !loaded ? 'default' : 'pointer',
        opacity: busy || !loaded ? 0.55 : 1,
        flex: 'none',
      }
      const statusStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-secondary)' }
      const errorStyle = { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-state-error-primary)' }

      const noticeText = notice === null
        ? null
        : notice.kind === 'saving'
          ? t('saving')
          : notice.kind === 'saved'
            ? t('saved')
            : t(notice.scope === 'load' ? 'loadFailed' : 'failed', { reason: notice.reason })

      return React.createElement('div', { style: rowStyle },
        React.createElement('div', { style: textStyle },
          React.createElement('div', { style: titleStyle }, t('title')),
          React.createElement('div', { style: descStyle }, t('desc')),
          invalid ? React.createElement('div', { style: errorStyle }, t('invalid')) : null,
          status !== null
            ? React.createElement('div', { style: statusStyle },
              t('tracked', { tracked: status.tracked ?? 0 }),
              ' · ',
              enabled ? t('eligible', { eligible: status.eligible ?? 0 }) : t('off'),
              (status.pending ?? 0) > 0 ? ` · ${t('pending', { pending: status.pending })}` : '',
              (status.lastRun?.skipped ?? 0) > 0 ? ` · ${t('skipped', { skipped: status.lastRun.skipped })}` : '')
            : null,
          noticeText !== null
            ? React.createElement('div', { style: notice.kind === 'error' ? errorStyle : statusStyle }, noticeText)
            : null,
        ),
        React.createElement(Menu, {
          open,
          onClose: () => { setOpen(false) },
          items: options,
          selectedId,
          onSelect: selectMode,
          align: 'end',
          portal: true,
          anchor: React.createElement('button', {
            ref: selectorRef,
            type: 'button',
            style: selectorStyle,
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': t('retention'),
            disabled: busy || !loaded,
            onClick: () => {
              if (busy || !loaded) return
              setOpen(value => !value)
            },
            onMouseEnter: () => { setHover(true) },
            onMouseLeave: () => { setHover(false) },
            onFocus: () => { setHover(true) },
            onBlur: () => { setHover(false) },
          },
            selectedLabel,
            React.createElement(IconChevronDownOutlineRegular, { size: 14, style: { flex: 'none' } }),
          ),
        }),
      )
    }

    function apply(ctx) {
      const adoptLocale = (locale) => {
        if (locale === null || locale === undefined || typeof locale.register !== 'function') return
        localeService = locale
        ctx.effect(() => locale.register(NS, { zh, en }), 'dss886-dsh-session-cleaner: dictionaries')
      }
      adoptLocale(ctx.get('locale'))
      if (localeService === null) ctx.inject(['locale'], (sub) => adoptLocale(sub.locale))

      ctx.slots.inject('settings.general.item', () => ctx.slots.register({
        name: 'settings.general.item',
        id: 'dss886-dsh-session-cleaner',
        order: 90,
        locale: NS,
      }, CleanerRow))
    }

    return { apply, inject: ['slots'] }
  },
})
