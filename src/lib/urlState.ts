import type { AppQuery, Place, WindowLength } from '../domain/types'

const MAX_LABEL_LEN = 120
const MAX_ID_LEN = 64
const MIN_ANCHOR_DATE = '1940-01-01'
const COUNTRY_CODE_RE = /^[A-Za-z]{2}$/
const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/

function parseLength(v: string | null): WindowLength {
  if (v === '1') return 1
  if (v === '30') return 30
  return 7
}

function parseBoundedCoord(
  raw: string | null,
  min: number,
  max: number,
): number | null {
  if (raw === null) return null
  const trimmed = raw.trim()
  if (!trimmed) return null
  const n = Number(trimmed)
  if (!Number.isFinite(n) || n < min || n > max) return null
  return n === 0 ? 0 : n
}

function capString(raw: string | null, maxLen: number): string | undefined {
  if (raw === null) return undefined
  const trimmed = raw.trim()
  if (!trimmed) return undefined
  const capped = trimmed.slice(0, maxLen).trim()
  return capped || undefined
}

function isValidAnchorDate(raw: string | null): raw is string {
  if (!raw || !ISO_DATE_RE.test(raw) || raw < MIN_ANCHOR_DATE) return false
  const [yStr, mStr, dStr] = raw.split('-')
  const year = Number(yStr)
  const month = Number(mStr)
  const day = Number(dStr)
  if (month < 1 || month > 12 || day < 1 || day > 31) return false
  const dt = new Date(Date.UTC(year, month - 1, day))
  return (
    dt.getUTCFullYear() === year &&
    dt.getUTCMonth() === month - 1 &&
    dt.getUTCDate() === day
  )
}

function round2(v: number): number {
  const r = Math.round(v * 100) / 100
  return r === 0 ? 0 : r
}

export function parseQueryParams(search: string): Partial<AppQuery> & {
  placeHint?: Place
} {
  const params = new URLSearchParams(search)
  const lat = parseBoundedCoord(params.get('lat'), -90, 90)
  const lon = parseBoundedCoord(params.get('lon'), -180, 180)
  const name = capString(params.get('name'), MAX_LABEL_LEN)
  const country = capString(params.get('country'), MAX_LABEL_LEN)
  const rawCc = params.get('cc')?.trim() ?? ''
  const countryCode = COUNTRY_CODE_RE.test(rawCc) ? rawCc : undefined
  const admin1 = capString(params.get('admin1'), MAX_LABEL_LEN)

  let placeHint: Place | undefined
  if (lat !== null && lon !== null && name && country && countryCode) {
    const id = capString(params.get('id'), MAX_ID_LEN) ?? `${lat},${lon}`
    placeHint = {
      id,
      name,
      ...(admin1 ? { admin1 } : {}),
      country,
      countryCode,
      latitude: lat,
      longitude: lon,
    }
  }

  const anchor = params.get('anchor')
  return {
    placeHint,
    length: parseLength(params.get('L')),
    anchorDate: isValidAnchorDate(anchor) ? anchor : null,
  }
}

export function buildQueryParams(query: AppQuery): URLSearchParams {
  const params = new URLSearchParams()
  if (query.place) {
    const isGeo = query.place.id.startsWith('geo:')
    const lat = isGeo ? round2(query.place.latitude) : query.place.latitude
    const lon = isGeo ? round2(query.place.longitude) : query.place.longitude
    const id = isGeo ? `geo:${lat.toFixed(2)},${lon.toFixed(2)}` : query.place.id

    params.set('id', id)
    params.set('name', query.place.name)
    params.set('country', query.place.country)
    params.set('cc', query.place.countryCode)
    if (query.place.admin1) params.set('admin1', query.place.admin1)
    params.set('lat', String(lat))
    params.set('lon', String(lon))
  }
  params.set('L', String(query.length))
  if (query.anchorDate) params.set('anchor', query.anchorDate)
  return params
}

export function readQueryFromUrl(): Partial<AppQuery> & {
  placeHint?: Place
} {
  return parseQueryParams(window.location.search)
}

export function writeQueryToUrl(query: AppQuery, replace = true): void {
  const qs = buildQueryParams(query).toString()
  const url = qs ? `${window.location.pathname}?${qs}` : window.location.pathname
  if (replace) {
    window.history.replaceState(null, '', url)
  } else {
    window.history.pushState(null, '', url)
  }
}

export function shareableUrl(query: AppQuery): string {
  const qs = buildQueryParams(query).toString()
  return `${window.location.origin}${window.location.pathname}?${qs}`
}
