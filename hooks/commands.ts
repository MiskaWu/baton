import type { BandCommand } from '../types'
import { EXIT_ONLY, excerpt, oneLine, printsSecrets, redact, reportFor } from './redact'

/**
 * 帶子上最多留幾筆；再多就照 STATUS 的 evict 擠掉舊的（跑完的先走，沒跑過的最後才走）。
 *
 * 桌面板一次只放得下 12 列（頁首 1 列＋整張的卡），放不下的用頁首的 ↑↓ 換張。
 * 9 ＝執行鈕的數字鍵 1–9。
 *
 * ⟳ 11-11：原本是 3 筆、最舊的先丟。Claude 一則回覆給了 4 個指令，第 4 個把同一則的第 1 個擠掉，
 * 那張卡你根本沒看到、也點不到。所以兩件事一起改：上限放寬，而且**同一則新進來的、正在跑的一律不丟**
 * ——上限是用來清舊的，不能拿來砍 Claude 剛交給你的。不要的那張按卡片上的 ✕ 拿掉（removeCommand）。
 */
export const MAX_KEPT = 9

// 只收 shell 圍欄。Claude 的慣例是「要使用者執行的指令」才標成 shell 區塊，
// 所以語言標籤本身就是篩選條件——不標 shell 的程式碼區塊不會被收進來。
const FENCE = /```(?:bash|sh|shell|zsh)[^\n]*\n([\s\S]*?)```/g

// 圍欄第一行的「# 原因：…」：為什麼這行要你按。註解在 shell 裡什麼都不做，複製到終端機也照樣能跑。
const REASON = /^#\s*(?:原因|reason)\s*[:：]\s*(.+)$/i

/** 從一段訊息文字裡抓出所有 shell 圍欄區塊：指令本體，以及第一行寫的原因。 */
export function parseCommands(text: string): { command: string; reason?: string }[] {
  const found: { command: string; reason?: string }[] = []
  for (const match of text.matchAll(FENCE)) {
    const lines = (match[1] ?? '').trim().split('\n')
    const head = REASON.exec((lines[0] ?? '').trim())
    const command = (head ? lines.slice(1) : lines).join('\n').trim()
    if (command === '') {
      continue
    }
    const reason = head?.[1]?.trim()
    found.push(reason === undefined || reason === '' ? { command } : { command, reason })
  }
  return found
}

/**
 * 把新抓到的指令併進待執行清單。
 *
 * 同樣的指令不重複收（同一則訊息裡重複、或我覆述上一則的指令都算）；
 * 重複的那筆如果這次寫了原因而舊的沒有，補上。超過 MAX_KEPT 筆時由 trimOld 清舊的。
 */
export function mergeCommands(
  pending: readonly BandCommand[],
  found: readonly { command: string; reason?: string }[],
  idFor: (index: number) => string,
): BandCommand[] {
  const merged = [...pending]
  // 這一則提到的（新收的，或覆述舊的）：清舊的時候不能動它們
  const mentioned = new Set<string>()
  found.forEach((item, index) => {
    const at = merged.findIndex(old => old.command === item.command)
    if (at >= 0) {
      const old = merged[at]
      if (old !== undefined) {
        mentioned.add(old.id)
        if (old.reason === undefined && item.reason !== undefined) {
          merged[at] = { ...old, reason: item.reason }
        }
      }
      return
    }
    const id = idFor(index)
    mentioned.add(id)
    merged.push({ id, ...item })
  })
  return trimOld(merged, mentioned)
}

/**
 * 超過 MAX_KEPT 筆時一筆一筆拿掉：照 STATUS 的 evict 由小到大、同一級先拿最舊的。
 * `keep` 裡的（這一則剛提到的）與 evict 為 null 的（正在跑）不拿；只剩這些時寧可超過上限。
 */
export function trimOld(list: readonly BandCommand[], keep: ReadonlySet<string>): BandCommand[] {
  const out = [...list]
  while (out.length > MAX_KEPT) {
    let victim = -1
    let rank = Infinity
    out.forEach((item, index) => {
      const evict = STATUS[statusOf(item)].evict
      if (keep.has(item.id) || evict === null || evict >= rank) {
        return
      }
      victim = index
      rank = evict
    })
    if (victim < 0) {
      break
    }
    out.splice(victim, 1)
  }
  return out
}

/**
 * 按卡片上的 ✕：拿掉這一張。
 * 正在跑的不拿（先按 ■ 停止）：子程序還在跑，結果回來時要有一張卡可以寫。
 */
export function removeCommand(pending: readonly BandCommand[], id: string): BandCommand[] {
  return pending.filter(item => item.id !== id || !removable(item))
}

