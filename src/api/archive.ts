import type { DailyObservation, Place } from '../domain/types'
import { compareIsoDates } from '../lib/dates'
import {
  ARCHIVE_START,
  ARCHIVE_START_YEAR,
  DELTA_OVERLAP_DAYS,
  RECENT_WINDOW_YEARS,
  isValidCachedHistory,
  mergeDailyObservations,
  planArchiveFetch,
  type CachedDailyHistory,
} from './archiveMerge'

export {
  ARCHIVE_START,
  ARCHIVE_START_YEAR,
  DELTA_OVERLAP_DAYS,
  RECENT_WINDOW_YEARS,
  type CachedDailyHistory,
}

type ArchiveResponse = {
  daily?: {
    time: string[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    precipitation_sum?: (number | null)[]
  }
  timezone?: string
}

/**
 * Open-Meteo free / open-access guidance (terms + pricing):
 * - Non-commercial use
 * - Fair-use limits (IP-based): 600/min, 5_000/hour, 10_000/day
 * - Attribution under CC BY 4.0
 * - Prefer fewer, larger requests; cache; avoid hammering after 429
 *
 * We cache persistently in Cache API v2 keyed by 2-decimal place coords,
 * share in-flight work across remounts, fetch only small tail deltas on return
 * visits, load recent 20 years first on cold visits, and back off on 429.
 */

const HISTORY_CACHE_MAX = 8
const historyCache = new Map<string, CachedDailyHistory>()

const PERSISTENT_CACHE_NAME = 'analog-weather-archive-v2'
const LEGACY_CACHE_NAME = 'analog-weather-archive-v1'
const PERSISTENT_CACHE_MAX = 12

let legacyCleanupDone = false
let legacyCleanupPromise: Promise<void> | null = null

export type HistoryLoadPhase =
  | 'loading'
  | 'refreshing'
  | 'backfilling'
  | 'complete'

export type DailyHistory = {
  /** Complete or partial daily observations loaded, chronological (oldest → newest). */
  days: DailyObservation[]
  archiveEnd: string
  timezone: string
}

/** Friendly, non-technical errors for the UI. */
export class WeatherArchiveError extends Error {
  readonly kind: 'rate_limit' | 'http' | 'empty' | 'unknown'
  /** Short title for the error panel. */
  readonly title: string
  /** Plain-language body for the user. */
  readonly detail: string

  constructor(
    kind: WeatherArchiveError['kind'],
    title: string,
    detail: string,
    technicalMessage?: string,
  ) {
    super(technicalMessage ?? title)
    this.name = 'WeatherArchiveError'
    this.kind = kind
    this.title = title
    this.detail = detail
  }
}

export type UserHistoryError = {
  title: string
  detail: string
  kind: WeatherArchiveError['kind'] | 'unknown'
}

export type DailyHistoryUpdate = DailyHistory & {
  coverageStart: string
  isComplete: boolean
  phase: HistoryLoadPhase
  backgroundError?: UserHistoryError | null
}

type InflightEntry = {
  promise: Promise<DailyHistoryUpdate>
  controller: AbortController
  subscribers: number
  listeners: Set<(update: DailyHistoryUpdate) => void>
  lastUpdate: DailyHistoryUpdate | null
}

const inflightByKey = new Map<string, InflightEntry>()

export const OPEN_METEO_TERMS_URL = 'https://open-meteo.com/en/terms'

export const RATE_LIMIT_TITLE = 'The weather archive needs a short break'

/** Plain-language explanation aligned with Open-Meteo free-tier terms. */
export const RATE_LIMIT_DETAIL =
  'This app uses Open-Meteo’s free open-access weather archive — a shared service ' +
  'meant for private and non-profit sites and apps without subscriptions or advertising. ' +
  'To keep that free service fair for everyone, Open-Meteo limits how often data can be requested ' +
  '(about 600 times per minute, 5,000 per hour, and 10,000 per day on a network). ' +
  'We’ve hit that limit for now. Please wait a minute or two, then try again.'

export const RATE_LIMIT_HINT =
  'We only ask the archive once per place and remember the answer afterward. ' +
  'Full terms: open-meteo.com/en/terms'

function defaultYesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

const DEFAULT_MIN_RETRY_DELAY_MS = 15_000
const DEFAULT_RETRY_DELAY_MS = 20_000

let getNow = () => Date.now()
let getYesterdayUtc = defaultYesterdayUtc
let minRetryDelayMs = DEFAULT_MIN_RETRY_DELAY_MS
let defaultRetryDelayMs = DEFAULT_RETRY_DELAY_MS

/** @internal Testability overrides for deterministic unit tests. */
export function configureArchiveForTest(overrides: {
  now?: () => number
  yesterdayUtc?: () => string
  minRetryDelayMs?: number
  defaultRetryDelayMs?: number
}) {
  if (overrides.now) getNow = overrides.now
  if (overrides.yesterdayUtc) getYesterdayUtc = overrides.yesterdayUtc
  if (overrides.minRetryDelayMs !== undefined) {
    minRetryDelayMs = overrides.minRetryDelayMs
  }
  if (overrides.defaultRetryDelayMs !== undefined) {
    defaultRetryDelayMs = overrides.defaultRetryDelayMs
  }
}

/** @internal Reset in-memory state and test overrides between unit tests. */
export function resetArchiveForTest() {
  historyCache.clear()
  inflightByKey.clear()
  legacyCleanupDone = false
  legacyCleanupPromise = null
  getNow = () => Date.now()
  getYesterdayUtc = defaultYesterdayUtc
  minRetryDelayMs = DEFAULT_MIN_RETRY_DELAY_MS
  defaultRetryDelayMs = DEFAULT_RETRY_DELAY_MS
}

function formatCoord(n: number): string {
  const normalized = Math.abs(n) < 0.005 ? 0 : n
  return normalized.toFixed(2)
}

function locationKey(place: Place): string {
  return `${formatCoord(place.latitude)},${formatCoord(place.longitude)}`
}

function persistentCacheUrl(place: Place): string {
  return `https://cache.local/archive/${locationKey(place)}`
}

function cacheGet(key: string): CachedDailyHistory | null {
  const hit = historyCache.get(key)
  if (!hit) return null
  historyCache.delete(key)
  historyCache.set(key, hit)
  return hit
}

function cacheSet(key: string, value: CachedDailyHistory) {
  if (historyCache.has(key)) historyCache.delete(key)
  historyCache.set(key, value)
  while (historyCache.size > HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value
    if (oldest === undefined) break
    historyCache.delete(oldest)
  }
}

async function openPersistentCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    if (!legacyCleanupDone) {
      if (!legacyCleanupPromise) {
        legacyCleanupPromise = caches
          .delete(LEGACY_CACHE_NAME)
          .catch(() => false)
          .then(() => {
            legacyCleanupDone = true
          })
      }
      await legacyCleanupPromise
    }
    return await caches.open(PERSISTENT_CACHE_NAME)
  } catch {
    return null
  }
}

