
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

// 30초/1분/3분/5분/15분/1시간 볼린저 — EasyTrade_MT5 hma_simulation.py의 멀티 타임프레임
// 치환 규칙(예: "5분 SMA20" = 1분봉 기준 "SMA100")을 그대로 따른다.
// label엔 SMA 숫자를 안 보여준다 - 그건 계산에 쓸 기간을 알려주는 값이었을 뿐, 화면에 노출하라는 게 아니었음.
export const BOLLINGER_BANDS = [
  { id: 'sma10', label: '30초 볼린저', period: 10, color: '#FFEB3B' },
  { id: 'sma20', label: '1분 볼린저', period: 20, color: '#F44336' },
  { id: 'sma60', label: '3분 볼린저', period: 60, color: '#4FC3F7' },
  { id: 'sma100', label: '5분 볼린저', period: 100, color: '#FF9800' },
  { id: 'sma300', label: '15분 볼린저', period: 300, color: '#6DFF38' },
  { id: 'sma1200', label: '1시간 볼린저', period: 1200, color: '#1F43F4' },
]

// values(null 섞여있어도 됨)의 뒤에서부터 최근 period개를 가중평균(WMA)한다.
// 가장 오래된 값 가중치 1, 가장 최신 값 가중치 period. (오래된 값 무시하고 null 구간은 건너뜀)
function rollingWMA(values, period) {
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

// 이평선(HMA) — 볼린저와 동일한 6개 타임프레임/기간/색상을 그대로 쓴다.
export const MOVING_AVERAGES = [
  { id: 'hma10', label: '30초 이평선', period: 10, color: '#FFEB3B' },
  { id: 'hma20', label: '1분 이평선', period: 20, color: '#F44336' },
  { id: 'hma60', label: '3분 이평선', period: 60, color: '#4FC3F7' },
  { id: 'hma100', label: '5분 이평선', period: 100, color: '#FF9800' },
  { id: 'hma300', label: '15분 이평선', period: 300, color: '#6DFF38' },
  { id: 'hma1200', label: '1시간 이평선', period: 1200, color: '#1F43F4' },
]
