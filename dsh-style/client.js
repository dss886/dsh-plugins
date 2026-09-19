// dsh-style — client half.
//
// The whole plugin is one document-level stylesheet: a 0.15s ease transition on
// the background of every hoverable element, so a hover that recolors a button,
// trigger, row or tab fades instead of snapping.
//
// ── Editing the look ────────────────────────────────────────────────────────
// Two constants below drive everything:
//
//   TARGETS     which elements are treated as hoverable. Kept to semantics that
//               survive CSS-module hashing — element names, roles and ARIA
//               states. Hashed class names (the client build emits
//               `[hash]_[local]`) are deliberately NOT matched, because a
//               class-name pattern breaks on the next restyle.
//   TRANSITION  the declaration itself. v1 asks for `background 0.15s ease`.
//
// TRACE_LABEL stamps `<html data-dsh-style="…">` and `window.__DSH_STYLE__` so a
// running page can be asked what it installed without opening devtools.
//
// Everything is installed through `ctx.effect`, so disabling the plugin row
// removes the stylesheet and the marker: this plugin has no state that outlives
// its mount.

/** Owner of the installed stylesheet; also the diagnostic key on `window`. */
const TRACE_LABEL = 'dsh-style'

/**
 * Elements whose hover recolors their background: buttons and button-shaped
 * controls, list rows (`tr`, ARIA rows), menu/picker/listbox entries, tabs,
 * tree items, and anything advertising a popup. `:disabled` elements never
 * hover-tint, and `[tabindex='-1']` is excluded because programmatic focus
 * targets are not pointer-interactive.
 */
const TARGETS = [
  'button',
  'summary',
  '[role=button]',
  '[role=menuitem]',
  '[role=menuitemradio]',
  '[role=menuitemcheckbox]',
  '[role=option]',
  '[role=tab]',
  '[role=treeitem]',
  '[role=row]',
  '[role=gridcell]',
  '[role=switch]',
  '[aria-haspopup]',
  '[tabindex]:not([tabindex="-1"])',
]

/** The v1 requirement: background transitions at 0.15s ease. */
const TRANSITION = 'background 0.15s ease'

/**
 * An empty `transition` cannot undo an `!important` one, so reduced motion is
 * honoured by collapsing the duration instead of removing the declaration —
 * which also keeps this plugin's timing authoritative over component rules that
 * already declare a longer background transition of their own.
 */
const REDUCED_MOTION_TRANSITION = 'background 0.001ms'

function stylesheet(mark) {
  const interactive = TARGETS.join(',')
  // `:where()` keeps the whole guard at zero specificity; the `!important` on
  // the declaration is what makes one rule win over per-component transition
  // shorthands (a module rule like `.primary:hover` resets `transition`, so a
  // non-important rule would only apply where nothing else set one).
  return `
/* ${mark} — hover background fade (${TRANSITION}) */
:where(${interactive}):not(:disabled):not([disabled]) {
  transition: ${TRANSITION} !important;
}

@media (prefers-reduced-motion: reduce) {
  :where(${interactive}):not(:disabled):not([disabled]) {
    transition: ${REDUCED_MOTION_TRANSITION} !important;
  }
}
`.trimStart()
}

window.__ModuleLoader__.load({
  id: 'dsh-style',
  factory() {
    const SOURCE = stylesheet(TRACE_LABEL)

    /**
     * Install the stylesheet on `<head>` and attach the diagnostic surface.
     * @returns the teardown for both, so a disabled row leaves no trace.
     */
    function install() {
      const style = document.createElement('style')
      style.id = TRACE_LABEL
      style.setAttribute('data-dsh-style', TRACE_LABEL)
      style.textContent = SOURCE
      document.head.appendChild(style)

      const root = document.documentElement
      root.setAttribute('data-dsh-style', TRACE_LABEL)

      const diagnostics = {
        styleId: TRACE_LABEL,
        transition: TRANSITION,
        styleElement: style,
        isActive() {
          return style.isConnected
        },
        /** How many elements the browser is currently transitioning. */
        countTargets() {
          try {
            return document.querySelectorAll(TARGETS.join(',')).length
          } catch {
            return -1
          }
        },
        /** The declaration the browser resolved for one element. */
        read(element) {
          const target = element ?? document.querySelector(TARGETS.join(','))
          return target === null ? null : getComputedStyle(target).transition
        },
      }
      window.__DSH_STYLE__ = diagnostics

      return function uninstall() {
        style.remove()
        root.removeAttribute('data-dsh-style')
        if (window.__DSH_STYLE__ === diagnostics) delete window.__DSH_STYLE__
      }
    }

    return {
      apply(ctx) {
        // The loader runs this half after the document body exists; a half that
        // somehow mounts earlier waits one event rather than throwing.
        if (document.head === null) {
          ctx.effect(() => {
            const run = () => {
              dispose = install()
            }
            let dispose = null
            document.addEventListener('DOMContentLoaded', run, { once: true })
            return () => {
              document.removeEventListener('DOMContentLoaded', run)
              if (dispose !== null) dispose()
            }
          }, TRACE_LABEL + ': deferred install')
          return
        }
        ctx.effect(install, TRACE_LABEL + ': hover transition')
      },
    }
  },
})
