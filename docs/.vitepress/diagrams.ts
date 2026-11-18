import { PeleError, render } from 'pele'
import type { MarkdownRenderer } from 'vitepress'

/**
 * 把 ```mermaid 代码块在构建期渲染成内联 SVG。
 *
 * 这样页面里没有任何图表运行时：pele 同步出 SVG，客户端只加载这张图本身。
 * 配色走 --pele-* 的 CSS 变量（见 custom.css），所以亮暗主题切换不需要重渲染。
 */

/** 便宜的 djb2：同一个图源得到同样的 id 前缀，diff 里不会到处跳。 */
function hash(source: string): string {
  let h = 5381
  for (let i = 0; i < source.length; i++) h = ((h * 33) ^ source.charCodeAt(i)) >>> 0
  return h.toString(36)
}

export function mermaidToSvg(md: MarkdownRenderer) {
  const fence = md.renderer.rules.fence!

  md.renderer.rules.fence = (tokens, idx, options, env, self) => {
    const token = tokens[idx]
    if (token.info.trim() !== 'mermaid') return fence(tokens, idx, options, env, self)

    const source = token.content.trim()
    const line = (token.map?.[0] ?? 0) + 1
    // 同一页可能放两张同源图，序号保证 id 不撞。
    const seq = (env.rsDiagram = (env.rsDiagram ?? 0) + 1)

    try {
      const { svg, width } = render(source, { idPrefix: `rs${hash(source)}-${seq}` })
      // 很宽的图（泳道、时间线）在正文栏里会被压得太小，给个可以横向滚动的标记。
      const wide = width >= 1100 ? ' rs-diagram-wrap--wide' : ''
      return (
        `<div class="rs-diagram-wrap${wide}">` +
        `<div class="rs-diagram">${svg}</div>` +
        '<button type="button" class="rs-zoom-btn" data-rs-zoom aria-haspopup="dialog" aria-label="放大这张图" title="放大查看">放大</button>' +
        '</div>\n'
      )
    } catch (error) {
      if (!(error instanceof PeleError)) throw error
      const where = `${env.path ?? '?'} 正文第 ${line} 行的 mermaid 块`
      throw new Error(`${where}画不出来（${error.code}）：${error.message}`)
    }
  }
}
