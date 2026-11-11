import { expect, test } from 'claude-code/testing'

import type { BandCommand } from '../types'
import {
  MAX_KEPT,
  actionLabel,
  applyOutcome,
  cardNote,
  lastLine,
  markRunning,
  mergeCommands,
  needsTerminal,
  outcomeOfRun,
  parseCommands,
  recoverAfterReload,
  removeCommand,
  setProgress,
  statusColor,
} from './commands'
import { EXIT_ONLY } from './redact'

// 假金鑰用拼的，原始碼裡不出現一整串長得像真的 token
const FAKE_GLPAT = 'glpat-' + 'EXAMPLEexample'.repeat(2) + '0000'

test('只收 shell 圍欄，不收其他語言的程式碼區塊', () => {
  const text = [
    '關單指令：',
    '```bash',
    'glab issue close 70 -R gitlab.example.com/a/b',
    '```',
    '這段是 Go，不該被收：',
    '```go',
    'func main() {}',
    '```',
    '```sh',
    'echo hi',
    '```',
  ].join('\n')

  expect(parseCommands(text)).toEqual([
    { command: 'glab issue close 70 -R gitlab.example.com/a/b' },
    { command: 'echo hi' },
  ])
})

test('第一行的「# 原因：」拆出來當原因，指令本體不含它', () => {
  const text = [
    '```bash',
    '# 原因：我在 worktree 裡推不了，這支分支要你推',
    'git push origin feat-login',
    '```',
    '```bash',
    '# reason: needs your sudo password',
    'sudo systemctl restart docker',
    '```',
    '```bash',
    '# 原因:半形冒號也算',
    'make gen',
    '```',
  ].join('\n')

  expect(parseCommands(text)).toEqual([
    { command: 'git push origin feat-login', reason: '我在 worktree 裡推不了，這支分支要你推' },
    { command: 'sudo systemctl restart docker', reason: 'needs your sudo password' },
    { command: 'make gen', reason: '半形冒號也算' },
  ])
})

test('一般註解不算原因；只有原因、沒有指令的區塊不收', () => {
  const text = ['```bash', '# 先清快取', 'make clean', '```', '```bash', '# 原因：沒東西', '```'].join('\n')

  expect(parseCommands(text)).toEqual([{ command: '# 先清快取\nmake clean' }])
})

test('同樣的指令不重複收；重複時補上原因', () => {
  const first = mergeCommands([], [{ command: 'a' }, { command: 'b' }], index => `t1-${index}`)
  expect(first.map(item => item.command)).toEqual(['a', 'b'])

  const again = mergeCommands(first, [{ command: 'b', reason: '要你的權限' }], index => `t2-${index}`)
  expect(again.map(item => item.id)).toEqual(['t1-0', 't1-1'])
  expect(again[1]?.reason).toBe('要你的權限')
})

// 11-11 的 bug：上限 3、最舊的先丟，Claude 一則給 4 個指令時第 1 個被第 4 個擠掉，使用者點不到。
test('同一則給的指令一個都不丟，就算比上限還多', () => {
  const four = ['merge', 'push', 'edge', 'edge-status'].map(command => ({ command }))
  expect(mergeCommands([], four, i => `t-${i}`).map(item => item.command)).toEqual(['merge', 'push', 'edge', 'edge-status'])

  const flood = Array.from({ length: MAX_KEPT + 2 }, (_, i) => ({ command: `c${i}` }))
  expect(mergeCommands([], flood, i => `t-${i}`)).toHaveLength(MAX_KEPT + 2)
})

test('滿了才清舊的：先清跑完的，再清跑過沒成的，沒跑過的最後；正在跑的不清', () => {
  const old: BandCommand[] = Array.from({ length: MAX_KEPT }, (_, i) => ({ id: `o${i}`, command: `old${i}` }))
  // o0 沒跑過（最舊）、o1 失敗、o2 正在跑、o3 跑完
  old[1] = { ...old[1]!, status: 'failed' as const, exitCode: 1 }
  old[2] = { ...old[2]!, status: 'running' as const }
  old[3] = { ...old[3]!, status: 'done' as const, exitCode: 0 }

  const one = mergeCommands(old, [{ command: 'new0' }], () => 'n0')
  expect(one).toHaveLength(MAX_KEPT)
  expect(one.map(item => item.id)).not.toContain('o3') // 跑完的先走
  expect(one.map(item => item.id)).toContain('o0') // 最舊但沒跑過，留著

  const two = mergeCommands(one, [{ command: 'new1' }], () => 'n1')
  expect(two.map(item => item.id)).not.toContain('o1') // 再來是跑過沒成的

  const three = mergeCommands(two, [{ command: 'new2' }], () => 'n2')
  expect(three.map(item => item.id)).not.toContain('o0') // 都沒有了才輪到沒跑過的，最舊的先
  expect(three.map(item => item.id)).toContain('o2') // 正在跑的一直都在
  expect(three.map(item => item.command).slice(-3)).toEqual(['new0', 'new1', 'new2'])
})

test('覆述舊的指令也算「這一則提到的」：清舊的時候不會被清掉', () => {
  const full = Array.from({ length: MAX_KEPT }, (_, i) => ({ id: `o${i}`, command: `old${i}` }))
  const merged = mergeCommands(full, [{ command: 'old0' }, { command: 'fresh' }], () => 'f')
  expect(merged.map(item => item.id)).toContain('o0')
  expect(merged.map(item => item.id)).not.toContain('o1')
})

