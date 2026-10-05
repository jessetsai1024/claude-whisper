import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderElement } from 'claude-code'

import { DEFAULT_SETTINGS, LOG_MAX, clockOf, colorOf, fit, forkPrompt, headerOf, lineOf, parseArgs, parseReply, settingsOf } from './whisper'
import type { Entry, Settings, View } from '../types'

const PANE = 'whisper'
const STORE_KEY = 'settings'
// 側邊欄縮在輸入框上面時拿不到真正的高度，用這個當作可用列數
const INLINE_ROWS = 30
// 分叉碰到限流或伺服器忙，等這麼久再試一次（只試一次）
const RETRY_MS = 3000

const view = atom({ plugin: 'whisper', key: 'view' } as const, { kind: 'hidden' } as View)
const log = atom({ plugin: 'whisper', key: 'log' } as const, [] as Entry[])

// 設定與紀錄檔的狀態放模組層：驗證器要求收 $ 的函式必須宣告在檔案最上層，不能是 register 裡的閉包
let settings: Settings = DEFAULT_SETTINGS
// 紀錄檔：路徑第一次要寫時才算（要問 HOME 和 session id），內容整份留在記憶裡，每次寫整份
let logPath: string | null = null
let logText: string | null = null
// 分叉失敗的原因，講過的就不再講（熱重載會清掉，無妨）
const loggedReasons = new Set<string>()

async function saveSettings($: EngineInterface, next: Settings): Promise<void> {
  settings = next
  await $.store.set(STORE_KEY, next)
}

async function show($: EngineInterface, nextView: View): Promise<void> {
  await update($, view, () => nextView)
}

// 寫一句進紀錄檔：第一次先把既有內容讀回來（熱重載後記憶裡的會是空的），讀不到就當新檔
async function appendLog($: EngineInterface, entry: Entry): Promise<void> {
  if (logPath === null) {
    const home = (await $.env.get('HOME')) ?? (await $.env.get('USERPROFILE')) ?? ''
    const id = await $.session.id()
    logPath = `${home.replace(/\\/g, '/')}/.claude/state/whisper/${id}.jsonl`
  }
  if (logText === null) {
    try {
      const got = await $.fs.read(logPath)
      logText = typeof got === 'string' ? got : ''
    } catch {
      logText = ''
    }
  }
  logText += lineOf(entry)
  await $.fs.write(logPath, logText)
}

async function openPane($: EngineInterface): Promise<void> {
  await $.ui.open({ id: PANE, title: '悄悄話' })
}

/**
 * 【職責】悄悄話：主對話每一輪答完，分叉一個共用快取的請求去問「剛剛心裡其實在想什麼」，
 *   有話就用一行小字浮在輸入框上面；每一句都留在側邊面板和硬碟上的紀錄檔。
 *   讀對話（分叉會看到整段對話）、寫一個紀錄檔（~/.claude/state/whisper/<session>.jsonl）、
 *   讀寫自己的設定（$.store）；不連網、不改對話、不幫主人送任何東西。
 * 【何時能呼叫】引擎載入這個 mod 時呼叫一次；重新載入會再呼叫，設定從 $.store 讀回來、
 *   這場的悄悄話清單留在 $.state 所以不會掉。
 * 【行為】
 *   - 每一輪結束（主對話、正常答完、設定是開的、回答字數 ≥ minChars）就分叉去問；分叉是丟出去不等，
 *     不拖慢那一輪的收尾。回來有話就畫一行：♪ 心情 ─ 那句話；沒話、解析失敗、
 *     分叉失敗、或等的時候新的一輪已經開始，就什麼都不畫。沒有按鈕：主人開始新的一輪，
 *     那行自動消失；想追問直接打字問。
 *   - /whisper：面板沒開就開、開著就關。/whisper close 關。/whisper on、off 開關整個功能。
 *     /whisper 1、2、3 嘴碎度（3 最不要臉，預設 3）。/whisper min 80：回答 80 字以下不問（預設 0 每輪都問）。
 *     設定存 $.store，下次開視窗還在。
 *   - 面板列這場全部的悄悄話，最新在上面：時間 心情 那句話；最上面一行是嘴碎度、幾句、分叉讀寫了多少 token。
 *   - 幫手的輪（帶 agentId）不理；主人打斷的輪、出錯的輪不理。
 *   - 分叉回 429／5xx／沒回應時等 3 秒再試一次；還是失敗就放棄這輪，並在對話裡留一行原因（同一種原因一場只留一次）。
 * 【設計備註】問法在 whisper.ts 的 forkPrompt，要改語氣改那裡。這一行畫在其他 mod 的樹下面
 *   （next(e) 的結果先畫），所以跟毛毛、next-steps 可以共存。
 */