/** 只留「這筆是什麼、為什麼要你跑」，上一次的結果全部清掉。 */
function fresh(item: BandCommand): BandCommand {
  return item.reason === undefined
    ? { id: item.id, command: item.command }
    : { id: item.id, command: item.command, reason: item.reason }
}

/**
 * 標成「正在跑」。
 *
 * 這是按下去的即時回饋：卡片的狀態記號開始呼吸、按鈕變「■ 停止」。上一次的結果一併清掉。
 */
export function markRunning(pending: readonly BandCommand[], id: string): BandCommand[] {
  return pending.map(item => (item.id === id ? { ...fresh(item), status: 'running' as const } : item))
}

/** 執行中最後一行輸出（呼叫端已經遮過金鑰）。 */
export function setProgress(pending: readonly BandCommand[], id: string, line: string): BandCommand[] {
  return pending.map(item =>
    item.id === id && item.status === 'running' ? { ...item, progress: line } : item,
  )
}

/** 一次執行的結果：卡片怎麼標，以及要帶給 Claude 的摘要。 */
export type RunOutcome = {
  status: 'done' | 'failed' | 'stopped' | 'terminal'
  exitCode?: number
  /** 卡片底下那列，已遮過金鑰。 */
  note: string
  /** 帶給 Claude 的那段字與卡片上的小膠囊。 */
  report: { text: string; badge: string }
}

/** 把結果寫回那一筆。 */
export function applyOutcome(
  pending: readonly BandCommand[],
  id: string,
  outcome: RunOutcome,
): BandCommand[] {
  return pending.map(item => {
    if (item.id !== id) {
      return item
    }
    const next: BandCommand = { ...fresh(item), status: outcome.status, note: outcome.note, report: outcome.report.badge }
    return outcome.exitCode === undefined ? next : { ...next, exitCode: outcome.exitCode }
  })
}

/** mod 重新載入時還標著「執行中」的：那個子程序已經跟著舊模組結束了，結果不得而知。 */
export function recoverAfterReload(pending: readonly BandCommand[]): BandCommand[] {
  return pending.map(item =>
    item.status === 'running'
      ? { ...fresh(item), status: 'failed' as const, note: '沒跑完：mod 重新載入了，這一筆的結果不知道' }
      : item,
  )
}

/**
 * 要你在終端機輸入才跑得下去的跡象（sudo 密碼、ssh 金鑰密碼、互動確認）。
 * 按鈕跑的指令沒有終端機、標準輸入一開始就關著，這類一定失敗。
 */
const NEEDS_TERMINAL =
  /(a terminal is required|no tty present|must be run from a terminal|not a tty|stdin is not a terminal|inappropriate ioctl for device|\[sudo\] password|enter passphrase|askpass)/i

export function needsTerminal(output: string): boolean {
  return NEEDS_TERMINAL.test(output)
}

/** 輸出裡最後一行有字的（執行中顯示用），太長就截。 */
export function lastLine(output: string, limit = 160): string {
  const lines = output.split('\n').map(line => line.trimEnd())
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i]?.trim() ?? ''
    if (line !== '') {
      return line.length <= limit ? line : `${line.slice(0, limit - 1)}…`
    }
  }
  return ''
}

/** 卡片上顯示的輸出：遮過金鑰、只留頭 1 行＋尾 2 行。原始輸出不會存進狀態。 */
export function cardNote(output: string, limit = 160): string {
  const lines = redact(output)
    .text.split('\n')
    .filter(line => line.trim() !== '')
    .map(line => line.trimEnd())
  const kept = excerpt(lines).map(line => (line.length <= limit ? line : `${line.slice(0, limit - 1)}…`))
  return kept.length === 0 ? '（沒有輸出）' : kept.join('\n')
}

/**
 * 把一次執行翻成「要怎麼標那一筆、帶什麼給 Claude」。
 *
 * 抽成純函式：exit code、要終端機、會印金鑰的指令、被停止，每條分支都值得咬住，
 * 而真的子程序在測試裡只能用假的。
 */
