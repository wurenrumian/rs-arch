import type { Router } from 'vitepress'

/**
 * 图表放大：点图或右上角「放大」，全屏看细节。
 *
 * 浮层里放的是**原来那张 SVG**（不是副本）：pele 产出的 SVG 带内部 id
 * （marker、clipPath 等），复制一份会和页面里那份撞 id；移动过去就没事，
 * 关掉时按原位插回。
 *
 * 交互：滚轮 / 双指缩放（以指针为锚点）、拖动平移、双击在「适应」与 2.4 倍之间切换、
 * Esc 关闭、+ / - / 0 键盘缩放。
 */

const MIN_SCALE = 0.2
const MAX_SCALE = 16
const EDGE = 56
const STEP = 1.35

type View = { scale: number; x: number; y: number; w: number; h: number; fit: number }

let dialog: HTMLDivElement | null = null
let stage: HTMLDivElement | null = null
let canvas: HTMLDivElement | null = null
let percent: HTMLSpanElement | null = null

let active: SVGSVGElement | null = null
let origin: { parent: Node; next: Node | null; style: string | null } | null = null
let lastFocus: Element | null = null

const view: View = { scale: 1, x: 0, y: 0, w: 0, h: 0, fit: 1 }
const pointers = new Map<number, { x: number; y: number }>()
let pinch: { dist: number; scale: number; cx: number; cy: number; x: number; y: number } | null = null
/** 一次按下到抬起的记录：判断这是「点空白」还是「拖了一把」。 */
let press: { id: number; moved: number; backdrop: boolean } | null = null

function clamp(value: number, lo: number, hi: number) {
  return value < lo ? lo : value > hi ? hi : value
}

function render() {
  if (canvas) canvas.style.transform = `translate(${view.x}px, ${view.y}px) scale(${view.scale})`
  if (percent) percent.textContent = `${Math.round(view.scale * 100)}%`
}

/** 图比视口小就居中；比视口大就允许拖动，但不许整张拖出屏幕。 */
function clampPan() {
  if (!stage) return
  const vw = stage.clientWidth
  const vh = stage.clientHeight
  const w = view.w * view.scale
  const h = view.h * view.scale
  view.x = w <= vw ? (vw - w) / 2 : clamp(view.x, vw - w - EDGE, EDGE)
  view.y = h <= vh ? (vh - h) / 2 : clamp(view.y, vh - h - EDGE, EDGE)
}

function zoomAt(factor: number, px: number, py: number) {
  const before = view.scale
  const after = clamp(before * factor, MIN_SCALE, MAX_SCALE)
  if (after === before) return
  view.x = px - ((px - view.x) * after) / before
  view.y = py - ((py - view.y) * after) / before
  view.scale = after
  clampPan()
  render()
}

function fit() {
  if (!stage) return
  const vw = stage.clientWidth || window.innerWidth
  const vh = stage.clientHeight || window.innerHeight
  // 小图不放大到失真，最多 1.5 倍原生尺寸。
  view.fit = clamp(Math.min((vw - EDGE * 2) / view.w, (vh - EDGE * 2) / view.h), MIN_SCALE, 1.5)
  view.scale = view.fit
  view.x = (vw - view.w * view.fit) / 2
  view.y = (vh - view.h * view.fit) / 2
  render()
}

function step(factor: number) {
  if (!stage) return
  zoomAt(factor, stage.clientWidth / 2, stage.clientHeight / 2)
}

