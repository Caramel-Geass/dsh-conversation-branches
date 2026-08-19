import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { KNOWN_SESSION_EVENT_TYPES } from '@deepseek-ai/dsh-session'

// fork/branch 是本插件自有的日志事件类型，不在 harness 的已知事件列表里；读取器会拒绝
// 含未知且未标记 ignorable 类型的日志。此处与 persistence 共享同一 dsh-session 模块实例，
// 模块加载时注册一次，存量与未来的会话日志均可被正常解读。
KNOWN_SESSION_EVENT_TYPES.add('fork/branch')

/**
 * 对话分支 Host 服务（静态 Remote，SRC 源模式）。
 * Client 通过 `ctx.remote.conversationBranches.load/save/ask/askPoll` 调用；
 * 分支数据作为 `fork/branch` log-only 事件写入会话自身的事件日志（与主对话同一持久化管线）。
 *
 * 说明：SRC 模式（dsh-api-gateway 的 source-mode discovery）要求方法签名使用
 * 简单标识符参数（不允许解构/默认值/rest），因此这里统一使用单个 `request` 参数，
 * 在方法体内解构。Remote 装饰器在文件末尾手动应用（TC39 方法装饰器语义）。
 */

/** 递归提取文本块（text / tool-result 内嵌块），跳过 reasoning/image/tool-call */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  const walk = (list) => {
    for (const b of list) {
      if (!b || typeof b !== 'object') continue
      if (b.type === 'text' && typeof b.text === 'string') out += b.text
      else if (b.type === 'tool-result' && Array.isArray(b.content)) walk(b.content)
    }
  }
  walk(blocks)
  return out
}

const truncate = (s, n) => (s.length > n ? s.slice(0, n) + '\n…(已截断)' : s)

/** 归一化分支：补全字段；持久化中仍为 thinking 的回答视为“已中断” */
function normalizeBranch(b, sessionId) {
  return {
    id: b.id,
    sessionId,
    selection: typeof b.selection === 'string' ? b.selection : '',
    anchorKey: typeof b.anchorKey === 'string' ? b.anchorKey : '',
    time: typeof b.time === 'number' ? b.time : 0,
    model: typeof b.model === 'string' ? b.model : '',
    collapsed: b.collapsed === true,
    turns: Array.isArray(b.turns)
      ? b.turns
          .filter((t) => t && typeof t.question === 'string')
          .map((t) => ({
            id: typeof t.id === 'string' ? t.id : '',
            question: t.question,
            status: t.status === 'done' ? 'done' : 'error',
            answer: typeof t.answer === 'string' ? t.answer : '',
            model: typeof t.model === 'string' ? t.model : '',
            error: t.status === 'done' ? (typeof t.error === 'string' ? t.error : '') : '页面刷新，回答已中断',
            time: typeof t.time === 'number' ? t.time : 0,
          }))
      : [],
  }
}

class ConversationBranchesService extends TypertRemoteService {
  static inject = ['sessions', 'sessionQuery', 'llm', 'agentDefaultModel', 'timer']

  constructor(ctx, config) {
    super(ctx, 'conversationBranches')
    this.seq = 0
    this.branchCache = new Map()
    this.streams = new Map()
  }

  /** 从会话日志重放 fork/branch 事件（按 seq 顺序应用 upsert/delete） */
  async replayBranches(sessionId) {
    const sessionQuery = this.ctx.sessionQuery
    if (!sessionQuery) return []
    const snap = await sessionQuery.readSession(sessionId)
    const byId = new Map()
    for (const ev of snap.events) {
      if (!ev || ev.type !== 'fork/branch' || !ev.data || typeof ev.data !== 'object') continue
      const op = ev.data.op
      if (op === 'upsert' && ev.data.branch && typeof ev.data.branch === 'object' && ev.data.branch.id) {
        byId.set(ev.data.branch.id, ev.data.branch)
      } else if (op === 'delete' && typeof ev.data.id === 'string') {
        byId.delete(ev.data.id)
      }
    }
    return Array.from(byId.values()).sort((a, b) => (b.time || 0) - (a.time || 0))
  }

  /** fork-save 后增量更新缓存（保持原始状态，fork-load 输出时归一化） */
  applyOpsToCache(sessionId, ops) {
    if (!this.branchCache.has(sessionId)) return
    const byId = new Map(this.branchCache.get(sessionId).map((b) => [b.id, b]))
    for (const op of ops) {
      if (!op || typeof op !== 'object') continue
      if (op.op === 'upsert' && op.branch && typeof op.branch === 'object' && op.branch.id) {
        byId.set(op.branch.id, op.branch)
      } else if (op.op === 'delete' && typeof op.id === 'string') {
        byId.delete(op.id)
      }
    }
    this.branchCache.set(sessionId, Array.from(byId.values()).sort((a, b) => (b.time || 0) - (a.time || 0)))
  }

