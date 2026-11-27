import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ARCHIVE_START,
  OPEN_METEO_TERMS_URL,
  loadDailyHistory,
  toUserHistoryError,
  type HistoryLoadPhase,
  type UserHistoryError,
} from './api/archive'
import { detectCurrentPlace, formatPlaceLabel } from './api/geocode'
import { AboutDialog } from './components/AboutDialog'
import { AnalogList } from './components/AnalogList'
import { LoadingWeather } from './components/LoadingWeather'
import { PlaceSearch } from './components/PlaceSearch'
import { ThemeToggle } from './components/ThemeToggle'
import { WeatherBackground } from './components/WeatherBackground'

const OverlayCharts = lazy(() =>
  import('./components/OverlayCharts').then((m) => ({
    default: m.OverlayCharts,
  })),
)
import { findAnalogEpisodes, seriesStats } from './domain/analogSearch'
import { classifyAtmosphere, getAtmosphereMeta } from './domain/atmosphere'
import type {
  AnalogEpisode,
  AppQuery,
  DailyObservation,
  Place,
  WindowLength,
} from './domain/types'
import { formatPrecip, formatTemp, unitsForPlace } from './domain/units'
import {
  buildFocalFromHistory,
  compareIsoDates,
  formatEpisodeRange,
  formatNiceDate,
  minAnchorForLength,
  stepPeriodAnchor,
  windowLabel,
} from './lib/dates'
import { readQueryFromUrl, shareableUrl, writeQueryToUrl } from './lib/urlState'

const LENGTHS: WindowLength[] = [1, 7, 30]
const TOP_N = 24

type AnalogSort = 'date' | 'match'

