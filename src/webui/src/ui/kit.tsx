/**
 * 页面基础组件（全量重构后的唯一控件来源）
 *
 * 只做「重复出现过 3 次以上」的东西：卡片、字段行、开关、分段选择、按钮、空态、统计块、
 * 抽屉、标签、柱状图。没有业务逻辑，业务状态由各自页面持有。
 */
import { useCallback, useEffect, type ReactNode } from 'react'

/* ==================== 卡片 ==================== */

export function Card({ title, desc, actions, children, className = '', bodyClass = '' }: {
    title?: ReactNode
    desc?: ReactNode
    actions?: ReactNode
    children: ReactNode
    className?: string
    bodyClass?: string
}) {
    return (
        <section className={`card animate-fade-in-up ${className}`}>
            {(title || actions) && (
                <div className="flex items-start justify-between gap-3 px-4 pt-4 pb-3 md:px-5">
                    <div className="min-w-0">
                        {title && <h3 className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</h3>}
                        {desc && <p className="text-xs text-gray-400 mt-0.5 leading-relaxed">{desc}</p>}
                    </div>
                    {actions && <div className="flex items-center gap-2 shrink-0">{actions}</div>}
                </div>
            )}
            <div className={`px-4 pb-4 md:px-5 md:pb-5 ${bodyClass}`}>{children}</div>
        </section>
    )
}

/* ==================== 字段行 ==================== */

/** 一行设置：左标签+说明，右控件。窄屏自动上下堆叠。 */
export function Row({ label, desc, children, stack = false }: {
    label: ReactNode
    desc?: ReactNode
    children: ReactNode
    /** true = 控件换行放下面（输入框、文本域用） */
    stack?: boolean
}) {
    if (stack) {
        return (
            <div className="py-3 first:pt-0 last:pb-0 border-b last:border-0 border-gray-100 dark:border-gray-800">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
                {desc && <div className="text-xs text-gray-400 mt-0.5 leading-relaxed">{desc}</div>}
                <div className="mt-2">{children}</div>
            </div>
        )
    }
    return (
        <div className="flex items-center justify-between gap-4 py-3 first:pt-0 last:pb-0 border-b last:border-0 border-gray-100 dark:border-gray-800">
            <div className="min-w-0">
                <div className="text-sm font-medium text-gray-800 dark:text-gray-200">{label}</div>
                {desc && <div className="text-xs text-gray-400 mt-0.5 leading-relaxed">{desc}</div>}
            </div>
            <div className="shrink-0">{children}</div>
        </div>
    )
}

/* ==================== 开关 ==================== */

export function Switch({ checked, onChange, disabled = false }: {
    checked: boolean
    onChange: (v: boolean) => void
    disabled?: boolean
}) {
    return (
        <label className={`toggle ${disabled ? 'opacity-40 pointer-events-none' : ''}`}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={(e) => onChange(e.target.checked)} />
            <div className="slider" />
        </label>
    )
}

/* ==================== 分段选择 ==================== */

export function Segmented<T extends string>({ value, options, onChange, disabled = false }: {
    value: T
    options: { value: T; label: string; hint?: string }[]
    onChange: (v: T) => void
    disabled?: boolean
}) {
    return (
        <div
            className={`inline-flex rounded-lg border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-[#1a1a1c] p-0.5 ${disabled ? 'opacity-50' : ''}`}
            role="radiogroup"
        >
            {options.map((o) => {
                const active = o.value === value
                return (
                    <button
                        key={o.value}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        title={o.hint}
                        disabled={disabled}
                        onClick={() => onChange(o.value)}
                        className={`px-3 py-1 rounded-[6px] text-xs font-medium transition-colors whitespace-nowrap ${
                            active
                                ? 'bg-white dark:bg-[#2a2a2e] text-gray-900 dark:text-white shadow-sm'
                                : 'text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200'
                        }`}
                    >
                        {o.label}
                    </button>
                )
            })}
        </div>
    )
}

