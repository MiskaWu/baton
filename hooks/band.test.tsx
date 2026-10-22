import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

import { treeRows } from './stack'

const PLUGIN = 'baton'

// 桌面板實測：帶子視窗 12 列、95 欄
const PROPS: RenderPropsOf['AbovePrompt'] = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: 95,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}

const SURFACES = ['terminal', 'desktop'] as const

/** 測試直接送 prompt.submit，要補引擎平常自己填的欄位：你在輸入框按 Enter。 */
const TYPED = { wait: false, origin: { kind: 'composer' } } as const

// 測試直接對引擎下 command.run，所以要補引擎平常自己填的兩個欄位。
const RUN_CONTEXT = {
  origin: { kind: 'plugin', name: 'band-test' },
  presentation: { isFullscreen: false, columns: 80 },
} as const

// 假金鑰用拼的，原始碼裡不出現一整串長得像真的 token
const FAKE_GLPAT = 'glpat-' + 'EXAMPLEexample'.repeat(2) + '0000'

/**
 * 測試底下什麼都沒有：帶子讓路時要有人答 ui.render、toast 要有人收、時鐘要會回答。
 * toast 的結果是 `{ value: undefined }`，不補的話每次 toast 都被丟掉並在報告留一行。
 */
function bottom(on: On, said: string[] = []): ReturnType<typeof mock.clock> {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('ui.toast', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })

  return mock.clock(on, { now: 1_700_000_000_000 })
}

/** 最後一張卡跑完後等多久才送給 Claude（register.tsx 的 SETTLE_MS）。 */
const SETTLE_MS = 3_000

/** 送進 prompt.submit 的每一則：誰送的、字、附帶的 context。 */
type Submitted = { text: string; origin: { kind: string; name?: string }; context?: readonly string[] }

function submissions(on: On): Submitted[] {
  const sent: Submitted[] = []
  on('prompt.submit', ($, e) => {
    sent.push({ text: e.text, origin: e.origin as Submitted['origin'], context: e.context })

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })

  return sent
}

const fromBaton = (sent: Submitted[]) => sent.filter(s => s.origin.kind === 'plugin' && s.origin.name === 'baton')

/** 假的子程序：每個指令吐一行；`slow` 那個要等 release() 才結束，其餘馬上以 0 結束。 */
function gatedSpawn(on: On, slow: string): { release: () => void } {
  let open = (): void => {}
  const gate = new Promise<void>(resolve => {
    open = resolve
  })
  on('process.spawn', async function* ($, e) {
    yield { stream: 'stdout' as const, text: `ran ${e.argv[2] ?? ''}\n` }
    if (e.argv[2] === slow) {
      await gate
    }

    return { value: { code: 0, signal: null } }
  })

  return { release: () => open() }
}

/** 假的子程序：記下收到的 argv，吐出 output、以 code 結束。 */
function fakeSpawn(on: On, seen: string[][], output: string, code: number): void {
  on('process.spawn', async function* ($, e) {
    seen.push([...e.argv])
    if (output !== '') {
      yield { stream: 'stdout' as const, text: output }
    }

    // 測試裡替 $ 的呼叫作答，結果要包成 { value }
    return { value: { code, signal: null } }
  })
}

// 桌面板的執行／複製只畫圖示（label 就是圖示），終端機是字：兩種都認
const RUN = /執行|重試|停止|^[▶■↻]$/
const AGAIN = /再執行|^↻$/
const COPY = /複製|^⧉$/

/** 依 label 找按鈕（沒有 label 才看畫出來的字）。 */
async function button(ui: { findAll: Function }, name: RegExp): Promise<{ key?: string; text?: string; props: { label?: unknown } } | undefined> {
  const all: { key?: string; text?: string; props: { label?: unknown } }[] = await ui.findAll({ type: 'Button' })

  return all.find(el => name.test(String(el.props.label ?? el.text ?? '')))
}

