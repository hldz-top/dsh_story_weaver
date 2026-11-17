/** Scene cast, viewpoint and misread frame for one chapter outline, and the body-task cards derived from them. */
import { type CharacterCore, type CharacterSheet, type CharacterVoice } from './character-sheet.ts'
import { echo, StageValidationRejection } from './stage-rejection.ts'

/** Prompt version that publishes scene cast, viewpoint and misread, and injects present-character cards into the body task. */
export const SCENE_CAST_PROMPT_VERSION = 15
/** Default Han-character budget for every injected character card together. */
export const DEFAULT_MAX_CAST_CARD_CHARS = 1200
/** Han-character budget of one injected card. */
export const MAX_CAST_TELL_HAN = 120
/** How many non-viewpoint cards survive a budget trim, together with every viewpoint. */
export const CAST_KEEP_BY_APPEARANCE = 4
/** Appended to the body task when cards were dropped to stay inside the budget. */
export const CAST_CARDS_OMITTED = '（其余角色卡已省略）'
/** Closed misread frame of one scene. `其它` has no free-text note here; the character card may still carry `其它:<note>`. */
export const SCENE_MISREAD_FRAMES = ['利益', '礼法', '逻辑', '技艺', '生计', '其它'] as const

/** One scene's optional cast fields. Older outlines omit all three. */
export interface SceneCastScene {
  readonly id: string
  readonly cast?: readonly string[] | undefined
  readonly pov?: string | undefined
  readonly misread?: string | undefined
}
/** Dominant frame stored on a scene. */
export type SceneMisread = (typeof SCENE_MISREAD_FRAMES)[number]
/** One present character, compressed to a single line. */
export interface CastCard { readonly name: string; readonly tell: string }
/** The frame the chapter outline assigned to one scene. */
export interface MisreadMapEntry { readonly sceneId: string; readonly frame: SceneMisread }
/** Cards and frames for one body task. Empty when injection is off or no card could be read. */
export interface CastInjection {
  readonly castCards: readonly CastCard[]
  readonly misreadMap: readonly MisreadMapEntry[]
  readonly uncastNames: readonly string[]
  readonly omittedMarker?: string
}

const HAN = /\p{Script=Han}/u

/** @param text - Any string. @returns How many Han characters it contains. */
export function countHan(text: string): number {
  let count = 0
  for (const char of text) if (HAN.test(char)) count += 1
  return count
}

/**
 * Reject a scene whose viewpoint is outside its cast, or whose misread is outside the closed frame list.
 * `其它` and `其它:` plus 1 to 10 characters are allowed. Unknown cast names are not decided here.
 * The same frame on every scene is not a rejection; {@link uniformMisreadNote} records that as an advisory.
 * @param scenes - Admitted chapter-outline scenes.
 */
export function assertSceneCastFields(scenes: readonly SceneCastScene[]): void {
  for (const scene of scenes) {
    if (scene.misread !== undefined) {
      const message = sceneMisreadMessage(scene.id, scene.misread)
      if (message !== null) throw new StageValidationRejection(message)
    }
    if (scene.pov !== undefined && !(scene.cast ?? []).includes(scene.pov)) {
      const cast = scene.cast ?? []
      const listed = cast.length === 0 ? 'none' : cast.map(name => echo(name)).join(', ')
      throw new StageValidationRejection(`Scene ${echo(scene.id)} field pov is ${echo(scene.pov)}; expected pov to be one name in cast (${listed}).`)
    }
  }
}

/**
 * Advisory when every scene that names a frame names the same one. One scene, or a mix of frames, returns null.
 * @param scenes - Chapter-outline scenes.
 */
export function uniformMisreadNote(scenes: readonly SceneCastScene[]): string | null {
  const frames = scenes.flatMap(scene => scene.misread === undefined ? [] : [scene.misread])
  const first = frames[0]
  if (first === undefined || frames.length < 2 || frames.some(frame => frame !== first)) return null
  return `Advisory cast: every scene uses misread ${first}. The outline is kept.`
}

