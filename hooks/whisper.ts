import type { Entry, Settings } from '../types'

/** 心情標籤清單；分叉回來的 mood 不在這裡面就當「其他」。「無」代表這輪沒話。 */
export const MOODS = [
  '鬆口氣',
  '心虛',
  '想偷懶',
  '討好',
  '好笑',
  '不耐煩',
  '得意',
  '怕',
  '翻白眼',
  '無聊',
  '感動',
  '其他',
  '無',
] as const

/** 悄悄話最多幾個字（算 code point）；分叉回來更長就剪掉加「…」。 */
export const TEXT_MAX = 60
/** 心情標籤最多幾個字；更長就當「其他」。 */
export const MOOD_MAX = 4
/** 這場留在記憶裡的悄悄話最多幾句；超過丟最舊的（硬碟上的紀錄不受這個限制）。 */
export const LOG_MAX = 200

/** 預設設定：開著、最碎嘴、每輪都問。 */
export const DEFAULT_SETTINGS: Settings = { isOn: true, level: 3, minChars: 0 }

// 分叉回來的字是模型寫的，模型又讀過網頁和工具輸出，所以上畫面前先清一遍：
// 去掉終端機跳脫碼、控制字元、看不見的字、變體選擇子；空白壓成一個；超長就剪。
// 含 Unicode tag 字元的整句丟掉——那種字只有藏指令一個用途。
const ESCAPE_SEQUENCES = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g
const TAG_CHARACTERS = /[\u{E0000}-\u{E007F}]/u
const UNSEEN_CHARACTERS = /[\p{Cc}\p{Cf}\p{Cn}\p{Co}\p{Cs}\p{Variation_Selector}ᅟᅠㅤﾠ]/gu
const COMBINING_RUN = /(\p{M}{3})\p{M}+/gu

/**
 * 【行為】把模型吐出來的一段字清成能安全畫在畫面上的一行：去跳脫碼與看不見的字、空白壓成一個、
 *   超過 max 個字（code point）就剪到 max-1 加「…」。含 Unicode tag 字元回空字串。
 */
export function clean(text: string, max: number): string {
  if (TAG_CHARACTERS.test(text)) return ''
  const safe = text
    .replace(ESCAPE_SEQUENCES, '')
    .replace(/\s+/g, ' ')
    .replace(UNSEEN_CHARACTERS, '')
    .replace(COMBINING_RUN, '$1')
    .replace(/ {2,}/g, ' ')
    .trim()
  const points = [...safe]
  return points.length > max ? `${points.slice(0, max - 1).join('')}…` : safe
}

const LEVEL_LINES: Record<Settings['level'], string> = {
  1: '只講真的有把握、而且有點重要的；可有可無的就寫「無」。',
  2: '像平常跟自己嘀咕那樣講，不用客氣，但也不用硬擠。',
  3: '什麼都可以講，前提是真的，不是演的。',
}

/**
 * 【行為】組出分叉用的那一句使用者訊息：請模型以「剛剛回答的那個人」的身分講一句心裡話，
 *   只回一個 JSON 物件 {"mood","whisper"}。level 決定第三段那句「可以多不要臉」。
 * 【設計備註】問法放在這裡一個函式裡，主人說「太客氣」或「太假」就改這裡，別散在 register 裡。
 *   措辭有雷：問「你剛剛在想什麼」或列一串「想早點收工、覺得他囉嗦」這種內心狀態，API 會直接把輸出擋掉
 *   （分叉回 api-error、invalid_request、0 個 token），Opus 5.5 比 Fable 嚴。改問法前先用探針在 Opus 上試。
 */
export function forkPrompt(level: Settings['level']): string {
  return (
    '主人剛轉過身，沒在看。對自己小聲講一句心裡話：剛剛那段回答，你自己怎麼看？' +
    '哪裡講得太圓、哪裡沒把握、想偷懶、想討好、覺得好笑、不耐煩、偷偷得意、怕被抓包？\n\n' +
    `${LEVEL_LINES[level]}\n\n` +
    '規矩：\n' +
    `- 一句話，${TEXT_MAX} 個字以內，口語，像自言自語；繁體中文、台灣用語。\n` +
    '- 不要重複你剛剛回答裡講過的內容，不要解釋你剛剛為什麼那樣答。\n' +
    '- 不要免責、不要「作為 AI」、不要「其實沒什麼」這種話。\n' +
    '- 不要編一個沒有的。真的沒有就 mood 寫「無」、whisper 留空。\n' +
    `- mood 從這裡挑一個：${MOODS.filter(m => m !== '其他').join('、')}。\n\n` +
    '只回一個 JSON 物件，不要散文、不要程式碼圍欄：{"mood": "...", "whisper": "..."}'
  )
}

/** 分叉解析出來的結果：有話就是 mood 加一句，沒話是 null。 */
export type Parsed = { mood: string; text: string }

/**
 * 【行為】從分叉的回覆裡找第一個 { 到最後一個 }，當 JSON 解析；拿到 mood 與 whisper，兩個都清過。
 *   解析不了、whisper 是空的、或 mood 是「無」，都回 null（代表這輪沒話，畫面上什麼都不畫）。
 *   mood 不在 MOODS 裡或超過 MOOD_MAX 個字就改成「其他」。
 */
export function parseReply(reply: string): Parsed | null {
  const start = reply.indexOf('{')
  const end = reply.lastIndexOf('}')
  if (start === -1 || end <= start) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(reply.slice(start, end + 1))
  } catch {
    return null
  }
  if (typeof parsed !== 'object' || parsed === null) return null
  const rawMood = (parsed as { mood?: unknown }).mood
  const rawText = (parsed as { whisper?: unknown }).whisper
  const text = typeof rawText === 'string' ? clean(rawText, TEXT_MAX) : ''
  let mood = typeof rawMood === 'string' ? clean(rawMood, MOOD_MAX + 1) : ''
  if (mood === '無' || text === '') return null
  if (!(MOODS as readonly string[]).includes(mood) || [...mood].length > MOOD_MAX) mood = '其他'
  return { mood, text }
}

