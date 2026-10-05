/** 一句悄悄話：什麼時候、哪一輪、什麼心情、講了什麼、分叉花了多少 token。 */
export type Entry = {
  /** 寫下的時間（毫秒）。 */
  at: number
  /** 這句是哪一輪答完之後講的。 */
  turnId: string
  /** 心情標籤，例如「心虛」「得意」；清單在 whisper.ts 的 MOODS。 */
  mood: string
  /** 那句話本身，40 字以內。 */
  text: string
  /** 分叉那次請求的四個 token 數；分叉失敗時沒有。 */
  usage?: { input: number; output: number; cacheRead: number; cacheWrite: number }
}

/** 輸入框上面那一行現在的狀態：沒東西、等分叉回來、或正在顯示某一句。 */
export type View =
  | { kind: 'hidden' }
  | { kind: 'loading'; turnId: string }
  | { kind: 'show'; turnId: string; entry: Entry }

/** 使用者的設定，存在 $.store 裡，下次開視窗還在。 */
export type Settings = {
  /** 關掉就什麼都不問、不畫。 */
  isOn: boolean
  /** 嘴碎度 1 含蓄、2 正常、3 不要臉。 */
  level: 1 | 2 | 3
  /** 回答少於這麼多字就不問；0 是每輪都問。 */
  minChars: number
}

declare module 'claude-code' {
  interface PluginState {
    whisper: { view: View; log: Entry[] }
  }
}
