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
export const BOLLINGER_BANDS = [
  { id: 'sma10', label: '30초 볼린저 SMA10', period: 10, color: '#FFEB3B' },
  { id: 'sma20', label: '1분 볼린저 SMA20', period: 20, color: '#F44336' },
  { id: 'sma60', label: '3분 볼린저 SMA60', period: 60, color: '#4FC3F7' },
  { id: 'sma100', label: '5분 볼린저 SMA100', period: 100, color: '#FF9800' },
  { id: 'sma300', label: '15분 볼린저 SMA300', period: 300, color: '#CDDC39' },
  { id: 'sma1200', label: '1시간 볼린저 SMA1200', period: 1200, color: '#2196F3' },
]