/** 文字或圖的 alt 裡找得到這段字（桌面板的卡片是圖，字在 alt 裡）。 */
async function shows(ui: { find: Function; findAll: Function }, text: RegExp): Promise<boolean> {
  if ((await ui.find({ text })) !== undefined) {
    return true
  }
  const svgs: { props: { alt?: unknown } }[] = await ui.findAll({ type: 'Svg' })

  return svgs.some(el => text.test(String(el.props.alt ?? '')))
}

test('沒有待執行指令時讓路，不畫帶子', async ($, on) => {
  bottom(on)

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    await ui.unmount()
  }
})

test('桌面板畫卡片（頁首＋每筆一張圖），終端機一張圖都沒有', async ($, on) => {
  bottom(on)
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'git push origin feat-login' })
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'make gen' })

  const desk = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect((await desk.findAll({ type: 'Svg' })).length).toBe(3)
  expect(await shows(desk, /git push origin feat-login/)).toBe(true)
  expect(await button(desk, RUN)).toBeDefined()
  // 只畫圖示：▶ 執行、⧉ 複製
  expect((await button(desk, RUN))?.props.label).toBe('▶')
  expect((await button(desk, COPY))?.props.label).toBe('⧉')
  await desk.unmount()

  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect((await term.findAll({ type: 'Svg' })).length).toBe(0)
  expect(await term.find({ type: 'Text', text: 'git push origin feat-login' })).toBeDefined()
  // 沒寫原因的，終端機也明講
  expect(await term.find({ type: 'Text', text: /沒寫為什麼/ })).toBeDefined()
  await term.unmount()
})

test('按下去以你的身分跑 bash -lc，跑完卡片留結果；送出前你先打了訊息，摘要搭那則帶給 Claude、不另外送', async ($, on) => {
  const seen: string[][] = []
  const said: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  const clock = bottom(on, said)
  fakeSpawn(on, seen, 'To gitlab:acme/server.git\n   a41c0f2..9be3d10  feat-login -> feat-login\n', 0)
  const sent: Submitted[] = []
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)
    sent.push({ text: e.text, origin: e.origin as Submitted['origin'], context: e.context })

    return { text: e.text, ...(e.context === undefined ? {} : { context: e.context }) }
  })

  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'git push origin feat-login' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: String((await button(ui, RUN))?.key) })

    expect(await button(ui, AGAIN)).toBeDefined()
    expect(await shows(ui, /a41c0f2\.\.9be3d10/)).toBe(true)
    await ui.unmount()
  }

  expect(seen[0]).toEqual(['bash', '-lc', 'git push origin feat-login'])
  expect(said.some(text => text.startsWith('✓ 完成'))).toBe(true)

  // 頁首說有幾筆排著要送給 Claude
  const before = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shows(before, /稍後送給 Claude 2 筆/)).toBe(true)
  await before.unmount()

  // 還沒送出你就打了訊息：兩次執行的摘要一起搭那則帶過去，帶完就清掉
  await $.prompt.submit({ ...TYPED, text: '推好了嗎？' })
  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shows(after, /稍後送給 Claude/)).toBe(false)
  await after.unmount()
  const rode = contexts.at(-1)?.join('\n') ?? ''
  expect(rode).toContain('[指令帶子] 使用者按了執行：git push origin feat-login → exit 0')
  await $.prompt.submit({ ...TYPED, text: '下一題' })
  expect(contexts.at(-1)).toBeUndefined()

  // 時間到了也不另外送一則：已經帶過了
  await clock.advance(SETTLE_MS * 2)
  expect(fromBaton(sent)).toEqual([])
})

