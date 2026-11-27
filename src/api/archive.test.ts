import assert from 'node:assert/strict'
import type { Place } from '../domain/types'
import {
  ARCHIVE_START,
  configureArchiveForTest,
  loadDailyHistory,
  resetArchiveForTest,
  type CachedDailyHistory,
  type DailyHistoryUpdate,
} from './archive'

class MockCache {
  private readonly store = new Map<
    string,
    { body: string; headers: Array<[string, string]> }
  >()
  readonly jsonReadUrls: string[] = []

  async match(request: RequestInfo | URL): Promise<Response | undefined> {
    const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
    const stored = this.store.get(key)
    if (!stored) return undefined
    const res = new Response(stored.body, {
      status: 200,
      headers: stored.headers,
    })
    const origJson = res.json.bind(res)
    res.json = () => {
      this.jsonReadUrls.push(key)
      return origJson()
    }
    return res
  }

  async put(request: RequestInfo | URL, response: Response): Promise<void> {
    const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
    const body = await response.text()
    const headers: Array<[string, string]> = []
    response.headers.forEach((value, name) => {
      headers.push([name, value])
    })
    if (!response.headers.has('content-type')) {
      headers.push(['content-type', 'application/json'])
    }
    this.store.set(key, { body, headers })
  }

  async delete(request: RequestInfo | URL): Promise<boolean> {
    const key = typeof request === 'string' ? request : request instanceof URL ? request.toString() : request.url
    return this.store.delete(key)
  }

  async keys(): Promise<readonly Request[]> {
    return Array.from(this.store.keys()).map((url) => new Request(url))
  }
}

class MockCacheStorage {
  readonly cachesByName = new Map<string, MockCache>()

  async open(name: string): Promise<Cache> {
    let cache = this.cachesByName.get(name)
    if (!cache) {
      cache = new MockCache()
      this.cachesByName.set(name, cache)
    }
    return cache as unknown as Cache
  }

  async delete(name: string): Promise<boolean> {
    return this.cachesByName.delete(name)
  }

  async has(name: string): Promise<boolean> {
    return this.cachesByName.has(name)
  }

  async keys(): Promise<string[]> {
    return Array.from(this.cachesByName.keys())
  }

  async match(): Promise<Response | undefined> {
    return undefined
  }
}

function makePlace(id: string, lat: number, lon: number): Place {
  return {
    id,
    name: `City ${id}`,
    country: 'Canada',
    countryCode: 'CA',
    latitude: lat,
    longitude: lon,
    timezone: 'America/Toronto',
  }
}

