// 指令帶子的卡片：純函式，給資料、回 SVG 字串，不碰 $。
// 桌面板用 Svg 畫，終端機照舊用文字（register.tsx 排除 terminal）。
// 起手式來自 mod-polish 的 kit/visual-kit.ts，強調色換成 shell 的粉紅（和桌面板的 bashBorder 同一家）。
// 尺寸照 2026-10-22 在桌面板實測：一列 19px、內容區一欄約 7.9px、帶子視窗 12 列。

import type { BandCommand } from '../types'
import { STATUS as STATES, statusOf } from './commands'
import type { Status } from './commands'
import { EXIT_ONLY, SKIP_MARK } from './redact'

export type Drawing = { source: string; alt: string; height: number; animated?: boolean }
type Accent = { light: string; dark: string; lightText: string; darkText: string }

/** 卡片要的那一筆。 */
export type CardCommand = BandCommand

const ACCENTS: Record<string, Accent> = {
  sh: { light: '#be185d', dark: '#f472b6', lightText: '#9d174d', darkText: '#f9a8d4' }, // shell 粉紅
}
const STATUS: Record<string, Accent> = {
  ok: { light: '#0b8a3a', dark: '#3fbf6a', lightText: '#0a6b2e', darkText: '#6fd892' },
  warn: { light: '#d99a06', dark: '#f5b52e', lightText: '#7a5300', darkText: '#f5c451' },
  crit: { light: '#c8322f', dark: '#f06a63', lightText: '#9e2320', darkText: '#ff8f88' },
}

const FONT = `'Segoe UI Variable Text','Segoe UI',-apple-system,BlinkMacSystemFont,'PingFang TC','Microsoft JhengHei UI','Microsoft JhengHei','Noto Sans TC','Noto Sans CJK TC',sans-serif`
const MONO = `'Cascadia Mono','JetBrains Mono',Consolas,ui-monospace,'Noto Sans Mono CJK TC',monospace`

function classes(name: string, c: Accent, dark: boolean): string {
  const v = dark ? c.dark : c.light
  const t = dark ? c.darkText : c.lightText
  const k = dark ? 0.16 : 0.1
  return `.${name}{fill:${v}}.${name}S{stroke:${v}}.${name}K{fill:${v};fill-opacity:${k}}.${name}T{fill:${t}}`
}

function style(): string {
  const all = { ...ACCENTS, ...STATUS }
  const light = Object.entries(all).map(([n, c]) => classes(n, c, false)).join('')
  const dark = Object.entries(all).map(([n, c]) => classes(n, c, true)).join('')
  return (
    `<style>` +
    `text{font-family:${FONT};}.m{font-family:${MONO};}` +
    `.t1{fill:#0b0b0b}.t2{fill:#52514e}.t3{fill:#77766f}` +
    `.hair{stroke:#e4e3de}.panel{fill:#f7f6f2}.chip{fill:#e9e8e2}.ink{stroke:#3b3a36}` +
    light +
    `@media (prefers-color-scheme: dark){` +
    `.t1{fill:#f0efec}.t2{fill:#c3c2b7}.t3{fill:#97968e}` +
    `.hair{stroke:#3a3a35}.panel{fill:#232321}.chip{fill:#34342f}.ink{stroke:#d6d5cd}` +
    dark +
    `}</style>`
  )
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;')
}

