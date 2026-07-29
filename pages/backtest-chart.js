
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Head from 'next/head'
import { createChart, CrosshairMode } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, CollapsibleCard, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr } from '../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, MOVING_AVERAGES, rollingHMA } from '../lib/indicators'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
const SPEEDS = [1, 5, 20, 60]
const TICK_MS = 200
const DEFAULT_UP_COLOR = '#38BDF8'   // 상승 기본색 - 스카이블루
const DEFAULT_DOWN_COLOR = '#FF69B4' // 하락 기본색 - 밝은 핑크

function publicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`
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
  const [enabledBands, setEnabledBands] = useState({})
  const [lineVisibility, setLineVisibility] = useState({}) // `${bandId}:${upper|middle|lower}` -> false면 숨김 (기본 true)
  const [bandColors, setBandColors] = useState({}) // bandId -> 커스텀 색상 (없으면 BOLLINGER_BANDS 기본색)
  const [enabledMA, setEnabledMA] = useState({})
  const [maColors, setMaColors] = useState({}) // maId -> 커스텀 색상 (없으면 MOVING_AVERAGES 기본색, 볼린저와 동일)
  const [upColor, setUpColorState] = useState(DEFAULT_UP_COLOR)
  const [downColor, setDownColorState] = useState(DEFAULT_DOWN_COLOR)

  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const rowsRef = useRef([])
  const intervalRef = useRef(null)
  const indexRef = useRef(0)
  const datasetCacheRef = useRef({}) // dataset.id -> 파싱된 전체 rows (CSV 재요청 방지용)
  const bandDataRef = useRef({})     // bandId -> { upper, middle, lower } - 선택한 날짜분, 워밍업 포함해서 계산됨
  const bandSeriesRef = useRef({})   // bandId -> { upper, middle, lower } lightweight-charts 라인 시리즈
  const maDataRef = useRef({})       // maId -> [{time,value}|null] - 선택한 날짜분, 워밍업 포함해서 계산됨
  const maSeriesRef = useRef({})     // maId -> lightweight-charts 라인 시리즈 (밴드와 달리 선 1개)

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
    bandDataRef.current = {}
    syncBands(0)
    maDataRef.current = {}
    syncMA(0)
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
      height: 640,
      layout: { background: { color: '#0f1115' }, textColor: '#9aa0ab' },
      grid: { vertLines: { color: '#1c2028' }, horzLines: { color: '#1c2028' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: '#2a2e38', timeVisible: true, secondsVisible: false },
      rightPriceScale: { borderColor: '#2a2e38' },
    })
    const series = chart.addCandlestickSeries({
      upColor, downColor,
      borderUpColor: upColor, borderDownColor: downColor,
      wickUpColor: upColor, wickDownColor: downColor,
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

  // 지표 라인은 봉 재생 위치(idx)를 절대 앞서가면 안 된다 - 아직 안 지난 미래 구간의
  // 볼린저 값이 미리 보이면 "다시보기 하면서 판단 연습"이라는 이 페이지의 목적이 깨진다.
  const applyBandIndex = (bandId, idx) => {
    const series = bandSeriesRef.current[bandId]
    const data = bandDataRef.current[bandId]
    if (!series || !data) return
    series.upper.setData(data.upper.slice(0, idx).filter(Boolean))
    series.middle.setData(data.middle.slice(0, idx).filter(Boolean))
    series.lower.setData(data.lower.slice(0, idx).filter(Boolean))
  }

  const syncBands = (idx) => {
    Object.keys(bandSeriesRef.current).forEach(bandId => applyBandIndex(bandId, idx))
  }

  // 이평선도 볼린저와 같은 이유로 재생 위치(idx)를 앞서가면 안 된다
  const applyMAIndex = (maId, idx) => {
    const series = maSeriesRef.current[maId]
    const data = maDataRef.current[maId]
    if (!series || !data) return
    series.setData(data.slice(0, idx).filter(Boolean))
  }

  const syncMA = (idx) => {
    Object.keys(maSeriesRef.current).forEach(maId => applyMAIndex(maId, idx))
  }

  const applyIndex = (idx) => {
    seriesRef.current?.setData(rowsRef.current.slice(0, idx))
    syncBands(idx)
    syncMA(idx)
    indexRef.current = idx
    setPlayIndex(idx)
  }

  // 캔들을 하나씩 update()로 이어붙이는 게 setData 전체 재계산보다 가볍다
  const applyIncrement = (from, to) => {
    const rows = rowsRef.current
    for (let i = from; i < to; i++) {
      seriesRef.current?.update(rows[i])
    }
    syncBands(to)
    syncMA(to)
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
    bandDataRef.current = {}
    syncBands(0)
    maDataRef.current = {}
    syncMA(0)
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

      let startIdx = fullRows.findIndex(r => toLocalDateStr(r.time) === dateStr)
      let endIdx = startIdx
      if (startIdx >= 0) {
        endIdx = startIdx
        while (endIdx < fullRows.length && toLocalDateStr(fullRows[endIdx].time) === dateStr) endIdx++
      }
      const dayRows = startIdx >= 0 ? fullRows.slice(startIdx, endIdx) : []
      rowsRef.current = dayRows
      setTotal(dayRows.length)

      // 볼린저는 그날 데이터만으론 워밍업이 부족하니(예: 1시간봉 SMA1200 = 20시간 분량)
      // 같은 파일 안의 이전 날짜들까지 포함해서 계산한 뒤, 표시 구간만 그날로 잘라낸다.
      if (dayRows.length > 0) {
        const closes = fullRows.map(r => r.close)
        const newBandData = {}
        for (const band of BOLLINGER_BANDS) {
          const { mids, ups, lows } = rollingBollinger(closes, band.period)
          const upper = [], middle = [], lower = []
          for (let i = startIdx; i < endIdx; i++) {
            const t = fullRows[i].time
            upper.push(ups[i] != null ? { time: t, value: ups[i] } : null)
            middle.push(mids[i] != null ? { time: t, value: mids[i] } : null)
            lower.push(lows[i] != null ? { time: t, value: lows[i] } : null)
          }
          newBandData[band.id] = { upper, middle, lower }
        }
        bandDataRef.current = newBandData

        const newMaData = {}
        for (const ma of MOVING_AVERAGES) {
          const hma = rollingHMA(closes, ma.period)
          const points = []
          for (let i = startIdx; i < endIdx; i++) {
            points.push(hma[i] != null ? { time: fullRows[i].time, value: hma[i] } : null)
          }
          newMaData[ma.id] = points
        }
        maDataRef.current = newMaData
      }

      if (dayRows.length === 0) setError('이 날짜엔 캔들이 없어요 (주말/휴장일일 수 있어요)')
    } catch (e) {
      setError(e.message)
      rowsRef.current = []
      setTotal(0)
    }
    setLoadingCsv(false)
  }

  // 위/중심/아래 각 줄을 따로 숨길 수도 있게 - 기본은 다 보임(true)
  const isLineVisible = (bandId, which) => lineVisibility[`${bandId}:${which}`] !== false

  const toggleLine = (bandId, which) => {
    const nextVisible = !isLineVisible(bandId, which)
    setLineVisibility(prev => ({ ...prev, [`${bandId}:${which}`]: nextVisible }))
    bandSeriesRef.current[bandId]?.[which].applyOptions({ visible: nextVisible })
  }

  const setUpColor = (color) => {
    setUpColorState(color)
    seriesRef.current?.applyOptions({ upColor: color, borderUpColor: color, wickUpColor: color })
  }

  const setDownColor = (color) => {
    setDownColorState(color)
    seriesRef.current?.applyOptions({ downColor: color, borderDownColor: color, wickDownColor: color })
  }

  const resetCandleColors = () => {
    setUpColor(DEFAULT_UP_COLOR)
    setDownColor(DEFAULT_DOWN_COLOR)
  }

  // 커스텀 색을 안 골랐으면 BOLLINGER_BANDS에 정의된 기본색 그대로
  const getBandColor = (band) => bandColors[band.id] || band.color

  const setBandColor = (bandId, color) => {
    setBandColors(prev => ({ ...prev, [bandId]: color }))
    const s = bandSeriesRef.current[bandId]
    if (s) {
      s.upper.applyOptions({ color })
      s.middle.applyOptions({ color })
      s.lower.applyOptions({ color })
    }
  }

  const resetBandColor = (band) => {
    setBandColors(prev => {
      const next = { ...prev }
      delete next[band.id]
      return next
    })
    const s = bandSeriesRef.current[band.id]
    if (s) {
      s.upper.applyOptions({ color: band.color })
      s.middle.applyOptions({ color: band.color })
      s.lower.applyOptions({ color: band.color })
    }
  }

  const toggleBand = (bandId) => {
    const turningOn = !enabledBands[bandId]
    setEnabledBands(prev => ({ ...prev, [bandId]: turningOn }))

    if (turningOn) {
      if (!bandSeriesRef.current[bandId] && chartRef.current) {
        const band = BOLLINGER_BANDS.find(b => b.id === bandId)
        const color = getBandColor(band)
        bandSeriesRef.current[bandId] = {
          // 위/중심/아래 모두 실선
          upper: chartRef.current.addLineSeries({ color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'upper') }),
          middle: chartRef.current.addLineSeries({ color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'middle') }),
          lower: chartRef.current.addLineSeries({ color, lineWidth: 1, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'lower') }),
        }
      }
      applyBandIndex(bandId, indexRef.current)
    } else {
      const s = bandSeriesRef.current[bandId]
      if (s && chartRef.current) {
        chartRef.current.removeSeries(s.upper)
        chartRef.current.removeSeries(s.middle)
        chartRef.current.removeSeries(s.lower)
      }
      delete bandSeriesRef.current[bandId]
    }
  }

  // 커스텀 색을 안 골랐으면 MOVING_AVERAGES에 정의된 기본색(볼린저와 동일) 그대로
  const getMAColor = (ma) => maColors[ma.id] || ma.color

  const setMAColor = (maId, color) => {
    setMaColors(prev => ({ ...prev, [maId]: color }))
    maSeriesRef.current[maId]?.applyOptions({ color })
  }

  const resetMAColor = (ma) => {
    setMaColors(prev => {
      const next = { ...prev }
      delete next[ma.id]
      return next
    })
    maSeriesRef.current[ma.id]?.applyOptions({ color: ma.color })
  }

  const toggleMA = (maId) => {
    const turningOn = !enabledMA[maId]
    setEnabledMA(prev => ({ ...prev, [maId]: turningOn }))

    if (turningOn) {
      if (!maSeriesRef.current[maId] && chartRef.current) {
        const ma = MOVING_AVERAGES.find(m => m.id === maId)
        const color = getMAColor(ma)
        // 볼린저와 구분되게 굵은 점선
        maSeriesRef.current[maId] = chartRef.current.addLineSeries({
          color, lineWidth: 3, lineStyle: 2, lastValueVisible: false, priceLineVisible: false,
        })
      }
      applyMAIndex(maId, indexRef.current)
    } else {
      const s = maSeriesRef.current[maId]
      if (s && chartRef.current) chartRef.current.removeSeries(s)
      delete maSeriesRef.current[maId]
    }
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

        <main style={{ maxWidth: 1500, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>캔들 시뮬레이션 차트</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 24 }}>달력에서 데이터가 있는 날짜를 골라서, 그날 시세를 순서대로 재생해볼 수 있어요.</p>

          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* 왼쪽 컬럼: 심볼버튼 / 달력 / 볼린저 리스트가 서로 붙어서 쌓인다 (오른쪽 차트 높이랑 무관하게) */}
            <div style={{ width: 170, display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {Object.entries(SYMBOL_LABEL).map(([sym, label]) => (
                  <button key={sym} onClick={() => setSymbol(sym)} style={{
                    flex: 1, background: symbol === sym ? '#4CAF50' : 'none', color: symbol === sym ? '#fff' : '#9aa0ab',
                    border: `1px solid ${symbol === sym ? '#4CAF50' : '#2a2e38'}`, borderRadius: 9,
                    padding: '8px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  }}>{label}</button>
                ))}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#9aa0ab' }}>
                <span style={{ flex: 1 }}>캔들 색상</span>
                <label title="상승 색상 변경 가능" style={{ display: 'flex', cursor: 'pointer' }}>
                  <input
                    type="color"
                    value={upColor}
                    onChange={e => setUpColor(e.target.value)}
                    style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </label>
                <label title="하락 색상 변경 가능" style={{ display: 'flex', cursor: 'pointer' }}>
                  <input
                    type="color"
                    value={downColor}
                    onChange={e => setDownColor(e.target.value)}
                    style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                  />
                </label>
                {(upColor !== DEFAULT_UP_COLOR || downColor !== DEFAULT_DOWN_COLOR) && (
                  <button
                    type="button"
                    onClick={resetCandleColors}
                    title="기본 색상으로"
                    style={{ fontSize: 10, color: '#5a5f6a', background: 'none', border: 'none', cursor: 'pointer' }}
                  >↺</button>
                )}
              </div>

              <CollapsibleCard title="달력" maxWidth={170}>
                <MonthCalendar
                  viewDate={viewDate}
                  onNavigate={navigateMonth}
                  availableDates={availableDates}
                  selectedDate={selectedDate}
                  onSelect={loadDate}
                  maxWidth={170}
                  bare
                />
              </CollapsibleCard>

              <CollapsibleCard title="볼린저" maxWidth={170}>
                {BOLLINGER_BANDS.map(band => {
                  const on = !!enabledBands[band.id]
                  const color = getBandColor(band)
                  const isCustom = !!bandColors[band.id]
                  return (
                    <div key={band.id} style={{ padding: '3px 0' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleBand(band.id)}
                          style={{ width: 13, height: 13, margin: 0, accentColor: color, flexShrink: 0 }}
                        />
                        <span style={{ flex: 1 }}>{band.label}</span>
                        {/* 네모를 누르면 브라우저 기본 색상선택기가 뜬다 - 기본값은 BOLLINGER_BANDS의 원래 색 */}
                        <input
                          type="color"
                          value={color}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setBandColor(band.id, e.target.value)}
                          title="색상변경 가능"
                          style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                        />
                      </label>

                      {/* 체크한 밴드에 한해 위/중심/아래를 따로 켜고 끌 수 있게 + 색상 기본값 복원 */}
                      {on && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 19, marginTop: 3 }}>
                          {[['upper', '상'], ['middle', '중'], ['lower', '하']].map(([which, wlabel]) => {
                            const vis = isLineVisible(band.id, which)
                            return (
                              <button
                                key={which}
                                type="button"
                                onClick={() => toggleLine(band.id, which)}
                                style={{
                                  fontSize: 10, padding: '2px 6px', borderRadius: 5,
                                  border: `1px solid ${vis ? color : '#2a2e38'}`,
                                  background: vis ? `${color}22` : 'none',
                                  color: vis ? color : '#5a5f6a',
                                  cursor: 'pointer',
                                }}
                              >{wlabel}</button>
                            )
                          })}
                          {isCustom && (
                            <button
                              type="button"
                              onClick={() => resetBandColor(band)}
                              title="기본 색상으로"
                              style={{ fontSize: 10, color: '#5a5f6a', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 2 }}
                            >↺</button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </CollapsibleCard>

              <CollapsibleCard title="이평선" maxWidth={170}>
                {MOVING_AVERAGES.map(ma => {
                  const on = !!enabledMA[ma.id]
                  const color = getMAColor(ma)
                  const isCustom = !!maColors[ma.id]
                  return (
                    <div key={ma.id} style={{ padding: '3px 0' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={on}
                          onChange={() => toggleMA(ma.id)}
                          style={{ width: 13, height: 13, margin: 0, accentColor: color, flexShrink: 0 }}
                        />
                        <span style={{ flex: 1 }}>{ma.label}</span>
                        <input
                          type="color"
                          value={color}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setMAColor(ma.id, e.target.value)}
                          title="색상변경 가능"
                          style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                        />
                      </label>
                      {on && isCustom && (
                        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: 3 }}>
                          <button
                            type="button"
                            onClick={() => resetMAColor(ma)}
                            title="기본 색상으로"
                            style={{ fontSize: 10, color: '#5a5f6a', background: 'none', border: 'none', cursor: 'pointer' }}
                          >↺</button>
                        </div>
                      )}
                    </div>
                  )
                })}
              </CollapsibleCard>
            </div>

            {/* 오른쪽 컬럼: 상태줄 / 차트 / 컨트롤 */}
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
                {!selectedDate && <div style={{ color: '#9aa0ab', fontSize: 13 }}>왼쪽 달력에서 초록색으로 표시된 날짜를 눌러보세요.</div>}
                {selectedDate && <div style={{ color: '#e8eaed', fontSize: 14, fontWeight: 700 }}>{selectedDate}</div>}
                {error && <div style={{ color: '#F44336', fontSize: 13, marginLeft: 12 }}>❌ {error}</div>}
                {loadingCsv && <div style={{ color: '#9aa0ab', fontSize: 13, marginLeft: 12 }}>불러오는 중...</div>}
              </div>

              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16 }}>
                <div ref={containerRef} style={{ width: '100%', height: 640 }} />
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
