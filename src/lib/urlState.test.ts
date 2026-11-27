import assert from 'node:assert/strict'
import type { AppQuery, Place } from '../domain/types'
import { buildQueryParams, parseQueryParams } from './urlState'

function makeSearch(overrides: Record<string, string | null>): string {
  const base: Record<string, string> = {
    id: '6167865',
    name: 'Toronto',
    admin1: 'Ontario',
    country: 'Canada',
    cc: 'CA',
    lat: '43.70011',
    lon: '-79.4163',
    L: '7',
    anchor: '2024-07-15',
  }
  const params = new URLSearchParams()
  for (const [k, v] of Object.entries({ ...base, ...overrides })) {
    if (v !== null) params.set(k, v)
  }
  return `?${params.toString()}`
}

// 1. Valid round-trips
{
  const place: Place = {
    id: '6167865',
    name: 'Toronto',
    admin1: 'Ontario',
    country: 'Canada',
    countryCode: 'CA',
    latitude: 43.70011,
    longitude: -79.4163,
  }
  const query: AppQuery = {
    place,
    length: 30,
    anchorDate: '2024-02-29',
  }
  const qs = buildQueryParams(query).toString()
  const parsed = parseQueryParams(`?${qs}`)
  assert.deepEqual(parsed.placeHint, place)
  assert.equal(parsed.length, 30)
  assert.equal(parsed.anchorDate, '2024-02-29')
}

{
  // Boundary coordinates & min anchor date & L=1 without admin1
  const place: Place = {
    id: 'p1',
    name: 'Equatorial Pole',
    country: 'Nowhere',
    countryCode: 'aq',
    latitude: -90,
    longitude: 180,
  }
  const qs = buildQueryParams({
    place,
    length: 1,
    anchorDate: '1940-01-01',
  }).toString()
  const parsed = parseQueryParams(`?${qs}`)
  assert.deepEqual(parsed.placeHint, place)
  assert.equal(parsed.length, 1)
  assert.equal(parsed.anchorDate, '1940-01-01')
}

// 2. Out-of-range lat/lon
for (const badLat of ['-90.0001', '90.0001', '-91', '91']) {
  const parsed = parseQueryParams(makeSearch({ lat: badLat }))
  assert.equal(parsed.placeHint, undefined, `expected lat=${badLat} rejected`)
}
for (const badLon of ['-180.0001', '180.0001', '-181', '181']) {
  const parsed = parseQueryParams(makeSearch({ lon: badLon }))
  assert.equal(parsed.placeHint, undefined, `expected lon=${badLon} rejected`)
}

// 3. NaN / Infinity / whitespace / non-numeric lat/lon
for (const badCoord of ['NaN', 'Infinity', '-Infinity', '   ', '', 'abc']) {
  assert.equal(
    parseQueryParams(makeSearch({ lat: badCoord })).placeHint,
    undefined,
    `expected lat=${JSON.stringify(badCoord)} rejected`,
  )
  assert.equal(
    parseQueryParams(makeSearch({ lon: badCoord })).placeHint,
    undefined,
    `expected lon=${JSON.stringify(badCoord)} rejected`,
  )
}

// 4. Invalid / impossible / pre-1940 dates
for (const badDate of [
  '2024-02-30',
  '2023-02-29',
  '2024-04-31',
  '2024-13-01',
  '2024-00-10',
  '2024-01-00',
  '1939-12-31',
  '1900-06-15',
  '2024-2-5',
  'not-a-date',
  '',
]) {
  const parsed = parseQueryParams(makeSearch({ anchor: badDate }))
  assert.equal(
    parsed.anchorDate,
    null,
    `expected anchor=${JSON.stringify(badDate)} rejected`,
  )
}

// 5. Overly long strings & whitespace-only strings
{
  const longText = 'A'.repeat(200)
  const longId = 'X'.repeat(120)
  const parsed = parseQueryParams(
    makeSearch({
      name: `  ${longText}  `,
      country: longText,
      admin1: longText,
      id: longId,
    }),
  )
  assert.ok(parsed.placeHint)
  assert.equal(parsed.placeHint.name.length, 120)
  assert.equal(parsed.placeHint.country.length, 120)
  assert.equal(parsed.placeHint.admin1?.length, 120)
  assert.equal(parsed.placeHint.id.length, 64)
}

{
  assert.equal(
    parseQueryParams(makeSearch({ name: '   ' })).placeHint,
    undefined,
  )
  assert.equal(
    parseQueryParams(makeSearch({ country: '   ' })).placeHint,
    undefined,
  )
  const parsedBlankOptional = parseQueryParams(
    makeSearch({ admin1: '   ', id: '   ' }),
  )
  assert.ok(parsedBlankOptional.placeHint)
  assert.equal(parsedBlankOptional.placeHint.admin1, undefined)
  assert.equal(parsedBlankOptional.placeHint.id, '43.70011,-79.4163')
}

// 6. Invalid country codes
for (const badCc of ['USA', 'C', '12', 'C1', '1A', 'C$', '', '   ']) {
  const parsed = parseQueryParams(makeSearch({ cc: badCc }))
  assert.equal(
    parsed.placeHint,
    undefined,
    `expected cc=${JSON.stringify(badCc)} rejected`,
  )
}

// 7. 2-decimal geo: rounding on serialization
{
  const geoPlace: Place = {
    id: 'geo:43.653226,-79.383184',
    name: 'Toronto',
    admin1: 'Ontario',
    country: 'Canada',
    countryCode: 'CA',
    latitude: 43.653226,
    longitude: -79.383184,
  }
  const params = buildQueryParams({
    place: geoPlace,
    length: 7,
    anchorDate: null,
  })
  assert.equal(params.get('id'), 'geo:43.65,-79.38')
  assert.equal(params.get('lat'), '43.65')
  assert.equal(params.get('lon'), '-79.38')

  const parsed = parseQueryParams(`?${params.toString()}`)
  assert.equal(parsed.placeHint?.id, 'geo:43.65,-79.38')
  assert.equal(parsed.placeHint?.latitude, 43.65)
  assert.equal(parsed.placeHint?.longitude, -79.38)
}

{
  // Near-zero negative coordinates do not serialize as -0
  const nearZeroGeo: Place = {
    id: 'geo:-0.001,0.001',
    name: 'Gulf of Guinea',
    country: 'Unknown',
    countryCode: 'XX',
    latitude: -0.001,
    longitude: 0.001,
  }
  const params = buildQueryParams({
    place: nearZeroGeo,
    length: 7,
    anchorDate: null,
  })
  assert.equal(params.get('id'), 'geo:0.00,0.00')
  assert.equal(params.get('lat'), '0')
  assert.equal(params.get('lon'), '0')
}

console.log('urlState.test.ts: all assertions passed')
