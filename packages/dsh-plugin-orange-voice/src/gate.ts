/**
 * Whether an utterance is for the bot. Pure state, clock injected.
 *
 * Windows open on the speaker's custom wake word (`kws`), on XiaoAI's own wake (its recognizer starts producing
 * results), and after the bot itself spoke (follow-up). An utterance inside a window is transcribed and delivered;
 * outside one it is dropped, or — with `alwaysListen` — transcribed and delivered only when it starts with one of the
 * `prefixes`. XiaoAI's final recognition result of a native wake decides whether the utterance is XiaoAI's after all
 * (`bypassPrefixes`, e.g. "小爱，开灯").
 *
 * @module dsh-plugin-orange-voice/gate
 */

export type Via = 'kws' | 'native' | 'follow-up' | 'prefix'

export interface GateOptions {
  kws: boolean
  wakeWords: readonly string[]
  native: boolean
  bypassPrefixes: readonly string[]
  prefixes: readonly string[]
  alwaysListen: boolean
  windowMs: number
  followUpMs: number
}

export type Decision = { action: 'transcribe'; via: Via; prefixOnly: boolean } | { action: 'drop'; reason: string }

const PUNCT = /^[\s，,、:：!！?？。.的呀啊]+/

export class WakeGate {
  private window: { until: number; via: Via; keyword?: string } | undefined
  private nativeFinal: { at: number; text: string; bypass: boolean } | undefined
  private nativeStarted = 0

  constructor(private readonly options: GateOptions, private readonly now: () => number = Date.now) {}

  /** A custom wake word was heard. Returns whether it opened a window. */
  keyword(word: string): boolean {
    if (!this.options.kws || !word) return false
    if (this.options.wakeWords.length && !this.options.wakeWords.some((w) => word.includes(w))) return false
    this.open('kws', this.options.windowMs, word)
    return true
  }

  /** XiaoAI's recognizer is running (a wake by "小爱同学"). */
  nativeListening(): void {
    if (!this.options.native) return
    if (this.window?.via !== 'native' || this.now() > this.window.until) {
      this.nativeStarted = this.now()
      this.nativeFinal = undefined
    }
    this.open('native', this.options.windowMs)
  }

  /** XiaoAI's final recognition result. Returns whether XiaoAI keeps this one. */
  nativeResult(text: string): boolean {
    const clean = text.trim()
    const bypass = this.options.bypassPrefixes.some((word) => word && clean.toLowerCase().startsWith(word.toLowerCase()))
    this.nativeFinal = { at: this.now(), text: clean, bypass }
    if (bypass && this.window?.via === 'native') this.window = undefined
    return bypass
  }

  /** The bot finished speaking: the next utterance needs no wake word. */
  spoke(): void {
    if (this.options.followUpMs > 0) this.open('follow-up', this.options.followUpMs)
  }

  /** Whether a native wake is still waiting for XiaoAI's final result. */
  awaitingNative(): boolean {
    return this.window?.via === 'native' && (this.nativeFinal === undefined || this.nativeFinal.at < this.nativeStarted)
  }

  /** Whether XiaoAI claimed the utterance that ended at `endedAt`. */
  bypassed(endedAt: number): boolean {
    const final = this.nativeFinal
    return final !== undefined && final.bypass && Math.abs(final.at - endedAt) < 8000
  }

  /** What to do with an utterance that ended at `endedAt`. */
  decide(endedAt: number): Decision {
    if (this.bypassed(endedAt)) return { action: 'drop', reason: 'XiaoAI keeps it (bypass prefix)' }
    const window = this.window
    if (window !== undefined && endedAt <= window.until + 1500) {
      // One window serves one utterance; a follow-up opens again after the answer.
      this.window = undefined
      return { action: 'transcribe', via: window.via, prefixOnly: false }
    }
    if (this.options.alwaysListen) return { action: 'transcribe', via: 'prefix', prefixOnly: true }
    return { action: 'drop', reason: 'no wake' }
  }

  /**
   * The text to deliver, with a leading prefix or wake word stripped; undefined when a prefix was required and
   * missing, or nothing is left.
   */
  accept(text: string, prefixOnly: boolean): { text: string; prefixed: boolean } | undefined {
    let rest = text.trim()
    let prefixed = false
    const words = [...this.options.prefixes, ...this.options.wakeWords].filter(Boolean).sort((a, b) => b.length - a.length)
    for (const word of words) {
      if (rest.toLowerCase().startsWith(word.toLowerCase())) {
        rest = rest.slice(word.length).replace(PUNCT, '').trim()
        prefixed = true
        break
      }
    }
    if (prefixOnly && !prefixed) return undefined
    if (!rest) return undefined
    return { text: rest, prefixed }
  }

  /** Give back a window an utterance used up without saying anything (only the wake word). */
  reopen(via: Via): void {
    if (via !== 'prefix') this.open(via, this.options.windowMs)
  }

  state(): { window?: { via: Via; msLeft: number; keyword?: string } } {
    const window = this.window
    if (window === undefined || this.now() > window.until) return {}
    return { window: { via: window.via, msLeft: window.until - this.now(), ...window.keyword ? { keyword: window.keyword } : {} } }
  }

  private open(via: Via, ms: number, keyword?: string): void {
    this.window = { until: this.now() + ms, via, ...keyword ? { keyword } : {} }
  }
}
