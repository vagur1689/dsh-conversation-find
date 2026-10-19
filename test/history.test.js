/**
 * History-paging test: the plugin must page a windowed session back to its
 * start before it claims to have searched "all" of it, and must report (not
 * hide) the case where the page cap is hit.
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
      <div data-chat-flow>
        <div class="msg">newest message body</div>
      </div>
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
window.Element.prototype.getBoundingClientRect = function () {
  return { top: 0, bottom: 600, left: 0, right: 800, width: 800, height: 600 }
}
window.Range.prototype.getClientRects = function () {
  return [{ top: 100, bottom: 120, left: 40, right: 120, width: 80, height: 20 }]
}

let spec
window.__ModuleLoader__ = { load: (value) => { spec = value } }
vm.runInThisContext(fs.readFileSync(SOURCE, 'utf8'), { filename: SOURCE })
const plugin = spec.factory((name) => {
  if (name === 'react') return { createElement: () => null }
  throw new Error(`unexpected require: ${name}`)
})

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** A windowed session: page 1 holds the newest message, page 2 an older one. */
function makeSession({ pages = 1, capProbe = false } = {}) {
  let remaining = pages
  const flow = window.document.querySelector('[data-chat-flow]')
  return {
    getSnapshot() {
      return { hasMore: remaining > 0, loadingOlder: false }
    },
    async loadOlder() {
      if (remaining <= 0) return
      remaining -= 1
      const row = window.document.createElement('div')
      row.className = 'msg'
      row.textContent = `older page ${pages - remaining}: legacy keyword marker`
      flow.prepend(row)
      if (capProbe) remaining = 1 // never drains, so the cap must stop the loop
    }
  }
}

function mountController(session) {
  const ctx = {
    get: (name) => (name === 'sessions' ? { binding: () => ({ session }) } : undefined)
  }
  const controller = plugin.__internals.createController()
  controller.attach(ctx)
  return controller
}

const panelCount = () => window.document.querySelector('.dcf-panel .dcf-count')

;(async () => {
  // 1) A session with two older pages: after opening, the older text is searchable.
  {
    const session = makeSession({ pages: 2 })
    const controller = mountController(session)
    controller.open()
    await wait(120)
    const input = window.document.querySelector('.dcf-panel input')
    input.value = 'legacy keyword marker'
    input.dispatchEvent(new window.Event('input'))
    await wait(320)
    const text = panelCount().textContent
    assert.match(text, /^1\/2$/, `expected both paged-in rows to match, got ${text}`)
    assert.equal(session.getSnapshot().hasMore, false, 'history was paged to the start')
    controller.close()
    controller.detach()
  }

  // 2) The page cap is reported, never silently swallowed.
  {
    session2 = makeSession({ pages: 5, capProbe: true })
    const controller = mountController(session2)
    controller.open()
    await wait(700)
    const title = panelCount().title
    assert.match(title, /历史未加载完/, `expected a partial-history notice, got "${title}"`)
    controller.close()
    controller.detach()
  }

  // 3) Closing mid-pass stops the paging loop instead of draining the session.
  {
    let calls = 0
    const session3 = {
      getSnapshot: () => ({ hasMore: true, loadingOlder: false }),
      async loadOlder() {
        calls += 1
        await wait(20)
      }
    }
    const controller = mountController(session3)
    controller.open()
    await wait(60)
    controller.close()
    const atClose = calls
    await wait(200)
    assert.equal(calls, atClose, 'no further pages are pulled after close')
    controller.detach()
  }

  // 4) A missing sessions service must be visible, never a silent no-op: that
  //    was the failure mode when the bundle did not declare the service.
  {
    const controller = plugin.__internals.createController()
    controller.attach()
    controller.open()
    await wait(40)
    const count = window.document.querySelector('.dcf-panel .dcf-count')
    assert.ok(count.textContent.startsWith('⚠ '), `expected a warning marker, got "${count.textContent}"`)
    assert.match(count.title, /会话/, `expected the title to explain the missing store, got "${count.title}"`)
    controller.close()
    controller.detach()
  }

  console.log(`history test passed: paged-in rows searchable, cap reported, close aborts, missing store surfaced`)
})().catch((error) => {
  console.error(error)
  process.exit(1)
})
