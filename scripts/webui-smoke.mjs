/**
 * WebUI 真实渲染 smoke：拿 dist 构建产物 + 假接口在无头 Chromium 里跑一遍 8 个页面，
 * 断言关键控件在、控制台无报错。部署后怀疑「页面没生效」时先跑它，能分清是构建问题还是设备问题。
 *
 *   npm run build && node scripts/webui-smoke.mjs        # 截图落 /tmp/shots
 *   CHROME_PATH=/path/to/chrome node scripts/webui-smoke.mjs
 */
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
const { chromium } = await import(process.env.PLAYWRIGHT_CORE ?? '/root/cchrome-web/node_modules/playwright-core/index.mjs')

const DIST = new URL('../dist/webui/index.html', import.meta.url).pathname
const PREFIX = '/plugin/napcat-plugin-autoreply'
const html = fs.readFileSync(DIST)

const config = {
    enabled: true, debug: false, cooldownSeconds: 30, replyDelayMinMs: 300, replyDelayMaxMs: 1200,
    atOnly: true, atReply: false,
    guard: { enabled: true, words: ['加微信'], wordsText: '加微信', action: 'both', warnText: '别发广告', groupIds: [111], groupIdsText: '111' },
    kbService: { enabled: true, baseUrl: 'http://127.0.0.1:8080', token: '******', timeoutMs: 5000 },
    groupWelcome: { enabled: false, template: '欢迎' },
    group: { enabled: true },
    private: { enabled: true, whitelist: ['123456'], whitelistText: '123456\n# 注释行', mergeWindowMs: 0, guide: { enabled: false, text: '', windowSeconds: 1800 } },
    fallback: { privateText: '没找到', groupAtText: '没找到' },
    aiTrigger: { private: true, groupAtOnly: true },
    keywords: [{ match: '下载', matchType: 'contains', reply: '看置顶', action: 'reply', enabled: true }],
    keywordsText: '下载=看置顶',
    blacklist: [], blacklistText: '', ignoreSenders: [], ignoreSendersText: '',
    collect: { enabled: false, questions: [] },
    relay: { token: '******' },
    sendGuard: { failThreshold: 5, privateFailThreshold: 3, cooldownSeconds: 30 },
    loopGuard: { maxReplies: 6, windowSeconds: 60, pauseSeconds: 120 },
    crossAccountDedup: true, accountAccessKey: '******', groupConfigRefreshMs: 300000,
    friendRequest: { autoAccept: false },
    groupRules: {},
}

const status = {
    pluginName: 'napcat-plugin-autoreply', uptime: 1000, uptimeFormatted: '16分钟', config,
    stats: { processed: 10, todayProcessed: 3, lastUpdateDay: '2026-11-08' },
    selfId: '10001', nickname: '一号', instanceName: 'acc-main', webuiPort: 6099,
    configRevision: 9, configSource: 'server', build: 'test',
}

const groupRow = (id, mode) => ({
    groupId: id, name: '群' + id, mode, missPolicy: 'fallback_only', atForceReply: false, keywordOutsideAt: false,
    cooldownSeconds: null, fallbackText: null, enabled: mode !== 'off', atOnly: mode === 'at', aiEnabled: true,
    welcomeEnabled: true, welcomeTemplate: null, source: 'default',
})

const routes = {
    '/status': { code: 0, data: status },
    '/config': { code: 0, data: config },
    '/routes': { code: 0, data: {} },
    '/peers': { code: 0, data: [{ uin: '10001', name: 'acc-main', webuiPort: 6099, running: true, isLogin: true }] },
    '/server-bots': { code: 0, data: [{ uin: '10001', nickname: '一号', revision: 9 }] },
    '/groups': { code: 0, data: { groups: [groupRow('111111', 'all'), groupRow('222222', 'at')], global: { cooldownSeconds: 30, fallbackText: '兜底', groupDefault: null } } },
    '/guard-policy': { code: 0, data: { windowSeconds: 600, threshold: 3, muteSeconds: 300, warnText: '别发广告', muteText: '已禁言', source: 'server' } },
    '/snapshots': { code: 0, data: { items: [{ id: 'snap-20261108-160000', ts: '2026-11-08T15:00:00.000Z', size: 2048, note: '改动前' }], max: 20 } },
    '/logs': { code: 0, data: { entries: [{ ts: '2026-11-08T15:00:00.000Z', channel: 'group', groupId: '111111', userId: '999', result: 'guard_mute', detail: '加微信' }, { ts: '2026-11-08T15:01:00.000Z', channel: 'private', userId: '123456', result: 'answered', detail: '下载' }], total: 2 } },
    '/traffic': { code: 0, data: { days: 7, configured: true, items: [{ day: '2026-11-08', row: { day: '2026-11-08', throughput: { in: 12, privateIn: 2, groupIn: 10, replies: 5, ruleHits: 2, aiReplies: 2, fallbackReplies: 1 }, rules: { hits: 2, top: [{ match: '下载', count: 2 }] }, groups: [], hourly: [] } }] } },
    '/keyword-stats': { code: 0, data: { 下载: { count: 2, lastAt: '2026-11-08T15:01:00.000Z' } } },
    '/observability': { code: 0, data: { service: { baseUrl: 'http://127.0.0.1:8080', enabled: true, tokenConfigured: true, reachable: true, lastAttemptAt: null, lastSyncAt: null, lastError: null }, sync: { blocklistAt: null, guardWordsAt: null, groupConfigAt: null, groupConfigVersion: '1' }, faq: { hit: 1, miss: 0 }, groups: { managed: 2 } } },
}