test('跑完等一下就直接送給 Claude，不用等你下一則訊息；連續按的幾張合成一則', async ($, on) => {
  const seen: string[][] = []
  const clock = bottom(on)
  fakeSpawn(on, seen, 'ok\n', 0)
  const sent = submissions(on)
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'git push origin feat-login' })
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'git push origin v0.4.0' })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const runs: { key?: string; props: { label?: unknown } }[] = (await ui.findAll({ type: 'Button' }))
    .filter((el: { props: { label?: unknown } }) => RUN.test(String(el.props.label ?? '')))
  expect(runs.length).toBe(2)
  await ui.press({ key: String(runs[0]?.key) })
  await clock.advance(SETTLE_MS - 1_000)
  expect(fromBaton(sent)).toEqual([]) // 還在等：說不定你還要按下一張
  await ui.press({ key: String(runs[1]?.key) }) // 等的時候按了第二張：從它跑完重新計時
  await ui.unmount()
  expect(seen.length).toBe(2)

  await clock.advance(SETTLE_MS - 1)
  expect(fromBaton(sent)).toEqual([]) // 第一張跑完已經超過 SETTLE_MS，但不先送它一張
  await clock.advance(1)
  const ours = fromBaton(sent)
  expect(ours.length).toBe(1)
  expect(ours[0]?.text).toContain('git push origin feat-login → exit 0')
  expect(ours[0]?.text).toContain('git push origin v0.4.0 → exit 0')
  expect(ours[0]?.context).toBeUndefined() // 自己送的那則不再附一次

  // 送過就清掉：頁首不再說排著，你下一則訊息也不再帶
  const band = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shows(band, /稍後送給 Claude/)).toBe(false)
  await band.unmount()
  await $.prompt.submit({ ...TYPED, text: '好' })
  expect(sent.at(-1)?.context).toBeUndefined()
  await clock.advance(SETTLE_MS * 2)
  expect(fromBaton(sent).length).toBe(1)
})

test('還有卡片在跑就不送：等它跑完、再過一段才一起送', async ($, on) => {
  const clock = bottom(on)
  const slow = gatedSpawn(on, 'make long-build')
  const sent = submissions(on)
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'make long-build' })
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'make quick' })

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  const keyOf = async (name: string) => {
    const all: { key?: string; props: { label?: unknown } }[] = await ui.findAll({ type: 'Button' })
    const runs = all.filter(el => RUN.test(String(el.props.label ?? '')))
    // 卡片照收進來的順序畫：第一顆是 make long-build、第二顆是 make quick
    return String(runs[name === 'long' ? 0 : 1]?.key)
  }
  const long = await keyOf('long')
  const quick = await keyOf('quick')
  const pressingLong = ui.press({ key: long }) // 跑很久：不等它
  const running = async () => {
    const all: { props: { label?: unknown } }[] = await ui.findAll({ type: 'Button' })
    return all.some(el => /停止|^■$/.test(String(el.props.label ?? '')))
  }
  // 每次查詢都是一趟引擎往返，夠讓按下去的那張開始跑（mod 的環境沒有 setTimeout）
  for (let i = 0; i < 500 && !(await running()); i++);
  expect(await running()).toBe(true)
  await ui.press({ key: quick })

  await clock.advance(SETTLE_MS * 2)
  expect(fromBaton(sent)).toEqual([]) // make quick 早就跑完，但 make long-build 還在跑

  slow.release()
  await pressingLong
  await clock.advance(SETTLE_MS)
  const ours = fromBaton(sent)
  expect(ours.length).toBe(1)
  expect(ours[0]?.text).toContain('make quick → exit 0')
  expect(ours[0]?.text).toContain('make long-build → exit 0')
  await ui.unmount()
})

test('輸出裡的金鑰：卡片上看不到，帶給 Claude 的也看不到', async ($, on) => {
  const seen: string[][] = []
  const contexts: (readonly string[] | undefined)[] = []
  bottom(on)
  fakeSpawn(on, seen, `Logged in as miska\ntoken: ${FAKE_GLPAT}\n`, 0)
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)

    return { text: e.text }
  })

  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'glab auth login --stdin < token.txt' })

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: String((await button(ui, RUN))?.key) })
    expect(await shows(ui, /遮掉：GitLab token/)).toBe(true)
    expect(await shows(ui, new RegExp(FAKE_GLPAT))).toBe(false)
    await ui.unmount()
  }

  await $.prompt.submit({ ...TYPED, text: '登好了' })
  const sent = contexts.at(-1)?.join('\n') ?? ''
  expect(sent).toContain('‹遮掉：GitLab token›')
  expect(sent).not.toContain(FAKE_GLPAT)
})