/* ==================== 按钮 ==================== */

export function Btn({ children, onClick, variant = 'ghost', size = 'md', loading = false, disabled = false, type = 'button', title }: {
    children: ReactNode
    onClick?: () => void
    variant?: 'primary' | 'ghost' | 'danger' | 'plain'
    size?: 'sm' | 'md'
    loading?: boolean
    disabled?: boolean
    type?: 'button' | 'submit'
    title?: string
}) {
    const base = variant === 'plain' ? 'btn-plain' : `btn btn-${variant}`
    const pad = size === 'sm' ? 'px-2.5 py-1 text-xs' : ''
    return (
        <button
            type={type}
            title={title}
            className={`${base} ${pad}`}
            onClick={onClick}
            disabled={disabled || loading}
        >
            {loading && <span className="loading-spinner !w-3.5 !h-3.5" />}
            {children}
        </button>
    )
}

/* ==================== 空态 / 加载 ==================== */

export function Empty({ title, desc, action }: { title: string; desc?: string; action?: ReactNode }) {
    return (
        <div className="flex flex-col items-center justify-center gap-2 py-10 text-center">
            <div className="text-2xl opacity-30">◌</div>
            <div className="text-sm font-medium text-gray-600 dark:text-gray-300">{title}</div>
            {desc && <div className="text-xs text-gray-400 max-w-sm leading-relaxed">{desc}</div>}
            {action && <div className="mt-2">{action}</div>}
        </div>
    )
}

export function Loading({ text = '加载中...' }: { text?: string }) {
    return (
        <div className="flex items-center justify-center gap-3 py-16">
            <div className="loading-spinner text-primary" />
            <div className="text-gray-400 text-sm">{text}</div>
        </div>
    )
}

/* ==================== 统计块 ==================== */

export function Stat({ label, value, hint, tone = 'default' }: {
    label: string
    value: ReactNode
    hint?: string
    tone?: 'default' | 'primary' | 'success' | 'warning'
}) {
    const color = {
        default: 'text-gray-900 dark:text-gray-100',
        primary: 'text-primary',
        success: 'text-emerald-500',
        warning: 'text-amber-500',
    }[tone]
    return (
        <div className="rounded-xl border border-gray-100 dark:border-gray-800 bg-white dark:bg-[#1e1e20] px-4 py-3">
            <div className="text-xs text-gray-400">{label}</div>
            <div className={`text-xl font-bold mt-1 tabular-nums ${color}`}>{value}</div>
            {hint && <div className="text-[11px] text-gray-400 mt-0.5 truncate">{hint}</div>}
        </div>
    )
}

/* ==================== 标签 ==================== */

export function Tag({ children, tone = 'default' }: {
    children: ReactNode
    tone?: 'default' | 'primary' | 'success' | 'warning' | 'danger' | 'muted'
}) {
    const cls = {
        default: 'bg-gray-100 text-gray-600 dark:bg-gray-800 dark:text-gray-300',
        primary: 'bg-brand-50 text-brand-700 dark:bg-brand-500/10 dark:text-brand-300',
        success: 'bg-emerald-50 text-emerald-700 dark:bg-emerald-500/10 dark:text-emerald-400',
        warning: 'bg-amber-50 text-amber-700 dark:bg-amber-500/10 dark:text-amber-400',
        danger: 'bg-red-50 text-red-600 dark:bg-red-500/10 dark:text-red-400',
        muted: 'bg-gray-50 text-gray-400 dark:bg-gray-800/60 dark:text-gray-500',
    }[tone]
    return <span className={`inline-flex items-center px-1.5 py-0.5 rounded text-[11px] font-medium ${cls}`}>{children}</span>
}

/* ==================== 抽屉 ==================== */