const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1:8099')
    if (url.pathname.startsWith(PREFIX + '/api/')) {
        const key = url.pathname.slice((PREFIX + '/api').length)
        const body = routes[key.split('?')[0]] ?? { code: 0, data: {} }
        res.writeHead(200, { 'content-type': 'application/json' })
        return res.end(JSON.stringify(body))
    }
    if (url.pathname === '/favicon.ico') { res.writeHead(204); return res.end() }
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' })
    res.end(html)
})

await new Promise((r) => server.listen(8099, '127.0.0.1', r))

const browser = await chromium.launch({
    executablePath: process.env.CHROME_PATH ?? '/root/cchrome-web/kernel/ungoogled-chromium-150.0.7871.186-1-x86_64_linux/chrome',
    headless: true, args: ['--no-sandbox'],
})
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
const errors = []
page.on('console', (m) => { if (m.type() === 'error') errors.push(m.text()) })
page.on('pageerror', (e) => errors.push('pageerror: ' + e.message))

const base = 'http://127.0.0.1:8099' + PREFIX + '/page/dashboard'
const checks = []
const check = (name, ok, extra = '') => checks.push({ name, ok, extra })

async function visit(pageId, text) {
    await page.goto(base + '#/' + pageId, { waitUntil: 'load' })
    await page.waitForFunction(() => (document.getElementById('root')?.innerHTML.length ?? 0) > 100, null, { timeout: 20000 }).catch(() => {})
    await page.waitForTimeout(400)
    const found = await page.getByText(text, { exact: false }).first().isVisible().catch(() => false)
    check(pageId + ' 显示「' + text + '」', found)
    await page.screenshot({ path: '/tmp/shots/' + pageId + '.png', fullPage: false })
}

fs.mkdirSync('/tmp/shots', { recursive: true })
await visit('overview', '最近命中')
check('概览命中结果已翻译', await page.getByText('禁言', { exact: true }).first().isVisible().catch(() => false))
await visit('reply', '回复前 @ 触发者')
await visit('private', '白名单 QQ')
const wl = await page.locator('textarea').first().inputValue({ timeout: 5000 }).catch(async () => {
    await page.screenshot({ path: '/tmp/shots/private-fail.png' })
    return '[无 textarea] ' + (await page.locator('body').innerText()).slice(0, 300)
})
check('白名单回显保留注释行', typeof wl === 'string' && wl.includes('# 注释行'), wl)
await visit('groups', '群规则')
await page.locator('tbody input[type=checkbox]').first().check().catch(() => {})
await page.waitForTimeout(300)
check('批量出现「模式不变」', await page.getByText('模式不变', { exact: false }).first().isVisible().catch(() => false))
await visit('guard', '启用内容守卫')
const guardBox = await page.locator('input[type=checkbox]').first().isChecked().catch(() => null)
check('守卫开关回显为开', guardBox === true, String(guardBox))
await visit('safety', '黑名单')
await visit('service', '配置快照')
await visit('logs', '命中日志')
await page.getByText('禁言', { exact: false }).first().waitFor({ timeout: 5000 }).catch(() => {})
// 只看表格：筛选项里的同名文案是隐藏的 <option>，会抢 first()
check('日志行显示中文结果「禁言」', await page.locator('tbody').getByText('禁言', { exact: true }).first().isVisible().catch(() => false))
check('日志筛选含守卫命中', await page.locator('option', { hasText: '守卫命中' }).first().count().then((n) => n > 0))

check('控制台无报错', errors.length === 0, errors.slice(0, 5).join(' | '))
await browser.close()
server.close()

const failed = checks.filter((c) => !c.ok)
for (const c of checks) console.log((c.ok ? 'PASS ' : 'FAIL ') + c.name + (c.extra ? '  [' + c.extra + ']' : ''))
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' 通过')
process.exit(failed.length ? 1 : 0)
