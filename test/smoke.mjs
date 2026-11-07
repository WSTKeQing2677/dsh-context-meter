/**
 * Offline smoke test: the shipped bundle loads, reports its client services, and
 * registers exactly one entry into conversation.input.left.
 *
 * Deliberately small — it proves the file in this repo is intact and self-consistent.
 * The full behavior harness (band words, threshold math, null paths, hover text) lives
 * in the development workspace, not here.
 */
import { readFileSync } from 'node:fs'

const source = readFileSync(new URL('../client.js', import.meta.url), 'utf8')

let loaded
const windowStub = { __ModuleLoader__: { load(module) { loaded = module } } }
const documentStub = {
  createElement: () => ({ dataset: {}, textContent: '', remove() {} }),
  head: { appendChild() {} },
}
const React = {
  createElement: () => ({}),
  Fragment: 'fragment',
  useCallback: (fn) => fn,
  useMemo: (fn) => fn(),
  useRef: (value) => ({ current: value }),
  useState: (value) => [value, () => {}],
  useEffect: () => {},
  useSyncExternalStore: (subscribe, read) => read(),
}

new Function('window', 'document', 'require', 'console', source)(
  windowStub,
  documentStub,
  () => React,
  console,
)

const failures = []
const check = (label, ok) => { if (!ok) failures.push(label) }

check('module id is the package name', loaded !== undefined && loaded.id === 'dsh-context-meter')

const api = loaded.factory(() => React)
check('injects slots', Array.isArray(api.inject) && api.inject.includes('slots'))
check('injects locale', api.inject.includes('locale'))

const seen = { locales: [], injects: [], registrations: [], effects: [] }
api.apply({
  effect(fn, label) {
    seen.effects.push(label)
    const undo = fn()
    if (typeof undo === 'function') undo()
  },
  locale: { register: (ns, dict) => seen.locales.push({ ns, dict }) },
  slots: {
    inject(slot, factory) { seen.injects.push(slot); factory() },
    register(meta, component) { seen.registrations.push({ meta, component }); return {} },
  },
})

check('registers into conversation.input.left', seen.injects.includes('conversation.input.left'))
const entry = seen.registrations[0]
check('registration id is context-meter', entry !== undefined && entry.meta.id === 'context-meter')
check('order is 40', entry !== undefined && entry.meta.order === 40)
check('entry renders a component', entry !== undefined && typeof entry.component === 'function')
const dict = seen.locales[0]
check('registers zh + en dictionaries', dict !== undefined && Object.keys(dict.dict.zh ?? {}).length > 0 && Object.keys(dict.dict.en ?? {}).length > 0)
check('zh and en share the same keys',
  dict !== undefined &&
  JSON.stringify(Object.keys(dict.dict.zh).sort()) === JSON.stringify(Object.keys(dict.dict.en).sort()))

console.log(failures.length === 0
  ? 'smoke ok: module id, inject list, input.left entry, order 40, zh/en parity'
  : `smoke FAILED: ${failures.join(', ')}`)
process.exit(failures.length === 0 ? 0 : 1)