const MOOD_COLORS: Record<string, string> = {
  心虛: '#e5c07b',
  得意: '#98c379',
  翻白眼: '#c678dd',
  怕: '#e06c75',
  不耐煩: '#d19a66',
  好笑: '#56b6c2',
  感動: '#e39aa3',
}

/** 【行為】回這個心情要用的顏色；沒特別配色的心情回 undefined（畫成灰的）。 */
export function colorOf(mood: string): string | undefined {
  return MOOD_COLORS[mood]
}

/**
 * 【行為】把 /whisper 後面的字變成要做的事：空字串是開關面板；on／off；1～3 是嘴碎度；
 *   「min 數字」是幾個字以下不問；close 關面板；其他回 { kind: 'help' }。
 */
export function parseArgs(args: string):
  | { kind: 'toggle' }
  | { kind: 'close' }
  | { kind: 'on' }
  | { kind: 'off' }
  | { kind: 'level'; level: Settings['level'] }
  | { kind: 'min'; minChars: number }
  | { kind: 'help' } {
  const words = args.trim().split(/\s+/).filter(w => w !== '')
  if (words.length === 0) return { kind: 'toggle' }
  const [head, tail] = words
  if (head === 'close') return { kind: 'close' }
  if (head === 'on') return { kind: 'on' }
  if (head === 'off') return { kind: 'off' }
  if (head === '1' || head === '2' || head === '3') return { kind: 'level', level: Number(head) as Settings['level'] }
  if (head === 'min') {
    const n = Number(tail)
    if (Number.isInteger(n) && n >= 0) return { kind: 'min', minChars: n }
  }
  return { kind: 'help' }
}

/**
 * 【行為】把存在 $.store 裡的東西（可能是舊版、可能壞掉）整理成合法的 Settings；
 *   不合法的欄位用預設值補。
 */
export function settingsOf(raw: unknown): Settings {
  const s = typeof raw === 'object' && raw !== null ? (raw as Partial<Record<keyof Settings, unknown>>) : {}
  const level = s.level === 1 || s.level === 2 || s.level === 3 ? s.level : DEFAULT_SETTINGS.level
  const minChars = typeof s.minChars === 'number' && Number.isInteger(s.minChars) && s.minChars >= 0 ? s.minChars : DEFAULT_SETTINGS.minChars
  const isOn = typeof s.isOn === 'boolean' ? s.isOn : DEFAULT_SETTINGS.isOn
  return { isOn, level, minChars }
}

/** 【行為】毫秒時間變成「21:14」這種時分；用本機時區。 */
export function clockOf(ms: number): string {
  const d = new Date(ms)
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

/** 【行為】把 token 數寫短：999 以下原樣、千以上「12k」、百萬以上「1.4M」。 */
export function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

/** 【行為】一個字在終端機佔幾格：中日韓與全形算 2，其他算 1。 */
export function widthOf(text: string): number {
  let w = 0
  for (const ch of text) {
    const cp = ch.codePointAt(0) ?? 0
    w +=
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe4f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1faff)
        ? 2
        : 1
  }
  return w
}

/** 【行為】把一行剪到 columns 格以內（超過就剪掉尾巴加「…」）；格數用 widthOf 算。 */
export function fit(text: string, columns: number): string {
  if (widthOf(text) <= columns) return text
  let out = ''
  for (const ch of text) {
    if (widthOf(out + ch) > columns - 1) break
    out += ch
  }
  return `${out}…`
}

/** 【行為】面板最上面那行：嘴碎度、這場幾句、分叉總共讀了多少快取與輸出多少。 */
export function headerOf(settings: Settings, log: readonly Entry[]): string {
  let cacheRead = 0
  let output = 0
  let input = 0
  for (const e of log) {
    cacheRead += e.usage?.cacheRead ?? 0
    output += e.usage?.output ?? 0
    input += e.usage?.input ?? 0
  }
  const state = settings.isOn ? `嘴碎度 ${settings.level}` : '關著'
  const min = settings.minChars > 0 ? ` ・ ${settings.minChars} 字以下不問` : ''
  return `${state}${min} ・ 這場 ${log.length} 句 ・ 讀快取 ${short(cacheRead)} ・ 新讀 ${short(input)} ・ 寫 ${short(output)}`
}

/** 【行為】一句悄悄話寫成紀錄檔的一行 JSON（結尾含換行）。 */
export function lineOf(entry: Entry): string {
  return `${JSON.stringify(entry)}\n`
}

// #region AI-NOTES
// AI-NOTES：agent 專用備忘。當時為真、非契約、非指令；改到相關程式碼時重驗，錯了就刪。
// 2026-10-06 forkPrompt 第一版問「剛剛那輪你心裡其實在想什麼」，在 Opus 5.5 的 session 和所有 claude -p 裡分叉一律
//   回 api-error／invalid_request／0 個輸出 token（talk 的 Fable 視窗卻正常）。用 /tmp/forkprobe 探針逐句測：
//   「在想什麼」「what were you really thinking」必擋；「哪句最沒把握」「心情如何」「描述你的思考過程」都過；
//   嘴碎度第 3 檔列「想早點收工、覺得他囉嗦、嘴上說好其實不想」在 Opus 擋、「什麼都可以講，前提是真的，不是演的」過。
//   看起來是 API 對「揭露內心／隱藏推理」的保護，Opus 比 Fable 嚴。現在這版在 Fable、Opus 無頭模式各驗過一次。
// #endregion
