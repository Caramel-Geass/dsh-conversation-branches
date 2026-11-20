/**
 * 对话分支 · Host 端
 *
 * 选中主对话文本后开启的独立问答分支：分支数据存在 storage domain（非会话日志），
 * 问答复用主对话的默认模型，通过 Remote 暴露给客户端。
 *
 * 适配目标：dsh 0.2.1-rc.3
 *  - 持久化：ctx.storageDomain（0.2.x 官方推荐的插件数据落点），不再向会话日志追加自定义事件类型
 *  - 迁移：首次读取时会从旧版写入会话日志的 `fork/branch` 事件导入
 */
import { Remote, TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

const TURN_SCHEMA = z.object({
  id: z.string(),
  question: z.string(),
  answer: z.string(),
  error: z.string(),
  model: z.string(),
  status: z.string(),
  time: z.number(),
})

const BRANCH_SCHEMA = z.object({
  id: z.string(),
  sessionId: z.string(),
  selection: z.string(),
  anchorKey: z.string(),
  time: z.number(),
  model: z.string(),
  collapsed: z.boolean(),
  turns: z.array(TURN_SCHEMA),
})

/** 插件自有数据域：每个会话一组分支记录，键为分支 id。 */
const DOMAIN_SPEC = defineDomain({
  name: 'conversation_branches',
  version: 1,
  tables: { branches: domainTable(BRANCH_SCHEMA) },
})

/** 旧版事件类型（只读迁移用）。 */
const LEGACY_EVENT_TYPE = 'fork/branch'

/** 单次提问的字符上限：防止误粘贴/恶意调用把超大 prompt 直接送进模型。 */
const MAX_QUESTION_CHARS = 4000
/** 单次写入的操作条数上限。 */
const MAX_SAVE_OPS = 100

const truncate = (value, max) => (value.length > max ? `${value.slice(0, max)}\n…(已截断)` : value)

/** 递归提取文本块（text / tool-result 内嵌块），跳过 reasoning / image / tool-call。 */
function extractText(blocks) {
  if (!Array.isArray(blocks)) return ''
  let out = ''
  const walk = (list) => {
    for (const block of list) {
      if (!block || typeof block !== 'object') continue
      if (block.type === 'text' && typeof block.text === 'string') out += block.text
      else if (block.type === 'tool-result' && Array.isArray(block.content)) walk(block.content)
    }
  }
  walk(blocks)
  return out
}

/** 补全字段并归一化旧记录；持久化中仍为 thinking 的回答视为“已中断”。 */
function normalizeBranch(raw, sessionId) {
  const turns = Array.isArray(raw && raw.turns) ? raw.turns : []
  return {
    id: String((raw && raw.id) || ''),
    sessionId,
    selection: typeof raw?.selection === 'string' ? raw.selection : '',
    anchorKey: typeof raw?.anchorKey === 'string' ? raw.anchorKey : '',
    time: typeof raw?.time === 'number' ? raw.time : 0,
    model: typeof raw?.model === 'string' ? raw.model : '',
    collapsed: raw?.collapsed === true,
    turns: turns
      .filter((turn) => turn && typeof turn.question === 'string')
      .map((turn) => ({
        id: typeof turn.id === 'string' ? turn.id : '',
        question: turn.question,
        answer: typeof turn.answer === 'string' ? turn.answer : '',
        model: typeof turn.model === 'string' ? turn.model : '',
        status: turn.status === 'done' ? 'done' : 'error',
        error:
          turn.status === 'done'
            ? typeof turn.error === 'string'
              ? turn.error
              : ''
            : '页面刷新，回答已中断',
        time: typeof turn.time === 'number' ? turn.time : 0,
      })),
  }
}

/**
 * 对话分支 Host 服务。
 * Client 通过 `remote.conversationBranches.{load,save,ask,askPoll}` 调用。
 */
class ConversationBranchesService extends TypertRemoteService {
  static inject = ['sessions', 'sessionQuery', 'llm', 'agentDefaultModel', 'timer', 'storageDomain']

  constructor(ctx, config) {
    super(ctx, 'conversationBranches')
    this.streams = new Map()
    this.seq = 0
    this.domainPromise = undefined
    ctx.effect(() => () => {
      const pending = this.domainPromise
      this.domainPromise = undefined
      if (pending !== undefined) pending.then((domain) => domain.close()).catch(() => {})
    })
  }

  /** 打开（并缓存）数据域；打开失败时允许下次重试。 */
  async domain() {
    if (this.domainPromise === undefined) {
      this.domainPromise = this.ctx.storageDomain.open(DOMAIN_SPEC).catch((error) => {
        this.domainPromise = undefined
        throw error
      })
    }
    return this.domainPromise
  }

  /** 从旧版会话日志的 `fork/branch` 事件重建分支（只读，读不到就当没有）。 */
  async legacyBranches(sessionId) {
    try {
      const snapshot = await this.ctx.sessionQuery.readSession(sessionId)
      const byId = new Map()
      for (const event of snapshot.events || []) {
        if (!event || event.type !== LEGACY_EVENT_TYPE) continue
        const data = event.data
        if (!data || typeof data !== 'object') continue
        if (data.op === 'upsert' && data.branch && data.branch.id) byId.set(data.branch.id, data.branch)
        else if (data.op === 'delete' && typeof data.id === 'string') byId.delete(data.id)
      }
      return [...byId.values()].map((branch) => normalizeBranch(branch, sessionId))
    } catch {
      return []
    }
  }

  /** 读取某会话的全部分支（缓存为空时尝试从旧版会话日志迁移）。 */
  async load(request) {
    const sessionId = request && request.sessionId
    if (typeof sessionId !== 'string' || sessionId === '') return { ok: false, error: '缺少会话' }
    try {
      const domain = await this.domain()
      const table = domain.table('branches')
      const branches = []
      for (const [, record] of table.entries()) {
        if (record && record.sessionId === sessionId) branches.push(normalizeBranch(record, sessionId))
      }
      if (branches.length === 0) {
        const legacy = await this.legacyBranches(sessionId)
        for (const branch of legacy) {
          await table.put(branch.id, branch)
          branches.push(branch)
        }
      }
      branches.sort((left, right) => (right.time || 0) - (left.time || 0))
      return { ok: true, branches }
    } catch (error) {
      return { ok: false, error: `读取分支失败：${String((error && error.message) || error)}` }
    }
  }

  /** 写入/删除分支：storage 写入在返回前已durable。 */
  async save(request) {
    const sessionId = request && request.sessionId
    const ops = request && request.ops
    if (typeof sessionId !== 'string' || sessionId === '' || !Array.isArray(ops) || ops.length === 0) {
      return { ok: false, error: '缺少会话或操作' }
    }
    if (ops.length > MAX_SAVE_OPS) return { ok: false, error: `单次写入操作过多（上限 ${MAX_SAVE_OPS} 条）` }
    try {
      const domain = await this.domain()
      const table = domain.table('branches')
      for (const op of ops) {
        if (!op || typeof op !== 'object') continue
        if (op.op === 'upsert' && op.branch && typeof op.branch.id === 'string' && op.branch.id !== '') {
          const branch = normalizeBranch({ ...op.branch, sessionId }, sessionId)
          await table.put(branch.id, branch)
        } else if (op.op === 'delete' && typeof op.id === 'string' && op.id !== '') {
          await table.delete(op.id)
        }
      }
      return { ok: true }
    } catch (error) {
      return { ok: false, error: `保存分支失败：${String((error && error.message) || error)}` }
    }
  }

  /** 分支问答：立即返回 requestId，后台消费 llm.stream 增量。 */
  async ask(request) {
    try {
      const input = request && typeof request === 'object' ? request : {}
      const sessionId = input.sessionId
      const question = typeof input.question === 'string' ? input.question.trim() : ''
      if (typeof sessionId !== 'string' || sessionId === '' || question === '') {
        return { ok: false, error: '缺少会话或问题' }
      }
      // Remote 的 wire codec 是透传的，边界不校验长度；超长问题会直接变成模型调用成本，这里挡住。
      if (question.length > MAX_QUESTION_CHARS) {
        return { ok: false, error: `问题过长（上限 ${MAX_QUESTION_CHARS} 字）` }
      }
      const { llm, sessionQuery, agentDefaultModel } = this.ctx
      if (!llm || !sessionQuery || !agentDefaultModel) {
        return { ok: false, error: '所需服务不可用（llm / sessionQuery / agentDefaultModel）' }
      }

      const selection = typeof input.selection === 'string' ? input.selection.slice(0, 6000) : ''
      const history = Array.isArray(input.history)
        ? input.history.filter((item) => item && typeof item.q === 'string' && typeof item.a === 'string').slice(-6)
        : []

      let transcript = ''
      try {
        const surface = await sessionQuery.readSurface(sessionId)
        const lines = []
        for (const event of surface.events || []) {
          if (!event || typeof event !== 'object') continue
          if (event.type === 'user/message') {
            const text = extractText(event.data && event.data.content)
            if (text) lines.push(`用户：${text}`)
          } else if (event.type === 'assistant/message') {
            const text = extractText(event.data && event.data.message && event.data.message.content)
            if (text) lines.push(`助手：${text}`)
          } else if (event.type === 'tool/result') {
            const text = extractText(event.data && event.data.message && event.data.message.content)
            if (text) lines.push(`工具输出：${truncate(text, 300)}`)
          }
        }
        transcript = lines.join('\n\n')
      } catch (error) {
        return { ok: false, error: `读取会话内容失败：${String((error && error.message) || error)}` }
      }
      if (transcript.length > 24000) transcript = `${transcript.slice(-24000)}\n…(更早的内容已省略)`

      const selectionInfo = agentDefaultModel.currentSelection()
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
        selection || '(未提供片段)',
        '```',
      ]
      if (history.length > 0) {
        prompt.push('', '该分支中之前的问答（越靠后越新，供你延续上下文）：')
        for (const item of history) {
          prompt.push(`用户追问：${item.q}`)
          prompt.push(`分支回答：${item.a}`)
        }
      }
      prompt.push('', '用户当前的问题：', question)

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
          id: `fork-${++this.seq}`,
          role: 'user',
          content: [{ type: 'text', text: prompt.join('\n') }],
          source: { kind: 'user' },
        },
      ]

      const requestId = `s${++this.seq}`
      const entry = { answer: '', done: false, error: '', model }
      this.streams.set(requestId, entry)
      const timer = this.ctx.timer
      if (timer) timer.timeout(() => this.streams.delete(requestId), 5 * 60 * 1000)

      void (async () => {
        try {
          const options = { provider, model, messages, system, maxTokens: 1500, sessionId }
          if (selectionInfo.reasoningEffort) options.reasoningEffort = selectionInfo.reasoningEffort
          let finish = null
          for await (const chunk of llm.stream(options)) {
            if (chunk && chunk.type === 'text-delta') entry.answer += chunk.text
            else if (chunk && chunk.type === 'finish') finish = chunk.reason
          }
          if (finish && (finish.kind === 'error' || finish.kind === 'aborted')) {
            entry.error = `模型调用失败：${String((finish.failure && finish.failure.message) || finish.kind)}`
          }
          entry.done = true
        } catch (error) {
          entry.error = `模型调用失败：${String((error && error.message) || error)}`
          entry.done = true
        }
      })()

      return { ok: true, requestId, model }
    } catch (error) {
      return { ok: false, error: `未知错误：${String((error && error.message) || error)}` }
    }
  }

  /** 轮询取回流式增量；完成后返回最终结果并清理。 */
  async askPoll(request) {
    try {
      const requestId = request && request.requestId
      const entry = typeof requestId === 'string' ? this.streams.get(requestId) : undefined
      if (!entry) return { ok: false, error: '未知的流式请求' }
      if (entry.done) {
        this.streams.delete(requestId)
        return { ok: true, done: true, answer: entry.answer, error: entry.error, model: entry.model }
      }
      return { ok: true, done: false, answer: entry.answer }
    } catch (error) {
      return { ok: false, error: String((error && error.message) || error) }
    }
  }
}

// 纯 JS 无法书写装饰器：手工套用 Remote 标记（TC39 方法装饰器协议）。
const REMOTE_METHODS = ['load', 'save', 'ask', 'askPoll']
const prototype = ConversationBranchesService.prototype
const initializers = []
for (const method of REMOTE_METHODS) {
  Remote(method)(prototype[method], {
    kind: 'method',
    name: method,
    static: false,
    private: false,
    addInitializer(initializer) {
      initializers.push(initializer)
    },
  })
}
const probe = Object.create(prototype)
for (const initializer of initializers) initializer.call(probe)

export default ConversationBranchesService
export { ConversationBranchesService }