function sceneMisreadMessage(sceneId: string, value: string): string | null {
  if ((SCENE_MISREAD_FRAMES as readonly string[]).includes(value)) return null
  if (value.startsWith('其它:')) {
    const note = value.slice('其它:'.length)
    if (note.trim().length > 0 && [...note].length <= 10) return null
  }
  return `Scene ${echo(sceneId)} field misread is ${echo(value)}; expected one of ${SCENE_MISREAD_FRAMES.join(', ')}, or 其它: followed by 1 to 10 characters.`
}

/**
 * Cast names that are not on the character card, in first-seen order.
 * @param scenes - Chapter-outline scenes. @param knownNames - Character-card names.
 */
export function uncastNamesOf(scenes: readonly SceneCastScene[], knownNames: ReadonlySet<string>): string[] {
  const names: string[] = []
  const seen = new Set<string>()
  for (const scene of scenes) {
    for (const name of scene.cast ?? []) {
      if (knownNames.has(name) || seen.has(name)) continue
      seen.add(name)
      names.push(name)
    }
  }
  return names
}

/**
 * Reject cast names the character card does not list. Used only when `strictCast` is on.
 * @param scenes - Chapter-outline scenes. @param knownNames - Character-card names.
 */
export function assertKnownCast(scenes: readonly SceneCastScene[], knownNames: ReadonlySet<string>): void {
  const unknown = uncastNamesOf(scenes, knownNames)
  if (unknown.length === 0) return
  const listed = unknown.map(name => echo(name)).join(', ')
  throw new StageValidationRejection(`Scene cast names ${listed} are not on the e5/e6 character card. strictCast is on, so each cast name must be a 角色 in that card. Add the person to the card or remove the name from cast.`)
}

/**
 * Merge e5 and e6 cards. A name that appears in both keeps the earlier sheet. A dimension that did not parse is omitted by the caller.
 * @param sheets - Parsed cards, e5 before e6.
 */
export function mergeCharacterSheets(sheets: readonly CharacterSheet[]): CharacterSheet | null {
  const core: CharacterCore[] = []
  const voice: CharacterVoice[] = []
  const seen = new Set<string>()
  for (const sheet of sheets) {
    for (const row of sheet.core) {
      if (seen.has(row.name)) continue
      const spoken = sheet.voice.find(item => item.name === row.name)
      if (spoken === undefined) continue
      seen.add(row.name)
      core.push(row)
      voice.push(spoken)
    }
  }
  return core.length === 0 ? null : { core, voice }
}

/** @param text - One card line. @param maxHan - Han budget. @returns The line, cut with an ellipsis once the budget is full. */
function trimTell(text: string, maxHan: number): string {
  let han = 0
  let kept = ''
  for (const char of text) {
    if (HAN.test(char)) {
      if (han === maxHan) return `${kept}…`
      han += 1
    }
    kept += char
  }
  return kept
}

function tellOf(core: CharacterCore, voice: CharacterVoice): string {
  const line = `${core.name}｜${core.misread}｜称他"${voice.addressForProtagonist}"，自称"${voice.selfReference}"｜${voice.syntax}｜${voice.mannerism}｜禁：${voice.forbidden}`
  return trimTell(line, MAX_CAST_TELL_HAN)
}

interface RankedCard {
  readonly name: string
  readonly tell: string
  appearances: number
  readonly firstSeen: number
  povAt: number | null
}

function sceneFrame(value: string): SceneMisread | undefined {
  if ((SCENE_MISREAD_FRAMES as readonly string[]).includes(value)) return value as SceneMisread
  if (value.startsWith('其它:') && sceneMisreadMessage('scene', value) === null) return '其它'
  return undefined
}

/**
 * Build the body-task cards for the scenes' cast.
 * Names in the result are exactly the cast union that also has a card. A card name absent from every cast is left out.
 * Over the Han budget, the kept cards are every viewpoint plus the four names in the most scenes.
 * @param scenes - The chapter outline's scenes. @param options - Sheet, switch and budget. A null sheet injects nothing.
 */