function build() {
  if (dialog) return

  dialog = document.createElement('div')
  dialog.className = 'rs-zoom'
  dialog.hidden = true
  dialog.setAttribute('role', 'dialog')
  dialog.setAttribute('aria-modal', 'true')
  dialog.setAttribute('aria-label', '图表放大查看')
  dialog.innerHTML = `
    <div class="rs-zoom-stage"><div class="rs-zoom-canvas"></div></div>
    <div class="rs-zoom-bar" role="toolbar" aria-label="缩放控制">
      <button type="button" data-zoom="out" aria-label="缩小" title="缩小（-）">−</button>
      <span class="rs-zoom-pct">100%</span>
      <button type="button" data-zoom="in" aria-label="放大" title="放大（+）">+</button>
      <button type="button" data-zoom="fit" title="适应窗口（0）">适应</button>
      <button type="button" data-zoom="close" title="关闭（Esc）">关闭</button>
      <span class="rs-zoom-hint">滚轮缩放 · 拖动平移 · 点空白关闭</span>
    </div>`

  document.body.appendChild(dialog)

  stage = dialog.querySelector<HTMLDivElement>('.rs-zoom-stage')
  canvas = dialog.querySelector<HTMLDivElement>('.rs-zoom-canvas')
  percent = dialog.querySelector<HTMLSpanElement>('.rs-zoom-pct')
  if (!stage || !canvas || !percent) return

  stage.addEventListener(
    'wheel',
    (e) => {
      e.preventDefault()
      const rect = stage!.getBoundingClientRect()
      const unit = e.deltaMode === 1 ? 0.05 : e.deltaMode === 2 ? 1 : 0.0015
      zoomAt(Math.exp(-e.deltaY * unit), e.clientX - rect.left, e.clientY - rect.top)
    },
    { passive: false }
  )

  stage.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button !== 0) return
    stage!.setPointerCapture(e.pointerId)
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
    if (pointers.size === 1) stage!.classList.add('is-dragging')
    if (pointers.size === 1) {
      // 记住这一下是不是点在图的空白处：没拖动就抬手时用它决定要不要退出。
      press = {
        id: e.pointerId,
        moved: 0,
        backdrop: !(active && e.target instanceof Node && active.contains(e.target))
      }
    }
    if (pointers.size === 2) {
      press = null
      const [a, b] = [...pointers.values()]
      const rect = stage!.getBoundingClientRect()
      pinch = {
        dist: Math.hypot(a.x - b.x, a.y - b.y) || 1,
        scale: view.scale,
        cx: (a.x + b.x) / 2 - rect.left,
        cy: (a.y + b.y) / 2 - rect.top,
        x: view.x,
        y: view.y
      }
    }
  })

  stage.addEventListener('pointermove', (e) => {
    const before = pointers.get(e.pointerId)
    if (!before) return
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY })

    if (pointers.size === 1) {
      const dx = e.clientX - before.x
      const dy = e.clientY - before.y
      if (press && press.id === e.pointerId) press.moved += Math.abs(dx) + Math.abs(dy)
      view.x += dx
      view.y += dy
      clampPan()
      render()
      return
    }

    if (pointers.size === 2 && pinch) {
      const [a, b] = [...pointers.values()]
      const rect = stage!.getBoundingClientRect()
      const cx = (a.x + b.x) / 2 - rect.left
      const cy = (a.y + b.y) / 2 - rect.top
      const dist = Math.hypot(a.x - b.x, a.y - b.y) || 1
      const k = clamp(pinch.scale * (dist / pinch.dist), MIN_SCALE, MAX_SCALE) / pinch.scale
      view.scale = pinch.scale * k
      view.x = cx - (pinch.cx - pinch.x) * k
      view.y = cy - (pinch.cy - pinch.y) * k
      clampPan()
      render()
    }
  })

  const release = (e: PointerEvent) => {
    const last = pointers.size === 1
    const tap = !!press && press.id === e.pointerId && press.moved < 8 && press.backdrop
    pointers.delete(e.pointerId)
    if (pointers.size < 2) pinch = null
    if (pointers.size === 0) stage!.classList.remove('is-dragging')
    if (last && tap && e.type === 'pointerup') {
      press = null
      close()
      return
    }
    if (pointers.size === 0) press = null
  }
  stage.addEventListener('pointerup', release)
  stage.addEventListener('pointercancel', release)

  stage.addEventListener('dblclick', (e) => {
    // 只在图上双击才切换倍率；空白处的那一下是用来退出的。
    if (!active || !(e.target instanceof Node) || !active.contains(e.target)) return
    if (view.scale > view.fit * 1.6) fit()
    else zoomAt((view.fit * 2.4) / view.scale, stage!.clientWidth / 2, stage!.clientHeight / 2)
  })

  dialog.addEventListener('click', (e) => {
    const btn = (e.target as Element | null)?.closest<HTMLElement>('[data-zoom]')
    if (!btn) return
    const action = btn.dataset.zoom
    if (action === 'close') close()
    else if (action === 'in') step(STEP)
    else if (action === 'out') step(1 / STEP)
    else if (action === 'fit') fit()
  })

  window.addEventListener('resize', () => {
    if (!dialog || dialog.hidden) return
    clampPan()
    render()
  })
}

