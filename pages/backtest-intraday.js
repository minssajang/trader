
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'
const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
// 사용자가 직접 고른 날짜별 색상 - 순서대로 고정 팔레트를 돌려써서 차트 선과 왼쪽 날짜 칩의 색이 항상 일치하게 한다
const DAY_COLORS = ['#4FC3F7', '#FFB74D', '#BA68C8', '#81C784', '#F06292', '#FFD54F', '#4DB6AC', '#E57373']
function dayColor(i) { return DAY_COLORS[i % DAY_COLORS.length] }

// 하루 전체(0~1439분)를 한 화면에 우겨넣지 않고, 트레이딩뷰처럼 드래그로 좌우 이동 + 휠로 확대/축소한다
// (사용자 요청 - 아래 슬라이드바 대신 차트를 직접 끌고 스크롤하는 방식).
const DEFAULT_WINDOW_MIN = 12 * 60 // 처음엔 12시간만 보이게 시작
const MIN_WINDOW_MIN = 60   // 최대로 확대하면 1시간까지만
const MAX_WINDOW_MIN = 24 * 60 // 최대로 축소하면 하루 전체

// 한국 시간 기준 실제 거래 시작은 00:00이 아니라 07:00(브로커 01시=한국 07시, candleCsv.js 오프셋
// 규칙 참고) - x축(00:00~23:59)은 그대로 두고, 시가(0선) 기준만 07:00 시점 가격으로 삼는다(사용자 요청).
const REFERENCE_MIN = 7 * 60 // 07:00

// "시간대별 변동성 분석" 막대그래프의 세분화 단위 - 1시간 하나로는 뭉뚱그려져서 15분 단위(1시간=4칸)로
// 쪼개달라는 요청(사용자)에 맞춘 것. 하루 24시간 = 96개 15분 버킷.
const MINUTES_PER_BUCKET = 15
const BUCKETS_PER_HOUR = 60 / MINUTES_PER_BUCKET
const TOTAL_BUCKETS = 24 * BUCKETS_PER_HOUR

