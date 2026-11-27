import assert from 'node:assert/strict'
import {
  extractSeries,
  findAnalogEpisodes,
  findBestAnalogInYear,
  matchStrengthFromDistance,
  seriesDeltas,
  seriesStats,
} from './analogSearch'
import type { DailyObservation } from './types'

function day(date: string, t: number, p: number): DailyObservation {
  return { date, tMax: t + 2, tMin: t - 2, precip: p }
}

function yearDays(year: number, baseTemp: number, basePrecip: number): DailyObservation[] {
  const out: DailyObservation[] = []
  // 10 days in January-ish
  for (let d = 1; d <= 10; d++) {
    const dd = String(d).padStart(2, '0')
    out.push(day(`${year}-01-${dd}`, baseTemp + d * 0.1, basePrecip))
  }
  // 10 days in July-ish
  for (let d = 1; d <= 10; d++) {
    const dd = String(d).padStart(2, '0')
    out.push(day(`${year}-07-${dd}`, baseTemp + 15 + d * 0.1, basePrecip + 2))
  }
  return out
}

// Focal: warm week like July pattern (base 20 → July ~35)
const focalDays = yearDays(2020, 20, 5).filter((d) => d.date.startsWith('2020-07')).slice(0, 7)
const focal = {
  dates: focalDays.map((d) => d.date),
  tMax: focalDays.map((d) => d.tMax!),
  tMin: focalDays.map((d) => d.tMin!),
  precip: focalDays.map((d) => d.precip!),
}

const historyWithFocal = [
  ...yearDays(2010, 5, 0), // cold — should fail cutoff
  ...yearDays(2011, 20, 5), // exact warm match
  ...yearDays(2012, 6, 0.5), // cold — fail
  ...yearDays(2015, 20, 5), // exact warm match (newer than 2011)
  ...yearDays(2018, 20.5, 5.5), // warm match, slightly warmer/wetter
  ...yearDays(2020, 20, 5), // focal year
]

const results = findAnalogEpisodes(historyWithFocal, focal, {
  length: 7,
  focalStart: '2020-07-01',
  focalEnd: '2020-07-07',
  topN: 10,
})

assert.ok(results.length >= 2, `should find several analogs, got ${results.length}`)
assert.equal(
  results[0]!.year,
  2018,
  `expected most recent (2018) first, got ${results[0]?.year}`,
)
assert.ok(
  results.every((r, i) => i === 0 || results[i - 1]!.endDate >= r.endDate),
  'should be sorted newest-first by endDate',
)
assert.ok(
  !results.some((r) => r.year === 2010 || r.year === 2012),
  'cold years should fail similarity cutoff',
)
assert.ok(
  results.every((r) => r.matchStrength >= 50),
  'all results should meet default min match strength',
)
assert.ok(
  !results.some((r) => r.startDate >= '2020-07-01' && r.endDate <= '2020-07-07'),
  'should not include overlapping focal window as self',
)
assert.ok(matchStrengthFromDistance(0) > matchStrengthFromDistance(2), 'closer = higher match')

const y2015 = results.find((r) => r.year === 2015)!
assert.equal(y2015.distance, 0, 'exact pattern match should have zero distance')
assert.equal(y2015.matchStrength, 100, 'exact pattern match should have 100 strength')
assert.equal(y2015.startDate, '2015-07-01', 'exact match should pick the July 1-7 window')
assert.equal(y2015.endDate, '2015-07-07')

// Signed deltas: 2018 is slightly warmer base → positive high/low delta vs focal
const y2018 = results.find((r) => r.year === 2018)!
const deltas = seriesDeltas(y2018.series, focal)
assert.ok(deltas.highDelta > 0, '2018 should be slightly warmer (positive high delta)')

const stats = seriesStats(focal)
assert.ok(stats.avgHigh > stats.avgLow && stats.totalPrecip > 0, 'seriesStats computes high/low/precip')

const strict = findAnalogEpisodes(historyWithFocal, focal, {
  length: 7,
  focalStart: '2020-07-01',
  focalEnd: '2020-07-07',
  minMatchStrength: 99.5,
})
assert.ok(strict.length <= results.length, 'stricter cutoff returns fewer or equal')
assert.ok(
  strict.every((r) => r.year === 2011 || r.year === 2015),
  'strict cutoff keeps only exact matches',
)

const limited = findAnalogEpisodes(historyWithFocal, focal, {
  length: 7,
  focalStart: '2020-07-01',
  focalEnd: '2020-07-07',
  topN: 1,
})
assert.equal(limited.length, 1, 'topN should cap returned episodes')
assert.equal(limited[0]!.year, 2018, 'topN: 1 returns newest qualifying year')

// Tie behavior in findBestAnalogInYear: earlier equal-distance window wins
const tiedFocal = extractSeries([day('2020-06-01', 20, 0)], 0, 1)!
const tiedYear = [
  day('2019-06-01', 20, 0),
  day('2019-06-02', 20, 0),
]
const tiedWinner = findBestAnalogInYear(2019, tiedYear, tiedFocal, {
  length: 1,
  focalStart: '2020-06-01',
  focalEnd: '2020-06-01',
})
assert.equal(tiedWinner?.startDate, '2019-06-01', 'tie keeps earliest window in year')

// Missing values: skip windows with null fields, still match valid later window
const missingYear: DailyObservation[] = [
  { date: '2017-07-01', tMax: 37, tMin: 33, precip: null },
  ...yearDays(2017, 20, 5).filter((d) => d.date >= '2017-07-02'),
]
const missingMatch = findBestAnalogInYear(2017, missingYear, focal, {
  length: 7,
  focalStart: '2020-07-01',
  focalEnd: '2020-07-07',
})
assert.equal(
  missingMatch?.startDate,
  '2017-07-02',
  'null observation invalidates overlapping window without hiding valid later window',
)

const allMissing = [
  { date: '2016-07-01', tMax: null, tMin: 10, precip: 0 },
  { date: '2016-07-02', tMax: 20, tMin: null, precip: 0 },
]
assert.equal(
  findBestAnalogInYear(2016, allMissing, tiedFocal, {
    length: 1,
    focalStart: '2020-06-01',
    focalEnd: '2020-06-01',
  }),
  null,
  'year with only null windows returns null',
)

// Edge cases: short history / focal length mismatch
assert.equal(
  findBestAnalogInYear(2019, [day('2019-07-01', 20, 5)], focal, {
    length: 7,
    focalStart: '2020-07-01',
    focalEnd: '2020-07-07',
  }),
  null,
  'fewer days than window length returns null',
)
assert.deepEqual(
  findAnalogEpisodes([day('2019-07-01', 20, 5)], focal, {
    length: 1,
    focalStart: '2020-07-01',
    focalEnd: '2020-07-07',
  }),
  [],
  'mismatched focal length returns empty array',
)

console.log('analogSearch tests passed', {
  top: results.slice(0, 5).map((r) => ({
    year: r.year,
    dates: `${r.startDate}..${r.endDate}`,
    m: r.matchStrength,
  })),
  delta2018: deltas,
})