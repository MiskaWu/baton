// 回傳給 Claude 之前的遮蔽：純函式，給指令與輸出，回「要帶給 Claude 的那段字」。
// 卡片上（你自己的畫面）照樣顯示完整輸出；只有離開這台機器、進到模型的那段要過這裡。
//
// 三道，順序有意義：
//   ① 指令表：常會把金鑰印出來的指令（env、cat .env、auth token…），輸出一個字都不回，只回 exit code。
//   ② 格式表：輸出全文先整段遮（PEM 這種跨行的要在截斷之前抓），再截。
//   ③ 截斷：頭 1 行＋尾 2 行、每行 160 字、總共 400 字。遮得不夠時，少帶一點也是一道防線。

/** 常把金鑰印出來的指令：輸出不回傳，只回 exit code。 */
const SECRET_PRINTING: { kind: string; pattern: RegExp }[] = [
  { kind: '環境變數', pattern: /(^|[;&|]\s*)(env|printenv|export\s+-p|set)\s*($|[;&|])/m },
  { kind: '設定檔／金鑰檔', pattern: /\b(cat|less|more|head|tail|bat|type|grep|rg|sed|awk)\b[^;&|]*(\.env\b|\.env\.|credentials|secret|token|\.pem\b|\.key\b|id_(rsa|ed25519|ecdsa)|\.netrc|\.npmrc|\.pypirc|\.git-credentials|kubeconfig|\.kube\/config|\.docker\/config\.json|\.aws\/)/i },
  { kind: '登入資訊', pattern: /\b(gh|glab)\s+auth\s+(token|status)|\bglab\s+config\s+get\s+token|\bgit\s+(config\s+[^;&|]*(token|credential|password)|credential\b)/i },
  { kind: '雲端／叢集機密', pattern: /\baws\s+(configure|sts\s+get-session-token|secretsmanager)|\bkubectl\s+get\s+secrets?\b|\bvault\s+(read|kv\s+get)|\bop\s+(read|item\s+get)|\bpass\s+show\b|\bsecurity\s+find-(generic|internet)-password/i },
]

