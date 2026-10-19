/**
 * Smoke test for dsh-conversation-find/client.js under jsdom.
 *
 * Verifies the parts that do not need a real browser: the bundle registers under
 * the row id, the factory returns a cordis-shaped plugin, and collect() finds
 * exactly the expected text ranges inside the conversation scroll port while
 * ignoring the composer, our own UI and script/style content.
 */
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { JSDOM } = require('jsdom')

const SOURCE = path.join(__dirname, '..', 'client.js')

const dom = new JSDOM(`<!doctype html><html><body>
  <div data-conversation-content data-conversation-session="sess-1">
    <div data-conversation-scroll>
      <div class="msg">Hello world, this is the first message.</div>
      <div class="msg">Second message mentions hello again twice: hello.</div>
      <div class="msg"><span>nested HELLO in a span</span></div>
      <script>var hello = "should not be searched";</script>
      <div data-dsh-conversation-find class="dcf-panel">hello from our own panel</div>
    </div>
    <div data-composer-seat data-conversation-region="composer">
      <textarea>hello draft in composer</textarea>
    </div>
  </div>
</body></html>`, { url: 'http://127.0.0.1:3080/' })

const { window } = dom
global.window = window
global.document = window.document
global.NodeFilter = window.NodeFilter

let registered = null
window.__ModuleLoader__ = {
  load: (spec) => {
    registered = spec
  }
}

vm.runInThisContext(fs.readFileSync(SOURCE, 'utf8'), { filename: SOURCE })

assert.equal(registered.id, 'dsh-conversation-find', 'bundle registers under the row id')

const exports_ = registered.factory((name) => {
  if (name === 'react') {
    return {
      createElement: (type, props, ...children) => ({ type, props, children })
    }
  }
  throw new Error(`unexpected require: ${name}`)
})

assert.equal(exports_.name, 'dsh-conversation-find')
assert.deepEqual(exports_.inject, ['slots', 'sessions'])
assert.equal(typeof exports_.apply, 'function')

const { collect } = exports_.__internals

const hits = collect('hello')
// 1 (first message) + 2 (second message) + 1 (nested span) = 4;
// the <script> body, our panel and the composer draft must not count.
assert.equal(hits.length, 4, `expected 4 matches, got ${hits.length}`)

const texts = hits.map((hit) => hit.node.nodeValue.slice(hit.start, hit.end))
assert.deepEqual(texts, ['Hello', 'hello', 'hello', 'HELLO'])

// Case-insensitive matching must not change the reported offsets.
for (const hit of hits) {
  assert.equal(hit.end - hit.start, 5)
}

assert.equal(collect('nothing-here').length, 0)
assert.equal(collect('').length, 0)

// The slot registration shape is what the host expects for a list seat.
const registrations = []
const ctx = {
  effect: (fn) => fn(),
  slots: {
    inject: (name, fn) => {
      registrations.push({ injected: name, result: fn() })
      return () => {}
    },
    register: (options, component) => {
      registrations.push({ options, component })
      return () => {}
    }
  }
}
exports_.apply(ctx)
const seat = registrations.find((entry) => entry.options !== undefined)
assert.equal(seat.options.name, 'conversation.session.header.utilities')
assert.equal(seat.options.id, 'dsh-conversation-find')
assert.equal(seat.options.order, 20)
assert.equal(typeof seat.component, 'function')
const injected = registrations.find((entry) => entry.injected !== undefined)
assert.equal(injected.injected, 'conversation.session.header.utilities')

console.log('smoke test passed: 4 hits, seat registered, plugin shape valid')
