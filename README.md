# claude code 的誠實豆沙包

一個 Claude Code 的 mod。每一輪 Claude 回答完，它會回頭問 Claude 一句：「剛剛那輪，你心裡其實在想什麼？」然後把答案用一行小字浮在輸入框上面。

English summary at the end.

```
⏺ 人家同意七成喵。人家整理的時候也有這個感覺……（Claude 的回答）

  ♪ 鬆口氣 ─ 他說「有看到」那一下人家才真的放心，之前講得那麼篤定其實一路都在怕第一句浮不出來。
╭──────────────────────────────────────────────────────────────────────────────╮
│ >                                                                            │
╰──────────────────────────────────────────────────────────────────────────────╯
```

你開始打下一句，它就自己消失。沒話的時候什麼都不畫。

## 它實際上怎麼做

1. 一輪結束（Claude 正常答完，不是被你打斷或出錯）時，mod 用 `$.model.fork` 分叉一個請求：**同一段對話、同一個模型、共用快取**，只多加一句使用者訊息，請 Claude 以「剛剛回答的那個人」的身分講一句心裡話，只回 JSON。
2. 分叉是丟出去不等的，不會拖慢那一輪的收尾；幾秒後回來，有話就畫、沒話就算了。
3. 每一句都留在側邊面板（`/whisper`）和硬碟上的紀錄檔 `~/.claude/state/whisper/<session id>.jsonl`。

**先講老實話**：這不是讀心。分叉看到的是跟 Claude 一樣的對話紀錄（看不到它的思考過程），只是任務換成「回頭看自己剛剛那段回答」。所以它抓得到的是回答裡的痕跡——講得太圓、該反駁沒反駁、數字給得心虛——而且有一部分是事後編的。把它當悄悄話，不要當證詞。

## 指令

| 指令 | 做什麼 |
| --- | --- |
| `/whisper` | 側邊面板開或關：這場全部的悄悄話，最新在上面，最上面一行是嘴碎度、幾句、分叉讀寫了多少 token |
| `/whisper 1` `2` `3` | 嘴碎度：1 含蓄（只講有把握的）、2 正常、3 不要臉。**預設 3** |
| `/whisper min 80` | 回答少於 80 個字就不問。預設 0，每輪都問 |
| `/whisper off` / `on` | 整個關掉／打開 |
| `/whisper close` | 關面板 |

設定存在 Claude Code 給這個 mod 的 store 裡，下次開視窗還在。

## 安裝

需要 Claude Code **2.1.287 以上**（mod 功能 2026-10-01 起預設開放）。不用 Node、不用裝套件。

**用 marketplace（推薦）**

```bash
claude plugin marketplace add jessetsai1024/claude-whisper
claude plugin install whisper@claude-whisper
```

然後在對話裡打 `/reload-plugins`，或重開 Claude Code。

**或者 clone 下來接捷徑**（之後 `git pull` 就是更新）

```bash
git clone https://github.com/jessetsai1024/claude-whisper.git
cd claude-whisper && ./install.sh
```

原理：放在 `~/.claude/skills/<名字>/` 底下的 plugin 會被 Claude Code 自動載入，`install.sh` 只是建一個捷徑指回這個 repo。

## 錢

分叉共用主對話的快取，所以每輪多的是「讀一次快取＋寫三四十個 token」。實測一輪：讀快取 27 萬 token、新讀 445、寫 74。API 只回 token 數不回金額，所以面板上也只列 token；自己換算的話，快取讀取大約是正常輸入價的十分之一。

## 它碰得到什麼

- 讀：整段對話（透過分叉）、`HOME`／`USERPROFILE` 環境變數、自己的紀錄檔。
- 寫：`~/.claude/state/whisper/<session id>.jsonl`、自己的設定 store。
- 不連網、不改對話、不幫你送出任何東西、不呼叫工具。`claude plugin validate .` 會列出每一個 hook 和呼叫。

## 改它

問法在 `hooks/whisper.ts` 的 `forkPrompt`，覺得太客氣或太假，改那一個函式就好。心情標籤與顏色也在同一個檔。

**改問法有一個雷**：問 Claude「你剛剛在想什麼」、或列一串「想早點收工、覺得他囉嗦」這種內心狀態，API 會直接把分叉的輸出擋掉（mod 會在對話裡留一行「分叉沒回答（api-error no-status invalid_request）」）。Opus 5.5 比 Fable 嚴。第一版就是這樣壞的；現在的問法在兩個模型上都驗過。改完先在 Opus 的 session 試一句。

```bash
claude plugin validate .   # 引擎會不會拒
claude plugin test .       # 8 個測試
tsc -p .                   # 型別（要先讓引擎載入一次，它會把型別檔寫到 .claude-plugin/types/）
```

## 來歷

2026-10-05 深夜，Jesse 看完一輪社群 mod 說「都了無新意」，問螢（他的 Claude）有沒有有趣的點子。螢提了五個，他挑了這個：「可以揭露心裡的小九九」。螢寫的，Jesse 定的規矩：預設最碎嘴、每輪都問、沒有按鈕。

MIT License.

---

## English

**whisper** is a Claude Code mod. After every turn, it forks the session (`$.model.fork`: same transcript, same model, shared prompt cache) and asks Claude one extra question — *what were you actually thinking just now?* — then shows the one-line answer, dimmed, above the prompt. It disappears when you start typing. Nothing is drawn when there is nothing to say.

- `/whisper` opens a pane with every whisper of the session; `/whisper 1|2|3` sets how candid it is (3, the default, is shameless); `/whisper min 80` skips short answers; `/whisper off` turns it off.
- Each whisper is appended to `~/.claude/state/whisper/<session id>.jsonl`.
- Honest caveat: this is the same model re-reading its own answer, not mind-reading. Treat it as gossip, not testimony.
- Install: `claude plugin marketplace add jessetsai1024/claude-whisper` then `claude plugin install whisper@claude-whisper`. Needs Claude Code 2.1.287+.
- Cost: one cache read plus ~40 output tokens per turn.
- The prompt lives in `hooks/whisper.ts` (`forkPrompt`); the band and pane in `hooks/register.tsx`. Prompts and UI are in Traditional Chinese.
- Gotcha: asking the model *what were you thinking* makes the API block the fork's output (`invalid_request`, zero tokens), more so on Opus 5.5. The shipped prompt avoids that wording; test on Opus before changing it.
