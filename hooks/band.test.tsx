import type { On, RenderPropsOf } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

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
function bottom(on: On, said: string[] = []): void {
  on('ui.render', ($, e) => {
    const { Box } = $.ui.resolve(e)

    return <Box />
  })
  on('ui.toast', ($, e) => {
    said.push(e.text)

    return { value: undefined }
  })
  mock.clock(on, { now: 1_700_000_000_000 })
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

test('按下去以你的身分跑 bash -lc，跑完卡片留結果，摘要在你下一則訊息帶給 Claude', async ($, on) => {
  const seen: string[][] = []
  const said: string[] = []
  const contexts: (readonly string[] | undefined)[] = []
  bottom(on, said)
  fakeSpawn(on, seen, 'To gitlab:acme/server.git\n   a41c0f2..9be3d10  feat-login -> feat-login\n', 0)
  on('prompt.submit', ($, e) => {
    contexts.push(e.context)

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

  // 頁首說有幾筆排著要帶給 Claude
  const before = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shows(before, /下則訊息帶給 Claude 2 筆/)).toBe(true)
  await before.unmount()

  // 下一則訊息：兩次執行的摘要一起帶過去，帶完就清掉
  await $.prompt.submit({ ...TYPED, text: '推好了嗎？' })
  const after = await $.ui.mount({ plugin: PLUGIN, surface: 'desktop', component: 'AbovePrompt', props: PROPS })
  expect(await shows(after, /下則訊息帶給 Claude/)).toBe(false)
  await after.unmount()
  const sent = contexts.at(-1)?.join('\n') ?? ''
  expect(sent).toContain('[指令帶子] 使用者按了執行：git push origin feat-login → exit 0')
  await $.prompt.submit({ ...TYPED, text: '下一題' })
  expect(contexts.at(-1)).toBeUndefined()
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
