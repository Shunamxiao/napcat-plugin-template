/**
 * 配置快照：把当前配置整份存成文件，改坏了回滚。
 *
 * 存在插件配置目录旁边的 snapshots/（不进 dist、不进 git），文件名即 id，
 * 只保留最近 MAX_SNAPSHOTS 份。纯文件操作，不依赖上下文，便于单测。
 */
import fs from 'fs';
import path from 'path';
import type { PluginConfig } from '../types';

export const MAX_SNAPSHOTS = 20;
const ID_RE = /^snap-\d{8}-\d{6}(?:-[a-z0-9]{1,16})?$/;

export interface SnapshotMeta {
    id: string;
    /** 创建时间 ISO */
    ts: string;
    /** 文件字节数 */
    size: number;
    note: string;
}

export interface SnapshotFile extends SnapshotMeta {
    config: PluginConfig;
}

/** snapshots 目录（与 config.json 同级） */
export function snapshotDir(configPath: string): string {
    return path.join(path.dirname(configPath), 'snapshots');
}

function safeId(id: string): string | null {
    return ID_RE.test(id) ? id : null;
}

function filePath(configPath: string, id: string): string | null {
    const safe = safeId(id);
    return safe ? path.join(snapshotDir(configPath), safe + '.json') : null;
}

/** 新→旧 */
export function listSnapshots(configPath: string): SnapshotMeta[] {
    const dir = snapshotDir(configPath);
    let names: string[] = [];
    try {
        names = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && safeId(n.slice(0, -5)));
    } catch {
        return [];
    }
    const out: SnapshotMeta[] = [];
    for (const name of names) {
        try {
            const raw = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8')) as Partial<SnapshotFile>;
            const id = name.slice(0, -5);
            out.push({
                id,
                ts: typeof raw.ts === 'string' ? raw.ts : '',
                size: fs.statSync(path.join(dir, name)).size,
                note: typeof raw.note === 'string' ? raw.note : '',
            });
        } catch {
            // 损坏的快照跳过，不影响其它条目
        }
    }
    return out.sort((a, b) => b.id.localeCompare(a.id));
}

/** 建快照；返回新条目，写盘失败抛错（调用方转 500） */
export function createSnapshot(configPath: string, config: PluginConfig, note = ''): SnapshotMeta {
    const dir = snapshotDir(configPath);
    fs.mkdirSync(dir, { recursive: true });
    const now = new Date();
    const p = (n: number) => String(n).padStart(2, '0');
    const stamp = `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
    let id = 'snap-' + stamp;
    let i = 1;
    while (fs.existsSync(path.join(dir, id + '.json'))) id = 'snap-' + stamp + '-' + (i++);
    const file: SnapshotFile = { id, ts: now.toISOString(), size: 0, note: note.slice(0, 80), config };
    const body = JSON.stringify(file, null, 2);
    fs.writeFileSync(path.join(dir, id + '.json'), body, 'utf-8');
    pruneSnapshots(configPath);
    return { id, ts: file.ts, size: Buffer.byteLength(body), note: file.note };
}

export function readSnapshot(configPath: string, id: string): SnapshotFile | null {
    const fp = filePath(configPath, id);
    if (!fp || !fs.existsSync(fp)) return null;
    try {
        const raw = JSON.parse(fs.readFileSync(fp, 'utf-8')) as Partial<SnapshotFile>;
        if (!raw || typeof raw !== 'object' || !raw.config || typeof raw.config !== 'object') return null;
        return { id, ts: String(raw.ts ?? ''), size: fs.statSync(fp).size, note: String(raw.note ?? ''), config: raw.config as PluginConfig };
    } catch {
        return null;
    }
}

export function deleteSnapshot(configPath: string, id: string): boolean {
    const fp = filePath(configPath, id);
    if (!fp || !fs.existsSync(fp)) return false;
    try {
        fs.unlinkSync(fp);
        return true;
    } catch {
        return false;
    }
}

/** 超出上限时删最旧的 */
export function pruneSnapshots(configPath: string, max = MAX_SNAPSHOTS): void {
    const all = listSnapshots(configPath);
    for (const old of all.slice(max)) deleteSnapshot(configPath, old.id);
}
