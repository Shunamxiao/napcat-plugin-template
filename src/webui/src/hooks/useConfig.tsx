/**
 * 配置草稿：一次加载，页面在 draft 上编辑，dirty 自动判定，保存走 saveBotConfig。
 *
 * 为什么不让页面各自 setState：全量重构后有 6 个页面要读写配置，逐页复制
 * 「fetch → 展平 → saving → 重新拉取」既啰嗦又容易出现「保存后界面还是旧值」。
 */
import { useCallback, useEffect, useMemo, useState } from 'react'
import { fetchBotConfigView, saveBotConfig } from '../utils/api'
import type { PluginConfigView } from '../types'
import { useAccount } from './useAccount'

export function useConfigDraft() {
    const { selectedUin, isCurrent } = useAccount()
    const [config, setConfig] = useState<PluginConfigView | null>(null)   // 服务端基线
    const [draft, setDraft] = useState<PluginConfigView | null>(null)     // 正在编辑
    const [revision, setRevision] = useState<number | null>(null)
    const [loading, setLoading] = useState(true)
    const [saving, setSaving] = useState(false)
    const [error, setError] = useState('')

    const load = useCallback(async () => {
        // 账号还没就绪（/status 未回）时别把页面永久挂在「加载中」：给个空态，selfId 一到就会重跑
        if (!selectedUin) { setLoading(false); return }
        setLoading(true)
        setError('')
        try {
            const view = await fetchBotConfigView(selectedUin, isCurrent)
            setConfig(view.config)
            setDraft(view.config)
            setRevision(view.revision)
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e))
        } finally {
            setLoading(false)
        }
    }, [selectedUin, isCurrent])

    useEffect(() => { load() }, [load])

    const update = useCallback((fn: (d: PluginConfigView) => PluginConfigView) => {
        setDraft((d) => (d ? fn(d) : d))
    }, [])

    const dirty = useMemo(
        () => !!config && !!draft && JSON.stringify(config) !== JSON.stringify(draft),
        [config, draft],
    )

    /** 只提交页面负责的字段：整份提交会把服务端其它字段（尤其是打码 token）写坏 */
    const save = useCallback(async (patch: Record<string, unknown>): Promise<{ ok: boolean; message: string }> => {
        if (!selectedUin) return { ok: false, message: '未选择账号' }
        setSaving(true)
        try {
            // 当前实例：本地 configRevision 要等 groupConfigRefreshMs 同步才更新，带上就会在
            // 连续保存时误报 409；其他实例仍按服务端 revision 做并发保护
            const result = await saveBotConfig(patch, selectedUin, isCurrent ? null : revision)
            if (!result.ok) return { ok: false, message: result.message }
            await load()
            return { ok: true, message: isCurrent ? '已保存并立即生效' : '已保存到服务端，该号下次同步后生效' }
        } catch (e) {
            return { ok: false, message: e instanceof Error ? e.message : String(e) }
        } finally {
            setSaving(false)
        }
    }, [selectedUin, isCurrent, revision, load])

    return { config, draft, update, dirty, save, saving, loading, error, reload: load }
}
