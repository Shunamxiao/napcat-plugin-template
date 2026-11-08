import type { ApiResponse, PluginConfigView } from '../types'

function resolvePluginName(): string {
    if (window.__PLUGIN_NAME__) return window.__PLUGIN_NAME__
    try {
        if (window.parent && (window.parent as Window & { __PLUGIN_NAME__?: string }).__PLUGIN_NAME__) {
            return (window.parent as Window & { __PLUGIN_NAME__?: string }).__PLUGIN_NAME__!
        }
    } catch { /* ignore */ }
    const extMatch = location.pathname.match(/\/ext\/([^/]+)/)
    if (extMatch) return extMatch[1]
    const pluginMatch = location.pathname.match(/\/plugin\/([^/]+)/)
    if (pluginMatch) return pluginMatch[1]
    return 'napcat-plugin-template'
}

const PLUGIN_NAME = resolvePluginName()

const API_BASE = '/plugin/' + PLUGIN_NAME + '/api'

function buildUrl(base: string, path: string): string {
    return new URL(base + path, window.location.origin).toString()
}

/**
 * 无认证 API 请求
 * 用于插件自带 WebUI 页面调用后端 router.getNoAuth / router.postNoAuth 注册的路由
 */
export async function noAuthFetch<T = unknown>(path: string, options: RequestInit = {}): Promise<ApiResponse<T>> {
    const res = await fetch(buildUrl(API_BASE, path), {
        ...options,
        // x-napcat-webui 是写接口的浏览器侧凭证：自定义头会触发预检，DNS rebinding 打不进来
        headers: { 'Content-Type': 'application/json', 'x-napcat-webui': '1', ...options.headers }
    })
    if (!res.ok) {
        const text = await res.text()
        throw new Error(text || `HTTP ${res.status}`)
    }
    return res.json()
}


export interface SaveBotConfigResult {
    ok: boolean
    /** true = 服务端 409 冲突，需要刷新后重试 */
    conflict?: boolean
    message: string
}

/**
 * 保存机器人配置：走后端写代理（POST /plugin/<id>/api/server-config，NoAuth + 同源闸门）。
 * 页面没有 NapCat 凭据（accessControlMode=none 时 WebUI 不登录，走 /api/Plugin/ext 只会 Unauthorized）。
 * 后端把补丁与目标实例现有配置合并后整份 PUT 服务端；当前实例同时落本地。
 * 409 时返回 conflict=true，文案固定「配置已被其他端修改，请刷新后重试」。
 */
export async function saveBotConfig(
    patch: Record<string, unknown>,
    uin: string,
    expectedRevision?: number | null
): Promise<SaveBotConfigResult> {
    try {
        const res = await fetch(buildUrl(API_BASE, '/server-config'), {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                uin,
                config: patch,
                expectedRevision: expectedRevision ?? undefined
            })
        })
        const text = await res.text()
        let data: { message?: string; error?: string } | null = null
        try { data = JSON.parse(text) } catch { /* 非 JSON 错误体 */ }
        if (res.status === 409) {
            return { ok: false, conflict: true, message: '配置已被其他端修改，请刷新后重试' }
        }
        if (!res.ok) {
            return { ok: false, message: data?.message || data?.error || `HTTP ${res.status}` }
        }
        return { ok: true, message: 'ok' }
    } catch (e) {
        return { ok: false, message: e instanceof Error ? e.message : String(e) }
    }
}

/** fetchBotConfigView 的返回：config 是编辑基底，revision 供保存时带 expectedRevision */
export interface BotConfigViewResult {
    config: PluginConfigView
    /** 当前实例来自本地缓存（无 revision 概念）时为 null */
    revision: number | null
}

/**
 * 读取编辑用配置：当前实例走本地 /config；其他实例走服务端只读代理 /server-config?uin=。
 * 编辑其他实例必须以该号服务端配置为基底，防止把本实例配置覆盖过去。
 */
export async function fetchBotConfigView(uin: string, isCurrent: boolean): Promise<BotConfigViewResult> {
    if (isCurrent) {
        const res = await noAuthFetch<PluginConfigView>('/config')
        if (res.code !== 0 || !res.data) throw new Error(res.message || '返回为空')
        return { config: res.data, revision: null }
    }
    const res = await fetch(buildUrl(API_BASE, '/server-config?uin=' + encodeURIComponent(uin)))
    const body = await res.json() as ApiResponse<{ config: PluginConfigView; revision: number }> & { error?: string }
    if (!res.ok || body.code !== 0 || !body.data) {
        throw new Error(body.error || body.message || `HTTP ${res.status}`)
    }
    return { config: body.data.config, revision: body.data.revision }
}