test('要輸入密碼的：標成要用終端機，執行鈕拿掉、只留複製', async ($, on) => {
  const seen: string[][] = []
  bottom(on)
  fakeSpawn(on, seen, 'sudo: a terminal is required to read the password\n', 1)

  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'sudo systemctl restart docker' })

  for (const surface of SURFACES) {
    await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'clear' })
    await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'sudo systemctl restart docker' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: String((await button(ui, RUN))?.key) })

    expect(await button(ui, RUN)).toBeUndefined()
    expect(await button(ui, COPY)).toBeDefined()
    expect(await shows(ui, /終端機/)).toBe(true)
    await ui.unmount()
  }
})

test('複製按鈕把指令原文（含換行、不含原因那行）放上該介面的剪貼簿', async ($, on) => {
  const multiline = 'cat <<EOF > a.txt\nhi\nEOF'
  const copied: { text: string; surface: string }[] = []
  bottom(on)
  on('ui.copy', ($, e) => {
    copied.push({ text: e.text, surface: String(e.surface) })

    return { value: { isCopied: true as const } }
  })

  for (const surface of SURFACES) {
    await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'clear' })
    await $.command.run({ ...RUN_CONTEXT, command: 'band', args: multiline })

    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: String((await button(ui, COPY))?.key) })

    expect(copied.at(-1)).toEqual({ text: multiline, surface })
    await ui.unmount()
  }
})

test('桌面板放不下時：頁首說上面還有幾筆、空白列放藏起來的卡的預覽，按了換張；終端機全部畫出來', async ($, on) => {
  bottom(on)
  const tall = 'x\n'.repeat(6) + 'done'
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: `${tall} 1` })
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: `${tall} 2` })
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'ls' })

  const desk = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  // 最新那張（ls）在視窗裡，較舊的藏在上面
  expect(await shows(desk, /第 3 筆指令：ls/)).toBe(true)
  expect(await shows(desk, /第 1 筆指令/)).toBe(false)
  const up = await button(desk, /上面/)
  expect(up?.text).toContain('↑')

  // 補的空白列放藏起來的那兩張的預覽，按了直接換到那張
  expect(await button(desk, /↑ 第 2 筆/)).toBeDefined()
  const peek = await button(desk, /↑ 第 1 筆/)
  expect(peek).toBeDefined()

  await desk.press({ key: String(up?.key) })
  expect(await shows(desk, /第 2 筆指令/)).toBe(true)
  expect(await button(desk, /下面/)).toBeDefined()

  await desk.press({ key: String(peek?.key) })
  expect(await shows(desk, /第 1 筆指令/)).toBe(true)
  await desk.unmount()

  const term = await $.ui.mount({ plugin: PLUGIN, surface: 'terminal', component: 'AbovePrompt', props: PROPS })
  expect(await term.find({ type: 'Text', text: 'ls' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: `${tall} 1` })).toBeDefined()
  await term.unmount()
})

test('✕ 與 /band clear 都讓整塊消失', async ($, on) => {
  bottom(on)

  for (const surface of SURFACES) {
    await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'echo hi' })
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    await ui.press({ key: 'dismiss' })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    await ui.unmount()
  }

  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'echo hi' })
  await $.command.run({ ...RUN_CONTEXT, command: 'band', args: 'clear' })
  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
  await ui.unmount()
})

// ── 和別的 mod 共用輸入框上方 ──────────────────────────────────────────────
//
// 上面的測試底下只有 bottom() 那個空的 <Box />：帶子永遠只有 baton 自己，所以 10-22 那兩件事都抓不到——
// baton 有卡片時不叫 next，下層畫什麼都被蓋掉；而卡片全是 /band 放的，Claude 的回覆走的 session.append 沒測過。
// 下面用行內外掛站在 baton 的下層（append）與外層（prepend），回覆一律走 session.append。

/** 裝在 baton 之後、鏈上在它下層的 mod：四列的提示列（三行字＋一顆按鈕）。 */
const NEIGHBOUR = {
  name: 'neighbour',
  tier: 'append' as const,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
      const { Box, Button, Text } = $.ui.resolve(e)

      return (
        <Box flexDirection="column">
          <Text>{`鄰居的提示（給我 ${e.props.maxRows} 列）`}</Text>
          <Text>第二行</Text>
          <Text>第三行</Text>
          <Button key="neighbour-ok" label="知道了" onPress={() => undefined} />
        </Box>
      )
    })
  },
}

