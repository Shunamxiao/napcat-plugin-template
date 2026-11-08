/**
 * 极简 hash 路由：每页一个 `#/<page>` 深链，刷新/分享不丢位置。
 * 不引依赖、不改服务端路由（NapCat 只会把 /page/settings 交给我们这份 HTML）。
 */
import { useCallback, useEffect, useState } from 'react'

export type PageId =
    | 'overview'
    | 'reply'
    | 'private'
    | 'groups'
    | 'guard'
    | 'safety'
    | 'service'
    | 'logs'

export const PAGE_IDS: PageId[] = ['overview', 'reply', 'private', 'groups', 'guard', 'safety', 'service', 'logs']

function readHash(fallback: PageId): PageId {
    const raw = window.location.hash.replace(/^#\/?/, '').split('?')[0]
    return (PAGE_IDS as string[]).includes(raw) ? (raw as PageId) : fallback
}

export function useHashRoute(fallback: PageId = 'overview') {
    const [page, setPage] = useState<PageId>(() => readHash(fallback))

    useEffect(() => {
        if (!window.location.hash) window.history.replaceState(null, '', '#/' + fallback)
        const onChange = () => setPage(readHash(fallback))
        window.addEventListener('hashchange', onChange)
        return () => window.removeEventListener('hashchange', onChange)
    }, [fallback])

    const go = useCallback((next: PageId) => {
        if (window.location.hash === '#/' + next) setPage(next)
        else window.location.hash = '#/' + next
    }, [])

    return { page, go }
}