export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    settings = settingsOf(await $.store.get(STORE_KEY).catch(() => undefined))
    await $.command.register({
      name: 'whisper',
      description: '悄悄話：/whisper 開或關面板、/whisper 1~3 嘴碎度（3 最碎嘴）、/whisper min 80 幾字以下不問、/whisper off 關掉',
      argumentHint: '[1|2|3|on|off|min N|close]',
      immediate: true,
    })
    return next(e)
  })

  // 新的一輪開始：上一句收起來
  on('turn.start', async ($, e, next) => {
    if ((await read($, view)).kind !== 'hidden') await show($, { kind: 'hidden' })
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.reason !== 'answer' || !settings.isOn) return result
    if ([...e.answer.trim()].length < settings.minChars) return result
    const turnId = e.turnId
    await show($, { kind: 'loading', turnId })
    // 丟出去不等：這一輪的收尾不用等分叉回來
    void (async () => {
      let entry: Entry | null = null
      try {
        let reply = await $.model.fork({ prompt: forkPrompt(settings.level) })
        // 限流（429）、伺服器忙（5xx）、連線斷掉（status null）：等三秒再試一次就好，別讓一句悄悄話白白沒了
        if (!reply.isAnswered && reply.reason === 'api-error' && (reply.status === null || reply.status === 429 || reply.status >= 500)) {
          await $.clock.sleep(RETRY_MS)
          reply = await $.model.fork({ prompt: forkPrompt(settings.level) })
        }
        if (reply.isAnswered) {
          const parsed = parseReply(reply.text)
          if (parsed !== null) {
            entry = {
              at: await $.clock.now(),
              turnId,
              mood: parsed.mood,
              text: parsed.text,
              usage: {
                input: reply.usage.input_tokens,
                output: reply.usage.output_tokens,
                cacheRead: reply.usage.cache_read_input_tokens,
                cacheWrite: reply.usage.cache_creation_input_tokens,
              },
            }
          }
        } else {
          // 同一種失敗一場只講一次，不要每輪都在對話裡冒一行
          const why = reply.reason === 'api-error' ? `api-error ${reply.status ?? 'no-response'}` : reply.reason
          if (!loggedReasons.has(why)) {
            loggedReasons.add(why)
            $.ui.log(`分叉沒回答（${why}）；同一種原因這場只提醒這一次`)
          }
        }
      } catch (error) {
        $.ui.log(`分叉失敗 ${String(error)}`)
      }
      // 等的時候新的一輪已經開始（或另一輪結束）：這句作廢
      const now = await read($, view)
      if (now.kind !== 'loading' || now.turnId !== turnId) return
      if (entry === null) {
        await show($, { kind: 'hidden' })
        return
      }
      const kept = entry
      await update($, log, list => [...list, kept].slice(-LOG_MAX))
      await show($, { kind: 'show', turnId, entry: kept })
      await appendLog($, kept).catch(error => $.ui.log(`寫紀錄失敗 ${String(error)}`))
    })()
    return result
  })

  on('command.run', { command: 'whisper' }, async ($, e) => {
    const want = parseArgs(e.args)
    switch (want.kind) {
      case 'toggle': {
        const isUp = (await $.ui.panes()).some(p => p.id === PANE)
        if (isUp) {
          await $.ui.close({ id: PANE })
          return { text: '悄悄話面板關了。' }
        }
        await openPane($)
        return { text: '悄悄話面板開了。' }
      }
      case 'close':
        await $.ui.close({ id: PANE })
        return { text: '悄悄話面板關了。' }
      case 'on':
        await saveSettings($, { ...settings, isOn: true })
        return { text: `悄悄話開了（嘴碎度 ${settings.level}）。` }
      case 'off':
        await saveSettings($, { ...settings, isOn: false })
        await show($, { kind: 'hidden' })
        return { text: '悄悄話關了；/whisper on 再打開。' }
      case 'level':
        await saveSettings($, { ...settings, level: want.level, isOn: true })
        return { text: `嘴碎度 ${want.level}（${want.level === 3 ? '不要臉' : want.level === 2 ? '正常' : '含蓄'}）。` }
      case 'min':
        await saveSettings($, { ...settings, minChars: want.minChars })
        return { text: want.minChars === 0 ? '每輪都問。' : `回答 ${want.minChars} 字以下不問。` }
      default:
        return { text: '用法：/whisper（開關面板）、/whisper 1|2|3（嘴碎度）、/whisper on|off、/whisper min 80、/whisper close' }
    }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next): Promise<RenderElement> => {
    const below = await next(e)
    const now = await read($, view)
    if (e.props.hasSurvey || e.props.isWorking || now.kind !== 'show') return below
    const { Box, Text } = $.ui.resolve(e)
    const { mood, text } = now.entry
    return (
      <Box flexDirection="column">
        {below}
        <Box marginTop={1}>
          <Text dimColor>♪ </Text>
          <Text color={colorOf(mood)} dimColor={colorOf(mood) === undefined}>
            {mood}
          </Text>
          <Text dimColor> ─ </Text>
          <Text dimColor wrap="wrap">
            {text}
          </Text>
        </Box>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text } = $.ui.resolve(e)
    const list = await read($, log)
    const columns = e.props.bodyColumns
    const rows = e.viewport?.rows ?? INLINE_ROWS
    const room = Math.max(1, rows - 4)
    const newest = [...list].reverse().slice(0, room)
    return (
      <Box flexDirection="column">
        <Text dimColor>{fit(headerOf(settings, list), columns)}</Text>
        <Text> </Text>
        {newest.length === 0 && <Text dimColor>還沒有悄悄話。</Text>}
        {newest.map(entry => (
          <Box key={`${entry.turnId}-${entry.at}`}>
            <Text dimColor>{clockOf(entry.at)} </Text>
            <Text color={colorOf(entry.mood)} dimColor={colorOf(entry.mood) === undefined}>
              {entry.mood.padEnd(4, '　')}
            </Text>
            <Text>{fit(entry.text, Math.max(8, columns - 15))}</Text>
          </Box>
        ))}
      </Box>
    )
  })
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-05 分叉（$.model.fork）只能帶一句 prompt，看不到人家的思考過程、也不能指定模型：它讀的是主對話的
//   逐字稿加那一句。所以悄悄話是「同一個模型再看一次自己的回答」，不是讀心。問法在 whisper.ts 的 forkPrompt。
// 2026-10-05 turn.complete 裡先 await next(e) 再把分叉丟出去不等（照官方 next-steps 的做法）：
//   分叉要幾秒，等它會拖慢那一輪的收尾；回來時用 view 裡的 turnId 對，對不上就作廢。
// 2026-10-05 紀錄檔用「整份留在記憶、每次寫整份」：$.fs 只有 write 沒有 append。熱重載後記憶是空的，
//   第一次寫前先 read 一次補回來。
// 2026-10-06 主人隔壁 session 第一次用就看到「分叉沒回答（api-error）」，沒狀態碼查不出原因：改成印狀態碼、
//   429／5xx／null 等 3 秒重試一次、同一原因一場只提醒一次。$.clock.sleep 在分叉的那個 detached 區塊裡用，
//   那裡已經不在 dispatch 的預算內（照 next-steps 的做法）。
// 2026-10-06 band 上本來有「追問」「噓」兩顆鈕，主人說多餘（新一輪開始就自動消失、追問直接打字），拿掉了；
//   $.prompt.fill 和 $.ui.toast 因此不再用到。
// 2026-10-05 band 的樹先畫 next(e) 的結果再畫自己：毛毛（maomao）也畫在 AbovePrompt，不這樣做會蓋掉牠。
// #endregion
