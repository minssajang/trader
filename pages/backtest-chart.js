import { useState, useEffect, useRef, useCallback } from 'react'
import Head from 'next/head'
import { createChart, CrosshairMode } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { parseCandleCsv } from '../lib/candleCsv'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
const SPEEDS = [1, 5, 20, 60]
const TICK_MS = 200

function publicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`
}

export default function BacktestChart() {
  const [symbol, setSymbol] = useState('GOLD')
  const [datasets, setDatasets] = useState([])
  const [datasetId, setDatasetId] = useState('')
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

  // 심볼 바뀌면 그 심볼의 데이터셋 목록을 불러온다
  useEffect(() => {
    setDatasetId('')
    fetch(`/api/backtest-datasets-public?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => setDatasets(d.rows || []))
      .catch(() => setDatasets([]))
  }, [symbol])

  // 차트 인스턴스는 한 번만 생성
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 520,
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

  const loadDataset = async (id) => {
    setDatasetId(id)
    stopPlayback()
    setError('')
    const row = datasets.find(d => d.id === id)
    if (!row) return

    setLoadingCsv(true)
    seriesRef.current?.setData([])
    indexRef.current = 0
    setPlayIndex(0)
    try {
      const res = await fetch(publicUrl(row.storage_path))
      if (!res.ok) throw new Error(`파일을 가져오지 못했습니다 (${res.status})`)
      const text = await res.text()
      const parsed = parseCandleCsv(text)
      rowsRef.current = parsed.rows
      setTotal(parsed.rows.length)
    } catch (e) {
      setError(e.message)
      rowsRef.current = []
      setTotal(0)
    }
    setLoadingCsv(false)
  }

  // playIndex(state)는 화면 표시용, indexRef는 인터벌 틱 안에서 참조할 최신값
  const indexRef = useRef(0)

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

  return (
    <>
      <Head><title>백테스팅 차트 시뮬레이션 — EasyTrade</title></Head>
      <div style={{ minHeight: '100vh', background: '#0f1115', color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 28px', borderBottom: '1px solid #2a2e38' }}>
          <BrandLogo label="백테스팅" />
        </header>

        <main style={{ maxWidth: 1000, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>캔들 시뮬레이션 차트</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 24 }}>업로드된 1분봉 데이터를 재생하면서 과거 시세를 그대로 다시 볼 수 있어요.</p>

          <div style={{ display: 'flex', gap: 8, marginBottom: 16 }}>
            {Object.entries(SYMBOL_LABEL).map(([sym, label]) => (
              <button key={sym} onClick={() => setSymbol(sym)} style={{
                background: symbol === sym ? '#4CAF50' : 'none', color: symbol === sym ? '#fff' : '#9aa0ab',
                border: `1px solid ${symbol === sym ? '#4CAF50' : '#2a2e38'}`, borderRadius: 9,
                padding: '8px 18px', fontSize: 14, fontWeight: 700, cursor: 'pointer',
              }}>{label}</button>
            ))}
          </div>

          <div style={{ marginBottom: 16 }}>
            <select value={datasetId} onChange={e => loadDataset(e.target.value)} style={{
              background: '#171a21', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 8,
              padding: '10px 14px', fontSize: 14, minWidth: 280,
            }}>
              <option value="">데이터셋을 선택하세요 ({datasets.length}개)</option>
              {datasets.map(d => (
                <option key={d.id} value={d.id}>{d.date_from} ~ {d.date_to} ({(d.row_count || 0).toLocaleString()}봉)</option>
              ))}
            </select>
          </div>

          {error && <div style={{ color: '#F44336', fontSize: 13, marginBottom: 12 }}>❌ {error}</div>}
          {loadingCsv && <div style={{ color: '#9aa0ab', fontSize: 13, marginBottom: 12 }}>데이터 불러오는 중...</div>}

          <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16 }}>
            <div ref={containerRef} style={{ width: '100%', height: 520 }} />
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
        </main>
      </div>
    </>
  )
}