  /** 读取分支：优先内存缓存，未命中则从会话日志重放；输出时归一化 */
  async load(request) {
    const { sessionId } = request && typeof request === 'object' ? request : {}
    try {
      if (!sessionId) return { ok: false, error: '缺少会话' }
      if (!this.branchCache.has(sessionId)) {
        this.branchCache.set(sessionId, await this.replayBranches(sessionId))
      }
      const branches = this.branchCache.get(sessionId).map((b) => normalizeBranch(b, sessionId))
      return { ok: true, branches }
    } catch (err) {
      return { ok: false, error: '读取分支失败：' + String((err && err.message) || err) }
    }
  }

  /** 保存分支：作为 log-only 事件追加进会话自己的事件日志，并等待落盘 */
  async save(request) {
    const { sessionId, ops } = request && typeof request === 'object' ? request : {}
    try {
      if (!sessionId || !Array.isArray(ops) || ops.length === 0) return { ok: false, error: '缺少会话或操作' }
      const sessions = this.ctx.sessions
      if (!sessions) return { ok: false, error: '会话服务不可用' }
      const session = sessions.get(sessionId)
      if (!session) return { ok: false, error: '会话不存在' }
      for (const op of ops) {
        if (!op || typeof op !== 'object') continue
        if (op.op === 'upsert' && op.branch && typeof op.branch === 'object' && op.branch.id) {
          session.append('fork/branch', { op: 'upsert', branch: op.branch })
        } else if (op.op === 'delete' && typeof op.id === 'string') {
          session.append('fork/branch', { op: 'delete', id: op.id })
        }
      }
      await sessions.flush(session)
      this.applyOpsToCache(sessionId, ops)
      return { ok: true }
    } catch (err) {
      return { ok: false, error: '保存分支失败：' + String((err && err.message) || err) }
    }
  }

