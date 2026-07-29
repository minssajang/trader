

// 볼린저밴드 계산 — EasyTrade_MT5 데스크톱 앱(hma_simulation.py/hma_tab.py)과 같은 공식.
// 중심선 = 종가 SMA(period), 상/하단 = 중심선 ± 2 * 표준편차(period)
// (표준편차는 pandas rolling().std() 기본값인 표본표준편차(ddof=1)로 맞춤)
export function rollingBollinger(closes, period) {
  const n = closes.length
  const mids = new Array(n).fill(null)
  const ups = new Array(n).fill(null)
  const lows = new Array(n).fill(null)
  if (period < 2) return { mids, ups, lows }

  let sum = 0
  let sumSq = 0
  for (let i = 0; i < n; i++) {
    sum += closes[i]
    sumSq += closes[i] * closes[i]
    if (i >= period) {
      sum -= closes[i - period]
      sumSq -= closes[i - period] * closes[i - period]
    }
    if (i >= period - 1) {
      const mean = sum / period
      const sumSqDev = Math.max(0, sumSq - period * mean * mean)
      const std = Math.sqrt(sumSqDev / (period - 1))
      mids[i] = mean
      ups[i] = mean + 2 * std
      lows[i] = mean - 2 * std
    }
  }
  return { mids, ups, lows }
}

// 1분/3분/5분/15분/1시간 볼린저 — EasyTrade_MT5 hma_simulation.py의 멀티 타임프레임
// 치환 규칙(예: "5분 SMA20" = 1분봉 기준 "SMA100")을 그대로 따른다.
// label엔 SMA 숫자를 안 보여준다 - 그건 계산에 쓸 기간을 알려주는 값이었을 뿐, 화면에 노출하라는 게 아니었음.
// "볼린저" => "B"로 축약(사용자 요청) - 더블비/눌림 슬롯 드롭다운에서 옵션 텍스트가 길어서 좁은 카드
// 밖으로 튀어나오는 문제가 있었음. 이 label을 쓰는 모든 화면(왼쪽 볼린저 체크 목록, 더블비/눌림 드롭다운)에
// 한번에 반영됨.
export const BOLLINGER_BANDS = [
  { id: 'sma20', label: '1분B', period: 20, color: '#F44336' },
  { id: 'sma60', label: '3분B', period: 60, color: '#4FC3F7' },
  { id: 'sma100', label: '5분B', period: 100, color: '#FF9800' },
  { id: 'sma300', label: '15분B', period: 300, color: '#6DFF38' },
  { id: 'sma1200', label: '1시간B', period: 1200, color: '#1F43F4' },
]

// 단순이동평균(SMA) - 표준편차 없이 평균만.
export function rollingSMA(closes, period) {
  const n = closes.length
  const out = new Array(n).fill(null)
  if (period < 1) return out
  let sum = 0
  for (let i = 0; i < n; i++) {
    sum += closes[i]
    if (i >= period) sum -= closes[i - period]
    if (i >= period - 1) out[i] = sum / period
  }
  return out
}

// values(null 섞여있어도 됨)의 뒤에서부터 최근 period개를 가중평균(WMA)한다.
// 가장 오래된 값 가중치 1, 가장 최신 값 가중치 period. (오래된 값 무시하고 null 구간은 건너뜀)
export function rollingWMA(values, period) {
  const n = values.length
  const out = new Array(n).fill(null)
  if (period < 1) return out

  const idxs = []
  const dense = []
  for (let i = 0; i < n; i++) {
    if (values[i] != null) { idxs.push(i); dense.push(values[i]) }
  }
  if (dense.length < period) return out

  const weightSum = (period * (period + 1)) / 2
  let S = 0
  let N = 0
  for (let k = 0; k < period; k++) {
    S += dense[k]
    N += dense[k] * (k + 1)
  }
  out[idxs[period - 1]] = N / weightSum
  for (let k = period; k < dense.length; k++) {
    N = N - S + period * dense[k]
    S = S - dense[k - period] + dense[k]
    out[idxs[k]] = N / weightSum
  }
  return out
}

