window.__ModuleLoader__.load({
	id: "dsh-plugin-completion-notify",
	factory: () => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

		//#region lib/types/client/plugin.js
		/**
		 * Browser half of the completion-notify bundle: when a session finishes a
		 * turn, raise a native system notification carrying the session title and a
		 * summary of the finished turn; clicking it focuses the window and returns
		 * to that session.
		 *
		 * The DSH desktop shell replaces `window.Notification` with a bridge to
		 * native macOS notifications, so this is the primary channel and it reaches
		 * the person even when another application covers the DSH window. The
		 * in-page card stays as a last-resort fallback for a plain browser whose
		 * notification permission was refused.
		 *
		 * Data comes from public Client surfaces only:
		 * - `remote.$on('api-session/status')` — the host's running-state push;
		 * - `remote.session.projections` — a fresh host read of `turnOutline`
		 *   (bounded prompt/response previews) and `title`;
		 * - `sessions.list` — title and subagent lineage;
		 * - `uiWorkspace.openSession` — navigation back to the session.
		 */

		/** Notification title when the host projects no title yet. */
		const FALLBACK_TITLE = "会话已完成";
		/** Suppress a second alert for the same session inside this window. */
		const COOLDOWN_MS = 4000;
		/** One-time welcome marker, so it never repeats. */
		const WELCOME_KEY = "dsh-completion-notify:welcome";
		/** Turn-end reasons that are not worth a "finished" alert. */
		const SILENT_REASONS = new Set(["aborted", "interrupted", "archived"]);
		/** How long a fallback card stays before it fades out. */
		const CARD_MS = 20000;
		/** Oldest fallback cards beyond this count are dropped first. */
		const CARD_LIMIT = 3;
		/** Host id of the fallback stack, so a hot reload replaces rather than stacks. */
		const STACK_ID = "dsh-completion-notify-stack";

		/** Required services: session list, Remote calls, the status event, and navigation. */
		const inject = ["sessions", "remote", "remote.session", "uiWorkspace"];

		/**
		 * Ask the host why the session's last turn ended, when the desktop shell
		 * offers the route. A user stop or an archived session stays silent.
		 * @param sessionId - session that just stopped.
		 * @returns true when the alert should be skipped.
		 */
		async function endedQuietly(sessionId) {
			try {
				const response = await fetch(`/api/tauri/notification/turn-end?sessionId=${encodeURIComponent(sessionId)}`, { headers: { accept: "application/json" } });
				if (!response.ok) return false;
				const fact = await response.json();
				return typeof fact?.reason === "string" && SILENT_REASONS.has(fact.reason);
			} catch {
				return false;
			}
		}

		/**
		 * Read the finished turn's bounded previews and the session title.
		 * The projection read is a fresh host read (not the cached list block), so
		 * the body always describes the turn that just ended.
		 * @param ctx - client root context.
		 * @param sessionId - session that just stopped.
		 * @returns title and body, both non-empty.
		 */
		async function describe(ctx, sessionId) {
			let title;
			let body = "";
			let row;
			try {
				row = ctx.sessions.list.getSnapshot().byId[sessionId];
				title = row?.title || row?.displayTitle;
			} catch {}
			try {
				const controller = new AbortController();
				const result = await ctx.remote.session.projections({ sessionId }, controller.signal);
				if (result.ok && result.value && result.value.values) {
					const values = result.value.values;
					if (typeof values.title === "string" && values.title !== "") title = values.title;
					const outline = values.turnOutline;
					if (Array.isArray(outline) && outline.length > 0) {
						const last = outline[outline.length - 1];
						const response = typeof last?.response === "string" ? last.response.trim() : "";
						const prompt = typeof last?.prompt === "string" ? last.prompt.trim() : "";
						body = response || prompt;
					}
				}
			} catch {}
			if (body === "") body = "回合已完成，点击回到该会话查看结果。";
			return {
				title: title || FALLBACK_TITLE,
				body
			};
		}

		/**
		 * Deliver one native notification. The desktop shell bridges this to a macOS
		 * banner; a plain browser uses its own Notification API.
		 * @param sessionId - session to open on click, absent for the welcome probe.
		 * @param title - notification title.
		 * @param body - notification body.
		 * @param open - navigation performed on click, absent for the welcome probe.
		 * @returns false when the platform cannot show one, so the caller falls back.
		 */
		function deliverNative(sessionId, title, body, open) {
			if (typeof Notification === "undefined") return false;
			try {
				if (Notification.permission === "denied") return false;
			} catch {}
			const options = { body, silent: false };
			if (typeof sessionId === "string" && sessionId !== "") {
				options.tag = `dsh-notification-${sessionId}-${Date.now()}`;
				options.sessionId = sessionId;
			}
			let notification;
			try {
				notification = new Notification(title, options);
			} catch (error) {
				console.warn("completion-notify: native notification rejected", error);
				return false;
			}
			notification.onclick = () => {
				try {
					notification.close();
				} catch {}
				try {
					window.focus();
				} catch {}
				try {
					open?.();
				} catch (error) {
					console.warn("completion-notify: notification click failed", error);
				}
			};
			return true;
		}

		/** Fallback card styles; a shadow root keeps them away from the application's. */
		const STYLE = `
:host { all: initial; }
.stack {
	position: fixed;
	top: 0;
	right: 10px;
	z-index: 2147483000;
	display: flex;
	flex-direction: column;
	gap: 10px;
	width: 360px;
	max-width: calc(100vw - 28px);
	pointer-events: none;
	font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif;
}
.card {
	pointer-events: auto;
	position: relative;
	overflow: hidden;
	border-radius: 12px 0 12px 12px;
	padding: 9px 12px 11px;
	color: #1b1b1f;
	background: rgba(255, 255, 255, 0.94);
	border: 1px solid rgba(0, 0, 0, 0.08);
	box-shadow: 0 14px 34px rgba(0, 0, 0, 0.18), 0 2px 8px rgba(0, 0, 0, 0.08);
	-webkit-backdrop-filter: blur(14px) saturate(1.5);
	backdrop-filter: blur(14px) saturate(1.5);
	cursor: pointer;
	animation: dsh-completion-in 0.22s cubic-bezier(0.22, 0.9, 0.3, 1);
	transform-origin: top right;
}
.card.out {
	animation: dsh-completion-out 0.2s ease-in forwards;
}
@media (prefers-color-scheme: dark) {
	.card {
		color: #f2f2f5;
		background: rgba(40, 40, 45, 0.94);
		border-color: rgba(255, 255, 255, 0.1);
		box-shadow: 0 14px 34px rgba(0, 0, 0, 0.5), 0 2px 8px rgba(0, 0, 0, 0.35);
	}
}
.head {
	display: flex;
	align-items: center;
	gap: 8px;
	min-width: 0;
}
.dot {
	flex: none;
	width: 16px;
	height: 16px;
	border-radius: 50%;
	background: radial-gradient(circle at 30% 30%, #9fe870, #2f9e44);
	box-shadow: 0 0 0 3px rgba(47, 158, 68, 0.16);
}
.title {
	flex: 1;
	min-width: 0;
	font-size: 13px;
	font-weight: 600;
	letter-spacing: 0.01em;
	overflow: hidden;
	text-overflow: ellipsis;
	white-space: nowrap;
}
.close {
	flex: none;
	width: 18px;
	height: 18px;
	border: 0;
	padding: 0;
	border-radius: 5px;
	background: transparent;
	color: inherit;
	opacity: 0.45;
	cursor: pointer;
	font-size: 13px;
	line-height: 18px;
}
.close:hover { opacity: 0.9; background: rgba(127, 127, 127, 0.16); }
.body {
	margin-top: 5px;
	font-size: 12.5px;
	line-height: 1.5;
	color: #55555f;
	display: -webkit-box;
	-webkit-line-clamp: 3;
	-webkit-box-orient: vertical;
	overflow: hidden;
	word-break: break-word;
	white-space: pre-wrap;
}
@media (prefers-color-scheme: dark) {
	.body { color: #b6b6c0; }
}
.bar {
	position: absolute;
	left: 0;
	bottom: 0;
	height: 2px;
	width: 100%;
	background: linear-gradient(90deg, #4dabf7, #51cf66);
	transform-origin: left center;
	animation: dsh-completion-bar linear forwards;
	opacity: 0.75;
}
@keyframes dsh-completion-in {
	from { opacity: 0; transform: translate3d(18px, -6px, 0) scale(0.97); }
	to { opacity: 1; transform: none; }
}
@keyframes dsh-completion-out {
	to { opacity: 0; transform: translate3d(14px, 0, 0) scale(0.98); }
}
@keyframes dsh-completion-bar {
	from { transform: scaleX(1); }
	to { transform: scaleX(0); }
}
@media (prefers-reduced-motion: reduce) {
	.card, .card.out, .bar { animation: none; }
	.card.out { opacity: 0; }
}
`;

		/**
		 * Two-note chime for the fallback card, so the alert still has a voice when
		 * no native surface is available. Browsers hold the audio context until a
		 * gesture; every call retries a resume, and failure stays silent.
		 * @returns the play controls.
		 */
		function createChime() {
			let audio;
			const ensure = () => {
				const Ctor = window.AudioContext ?? window.webkitAudioContext;
				if (typeof Ctor !== "function") return undefined;
				if (audio === undefined) try {
					audio = new Ctor();
				} catch {
					return undefined;
				}
				if (audio.state === "suspended") try {
					void audio.resume().catch(() => {});
				} catch {}
				return audio;
			};
			return {
				/** Create and unlock the context on a gesture without making a sound. */
				resume() {
					ensure();
				},
				play() {
					const context_ = ensure();
					if (context_ === undefined) return;
					let now;
					try {
						now = context_.currentTime + 0.01;
					} catch {
						return;
					}
					for (const [frequency, offset, peak] of [[880, 0, 0.07], [1318.51, 0.13, 0.055]]) {
						try {
							const oscillator = context_.createOscillator();
							const gain = context_.createGain();
							oscillator.type = "sine";
							oscillator.frequency.value = frequency;
							gain.gain.setValueAtTime(0.0001, now + offset);
							gain.gain.exponentialRampToValueAtTime(peak, now + offset + 0.012);
							gain.gain.exponentialRampToValueAtTime(0.0001, now + offset + 0.42);
							oscillator.connect(gain).connect(context_.destination);
							oscillator.start(now + offset);
							oscillator.stop(now + offset + 0.45);
						} catch {}
					}
				}
			};
		}

		/**
		 * Own the fallback card stack for one plugin lifetime.
		 * @returns the stack controls, or undefined when the document is unavailable.
		 */
		function createStack() {
			if (typeof document === "undefined" || document.body === null) return undefined;
			const previous = document.getElementById(STACK_ID);
			if (previous !== null && previous.parentNode !== null) previous.parentNode.removeChild(previous);
			const host = document.createElement("div");
			host.id = STACK_ID;
			host.setAttribute("data-dsh-completion-notify", "1");
			const shadow = host.attachShadow({ mode: "open" });
			const style = document.createElement("style");
			style.textContent = STYLE;
			const stack = document.createElement("div");
			stack.className = "stack";
			stack.setAttribute("role", "region");
			stack.setAttribute("aria-label", "任务完成通知");
			shadow.append(style, stack);
			document.body.appendChild(host);
			const live = [];
			const drop = (item) => {
				const index = live.indexOf(item);
				if (index < 0) return;
				live.splice(index, 1);
				item.dismiss();
			};
			return {
				show({ title, body, onClick, duration = CARD_MS }) {
					while (live.length >= CARD_LIMIT) drop(live[0]);
					const card = document.createElement("div");
					card.className = "card";
					card.tabIndex = 0;
					card.setAttribute("role", "button");
					const head = document.createElement("div");
					head.className = "head";
					const dot = document.createElement("span");
					dot.className = "dot";
					const label = document.createElement("div");
					label.className = "title";
					label.textContent = title;
					const close = document.createElement("button");
					close.className = "close";
					close.type = "button";
					close.title = "关闭";
					close.setAttribute("aria-label", "关闭通知");
					close.textContent = "✕";
					head.append(dot, label, close);
					const text = document.createElement("div");
					text.className = "body";
					text.textContent = body;
					const bar = document.createElement("div");
					bar.className = "bar";
					bar.style.animationDuration = `${duration}ms`;
					card.append(head, text, bar);
					stack.appendChild(card);
					const item = {
						timer: 0,
						dismissed: false,
						dismiss() {
							if (this.dismissed) return;
							this.dismissed = true;
							if (this.timer !== 0) clearTimeout(this.timer);
							card.classList.add("out");
							setTimeout(() => {
								if (card.parentNode !== null) card.parentNode.removeChild(card);
							}, 220);
						}
					};
					const activate = () => {
						item.dismiss();
						try {
							window.focus();
						} catch {}
						try {
							onClick?.();
						} catch (error) {
							console.warn("completion-notify: card click failed", error);
						}
					};
					card.addEventListener("click", activate);
					card.addEventListener("keydown", (event) => {
						if (event.key === "Enter" || event.key === " ") {
							event.preventDefault();
							activate();
						}
					});
					close.addEventListener("click", (event) => {
						event.stopPropagation();
						item.dismiss();
					});
					item.timer = setTimeout(() => item.dismiss(), duration);
					live.push(item);
					return item;
				},
				dispose() {
					for (const item of live.splice(0)) item.dismiss();
					if (host.parentNode !== null) host.parentNode.removeChild(host);
				}
			};
		}

		/**
		 * Publish one alert: native first, the in-page card only when the platform
		 * cannot show a notification at all.
		 * @param ui - plugin runtime state (stack, chime, context).
		 * @param sessionId - session to open on click, absent for the welcome probe.
		 * @param title - alert title.
		 * @param body - alert body.
		 * @returns nothing.
		 */
		function announce(ui, sessionId, title, body) {
			const open = typeof sessionId === "string" && sessionId !== "" ? () => ui.ctx.uiWorkspace.openSession(sessionId) : undefined;
			// The shell's native banner carries no audible cue of its own on this
			// build, so the chime plays for both channels.
			ui.chime.play();
			if (deliverNative(sessionId, title, body, open)) return;
			// Built on first fallback use, so a working native surface never adds a
			// stray element to the page.
			ui.stack ??= createStack();
			ui.stack?.show({ title, body, onClick: open });
		}

		/**
		 * Browser plugin body: request permission when needed, then announce each
		 * finished turn.
		 * @param ctx - client root context.
		 * @returns nothing.
		 */
		function apply(ctx) {
			if (typeof window === "undefined") return;

			const ui = {
				ctx,
				stack: undefined,
				chime: createChime()
			};
			/** Last observed running state per session; alerts need a witnessed start. */
			const running = new Map();
			/** Last alert time per session, for the cooldown. */
			const notifiedAt = new Map();

			/**
			 * Show the one-time welcome notification, so the whole chain is visible.
			 * @returns nothing.
			 */
			const welcome = () => {
				try {
					if (localStorage.getItem(WELCOME_KEY) === "1") return;
					localStorage.setItem(WELCOME_KEY, "1");
				} catch {}
				announce(ui, undefined, "完成通知已开启", "会话跑完一轮后会在这里提醒你；点通知可回到对应会话。");
			};

			/**
			 * Ask for notification permission, which a plain browser needs before a
			 * notification can appear; the desktop shell always reports granted.
			 * @returns completion of the permission round-trip.
			 */
			const ensurePermission = async () => {
				if (typeof Notification === "undefined") return;
				if (Notification.permission === "granted") return;
				if (Notification.permission !== "default") return;
				try {
					await Notification.requestPermission();
				} catch {}
			};

			const onGesture = () => {
				document.removeEventListener("pointerdown", onGesture, true);
				document.removeEventListener("keydown", onGesture, true);
				void ensurePermission();
				ui.chime.resume();
			};
			if (typeof document !== "undefined") {
				document.addEventListener("pointerdown", onGesture, true);
				document.addEventListener("keydown", onGesture, true);
			}
			ctx.effect(() => () => {
				if (typeof document === "undefined") return;
				document.removeEventListener("pointerdown", onGesture, true);
				document.removeEventListener("keydown", onGesture, true);
				ui.stack?.dispose();
			}, "completion-notify: teardown");

			// Seed the observed state so a turn already running when the plugin
			// mounts still ends with an alert instead of looking like a baseline.
			try {
				for (const [id, row] of Object.entries(ctx.sessions.list.getSnapshot().byId)) {
					if (row.running === true) running.set(id, true);
				}
			} catch {}

			welcome();

			ctx.effect(() => ctx.remote.$on("api-session/status", (sessionId, isRunning) => {
				const previous = running.get(sessionId);
				running.set(sessionId, isRunning === true);
				if (isRunning !== false) return;
				// Only a witnessed start can end: a page opened mid-run must not fire
				// once per existing session on the first status batch.
				if (previous !== true) return;
				const now = Date.now();
				if (now - (notifiedAt.get(sessionId) ?? 0) < COOLDOWN_MS) return;
				const row = ctx.sessions.list.getSnapshot().byId[sessionId];
				// Subagent children belong to a parent turn; alerting for both would
				// double-report one task.
				if (row?.origin === "subagent" || (row?.parentId !== undefined && row?.parentId !== null)) return;
				notifiedAt.set(sessionId, now);
				void (async () => {
					if (await endedQuietly(sessionId)) return;
					const { title, body } = await describe(ctx, sessionId);
					announce(ui, sessionId, title, body);
				})().catch((error) => {
					console.warn("completion-notify: announce failed", error);
				});
			}), "completion-notify: session status");
		}
		//#endregion

		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