async function persistentCacheGet(
  place: Place,
): Promise<CachedDailyHistory | null> {
  const cache = await openPersistentCache()
  if (!cache) return null
  try {
    const url = persistentCacheUrl(place)
    const res = await cache.match(url)
    if (!res || !res.ok) return null
    const parsed: unknown = await res.json()
    if (!isValidCachedHistory(parsed)) {
      await cache.delete(url).catch(() => {})
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function readUpdatedAt(cache: Cache, req: Request): Promise<number> {
  try {
    const res = await cache.match(req)
    if (!res || !res.ok) return Number.NEGATIVE_INFINITY
    const parsed: unknown = await res.json()
    if (
      typeof parsed === 'object' &&
      parsed !== null &&
      typeof (parsed as Record<string, unknown>).updatedAt === 'number' &&
      Number.isFinite((parsed as Record<string, unknown>).updatedAt)
    ) {
      return (parsed as Record<string, unknown>).updatedAt as number
    }
    return Number.NEGATIVE_INFINITY
  } catch {
    return Number.NEGATIVE_INFINITY
  }
}

async function persistentCacheSet(
  place: Place,
  entry: CachedDailyHistory,
): Promise<void> {
  const cache = await openPersistentCache()
  if (!cache) return
  try {
    const url = persistentCacheUrl(place)
    await cache.delete(url)
    await cache.put(
      url,
      new Response(JSON.stringify(entry), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const keys = await cache.keys()
    if (keys.length <= PERSISTENT_CACHE_MAX) return

    const candidates: Array<{ req: Request; updatedAt: number }> = []
    for (const req of keys) {
      if (req.url === url) continue
      const updatedAt = await readUpdatedAt(cache, req)
      candidates.push({ req, updatedAt })
    }
    candidates.sort((a, b) => a.updatedAt - b.updatedAt)

    let excess = keys.length - PERSISTENT_CACHE_MAX
    for (const item of candidates) {
      if (excess <= 0) break
      await cache.delete(item.req)
      excess -= 1
    }
  } catch {
    // Ignore storage/quota/privacy-mode errors and rely on in-memory LRU.
  }
}

function parseDaily(
  daily: NonNullable<ArchiveResponse['daily']>,
): DailyObservation[] {
  const {
    time,
    temperature_2m_max: tMax,
    temperature_2m_min: tMin,
    precipitation_sum: precip,
  } = daily
  const n = time.length
  const days: DailyObservation[] = new Array(n)
  for (let i = 0; i < n; i++) {
    days[i] = {
      date: time[i]!,
      tMax: tMax?.[i] ?? null,
      tMin: tMin?.[i] ?? null,
      precip: precip?.[i] ?? null,
    }
  }
  return days
}

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError')
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException || err instanceof Error) &&
    err.name === 'AbortError'
  )
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const t = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(t)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Fetch an inclusive daily range from the Open-Meteo archive API.
 * Retries at most once on 429 with a polite pause honoring AbortSignal.
 */
async function fetchRange(
  place: Place,
  startDate: string,
  endDate: string,
  signal?: AbortSignal,
): Promise<{ days: DailyObservation[]; timezone: string }> {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive')
  url.searchParams.set('latitude', String(place.latitude))
  url.searchParams.set('longitude', String(place.longitude))
  url.searchParams.set('start_date', startDate)
  url.searchParams.set('end_date', endDate)
  url.searchParams.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,precipitation_sum',
  )
  url.searchParams.set('timezone', 'auto')

  const maxAttempts = 2

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw abortError()
    }

    const res = await fetch(url, { signal })

    if (res.status === 429) {
      if (attempt >= maxAttempts) {
        throw new WeatherArchiveError(
          'rate_limit',
          RATE_LIMIT_TITLE,
          RATE_LIMIT_DETAIL,
          'Open-Meteo rate limit (429)',
        )
      }
      const retryAfter = Number(res.headers.get('Retry-After'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.max(retryAfter * 1000, minRetryDelayMs)
          : defaultRetryDelayMs
      await sleep(waitMs, signal)
      continue
    }

    if (!res.ok) {
      throw new WeatherArchiveError(
        'http',
        'Could not load weather history',
        'Something went wrong while fetching the historical weather record. Please try again in a moment.',
        `Weather archive failed (${res.status})`,
      )
    }

    const data = (await res.json()) as ArchiveResponse
    const daily = data.daily
    if (!daily?.time?.length) {
      throw new WeatherArchiveError(
        'empty',
        'No weather history for this place',
        'The open weather archive did not return daily data for this location. Try a nearby city or another place.',
      )
    }

    return {
      days: parseDaily(daily),
      timezone: data.timezone ?? place.timezone ?? 'UTC',
    }
  }

  throw new WeatherArchiveError(
    'rate_limit',
    RATE_LIMIT_TITLE,
    RATE_LIMIT_DETAIL,
    'Open-Meteo rate limit (429)',
  )
}

function toUpdate(
  history: CachedDailyHistory,
  phase: HistoryLoadPhase,
  backgroundError: UserHistoryError | null = null,
): DailyHistoryUpdate {
  return {
    days: history.days,
    archiveEnd: history.archiveEnd,
    timezone: history.timezone,
    coverageStart: history.startDate,
    isComplete: history.complete,
    phase,
    backgroundError,
  }
}

function emitUpdate(entry: InflightEntry, update: DailyHistoryUpdate) {
  if (entry.controller.signal.aborted) return
  entry.lastUpdate = update
  for (const listener of [...entry.listeners]) {
    listener(update)
  }
}

/**
 * Load weather history progressively for a place using Cache API v2,
 * tail delta refreshes, and 2-phase cold loading (recent 20 years first).
 * Deduplicates concurrent subscribers and replays latest emitted state.
 */
export function loadDailyHistory(
  place: Place,
  options?: {
    signal?: AbortSignal
    preferredAnchor?: string | null
    onUpdate?: (update: DailyHistoryUpdate) => void
  },
): Promise<DailyHistoryUpdate> {
  const signal = options?.signal
  const onUpdate = options?.onUpdate

  if (signal?.aborted) {
    return Promise.reject(abortError())
  }

  const targetEnd = getYesterdayUtc()
  const key = locationKey(place)
  const mem = cacheGet(key)
  if (mem && mem.complete && compareIsoDates(mem.archiveEnd, targetEnd) >= 0) {
    const update = toUpdate(mem, 'complete')
    onUpdate?.(update)
    return Promise.resolve(update)
  }

  let entry = inflightByKey.get(key)
  if (!entry) {
    const controller = new AbortController()
    const created: InflightEntry = {
      promise: null as unknown as Promise<DailyHistoryUpdate>,
      controller,
      subscribers: 0,
      listeners: new Set(),
      lastUpdate: null,
    }

    const execute = async (): Promise<DailyHistoryUpdate> => {
      const { signal: innerSignal } = controller
      if (innerSignal.aborted) throw abortError()

      const cached = cacheGet(key) ?? (await persistentCacheGet(place))
      if (innerSignal.aborted) throw abortError()

      const plan = planArchiveFetch({
        cached,
        targetEnd,
        preferredAnchor: options?.preferredAnchor,
      })

      if (plan.kind === 'cache-hit' && cached) {
        cacheSet(key, cached)
        const update = toUpdate(cached, 'complete')
        emitUpdate(created, update)
        return update
      }

      if (plan.kind === 'delta-only' && cached) {
        cacheSet(key, cached)
        emitUpdate(created, toUpdate(cached, 'refreshing'))
        try {
          const delta = await fetchRange(
            place,
            plan.deltaStart,
            plan.deltaEnd,
            innerSignal,
          )
          const updated: CachedDailyHistory = {
            version: 2,
            startDate: cached.startDate,
            archiveEnd: plan.deltaEnd,
            complete: true,
            timezone: delta.timezone || cached.timezone,
            updatedAt: getNow(),
            days: mergeDailyObservations(cached.days, delta.days),
          }
          cacheSet(key, updated)
          await persistentCacheSet(place, updated)
          const update = toUpdate(updated, 'complete')
          emitUpdate(created, update)
          return update
        } catch (err) {
          if (innerSignal.aborted || isAbortError(err)) throw err
          const update = toUpdate(
            cached,
            'complete',
            toUserHistoryError(err),
          )
          emitUpdate(created, update)
          return update
        }
      }

      if (plan.kind === 'backfill-only' && cached) {
        cacheSet(key, cached)
        emitUpdate(created, toUpdate(cached, 'backfilling'))
        try {
          const older = await fetchRange(
            place,
            plan.backfillStart,
            plan.backfillEnd,
            innerSignal,
          )
          const updated: CachedDailyHistory = {
            version: 2,
            startDate: ARCHIVE_START,
            archiveEnd: cached.archiveEnd,
            complete: true,
            timezone: cached.timezone || older.timezone,
            updatedAt: getNow(),
            days: mergeDailyObservations(older.days, cached.days),
          }
          cacheSet(key, updated)
          await persistentCacheSet(place, updated)
          const update = toUpdate(updated, 'complete')
          emitUpdate(created, update)
          return update
        } catch (err) {
          if (innerSignal.aborted || isAbortError(err)) throw err
          const update = toUpdate(
            cached,
            'complete',
            toUserHistoryError(err),
          )
          emitUpdate(created, update)
          return update
        }
      }

      if (plan.kind === 'backfill-and-delta' && cached) {
        cacheSet(key, cached)
        emitUpdate(created, toUpdate(cached, 'backfilling'))

        let current = cached
        try {
          const delta = await fetchRange(
            place,
            plan.deltaStart,
            plan.deltaEnd,
            innerSignal,
          )
          current = {
            version: 2,
            startDate: current.startDate,
            archiveEnd: plan.deltaEnd,
            complete: false,
            timezone: delta.timezone || current.timezone,
            updatedAt: getNow(),
            days: mergeDailyObservations(current.days, delta.days),
          }
          cacheSet(key, current)
          await persistentCacheSet(place, current)
          emitUpdate(created, toUpdate(current, 'backfilling'))
        } catch (err) {
          if (innerSignal.aborted || isAbortError(err)) throw err
          const update = toUpdate(
            current,
            'complete',
            toUserHistoryError(err),
          )
          emitUpdate(created, update)
          return update
        }

        if (innerSignal.aborted) throw abortError()

        try {
          const older = await fetchRange(
            place,
            plan.backfillStart,
            plan.backfillEnd,
            innerSignal,
          )
          current = {
            version: 2,
            startDate: ARCHIVE_START,
            archiveEnd: current.archiveEnd,
            complete: true,
            timezone: current.timezone || older.timezone,
            updatedAt: getNow(),
            days: mergeDailyObservations(older.days, current.days),
          }
          cacheSet(key, current)
          await persistentCacheSet(place, current)
          const update = toUpdate(current, 'complete')
          emitUpdate(created, update)
          return update
        } catch (err) {
          if (innerSignal.aborted || isAbortError(err)) throw err
          const update = toUpdate(
            current,
            'complete',
            toUserHistoryError(err),
          )
          emitUpdate(created, update)
          return update
        }
      }

      if (plan.kind === 'cold-full') {
        const fetched = await fetchRange(
          place,
          plan.start,
          plan.end,
          innerSignal,
        )
        const completeHistory: CachedDailyHistory = {
          version: 2,
          startDate: ARCHIVE_START,
          archiveEnd: plan.end,
          complete: true,
          timezone: fetched.timezone,
          updatedAt: getNow(),
          days: fetched.days,
        }
        cacheSet(key, completeHistory)
        await persistentCacheSet(place, completeHistory)
        const update = toUpdate(completeHistory, 'complete')
        emitUpdate(created, update)
        return update
      }

      if (plan.kind !== 'cold-two-phase') {
        throw new WeatherArchiveError(
          'unknown',
          'Could not load weather history',
          'Something went wrong while planning the weather archive request.',
          `Unexpected archive fetch plan: ${plan.kind}`,
        )
      }

      const phase1 = await fetchRange(
        place,
        plan.recentStart,
        plan.recentEnd,
        innerSignal,
      )
      const partial: CachedDailyHistory = {
        version: 2,
        startDate: plan.recentStart,
        archiveEnd: plan.recentEnd,
        complete: false,
        timezone: phase1.timezone,
        updatedAt: getNow(),
        days: phase1.days,
      }
      cacheSet(key, partial)
      await persistentCacheSet(place, partial)
      emitUpdate(created, toUpdate(partial, 'backfilling'))

      if (innerSignal.aborted) throw abortError()

      try {
        const phase2 = await fetchRange(
          place,
          plan.backfillStart,
          plan.backfillEnd,
          innerSignal,
        )
        const completeHistory: CachedDailyHistory = {
          version: 2,
          startDate: ARCHIVE_START,
          archiveEnd: partial.archiveEnd,
          complete: true,
          timezone: partial.timezone || phase2.timezone,
          updatedAt: getNow(),
          days: mergeDailyObservations(phase2.days, partial.days),
        }
        cacheSet(key, completeHistory)
        await persistentCacheSet(place, completeHistory)
        const update = toUpdate(completeHistory, 'complete')
        emitUpdate(created, update)
        return update
      } catch (err) {
        if (innerSignal.aborted || isAbortError(err)) throw err
        const update = toUpdate(
          partial,
          'complete',
          toUserHistoryError(err),
        )
        emitUpdate(created, update)
        return update
      }
    }

    created.promise = execute()
      .then((update) => {
        if (inflightByKey.get(key) === created) {
          inflightByKey.delete(key)
        }
        return update
      })
      .catch((err) => {
        if (inflightByKey.get(key) === created) {
          inflightByKey.delete(key)
        }
        throw err
      })

    entry = created
    created.promise.catch(() => {})
    inflightByKey.set(key, entry)
  }

  const activeEntry = entry
  activeEntry.subscribers += 1
  if (onUpdate) {
    activeEntry.listeners.add(onUpdate)
    if (activeEntry.lastUpdate) {
      onUpdate(activeEntry.lastUpdate)
    }
  }

  return new Promise<DailyHistoryUpdate>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
      if (onUpdate) {
        activeEntry.listeners.delete(onUpdate)
      }
    }

    const onAbort = () => {
      if (settled) return
      settled = true
      cleanup()
      activeEntry.subscribers -= 1
      if (activeEntry.subscribers <= 0) {
        if (inflightByKey.get(key) === activeEntry) {
          inflightByKey.delete(key)
        }
        activeEntry.controller.abort()
      }
      reject(abortError())
    }

    if (signal?.aborted) {
      onAbort()
      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    activeEntry.promise.then(
      (update) => {
        if (settled) return
        settled = true
        cleanup()
        activeEntry.subscribers -= 1
        resolve(update)
      },
      (err) => {
        if (settled) return
        settled = true
        cleanup()
        activeEntry.subscribers -= 1
        reject(err)
      },
    )
  })
}

export function isRateLimitError(e: unknown): e is WeatherArchiveError {
  return e instanceof WeatherArchiveError && e.kind === 'rate_limit'
}

export function toUserHistoryError(e: unknown): UserHistoryError {
  if (e instanceof WeatherArchiveError) {
    return { title: e.title, detail: e.detail, kind: e.kind }
  }
  const msg = (e as Error)?.message ?? ''
  if (/429|rate.?limit/i.test(msg)) {
    return {
      title: RATE_LIMIT_TITLE,
      detail: RATE_LIMIT_DETAIL,
      kind: 'rate_limit',
    }
  }
  return {
    title: 'Could not load weather history',
    detail:
      'Something went wrong while loading historical weather. Please try again in a moment.',
    kind: 'unknown',
  }
}
