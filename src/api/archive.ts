import type { DailyObservation, Place } from '../domain/types'

type ArchiveResponse = {
  daily?: {
    time: string[]
    temperature_2m_max?: (number | null)[]
    temperature_2m_min?: (number | null)[]
    precipitation_sum?: (number | null)[]
  }
  timezone?: string
}

export const ARCHIVE_START_YEAR = 1940
export const ARCHIVE_START = `${ARCHIVE_START_YEAR}-01-01`

/**
 * Open-Meteo free / open-access guidance (terms + pricing):
 * - Non-commercial use
 * - Fair-use limits (IP-based): 600/min, 5_000/hour, 10_000/day
 * - Attribution under CC BY 4.0
 * - Prefer fewer, larger requests; cache; avoid hammering after 429
 *
 * We make at most one archive call per place (full history), share in-flight
 * work across remounts, cache complete results, and back off on 429.
 */

/** In-memory cache of complete histories. */
const HISTORY_CACHE_MAX = 8
const historyCache = new Map<
  string,
  { days: DailyObservation[]; endDate: string; timezone: string }
>()

/** Persistent browser Cache API layer (survives reloads, bounded to 12 places). */
const PERSISTENT_CACHE_NAME = 'analog-weather-archive-v1'
const PERSISTENT_CACHE_MAX = 12

/** Dedupe concurrent loads (React Strict Mode, rapid re-select). */
type InflightEntry = {
  promise: Promise<DailyHistory>
  controller: AbortController
  subscribers: number
}

const inflightByKey = new Map<string, InflightEntry>()