// 세계 3대 시장 개장 시각 - backtest-chart.js와 동일한 시간 라벨(브로커 서버+서머타임 오프셋) 기준
// 분(minute-of-day). 유럽(런던)은 서머타임(BST) 기준 07:00 UTC=16:00 이 라벨(겨울엔 17:00).
const SESSION_OPENS = [
  { label: '아시아', minute: 7 * 60, color: '#64B5F6' },
  { label: '유럽', minute: 16 * 60, color: '#FFD54F' },
  { label: '미장', minute: 22 * 60 + 30, color: '#BA68C8' },
]

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
  const [hoverInfo, setHoverInfo] = useState(null) // {minute, avg, up, down}
  // 달력에서 클릭해서 고른 날짜들만 겹쳐 그린다 - 처음엔 아무것도 안 골랐으니 차트가 비어있다
  // (예전엔 그 달 전체를 자동으로 다 그렸는데, "왜 선이 미리 그려져 있냐"는 피드백으로 사용자가
  // 직접 고른 날짜만 그리는 방식으로 바꿈)
  const [selectedDates, setSelectedDates] = useState([])
  // 평균선은 기본으로 자동으로 안 그리고, 이 버튼을 켜야만 그린다(사용자 요청 - 시키지 않은 걸
  // 자동으로 하지 말고 옵션 버튼으로 빼둘 것)
  const [showAverage, setShowAverage] = useState(false)
  // 지금 보고 있는 구간 - 드래그(팬)로 시작 위치를, 휠(줌)로 폭을 바꾼다
  const [windowStart, setWindowStart] = useState(0)
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW_MIN)
  // 지금 마우스가 어느 영역(본문/y축/x축) 위에 있는지에 따라 커서 모양을 바꿔서 뭘 할 수 있는지 알려준다
  const [cursorStyle, setCursorStyle] = useState('grab')
  // "시간대별 변동성 분석" 버튼 결과 - null(아직 안 돌림) | {ranked, dayCount, missingBuckets} | {error}
  const [hourlyAnalysis, setHourlyAnalysis] = useState(null)

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const dragRef = useRef(null) // {startClientX, startWindowStart} - 드래그 중일 때만 값이 있음
  const datasetCacheRef = useRef({}) // dataset.id -> parsed rows(전체) 캐시
  const dayRowsRef = useRef({}) // date -> 그 날의 원본 캔들 행(open/high/low/close/time) - "시간대별 변동성 분석"에서 씀

  useEffect(() => {
    let ignore = false
    fetch(`/api/backtest-datasets-public?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => { if (!ignore) setDatasets(d.rows || []) })
      .catch(() => { if (!ignore) setDatasets([]) })
    return () => { ignore = true }
  }, [symbol])

  // 심볼이 바뀌면 이전 심볼 기준으로 돌려둔 분석 결과는 더 이상 유효하지 않으니 지운다
  useEffect(() => { setHourlyAnalysis(null) }, [symbol])

  const navigateMonth = (delta) => setViewMonth(v => new Date(v.getFullYear(), v.getMonth() + delta, 1))
  const availableDates = useMemo(() => buildAvailableDates(datasets), [datasets])

  useEffect(() => {
    let ignore = false
    const y = viewMonth.getFullYear(), m = viewMonth.getMonth()
    const monthStart = `${y}-${String(m + 1).padStart(2, '0')}-01`
    const monthEnd = `${y}-${String(m + 1).padStart(2, '0')}-31`

    // 데이터 파일들이 서로 겹치는 구간이 많아서(예: "5/29~7/1"과 "6/29~7/29" 둘 다 7월 일부를 포함),
    // 그냥 첫 번째로 겹치는 파일을 고르면 날짜 범위(date_from ascending 정렬)상 먼저 오는 쪽이 뽑혀서
    // 실제로는 그 달 극히 일부만 담긴 파일이 선택되는 버그가 있었다 - 겹치는 파일들 중 그 달을 가장
    // 많이 담고 있는(date_to가 가장 늦은) 파일을 고르도록 수정.
    const overlapping = datasets.filter(d => d.date_from <= monthEnd && d.date_to >= monthStart)
    const ds = overlapping.length
      ? overlapping.reduce((best, d) => (d.date_to > best.date_to ? d : best))
      : null
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
        const nextDayRows = {}
        for (const [date, rows] of [...byDate.entries()].sort()) {
          // 완전한 하루가 아니어도(데이터 경계에 걸려 일부 시간대만 있어도) 있는 부분만 그린다.
          // 시가(0선) 기준은 07:00 시점 가격 - 정확히 07:00 캔들이 있으면 그걸 쓰고, 없으면(경계에
          // 걸려 07:00 근처가 비어있으면) 그날 안에서 07:00에 가장 가까운 캔들로 대체한다.
          let refRow = null, refDist = Infinity
          for (const r of rows) {
            const d = new Date(r.time * 1000)
            const dist = Math.abs((d.getHours() * 60 + d.getMinutes()) - REFERENCE_MIN)
            if (dist < refDist) { refRow = r; refDist = dist }
          }
          // .open이 아니라 .close를 기준으로 삼아야, 모든 점을 "그 캔들의 close - 기준"으로 계산할 때
          // 07:00 캔들 자기 자신의 점도 정확히 0이 된다(그래야 겹쳐 그린 모든 날짜가 07:00에서 전부
          // 같은 점(0)에서 만난다 - 사용자 확인).
          const dayOpen = (refRow || rows[0]).close
          const points = rows.map(r => {
            const d = new Date(r.time * 1000)
            const minutes = d.getHours() * 60 + d.getMinutes()
            return [minutes, Math.round((r.close - dayOpen) * 100) / 100]
          })
          nextDays.push({ date, points })
          nextDayRows[date] = rows // "시간대별 변동성 분석"은 편차가 아니라 원본 high/low/close가 필요해서 따로 보관
        }
        if (!ignore) {
          setDays(nextDays)
          dayRowsRef.current = nextDayRows
          setSelectedDates([]) // 달/심볼이 바뀌면 이전에 골라둔 날짜는 더 이상 유효하지 않을 수 있으니 초기화
          setHourlyAnalysis(null)
          if (nextDays.length === 0) setError('이 달엔 완전한 거래일 데이터가 없습니다')
        }
      } catch (e) {
        if (!ignore) { setError(e.message); setDays([]) }
      }
      if (!ignore) setLoading(false)
    })()

    return () => { ignore = true }
  }, [viewMonth, datasets])

  // 실제로 그릴 대상 = 달력에서 고른 날짜들만(days 전체가 아니라)
  const selectedSeries = useMemo(
    () => days.filter(d => selectedDates.includes(d.date)),
    [days, selectedDates]
  )

  // 달력에서 고른 날짜별로 다른 색을 쓰고, 그 색을 달력 강조에도 그대로 넘긴다(선-달력 색 일치)
  const dateColors = useMemo(
    () => Object.fromEntries(selectedDates.map((d, i) => [d, dayColor(i)])),
    [selectedDates]
  )

  // y축 범위는 지금 보이는 구간 안의 값만 기준으로 자동으로 잡되, y축 위에서 세로로 드래그하면
  // yZoom 배율만큼 그 자동 범위를 더 늘리거나 줄인다(사용자 요청 - y축 잡고 드래그하면 위아래 확대/축소).
  const windowEnd = windowStart + windowSize - 1
  const [yZoom, setYZoom] = useState(1)
  const { yLo: baseYLo, yHi: baseYHi } = useMemo(() => {
    let lo = Infinity, hi = -Infinity
    for (const d of selectedSeries) {
      for (const [mnt, v] of d.points) {
        if (mnt < windowStart || mnt > windowEnd) continue
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
    }
    if (!Number.isFinite(lo)) return { yLo: -1, yHi: 1 }
    const pad = (hi - lo) * 0.08 || 1
    return { yLo: lo - pad, yHi: hi + pad }
  }, [selectedSeries, windowStart, windowEnd])
  const { yLo, yHi } = useMemo(() => {
    const center = (baseYLo + baseYHi) / 2
    const halfRange = (baseYHi - baseYLo) / 2 / yZoom
    return { yLo: center - halfRange, yHi: center + halfRange }
  }, [baseYLo, baseYHi, yZoom])

  // "평균선 표시" 버튼을 켰을 때만 계산 - 기본은 안 켜져 있으니 매번 계산 안 해도 됨
  const avgMap = useMemo(() => {
    if (!showAverage || selectedSeries.length < 2) return new Map()
    const sums = new Map()
    for (const d of selectedSeries) {
      for (const [mnt, v] of d.points) {
        const e = sums.get(mnt) || { s: 0, n: 0 }
        e.s += v; e.n += 1
        sums.set(mnt, e)
      }
    }
    return new Map([...sums.entries()].map(([mnt, e]) => [mnt, e.s / e.n]))
  }, [showAverage, selectedSeries])
  const avgSeries = useMemo(() => [...avgMap.entries()].sort((a, b) => a[0] - b[0]), [avgMap])

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

    const px = mnt => 56 + (mnt - windowStart) / (windowSize - 1) * (W - 56 - 20)
    const py = v => 16 + (1 - (v - yLo) / (yHi - yLo)) * (H - 16 - 34)
    const inWindow = mnt => mnt >= windowStart && mnt <= windowEnd

    ctx.clearRect(0, 0, W, H)
    if (selectedSeries.length === 0) {
      ctx.fillStyle = '#5a5f6a'
      ctx.font = '13px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
      ctx.textAlign = 'center'
      ctx.fillText('왼쪽 달력에서 날짜를 클릭해 겹쳐볼 날짜를 골라주세요', W / 2, H / 2)
      return
    }

    ctx.font = '11px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
    ctx.strokeStyle = '#232733'
    ctx.fillStyle = '#9aa0ab'
    // 확대할수록(구간이 좁을수록) 1시간 간격, 축소할수록(구간이 넓을수록) 라벨이 겹치지 않게 2시간 간격
    const hourStep = windowSize / 60 > 12 ? 2 : 1
    const firstHour = Math.ceil(windowStart / 60 / hourStep) * hourStep
    const lastHour = Math.floor(windowEnd / 60)
    for (let h = firstHour; h <= lastHour; h += hourStep) {
      const x = px(h * 60)
      ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, H - 34); ctx.stroke()
      ctx.textAlign = 'center'
      ctx.fillText(`${String(h % 24).padStart(2, '0')}:00`, x, H - 16)
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
    ctx.fillText('시가(07:00, 0)', 58, zeroY - 5)

    // 세계 3대 시장 개장 시각 - 지금 보이는 구간 안에 있을 때만 세로 점선 + 라벨로 표시
    ctx.font = '10px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
    for (const session of SESSION_OPENS) {
      if (!inWindow(session.minute)) continue
      const sx = px(session.minute)
      ctx.strokeStyle = session.color
      ctx.globalAlpha = 0.5
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(sx, 16); ctx.lineTo(sx, H - 34); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      ctx.fillStyle = session.color
      ctx.textAlign = 'center'
      ctx.fillText(session.label, sx, 27)
    }

    // 고른 날짜들만, 지금 보이는 12시간 구간에 해당하는 부분만 그린다
    const n = selectedSeries.length
    selectedSeries.forEach((d, i) => {
      ctx.strokeStyle = dayColor(i)
      ctx.lineWidth = 1.8
      ctx.beginPath()
      let started = false
      d.points.forEach(([mnt, v]) => {
        if (!inWindow(mnt)) return
        const x = px(mnt), y = py(v)
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      })
      ctx.stroke()
    })

    if (showAverage && n >= 2) {
      ctx.strokeStyle = '#e8eaed'
      ctx.lineWidth = 2.6
      ctx.setLineDash([6, 4])
      ctx.beginPath()
      let started = false
      avgSeries.forEach(([mnt, v]) => {
        if (!inWindow(mnt)) return
        const x = px(mnt), y = py(v)
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      })
      ctx.stroke()
      ctx.setLineDash([])
    }

    if (hoverInfo && inWindow(hoverInfo.minute)) {
      const hx = px(hoverInfo.minute)
      ctx.strokeStyle = '#e8eaed'
      ctx.globalAlpha = 0.35
      ctx.beginPath(); ctx.moveTo(hx, 16); ctx.lineTo(hx, H - 34); ctx.stroke()
      ctx.globalAlpha = 1
    }
  }, [selectedSeries, yLo, yHi, avgSeries, showAverage, hoverInfo, windowStart, windowEnd, windowSize])

  useEffect(() => {
    draw()
    const onResize = () => draw()
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [draw])

  const updateHoverForMinute = (minute) => {
    if (selectedSeries.length === 0) return
    let up = 0, down = 0
    for (const d of selectedSeries) {
      const p = d.points.find(([mnt]) => mnt === minute)
      if (p) { if (p[1] >= 0) up++; else down++ }
    }
    setHoverInfo({ minute, avg: avgMap.get(minute), up, down })
  }

  // 트레이딩뷰처럼 영역별로 드래그 동작이 다르다(사용자 요청):
  //  - 가운데(차트 본문)를 잡고 끌면 좌우 이동(팬)
  //  - 왼쪽 y축(가격 라벨) 위를 잡고 위아래로 끌면 세로 확대/축소
  //  - 아래쪽 x축(시간 라벨) 위를 잡고 좌우로 끌면 가로 확대/축소(휠과 같은 효과, 드래그로도 가능하게)
  const AXIS_LEFT = 56, AXIS_BOTTOM = 34

  const onMouseDown = (e) => {
    if (selectedSeries.length === 0) return
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    let mode = 'pan'
    if (mx < AXIS_LEFT) mode = 'yzoom'
    else if (my > rect.height - AXIS_BOTTOM) mode = 'xzoom'
    dragRef.current = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWindowStart: windowStart,
      startWindowSize: windowSize,
      startYZoom: yZoom,
    }
    setCursorStyle(mode === 'yzoom' ? 'ns-resize' : mode === 'xzoom' ? 'ew-resize' : 'grabbing')
  }

  const onMouseUp = () => {
    dragRef.current = null
    setCursorStyle('grab')
  }

  const onMouseMove = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    const rect = canvas.getBoundingClientRect()
    const plotW = rect.width - AXIS_LEFT - 20
    const drag = dragRef.current

    if (drag) {
      if (drag.mode === 'pan') {
        const deltaPx = e.clientX - drag.startClientX
        const deltaMin = -(deltaPx / plotW) * windowSize
        const maxStart = Math.max(0, 1440 - windowSize)
        setWindowStart(Math.max(0, Math.min(maxStart, Math.round(drag.startWindowStart + deltaMin))))
      } else if (drag.mode === 'yzoom') {
        // 위로 끌면 확대, 아래로 끌면 축소
        const deltaPx = e.clientY - drag.startClientY
        const factor = Math.exp(-deltaPx / 150)
        setYZoom(Math.max(0.2, Math.min(8, drag.startYZoom * factor)))
      } else if (drag.mode === 'xzoom') {
        // 오른쪽으로 끌면 확대(구간 좁아짐), 왼쪽으로 끌면 축소 - 지금 보이는 구간 중심은 고정
        const deltaPx = e.clientX - drag.startClientX
        const factor = Math.exp(-deltaPx / 150)
        const center = drag.startWindowStart + drag.startWindowSize / 2
        const nextSize = Math.max(MIN_WINDOW_MIN, Math.min(MAX_WINDOW_MIN, Math.round(drag.startWindowSize * factor)))
        const maxStart = Math.max(0, 1440 - nextSize)
        setWindowSize(nextSize)
        setWindowStart(Math.max(0, Math.min(maxStart, Math.round(center - nextSize / 2))))
      }
      setHoverInfo(null)
      return
    }

    // 드래그 중이 아닐 땐 지금 위치가 어느 영역인지에 따라 커서 모양만 바꿔서 "여길 잡으면 뭘 할 수 있는지" 알려준다
    const mx = e.clientX - rect.left
    const my = e.clientY - rect.top
    if (mx < AXIS_LEFT) { setCursorStyle('ns-resize'); setHoverInfo(null); return }
    if (my > rect.height - AXIS_BOTTOM) { setCursorStyle('ew-resize'); setHoverInfo(null); return }
    setCursorStyle('grab')

    if (selectedSeries.length === 0) return
    if (mx > rect.width - 20) { setHoverInfo(null); return }
    const t = (mx - AXIS_LEFT) / plotW
    const minute = Math.max(windowStart, Math.min(windowEnd, Math.round(windowStart + t * (windowSize - 1))))
    updateHoverForMinute(minute)
  }

  // 마우스 휠로도 확대/축소 - 마우스 커서가 가리키는 시각을 고정한 채로 구간 폭(windowSize)만 줄이거나 늘린다
  const onWheel = (e) => {
    const canvas = canvasRef.current
    if (!canvas) return
    e.preventDefault()
    const rect = canvas.getBoundingClientRect()
    const plotW = rect.width - AXIS_LEFT - 20
    const mx = e.clientX - rect.left
    const t = Math.max(0, Math.min(1, (mx - AXIS_LEFT) / plotW))
    const cursorMinute = windowStart + t * (windowSize - 1)
    const factor = e.deltaY > 0 ? 1.15 : 1 / 1.15
    const nextSize = Math.max(MIN_WINDOW_MIN, Math.min(MAX_WINDOW_MIN, Math.round(windowSize * factor)))
    const maxStart = Math.max(0, 1440 - nextSize)
    const nextStart = Math.max(0, Math.min(maxStart, Math.round(cursorMinute - t * (nextSize - 1))))
    setWindowSize(nextSize)
    setWindowStart(nextStart)
  }

  // 드래그 도중 마우스가 캔버스 밖으로 나가서 놓일 수도 있으니 window 전체에 mouseup을 걸어둔다
  useEffect(() => {
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  const fmtHM = (mnt) => `${String(Math.floor((mnt % 1440 + 1440) % 1440 / 60)).padStart(2, '0')}:${String(mnt % 60).padStart(2, '0')}`

  // 달력 클릭 = 그 날짜를 선택 목록에 넣거나 뺀다(토글). availableDates는 데이터셋 범위 전체 기준이라
  // 주말이나 (경계에 걸려 잘려서) 오버레이에서 빠진 날도 "데이터 있음"으로 클릭 가능하게 나올 수 있어서,
  // 실제로 days 안에 있는(완전한 거래일인) 날짜만 선택 가능하게 막는다.
  const handleDayClick = (dateStr) => {
    if (!days.some(d => d.date === dateStr)) {
      setError('이 날짜는 완전한 거래일이 아니라 겹쳐볼 수 없습니다(주말이거나 캔들 수 부족)')
      return
    }
    setError('')
    setSelectedDates(prev => prev.includes(dateStr) ? prev.filter(d => d !== dateStr) : [...prev, dateStr].sort())
  }

  // "⏱ 시간대별 변동성 분석" - 지금 왼쪽 달력에서 클릭해서 고른 날짜들(selectedDates, 위 오버레이
  // 차트에 그려지는 바로 그 날짜들)만 대상으로, 하루 중 어느 15분 구간에 변동이 몰리는지 계산한다 -
  // "24시간 중 언제 자리를 지키고 있어야 하는지" 물어본 데서 나온 기능. 처음엔 1시간 단위(24칸)로
  // 만들었는데 "1시간은 너무 뭉뚱그려진다, 15분에 하나씩(1시간=4칸)으로 쪼개달라"는 요청으로 96개
  // 15분 버킷 단위로 세분화함. 원본 행(dayRowsRef)은 편차가 아니라 실제 open/high/low/close라
  // 이 계산에 필요한 레인지(고가-저가)·직전 종가 대비 변동폭을 그대로 쓸 수 있다.
  // 지표: 그 15분 구간 1분봉들의 (종가 - 직전 종가) 절대값을 하루 안에서만 누적한 값 - 고른 날짜 전체의
  // 총 변동 중 이 구간이 차지하는 비중(%)으로 순위를 매긴다.
  const runHourlyAnalysis = useCallback(() => {
    if (selectedDates.length === 0) return

    const bucketRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const bucketRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    const bucketMoveSum = new Array(TOTAL_BUCKETS).fill(0)

    for (const date of selectedDates) {
      const rows = dayRowsRef.current[date]
      if (!rows || rows.length === 0) continue
      let prevClose = null
      for (const r of rows) {
        const d = new Date(r.time * 1000)
        const idx = d.getHours() * BUCKETS_PER_HOUR + Math.floor(d.getMinutes() / MINUTES_PER_BUCKET)
        bucketRangeSum[idx] += r.high - r.low
        bucketRangeCnt[idx] += 1
        if (prevClose != null) bucketMoveSum[idx] += Math.abs(r.close - prevClose)
        prevClose = r.close
      }
    }

    const grandTotal = bucketMoveSum.reduce((a, b) => a + b, 0)
    const missingBuckets = []
    const ranked = []
    for (let idx = 0; idx < TOTAL_BUCKETS; idx++) {
      if (bucketRangeCnt[idx] === 0) { missingBuckets.push(idx); continue }
      ranked.push({
        bucket: idx,
        sharePct: grandTotal ? (bucketMoveSum[idx] / grandTotal * 100) : 0,
        avgRange: bucketRangeSum[idx] / bucketRangeCnt[idx],
      })
    }
    ranked.sort((a, b) => b.sharePct - a.sharePct)
    setHourlyAnalysis({ ranked, dayCount: selectedDates.length, missingBuckets })
  }, [selectedDates])

  // 고른 날짜 목록이 바뀌면(날짜 추가/제거, 전체 지우기) 이전 분석 결과는 더 이상 지금 선택과
  // 안 맞으니 지운다 - 버튼을 다시 눌러야 최신 선택 기준으로 갱신됨
  useEffect(() => { setHourlyAnalysis(null) }, [selectedDates])

  const finalDevs = selectedSeries.map(d => d.points[d.points.length - 1][1])
  const upDays = finalDevs.filter(v => v > 0).length
  const avgFinal = finalDevs.length ? finalDevs.reduce((a, b) => a + b, 0) / finalDevs.length : 0
  const maxAbs = selectedSeries.length ? Math.max(...selectedSeries.flatMap(d => d.points.map(p => Math.abs(p[1])))) : 0

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
            왼쪽 달력에서 날짜를 하나씩 클릭해서 겹쳐볼 날짜를 골라주세요. 고른 날짜의 종가에서 그날 시가(한국시간 07:00 기준 - 실제 거래 시작 시점)를 뺀 값을 시간대별로 겹쳐 그립니다 - 0선이 07:00 가격입니다. 차트를 드래그하면 좌우로 이동하고, 마우스 휠로 확대/축소할 수 있습니다.
          </p>

          {/* 하루 24시간(15분 단위 96칸) 중 언제 변동이 몰리는지(=언제 자리를 지키고 있어야 하는지) 별도 분석 */}
          <div style={{ marginBottom: 20 }}>
            <button
              type="button"
              onClick={runHourlyAnalysis}
              disabled={selectedDates.length === 0}
              style={{
                background: 'none', border: '1px solid #4CAF50', color: '#4CAF50', borderRadius: 9,
                padding: '9px 16px', fontSize: 13, fontWeight: 700,
                cursor: selectedDates.length === 0 ? 'default' : 'pointer',
                opacity: selectedDates.length === 0 ? 0.5 : 1,
              }}
            >
              ⏱ 고른 날짜 시간대별 변동성 분석{selectedDates.length > 0 ? ` (${selectedDates.length}일)` : ''}
            </button>
            {selectedDates.length === 0 && (
              <span style={{ marginLeft: 10, fontSize: 12, color: '#5a5f6a' }}>왼쪽 달력에서 날짜를 먼저 골라주세요</span>
            )}

            {hourlyAnalysis && hourlyAnalysis.error && (
              <div style={{ marginTop: 10, color: '#F44336', fontSize: 13 }}>❌ {hourlyAnalysis.error}</div>
            )}

            {hourlyAnalysis && !hourlyAnalysis.error && (() => {
              const maxShare = Math.max(...hourlyAnalysis.ranked.map(r => r.sharePct), 0.0001)
              const byBucket = new Map(hourlyAnalysis.ranked.map((r, i) => [r.bucket, { ...r, rank: i + 1 }]))
              // 안내 문구용 - 15분 단위 그대로 나열하면 너무 길어지니 "그 시간(들) 중 일부 구간은 데이터 없음" 식으로 시간 단위로 묶어서 보여준다
              const missingHoursSet = new Set(hourlyAnalysis.missingBuckets.map(idx => Math.floor(idx / BUCKETS_PER_HOUR)))
              return (
                <div style={{ marginTop: 14, background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 20 }}>
                  <div style={{ fontSize: 12.5, color: '#9aa0ab', marginBottom: 18 }}>
                    {SYMBOL_LABEL[symbol]} · 고른 날짜 {hourlyAnalysis.dayCount}일 기준 - 15분 단위로 쪼갠 구간별 총 변동(1분봉 종가 변화 절대값을 하루 안에서 누적) 비중. 막대 위 숫자는 순위(1위=가장 바쁜 구간, 96칸 전부 표시 - 세로쓰기), 상위 3개는 초록색으로 강조.
                    {missingHoursSet.size > 0 && (
                      <> · {[...missingHoursSet].sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}시`).join(', ')} 구간엔 데이터 없음</>
                    )}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'flex-end', gap: 0, height: 200 }}>
                    {Array.from({ length: 24 }, (_, hour) => {
                      const sessionHere = SESSION_OPENS.find(s => Math.floor(s.minute / 60) === hour)
                      return (
                        <div
                          key={hour}
                          style={{
                            flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
                            borderLeft: hour !== 0 ? '1px solid #2a2e38' : 'none', paddingLeft: hour !== 0 ? 3 : 0,
                          }}
                        >
                          {/* 1시간마다 세로선으로 구분 - 그 시간의 15분 버킷 4개를 한 그룹으로 묶어서 아래 시간 숫자가 정가운데에 오게 한다 */}
                          <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, width: '100%', height: 180 }}>
                            {Array.from({ length: BUCKETS_PER_HOUR }, (_, quarter) => {
                              const idx = hour * BUCKETS_PER_HOUR + quarter
                              const info = byBucket.get(idx)
                              const barH = info ? Math.max(3, (info.sharePct / maxShare) * 158) : 0
                              const top3 = !!info && info.rank <= 3
                              const label = `${String(hour).padStart(2, '0')}:${String(quarter * MINUTES_PER_BUCKET).padStart(2, '0')}`
                              return (
                                <div key={idx} style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', height: '100%' }}>
                                  <span style={{
                                    fontSize: 8, fontWeight: top3 ? 800 : 400, color: top3 ? '#4CAF50' : '#5a5f6a',
                                    marginBottom: 2, writingMode: 'vertical-rl', textOrientation: 'mixed', lineHeight: 1, height: 20,
                                  }}>
                                    {info ? info.rank : ''}
                                  </span>
                                  <div
                                    title={info ? `${label} - ${info.sharePct.toFixed(1)}% (평균 레인지 ${info.avgRange.toFixed(1)}pt)` : `${label} - 데이터 없음`}
                                    style={{
                                      width: '100%', height: barH,
                                      background: top3 ? '#4CAF50' : (info ? '#3a4152' : 'transparent'),
                                      borderRadius: '2px 2px 0 0',
                                    }}
                                  />
                                </div>
                              )
                            })}
                          </div>
                          <span style={{ fontSize: 9.5, color: sessionHere ? sessionHere.color : '#5a5f6a', fontWeight: sessionHere ? 800 : 400, marginTop: 5 }}>
                            {String(hour).padStart(2, '0')}
                          </span>
                          {sessionHere && (
                            <span style={{ fontSize: 8, color: sessionHere.color, marginTop: 1 }}>{sessionHere.label}</span>
                          )}
                        </div>
                      )
                    })}
                  </div>
                </div>
              )
            })()}
          </div>

          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* 왼쪽: 심볼 선택 + 달력(날짜를 클릭해서 겹쳐볼 날짜를 고른다) */}
            <div style={{ width: 220, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8 }}>
                {Object.entries(SYMBOL_LABEL).map(([sym, label]) => (
                  <button key={sym} onClick={() => setSymbol(sym)} style={{
                    flex: 1, background: symbol === sym ? '#4CAF50' : 'none', color: symbol === sym ? '#fff' : '#9aa0ab',
                    border: `1px solid ${symbol === sym ? '#4CAF50' : '#2a2e38'}`, borderRadius: 9,
                    padding: '8px 0', fontSize: 14, fontWeight: 700, cursor: 'pointer',
                  }}>{label}</button>
                ))}
              </div>
              <MonthCalendar
                viewDate={viewMonth}
                onNavigate={navigateMonth}
                availableDates={availableDates}
                dateColors={dateColors}
                onSelect={handleDayClick}
                maxWidth={220}
              />
              {selectedDates.length > 0 && (
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <div style={{ display: 'flex', alignItems: 'center', marginBottom: 2 }}>
                    <span style={{ fontSize: 11, color: '#9aa0ab' }}>고른 날짜 {selectedDates.length}개</span>
                    <button type="button" onClick={() => setSelectedDates([])} style={{ marginLeft: 'auto', background: 'none', border: 'none', color: '#9aa0ab', cursor: 'pointer', fontSize: 11 }}>전체 지우기</button>
                  </div>
                  {selectedDates.map((date, i) => (
                    <div key={date} style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#e8eaed' }}>
                      <span style={{ width: 10, height: 10, borderRadius: 3, background: dayColor(i), display: 'inline-block', flexShrink: 0 }} />
                      <span style={{ flex: 1 }}>{date}</span>
                      <button type="button" onClick={() => handleDayClick(date)} style={{ background: 'none', border: 'none', color: '#9aa0ab', cursor: 'pointer', fontSize: 13, padding: 0 }}>✕</button>
                    </div>
                  ))}
                </div>
              )}
              {loading && <div style={{ color: '#9aa0ab', fontSize: 13 }}>불러오는 중...</div>}
              {error && <div style={{ color: '#F44336', fontSize: 13 }}>❌ {error}</div>}
            </div>

            {/* 오른쪽: 오버레이 차트 */}
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 20, position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14, flexWrap: 'wrap', fontSize: 12.5, color: '#9aa0ab' }}>
                  <span>고른 날짜별로 색이 다릅니다(왼쪽 목록 참고)</span>
                  {selectedSeries.length >= 2 && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={showAverage} onChange={e => setShowAverage(e.target.checked)} style={{ width: 13, height: 13, margin: 0 }} />
                      평균선 표시
                    </label>
                  )}
                  <span style={{ marginLeft: 'auto', fontWeight: 700, color: '#e8eaed' }}>{fmtHM(windowStart)} ~ {fmtHM(windowEnd + 1)}</span>
                </div>
                <div ref={wrapRef} style={{ position: 'relative' }}>
                  <canvas
                    ref={canvasRef}
                    onMouseDown={onMouseDown}
                    onMouseMove={onMouseMove}
                    onMouseLeave={() => { setHoverInfo(null); if (!dragRef.current) setCursorStyle('grab') }}
                    onWheel={onWheel}
                    style={{ display: 'block', width: '100%', height: 460, cursor: cursorStyle, touchAction: 'none' }}
                  />
                  {hoverInfo && (
                    <div style={{
                      position: 'absolute', top: 0, right: 0, background: '#171a21', border: '1px solid #2a2e38',
                      borderRadius: 10, padding: '10px 14px', fontSize: 12.5, lineHeight: 1.6, minWidth: 150,
                      pointerEvents: 'none', boxShadow: '0 6px 18px rgba(0,0,0,0.25)',
                    }}>
                      <div style={{ color: '#9aa0ab', fontSize: 11, marginBottom: 4 }}>{fmtHM(hoverInfo.minute)}</div>
                      {showAverage && (
                        <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                          <span>평균 편차</span><b>{hoverInfo.avg != null ? hoverInfo.avg.toFixed(1) + 'pt' : '-'}</b>
                        </div>
                      )}
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span>시가 위</span><b>{hoverInfo.up}일</b>
                      </div>
                      <div style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                        <span>시가 아래</span><b>{hoverInfo.down}일</b>
                      </div>
                    </div>
                  )}
                </div>
                <p style={{ color: '#5a5f6a', fontSize: 11, marginTop: 10, marginBottom: 0 }}>
                  차트 본문을 드래그하면 좌우 이동, 왼쪽 가격축을 드래그하면 세로 확대/축소, 아래 시간축을 드래그하거나 휠을 돌리면 가로 확대/축소됩니다.
                </p>
              </div>

              {selectedSeries.length > 0 && (
                <div style={{ display: 'flex', gap: 10, marginTop: 16, flexWrap: 'wrap' }}>
                  {[
                    ['고른 거래일 수', `${selectedSeries.length}일`],
                    ['마감이 시가보다 높은 날', `${upDays} / ${selectedSeries.length}일`],
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
                시간은 브로커 서버 기준(서머타임 적용). 데이터 경계에 걸쳐 일부 시간대만 있는 날은 있는 부분만 그려집니다. 통계 카드는 고른 날짜 전체(보이는 구간 제한 없이) 기준입니다.
              </p>
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