/** 已知的金鑰格式：遮成「‹遮掉：種類›」，種類留著讓 Claude 知道那裡原本是什麼。 */
const FORMATS: { kind: string; pattern: RegExp; keep?: string }[] = [
  { kind: '私鑰', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: 'GitLab token', pattern: /\bgl(pat|dt|rt|ptt|ft|imt|agent|oas|cbt|soat|ffct)-[A-Za-z0-9_-]{20,}/g },
  { kind: 'GitHub token', pattern: /\b(gh[pousr]_[A-Za-z0-9]{30,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: 'Anthropic key', pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: 'API key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/g },
  { kind: 'AWS key', pattern: /\b(AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: 'Slack token', pattern: /\bxox[abprs]-[A-Za-z0-9-]{10,}/g },
  { kind: 'Google key', pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: 'JWT', pattern: /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g },
  // 「Authorization: Bearer xxx」「--password xxx」這類：名字留著，值遮掉
  { kind: '授權標頭', pattern: /\b(authorization|proxy-authorization)(\s*[:=]\s*)(bearer\s+|basic\s+|token\s+)?[^\s'"]+/gi, keep: '$1$2$3' },
  { kind: '密碼參數', pattern: /(--?(password|passwd|pass|token|secret|api-?key)(\s+|=))[^\s'"]+/gi, keep: '$1' },
  // 網址裡的帳密：https://user:pass@host
  { kind: '網址帳密', pattern: /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:)[^\s/@]+(?=@)/gi, keep: '$1' },
  // NAME_TOKEN=xxx、"apiKey": "xxx"：名字裡有敏感字的，值遮掉
  {
    kind: '敏感設定值',
    pattern: /\b([A-Za-z0-9_.-]*(token|secret|passw(or)?d|api_?key|apikey|private_?key|access_?key|credential)[A-Za-z0-9_.-]*["']?\s*[:=]\s*["']?)[^\s"',;]{4,}/gi,
    keep: '$1',
  },
  // 不認得格式、但長得像金鑰的：32 字以上一整串，大寫、小寫、數字各至少 4 個。
  // 不含 / _ - .，所以路徑、識別字、套件名不會中；純 16 進位（git SHA、checksum）沒有大寫也不會中。
  { kind: '疑似金鑰', pattern: /(?<![A-Za-z0-9+])(?=(?:[A-Za-z0-9+]*[A-Z]){4})(?=(?:[A-Za-z0-9+]*[a-z]){4})(?=(?:[A-Za-z0-9+]*[0-9]){4})[A-Za-z0-9+]{32,}={0,2}/g },
]

export type Redacted = { text: string; hits: { kind: string; count: number }[] }

// 遮過的地方先換成占位記號，最後才換成「‹遮掉：種類›」：
// 不然後面比較寬的規則（敏感設定值、授權標頭）會把前面遮好的那段再抓一次，字就亂了。
const OPEN = '\u0001'
const CLOSE = '\u0002'

/** 值是「指向金鑰的東西」而不是金鑰：$VAR、${VAR}、%s 這類格式、<TOKEN> 這類占位字。 */
const PLACEHOLDER = /^["']?(\$|%|<|\{)|%[sdq]/

/** 輸出全文照格式表遮一遍。 */
export function redact(text: string): Redacted {
  const hits = new Map<string, number>()
  const marks: string[] = []
  let out = text.replaceAll(OPEN, '').replaceAll(CLOSE, '')
  for (const { kind, pattern, keep } of FORMATS) {
    out = out.replace(pattern, (...args) => {
      const match = String(args[0])
      if (match.includes(OPEN)) return match
      // 疑似金鑰要數字散在至少三處：TestFoo2026 這種識別字只有一段數字
      if (kind === '疑似金鑰' && (match.match(/[0-9]+/g)?.length ?? 0) < 3) return match
      const kept = keep === undefined ? '' : keep.replace(/\$(\d)/g, (_, n: string) => String(args[Number(n)] ?? ''))
      // 「名字留著、值遮掉」的那幾條：值是變數引用或格式字串（$GITLAB_TOKEN、%s）就不是金鑰本身，
      // 留著反而讓 Claude 看得懂指令在做什麼（10-22 試跑：printf 'token: glpat-%s' 被誤遮）
      if (keep !== undefined && PLACEHOLDER.test(match.slice(kept.length))) return match
      hits.set(kind, (hits.get(kind) ?? 0) + 1)
      marks.push(`‹遮掉：${kind}›`)
      return `${kept}${OPEN}${marks.length - 1}${CLOSE}`
    })
  }
  out = out.replace(new RegExp(`${OPEN}(\\d+)${CLOSE}`, 'g'), (_, n: string) => marks[Number(n)] ?? '')
  return { text: out, hits: [...hits].map(([kind, count]) => ({ kind, count })) }
}

/** 這行指令是不是常把金鑰印出來（是的話輸出不回傳）。 */
export function printsSecrets(command: string): string | undefined {
  return SECRET_PRINTING.find(({ pattern }) => pattern.test(command))?.kind
}

/** 中間被略過的那一行開頭的記號；卡片上這一行畫成淡字。 */
export const SKIP_MARK = '⋯ 略過'

/**
 * 輸出太長時只留頭 1 行＋尾 2 行：開頭說是什麼，結尾通常是結果（git push 的分支、測試總結）。
 * 中間換成一行「⋯ 略過 N 行」。4 行以內全留——略過 1 行換 1 行記號，省不到東西。
 */
export function excerpt(lines: readonly string[], head = 1, tail = 2): string[] {
  if (lines.length <= head + tail + 1) {
    return [...lines]
  }
  return [...lines.slice(0, head), `${SKIP_MARK} ${lines.length - head - tail} 行`, ...lines.slice(-tail)]
}

/**
 * 多行指令壓成一行：原本的換行標成「 ↵ 」，不然 do 後面直接接 echo，看起來像寫錯的 shell。
 * 帶給 Claude 的摘要、預覽列、toast 都用這一個。
 */
export function oneLine(command: string): string {
  return command
    .trim()
    .split('\n')
    .map(line => line.replace(/\s+/g, ' ').trim())
    .filter(line => line !== '')
    .join(' ↵ ')
}

/** 卡片右下角膠囊的字：這一筆輸出一個字都沒帶給 Claude。 */
export const EXIT_ONLY = '只回傳 exit code'

export type Report = {
  /** 要帶給 Claude 的那段字（下一則訊息的 context）。 */
  text: string
  /** 卡片上那顆小膠囊要寫的：回了什麼。 */
  badge: string
}

const MAX_LINE = 160
const MAX_TOTAL = 400

/**
 * 一次執行要帶給 Claude 的摘要。指令本身也過一遍格式表——
 * 用 /band 手動放進來的指令可能自己帶著 token。
 */
export function reportFor(command: string, exitCode: number | undefined, output: string): Report {
  const cmd = redact(oneLine(command))
  const head = `[指令帶子] 使用者按了執行：${cmd.text} → ${exitCode === undefined ? '沒跑成' : `exit ${exitCode}`}`
  const lines = output.split('\n').filter(l => l.trim() !== '')
  const gate = printsSecrets(command)

  if (gate !== undefined) {
    return {
      text: `${head}（輸出 ${lines.length} 行，這類指令常印出${gate === '環境變數' ? '環境變數裡的金鑰' : '金鑰'}，內容沒有回傳）`,
      badge: EXIT_ONLY,
    }
  }

  const body = redact(output)
  const all = body.text.split('\n').filter(l => l.trim() !== '')
  const kept = excerpt(all).map(l => (l.length > MAX_LINE ? `${l.slice(0, MAX_LINE - 1)}…` : l))
  let snippet = kept.join('\n')
  if (snippet.length > MAX_TOTAL) snippet = `${snippet.slice(0, MAX_TOTAL - 1)}…`
  const masked = [...cmd.hits, ...body.hits].reduce((a, h) => a + h.count, 0)
  const note = [
    `輸出 ${lines.length} 行${kept.length < all.length ? '，只帶頭 1 行和尾 2 行' : ''}`,
    masked > 0 ? `遮掉 ${masked} 處金鑰` : '',
  ]
    .filter(Boolean)
    .join('，')
  return {
    text: snippet === '' ? `${head}（沒有輸出）` : `${head}（${note}）\n${snippet.replace(/^/gm, '  ')}`,
    badge: masked > 0 ? `回傳摘要・遮 ${masked} 處` : '回傳摘要',
  }
}
