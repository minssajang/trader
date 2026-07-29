
import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Head from 'next/head'
import { createChart, CrosshairMode } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, CollapsibleCard, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr } from '../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, MOVING_AVERAGES, computeMA } from '../lib/indicators'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
// x1 = 실제 1분봉 그대로(캔들 1개 = 60초). 다른 배속은 전부 이 기준의 배수.
const SPEEDS = [0.25, 0.5, 1, 2, 3, 5, 20, 60, 300]
const REALTIME_MS = 60000
const MIN_TICK_MS = 50 // setInterval 실질 하한 - 이보다 짧은 간격은 한 틱에 여러 캔들을 진행시켜 흉내낸다
const MA_WIDTHS = [1, 2, 3, 4]
const DEFAULT_UP_COLOR = '#38BDF8'   // 상승 기본색 - 스카이블루
const DEFAULT_DOWN_COLOR = '#FF69B4' // 하락 기본색 - 밝은 핑크
// lightweight-charts 마커가 네이티브로 지원하는 모양만 사용(삼각형은 화살표로 표현)
const CROSS_SHAPES = [
  { id: 'circle', label: '●' },
  { id: 'square', label: '■' },
  { id: 'arrowUp', label: '▲' },
  { id: 'arrowDown', label: '▼' },
]
const CROSS_SIZES = [1, 2, 3]
const DEFAULT_GOLDEN_COLOR = '#00E676'
const DEFAULT_DEAD_COLOR = '#FF1744'
// 1랏 기준 1.00포인트 변동 시 손익(달러). 골드는 사용자가 알려준 값($100),
// 나스닥은 MonetaMarkets 공식 사이트(monetamarkets.com/trading/products/indices)에서 직접 확인함
// - NAS100(Cash): 계약크기 1, 틱당 가치 USD $1. 수수료/스프레드는 계산하지 않음.
const POINT_VALUE_PER_LOT = { GOLD: 100, NASDAQ: 1 }
const DEFAULT_STARTING_BALANCE = 10000

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
  const [speed, setSpeed] = useState(1)
  const [playIndex, setPlayIndex] = useState(0)
  const [total, setTotal] = useState(0)
  const [enabledBands, setEnabledBands] = useState({})
  const [lineVisibility, setLineVisibility] = useState({}) // `${bandId}:${upper|middle|lower}` -> false면 숨김 (기본 true)
  const [bandColors, setBandColors] = useState({}) // bandId -> 커스텀 색상 (없으면 BOLLINGER_BANDS 기본색)
  const [enabledMA, setEnabledMA] = useState({})
  const [maColors, setMaColors] = useState({}) // maId -> 커스텀 색상 (없으면 MOVING_AVERAGES 기본색, 볼린저와 동일)
  const [maWidths, setMaWidths] = useState({}) // maId -> 커스텀 선 굵기 (없으면 MOVING_AVERAGES 기본 lineWidth)
  const [upColor, setUpColorState] = useState(DEFAULT_UP_COLOR)
  const [downColor, setDownColorState] = useState(DEFAULT_DOWN_COLOR)
  const [crossEnabled, setCrossEnabled] = useState({}) // maId -> 크로스 감지 대상 포함 여부
  // 골든크로스(단기선이 장기선을 아래에서 위로 돌파)/데드크로스(그 반대) 표시를 따로 설정
  const [goldenShape, setGoldenShapeState] = useState('arrowUp')
  const [goldenColor, setGoldenColorState] = useState(DEFAULT_GOLDEN_COLOR)
  const [goldenSize, setGoldenSizeState] = useState(1)
  const [deadShape, setDeadShapeState] = useState('arrowDown')
  const [deadColor, setDeadColorState] = useState(DEFAULT_DEAD_COLOR)
  const [deadSize, setDeadSizeState] = useState(1)
  // 매매 연습 - 헤징 허용(바이/셀 동시 보유 가능), 수수료/스프레드는 계산 안 함
  const [startingBalance, setStartingBalanceState] = useState(DEFAULT_STARTING_BALANCE)
  const [balance, setBalance] = useState(DEFAULT_STARTING_BALANCE)
  const [lotSize, setLotSize] = useState(0.01)
  const [positions, setPositions] = useState([]) // { id, side:'buy'|'sell', symbol, lot, entryPrice, entryTime }
  const [pnlDisplay, setPnlDisplay] = useState('dollar') // 'dollar' | 'point'

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
  const crossPointsRef = useRef([])  // 체크한 이평선끼리 교차하는 지점 전체 [{idx, time, type:'golden'|'dead'}]

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
    crossPointsRef.current = []
    seriesRef.current?.setMarkers([])
    setPositions([]) // 심볼이 바뀌면 그 전 심볼 가격 기준 포지션은 의미가 없어짐(체결 없이 그냥 사라짐)
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

  // 크로스 마커도 재생 위치를 앞서가면 안 된다 - 미리 계산해둔 전체 교차점 중
  // 아직 재생 안 지난 구간은 걸러서 캔들 시리즈에 마커로 얹는다.
  // overrides로 넘긴 값만 즉시 반영하고 나머지는 현재 state를 그대로 씀
  // (setState 직후 같은 틱에 호출될 때 클로저가 stale해지는 걸 피하기 위함)
  const applyCrossMarkers = (idx, overrides = {}) => {
    if (!seriesRef.current) return
    const gShape = overrides.goldenShape ?? goldenShape
    const gColor = overrides.goldenColor ?? goldenColor
    const gSize = overrides.goldenSize ?? goldenSize
    const dShape = overrides.deadShape ?? deadShape
    const dColor = overrides.deadColor ?? deadColor
    const dSize = overrides.deadSize ?? deadSize
    const markers = crossPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => p.type === 'golden'
        ? { time: p.time, position: 'belowBar', color: gColor, shape: gShape, size: gSize, text: '' }
        : { time: p.time, position: 'aboveBar', color: dColor, shape: dShape, size: dSize, text: '' })
    seriesRef.current.setMarkers(markers)
  }

  const applyIndex = (idx) => {
    seriesRef.current?.setData(rowsRef.current.slice(0, idx))
    syncBands(idx)
    syncMA(idx)
    applyCrossMarkers(idx)
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
    applyCrossMarkers(to)
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
    crossPointsRef.current = []
    seriesRef.current?.setMarkers([])
    setPositions([]) // 새 날짜를 불러오면 그 전 리플레이의 미체결 포지션은 그냥 사라짐(새 연습 세션)
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
          const vals = computeMA(ma, closes)
          const points = []
          for (let i = startIdx; i < endIdx; i++) {
            points.push(vals[i] != null ? { time: fullRows[i].time, value: vals[i] } : null)
          }
          newMaData[ma.id] = points
        }
        maDataRef.current = newMaData
        refreshCross()
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

  // 커스텀 굵기를 안 골랐으면 MOVING_AVERAGES에 정의된 기본 lineWidth 그대로
  const getMAWidth = (ma) => maWidths[ma.id] || ma.lineWidth

  const setMAWidth = (maId, width) => {
    setMaWidths(prev => ({ ...prev, [maId]: width }))
    maSeriesRef.current[maId]?.applyOptions({ lineWidth: width })
  }

  const resetMAWidth = (ma) => {
    setMaWidths(prev => {
      const next = { ...prev }
      delete next[ma.id]
      return next
    })
    maSeriesRef.current[ma.id]?.applyOptions({ lineWidth: ma.lineWidth })
  }

  const toggleMA = (maId) => {
    const turningOn = !enabledMA[maId]
    setEnabledMA(prev => ({ ...prev, [maId]: turningOn }))

    if (turningOn) {
      if (!maSeriesRef.current[maId] && chartRef.current) {
        const ma = MOVING_AVERAGES.find(m => m.id === maId)
        const color = getMAColor(ma)
        const width = getMAWidth(ma)
        // 각 이평선마다 정의된(또는 커스텀) 굵기 + 실선/점선 스타일 그대로
        maSeriesRef.current[maId] = chartRef.current.addLineSeries({
          color, lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
        })
      }
      applyMAIndex(maId, indexRef.current)
    } else {
      const s = maSeriesRef.current[maId]
      if (s && chartRef.current) chartRef.current.removeSeries(s)
      delete maSeriesRef.current[maId]
    }
  }

  // 체크한 이평선들 중 기간이 짧은 쪽을 단기선, 긴 쪽을 장기선으로 보고
  // 단기선이 장기선을 아래→위로 뚫으면 골든크로스, 위→아래면 데드크로스로 분류해
  // 그날 데이터 전체에서 미리 찾아둔다 (재생 위치 필터링은 applyCrossMarkers가 담당)
  const refreshCross = (enabledMap = crossEnabled) => {
    const ids = MOVING_AVERAGES.map(m => m.id).filter(id => enabledMap[id])
    const maById = Object.fromEntries(MOVING_AVERAGES.map(m => [m.id, m]))
    const points = []
    for (let a = 0; a < ids.length; a++) {
      for (let b = a + 1; b < ids.length; b++) {
        const maA = maById[ids[a]], maB = maById[ids[b]]
        const [fastId, slowId] = maA.period <= maB.period ? [ids[a], ids[b]] : [ids[b], ids[a]]
        const F = maDataRef.current[fastId]
        const S = maDataRef.current[slowId]
        if (!F || !S) continue
        for (let i = 1; i < F.length; i++) {
          const f0 = F[i - 1], f1 = F[i], s0 = S[i - 1], s1 = S[i]
          if (!f0 || !f1 || !s0 || !s1) continue
          const d0 = f0.value - s0.value
          const d1 = f1.value - s1.value
          if (d0 === 0 || (d0 > 0) === (d1 > 0)) continue
          points.push({ idx: i, time: f1.time, type: d1 > 0 ? 'golden' : 'dead' })
        }
      }
    }
    points.sort((p, q) => p.idx - q.idx)
    crossPointsRef.current = points
    applyCrossMarkers(indexRef.current)
  }

  const toggleCross = (maId) => {
    setCrossEnabled(prev => {
      const next = { ...prev, [maId]: !prev[maId] }
      refreshCross(next)
      return next
    })
  }

  const setGoldenShape = (v) => { setGoldenShapeState(v); applyCrossMarkers(indexRef.current, { goldenShape: v }) }
  const setGoldenColor = (v) => { setGoldenColorState(v); applyCrossMarkers(indexRef.current, { goldenColor: v }) }
  const setGoldenSize = (v) => { setGoldenSizeState(v); applyCrossMarkers(indexRef.current, { goldenSize: v }) }
  const setDeadShape = (v) => { setDeadShapeState(v); applyCrossMarkers(indexRef.current, { deadShape: v }) }
  const setDeadColor = (v) => { setDeadColorState(v); applyCrossMarkers(indexRef.current, { deadColor: v }) }
  const setDeadSize = (v) => { setDeadSizeState(v); applyCrossMarkers(indexRef.current, { deadSize: v }) }

  const play = () => {
    if (!rowsRef.current.length) return
    if (indexRef.current >= rowsRef.current.length) applyIndex(0)
    setPlaying(true)
  }

  useEffect(() => {
    if (!playing) return
    // 이상적인 간격(실제 1분 ÷ 배속)이 브라우저 타이머 하한보다 짧아지면,
    // 틱 간격은 하한에 고정하고 그 틱마다 여러 캔들을 진행시켜 같은 체감 속도를 낸다.
    const idealMs = REALTIME_MS / speed
    const tickMs = Math.max(MIN_TICK_MS, idealMs)
    const candlesPerTick = Math.max(1, Math.round(speed * tickMs / REALTIME_MS))
    intervalRef.current = setInterval(() => {
      const from = indexRef.current
      const to = Math.min(from + candlesPerTick, rowsRef.current.length)
      applyIncrement(from, to)
      if (to >= rowsRef.current.length) stopPlayback()
    }, tickMs)
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

  // 재생으로 지금까지 드러난 마지막 캔들 종가 - 아직 재생 안 지난 미래 가격으로 체결/청산하면 안 되니 진입가 기준은 항상 이거
  const currentPrice = playIndex > 0 ? rowsRef.current[playIndex - 1]?.close ?? null : null

  const calcPnl = (pos, price) => {
    const pointValue = POINT_VALUE_PER_LOT[pos.symbol] || 0
    const points = pos.side === 'buy' ? price - pos.entryPrice : pos.entryPrice - price
    return { points, dollars: points * pos.lot * pointValue }
  }

  const openPosition = (side) => {
    if (currentPrice == null) return
    setPositions(prev => [...prev, {
      id: `${Date.now()}_${Math.random()}`,
      side, symbol, lot: lotSize, entryPrice: currentPrice,
      entryTime: rowsRef.current[playIndex - 1].time,
    }])
  }

  const closePosition = (id) => {
    const pos = positions.find(p => p.id === id)
    if (!pos) return
    if (currentPrice != null) {
      const { dollars } = calcPnl(pos, currentPrice)
      setBalance(b => b + dollars)
    }
    setPositions(prev => prev.filter(p => p.id !== id))
  }

  const applyStartingBalance = (value) => {
    const v = Math.max(0, Number(value) || 0)
    setStartingBalanceState(v)
    setBalance(v)
  }

  const nudgeLot = (delta) => {
    setLotSize(l => Math.max(0.01, Math.round((l + delta) * 100) / 100))
  }

  // 골든/데드크로스 설정 행 하나를 그리는 헬퍼(둘 다 같은 구조라 중복 방지)
  const renderCrossRow = (title, shape, setShape, color, setColor, size, setSize) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ fontSize: 10, color: '#9aa0ab', marginBottom: 4 }}>{title}</div>
      <div style={{ display: 'flex', gap: 4, marginBottom: 4 }}>
        {CROSS_SHAPES.map(s => (
          <button
            key={s.id}
            type="button"
            onClick={() => setShape(s.id)}
            title={s.id}
            style={{
              flex: 1, fontSize: 13, padding: '3px 0', borderRadius: 6,
              border: `1px solid ${shape === s.id ? color : '#2a2e38'}`,
              background: shape === s.id ? `${color}22` : 'none',
              color: shape === s.id ? color : '#9aa0ab',
              cursor: 'pointer',
            }}
          >{s.label}</button>
        ))}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <input
          type="color"
          value={color}
          onChange={e => setColor(e.target.value)}
          title="색상변경 가능"
          style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
        />
        <div style={{ display: 'flex', gap: 3, flex: 1 }}>
          {CROSS_SIZES.map(sz => (
            <button
              key={sz}
              type="button"
              onClick={() => setSize(sz)}
              title={`크기 ${sz}`}
              style={{
                flex: 1, fontSize: 10, padding: '2px 0', borderRadius: 5,
                border: `1px solid ${size === sz ? color : '#2a2e38'}`,
                background: size === sz ? `${color}22` : 'none',
                color: size === sz ? color : '#5a5f6a',
                cursor: 'pointer',
              }}
            >{sz}</button>
          ))}
        </div>
      </div>
    </div>
  )

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
                  const isCustomColor = !!maColors[ma.id]
                  const width = getMAWidth(ma)
                  const isCustomWidth = !!maWidths[ma.id]
                  return (
                    <div key={ma.id} style={{ padding: '1px 0' }}>
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
                      {on && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 19, marginTop: 3 }}>
                          {MA_WIDTHS.map(w => (
                            <button
                              key={w}
                              type="button"
                              onClick={() => setMAWidth(ma.id, w)}
                              title={`굵기 ${w}`}
                              style={{
                                fontSize: 10, padding: '2px 6px', borderRadius: 5,
                                border: `1px solid ${width === w ? color : '#2a2e38'}`,
                                background: width === w ? `${color}22` : 'none',
                                color: width === w ? color : '#5a5f6a',
                                cursor: 'pointer',
                              }}
                            >{w}</button>
                          ))}
                          {isCustomColor && (
                            <button
                              type="button"
                              onClick={() => resetMAColor(ma)}
                              title="기본 색상으로"
                              style={{ fontSize: 10, color: '#5a5f6a', background: 'none', border: 'none', cursor: 'pointer', marginLeft: 'auto' }}
                            >색↺</button>
                          )}
                          {isCustomWidth && (
                            <button
                              type="button"
                              onClick={() => resetMAWidth(ma)}
                              title="기본 굵기로"
                              style={{ fontSize: 10, color: '#5a5f6a', background: 'none', border: 'none', cursor: 'pointer' }}
                            >굵↺</button>
                          )}
                        </div>
                      )}
                    </div>
                  )
                })}
              </CollapsibleCard>

              <CollapsibleCard title="크로스" maxWidth={170}>
                {renderCrossRow('골든크로스', goldenShape, setGoldenShape, goldenColor, setGoldenColor, goldenSize, setGoldenSize)}
                {renderCrossRow('데드크로스', deadShape, setDeadShape, deadColor, setDeadColor, deadSize, setDeadSize)}
                {MOVING_AVERAGES.map(ma => (
                  <label key={ma.id} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer', padding: '1px 0' }}>
                    <input
                      type="checkbox"
                      checked={!!crossEnabled[ma.id]}
                      onChange={() => toggleCross(ma.id)}
                      style={{ width: 13, height: 13, margin: 0, accentColor: ma.color, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>{ma.label}</span>
                  </label>
                ))}
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

              <div style={{ display: 'flex', alignItems: 'center', marginTop: 16 }}>
                <span style={{ color: '#9aa0ab', fontSize: 13 }}>{playIndex.toLocaleString()} / {total.toLocaleString()}봉</span>
              </div>
              <input
                type="range" min={0} max={total || 0} value={playIndex}
                onChange={e => scrub(Number(e.target.value))}
                disabled={!total}
                style={{ width: '100%', marginTop: 6 }}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={playing ? stopPlayback : play} disabled={!total} style={{
                  background: '#4CAF50', color: '#fff', border: 'none', borderRadius: 9,
                  padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: total ? 'pointer' : 'not-allowed', opacity: total ? 1 : 0.5,
                }}>{playing ? '⏸ 일시정지' : '▶ 재생'}</button>

                <button onClick={reset} disabled={!total} style={{
                  background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '10px 16px', fontSize: 14, cursor: total ? 'pointer' : 'not-allowed',
                }}>⏮ 처음부터</button>

                {SPEEDS.map(s => {
                  const secs = REALTIME_MS / s / 1000
                  const secsLabel = secs >= 60 ? `${(secs / 60).toFixed(secs % 60 === 0 ? 0 : 1)}분` : `${secs.toFixed(secs % 1 === 0 ? 0 : 1)}초`
                  return (
                    <button key={s} onClick={() => setSpeed(s)} title={`캔들 1개 = ${secsLabel}`} style={{
                      background: speed === s ? '#2a2e38' : 'none', color: speed === s ? '#e8eaed' : '#9aa0ab',
                      border: '1px solid #2a2e38', borderRadius: 9, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                    }}>x{s}</button>
                  )
                })}
              </div>
              <div style={{ fontSize: 11, color: '#5a5f6a', marginTop: 4 }}>
                x1 = 1분당 캔들 1개 (실제 시세 속도). 배속은 그 배수 — x2=30초/캔들, x60=1초/캔들
              </div>

              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, marginTop: 16 }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9aa0ab' }}>
                    시작 자금
                    <input
                      type="number" min={0} value={startingBalance}
                      onChange={e => applyStartingBalance(e.target.value)}
                      style={{ width: 100, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '5px 8px', fontSize: 13 }}
                    />
                    USD
                  </label>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>
                    잔고: ${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                  </div>
                  <div style={{ display: 'flex', gap: 4, marginLeft: 'auto' }}>
                    {[['dollar', '달러'], ['point', '포인트']].map(([mode, label]) => (
                      <button
                        key={mode}
                        type="button"
                        onClick={() => setPnlDisplay(mode)}
                        style={{
                          fontSize: 12, padding: '5px 10px', borderRadius: 7,
                          border: `1px solid ${pnlDisplay === mode ? '#4CAF50' : '#2a2e38'}`,
                          background: pnlDisplay === mode ? 'rgba(76,175,80,0.15)' : 'none',
                          color: pnlDisplay === mode ? '#4CAF50' : '#9aa0ab', cursor: 'pointer',
                        }}
                      >{label}</button>
                    ))}
                  </div>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, color: '#9aa0ab' }}>랏수</span>
                    <button type="button" onClick={() => nudgeLot(-0.01)} style={{ width: 26, height: 26, background: 'none', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', cursor: 'pointer' }}>-</button>
                    <input
                      type="number" step={0.01} min={0.01} value={lotSize}
                      onChange={e => setLotSize(Math.max(0.01, Number(e.target.value) || 0.01))}
                      style={{ width: 64, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '5px 6px', fontSize: 13, textAlign: 'center' }}
                    />
                    <button type="button" onClick={() => nudgeLot(0.01)} style={{ width: 26, height: 26, background: 'none', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', cursor: 'pointer' }}>+</button>
                  </div>

                  <button
                    type="button" onClick={() => openPosition('buy')} disabled={currentPrice == null}
                    style={{
                      background: '#26a69a', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700,
                      padding: '9px 22px', fontSize: 14, cursor: currentPrice == null ? 'not-allowed' : 'pointer', opacity: currentPrice == null ? 0.5 : 1,
                    }}
                  >BUY</button>
                  <button
                    type="button" onClick={() => openPosition('sell')} disabled={currentPrice == null}
                    style={{
                      background: '#ef5350', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700,
                      padding: '9px 22px', fontSize: 14, cursor: currentPrice == null ? 'not-allowed' : 'pointer', opacity: currentPrice == null ? 0.5 : 1,
                    }}
                  >SELL</button>

                  <span style={{ fontSize: 11, color: '#5a5f6a' }}>
                    {symbol === 'GOLD' ? '골드 1랏 = 1.00pt당 $100' : '나스닥 1랏 = 1.00pt당 $1'} (수수료 미반영)
                  </span>
                </div>

                {positions.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid #2a2e38', paddingTop: 8 }}>
                    {positions.map(pos => {
                      const { points, dollars } = currentPrice != null ? calcPnl(pos, currentPrice) : { points: 0, dollars: 0 }
                      const profit = dollars >= 0
                      return (
                        <div key={pos.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5 }}>
                          <span style={{ color: pos.side === 'buy' ? '#26a69a' : '#ef5350', fontWeight: 700, width: 36 }}>
                            {pos.side === 'buy' ? 'BUY' : 'SELL'}
                          </span>
                          <span style={{ color: '#9aa0ab' }}>{pos.lot.toFixed(2)}랏</span>
                          <span style={{ color: '#9aa0ab' }}>진입 {pos.entryPrice.toFixed(2)}</span>
                          <span style={{ color: profit ? '#26a69a' : '#ef5350', fontWeight: 700, marginLeft: 'auto' }}>
                            {currentPrice == null ? '—' : pnlDisplay === 'dollar'
                              ? `${profit ? '+' : ''}$${dollars.toFixed(2)}`
                              : `${points >= 0 ? '+' : ''}${points.toFixed(2)}pt`}
                          </span>
                          <button
                            type="button" onClick={() => closePosition(pos.id)}
                            style={{ fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', cursor: 'pointer' }}
                          >청산</button>
                        </div>
                      )
                    })}
                  </div>
                )}
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