export const wide = (ch: string) => /[ᄀ-ᅟ⺀-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/.test(ch)

/** 估計的字寬（px）：中日韓一個字級寬；mono 每個半形 0.6 個字級。SVG 不會量字，靠它截斷與斷行。 */
export function textWidth(s: string, size: number, mono = false): number {
  let w = 0
  for (const ch of s) w += wide(ch) ? size : mono ? size * 0.6 : /[A-Z0-9@%]/.test(ch) ? size * 0.62 : size * 0.54
  return w
}

function fit(s: string, size: number, max: number, mono = false): string {
  if (textWidth(s, size, mono) <= max) return s
  let out = ''
  for (const ch of s) {
    if (textWidth(`${out}${ch}…`, size, mono) > max) break
    out += ch
  }
  return `${out}…`
}

const CLOSING = /^[，。、；：！？」』）】〉》,.;:!?)]/
const OPENING = /[「『（【〈《(]$/

/**
 * 斷行：照 tokens 排，標點不放行首、開括號不留行尾；一個詞本身就比一行長時逐字切。
 * 不截斷，行數由呼叫端決定。
 */
function wrapTokens(tokens: string[], size: number, maxOf: number | ((line: number) => number), mono: boolean): string[] {
  const widthAt = (line: number) => (typeof maxOf === 'number' ? maxOf : maxOf(line))
  const lines: string[] = []
  let cur = ''
  for (const tok of tokens) {
    if (textWidth(cur + tok, size, mono) > widthAt(lines.length) && cur.trim() && !CLOSING.test(tok)) {
      // 開括號跟著下一行走
      const open = OPENING.exec(cur.trimEnd())
      const head = open ? cur.trimEnd().slice(0, -1) : cur
      lines.push(head.trimEnd())
      cur = (open ? open[0] : '') + tok.trimStart()
    } else {
      cur += tok
    }
  }
  if (cur.trim()) lines.push(cur.trimEnd())
  // 一個詞比一行長的才逐字切；切的寬度取最窄的那一行，保守一點
  const narrow = Math.min(widthAt(0), widthAt(1))
  return lines.flatMap((line, i) => (textWidth(line, size, mono) > widthAt(i) ? hardBreak(line, size, narrow, mono) : [line]))
}

/**
 * 一個詞比一行長（長路徑、長網址）：在寬度內最後一個 / 或 - 後面切，
 * 找不到夠後面的分隔字才逐字切——路徑一層一層斷，比斷在半個資料夾名中間好讀。
 */
function hardBreak(s: string, size: number, max: number, mono: boolean): string[] {
  const out: string[] = []
  let rest = s
  while (textWidth(rest, size, mono) > max) {
    let cut = 0
    let w = 0
    const chars = [...rest]
    while (cut < chars.length && w + textWidth(chars[cut] ?? '', size, mono) <= max) {
      w += textWidth(chars[cut] ?? '', size, mono)
      cut += 1
    }
    const soft = Math.max(chars.slice(0, cut).lastIndexOf('/'), chars.slice(0, cut).lastIndexOf('-'))
    const at = soft >= cut * 0.5 ? soft + 1 : Math.max(1, cut)
    out.push(chars.slice(0, at).join(''))
    rest = chars.slice(at).join('')
  }
  if (rest !== '') out.push(rest)
  return out
}

/** 內文斷行：中文逐字、英文不切開單字。 */
function wrapProse(s: string, size: number, max: number, mono = false): string[] {
  return wrapTokens(s.match(/[A-Za-z0-9._\-/\\:@~]+|\s+|./gu) ?? [], size, max, mono)
}

/**
 * 指令斷行：先照原文的換行切（heredoc、多行指令），每一行再只在空白處折——
 * 指令裡的 ~/ 、= 、引號都是詞的一部分，不能從中間拆。折下來的續行標 ↳、縮排 14px。
 * widthAt 給「整張卡第 i 個畫面行」能用的寬度：第一行讓出右上角的回傳膠囊、第二行讓出按鈕。
 */
export function wrapCommand(command: string, widthAt: number | ((line: number) => number)): { text: string; cont: boolean }[] {
  const at = (i: number) => (typeof widthAt === 'number' ? widthAt : widthAt(i))
  const out: { text: string; cont: boolean }[] = []
  for (const raw of command.split('\n')) {
    const tokens = raw.replace(/\t/g, '  ').match(/\S+|\s+/g) ?? []
    const start = out.length
    const parts = wrapTokens(tokens, CMD, line => at(start + line) - (line > 0 ? 14 : 0), true)
    if (parts.length === 0) out.push({ text: '', cont: false })
    parts.forEach((text, i) => out.push({ text, cont: i > 0 }))
  }
  return out
}

function svg(w: number, h: number, body: string): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${style()}${body}</svg>`
}

function txt(x: number, y: number, cls: string, size: number, s: string, extra = ''): string {
  return `<text x="${x}" y="${y}" class="${cls}" font-size="${size}" ${extra}>${esc(s)}</text>`
}

function pill(x: number, cy: number, tone: string, s: string, anchor: 'start' | 'end' = 'start'): { svg: string; w: number } {
  const w = Math.ceil(textWidth(s, 11)) + 14
  const left = anchor === 'end' ? x - w : x
  const bg = tone === 'none' ? 'chip' : `${tone}K`
  const fg = tone === 'none' ? 't2' : `${tone}T`
  return { svg: `<rect x="${left}" y="${cy - 9}" width="${w}" height="18" rx="9" class="${bg}"/>` + txt(left + 7, cy + 4, fg, 11, s, 'font-weight="600"'), w }
}

// ---------------------------------------------------------------------------
// 尺寸：桌面板以「列」排版，一列 19px（10-22 實測）。卡片高度一律是 19 的倍數，
// 卡與卡之間的間距畫在 SVG 裡（Box 的 gap 是一整列，太寬）。
//
// 卡片至少 3 列：
//   第 1 列：狀態記號＋指令第一行。
//   第 2 列：右邊疊著「執行」「複製」兩顆 Button（register.tsx 用 position absolute、top={TOOLBAR_ROW}）。
//   之後：底下那列「原因／執行中／結果」（不畫虛線，靠留白和膠囊分段）。
// 按鈕不放第 1 列：桌面板的按鈕約 20px，比一列高，放第 1 列上緣會壓到框線、下緣貼著虛線，
// 頁首的按鈕也會貼著框（10-22 截圖「很擠」）。放第 2 列，上下都碰不到框。
// 框的上緣往下縮 FRAME_TOP，和頁首、上一張卡之間留出空隙。
// ---------------------------------------------------------------------------

export const ROW = 19
/**
 * 內容區一欄約幾 px（10-22 /probe fit：82 欄寬的 flexGrow 容器把 300px 樣本卡撐成約 648px）。
 * 估差一點沒關係：卡片放在會撐滿的容器裡，誤差只是 1–2% 的等比縮放。
 */
export const COL = 7.9

const CMD = 12
const LH = 17
const NOTE = 12
/** 框的上緣離卡片頂端多遠：和頁首的按鈕、上一張卡留空隙。 */
const FRAME_TOP = 4
/** 卡片下方留給下一張的間距。 */
const GAP_BELOW = 2
const PAD_BOTTOM = 6
/** 指令最後一行的基線到底下那列中線的距離：不畫虛線，靠這段留白和膠囊分開兩段。 */
const NOTE_GAP = 18
const GUTTER = 32
const PAD_R = 12
/** 第一行的基線：框上緣往下留 5px 以上再放字（10-22 真畫面：15.5 時字貼著框線）。 */
const FIRST_BASELINE = 21

/** 兩顆按鈕疊在卡片的第幾列（從 0 數）。 */
export const TOOLBAR_ROW = 1

/**
 * 右邊按鈕區的寬度（欄）：兩顆只畫圖示的按鈕「▶ 1」「⧉」橫排＋間距，再加右邊 1 欄內距。
 * 第 2 列的內容（指令第二行，或一行指令時底下那列的第一行）要讓出這塊。
 */
export const TOOLBAR_COLS = 11
const TOOLBAR_PX = TOOLBAR_COLS * COL

/**
 * 卡片最多畫幾行指令。按得到「執行」的指令一定要全部看得到（你看過才按），
 * 所以超過的不給執行鈕，只能複製到終端機跑。
 * 7 行指令＋4 行結果（頭 1 行、⋯ 略過、尾 2 行）剛好是一張卡的上限 11 列（視窗 12 列減頁首）。
 */
export const MAX_COMMAND_LINES = 7
export const MAX_NOTE_LINES = 4

type Bottom = { tone: string; label: string; body: string; mono: boolean; dim?: boolean }

/**
 * 卡片底下那一列：沒跑過是「原因」（為什麼要你按），按下去是「執行中」（最後一行輸出），
 * 跑完是結果（exit code ＋ 輸出或錯誤）。同一個位置，講的永遠是「這一筆現在怎樣」。
 * 依狀態查表：Record 少一個狀態就編譯不過（和 commands.ts 的 STATUS 同一套）。
 */
const BOTTOM: Record<Status, (c: CardCommand, width: number) => Bottom> = {
  idle: (c, width) => {
    if (tooLong(c, width)) {
      // 原因照留，下一行說為什麼沒有執行鈕
      const why = c.reason ?? 'Claude 沒寫為什麼要你跑'
      return { tone: 'sh', label: '原因', body: `${why}\n太長沒有全部顯示，不能從這裡跑：按「複製」到終端機看完再跑`, mono: false }
    }
    return c.reason === undefined
      ? { tone: 'none', label: '原因', body: 'Claude 沒寫為什麼要你跑', mono: false, dim: true }
      : { tone: 'sh', label: '原因', body: c.reason, mono: false }
  },
  running: c => ({ tone: 'warn', label: '執行中', body: c.progress ?? '已交給 bash', mono: c.progress !== undefined }),
  done: c => ({ tone: 'ok', label: '完成', body: c.note ?? '（沒有輸出）', mono: c.report !== EXIT_ONLY }),
  failed: c => ({ tone: 'crit', label: c.exitCode === undefined ? '沒跑成' : `exit ${c.exitCode}`, body: c.note ?? '', mono: c.exitCode !== undefined }),
  stopped: c => ({ tone: 'none', label: '已停止', body: c.note ?? '你按了停止', mono: c.note !== undefined }),
  terminal: c => ({ tone: 'crit', label: '要用終端機', body: c.note ?? '這行需要輸入，按「複製」到終端機跑', mono: false }),
}

export function bottomLine(c: CardCommand, width: number): Bottom {
  return BOTTOM[statusOf(c)](c, width)
}



/** 這一筆給不給「執行」鈕：要你全部看得到才給；要輸入密碼的按了也沒用，只留複製。 */
export function runnable(c: CardCommand, width: number): boolean {
  return STATES[statusOf(c)].runnable && !tooLong(c, width)
}


/**
 * 指令照卡片的寬度折行：前兩個畫面行都讓出右邊的按鈕——
 * 按鈕在第 2 列，第一行的字下移後下緣也碰得到它（10-22 真畫面）。
 */
function commandLines(c: CardCommand, width: number): { text: string; cont: boolean }[] {
  const room = width - GUTTER - PAD_R
  return wrapCommand(c.command, i => (i <= TOOLBAR_ROW ? room - TOOLBAR_PX : room))
}

export function tooLong(c: CardCommand, width: number): boolean {
  return commandLines(c, width).length > MAX_COMMAND_LINES
}

/** 左欄的狀態記號：沒跑過是 shell 提示符 $，其餘是圓點＋符號。依狀態查表，和 STATUS 同一套。 */
const GLYPH: Record<Status, (x: number, cy: number) => string> = {
  idle: (x, cy) => txt(x, cy + 4.5, 'sh m', 13, '$', 'text-anchor="middle" font-weight="700"'),
  running: (x, cy) =>
    `<circle cx="${x}" cy="${cy}" r="7.5" class="warnK"/>` +
    `<circle cx="${x}" cy="${cy}" r="3.8" class="warn"><animate attributeName="opacity" values="1;.25;1" dur="1.2s" repeatCount="indefinite"/></circle>`,
  done: (x, cy) =>
    `<circle cx="${x}" cy="${cy}" r="7.5" class="okK"/><path d="M${x - 3.4} ${cy}l2.4 2.5 4.6-5" fill="none" class="okS" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/>`,
  failed: (x, cy) => cross(x, cy),
  terminal: (x, cy) => cross(x, cy),
  stopped: (x, cy) => `<circle cx="${x}" cy="${cy}" r="7.5" class="chip"/><rect x="${x - 3}" y="${cy - 3}" width="6" height="6" rx="1" class="t3"/>`,
}

function cross(x: number, cy: number): string {
  return `<circle cx="${x}" cy="${cy}" r="7.5" class="critK"/><path d="M${x - 2.8} ${cy - 2.8}l5.6 5.6M${x + 2.8} ${cy - 2.8}l-5.6 5.6" class="critS" stroke-width="1.8" stroke-linecap="round"/>`
}

function glyph(c: CardCommand, cy: number): string {
  return GLYPH[statusOf(c)](GUTTER / 2, cy)
}

/** 底下那列折行；一行指令時它的第一行落在第 2 列，要讓出按鈕。 */
function bottomLayout(n: Bottom, width: number, cmdLines: number): string[] {
  const pillW = Math.ceil(textWidth(n.label === '執行中' ? '執行中　　' : n.label, 11)) + 14
  const room = width - GUTTER - PAD_R - pillW - 8
  const firstRoom = cmdLines === 1 ? room - TOOLBAR_PX : room
  const out: string[] = []
  for (const line of n.body.split('\n')) {
    const tokens = line.match(/[A-Za-z0-9._\-/\\:@~]+|\s+|./gu) ?? []
    out.push(...wrapTokens(tokens, NOTE, i => (out.length + i === 0 ? firstRoom : room), n.mono))
  }
  return out
}

/**
 * 卡片內各段的位置：底下那列的中線，以及內容到哪裡為止。
 * 10-22 真畫面：框到字、字到虛線、虛線到膠囊都只有 3–5px，看起來擠——拿掉虛線，
 * 把高度平均成框到字約 6px、字到膠囊約 7px、膠囊到框底約 6px。
 */
function layout(cmdLines: number, noteLines: number): { noteMid: number; bottom: number } {
  const noteMid = FIRST_BASELINE + (cmdLines - 1) * LH + NOTE_GAP
  const bottom = noteMid + 4 + (noteLines - 1) * LH + 5 + PAD_BOTTOM
  return { noteMid, bottom }
}

/** 內容高度換成列數：框下方再留 GAP_BELOW，取 19 的倍數；至少 3 列（按鈕在第 2 列，上下都要有框）。 */
function rowsFor(cmdLines: number, noteLines: number): number {
  return Math.max(TOOLBAR_ROW + 2, Math.ceil((layout(cmdLines, noteLines).bottom + GAP_BELOW) / ROW))
}

/** 這張卡佔幾列（給視窗挑卡用，不畫）。 */
export function cardRows(c: CardCommand, width: number): number {
  const cmd = Math.min(commandLines(c, width).length, MAX_COMMAND_LINES)
  const note = Math.min(bottomLayout(bottomLine(c, width), width, cmd).length, MAX_NOTE_LINES)
  return rowsFor(cmd, note)
}

/**
 * 一筆指令的卡片：左欄狀態記號、指令原文（等寬、照原文換行再在空白處折）、
 * 底下那列講「為什麼要你跑」或「跑得怎樣」。帶給 Claude 的筆數在頁首講一次就好。
 *
 * 按鈕不在圖裡——SVG 收不到點擊。「執行」「複製」是兩顆 Button，疊在這張圖第 2 列的右邊
 * （圖在那裡替它們留了空），看起來就在圓框裡。
 */
export function commandCard(c: CardCommand, index: number, width: number): Drawing {
  const cmdRoom = width - GUTTER - PAD_R
  const all = commandLines(c, width)
  let lines = all.slice(0, MAX_COMMAND_LINES)
  const hidden = all.length - lines.length
  if (hidden > 0) lines = [...lines.slice(0, -1), { text: '', cont: false }]
  const n = bottomLine(c, width)
  const noteAll = bottomLayout(n, width, lines.length)
  const notes = noteAll.slice(0, MAX_NOTE_LINES)
  if (noteAll.length > notes.length) {
    const last = notes.length - 1
    // 輸出是一行一行的（用空白接），原因是被折開的一句話（直接接）
    const sep = n.mono ? ' ' : ''
    notes[last] = fit(`${notes[last]}${sep}${noteAll.slice(MAX_NOTE_LINES).join(sep)}`, NOTE, cmdRoom - 60, n.mono)
  }
  const rows = rowsFor(lines.length, notes.length)
  const h = rows * ROW
  const at = layout(lines.length, notes.length)

  let body = `<rect x=".5" y="${FRAME_TOP + 0.5}" width="${width - 1}" height="${h - FRAME_TOP - GAP_BELOW - 1}" rx="8" class="panel hair" stroke-width="1"/>`
  body += glyph(c, FIRST_BASELINE - 4)

  lines.forEach((line, i) => {
    const y = FIRST_BASELINE + i * LH
    if (hidden > 0 && i === lines.length - 1) {
      body += txt(GUTTER, y, 't3', 11, `⋯ 還有 ${hidden + 1} 行沒顯示`)
      return
    }
    if (line.cont) body += txt(GUTTER - 1, y, 't3 m', CMD, '↳')
    body += txt(GUTTER + (line.cont ? 14 : 0), y, 't1 m', CMD, line.text, 'xml:space="preserve"')
  })

  const cy = at.noteMid
  // 執行中的膠囊裡多三個輪流亮的點；放在膠囊裡，不用去猜比例字的輸出有多寬
  const running = c.status === 'running'
  const p = pill(GUTTER, cy, n.tone, running ? `${n.label}　　` : n.label)
  body += p.svg
  if (running) {
    const dx = GUTTER + p.w - 20
    for (let k = 0; k < 3; k++) {
      body += `<circle cx="${dx + k * 5}" cy="${cy}" r="1.6" class="warnT"><animate attributeName="opacity" values=".2;1;.2" dur="1.2s" begin="${k * 0.2}s" repeatCount="indefinite"/></circle>`
    }
  }
  const tx = GUTTER + p.w + 8
  const cls = n.tone === 'crit' ? 'critT' : n.dim === true ? 't3' : n.tone === 'sh' ? 't1' : 't2'
  notes.forEach((line, i) => {
    // 「⋯ 略過 N 行」是說明，不是輸出：淡字、一般字體
    const skip = line.startsWith(SKIP_MARK)
    body += txt(tx, cy + 4 + i * LH, skip ? 't3' : `${cls}${n.mono ? ' m' : ''}`, skip ? 11 : NOTE, line, 'xml:space="preserve"')
  })

  return {
    source: svg(width, h, body),
    alt: `第 ${index + 1} 筆指令：${c.command}。${n.label}：${n.body}${c.report === undefined ? '' : `。帶給 Claude：${c.report}`}`,
    height: h,
    animated: c.status === 'running',
  }
}

/**
 * 頁首（一列高）：終端圖示＋「指令 N 筆」，右邊是跑完、排著等一下送給 Claude 的筆數。
 * 狀態不在這裡重講——每張卡左欄的記號就是狀態（10-22「很擠」：頁首和卡片各講一次只是佔位）。
 * 視窗的 ↑↓ 與 ✕ 是旁邊的 Button。
 */
export function bandHeader(list: readonly CardCommand[], width: number, queued = 0): Drawing {
  const h = ROW
  let body =
    `<rect x="0" y="2" width="15" height="15" rx="4" class="shK"/>` +
    `<path d="M3.8 6.4l2.8 2.8-2.8 2.8M8 12.4h4" fill="none" class="shS" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"/>` +
    txt(22, 14, 't1', 12.5, '指令', 'font-weight="700"') +
    txt(22 + textWidth('指令', 12.5) + 7, 14, 't3', 11.5, `${list.length} 筆`)
  const note = queued > 0 ? `↗ 稍後送給 Claude ${queued} 筆` : ''
  if (note !== '') {
    body += txt(width, 14, 't3', 11, note, 'text-anchor="end"')
  }
  return {
    source: svg(width, h, body),
    alt: `指令 ${list.length} 筆${note === '' ? '' : `，${note}`}`,
    height: h,
  }
}