function open(svg: SVGSVGElement) {
  build()
  if (!dialog || !stage || !canvas) return
  if (active) close()

  lastFocus = document.activeElement
  press = null

  const box = svg.getBoundingClientRect()
  const vb = svg.viewBox?.baseVal
  view.w = vb && vb.width > 0 ? vb.width : box.width || 800
  view.h = vb && vb.height > 0 ? vb.height : box.height || 600

  origin = { parent: svg.parentNode!, next: svg.nextSibling, style: svg.getAttribute('style') }
  active = svg
  canvas.appendChild(svg)
  svg.style.maxWidth = 'none'
  svg.style.width = `${view.w}px`
  svg.style.height = `${view.h}px`

  dialog.hidden = false
  document.documentElement.classList.add('rs-zoom-open')
  fit()
  dialog.querySelector<HTMLButtonElement>('[data-zoom="close"]')?.focus({ preventScroll: true })
}

function close() {
  if (!dialog || dialog.hidden) return
  press = null
  if (active && origin) {
    if (origin.style === null) active.removeAttribute('style')
    else active.setAttribute('style', origin.style)
    origin.parent.insertBefore(active, origin.next)
  }
  active = null
  origin = null
  dialog.hidden = true
  if (canvas) canvas.style.transform = ''
  document.documentElement.classList.remove('rs-zoom-open')
  if (lastFocus instanceof HTMLElement) lastFocus.focus({ preventScroll: true })
  lastFocus = null
}

function onKey(e: KeyboardEvent) {
  if (!dialog || dialog.hidden) return

  if (e.key === 'Escape') {
    e.preventDefault()
    close()
    return
  }
  if (e.key === '+' || e.key === '=') {
    e.preventDefault()
    step(STEP)
    return
  }
  if (e.key === '-' || e.key === '_') {
    e.preventDefault()
    step(1 / STEP)
    return
  }
  if (e.key === '0') {
    e.preventDefault()
    fit()
    return
  }
  if (e.key === 'Tab') {
    const items = [...dialog.querySelectorAll<HTMLElement>('button')]
    if (!items.length) return
    const first = items[0]
    const last = items[items.length - 1]
    if (e.shiftKey && document.activeElement === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && document.activeElement === last) {
      e.preventDefault()
      first.focus()
    }
  }
}

function onClick(e: MouseEvent) {
  if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return
  const target = e.target as Element | null
  if (!target) return
  if (dialog && !dialog.hidden) return
  // 拖选图里的文字时不要弹浮层。
  if (window.getSelection()?.toString().trim()) return

  const trigger = target.closest<HTMLElement>('.rs-zoom-btn')
  if (trigger) {
    const svg = trigger.closest('.rs-diagram-wrap')?.querySelector('svg')
    if (svg) {
      e.preventDefault()
      open(svg as SVGSVGElement)
    }
    return
  }

  const svg = target.closest('.rs-diagram svg')
  if (svg) open(svg as SVGSVGElement)
}

export function setupDiagramZoom(router: Router) {
  if (typeof document === 'undefined') return

  document.addEventListener('click', onClick)
  document.addEventListener('keydown', onKey)

  // 换页时把浮层收掉，免得盖住新页面。
  const previous = router.onAfterRouteChanged
  router.onAfterRouteChanged = (to) => {
    previous?.(to)
    if (dialog && !dialog.hidden) close()
  }
}
