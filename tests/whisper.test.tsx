import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

import { clean, fit, forkPrompt, headerOf, parseArgs, parseReply, settingsOf, short } from '../hooks/whisper'

const COLUMNS = 100
const BAND = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 12,
  bodyColumns: COLUMNS,
  scroll: { offset: 0, bodyRows: 12 },
  view: {},
}
const RUN = { origin: { kind: 'composer' }, presentation: { isFullscreen: true, columns: COLUMNS } } as const

// 代替引擎：分叉回一句假的、紀錄檔寫進記憶、其他呼叫直接收下
function engine(on: On, reply: string): { written: string[]; forks: number } {
  const seen = { written: [] as string[], forks: 0 }
  mock.store(on)
  mock.clock(on, { now: 1_759_670_040_000 })
  mock.env(on, { HOME: '/Users/someone' })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('command.register', (_, e) => ({ value: { command: e.name } }))
  on('ui.invalidate', (_, e, next) => next(e))
  on('ui.toast', () => ({ value: undefined }))
  on('ui.log', () => ({ value: undefined }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  on('ui.close', () => ({ value: undefined }))
  on('ui.panes', () => ({ value: [] }))
  on('session.id', () => ({ value: 'session-1' }))
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  on('fs.write', (_, e) => {
    seen.written.push(e.text)
    return { value: undefined }
  })
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('model.fork', () => {
    seen.forks += 1
    return {
      value: {
        isAnswered: true,
        text: reply,
        usage: { input_tokens: 300, output_tokens: 40, cache_read_input_tokens: 52_000, cache_creation_input_tokens: 0 },
      },
    }
  })
  on('ui.render', ($, e) => {
    const { Text } = $.ui.resolve(e)
    return <Text> </Text>
  })
  return seen
}

test('分叉的回覆解析：正常、帶散文、沒話、壞掉', () => {
  expect(parseReply('{"mood": "心虛", "whisper": "那句是隨口押的"}')).toEqual({ mood: '心虛', text: '那句是隨口押的' })
  expect(parseReply('好的喵～ {"mood":"得意","whisper":"寶可夢是人家自己想裝"} 以上')).toEqual({ mood: '得意', text: '寶可夢是人家自己想裝' })
  expect(parseReply('{"mood": "無", "whisper": ""}')).toBeNull()
  expect(parseReply('{"mood": "心虛", "whisper": "  "}')).toBeNull()
  expect(parseReply('沒有 JSON')).toBeNull()
  expect(parseReply('{"mood": 3, "whisper": "x"}')).toEqual({ mood: '其他', text: 'x' })
  expect(parseReply('{"mood": "一個很長的心情標籤", "whisper": "x"}')).toEqual({ mood: '其他', text: 'x' })
  // 超過 60 字會剪
  const long = '字'.repeat(80)
  expect([...(parseReply(`{"mood":"好笑","whisper":"${long}"}`)?.text ?? '')].length).toBe(60)
})

test('清字：跳脫碼、看不見的字、tag 字元', () => {
  expect(clean('\x1b[31m紅色\x1b[0m  字', 20)).toBe('紅色 字')
  expect(clean('a​b', 20)).toBe('ab')
  expect(clean('藏指令\u{E0041}', 20)).toBe('')
  expect(clean('一二三四五', 4)).toBe('一二三…')
})

test('/whisper 的參數', () => {
  expect(parseArgs('')).toEqual({ kind: 'toggle' })
  expect(parseArgs(' 3 ')).toEqual({ kind: 'level', level: 3 })
  expect(parseArgs('min 80')).toEqual({ kind: 'min', minChars: 80 })
  expect(parseArgs('min -1')).toEqual({ kind: 'help' })
  expect(parseArgs('off')).toEqual({ kind: 'off' })
  expect(parseArgs('close')).toEqual({ kind: 'close' })
  expect(parseArgs('4')).toEqual({ kind: 'help' })
})

test('設定從 store 讀回來，壞的欄位用預設值', () => {
  expect(settingsOf(undefined)).toEqual({ isOn: true, level: 3, minChars: 0 })
  expect(settingsOf({ level: 2, minChars: 80, isOn: false })).toEqual({ isOn: false, level: 2, minChars: 80 })
  expect(settingsOf({ level: 9, minChars: -3, isOn: 'yes' })).toEqual({ isOn: true, level: 3, minChars: 0 })
})

test('問法會隨嘴碎度換一句，而且只要 JSON', () => {
  expect(forkPrompt(3)).toContain('前提是真的，不是演的')
  // 這幾個字會讓 API 把分叉的輸出擋掉（見 whisper.ts 的 AI-NOTES），不能再出現
  expect(forkPrompt(3)).not.toMatch(/在想什麼|不要臉|早點收工/)
  expect(forkPrompt(1)).toContain('只講真的有把握')
  expect(forkPrompt(2)).toContain('只回一個 JSON 物件')
  expect(forkPrompt(2)).toContain('mood 寫「無」')
})

test('面板表頭與小工具', () => {
  expect(short(999)).toBe('999')
  expect(short(52_000)).toBe('52k')
  expect(short(1_400_000)).toBe('1.4M')
  expect(fit('一二三四五六', 8)).toBe('一二三…')
  expect(fit('abc', 8)).toBe('abc')
  const header = headerOf({ isOn: true, level: 3, minChars: 0 }, [
    { at: 0, turnId: 't1', mood: '心虛', text: 'x', usage: { input: 300, output: 40, cacheRead: 52_000, cacheWrite: 0 } },
    { at: 0, turnId: 't2', mood: '得意', text: 'y', usage: { input: 300, output: 50, cacheRead: 52_000, cacheWrite: 0 } },
  ])
  expect(header).toContain('嘴碎度 3')
  expect(header).toContain('這場 2 句')
  expect(header).toContain('讀快取 104k')
  expect(headerOf({ isOn: false, level: 3, minChars: 80 }, [])).toContain('關著 ・ 80 字以下不問')
})

test('一輪答完會分叉、畫在輸入框上面、寫進紀錄檔；新的一輪開始就收起來', async ($, on) => {
  const seen = engine(on, '{"mood":"心虛","whisper":"那句是隨口押的，人家沒查"}')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })

  const ui = await $.ui.mount({ plugin: 'whisper', surface: 'terminal', component: 'AbovePrompt', props: BAND })
  expect(await ui.find({ type: 'Text', text: /心虛/ })).toBeUndefined()

  await $.turn.complete({ answer: '人家同意七成喵', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw()
  expect(seen.forks).toBe(1)
  expect(await ui.find({ type: 'Text', text: /心虛/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /隨口押的/ })).toBeDefined()
  expect(await ui.find({ type: 'Button' })).toBeUndefined()
  expect(seen.written).toHaveLength(1)
  expect(seen.written[0]).toContain('"mood":"心虛"')

  // 新的一輪開始就消失
  await $.turn.start({ turnId: 't2' } as never)
  await ui.redraw()
  expect(await ui.find({ type: 'Text', text: /心虛/ })).toBeUndefined()

  // 幫手的輪、被打斷的輪都不問
  await $.turn.complete({ answer: '幫手', durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer', agentId: 'a1' })
  await $.turn.complete({ answer: '斷', durationMs: 1, isAborted: true, turnId: 't4', reason: 'aborted' })
  expect(seen.forks).toBe(1)

  await ui.unmount()
})

test('分叉說「無」就什麼都不畫；/whisper off 之後不再問；min 80 擋短回答', async ($, on) => {
  const seen = engine(on, '{"mood":"無","whisper":""}')
  await $.session.start({ cwd: '/tmp', surface: 'terminal', isInteractive: true })
  const ui = await $.ui.mount({ plugin: 'whisper', surface: 'terminal', component: 'AbovePrompt', props: BAND })

  await $.turn.complete({ answer: '一句', durationMs: 1, isAborted: false, turnId: 't1', reason: 'answer' })
  await ui.redraw()
  expect(seen.forks).toBe(1)
  expect(await ui.find({ type: 'Text', text: /♪/ })).toBeUndefined()
  expect(seen.written).toHaveLength(0)

  const min = await $.command.run({ command: 'whisper', args: 'min 80', ...RUN })
  expect(min.text).toContain('80 字以下不問')
  await $.turn.complete({ answer: '短', durationMs: 1, isAborted: false, turnId: 't2', reason: 'answer' })
  expect(seen.forks).toBe(1)
  await $.turn.complete({ answer: '長'.repeat(80), durationMs: 1, isAborted: false, turnId: 't3', reason: 'answer' })
  expect(seen.forks).toBe(2)

  const off = await $.command.run({ command: 'whisper', args: 'off', ...RUN })
  expect(off.text).toContain('關了')
  await $.turn.complete({ answer: '長'.repeat(80), durationMs: 1, isAborted: false, turnId: 't4', reason: 'answer' })
  expect(seen.forks).toBe(2)

  const level = await $.command.run({ command: 'whisper', args: '1', ...RUN })
  expect(level.text).toContain('嘴碎度 1')
  // 嘴碎度設了之後功能會重新打開，而且 min 80 還在
  await $.turn.complete({ answer: '長'.repeat(80), durationMs: 1, isAborted: false, turnId: 't5', reason: 'answer' })
  expect(seen.forks).toBe(3)
  await $.turn.complete({ answer: '短', durationMs: 1, isAborted: false, turnId: 't6', reason: 'answer' })
  expect(seen.forks).toBe(3)

  await ui.unmount()
})
