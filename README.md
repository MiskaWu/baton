# baton

Claude 跑不了的指令交到你手上，你看過、按一下就跑；跑完的結果遮掉金鑰，再交回給 Claude。一來一回，像接力棒。

Claude Code 對話裡，Claude 常會給你一段 bash 要你自己跑：它的權限規則擋住了、要用你的帳號、要你的 sudo。
baton 把這些指令收成輸入框上方的卡片：

- 每張卡寫著**為什麼要你跑**（Claude 寫在指令第一行的 `# 原因：…`）。
- 按 ▶（或數字鍵 1–9）就**以你的身分執行**，等於你在終端機打這一行；執行中按 ■ 停止。
- 跑完的輸出（頭 1 行＋尾 2 行）留在卡片上，並在你**下一則訊息**時帶給 Claude，讓它接著做。
- 帶回去之前**先遮金鑰**；會把金鑰印出來的指令（`env`、`cat .env`、`gh auth token`…）只帶 exit code。

## 安裝

三種方式擇一，都不用改任何設定檔。

**A. 請 Claude 幫你裝**：在任何一個 Claude Code 對話（桌面 app 的 Code 分頁也可以）輸入：

> 請照 https://github.com/MiskaWu/baton README 的「給 Claude 的安裝步驟」幫我安裝

**B. 自己在終端機裝**（電腦上有 `claude` 指令的話）：

```bash
claude plugin marketplace add MiskaWu/baton && claude plugin install baton@baton
```

或在終端機版 Claude Code 的輸入框打 `/plugin install baton --marketplace MiskaWu/baton`，問 `Add marketplace?` 時回 `y`，範圍選 user。

**C. 桌面 app**（`/plugin` 在桌面 app 不能用）：按輸入框旁的 **+** → **Plugins** → **Add marketplace**，填 `MiskaWu/baton`，再 **Add plugin**。

裝好後輸入 `/reload-plugins`（或開一個新對話）就生效。

### 更新

```bash
claude plugin marketplace update baton && claude plugin update baton@baton
```

或在 `/plugin` → **Marketplaces** → **baton** → **Enable auto-update** 打開自動更新。

### 給 Claude 的安裝步驟

照下面做，不要改 `settings.json`。

1. 決定用哪個 `claude`：`command -v claude` 有結果就用它；沒有的話用環境變數 `$CLAUDE_CODE_EXECPATH`
   （目前這個 Claude Code 本身，桌面 app 的 Code 分頁裡也有）。以下記作 `$CLAUDE`。
2. 加入 marketplace：`"$CLAUDE" plugin marketplace add MiskaWu/baton`。
   已經加過的話改跑 `"$CLAUDE" plugin marketplace update baton`。
3. 安裝：`"$CLAUDE" plugin install baton@baton`。已經裝過的話改跑 `"$CLAUDE" plugin update baton@baton`。
4. 用 `"$CLAUDE" plugin list` 確認 `baton@baton` 是 enabled，然後告訴使用者：先輸入 `/reload-plugins`（或開一個新對話）。

## 用法

- Claude 回覆裡的 ` ```bash `／` ```sh ` 區塊會自動變成卡片，最多留最近 3 張。只收主對話的回覆，子代理的不收。
- 卡片底下那一列：沒跑之前是**原因**，跑的時候是最後一行輸出，跑完是結果（完成、exit N、已停止、要用終端機）。
- 按鈕：▶ 執行、■ 停止、↻ 再跑一次；⧉ 複製指令（不含原因那一行）。
- 數字鍵：點一下帶子讓它取得焦點，按 1–9 執行對應的那張。
- 放不下時：頁首的「↑ 上面 N 筆／↓ 下面 N 筆」、卡片下方的預覽列，或在帶子上用滾輪換張。
- `/band <指令>` 手動放一筆進去；`/band clear` 或 ✕ 清空。
- 桌面 app 畫成卡片；終端機用文字，按鈕一樣。
- 別的 mod 也在輸入框上方畫東西時，卡片疊在它們上面、一起顯示；問卷出現時先讓路。