function archiveJson(
  dates: string[],
  tMaxOffset = 0,
  timezone = 'America/Toronto',
): Response {
  return new Response(
    JSON.stringify({
      timezone,
      daily: {
        time: dates,
        temperature_2m_max: dates.map((_, i) => 10 + i + tMaxOffset),
        temperature_2m_min: dates.map((_, i) => 2 + i),
        precipitation_sum: dates.map(() => 0.5),
      },
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  )
}

const originalFetch = globalThis.fetch
const originalCaches = globalThis.caches

async function runTests() {
  try {
    // 1. Same-day cache-hit (0 fetch calls) + lazy v1 cleanup
    {
      resetArchiveForTest()
      let nowMs = 1_700_000_000_000
      configureArchiveForTest({
        now: () => nowMs,
        yesterdayUtc: () => '2026-11-25',
      })
      const storage = new MockCacheStorage()
      await storage.open('analog-weather-archive-v1')
      const v2 = await storage.open('analog-weather-archive-v2')
      const cached: CachedDailyHistory = {
        version: 2,
        startDate: ARCHIVE_START,
        archiveEnd: '2026-11-25',
        complete: true,
        timezone: 'America/Toronto',
        updatedAt: nowMs - 1000,
        days: [
          { date: ARCHIVE_START, tMax: -5, tMin: -12, precip: 0 },
          { date: '2026-11-25', tMax: 6, tMin: 1, precip: 2 },
        ],
      }
      await v2.put(
        'https://cache.local/archive/43.65,-79.38',
        new Response(JSON.stringify(cached)),
      )

      let fetchCalls = 0
      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async () => {
        fetchCalls += 1
        throw new Error('fetch should not be called on cache hit')
      }) as typeof fetch

      const updates: DailyHistoryUpdate[] = []
      const result = await loadDailyHistory(makePlace('tor', 43.653, -79.383), {
        onUpdate: (u) => updates.push(u),
      })

      assert.equal(fetchCalls, 0)
      assert.equal(await storage.has('analog-weather-archive-v1'), false)
      assert.equal(updates.length, 1)
      assert.equal(updates[0]!.phase, 'complete')
      assert.equal(result.isComplete, true)
      assert.equal(result.days.length, 2)
    }

    // 2. Stale-while-revalidate delta-only (emits cached immediately, fetches overlap + tail, merges ERA5 revision)
    {
      resetArchiveForTest()
      const nowMs = 1_700_000_100_000
      configureArchiveForTest({
        now: () => nowMs,
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      const v2 = await storage.open('analog-weather-archive-v2')
      const cached: CachedDailyHistory = {
        version: 2,
        startDate: ARCHIVE_START,
        archiveEnd: '2026-11-23',
        complete: true,
        timezone: 'America/Toronto',
        updatedAt: nowMs - 86_400_000,
        days: [
          { date: ARCHIVE_START, tMax: -4, tMin: -10, precip: 0 },
          { date: '2026-11-22', tMax: 5, tMin: 0, precip: 0 },
          { date: '2026-11-23', tMax: 7, tMin: 1, precip: 1 },
        ],
      }
      await v2.put(
        'https://cache.local/archive/43.65,-79.38',
        new Response(JSON.stringify(cached)),
      )

      const requestedRanges: Array<{ start: string; end: string }> = []
      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = new URL(input.toString())
        requestedRanges.push({
          start: u.searchParams.get('start_date')!,
          end: u.searchParams.get('end_date')!,
        })
        return archiveJson(
          ['2026-11-22', '2026-11-23', '2026-11-24', '2026-11-25', '2026-11-26'],
          10, // revised 2026-11-22 tMax=20, 2026-11-23 tMax=21
        )
      }) as typeof fetch

      const updates: DailyHistoryUpdate[] = []
      const result = await loadDailyHistory(makePlace('tor', 43.65, -79.38), {
        onUpdate: (u) => updates.push(u),
      })

      assert.deepEqual(requestedRanges, [
        { start: '2026-11-18', end: '2026-11-26' },
      ])
      assert.equal(updates.length, 2)
      assert.equal(updates[0]!.phase, 'refreshing')
      assert.equal(updates[0]!.archiveEnd, '2026-11-23')
      assert.equal(updates[1]!.phase, 'complete')
      assert.equal(result.archiveEnd, '2026-11-26')
      assert.equal(result.days.find((d) => d.date === '2026-11-23')?.tMax, 21)

      const persistedRes = await v2.match('https://cache.local/archive/43.65,-79.38')
      const persisted = (await persistedRes!.json()) as CachedDailyHistory
      assert.equal(persisted.archiveEnd, '2026-11-26')
      assert.equal(persisted.complete, true)
    }

    // 3. cold-two-phase (Phase 1 recent -> 'backfilling' + partial persist -> Phase 2 -> 'complete')
    {
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      const requestedRanges: Array<{ start: string; end: string }> = []
      let seenPartialDuringPhase2 = false

      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = new URL(input.toString())
        const start = u.searchParams.get('start_date')!
        const end = u.searchParams.get('end_date')!
        requestedRanges.push({ start, end })
        if (start === '2006-01-01') {
          return archiveJson(['2006-01-01', '2026-11-26'])
        }
        const v2 = await storage.open('analog-weather-archive-v2')
        const partialRes = await v2.match('https://cache.local/archive/45.50,-73.57')
        if (partialRes) {
          const parsed = (await partialRes.json()) as CachedDailyHistory
          seenPartialDuringPhase2 =
            parsed.complete === false && parsed.startDate === '2006-01-01'
        }
        return archiveJson(['1940-01-01', '2005-12-31'])
      }) as typeof fetch

      const updates: DailyHistoryUpdate[] = []
      const result = await loadDailyHistory(makePlace('mtl', 45.5, -73.57), {
        onUpdate: (u) => updates.push(u),
      })

      assert.deepEqual(requestedRanges, [
        { start: '2006-01-01', end: '2026-11-26' },
        { start: '1940-01-01', end: '2005-12-31' },
      ])
      assert.equal(seenPartialDuringPhase2, true)
      assert.equal(updates.length, 2)
      assert.equal(updates[0]!.phase, 'backfilling')
      assert.equal(updates[0]!.isComplete, false)
      assert.equal(updates[0]!.coverageStart, '2006-01-01')
      assert.equal(updates[1]!.phase, 'complete')
      assert.equal(result.isComplete, true)
      assert.equal(result.coverageStart, ARCHIVE_START)
      assert.deepEqual(
        result.days.map((d) => d.date),
        ['1940-01-01', '2005-12-31', '2006-01-01', '2026-11-26'],
      )
    }

    // 4. cold-full when preferredAnchor precedes recent window
    {
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      const requestedRanges: Array<{ start: string; end: string }> = []
      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async (input: RequestInfo | URL) => {
        const u = new URL(input.toString())
        requestedRanges.push({
          start: u.searchParams.get('start_date')!,
          end: u.searchParams.get('end_date')!,
        })
        return archiveJson(['1940-01-01', '1978-07-12', '2026-11-26'])
      }) as typeof fetch

      const result = await loadDailyHistory(makePlace('van', 49.28, -123.12), {
        preferredAnchor: '1978-07-12',
      })

      assert.deepEqual(requestedRanges, [
        { start: '1940-01-01', end: '2026-11-26' },
      ])
      assert.equal(result.isComplete, true)
      assert.equal(result.coverageStart, ARCHIVE_START)
    }

    // 5. Non-fatal Phase 2 429 error & non-fatal delta network error
    {
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
        minRetryDelayMs: 5,
        defaultRetryDelayMs: 5,
      })
      const storage = new MockCacheStorage()
      globalThis.caches = storage as unknown as CacheStorage

      let calls = 0
      globalThis.fetch = (async () => {
        calls += 1
        if (calls === 1) {
          return archiveJson(['2006-01-01', '2026-11-26'])
        }
        return new Response('rate limited', { status: 429 })
      }) as typeof fetch

      const updates: DailyHistoryUpdate[] = []
      const res1 = await loadDailyHistory(makePlace('cal', 51.04, -114.07), {
        onUpdate: (u) => updates.push(u),
      })
      assert.equal(calls, 3) // Phase 1 + Phase 2 initial + 1 polite retry
      assert.equal(res1.isComplete, false)
      assert.equal(res1.phase, 'complete')
      assert.equal(res1.backgroundError?.kind, 'rate_limit')
      assert.equal(res1.days.length, 2)

      // Now test non-fatal delta network error on cached complete place
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
      })
      const v2 = await storage.open('analog-weather-archive-v2')
      const cached: CachedDailyHistory = {
        version: 2,
        startDate: ARCHIVE_START,
        archiveEnd: '2026-11-24',
        complete: true,
        timezone: 'America/Toronto',
        updatedAt: 1_700_000_000_000,
        days: [{ date: '2026-11-24', tMax: 4, tMin: -1, precip: 0 }],
      }
      await v2.put(
        'https://cache.local/archive/45.42,-75.70',
        new Response(JSON.stringify(cached)),
      )
      globalThis.fetch = (async () => {
        throw new Error('offline')
      }) as typeof fetch

      const deltaUpdates: DailyHistoryUpdate[] = []
      const res2 = await loadDailyHistory(makePlace('ott', 45.42, -75.7), {
        onUpdate: (u) => deltaUpdates.push(u),
      })
      assert.equal(deltaUpdates[0]!.phase, 'refreshing')
      assert.equal(res2.phase, 'complete')
      assert.equal(res2.archiveEnd, '2026-11-24')
      assert.equal(res2.backgroundError?.kind, 'unknown')
    }

    // 6. Abort during 429 sleep() and abort between Phase 1 & Phase 2 + listener replay
    {
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
        minRetryDelayMs: 60_000,
        defaultRetryDelayMs: 60_000,
      })
      const storage = new MockCacheStorage()
      globalThis.caches = storage as unknown as CacheStorage

      const ac = new AbortController()
      globalThis.fetch = (async () => {
        setTimeout(() => ac.abort(), 10)
        return new Response('rate limited', { status: 429 })
      }) as typeof fetch

      await assert.rejects(
        () =>
          loadDailyHistory(makePlace('hal', 44.65, -63.57), {
            signal: ac.signal,
          }),
        (err: unknown) => err instanceof Error && err.name === 'AbortError',
      )

      // Abort between Phase 1 & Phase 2 + verify Phase 1 cache preserved and listener replay works
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
      })
      const ac1 = new AbortController()
      const ac2 = new AbortController()
      let resolvePhase2Start!: () => void
      const phase2Started = new Promise<void>((r) => {
        resolvePhase2Start = r
      })

      let phase = 0
      globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
        phase += 1
        if (phase === 1) {
          return archiveJson(['2006-01-01', '2026-11-26'])
        }
        resolvePhase2Start()
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener(
            'abort',
            () => reject(new DOMException('Aborted', 'AbortError')),
            { once: true },
          )
        })
      }) as typeof fetch

      const sub1Updates: DailyHistoryUpdate[] = []
      const p1 = loadDailyHistory(makePlace('wpg', 49.9, -97.14), {
        signal: ac1.signal,
        onUpdate: (u) => sub1Updates.push(u),
      })

      await phase2Started

      // Attach second subscriber mid-flight; it must replay Phase 1 immediately
      const sub2Updates: DailyHistoryUpdate[] = []
      const p2 = loadDailyHistory(makePlace('wpg', 49.9, -97.14), {
        signal: ac2.signal,
        onUpdate: (u) => sub2Updates.push(u),
      })
      assert.equal(sub1Updates.length, 1)
      assert.equal(sub2Updates.length, 1)
      assert.equal(sub2Updates[0]!.phase, 'backfilling')

      // Aborting only sub1 must NOT abort the shared fetch
      ac1.abort()
      await assert.rejects(
        () => p1,
        (err: unknown) => err instanceof Error && err.name === 'AbortError',
      )

      // Aborting the final subscriber (sub2) aborts the shared fetch
      ac2.abort()
      await assert.rejects(
        () => p2,
        (err: unknown) => err instanceof Error && err.name === 'AbortError',
      )

      // Verify Phase 1 partial cache remained persisted
      const v2 = await storage.open('analog-weather-archive-v2')
      const partialRes = await v2.match('https://cache.local/archive/49.90,-97.14')
      assert.ok(partialRes)
      const partial = (await partialRes.json()) as CachedDailyHistory
      assert.equal(partial.complete, false)
      assert.equal(partial.startDate, '2006-01-01')
    }

    // 7. LRU eviction deletes the oldest updatedAt entry when exceeding 12 places
    {
      resetArchiveForTest()
      let clock = 10_000
      configureArchiveForTest({
        now: () => {
          clock += 100
          return clock
        },
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      const v2 = await storage.open('analog-weather-archive-v2')
      // Seed 12 entries with explicit updatedAt timestamps; place 0 is oldest (1000), place 1 is 2000...
      for (let i = 0; i < 12; i++) {
        const lat = (10 + i).toFixed(2)
        const entry: CachedDailyHistory = {
          version: 2,
          startDate: ARCHIVE_START,
          archiveEnd: '2026-11-26',
          complete: true,
          timezone: 'UTC',
          updatedAt: (i + 1) * 1000,
          days: [{ date: '2026-11-26', tMax: 10, tMin: 2, precip: 0 }],
        }
        await v2.put(
          `https://cache.local/archive/${lat},0.00`,
          new Response(JSON.stringify(entry)),
        )
      }

      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async () =>
        archiveJson(['1940-01-01', '2026-11-26'])) as typeof fetch

      await loadDailyHistory(makePlace('extra', 55, 0), {
        preferredAnchor: '1970-01-01',
      })

      const remainingKeys = (await v2.keys()).map((r) => r.url)
      assert.equal(remainingKeys.length, 12)
      assert.equal(
        remainingKeys.includes('https://cache.local/archive/10.00,0.00'),
        false,
        'oldest updatedAt entry should be evicted',
      )
      assert.equal(
        remainingKeys.includes('https://cache.local/archive/55.00,0.00'),
        true,
      )
    }

    // 8. latestCompleteDate handles trailing ERA5 null days while keeping archiveEnd as targetEnd
    {
      resetArchiveForTest()
      configureArchiveForTest({
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async () =>
        new Response(
          JSON.stringify({
            timezone: 'America/Toronto',
            daily: {
              time: ['1940-01-01', '2026-11-24', '2026-11-25', '2026-11-26'],
              temperature_2m_max: [-2, 8, null, null],
              temperature_2m_min: [-9, 1, null, null],
              precipitation_sum: [0, 0.2, 0, null],
            },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        )) as typeof fetch

      const result = await loadDailyHistory(makePlace('ott-lag', 45.42, -75.7), {
        preferredAnchor: '1970-01-01',
      })
      assert.equal(result.archiveEnd, '2026-11-26')
      assert.equal(result.latestCompleteDate, '2026-11-24')

      const v2 = await storage.open('analog-weather-archive-v2')
      const persistedRes = await v2.match('https://cache.local/archive/45.42,-75.70')
      const persisted = (await persistedRes!.json()) as CachedDailyHistory
      assert.equal(persisted.archiveEnd, '2026-11-26')
    }

    // 9. Zero-parse Cache API LRU using X-Updated-At header (res.json() not called during eviction)
    {
      resetArchiveForTest()
      let clock = 100_000
      configureArchiveForTest({
        now: () => {
          clock += 100
          return clock
        },
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      const v2 = (await storage.open('analog-weather-archive-v2')) as unknown as MockCache
      for (let i = 0; i < 12; i++) {
        const lat = (10 + i).toFixed(2)
        const updatedAt = (i + 1) * 1000
        const entry: CachedDailyHistory = {
          version: 2,
          startDate: ARCHIVE_START,
          archiveEnd: '2026-11-26',
          complete: true,
          timezone: 'UTC',
          updatedAt,
          days: [{ date: '2026-11-26', tMax: 10, tMin: 2, precip: 0 }],
        }
        await v2.put(
          `https://cache.local/archive/${lat},0.00`,
          new Response(JSON.stringify(entry), {
            headers: {
              'Content-Type': 'application/json',
              'X-Updated-At': String(updatedAt),
            },
          }),
        )
      }

      v2.jsonReadUrls.length = 0
      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async () =>
        archiveJson(['1940-01-01', '2026-11-26'])) as typeof fetch

      await loadDailyHistory(makePlace('extra2', 56, 0), {
        preferredAnchor: '1970-01-01',
      })

      assert.deepEqual(v2.jsonReadUrls, [], 'eviction should read X-Updated-At header without calling res.json()')
      const remainingKeys = (await v2.keys()).map((r) => r.url)
      assert.equal(remainingKeys.length, 12)
      assert.equal(
        remainingKeys.includes('https://cache.local/archive/10.00,0.00'),
        false,
        'oldest X-Updated-At entry should be evicted',
      )
      assert.equal(
        remainingKeys.includes('https://cache.local/archive/56.00,0.00'),
        true,
      )
    }

    // 10. Revisiting an older cached place refreshes recency and spares it on 13th insert
    {
      resetArchiveForTest()
      let clock = 200_000
      configureArchiveForTest({
        now: () => clock,
        yesterdayUtc: () => '2026-11-26',
      })
      const storage = new MockCacheStorage()
      const v2 = await storage.open('analog-weather-archive-v2')
      for (let i = 0; i < 12; i++) {
        const lat = (20 + i).toFixed(2)
        const updatedAt = (i + 1) * 1000
        const entry: CachedDailyHistory = {
          version: 2,
          startDate: ARCHIVE_START,
          archiveEnd: '2026-11-26',
          complete: true,
          timezone: 'UTC',
          updatedAt,
          days: [{ date: '2026-11-26', tMax: 10, tMin: 2, precip: 0 }],
        }
        await v2.put(
          `https://cache.local/archive/${lat},0.00`,
          new Response(JSON.stringify(entry), {
            headers: {
              'Content-Type': 'application/json',
              'X-Updated-At': String(updatedAt),
            },
          }),
        )
      }

      globalThis.caches = storage as unknown as CacheStorage
      globalThis.fetch = (async () =>
        archiveJson(['1940-01-01', '2026-11-26'])) as typeof fetch

      // Revisit place 0 (20.00,0.00) which has updatedAt = 1000 while clock = 200_000 (> 60s old)
      await loadDailyHistory(makePlace('revisit', 20, 0))
      // Allow fire-and-forget persistentCacheTouch to flush
      await new Promise((r) => setTimeout(r, 0))

      // Advance clock slightly and insert 13th place
      clock = 201_000
      await loadDailyHistory(makePlace('thirteenth', 57, 0), {
        preferredAnchor: '1970-01-01',
      })

      const remainingKeys = (await v2.keys()).map((r) => r.url)
      assert.equal(remainingKeys.length, 12)
      assert.equal(
        remainingKeys.includes('https://cache.local/archive/20.00,0.00'),
        true,
        'revisited place should have refreshed recency and be spared',
      )
      assert.equal(
        remainingKeys.includes('https://cache.local/archive/21.00,0.00'),
        false,
        'place 1 (now oldest) should be evicted instead',
      )
    }

    console.log('archive tests passed')
  } finally {
    resetArchiveForTest()
    globalThis.fetch = originalFetch
    globalThis.caches = originalCaches
  }
}

await runTests()
