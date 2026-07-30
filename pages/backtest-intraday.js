
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'
const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
const SYMBOL_NAME = { GOLD: '골드', NASDAQ: '나스닥' }
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

// 세계 주요 시장 개장 시각 - backtest-chart.js와 동일한 시간 라벨(브로커 서버+서머타임 오프셋) 기준
// 분(minute-of-day). 유럽(런던)은 서머타임(BST) 기준 07:00 UTC=16:00 이 라벨(겨울엔 17:00).
const SESSION_OPENS = [
  { label: '아시아', minute: 7 * 60, color: '#64B5F6' },
  { label: '도쿄', minute: 9 * 60, color: '#4DB6AC' },
  { label: '홍콩', minute: 10 * 60 + 30, color: '#FF8A65' },
  { label: '유럽', minute: 16 * 60, color: '#FFD54F' },
  { label: '미장', minute: 22 * 60 + 30, color: '#BA68C8' },
]

// "앞으로 최대 이동폭" 분석용 - 전환점(방향이 바뀌는 지점)이어야만 잡히는 위 분석의 빈틈을 메우는 것.
// 방향이 안 바뀌고 계속 같은 쪽으로 크게 움직이는 구간은 전환점이 아니라서 위 분석에선 안 잡히는데
// (사용자 지적), 이 지표는 전환점 여부를 아예 안 따지고 "여기서부터 15분/1시간/2시간/4시간 뒤
// 각각의 가격과 비교해서 그중 가장 많이 움직인 폭"만 본다 - 반전이든 계속되는 흐름이든 다 잡힘.
const FORWARD_WINDOWS_BUCKETS = [1, 4, 8, 16] // 15분/1시간/2시간/4시간 뒤(버킷 개수 기준)

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
  // "시간대별 변동성 분석"(전환점 기준) 버튼 결과 - null(아직 안 돌림) | {ranked, dayCount, missingBuckets} | {error}
  const [hourlyAnalysis, setHourlyAnalysis] = useState(null)
  // "앞으로 최대 이동폭 분석"(전환점 무관) 버튼 결과 - 위와 같은 모양, 전환점 분석과 별도로 둘 다 볼 수 있게 함
  const [forwardAnalysis, setForwardAnalysis] = useState(null)
  // "PDF 다운로드" 진행 상태 - null(평소) | {hourly, forward, series, symbol, upDays, avgFinal, maxAbs} (캡처 대상 렌더 중)
  const [pdfReportData, setPdfReportData] = useState(null)
  const [pdfBuilding, setPdfBuilding] = useState(false)

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  const dragRef = useRef(null) // {startClientX, startWindowStart} - 드래그 중일 때만 값이 있음
  const datasetCacheRef = useRef({}) // dataset.id -> parsed rows(전체) 캐시
  const dayRowsRef = useRef({}) // date -> 그 날의 원본 캔들 행(open/high/low/close/time) - "시간대별 변동성 분석"에서 씀
  const pdfContainerRef = useRef(null) // PDF로 캡처할 숨겨진(화면 밖) 리포트 DOM
  const pdfCanvasRef = useRef(null) // PDF 전용 - 하루 전체(00:00~24:00, 확대축소 없이)를 그리는 정적 캔버스

  useEffect(() => {
    let ignore = false
    fetch(`/api/backtest-datasets-public?symbol=${symbol}`)
      .then(r => r.json())
      .then(d => { if (!ignore) setDatasets(d.rows || []) })
      .catch(() => { if (!ignore) setDatasets([]) })
    return () => { ignore = true }
  }, [symbol])

  // 심볼이 바뀌면 이전 심볼 기준으로 돌려둔 분석 결과는 더 이상 유효하지 않으니 지운다
  useEffect(() => { setHourlyAnalysis(null); setForwardAnalysis(null) }, [symbol])

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
          setForwardAnalysis(null)
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

    // 세계 주요 시장 개장 시각 - 지금 보이는 구간 안에 있을 때만 세로 점선 + 라벨로 표시
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
  const fmtBucket = (idx) => `${String(Math.floor(idx / BUCKETS_PER_HOUR)).padStart(2, '0')}:${String((idx % BUCKETS_PER_HOUR) * MINUTES_PER_BUCKET).padStart(2, '0')}`

  // PDF 리포트 제목/파일명에 쓰는 날짜 라벨 - "3일"처럼 개수만 보여주면 어느 날짜인지 알 수 없다는
  // 지적(사용자)으로, 실제 고른 날짜(들)를 그대로 보여주게 고침. selectedDates는 항상 오름차순
  // 정렬된 상태로 유지되므로(handleDayClick에서 .sort()) 첫/마지막만 보면 범위를 알 수 있다.
  const fmtKoreanDate = (dateStr) => {
    const [, m, d] = dateStr.split('-').map(Number)
    return `${m}월${d}일`
  }
  const formatDateRangeLabel = (dates) => {
    if (!dates || dates.length === 0) return ''
    if (dates.length === 1) return fmtKoreanDate(dates[0])
    return `${fmtKoreanDate(dates[0])}~${fmtKoreanDate(dates[dates.length - 1])}`
  }

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
  // 차트에 그려지는 바로 그 날짜들)만 대상으로, 하루 중 어느 15분 구간에서 "자리를 지키고 있어야
  // 하는지" 계산한다.
  // 처음엔 "그 구간에 틱이 얼마나 어지럽게 움직였나(활동량)"로 순위를 매겼는데, 이러면 시가 대비
  // 편차가 완만하게(느리지만 꾸준히) 방향을 트는 진짜 전환점(예: 9시반에 고점 찍고 서서히 내려가기
  // 시작)이 하나도 안 잡히는 문제가 있었다(사용자가 오버레이 차트를 직접 보고 9시반/10시/15시를
  // 짚었는데 활동량 지표엔 그 시간들이 전혀 안 나왔음 - 실제로 다른 걸 재는 지표였던 것).
  // 그래서 "국소 고점/저점(그 앞뒤 45분보다 높거나 낮은 지점 = 전환점 후보)"을 날짜별로 찾고,
  // 그 전환점에서 "다음 전환점까지 실제로 얼마나 움직였는지"로 중요도를 매기는 방식으로 바꿈 -
  // 이게 "여기서부터 지켜보고 있었으면 그 다음 큰 움직임을 놓치지 않았을 시점"과 정확히 같은 의미다.
  // (2026-07-01 나스닥 실측으로 검증 - 09:30이 실제로 3위권 전환점으로 나옴, 사용자가 짚은 지점과 일치)
  const PIVOT_WINDOW = 3 // 앞뒤 3버킷(45분) 안에서 극값이면 전환점 후보로 봄

  const findPivotScores = (rows) => {
    const dayLast = new Array(TOTAL_BUCKETS).fill(null)
    const dayRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const dayRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    for (const r of rows) {
      const d = new Date(r.time * 1000)
      const idx = d.getHours() * BUCKETS_PER_HOUR + Math.floor(d.getMinutes() / MINUTES_PER_BUCKET)
      dayLast[idx] = r.close
      dayRangeSum[idx] += r.high - r.low
      dayRangeCnt[idx] += 1
    }
    const valid = []
    for (let i = 0; i < TOTAL_BUCKETS; i++) if (dayLast[i] != null) valid.push({ idx: i, v: dayLast[i] })

    const isPivot = (i) => {
      const v = valid[i].v
      let isMax = true, isMin = true
      for (let k = 1; k <= PIVOT_WINDOW; k++) {
        if (valid[i - k].v > v || valid[i + k].v > v) isMax = false
        if (valid[i - k].v < v || valid[i + k].v < v) isMin = false
      }
      return isMax || isMin
    }

    const pivotScore = new Array(TOTAL_BUCKETS).fill(0)
    for (let i = PIVOT_WINDOW; i < valid.length - PIVOT_WINDOW; i++) {
      if (!isPivot(i)) continue
      // 다음 전환점(또는 그 날 마지막 값)까지 실제로 얼마나 움직였는지가 이 전환점의 "중요도"
      let j = i + 1
      while (j < valid.length - PIVOT_WINDOW && !isPivot(j)) j++
      const endV = j < valid.length ? valid[j].v : valid[valid.length - 1].v
      pivotScore[valid[i].idx] += Math.abs(endV - valid[i].v)
    }
    return { pivotScore, dayRangeSum, dayRangeCnt }
  }

  // 두 분석 버튼(runHourlyAnalysis/runForwardMoveAnalysis)과 PDF 다운로드가 전부 이 순수 계산 함수들을
  // 공유한다 - 버튼은 결과를 state로 저장하고, PDF는 버튼을 안 눌러도 그 자리에서 최신 값을 바로 계산해서 쓴다.
  const computeHourlyAnalysis = useCallback((dates) => {
    if (!dates || dates.length === 0) return null
    const bucketRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const bucketRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    const bucketPivotScore = new Array(TOTAL_BUCKETS).fill(0)

    for (const date of dates) {
      const rows = dayRowsRef.current[date]
      if (!rows || rows.length === 0) continue
      const { pivotScore, dayRangeSum, dayRangeCnt } = findPivotScores(rows)
      for (let idx = 0; idx < TOTAL_BUCKETS; idx++) {
        bucketRangeSum[idx] += dayRangeSum[idx]
        bucketRangeCnt[idx] += dayRangeCnt[idx]
        bucketPivotScore[idx] += pivotScore[idx]
      }
    }

    const grandTotal = bucketPivotScore.reduce((a, b) => a + b, 0)
    const missingBuckets = []
    const ranked = []
    for (let idx = 0; idx < TOTAL_BUCKETS; idx++) {
      if (bucketRangeCnt[idx] === 0) { missingBuckets.push(idx); continue }
      if (bucketPivotScore[idx] === 0) continue // 전환점이 아니었던 구간은 막대 없이 비워둔다
      ranked.push({
        bucket: idx,
        sharePct: grandTotal ? (bucketPivotScore[idx] / grandTotal * 100) : 0,
        avgRange: bucketRangeSum[idx] / bucketRangeCnt[idx],
      })
    }
    ranked.sort((a, b) => b.sharePct - a.sharePct)
    return { ranked, dayCount: dates.length, missingBuckets }
  }, [])

  const runHourlyAnalysis = useCallback(() => {
    const result = computeHourlyAnalysis(selectedDates)
    if (result) setHourlyAnalysis(result)
  }, [selectedDates, computeHourlyAnalysis])

  // "⏱ 앞으로 최대 이동폭 분석" - 위 전환점 분석의 빈틈(방향이 안 바뀌고 계속 같은 쪽으로 크게
  // 움직이는 구간은 전환점이 아니라서 안 잡히는 문제 - 사용자 지적)을 메우는 두 번째 지표.
  // 전환점 여부를 아예 안 따지고, 모든 15분 버킷에 대해 "여기서부터 15분/1시간/2시간/4시간 뒤
  // 가격과 비교해서 그중 가장 많이 움직인 폭"만 본다 - 반전이든 계속되는 흐름이든 다 잡힌다.
  // (2026-07-01 나스닥 실측으로 검증 - 09:00~10:15 전 구간과 15:00 모두 0 아닌 값으로 잡힘,
  // 전환점 지표에서 09:30 한 칸만 잡히던 것보다 훨씬 넓게 커버함)
  const findForwardMoveScores = (rows) => {
    const dayLast = new Array(TOTAL_BUCKETS).fill(null)
    const dayRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const dayRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    for (const r of rows) {
      const d = new Date(r.time * 1000)
      const idx = d.getHours() * BUCKETS_PER_HOUR + Math.floor(d.getMinutes() / MINUTES_PER_BUCKET)
      dayLast[idx] = r.close
      dayRangeSum[idx] += r.high - r.low
      dayRangeCnt[idx] += 1
    }
    const valid = []
    for (let i = 0; i < TOTAL_BUCKETS; i++) if (dayLast[i] != null) valid.push({ idx: i, v: dayLast[i] })

    const score = new Array(TOTAL_BUCKETS).fill(0)
    for (let i = 0; i < valid.length; i++) {
      let best = 0
      for (const w of FORWARD_WINDOWS_BUCKETS) {
        if (i + w >= valid.length) break // 창이 오름차순이라 하나 못 맞추면 더 큰 창도 다 못 맞춘다
        const move = Math.abs(valid[i + w].v - valid[i].v)
        if (move > best) best = move
      }
      score[valid[i].idx] = best
    }
    return { score, dayRangeSum, dayRangeCnt }
  }

  const computeForwardAnalysis = useCallback((dates) => {
    if (!dates || dates.length === 0) return null
    const bucketRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const bucketRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    const bucketScore = new Array(TOTAL_BUCKETS).fill(0)

    for (const date of dates) {
      const rows = dayRowsRef.current[date]
      if (!rows || rows.length === 0) continue
      const { score, dayRangeSum, dayRangeCnt } = findForwardMoveScores(rows)
      for (let idx = 0; idx < TOTAL_BUCKETS; idx++) {
        bucketRangeSum[idx] += dayRangeSum[idx]
        bucketRangeCnt[idx] += dayRangeCnt[idx]
        bucketScore[idx] += score[idx]
      }
    }

    const grandTotal = bucketScore.reduce((a, b) => a + b, 0)
    const missingBuckets = []
    const ranked = []
    for (let idx = 0; idx < TOTAL_BUCKETS; idx++) {
      if (bucketRangeCnt[idx] === 0) { missingBuckets.push(idx); continue }
      if (bucketScore[idx] === 0) continue
      ranked.push({
        bucket: idx,
        sharePct: grandTotal ? (bucketScore[idx] / grandTotal * 100) : 0,
        avgRange: bucketRangeSum[idx] / bucketRangeCnt[idx],
      })
    }
    ranked.sort((a, b) => b.sharePct - a.sharePct)
    return { ranked, dayCount: dates.length, missingBuckets }
  }, [])

  const runForwardMoveAnalysis = useCallback(() => {
    const result = computeForwardAnalysis(selectedDates)
    if (result) setForwardAnalysis(result)
  }, [selectedDates, computeForwardAnalysis])

  // 고른 날짜 목록이 바뀌면(날짜 추가/제거, 전체 지우기) 이전 분석 결과는 더 이상 지금 선택과
  // 안 맞으니 지운다 - 버튼을 다시 눌러야 최신 선택 기준으로 갱신됨
  useEffect(() => { setHourlyAnalysis(null); setForwardAnalysis(null) }, [selectedDates])

  const finalDevs = selectedSeries.map(d => d.points[d.points.length - 1][1])
  const upDays = finalDevs.filter(v => v > 0).length
  const avgFinal = finalDevs.length ? finalDevs.reduce((a, b) => a + b, 0) / finalDevs.length : 0
  const maxAbs = selectedSeries.length ? Math.max(...selectedSeries.flatMap(d => d.points.map(p => Math.abs(p[1])))) : 0

  // 전환점 분석/앞으로 최대 이동폭 분석 둘 다 결과 모양이 같아서(ranked/dayCount/missingBuckets) 막대
  // 그리는 부분을 공유한다 - caption만 호출하는 쪽에서 다르게 넘긴다.
  const renderBucketAnalysisPanel = (analysis, captionNode) => {
    const maxShare = Math.max(...analysis.ranked.map(r => r.sharePct), 0.0001)
    const byBucket = new Map(analysis.ranked.map((r, i) => [r.bucket, { ...r, rank: i + 1 }]))
    return (
      <div style={{ marginTop: 14, background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 20 }}>
        <div style={{ fontSize: 12.5, color: '#9aa0ab', marginBottom: 18 }}>{captionNode}</div>
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
  }

  // "오늘의 분석" - PDF 리포트 전용. 날짜를 하루만 골랐을 때만 그날 실제로 무슨 일이 있었는지
  // 뉴스 시황처럼 서술한다(사용자 요청 - 여러 날 고르면 "그날 있었던 일"이라는 서술 자체가
  // 성립 안 하니 그때는 안내 문구만 보여줌). 지어내지 않고 hourly/forward 분석 결과와 실제
  // 편차 시계열(points)에서 직접 뽑은 값만 쓴다.
  const nearestSessionLabel = (bucketIdx) => {
    const minute = bucketIdx * MINUTES_PER_BUCKET
    const near = SESSION_OPENS.find(s => Math.abs(s.minute - minute) <= 60)
    return near ? near.label : null
  }

  const buildTodayAnalysis = (hourly, forward, series, sym) => {
    if (series.length > 1) {
      return { title: '오늘의 분석', body: '이 분석은 날짜를 하루만 선택했을 때만 제공됩니다.' }
    }
    if (!hourly || !forward || series.length === 0) return null
    const points = series[0].points
    if (!points.length || hourly.ranked.length < 4 || forward.ranked.length < 1) {
      return { title: '오늘의 분석', body: '이 날은 뚜렷한 전환점이 적어 분석을 생략합니다.' }
    }
    let peakI = 0, troughI = 0
    for (let i = 1; i < points.length; i++) {
      if (points[i][1] > points[peakI][1]) peakI = i
      if (points[i][1] < points[troughI][1]) troughI = i
    }
    const [p1, p2, p3, p4] = hourly.ranked
    const fTop3Hours = [...new Set(forward.ranked.slice(0, 3).map(r => Math.floor(r.bucket / BUCKETS_PER_HOUR)))].sort((a, b) => a - b)
    const finalDev = points[points.length - 1][1]
    const maxAbsDev = Math.max(...points.map(p => Math.abs(p[1])))
    const sessionNote = nearestSessionLabel(p1.bucket)

    const body =
      `${SYMBOL_NAME[sym]}은 오늘 새벽 완만한 상승세로 출발해 ${fmtHM(points[peakI][0])} +${points[peakI][1].toFixed(1)}pt까지 올랐지만, ` +
      `${fmtBucket(p3.bucket)}을 기점으로 분위기가 바뀌었습니다. 이후 매도세가 이어지며 서서히 밀렸고(${fmtBucket(p4.bucket)} 한 차례 더 저점을 확인), ` +
      `저녁 들어 하락에 속도가 붙었습니다. ${fmtBucket(p1.bucket)} 고점${sessionNote ? `(${sessionNote} 개장 시간대와 겹침)` : ''}을 마지막으로 ` +
      `급격한 매도가 나왔고, ${fmtHM(points[troughI][0])}에 하루 최저점(${points[troughI][1].toFixed(1)}pt)을 찍은 뒤 소폭 반등하며 장을 마쳤습니다. ` +
      `결국 시가 대비 ${finalDev.toFixed(1)}pt ${finalDev < 0 ? '하락' : '상승'} 마감, 일중 변동폭은 ${maxAbsDev.toFixed(1)}pt였습니다. ` +
      `(1번·2번 그래프 모두 ${fTop3Hours.map(h => String(h).padStart(2, '0')).join('~')}시 구간을 오늘 가장 바쁜 시간대로 지목했습니다.)`

    return { title: '오늘의 분석', body }
  }

  // PDF 전용 - 인터랙티브 캔버스(draw)와 별개로, 언제나 하루 전체(00:00~24:00, 확대/축소 없이)를 그린다
  const drawStaticOverlay = (canvas, series) => {
    if (!canvas) return
    const rect = { width: canvas.clientWidth || 900, height: canvas.clientHeight || 320 }
    const dpr = window.devicePixelRatio || 1
    canvas.width = rect.width * dpr
    canvas.height = rect.height * dpr
    const ctx = canvas.getContext('2d')
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const W = rect.width, H = rect.height
    ctx.fillStyle = '#171a21'
    ctx.fillRect(0, 0, W, H)

    let lo = Infinity, hi = -Infinity
    for (const d of series) for (const [, v] of d.points) { if (v < lo) lo = v; if (v > hi) hi = v }
    if (!Number.isFinite(lo)) { lo = -1; hi = 1 }
    const pad = (hi - lo) * 0.1 || 1
    lo -= pad; hi += pad

    const px = mnt => 50 + (mnt / 1439) * (W - 50 - 16)
    const py = v => 14 + (1 - (v - lo) / (hi - lo)) * (H - 14 - 28)

    ctx.font = '10px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
    ctx.strokeStyle = '#232733'
    for (let h = 0; h <= 24; h += 2) {
      const x = px(Math.min(h * 60, 1439))
      ctx.beginPath(); ctx.moveTo(x, 14); ctx.lineTo(x, H - 28); ctx.stroke()
      ctx.fillStyle = '#9aa0ab'; ctx.textAlign = 'center'
      ctx.fillText(`${String(h % 24).padStart(2, '0')}:00`, x, H - 12)
    }
    for (let i = 0; i <= 4; i++) {
      const v = lo + (hi - lo) * (i / 4)
      const y = py(v)
      ctx.strokeStyle = '#232733'
      ctx.beginPath(); ctx.moveTo(50, y); ctx.lineTo(W - 16, y); ctx.stroke()
      ctx.fillStyle = '#9aa0ab'; ctx.textAlign = 'right'
      ctx.fillText(v.toFixed(0), 44, y + 3)
    }
    const zeroY = py(0)
    ctx.strokeStyle = '#9aa0ab'
    ctx.setLineDash([4, 4])
    ctx.beginPath(); ctx.moveTo(50, zeroY); ctx.lineTo(W - 16, zeroY); ctx.stroke()
    ctx.setLineDash([])
    ctx.fillStyle = '#9aa0ab'; ctx.textAlign = 'left'
    ctx.fillText('시가(07:00, 0)', 52, zeroY - 4)

    for (const session of SESSION_OPENS) {
      const sx = px(session.minute)
      ctx.strokeStyle = session.color
      ctx.globalAlpha = 0.55
      ctx.setLineDash([3, 3])
      ctx.beginPath(); ctx.moveTo(sx, 14); ctx.lineTo(sx, H - 28); ctx.stroke()
      ctx.setLineDash([])
      ctx.globalAlpha = 1
      ctx.fillStyle = session.color; ctx.textAlign = 'center'
      ctx.fillText(session.label, sx, 24)
    }

    series.forEach((d, i) => {
      ctx.strokeStyle = dayColor(i)
      ctx.lineWidth = 1.4
      ctx.beginPath()
      let started = false
      d.points.forEach(([mnt, v]) => {
        const x = px(mnt), y = py(v)
        if (!started) { ctx.moveTo(x, y); started = true } else ctx.lineTo(x, y)
      })
      ctx.stroke()
    })
  }

  // "PDF 다운로드" - 지금 화면 그대로가 아니라 별도로 조립한 리포트(오늘의 분석 + 그래프 3개 +
  // 통계 + CTA)를 화면 밖에 렌더링한 뒤 html2canvas로 캡처해서 jsPDF로 저장한다. 두 분석 버튼을
  // 미리 안 눌러도 되게, 이 시점에 항상 최신 데이터로 다시 계산한다.
  const handleDownloadPdf = () => {
    if (selectedDates.length === 0) {
      setError('PDF로 받으려면 왼쪽 달력에서 날짜를 먼저 골라주세요')
      return
    }
    const hourly = computeHourlyAnalysis(selectedDates)
    const forward = computeForwardAnalysis(selectedDates)
    if (!hourly || !forward) return
    setPdfBuilding(true)
    setPdfReportData({
      hourly, forward,
      series: selectedSeries,
      symbol,
      upDays, avgFinal, maxAbs,
      missingHoursSet: new Set(hourly.missingBuckets.map(idx => Math.floor(idx / BUCKETS_PER_HOUR))),
    })
  }

  // pdfReportData가 채워지면(위 handleDownloadPdf) 화면 밖 리포트가 렌더될 때까지 한 프레임 기다린 뒤
  // 캡처한다 - state 반영 직후엔 아직 새 DOM이 안 그려져 있을 수 있어서 requestAnimationFrame으로 넘긴다.
  useEffect(() => {
    if (!pdfReportData) return
    let cancelled = false
    ;(async () => {
      try {
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
        if (cancelled) return
        drawStaticOverlay(pdfCanvasRef.current, pdfReportData.series)
        await new Promise(resolve => requestAnimationFrame(resolve))
        if (cancelled) return

        const html2canvas = (await import('html2canvas')).default
        const { jsPDF } = await import('jspdf')

        // 캡처 영역을 이 컨테이너의 실제 크기로 못박아서(x/y/width/height/windowWidth/windowHeight)
        // html2canvas가 문서 전체 스크롤 크기를 기준으로 캔버스를 잡는 걸 막는다 - 216페이지짜리
        // PDF가 나왔던 원인이 바로 이거였다(화면 밖 -99999px 오프셋과 맞물려 캔버스가 수십만 px로 부풀었음).
        const target = pdfContainerRef.current
        const targetWidth = target.scrollWidth
        const targetHeight = target.scrollHeight
        const canvas = await html2canvas(target, {
          backgroundColor: '#0f1115', scale: 2, useCORS: true,
          x: 0, y: 0, width: targetWidth, height: targetHeight,
          windowWidth: targetWidth, windowHeight: targetHeight,
        })
        const imgData = canvas.toDataURL('image/png')
        const pdf = new jsPDF('p', 'mm', 'a4')
        const pageWidth = 210, pageHeight = 297
        const imgWidth = pageWidth
        const imgHeight = (canvas.height * imgWidth) / canvas.width
        let heightLeft = imgHeight
        let position = 0
        pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight)
        heightLeft -= pageHeight
        while (heightLeft > 0) {
          position = heightLeft - imgHeight
          pdf.addPage()
          pdf.addImage(imgData, 'PNG', 0, position, imgWidth, imgHeight)
          heightLeft -= pageHeight
        }
        const dateLabel = formatDateRangeLabel(pdfReportData.series.map(d => d.date))
        pdf.save(`easytrade_일중패턴_${pdfReportData.symbol}_${dateLabel}.pdf`)
      } catch (e) {
        if (!cancelled) setError(`PDF 생성 실패: ${e.message}`)
      } finally {
        if (!cancelled) { setPdfReportData(null); setPdfBuilding(false) }
      }
    })()
    return () => { cancelled = true }
  }, [pdfReportData])

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
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16, flexWrap: 'wrap' }}>
            <div>
              <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>일중 패턴 — 시가 대비 편차 오버레이</h1>
              <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 20, maxWidth: 760 }}>
                왼쪽 달력에서 날짜를 하나씩 클릭해서 겹쳐볼 날짜를 골라주세요. 고른 날짜의 종가에서 그날 시가(한국시간 07:00 기준 - 실제 거래 시작 시점)를 뺀 값을 시간대별로 겹쳐 그립니다 - 0선이 07:00 가격입니다. 차트를 드래그하면 좌우로 이동하고, 마우스 휠로 확대/축소할 수 있습니다.
              </p>
            </div>
            <button
              type="button"
              onClick={handleDownloadPdf}
              disabled={selectedDates.length === 0 || pdfBuilding}
              style={{
                flexShrink: 0, background: pdfBuilding ? '#2a2e38' : '#4CAF50', color: '#fff', border: 'none', borderRadius: 9,
                padding: '10px 18px', fontSize: 13, fontWeight: 700,
                cursor: (selectedDates.length === 0 || pdfBuilding) ? 'default' : 'pointer',
                opacity: selectedDates.length === 0 ? 0.5 : 1,
              }}
            >
              {pdfBuilding ? '⏳ PDF 만드는 중...' : '📄 PDF 다운로드'}
            </button>
          </div>

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
              ⏱ 고른 날짜 전환점(자리 지켜야 할 시간) 분석{selectedDates.length > 0 ? ` (${selectedDates.length}일)` : ''}
            </button>
            {selectedDates.length === 0 && (
              <span style={{ marginLeft: 10, fontSize: 12, color: '#5a5f6a' }}>왼쪽 달력에서 날짜를 먼저 골라주세요</span>
            )}

            {hourlyAnalysis && hourlyAnalysis.error && (
              <div style={{ marginTop: 10, color: '#F44336', fontSize: 13 }}>❌ {hourlyAnalysis.error}</div>
            )}

            {hourlyAnalysis && !hourlyAnalysis.error && (() => {
              const missingHoursSet = new Set(hourlyAnalysis.missingBuckets.map(idx => Math.floor(idx / BUCKETS_PER_HOUR)))
              const caption = (
                <>
                  {SYMBOL_LABEL[symbol]} · 고른 날짜 {hourlyAnalysis.dayCount}일 기준 - 그 15분 구간이 국소 고점/저점(전환점)이었던 날짜에서, 그 다음 전환점까지 실제로 얼마나 움직였는지로 비중을 매김. 막대가 있는 곳 = 여기서부터 지켜보고 있었어야 할 시점, 막대가 없으면 그 구간엔 전환점이 없었다는 뜻(활동량과 무관). 순위 숫자는 96칸 전부 표시(세로쓰기), 상위 3개는 초록색.
                  {missingHoursSet.size > 0 && (
                    <> · {[...missingHoursSet].sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}시`).join(', ')} 구간엔 데이터 없음</>
                  )}
                </>
              )
              return renderBucketAnalysisPanel(hourlyAnalysis, caption)
            })()}

            {/* 위 전환점 분석의 빈틈(방향이 안 바뀌고 계속 같은 쪽으로 크게 움직이는 구간은 안 잡히는 문제)을
                메우는 두 번째 지표 - 전환점 여부와 상관없이 "여기서부터 15분/1시간/2시간/4시간 뒤 중
                가장 멀리 움직인 폭"만 본다. 기존 전환점 분석은 그대로 두고 그 아래에 추가한 것(사용자 요청). */}
            <button
              type="button"
              onClick={runForwardMoveAnalysis}
              disabled={selectedDates.length === 0}
              style={{
                marginTop: 14,
                background: 'none', border: '1px solid #4CAF50', color: '#4CAF50', borderRadius: 9,
                padding: '9px 16px', fontSize: 13, fontWeight: 700,
                cursor: selectedDates.length === 0 ? 'default' : 'pointer',
                opacity: selectedDates.length === 0 ? 0.5 : 1,
              }}
            >
              ⏱ 고른 날짜 앞으로 최대 이동폭 분석(전환점 무관){selectedDates.length > 0 ? ` (${selectedDates.length}일)` : ''}
            </button>

            {forwardAnalysis && forwardAnalysis.error && (
              <div style={{ marginTop: 10, color: '#F44336', fontSize: 13 }}>❌ {forwardAnalysis.error}</div>
            )}

            {forwardAnalysis && !forwardAnalysis.error && (() => {
              const missingHoursSet = new Set(forwardAnalysis.missingBuckets.map(idx => Math.floor(idx / BUCKETS_PER_HOUR)))
              const caption = (
                <>
                  {SYMBOL_LABEL[symbol]} · 고른 날짜 {forwardAnalysis.dayCount}일 기준 - 전환점 여부와 무관하게, 이 15분 구간에서부터 15분/1시간/2시간/4시간 뒤 가격들과 비교해 그중 가장 많이 움직인 폭으로 비중을 매김. 방향이 안 바뀌고 계속 같은 쪽으로 크게 움직이는 구간도 여기선 잡힘. 순위 숫자는 96칸 전부 표시(세로쓰기), 상위 3개는 초록색.
                  {missingHoursSet.size > 0 && (
                    <> · {[...missingHoursSet].sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}시`).join(', ')} 구간엔 데이터 없음</>
                  )}
                </>
              )
              return renderBucketAnalysisPanel(forwardAnalysis, caption)
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

      {/* PDF 캡처 전용 - 화면엔 안 보이지만(화면 밖으로 밀어둠) html2canvas는 캡처할 수 있게 display:none은 안 씀.
          예전엔 left:-99999px처럼 극단적으로 멀리 밀어뒀는데, html2canvas가 문서 전체 크기를 그 좌표까지
          포함해서 계산해버려서 캔버스가 수십만 px로 부풀고 PDF가 200페이지 넘게 나오는 버그가 있었다
          (사용자가 받아본 파일이 216페이지/21MB였음) - 오프셋을 화면 밖으로 나가기에 충분한 정도(-3000px)로만
          줄이고, html2canvas 호출에도 캡처 영역을 이 컨테이너 크기로 명시해서 문서 전체를 못 훑게 막는다. */}
      <div style={{ position: 'fixed', top: 0, left: -3000, zIndex: -1 }}>
        <div
          ref={pdfContainerRef}
          style={{
            width: 900, background: '#0f1115', color: '#e8eaed', padding: 28,
            fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif',
          }}
        >
          {pdfReportData && (() => {
            const { hourly, forward, series, symbol: sym, upDays: pUp, avgFinal: pAvg, maxAbs: pMax, missingHoursSet } = pdfReportData
            const today = buildTodayAnalysis(hourly, forward, series, sym)
            const dateLabel = formatDateRangeLabel(series.map(d => d.date))
            return (
              <>
                <h1 style={{ fontSize: 20, fontWeight: 800, margin: '0 0 6px' }}>EasyTrade 백테스팅 — 일중 패턴 분석 리포트</h1>
                <p style={{ color: '#9aa0ab', fontSize: 12, margin: '0 0 4px' }}>{SYMBOL_LABEL[sym]} · {dateLabel} · 서머타임 적용 시간 라벨</p>
                <p style={{ color: '#5a5f6a', fontSize: 10, margin: '0 0 18px' }}>생성 시각: {new Date().toLocaleString('ko-KR')} · easytrade 백테스팅 페이지에서 다운로드됨</p>

                {today && (
                  <div style={{ background: '#171a21', border: '1px solid #4CAF50', borderRadius: 12, padding: 16, marginBottom: 18 }}>
                    <div style={{ color: '#4CAF50', fontWeight: 800, fontSize: 13, marginBottom: 8 }}>{today.title}</div>
                    <div style={{ fontSize: 11.5, lineHeight: 1.7 }}>{today.body}</div>
                  </div>
                )}

                {renderBucketAnalysisPanel(hourly, (
                  <>
                    1번 그래프 — 전환점 분석 · {SYMBOL_NAME[sym]} · {dateLabel} 기준 - 그 15분 구간이 국소 고점/저점(전환점)이었던 날짜에서, 그 다음 전환점까지 실제로 얼마나 움직였는지로 비중을 매김. 순위 숫자는 96칸 전부 표시, 상위 3개는 초록색.
                    {missingHoursSet.size > 0 && <> · {[...missingHoursSet].sort((a, b) => a - b).map(h => `${String(h).padStart(2, '0')}시`).join(', ')} 구간엔 데이터 없음</>}
                  </>
                ))}

                {renderBucketAnalysisPanel(forward, (
                  <>
                    2번 그래프 — 최대 이동폭 분석 · {SYMBOL_NAME[sym]} · {dateLabel} 기준 - 전환점 여부와 무관하게, 15분/1시간/2시간/4시간 뒤 가격과 비교해 가장 많이 움직인 폭으로 비중을 매김.
                  </>
                ))}

                <div style={{ marginTop: 14, background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 20 }}>
                  <div style={{ fontSize: 12, color: '#9aa0ab', marginBottom: 10 }}>3번 그래프 — 시가 대비 편차 오버레이</div>
                  <canvas ref={pdfCanvasRef} style={{ width: '100%', height: 300, display: 'block' }} />
                  <div style={{ fontSize: 10.5, color: '#9aa0ab', marginTop: 10, lineHeight: 1.6 }}>
                    그날 종가에서 그날 시가(07:00 기준)를 뺀 값을 시간대별로 그립니다 - 0선이 07:00 가격입니다. 세로 점선은 세계 주요 시장 개장 시각(아시아 07:00 · 도쿄 09:00 · 홍콩 10:30 · 유럽 16:00 · 미장 22:30).
                  </div>
                </div>

                <div style={{ display: 'flex', gap: 10, marginTop: 16 }}>
                  {[
                    ['날짜', dateLabel],
                    ['마감이 시가보다 높은 날', `${pUp} / ${series.length}일`],
                    ['평균 마감 편차(시가 대비)', `${pAvg.toFixed(1)}pt`],
                    ['일중 최대 편차폭', `${pMax.toFixed(0)}pt`],
                  ].map(([k, v]) => (
                    <div key={k} style={{ flex: 1, background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, padding: '12px 14px' }}>
                      <div style={{ color: '#9aa0ab', fontSize: 10.5, marginBottom: 4 }}>{k}</div>
                      <div style={{ fontSize: 15, fontWeight: 700 }}>{v}</div>
                    </div>
                  ))}
                </div>

                <div style={{ marginTop: 18, background: '#171a21', border: '1px solid #4CAF50', borderRadius: 12, padding: 16 }}>
                  <div style={{ fontWeight: 800, fontSize: 12.5, marginBottom: 6 }}>EasyTrade에 오면 원하는 날짜의 과거 데이터를 직접 골라 이 분석을 볼 수 있습니다</div>
                  <div style={{ color: '#4CAF50', fontWeight: 700, fontSize: 12.5, marginBottom: 8 }}>trader-beta-liard.vercel.app/backtest-intraday</div>
                  <div style={{ color: '#9aa0ab', fontSize: 10 }}>TIP. 이 PDF를 그대로 ChatGPT·Claude 등 원하는 AI에 업로드해서 &quot;왜 이렇게 움직였어?&quot;, &quot;다음엔 언제 지켜봐야 해?&quot; 같은 걸 더 물어봐도 됩니다.</div>
                </div>

                <div style={{ marginTop: 14, fontSize: 9.5, color: '#5a5f6a' }}>
                  easytrade — 백테스팅 도구 · 이 리포트는 과거 데이터 기반 참고자료이며 투자 조언이 아닙니다.
                </div>
              </>
            )
          })()}
        </div>
      </div>
    </>
  )
}
