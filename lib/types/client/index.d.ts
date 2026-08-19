/** Client 端插件声明的 inject 列表 */
export const inject: string[]

/** Client 端插件入口:注册选区提问、分支面板与弹窗等 slot */
export function apply(ctx: any): Promise<void>
