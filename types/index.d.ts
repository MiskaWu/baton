/** 帶子上的一筆指令。 */
export type BandCommand = {
  /** 收進來的時間戳加序號，當繪製的 key 用。 */
  id: string
  /** 要跑的指令（圍欄第一行的「# 原因：」已經拆出去）；可能是多行（heredoc）。 */
  command: string
  /** 為什麼要你跑：Claude 寫在圍欄第一行的「# 原因：…」。沒寫就沒有。 */
  reason?: string
  /**
   * 畫面上看得出來的狀態，也是按下去的即時回饋：
   * running（■ 停止）、done（✓ 再執行）、failed（✗ 重試）、stopped（你按了停止）、
   * terminal（跑了才發現要輸入密碼或確認，這裡沒地方打字：只留複製）。
   * 還沒按過的不帶這個欄位。各狀態長什麼樣子集中在 commands.ts 的 STATUS 表。
   */
  status?: 'running' | 'done' | 'failed' | 'stopped' | 'terminal'
  /** 執行中最後一行輸出（已遮過金鑰）。 */
  progress?: string
  /** 跑完的 exit code；沒跑成或被停止就沒有。 */
  exitCode?: number
  /** 卡片底下那列的內容：輸出前幾行或原因，**一律是遮過金鑰的版本**——原始輸出不存進狀態。 */
  note?: string
  /** 帶給 Claude 的是什麼（「回傳摘要」「只回傳 exit code」…），卡片右下角的小膠囊。 */
  report?: string
}

/**
 * 桌面板的卡片視窗：頁首固定，下面只放整張的卡。
 * first 有值＝你用 ↑↓ 或滾輪捲過；沒有就以 anchor（新進來或執行中的那張）為準。
 */
export type BandView = { first: number | null; anchor: string | null }

declare module 'claude-code' {
  interface PluginState {
    'baton': {
      pending: BandCommand[]
      view: BandView
      /** 排著等你下一則訊息帶給 Claude 的執行摘要（已遮過金鑰）。 */
      reports: string[]
    }
  }
}