test('卡片上的 ✕ 只拿掉那一張；正在跑的不拿', () => {
  const list = [
    { id: 'a', command: 'a' },
    { id: 'b', command: 'b', status: 'running' as const },
    { id: 'c', command: 'c', status: 'done' as const },
  ]
  expect(removeCommand(list, 'a').map(item => item.id)).toEqual(['b', 'c'])
  expect(removeCommand(list, 'c').map(item => item.id)).toEqual(['a', 'b'])
  expect(removeCommand(list, 'b').map(item => item.id)).toEqual(['a', 'b', 'c'])
  expect(removeCommand(list, 'nope')).toEqual(list)
})

test('按下去清掉上次結果、執行中才收進度；按鈕與顏色就是狀態', () => {
  const list = mergeCommands([], [{ command: 'a', reason: 'r' }], () => 't-0')
  const done = applyOutcome(list, 't-0', outcomeOfRun('a', { code: 0, signal: null, output: 'ok' }))
  expect(actionLabel(done[0]!)).toBe('✓ 再執行')
  expect(statusColor(done[0]!)).toBe('success')

  const running = markRunning(done, 't-0')
  expect(running[0]).toEqual({ id: 't-0', command: 'a', reason: 'r', status: 'running' })
  expect(actionLabel(running[0]!)).toBe('■ 停止')
  expect(setProgress(running, 't-0', 'step 2')[0]?.progress).toBe('step 2')
  // 不在跑的那筆不收進度（晚到的一段輸出不能把結果蓋掉）
  expect(setProgress(done, 't-0', 'late')[0]?.progress).toBeUndefined()
})

test('重新載入時還標著執行中的，改成沒跑完', () => {
  const running = markRunning(mergeCommands([], [{ command: 'a' }], () => 't-0'), 't-0')
  const recovered = recoverAfterReload(running)
  expect(recovered[0]?.status).toBe('failed')
  expect(recovered[0]?.note).toContain('重新載入')
})

test('exit 0 是完成、非 0 是失敗並留 exit code；卡片留頭 1 行＋尾 2 行', () => {
  const short = outcomeOfRun('ls', { code: 0, signal: null, output: 'a\nb\nc\nd\n' })
  expect(short.status).toBe('done')
  expect(short.exitCode).toBe(0)
  // 4 行以內全留：略過 1 行換 1 行記號，省不到東西
  expect(short.note).toBe('a\nb\nc\nd')

  const seconds = Array.from({ length: 20 }, (_, i) => `第 ${i + 1} 秒`).join('\n')
  const loop = outcomeOfRun('for i in $(seq 1 20); do echo "第 $i 秒"; sleep 1; done', { code: 0, signal: null, output: seconds })
  expect(loop.note).toBe('第 1 秒\n⋯ 略過 17 行\n第 19 秒\n第 20 秒')

  const failed = outcomeOfRun('go test ./...', { code: 1, signal: null, output: '--- FAIL: TestX\n' })
  expect(failed.status).toBe('failed')
  expect(failed.exitCode).toBe(1)
  expect(failed.report.text).toContain('exit 1')
})

test('要輸入密碼的指令標成要用終端機', () => {
  expect(needsTerminal('sudo: a terminal is required to read the password')).toBe(true)
  expect(needsTerminal('[sudo] password for dev:')).toBe(true)
  expect(needsTerminal('Everything up-to-date')).toBe(false)

  const outcome = outcomeOfRun('sudo systemctl restart docker', {
    code: 1,
    signal: null,
    output: 'sudo: a terminal is required to read the password',
  })
  expect(outcome.status).toBe('terminal')
})

test('會印金鑰的指令：卡片不顯示輸出，帶給 Claude 的只有 exit code', () => {
  const outcome = outcomeOfRun('cat ~/.config/acme/dev.env', {
    code: 0,
    signal: null,
    output: `APP_ENV=dev\nGITLAB_TOKEN=${FAKE_GLPAT}\n`,
  })
  expect(outcome.note).not.toContain('APP_ENV')
  expect(outcome.note).toContain('沒有顯示')
  expect(outcome.report.badge).toBe(EXIT_ONLY)
  expect(outcome.report.text).not.toContain(FAKE_GLPAT)
  expect(outcome.report.text).not.toContain('APP_ENV')
})

test('卡片上的輸出也是遮過的：截圖貼給 Claude 也不會帶出金鑰', () => {
  expect(cardNote(`token: ${FAKE_GLPAT}`)).not.toContain(FAKE_GLPAT)
  const outcome = outcomeOfRun('glab auth login --stdin', { code: 0, signal: null, output: `ok\ntoken: ${FAKE_GLPAT}` })
  expect(outcome.note).not.toContain(FAKE_GLPAT)
  expect(outcome.report.text).not.toContain(FAKE_GLPAT)
})

test('按了停止就是停止，不是沒跑成：卡片留停下時的輸出', () => {
  const outcome = outcomeOfRun('npm run dev', { code: null, signal: null, output: 'listening on 3000', isStopped: true })
  expect(outcome.status).toBe('stopped')
  expect(outcome.note).toBe('listening on 3000')
  expect(outcomeOfRun('sleep 9', { code: null, signal: null, output: '', isStopped: true }).note).toBe('還沒有輸出就停了')
  expect(outcome.report.text).toContain('→ 使用者按了停止')
  expect(outcome.report.text).not.toContain('沒跑成')
  // 停在哪裡通常就是重點：輸出照樣帶
  expect(outcome.report.text).toContain('listening on 3000')
})

test('執行中的最後一行：跳過空行、太長截斷', () => {
  expect(lastLine('a\nb\n\n')).toBe('b')
  expect(lastLine('x'.repeat(200), 10)).toBe(`${'x'.repeat(9)}…`)
  expect(lastLine('')).toBe('')
})
