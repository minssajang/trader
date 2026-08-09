
import { useState, useEffect, useRef, useMemo, useCallback } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, buildAvailableDates, CollapsibleCard } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, DONCHIAN_CHANNELS, rollingDonchian } from '../lib/indicators'

const ALL_BAND_DEFS = [...BOLLINGER_BANDS, ...DONCHIAN_CHANNELS]

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'
const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
const SYMBOL_NAME = { GOLD: '골드', NASDAQ: '나스닥' }
// 사용자가 직접 고른 날짜별 색상 - 순서대로 고정 팔레트를 돌려써서 차트 선과 왼쪽 날짜 칩의 색이 항상 일치하게 한다
const DAY_COLORS = ['#4FC3F7', '#FFB74D', '#BA68C8', '#81C784', '#F06292', '#FFD54F', '#4DB6AC', '#E57373']
function dayColor(i) { return DAY_COLORS[i % DAY_COLORS.length] }

// 오버레이 차트의 "하루" 구간은 달력상 00:00~23:59가 아니라 05:00~다음날 06:00(25시간)이다(사용자 요청 -
// "한국에서 기준을 5시 정도부터 다음 6시까지 보이게 해줘"). 예: 8월3일 = 8/3 05:00 ~ 8/4 06:00.
// 이 규칙을 매일 그대로 적용하면 05:00~06:00(1시간)이 "전날의 연장"과 "당일의 시작" 양쪽에 다 걸치는데,
// 그것도 사용자가 말한 규칙을 문자 그대로 적용한 결과라 그대로 둔다(의도된 중복 구간).
// 이 05:00~익일06:00 재정의는 메인 오버레이 차트뿐 아니라 "시간대별 변동성 분석"/"앞으로 최대
// 이동폭 분석"(TOTAL_BUCKETS 100개, MINUTES_PER_BUCKET 그대로)에도 동일하게 적용했다(사용자 요청 -
// "다 적용을 해야지"). PDF 리포트 기능은 제거했다(사용자 요청).
const DAY_WINDOW_START_MIN = 5 * 60 // 05:00 - 오버레이 차트 "하루"의 시작
const DAY_WINDOW_TOTAL_MIN = 25 * 60 // 05:00 ~ 다음날 06:00 = 25시간(1500분)

// 하루 전체를 한 화면에 우겨넣지 않고, 트레이딩뷰처럼 드래그로 좌우 이동 + 휠로 확대/축소한다
// (사용자 요청 - 아래 슬라이드바 대신 차트를 직접 끌고 스크롤하는 방식).
const DEFAULT_WINDOW_MIN = 12 * 60 // 처음엔 12시간만 보이게 시작
const MIN_WINDOW_MIN = 60   // 최대로 확대하면 1시간까지만
const MAX_WINDOW_MIN = DAY_WINDOW_TOTAL_MIN // 최대로 축소하면 05:00~다음날06:00 전체

// 한국 시간 기준 실제 거래 시작은 00:00이 아니라 07:00(브로커 01시=한국 07시, candleCsv.js 오프셋
// 규칙 참고) - 시가(0선) 기준을 07:00 시점 가격으로 삼는다(사용자 요청). "시간대별 분석" 등에서 실제
// 시각(0~1439) 그대로 써야 하는 곳이 있어 이 값 자체는 그대로 둔다(위 DAY_WINDOW_START_MIN과는 별개).
const REFERENCE_MIN = 7 * 60 // 07:00

// "시간대별 변동성 분석" 막대그래프의 세분화 단위 - 1시간 하나로는 뭉뚱그려져서 15분 단위(1시간=4칸)로
// 쪼개달라는 요청(사용자)에 맞춘 것. 하루 25시간(05:00~익일06:00, DAY_WINDOW_TOTAL_MIN) = 100개 15분 버킷.
const MINUTES_PER_BUCKET = 15
const BUCKETS_PER_HOUR = 60 / MINUTES_PER_BUCKET
const TOTAL_BUCKETS = DAY_WINDOW_TOTAL_MIN / MINUTES_PER_BUCKET

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

// "YYYY-MM-DD" 문자열의 하루 전 - 05:00~익일06:00 트레이딩데이 버킷팅에서 씀(components/BacktestCalendar.js의
// addDays와 같은 로직, 이 파일에선 -1일만 필요해서 별도로 둠).
function prevLocalDateStr(dateStr) {
  const [y, m, d] = dateStr.split('-').map(Number)
  const dt = new Date(y, m - 1, d)
  dt.setDate(dt.getDate() - 1)
  return `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`
}

// 실제 시각(0~1439, 자정 기준)을 오버레이 차트 x축 오프셋(0~1499, 05:00 기준)으로. 05:00 이전(00:00~04:59)은
// "전날의 연장"이라 1440을 더해 뒤쪽(1140~1439)으로 이어붙인다.
function toChartOffset(minuteOfDay) {
  return minuteOfDay >= DAY_WINDOW_START_MIN ? minuteOfDay - DAY_WINDOW_START_MIN : minuteOfDay + (1440 - DAY_WINDOW_START_MIN)
}
// 오버레이 차트 x축 오프셋을 다시 실제 시각(0~1439)으로 - 축 라벨(HH:MM) 표시용.
function fromChartOffset(offsetMinute) {
  return (((offsetMinute + DAY_WINDOW_START_MIN) % 1440) + 1440) % 1440
}

// 새로고침하면 골라둔 심볼/달/날짜/표시설정이 전부 날아간다는 지적(사용자) - replay.js/backtest-chart.js와
// 같은 방식으로 localStorage에 저장했다가 마운트 시 복원한다.
const INTRADAY_SETTINGS_KEY = 'intradayPatternSettings'