export type DailyHistory = {
  /** Complete daily observations loaded, chronological (oldest → newest). */
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

function yesterdayUtc(): string {
  const d = new Date()
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}

function cacheKey(place: Place, endDate: string): string {
  const lat = place.latitude.toFixed(2)
  const lon = place.longitude.toFixed(2)
  return `${lat},${lon}|${endDate}`
}

function cacheGet(key: string) {
  const hit = historyCache.get(key)
  if (!hit) return null
  historyCache.delete(key)
  historyCache.set(key, hit)
  return hit
}

function cacheSet(
  key: string,
  value: { days: DailyObservation[]; endDate: string; timezone: string },
) {
  if (historyCache.has(key)) historyCache.delete(key)
  historyCache.set(key, value)
  while (historyCache.size > HISTORY_CACHE_MAX) {
    const oldest = historyCache.keys().next().value
    if (oldest === undefined) break
    historyCache.delete(oldest)
  }
}

function persistentCacheUrl(place: Place, archiveEnd: string): string {
  const lat = place.latitude.toFixed(2)
  const lon = place.longitude.toFixed(2)
  return `https://cache.local/archive/${lat},${lon}/${archiveEnd}`
}

function extractArchiveEnd(url: string): string | null {
  try {
    const { pathname } = new URL(url)
    const match = /^\/archive\/[^/]+\/(\d{4}-\d{2}-\d{2})$/.exec(pathname)
    return match ? match[1]! : null
  } catch {
    return null
  }
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

function isValidDailyHistory(
  value: unknown,
  expectedArchiveEnd: string,
): value is DailyHistory {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.archiveEnd !== expectedArchiveEnd) return false
  if (typeof record.timezone !== 'string' || record.timezone.length === 0) {
    return false
  }
  if (!Array.isArray(record.days) || record.days.length === 0) return false
  for (const day of record.days) {
    if (typeof day !== 'object' || day === null) return false
    const obs = day as Record<string, unknown>
    if (
      typeof obs.date !== 'string' ||
      !isNullableFiniteNumber(obs.tMax) ||
      !isNullableFiniteNumber(obs.tMin) ||
      !isNullableFiniteNumber(obs.precip)
    ) {
      return false
    }
  }
  return true
}

async function openPersistentCache(): Promise<Cache | null> {
  if (typeof caches === 'undefined') return null
  try {
    return await caches.open(PERSISTENT_CACHE_NAME)
  } catch {
    return null
  }
}

async function persistentCacheGet(
  place: Place,
  archiveEnd: string,
): Promise<DailyHistory | null> {
  const cache = await openPersistentCache()
  if (!cache) return null
  try {
    const url = persistentCacheUrl(place, archiveEnd)
    const res = await cache.match(url)
    if (!res || !res.ok) return null
    const parsed: unknown = await res.json()
    if (!isValidDailyHistory(parsed, archiveEnd)) {
      await cache.delete(url).catch(() => {})
      return null
    }
    return parsed
  } catch {
    return null
  }
}

async function persistentCacheSet(
  place: Place,
  history: DailyHistory,
): Promise<void> {
  const cache = await openPersistentCache()
  if (!cache) return
  try {
    const url = persistentCacheUrl(place, history.archiveEnd)
    await cache.delete(url)
    await cache.put(
      url,
      new Response(JSON.stringify(history), {
        headers: { 'Content-Type': 'application/json' },
      }),
    )

    const keys = await cache.keys()
    const kept: Request[] = []
    for (const req of keys) {
      const entryEnd = extractArchiveEnd(req.url)
      if (entryEnd && entryEnd < history.archiveEnd) {
        await cache.delete(req)
      } else {
        kept.push(req)
      }
    }

    let excess = kept.length - PERSISTENT_CACHE_MAX
    for (const req of kept) {
      if (excess <= 0) break
      if (req.url === url) continue
      await cache.delete(req)
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

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('Aborted', 'AbortError'))
      return
    }
    const t = globalThis.setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      globalThis.clearTimeout(t)
      reject(new DOMException('Aborted', 'AbortError'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * One full-history request (1940 → yesterday). Most polite pattern for
 * Open-Meteo free tier: minimize call count, cache, don't burst.
 */
async function fetchFullHistory(
  place: Place,
  archiveEnd: string,
  signal?: AbortSignal,
): Promise<{ days: DailyObservation[]; timezone: string }> {
  const url = new URL('https://archive-api.open-meteo.com/v1/archive')
  url.searchParams.set('latitude', String(place.latitude))
  url.searchParams.set('longitude', String(place.longitude))
  url.searchParams.set('start_date', ARCHIVE_START)
  url.searchParams.set('end_date', archiveEnd)
  url.searchParams.set(
    'daily',
    'temperature_2m_max,temperature_2m_min,precipitation_sum',
  )
  url.searchParams.set('timezone', 'auto')

  // At most one gentle retry after a long pause — never a rapid retry storm
  const maxAttempts = 2

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (signal?.aborted) {
      throw new DOMException('Aborted', 'AbortError')
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
      // Wait well beyond a short burst window before one polite retry
      const retryAfter = Number(res.headers.get('Retry-After'))
      const waitMs =
        Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.max(retryAfter * 1000, 15_000)
          : 20_000
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

/**
 * Load full history for a place. Shared per place so remounts do not
 * double-call Open-Meteo, while aborting the shared fetch if all active
 * subscribers abort.
 */
export function fetchDailyHistory(
  place: Place,
  signal?: AbortSignal,
): Promise<DailyHistory> {
  if (signal?.aborted) {
    return Promise.reject(new DOMException('Aborted', 'AbortError'))
  }

  const archiveEnd = yesterdayUtc()
  const key = cacheKey(place, archiveEnd)
  const cached = cacheGet(key)
  if (cached) {
    return Promise.resolve({
      days: cached.days,
      archiveEnd: cached.endDate,
      timezone: cached.timezone,
    })
  }

  let entry = inflightByKey.get(key)
  if (!entry) {
    const controller = new AbortController()
    const created: InflightEntry = {
      promise: null as unknown as Promise<DailyHistory>,
      controller,
      subscribers: 0,
    }
    created.promise = (async (): Promise<DailyHistory> => {
      const persisted = await persistentCacheGet(place, archiveEnd)
      if (persisted) {
        cacheSet(key, {
          days: persisted.days,
          endDate: persisted.archiveEnd,
          timezone: persisted.timezone,
        })
        return persisted
      }
      const { days, timezone } = await fetchFullHistory(
        place,
        archiveEnd,
        controller.signal,
      )
      const history: DailyHistory = { days, archiveEnd, timezone }
      cacheSet(key, { days, endDate: archiveEnd, timezone })
      await persistentCacheSet(place, history)
      return history
    })()
      .then((history) => {
        if (inflightByKey.get(key) === created) {
          inflightByKey.delete(key)
        }
        return history
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

  return new Promise<DailyHistory>((resolve, reject) => {
    let settled = false

    const cleanup = () => {
      signal?.removeEventListener('abort', onAbort)
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
      reject(new DOMException('Aborted', 'AbortError'))
    }

    if (signal?.aborted) {
      onAbort()
      return
    }

    signal?.addEventListener('abort', onAbort, { once: true })

    activeEntry.promise.then(
      (history) => {
        if (settled) return
        settled = true
        cleanup()
        activeEntry.subscribers -= 1
        resolve(history)
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

export function toUserHistoryError(e: unknown): {
  title: string
  detail: string
  kind: WeatherArchiveError['kind'] | 'unknown'
} {
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