export type CardWindow = { first: number; last: number; above: number; below: number }

/** 從第 first 張開始，往後放到放不下為止（你用 ↑↓ 或滾輪捲過之後用這個）。 */
export function windowFrom(rows: readonly number[], budget: number, first: number): CardWindow {
  const start = Math.min(Math.max(first, 0), Math.max(rows.length - 1, 0))
  let last = start
  let used = rows[start] ?? 0
  while (last + 1 < rows.length && used + (rows[last + 1] ?? 0) <= budget) used += rows[++last] ?? 0
  return { first: start, last, above: start, below: rows.length - 1 - last }
}

/** 往下捲最多捲到第幾張開始：再往下就不會多看到任何一張。 */
export function lastFirst(rows: readonly number[], budget: number): number {
  let first = rows.length - 1
  let used = rows[first] ?? 0
  while (first - 1 >= 0 && used + (rows[first - 1] ?? 0) <= budget) used += rows[--first] ?? 0
  return Math.max(first, 0)
}

/**
 * 視窗挑卡：頁首固定佔一列，剩下的列數放「整張」的卡（不切半張）。
 * 全部放得下就全放；放不下時以 anchor（新進來的或執行中的那張）為準，先往後（較新）再往前補。
 * 回傳看得到的第一張與最後一張，以及上下各藏了幾筆（頁首的 ↑↓ 用）。
 */
export function windowFor(rows: readonly number[], budget: number, anchor: number): CardWindow {
  const total = rows.reduce((a, r) => a + r, 0)
  if (total <= budget) return { first: 0, last: rows.length - 1, above: 0, below: 0 }
  let first = anchor
  let last = anchor
  let used = rows[anchor] ?? 0
  while (last + 1 < rows.length && used + (rows[last + 1] ?? 0) <= budget) used += rows[++last] ?? 0
  while (first - 1 >= 0 && used + (rows[first - 1] ?? 0) <= budget) used += rows[--first] ?? 0
  return { first, last, above: first, below: rows.length - 1 - last }
}