export function Drawer({ open, title, desc, onClose, footer, dirty = false, children }: {
    open: boolean
    title: ReactNode
    desc?: ReactNode
    onClose: () => void
    footer?: ReactNode
    dirty?: boolean
    children: ReactNode
}) {
    // 有未保存改动时，Esc / 点遮罩 / 点 × 都要先确认，别让编辑静默丢失
    const requestClose = useCallback(() => {
        if (dirty && !window.confirm('有未保存的修改，确定关闭？')) return
        onClose()
    }, [dirty, onClose])

    useEffect(() => {
        if (!open) return
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') requestClose() }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
    }, [open, requestClose])

    if (!open) return null
    return (
        <div className="fixed inset-0 z-40 flex justify-end">
            <div className="absolute inset-0 bg-black/30 animate-fade-in" onClick={requestClose} />
            <div
                role="dialog"
                aria-modal="true"
                className="relative h-full w-full max-w-md bg-[#f8f9fa] dark:bg-[#18191C] shadow-2xl flex flex-col animate-fade-in"
            >
                <div className="flex items-start justify-between gap-3 px-5 py-4 border-b border-gray-200 dark:border-gray-800">
                    <div className="min-w-0">
                        <div className="text-sm font-semibold text-gray-900 dark:text-gray-100">{title}</div>
                        {desc && <div className="text-xs text-gray-400 mt-0.5">{desc}</div>}
                    </div>
                    <button className="btn-plain text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 text-lg leading-none" onClick={requestClose} aria-label="关闭">×</button>
                </div>
                <div className="flex-1 overflow-y-auto px-5 py-4 space-y-4">{children}</div>
                {footer && <div className="px-5 py-3 border-t border-gray-200 dark:border-gray-800 flex justify-end gap-2">{footer}</div>}
            </div>
        </div>
    )
}

/* ==================== 柱状图（无依赖，纯 SVG） ==================== */

export function Bars({ data, height = 120, tone = 'primary', unit = '' }: {
    data: { label: string; value: number }[]
    height?: number
    tone?: 'primary' | 'success'
    unit?: string
}) {
    if (data.length === 0) return <Empty title="暂无数据" />
    const max = Math.max(1, ...data.map((d) => d.value))
    const color = tone === 'success' ? 'bg-emerald-400' : 'bg-primary'
    return (
        <div className="flex items-end gap-2" style={{ height }}>
            {data.map((d) => {
                const h = Math.max(2, Math.round((d.value / max) * (height - 26)))
                return (
                    <div key={d.label} className="flex-1 flex flex-col items-center justify-end gap-1 min-w-0" title={`${d.label}：${d.value}${unit}`}>
                        <div className="text-[10px] text-gray-400 tabular-nums">{d.value}</div>
                        <div className={`w-full rounded-t ${color} opacity-80 hover:opacity-100 transition-opacity`} style={{ height: h }} />
                        <div className="text-[10px] text-gray-400 truncate w-full text-center">{d.label}</div>
                    </div>
                )
            })}
        </div>
    )
}

/* ==================== 保存栏 ==================== */

export function SaveBar({ dirty, saving, onSave, label, hint }: {
    dirty: boolean
    saving: boolean
    onSave: () => void
    label: string
    hint?: ReactNode
}) {
    return (
        <div className="sticky bottom-0 z-10 -mx-1 px-1 py-3 bg-gradient-to-t from-[#f8f9fa] via-[#f8f9fa] dark:from-[#18191C] dark:via-[#18191C] to-transparent">
            <div className="flex items-center justify-between gap-3 rounded-xl border border-gray-200 dark:border-gray-800 bg-white/95 dark:bg-[#1e1e20]/95 backdrop-blur px-4 py-2.5 shadow-sm">
                <div className="text-xs text-gray-400 min-w-0 truncate">{dirty ? '有未保存的修改' : (hint ?? '配置与服务端同步')}</div>
                <Btn variant="primary" size="sm" loading={saving} disabled={!dirty || saving} onClick={onSave}>{label}</Btn>
            </div>
        </div>
    )
}