// HMA(Hull Moving Average) — EasyTrade_MT5 hma_simulation.py의 _hma()와 같은 공식.
// HMA(n) = WMA( 2*WMA(n/2) - WMA(n), sqrt(n) )
export function rollingHMA(closes, period) {
  const half = Math.max(1, Math.floor(period / 2))
  const sqrtN = Math.max(1, Math.floor(Math.sqrt(period)))
  const wmaHalf = rollingWMA(closes, half)
  const wmaFull = rollingWMA(closes, period)

  const n = closes.length
  const raw = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (wmaHalf[i] != null && wmaFull[i] != null) {
      raw[i] = 2 * wmaHalf[i] - wmaFull[i]
    }
  }
  return rollingWMA(raw, sqrtN)
}

// 종가 배열에 대해 ma.type에 맞는 이동평균을 계산한다.
export function computeMA(ma, closes) {
  if (ma.type === 'sma') return rollingSMA(closes, ma.period)
  if (ma.type === 'wma') return rollingWMA(closes, ma.period)
  return rollingHMA(closes, ma.period)
}

// 이평선 — type: 'hma'|'wma'|'sma'. period는 1분봉 기준 내부 계산기간
// (표시기간 × 분 = 내부기간, 볼린저와 같은 치환 규칙). lineWidth/lineStyle은
// lightweight-charts 라인 시리즈 옵션 그대로(lineStyle 0=실선, 2=점선).
// label은 좁은 왼쪽 컬럼에서 줄바꿈 안 되게 짧게 유지 (H=HMA, W+숫자=WMA표시기간, S+숫자=SMA표시기간)
export const MOVING_AVERAGES = [
  { id: 'hma10', label: '30초 H', type: 'hma', period: 10, color: '#FFEB3B', lineWidth: 3, lineStyle: 2 },
  { id: 'hma20', label: '1분 H', type: 'hma', period: 20, color: '#F44336', lineWidth: 3, lineStyle: 2 },
  { id: 'hma60', label: '3분 H', type: 'hma', period: 60, color: '#4FC3F7', lineWidth: 3, lineStyle: 2 },
  { id: 'hma100', label: '5분 H', type: 'hma', period: 100, color: '#FF9800', lineWidth: 3, lineStyle: 2 },
  { id: 'hma300', label: '15분 H', type: 'hma', period: 300, color: '#6DFF38', lineWidth: 3, lineStyle: 2 },
  { id: 'hma1200', label: '1시간 H', type: 'hma', period: 1200, color: '#1F43F4', lineWidth: 3, lineStyle: 2 },
  { id: 'wma17_1m', label: '1분 W17', type: 'wma', period: 17, color: '#2196F3', lineWidth: 2, lineStyle: 0 },
  { id: 'sma20_3m', label: '3분 S20', type: 'sma', period: 60, color: '#FFFFFF', lineWidth: 2, lineStyle: 0 },
  { id: 'wma17_5m', label: '5분 W17', type: 'wma', period: 85, color: '#4FC3F7', lineWidth: 2, lineStyle: 0 },
  { id: 'wma4_1h', label: '1시간 W4', type: 'wma', period: 240, color: '#FFEB3B', lineWidth: 3, lineStyle: 2 },
  // 볼린저 중심선(sma20/sma60/sma100/sma300/sma1200)과 같은 기간의 단순이동평균 - 밴드 없이 선 하나만.
  // 3분(sma20_3m/period 60)은 이미 있었고, 나머지 5분/15분/1시간을 추가함(사용자 요청).
  { id: 'sma100', label: '5분 S', type: 'sma', period: 100, color: '#26A69A', lineWidth: 2, lineStyle: 0 },
  { id: 'sma300', label: '15분 S', type: 'sma', period: 300, color: '#EF5350', lineWidth: 2, lineStyle: 0 },
  { id: 'sma1200', label: '1시간 S', type: 'sma', period: 1200, color: '#AB47BC', lineWidth: 2, lineStyle: 0 },
]
