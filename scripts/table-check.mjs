#!/usr/bin/env node
/**
 * 表格体检：源码里的表能不能被真的渲染成 <table>。
 *
 *   npm run check:tables
 *
 * 查三件事：
 * 1. 每个表格块第二行是不是合法分隔行（没有就不是表）
 * 2. 每行列数是否与分隔行一致（单元格里的裸 `|` 会把表切歪——最常见的一种坏法）
 * 3. 表前是否留了空行（紧贴段落的表格不会被解析）
 *
 * 顺带数一下构建产物里的 <table>，与源码表格块数量对齐。
 */
import { readFileSync, readdirSync, statSync, existsSync } from 'node:fs'
import { join, relative } from 'node:path'

const ROOT = new URL('..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
const DOCS = join(ROOT, 'docs')
const DIST = join(DOCS, '.vitepress', 'dist')
const SEP = /^\s*\|(\s*:?-{2,}:?\s*\|)+\s*$/

function walk(dir) {
  const out = []
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) {
      if (name === '.vitepress' || name === 'public') continue
      out.push(...walk(full))
    } else if (name.endsWith('.md')) out.push(full)
  }
  return out
}

const problems = []
const counts = new Map()

for (const file of walk(DOCS)) {
  const page = relative(DOCS, file).replace(/\\/g, '/')
  const lines = readFileSync(file, 'utf8').split(/\r?\n/)
  let inFence = false
  let i = 0
  let n = 0

  while (i < lines.length) {
    if (/^\s*```/.test(lines[i])) {
      inFence = !inFence
      i++
      continue
    }
    if (inFence || !/^\s*\|/.test(lines[i])) {
      i++
      continue
    }

    const start = i
    const block = []
    while (i < lines.length && /^\s*\|/.test(lines[i])) block.push(lines[i++])

    if (block.length < 2 || !SEP.test(block[1])) {
      problems.push(`无分隔行  ${page}:${start + 1}  「${block[0].trim()}」`)
      continue
    }
    n++

    const cols = block[1].trim().replace(/\|$/, '').split('|').length
    block.forEach((row, k) => {
      if (k === 1) return
      const c = row.trim().replace(/\|$/, '').split(/(?<!\\)\|/).length
      if (c !== cols) {
        problems.push(`列数不符  ${page}:${start + k + 1}  应为 ${cols} 列，实为 ${c} 列（单元格里的裸 | 会把表切歪）`)
      }
    })

    if (start > 0) {
      const prev = lines[start - 1]
      if (prev.trim() !== '' && !/^\s*#/.test(prev)) {
        problems.push(`前缺空行  ${page}:${start + 1}  上一行「${prev.trim().slice(0, 28)}」`)
      }
    }
  }

  counts.set(page, n)
}

const total = [...counts.values()].reduce((a, b) => a + b, 0)
console.log(`源码表格块：${total}`)
if (problems.length) {
  console.log(`格式问题：${problems.length}`)
  for (const p of problems) console.log('  ' + p)
} else {
  console.log('格式问题：0')
}

if (existsSync(DIST)) {
  const mismatch = []
  for (const [page, n] of counts) {
    let html = page.replace(/\.md$/, '.html')
    if (page === 'index.md') html = 'index.html'
    const p = join(DIST, html)
    if (!existsSync(p)) continue
    const got = (readFileSync(p, 'utf8').match(/<table/g) ?? []).length
    if (got !== n) mismatch.push(`${page}  源码 ${n} 张 / 产物 ${got} 张`)
  }
  if (mismatch.length) {
    console.log(`产物与源码不一致：${mismatch.length}`)
    for (const m of mismatch) console.log('  ' + m)
  } else {
    console.log('产物与源码不一致：0')
  }
}

process.exit(problems.length ? 1 : 0)
