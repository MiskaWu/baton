import { atom, read, update } from 'claude-code'
import type {
  EngineInterface,
  HookStream,
  ProcessSpawnChunk,
  ProcessSpawnResult,
  Register,
  RenderElement,
  RenderSurface,
} from 'claude-code'

import type { BandCommand, BandView } from '../types'
import {
  actionIcon,
  actionLabel,
  applyOutcome,
  lastLine,
  markRunning,
  mergeCommands,
  outcomeOfRun,
  parseCommands,
  recoverAfterReload,
  setProgress,
  shorten,
  startFailure,
  STATUS,
  statusColor,
  statusOf,
} from './commands'
import type { RunOutcome } from './commands'
import { redact } from './redact'
import { BAND_MIN_ROWS, treeRows } from './stack'
import { COL, TOOLBAR_ROW, bandHeader, cardRows, commandCard, lastFirst, runnable, windowFor, windowFrom } from './visual'

/**
 * 配 id 用的序號。
 *
 * 只靠時間戳不夠：同一毫秒內收進來的兩筆會拿到同一個 id，而 id 就是繪製的 key，
 * 兩顆同 key 的按鈕會被引擎直接擋下來（測試的假時鐘不會走，剛好把它逼出來）。
 */
let seq = 0

function nextId(stamp: number): string {
  seq += 1

  return `${stamp}-${seq}`
}

// 三個值刻意宣告在這個模組裡：`claude plugin validate` 的掃描要能在同一份原始碼裡
// 看到 atom 的 plugin 與 key 是字面值，跨檔 import 它讀不到。

/** 待執行的指令清單。 */
export const pending = atom(
  { plugin: 'baton', key: 'pending' } as const,
  [] as BandCommand[],
)

/** 桌面板的卡片視窗：你捲到哪、或該讓哪一張進視窗。 */
export const view = atom(
  { plugin: 'baton', key: 'view' } as const,
  { first: null, anchor: null } as BandView,
)

/** 排著等你下一則訊息帶給 Claude 的執行摘要（已遮過金鑰）。 */
export const reports = atom(
  { plugin: 'baton', key: 'reports' } as const,
  [] as string[],
)

/** 執行中最後一行輸出最快多久更新一次卡片（ms）：聊天很多的指令不要每段都重畫。 */
const PROGRESS_MS = 250

/** 最多排幾筆摘要等著帶給 Claude；你很久沒說話時只帶最近的。 */
const MAX_REPORTS = 6

/**
 * 正在跑的子程序：按「■ 停止」時用它結束。只活在這個模組裡——
 * mod 重新載入時子程序跟著舊模組結束，`recoverAfterReload` 把那一筆標成「沒跑完」。
 */
const children = new Map<string, HookStream<ProcessSpawnChunk, ProcessSpawnResult>>()
const stopping = new Set<string>()

/** 桌面板上一次畫的視窗：滾輪換張要知道現在從第幾張開始、最多捲到哪。 */
let drawn: { requestId: string; first: number; maxFirst: number } | null = null

/**
 * 加進 Claude 系統提示的寫法規則：原因寫在哪、什麼該放進 bash 區塊、結果怎麼回來。
 *
 * 「只有寫進回覆裡的區塊才會變卡片」那條來自 10-22：Claude 在回合結束框的 recap 裡說「兩張卡片已經放上去了」，
 * 回覆裡卻一個 bash 區塊都沒寫，使用者看到的只有上一輪的舊卡——它說的和真的發生的分岔了。
 */
const GUIDE = [
  'Shell commands you hand the user to run (a ```bash fenced block) become cards above the prompt,',
  'via the baton plugin: one press runs the command as the user, outside your permission rules and hooks.',
  '- Make the first line of each such block a comment saying briefly, in the user\'s language, why the user rather',
  '  than you has to run it: `# 原因：<one short sentence>`. The card shows it; a block without it is flagged.',
  '- Keep each block one self-contained command the user can read in full; blocks over 7 lines get no run button.',
  '- Use bash fences only for commands meant for the user to run; put illustrative snippets in other fences.',
  '- Only a block written out in your reply\'s own text becomes a card: write it before any tool call that ends',
  '  your turn. Saying a card is up (in a recap, a tool\'s input or anywhere else) puts none there.',
  '- Each run\'s result comes back beside the user\'s next message, starting with [指令帶子], with secrets masked.',
].join('\n')