export function outcomeOfRun(
  command: string,
  run: { code: number | null; signal: string | null; output: string; isStopped?: boolean },
): RunOutcome {
  const report = reportFor(command, run.code ?? undefined, run.output)
  const gated = printsSecrets(command) !== undefined
  const lines = run.output.split('\n').filter(line => line.trim() !== '').length
  const note = gated ? `輸出 ${lines} 行沒有顯示：這類指令常印出金鑰，要看請到終端機跑` : cardNote(run.output)

  if (run.isStopped === true || (run.code === null && run.signal !== null)) {
    // 卡片上留停下時的輸出（停在哪裡通常就是重點），還沒輸出就直說
    const stoppedNote = run.output.trim() === '' ? '還沒有輸出就停了' : note
    return {
      status: run.isStopped === true ? 'stopped' : 'failed',
      note: run.isStopped === true ? stoppedNote : `被 ${run.signal ?? '訊號'} 結束`,
      // 頭一行的「→ 沒跑成」換成實情；輸出照樣附上（停在哪裡通常就是重點）
      report: {
        text: report.text.replace('→ 沒跑成', run.isStopped === true ? '→ 使用者按了停止' : `→ 被 ${run.signal ?? '訊號'} 結束`),
        badge: report.badge,
      },
    }
  }
  if (run.code !== 0 && needsTerminal(run.output)) {
    return {
      status: 'terminal',
      ...(run.code === null ? {} : { exitCode: run.code }),
      note: '這行需要你輸入（密碼或確認），這裡沒有地方打字：按「複製」到終端機跑',
      report,
    }
  }
  return {
    status: run.code === 0 ? 'done' : 'failed',
    ...(run.code === null ? {} : { exitCode: run.code }),
    note,
    report: gated ? { text: report.text, badge: EXIT_ONLY } : report,
  }
}

/** 根本沒跑起來（bash 起不來、mod 的呼叫丟錯）。 */
export function startFailure(command: string, error: unknown): RunOutcome {
  const why = redact(String(error)).text
  return {
    status: 'failed',
    note: `沒跑成：${why}`,
    report: { text: `${reportFor(command, undefined, '').text.split('\n')[0] ?? ''}（沒跑起來：${why}）`, badge: '回傳摘要' },
  }
}

/** 一筆指令的狀態；還沒按過的是 idle。 */
export type Status = NonNullable<BandCommand['status']> | 'idle'

export function statusOf(command: BandCommand): Status {
  return command.status ?? 'idle'
}

/**
 * 每種狀態在各處長什麼樣子，集中在這一張表。
 *
 * 以前分散在六個 switch（按鈕圖示、終端文字、終端顏色、預覽記號、卡片記號、卡片底下那列），
 * 多一種狀態就要記得改六處——加「已停止」時就差點漏。Record 少填一個狀態會直接編譯失敗。
 * - icon：桌面板執行鈕的圖示（桌面板畫的是 label，所以圖示就是 label）：▶ 執行、■ 停止、↻ 再跑。
 * - terminal：終端機執行鈕的字；記號講上一次的結果，詞講按下去會做什麼。
 * - color：終端機的狀態色；可按的不上色。
 * - mark：預覽列上的一個字，和卡片左欄的記號同一套。
 * - runnable：給不給執行鈕（要你輸入的按了也沒用，只留複製）。
 * - evict：清單滿了先清誰（trimOld）：數字小的先走；null 不清。跑完的先走，沒跑過的最後才走，正在跑的不動。
 * - removable：卡片上給不給 ✕（removeCommand）；正在跑的要先停止。
 */
export const STATUS: Record<
  Status,
  {
    icon: string
    terminal: string
    color?: 'success' | 'error' | 'warning'
    mark: string
    runnable: boolean
    evict: number | null
    removable: boolean
  }
> = {
  idle: { icon: '▶', terminal: '▶ 執行', mark: '$', runnable: true, evict: 2, removable: true },
  running: { icon: '■', terminal: '■ 停止', color: 'warning', mark: '…', runnable: true, evict: null, removable: false },
  done: { icon: '↻', terminal: '✓ 再執行', color: 'success', mark: '✓', runnable: true, evict: 0, removable: true },
  failed: { icon: '↻', terminal: '✗ 重試', color: 'error', mark: '✗', runnable: true, evict: 1, removable: true },
  stopped: { icon: '↻', terminal: '■ 再執行', color: 'warning', mark: '■', runnable: true, evict: 1, removable: true },
  terminal: { icon: '↻', terminal: '✗ 重試', color: 'error', mark: '✗', runnable: false, evict: 1, removable: true },
}

export function removable(command: BandCommand): boolean {
  return STATUS[statusOf(command)].removable
}

export function actionIcon(command: BandCommand): string {
  return STATUS[statusOf(command)].icon
}

export function actionLabel(command: BandCommand): string {
  return STATUS[statusOf(command)].terminal
}

export function statusColor(command: BandCommand): 'success' | 'error' | 'warning' | undefined {
  return STATUS[statusOf(command)].color
}

/** 指令壓成一行再截短；給 toast、預覽列與提醒用，卡片上的指令不截斷。 */
export function shorten(command: string, width = 46): string {
  const flat = oneLine(command)
  return flat.length <= width ? flat : `${flat.slice(0, width - 1)}…`
}