/** 裝在 baton 之前、鏈上在它外層，照 README 約定寫的 mod：三列疊在上面，往下傳的 maxRows 扣掉三列。 */
const OUTER = {
  name: 'outer',
  tier: 'prepend' as const,
  register(on: On) {
    on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
      if (e.props.hasSurvey) {
        return next(e)
      }
      const { Box, Text } = $.ui.resolve(e)
      const below = await next({ ...e, props: { ...e.props, maxRows: Math.max(0, e.props.maxRows - 3) } })

      return (
        <Box flexDirection="column">
          <Text>外層的提示</Text>
          <Text>第二行</Text>
          <Text>第三行</Text>
          {below}
        </Box>
      )
    })
  },
}

/** 整棵樹畫出來的字（含按鈕 label 與圖的 alt）：別的 mod 畫的元素 find 找不到，從樹上讀。 */
function texts(node: unknown): string {
  if (typeof node === 'string') {
    return node
  }
  if (Array.isArray(node)) {
    return node.map(texts).join('\n')
  }
  if (typeof node !== 'object' || node === null) {
    return ''
  }
  const { props, children } = node as { props?: { label?: unknown; alt?: unknown }; children?: unknown }

  return [props?.label, props?.alt, texts(children)].filter(part => typeof part === 'string' && part !== '').join('\n')
}

let rowSeq = 0

/** Claude 的一則回覆進轉錄：和真的對話一樣走 session.append。agentId 有值就是子代理的回覆。 */
async function reply($: Engine, text: string, agentId?: string): Promise<void> {
  rowSeq += 1
  await $.session.append({
    message: { type: 'assistant', role: 'assistant', content: [{ type: 'text', text }] },
    door: 'response',
    origin: { kind: 'model', model: 'claude-test' },
    uuid: `row-${rowSeq}`,
    ...(agentId === undefined ? {} : { agentId }),
  })
}

const fence = (command: string, reason = '要你跑') => `\`\`\`bash\n# 原因：${reason}\n${command}\n\`\`\``

// 七行的指令：一張卡就比半條帶子高，三張一定放不下、要開視窗
const TALL = 'x\n'.repeat(6) + 'done'

test('下層的 mod 有自己的提示列時：baton 疊在它上面，兩邊都畫得出來、按得到', { plugins: [NEIGHBOUR] }, async ($, on) => {
  bottom(on)
  await reply($, fence('git push origin feat-login'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: PROPS })
    const drawn = texts(await ui.drawn())

    expect(await ui.find({ key: 'dismiss' })).toBeDefined()
    expect(await shows(ui, /git push origin feat-login/)).toBe(true)
    expect(drawn).toContain('鄰居的提示')
    expect(await ui.press({ key: 'neighbour-ok', plugin: 'neighbour' })).toBeDefined()
    // baton 的帶子在上、鄰居的在下（同 ue-agent：自己的在上，next(e) 的在下）
    expect(drawn.indexOf('git push origin feat-login')).toBeLessThan(drawn.indexOf('鄰居的提示'))
    // 往下傳的列數扣掉了 baton 至少要的頁首＋一張卡
    expect(drawn).toContain(`給我 ${PROPS.maxRows - 4} 列`)
    await ui.unmount()
  }
})

test('外層的 mod 照約定疊加時：baton 照剩下的列數排，整條帶子不超過視窗（只多 baton 自己墊的一列）', { plugins: [OUTER] }, async ($, on) => {
  bottom(on)
  await reply($, [fence(`${TALL} 1`), fence(`${TALL} 2`), fence('ls')].join('\n\n'))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  const tree = await ui.drawn()

  expect(texts(tree)).toContain('外層的提示')
  expect(await shows(ui, /第 3 筆指令：ls/)).toBe(true)
  expect(treeRows(tree, PROPS.bodyColumns)).toBeLessThanOrEqual(PROPS.maxRows + 1)
  await ui.unmount()
})

