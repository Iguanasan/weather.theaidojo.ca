import assert from 'node:assert/strict'
import type { DailyObservation } from '../domain/types'
import {
  ARCHIVE_START,
  computeRecentStart,
  isValidCachedHistory,
  mergeDailyObservations,
  planArchiveFetch,
  type CachedDailyHistory,
} from './archiveMerge'

function makeCached(
  overrides: Partial<CachedDailyHistory> = {},
): CachedDailyHistory {
  return {
    version: 2,
    startDate: ARCHIVE_START,
    archiveEnd: '2026-11-20',
    complete: true,
    timezone: 'America/Toronto',
    updatedAt: 1_700_000_000_000,
    days: [
      { date: '2026-11-19', tMax: 8, tMin: 2, precip: 0 },
      { date: '2026-11-20', tMax: 9, tMin: 1, precip: 1.2 },
    ],
    ...overrides,
  }
}

// 1. computeRecentStart
assert.equal(computeRecentStart('2026-11-26'), '2006-01-01')
assert.equal(computeRecentStart('2026-11-26', 10), '2016-01-01')
assert.equal(computeRecentStart('1955-06-01', 20), ARCHIVE_START)
assert.equal(computeRecentStart('1940-05-01', 20), ARCHIVE_START)

// 2. planArchiveFetch — all 6 branches
// 2a. cache-hit
assert.deepEqual(
  planArchiveFetch({
    cached: makeCached({ archiveEnd: '2026-11-26', complete: true }),
    targetEnd: '2026-11-26',
  }),
  { kind: 'cache-hit' },
)

// 2b. delta-only with 5-day overlap
assert.deepEqual(
  planArchiveFetch({
    cached: makeCached({ archiveEnd: '2026-11-20', complete: true }),
    targetEnd: '2026-11-26',
  }),
  {
    kind: 'delta-only',
    deltaStart: '2026-11-15',
    deltaEnd: '2026-11-26',
  },
)

// delta-only clamps deltaStart to ARCHIVE_START when archiveEnd is near 1940-01-01
assert.deepEqual(
  planArchiveFetch({
    cached: makeCached({ archiveEnd: '1940-01-03', complete: true }),
    targetEnd: '1940-01-10',
  }),
  {
    kind: 'delta-only',
    deltaStart: '1940-01-01',
    deltaEnd: '1940-01-10',
  },
)

// 2c. backfill-only (partial cache already up to targetEnd)
assert.deepEqual(
  planArchiveFetch({
    cached: makeCached({
      startDate: '2006-01-01',
      archiveEnd: '2026-11-26',
      complete: false,
    }),
    targetEnd: '2026-11-26',
  }),
  {
    kind: 'backfill-only',
    backfillStart: ARCHIVE_START,
    backfillEnd: '2005-12-31',
  },
)

// 2d. backfill-and-delta (partial cache and stale tail)
assert.deepEqual(
  planArchiveFetch({
    cached: makeCached({
      startDate: '2006-01-01',
      archiveEnd: '2026-11-20',
      complete: false,
    }),
    targetEnd: '2026-11-26',
  }),
  {
    kind: 'backfill-and-delta',
    deltaStart: '2026-11-15',
    deltaEnd: '2026-11-26',
    backfillStart: ARCHIVE_START,
    backfillEnd: '2005-12-31',
  },
)

// 2e. cold-two-phase (no cache, live mode or in-window anchor)
assert.deepEqual(
  planArchiveFetch({
    cached: null,
    targetEnd: '2026-11-26',
    preferredAnchor: null,
  }),
  {
    kind: 'cold-two-phase',
    recentStart: '2006-01-01',
    recentEnd: '2026-11-26',
    backfillStart: ARCHIVE_START,
    backfillEnd: '2005-12-31',
  },
)

