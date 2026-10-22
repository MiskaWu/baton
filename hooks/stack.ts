// 輸入框上方那一塊（AbovePrompt）是所有 mod 共用的一個位置：引擎只問一次，畫最外層 hook 回的那一棵樹。
// 回了自己的樹又不叫 next，裡層的 mod 和引擎的問卷就整個不見——10-22 baton 自己這樣蓋掉別人，
// 也被裝在它前面、同樣這樣寫的 mod 蓋掉。所以大家照同一個約定「疊」不「佔」（README「和其他 mod 共用」）：
// 往下傳的 maxRows 扣掉自己要的列數，拿 next(e) 畫回來的樹，把自己的疊在上面。
//
// 這裡是純函式，不碰 $：baton 要知道下層畫的佔了幾列，才知道自己的卡片視窗還剩多少。
// 別的 mod 的樹 baton 量不到，只能照元件估；估得不準的代價只是少放一張卡、或引擎多捲一列。

import { ROW, wide } from './visual'

/** baton 至少要的列數：頁首一列＋最矮的一張卡（三列）。往下傳 maxRows 時先扣掉這些。 */
export const BAND_MIN_ROWS = 4

/** 樹的一個節點，只看估列數用得到的欄位；別的 mod 畫什麼都可能，所以一律當成不確定的資料讀。 */
type Node = { type?: unknown; props?: Record<string, unknown>; children?: unknown }

/** 間距的步階名稱換成列：圖形介面的 xs、sm 比一列矮，算 0。 */
const STEP: Record<string, number> = { xs: 0, sm: 0, md: 1, lg: 1, xl: 2 }

function space(value: unknown): number {
  if (typeof value === 'number') {
    return Math.max(0, Math.round(value))
  }

  return typeof value === 'string' ? (STEP[value] ?? 0) : 0
}

/** 上下兩邊加起來佔幾列（margin 或 padding）：個別一邊的寫法優先，再來 Y、再來四邊。 */
function vertical(props: Record<string, unknown>, name: 'margin' | 'padding'): number {
  const both = props[`${name}Y`] ?? props[name]

  return space(props[`${name}Top`] ?? both) + space(props[`${name}Bottom`] ?? both)
}

/** 左右兩邊加起來佔幾欄。 */
function horizontal(props: Record<string, unknown>, name: 'margin' | 'padding'): number {
  const both = props[`${name}X`] ?? props[name]

  return space(props[`${name}Left`] ?? both) + space(props[`${name}Right`] ?? both)
}

function cells(line: string): number {
  let width = 0
  for (const ch of line) {
    width += wide(ch) ? 2 : 1
  }

  return width
}

/** 一段字在 columns 欄寬裡佔幾列：照換行切，會折行的每行依寬度折（中日韓全形算兩欄）。 */
export function textRows(text: string, columns: number, wraps = true): number {
  const width = Math.max(1, columns)

  return text.split('\n').reduce((sum, line) => sum + (wraps ? Math.max(1, Math.ceil(cells(line) / width)) : 1), 0)
}

/** 節點裡的字串起來（Text 裡可以再包 Text）。 */
function plain(node: unknown): string {
  if (typeof node === 'string' || typeof node === 'number') {
    return String(node)
  }
  if (Array.isArray(node)) {
    return node.map(plain).join('')
  }

  return typeof node === 'object' && node !== null ? plain((node as Node).children) : ''
}

/** Svg 的高度換成列：有給 height 就用它，沒有就讀 <svg> 自己寫的高度（桌面板一列 19px）。 */
function svgRows(props: Record<string, unknown>): number {
  const own = /<svg\b[^>]*?\sheight="([\d.]+)"/.exec(String(props.source ?? ''))?.[1]
  const px = typeof props.height === 'number' ? props.height : own === undefined ? NaN : Number(own)

  return Number.isFinite(px) ? Math.max(1, Math.ceil(px / ROW)) : 1
}

function boxRows(box: Node, columns: number): number {
  const props = box.props ?? {}

  // 疊在別的元素上的（例如卡片上的按鈕列）不另外佔列
  if (props.display === 'none' || props.position === 'absolute') {
    return 0
  }

  const margin = vertical(props, 'margin')

  if (typeof props.height === 'number') {
    return props.height + margin
  }

  const border = typeof props.borderStyle === 'string' ? 2 : 0
  const inner = columns - border - horizontal(props, 'padding') - horizontal(props, 'margin')
  const kids = (Array.isArray(box.children) ? box.children : [])
    .map(child => treeRows(child, inner))
    .filter(rows => rows > 0)
  const isColumn = typeof props.flexDirection === 'string' && props.flexDirection.startsWith('column')
  const gap = space(props.rowGap ?? props.gap)
  // 直排疊起來，橫排取最高的那個（各自都當有整行寬可折，寧可估少一點）
  const body =
    kids.length === 0 ? 0 : isColumn ? kids.reduce((sum, rows) => sum + rows, 0) + gap * (kids.length - 1) : Math.max(...kids)

  // 什麼都沒畫的 Box（測試底下的 <Box />、下層讓路時的空位）不佔列
  if (body === 0 && border === 0) {
    return 0
  }

  return body + border + vertical(props, 'padding') + margin
}

/**
 * 一棵別人畫的樹在帶子裡大約佔幾列。
 *
 * 引擎自己的節點（`{ type: 'engine' }`）算 0：問卷佔著帶子時 baton 整個讓路，其他時候引擎在這裡什麼都不畫。
 * 不認得的元件至少算一列。
 */
export function treeRows(node: unknown, columns: number): number {
  if (node === null || node === undefined || typeof node === 'boolean') {
    return 0
  }
  if (typeof node === 'string' || typeof node === 'number') {
    return textRows(String(node), columns)
  }
  if (Array.isArray(node)) {
    return node.reduce((sum: number, child) => sum + treeRows(child, columns), 0)
  }

  const element = node as Node
  const props = element.props ?? {}

  switch (element.type) {
    case 'engine':
      return 0
    case 'Box':
      return boxRows(element, columns)
    case 'Text':
      return textRows(plain(element.children), columns, props.wrap === undefined || props.wrap === 'wrap')
    case 'Button':
      return textRows(String(props.label ?? plain(element.children)), columns, false)
    case 'Svg':
      return svgRows(props)
    case 'Code':
      return textRows(String(props.source ?? ''), columns)
    case 'Markdown':
      return textRows(String(props.text ?? ''), columns)
    case 'Raster':
    case 'Image':
      return typeof props.rows === 'number' ? props.rows : 1
    case 'Client':
      return typeof props.height === 'number' ? props.height : 1
    default:
      return 1
  }
}
