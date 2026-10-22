import { expect, test } from 'claude-code/testing'

import { ROW, bottomLine, cardRows, commandCard, lastFirst, runnable, windowFor, windowFrom } from './visual'

const WIDTH = 647

test('卡片高度一律是一列（19px）的倍數，至少三列（按鈕疊在第 2 列，上下都要有框）', () => {
  const cases = [
    { id: 'a', command: 'make gen' },
    { id: 'b', command: 'make gen', reason: '要你跑' },
    { id: 'c', command: 'ls', status: 'done' as const, exitCode: 0, note: 'a\nb\nc', report: '回傳摘要' },
    { id: 'd', command: 'x\n'.repeat(12) },
  ]
  for (const c of cases) {
    const card = commandCard(c, 0, WIDTH)
    expect(card.height % ROW).toBe(0)
    expect(card.height / ROW).toBe(cardRows(c, WIDTH))
    expect(cardRows(c, WIDTH)).toBeGreaterThanOrEqual(3)
  }
  // 三筆都沒跑、各寫了原因：每張 3 列，加頁首剛好 10 列
  expect(cardRows({ id: 'a', command: 'git push origin feat-login', reason: '要你推' }, WIDTH)).toBe(3)
  // 最高的卡（7 行指令＋頭尾 4 行結果）也要放得進視窗（12 列減頁首）
  const tallest = {
    id: 't',
    command: Array.from({ length: 7 }, (_, i) => `echo ${i}`).join('\n'),
    status: 'done' as const,
    exitCode: 0,
    note: '第 1 秒\n⋯ 略過 17 行\n第 19 秒\n第 20 秒',
    report: '回傳摘要',
  }
  expect(cardRows(tallest, WIDTH)).toBeLessThanOrEqual(11)
})

test('底下那列：沒跑是原因，沒寫原因就明講', () => {
  expect(bottomLine({ id: 'a', command: 'x', reason: '要你推' }, WIDTH)).toMatchObject({ label: '原因', body: '要你推' })
  expect(bottomLine({ id: 'a', command: 'x' }, WIDTH)).toMatchObject({ label: '原因', dim: true })
  expect(bottomLine({ id: 'a', command: 'x', status: 'failed', exitCode: 2, note: 'boom' }, WIDTH).label).toBe('exit 2')
  // 按了停止的不是「沒跑成」
  expect(bottomLine({ id: 'a', command: 'x', status: 'stopped', note: '第 6 秒' }, WIDTH)).toMatchObject({ label: '已停止', body: '第 6 秒' })
  expect(runnable({ id: 'a', command: 'x', status: 'stopped' }, WIDTH)).toBe(true)
})

test('看不完的不給按：太長的、要終端機的都只留複製', () => {
  expect(runnable({ id: 'a', command: 'ls' }, WIDTH)).toBe(true)
  expect(runnable({ id: 'a', command: 'x\n'.repeat(12) }, WIDTH)).toBe(false)
  expect(runnable({ id: 'a', command: 'sudo ls', status: 'terminal' }, WIDTH)).toBe(false)
})

test('執行中的卡會動，alt 把指令、原因、回傳都講完', () => {
  const running = commandCard({ id: 'a', command: 'make gen', status: 'running', progress: 'protoc …' }, 1, WIDTH)
  expect(running.animated).toBe(true)
  expect(running.alt).toContain('第 2 筆指令：make gen')

  const done = commandCard({ id: 'a', command: 'ls', reason: 'r', status: 'done', note: 'ok', report: '回傳摘要' }, 0, WIDTH)
  expect(done.animated).toBe(false)
  expect(done.alt).toContain('帶給 Claude：回傳摘要')
})

test('視窗挑卡：放得下全放，放不下以新的那張為準、只放整張', () => {
  expect(windowFor([3, 3, 3], 11, 2)).toEqual({ first: 0, last: 2, above: 0, below: 0 })
  expect(windowFor([5, 4, 3], 11, 2)).toEqual({ first: 1, last: 2, above: 1, below: 0 })
  expect(windowFor([5, 4, 3], 11, 0)).toEqual({ first: 0, last: 1, above: 0, below: 1 })
  expect(windowFrom([5, 4, 3], 11, 0)).toEqual({ first: 0, last: 1, above: 0, below: 1 })
  expect(lastFirst([5, 4, 3], 11)).toBe(1)
})
