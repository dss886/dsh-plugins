// dsh-style — host half.
//
// The plugin is a pure UI trim: everything it does lives in the browser half
// (`client.js`, declared by `dsh.client` in package.json). The Host row exists
// only so the bundle is a normal Cordis plugin row that mounts, reports, and
// can be toggled from the Plugins page; it publishes no service, reserves no
// route, and reads no configuration.

export const name = 'dsh-style'

export function apply() {}
