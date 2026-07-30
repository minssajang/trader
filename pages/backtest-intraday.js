import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import BrandLogo from '../components/BrandLogo'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'
const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
// 하루 캔들이 이 개수 미만이면(주말/휴장일 또는 데이터 파일 경계에 걸쳐 잘린 날) 오버레이에서 제외 -
// 정상적인 하루는 01:00~23:59, 1분봉 1380개
const MIN_CANDLES_PER_DAY = 1300

function publicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`
}

// backtest-chart.js의 서머타임 토글과 같은 개념이지만, 이 페이지는 달 단위로 통으로 보기 때문에
// 별도 상태 없이 항상 서머타임 오프셋을 쓴다(데이터 자체가 전부 2026년 여름 구간).
export default function BacktestIntraday() {
  const [symbol, setSymbol] = useState('NASDAQ')
  const [datasets, setDatasets] = useState([])
  const [viewMonth, setViewMonth] = useState(new Date())
  const [days, setDays] = useState([]) // [{date, points:[[minute, deviation]]}]
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hoverInfo, setHoverInfo] = useState(null) // {x, minute, avg, up, down}

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const datasetCacheRef = useRef({}) // dataset.id -> parsed rows(전체) 캐시

  useEffect(() => {
    let ignore = false
    fetch(`/api/backtest-datasets-public?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => { if (!ignore) setDatasets(d.rows || []) })
      .catch(() => { if (!ignore) setDatasets([]) })
    return () => { ignore = true }
  }, [symbol])

  const monthLabel = `${viewMonth.getFullYear()}년 ${viewMonth.getMonth() + 1}월`
  const navigateMonth = (delta) => setViewMonth(v => new Date(v.getFullYear(), v.getMonth() + delta, 1))

  useEffect(() => {
    let ignore = false
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth()
    const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const monthEnd = `${y}-${String(m + 1).padStart(2, '0')}-31`

    const ds = datasets.find(d => d.date_from <= monthEnd && d.date_to >= monthStart)
    if (!ds) {
      setDays([])
      setError(datasets.length ? '이 달에는 데이터가 없습니다' : '')
      return
    }

    setLoading(true)
    setError('')
    ;(async () => {
      try {
        let fullRows = datasetCacheRef.current[ds.id]
        if (!fullRows) {
          const res = await fetch(publicUrl(ds.storage_path))
          if (!res.ok) throw new Error(`파일을 가져오지 못했습니다 (${res.status})`)
          const text = await res.text()
          fullRows = parseCandleCsv(text, BROKER_OFFSET_SECONDS.summer).rows
          datasetCacheRef.current[ds.id] = fullRows
        }
        if (ignore) return

        const byDate = new Map()
        for (const r of fullRows) {
          const dateStr = toLocalDateStr(r.time)
          if (!dateStr.startsWith(`${y}-${String(m + 1).padStart(2, '0')}`)) continue
          if (!byDate.has(dateStr)) byDate.set(dateStr, [])
          byDate.get(dateStr).push(r)
        }

        const nextDays = []
        for (const [date, rows] of [...byDate.entries()].sort()) {
          if (rows.length < MIN_CANDLES_PER_DAY) continue
          const dayOpen = rows[0].open
          const points = rows.map(r => {
            const d = new Date(r.time * 1000)
            const minutes = d.getHours() * 60 + d.getMinutes()
            return [minutes, Math.round((r.close - dayOpen) * 100) / 100]
          })
          nextDays.push({ date, points })
        }
        if (!ignore) {
          setDays(nextDays)
          if (nextDays.length === 0) setError('이 달엔 완전한 거래일 데이터가 없습니다')
        }
      } catch (e) {
        if (!ignore) { setError(e.message); setDays([]) }
      }
      if (!ignore) setLoading(false)
    })()

    return () => { ignore = true }
  }, [viewMonth, datasets])

  const { yLo, yHi, avgSeries, avgMap } = useMemo(() => {
    if (days.length === 0) return { yLo: -1, yHi: 1, avgSeries: [], avgMap: new Map() }
    let lo = Infinity, hi = -Infinity
    const sums = new Map()
    for (const d of days) {
      for (const [m, v] of d.points) {
        if (v < lo) lo = v
        if (v > hi) hi = v
        const e = sums.get(m) || { s: 0, n: 0 }
        e.s += v; e.n += 1
        sums.set(m, e)
      }
    }
    const pad = (hi - lo) * 0.08 || 1
    const mins = [...sums.keys()].sort((a, b) => a - b)
    const series = mins.map(m => [m, sums.get(m).s / sums.get(m).n])
    return { yLo: lo - pad, yHi: hi + pad, avgSeries: series, avgMap: new Map(series) }
  }, [days])

  const MIN_MIN = 60, MAX_MIN = 24 * 60 - 1

  const draw = useCallback(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = rect.width, H = rect.height

    const px = m => 56 + (m - MIN_MIN) / (MAX_MIN - MIN_MIN) * (W - 56 - 20)
    const py = v => 16 + (1 - (v - yLo) / (yHi - yLo)) * (H - 16 - 34)

    ctx.clearRect(0, 0, W, H)
    if (days.length === 0) return

    ctx.font = '11px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
    ctx.strokeStyle = '#232733'
    ctx.fillStyle = '#9aa0ab'
    for (let h = 2; h <= 22; h += 2) {
      const x = px(h * 60)
      ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, H - 34); ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText(`${String(h).padStart(2, '0')}:00`, x, H - 16)
    }
    for (let i = 0; i <= 5; i++) {
      const v = yLo + (yHi - yLo) * (i / 5)
      const y = py(v)
      ctx.strokeStyle = '#232733'
      ctx.beginPath(); ctx.moveTo(56, y); ctx.lineTo(W - 20, y); ctx.stroke()
      ctx.fillStyle = '#9aa0ab'
      ctx.textAlign = 'right'
      ctx.fillText(v.toFixed(0), 48, y + 4)
    }

    const zeroY = py(0)
    ctx.strokeStyle = '#9aa0ab'
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(56, zeroY); ctx.lineTo(W - 20, zeroY); ctx.stroke()
    ctx.setLineDash([])
    ctx.textAlign = 'left'
    ctx.fillText('시가(0)', 58, zeroY - 5)

    const n = days.length
    days.forEach((d, i) => {
      const t = n === 1 ? 1 : i / (n - 1)
      const alpha = 0.16 + t * 0.30
      ctx.strokeStyle = `rgba(107, 143, 176, ${alpha})`
      ctx.lineWidth = 1.2
      ctx.beginPath()
      d.points.forEach(([m, v], idx) => {
        const x = px(m), y = py(v)
        if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
      })
      ctx.stroke()
    })

    ctx.strokeStyle = '#26a69a'
    ctx.lineWidth = 2.4
    ctx.beginPath()
    avgSeries.forEach(([m, v], idx) => {
      const x = px(m), y = py(v)
      if (idx === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    })
    ctx.stroke()

    if (hoverInfo) {
      ctx.strokeStyle = '#e8eaed'
      ctx.globalAlpha = 0.35
      ctx.beginPath(); ctx.moveTo(hoverInfo.x, 16); ctx.lineTo(hoverInfo.x, H - 34); ctx.stroke()
      ctx.globalAlpha = 1
    }
  }, [days, yLo, yHi, avgSeries, hoverInfo])

  useEffect(() => {
    draw()
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  const onMouseMove = (e) => {
    const canvas = canvasRef.current
    if (!canvas || days.length === 0) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    if (mx < 56 || mx > rect.width - 20) { setHoverInfo(null); return }
    const t = (mx - 56) / (rect.width - 56 - 20)
    const minute = Math.max(MIN_MIN, Math.min(MAX_MIN, Math.round(MIN_MIN + t * (MAX_MIN - MIN_MIN))))
    let up = 0, down = 0
    for (const d of days) {
      const p = d.points.find(([m]) => m === minute)
      if (p) { if (p[1] >= 0) up++; else down++ }
    }
    setHoverInfo({ x: mx, minute, avg: avgMap.get(minute), up, down })
  }

  const fmtHM = (m) => `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`

  const finalDevs = days.map(d => d.points[d.points.length - 1][1])
  const upDays = finalDevs.filter(v => v > 0).length
  const avgFinal = finalDevs.length ? finalDevs.reduce((a, b) => a + b, 0) / finalDevs.length : 0
  const maxAbs = days.length ? Math.max(...days.flatMap(d => d.points.map(p => Math.abs(p[1])))) : 0

  return (
    <>
      <Head><title>일중 패턴 — EasyTrade 백테스팅</title></Head>
      <div style={{ minHeight: '100vh', background: '#0f1115', color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 28px', borderBottom: '1px solid #2a2e38' }}>
          <BrandLogo label="일중 패턴" />
          <nav style={{ display: 'flex', gap: 6 }}>
            <Link href="/backtest-chart" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>캔들 재생</Link>
            <span style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'rgba(76,175,80,0.15)', color: '#4CAF50', border: '1px solid #4CAF50' }}>📈 일중 패턴</span>
          </nav>
        </header>

        <main style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>일중 패턴 — 시가 대비 편차 오버레이</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 20 }}>
            선택한 달의 모든 거래일을 겹쳐서, 그날 시가(01:00 기준) 대비 가격이 시간대별로 어떻게 움직였는지 봅니다. 0선이 그날 시가입니다.
          </p>

          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap', marginBottom: 16 }}>
            <div style={{ display: 'flex', gap: 8 }}>
              {Object.entries(SYMBOL_LABEL).map(([sym, label]) => (
                <button key={sym} onClick={() => setSymbol(sym)} style={{
                  background: symbol === sym ? '#4CAF50' : 'none', color: symbol === sym ? '#fff' : '#9aa0ab',
                  border: `1px solid ${symbol === sym ? '#4CAF50' : '#2a2e38'}`, borderRadius: 9,
                  padding: '8px 16px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                }}>{label}</button>
              ))}
            </div>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
              <button type="button" onClick={() => navigateMonth(-1)} style={{ background: 'none', border: '1px solid #2a2e38', color: '#9aa0ab', borderRadius: 8, width: 30, height: 30, cursor: 'pointer' }}>‹</button>
              <div style={{ fontWeight: 700, fontSize: 15, minWidth: 90, textAlign: 'center' }}>{monthLabel}</div>
              <button type="button" onClick={() => navigateMonth(1)} style={{ background: 'none', border: '1px solid #2a2e38', color: '#9aa0ab', borderRadius: 8, width: 30, height: 30, cursor: 'pointer' }}>›</button>
            </div>
            {loading && <div style={{ color: '#9aa0ab', fontSize: 13 }}>불러오는 중...</div>}
            {error && <div style={{ color: '#F44336', fontSize: 13 }}>❌ {error}</div>}
          </div>

          <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 20, position: 'relative' }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14, flexWrap: 'wrap', fontSize: 12.5, color: '#9aa0ab' }}>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 18, height: 2, display: 'inline-block', background: '#6b8fb0', opacity: 0.55 }} />
                개별 거래일 ({days.length}일, 옅을수록 이른 날짜)
              </span>
              <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
                <span style={{ width: 18, height: 3, display: 'inline-block', background: '#26a69a' }} />
                전체 평균 편차
              </span>
            </div>
            <div ref={wrapRef} style={{ position: 'relative' }}>
              <canvas
                ref={canvasRef}
                onMouseMove={onMouseMove}
                onMouseLeave={() => setHoverInfo(null)}
                style={{ display: 'block', width: '100%', height: 460, cursor: 'crosshair' }}
              />
              {hoverInfo && (
                <div style={{
                  position: 'absolute', top: 0, right: 0, background: '#171a21', border: '1px solid #2a2e38',
                  borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.6, minWidth: 150,
                  pointerEvents: 'none', boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                }}>
                  <div style={{ color: '#9aa0ab', fontSize: 11, marginBottom: 4 }}>{fmtHM(hoverInfo.minute)}</div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span>평균 편차</span><b>{hoverInfo.avg != null ? hoverInfo.avg.toFixed(1) + 'pt' : '-'}</b>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span>시가 위</span><b>{hoverInfo.up}일</b>
                  </div>
                  <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                    <span>시가 아래</span><b>{hoverInfo.down}일</b>
                  </div>
                </div>
              )}
            </div>
          </div>

          {days.length > 0 && (
            <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
              {[
                ['분석 거래일 수', `${days.length}일`],
                ['마감이 시가보다 높은 날', `${upDays} / ${days.length}일`],
                ['평균 마감 편차(시가 대비)', `${avgFinal.toFixed(1)}pt`],
                ['일중 최대 편차폭', `${maxAbs.toFixed(0)}pt`],
              ].map(([k, v]) => (
                <div key={k} style={{ flex: '1 1 140px', background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, padding: '12px 14px' }}>
                  <div style={{ color: '#9aa0ab', fontSize: 11.5, marginBottom: 4 }}>{k}</div>
                  <div style={{ fontSize: 17, fontWeight: 700 }}>{v}</div>
                </div>
              ))}
            </div>
          )}

          <p style={{ color: '#9aa0ab', fontSize: 12, marginTop: 14 }}>
            시간은 브로커 서버 기준(서머타임 적용). 완전한 하루(캔들 {MIN_CANDLES_PER_DAY}개 이상)만 포함하며, 주말·데이터 경계에 걸친 날은 제외됩니다.
          </p>
        </main>
      </div>
    </>
  )
}
