import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, CollapsibleCard, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, MOVING_AVERAGES, MADRID_RIBBON, computeMA, rollingRSI, rollingMACD } from '../lib/indicators'

// 이평선 데이터 계산/토글 파이프라인(maDataRef/maSeriesRef/enabledMA 등)은 id로만 구분하므로
// 리본도 같은 파이프라인을 공유한다 - 화면에서만 "리본" 카드로 따로 묶어서 보여준다(사용자 요청).
const ALL_MA = [...MOVING_AVERAGES, ...MADRID_RIBBON]

// 리본 전용 - 오를 땐 라임/내릴 땐 레드로(Madrid 원본 색, 사용자 요청 "트레이딩뷰처럼").
// lightweight-charts는 선 하나 안에서 구간별 색을 못 바꾸므로, 선마다 상승구간 시리즈(라임)와
// 하락구간 시리즈(레드) 둘로 쪼개서 겹쳐 그린다. 색이 바뀌는 경계에서는 두 시리즈 모두에 그
// 경계점을 포함시켜(중복) 끊어져 보이지 않게 이어붙인다.
const RIBBON_LIME = '#00FF00'
const RIBBON_RED = '#FF0000'
// 리본 18개 + "3분 H"(hma60, 사용자 요청) - 이 id들은 단색 대신 상승/하락 두 색으로 동적 렌더링한다.
const DUAL_COLOR_IDS = new Set([...MADRID_RIBBON.map(m => m.id), 'hma60'])
const isDualColor = (maId) => DUAL_COLOR_IDS.has(maId)
const RIBBON_IDS = new Set(MADRID_RIBBON.map(m => m.id))
const isRibbonId = (maId) => RIBBON_IDS.has(maId)
// hex(#RRGGBB) -> rgba(r,g,b,alpha) 문자열 - 리본 18개 선에만 투명도를 적용할 때 씀(hma3는 불투명 유지, 사용자 요청)
function hexToRgba(hex, alpha) {
  const h = (hex || '#000000').replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
function splitRibbonBySlope(points) {
  const n = points.length
  const lime = new Array(n).fill(null)
  const red = new Array(n).fill(null)
  let lastState = null
  for (let i = 1; i < n; i++) {
    const p0 = points[i - 1], p1 = points[i]
    if (!p0 || !p1) { lastState = null; continue }
    const state = p1.value >= p0.value ? 'lime' : 'red'
    const arr = state === 'lime' ? lime : red
    if (lastState !== state) arr[i - 1] = p0 // 색 바뀌는 경계점은 새 색 쪽에도 포함시켜 이어붙임
    arr[i] = p1
    lastState = state
  }
  return { lime, red }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
// x1 = 실제 1분봉 그대로(캔들 1개 = 60초). 다른 배속은 전부 이 기준의 배수.
const SPEEDS = [0.25, 0.5, 1, 2, 3, 5, 20, 60, 100, 200, 300]
const REALTIME_MS = 60000
const MIN_TICK_MS = 50 // setInterval 실질 하한 - 이보다 짧은 간격은 한 틱에 여러 캔들을 진행시켜 흉내낸다
const MA_WIDTHS = [1, 2, 3, 4]
const RSI_PERIOD = 14
const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9
// MACD5 = "5분" MACD - 볼린저/이평선과 같은 멀티 타임프레임 치환 규칙(1분봉 기준 기간 × 5)을 그대로 적용
const MACD5_FAST = 60
const MACD5_SLOW = 130
const MACD5_SIGNAL = 45
const DEFAULT_RSI_COLOR = '#FFB74D'
const DEFAULT_MACD_LINE_COLOR = '#42A5F5'
const DEFAULT_MACD_SIGNAL_COLOR = '#FF7043'
const DEFAULT_MACD_HIST_UP = '#26A69A'
const DEFAULT_MACD_HIST_DOWN = '#EF5350'
const DEFAULT_MACD5_LINE_COLOR = '#AB47BC'
const DEFAULT_MACD5_SIGNAL_COLOR = '#FFCA28'
// RSI(0~100)/MACD(진동값)는 캔들 가격축과 스케일이 전혀 달라 같은 축에 못 그림 -
// lightweight-charts v5의 진짜 pane API(addSeries의 세 번째 인자 paneIndex)로 별도 창에 그린다.
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
// "볼린저 눌림" 조건 고정 페어 - 크로스/더블비와 달리 이건 원래부터 5분↔15분으로 고정이었고
// 슬롯/드롭다운으로 바꾸지 말라는 요청(사용자 확인) - 그대로 고정 유지.
const BOLL_INNER_SHORT_ID = 'sma100' // 5분
const BOLL_INNER_LONG_ID = 'sma300'  // 15분
const EMPTY_PAIR_SLOTS = [{ a: '', b: '' }, { a: '', b: '' }, { a: '', b: '' }]
// 더블비 슬롯 드롭다운에 쓰는 라인 옵션 목록 - 밴드 5개 × 상/중/하 = 15개, state에 안 의존하니 모듈 레벨에서 한 번만 계산
const DOUBLE_B_LINE_OPTIONS = BOLLINGER_BANDS.flatMap(b =>
  [['upper', '상'], ['middle', '중'], ['lower', '하']].map(([which, wlabel]) => ({ id: `${b.id}:${which}`, label: `${b.label} ${wlabel}` }))
)
// 세계 3대 시장 개장 시각 - 전부 이 차트/일중패턴 차트의 시간 라벨(브로커 서버+서머타임 오프셋,
// candleCsv.js 기준 한국시간과 동일) 기준 분(minute-of-day)이다. 유럽(런던)은 서머타임(BST) 기준
// 08:00 런던시각=07:00 UTC=16:00 이 시간 라벨(사용자 확인) - 겨울(GMT)엔 17:00으로 밀림.
const SESSION_OPENS = [
  { label: '아시아', minute: 7 * 60, color: '#64B5F6' },
  { label: '유럽', minute: 16 * 60, color: '#FFD54F' },
  { label: '미장', minute: 22 * 60 + 30, color: '#BA68C8' },
]

function publicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`
}

// lightweight-charts는 숫자 타임스탬프를 축/툴팁에 표시할 때 기본적으로 UTC로 포맷한다.
// 반면 candleCsv.js의 toUnixSeconds/toLocalDateStr은 시간대 표기 없는 원본 문자열을
// "브라우저 로컬시간 그대로"로 해석한다 - 이 둘의 기준이 서로 달라서, 한국시간 자정
// 근처 캔들이 날짜 필터링(로컬)과 화면 표시(UTC)에서 서로 다른 날짜로 보이는 문제가 있었다.
// 화면 표시도 로컬(new Date().getHours() 등)로 맞춰서 둘의 기준을 통일한다.
function localTickMarkFormatter(time) {
  const d = new Date(time * 1000)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  if (hh === '00' && mm === '00') {
    const yy = String(d.getFullYear()).slice(-2)
    return `${yy}년 ${d.getMonth() + 1}월 ${d.getDate()}일`
  }
  return `${hh}:${mm}`
}

function localTimeFormatter(time) {
  const d = new Date(time * 1000)
  const yy = String(d.getFullYear()).slice(-2)
  const hh = String(d.getHours()).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return `${yy}년 ${d.getMonth() + 1}월 ${d.getDate()}일 ${hh}:${mm}`
}

// 크로스/더블비/눌림 슬롯에서 쓰는 커스텀 드롭다운 - 네이티브 <select>는 옵션 목록 팝업 너비를
// 브라우저가 내용 길이에 맞춰 자기 마음대로 정해서(CSS로 못 줄임), 좁은 170px 카드 밖으로
// 옵션 목록이 튀어나오는 문제가 있었다(라벨을 줄여도 여전히 브라우저 재량이라 근본 해결이 안 됨).
// 그래서 직접 그리는 팝업으로 바꿔서 너비를 완전히 우리가 통제한다(트리거 버튼과 같은 너비, 넘치면 줄임표).
function PairSelect({ value, onChange, options, placeholder = '-' }) {
  const [open, setOpen] = useState(false)
  const wrapRef = useRef(null)

  useEffect(() => {
    if (!open) return
    const onDocClick = (e) => { if (wrapRef.current && !wrapRef.current.contains(e.target)) setOpen(false) }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [open])

  const selected = options.find(o => o.id === value)

  return (
    <div ref={wrapRef} style={{ position: 'relative', flex: 1, minWidth: 0 }}>
      <button
        type="button"
        onClick={() => setOpen(o => !o)}
        style={{
          width: '100%', textAlign: 'left', background: '#0f1115', color: value ? '#e8eaed' : '#5a5f6a',
          border: `1px solid ${open ? '#4CAF50' : '#2a2e38'}`, borderRadius: 6, fontSize: 11, padding: '3px 6px',
          cursor: 'pointer', display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 2,
        }}
      >
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{selected ? selected.label : placeholder}</span>
        <span style={{ fontSize: 9, flexShrink: 0, color: '#5a5f6a' }}>▾</span>
      </button>
      {open && (
        <div
          style={{
            position: 'absolute', top: '100%', left: 0, zIndex: 30, marginTop: 2,
            width: 'max-content', minWidth: '100%', maxWidth: 160, maxHeight: 190, overflowY: 'auto',
            background: '#171a21', border: '1px solid #2a2e38', borderRadius: 6,
            boxShadow: '0 6px 16px rgba(0,0,0,0.45)',
          }}
        >
          <div
            onClick={() => { onChange(''); setOpen(false) }}
            style={{ padding: '5px 8px', fontSize: 11, color: '#5a5f6a', cursor: 'pointer' }}
          >{placeholder}</div>
          {options.map(o => (
            <div
              key={o.id}
              onClick={() => { onChange(o.id); setOpen(false) }}
              style={{
                padding: '5px 8px', fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
                color: o.id === value ? '#4CAF50' : '#e8eaed',
                background: o.id === value ? 'rgba(76,175,80,0.12)' : 'none',
              }}
            >{o.label}</div>
          ))}
        </div>
      )}
    </div>
  )
}

// 다른 페이지 갔다가 돌아왔을 때(뒤로가기 등, 컴포넌트가 완전히 언마운트/리마운트됨) 심볼·선택한 날짜·
// 재생 위치가 리셋되던 문제 - 탭을 닫기 전까진 유지되는 sessionStorage에 저장해두고 마운트 시 복원한다.
// (새로고침에도 유지되길 원하면 localStorage로 바꾸면 되지만, 여긴 "이 세션 동안만" 기준으로 sessionStorage 사용)
const BACKTEST_STATE_KEY = 'backtestChartState'

export default function BacktestChart() {
  // 마운트 시 딱 한 번만 sessionStorage를 읽어서 ref에 담아둔다(렌더 중 계산이라 useEffect보다 먼저 값이 준비됨).
  const restoreRef = useRef(undefined)
  if (restoreRef.current === undefined) {
    restoreRef.current = null
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem(BACKTEST_STATE_KEY)
        if (raw) restoreRef.current = JSON.parse(raw)
      } catch { /* 저장된 값이 깨져있으면 그냥 무시하고 기본값으로 시작 */ }
    }
  }
  const hasAutoRestoredRef = useRef(false)

  const [symbol, setSymbol] = useState(() => restoreRef.current?.symbol || 'NASDAQ')
  // 브로커 서머타임 여부 - 겨울엔 서버시간이 1시간 밀려서(EEST→EET) 한국시간 환산 오프셋이 6→7시간으로 바뀐다.
  // 자동판별할 방법이 없어서 버튼으로 직접 전환하게 함(기본값: 서머타임 켜짐)
  const [summerTime, setSummerTime] = useState(true)
  const [datasets, setDatasets] = useState([])
  const [viewDate, setViewDate] = useState(new Date())
  const [selectedDate, setSelectedDate] = useState('')
  const [selectedDateTo, setSelectedDateTo] = useState('') // 여러 날 선택 모드에서 범위의 끝 날짜 (단일 선택이면 '')
  const [multiSelectMode, setMultiSelectMode] = useState(false) // 켜면 달력 클릭 두 번으로 범위(여러 날)를 이어서 불러온다
  const [loadingCsv, setLoadingCsv] = useState(false)
  const [error, setError] = useState('')
  const [playing, setPlaying] = useState(false)
  const [speed, setSpeed] = useState(1)
  const [playIndex, setPlayIndex] = useState(0)
  const [total, setTotal] = useState(0)
  // 기본 셋팅(사용자 요청) - 1분 볼린저는 중간선만, 5분/15분/1시간 볼린저는 전체 표시
  const [enabledBands, setEnabledBands] = useState({ sma20: true, sma100: true, sma300: true, sma1200: true })
  const [lineVisibility, setLineVisibility] = useState({}) // `${bandId}:${upper|middle|lower}` -> false면 숨김 (기본 true, 1분B 상/하도 기본 켜짐 - 사용자 요청)
  const [bandColors, setBandColors] = useState({}) // bandId -> 커스텀 색상 (없으면 BOLLINGER_BANDS 기본색)
  // 기본 셋팅 - 3분/5분/15분 H, 1분/5분 W17, 1시간 W4 이평선 체크
  const [enabledMA, setEnabledMA] = useState({
    hma60: true, hma100: true, hma300: true, wma17_1m: true, wma17_5m: true, wma4_1h: true,
    ...Object.fromEntries(MADRID_RIBBON.map(m => [m.id, true])), // 리본 기본 체크(사용자 요청)
  })
  const [maColors, setMaColors] = useState({}) // maId -> 커스텀 색상 (없으면 MOVING_AVERAGES 기본색, 볼린저와 동일)
  // 기본 셋팅 - 위 6개 이평선 전부 두께 3
  const [maWidths, setMaWidths] = useState({ hma60: 3, hma100: 3, hma300: 3, wma17_1m: 3, wma17_5m: 3, wma4_1h: 3 }) // maId -> 커스텀 선 굵기 (없으면 MOVING_AVERAGES 기본 lineWidth)
  // 리본(Madrid) - MACD처럼 체크박스 하나가 켜고 끄는 세트(사용자 요청).
  const [ribbonEnabled, setRibbonEnabledState] = useState(true) // 기본 체크(사용자 요청)
  const [ribbonOpacity, setRibbonOpacityState] = useState(0.2) // 리본 18개 선 전용 투명도(0~1, 기본 20%, 사용자 요청) - hma3는 영향 없음
  // DUAL_COLOR_IDS(리본 18개 + hma60)의 상승/하락 색 - maId -> 커스텀 색(없으면 RIBBON_LIME/RIBBON_RED)
  const [maUpColors, setMaUpColors] = useState({ hma60: '#00D5FF' }) // 3분 H 상승색 기본값(사용자 지정)
  const [maDownColors, setMaDownColors] = useState({})
  // RSI/MACD - 기간은 표준값(14 / 12,26,9)으로 고정, 색상만 커스터마이징 가능. 기본은 꺼짐(체크해야 나옴)
  const [enabledRSI, setEnabledRSI] = useState(false)
  const [rsiColor, setRsiColorState] = useState(DEFAULT_RSI_COLOR)
  const [enabledMACD, setEnabledMACD] = useState(false)
  const [macdLineColor, setMacdLineColorState] = useState(DEFAULT_MACD_LINE_COLOR)
  const [macdSignalColor, setMacdSignalColorState] = useState(DEFAULT_MACD_SIGNAL_COLOR)
  const [enabledMACD5, setEnabledMACD5] = useState(false)
  const [macd5LineColor, setMacd5LineColorState] = useState(DEFAULT_MACD5_LINE_COLOR)
  const [macd5SignalColor, setMacd5SignalColorState] = useState(DEFAULT_MACD5_SIGNAL_COLOR)
  const [upColor, setUpColorState] = useState(DEFAULT_UP_COLOR)
  const [downColor, setDownColorState] = useState(DEFAULT_DOWN_COLOR)
  const [candleVisible, setCandleVisible] = useState(() => restoreRef.current?.candleVisible ?? true) // 체크 해제하면 캔들을 숨김(지표만 보고 판단 연습할 때 씀) - 기본 체크됨
  // 왼쪽 "크로스/더블비/눌림 신호" 표시 - 예전엔 체크박스를 여러 개 켜면 그 안에서 가능한 모든 조합을
  // 자동으로 판정했는데(체크 3개면 3쌍이 전부 감지되는 식으로 통제가 안 됨), 각각 1/2/3 슬롯으로 나눠
  // 슬롯마다 정확히 2개(드롭다운)만 골라 그 조합만 보게 바꿈(사용자 요청) - 크로스/더블비/눌림 전부 동일 방식,
  // 반자동(auto)/시뮬레이션(sim)도 같은 방식으로 통일함.
  const [crossPairs, setCrossPairs] = useState(EMPTY_PAIR_SLOTS)
  // 골든크로스(단기선이 장기선을 아래에서 위로 돌파)/데드크로스(그 반대) 표시를 따로 설정
  const [goldenShape, setGoldenShapeState] = useState('arrowUp')
  const [goldenColor, setGoldenColorState] = useState(DEFAULT_GOLDEN_COLOR)
  const [goldenSize, setGoldenSizeState] = useState(3) // 기본 셋팅(사용자 요청) - 크로스 신호 크기 3번
  const [deadShape, setDeadShapeState] = useState('arrowDown')
  const [deadColor, setDeadColorState] = useState(DEFAULT_DEAD_COLOR)
  const [deadSize, setDeadSizeState] = useState(3) // 기본 셋팅(사용자 요청) - 크로스 신호 크기 3번
  // 더블비 신호(왼쪽 표시용) - 슬롯 1/2/3마다 라인(`${bandId}:${upper|middle|lower}`) 2개를 드롭다운으로 골라
  // 그 쌍의 겹침만 본다. 반자동/시뮬레이션의 더블비 조건(autoDoubleBPairs/simDoubleBPairs)과 슬롯 상태는
  // 따로 관리하지만, 계산 함수(computeDoubleBTouchForPair)는 공유한다.
  const [doubleBPairs, setDoubleBPairsState] = useState(EMPTY_PAIR_SLOTS)
  // 더블비 신호 모양/색상/크기 - 매수(롱)/매도(숏) 방향별로 따로 저장하고, 크로스 신호(골든/데드)와 같은
  // 방식으로 롱/숏 두 행을 탭 전환 없이 항상 같이 보여준다(사용자 요청 - 통일성)
  const [doubleBShapeLong, setDoubleBShapeLongState] = useState('square')
  const [doubleBColorLong, setDoubleBColorLongState] = useState('#00BCD4')
  const [doubleBSizeLong, setDoubleBSizeLongState] = useState(1)
  const [doubleBShapeShort, setDoubleBShapeShortState] = useState('square')
  const [doubleBColorShort, setDoubleBColorShortState] = useState('#FF6D00')
  const [doubleBSizeShort, setDoubleBSizeShortState] = useState(1)
  // 볼린저 눌림 신호(왼쪽 표시용, 5분↔15분 고정) - 반자동/시뮬레이션의 볼린저 눌림 조건과 켜고 끄는 체크는
  // 따로 관리하지만 계산 함수(computeBollInnerTouchForPair)는 공유한다.
  const [bollInnerSignalSellEnabled, setBollInnerSignalSellEnabled] = useState(false) // 5분 상단선이 15분 상단선 안(아래)
  const [bollInnerSignalBuyEnabled, setBollInnerSignalBuyEnabled] = useState(false)   // 5분 하단선이 15분 하단선 안(위)
  // 롱/숏 모양/색상/크기 - 더블비와 같은 이유로 탭 전환 없이 두 행을 항상 같이 보여준다
  const [bollInnerShapeLong, setBollInnerShapeLongState] = useState('circle')
  const [bollInnerColorLong, setBollInnerColorLongState] = useState('#26A69A')
  const [bollInnerSizeLong, setBollInnerSizeLongState] = useState(1)
  const [bollInnerShapeShort, setBollInnerShapeShortState] = useState('circle')
  const [bollInnerColorShort, setBollInnerColorShortState] = useState('#EF5350')
  const [bollInnerSizeShort, setBollInnerSizeShortState] = useState(1)
  // 매매 연습 - 헤징 허용(바이/셀 동시 보유 가능), 수수료/스프레드는 계산 안 함
  const [startingBalance, setStartingBalanceState] = useState(DEFAULT_STARTING_BALANCE)
  const [balance, setBalance] = useState(DEFAULT_STARTING_BALANCE)
  const [lotSize, setLotSize] = useState(0.01)
  const [positions, setPositions] = useState([]) // { id, side:'buy'|'sell', symbol, lot, entryPrice, entryTime }
  const [pnlDisplay, setPnlDisplay] = useState('dollar') // 'dollar' | 'point'
  // 반자동진입 - 왼쪽 표시(크로스는 crossPairs, 더블비는 doubleBPairs 슬롯)와 켜고 끄는 슬롯 상태는
  // 따로 관리한다(화면엔 여러 개 띄워두고 그중 일부만 실전 진입 조건으로 쓸 수 있게). 계산 로직
  // (findMACrossForPair / computeDoubleBTouchForPair / computeBollInnerTouchForPair)은 공유하므로,
  // 왼쪽과 여기에 같은 조합을 골라두면 마커 표시 캔들 = 실제 진입 캔들이 항상 일치한다.
  // 볼린저 눌림은 크로스/더블비와 달리 원래부터 5분↔15분 고정이라 여기도 그대로 고정 유지.
  const [semiAutoEnabled, setSemiAutoEnabled] = useState(false)
  const [autoCrossPairs, setAutoCrossPairsState] = useState(EMPTY_PAIR_SLOTS)
  const [autoDoubleBPairs, setAutoDoubleBPairsState] = useState(EMPTY_PAIR_SLOTS)
  // "볼린저 눌림"(5분↔15분 고정) - 상단/하단 조건을 따로 켜고 끌 수 있다
  const [autoBollInnerSellEnabled, setAutoBollInnerSellEnabled] = useState(false) // 5분 상단선이 15분 상단선 안(아래)일 때 매도
  const [autoBollInnerBuyEnabled, setAutoBollInnerBuyEnabled] = useState(false)   // 5분 하단선이 15분 하단선 안(위)일 때 매수

  // 시뮬레이션 - 반자동과 조건 구성은 완전히 동일하되, 켜고 끄는 체크 상태와 트리거 타임라인은 독립적이라
  // 반자동과 시뮬레이션을 동시에 켜두고 서로 다른 조건 조합을 비교해볼 수 있다
  const [simulationEnabled, setSimulationEnabled] = useState(false)
  const [simCrossPairs, setSimCrossPairsState] = useState(EMPTY_PAIR_SLOTS)
  const [simDoubleBPairs, setSimDoubleBPairsState] = useState(EMPTY_PAIR_SLOTS)
  const [simBollInnerSellEnabled, setSimBollInnerSellEnabled] = useState(false)
  const [simBollInnerBuyEnabled, setSimBollInnerBuyEnabled] = useState(false)
  // 시뮬레이션 결과 저장 - 청산된 거래를 여기 쌓아뒀다가 "결과 저장" 누르면 한 번에 DB로 보낸다.
  // (Claude가 나중에 MCP run_sql로 simulation_results 테이블을 조회해서 분석해줄 수 있게 하는 용도 -
  // 사이트 화면 어디에도 노출 안 되는, 세션에서만 쓰는 백엔드 기록)
  const [closedTradesCount, setClosedTradesCount] = useState(0)
  const [savingResults, setSavingResults] = useState(false)

  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const markerSeriesRef = useRef(null) // 투명 라인 시리즈 - 마커 전용. 다른 라인이 새로 추가될 때마다 지웠다 다시 만들어서 항상 맨 위(가장 나중에 추가된 시리즈)에 오게 함
  const markersPrimitiveRef = useRef(null) // v5: series.setMarkers() 대신 createSeriesMarkers(series, markers)가 반환하는 primitive를 씀
  const rowsRef = useRef([])
  const intervalRef = useRef(null)
  const indexRef = useRef(0)
  const datasetCacheRef = useRef({}) // dataset.id -> 파싱된 전체 rows (CSV 재요청 방지용)
  const bandDataRef = useRef({})     // bandId -> { upper, middle, lower } - 선택한 날짜분, 워밍업 포함해서 계산됨
  const bandSeriesRef = useRef({})   // bandId -> { upper, middle, lower } lightweight-charts 라인 시리즈
  const maDataRef = useRef({})       // maId -> [{time,value}|null] - 선택한 날짜분, 워밍업 포함해서 계산됨
  const maSeriesRef = useRef({})     // maId -> lightweight-charts 라인 시리즈 (밴드와 달리 선 1개)
  const rsiDataRef = useRef([])      // [{time,value}|null] - 선택한 날짜분
  const rsiSeriesRef = useRef(null)
  const macdDataRef = useRef({ macd: [], signal: [], hist: [] }) // 각각 [{time,value}|null]
  const macdSeriesRef = useRef(null) // { macd, signal, hist } lightweight-charts 시리즈 3개
  const macd5DataRef = useRef({ macd: [], signal: [], hist: [] })
  const macd5SeriesRef = useRef(null)
  const crossPointsRef = useRef([])  // 체크한 이평선끼리 교차하는 지점 전체 [{idx, time, type:'golden'|'dead'}]
  const autoEventsRef = useRef([])   // 반자동진입 트리거 전체 [{idx, time, side:'buy'|'sell', source}]
  const simEventsRef = useRef([])    // 시뮬레이션 트리거 전체 (반자동과 동일한 구조, 별도 타임라인)
  const doubleBSignalPointsRef = useRef([]) // 더블비 신호(표시용) 전체 [{idx, time, side}]
  const bollInnerSignalPointsRef = useRef([]) // 볼린저 눌림 신호(표시용) 전체 [{idx, time, side}]
  const sessionPointsRef = useRef([]) // 세계 3대 시장 개장 시각 표시용 [{idx, time, label, color}] - 매매 신호가 아니라 항상 표시하는 고정 참고선
  const rangeAnchorRef = useRef('') // 여러 날 선택 모드에서 첫 번째 클릭(범위 시작)을 임시로 들고 있다가 두 번째 클릭에서 씀
  const closedTradesRef = useRef([]) // 청산된 거래 전체(수동/반자동/시뮬레이션 다 포함, source로 구분) - "결과 저장" 누르면 DB로 보냄

  const availableDates = useMemo(() => buildAvailableDates(datasets), [datasets])
  // '전체선택' 체크박스용 - 지금 보고 있는 달(viewDate) 안에서 데이터 있는 날짜만 정렬해서 뽑아둠
  const monthAvailableDates = useMemo(() => {
    const prefix = `${viewDate.getFullYear()}-${String(viewDate.getMonth() + 1).padStart(2, '0')}`
    return Array.from(availableDates).filter(d => d.startsWith(prefix)).sort()
  }, [availableDates, viewDate])

  // 심볼 바뀌면 그 심볼의 데이터셋 목록을 불러온다
  useEffect(() => {
    // 심볼을 빠르게 연속 전환하면(예: 골드→나스닥) 두 fetch가 동시에 날아가고, 먼저 보낸
    // 쪽(골드)의 응답이 네트워크 지연으로 나스닥 응답보다 "나중에" 도착할 수 있다.
    // ignore 플래그 없이 그대로 setDatasets를 부르면, 이미 나스닥으로 전환된 화면에
    // 뒤늦게 도착한 골드 목록이 덮어써서 "나스닥을 선택해도 반영이 안 되는" 것처럼 보이는
    // 버그가 생긴다. cleanup에서 ignore를 true로 만들어 그 시점 이후의 setState를 막는다.
    let ignore = false
    stopPlayback()
    setSelectedDate('')
    setSelectedDateTo('')
    rangeAnchorRef.current = ''
    setError('')
    rowsRef.current = []
    indexRef.current = 0
    setPlayIndex(0)
    setTotal(0)
    seriesRef.current?.setData([])
    markerSeriesRef.current?.setData([])
    bandDataRef.current = {}
    syncBands(0)
    maDataRef.current = {}
    syncMA(0)
    rsiDataRef.current = []
    syncRSI(0)
    macdDataRef.current = { macd: [], signal: [], hist: [] }
    syncMACD(0)
    macd5DataRef.current = { macd: [], signal: [], hist: [] }
    syncMACD5(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    doubleBSignalPointsRef.current = []
    bollInnerSignalPointsRef.current = []
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    setPositions([]) // 심볼이 바뀌면 그 전 심볼 가격 기준 포지션은 의미가 없어짐(체결 없이 그냥 사라짐)
    fetch(`/api/backtest-datasets-public?symbol=${symbol}`)
      .then(r => r.json())
      .then(async d => {
        if (ignore) return
        const rows = d.rows || []
        setDatasets(rows)
        // 데이터가 있는 가장 최근 달을 기본으로 보여준다
        const latest = rows.reduce((max, r) => (r.date_to && r.date_to > max ? r.date_to : max), '')
        if (latest) {
          const [y, m] = latest.split('-').map(Number)
          setViewDate(new Date(y, m - 1, 1))
        }
        // 세션 복원 - 마운트 직후 딱 한 번만, 저장된 심볼이 지금 심볼과 같을 때만 그 날짜/재생위치를 이어서 불러온다
        if (!hasAutoRestoredRef.current) {
          hasAutoRestoredRef.current = true
          const saved = restoreRef.current
          if (saved && saved.symbol === symbol && saved.selectedDate) {
            const [y2, m2] = saved.selectedDate.split('-').map(Number)
            if (!Number.isNaN(y2) && !Number.isNaN(m2)) setViewDate(new Date(y2, m2 - 1, 1))
            await loadRange(saved.selectedDate, saved.selectedDateTo || saved.selectedDate, rows)
            if (!ignore && typeof saved.playIndex === 'number' && saved.playIndex > 0) {
              applyIndex(Math.min(saved.playIndex, rowsRef.current.length))
            }
          }
        }
      })
      .catch(() => { if (!ignore) setDatasets([]) })
    return () => { ignore = true }
  }, [symbol])

  // 차트 인스턴스는 한 번만 생성
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 860,
      layout: {
        background: { color: '#0f1115' }, textColor: '#9aa0ab',
        panes: { separatorColor: '#2a2e38', separatorHoverColor: 'rgba(76,175,80,0.15)', enableResize: true },
      },
      grid: { vertLines: { color: '#1c2028' }, horzLines: { color: '#1c2028' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: '#2a2e38', timeVisible: true, secondsVisible: false, tickMarkFormatter: localTickMarkFormatter },
      rightPriceScale: { borderColor: '#2a2e38' },
      localization: { timeFormatter: localTimeFormatter },
    })
    const series = chart.addSeries(CandlestickSeries, {
      visible: candleVisible,
      upColor, downColor,
      borderUpColor: upColor, borderDownColor: downColor,
      wickUpColor: upColor, wickDownColor: downColor,
    })
    chartRef.current = chart
    seriesRef.current = series

    // 기본으로 켜둔 볼린저/이평선은 toggleBand/toggleMA(클릭했을 때만 시리즈를 만듦)를 거치지 않으므로,
    // 마운트 시점에 켜져 있는 것들의 실제 차트 시리즈를 여기서 직접 만들어둔다.
    // (마커 시리즈는 항상 "가장 나중에 추가된 것 = 맨 위"여야 하므로 이 시리즈들보다 뒤에 만든다)
    for (const band of BOLLINGER_BANDS) {
      if (!enabledBands[band.id]) continue
      const color = bandColors[band.id] || band.color
      bandSeriesRef.current[band.id] = {
        upper: chart.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: lineVisibility[`${band.id}:upper`] !== false }),
        middle: chart.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: lineVisibility[`${band.id}:middle`] !== false }),
        lower: chart.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: lineVisibility[`${band.id}:lower`] !== false }),
      }
    }
    for (const ma of ALL_MA) {
      if (!enabledMA[ma.id]) continue
      const width = maWidths[ma.id] || ma.lineWidth
      if (isDualColor(ma.id)) {
        const alpha = isRibbonId(ma.id) ? ribbonOpacity : 1
        maSeriesRef.current[ma.id + '_lime'] = chart.addSeries(LineSeries, {
          color: hexToRgba(maUpColors[ma.id] || RIBBON_LIME, alpha), lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
        })
        maSeriesRef.current[ma.id + '_red'] = chart.addSeries(LineSeries, {
          color: hexToRgba(maDownColors[ma.id] || RIBBON_RED, alpha), lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
        })
      } else {
        const color = maColors[ma.id] || ma.color
        maSeriesRef.current[ma.id] = chart.addSeries(LineSeries, {
          color, lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
        })
      }
    }

    markerSeriesRef.current = chart.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    })
    markersPrimitiveRef.current = createSeriesMarkers(markerSeriesRef.current, [])

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

  // RSI/MACD도 재생 위치(idx)를 앞서가면 안 되는 건 볼린저/이평선과 동일
  const applyRSIIndex = (idx) => {
    if (!rsiSeriesRef.current) return
    rsiSeriesRef.current.setData(rsiDataRef.current.slice(0, idx).filter(Boolean))
  }
  const syncRSI = (idx) => applyRSIIndex(idx)

  const applyMACDIndex = (idx) => {
    const s = macdSeriesRef.current
    const d = macdDataRef.current
    if (!s) return
    s.macd.setData(d.macd.slice(0, idx).filter(Boolean))
    s.signal.setData(d.signal.slice(0, idx).filter(Boolean))
    s.hist.setData(d.hist.slice(0, idx).filter(Boolean))
  }
  const syncMACD = (idx) => applyMACDIndex(idx)

  const applyMACD5Index = (idx) => {
    const s = macd5SeriesRef.current
    const d = macd5DataRef.current
    if (!s) return
    s.macd.setData(d.macd.slice(0, idx).filter(Boolean))
    s.signal.setData(d.signal.slice(0, idx).filter(Boolean))
    s.hist.setData(d.hist.slice(0, idx).filter(Boolean))
  }
  const syncMACD5 = (idx) => applyMACD5Index(idx)

  // 크로스/더블비 신호 마커 둘 다 재생 위치를 앞서가면 안 된다 - 미리 계산해둔 전체 지점 중
  // 아직 재생 안 지난 구간은 걸러서 캔들 시리즈 마커 하나로 합쳐서 얹는다
  // (setMarkers는 호출할 때마다 통째로 교체되므로 두 종류를 항상 같이 계산해서 넘겨야 함).
  // overrides로 넘긴 값만 즉시 반영하고 나머지는 현재 state를 그대로 씀
  // (setState 직후 같은 틱에 호출될 때 클로저가 stale해지는 걸 피하기 위함)
  const applyAllMarkers = (idx, overrides = {}) => {
    if (!markerSeriesRef.current) return
    const gShape = overrides.goldenShape ?? goldenShape
    const gColor = overrides.goldenColor ?? goldenColor
    const gSize = overrides.goldenSize ?? goldenSize
    const dShape = overrides.deadShape ?? deadShape
    const dColor = overrides.deadColor ?? deadColor
    const dSize = overrides.deadSize ?? deadSize
    const bShapeLong = overrides.doubleBShapeLong ?? doubleBShapeLong
    const bColorLong = overrides.doubleBColorLong ?? doubleBColorLong
    const bSizeLong = overrides.doubleBSizeLong ?? doubleBSizeLong
    const bShapeShort = overrides.doubleBShapeShort ?? doubleBShapeShort
    const bColorShort = overrides.doubleBColorShort ?? doubleBColorShort
    const bSizeShort = overrides.doubleBSizeShort ?? doubleBSizeShort
    const iShapeLong = overrides.bollInnerShapeLong ?? bollInnerShapeLong
    const iColorLong = overrides.bollInnerColorLong ?? bollInnerColorLong
    const iSizeLong = overrides.bollInnerSizeLong ?? bollInnerSizeLong
    const iShapeShort = overrides.bollInnerShapeShort ?? bollInnerShapeShort
    const iColorShort = overrides.bollInnerColorShort ?? bollInnerColorShort
    const iSizeShort = overrides.bollInnerSizeShort ?? bollInnerSizeShort

    const crossMarkers = crossPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => p.type === 'golden'
        ? { time: p.time, position: 'belowBar', color: gColor, shape: gShape, size: gSize, text: '' }
        : { time: p.time, position: 'aboveBar', color: dColor, shape: dShape, size: dSize, text: '' })

    // 더블비 신호는 매수(롱)/매도(숏) 방향에 따라 서로 다른 모양·색상·크기로 그린다
    const doubleBMarkers = doubleBSignalPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => p.side === 'buy'
        ? { time: p.time, position: 'inBar', color: bColorLong, shape: bShapeLong, size: bSizeLong, text: '' }
        : { time: p.time, position: 'inBar', color: bColorShort, shape: bShapeShort, size: bSizeShort, text: '' })

    // 볼린저 눌림 신호도 더블비와 같은 방식 - 매수(롱)/매도(숏) 방향별로 다른 모양·색상·크기
    const bollInnerMarkers = bollInnerSignalPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => p.side === 'buy'
        ? { time: p.time, position: 'inBar', color: iColorLong, shape: iShapeLong, size: iSizeLong, text: '' }
        : { time: p.time, position: 'inBar', color: iColorShort, shape: iShapeShort, size: iSizeShort, text: '' })

    // 세계 3대 시장 개장 시각 - 매매 신호가 아니라 항상 고정으로 보여주는 참고 마커(텍스트로 세션 이름 표시)
    const sessionMarkers = sessionPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => ({ time: p.time, position: 'aboveBar', color: p.color, shape: 'circle', size: 1, text: p.label }))

    markersPrimitiveRef.current?.setMarkers([...crossMarkers, ...doubleBMarkers, ...bollInnerMarkers, ...sessionMarkers].sort((a, b) => a.time - b.time))
  }

  const applyIndex = (idx) => {
    const dayRows = rowsRef.current.slice(0, idx)
    seriesRef.current?.setData(dayRows)
    markerSeriesRef.current?.setData(dayRows.map(r => ({ time: r.time, value: r.close })))
    syncBands(idx)
    syncMA(idx)
    syncRSI(idx)
    syncMACD(idx)
    syncMACD5(idx)
    applyAllMarkers(idx)
    indexRef.current = idx
    setPlayIndex(idx)
  }

  // 캔들을 하나씩 update()로 이어붙이는 게 setData 전체 재계산보다 가볍다
  const applyIncrement = (from, to) => {
    const rows = rowsRef.current
    for (let i = from; i < to; i++) {
      seriesRef.current?.update(rows[i])
      markerSeriesRef.current?.update({ time: rows[i].time, value: rows[i].close })
    }
    syncBands(to)
    syncMA(to)
    syncRSI(to)
    syncMACD(to)
    syncMACD5(to)
    applyAllMarkers(to)
    // 반자동진입 - 재생(자동 진행)으로 새로 드러난 구간에서만 조건을 확인한다.
    // 슬라이더로 수동 스크럽할 때는 안 걸리게(applyIndex가 아니라 여기서만 체크)
    if (semiAutoEnabled) {
      const triggered = autoEventsRef.current.filter(e => e.idx >= from && e.idx < to)
      if (triggered.length) {
        setPositions(prev => [
          ...prev,
          ...triggered.map(e => ({
            id: `auto_${e.idx}_${e.source}_${Math.random()}`,
            side: e.side, symbol, lot: lotSize, entryPrice: rows[e.idx].close, entryTime: rows[e.idx].time,
          })),
        ])
      }
    }
    // 시뮬레이션 - 반자동과 같은 방식으로, 켜져 있을 때만 새로 드러난 구간의 트리거를 확인해 진입한다
    if (simulationEnabled) {
      const triggered = simEventsRef.current.filter(e => e.idx >= from && e.idx < to)
      if (triggered.length) {
        setPositions(prev => [
          ...prev,
          ...triggered.map(e => ({
            id: `sim_${e.idx}_${e.source}_${Math.random()}`,
            side: e.side, symbol, lot: lotSize, entryPrice: rows[e.idx].close, entryTime: rows[e.idx].time,
          })),
        ])
      }
    }
    indexRef.current = to
    setPlayIndex(to)
  }

  // fromStr === toStr이면 하루, fromStr < toStr이면 그 사이 여러 날을 이어서 하나의 재생 구간으로 불러온다
  // (여러 날 선택 모드에서 두 번째 클릭 시 씀). 단일 날짜 클릭(loadDate)도 내부적으로 이 함수를 그대로 쓴다.
  // datasetsOverride: 세션 복원 직후처럼 setDatasets(rows)를 호출한 바로 그 틱 안에서 곧바로
  // loadRange를 부르면, 이 함수가 클로저로 캡처한 `datasets` state는 아직 리렌더 전이라 예전 값(빈 배열)
  // 그대로다 - "이 심볼엔 데이터셋이 없다"고 오판해서 조용히 실패하는 버그가 있었음. 그 경우엔 방금 받은
  // rows를 여기로 직접 넘겨서 state 갱신을 기다리지 않고 바로 쓰게 한다.
  const loadRange = async (fromStr, toStr, datasetsOverride) => {
    stopPlayback()
    setError('')
    setSelectedDate(fromStr)
    setSelectedDateTo(fromStr === toStr ? '' : toStr)

    // symbol 전환 직후엔 datasets state가 아직 이전 심볼 목록일 수 있다(비동기 fetch가 덜 끝난 사이 클릭한 경우) -
    // d.symbol 체크 없이 날짜 범위만 보면 그 사이에 이전 심볼(예: GOLD) 파일을 잘못 불러오는 버그가 있었다.
    // 예전엔 시작~끝 날짜가 전부 같은 파일 안에 있어야 했는데(파일이 월 단위로 나뉘어 있어서 여러 달
    // 걸치면 에러가 났음), 주말에 캔들이 비어도 자연스럽게 넘어가는 것처럼 파일 경계도 신경 안 쓰게
    // 해달라는 요청(사용자) - 그 심볼의 파일을 전부 모아 시간 기준으로 병합해서 하나의 연속 시계열로 씀.
    const symbolDatasets = (datasetsOverride || datasets).filter(d => d.symbol === symbol)
    const overlapping = symbolDatasets.filter(d => d.date_from <= toStr && fromStr <= d.date_to)
    if (overlapping.length === 0) {
      setError(fromStr === toStr ? '해당 날짜의 데이터를 찾을 수 없습니다' : '선택한 범위의 데이터를 찾을 수 없습니다')
      return
    }

    setLoadingCsv(true)
    seriesRef.current?.setData([])
    markerSeriesRef.current?.setData([])
    bandDataRef.current = {}
    syncBands(0)
    maDataRef.current = {}
    syncMA(0)
    rsiDataRef.current = []
    syncRSI(0)
    macdDataRef.current = { macd: [], signal: [], hist: [] }
    syncMACD(0)
    macd5DataRef.current = { macd: [], signal: [], hist: [] }
    syncMACD5(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    doubleBSignalPointsRef.current = []
    bollInnerSignalPointsRef.current = []
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    setPositions([]) // 새 구간을 불러오면 그 전 리플레이의 미체결 포지션은 그냥 사라짐(새 연습 세션)
    indexRef.current = 0
    setPlayIndex(0)
    try {
      // 아직 캐시 안 된 파일만 병렬로 받아온다 (캐시된 건 재요청 안 함)
      const toFetch = symbolDatasets.filter(d => !datasetCacheRef.current[d.id])
      if (toFetch.length > 0) {
        await Promise.all(toFetch.map(async d => {
          const res = await fetch(publicUrl(d.storage_path))
          if (!res.ok) throw new Error(`파일을 가져오지 못했습니다 (${res.status})`)
          const csvText = await res.text()
          datasetCacheRef.current[d.id] = parseCandleCsv(csvText, summerTime ? BROKER_OFFSET_SECONDS.summer : BROKER_OFFSET_SECONDS.winter).rows
        }))
      }
      // 같은 시각 캔들이 여러 파일에 겹쳐 있을 수 있어 시간을 키로 병합(뒤에 처리한 파일이 있으면 덮어씀) 후 정렬
      const mergedByTime = new Map()
      for (const d of symbolDatasets) {
        for (const r of datasetCacheRef.current[d.id]) mergedByTime.set(r.time, r)
      }
      const fullRows = Array.from(mergedByTime.values()).sort((a, b) => a.time - b.time)

      // fromStr 그 날짜에 캔들이 하나도 없어도(주말/휴장일) 통째로 실패시키지 않고, 그 날짜 이후
      // 첫 캔들부터 시작한다 - 범위 중간의 주말은 원래도 그냥 건너뛰어지므로, 시작일도 같은 방식으로 맞춤.
      let startIdx = fullRows.findIndex(r => toLocalDateStr(r.time) >= fromStr)
      let endIdx = startIdx
      if (startIdx >= 0) {
        endIdx = startIdx
        while (endIdx < fullRows.length && toLocalDateStr(fullRows[endIdx].time) <= toStr) endIdx++
      }
      const dayRows = startIdx >= 0 ? fullRows.slice(startIdx, endIdx) : []
      rowsRef.current = dayRows
      setTotal(dayRows.length)

      // 볼린저는 그 구간 데이터만으론 워밍업이 부족하니(예: 1시간봉 SMA1200 = 20시간 분량)
      // 같은 파일 안의 이전 날짜들까지 포함해서 계산한 뒤, 표시 구간만 잘라낸다.
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
        for (const ma of ALL_MA) {
          const vals = computeMA(ma, closes)
          const points = []
          for (let i = startIdx; i < endIdx; i++) {
            points.push(vals[i] != null ? { time: fullRows[i].time, value: vals[i] } : null)
          }
          newMaData[ma.id] = points
        }
        for (const dualId of DUAL_COLOR_IDS) {
          const { lime, red } = splitRibbonBySlope(newMaData[dualId])
          newMaData[dualId + '_lime'] = lime
          newMaData[dualId + '_red'] = red
        }
        maDataRef.current = newMaData

        // RSI/MACD도 이평선처럼 그 구간 데이터만으론 워밍업이 부족할 수 있어 파일 전체로 계산 후 표시 구간만 자름
        const rsiVals = rollingRSI(closes, RSI_PERIOD)
        const rsiPoints = []
        for (let i = startIdx; i < endIdx; i++) {
          rsiPoints.push(rsiVals[i] != null ? { time: fullRows[i].time, value: rsiVals[i] } : null)
        }
        rsiDataRef.current = rsiPoints

        const { macdLine, signalLine, histogram } = rollingMACD(closes, MACD_FAST, MACD_SLOW, MACD_SIGNAL)
        const macdPoints = [], signalPoints = [], histPoints = []
        for (let i = startIdx; i < endIdx; i++) {
          const t = fullRows[i].time
          macdPoints.push(macdLine[i] != null ? { time: t, value: macdLine[i] } : null)
          signalPoints.push(signalLine[i] != null ? { time: t, value: signalLine[i] } : null)
          histPoints.push(histogram[i] != null ? { time: t, value: histogram[i], color: histogram[i] >= 0 ? DEFAULT_MACD_HIST_UP : DEFAULT_MACD_HIST_DOWN } : null)
        }
        macdDataRef.current = { macd: macdPoints, signal: signalPoints, hist: histPoints }

        const macd5 = rollingMACD(closes, MACD5_FAST, MACD5_SLOW, MACD5_SIGNAL)
        const macd5Points = [], signal5Points = [], hist5Points = []
        for (let i = startIdx; i < endIdx; i++) {
          const t = fullRows[i].time
          macd5Points.push(macd5.macdLine[i] != null ? { time: t, value: macd5.macdLine[i] } : null)
          signal5Points.push(macd5.signalLine[i] != null ? { time: t, value: macd5.signalLine[i] } : null)
          hist5Points.push(macd5.histogram[i] != null ? { time: t, value: macd5.histogram[i], color: macd5.histogram[i] >= 0 ? DEFAULT_MACD_HIST_UP : DEFAULT_MACD_HIST_DOWN } : null)
        }
        macd5DataRef.current = { macd: macd5Points, signal: signal5Points, hist: hist5Points }

        refreshCross()
        refreshDoubleBSignal()
        refreshBollInnerSignal()
        refreshAutoEvents()
        refreshSimEvents()
        refreshSessionMarkers()
      }

      if (dayRows.length === 0) setError('이 날짜엔 캔들이 없어요 (주말/휴장일일 수 있어요)')
    } catch (e) {
      setError(e.message)
      rowsRef.current = []
      setTotal(0)
    }
    setLoadingCsv(false)
  }

  const loadDate = (dateStr) => loadRange(dateStr, dateStr)

  // 달력 클릭 처리 - 여러 날 선택 모드가 꺼져있으면 예전처럼 클릭한 날 하루만 바로 불러온다.
  // 켜져있으면 첫 클릭은 범위 시작점만 표시해두고, 두 번째 클릭에서 시작~끝을 이어서 불러온다
  // (Shift+클릭도 같은 방식으로 동작 - MonthCalendar가 이미 shiftKey를 넘겨주고 있었음).
  const handleCalendarSelect = (dateStr, shiftKey) => {
    if (!multiSelectMode && !shiftKey) {
      rangeAnchorRef.current = ''
      loadDate(dateStr)
      return
    }
    if (!rangeAnchorRef.current) {
      rangeAnchorRef.current = dateStr
      setSelectedDate(dateStr)
      setSelectedDateTo('')
      setError('')
      return
    }
    const anchor = rangeAnchorRef.current
    rangeAnchorRef.current = ''
    const from = anchor <= dateStr ? anchor : dateStr
    const to = anchor <= dateStr ? dateStr : anchor
    loadRange(from, to)
  }

  // 선택 전부 지우고 빈 화면으로 - '전체선택' 체크 해제할 때 씀. symbol 전환 리셋과 같은 항목을 지운다.
  const clearSelection = () => {
    stopPlayback()
    setSelectedDate('')
    setSelectedDateTo('')
    rangeAnchorRef.current = ''
    setError('')
    rowsRef.current = []
    indexRef.current = 0
    setPlayIndex(0)
    setTotal(0)
    seriesRef.current?.setData([])
    markerSeriesRef.current?.setData([])
    bandDataRef.current = {}
    syncBands(0)
    maDataRef.current = {}
    syncMA(0)
    rsiDataRef.current = []
    syncRSI(0)
    macdDataRef.current = { macd: [], signal: [], hist: [] }
    syncMACD(0)
    macd5DataRef.current = { macd: [], signal: [], hist: [] }
    syncMACD5(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    doubleBSignalPointsRef.current = []
    bollInnerSignalPointsRef.current = []
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    setPositions([])
  }

  // '전체선택' - 지금 보고 있는 달에 데이터 있는 날짜를 전부 이어서 하나의 재생 구간으로 불러온다.
  // (loadRange가 '같은 데이터 파일 안'이어야 한다는 제약을 그대로 검사하므로, 파일 경계에 걸친 달은
  // 기존과 동일하게 에러 메시지가 뜬다.) 체크 해제하면 clearSelection으로 빈 화면으로 되돌린다.
  const selectAllMonth = () => {
    if (allMonthSelected) {
      clearSelection()
      return
    }
    if (monthAvailableDates.length === 0) return
    rangeAnchorRef.current = ''
    setMultiSelectMode(true)
    loadRange(monthAvailableDates[0], monthAvailableDates[monthAvailableDates.length - 1])
  }

  const allMonthSelected = monthAvailableDates.length > 0
    && selectedDate === monthAvailableDates[0]
    && (monthAvailableDates.length === 1 ? !selectedDateTo : selectedDateTo === monthAvailableDates[monthAvailableDates.length - 1])

  const toggleSummerTime = () => setSummerTime(prev => !prev)

  // 서머타임 상태가 바뀌면 캐시된 rows엔 예전 오프셋이 이미 반영돼 있어서 그대로 두면 안 바뀐다.
  // 캐시를 통째로 비우고, 지금 보고 있던 날짜가 있으면 새 오프셋으로 다시 불러온다.
  // (setSummerTime 콜백 안에서 바로 loadDate를 부르면 summerTime이 아직 안 바뀐 값이라 한 번 밀리므로 effect로 분리)
  useEffect(() => {
    datasetCacheRef.current = {}
    if (selectedDate) loadRange(selectedDate, selectedDateTo || selectedDate)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summerTime])

  // 심볼/날짜/재생위치가 바뀔 때마다 sessionStorage에 저장 - 다른 페이지 갔다가 돌아와도 이어서 볼 수 있게.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(BACKTEST_STATE_KEY, JSON.stringify({ symbol, selectedDate, selectedDateTo, playIndex, candleVisible }))
    } catch { /* 저장 실패해도(예: 프라이빗 모드 용량제한) 기능엔 영향 없음 - 그냥 다음번엔 복원 안 될 뿐 */ }
  }, [symbol, selectedDate, selectedDateTo, playIndex, candleVisible])

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

  const toggleCandleVisible = () => {
    const next = !candleVisible
    setCandleVisible(next)
    seriesRef.current?.applyOptions({ visible: next })
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

  // lightweight-charts는 시리즈를 추가한 순서대로 위에 그린다 - 볼린저/이평선을 새로 켤 때마다
  // 마커 전용 투명 시리즈를 지웠다 새로 만들어서 항상 "가장 나중에 추가된 = 가장 위" 자리를 되찾는다.
  const bumpMarkerLayer = () => {
    if (!chartRef.current) return
    if (markerSeriesRef.current) chartRef.current.removeSeries(markerSeriesRef.current)
    markerSeriesRef.current = chartRef.current.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    })
    markersPrimitiveRef.current = createSeriesMarkers(markerSeriesRef.current, [])
    const idx = indexRef.current
    markerSeriesRef.current.setData(rowsRef.current.slice(0, idx).map(r => ({ time: r.time, value: r.close })))
    applyAllMarkers(idx)
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
          upper: chartRef.current.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'upper') }),
          middle: chartRef.current.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'middle') }),
          lower: chartRef.current.addSeries(LineSeries, { color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'lower') }),
        }
        bumpMarkerLayer()
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
    if (isDualColor(maId)) {
      maSeriesRef.current[maId + '_lime']?.applyOptions({ lineWidth: width })
      maSeriesRef.current[maId + '_red']?.applyOptions({ lineWidth: width })
    } else {
      maSeriesRef.current[maId]?.applyOptions({ lineWidth: width })
    }
  }

  const resetMAWidth = (ma) => {
    setMaWidths(prev => {
      const next = { ...prev }
      delete next[ma.id]
      return next
    })
    if (isDualColor(ma.id)) {
      maSeriesRef.current[ma.id + '_lime']?.applyOptions({ lineWidth: ma.lineWidth })
      maSeriesRef.current[ma.id + '_red']?.applyOptions({ lineWidth: ma.lineWidth })
    } else {
      maSeriesRef.current[ma.id]?.applyOptions({ lineWidth: ma.lineWidth })
    }
  }

  // DUAL_COLOR_IDS(리본 + hma60) 전용 - 커스텀 안 골랐으면 RIBBON_LIME/RIBBON_RED 기본값.
  // 이름이 candle up/down색 설정 함수(setUpColor/setDownColor, 위쪽에 있음)랑 겹쳐서 Dual 접두어로 구분.
  const getDualUpColor = (maId) => maUpColors[maId] || RIBBON_LIME
  const getDualDownColor = (maId) => maDownColors[maId] || RIBBON_RED
  const setDualUpColor = (maId, color) => {
    setMaUpColors(prev => ({ ...prev, [maId]: color }))
    const applied = isRibbonId(maId) ? hexToRgba(color, ribbonOpacity) : color
    maSeriesRef.current[maId + '_lime']?.applyOptions({ color: applied })
  }
  const setDualDownColor = (maId, color) => {
    setMaDownColors(prev => ({ ...prev, [maId]: color }))
    const applied = isRibbonId(maId) ? hexToRgba(color, ribbonOpacity) : color
    maSeriesRef.current[maId + '_red']?.applyOptions({ color: applied })
  }
  // 리본 카드의 "세트" 컬러피커 - 리본 선 전부의 상승/하락 색을 한번에 바꾼다
  const setRibbonUpColor = (color) => { for (const ma of MADRID_RIBBON) setDualUpColor(ma.id, color) }
  const setRibbonDownColor = (color) => { for (const ma of MADRID_RIBBON) setDualDownColor(ma.id, color) }
  // 리본 18개 선 전용 투명도 슬라이더(사용자 요청) - hma3(dual이지만 리본 아님)는 영향 없음
  const setRibbonOpacityValue = (value) => {
    setRibbonOpacityState(value)
    for (const ma of MADRID_RIBBON) {
      maSeriesRef.current[ma.id + '_lime']?.applyOptions({ color: hexToRgba(getDualUpColor(ma.id), value) })
      maSeriesRef.current[ma.id + '_red']?.applyOptions({ color: hexToRgba(getDualDownColor(ma.id), value) })
    }
  }

  const toggleMA = (maId) => {
    const turningOn = !enabledMA[maId]
    setEnabledMA(prev => ({ ...prev, [maId]: turningOn }))
    const ma = ALL_MA.find(m => m.id === maId)
    const dual = isDualColor(maId)

    if (turningOn) {
      if (dual) {
        if (!maSeriesRef.current[maId + '_lime'] && chartRef.current) {
          const width = getMAWidth(ma)
          const alpha = isRibbonId(maId) ? ribbonOpacity : 1
          maSeriesRef.current[maId + '_lime'] = chartRef.current.addSeries(LineSeries, {
            color: hexToRgba(getDualUpColor(maId), alpha), lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
          })
          maSeriesRef.current[maId + '_red'] = chartRef.current.addSeries(LineSeries, {
            color: hexToRgba(getDualDownColor(maId), alpha), lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
          })
          bumpMarkerLayer()
        }
        applyMAIndex(maId + '_lime', indexRef.current)
        applyMAIndex(maId + '_red', indexRef.current)
      } else {
        if (!maSeriesRef.current[maId] && chartRef.current) {
          const color = getMAColor(ma)
          const width = getMAWidth(ma)
          // 각 이평선마다 정의된(또는 커스텀) 굵기 + 실선/점선 스타일 그대로
          maSeriesRef.current[maId] = chartRef.current.addSeries(LineSeries, {
            color, lineWidth: width, lineStyle: ma.lineStyle, lastValueVisible: false, priceLineVisible: false,
          })
          bumpMarkerLayer()
        }
        applyMAIndex(maId, indexRef.current)
      }
    } else {
      if (dual) {
        for (const suffix of ['_lime', '_red']) {
          const key = maId + suffix
          const s = maSeriesRef.current[key]
          if (s && chartRef.current) chartRef.current.removeSeries(s)
          delete maSeriesRef.current[key]
        }
      } else {
        const s = maSeriesRef.current[maId]
        if (s && chartRef.current) chartRef.current.removeSeries(s)
        delete maSeriesRef.current[maId]
      }
    }
  }

  // 리본(MADRID_RIBBON) 18개를 한 세트로 묶어서 통째로 켜고 끈다 - toggleMA가 이미 dual-color를
  // 알아서 처리하므로 id별로 반복 호출만 하면 된다.
  const toggleRibbon = () => {
    setRibbonEnabledState(prev => !prev)
    for (const ma of MADRID_RIBBON) toggleMA(ma.id)
  }

  // RSI - 자기만의 pane(index는 동적으로 계산: 현재 pane 개수 = 맨 끝에 새 pane) - v5 진짜 pane API
  const toggleRSI = () => {
    const turningOn = !enabledRSI
    setEnabledRSI(turningOn)
    if (turningOn) {
      if (!rsiSeriesRef.current && chartRef.current) {
        const paneIndex = chartRef.current.panes().length
        rsiSeriesRef.current = chartRef.current.addSeries(LineSeries, {
          color: rsiColor, lineWidth: 2, lastValueVisible: true, priceLineVisible: true,
        }, paneIndex)
        bumpMarkerLayer()
      }
      applyRSIIndex(indexRef.current)
    } else {
      if (rsiSeriesRef.current && chartRef.current) {
        const pane = rsiSeriesRef.current.getPane()
        chartRef.current.removeSeries(rsiSeriesRef.current)
        try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
      }
      rsiSeriesRef.current = null
    }
  }

  const setRsiColor = (color) => {
    setRsiColorState(color)
    rsiSeriesRef.current?.applyOptions({ color })
  }

  // MACD1 - MACD5와 같은 pane을 공유(둘 중 먼저 켜진 쪽이 pane을 만들고, 나중 것은 그 pane index를 그대로 씀)
  const toggleMACD = () => {
    const turningOn = !enabledMACD
    setEnabledMACD(turningOn)
    if (turningOn) {
      if (!macdSeriesRef.current && chartRef.current) {
        const paneIndex = macd5SeriesRef.current ? macd5SeriesRef.current.macd.getPane().paneIndex() : chartRef.current.panes().length
        macdSeriesRef.current = {
          hist: chartRef.current.addSeries(HistogramSeries, {
            lastValueVisible: false, priceLineVisible: false,
          }, paneIndex),
          macd: chartRef.current.addSeries(LineSeries, {
            color: macdLineColor, lineWidth: 2, lastValueVisible: true, priceLineVisible: true,
          }, paneIndex),
          signal: chartRef.current.addSeries(LineSeries, {
            color: macdSignalColor, lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
          }, paneIndex),
        }
        bumpMarkerLayer()
      }
      applyMACDIndex(indexRef.current)
    } else {
      const s = macdSeriesRef.current
      if (s && chartRef.current) {
        const pane = s.macd.getPane()
        chartRef.current.removeSeries(s.macd)
        chartRef.current.removeSeries(s.signal)
        chartRef.current.removeSeries(s.hist)
        if (!macd5SeriesRef.current) {
          try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
        }
      }
      macdSeriesRef.current = null
    }
  }

  const setMacdLineColor = (color) => {
    setMacdLineColorState(color)
    macdSeriesRef.current?.macd.applyOptions({ color })
  }

  const setMacdSignalColor = (color) => {
    setMacdSignalColorState(color)
    macdSeriesRef.current?.signal.applyOptions({ color })
  }

  // MACD5 - "5분" MACD(기간 ×5). MACD1과 같은 pane을 공유해서 한 창에 같이 그린다.
  const toggleMACD5 = () => {
    const turningOn = !enabledMACD5
    setEnabledMACD5(turningOn)
    if (turningOn) {
      if (!macd5SeriesRef.current && chartRef.current) {
        const paneIndex = macdSeriesRef.current ? macdSeriesRef.current.macd.getPane().paneIndex() : chartRef.current.panes().length
        macd5SeriesRef.current = {
          hist: chartRef.current.addSeries(HistogramSeries, {
            lastValueVisible: false, priceLineVisible: false,
          }, paneIndex),
          macd: chartRef.current.addSeries(LineSeries, {
            color: macd5LineColor, lineWidth: 2, lastValueVisible: true, priceLineVisible: true,
          }, paneIndex),
          signal: chartRef.current.addSeries(LineSeries, {
            color: macd5SignalColor, lineWidth: 1, lastValueVisible: true, priceLineVisible: false,
          }, paneIndex),
        }
        bumpMarkerLayer()
      }
      applyMACD5Index(indexRef.current)
    } else {
      const s = macd5SeriesRef.current
      if (s && chartRef.current) {
        const pane = s.macd.getPane()
        chartRef.current.removeSeries(s.macd)
        chartRef.current.removeSeries(s.signal)
        chartRef.current.removeSeries(s.hist)
        if (!macdSeriesRef.current) {
          try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
        }
      }
      macd5SeriesRef.current = null
    }
  }

  const setMacd5LineColor = (color) => {
    setMacd5LineColorState(color)
    macd5SeriesRef.current?.macd.applyOptions({ color })
  }

  const setMacd5SignalColor = (color) => {
    setMacd5SignalColorState(color)
    macd5SeriesRef.current?.signal.applyOptions({ color })
  }

  // 체크한 이평선들 중 기간이 짧은 쪽을 단기선, 긴 쪽을 장기선으로 보고
  // 단기선이 장기선을 아래→위로 뚫으면 골든크로스, 위→아래면 데드크로스로 분류해
  // 그날 데이터 전체에서 미리 찾아둔다 (재생 위치 필터링은 applyAllMarkers가 담당)
  // 이평선 2개(idA, idB) 사이에서만 교차 지점을 찾는다 - 기간이 짧은 쪽을 단기선, 긴 쪽을
  // 장기선으로 보고 서로 교차하는 지점을 전부 찾는다.
  const findMACrossForPair = (idA, idB) => {
    const maById = Object.fromEntries(MOVING_AVERAGES.map(m => [m.id, m]))
    const maA = maById[idA], maB = maById[idB]
    if (!maA || !maB) return []
    const [fastId, slowId] = maA.period <= maB.period ? [idA, idB] : [idB, idA]
    const F = maDataRef.current[fastId]
    const S = maDataRef.current[slowId]
    if (!F || !S) return []
    const points = []
    for (let i = 1; i < F.length; i++) {
      const f0 = F[i - 1], f1 = F[i], s0 = S[i - 1], s1 = S[i]
      if (!f0 || !f1 || !s0 || !s1) continue
      const d0 = f0.value - s0.value
      const d1 = f1.value - s1.value
      if (d0 === 0 || (d0 > 0) === (d1 > 0)) continue
      points.push({ idx: i, time: f1.time, type: d1 > 0 ? 'golden' : 'dead' })
    }
    return points
  }

  // 세계 3대 시장(아시아/유럽/미장) 개장 시각 표시 - 매매 신호가 아니라 항상 켜져 있는 고정 참고선.
  // 로드된 구간이 여러 날(범위 선택)이면 날짜별로 각각 찾는다. 그 날 데이터에 해당 시각 근처
  // 캔들이 실제로 있을 때만 표시(데이터 경계에 잘린 날은 해당 세션이 아예 없을 수 있어서 스킵).
  const refreshSessionMarkers = () => {
    const rows = rowsRef.current
    if (!rows.length) { sessionPointsRef.current = []; return }
    const idxByDate = new Map()
    rows.forEach((r, idx) => {
      const d = toLocalDateStr(r.time)
      if (!idxByDate.has(d)) idxByDate.set(d, [])
      idxByDate.get(d).push(idx)
    })
    const points = []
    for (const idxList of idxByDate.values()) {
      for (const session of SESSION_OPENS) {
        let bestIdx = null, bestDist = Infinity
        for (const idx of idxList) {
          const d = new Date(rows[idx].time * 1000)
          const dist = Math.abs((d.getHours() * 60 + d.getMinutes()) - session.minute)
          if (dist < bestDist) { bestDist = dist; bestIdx = idx }
        }
        if (bestIdx != null && bestDist <= 10) {
          points.push({ idx: bestIdx, time: rows[bestIdx].time, label: session.label, color: session.color })
        }
      }
    }
    sessionPointsRef.current = points.sort((a, b) => a.idx - b.idx)
  }

  // 왼쪽 "크로스 신호" 표시 - 크로스1/2/3 슬롯에 명시적으로 고른 쌍만 본다(반자동/시뮬레이션도 이제
  // 같은 슬롯 방식 - computePairEvents가 공유하는 findMACrossForPair를 그대로 씀).
  const refreshCross = (pairs = crossPairs) => {
    const points = []
    for (const { a, b } of pairs) {
      if (a && b && a !== b) points.push(...findMACrossForPair(a, b))
    }
    crossPointsRef.current = points.sort((p, q) => p.idx - q.idx)
    applyAllMarkers(indexRef.current)
  }

  // "더블비" - 라인(윗선/중심/아래선) 2개를 골라(다른 밴드끼리도 조합 가능), 그 두 라인 값 사이 구간을
  // 캔들이 동시에 건드렸는지 확인한다. 겹친 구간이 두 밴드 중심선 평균보다 위면 매도(과열/저항),
  // 아래면 매수(과매도/지지) 신호로 본다. 왼쪽/반자동/시뮬레이션의 더블비 슬롯이 전부 이 함수를 공유한다.
  const computeDoubleBTouchForPair = (lineKeyA, lineKeyB) => {
    const rows = rowsRef.current
    const sepA = lineKeyA.lastIndexOf(':'), sepB = lineKeyB.lastIndexOf(':')
    const A = { bandId: lineKeyA.slice(0, sepA), which: lineKeyA.slice(sepA + 1) }
    const B = { bandId: lineKeyB.slice(0, sepB), which: lineKeyB.slice(sepB + 1) }
    if (A.bandId === B.bandId && A.which === B.which) return []
    const Aband = bandDataRef.current[A.bandId]
    const Bband = bandDataRef.current[B.bandId]
    if (!Aband || !Bband) return []
    const points = []
    for (let i = 0; i < rows.length; i++) {
      const av = Aband[A.which]?.[i], bv = Bband[B.which]?.[i]
      const am = Aband.middle[i], bm = Bband.middle[i]
      if (!av || !bv || !am || !bm) continue
      const lowVal = Math.min(av.value, bv.value)
      const highVal = Math.max(av.value, bv.value)
      const candle = rows[i]
      if (candle.low > highVal || candle.high < lowVal) continue
      const overlapMid = (lowVal + highVal) / 2
      const avgMid = (am.value + bm.value) / 2
      points.push({ idx: i, time: candle.time, side: overlapMid > avgMid ? 'sell' : 'buy' })
    }
    return points
  }

  // "볼린저 눌림" - shortId 밴드가 longId 밴드 안쪽으로 눌려 들어온 상태가 유지되는 모든 캔들마다 신호로
  // 본다(더블비와 같은 방식 - 상태가 풀릴 때까지 매 캔들 계속 신호). short 상단선이 long 상단선보다
  // 아래에 있으면 매도, short 하단선이 long 하단선보다 위에 있으면 매수. 왼쪽/반자동/시뮬레이션의
  // 눌림 슬롯이 전부 이 함수를 공유한다(예전엔 5분↔15분으로 고정이었는데 이제 슬롯마다 자유롭게 고름).
  const computeBollInnerTouchForPair = (shortId, longId) => {
    const rows = rowsRef.current
    const points = []
    const short = bandDataRef.current[shortId]
    const long = bandDataRef.current[longId]
    if (!short || !long) return points
    for (let i = 0; i < rows.length; i++) {
      const candle = rows[i]
      const su = short.upper[i], sl = short.lower[i]
      const lu = long.upper[i], ll = long.lower[i]
      if (su && lu && su.value < lu.value) points.push({ idx: i, time: candle.time, side: 'sell' })
      if (sl && ll && sl.value > ll.value) points.push({ idx: i, time: candle.time, side: 'buy' })
    }
    return points
  }

  // 크로스/더블비 슬롯(pairs)과 볼린저 눌림(5분↔15분 고정, sell/buy 두 방향만 켜고 끔)을 각각 계산해서
  // 하나의 이벤트 배열로 합치는 공용 헬퍼 - 반자동(refreshAutoEvents)과 시뮬레이션(refreshSimEvents)이
  // 완전히 같은 구조라 여기서 공유한다.
  const computePairEvents = (crossPairsArg, doubleBPairsArg, bollInnerSell, bollInnerBuy) => {
    const crossEvents = crossPairsArg
      .flatMap(({ a, b }) => (a && b && a !== b ? findMACrossForPair(a, b) : []))
      .map(p => ({ idx: p.idx, time: p.time, side: p.type === 'golden' ? 'buy' : 'sell', source: 'cross' }))

    const doubleBEvents = doubleBPairsArg
      .flatMap(({ a, b }) => (a && b && a !== b ? computeDoubleBTouchForPair(a, b) : []))
      .map(p => ({ ...p, source: 'doubleB' }))

    const bollInnerEvents = computeBollInnerTouchForPair(BOLL_INNER_SHORT_ID, BOLL_INNER_LONG_ID)
      .filter(p => (p.side === 'sell' && bollInnerSell) || (p.side === 'buy' && bollInnerBuy))
      .map(p => ({ ...p, source: 'bollInner' }))

    return [...crossEvents, ...doubleBEvents, ...bollInnerEvents].sort((a, b) => a.idx - b.idx)
  }

  // 반자동진입 트리거 3종을 모두 다시 계산해 하나의 타임라인으로 합친다
  const refreshAutoEvents = (
    crossP = autoCrossPairs,
    doubleBP = autoDoubleBPairs,
    bollInnerSell = autoBollInnerSellEnabled,
    bollInnerBuy = autoBollInnerBuyEnabled,
  ) => {
    autoEventsRef.current = computePairEvents(crossP, doubleBP, bollInnerSell, bollInnerBuy)
  }

  const setAutoCrossPair = (slotIndex, which, maId) => {
    setAutoCrossPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: maId } : p))
      refreshAutoEvents(next, autoDoubleBPairs, autoBollInnerSellEnabled, autoBollInnerBuyEnabled)
      return next
    })
  }

  const setAutoDoubleBPair = (slotIndex, which, lineKey) => {
    setAutoDoubleBPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: lineKey } : p))
      refreshAutoEvents(autoCrossPairs, next, autoBollInnerSellEnabled, autoBollInnerBuyEnabled)
      return next
    })
  }

  const toggleAutoBollInnerSell = () => {
    setAutoBollInnerSellEnabled(prev => {
      const next = !prev
      refreshAutoEvents(autoCrossPairs, autoDoubleBPairs, next, autoBollInnerBuyEnabled)
      return next
    })
  }

  const toggleAutoBollInnerBuy = () => {
    setAutoBollInnerBuyEnabled(prev => {
      const next = !prev
      refreshAutoEvents(autoCrossPairs, autoDoubleBPairs, autoBollInnerSellEnabled, next)
      return next
    })
  }

  // 시뮬레이션 트리거 3종 - 반자동(refreshAutoEvents)과 완전히 같은 계산이지만 별도 타임라인(simEventsRef)에 쌓는다
  const refreshSimEvents = (
    crossP = simCrossPairs,
    doubleBP = simDoubleBPairs,
    bollInnerSell = simBollInnerSellEnabled,
    bollInnerBuy = simBollInnerBuyEnabled,
  ) => {
    simEventsRef.current = computePairEvents(crossP, doubleBP, bollInnerSell, bollInnerBuy)
  }

  const setSimCrossPair = (slotIndex, which, maId) => {
    setSimCrossPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: maId } : p))
      refreshSimEvents(next, simDoubleBPairs, simBollInnerSellEnabled, simBollInnerBuyEnabled)
      return next
    })
  }

  const setSimDoubleBPair = (slotIndex, which, lineKey) => {
    setSimDoubleBPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: lineKey } : p))
      refreshSimEvents(simCrossPairs, next, simBollInnerSellEnabled, simBollInnerBuyEnabled)
      return next
    })
  }

  const toggleSimBollInnerSell = () => {
    setSimBollInnerSellEnabled(prev => {
      const next = !prev
      refreshSimEvents(simCrossPairs, simDoubleBPairs, next, simBollInnerBuyEnabled)
      return next
    })
  }

  const toggleSimBollInnerBuy = () => {
    setSimBollInnerBuyEnabled(prev => {
      const next = !prev
      refreshSimEvents(simCrossPairs, simDoubleBPairs, simBollInnerSellEnabled, next)
      return next
    })
  }

  const setCrossPair = (slotIndex, which, maId) => {
    setCrossPairs(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: maId } : p))
      refreshCross(next)
      return next
    })
  }

  const setGoldenShape = (v) => { setGoldenShapeState(v); applyAllMarkers(indexRef.current, { goldenShape: v }) }
  const setGoldenColor = (v) => { setGoldenColorState(v); applyAllMarkers(indexRef.current, { goldenColor: v }) }
  const setGoldenSize = (v) => { setGoldenSizeState(v); applyAllMarkers(indexRef.current, { goldenSize: v }) }
  const setDeadShape = (v) => { setDeadShapeState(v); applyAllMarkers(indexRef.current, { deadShape: v }) }
  const setDeadColor = (v) => { setDeadColorState(v); applyAllMarkers(indexRef.current, { deadColor: v }) }
  const setDeadSize = (v) => { setDeadSizeState(v); applyAllMarkers(indexRef.current, { deadSize: v }) }
  const setDoubleBShapeLong = (v) => { setDoubleBShapeLongState(v); applyAllMarkers(indexRef.current, { doubleBShapeLong: v }) }
  const setDoubleBColorLong = (v) => { setDoubleBColorLongState(v); applyAllMarkers(indexRef.current, { doubleBColorLong: v }) }
  const setDoubleBSizeLong = (v) => { setDoubleBSizeLongState(v); applyAllMarkers(indexRef.current, { doubleBSizeLong: v }) }
  const setDoubleBShapeShort = (v) => { setDoubleBShapeShortState(v); applyAllMarkers(indexRef.current, { doubleBShapeShort: v }) }
  const setDoubleBColorShort = (v) => { setDoubleBColorShortState(v); applyAllMarkers(indexRef.current, { doubleBColorShort: v }) }
  const setDoubleBSizeShort = (v) => { setDoubleBSizeShortState(v); applyAllMarkers(indexRef.current, { doubleBSizeShort: v }) }

  const refreshDoubleBSignal = (pairs = doubleBPairs) => {
    const points = []
    for (const { a, b } of pairs) {
      if (a && b && a !== b) points.push(...computeDoubleBTouchForPair(a, b))
    }
    doubleBSignalPointsRef.current = points.sort((p, q) => p.idx - q.idx)
    applyAllMarkers(indexRef.current)
  }

  const setDoubleBPair = (slotIndex, which, lineKey) => {
    setDoubleBPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: lineKey } : p))
      refreshDoubleBSignal(next)
      return next
    })
  }

  const setBollInnerShapeLong = (v) => { setBollInnerShapeLongState(v); applyAllMarkers(indexRef.current, { bollInnerShapeLong: v }) }
  const setBollInnerColorLong = (v) => { setBollInnerColorLongState(v); applyAllMarkers(indexRef.current, { bollInnerColorLong: v }) }
  const setBollInnerSizeLong = (v) => { setBollInnerSizeLongState(v); applyAllMarkers(indexRef.current, { bollInnerSizeLong: v }) }
  const setBollInnerShapeShort = (v) => { setBollInnerShapeShortState(v); applyAllMarkers(indexRef.current, { bollInnerShapeShort: v }) }
  const setBollInnerColorShort = (v) => { setBollInnerColorShortState(v); applyAllMarkers(indexRef.current, { bollInnerColorShort: v }) }
  const setBollInnerSizeShort = (v) => { setBollInnerSizeShortState(v); applyAllMarkers(indexRef.current, { bollInnerSizeShort: v }) }

  // 볼린저 눌림 신호(왼쪽 표시용) - computeBollInnerTouchForPair()는 반자동/시뮬레이션과 공유, 슬롯별 매도/매수 표시만 따로 켜고 끈다
  // 볼린저 눌림 신호(왼쪽 표시용) - computeBollInnerTouchForPair()는 반자동/시뮬레이션과 공유, 매도/매수 표시만 따로 켜고 끈다
  const refreshBollInnerSignal = (sellEnabled = bollInnerSignalSellEnabled, buyEnabled = bollInnerSignalBuyEnabled) => {
    bollInnerSignalPointsRef.current = computeBollInnerTouchForPair(BOLL_INNER_SHORT_ID, BOLL_INNER_LONG_ID)
      .filter(p => (p.side === 'sell' && sellEnabled) || (p.side === 'buy' && buyEnabled))
      .sort((p, q) => p.idx - q.idx)
    applyAllMarkers(indexRef.current)
  }

  const toggleBollInnerSignalSell = () => {
    setBollInnerSignalSellEnabled(prev => {
      const next = !prev
      refreshBollInnerSignal(next, bollInnerSignalBuyEnabled)
      return next
    })
  }

  const toggleBollInnerSignalBuy = () => {
    setBollInnerSignalBuyEnabled(prev => {
      const next = !prev
      refreshBollInnerSignal(bollInnerSignalSellEnabled, next)
      return next
    })
  }

  // 지금 화면에 보이는 상태 그대로(재생/스크럽 위치, 켜둔 지표·마커 전부 포함) PNG로 캡처해서 바로 다운로드.
  // lightweight-charts 내장 takeScreenshot()은 지금까지 그려진 캔버스를 그대로 캡처하므로,
  // 재생 위치보다 앞선(아직 안 지난) 구간은 애초에 그려져 있지 않아 화면에 보이는 그대로만 찍힌다.
  const captureScreenshot = () => {
    const chart = chartRef.current
    if (!chart) return
    const canvas = chart.takeScreenshot()
    canvas.toBlob(blob => {
      if (!blob) return
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      const dateLabel = selectedDate ? (selectedDateTo ? `${selectedDate}_${selectedDateTo}` : selectedDate) : 'chart'
      a.href = url
      a.download = `${symbol}_${dateLabel}_${playIndex}봉.png`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    })
  }

  // 지금 재생 위치까지 실제로 화면에 그려진 데이터를 스샷(그림) 대신 숫자 그대로 뽑아낸다.
  // 캔들 + 볼린저밴드 5개 + 이평선 전부 + RSI + MACD1/5 - 전부 재생 위치(playIndex) 이후(아직 안 지난)
  // 구간은 제외하고 지금까지 드러난 만큼만 담는다(화면에 실제 그려진 것과 동일한 범위).
  const buildChartDataPayload = () => {
    const idx = playIndex
    const bands = {}
    for (const band of BOLLINGER_BANDS) {
      const d = bandDataRef.current[band.id]
      if (!d) continue
      bands[band.id] = {
        label: band.label,
        upper: d.upper.slice(0, idx).filter(Boolean),
        middle: d.middle.slice(0, idx).filter(Boolean),
        lower: d.lower.slice(0, idx).filter(Boolean),
      }
    }
    const movingAverages = {}
    for (const ma of ALL_MA) {
      const d = maDataRef.current[ma.id]
      if (!d) continue
      movingAverages[ma.id] = { label: ma.label, values: d.slice(0, idx).filter(Boolean) }
    }
    return {
      symbol, selectedDate, selectedDateTo, playIndex: idx, total,
      candles: rowsRef.current.slice(0, idx),
      bollingerBands: bands,
      movingAverages,
      rsi: rsiDataRef.current.slice(0, idx).filter(Boolean),
      macd1: {
        macd: macdDataRef.current.macd.slice(0, idx).filter(Boolean),
        signal: macdDataRef.current.signal.slice(0, idx).filter(Boolean),
        hist: macdDataRef.current.hist.slice(0, idx).filter(Boolean),
      },
      macd5: {
        macd: macd5DataRef.current.macd.slice(0, idx).filter(Boolean),
        signal: macd5DataRef.current.signal.slice(0, idx).filter(Boolean),
        hist: macd5DataRef.current.hist.slice(0, idx).filter(Boolean),
      },
    }
  }

  // "📋 데이터" 버튼 - 사람이 눌러서 JSON 파일로 다운로드(기존 그대로 둠).
  const exportChartData = () => {
    const payload = buildChartDataPayload()
    const blob = new Blob([JSON.stringify(payload)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    const dateLabel = selectedDate ? (selectedDateTo ? `${selectedDate}_${selectedDateTo}` : selectedDate) : 'chart'
    a.href = url
    a.download = `${symbol}_${dateLabel}_${payload.playIndex}봉_data.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // Claude가 Browser 도구로 이 페이지에 직접 접속했을 때, 파일 다운로드 없이 브라우저 콘솔에서
  // `window.getBacktestChartData()`를 호출해서 지금 이 화면 상태(재생위치까지)를 바로 읽어갈 수 있게
  // window에 노출해둔다. 렌더될 때마다 최신 클로저로 갱신(각 값이 바뀔 때마다 새로 만들어도 비용 거의 없음).
  useEffect(() => {
    window.getBacktestChartData = buildChartDataPayload
    return () => { if (window.getBacktestChartData === buildChartDataPayload) delete window.getBacktestChartData }
  })

  const play = () => {
    if (!rowsRef.current.length) return
    if (indexRef.current >= rowsRef.current.length) applyIndex(0)
    // 재생 위치를 찾기 힘들다는 피드백 - 재생 시작할 때 차트를 지금 캔들이 보이는 오른쪽 끝으로 이동시킨다.
    // 여기서 한 번만 옮겨두면, 그 뒤로 재생되면서 새 캔들이 추가될 때도 lightweight-charts가
    // 오른쪽 끝에 붙어있는 상태를 기본적으로 계속 따라가 준다.
    chartRef.current?.timeScale().scrollToPosition(0, true)
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

  // 포지션 id의 접두어로 어디서 생긴 거래인지 구분한다 - 반자동/시뮬레이션은 applyIncrement에서
  // `auto_...`/`sim_...`로 접두어를 붙여서 만들고, 수동 BUY/SELL(openPosition)은 접두어가 없다.
  const tradeSource = (id) => {
    if (id.startsWith('sim_')) return 'sim'
    if (id.startsWith('auto_')) return 'auto'
    return 'manual'
  }

  const closePosition = (id) => {
    const pos = positions.find(p => p.id === id)
    if (!pos) return
    if (currentPrice != null) {
      const { points, dollars } = calcPnl(pos, currentPrice)
      setBalance(b => b + dollars)
      closedTradesRef.current.push({
        source: tradeSource(pos.id), side: pos.side, symbol: pos.symbol, lot: pos.lot,
        entryPrice: pos.entryPrice, entryTime: pos.entryTime,
        exitPrice: currentPrice, exitTime: rowsRef.current[playIndex - 1]?.time ?? null,
        points, dollars,
      })
      setClosedTradesCount(c => c + 1)
    }
    setPositions(prev => prev.filter(p => p.id !== id))
  }

  // 시뮬레이션에서 나온 청산 거래만 모아서 DB에 저장 - 화면엔 노출 안 되고, 나중에 Claude가
  // MCP(run_sql)로 simulation_results 테이블을 조회해서 분석해주는 용도로만 씀.
  const saveSimulationResults = async () => {
    const trades = closedTradesRef.current.filter(t => t.source === 'sim')
    if (trades.length === 0) {
      alert('저장할 시뮬레이션 거래(청산된 것)가 없습니다. 시뮬레이션을 켜고 재생하면서 포지션을 청산해보세요.')
      return
    }
    setSavingResults(true)
    try {
      const res = await fetch('/api/simulation-results', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          symbol,
          date_from: selectedDate,
          date_to: selectedDateTo || selectedDate,
          starting_balance: startingBalance,
          ending_balance: balance,
          config: {
            crossPairs: simCrossPairs,
            doubleBPairs: simDoubleBPairs,
            bollInnerSellEnabled: simBollInnerSellEnabled,
            bollInnerBuyEnabled: simBollInnerBuyEnabled,
          },
          trades,
        }),
      })
      if (!res.ok) throw new Error()
      closedTradesRef.current = closedTradesRef.current.filter(t => t.source !== 'sim')
      setClosedTradesCount(closedTradesRef.current.length)
      alert(`시뮬레이션 결과 ${trades.length}건 저장했습니다.`)
    } catch {
      alert('저장에 실패했습니다.')
    }
    setSavingResults(false)
  }

  const applyStartingBalance = (value) => {
    const v = Math.max(0, Number(value) || 0)
    setStartingBalanceState(v)
    setBalance(v)
  }

  const nudgeLot = (delta) => {
    setLotSize(l => Math.max(0.01, Math.round((l + delta) * 100) / 100))
  }

  // 크로스/더블비 슬롯 공용 - 슬롯 3개(namePrefix+1/2/3), 슬롯마다 옵션 목록(options: [{id,label}])에서
  // 드롭다운 2개로 정확히 한 쌍만 고른다. 왼쪽 표시/반자동/시뮬레이션이 전부 이 헬퍼를 공유한다.
  const renderPairSlots = (pairs, setPair, options, namePrefix) => (
    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10 }}>
      {pairs.map((pair, i) => (
        <div key={i} style={{ minWidth: 140 }}>
          <div style={{ fontSize: 10, color: '#9aa0ab', marginBottom: 3 }}>{namePrefix}{i + 1}</div>
          <div style={{ display: 'flex', gap: 4 }}>
            <PairSelect value={pair.a} onChange={v => setPair(i, 'a', v)} options={options} />
            <PairSelect value={pair.b} onChange={v => setPair(i, 'b', v)} options={options} />
          </div>
        </div>
      ))}
    </div>
  )

  const renderCrossRow = (title, shape, setShape, color, setColor, size, setSize, extra) => (
    <div style={{ marginBottom: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 4 }}>
        <div style={{ fontSize: 10, color: '#9aa0ab' }}>{title}</div>
        {extra}
      </div>
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
          <nav style={{ display: 'flex', gap: 6 }}>
            <span style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'rgba(76,175,80,0.15)', color: '#4CAF50', border: '1px solid #4CAF50' }}>캔들 재생</span>
            <Link href="/backtest-intraday" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>📈 일중 패턴</Link>
          </nav>
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
                <label title="체크 해제하면 캔들을 숨깁니다(지표만 보고 판단 연습할 때)" style={{ display: 'flex', alignItems: 'center', gap: 4, flex: 1, cursor: 'pointer' }}>
                  <input type="checkbox" checked={candleVisible} onChange={toggleCandleVisible} />
                  캔들 색상
                </label>
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
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer', marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={multiSelectMode}
                    onChange={() => {
                      setMultiSelectMode(m => !m)
                      rangeAnchorRef.current = ''
                    }}
                    style={{ width: 13, height: 13, margin: 0, flexShrink: 0 }}
                  />
                  <span>여러 날 선택</span>
                </label>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer', marginBottom: 8 }}>
                  <input
                    type="checkbox"
                    checked={allMonthSelected}
                    onChange={selectAllMonth}
                    disabled={monthAvailableDates.length === 0}
                    style={{ width: 13, height: 13, margin: 0, flexShrink: 0 }}
                  />
                  <span>전체선택 {monthAvailableDates.length > 0 ? `(${monthAvailableDates.length}일)` : ''}</span>
                </label>
                <MonthCalendar
                  viewDate={viewDate}
                  onNavigate={navigateMonth}
                  availableDates={availableDates}
                  selectedDate={selectedDate}
                  selectedDateTo={selectedDateTo}
                  onSelect={handleCalendarSelect}
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

              <CollapsibleCard title="이평선" maxWidth={170} defaultOpen={false}>
                {MOVING_AVERAGES.map(ma => {
                  const on = !!enabledMA[ma.id]
                  const dual = isDualColor(ma.id)
                  const color = dual ? getDualUpColor(ma.id) : getMAColor(ma)
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
                        {dual ? (
                          <>
                            <input
                              type="color"
                              value={getDualUpColor(ma.id)}
                              onClick={e => e.stopPropagation()}
                              onChange={e => setDualUpColor(ma.id, e.target.value)}
                              title="상승 구간 색상"
                              style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                            />
                            <input
                              type="color"
                              value={getDualDownColor(ma.id)}
                              onClick={e => e.stopPropagation()}
                              onChange={e => setDualDownColor(ma.id, e.target.value)}
                              title="하락 구간 색상"
                              style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                            />
                          </>
                        ) : (
                          <input
                            type="color"
                            value={color}
                            onClick={e => e.stopPropagation()}
                            onChange={e => setMAColor(ma.id, e.target.value)}
                            title="색상변경 가능"
                            style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                          />
                        )}
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
                          {!dual && isCustomColor && (
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

              <CollapsibleCard title="리본" maxWidth={170} defaultOpen={false}>
                <div style={{ padding: '1px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={ribbonEnabled}
                      onChange={toggleRibbon}
                      style={{ width: 13, height: 13, margin: 0, accentColor: RIBBON_LIME, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>리본</span>
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                      상승
                      <input
                        type="color"
                        value={getDualUpColor('madrid05')}
                        onChange={e => setRibbonUpColor(e.target.value)}
                        title="상승 구간 색상(리본 18개 전체 적용)"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </label>
                    <label style={{ display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                      하락
                      <input
                        type="color"
                        value={getDualDownColor('madrid05')}
                        onChange={e => setRibbonDownColor(e.target.value)}
                        title="하락 구간 색상(리본 18개 전체 적용)"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </label>
                  </div>
                  <div style={{ marginTop: 5, fontSize: 10, color: '#5a5f6a', width: '100%', boxSizing: 'border-box' }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, whiteSpace: 'nowrap' }}>
                      <span>투명도</span>
                      <input
                        type="number"
                        min={10}
                        max={100}
                        step={5}
                        value={Math.round(ribbonOpacity * 100)}
                        onChange={e => {
                          const pct = Math.min(100, Math.max(10, Number(e.target.value) || 0))
                          setRibbonOpacityValue(pct / 100)
                        }}
                        style={{ width: 36, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                      />
                      <span>%</span>
                    </div>
                    <input
                      type="range"
                      min={0.1}
                      max={1}
                      step={0.05}
                      value={ribbonOpacity}
                      onChange={e => setRibbonOpacityValue(Number(e.target.value))}
                      style={{ width: '100%', boxSizing: 'border-box', display: 'block', margin: 0 }}
                    />
                  </div>
                </div>
              </CollapsibleCard>

              <CollapsibleCard title="보조지표" maxWidth={170} defaultOpen={false}>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledRSI}
                      onChange={toggleRSI}
                      style={{ width: 13, height: 13, margin: 0, accentColor: rsiColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>RSI(14)</span>
                    <input
                      type="color"
                      value={rsiColor}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setRsiColor(e.target.value)}
                      title="색상변경 가능"
                      style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                    />
                  </label>
                </div>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledMACD}
                      onChange={toggleMACD}
                      style={{ width: 13, height: 13, margin: 0, accentColor: macdLineColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>MACD1</span>
                  </label>
                  {enabledMACD && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                      <span>MACD</span>
                      <input
                        type="color"
                        value={macdLineColor}
                        onChange={e => setMacdLineColor(e.target.value)}
                        title="MACD선 색상"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                      <span>시그널</span>
                      <input
                        type="color"
                        value={macdSignalColor}
                        onChange={e => setMacdSignalColor(e.target.value)}
                        title="시그널선 색상"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </div>
                  )}
                </div>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledMACD5}
                      onChange={toggleMACD5}
                      style={{ width: 13, height: 13, margin: 0, accentColor: macd5LineColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>MACD5</span>
                  </label>
                  {enabledMACD5 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                      <span>MACD</span>
                      <input
                        type="color"
                        value={macd5LineColor}
                        onChange={e => setMacd5LineColor(e.target.value)}
                        title="MACD선 색상"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                      <span>시그널</span>
                      <input
                        type="color"
                        value={macd5SignalColor}
                        onChange={e => setMacd5SignalColor(e.target.value)}
                        title="시그널선 색상"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </div>
                  )}
                </div>
              </CollapsibleCard>

              <CollapsibleCard title="크로스 신호" maxWidth={170} defaultOpen={false}>
                {renderCrossRow('골든크로스', goldenShape, setGoldenShape, goldenColor, setGoldenColor, goldenSize, setGoldenSize)}
                {renderCrossRow('데드크로스', deadShape, setDeadShape, deadColor, setDeadColor, deadSize, setDeadSize)}
                {renderPairSlots(crossPairs, setCrossPair, MOVING_AVERAGES, '크로스')}
              </CollapsibleCard>

              <CollapsibleCard title="더블비 신호" maxWidth={170} defaultOpen={false}>
                {renderCrossRow('더블비 롱', doubleBShapeLong, setDoubleBShapeLong, doubleBColorLong, setDoubleBColorLong, doubleBSizeLong, setDoubleBSizeLong)}
                {renderCrossRow('더블비 숏', doubleBShapeShort, setDoubleBShapeShort, doubleBColorShort, setDoubleBColorShort, doubleBSizeShort, setDoubleBSizeShort)}
                {renderPairSlots(doubleBPairs, setDoubleBPair, DOUBLE_B_LINE_OPTIONS, '더블비')}
              </CollapsibleCard>

              <CollapsibleCard title="볼린저 눌림 신호" maxWidth={170} defaultOpen={false}>
                {renderCrossRow('눌림 롱', bollInnerShapeLong, setBollInnerShapeLong, bollInnerColorLong, setBollInnerColorLong, bollInnerSizeLong, setBollInnerSizeLong)}
                {renderCrossRow('눌림 숏', bollInnerShapeShort, setBollInnerShapeShort, bollInnerColorShort, setBollInnerColorShort, bollInnerSizeShort, setBollInnerSizeShort)}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: bollInnerSignalSellEnabled ? '#ef5350' : '#9aa0ab', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={bollInnerSignalSellEnabled}
                      onChange={toggleBollInnerSignalSell}
                      style={{ width: 12, height: 12, margin: 0, accentColor: '#ef5350', flexShrink: 0 }}
                    />
                    5분 상단 눌림 (매도)
                  </label>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: bollInnerSignalBuyEnabled ? '#26a69a' : '#9aa0ab', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={bollInnerSignalBuyEnabled}
                      onChange={toggleBollInnerSignalBuy}
                      style={{ width: 12, height: 12, margin: 0, accentColor: '#26a69a', flexShrink: 0 }}
                    />
                    5분 하단 눌림 (매수)
                  </label>
                </div>
              </CollapsibleCard>
            </div>

            {/* 오른쪽 컬럼: 상태줄 / 차트 / 컨트롤 */}
            <div style={{ flex: 1, minWidth: 280 }}>
              <div style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
                {!selectedDate && <div style={{ color: '#9aa0ab', fontSize: 13 }}>왼쪽 달력에서 초록색으로 표시된 날짜를 눌러보세요.</div>}
                {selectedDate && (
                  <div style={{ color: '#e8eaed', fontSize: 14, fontWeight: 700 }}>
                    {selectedDateTo ? `${selectedDate} ~ ${selectedDateTo}` : selectedDate}
                    {multiSelectMode && !selectedDateTo && rangeAnchorRef.current && (
                      <span style={{ color: '#9aa0ab', fontWeight: 400, fontSize: 12, marginLeft: 8 }}>끝 날짜를 눌러주세요</span>
                    )}
                  </div>
                )}
                {error && <div style={{ color: '#F44336', fontSize: 13, marginLeft: 12 }}>❌ {error}</div>}
                {loadingCsv && <div style={{ color: '#9aa0ab', fontSize: 13, marginLeft: 12 }}>불러오는 중...</div>}
                <button
                  type="button"
                  onClick={toggleSummerTime}
                  title="브로커 서버가 서머타임 중인지 전환 - 겨울엔 서버시간이 1시간 밀려서(EEST→EET) 한국시간 환산 기준이 바뀝니다"
                  style={{
                    marginLeft: 'auto', fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                    border: `1px solid ${summerTime ? '#FF9800' : '#4FC3F7'}`,
                    background: summerTime ? '#FF980022' : '#4FC3F722',
                    color: summerTime ? '#FF9800' : '#4FC3F7',
                  }}
                >{summerTime ? '☀ 서머타임 (+6h)' : '❄ 윈터타임 (+7h)'}</button>
              </div>

              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16 }}>
                <div ref={containerRef} style={{ width: '100%', height: 860 }} />
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

                <button onClick={captureScreenshot} disabled={!total} title="지금 보이는 상태 그대로 PNG로 저장" style={{
                  background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '10px 16px', fontSize: 14, cursor: total ? 'pointer' : 'not-allowed',
                }}>📸 스샷</button>

                <button onClick={exportChartData} disabled={!total} title="지금까지 재생된 캔들+볼린저+이평선+RSI+MACD 값을 JSON으로 저장" style={{
                  background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '10px 16px', fontSize: 14, cursor: total ? 'pointer' : 'not-allowed',
                }}>📋 데이터</button>

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
              <div style={{ fontSize: 12.5, color: '#c8ccd4', marginTop: 6, fontWeight: 500 }}>
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
                    <button type="button" onClick={() => nudgeLot(-0.01)} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1, background: 'none', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', fontSize: 16, cursor: 'pointer' }}>−</button>
                    <input
                      type="number" step={0.01} min={0.01} value={lotSize}
                      onChange={e => setLotSize(Math.max(0.01, Number(e.target.value) || 0.01))}
                      style={{ width: 64, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '5px 6px', fontSize: 13, textAlign: 'center' }}
                    />
                    <button type="button" onClick={() => nudgeLot(0.01)} style={{ width: 26, height: 26, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1, background: 'none', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', fontSize: 16, cursor: 'pointer' }}>+</button>
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

              <div style={{ marginTop: 16 }}>
                <CollapsibleCard title="⚙ 반자동" maxWidth="none" defaultOpen={false}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 12 }}>
                    <input
                      type="checkbox" checked={semiAutoEnabled}
                      onChange={e => setSemiAutoEnabled(e.target.checked)}
                      style={{ width: 15, height: 15, accentColor: '#4CAF50' }}
                    />
                    반자동 사용하기
                  </label>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                      조건: 크로스 — 골든크로스 매수 / 데드크로스 매도 (왼쪽 "크로스" 표시와는 슬롯이 따로지만, 같은 조합을 골라두면 마커가 뜨는 캔들에 그대로 진입됩니다)
                    </div>
                    {renderPairSlots(autoCrossPairs, setAutoCrossPair, MOVING_AVERAGES, '크로스')}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                      조건: 더블비 — 슬롯에서 고른 라인 2개가 겹친 구간을 캔들이 동시에 터치 (겹친 구간이 상단쪽이면 매도, 하단쪽이면 매수 / 왼쪽 "더블비 신호" 표시와는 슬롯이 따로지만, 같은 조합을 골라두면 마커가 뜨는 캔들에 그대로 진입됩니다)
                    </div>
                    {renderPairSlots(autoDoubleBPairs, setAutoDoubleBPair, DOUBLE_B_LINE_OPTIONS, '더블비')}
                  </div>

                  <div>
                    <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                      조건: 볼린저 눌림(5분↔15분 고정) — 5분 상단선이 15분 상단선 안(아래)이면 매도, 5분 하단선이 15분 하단선 안(위)이면 매수. 유지되는 동안 매 캔들 계속 신호
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: autoBollInnerSellEnabled ? '#ef5350' : '#9aa0ab', cursor: 'pointer' }}>
                        <input type="checkbox" checked={autoBollInnerSellEnabled} onChange={toggleAutoBollInnerSell} style={{ width: 13, height: 13, margin: 0, accentColor: '#ef5350' }} />
                        5분 상단 눌림 → 매도
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: autoBollInnerBuyEnabled ? '#26a69a' : '#9aa0ab', cursor: 'pointer' }}>
                        <input type="checkbox" checked={autoBollInnerBuyEnabled} onChange={toggleAutoBollInnerBuy} style={{ width: 13, height: 13, margin: 0, accentColor: '#26a69a' }} />
                        5분 하단 눌림 → 매수
                      </label>
                    </div>
                  </div>
                </CollapsibleCard>
              </div>

              {/* 시뮬레이션 - 반자동과 조건 구성/계산 로직은 동일하고, 켜고 끄는 체크와 진입 타임라인만 별도라
                  반자동과 동시에 켜두고 서로 다른 조건 조합을 비교해볼 수 있다. 날짜 선택/재생은 위 차트 컨트롤 그대로 공용으로 쓴다. */}
              <div style={{ marginTop: 16 }}>
                <CollapsibleCard title="🧪 시뮬레이션" maxWidth="none" defaultOpen={false}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 14, fontWeight: 700, cursor: 'pointer', marginBottom: 12 }}>
                    <input
                      type="checkbox" checked={simulationEnabled}
                      onChange={e => setSimulationEnabled(e.target.checked)}
                      style={{ width: 15, height: 15, accentColor: '#4CAF50' }}
                    />
                    시뮬레이션 사용하기
                  </label>

                  {/* 화면에 노출되는 "분석" 기능은 아니고, 청산된 시뮬레이션 거래를 DB에 쌓아뒀다가
                      나중에 대화 중 요청하면 그 기록을 조회해서 분석해주는 용도의 저장 버튼 */}
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14, padding: '8px 10px', background: '#0f1115', borderRadius: 8 }}>
                    <span style={{ fontSize: 12, color: '#9aa0ab' }}>청산된 시뮬레이션 거래 {closedTradesCount}건</span>
                    <button
                      type="button"
                      onClick={saveSimulationResults}
                      disabled={savingResults}
                      style={{
                        fontSize: 12, padding: '5px 12px', borderRadius: 6, cursor: savingResults ? 'default' : 'pointer',
                        border: '1px solid #4CAF50', background: '#4CAF5022', color: '#4CAF50', fontWeight: 700,
                        opacity: savingResults ? 0.6 : 1,
                      }}
                    >{savingResults ? '저장 중...' : '결과 저장'}</button>
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                      조건: 크로스 — 골든크로스 매수 / 데드크로스 매도 (반자동과 별개로 켜고 끌 수 있는 시뮬레이션 전용 슬롯입니다)
                    </div>
                    {renderPairSlots(simCrossPairs, setSimCrossPair, MOVING_AVERAGES, '크로스')}
                  </div>

                  <div style={{ marginBottom: 14 }}>
                    <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                      조건: 더블비 — 슬롯에서 고른 라인 2개가 겹친 구간을 캔들이 동시에 터치 (겹친 구간이 상단쪽이면 매도, 하단쪽이면 매수 / 반자동과 별개인 시뮬레이션 전용 슬롯입니다)
                    </div>
                    {renderPairSlots(simDoubleBPairs, setSimDoubleBPair, DOUBLE_B_LINE_OPTIONS, '더블비')}
                  </div>

                  <div>
                    <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6 }}>
                      조건: 볼린저 눌림(5분↔15분 고정) — 5분 상단선이 15분 상단선 안(아래)이면 매도, 5분 하단선이 15분 하단선 안(위)이면 매수. 유지되는 동안 매 캔들 계속 신호
                    </div>
                    <div style={{ display: 'flex', flexWrap: 'wrap', gap: 16 }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: simBollInnerSellEnabled ? '#ef5350' : '#9aa0ab', cursor: 'pointer' }}>
                        <input type="checkbox" checked={simBollInnerSellEnabled} onChange={toggleSimBollInnerSell} style={{ width: 13, height: 13, margin: 0, accentColor: '#ef5350' }} />
                        5분 상단 눌림 → 매도
                      </label>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: simBollInnerBuyEnabled ? '#26a69a' : '#9aa0ab', cursor: 'pointer' }}>
                        <input type="checkbox" checked={simBollInnerBuyEnabled} onChange={toggleSimBollInnerBuy} style={{ width: 13, height: 13, margin: 0, accentColor: '#26a69a' }} />
                        5분 하단 눌림 → 매수
                      </label>
                    </div>
                  </div>
                </CollapsibleCard>
              </div>
            </div>
          </div>
        </main>
      </div>
    </>
  )
}
