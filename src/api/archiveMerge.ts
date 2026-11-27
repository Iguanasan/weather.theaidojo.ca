import type { DailyObservation } from '../domain/types'
import { addDaysIso, compareIsoDates } from '../lib/dates'

export const ARCHIVE_START_YEAR = 1940
export const ARCHIVE_START = `${ARCHIVE_START_YEAR}-01-01`
export const DELTA_OVERLAP_DAYS = 5
export const RECENT_WINDOW_YEARS = 20

const MAX_WINDOW_LENGTH = 30
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

export type CachedDailyHistory = {
  version: 2
  startDate: string
  archiveEnd: string
  complete: boolean
  timezone: string
  updatedAt: number
  days: DailyObservation[]
}

export type ArchiveFetchPlan =
  | { kind: 'cache-hit' }
  | { kind: 'delta-only'; deltaStart: string; deltaEnd: string }
  | { kind: 'backfill-only'; backfillStart: string; backfillEnd: string }
  | {
      kind: 'backfill-and-delta'
      deltaStart: string
      deltaEnd: string
      backfillStart: string
      backfillEnd: string
    }
  | {
      kind: 'cold-two-phase'
      recentStart: string
      recentEnd: string
      backfillStart: string
      backfillEnd: string
    }
  | { kind: 'cold-full'; start: string; end: string }

/** Verify YYYY-MM-DD format and real UTC calendar validity (e.g. rejects Feb 30). */
export function isValidIsoDate(value: unknown): value is string {
  if (typeof value !== 'string' || !ISO_DATE_RE.test(value)) return false
  const [y, m, d] = value.split('-').map(Number)
  const dt = new Date(Date.UTC(y!, m! - 1, d!))
  return (
    dt.getUTCFullYear() === y &&
    dt.getUTCMonth() === m! - 1 &&
    dt.getUTCDate() === d
  )
}

/**
 * Compute the start date (`YYYY-01-01`) of the recent Phase 1 window,
 * clamped so it never precedes `ARCHIVE_START` (`1940-01-01`).
 */
export function computeRecentStart(
  archiveEnd: string,
  years = RECENT_WINDOW_YEARS,
): string {
  const endYear = Number(archiveEnd.slice(0, 4))
  const clampedYears = Number.isFinite(years) ? Math.max(0, Math.floor(years)) : RECENT_WINDOW_YEARS
  const startYear = Math.max(ARCHIVE_START_YEAR, endYear - clampedYears)
  return `${startYear}-01-01`
}

function clampToArchiveStart(isoDate: string): string {
  return compareIsoDates(isoDate, ARCHIVE_START) < 0 ? ARCHIVE_START : isoDate
}

/**
 * Plan the minimal Open-Meteo archive request(s) required to satisfy `targetEnd`
 * and an optional `preferredAnchor` given the currently cached record.
 */
export function planArchiveFetch(input: {
  cached: CachedDailyHistory | null
  targetEnd: string
  preferredAnchor?: string | null
  recentYears?: number
}): ArchiveFetchPlan {
  const { cached, targetEnd, preferredAnchor, recentYears } = input

  if (cached) {
    const needsBackfill =
      !cached.complete && compareIsoDates(cached.startDate, ARCHIVE_START) > 0
    const needsDelta = compareIsoDates(cached.archiveEnd, targetEnd) < 0

    if (!needsBackfill && !needsDelta) {
      return { kind: 'cache-hit' }
    }

    const deltaStart = clampToArchiveStart(
      addDaysIso(cached.archiveEnd, -DELTA_OVERLAP_DAYS),
    )
    const backfillEnd = addDaysIso(cached.startDate, -1)

    if (!needsBackfill && needsDelta) {
      return { kind: 'delta-only', deltaStart, deltaEnd: targetEnd }
    }
    if (needsBackfill && !needsDelta) {
      return {
        kind: 'backfill-only',
        backfillStart: ARCHIVE_START,
        backfillEnd,
      }
    }
    return {
      kind: 'backfill-and-delta',
      deltaStart,
      deltaEnd: targetEnd,
      backfillStart: ARCHIVE_START,
      backfillEnd,
    }
  }

  const recentStart = computeRecentStart(targetEnd, recentYears)
  if (compareIsoDates(recentStart, ARCHIVE_START) <= 0) {
    return { kind: 'cold-full', start: ARCHIVE_START, end: targetEnd }
  }

  if (isValidIsoDate(preferredAnchor)) {
    // Include a 29-day margin so up to a 30-day focal window fits cleanly inside Phase 1.
    const neededStart = addDaysIso(preferredAnchor, -(MAX_WINDOW_LENGTH - 1))
    if (compareIsoDates(neededStart, recentStart) < 0) {
      return { kind: 'cold-full', start: ARCHIVE_START, end: targetEnd }
    }
  }

  return {
    kind: 'cold-two-phase',
    recentStart,
    recentEnd: targetEnd,
    backfillStart: ARCHIVE_START,
    backfillEnd: addDaysIso(recentStart, -1),
  }
}

/**
 * Merge two daily observation arrays by ISO date, letting `incoming` overwrite
 * `existing` on overlapping dates (picking up ERA5 revisions) and returning
 * a chronologically sorted array.
 */
export function mergeDailyObservations(
  existing: DailyObservation[],
  incoming: DailyObservation[],
): DailyObservation[] {
  const byDate = new Map<string, DailyObservation>()
  for (const obs of existing) {
    byDate.set(obs.date, obs)
  }
  for (const obs of incoming) {
    byDate.set(obs.date, obs)
  }
  const merged = Array.from(byDate.values())
  merged.sort((a, b) => compareIsoDates(a.date, b.date))
  return merged
}

function isNullableFiniteNumber(value: unknown): value is number | null {
  return value === null || (typeof value === 'number' && Number.isFinite(value))
}

/** Runtime validator for persisted v2 cache payloads. */
export function isValidCachedHistory(
  value: unknown,
): value is CachedDailyHistory {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  if (record.version !== 2) return false
  if (!isValidIsoDate(record.startDate) || !isValidIsoDate(record.archiveEnd)) {
    return false
  }
  if (compareIsoDates(record.startDate, record.archiveEnd) > 0) return false
  if (typeof record.complete !== 'boolean') return false
  if (typeof record.timezone !== 'string' || record.timezone.length === 0) {
    return false
  }
  if (typeof record.updatedAt !== 'number' || !Number.isFinite(record.updatedAt)) {
    return false
  }
  if (!Array.isArray(record.days) || record.days.length === 0) return false

  for (const day of record.days) {
    if (typeof day !== 'object' || day === null) return false
    const obs = day as Record<string, unknown>
    if (
      !isValidIsoDate(obs.date) ||
      !isNullableFiniteNumber(obs.tMax) ||
      !isNullableFiniteNumber(obs.tMin) ||
      !isNullableFiniteNumber(obs.precip)
    ) {
      return false
    }
  }
  return true
}
