#!/usr/bin/env node
/**
 * 正文体检：符号密度 + 图表覆盖。
 *
 * 规则（见 docs/guide/index.md「写作约定」）：
 * 1. 一段叙述里出现 3 个以上行内代码，且平均每 100 字 ≥ 1.2 个符号，
 *    说明这段在描述结构而不是讲因果 —— 应该画成图，或者退回成表格。
 * 2. 一页有 25 个以上符号却一张图都没有，应该至少补一张图。
 *
 * 豁免：`risks.md` / `evidence.md` / `appendix.md` / `index.md` 是索引与清单页，
 * 以及页面顶部标明「这页是查表用的」的页（配置表、不变量表）。
 *
 * 用法：
 *   node scripts/prose-check.mjs            # 全站
 *   node scripts/prose-check.mjs docs/ch05  # 只看某个目录
 *   node scripts/prose-check.mjs --strict   # 有命中就退出码 1
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DOCS = join(ROOT, 'docs')
const SKIP_FILES = new Set(['risks.md', 'evidence.md', 'appendix.md', 'index.md'])
const STRUCTURAL = /查表用的|这页是查表/

const PARAGRAPH_MIN_CODES = 3
const PARAGRAPH_MAX_PER_100 = 1.2
const PAGE_MIN_SYMBOLS = 25

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '.vitepress' || name === 'public') continue
      out.push(...walk(full))
    } else if (name.endsWith('.md') && !SKIP_FILES.has(name)) {
      out.push(full)
    }
  }
  return out
}

function strip(text) {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/^---[\s\S]*?^---\s*$/m, '')
}

const findings = []
const targets = process.argv.slice(2).filter((a) => !a.startsWith('-'))
const strict = process.argv.includes('--strict')
const files = targets.length
  ? targets.flatMap((t) => (statSync(join(ROOT, t)).isDirectory() ? walk(join(ROOT, t)) : [join(ROOT, t)]))
  : walk(DOCS)

for (const file of files) {
  const page = relative(DOCS, file).replace(/\\/g, '/')
  const raw = readFileSync(file, 'utf8')
  const diagrams = (raw.match(/```mermaid/g) ?? []).length
  const body = strip(raw)
  // 页级只看「叙述文字」里的符号：表格行与清单项本来就是查表用的，不算密度
  const bodyProse = body
    .split(/\r?\n/)
    .filter((l) => !/^\s*\|/.test(l) && !/^\s*[-*] /.test(l) && !/^\s*\d+\. /.test(l))
    .join('\n')
  const codes = (bodyProse.match(/`[^`]*`/g) ?? []).length
  const links = (bodyProse.match(/\]\([^)]*\)/g) ?? []).length
  const proseChars = body
    .replace(/`[^`]*`/g, '')
    .replace(/\]\([^)]*\)/g, '')
    .replace(/[\s#*|>-]/g, '').length
  const lookup = STRUCTURAL.test(body.slice(0, 400))

  if (!lookup && diagrams === 0 && codes + links >= PAGE_MIN_SYMBOLS) {
    findings.push({ page, kind: '无图', detail: `${codes + links} 个符号 / ${proseChars} 字，0 张图` })
  }

  if (lookup) continue

  for (const block of body.split(/\r?\n\s*\r?\n/)) {
    const t = block.trim()
    if (!t || /^#/.test(t) || /^\|/.test(t) || /^- /.test(t) || /^\d+\. /.test(t)) continue
    const n = (t.match(/`[^`]*`/g) ?? []).length
    if (n < PARAGRAPH_MIN_CODES) continue
    const len = t.replace(/`[^`]*`/g, '').length
    if (!len) continue
    const per100 = (n * 100) / len
    if (per100 >= PARAGRAPH_MAX_PER_100) {
      findings.push({
        page,
        kind: '段落',
        detail: `${n} 个符号 / ${len} 字（每 100 字 ${per100.toFixed(1)} 个）：「${t.slice(0, 38)}…」`
      })
    }
  }
}

if (!findings.length) {
  console.log('正文体检通过：没有超密段落，也没有「符号多但无图」的页。')
} else {
  const byPage = new Map()
  for (const f of findings) {
    if (!byPage.has(f.page)) byPage.set(f.page, [])
    byPage.get(f.page).push(f)
  }
  for (const [page, list] of [...byPage].sort()) {
    console.log(`\n${page}`)
    for (const f of list) console.log(`  · [${f.kind}] ${f.detail}`)
  }
  console.log(`\n共 ${findings.length} 处，涉及 ${byPage.size} 页。`)
}

if (strict && findings.length) process.exit(1)
