#!/usr/bin/env node
/**
 * 改写保真闸门：新稿必须保住原稿（默认 git HEAD，可用 --base 指定）里的每一个行内代码符号。
 *
 *   npm run check:tokens                       # 所有改过的 docs 页
 *   npm run check:tokens docs/ch05/ssd-nvm.md  # 指定文件
 *
 * 只比符号，不比文字：中文句子可以重写，`符号` 与 `路径` 一个都不能丢。
 * 允许的例外写在 ALLOW 里，每条都要写明理由。
 */
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 已知的、有意为之的符号替换：文件 → 旧符号 → 新符号 */
const ALLOW = {
  // 原稿写错了名字，基线源码里不存在 BatchLoadIndexedFloatRange
  'docs/ch05/risks.md': { BatchLoadIndexedFloatRange: 'BulkLoadIndexedFloatRange' },
  'docs/ch05/read-path.md': { BatchLoadIndexedFloatRange: 'BulkLoadIndexedFloatRange' },
  // 基线里没有 ShouldUseDram，实际判定函数是 TryAllocDram
  'docs/ch05/value-store.md': {
    'HybridValueStore::ShouldUseDram': 'HybridValueStore::TryAllocDram',
    '#HybridValueStore::ShouldUseDram': '#HybridValueStore::TryAllocDram'
  },
  'docs/ch05/appendix.md': { 'HybridValueStore::ShouldUseDram': 'HybridValueStore::TryAllocDram' },
  // 表格单元格里的裸竖线会把表切歪，故在表内拆写、在代码位置保留原串
  'docs/ch05/allocator.md': { 'mmap(MAP_PRIVATE | MAP_ANONYMOUS)': 'mmap(MAP_PRIVATE | MAP_ANONYMOUS)' }
}

function changedDocs() {
  const out = execFileSync('git', ['status', '--porcelain'], { encoding: 'utf8' })
  return out
    .split('\n')
    .map((l) => l.slice(3).trim())
    .filter((p) => p.startsWith('docs/') && p.endsWith('.md'))
}

const args = process.argv.slice(2)
const baseIdx = args.indexOf('--base')
const BASE = baseIdx >= 0 ? args.splice(baseIdx, 2)[1] : 'HEAD'
const files = args.length ? args : changedDocs()
if (!files.length) {
  console.log('没有改动中的文档。')
  process.exit(0)
}

let bad = 0
let checked = 0

for (const file of files) {
  const rel = file.replace(/\\/g, '/').replace(/^\.?\//, '')
  let old
  try {
    old = execFileSync('git', ['show', `HEAD:${rel}`], { encoding: 'utf8', maxBuffer: 1 << 26 })
  } catch {
    continue
  }
  checked++
  const now = readFileSync(file, 'utf8')
  const allow = ALLOW[rel] ?? {}
  const tokens = [...old.matchAll(/`([^`\n]+)`/g)]
    .map((m) => m[1])
    .filter((t) => !/[\u4e00-\u9fff]/.test(t) && t.length < 120)
  const uniq = [...new Set(tokens)]
  const missing = uniq.filter((t) => !now.includes(t) && !(allow[t] && now.includes(allow[t])))

  if (missing.length) {
    bad++
    console.log(`✗ ${rel}：原稿 ${uniq.length} 个符号，缺 ${missing.length} 个`)
    for (const m of missing.slice(0, 40)) console.log(`    ${m}`)
  } else {
    console.log(`✓ ${rel}：${uniq.length} 个符号全部保留`)
  }
}

console.log(bad ? `\n${bad}/${checked} 页丢了符号` : `\n${checked} 页全部保真`)
process.exit(bad ? 1 : 0)