## 安全須知

- **按下去就是你本人在跑**：不經過 Claude 的權限規則和 hooks（例如擋 `git push` 的 hook）。卡片的用意是讓你看清楚再按。
- **看不完的不給按**：超過 7 行、卡片放不完的指令沒有執行鈕，只能複製。
- **沒有終端機可以輸入**：要密碼或確認的指令（sudo 要密碼、ssh 金鑰密碼、互動登入）會失敗，卡片標成「要用終端機」，只留複製。
- git 的 repo hooks（pre-commit 這類）不會跑；指令會一直跑到結束或你按停止。
- **金鑰遮蔽是比對已知格式**：私鑰、GitLab／GitHub token、`sk-` 系列 key、AWS、Slack、Google key、JWT、
  `Authorization` 標頭、`--password` 參數、網址裡的帳密、名字含 TOKEN／SECRET／PASSWORD 的設定值，以及看起來像亂數的長字串。
  不保證抓得到所有格式，所以會印金鑰的指令整段不帶，其他的也只帶頭尾幾行。卡片上同樣只顯示遮過的版本，截圖給 Claude 也不會帶出金鑰。
- 卡片上的指令來自 Claude 的回覆。Claude 讀到的網頁或檔案如果夾帶惡意指令，也可能出現在卡片上，按之前看清楚。

## 它怎麼跟 Claude 溝通

- baton 在 Claude 的系統提示加一小段規則：bash 區塊第一行寫 `# 原因：…`、一個區塊放一個完整指令、超過 7 行不會有執行鈕、
  只有真的寫進回覆裡的區塊才會變卡片（在 recap 裡說「卡片放上去了」不算）、結果會以 `[指令帶子]` 開頭帶回。
- 執行結果附在你下一則訊息旁邊交給 Claude（不會插進對話畫面），每筆只帶一次。

## 開發

```bash
claude plugin test .
claude plugin validate .
```

`hooks/register.tsx` 是進入點；卡片畫法在 `hooks/visual.ts`（純函式，回傳 SVG），金鑰遮蔽在 `hooks/redact.ts`，
狀態與執行結果的判斷在 `hooks/commands.ts`。每種狀態長什麼樣子集中在 `commands.ts` 的 `STATUS` 表。
和其他 mod 共用輸入框上方時，估下層佔幾列的純函式在 `hooks/stack.ts`。

### 和其他 mod 共用輸入框上方

輸入框上方那一塊（`AbovePrompt`）所有 mod 共用一個位置，引擎只畫最外層 hook 回的那一棵樹。
一個 mod 回了自己的樹又不叫 `next(e)`，鏈上在它裡層的 mod（比它晚裝的）和引擎的問卷就整個不見。
baton 照下面的約定寫，也請其他畫這一塊的 mod 照做：

1. **沒東西要顯示，或 `e.props.hasSurvey` 為真**：`return next(e)`。
2. **有東西要顯示時疊，不要佔**：先叫 `next`，往下傳的 `maxRows` 扣掉自己要用的列數，再把自己的放在上面。

   ```tsx
   const below = await next({ ...e, props: { ...e.props, maxRows: Math.max(0, e.props.maxRows - mine) } })

   return (
     <Box flexDirection="column">
       {myTree}
       {below}
     </Box>
   )
   ```

3. **照 `e.props.maxRows` 排版**：裡層看到的是外層扣過的列數，照它排就不會把別人擠出視窗。
4. **只有帶子上只有自己時才攔 `ui.scroll`**：和別人共用時讓引擎捲整條，別人的內容才捲得到。

baton 自己至少要 4 列（頁首＋一張卡），往下傳時扣掉這 4 列；下層畫回來的佔幾列用 `stack.ts` 估，卡片視窗只用剩下的。

## 授權

MIT
