import { expect, test } from 'claude-code/testing'

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

test('同樣的指令不重複收，清單只留最後幾筆；重複時補上原因', () => {
  const first = mergeCommands([], [{ command: 'a' }, { command: 'b' }], index => `t1-${index}`)
  expect(first.map(item => item.command)).toEqual(['a', 'b'])

  const again = mergeCommands(first, [{ command: 'b', reason: '要你的權限' }], index => `t2-${index}`)
  expect(again.map(item => item.id)).toEqual(['t1-0', 't1-1'])
  expect(again[1]?.reason).toBe('要你的權限')

  const many = mergeCommands(again, [{ command: 'c' }, { command: 'd' }, { command: 'e' }], index => `t3-${index}`)
  expect(many).toHaveLength(MAX_KEPT)
  expect(many.map(item => item.command)).toEqual(['c', 'd', 'e'])
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