test('問卷佔著帶子時讓路：畫引擎（下層）的，baton 不畫', async ($, on) => {
  on('ui.render', ($, e) => {
    const { Box, Text } = $.ui.resolve(e)

    return (
      <Box>
        <Text>問卷</Text>
      </Box>
    )
  })
  on('ui.toast', () => ({ value: undefined }))
  mock.clock(on, { now: 1_700_000_000_000 })
  await reply($, fence('make gen'))

  for (const surface of SURFACES) {
    const ui = await $.ui.mount({ plugin: PLUGIN, surface, component: 'AbovePrompt', props: { ...PROPS, hasSurvey: true } })
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    expect(texts(await ui.drawn())).toContain('問卷')
    await ui.unmount()
  }
})

for (const [where, plugins] of [
  ['只有 baton', []],
  ['下層有別的 mod', [NEIGHBOUR]],
  ['外層有別的 mod', [OUTER]],
] as const) {
  test(`新收的指令一定在視窗裡，就算你捲到別張了（${where}）`, { plugins }, async ($, on) => {
    bottom(on)
    await reply($, [fence(`${TALL} 1`), fence(`${TALL} 2`), fence(`${TALL} 3`)].join('\n\n'))

    const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
    expect(await shows(ui, /第 3 筆指令：x/)).toBe(true)

    // 捲到最上面那張，新的回覆進來
    while ((await button(ui, /上面/)) !== undefined) {
      await ui.press({ key: 'window-up' })
    }
    expect(await shows(ui, /第 1 筆指令/)).toBe(true)
    await reply($, `好了，再跑這個：\n\n${fence('git push origin main', '從 worktree 推會被擋')}`)

    // 只留最後三筆：最舊的被擠掉，新的那張在第 3 筆、而且在視窗裡
    expect(await shows(ui, /第 3 筆指令：git push origin main/)).toBe(true)
    expect(await shows(ui, /done 1/)).toBe(false)
    await ui.unmount()
  })
}

test('和別人共用帶子時滾輪交給引擎捲整條；只有 baton 時才攔下來換張', { plugins: [NEIGHBOUR] }, async ($, on) => {
  const scrolled: number[] = []
  bottom(on)
  on('ui.scroll', ($, e) => {
    scrolled.push(e.by)

    return {}
  })
  await reply($, [fence(`${TALL} 1`), fence(`${TALL} 2`), fence('ls')].join('\n\n'))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS, requestId: 'band' })
  expect(await button(ui, /上面/)).toBeDefined()
  await $.ui.scroll({ component: 'AbovePrompt', requestId: 'band', offset: 1, by: 1, bodyRows: 12, contentRows: 14, origin: { kind: 'person' } })
  expect(scrolled).toEqual([1])
  await ui.unmount()
})

test('只有 baton、卡片放不下時：滾輪一格換一張，不讓引擎捲', async ($, on) => {
  const scrolled: number[] = []
  bottom(on)
  on('ui.scroll', ($, e) => {
    scrolled.push(e.by)

    return {}
  })
  await reply($, [fence(`${TALL} 1`), fence(`${TALL} 2`), fence('ls')].join('\n\n'))

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS, requestId: 'band' })
  expect(await shows(ui, /第 3 筆指令：ls/)).toBe(true)
  await $.ui.scroll({ component: 'AbovePrompt', requestId: 'band', offset: 0, by: -1, bodyRows: 12, contentRows: 13, origin: { kind: 'person' } })
  expect(scrolled).toEqual([])
  expect(await shows(ui, /第 2 筆指令/)).toBe(true)
  await ui.unmount()
})

test('子代理回覆裡的 bash 區塊不收：你在對話裡看不到它，收了只會把要你跑的擠掉', async ($, on) => {
  bottom(on)
  await reply($, fence('make gen'))
  await reply($, [fence('cat a'), fence('cat b'), fence('cat c')].join('\n\n'), 'agent-explore')

  const ui = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shows(ui, /make gen/)).toBe(true)
  expect(await shows(ui, /cat a/)).toBe(false)
  await ui.unmount()
})