// backtest-chart.js의 서머타임 토글과 같은 개념이지만, 이 페이지는 달 단위로 통으로 보기 때문에
// 별도 상태 없이 항상 서머타임 오프셋을 쓴다(데이터 자체가 전부 2026년 여름 구간).
export default function BacktestIntraday() {
  // 마운트 시 딱 한 번만 localStorage를 읽어서 ref에 담아둔다(렌더 중 계산이라 useEffect보다 먼저 값이 준비됨).
  const settingsRestoreRef = useRef(undefined)
  if (settingsRestoreRef.current === undefined) {
    settingsRestoreRef.current = null
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(INTRADAY_SETTINGS_KEY)
        if (raw) settingsRestoreRef.current = JSON.parse(raw)
      } catch { /* 저장된 값이 깨져있으면 그냥 무시하고 기본값으로 시작 */ }
    }
  }
  const rs = settingsRestoreRef.current || {}

  const [symbol, setSymbol] = useState(rs.symbol ?? 'NASDAQ')
  const [datasets, setDatasets] = useState([])
  const [viewMonth, setViewMonth] = useState(() => rs.viewMonth ? new Date(rs.viewMonth.y, rs.viewMonth.m, 1) : new Date())
  const [days, setDays] = useState([]) // [{date, points:[[minute, deviation]]}]
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState('')
  const [hoverInfo, setHoverInfo] = useState(null) // {minute, avg, up, down}
  // 달력에서 클릭해서 고른 날짜들만 겹쳐 그린다 - 처음엔 아무것도 안 골랐으니 차트가 비어있다
  // (예전엔 그 달 전체를 자동으로 다 그렸는데, "왜 선이 미리 그려져 있냐"는 피드백으로 사용자가
  // 직접 고른 날짜만 그리는 방식으로 바꿈)
  const [selectedDates, setSelectedDates] = useState(rs.selectedDates ?? [])
  // 평균선은 기본으로 자동으로 안 그리고, 이 버튼을 켜야만 그린다(사용자 요청 - 시키지 않은 걸
  // 자동으로 하지 말고 옵션 버튼으로 빼둘 것)
  const [showAverage, setShowAverage] = useState(rs.showAverage ?? false)
  // 각 날짜의 가격선 위에 그 날의 볼린저/도치안 밴드(상단·중심·하단)도 "시가(0선) 기준" 같은 스케일로
  // 겹쳐 그린다(사용자 요청 - "중심선을 기준으로 밴드를 보여줘야 할 거 아니냐"). 왼쪽 체크박스로 여러
  // 개를 동시에 켤 수 있어야 서로 겹쳐볼 수 있다(사용자 요청) - bandId -> boolean.
  const [enabledOverlay, setEnabledOverlay] = useState(rs.enabledOverlay ?? {})
  const toggleOverlay = (bandId) => setEnabledOverlay(prev => ({ ...prev, [bandId]: !prev[bandId] }))
  // 위/중심/아래 각 줄을 따로 숨길 수도 있게 - replay.js/backtest-chart.js와 완전히 동일한 기능(사용자
  // 요청 - "리플레이와 똑같이 만들어두라니까" 체크박스만 있고 이게 빠져있었음). 기본은 다 보임(true).
  const [overlayLineVisibility, setOverlayLineVisibility] = useState(rs.overlayLineVisibility ?? {})
  const isOverlayLineVisible = (bandId, which) => overlayLineVisibility[`${bandId}:${which}`] !== false
  const toggleOverlayLine = (bandId, which) => {
    setOverlayLineVisibility(prev => ({ ...prev, [`${bandId}:${which}`]: !isOverlayLineVisible(bandId, which) }))
  }
  // 교집합(체크한 밴드들이 전부 겹치는 구간) 표시는 밴드 체크와 자동으로 같이 켜지지 않고 별도 토글로
  // 뺀다 - 처음에 자동으로 켜지게 만들었더니 "개별 밴드만 보려고 체크했는데 왜 마음대로 겹쳐서
  // 보여주냐"는 지적(사용자) - 기본은 꺼짐, 원할 때만 켠다.
  const [showIntersection, setShowIntersection] = useState(rs.showIntersection ?? false)
  // 지금 보고 있는 구간 - 드래그(팬)로 시작 위치를, 휠(줌)로 폭을 바꾼다
  const [windowStart, setWindowStart] = useState(0)
  const [windowSize, setWindowSize] = useState(DEFAULT_WINDOW_MIN)
  // 지금 마우스가 어느 영역(본문/y축/x축) 위에 있는지에 따라 커서 모양을 바꿔서 뭘 할 수 있는지 알려준다
  const [cursorStyle, setCursorStyle] = useState('grab')
  // "시간대별 변동성 분석"(전환점 기준) 버튼 결과 - null(아직 안 돌림) | {ranked, dayCount, missingBuckets} | {error}
  const [hourlyAnalysis, setHourlyAnalysis] = useState(null)
  // "앞으로 최대 이동폭 분석"(전환점 무관) 버튼 결과 - 위와 같은 모양, 전환점 분석과 별도로 둘 다 볼 수 있게 함
  const [forwardAnalysis, setForwardAnalysis] = useState(null)

  const canvasRef = useRef(null)
  const wrapRef = useRef(null)
  // `${symbol}:${y}-${m}` - localStorage에서 selectedDates를 복원했을 때, 데이터 로딩 effect가 "새 달로 바뀜"으로 오판해서
  // 복원된 날짜 선택을 곧바로 지워버리지 않도록 복원된 심볼/달로 미리 채워둔다.
  const lastMonthKeyRef = useRef(rs.selectedDates?.length ? `${rs.symbol ?? 'NASDAQ'}:${viewMonth.getFullYear()}-${viewMonth.getMonth()}` : null)
  const lastLoadedSymbolRef = useRef(null) // days/dayRowsRef를 심볼이 바뀔 때만 통째로 새로 시작하기 위한 비교용
  const dragRef = useRef(null) // {startClientX, startWindowStart} - 드래그 중일 때만 값이 있음
  const rangeAnchorRef = useRef('') // 마지막으로 클릭한 날짜 - Shift+클릭으로 범위 선택할 때 시작점(replay.js와 같은 방식)
  const datasetCacheRef = useRef({}) // dataset.id -> parsed rows(전체) 캐시
  const dayRowsRef = useRef({}) // date -> 그 날의 원본 캔들 행(open/high/low/close/time) - "시간대별 변동성 분석"에서 씀

  // 심볼/달/고른 날짜/표시설정이 바뀔 때마다 localStorage에 저장 - 새로고침해도 그대로 유지된다(사용자 지적).
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(INTRADAY_SETTINGS_KEY, JSON.stringify({
        symbol,
        viewMonth: { y: viewMonth.getFullYear(), m: viewMonth.getMonth() },
        selectedDates, showAverage, enabledOverlay, overlayLineVisibility, showIntersection,
      }))
    } catch { /* 저장 실패해도(예: 프라이빗 모드 용량제한) 기능엔 영향 없음 */ }
  }, [symbol, viewMonth, selectedDates, showAverage, enabledOverlay, overlayLineVisibility, showIntersection])

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

        // 체크박스로 켠 오버레이 밴드만 계산한다("아무것도 안 켠" 기본 상태에선 불필요한 비용을 안 씀).
        // fullRows(이 파일 전체, 이번 달보다 앞선 날짜도 포함)를 그대로 기준으로 계산해야 월초 며칠도
        // 워밍업(예: 1시간B/1시간D = 1200분 = 20시간치 이전 데이터)이 채워진다 - replay.js와 같은 방식.
        const overlayBands = ALL_BAND_DEFS.filter(b => enabledOverlay[b.id]) // 체크박스로 여러 개 동시 선택 가능
        let timeToIdx = null
        const overlayUpsLowsById = {} // bandId -> {ups, lows} (fullRows 인덱스 기준)
        if (overlayBands.length > 0) {
          timeToIdx = new Map(fullRows.map((r, i) => [r.time, i]))
          const closes = fullRows.map(r => r.close)
          for (const band of overlayBands) {
            overlayUpsLowsById[band.id] = band.type === 'donchian' ? rollingDonchian(fullRows, band.period) : rollingBollinger(closes, band.period)
          }
        }

        // 트레이딩데이 버킷팅 - 하루가 "그 날짜 05:00 ~ 다음날 06:00"이라(DAY_WINDOW_START_MIN 위 설명
        // 참고), fullRows를 그냥 달력 날짜로만 나누지 않고, 자정을 넘긴 00:00~05:59 캔들을 "전날"
        // 버킷에도 같이 얹는다. fullRows가 이미 시간순 정렬돼있어서, 특정 날짜 D의 버킷엔 먼저 D 자신의
        // 05:00~23:59가 순서대로 쌓이고 그 다음(달이 넘어가며) D+1의 00:00~05:59가 이어붙어서, 결과
        // 배열이 그대로 시간순이 된다(별도 정렬 불필요).
        const byDate = new Map()
        const addRow = (dateStr, r) => {
          if (!byDate.has(dateStr)) byDate.set(dateStr, [])
          byDate.get(dateStr).push(r)
        }
        for (const r of fullRows) {
          const calDate = toLocalDateStr(r.time)
          const d = new Date(r.time * 1000)
          const minuteOfDay = d.getHours() * 60 + d.getMinutes()
          if (minuteOfDay >= DAY_WINDOW_START_MIN) addRow(calDate, r) // 그 날짜 자신의 05:00~23:59
          if (minuteOfDay < DAY_WINDOW_START_MIN + 60) addRow(prevLocalDateStr(calDate), r) // 전날의 05:00~익일06:00 연장분(00:00~05:59, 05:00~05:59 겹침 포함)
        }
        const nextDays = []
        const nextDayRows = {}
        // monthPrefix로 미리 걸러내지 않고 fullRows(파일 전체) 범위의 모든 날짜를 다 만든다 - 달력에서
        // 앞/뒤 달로 흐리게 걸쳐나오는 날짜(예: 8월 보는 중에 맨 앞줄의 7월 27~31일)를 클릭했을 때, 지금
        // 보고 있는 달(viewMonth)만 걸러서 만들면 그 날짜가 통째로 안 만들어져서 0봉으로 나오는 버그가
        // 있었다(사용자 지적 - "같은 자료인데 왜 0봉이냐"). 파일 하나가 보통 1.5개월치라 비용 부담은 적다.
        for (const [date, rows] of [...byDate.entries()].sort()) {
          // 이 날짜(트레이딩데이) 소속 캔들을 실제 x축 오프셋(0=05:00 ~ 1499=익일05:59)으로 바꾼다.
          // 자기 날짜(D) 소속이면 05:00 기준 그대로, 다음날(D+1) 새벽 연장분이면 1440을 더해 뒤로 이어붙인다
          // (05:00~05:59는 D의 "연장"과 D+1의 "자기 날짜" 양쪽에 다 있을 수 있어 실제 달력날짜로 구분해야 함).
          const rowOffset = (r) => {
            const d = new Date(r.time * 1000)
            const minuteOfDay = d.getHours() * 60 + d.getMinutes()
            return toLocalDateStr(r.time) === date ? (minuteOfDay - DAY_WINDOW_START_MIN) : (minuteOfDay + (1440 - DAY_WINDOW_START_MIN))
          }
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
          const points = rows.map(r => [rowOffset(r), Math.round((r.close - dayOpen) * 100) / 100])

          // 볼린저/도치안 밴드 상단/중심선/하단을 "시가(0) 기준" 같은 스케일(값 - dayOpen)로 바꿔서
          // 그 날 가격선과 나란히 겹쳐 그릴 수 있게 한다(사용자 요청 - "중심선을 기준으로" 보여달라는
          // 것 + 중심선 자체도 빠져있었다는 지적). 왼쪽 체크박스로 여러 밴드를 동시에 켤 수 있으니
          // bandId -> {upper,mid,lower}로 전부 담아둔다.
          const overlays = {}
          for (const band of overlayBands) {
            const upsLows = overlayUpsLowsById[band.id]
            const upper = [], mid = [], lower = []
            for (const r of rows) {
              const idx = timeToIdx.get(r.time)
              const u = upsLows.ups[idx], l = upsLows.lows[idx], m = upsLows.mids[idx]
              if (u == null || l == null || m == null) continue
              const off = rowOffset(r)
              upper.push([off, Math.round((u - dayOpen) * 100) / 100])
              mid.push([off, Math.round((m - dayOpen) * 100) / 100])
              lower.push([off, Math.round((l - dayOpen) * 100) / 100])
            }
            overlays[band.id] = { upper, mid, lower }
          }

          // 교집합(사용자 요청) - 체크한 밴드가 2개 이상이면, 그 밴드들이 전부 공통으로 겹치는 가장
          // 좁은 구간(상단=체크한 밴드들 중 제일 낮은 상단, 하단=제일 높은 하단)을 따로 계산한다.
          // "밴드는 교집합, 이평선(중심선)은 그 교집합의 한가운데"라는 사용자 설명대로 mid도 같이 둔다.
          let intersection = null
          const activeBandIds = Object.keys(overlays)
          if (activeBandIds.length >= 2) {
            const upperMaps = activeBandIds.map(id => new Map(overlays[id].upper))
            const lowerMaps = activeBandIds.map(id => new Map(overlays[id].lower))
            const commonOffsets = [...upperMaps[0].keys()]
              .filter(off => upperMaps.every(m => m.has(off)) && lowerMaps.every(m => m.has(off)))
              .sort((a, b) => a - b)
            const upper = [], mid = [], lower = []
            for (const off of commonOffsets) {
              const u = Math.min(...upperMaps.map(m => m.get(off)))
              const l = Math.max(...lowerMaps.map(m => m.get(off)))
              upper.push([off, u])
              lower.push([off, l])
              mid.push([off, Math.round((u + l) / 2 * 100) / 100])
            }
            intersection = { upper, mid, lower }
          }

          nextDays.push({ date, points, overlays, intersection })
          nextDayRows[date] = rows // "시간대별 변동성 분석"은 편차가 아니라 원본 high/low/close가 필요해서 따로 보관
        }
        if (!ignore) {
          // 달을 넘나들 때마다 days/dayRowsRef를 통째로 새로 바꾸지 않고 누적(merge)한다 - 그래야 이전에
          // 불러온 달의 날짜(예: 8월 보는 중에도 7월에 골라둔 날짜)가 계속 살아있는다. 심볼이 바뀌면
          // 다른 상품 데이터라 의미가 없으니 그때만 통째로 새로 시작한다.
          const symbolChanged = lastLoadedSymbolRef.current !== null && lastLoadedSymbolRef.current !== symbol
          lastLoadedSymbolRef.current = symbol
          if (symbolChanged) {
            setDays(nextDays)
            dayRowsRef.current = nextDayRows
          } else {
            setDays(prev => {
              const merged = new Map(prev.map(d => [d.date, d]))
              for (const d of nextDays) merged.set(d.date, d)
              return [...merged.values()].sort((a, b) => a.date.localeCompare(b.date))
            })
            dayRowsRef.current = { ...dayRowsRef.current, ...nextDayRows }
          }
          // 달/심볼이 바뀔 때만 날짜 선택을 초기화한다 - 오버레이 밴드 체크만 바꿨을 때는 고른 날짜를
          // 그대로 유지해야 방금 겹쳐보던 날짜들을 바로 이어서 볼 수 있다(사용자 편의).
          const monthKey = `${symbol}:${y}-${m}`
          if (lastMonthKeyRef.current !== monthKey) {
            lastMonthKeyRef.current = monthKey
            setSelectedDates([])
            setHourlyAnalysis(null)
            setForwardAnalysis(null)
          }
          if (nextDays.length === 0) setError('이 달엔 완전한 거래일 데이터가 없습니다')
        }
      } catch (e) {
        if (!ignore) { setError(e.message); setDays([]) }
      }
      if (!ignore) setLoading(false)
    })()

    return () => { ignore = true }
  }, [viewMonth, datasets, enabledOverlay])

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

  // y축 범위는 고른 날짜(+오버레이 밴드) 전체 기준으로 한 번만 잡고, 시간대를 좌우로 이동(팬)해도
  // 다시 계산하지 않는다 - 예전엔 "지금 보이는 구간 안의 값만" 기준으로 팬할 때마다 다시 잡아서 스크롤할
  // 때마다 세로 크기가 제멋대로 커졌다 줄었다 했다(사용자 지적) - 날짜/밴드 선택이 바뀔 때만 다시 계산.
  // y축 위에서 세로로 드래그하면 yZoom 배율만큼 이 범위를 늘리거나 줄인다(기존 기능 유지).
  const windowEnd = windowStart + windowSize - 1
  const [yZoom, setYZoom] = useState(1)
  const { yLo: baseYLo, yHi: baseYHi } = useMemo(() => {
    let lo = Infinity, hi = -Infinity
    for (const d of selectedSeries) {
      for (const [, v] of d.points) {
        if (v < lo) lo = v
        if (v > hi) hi = v
      }
      // 겹쳐 그리는 밴드가 가격선보다 위/아래로 더 벌어질 수 있으니 y축 자동범위에도 포함시킨다
      // (안 그러면 밴드 선이 차트 위/아래로 잘려서 안 보임).
      if (d.overlays) {
        for (const [bandId, ov] of Object.entries(d.overlays)) {
          for (const [which, line] of [['upper', ov.upper], ['lower', ov.lower]]) {
            if (!isOverlayLineVisible(bandId, which)) continue
            for (const [, v] of line) {
              if (v < lo) lo = v
              if (v > hi) hi = v
            }
          }
        }
      }
    }
    if (!Number.isFinite(lo)) return { yLo: -1, yHi: 1 }
    const pad = (hi - lo) * 0.08 || 1
    return { yLo: lo - pad, yHi: hi + pad }
  }, [selectedSeries, overlayLineVisibility])
  // 차트 본문을 위아래로 끌면 세로 위치(0점 포함) 자체가 그만큼 옮겨진다(사용자 요청) - value 단위 오프셋.
  const [yPan, setYPan] = useState(0)
  const { yLo, yHi } = useMemo(() => {
    const center = (baseYLo + baseYHi) / 2 - yPan
    const halfRange = (baseYHi - baseYLo) / 2 / yZoom
    return { yLo: center - halfRange, yHi: center + halfRange }
  }, [baseYLo, baseYHi, yZoom, yPan])

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
    // 확대할수록(구간이 좁을수록) 눈금 간격을 촘촘하게(분 단위까지) 줄이고, 축소할수록 라벨이 안
    // 겹치게 늘린다(사용자 요청 - "분 표시가 안 되어서 못 알아보겠다"). 라벨도 항상 HH:MM으로 찍어서
    // 정시가 아닌 지점(예: 07:14)도 축에서 바로 읽을 수 있게 한다.
    const stepMinutes =
      windowSize > 720 ? 120 :
      windowSize > 360 ? 60 :
      windowSize > 180 ? 30 :
      windowSize > 90 ? 15 :
      windowSize > 45 ? 10 :
      windowSize > 20 ? 5 : 1
    const firstTick = Math.ceil(windowStart / stepMinutes) * stepMinutes
    const lastTick = Math.floor(windowEnd / stepMinutes) * stepMinutes
    for (let mnt = firstTick; mnt <= lastTick; mnt += stepMinutes) {
      const x = px(mnt)
      ctx.beginPath(); ctx.moveTo(x, 16); ctx.lineTo(x, H - 34); ctx.stroke()
      ctx.textAlign = 'center'
      const real = fromChartOffset(mnt)
      const hh = Math.floor(real / 60), mm = real % 60
      ctx.fillText(`${String(hh).padStart(2, '0')}:${String(mm).padStart(2, '0')}`, x, H - 16)
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

    // 세계 주요 시장 개장 시각 - 지금 보이는 구간 안에 있을 때만 세로 점선 + 라벨로 표시.
    // SESSION_OPENS.minute은 실제 시각(0~1439) 그대로 두고(시간대별 분석 쪽 막대그래프도 실제 시(hour)
    // 기준으로 비교하고 있어서), 여기 메인 차트에서만 x축 오프셋으로 변환해서 쓴다.
    ctx.font = '10px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif'
    for (const session of SESSION_OPENS) {
      const sessionOffset = toChartOffset(session.minute)
      if (!inWindow(sessionOffset)) continue
      const sx = px(sessionOffset)
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

      // 체크박스로 켠 밴드가 있으면 그 날 가격선 위에 상/하단을 겹쳐 그린다 - 날짜색이 아니라
      // 밴드 고유색(실선)으로 그려서, 여러 날짜를 겹쳐봐도 "이건 몇 분B/D인지"가 항상 같은 색으로 보인다.
      if (d.overlays) {
        for (const band of ALL_BAND_DEFS) {
          const ov = d.overlays[band.id]
          if (!ov) continue
          ctx.strokeStyle = band.color
          ctx.globalAlpha = 0.55
          ctx.lineWidth = 1.2
          for (const [which, line] of [['upper', ov.upper], ['mid', ov.mid], ['lower', ov.lower]]) {
            if (!isOverlayLineVisible(band.id, which)) continue
            ctx.beginPath()
            let started2 = false
            line.forEach(([mnt, v]) => {
              if (!inWindow(mnt)) return
              const x = px(mnt), y = py(v)
              if (!started2) { ctx.moveTo(x, y); started2 = true } else ctx.lineTo(x, y)
            })
            ctx.stroke()
          }
          ctx.globalAlpha = 1
        }
      }

      // 교집합(사용자 요청) - 체크한 밴드 2개 이상이 전부 겹치는 가장 좁은 구간을 흰색 굵은 선으로
      // 도드라지게 그린다. 개별 밴드 색상과 안 겹치게 흰색 고정, 상/중/하 전부 표시(개별 상/중/하
      // 토글과는 무관 - 교집합은 파생값이라 항상 다 보여줌).
      if (showIntersection && d.intersection) {
        ctx.strokeStyle = '#FFFFFF'
        ctx.globalAlpha = 0.9
        ctx.lineWidth = 1.8
        for (const line of [d.intersection.upper, d.intersection.mid, d.intersection.lower]) {
          ctx.beginPath()
          let started3 = false
          line.forEach(([mnt, v]) => {
            if (!inWindow(mnt)) return
            const x = px(mnt), y = py(v)
            if (!started3) { ctx.moveTo(x, y); started3 = true } else ctx.lineTo(x, y)
          })
          ctx.stroke()
        }
        ctx.globalAlpha = 1
      }
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
  }, [selectedSeries, yLo, yHi, avgSeries, showAverage, hoverInfo, windowStart, windowEnd, windowSize, overlayLineVisibility, showIntersection])

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
      startYPan: yPan,
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
    const plotH = rect.height - 16 - AXIS_BOTTOM
    const drag = dragRef.current

    if (drag) {
      if (drag.mode === 'pan') {
        const deltaPx = e.clientX - drag.startClientX
        const deltaMin = -(deltaPx / plotW) * windowSize
        const maxStart = Math.max(0, DAY_WINDOW_TOTAL_MIN - windowSize)
        setWindowStart(Math.max(0, Math.min(maxStart, Math.round(drag.startWindowStart + deltaMin))))

        // 세로로 끌면 0점을 포함한 세로 위치 자체가 그만큼 옮겨간다(사용자 요청) - 잡고 아래로 끌면
        // 내용이 손을 따라 아래로 내려온다(가로 팬과 같은 "잡고 끄는" 방향 감각).
        const deltaPxY = e.clientY - drag.startClientY
        const valuePerPixel = (yHi - yLo) / plotH
        setYPan(drag.startYPan - deltaPxY * valuePerPixel)
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
        const maxStart = Math.max(0, DAY_WINDOW_TOTAL_MIN - nextSize)
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
    const maxStart = Math.max(0, DAY_WINDOW_TOTAL_MIN - nextSize)
    const nextStart = Math.max(0, Math.min(maxStart, Math.round(cursorMinute - t * (nextSize - 1))))
    setWindowSize(nextSize)
    setWindowStart(nextStart)
  }

  // 드래그 도중 마우스가 캔버스 밖으로 나가서 놓일 수도 있으니 window 전체에 mouseup을 걸어둔다
  useEffect(() => {
    window.addEventListener('mouseup', onMouseUp)
    return () => window.removeEventListener('mouseup', onMouseUp)
  }, [])

  // mnt는 이제 05:00을 0으로 삼는 x축 오프셋이라, 실제 시:분 라벨로 보여줄 땐 fromChartOffset으로
  // 되돌려야 한다(05:00~다음날06:00 구간이라 자정을 넘어가는 오프셋도 정확한 실제 시각으로 나옴).
  const fmtHM = (mnt) => { const real = fromChartOffset(mnt); return `${String(Math.floor(real / 60)).padStart(2, '0')}:${String(real % 60).padStart(2, '0')}` }
  // idx(오프셋 버킷 번호, 0=05:00대)를 실제 시:분 라벨로 - fmtHM과 같은 이유로 fromChartOffset을 거친다.
  const fmtBucket = (idx) => fmtHM(idx * MINUTES_PER_BUCKET)

  // 설정 초기화 버튼 - backtest-chart.js(학습페이지)와 같은 기능(사용자 요청). 다만 이 페이지는
  // 심볼/달/고른 날짜까지 같은 저장키에 같이 담아두므로(학습페이지는 별도 키로 분리돼있음), 초기화해도
  // 지금 보고 있던 심볼/달/날짜 선택은 그대로 유지하고 표시설정(평균선/표시모드/오버레이 밴드)만 되돌린다.
  const resetChartSettings = () => {
    if (typeof window === 'undefined') return
    if (!window.confirm('차트 설정을 전부 기본값으로 초기화할까요? (심볼/날짜는 유지됩니다)')) return
    try {
      window.localStorage.setItem(INTRADAY_SETTINGS_KEY, JSON.stringify({
        symbol,
        viewMonth: { y: viewMonth.getFullYear(), m: viewMonth.getMonth() },
        selectedDates,
        showAverage: false, enabledOverlay: {}, overlayLineVisibility: {}, showIntersection: false,
      }))
    } catch { /* ignore */ }
    window.location.reload()
  }

  // 달력 클릭 = 그 날짜를 선택 목록에 넣거나 뺀다(토글). replay.js(loadDate/loadRange)는 데이터
  // 유무를 미리 안 따지고 그냥 시도부터 하고, 없으면 그 결과가 자연히 비어 보일 뿐이다 - 여기서도
  // 사전에 막지 않고 똑같이 일단 선택목록에 넣는다(사용자 지적 - "리플레이에선 시도라도 하는데
  // 여기선 클릭도 안 먹힌다"). 데이터가 없는 날을 골라도 오버레이 차트엔 그냥 아무것도 안 그려질 뿐,
  // 에러로 막지 않는다.
  // Shift+클릭하면 직전 클릭 날짜(anchor)부터 지금 클릭한 날짜까지 구간 안의 거래일을 한번에 전부
  // 선택목록에 추가한다(replay.js의 범위선택을 이식 - 사용자 요청). 이 페이지는 원래도 클릭할 때마다
  // 목록에 "추가"되는 방식이라 replay.js처럼 별도 "여러 날 선택 모드" 스위치 없이 Shift+클릭만으로 충분.
  const handleDayClick = (dateStr, shiftKey) => {
    setError('')
    if (shiftKey && rangeAnchorRef.current) {
      const anchor = rangeAnchorRef.current
      const from = anchor <= dateStr ? anchor : dateStr
      const to = anchor <= dateStr ? dateStr : anchor
      const rangeDates = days.map(d => d.date).filter(d => d >= from && d <= to)
      setSelectedDates(prev => [...new Set([...prev, ...rangeDates])].sort())
      rangeAnchorRef.current = dateStr
      return
    }
    rangeAnchorRef.current = dateStr
    setSelectedDates(prev => prev.includes(dateStr) ? prev.filter(d => d !== dateStr) : [...prev, dateStr].sort())
  }

  // replay.js의 "📸 스샷"과 같은 기능(사용자 요청) - 다만 이 페이지는 lightweight-charts가 아니라
  // 그냥 <canvas>에 직접 그리는 방식이라 chart.takeScreenshot() 같은 라이브러리 메서드가 없다.
  // <canvas> 자체가 이미 픽셀 버퍼라 canvas.toBlob()으로 바로 지금 보이는 화면 그대로를 PNG로 뽑는다.
  const captureScreenshot = () => {
    const canvas = canvasRef.current
    if (!canvas) return
    canvas.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const dateLabel = selectedDates.length
        ? (selectedDates.length === 1 ? selectedDates[0] : `${selectedDates[0]}_${selectedDates[selectedDates.length - 1]}`)
        : 'chart'
      a.href = url
      a.download = `${symbol}_일중패턴_${dateLabel}.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    })
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

  // rows(dayRowsRef.current[date])의 버킷 인덱스를 실제 시각이 아니라 "05:00을 0으로 삼는 오프셋"
  // 기준으로 구한다(메인 오버레이 차트와 동일한 05:00~익일06:00 하루 정의, 사용자 요청 - "다 적용을
  // 해야지"). rows엔 그 날짜 자신의 05:00~23:59와 다음날 00:00~05:59(연장분)가 섞여있는데, 실제
  // 달력날짜(date)와 같은지로 "자기 날짜 몫"인지 "다음날 연장 몫"인지 구분해야 05:00~05:59 겹침
  // 구간에서 서로 다른 두 날의 캔들이 같은 버킷으로 충돌하지 않는다(main 오버레이 차트의 rowOffset과 동일 로직).
  const rowBucketIdx = (r, date) => {
    const d = new Date(r.time * 1000)
    const minuteOfDay = d.getHours() * 60 + d.getMinutes()
    const offset = toLocalDateStr(r.time) === date ? (minuteOfDay - DAY_WINDOW_START_MIN) : (minuteOfDay + (1440 - DAY_WINDOW_START_MIN))
    return Math.floor(offset / MINUTES_PER_BUCKET)
  }

  const findPivotScores = (rows, date) => {
    const dayLast = new Array(TOTAL_BUCKETS).fill(null)
    const dayRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const dayRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    for (const r of rows) {
      const idx = rowBucketIdx(r, date)
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

  // 이 순수 계산 함수를 runHourlyAnalysis 버튼이 결과를 state로 저장할 때 쓴다.
  const computeHourlyAnalysis = useCallback((dates) => {
    if (!dates || dates.length === 0) return null
    const bucketRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const bucketRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    const bucketPivotScore = new Array(TOTAL_BUCKETS).fill(0)

    for (const date of dates) {
      const rows = dayRowsRef.current[date]
      if (!rows || rows.length === 0) continue
      const { pivotScore, dayRangeSum, dayRangeCnt } = findPivotScores(rows, date)
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
  const findForwardMoveScores = (rows, date) => {
    const dayLast = new Array(TOTAL_BUCKETS).fill(null)
    const dayRangeSum = new Array(TOTAL_BUCKETS).fill(0)
    const dayRangeCnt = new Array(TOTAL_BUCKETS).fill(0)
    for (const r of rows) {
      const idx = rowBucketIdx(r, date)
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
      const { score, dayRangeSum, dayRangeCnt } = findForwardMoveScores(rows, date)
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
          {/* hourGroup은 버킷 인덱스 그룹(0=05:00대 ~ 24=익일05:00대, 05:00~익일06:00 하루 기준의 25개
              시간대) - 화면에 보여줄 실제 시(hour)는 fromChartOffset으로 되돌려서 구한다(사용자 요청 -
              "다 적용을 해야지"). */}
          {Array.from({ length: TOTAL_BUCKETS / BUCKETS_PER_HOUR }, (_, hourGroup) => {
            const displayHour = Math.floor(fromChartOffset(hourGroup * 60) / 60)
            const sessionHere = SESSION_OPENS.find(s => Math.floor(s.minute / 60) === displayHour)
            return (
              <div
                key={hourGroup}
                style={{
                  flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', alignItems: 'center',
                  borderLeft: hourGroup !== 0 ? '1px solid #2a2e38' : 'none', paddingLeft: hourGroup !== 0 ? 3 : 0,
                }}
              >
                {/* 1시간마다 세로선으로 구분 - 그 시간의 15분 버킷 4개를 한 그룹으로 묶어서 아래 시간 숫자가 정가운데에 오게 한다 */}
                <div style={{ display: 'flex', alignItems: 'flex-end', gap: 1, width: '100%', height: 180 }}>
                  {Array.from({ length: BUCKETS_PER_HOUR }, (_, quarter) => {
                    const idx = hourGroup * BUCKETS_PER_HOUR + quarter
                    const info = byBucket.get(idx)
                    const barH = info ? Math.max(3, (info.sharePct / maxShare) * 158) : 0
                    const top3 = !!info && info.rank <= 3
                    const label = fmtBucket(idx)
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
                  {String(displayHour).padStart(2, '0')}
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

  return (
    <>
      <Head><title>일중 패턴 — EasyTrade 백테스팅</title></Head>
      <div style={{ minHeight: '100vh', background: '#0f1115', color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 28px', borderBottom: '1px solid #2a2e38' }}>
          <BrandLogo label="일중 패턴" />
          <nav style={{ display: 'flex', gap: 6 }}>
            <Link href="/backtest-chart" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>학습</Link>
            <span style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'rgba(76,175,80,0.15)', color: '#4CAF50', border: '1px solid #4CAF50' }}>📈 일중 패턴</span>
            <Link href="/replay" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>🔁 리플레이</Link>
          </nav>
        </header>

        <main style={{ maxWidth: 1200, margin: '0 auto', padding: '28px 20px 60px' }}>
          <div>
            <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>일중 패턴 — 시가 대비 편차 오버레이</h1>
            <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 20, maxWidth: 760 }}>
              왼쪽 달력에서 날짜를 하나씩 클릭해서 겹쳐볼 날짜를 골라주세요. 고른 날짜의 종가에서 그날 시가(한국시간 07:00 기준 - 실제 거래 시작 시점)를 뺀 값을 시간대별로 겹쳐 그립니다 - 0선이 07:00 가격입니다. 차트를 드래그하면 좌우로 이동하고, 마우스 휠로 확대/축소할 수 있습니다.
            </p>
          </div>

          {/* 하루 25시간(05:00~익일06:00, 15분 단위 100칸) 중 언제 변동이 몰리는지(=언제 자리를 지키고 있어야 하는지) 별도 분석 */}
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
              const missingHoursSet = new Set(hourlyAnalysis.missingBuckets.map(idx => Math.floor(fromChartOffset(idx * MINUTES_PER_BUCKET) / 60)))
              const caption = (
                <>
                  {SYMBOL_LABEL[symbol]} · 고른 날짜 {hourlyAnalysis.dayCount}일 기준 - 그 15분 구간이 국소 고점/저점(전환점)이었던 날짜에서, 그 다음 전환점까지 실제로 얼마나 움직였는지로 비중을 매김. 막대가 있는 곳 = 여기서부터 지켜보고 있었어야 할 시점, 막대가 없으면 그 구간엔 전환점이 없었다는 뜻(활동량과 무관). 순위 숫자는 100칸 전부 표시(세로쓰기), 상위 3개는 초록색.
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
              const missingHoursSet = new Set(forwardAnalysis.missingBuckets.map(idx => Math.floor(fromChartOffset(idx * MINUTES_PER_BUCKET) / 60)))
              const caption = (
                <>
                  {SYMBOL_LABEL[symbol]} · 고른 날짜 {forwardAnalysis.dayCount}일 기준 - 전환점 여부와 무관하게, 이 15분 구간에서부터 15분/1시간/2시간/4시간 뒤 가격들과 비교해 그중 가장 많이 움직인 폭으로 비중을 매김. 방향이 안 바뀌고 계속 같은 쪽으로 크게 움직이는 구간도 여기선 잡힘. 순위 숫자는 100칸 전부 표시(세로쓰기), 상위 3개는 초록색.
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
              <button
                onClick={resetChartSettings}
                title="평균선 표시/표시모드/오버레이 밴드 등 표시 설정을 기본값으로 되돌립니다(심볼/날짜는 유지)"
                style={{
                  width: '100%', background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '7px 0', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                }}
              >↺ 설정 초기화</button>
              {/* 가격선 위에 그 날의 볼린저/도치안 밴드를 겹쳐 그리는 체크박스 - 드롭다운(하나만 고름)이
                  아니라 체크박스로 해야 여러 개를 동시에 켜서 서로 겹쳐볼 수 있다(사용자 요청).
                  볼린저/도치안 각각 접었다 펼 수 있는 별도 카드로 분리(사용자 요청, replay.js와 같은 방식). */}
              {/* localStorage에서 복원된 체크 상태가 있는데 카드가 기본 접힘이면 체크 표시가 안 보여서
                  "새로고침하니 체크한 게 사라졌다"로 오해할 수 있다(사용자 지적) - 복원 시점에 이미
                  켜진 밴드가 있는 그룹은 처음부터 펼쳐서 보여준다. */}
              {[['볼린저', BOLLINGER_BANDS], ['도치안', DONCHIAN_CHANNELS]].map(([groupLabel, bands]) => (
                <CollapsibleCard key={groupLabel} title={groupLabel} maxWidth={220} defaultOpen={bands.some(b => enabledOverlay[b.id])}>
                  {bands.map(b => {
                    const on = !!enabledOverlay[b.id]
                    return (
                      <div key={b.id} style={{ padding: '3px 0' }}>
                        <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                          <input
                            type="checkbox"
                            checked={on}
                            onChange={() => toggleOverlay(b.id)}
                            style={{ width: 12, height: 12, margin: 0, accentColor: b.color, flexShrink: 0 }}
                          />
                          <span style={{ color: on ? b.color : '#e8eaed' }}>{b.label}</span>
                        </label>
                        {/* replay.js/backtest-chart.js와 동일 - 체크한 밴드에 한해 위/중심/아래를 따로 켜고 끌 수 있게(사용자 요청) */}
                        {on && (
                          <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 16, marginTop: 3 }}>
                            {[['upper', '상'], ['mid', '중'], ['lower', '하']].map(([which, wlabel]) => {
                              const vis = isOverlayLineVisible(b.id, which)
                              return (
                                <button
                                  key={which}
                                  type="button"
                                  onClick={() => toggleOverlayLine(b.id, which)}
                                  style={{
                                    fontSize: 10, padding: '2px 6px', borderRadius: 5,
                                    border: `1px solid ${vis ? b.color : '#2a2e38'}`,
                                    background: vis ? `${b.color}22` : 'none',
                                    color: vis ? b.color : '#5a5f6a',
                                    cursor: 'pointer',
                                  }}
                                >{wlabel}</button>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </CollapsibleCard>
              ))}
              <MonthCalendar
                viewDate={viewMonth}
                onNavigate={navigateMonth}
                availableDates={availableDates}
                dateColors={dateColors}
                onSelect={handleDayClick}
                maxWidth={220}
              />
              <div style={{ fontSize: 11, color: '#FFB74D', lineHeight: 1.5 }}>
                ⚠ 한 번에 너무 긴 기간을 불러오면 느려질 수 있어요 — 1주일 단위로 나눠서 보는 걸 추천해요.
              </div>
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
            {/* 왼쪽 사이드바를 스크롤해서 내려도 이 컬럼이 화면 밖으로 사라지지 않게 sticky로 고정한다
                (사용자 요청). replay.js/backtest-chart.js는 왼쪽 사이드바가 훨씬 길어서 오른쪽 컬럼에도
                maxHeight+내부스크롤(overflowY:auto)을 같이 걸었는데, 이 페이지는 왼쪽이 그정도로 길지
                않아서 그 내부스크롤 제약이 오히려 페이지 전체 드래그/스크롤을 막는 문제가 있었다(사용자
                지적) - maxHeight/overflow 없이 sticky만 남긴다. */}
            <div style={{ flex: 1, minWidth: 280, position: 'sticky', top: 20 }}>
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 20, position: 'relative' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 18, marginBottom: 14, flexWrap: 'wrap', fontSize: 12.5, color: '#9aa0ab' }}>
                  <span>고른 날짜별로 색이 다릅니다(왼쪽 목록 참고)</span>
                  {selectedSeries.length >= 2 && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={showAverage} onChange={e => setShowAverage(e.target.checked)} style={{ width: 13, height: 13, margin: 0 }} />
                      평균선 표시
                    </label>
                  )}
                  {/* 밴드 체크만 해도 자동으로 겹쳐 나오지 않게 별도 토글로 분리(사용자 지적) - 2개
                      이상 켰을 때만 의미가 있으니 그때만 노출한다. */}
                  {Object.values(enabledOverlay).filter(Boolean).length >= 2 && (
                    <label style={{ display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                      <input type="checkbox" checked={showIntersection} onChange={e => setShowIntersection(e.target.checked)} style={{ width: 13, height: 13, margin: 0 }} />
                      교집합 표시
                    </label>
                  )}
                  <span style={{ marginLeft: 'auto', fontWeight: 700, color: '#e8eaed' }}>{fmtHM(windowStart)} ~ {fmtHM(windowEnd + 1)}</span>
                  <button
                    type="button"
                    onClick={captureScreenshot}
                    disabled={selectedSeries.length === 0}
                    title="지금 보이는 상태 그대로 PNG로 저장"
                    style={{
                      background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 8,
                      padding: '5px 10px', fontSize: 12, cursor: selectedSeries.length === 0 ? 'not-allowed' : 'pointer',
                    }}
                  >📸 스샷</button>
                </div>
                <div ref={wrapRef} style={{ position: 'relative' }}>
                  <canvas
                    ref={canvasRef}
                    onMouseDown={onMouseDown}
                    onMouseMove={onMouseMove}
                    onMouseLeave={() => { setHoverInfo(null); if (!dragRef.current) setCursorStyle('grab') }}
                    onWheel={onWheel}
                    // touchAction: 'none'이면 터치 드래그가 전부 차트 좌우 팬(가로) 전용으로 잡혀서, 세로로
                    // 끌어 페이지를 스크롤하려는 시도(터치기기)가 브라우저 기본 동작에서부터 막혀버렸다
                    // (사용자 지적 - "캔버스 안쪽을 잡고 내려도 안 움직인다"). 'pan-y'로 바꿔서 세로 방향은
                    // 브라우저가 페이지 스크롤로 처리하게 두고, 가로 방향만 계속 커스텀 팬으로 남긴다.
                    style={{ display: 'block', width: '100%', height: 600, cursor: cursorStyle, touchAction: 'pan-y' }}
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
                {/* replay.js 재생바 위 "0/1,020봉 2026-07-27"과 같은 자리(차트 바로 아래) - 몇 일
                    골랐고 그 안에 캔들(봉)이 총 몇 개인지, 그리고 정확히 어느 날짜(들)인지 바로 확인할
                    수 있게(사용자 요청 - "몇월 며칠 선택한건지는 표시 안됨"). */}
                {selectedDates.length > 0 && (
                  <div style={{ marginTop: 10, color: '#9aa0ab', fontSize: 13 }}>
                    {selectedDates.length}일 선택 · {selectedDates.reduce((sum, d) => sum + (dayRowsRef.current[d]?.length || 0), 0).toLocaleString()}봉
                    {' · '}
                    <span style={{ color: '#e8eaed', fontWeight: 700 }}>
                      {selectedDates.length === 1 ? selectedDates[0] : `${selectedDates[0]} ~ ${selectedDates[selectedDates.length - 1]}`}
                    </span>
                  </div>
                )}
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