assert.deepEqual(
  planArchiveFetch({
    cached: null,
    targetEnd: '2026-11-26',
    preferredAnchor: '2006-01-30', // 30-day window starts 2006-01-01 -> fits inside Phase 1
  }),
  {
    kind: 'cold-two-phase',
    recentStart: '2006-01-01',
    recentEnd: '2026-11-26',
    backfillStart: ARCHIVE_START,
    backfillEnd: '2005-12-31',
  },
)

// 2f. cold-full when preferredAnchor is older than recentStart or within 30 days of recentStart
assert.deepEqual(
  planArchiveFetch({
    cached: null,
    targetEnd: '2026-11-26',
    preferredAnchor: '1978-07-12',
  }),
  {
    kind: 'cold-full',
    start: ARCHIVE_START,
    end: '2026-11-26',
  },
)

assert.deepEqual(
  planArchiveFetch({
    cached: null,
    targetEnd: '2026-11-26',
    preferredAnchor: '2006-01-15', // 30-day window needs 2005-12-17 < 2006-01-01
  }),
  {
    kind: 'cold-full',
    start: ARCHIVE_START,
    end: '2026-11-26',
  },
)

assert.deepEqual(
  planArchiveFetch({
    cached: null,
    targetEnd: '1950-05-01',
  }),
  {
    kind: 'cold-full',
    start: ARCHIVE_START,
    end: '1950-05-01',
  },
)

// 3. mergeDailyObservations
{
  const existing: DailyObservation[] = [
    { date: '2026-11-20', tMax: 9, tMin: 1, precip: 0 },
    { date: '2026-11-18', tMax: 11, tMin: 3, precip: 2 },
    { date: '2026-11-19', tMax: 10, tMin: 2, precip: 0.5 },
  ]
  const incoming: DailyObservation[] = [
    { date: '2026-11-22', tMax: 6, tMin: -1, precip: 0 },
    { date: '2026-11-20', tMax: 9.4, tMin: 1.5, precip: 0.4 }, // revised ERA5 day
    { date: '2026-11-21', tMax: 7, tMin: 0, precip: 3.1 },
  ]
  const merged = mergeDailyObservations(existing, incoming)
  assert.deepEqual(merged, [
    { date: '2026-11-18', tMax: 11, tMin: 3, precip: 2 },
    { date: '2026-11-19', tMax: 10, tMin: 2, precip: 0.5 },
    { date: '2026-11-20', tMax: 9.4, tMin: 1.5, precip: 0.4 },
    { date: '2026-11-21', tMax: 7, tMin: 0, precip: 3.1 },
    { date: '2026-11-22', tMax: 6, tMin: -1, precip: 0 },
  ])

  assert.deepEqual(mergeDailyObservations([], []), [])
  assert.deepEqual(mergeDailyObservations(existing, []).map((d) => d.date), [
    '2026-11-18',
    '2026-11-19',
    '2026-11-20',
  ])
}

// 4. isValidCachedHistory
assert.equal(isValidCachedHistory(makeCached()), true)
assert.equal(
  isValidCachedHistory(
    makeCached({
      days: [{ date: '2026-11-20', tMax: null, tMin: null, precip: null }],
    }),
  ),
  true,
)

for (const bad of [
  null,
  'bad',
  { ...makeCached(), version: 1 },
  { ...makeCached(), startDate: '2024-02-30' },
  { ...makeCached(), archiveEnd: 'not-a-date' },
  { ...makeCached(), startDate: '2026-11-25', archiveEnd: '2026-11-20' },
  { ...makeCached(), complete: 'true' },
  { ...makeCached(), timezone: '' },
  { ...makeCached(), updatedAt: Number.NaN },
  { ...makeCached(), days: [] },
  {
    ...makeCached(),
    days: [{ date: '2026-11-19', tMax: Number.NaN, tMin: 1, precip: 0 }],
  },
  {
    ...makeCached(),
    days: [{ date: '2026-11-19', tMax: 5, tMin: 1 }],
  },
]) {
  assert.equal(isValidCachedHistory(bad), false)
}

console.log('archiveMerge tests passed')