/** 結果的一句話，給 toast：狀態記號＋短指令。 */
function toastFor(command: BandCommand, outcome: RunOutcome): string {
  const what = shorten(command.command, 40)
  switch (outcome.status) {
    case 'done':
      return `✓ 完成：${what}`
    case 'terminal':
      return `這行要在終端機跑：${what}`
    case 'stopped':
      return `■ 已停止：${what}`
    default:
      return outcome.exitCode === undefined ? `✗ 沒跑完：${what}` : `✗ exit ${outcome.exitCode}：${what}`
  }
}

/**
 * 按鈕按下去：以你的身分直接執行（`bash -lc`），等於你在終端機打這一行。
 *
 * 刻意**不**走 `$.tool.call` 的 Bash：Claude 把指令交給你，通常就是因為它的權限規則或 hooks
 * 擋住了它；借同一條路，按鈕也會被同一層擋住。你看過卡片才按，這一下就是你自己的動作。
 * 代價寫在設計稿：不經過 Claude 的規則與 hooks、git 的 repo hooks 不跑、沒有終端機可以輸入。
 *
 * 跑的時候再按一次是「■ 停止」。輸出一段一段回來，卡片顯示最後一行（遮過金鑰）；
 * 跑完把遮過的摘要排進 `reports`，你下一則訊息時帶給 Claude。原始輸出只存在這個函式裡。
 */
async function runCommand($: EngineInterface, id: string): Promise<void> {
  const command = (await read($, pending)).find(item => item.id === id)

  if (command === undefined) {
    return
  }

  const child = children.get(id)

  if (command.status === 'running') {
    if (child !== undefined) {
      stopping.add(id)
      await child.return({ code: null, signal: 'SIGTERM' })
    }

    return
  }

  await update($, pending, list => markRunning(list, id))
  await update($, view, () => ({ first: null, anchor: id }))

  let output = ''
  let outcome: RunOutcome

  try {
    // 沒給 input：標準輸入一開始就關著，等你輸入的指令會立刻失敗，而不是卡住
    const stream = $.process.spawn({ argv: ['bash', '-lc', command.command] })
    children.set(id, stream)
    let shownLine = ''
    let shownAt = 0

    for await (const chunk of stream) {
      output += chunk.text
      const now = await $.clock.now()
      const line = redact(lastLine(output)).text

      if (line !== shownLine && now - shownAt >= PROGRESS_MS) {
        shownLine = line
        shownAt = now
        await update($, pending, list => setProgress(list, id, line))
      }
    }

    const end = await stream.result
    outcome = outcomeOfRun(command.command, { ...end, output, isStopped: stopping.has(id) })
  } catch (error) {
    // 按了停止的話，串流是被我們關掉的：那是「停止」，不是「沒跑成」
    outcome = stopping.has(id)
      ? outcomeOfRun(command.command, { code: null, signal: null, output, isStopped: true })
      : startFailure(command.command, error)
  } finally {
    children.delete(id)
    stopping.delete(id)
  }

  await update($, pending, list => applyOutcome(list, id, outcome))
  await update($, reports, list => [...list, outcome.report.text].slice(-MAX_REPORTS))
  $.ui.toast(toastFor(command, outcome))
}

/**
 * 把指令原文放上剪貼簿（不含「# 原因：」那行）。
 *
 * 畫面上的指令選不乾淨（卡片是圖、終端的選取會把框線一起帶走），所以複製交給按鈕：
 * `$.ui.copy` 要的 surface 由按下事件帶過來。
 */
async function copyCommand(
  $: EngineInterface,
  command: BandCommand,
  surface: RenderSurface,
): Promise<void> {
  const result = await $.ui.copy({ text: command.command, surface })
  $.ui.toast(result.isCopied === true ? '已複製指令' : '這個介面沒接住複製')
}

