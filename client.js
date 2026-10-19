/**
 * dsh-conversation-find — browser client bundle.
 *
 * Adds keyword search inside the CURRENT conversation, with scroll-to-match.
 * This is deliberately a DOM-level feature: the official Trajectory view can
 * search its own ledger, but its own README states that record/timeline
 * selection is local "with no anchor deep links", so nothing there can move the
 * chat viewport. The conversation view does not virtualize its message rows, so
 * every rendered message is a real node under
 * `[data-conversation-scroll]` — finding a text range and scrolling its client
 * rect into view is exact, and it needs no client-runtime internals (which
 * `@deepseek-ai/dsh-client-runtime` used to provide and 0.2.x no longer ships).
 *
 * Matching is character-level through a Range, but highlighting never mutates
 * React-owned markup: hits are painted by a pointer-events:none overlay layer
 * positioned from live client rects, so a re-render or a streaming update can
 * never leave stale markup behind.
 *
 * Scope: only the conversation that is open right now, and only content the
 * view has actually rendered (older pages that were never expanded are not in
 * the DOM). Cross-session search is out of scope for this build.
 */
window.__ModuleLoader__.load({
	id: "dsh-conversation-find",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		const React = require("react");

		const PLUGIN_ID = "dsh-conversation-find";
		const OWN_ATTR = "data-dsh-conversation-find";
		const SCROLL_SELECTOR = "[data-conversation-scroll]";
		const SESSION_ATTR = "data-conversation-session";
		const COMPOSER_SELECTOR = "[data-composer-seat]";
		const STYLE_ID = "dsh-conversation-find-style";
		/* A long conversation can hold tens of thousands of characters; both caps
		   keep one keystroke bounded (matches) and one paint bounded (boxes). */
		const MAX_MATCHES = 2000;
		const MAX_BOXES = 400;
		/* The conversation keeps a window, not the whole transcript: `hasMore` says
		   older pages remain. Searching "all history" therefore means paging the
		   session back to its start first. The cap keeps one search from turning a
		   pathological session into an unbounded download; hitting it is reported,
		   never hidden. */
		const MAX_HISTORY_PAGES = 400;
		const SEARCH_DEBOUNCE_MS = 160;
		const STREAM_DEBOUNCE_MS = 400;

		const CSS = `
.dcf-panel{position:fixed;z-index:60;display:flex;align-items:center;gap:4px;padding:5px 7px;border-radius:10px;background:var(--dsw-alias-bg-layer-1,#1b1b1f);border:.5px solid var(--dsw-alias-border-l2,rgba(255,255,255,.16));box-shadow:0 8px 28px rgba(0,0,0,.28);font:12px/1.4 var(--ds-font-family-ui,system-ui,sans-serif);color:var(--dsw-alias-label-primary,#e8e8ea)}
.dcf-panel input{box-sizing:border-box;width:200px;height:24px;padding:0 8px;border-radius:6px;border:.5px solid var(--dsw-alias-border-l4,rgba(255,255,255,.28));background:var(--dsw-alias-bg-layer-2,rgba(255,255,255,.06));color:inherit;font:inherit;outline:none}
.dcf-panel input:focus{border-color:var(--dsw-alias-state-business-primary,#4c8dff)}
.dcf-count{min-width:54px;text-align:center;font-variant-numeric:tabular-nums;color:var(--dsw-alias-label-caption,rgba(232,232,234,.68))}
.dcf-btn{width:24px;height:24px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:inherit;cursor:pointer;font:14px/1 system-ui,sans-serif;padding:0}
.dcf-btn:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
.dcf-btn:disabled{opacity:.35;cursor:default}
.dcf-layer{position:fixed;inset:0;pointer-events:none;z-index:55}
.dcf-hit{position:absolute;border-radius:2px;background:rgba(255,193,7,.32);box-shadow:0 0 0 1px rgba(255,193,7,.42)}
.dcf-hit[data-current="true"]{background:rgba(255,140,0,.5);box-shadow:0 0 0 1px rgba(255,140,0,.95)}
.dcf-trigger{width:22px;height:22px;display:inline-flex;align-items:center;justify-content:center;border:0;border-radius:6px;background:transparent;color:var(--dsw-alias-label-tertiary,rgba(232,232,234,.62));cursor:pointer;padding:0}
.dcf-trigger:hover{color:var(--dsw-alias-label-primary,#e8e8ea);background:var(--dsw-alias-interactive-bg-hover,rgba(255,255,255,.1))}
`;

		/** Inject the plugin sheet once per document; a rebuild swaps it in place. */
		function ensureStyles() {
			if (typeof document === "undefined") return;
			let el = document.getElementById(STYLE_ID);
			if (el === null) {
				el = document.createElement("style");
				el.id = STYLE_ID;
				el.setAttribute(OWN_ATTR, "");
				(headOf())?.appendChild(el);
			}
			if (el.textContent !== CSS) el.textContent = CSS;
		}

		function headOf() {
			return document.head ?? document.documentElement;
		}

		/** One line of human-readable text for a failed store call. */
		function describeError(error) {
			if (error === undefined || error === null) return "未知错误";
			if (typeof error === "string") return error;
			return error.message ?? String(error);
		}

		/** The scrolling column that owns every rendered message row. */
		function getPort() {
			if (typeof document === "undefined") return undefined;
			return document.querySelector(SCROLL_SELECTOR) ?? undefined;
		}

		/** Session the open conversation belongs to, so a switch can close the panel. */
		function currentSessionId() {
			const holder = document.querySelector("[data-conversation-session]");
			return holder?.getAttribute(SESSION_ATTR) ?? undefined;
		}

		/* Characters the last collect() walk actually covered — surfaced in the
		   panel so "no results" can be told apart from "nothing was scanned". */
		let lastScanned = 0;

		/**
		 * Every text range matching the normalized query, in document order.
		 *
		 * Skipped on purpose: our own UI, the composer seat (a draft is not
		 * conversation content), and non-content tags.
		 */
		function collect(query) {
			/* An empty needle matches at every offset: refuse it here, not only at
			   the call site, so a future caller cannot turn it into a 2000-hit scan. */
			if (query.length === 0) return [];
			lastScanned = 0;
			const port = getPort();
			if (port === undefined) return [];
			const out = [];
			const walker = document.createTreeWalker(port, NodeFilter.SHOW_TEXT, {
				acceptNode(node) {
					const parent = node.parentElement;
					if (parent === null) return NodeFilter.FILTER_REJECT;
					if (parent.closest(`[${OWN_ATTR}]`) !== null) return NodeFilter.FILTER_REJECT;
					if (parent.closest(COMPOSER_SELECTOR) !== null) return NodeFilter.FILTER_REJECT;
					const tag = parent.tagName;
					if (tag === "SCRIPT" || tag === "STYLE" || tag === "NOSCRIPT") return NodeFilter.FILTER_REJECT;
					const text = node.nodeValue;
					if (text === null || text.length === 0) return NodeFilter.FILTER_REJECT;
					return NodeFilter.FILTER_ACCEPT;
				}
			});
			for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
				const text = node.nodeValue;
				if (text === null) continue;
				lastScanned += text.length;
				const haystack = text.toLowerCase();
				let from = 0;
				while (out.length < MAX_MATCHES) {
					const at = haystack.indexOf(query, from);
					if (at < 0) break;
					out.push({ node, start: at, end: at + query.length });
					from = at + Math.max(1, query.length);
				}
				if (out.length >= MAX_MATCHES) break;
			}
			return out;
		}

		function rangeOf(match) {
			const range = document.createRange();
			range.setStart(match.node, match.start);
			range.setEnd(match.node, match.end);
			return range;
		}

		/**
		 * One search controller per page.
		 *
		 * Two mounts of the same bundle (a rebuild swap, or a second composition)
		 * must not own two panels or two sets of listeners: the reference count in
		 * attach()/detach() makes the first mount own the surface and the last
		 * unmount release it.
		 */
		function createController() {
			const state = {
				refs: 0,
				open: false,
				query: "",
				matches: [],
				current: -1,
				session: undefined,
				panel: undefined,
				input: undefined,
				count: undefined,
				prev: undefined,
				next: undefined,
				layer: undefined,
				portObserver: undefined,
				port: undefined,
				sessionObserver: undefined,
				raf: 0,
				searchTimer: 0,
				streamTimer: 0,
				/* The `sessions` client service, so history can be paged back to the
				   session start; undefined when the seat is mounted without it. */
				sessions: undefined,
				ctx: undefined,
				loadingHistory: false,
				loadedPages: 0,
				historyPartial: false,
				historyError: "",
				scanned: 0,
				loadToken: 0,
				onScroll: undefined,
				onResize: undefined,
				onKey: undefined
			};

			function schedulePaint() {
				if (state.raf !== 0) return;
				state.raf = window.requestAnimationFrame(() => {
					state.raf = 0;
					paint();
				});
			}

			function ensureLayer() {
				if (state.layer !== undefined && state.layer.isConnected) return state.layer;
				const layer = document.createElement("div");
				layer.className = "dcf-layer";
				layer.setAttribute(OWN_ATTR, "");
				document.body.appendChild(layer);
				state.layer = layer;
				return layer;
			}

			function clearLayer() {
				if (state.layer !== undefined) {
					state.layer.remove();
					state.layer = undefined;
				}
			}

			/** Repaint every hit rect that still intersects the scroll port. */
			function paint() {
				if (!state.open) {
					clearLayer();
					return;
				}
				if (state.session !== undefined && currentSessionId() !== state.session) {
					close();
					return;
				}
				const port = getPort();
				if (port === undefined) {
					clearLayer();
					return;
				}
				const portRect = port.getBoundingClientRect();
				if (portRect.width === 0 || portRect.height === 0) {
					clearLayer();
					return;
				}
				const layer = ensureLayer();
				const fragment = document.createDocumentFragment();
				let boxes = 0;
				for (let i = 0; i < state.matches.length && boxes < MAX_BOXES; i++) {
					const match = state.matches[i];
					if (match.node.isConnected !== true) continue;
					let rects;
					try {
						rects = rangeOf(match).getClientRects();
					} catch {
						continue;
					}
					for (let j = 0; j < rects.length && boxes < MAX_BOXES; j++) {
						const rect = rects[j];
						if (rect.width <= 0 || rect.height <= 0) continue;
						const top = Math.max(rect.top, portRect.top);
						const bottom = Math.min(rect.bottom, portRect.bottom);
						if (bottom - top <= 0) continue;
						const box = document.createElement("div");
						box.className = "dcf-hit";
						box.dataset.current = String(i === state.current);
						box.style.top = `${top}px`;
						box.style.left = `${rect.left}px`;
						box.style.width = `${rect.width}px`;
						box.style.height = `${bottom - top}px`;
						fragment.appendChild(box);
						boxes += 1;
					}
				}
				layer.replaceChildren(fragment);
			}

			function updateCount() {
				if (state.count === undefined) return;
				const total = state.matches.length;
				if (state.loadingHistory) {
					state.count.textContent = `加载历史 ${state.loadedPages}`;
					state.count.title = "正在把会话历史翻到最早一页，完成后即可搜索全部消息";
					if (state.prev !== undefined) state.prev.disabled = true;
					if (state.next !== undefined) state.next.disabled = true;
					return;
				}
				const flags = [];
				if (state.historyError !== "") flags.push(`历史加载失败: ${state.historyError}`);
				if (state.historyPartial) flags.push(`历史未加载完（已翻 ${state.loadedPages} 页）`);
				flags.push(`已扫描 ${state.scanned} 字`);
				state.count.textContent = total === 0 ? "0/0" : `${state.current + 1}/${total}`;
				state.count.title = flags.join(" · ");
				/* A degraded scan must be visible without hovering the counter. */
				const degraded = state.historyError !== "" || state.historyPartial;
				state.count.textContent = `${degraded ? "⚠ " : ""}${state.count.textContent}`;
				if (state.prev !== undefined) state.prev.disabled = total === 0;
				if (state.next !== undefined) state.next.disabled = total === 0;
			}

			/** The current session's client store (paging + snapshot), when reachable. */
			function sessionStore() {
				/* Resolve lazily on every call: capturing the service once at attach can
				   grab it before it is registered, and that stale undefined then makes
				   every later history pass a silent no-op. */
				let sessions = state.sessions;
				try {
					sessions = state.ctx?.get?.("sessions") ?? sessions;
					state.sessions = sessions;
				} catch {
					/* fall back to the captured reference */
				}
				const id = currentSessionId();
				if (sessions === undefined || id === undefined) return undefined;
				try {
					return sessions.binding(id)?.session;
				} catch {
					return undefined;
				}
			}

			/**
			 * Page the session back to its earliest loaded window.
			 *
			 * The conversation keeps only a window of the transcript in the DOM, so
			 * "search everything" has to fetch the rest first. The view reacts to the
			 * `loadingOlder` transition by preserving the reader's scroll position, so
			 * driving the store directly does not yank the viewport.
			 */
			async function loadAllHistory() {
				state.historyError = "";
				const session = sessionStore();
				if (session === undefined) {
					state.historyError = "拿不到会话 store（sessions 服务不可用或会话未绑定）";
					updateCount();
					return;
				}
				let snapshot;
				try {
					snapshot = session.getSnapshot();
				} catch (error) {
					state.historyError = describeError(error);
					updateCount();
					return;
				}
				if (snapshot?.hasMore !== true) return;
				const token = ++state.loadToken;
				state.loadingHistory = true;
				state.historyPartial = false;
				state.loadedPages = 0;
				updateCount();
				try {
					while (state.open && token === state.loadToken) {
						let more;
						try {
							more = session.getSnapshot().hasMore === true;
						} catch (error) {
							state.historyError = describeError(error);
							break;
						}
						if (!more) break;
						if (state.loadedPages >= MAX_HISTORY_PAGES) {
							state.historyPartial = true;
							break;
						}
						state.loadedPages += 1;
						updateCount();
						try {
							await session.loadOlder();
						} catch (error) {
							state.historyError = describeError(error);
							break;
						}
					}
				} finally {
					if (token !== state.loadToken) return;
					state.loadingHistory = false;
					updateCount();
					/* React commits the prepended page asynchronously; one frame later the
					   DOM holds the rows this pass is supposed to search. */
					if (typeof window.requestAnimationFrame === "function") {
						window.requestAnimationFrame(() => {
							if (state.open) refresh(false);
						});
					} else {
						refresh(false);
					}
				}
			}

			/** Scroll the given match to the vertical middle of the port. */
			function goTo(index) {
				const total = state.matches.length;
				if (total === 0) {
					updateCount();
					paint();
					return;
				}
				state.current = ((index % total) + total) % total;
				const match = state.matches[state.current];
				const port = getPort();
				try {
					const rect = rangeOf(match).getBoundingClientRect();
					if (port !== undefined) {
						const portRect = port.getBoundingClientRect();
						const target = port.scrollTop + (rect.top - portRect.top) - Math.max(0, (portRect.height - rect.height) / 2);
						port.scrollTo({ top: Math.max(0, target), behavior: "smooth" });
					}
				} catch {
					/* A record that vanished between paint and jump is not an error. */
				}
				updateCount();
				paint();
			}

			/** Recompute the match set for the current query. */
			function refresh(jumpToFirst) {
				const query = state.query.trim().toLowerCase();
				if (query.length === 0) {
					state.matches = [];
					state.current = -1;
					updateCount();
					paint();
					return;
				}
				state.matches = collect(query);
				state.scanned = lastScanned;
				state.current = state.matches.length === 0 ? -1 : Math.min(Math.max(state.current, 0), state.matches.length - 1);
				updateCount();
				if (jumpToFirst && state.matches.length > 0) goTo(0);
				else paint();
			}

			function scheduleSearch() {
				window.clearTimeout(state.searchTimer);
				state.searchTimer = window.setTimeout(() => {
					state.searchTimer = 0;
					refresh(true);
				}, SEARCH_DEBOUNCE_MS);
			}

			function scheduleStreamRefresh() {
				window.clearTimeout(state.streamTimer);
				state.streamTimer = window.setTimeout(() => {
					state.streamTimer = 0;
					if (state.open) refresh(false);
				}, STREAM_DEBOUNCE_MS);
			}

			/** Watch the current port for streamed text, and the shell for session switches. */
			function observe(port) {
				/* Read the constructor off window: a bare MutationObserver reference is a
				   ReferenceError in any environment that exposes it only on the global
				   object, and the watchers are an optimization, not a requirement. */
				const Watcher = window.MutationObserver;
				if (Watcher === undefined) return;
				if (state.port !== port) {
					if (state.portObserver !== undefined) state.portObserver.disconnect();
					state.port = port;
					if (port !== undefined) {
						state.portObserver = new Watcher(scheduleStreamRefresh);
						state.portObserver.observe(port, { childList: true, subtree: true, characterData: true });
					}
				}
				if (state.sessionObserver === undefined) {
					state.sessionObserver = new Watcher(() => {
						if (state.open && state.session !== undefined && currentSessionId() !== state.session) close();
					});
					state.sessionObserver.observe(document.documentElement, {
						attributes: true,
						subtree: true,
						attributeFilter: [SESSION_ATTR]
					});
				}
			}

			function placePanel() {
				if (state.panel === undefined) return;
				const port = getPort();
				if (port === undefined) {
					state.panel.style.top = "64px";
					state.panel.style.right = "24px";
					return;
				}
				const rect = port.getBoundingClientRect();
				state.panel.style.top = `${Math.max(8, rect.top + 10)}px`;
				state.panel.style.right = `${Math.max(8, window.innerWidth - rect.right + 14)}px`;
			}

			function buildPanel() {
				if (state.panel !== undefined && state.panel.isConnected) return state.panel;
				const panel = document.createElement("div");
				panel.className = "dcf-panel";
				panel.setAttribute(OWN_ATTR, "");
				panel.setAttribute("role", "search");

				const input = document.createElement("input");
				input.type = "search";
				input.placeholder = "在当前会话中查找";
				input.setAttribute("aria-label", "在当前会话中查找");
				input.value = state.query;
				input.addEventListener("input", () => {
					state.query = input.value;
					scheduleSearch();
				});
				/* The composer and the shell own global hotkeys; a keystroke aimed at
				   this field must never reach them. */
				input.addEventListener("keydown", (event) => {
					event.stopPropagation();
					if (event.key === "Escape") {
						event.preventDefault();
						close();
						return;
					}
					if (event.key === "Enter") {
						event.preventDefault();
						goTo(state.current + (event.shiftKey ? -1 : 1));
					}
				});

				const count = document.createElement("span");
				count.className = "dcf-count";

				const prev = document.createElement("button");
				prev.type = "button";
				prev.className = "dcf-btn";
				prev.textContent = "↑";
				prev.title = "上一个（Shift + Enter）";
				prev.addEventListener("click", () => goTo(state.current - 1));

				const next = document.createElement("button");
				next.type = "button";
				next.className = "dcf-btn";
				next.textContent = "↓";
				next.title = "下一个（Enter）";
				next.addEventListener("click", () => goTo(state.current + 1));

				const closeButton = document.createElement("button");
				closeButton.type = "button";
				closeButton.className = "dcf-btn";
				closeButton.textContent = "✕";
				closeButton.title = "关闭（Esc）";
				closeButton.addEventListener("click", () => close());

				panel.append(input, count, prev, next, closeButton);
				document.body.appendChild(panel);
				state.panel = panel;
				state.input = input;
				state.count = count;
				state.prev = prev;
				state.next = next;
				return panel;
			}

			function open() {
				if (state.open) {
					state.input?.focus();
					state.input?.select();
					return;
				}
				state.open = true;
				state.session = currentSessionId();
				const port = getPort();
				observe(port);
				buildPanel();
				placePanel();
				updateCount();
				refresh(false);
				state.input?.focus();
				state.input?.select();
				/* Coverage first, search second: a session that still has older pages
				   would otherwise answer "not found" for text it simply has not loaded. */
				loadAllHistory();
			}

			function close() {
				if (!state.open) return;
				state.open = false;
				/* Bump the token so an in-flight history pass stops paging immediately. */
				state.loadToken += 1;
				state.loadingHistory = false;
				state.loadedPages = 0;
				state.historyPartial = false;
				state.query = "";
				state.matches = [];
				state.current = -1;
				window.clearTimeout(state.searchTimer);
				window.clearTimeout(state.streamTimer);
				state.searchTimer = 0;
				state.streamTimer = 0;
				clearLayer();
				state.panel?.remove();
				state.panel = undefined;
				state.input = undefined;
				state.count = undefined;
				state.prev = undefined;
				state.next = undefined;
				state.portObserver?.disconnect();
				state.portObserver = undefined;
				state.port = undefined;
			}

			function toggle() {
				if (state.open) close();
				else open();
			}

			function onScroll() {
				if (state.open) schedulePaint();
			}

			function onResize() {
				if (!state.open) return;
				placePanel();
				schedulePaint();
			}

			function onKey(event) {
				const modifier = event.metaKey || event.ctrlKey;
				if (modifier && event.shiftKey && (event.key === "f" || event.key === "F")) {
					event.preventDefault();
					event.stopPropagation();
					toggle();
					return;
				}
				if (event.key === "Escape" && state.open) {
					event.preventDefault();
					close();
				}
			}

			function attach(ctx) {
				state.refs += 1;
				if (ctx !== undefined) {
					state.ctx = ctx;
					try {
						state.sessions = ctx.get?.("sessions");
					} catch {
						state.sessions = undefined;
					}
				}
				if (state.refs > 1) return;
				ensureStyles();
				window.addEventListener("keydown", onKey, true);
				window.addEventListener("resize", onResize);
				document.addEventListener("scroll", onScroll, true);
			}

			function detach() {
				state.refs = Math.max(0, state.refs - 1);
				if (state.refs > 0) return;
				close();
				state.sessionObserver?.disconnect();
				state.sessionObserver = undefined;
				window.removeEventListener("keydown", onKey, true);
				window.removeEventListener("resize", onResize);
				document.removeEventListener("scroll", onScroll, true);
				window.cancelAnimationFrame(state.raf);
				state.raf = 0;
			}

			return { attach, detach, toggle, open, close };
		}

		/* One controller per page, shared across duplicate mounts of this bundle. */
		const controller = (() => {
			if (typeof window === "undefined") return undefined;
			if (window.__dshConversationFind !== undefined) return window.__dshConversationFind;
			const created = createController();
			window.__dshConversationFind = created;
			return created;
		})();

		/** Header utility: the search affordance beside the session actions. */
		function FindButton() {
			return React.createElement(
				"button",
				{
					type: "button",
					className: "dcf-trigger",
					title: "在当前会话中查找（⌘/Ctrl + Shift + F）",
					"aria-label": "在当前会话中查找",
					onClick: (event) => {
						event.preventDefault();
						event.stopPropagation();
						controller?.toggle();
					}
				},
				React.createElement(
					"svg",
					{ width: 14, height: 14, viewBox: "0 0 16 16", fill: "none", "aria-hidden": "true" },
					React.createElement("circle", { cx: "7", cy: "7", r: "4.5", stroke: "currentColor", strokeWidth: "1.3" }),
					React.createElement("path", { d: "M10.6 10.6L14 14", stroke: "currentColor", strokeWidth: "1.3", strokeLinecap: "round" })
				)
			);
		}

		function apply(ctx) {
			ctx.effect(() => {
				ensureStyles();
				controller?.attach(ctx);
				const off = ctx.slots.inject("conversation.session.header.utilities", () =>
					ctx.slots.register(
						{
							name: "conversation.session.header.utilities",
							id: PLUGIN_ID,
							order: 20,
							registrant: PLUGIN_ID
						},
						FindButton
					)
				);
				return () => {
					try {
						off();
					} catch {}
					controller?.detach();
				};
			}, "dsh-conversation-find: header search + shortcuts");
		}

		exports.name = PLUGIN_ID;
		/* `sessions` must be declared here, not merely reached through ctx.get at
		   runtime: an undeclared service is not available to this fiber, so the
		   history pass below would silently find nothing to page. */
		exports.inject = ["slots", "sessions"];
		exports.apply = apply;
		/* Exposed for smoke tests in a DOM stub; not part of the plugin contract. */
		exports.__internals = { collect, createController };
		return module.exports;
	}
});