export function buildCastInjection(scenes: readonly SceneCastScene[], options: {
  readonly sheet: CharacterSheet | null
  readonly castInjection?: boolean | undefined
  readonly maxCastCardChars?: number | undefined
}): CastInjection {
  const empty: CastInjection = { castCards: [], misreadMap: [], uncastNames: [] }
  if (options.castInjection === false || options.sheet === null) return empty
  const maxCastCardChars = options.maxCastCardChars ?? DEFAULT_MAX_CAST_CARD_CHARS
  if (!Number.isSafeInteger(maxCastCardChars) || maxCastCardChars < 1) throw new Error('maxCastCardChars must be a finite positive integer')
  const voiceByName = new Map(options.sheet.voice.map(row => [row.name, row]))
  const byName = new Map(options.sheet.core.flatMap(row => {
    const voice = voiceByName.get(row.name)
    return voice === undefined ? [] : [[row.name, { core: row, voice }] as const]
  }))
  const known = new Set(byName.keys())
  const ranked = new Map<string, RankedCard>()
  scenes.forEach((scene, index) => {
    for (const name of new Set(scene.cast ?? [])) {
      const card = byName.get(name)
      if (card === undefined) continue
      const row = ranked.get(name)
      if (row === undefined) ranked.set(name, { name, tell: tellOf(card.core, card.voice), appearances: 1, firstSeen: index, povAt: scene.pov === name ? index : null })
      else {
        row.appearances += 1
        if (scene.pov === name && row.povAt === null) row.povAt = index
      }
    }
  })
  const rows = [...ranked.values()]
  const total = rows.reduce((sum, row) => sum + countHan(row.tell), 0)
  let kept = [...rows].sort((left, right) => left.firstSeen - right.firstSeen)
  let omitted = false
  if (total > maxCastCardChars) {
    omitted = true
    const byAppearance = [...rows].sort((left, right) => right.appearances - left.appearances || left.firstSeen - right.firstSeen)
    const frequent = new Set(byAppearance.slice(0, CAST_KEEP_BY_APPEARANCE).map(row => row.name))
    const viewpoints = rows.flatMap(row => row.povAt === null ? [] : [{ ...row, povAt: row.povAt }]).sort((left, right) => left.povAt - right.povAt)
    const chosen = new Set<string>([...viewpoints.map(row => row.name), ...frequent])
    kept = [
      ...viewpoints,
      ...byAppearance.filter(row => chosen.has(row.name) && row.povAt === null),
    ]
  }
  const misreadMap = scenes.flatMap(scene => {
    if (scene.misread === undefined) return []
    const frame = sceneFrame(scene.misread)
    return frame === undefined ? [] : [{ sceneId: scene.id, frame }]
  })
  return {
    castCards: kept.map(row => ({ name: row.name, tell: row.tell })),
    misreadMap,
    uncastNames: uncastNamesOf(scenes, known),
    ...(omitted ? { omittedMarker: CAST_CARDS_OMITTED } : {}),
  }
}

/**
 * Task fields a body prompt should carry. An empty injection adds no keys, so a run with no card keeps its previous task shape.
 * @param injection - The result of {@link buildCastInjection}.
 */
export function castTaskFields(injection: CastInjection): {
  castCards?: readonly CastCard[]
  misreadMap?: readonly MisreadMapEntry[]
  uncastNames?: readonly string[]
  castCardsOmitted?: string
} {
  if (injection.castCards.length === 0 && injection.misreadMap.length === 0 && injection.uncastNames.length === 0 && injection.omittedMarker === undefined) return {}
  return {
    ...(injection.castCards.length === 0 ? {} : { castCards: injection.castCards }),
    ...(injection.misreadMap.length === 0 ? {} : { misreadMap: injection.misreadMap }),
    ...(injection.uncastNames.length === 0 ? {} : { uncastNames: injection.uncastNames }),
    ...(injection.omittedMarker === undefined ? {} : { castCardsOmitted: injection.omittedMarker }),
  }
}