  /** 分支问答（流式）：立即返回 requestId，后台持续消费 llm.stream 增量 */
  async ask(request) {
    const input = request && typeof request === 'object' ? request : {}
    const { sessionId, selection, question, history } = input
    try {
      if (!sessionId || typeof question !== 'string' || !question.trim()) {
        return { ok: false, error: '缺少会话或问题' }
      }

      const llm = this.ctx.llm
      const sessionQuery = this.ctx.sessionQuery
      const defaultModel = this.ctx.agentDefaultModel
      if (!llm || !sessionQuery || !defaultModel) {
        return { ok: false, error: '所需服务不可用（llm / sessionQuery / agentDefaultModel）' }
      }

      const sel = typeof selection === 'string' ? selection.slice(0, 6000) : ''
      const hist = Array.isArray(history)
        ? history.filter((h) => h && typeof h.q === 'string' && typeof h.a === 'string').slice(-6)
        : []

      // 1. 读取主对话的当前模型表面（user / assistant / tool 消息，按模型可见顺序）
      let transcript = ''
      try {
        const snap = await sessionQuery.readSurface(sessionId)
        const lines = []
        for (const ev of snap.events) {
          if (!ev || typeof ev !== 'object') continue
          if (ev.type === 'user/message') {
            const t = extractText(ev.data && ev.data.content)
            if (t) lines.push('用户：' + t)
          } else if (ev.type === 'assistant/message') {
            const t = extractText(ev.data && ev.data.message && ev.data.message.content)
            if (t) lines.push('助手：' + t)
          } else if (ev.type === 'tool/result') {
            const t = extractText(ev.data && ev.data.message && ev.data.message.content)
            if (t) lines.push('工具输出：' + truncate(t, 300))
          }
        }
        transcript = lines.join('\n\n')
      } catch (err) {
        return { ok: false, error: '读取会话内容失败：' + String((err && err.message) || err) }
      }
      if (transcript.length > 24000) {
        transcript = transcript.slice(-24000) + '\n…(更早的内容已省略)'
      }

      // 2. 使用与主对话一致的默认模型
      const selectionInfo = defaultModel.currentSelection()
      const provider = selectionInfo && selectionInfo.provider
      const model = selectionInfo && selectionInfo.model
      if (!provider || !model) return { ok: false, error: '未找到默认模型配置' }

      const prompt = [
        '以下是主对话到目前为止的内容（按时间顺序，越靠后越新）：',
        '```',
        transcript || '(主对话还没有内容)',
        '```',
        '',
        '用户在主对话中选中了以下片段，并针对它开启了一个问答分支：',
        '',
        '选中的片段：',
        '```',
        sel || '(未提供片段)',
        '```',
      ]
      if (hist.length > 0) {
        prompt.push('', '该分支中之前的问答（越靠后越新，供你延续上下文）：')
        for (const h of hist) {
          prompt.push('用户追问：' + h.q)
          prompt.push('分支回答：' + h.a)
        }
      }
      prompt.push('', '用户当前的问题：', question.trim())

      const system = [
        '你是主对话助手的一个“分支问答”实例：用户没有打断主对话，而是在侧栏开启了一个独立分支向你提问。',
        '你的任务：基于给出的主对话上下文、选中片段以及分支内已有的问答，准确、简洁地回答用户的问题。',
        '要求：',
        '- 只围绕选中片段回答；如果上下文不足以回答，直接说明缺少什么信息，不要编造。',
        '- 如果是分支内的追问，先回顾分支内已有的问答，延续之前的结论继续回答，避免重复已说过的话。',
        '- 用与用户问题相同的语言回答。',
        '- 回答保持简洁（一般 300 字以内），可使用 Markdown 列表或代码块增强可读性。',
      ].join('\n')

      const messages = [
        {
          id: 'fork-' + ++this.seq,
          role: 'user',
          content: [{ type: 'text', text: prompt.join('\n') }],
          source: { kind: 'user' },
        },
      ]

      // 3. 建立流式任务：立即返回 requestId，后台持续累积增量
      const requestId = 's' + ++this.seq
      const entry = { answer: '', done: false, error: '', model }
      this.streams.set(requestId, entry)
      const timer = this.ctx.timer
      if (timer) timer.timeout(() => this.streams.delete(requestId), 5 * 60 * 1000)
      void (async () => {
        try {
          const opts = {
            provider,
            model,
            messages,
            system,
            maxTokens: 1500,
            sessionId,
          }
          if (selectionInfo && selectionInfo.reasoningEffort) opts.reasoningEffort = selectionInfo.reasoningEffort
          let finish = null
          for await (const chunk of llm.stream(opts)) {
            if (chunk && chunk.type === 'text-delta') entry.answer += chunk.text
            else if (chunk && chunk.type === 'finish') finish = chunk.reason
          }
          if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
            entry.error = '模型调用失败：' + String((finish.failure && finish.failure.message) || finish.kind)
          }
          entry.done = true
        } catch (err) {
          entry.error = '模型调用失败：' + String((err && err.message) || err)
          entry.done = true
        }
      })()
      return { ok: true, requestId, model }
    } catch (err) {
      return { ok: false, error: '未知错误：' + String((err && err.message) || err) }
    }
  }

  /** 轮询取回流式增量；完成后返回最终结果并清理 */
  async askPoll(request) {
    const { requestId } = request && typeof request === 'object' ? request : {}
    try {
      const entry = requestId ? this.streams.get(requestId) : undefined
      if (!entry) return { ok: false, error: '未知的流式请求' }
      if (entry.done) {
        this.streams.delete(requestId)
        return { ok: true, done: true, answer: entry.answer, error: entry.error, model: entry.model }
      }
      return { ok: true, done: false, answer: entry.answer }
    } catch (err) {
      return { ok: false, error: String((err && err.message) || err) }
    }
  }
}

// ---------------------------------------------------------------------------
// 手动应用 TC39 方法装饰器（@Remote('load') / @Remote('save') / @Remote('ask') /
// @Remote('askPoll')），与编译器输出等价：装饰器通过 context.addInitializer 注册
// 初始化器，初始化器以实例为 this 调用（这里用一个原型为类原型的探针对象执行），
// 最终把 marker 写入 typert-protocol 的模块私有 WeakMap（键为类原型）。
// ---------------------------------------------------------------------------
for (const name of ['load', 'save', 'ask', 'askPoll']) {
  const initializers = []
  Remote(name)(ConversationBranchesService.prototype[name], {
    kind: 'method',
    name,
    static: false,
    private: false,
    addInitializer(fn) {
      initializers.push(fn)
    },
  })
  const probe = Object.create(ConversationBranchesService.prototype)
  for (const init of initializers) init.call(probe)
}

export default ConversationBranchesService
export { ConversationBranchesService }
