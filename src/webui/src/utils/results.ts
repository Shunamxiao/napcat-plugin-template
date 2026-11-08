/** 命中结果码 → 中文标签 + 语义色；日志页与概览页共用一份，避免两边对不上 */
export type ResultTone = 'success' | 'warning' | 'danger' | 'muted' | 'primary'

export const RESULT_META: Record<string, { text: string; tone: ResultTone }> = {
    answered: { text: '已回复', tone: 'success' },
    silent: { text: '未回复', tone: 'muted' },
    guard: { text: '守卫命中', tone: 'warning' },
    guard_mute: { text: '禁言', tone: 'danger' },
    guard_degraded: { text: '禁言失败', tone: 'warning' },
    service_down: { text: '服务降级', tone: 'warning' },
}

export function resultMeta(code: string | undefined): { text: string; tone: ResultTone } {
    return RESULT_META[code ?? ''] ?? { text: code || '-', tone: 'muted' }
}
