import { expect, test } from 'claude-code/testing'

import { EXIT_ONLY, oneLine, printsSecrets, redact, reportFor } from './redact'

// 假金鑰用拼的，原始碼裡不出現一整串長得像真的 token
const FAKE = {
  glpat: 'glpat-' + 'EXAMPLEexample'.repeat(2) + '0000',
  github: 'ghp_' + 'A1b2C3d4E5f6G7h8I9j0'.repeat(2),
  anthropic: 'sk-ant-api03-' + 'EXAMPLEexample0000xyz'.repeat(2),
  aws: 'AKIA' + 'ABCDEFGHIJKLMNOP',
  random: 'Zx9Qw8Er7Ty6Ui5Op4As3Df2Gh1Jk0LmNbVcXzQ',
  pem: ['-----BEGIN OPENSSH PRIVATE KEY-----', 'b3BlbnNzaC1rZXktdjEAAAAABG5vbmU', '-----END OPENSSH PRIVATE KEY-----'].join('\n'),
}

test('已知格式的金鑰都遮掉，換成「‹遮掉：種類›」', () => {
  const cases: [string, string][] = [
    [`token: ${FAKE.glpat}`, 'GitLab token'],
    [`GITHUB_TOKEN=${FAKE.github}`, 'GitHub token'],
    [`key ${FAKE.anthropic}`, 'Anthropic key'],
    [`"AccessKeyId": "${FAKE.aws}"`, 'AWS key'],
    [`${FAKE.pem}\nok`, '私鑰'],
    [`origin https://miska:${FAKE.random}@gitlab.example.com/a.git`, '網址帳密'],
    [`key ${FAKE.random}`, '疑似金鑰'],
  ]
  for (const [text, kind] of cases) {
    const out = redact(text)
    expect(out.text).toContain(`‹遮掉：${kind}›`)
    for (const secret of Object.values(FAKE)) {
      expect(out.text).not.toContain(secret)
    }
  }
})

test('同一段不會被遮兩次（寬的規則不能把遮好的再抓一次）', () => {
  const out = redact(`token: ${FAKE.glpat}\nAuthorization: Bearer ${FAKE.anthropic}`)
  expect(out.text).toBe('token: ‹遮掉：GitLab token›\nAuthorization: Bearer ‹遮掉：Anthropic key›')
})

test('網址帳密只遮密碼，@ 和主機留著', () => {
  expect(redact(`https://miska:${FAKE.random}@gitlab.example.com/a.git`).text).toBe(
    'https://miska:‹遮掉：網址帳密›@gitlab.example.com/a.git',
  )
})

test('不該遮的不能誤傷：git SHA、email、路徑、測試名稱', () => {
  const text = [
    'commit 9be3d10f2a41c0f2e8b7a6c5d4e3f2a1b0c9d8e7',
    'Author: Dev Example <dev@example.com>',
    '--- FAIL: TestLoginRetryWithThreeAttemptsReturnsLockout2026 (0.02s)',
    '/home/dev/projects/acme/server/internal/login/retry_test.go:41',
  ].join('\n')
  const out = redact(text)
  expect(out.text).toBe(text)
  expect(out.hits).toEqual([])
})

test('變數引用與格式字串不是金鑰：留著讓 Claude 看得懂指令（10-22 試跑的誤遮）', () => {
  const text = [
    "printf 'token: glpat-%s\\n' EXAMPLE",
    'curl -H "Authorization: Bearer $GITLAB_TOKEN" https://api.example.com',
    'GITLAB_TOKEN=${CI_JOB_TOKEN} make deploy',
    'mysql --password=$DB_PASS',
  ].join('\n')
  const out = redact(text)
  expect(out.text).toBe(text)
  expect(out.hits).toEqual([])
  // 真的值照樣遮
  expect(redact('GITLAB_TOKEN=hunter2hunter2').text).toBe('GITLAB_TOKEN=‹遮掉：敏感設定值›')
})

test('多行指令壓成一行時標出原本的換行', () => {
  expect(oneLine('for n in 1 2; do\n  echo "$n"\ndone\n')).toBe('for n in 1 2; do ↵ echo "$n" ↵ done')
  expect(reportFor('for n in 1 2; do\n  echo "$n"\ndone', 0, '1\n2').text).toContain('執行：for n in 1 2; do ↵ echo "$n" ↵ done → exit 0')
})

test('會印金鑰的指令認得出來，一般指令不算', () => {
  expect(printsSecrets('env | sort')).toBeDefined()
  expect(printsSecrets('cat ~/.config/acme/dev.env')).toBeDefined()
  expect(printsSecrets('gh auth token')).toBeDefined()
  expect(printsSecrets('kubectl get secret db -o yaml')).toBeDefined()
  expect(printsSecrets('git push origin feat-login')).toBeUndefined()
  expect(printsSecrets('make -C server gen')).toBeUndefined()
})

test('帶給 Claude 的摘要：頭 1 行＋尾 2 行、說明遮了幾處、指令本身也遮', () => {
  const report = reportFor(`curl -H "Authorization: Bearer ${FAKE.anthropic}" https://api.example.com`, 0, 'a\nb\nc\nd\ne\nf\n')
  expect(report.text).not.toContain(FAKE.anthropic)
  expect(report.text).toContain('只帶頭 1 行和尾 2 行')
  expect(report.text).toContain('遮掉 1 處金鑰')
  expect(report.text.split('\n').slice(1)).toEqual(['  a', '  ⋯ 略過 3 行', '  e', '  f'])
  expect(report.badge).toBe('回傳摘要・遮 1 處')

  expect(reportFor('env', 0, `X=${FAKE.random}`).badge).toBe(EXIT_ONLY)
})