export default function App() {
  const initial = useMemo(() => readQueryFromUrl(), [])
  const hadPlaceInUrl = Boolean(initial.placeHint)
  const [place, setPlace] = useState<Place | null>(initial.placeHint ?? null)
  const [length, setLength] = useState<WindowLength>(initial.length ?? 7)
  const [anchorDate, setAnchorDate] = useState<string | null>(initial.anchorDate ?? null)
  const [liveMode, setLiveMode] = useState(!initial.anchorDate)

  const [days, setDays] = useState<DailyObservation[] | null>(null)
  const [archiveEnd, setArchiveEnd] = useState<string | null>(null)
  const [latestCompleteDate, setLatestCompleteDate] = useState<string | null>(null)
  const [coverageStart, setCoverageStart] = useState<string | null>(null)
  /** Progressive history loading phase for the selected place. */
  const [historyPhase, setHistoryPhase] = useState<HistoryLoadPhase | null>(null)
  const [historyError, setHistoryError] = useState<UserHistoryError | null>(null)
  const [backgroundError, setBackgroundError] = useState<UserHistoryError | null>(null)
  /** Bump to retry archive load for the same place after an error. */
  const [historyReloadKey, setHistoryReloadKey] = useState(0)
  const [locating, setLocating] = useState(!hadPlaceInUrl)
  const [locationHint, setLocationHint] = useState<string | null>(null)

  const [analogs, setAnalogs] = useState<AnalogEpisode[]>([])
  const [analogSort, setAnalogSort] = useState<AnalogSort>('date')
  const [selected, setSelected] = useState<AnalogEpisode | null>(null)
  const [copied, setCopied] = useState(false)
  const [aboutOpen, setAboutOpen] = useState(false)

  const abortRef = useRef<AbortController | null>(null)
  const locateAbortRef = useRef<AbortController | null>(null)
  const loadedPlaceKeyRef = useRef<string | null>(null)
  const hasDaysRef = useRef(false)
  const liveModeRef = useRef(liveMode)
  const anchorDateRef = useRef(anchorDate)
  hasDaysRef.current = Boolean(days)
  liveModeRef.current = liveMode
  anchorDateRef.current = anchorDate

  const latestAnchor = latestCompleteDate ?? archiveEnd
  const effectiveAnchor = liveMode ? latestAnchor : anchorDate
  const units = unitsForPlace(place)

  const query: AppQuery = useMemo(
    () => ({
      place,
      length,
      anchorDate: liveMode ? null : anchorDate,
    }),
    [place, length, liveMode, anchorDate],
  )

  useEffect(() => {
    writeQueryToUrl(query, true)
  }, [query])

  const locateUser = useCallback(async (onlyIfEmpty = false) => {
    locateAbortRef.current?.abort()
    const ac = new AbortController()
    locateAbortRef.current = ac
    setLocating(true)
    setLocationHint(null)
    try {
      const p = await detectCurrentPlace({ signal: ac.signal })
      if (ac.signal.aborted) return
      setPlace((current) => {
        if (onlyIfEmpty && current) return current
        return p
      })
    } catch (e) {
      if (ac.signal.aborted || (e as Error).name === 'AbortError') return
      setLocationHint(
        (e as Error).message ||
          'Could not detect location — search for a place instead.',
      )
    } finally {
      if (locateAbortRef.current === ac) {
        locateAbortRef.current = null
      }
      if (!ac.signal.aborted) {
        setLocating(false)
      }
    }
  }, [])

  // Default to the user's current location when the URL has no place.
  useEffect(() => {
    if (hadPlaceInUrl) return
    locateAbortRef.current?.abort()
    const ac = new AbortController()
    locateAbortRef.current = ac
    setLocating(true)
    setLocationHint(null)
    detectCurrentPlace({ signal: ac.signal })
      .then((p) => {
        if (ac.signal.aborted) return
        setPlace((current) => current ?? p)
      })
      .catch((e) => {
        if (ac.signal.aborted || (e as Error).name === 'AbortError') return
        setLocationHint(
          (e as Error).message ||
            'Could not detect location — search for a place instead.',
        )
      })
      .finally(() => {
        if (locateAbortRef.current === ac) {
          locateAbortRef.current = null
        }
        if (!ac.signal.aborted) setLocating(false)
      })
    return () => {
      ac.abort()
    }
  }, [hadPlaceInUrl])

  // Load history progressively per place; analog matching runs as data arrives.
  useEffect(() => {
    if (!place) {
      loadedPlaceKeyRef.current = null
      setDays(null)
      setArchiveEnd(null)
      setLatestCompleteDate(null)
      setCoverageStart(null)
      setAnalogs([])
      setSelected(null)
      setHistoryPhase(null)
      setHistoryError(null)
      setBackgroundError(null)
      return
    }

    const formatCoordKey = (v: number) =>
      (Math.abs(v) < 0.005 ? 0 : v).toFixed(2)
    const nextPlaceKey = `${formatCoordKey(place.latitude)},${formatCoordKey(place.longitude)}`
    const isNewPlace = loadedPlaceKeyRef.current !== nextPlaceKey
    loadedPlaceKeyRef.current = nextPlaceKey

    abortRef.current?.abort()
    const ac = new AbortController()
    abortRef.current = ac
    setHistoryError(null)
    setBackgroundError(null)
    if (isNewPlace) {
      setHistoryPhase('loading')
      setDays(null)
      setArchiveEnd(null)
      setLatestCompleteDate(null)
      setCoverageStart(null)
      setAnalogs([])
      setSelected(null)
    } else if (!hasDaysRef.current) {
      setHistoryPhase('loading')
    }

    ;(async () => {
      try {
        await loadDailyHistory(place, {
          signal: ac.signal,
          preferredAnchor: liveModeRef.current ? null : anchorDateRef.current,
          onUpdate: (update) => {
            if (ac.signal.aborted) return
            setDays(update.days)
            setArchiveEnd(update.archiveEnd)
            setLatestCompleteDate(update.latestCompleteDate)
            setCoverageStart(update.coverageStart)
            setHistoryPhase(update.phase)
            setBackgroundError(update.backgroundError ?? null)
            if (liveModeRef.current || !anchorDateRef.current) {
              setAnchorDate(update.latestCompleteDate)
            }
          },
        })
      } catch (e) {
        if (
          ac.signal.aborted ||
          ((e instanceof DOMException || e instanceof Error) &&
            e.name === 'AbortError')
        ) {
          return
        }
        setHistoryError(toUserHistoryError(e))
        setHistoryPhase(null)
      }
    })()

    return () => ac.abort()
  }, [place, historyReloadKey])

  const focal = useMemo(() => {
    if (!days || !effectiveAnchor) return null
    return buildFocalFromHistory(days, effectiveAnchor, length)
  }, [days, effectiveAnchor, length])

  const atmosphere = useMemo(() => {
    if (!focal) return 'fair'
    return classifyAtmosphere(focal.series)
  }, [focal])

  useEffect(() => {
    document.documentElement.setAttribute('data-atmosphere', atmosphere)
  }, [atmosphere])

  // Run analog matching once whenever (days, effectiveAnchor, length) settles.
  useEffect(() => {
    if (!days || !focal) {
      setAnalogs([])
      setSelected(null)
      return
    }
    const results = findAnalogEpisodes(days, focal.series, {
      length,
      focalStart: focal.start,
      focalEnd: focal.end,
      topN: TOP_N,
    })
    setAnalogs(results)
  }, [days, focal, length])

  const sortedAnalogs = useMemo(() => {
    if (analogSort === 'date') return analogs
    return [...analogs].sort((a, b) => {
      if (b.matchStrength !== a.matchStrength) {
        return b.matchStrength - a.matchStrength
      }
      return a.endDate < b.endDate ? 1 : a.endDate > b.endDate ? -1 : 0
    })
  }, [analogs, analogSort])

  useEffect(() => {
    if (sortedAnalogs.length === 0) {
      setSelected(null)
      return
    }
    setSelected((cur) => {
      if (
        cur &&
        sortedAnalogs.some(
          (ep) => ep.year === cur.year && ep.startDate === cur.startDate,
        )
      ) {
        return cur
      }
      return sortedAnalogs[0] ?? null
    })
  }, [sortedAnalogs])

  const onSelectPlace = useCallback((p: Place) => {
    locateAbortRef.current?.abort()
    locateAbortRef.current = null
    setLocating(false)
    setLocationHint(null)
    setPlace(p)
  }, [])

  const minAnchor = minAnchorForLength(length)
  const canStepPrev =
    Boolean(place && effectiveAnchor) &&
    compareIsoDates(stepPeriodAnchor(effectiveAnchor!, length, -1), minAnchor) >= 0
  const canStepNext =
    Boolean(place && effectiveAnchor && latestAnchor) &&
    compareIsoDates(effectiveAnchor!, latestAnchor!) < 0

  function stepPeriod(direction: -1 | 1) {
    if (!effectiveAnchor) return
    let next = stepPeriodAnchor(effectiveAnchor, length, direction)
    if (compareIsoDates(next, minAnchor) < 0) next = minAnchor
    if (latestAnchor && compareIsoDates(next, latestAnchor) > 0) next = latestAnchor
    setLiveMode(false)
    setAnchorDate(next)
  }

  const focalStats = focal ? seriesStats(focal.series) : null

  async function copyShareLink() {
    const url = shareableUrl(query)
    try {
      await navigator.clipboard.writeText(url)
      setCopied(true)
      window.setTimeout(() => setCopied(false), 1800)
    } catch {
      window.prompt('Copy this link:', url)
    }
  }

  return (
    <div className="app">
      <WeatherBackground atmosphere={atmosphere} />
      <header className="hero">
        <div className="brand">
          <h1>When did it feel like?</h1>
          <p className="tagline">
            Find past spells with temperature and rain like this day, week, or month.
          </p>
        </div>
        <div className="hero-actions">
          <button
            type="button"
            className="secondary-btn about-btn"
            onClick={() => setAboutOpen(true)}
          >
            About
          </button>
          <ThemeToggle />
          <button
            type="button"
            className={`icon-btn share-btn${copied ? ' copied' : ''}`}
            disabled={!place}
            onClick={copyShareLink}
            aria-label={copied ? 'Link copied' : 'Share link'}
            title={copied ? 'Link copied' : 'Copy share link'}
          >
            {copied ? (
              <svg
                className="icon"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                aria-hidden="true"
              >
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  d="M5 13l4 4L19 7"
                />
              </svg>
            ) : (
              <svg
                className="icon"
                viewBox="0 0 24 24"
                width="20"
                height="20"
                aria-hidden="true"
              >
                <circle cx="18" cy="5" r="2.5" fill="currentColor" />
                <circle cx="6" cy="12" r="2.5" fill="currentColor" />
                <circle cx="18" cy="19" r="2.5" fill="currentColor" />
                <path
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2"
                  strokeLinecap="round"
                  d="M8.4 10.8l7.2-4.6M8.4 13.2l7.2 4.6"
                />
              </svg>
            )}
          </button>
        </div>
      </header>

      <section className="controls panel">
        <PlaceSearch
          selected={place}
          onSelect={onSelectPlace}
          locating={locating}
          onUseMyLocation={() => locateUser(false)}
        />
        {locationHint && place && (
          <p className="error-text location-hint">{locationHint}</p>
        )}

        <div className="control-grid">
          <div>
            <span className="field-label">Window</span>
            <div className="segmented" role="group" aria-label="Comparison window">
              {LENGTHS.map((L) => (
                <button
                  key={L}
                  type="button"
                  className={length === L ? 'active' : ''}
                  onClick={() => setLength(L)}
                >
                  {windowLabel(L)}
                </button>
              ))}
            </div>
          </div>

          <div>
            <span className="field-label">Mode</span>
            <div className="segmented" role="group" aria-label="Anchor mode">
              <button
                type="button"
                className={liveMode ? 'active' : ''}
                onClick={() => {
                  setLiveMode(true)
                  if (latestAnchor) setAnchorDate(latestAnchor)
                }}
              >
                Live
              </button>
              <button
                type="button"
                className={!liveMode ? 'active' : ''}
                onClick={() => setLiveMode(false)}
              >
                Explorer
              </button>
            </div>
          </div>

          <div className="anchor-field">
            <label className="field-label" htmlFor="anchor-date">
              {length === 1 ? 'Selected Day' : 'Period Ending'}
            </label>
            <div className="period-nav">
              <button
                type="button"
                className="icon-btn period-step"
                disabled={!canStepPrev}
                onClick={() => stepPeriod(-1)}
                aria-label={
                  length === 1 ? 'Previous day' : 'Previous period'
                }
                title={length === 1 ? 'Previous day' : 'Previous period'}
              >
                <svg
                  className="icon"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M15 6l-6 6 6 6"
                  />
                </svg>
              </button>
              <input
                id="anchor-date"
                type="date"
                value={effectiveAnchor ?? ''}
                max={latestAnchor ?? undefined}
                min={minAnchor}
                disabled={!place}
                onChange={(e) => {
                  setLiveMode(false)
                  setAnchorDate(e.target.value || null)
                }}
              />
              <button
                type="button"
                className="icon-btn period-step"
                disabled={!canStepNext}
                onClick={() => stepPeriod(1)}
                aria-label={length === 1 ? 'Next day' : 'Next period'}
                title={length === 1 ? 'Next day' : 'Next period'}
              >
                <svg
                  className="icon"
                  viewBox="0 0 24 24"
                  width="18"
                  height="18"
                  aria-hidden="true"
                >
                  <path
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2.2"
                    strokeLinecap="round"
                    strokeLinejoin="round"
                    d="M9 6l6 6-6 6"
                  />
                </svg>
              </button>
            </div>
          </div>
        </div>
      </section>

      {!place && (
        <section className="panel empty-state">
          {locating ? (
            <LoadingWeather stage="locating" variant="banner" />
          ) : (
            <p>
              Search for a place to see which past spells look most like recent
              weather there.
              {locationHint ? (
                <>
                  {' '}
                  <span className="error-text">{locationHint}</span>
                </>
              ) : null}
            </p>
          )}
        </section>
      )}

      {place && (
        <>
          {!days && historyPhase === 'loading' && !historyError && (
            <LoadingWeather
              stage="history"
              variant="banner"
              progress={0.15}
              detail="Collecting recent weather from the open archive… this can take a moment."
              placeLabel={formatPlaceLabel(place)}
            />
          )}

          {days && historyPhase === 'backfilling' && !historyError && (
            <LoadingWeather
              stage="history"
              variant="banner"
              title="Expanding historical archive…"
              progress={0.55}
              detail={`Showing ${formatNiceDate(
                coverageStart ?? days[0]?.date ?? ARCHIVE_START,
              )}–${formatNiceDate(
                archiveEnd ?? days[days.length - 1]!.date,
              )} · loading earlier archive back to 1940…`}
              placeLabel={formatPlaceLabel(place)}
            />
          )}

          {days && backgroundError && !historyError && (
            <section
              className={`panel background-error-banner${
                backgroundError.kind === 'rate_limit'
                  ? ' background-error-banner--rate'
                  : ''
              }`}
              role="status"
            >
              <div className="background-error-copy">
                <strong>{backgroundError.title}</strong>
                <p className="muted">
                  Showing {formatNiceDate(coverageStart ?? days[0]?.date ?? ARCHIVE_START)}–
                  {formatNiceDate(archiveEnd ?? days[days.length - 1]!.date)}.{' '}
                  {backgroundError.detail}
                </p>
              </div>
              <div className="background-error-actions">
                <button
                  type="button"
                  className="secondary-btn background-error-btn"
                  onClick={() => {
                    setBackgroundError(null)
                    setHistoryReloadKey((k) => k + 1)
                  }}
                >
                  Try again
                </button>
                <button
                  type="button"
                  className="secondary-btn background-error-btn"
                  onClick={() => setBackgroundError(null)}
                >
                  Dismiss
                </button>
              </div>
            </section>
          )}

          {historyError && (
            <section
              className={`panel history-error-panel${
                historyError.kind === 'rate_limit' ? ' history-error-panel--rate' : ''
              }`}
              role="alert"
            >
              <h2 className="history-error-title">{historyError.title}</h2>
              <p className="history-error-detail">{historyError.detail}</p>
              {historyError.kind === 'rate_limit' && (
                <>
                  <p className="muted history-error-hint">
                    Tip: waiting a couple of minutes usually works. We only ask
                    the free archive once per place and remember the result
                    afterward.
                  </p>
                  <p className="muted history-error-terms">
                    Open-Meteo free-tier terms (fair-use limits):{' '}
                    <a
                      href={OPEN_METEO_TERMS_URL}
                      target="_blank"
                      rel="noreferrer"
                    >
                      open-meteo.com/en/terms
                    </a>
                  </p>
                </>
              )}
              <button
                type="button"
                className="secondary-btn history-error-retry"
                onClick={() => {
                  setHistoryError(null)
                  setHistoryReloadKey((k) => k + 1)
                }}
              >
                Try again
              </button>
            </section>
          )}

          <section className="panel status-bar">
            <div className="status-place">
              <strong>{formatPlaceLabel(place)}</strong>
              {archiveEnd && (
                <span className="muted status-archive">
                  {' '}
                  - (
                  {formatNiceDate(coverageStart ?? days?.[0]?.date ?? ARCHIVE_START)}
                  {' to '}
                  {formatNiceDate(archiveEnd)}
                  ) - All available data from{' '}
                  <a
                    href="https://open-meteo.com/"
                    target="_blank"
                    rel="noreferrer"
                  >
                    Open-Meteo
                  </a>
                  .
                </span>
              )}
              {!days && historyPhase === 'loading' && !historyError && (
                <span className="muted">
                  {' '}
                  Loading the historical record…
                </span>
              )}
              {days && historyPhase === 'refreshing' && !historyError && (
                <span className="muted status-sync">
                  {' '}
                  Checking for latest days…
                </span>
              )}
            </div>
          </section>

          {focal && focalStats && (
            <section className="panel focal-panel">
              <div className="focal-header">
                <div className="focal-title-row">
                  <h2>{windowLabel(length)}</h2>
                  <span
                    className="atmosphere-badge"
                    data-atmosphere-type={atmosphere}
                    title={`Atmosphere mood: ${getAtmosphereMeta(atmosphere).label}`}
                  >
                    <span className="atmosphere-icon" aria-hidden="true">
                      {getAtmosphereMeta(atmosphere).icon}
                    </span>
                    <span>{getAtmosphereMeta(atmosphere).label}</span>
                  </span>
                </div>
                <span className="muted">
                  {formatEpisodeRange(focal.start, focal.end)}
                </span>
              </div>
              <p className="muted section-help focal-help">
                Matched on daily highs, overnight lows, and rain — so hot days
                and nights that don&apos;t cool off compare like for like.
              </p>
              <div className="stat-row">
                <div className="stat">
                  <span className="stat-label">Avg high</span>
                  <span className="stat-value">
                    {formatTemp(focalStats.avgHigh, units, 1)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Avg low</span>
                  <span className="stat-value">
                    {formatTemp(focalStats.avgLow, units, 1)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Total precip</span>
                  <span className="stat-value">
                    {formatPrecip(focalStats.totalPrecip, units, 1)}
                  </span>
                </div>
                <div className="stat">
                  <span className="stat-label">Similar spells</span>
                  <span className="stat-value">{analogs.length}</span>
                </div>
              </div>
            </section>
          )}

          {focal && (
            <section className="results-layout">
              <div className="panel">
                <div className="panel-heading">
                  <h2 className="section-title">When it felt like this</h2>
                  <div className="sort-toggle">
                    <span className="field-label sort-toggle-label" id="sort-label">
                      Sort
                    </span>
                    <div
                      className="segmented sort-segmented"
                      role="group"
                      aria-labelledby="sort-label"
                    >
                      <button
                        type="button"
                        className={analogSort === 'date' ? 'active' : ''}
                        onClick={() => setAnalogSort('date')}
                        aria-pressed={analogSort === 'date'}
                      >
                        Date
                      </button>
                      <button
                        type="button"
                        className={analogSort === 'match' ? 'active' : ''}
                        onClick={() => setAnalogSort('match')}
                        aria-pressed={analogSort === 'match'}
                      >
                        Match
                      </button>
                    </div>
                  </div>
                </div>
                <p className="muted section-help">
                  {analogSort === 'date'
                    ? 'Most recent first'
                    : 'Strongest match first'}{' '}
                  · one spell per year · only if close enough (score ≥ 50). +/−
                  is warmer/cooler or wetter/drier than this spell.
                </p>
                <AnalogList
                  analogs={sortedAnalogs}
                  focal={focal.series}
                  selectedYear={selected?.year ?? null}
                  onSelect={setSelected}
                  units={units}
                />
              </div>
              <div className="panel">
                <h2 className="section-title">
                  {selected
                    ? `This spell vs ${selected.year}`
                    : 'Overlay'}
                </h2>
                {selected && (
                  <p className="muted section-help">
                    {formatEpisodeRange(selected.startDate, selected.endDate)} ·
                    close {selected.matchStrength.toFixed(0)}
                  </p>
                )}
                <Suspense fallback={<p className="muted">Loading charts…</p>}>
                  <OverlayCharts
                    focal={focal.series}
                    analog={selected}
                    units={units}
                  />
                </Suspense>
              </div>
            </section>
          )}

          {place &&
            !focal &&
            !historyError &&
            days &&
            (historyPhase === 'backfilling' || historyPhase === 'refreshing') && (
              <section className="panel">
                <p className="muted">Loading older historical records…</p>
              </section>
            )}

          {place &&
            historyPhase !== 'loading' &&
            historyPhase !== 'backfilling' &&
            historyPhase !== 'refreshing' &&
            !focal &&
            !historyError &&
            days && (
            <section className="panel">
              <p className="error-text">
                Not enough complete daily data for this window ending on the selected date. Try a later anchor or a shorter window.
              </p>
            </section>
          )}
        </>
      )}

      <AboutDialog open={aboutOpen} onClose={() => setAboutOpen(false)} />
    </div>
  )
}
