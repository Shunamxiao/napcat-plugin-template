/**
 * 配置快照的排序与裁剪：同秒连拍时列表必须仍是新→旧，否则 prune 会先删掉刚建的那份。
 */
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createSnapshot, deleteSnapshot, listSnapshots, MAX_SNAPSHOTS, readSnapshot, snapshotDir } from '../src/core/config-snapshots.ts'

const configPath = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'snapcfg-')), 'config.json')

test('同秒连拍：列表保持新→旧，裁剪只删最旧的', () => {
    const cp = configPath()
    const total = MAX_SNAPSHOTS + 3
    for (let i = 0; i < total; i += 1) createSnapshot(cp, { n: i }, 's' + i)
    // 快照 id 只精确到秒，同秒内后缀会被回收，所以按内容 n 判定新旧
    const listed = listSnapshots(cp).map((s) => readSnapshot(cp, s.id).config.n)
    assert.equal(listed.length, MAX_SNAPSHOTS)
    assert.equal(listed[0], total - 1, '最新的快照必须排第一')
    assert.deepEqual([...listed].sort((a, b) => a - b), Array.from({ length: MAX_SNAPSHOTS }, (_, i) => i + 3))
    assert.equal(fs.readdirSync(snapshotDir(cp)).length, MAX_SNAPSHOTS)
})

test('删除快照：只删指定 id，重复删返回 false', () => {
    const cp = configPath()
    const a = createSnapshot(cp, { n: 1 }).id
    const b = createSnapshot(cp, { n: 2 }).id
    assert.equal(deleteSnapshot(cp, a), true)
    assert.equal(deleteSnapshot(cp, a), false)
    assert.deepEqual(listSnapshots(cp).map((s) => s.id), [b])
})
