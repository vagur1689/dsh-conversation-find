/**
 * Behavioural test: the panel opens, drives the match counter, cycles through
 * hits, and tears down cleanly. Rect-based painting is stubbed out by jsdom
 * (getClientRects returns nothing), so this asserts the state machine and the
 * DOM surface the user actually touches, not the overlay geometry.
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
      <div class="msg">alpha beta gamma</div>
      <div class="msg">beta appears again</div>
      <div class="msg">nothing here</div>
    </div>
  </div>
</body></html>`, { url: 'http://127.0.0.1:3080/' })

const { window } = dom
global.window = window
global.document = window.document
global.NodeFilter = window.NodeFilter
window.requestAnimationFrame = (fn) => setTimeout(() => fn(0), 0)
window.cancelAnimationFrame = (id) => clearTimeout(id)
window.Element.prototype.scrollTo = function scrollTo() {}
/* jsdom has no layout: give the port a box and every match a rect so the
   overlay painter runs its real clipping/marking path. */
window.Element.prototype.getBoundingClientRect = function () {
  return { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 }
}
window.Range.prototype.getClientRects = function () {
  return [{ top: 120, bottom: 140, left: 60, right: 140, width: 80, height: 20 }]
}

let spec
window.__ModuleLoader__ = { load: (value) => { spec = value } }
vm.runInThisContext(fs.readFileSync(SOURCE, 'utf8'), { filename: SOURCE })
const plugin = spec.factory((name) => {
  if (name === 'react') return { createElement: () => null }
  throw new Error(`unexpected require: ${name}`)
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const panel = () => window.document.querySelector('.dcf-panel')

;(async () => {
  const controller = plugin.__internals.createController()
  /* A fully loaded session: no older pages, so opening the panel must not
     degrade the counter with a history warning. */
  controller.attach({
    get: () => ({
      binding: () => ({
        session: { getSnapshot: () => ({ hasMore: false }), loadOlder: async () => {} }
      })
    })
  })

  controller.open()
  assert.ok(panel(), 'panel is mounted on open')
  const input = panel().querySelector('input')
  assert.equal(panel().querySelector('.dcf-count').textContent, '0/0', 'empty query shows 0/0')

  input.value = 'beta'
  input.dispatchEvent(new window.Event('input'))
  await wait(260)
  assert.equal(panel().querySelector('.dcf-count').textContent, '1/2', 'first hit selected after typing')

  const hits = window.document.querySelectorAll('.dcf-hit')
  assert.equal(hits.length, 2, 'one overlay box per visible match')
  assert.equal([...hits].filter((box) => box.dataset.current === 'true').length, 1, 'exactly one box is the current hit')
  assert.equal(hits[0].style.width, '80px', 'box geometry comes from the match rect')

  panel().querySelectorAll('.dcf-btn')[1].dispatchEvent(new window.Event('click'))
  assert.equal(panel().querySelector('.dcf-count').textContent, '2/2', 'next advances the counter')

  panel().querySelectorAll('.dcf-btn')[1].dispatchEvent(new window.Event('click'))
  assert.equal(panel().querySelector('.dcf-count').textContent, '1/2', 'next wraps around')

  panel().querySelectorAll('.dcf-btn')[0].dispatchEvent(new window.Event('click'))
  assert.equal(panel().querySelector('.dcf-count').textContent, '2/2', 'prev wraps backwards')

  const escape = new window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  input.dispatchEvent(escape)
  assert.equal(panel(), null, 'Escape closes and unmounts the panel')
  assert.equal(window.document.querySelector('.dcf-layer'), null, 'the highlight layer is released too')

  controller.detach()
  console.log('behaviour test passed: open → 1/2 → 2/2 → wrap → close')
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
