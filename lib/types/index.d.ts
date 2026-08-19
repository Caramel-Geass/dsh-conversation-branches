import type { Context } from '@deepseek-ai/cordis'
import { TypertRemoteService } from '@deepseek-ai/dsh-typert-protocol'

export interface ForkBranchTurn {
  id: string
  question: string
  status: string
  answer: string
  model: string
  error: string
  time: number
}

export interface ForkBranch {
  id: string
  sessionId: string
  selection: string
  anchorKey: string
  time: number
  model: string
  collapsed: boolean
  turns: ForkBranchTurn[]
}

export type ForkSaveOp =
  | { op: 'upsert'; branch: ForkBranch }
  | { op: 'delete'; id: string }

/**
 * 对话分支 Host 服务(静态 Remote)。
 * Client 通过 `ctx.remote.conversationBranches.load/save/ask/askPoll` 调用;
 * 分支数据作为 `fork/branch` log-only 事件写入会话自身的事件日志。
 */
export default class ConversationBranchesService extends TypertRemoteService<never> {
  static inject: string[]

  constructor(ctx: Context, config: unknown)

  load(request: { sessionId: string }): Promise<{ ok: boolean; branches?: ForkBranch[]; error?: string }>

  save(request: { sessionId: string; ops: ForkSaveOp[] }): Promise<{ ok: boolean; error?: string }>

  ask(request: {
    sessionId: string
    selection?: string
    question: string
    history?: { q: string; a: string }[]
  }): Promise<{ ok: boolean; requestId?: string; model?: string; error?: string }>

  askPoll(request: {
    requestId: string
  }): Promise<{ ok: boolean; done?: boolean; answer?: string; error?: string; model?: string }>
}
