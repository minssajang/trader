import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Head from 'next/head'
import { createChart, CrosshairMode } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { parseCandleCsv, toLocalDateStr } from '../lib/candleCsv'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
const WEEKDAY_LABEL = ['일', '월', '화', '수', '목', '금', '토']
const SPEEDS = [1, 5, 20, 60]
const TICK_MS = 200

function publicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`
}

// "YYYY-MM-DD" 문자열 그대로 하루씩 이동 (로컬 타임존 기준 - toLocalDateStr과 짝을 맞춤)
function addDays(dateStr, days) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() + days)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

// 데이터셋들의 date_from~date_to 구간을 모두 합쳐 "데이터가 있는 날짜" 집합을 만든다.
// (실제 캔들이 없는 주말도 포함될 수 있지만, 그런 날은 선택해도 "캔들 없음"으로 자연스럽게 처리됨)
function buildAvailableDates(datasets) {
  const set = new Set()
  for (const ds of datasets) {
    if (!ds.date_from || !ds.date_to) continue
    let cur = ds.date_from
    let guard = 0
    while (cur <= ds.date_to && guard < 3660) {
      set.add(cur)
      cur = addDays(cur, 1)
      guard++
    }
  }
  return set
}

function MonthCalendar({ viewDate, onNavigate, availableDates, selectedDate, onSelect }) {
  const year = viewDate.getFullYear()
  const month = viewDate.getMonth()
  const startWeekday = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()

  const cells = []
  for (let i = 0; i < startWeekday; i++) cells.push(null)
  for (let d = 1; d <= daysInMonth; d++) cells.push(d)

  const navBtn = {
    background: 'none', border: '1px solid #2a2e38', color: '#9aa0ab', borderRadius: 8,
    width: 30, height: 30, cursor: 'pointer', fontSize: 14,
  }

  return (
    <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, maxWidth: 340 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 12 }}>
        <button onClick={() => onNavigate(-1)} style={navBtn}>‹</button>
        <div style={{ fontWeight: 700, fontSize: 14 }}>{year}년 {month + 1}월</div>
        <button onClick={() => onNavigate(1)} style={navBtn}>›</button>
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, fontSize: 11, color: '#9aa0ab', textAlign: 'center', marginBottom: 4 }}>
        {WEEKDAY_LABEL.map(w => <div key={w}>{w}</div>)}
      </div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4 }}>
        {cells.map((d, i) => {
          if (d == null) return <div key={i} />
          const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`
          const has = availableDates.has(dateStr)
          const isSelected = dateStr === selectedDate
          return (
            <button
              key={i}
              disabled={!has}
              onClick={() => onSelect(dateStr)}
              style={{
                padding: '8px 0', borderRadius: 6, fontSize: 12,
                cursor: has ? 'pointer' : 'default',
                border: isSelected ? '1px solid #4CAF50' : '1px solid transparent',
                background: isSelected ? '#4CAF50' : has ? 'rgba(76,175,80,0.15)' : 'transparent',
                color: isSelected ? '#fff' : has ? '#e8eaed' : '#3a3f4a',
                fontWeight: has ? 700 : 400,
              }}
            >{d}</button>
          )
        })}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 12, fontSize: 11, color: '#9aa0ab' }}>
        <span style={{ width: 10, height: 10, borderRadius: 3, background: 'rgba(76,175,80,0.15)', display: 'inline-block' }} />
        데이터 있음
      </div>
    </div>
  )
}

