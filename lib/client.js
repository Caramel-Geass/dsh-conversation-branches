window.__ModuleLoader__.load({
	id: "@caramel-geass/dsh-conversation-branches",
	factory: (require) => {
		var module = { exports: {} };
		var exports = module.exports;
		Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
		let react = require("react");
		var React = react; // 修复：产物缺少 React 绑定，组件渲染即 ReferenceError
		//#region conversation-branches client
		const rpc = async (fn, args) => {
			const res = await fn(args);
			return res && res.ok ? res.value : res;
		};
		// 0.2.x 的 descriptor 校验要求每个 codec 带 create() 工厂（旧版是 schema 字段）。
		// 本插件的入参/返回值是自有 JSON 结构，用透传 codec 即可。
		const PASSTHROUGH = { parse: (value) => value, optional() { return this }, nonoptional() { return this } };
		const PASSTHROUGH_JSON_SCHEMA = { type: "object", additionalProperties: true };
		const mkCodec = (typeSymbol) => ({ mode: "strict", typeSymbol, create: () => PASSTHROUGH, jsonSchema: PASSTHROUGH_JSON_SCHEMA });
		const mkParam = (wire) => ({ name: wire, wire, source: "json", codec: mkCodec("@caramel-geass/dsh-conversation-branches/types#" + wire + "Request"), strictCodec: mkCodec("@caramel-geass/dsh-conversation-branches/types#" + wire + "Request") });
		const mkDesc = (method) => ({
			id: "@caramel-geass/dsh-conversation-branches#conversationBranches/" + method,
			service: "conversationBranches",
			namespace: "conversationBranches",
			method,
			invocation: { kind: "direct" },
			parameters: [mkParam("request")],
			result: mkCodec("@caramel-geass/dsh-conversation-branches/types#" + method + "Result")
		});
		const CONVERSATION_BRANCHES_CONTRIBUTION = {
			package: "@caramel-geass/dsh-conversation-branches",
			descriptors: ["load", "save", "ask", "askPoll"].map(mkDesc)
		};
		// 0.2.x 布局服务不再提供 openDetails/closeDetails，面板改为自带右侧停靠栏，故不再注入 layout。
		const inject = ["slots", "remote", "typert"];
		async function apply(ctx) {
			try {
			// 自挂载 conversationBranches Remote 命名空间（无 monorepo 生成物时，客户端自行注册描述符）
			await ctx.remote.$mount(CONVERSATION_BRANCHES_CONTRIBUTION);
			// 本插件自挂载命名空间：提供方是 ownerCtx(root) 下的兄弟 fiber，插件自身 fiber 无法通过
			// ctx.remote.conversationBranches 的 fiber-store 链解析到它（也不能注入自己挂载的服务，会自依赖死锁）。
			// 改用 ctx.get() 走 reflect store（isolate 键）解析，绕开 fiber-store 链。
			const branchesNs = () => {
				const ns = ctx.get('remote.conversationBranches')
				if (!ns) throw new Error('conversationBranches 命名空间尚未就绪')
				return ns
			}
    // ---------- 模块级 store（本次运行内跨渲染共享） ----------
    const listeners = new Set()
    const store = {
      sessionId: undefined,
      panelOpen: false,
      popup: null, // { text, x, y, above, anchorKey }
      highlights: [], // { left, top, width, height }[] 视口坐标高亮块
      branches: new Map(), // sessionId -> Branch[]
      nextId: 1,
    }
    let activeRange = null // 当前高亮对应的 DOM Range（仅客户端内部使用）

    // ---------- 输入法（IME）保护 ----------
    // 中文/日文等输入法组字时，空格是“选中候选”，回车是“确认候选”，都不该被当成发送。
    // 部分输入法（Safari 及某些第三方 IME）会先 compositionend 再补一个普通 keydown，
    // 那个“余波 Enter”要在极短窗口内吃掉；而不能像早先那样把整段时间的 Enter 都放行，
    // 否则用户随后按下的 Enter 会落到 textarea 的默认行为上，变成换行。
    const IME_TAIL_MS = 60
    let imeEndedAt = 0
    const noteImeStart = () => { imeEndedAt = 0 }
    const noteImeEnd = () => { imeEndedAt = Date.now() }
    /** 真正处于组字中的按键（此时绝不能 preventDefault，否则输入法无法确认候选）。 */
    const isComposingEvent = (event) => {
      if (!event) return false
      const native = event.nativeEvent || event
      return native.isComposing === true || event.isComposing === true || native.keyCode === 229 || event.keyCode === 229
    }
    /** 组字刚结束的极短余波：只可能吞掉一次输入法补发的 Enter。 */
    const consumeImeTail = () => {
      const hit = imeEndedAt !== 0 && Date.now() - imeEndedAt <= IME_TAIL_MS
      imeEndedAt = 0
      return hit
    }

    const notify = () => { for (const fn of listeners) fn() }
    const subscribe = (fn) => { listeners.add(fn); return () => listeners.delete(fn) }
    const fmtTime = (t) => {
      try { return new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) } catch (e) { return '' }
    }
    const useStore = () => {
      const [, force] = React.useState(0)
      React.useEffect(() => subscribe(() => force((n) => n + 1)), [])
    }
    // 面板由插件自己在 shell.overlay 里停靠渲染（0.2.x 没有 details 槽位），开关只改 store。
    const openPanel = () => {
      store.panelOpen = true
      notify()
    }
    const closePanel = () => {
      store.panelOpen = false
      notify()
    }

    // ---------- 分支持久化（与主对话一致：写入会话事件日志，Host 端落盘） ----------
    const loadedSessions = new Set()
    const saveChains = {} // sessionId -> Promise 链，保证同一会话的写入按序落盘

    const bumpNextId = (id) => {
      const m = /(\d+)$/.exec(String(id || ''))
      if (m) {
        const n = parseInt(m[1], 10)
        if (!isNaN(n) && n + 1 > store.nextId) store.nextId = n + 1
      }
    }

    const loadBranches = async (sessionId) => {
      if (!sessionId || loadedSessions.has(sessionId)) return false
      let loadedAny = false
      try {
        const res = await rpc(branchesNs().load, { sessionId })
        if (res && res.ok && Array.isArray(res.branches)) {
          loadedSessions.add(sessionId)
          const list = res.branches
          if (list.length > 0) {
            for (const b of list) {
              bumpNextId(b.id)
              for (const t of b.turns || []) bumpNextId(t.id)
            }
            store.branches.set(sessionId, list)
            loadedAny = true
          }
        }
      } catch (e) { /* 读取失败则下次重试 */ }
      return loadedAny
    }

    const branchToJson = (b) => ({
      id: b.id,
      selection: b.selection,
      anchorKey: b.anchorKey || '',
      time: b.time,
      model: b.model || '',
      collapsed: b.collapsed === true,
      turns: b.turns.map((t) => ({
        id: t.id,
        question: t.question,
        status: t.status,
        answer: t.answer || '',
        model: t.model || '',
        error: t.error || '',
        time: t.time,
      })),
    })

    const persistBranch = (branch) => {
      const sessionId = branch.sessionId
      if (!sessionId) return
      const prev = saveChains[sessionId] || Promise.resolve()
      saveChains[sessionId] = prev.then(() =>
        rpc(branchesNs().save, { sessionId, ops: [{ op: 'upsert', branch: branchToJson(branch) }] }).catch(() => null)
      )
    }

    const persistDelete = (branch) => {
      const sessionId = branch.sessionId
      if (!sessionId) return
      const prev = saveChains[sessionId] || Promise.resolve()
      saveChains[sessionId] = prev.then(() =>
        rpc(branchesNs().save, { sessionId, ops: [{ op: 'delete', id: branch.id }] }).catch(() => null)
      )
    }

    // ---------- 流式问答：发起 + 轮询取回增量 ----------
    const branchAlive = (branch) => {
      const list = store.branches.get(branch.sessionId)
      return !!(list && list.some((x) => x.id === branch.id))
    }

    const streamTurn = async (branch, turn, sessionId, selection, question, history) => {
      const timerSvc = ctx.get('timer')
      let requestId = null
      try {
        const args = { sessionId, selection, question }
        if (history !== undefined && history !== null) args.history = history
        const res = await rpc(branchesNs().ask, args)
        if (!res || !res.ok) {
          turn.status = 'error'
          turn.error = (res && res.error) || '请求失败'
          if (branchAlive(branch)) { persistBranch(branch); notify() }
          return
        }
        requestId = res.requestId
        if (res.model) branch.model = res.model
        notify()
      } catch (err) {
        turn.status = 'error'
        turn.error = String((err && err.message) || err)
        if (branchAlive(branch)) { persistBranch(branch); notify() }
        return
      }
      const tick = () => {
        if (turn.status !== 'thinking') return
        rpc(branchesNs().askPoll, { requestId }).then((res) => {
          if (res && res.ok) {
            if (res.answer && res.answer !== turn.answer) {
              turn.answer = res.answer
              notify()
            }
            if (res.done) {
              if (res.error) {
                turn.status = 'error'
                turn.error = res.error
              } else if (!res.answer || !res.answer.trim()) {
                turn.status = 'error'
                turn.error = '模型未返回内容'
              } else {
                turn.status = 'done'
                turn.answer = res.answer
              }
              if (branchAlive(branch)) { persistBranch(branch); notify() }
              return
            }
          }
          if (turn.status === 'thinking') {
            if (timerSvc) timerSvc.timeout(tick, 200)
            else setTimeout(tick, 200)
          }
        }).catch(() => {
          if (turn.status === 'thinking') {
            if (timerSvc) timerSvc.timeout(tick, 300)
            else setTimeout(tick, 300)
          }
        })
      }
      if (timerSvc) timerSvc.timeout(tick, 60)
      else setTimeout(tick, 60)
    }

    // ---------- 轻量 Markdown 渲染（纯 JS → React 元素，不产生 HTML，无注入风险） ----------
    const inlineToken = (text, keyBase) => {
      const out = []
      let rest = String(text)
      let k = 0
      while (rest.length > 0) {
        const code = /^`([^`]+)`/.exec(rest)
        if (code) {
          out.push(React.createElement('code', { key: keyBase + 'c' + k++ }, code[1]))
          rest = rest.slice(code[0].length)
          continue
        }
        const bold = /^\*\*([^*]+)\*\*/.exec(rest)
        if (bold) {
          out.push(React.createElement('strong', { key: keyBase + 'b' + k++ }, bold[1]))
          rest = rest.slice(bold[0].length)
          continue
        }
        const italic = /^\*([^*]+)\*/.exec(rest)
        if (italic) {
          out.push(React.createElement('em', { key: keyBase + 'i' + k++ }, italic[1]))
          rest = rest.slice(italic[0].length)
          continue
        }
        const link = /^\[([^\]]+)\]\(([^)\s]+)\)/.exec(rest)
        if (link) {
          const href = link[2]
          const safe = /^(https?:|mailto:)/.test(href) || href.startsWith('/') ? href : '#'
          out.push(React.createElement('a', { key: keyBase + 'l' + k++, href: safe, target: '_blank', rel: 'noreferrer' }, link[1]))
          rest = rest.slice(link[0].length)
          continue
        }
        const plain = /^[^*`\[]+/.exec(rest)
        if (plain) {
          out.push(plain[0])
          rest = rest.slice(plain[0].length)
          continue
        }
        out.push(rest[0])
        rest = rest.slice(1)
      }
      return out
    }

    const renderMarkdown = (text) => {
      if (!text) return []
      const lines = String(text).split(/\r?\n/)
      const blocks = []
      let i = 0
      let key = 0
      const push = (el) => { if (el !== null && el !== undefined) blocks.push(el) }

      while (i < lines.length) {
        const line = lines[i]
        const fence = /^\s*```/.exec(line)
        if (fence) {
          const lang = line.slice(fence[0].length).trim()
          const buf = []
          i++
          while (i < lines.length && !/^\s*```/.test(lines[i])) { buf.push(lines[i]); i++ }
          i++
          push(React.createElement('div', { className: 'fork-md-code', key: key++ },
            lang ? React.createElement('div', { className: 'fork-md-code-lang', key: 'lang' }, lang) : null,
            React.createElement('pre', { key: 'pre' }, React.createElement('code', { key: 'code' }, buf.join('\n'))),
          ))
          continue
        }
        const heading = /^(#{1,6})\s+(.*)$/.exec(line)
        if (heading) {
          const level = heading[1].length
          const H = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'][level - 1]
          push(React.createElement(H, { className: 'fork-md-h', key: key++ }, ...inlineToken(heading[2], 'h' + key)))
          i++
          continue
        }
        if (/^\s*(-{3,}|\*{3,}|_{3,})\s*$/.test(line)) {
          push(React.createElement('hr', { key: key++ }))
          i++
          continue
        }
        if (/^\s*>\s?/.test(line)) {
          const buf = []
          while (i < lines.length && /^\s*>\s?/.test(lines[i])) { buf.push(lines[i].replace(/^\s*>\s?/, '')); i++ }
          push(React.createElement('blockquote', { className: 'fork-md-quote', key: key++ },
            ...renderMarkdown(buf.join('\n')),
          ))
          continue
        }
        const listMatch = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(line)
        if (listMatch) {
          const items = []
          const ordered = /^\s*\d+\.\s/.test(line)
          while (i < lines.length) {
            const m = /^(\s*)([-*+]|\d+\.)\s+(.*)$/.exec(lines[i])
            if (!m) break
            const indent = m[1].length
            let j = i + 1
            const nested = []
            while (j < lines.length) {
              const nm = /^(\s+)([-*+]|\d+\.)\s+(.*)$/.exec(lines[j])
              if (!nm || nm[1].length <= indent) break
              nested.push(React.createElement('li', { key: 'n' + j }, ...inlineToken(nm[3], 'n' + j)))
              j++
            }
            items.push(React.createElement('li', { key: 'i' + i },
              ...inlineToken(m[3], 'i' + i),
              nested.length > 0 ? React.createElement('ul', { className: 'fork-md-ul', key: 'sub' + i }, ...nested) : null,
            ))
            if (j > i + 1) i = j
            else i++
          }
          push(React.createElement(ordered ? 'ol' : 'ul', { className: ordered ? 'fork-md-ol' : 'fork-md-ul', key: key++ }, ...items))
          continue
        }
        if (/^\s*$/.test(line)) { i++; continue }
        const buf = []
        while (i < lines.length
          && !/^\s*$/.test(lines[i])
          && !/^(#{1,6})\s+/.test(lines[i])
          && !/^\s*```/.test(lines[i])
          && !/^\s*>\s?/.test(lines[i])
          && !/^(\s*)([-*+]|\d+\.)\s+/.test(lines[i])) {
          buf.push(lines[i])
          i++
        }
        push(React.createElement('p', { className: 'fork-md-p', key: key++ }, ...inlineToken(buf.join(' '), 'p' + key)))
      }
      return blocks
    }

    // ---------- 精确文本定位与高亮 ----------
    const findTextRange = (container, text) => {
      if (!text) return null
      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT)
      const nodes = []
      let total = ''
      let node = walker.nextNode()
      while (node) {
        nodes.push(node)
        total += node.textContent || ''
        node = walker.nextNode()
      }
      const idx = total.indexOf(text)
      if (idx === -1) return null
      const end = idx + text.length
      let startNode = null
      let startOff = 0
      let endNode = null
      let endOff = 0
      let acc = 0
      for (const n of nodes) {
        const len = (n.textContent || '').length
        if (startNode === null && idx < acc + len) {
          startNode = n
          startOff = idx - acc
        }
        if (endNode === null && end <= acc + len) {
          endNode = n
          endOff = end - acc
          break
        }
        acc += len
      }
      if (!startNode || !endNode) return null
      const range = document.createRange()
      range.setStart(startNode, startOff)
      range.setEnd(endNode, endOff)
      return range
    }

    const computeHighlightRects = () => {
      if (!activeRange) return
      try {
        const rects = Array.from(activeRange.getClientRects()).filter((r) => r.width > 0 && r.height > 0)
        if (rects.length === 0) return
        store.highlights = rects.map((r) => ({ left: r.left, top: r.top, width: r.width, height: r.height }))
        notify()
      } catch (e) { clearHighlight() }
    }

    const clearHighlight = () => {
      activeRange = null
      if (store.highlights.length > 0) { store.highlights = []; notify() }
    }

    const scrollToBranch = (branch) => {
      try {
        const scrollport = document.querySelector('[data-conversation-scroll]')
        if (!scrollport) return
        let target = null
        if (branch.anchorKey) {
          for (const row of scrollport.querySelectorAll('[data-chat-anchor-key]')) {
            if (row.dataset.chatAnchorKey === branch.anchorKey) { target = row; break }
          }
        }
        if (!target && branch.selection) {
          const walker = document.createTreeWalker(scrollport, NodeFilter.SHOW_TEXT)
          let node = walker.nextNode()
          while (node) {
            if (node.textContent && node.textContent.indexOf(branch.selection) !== -1) {
              target = node.parentElement
              break
            }
            node = walker.nextNode()
          }
        }
        if (!target) return
        const el = target.closest('[data-conversation-scroll]') || scrollport
        const timerSvc = ctx.get('timer')
        const place = () => {
          const rowRect = target.getBoundingClientRect()
          const elRect = el.getBoundingClientRect()
          const rowTop = rowRect.top - elRect.top + el.scrollTop
          const goal = Math.max(0, Math.min(rowTop + rowRect.height / 2 - el.clientHeight / 2, Math.max(0, el.scrollHeight - el.clientHeight)))
          el.scrollTop = goal
          return goal
        }
        const goal = place()
        const retry = (delay) => {
          const fn = () => {
            if (!target.isConnected) return
            if (Math.abs(el.scrollTop - goal) > 24) place()
          }
          if (timerSvc) timerSvc.timeout(fn, delay)
          else setTimeout(fn, delay)
        }
        retry(80)
        retry(260)
        const showHighlight = () => {
          if (activeRange) return
          try {
            const range = findTextRange(target, branch.selection) || findTextRange(scrollport, branch.selection)
            if (!range) return
            activeRange = range
            computeHighlightRects()
            const clear = () => clearHighlight()
            if (timerSvc) timerSvc.timeout(clear, 2400)
            else setTimeout(clear, 2400)
          } catch (e) { /* 忽略高亮失败 */ }
        }
        if (timerSvc) timerSvc.timeout(showHighlight, 120)
        else setTimeout(showHighlight, 120)
      } catch (e) { /* 忽略定位失败 */ }
    }

    // ---------- 发起分支提问 / 追问（流式） ----------
    const ask = async (question) => {
      const sessionId = store.sessionId
      const popup = store.popup
      if (!sessionId || !popup) return
      await loadBranches(sessionId)
      const branch = {
        id: 'b' + (store.nextId++),
        sessionId,
        selection: popup.text,
        anchorKey: popup.anchorKey || '',
        time: Date.now(),
        model: '',
        collapsed: false,
        turns: [{
          id: 't' + (store.nextId++),
          question,
          status: 'thinking',
          answer: '',
          model: '',
          error: '',
          time: Date.now(),
        }],
      }
      const list = store.branches.get(sessionId) || []
      list.unshift(branch)
      store.branches.set(sessionId, list)
      store.popup = null
      openPanel()
      persistBranch(branch)
      notify()
      streamTurn(branch, branch.turns[0], sessionId, popup.text, question, undefined)
    }

    const askFollowup = async (branch, question) => {
      const busy = branch.turns.some((t) => t.status === 'thinking')
      if (busy) return
      const turn = {
        id: 't' + (store.nextId++),
        question,
        status: 'thinking',
        answer: '',
        model: '',
        error: '',
        time: Date.now(),
      }
      branch.turns.push(turn)
      const history = branch.turns
        .filter((t) => t.status === 'done')
        .map((t) => ({ q: t.question, a: t.answer }))
      persistBranch(branch)
      notify()
      streamTurn(branch, turn, branch.sessionId, branch.selection, question, history)
    }

    const removeBranch = (branch) => {
      const list = store.branches.get(branch.sessionId)
      if (!list) return
      store.branches.set(branch.sessionId, list.filter((b) => b.id !== branch.id))
      persistDelete(branch)
      notify()
    }

    // ---------- 选区监听与弹窗定位 ----------
    ctx.effect(() => {
      let dragging = false
      const isInsideForkUi = (node) => {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement
        return !!(el && el.closest && el.closest('[data-fork-ui]'))
      }
      // 0.2.x 把 composer 放进了 [data-conversation-scroll] 内部（composerSeat 是 scrollBody 的子节点），
      // 只判断滚动容器会把“选中输入框里的文字”也算成对话内容，这里额外排除输入/编辑区域。
      const TEXT_ENTRY_SELECTOR = [
        'textarea',
        'input',
        'select',
        '[contenteditable]:not([contenteditable="false"])',
        '[data-composer-seat]',
        '[data-conversation-region="composer"]',
        '[data-slot^="conversation.composer"]',
        '[data-slot^="conversation.input"]',
      ].join(', ')
      const isTextEntry = (node) => {
        const el = node && node.nodeType === 1 ? node : node && node.parentElement
        return !!(el && el.closest && el.closest(TEXT_ENTRY_SELECTOR))
      }
      const readSelection = () => {
        try {
          const sel = window.getSelection()
          if (!sel || sel.isCollapsed || sel.rangeCount === 0) return null
          const text = sel.toString()
          if (!text || !text.trim() || text.length > 8000) return null
          const anchor = sel.anchorNode
          if (!anchor || isInsideForkUi(anchor)) return null
          // 输入框、编辑器、composer 区域内的选区一律不算“对话内容”
          if (isTextEntry(anchor)) return null
          const anchorEl = anchor.nodeType === 1 ? anchor : anchor.parentElement
          if (!anchorEl || !anchorEl.closest('[data-conversation-scroll]')) return null
          // 没有会话（新会话空状态 / 欢迎页）时没有可追问的对象
          const sessionEl = anchorEl.closest('[data-conversation-session]')
          if (!sessionEl || !sessionEl.getAttribute('data-conversation-session')) return null
          const anchorRow = anchorEl.closest('[data-chat-anchor-key]')
          const anchorKey = anchorRow ? anchorRow.dataset.chatAnchorKey : ''
          const range = sel.getRangeAt(0)
          const rect = range.getBoundingClientRect()
          if (!rect || (rect.width === 0 && rect.height === 0)) return null
          const vw = window.innerWidth
          const x = Math.max(180, Math.min(rect.left + rect.width / 2, vw - 180))
          const above = rect.bottom + 260 > window.innerHeight
          return { text, x, y: above ? rect.top - 10 : rect.bottom + 10, above, anchorKey }
        } catch (e) { return null }
      }
      const closePopup = () => {
        if (store.popup) { store.popup = null; notify() }
      }
      const onSelectionChange = () => {
        if (dragging) return
        const sel = window.getSelection()
        const anchor = sel && sel.anchorNode
        // 在弹窗/面板自己的输入框里选区（含打字时的光标移动）不能把弹窗关掉
        if (anchor && isInsideForkUi(anchor)) return
        // 在对话输入框里选区：不算对话内容，顺带关掉可能残留的弹窗
        if (anchor && isTextEntry(anchor)) { closePopup(); return }
        const next = readSelection()
        if (next) { store.popup = next; notify() }
      }
      const onPointerDown = (e) => {
        const t = e.target
        if (t && t.closest && t.closest('[data-fork-ui]')) return
        dragging = true
        closePopup()
      }
      const onPointerUp = () => {
        if (!dragging) return
        dragging = false
        const next = readSelection()
        if (next) { store.popup = next; notify() }
      }
      const onKeyDown = (e) => { if (e.key === 'Escape') closePopup() }
      const onScrollOrResize = () => {
        if (!store.popup) return
        const next = readSelection()
        if (next) { store.popup = next; notify() }
      }
      const onScrollAny = () => { if (activeRange) computeHighlightRects() }
      document.addEventListener('selectionchange', onSelectionChange)
      document.addEventListener('pointerdown', onPointerDown, true)
      window.addEventListener('pointerup', onPointerUp)
      document.addEventListener('pointercancel', onPointerUp)
      document.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('scroll', onScrollOrResize, true)
      window.addEventListener('scroll', onScrollAny, true)
      window.addEventListener('resize', onScrollOrResize)
      return () => {
        document.removeEventListener('selectionchange', onSelectionChange)
        document.removeEventListener('pointerdown', onPointerDown, true)
        window.removeEventListener('pointerup', onPointerUp)
        document.removeEventListener('pointercancel', onPointerUp)
        document.removeEventListener('keydown', onKeyDown, true)
        window.removeEventListener('scroll', onScrollOrResize, true)
        window.removeEventListener('scroll', onScrollAny, true)
        window.removeEventListener('resize', onScrollOrResize)
      }
    })

    // ---------- UI 组件（IM 气泡对话样式） ----------
    const ChatTurn = (props) => {
      const t = props.turn
      return React.createElement('div', { className: 'fork-chat-turn' },
        React.createElement('div', { className: 'fork-bubble user' }, t.question),
        t.status === 'thinking'
          ? React.createElement('div', { className: 'fork-bubble assistant' + (t.answer ? ' streaming' : '') },
              t.answer
                ? React.createElement(React.Fragment, null, t.answer, React.createElement('span', { className: 'fork-cursor' }, '▍'))
                : '正在思考…')
          : t.status === 'error'
            ? React.createElement('div', { className: 'fork-bubble assistant error' }, t.error)
            : React.createElement('div', { className: 'fork-bubble assistant fork-md' }, ...renderMarkdown(t.answer)),
      )
    }

    const BranchCard = (props) => {
      const b = props.branch
      const collapsed = b.collapsed === true
      const [expanded, setExpanded] = React.useState(false)
      const [asking, setAsking] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const busy = b.turns.some((t) => t.status === 'thinking')
      const toggleCollapse = () => {
        b.collapsed = !collapsed
        persistBranch(b)
        notify()
      }
      const send = () => {
        const q = draft.trim()
        if (!q) return
        setDraft('')
        setAsking(false)
        askFollowup(b, q)
      }
      const onQuoteClick = () => {
        setExpanded(!expanded)
        scrollToBranch(b)
      }
      const firstTurn = b.turns[0]
      return React.createElement('div', { className: 'fork-branch' + (collapsed ? ' collapsed' : '') },
        React.createElement('div', { className: 'fork-branch-meta' },
          React.createElement('button', {
            className: 'fork-collapse',
            onClick: toggleCollapse,
            title: collapsed ? '展开分支' : '折叠分支',
          }, collapsed ? '▸' : '▾'),
          React.createElement('span', { className: 'fork-branch-time' }, fmtTime(b.time)),
          b.model ? React.createElement('span', { className: 'fork-branch-model' }, String(b.model)) : null,
          React.createElement('button', { className: 'fork-branch-del', onClick: () => removeBranch(b), title: '删除' }, '×'),
        ),
        React.createElement('div', { className: 'fork-quote' + (expanded ? ' expanded' : ''), onClick: onQuoteClick, title: expanded ? '收起引用 / 定位到主对话' : '展开引用 / 定位到主对话' },
          React.createElement('div', { className: 'fork-quote-label' }, '选中片段'),
          React.createElement('div', { className: 'fork-quote-text' }, b.selection),
        ),
        collapsed
          ? (firstTurn
              ? React.createElement('div', { className: 'fork-question fork-first-q', title: firstTurn.question }, firstTurn.question)
              : null)
          : React.createElement(React.Fragment, null,
              b.turns.map((t, i) => React.createElement(ChatTurn, { key: t.id, turn: t })),
              React.createElement('div', { className: 'fork-followup' },
                asking
                  ? React.createElement(React.Fragment, null,
                      React.createElement('input', {
                        className: 'fork-followup-input',
                        placeholder: '追问…（Enter 发送）',
                        value: draft,
                        onChange: (e) => setDraft(e.target.value),
                        onCompositionStart: noteImeStart,
                        onCompositionEnd: noteImeEnd,
                        onKeyDown: (e) => {
                          if (e.key === 'Escape') { setAsking(false); setDraft(''); return }
                          if (e.key !== 'Enter') return
                          // 组字中的 Enter 是“确认候选”，交给输入法，不拦截默认行为
                          if (isComposingEvent(e)) return
                          e.preventDefault()
                          // 输入法刚结束时补发的余波 Enter：吞掉，不发送也不换行
                          if (consumeImeTail()) return
                          send()
                        },
                        autoFocus: true,
                      }),
                      React.createElement('div', { className: 'fork-followup-actions' },
                        React.createElement('button', { className: 'fork-btn ghost', onClick: () => { setAsking(false); setDraft('') } }, '取消'),
                        React.createElement('button', { className: 'fork-btn primary', disabled: !draft.trim() || busy, onClick: send }, '发送'),
                      ),
                    )
                  : React.createElement('button', { className: 'fork-followup-btn', disabled: busy, onClick: () => setAsking(true) }, '追问'),
              ),
            ),
      )
    }

    const BranchPanel = (props) => {
      useStore()
      const sessionId = props.sessionId
      React.useEffect(() => {
        let alive = true
        loadBranches(sessionId).then((loaded) => { if (loaded && alive) notify() })
        return () => { alive = false }
      }, [sessionId])
      const branches = sessionId ? (store.branches.get(sessionId) || []) : []
      return React.createElement('div', { className: 'fork-panel' },
        React.createElement('div', { className: 'fork-panel-head' },
          React.createElement('div', { className: 'fork-panel-title' },
            '对话分支',
            React.createElement('span', { className: 'fork-panel-count' }, String(branches.length)),
          ),
          React.createElement('button', { className: 'fork-panel-close', onClick: closePanel, title: '收起' }, '×'),
        ),
        React.createElement('div', { className: 'fork-panel-body' },
          branches.length === 0
            ? React.createElement('div', { className: 'fork-empty' }, '在主对话中选中内容并提问，分支会显示在这里')
            : branches.map((b) => React.createElement(BranchCard, { key: b.id, branch: b })),
        ),
      )
    }

    const Popup = () => {
      useStore()
      const popup = store.popup
      const [draft, setDraft] = React.useState('')
      const inputRef = React.useRef(null)
      const open = !!popup
      React.useEffect(() => { setDraft('') }, [popup ? popup.text : null])
      // 不自动聚焦输入框：输入框拿到焦点会清掉正文选区，用户就没法再复制刚选中的文字。
      // 改为“直接打字即写入”：弹窗打开且焦点不在可编辑元素上时，可打印字符自动聚焦并写入输入框。
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          // 组字中或刚提交候选的按键不能拦截：否则会把输入法的首个候选“抢”进输入框
          if (isComposingEvent(event)) return
          if (imeEndedAt !== 0 && Date.now() - imeEndedAt <= IME_TAIL_MS) return
          if (event.metaKey || event.ctrlKey || event.altKey) return
          if (typeof event.key !== 'string' || event.key.length !== 1) return
          // 空格既不作为“开始输入”的第一个字符，也避开了输入法用空格选词的场景
          if (event.key === ' ') return
          const active = document.activeElement
          if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.isContentEditable)) return
          const el = inputRef.current
          if (!el) return
          event.preventDefault()
          el.focus()
          setDraft((prev) => prev + event.key)
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [open])
      if (!popup) return null
      const send = () => {
        const q = draft.trim()
        if (!q) return
        ask(q)
      }
      return React.createElement('div', {
        className: 'fork-popup' + (popup.above ? ' above' : ''),
        style: { left: popup.x + 'px', top: popup.y + 'px' },
      },
        React.createElement('div', { className: 'fork-popup-quote' }, popup.text),
        React.createElement('textarea', {
          className: 'fork-popup-input',
          placeholder: '针对选中的内容提问…（直接输入即可，Enter 发送，Shift+Enter 换行）',
          value: draft,
          ref: inputRef,
          onChange: (e) => setDraft(e.target.value),
          onCompositionStart: noteImeStart,
          onCompositionEnd: noteImeEnd,
          onKeyDown: (e) => {
            if (e.key !== 'Enter') return
            // 组字中的 Enter 是“确认候选”：交给输入法，不能 preventDefault
            if (isComposingEvent(e)) return
            // Shift+Enter 才是换行
            if (e.shiftKey) return
            // 普通 Enter 永不换行：要么发送，要么被当作输入法余波吞掉
            e.preventDefault()
            if (consumeImeTail()) return
            send()
          },
        }),
        React.createElement('div', { className: 'fork-popup-actions' },
          React.createElement('button', { className: 'fork-btn ghost', onClick: () => { store.popup = null; notify() } }, '取消'),
          React.createElement('button', { className: 'fork-btn primary', disabled: !draft.trim(), onClick: send }, '提问'),
        ),
      )
    }

    const HighlightLayer = () => {
      useStore()
      const hs = store.highlights
      if (!hs || hs.length === 0) return null
      return React.createElement('div', { className: 'fork-highlight-layer' },
        hs.map((h, i) => React.createElement('div', {
          key: i,
          className: 'fork-text-highlight',
          style: { left: h.left + 'px', top: h.top + 'px', width: h.width + 'px', height: h.height + 'px' },
        })),
      )
    }

    const Toggle = (props) => {
      store.sessionId = props.sessionId
      useStore()
      const prevSession = React.useRef(null)
      React.useEffect(() => {
        if (prevSession.current !== props.sessionId) {
          prevSession.current = props.sessionId
          if (store.panelOpen) { store.panelOpen = false; notify() }
        }
        loadBranches(props.sessionId).then((loaded) => { if (loaded) notify() })
      }, [props.sessionId])
      const count = (store.branches.get(props.sessionId) || []).length
      const toggle = () => {
        if (store.panelOpen) closePanel()
        else openPanel()
      }
      return React.createElement('button', {
        className: 'fork-toggle' + (store.panelOpen ? ' active' : ''),
        onClick: toggle,
        title: store.panelOpen ? '收起分支面板' : '打开分支面板（可拖拽左边缘调节宽度）',
      },
        '分支',
        count > 0 ? React.createElement('span', { className: 'fork-toggle-count' }, String(count)) : null,
      )
    }

    // 右侧停靠栏：0.2.x 的 details 槽位已不存在，分支面板改为插件自绘的停靠列。
    const DOCK_MIN = 300
    const DOCK_MAX = 560
    const DOCK_KEY = 'fork-dock-width'
    const readDockWidth = () => {
      try {
        const value = Number(localStorage.getItem(DOCK_KEY))
        if (Number.isFinite(value) && value >= DOCK_MIN && value <= DOCK_MAX) return value
      } catch (e) {}
      return 380
    }
    const DockedPanel = () => {
      useStore()
      const [width, setWidth] = React.useState(readDockWidth)
      if (!store.panelOpen || !store.sessionId) return null
      const startDrag = (event) => {
        event.preventDefault()
        const startX = event.clientX
        const startWidth = width
        const onMove = (move) => setWidth(Math.min(DOCK_MAX, Math.max(DOCK_MIN, startWidth - (move.clientX - startX))))
        const onUp = () => {
          window.removeEventListener('pointermove', onMove)
          window.removeEventListener('pointerup', onUp)
          setWidth((current) => {
            try { localStorage.setItem(DOCK_KEY, String(current)) } catch (e) {}
            return current
          })
        }
        window.addEventListener('pointermove', onMove)
        window.addEventListener('pointerup', onUp)
      }
      return React.createElement('div', { className: 'fork-dock', style: { width: width + 'px' } },
        React.createElement('div', { className: 'fork-dock-resize', onPointerDown: startDrag, title: '拖拽调节宽度' }),
        React.createElement(BranchPanel, { sessionId: store.sessionId }),
      )
    }

    const Overlay = () => React.createElement('div', { 'data-fork-ui': 'true', className: 'fork-root' },
      React.createElement(DockedPanel),
      React.createElement(HighlightLayer),
      React.createElement(Popup),
    )

    // ---------- 样式 ----------
    const CSS = `
.fork-root { position: fixed; inset: 0; z-index: 2147483000; pointer-events: none; font-family: system-ui, -apple-system, 'Segoe UI', sans-serif; }
.fork-root * { box-sizing: border-box; }
.fork-panel { height: 100%; min-width: 0; display: flex; flex-direction: column; overflow: hidden; background: var(--dsw-alias-bg-base, #ffffff); color: var(--dsw-alias-label-primary, #1f2328); }
.fork-panel-head { flex: none; display: flex; align-items: center; justify-content: space-between; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); }
.fork-panel-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; }
.fork-panel-count { font-size: 11px; font-weight: 500; color: var(--dsw-alias-label-secondary, #57606a); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); border-radius: 999px; padding: 1px 7px; }
.fork-panel-close, .fork-branch-del, .fork-collapse { border: none; background: transparent; color: var(--dsw-alias-label-secondary, #57606a); cursor: pointer; border-radius: 8px; }
.fork-panel-close, .fork-branch-del { font-size: 16px; line-height: 1; padding: 4px 6px; }
.fork-collapse { font-size: 15px; line-height: 1; padding: 6px 9px; min-width: 30px; text-align: center; }
.fork-panel-close:hover, .fork-branch-del:hover, .fork-collapse:hover { background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.08)); color: var(--dsw-alias-label-primary, #1f2328); }
.fork-panel-body { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; display: flex; flex-direction: column; gap: 10px; }
.fork-empty { color: var(--dsw-alias-label-secondary, #57606a); font-size: 12.5px; text-align: center; padding: 40px 12px; line-height: 1.6; }
.fork-branch { border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08)); border-radius: 10px; padding: 10px 12px; background: var(--dsw-alias-bg-layer-1, rgba(0,0,0,.02)); }
.fork-branch.collapsed { padding: 8px 12px; }
.fork-branch-meta { display: flex; align-items: center; gap: 8px; margin-bottom: 6px; }
.fork-branch-time { font-size: 11px; color: var(--dsw-alias-label-secondary, #57606a); }
.fork-branch-model { font-size: 10.5px; color: var(--dsw-alias-label-secondary, #57606a); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.05)); border-radius: 4px; padding: 1px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; max-width: 150px; }
.fork-branch-del { margin-left: auto; }
.fork-status { font-size: 10.5px; font-weight: 600; }
.fork-status.thinking { color: var(--dsw-alias-brand-primary, #0969da); animation: fork-pulse 1.2s ease-in-out infinite; }
.fork-quote { border-left: 3px solid var(--dsw-alias-brand-primary, #0969da); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04)); border-radius: 6px; padding: 6px 8px; margin-bottom: 10px; cursor: pointer; }
.fork-quote-label { font-size: 10.5px; font-weight: 600; color: var(--dsw-alias-label-secondary, #57606a); margin-bottom: 3px; }
.fork-quote-text { font-size: 12px; color: var(--dsw-alias-label-primary, #1f2328); white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.fork-quote.expanded .fork-quote-text { display: block; }
.fork-first-q { font-size: 12.5px; color: var(--dsw-alias-label-primary, #1f2328); margin-bottom: 0; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; font-weight: 600; }
.fork-chat-turn { display: flex; flex-direction: column; gap: 6px; margin-bottom: 12px; }
.fork-chat-turn:last-child { margin-bottom: 0; }
.fork-bubble { max-width: 88%; padding: 7px 10px; border-radius: 12px; font-size: 12.5px; line-height: 1.6; word-break: break-word; white-space: pre-wrap; }
.fork-bubble.user { align-self: flex-end; background: var(--dsw-alias-brand-primary, #0969da); color: #ffffff; border-bottom-right-radius: 4px; font-weight: 500; }
.fork-bubble.assistant { align-self: flex-start; background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.06)); color: var(--dsw-alias-label-primary, #1f2328); border-bottom-left-radius: 4px; }
.fork-bubble.assistant.error { color: var(--dsw-alias-state-error-primary, #cf222e); }
.fork-bubble.assistant.streaming { color: var(--dsw-alias-label-primary, #1f2328); }
.fork-cursor { display: inline-block; color: var(--dsw-alias-brand-primary, #0969da); animation: fork-blink 1.1s steps(2) infinite; }
.fork-md { white-space: normal; }
.fork-md-p { margin: 0 0 8px; }
.fork-md-p:last-child { margin-bottom: 0; }
.fork-md-h { font-weight: 600; margin: 10px 0 6px; line-height: 1.3; }
.fork-md h1 { font-size: 16px; }
.fork-md h2 { font-size: 15px; }
.fork-md h3 { font-size: 14px; }
.fork-md h4 { font-size: 13px; }
.fork-md h5, .fork-md h6 { font-size: 12.5px; }
.fork-md strong { font-weight: 700; }
.fork-md em { font-style: italic; }
.fork-md code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px; background: rgba(0,0,0,.08); border-radius: 4px; padding: 1px 4px; }
.fork-md pre { background: rgba(0,0,0,.07); border-radius: 8px; padding: 8px 10px; overflow-x: auto; margin: 0 0 8px; }
.fork-md pre code { background: transparent; padding: 0; font-size: 11.5px; white-space: pre; }
.fork-md-code { margin-bottom: 8px; }
.fork-md-code-lang { font-size: 10px; color: var(--dsw-alias-label-secondary, #57606a); margin-bottom: 2px; }
.fork-md ul, .fork-md ol { margin: 0 0 8px; padding-left: 18px; }
.fork-md li { margin: 2px 0; }
.fork-md a { color: var(--dsw-alias-brand-primary, #0969da); text-decoration: none; }
.fork-md a:hover { text-decoration: underline; }
.fork-md blockquote { margin: 0 0 8px; padding: 4px 10px; border-left: 3px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2)); color: var(--dsw-alias-label-secondary, #57606a); }
.fork-md hr { border: none; border-top: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)); margin: 8px 0; }
.fork-followup { margin-top: 10px; }
.fork-followup-btn { border: 1px dashed var(--dsw-alias-border-l2, rgba(0,0,0,.2)); background: transparent; color: var(--dsw-alias-label-secondary, #57606a); border-radius: 8px; padding: 4px 12px; font-size: 12px; cursor: pointer; font-family: inherit; }
.fork-followup-btn:hover { color: var(--dsw-alias-brand-primary, #0969da); border-color: var(--dsw-alias-brand-primary, #0969da); }
.fork-followup-btn:disabled { opacity: .5; cursor: default; }
.fork-followup-input { width: 100%; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f2328); padding: 7px 10px; font-size: 12.5px; font-family: inherit; outline: none; }
.fork-followup-input:focus { border-color: var(--dsw-alias-brand-primary, #0969da); }
.fork-followup-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.fork-popup { position: fixed; z-index: 2147483001; width: 380px; max-width: calc(100vw - 24px); pointer-events: auto; transform: translate(-50%, 0); background: var(--dsw-alias-bg-overlay, #ffffff); border: 1px solid var(--dsw-alias-border-l2, rgba(0,0,0,.2)); border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.22); padding: 10px; color: var(--dsw-alias-label-primary, #1f2328); }
.fork-popup.above { transform: translate(-50%, -100%); }
.fork-popup-quote { font-size: 12px; color: var(--dsw-alias-label-secondary, #57606a); background: var(--dsw-alias-bg-layer-2, rgba(0,0,0,.04)); border-left: 3px solid var(--dsw-alias-brand-primary, #0969da); border-radius: 6px; padding: 6px 8px; margin-bottom: 8px; white-space: pre-wrap; word-break: break-word; overflow: hidden; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; }
.fork-popup-input { width: 100%; min-height: 64px; resize: vertical; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15)); border-radius: 8px; background: var(--dsw-alias-bg-layer-1, #ffffff); color: var(--dsw-alias-label-primary, #1f2328); padding: 8px 10px; font-size: 12.5px; font-family: inherit; outline: none; }
.fork-popup-input:focus { border-color: var(--dsw-alias-brand-primary, #0969da); }
.fork-popup-actions { display: flex; justify-content: flex-end; gap: 8px; margin-top: 8px; }
.fork-btn { border: 1px solid transparent; border-radius: 8px; padding: 5px 14px; font-size: 12.5px; cursor: pointer; font-family: inherit; }
.fork-btn.ghost { background: transparent; color: var(--dsw-alias-label-secondary, #57606a); border-color: var(--dsw-alias-border-l1, rgba(0,0,0,.15)); }
.fork-btn.ghost:hover { color: var(--dsw-alias-label-primary, #1f2328); }
.fork-btn.primary { background: var(--dsw-alias-brand-primary, #0969da); color: #ffffff; }
.fork-btn.primary:disabled { opacity: .5; cursor: default; }
.fork-toggle { display: inline-flex; align-items: center; gap: 4px; border: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12)); background: transparent; color: var(--dsw-alias-label-secondary, #57606a); border-radius: 8px; padding: 4px 10px; font-size: 12.5px; cursor: pointer; font-family: inherit; }
.fork-toggle:hover, .fork-toggle.active { color: var(--dsw-alias-brand-primary, #0969da); border-color: var(--dsw-alias-brand-primary, #0969da); }
.fork-toggle-count { background: var(--dsw-alias-brand-primary, #0969da); color: #ffffff; font-size: 10px; border-radius: 999px; padding: 0 5px; line-height: 14px; }
.fork-highlight-layer { position: fixed; inset: 0; z-index: 2147483002; pointer-events: none; }
.fork-text-highlight { position: absolute; background: rgba(255, 224, 130, .55); background: color-mix(in srgb, #ffe08a 55%, transparent); border-radius: 3px; animation: fork-highlight-fade 2.4s ease forwards; }
.fork-dock { position: fixed; top: 0; right: 0; bottom: 0; display: flex; flex-direction: column; pointer-events: auto; background: var(--dsw-alias-bg-base, #ffffff); border-left: 1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.1)); box-shadow: -12px 0 32px rgba(0,0,0,.12); }
.fork-dock-resize { position: absolute; left: -3px; top: 0; bottom: 0; width: 6px; cursor: col-resize; touch-action: none; }
.fork-dock-resize:hover { background: var(--dsw-alias-border-l3, rgba(0,0,0,.2)); }
@keyframes fork-highlight-fade { 0% { opacity: 1; } 75% { opacity: 1; } 100% { opacity: 0; } }
@keyframes fork-pulse { 0%,100% { opacity: .45; } 50% { opacity: 1; } }
@keyframes fork-blink { 50% { opacity: 0; } }
`
  ctx.effect(() => {
    const tagId = 'fork-ui'
    if (!document.querySelector('style[data-plugin-css="' + tagId + '"]')) {
      const tag = document.createElement('style')
      tag.setAttribute('data-plugin-css', tagId)
      tag.textContent = CSS
      document.head.appendChild(tag)
    }
    return () => {
      const tag = document.querySelector('style[data-plugin-css="' + tagId + '"]')
      if (tag) tag.remove()
    }
  })

    // ---------- 注册到 Slot ----------
    const slots = ctx.get('slots')
    if (slots === undefined) return
    slots.inject('conversation.session.header.utilities', () => slots.register(
      { name: 'conversation.session.header.utilities', id: 'fork-branches' },
      (props) => React.createElement(Toggle, { sessionId: props.sessionId }),
    ))
    slots.inject('shell.overlay', () => slots.register(
      { name: 'shell.overlay', id: 'fork-ui' },
      () => React.createElement(Overlay),
    ))
			} catch (error) {
				console.error('[fork] apply failed:', error && error.stack ? error.stack : error)
				throw error
			}
		}
		//#endregion
		exports.apply = apply;
		exports.inject = inject;
		return module.exports;
	}
});