/** 清空：卡片、視窗都歸零。排著要帶給 Claude 的摘要留著——那是已經發生的事。 */
async function clearBand($: EngineInterface): Promise<void> {
  await update($, pending, () => [])
  await update($, view, () => ({ first: null, anchor: null }))
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'band',
      description: '把一行指令手動放進指令帶子；/band clear 清空',
    })
    // 重新載入前還在跑的那幾筆，子程序已經跟著舊模組結束了
    await update($, pending, recoverAfterReload)

    return next(e)
  })

  // 告訴 Claude 這條路怎麼用：原因寫在第一行、什麼該放進 bash 區塊、結果怎麼回來。
  on('prompt.compose', async ($, e, next) => {
    const composed = await next(e)

    return {
      sections: [...composed.sections, { id: 'baton:guide', text: GUIDE, scope: 'session' as const }],
    }
  })

  // 把排著的執行摘要帶給 Claude：附在你下一則訊息旁邊（你在畫面上看不到這段），帶完清掉。
  // 斜線指令不帶——它不一定會進到模型，帶了就丟了。
  on('prompt.submit', async ($, e, next) => {
    const queued = e.command === undefined ? await read($, reports) : []

    if (queued.length === 0) {
      return next(e)
    }

    const entered = await next({ ...e, context: [...(e.context ?? []), queued.join('\n\n')] })

    if (entered.drop === undefined) {
      await update($, reports, () => [])
    }

    return entered
  })

  // 手動放一筆進帶子，或清空。Claude 沒給指令、但自己想留一個常用的時候用。
  on('command.run', { command: 'band' }, async ($, e) => {
    const args = e.args.trim()

    if (args === '' || args === 'clear') {
      await clearBand($)

      return { text: '指令帶子已清空。' }
    }

    const stamp = await $.clock.now()
    const merged = mergeCommands(await read($, pending), [{ command: args }], () => nextId(stamp))
    await update($, pending, () => merged)
    await update($, view, () => ({ first: null, anchor: merged.find(item => item.command === args)?.id ?? null }))

    return { text: `已放進指令帶子：${shorten(args)}` }
  })

  // 收指令：Claude 的回覆進轉錄時，把裡面的 shell 圍欄區塊收進帶子，最新那張自動進視窗。
  // 只收主對話的：子代理的回覆你在對話裡看不到，它引用的指令收進來只會把真正要你跑的擠掉（只留 MAX_KEPT 筆）。
  //
  // 這是會過路的 hook——轉錄的每一列都經過它，所以整段包在 try 裡：
  // 收指令失敗最多就是帶子少一張卡，絕不能連帶讓那一列進不了轉錄。
  on('session.append', async ($, e, next) => {
    try {
      if (e.message.type === 'assistant' && e.agentId === undefined) {
        const text = e.message.content
          .map(block => (block.type === 'text' ? block.text : ''))
          .join('\n')
        const found = parseCommands(text)

        if (found.length > 0) {
          const stamp = await $.clock.now()
          const merged = mergeCommands(await read($, pending), found, () => nextId(stamp))
          const newest = found[found.length - 1]?.command
          await update($, pending, () => merged)
          await update($, view, () => ({ first: null, anchor: merged.find(item => item.command === newest)?.id ?? null }))
        }
      }
    } catch (error) {
      $.ui.toast(`指令帶子：收指令失敗（${String(error)}）`)
    }

    return next(e)
  })

  // 桌面板換張：滾輪在帶子上時，一格換一張卡，不讓引擎真的捲（頁首要一直看得到）。
  // 只有卡片放不下時才有這件事——放得下的時候引擎根本不會送滾輪事件（10-22 實測）。
  on('ui.scroll', async ($, e, next) => {
    const window = drawn

    if (
      e.component !== 'AbovePrompt' ||
      e.origin.kind !== 'person' ||
      window === null ||
      e.requestId !== window.requestId
    ) {
      return next(e)
    }

    const step = Math.sign(e.by)
    const first = Math.min(Math.max(window.first + step, 0), window.maxFirst)

    if (step !== 0 && first !== window.first) {
      await update($, view, () => ({ first, anchor: null }))
    }

    return {}
  })

  // 畫帶子。沒有待執行的指令、或問卷佔著帶子，就讓路。
  //
  // 這一塊是所有 mod 共用的（stack.ts 開頭）：有卡片時也不獨佔，先讓下層畫——往下傳的 maxRows
  // 扣掉 baton 至少要的列數——再把帶子疊在下層畫的上面，視窗只用剩下的列。
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const list = await read($, pending)

    if (list.length === 0 || e.props.hasSurvey) {
      drawn = null

      return next(e)
    }

    const below = await next({ ...e, props: { ...e.props, maxRows: Math.max(0, e.props.maxRows - BAND_MIN_ROWS) } })
    // 下層沒畫東西（引擎的空位、空的 Box）就當帶子只有 baton，照原本的畫法
    const belowRows = treeRows(below, e.props.bodyColumns)
    const isShared = belowRows > 0
    const room = e.props.maxRows - belowRows

    const table = $.ui.resolve(e)
    const { Box, Button, Text } = table
    const stacked = (band: RenderElement): RenderElement =>
      isShared ? (
        <Box flexDirection="column">
          {band}
          {below}
        </Box>
      ) : (
        band
      )
    // 終端機沒有 Svg：元件表裡有也不能畫，畫下去整棵樹被拒、引擎改畫它自己的，而且不報錯
    const Svg = e.surface !== 'terminal' && 'Svg' in table ? table.Svg : undefined

    if (Svg === undefined) {
      drawn = null
      const total = list.length

      // 終端機照舊用文字：全部展開（終端機的帶子超出時引擎自己會捲），每筆多一行原因。
      return stacked(
        <Box flexDirection="column" borderStyle="round" borderColor="bashBorder" paddingX={2}>
          <Box flexDirection="row" gap={2}>
            <Text bold color="bashBorder">
              指令
            </Text>
            <Text dimColor>{`${total} 筆`}</Text>
            <Box flexGrow={1} />
            <Button key="dismiss" label="✕" onPress={() => clearBand($)} />
          </Box>

          {list.map((command, index) => {
            const color = statusColor(command)
            const result = command.status === 'running' ? command.progress ?? '執行中…' : command.note

            return (
              <Box key={`item-${command.id}`} flexDirection="column" gap={1} marginTop={1}>
                <Box flexDirection="row" gap={1}>
                  <Text dimColor bold>
                    {String(index + 1)}
                  </Text>
                  <Box key={`frame-${command.id}`} flexGrow={1} borderStyle="round" borderDimColor paddingX={1}>
                    <Text wrap="wrap">{command.command}</Text>
                  </Box>
                </Box>

                <Box marginLeft={2}>
                  <Text wrap="wrap" dimColor>
                    {command.reason === undefined ? '（Claude 沒寫為什麼要你跑）' : `原因：${command.reason}`}
                  </Text>
                </Box>

                <Box flexDirection="row" gap={2} marginLeft={2}>
                  {command.status === 'terminal' ? null : (
                    <Button
                      key={`run-${command.id}`}
                      label={actionLabel(command)}
                      onPress={() => runCommand($, command.id)}
                      {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                    />
                  )}
                  <Button
                    key={`copy-${command.id}`}
                    label="⧉ 複製"
                    onPress={press => copyCommand($, command, press.surface)}
                  />
                  {command.report === undefined ? null : <Text dimColor>{`↗ ${command.report}`}</Text>}
                </Box>

                {result === undefined ? null : (
                  <Box
                    marginLeft={2}
                    borderStyle="round"
                    paddingX={1}
                    {...(color === undefined ? { borderDimColor: true } : { borderColor: color })}
                  >
                    <Text wrap="wrap" {...(color === undefined ? { dimColor: true } : { color })}>
                      {result}
                    </Text>
                  </Box>
                )}
              </Box>
            )
          })}
        </Box>,
      )
    }

    // 桌面板：頁首固定一列，下面只放整張的卡；放不下的用頁首的 ↑↓（或滾輪）換張。
    // 卡片放在直排容器裡會被等比撐滿整條帶子，所以寬度照欄數估就好，差一點只是 1–2% 的縮放。
    const columns = e.props.bodyColumns
    const cardPx = Math.max(320, Math.floor(columns * COL))
    const rows = list.map(command => cardRows(command, cardPx))
    const budget = Math.max(2, room - 1)
    const at = await read($, view)
    const anchor = at.anchor === null ? -1 : list.findIndex(command => command.id === at.anchor)
    const window =
      at.first === null
        ? windowFor(rows, budget, anchor < 0 ? list.length - 1 : anchor)
        : windowFrom(rows, budget, Math.min(at.first, lastFirst(rows, budget)))
    const isWindowed = window.above + window.below > 0
    // 和別人共用帶子時滾輪交給引擎捲整條：攔下來換張的話，被擠出視窗的下層內容就捲不到了
    drawn = isWindowed && !isShared ? { requestId: e.requestId, first: window.first, maxFirst: lastFirst(rows, budget) } : null

    const hintCols = (window.above > 0 ? 11 : 0) + (window.below > 0 ? 11 : 0)
    const queued = (await read($, reports)).length
    const header = bandHeader(list, Math.max(160, Math.floor((columns - 4 - hintCols) * COL)), queued)
    const shownRows = 1 + rows.slice(window.first, window.last + 1).reduce((sum, r) => sum + r, 0)
    // 卡片放不下時，視窗裡卡片下面空著的列放被藏起來的卡的一行預覽（按了就換到那張）。
    // 只有 baton 時再多墊到比視窗高一列：引擎才會把滾輪事件送來，ui.scroll 再攔下來換張；
    // 最後一列在視窗外，看不到，留空。和別人共用時不墊——墊出來的列會把下層的字擠出視窗。
    const spare = isWindowed ? Math.max(0, room - shownRows) : 0
    const hidden = list
      .map((command, index) => ({ command, index }))
      .filter(({ index }) => index < window.first || index > window.last)
    const peeks = hidden.slice(0, spare)
    const blanks = isWindowed && !isShared ? Math.max(0, room + 1 - shownRows - peeks.length) : 0
    const peekWidth = Math.max(20, columns - 18)

    return stacked(
      <Box flexDirection="column">
        <Box flexDirection="row" gap={1}>
          <Box flexDirection="column" flexGrow={1}>
            <Svg key="header" source={header.source} alt={header.alt} />
          </Box>
          {window.above > 0 ? (
            <Button
              key="window-up"
              label={`↑ 上面 ${window.above} 筆`}
              onPress={() => update($, view, () => ({ first: window.first - 1, anchor: null }))}
            />
          ) : null}
          {window.below > 0 ? (
            <Button
              key="window-down"
              label={`↓ 下面 ${window.below} 筆`}
              onPress={() => update($, view, () => ({ first: window.first + 1, anchor: null }))}
            />
          ) : null}
          <Button key="dismiss" label="✕" onPress={() => clearBand($)} />
        </Box>

        {list.map((command, index) => {
          if (index < window.first || index > window.last) {
            return null
          }

          const card = commandCard(command, index, cardPx)

          // 「執行」「複製」疊在卡片圖第 2 列的右邊（圖在那裡替它們留了空），看起來就在圓框裡。
          // 桌面板畫的是 label（子元素不畫），所以 label 直接放圖示：▶ 執行、■ 停止、↻ 再跑、⧉ 複製
          return (
            <Box key={`item-${command.id}`} flexDirection="column">
              {/* 刻意不開 isInteractive：開了桌面板改用 iframe 畫，框的高度和圖對不上，卡片上下多出一大塊、
                  按鈕浮到卡片外（10-22 真畫面）。執行中看得出在跑，靠的是底下那行輸出每秒在換。 */}
              <Svg key={`card-${command.id}`} source={card.source} alt={card.alt} />
              <Box position="absolute" top={TOOLBAR_ROW} right={1} flexDirection="row" gap={1}>
                {runnable(command, cardPx) ? (
                  <Button
                    key={`run-${command.id}`}
                    label={actionIcon(command)}
                    onPress={() => runCommand($, command.id)}
                    {...(index < 9 ? { hotkey: String(index + 1) } : {})}
                  />
                ) : null}
                <Button key={`copy-${command.id}`} label="⧉" onPress={press => copyCommand($, command, press.surface)} />
              </Box>
            </Box>
          )
        })}

        {peeks.map(({ command, index }) => (
          <Button
            key={`peek-${command.id}`}
            plain
            dimColor
            label={`${index < window.first ? '↑' : '↓'} 第 ${index + 1} 筆　${STATUS[statusOf(command)].mark} ${shorten(command.command, peekWidth)}`}
            onPress={() => update($, view, () => ({ first: index, anchor: null }))}
          />
        ))}
        {Array.from({ length: blanks }, (_, k) => (
          <Text key={`filler-${k}`}> </Text>
        ))}
      </Box>,
    )
  })
}