export default function BacktestChart() {
  const [symbol, setSymbol] = useState('GOLD')
  const [datasets, setDatasets] = useState([])
  const [viewDate, setViewDate] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState('')
  const [loadingCsv, setLoadingCsv] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(5)
  const [playIndex, setPlayIndex] = useState(0)
  const [total, setTotal] = useState(0)

  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const rowsRef = useRef([])
  const intervalRef = useRef(null)
  const indexRef = useRef(0)
  const datasetCacheRef = useRef({}) // dataset.id -> 파싱된 전체 rows (CSV 재요청 방지용)

  const availableDates = useMemo(() => buildAvailableDates(datasets), [datasets])

  // 심볼 바뀌면 그 심볼의 데이터셋 목록을 불러온다
  useEffect(() => {
    stopPlayback()
    setSelectedDate('')
    setError('')
    rowsRef.current = []
    indexRef.current = 0
    setPlayIndex(0)
    setTotal(0)
    seriesRef.current?.setData([])
    fetch(`/api/backtest-datasets-public?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => {
        const rows = d.rows || []
        setDatasets(rows)
        // 데이터가 있는 가장 최근 달을 기본으로 보여준다
        const latest = rows.reduce((max, r) => (r.date_to && r.date_to > max ? r.date_to : max), '')
        if (latest) {
          const [y, m] = latest.split('-').map(Number)
          setViewDate(new Date(y, m - 1, 1))
        }
      })
      .catch(() => setDatasets([]))
  }, [symbol])

  // 차트 인스턴스는 한 번만 생성
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 480,
      layout: { background: { color: '#0f1115' }, textColor: '#9aa0ab' },
      grid: { vertLines: { color: '#1c2028' }, horzLines: { color: '#1c2028' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: '#2a2e38', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#2a2e38' },
    })
    const series = chart.addCandlestickSeries({
      upColor: '#26a69a', downColor: '#ef5350',
      borderUpColor: '#26a69a', borderDownColor: '#ef5350',
      wickUpColor: '#26a69a', wickDownColor: '#ef5350',
    })
    chartRef.current = chart
    seriesRef.current = series

    const onResize = () => chart.applyOptions({ width: containerRef.current.clientWidth })
    window.addEventListener('resize', onResize)
    return () => {
      window.removeEventListener('resize', onResize)
      chart.remove()
    }
  }, [])

  const stopPlayback = useCallback(() => {
    setPlaying(false)
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
  }, [])

  const applyIndex = (idx) => {
    seriesRef.current?.setData(rowsRef.current.slice(0, idx))
    indexRef.current = idx
    setPlayIndex(idx)
  }

  // 캔들을 하나씩 update()로 이어붙이는 게 setData 전체 재계산보다 가볍다
  const applyIncrement = (from, to) => {
    const rows = rowsRef.current
    for (let i = from; i < to; i++) {
      seriesRef.current?.update(rows[i])
    }
    indexRef.current = to
    setPlayIndex(to)
  }

  const loadDate = async (dateStr) => {
    stopPlayback()
    setError('')
    setSelectedDate(dateStr)

    const ds = datasets.find(d => d.date_from <= dateStr && dateStr <= d.date_to)
    if (!ds) {
      setError('해당 날짜의 데이터를 찾을 수 없습니다')
      return
    }

    setLoadingCsv(true)
    seriesRef.current?.setData([])
    indexRef.current = 0
    setPlayIndex(0)
    try {
      let fullRows = datasetCacheRef.current[ds.id]
      if (!fullRows) {
        const res = await fetch(publicUrl(ds.storage_path))
        if (!res.ok) throw new Error(`파일을 가져오지 못했습니다 (${res.status})`)
        const text = await res.text()
        fullRows = parseCandleCsv(text).rows
        datasetCacheRef.current[ds.id] = fullRows
      }
      const dayRows = fullRows.filter(r => toLocalDateStr(r.time) === dateStr)
      rowsRef.current = dayRows
      setTotal(dayRows.length)
      if (dayRows.length === 0) setError('이 날짜엔 캔들이 없어요 (주말/휴장일일 수 있어요)')
    } catch (e) {
      setError(e.message)
      rowsRef.current = []
      setTotal(0)
    }
    setLoadingCsv(false)
  }

  const play = () => {
    if (!rowsRef.current.length) return
    if (indexRef.current >= rowsRef.current.length) applyIndex(0)
    setPlaying(true)
  }

  useEffect(() => {
    if (!playing) return
    intervalRef.current = setInterval(() => {
      const from = indexRef.current
      const to = Math.min(from + speed, rowsRef.current.length)
      applyIncrement(from, to)
      if (to >= rowsRef.current.length) stopPlayback()
    }, TICK_MS)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, speed, stopPlayback])

  const reset = () => {
    stopPlayback()
    applyIndex(0)
  }

  const scrub = (idx) => {
    stopPlayback()
    applyIndex(idx)
  }

  const navigateMonth = (delta) => {
    setViewDate(v => new Date(v.getFullYear(), v.getMonth() + delta, 1))
  }

  return (
    <>
      <Head><title>백테스팅 차트 시뮬레이션 — EasyTrade</title></Head>
      <div className="bt-page" style={{ minHeight: '100vh', background: '#0f1115', color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
        <style>{`
          /* styles/site.css의 전역 button { width:100%; margin-top:20px }이
             재생/속도 버튼들을 세로로 늘려버리는 문제를 이 페이지 안에서만 되돌린다. */
          .bt-page button { width: auto; margin-top: 0; }
        `}</style>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 28px', borderBottom: '1px solid #2a2e38' }}>
          <BrandLogo label="백테스팅" />
        </header>

        <main style={{ maxWidth: 1100, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>캔들 시뮬레이션 차트</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 24 }}>달력에서 데이터가 있는 날짜를 골라서, 그날 시세를 순서대로 재생해볼 수 있어요.</p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
            {Object.entries(SYMBOL_LABEL).map(([sym, label]) => (
              <button key={sym} onClick={() => setSymbol(sym)} style={{
                background: symbol === sym ? '#4CAF50' : 'none', color: symbol === sym ? '#fff' : '#9aa0ab',
                border: `1px solid ${symbol === sym ? '#4CAF50' : '#2a2e38'}`, borderRadius: 9,
                padding: '8px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>{label}</button>
            ))}
          </div>

          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <MonthCalendar
              viewDate={viewDate}
              onNavigate={navigateMonth}
              availableDates={availableDates}
              selectedDate={selectedDate}
              onSelect={loadDate}
            />

            <div style={{ flex: 1, minWidth: 280 }}>
              {!selectedDate && <div style={{ color: '#9aa0ab', fontSize: 13, marginBottom: 12 }}>왼쪽 달력에서 초록색으로 표시된 날짜를 눌러보세요.</div>}
              {selectedDate && <div style={{ color: '#e8eaed', fontSize: 14, fontWeight: 700, marginBottom: 12 }}>{selectedDate}</div>}
              {error && <div style={{ color: '#F44336', fontSize: 13, marginBottom: 12 }}>❌ {error}</div>}
              {loadingCsv && <div style={{ color: '#9aa0ab', fontSize: 13, marginBottom: 12 }}>데이터 불러오는 중...</div>}

              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16 }}>
                <div ref={containerRef} style={{ width: '100%', height: 480 }} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                <button onClick={playing ? stopPlayback : play} disabled={!total} style={{
                  background: '#4CAF50', color: '#fff', border: 'none', borderRadius: 9,
                  padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: total ? 'pointer' : 'not-allowed', opacity: total ? 1 : 0.5,
                }}>{playing ? '⏸ 일시정지' : '▶ 재생'}</button>

                <button onClick={reset} disabled={!total} style={{
                  background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '10px 16px', fontSize: 14, cursor: total ? 'pointer' : 'not-allowed',
                }}>⏮ 처음부터</button>

                {SPEEDS.map(s => (
                  <button key={s} onClick={() => setSpeed(s)} style={{
                    background: speed === s ? '#2a2e38' : 'none', color: speed === s ? '#e8eaed' : '#9aa0ab',
                    border: '1px solid #2a2e38', borderRadius: 9, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                  }}>x{s}</button>
                ))}

                <span style={{ color: '#9aa0ab', fontSize: 13, marginLeft: 'auto' }}>{playIndex.toLocaleString()} / {total.toLocaleString()}봉</span>
              </div>

              <input
                type="range" min={0} max={total || 0} value={playIndex}
                onChange={e => scrub(Number(e.target.value))}
                disabled={!total}
                style={{ width: '100%', marginTop: 10 }}
              />
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
