

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

// 도치안 채널(Donchian Channel) - 상단 = 최근 period개 고가의 최고값, 하단 = 최근 period개 저가의
// 최저값, 중심선 = 상하단의 평균. 볼린저처럼 표준편차로 매 순간 출렁이지 않고, 그 기간의 실제 고점/저점이
// 갱신될 때만 선이 움직여서 더 안정적인 기준선 역할을 한다(사용자 요청 - "볼린저는 너무 움직여서 판단이
// 어렵다"). period/색상은 BOLLINGER_BANDS와 1:1로 동일하게 맞춤(사용자 요청).
export function rollingDonchian(candles, period) {
  const n = candles.length
  const mids = new Array(n).fill(null)
  const ups = new Array(n).fill(null)
  const lows = new Array(n).fill(null)
  if (period < 1) return { mids, ups, lows }

  // 슬라이딩 윈도우 최댓값/최솟값을 단조 deque로 O(n)에 구한다(head/tail 포인터만 증가시켜서
  // Array.shift()의 O(k) 재정렬 비용을 피함 - period가 최대 1200이라 n*period 방식은 브라우저에서 느림).
  const maxDeque = new Array(n); let maxHead = 0, maxTail = 0
  const minDeque = new Array(n); let minHead = 0, minTail = 0

  for (let i = 0; i < n; i++) {
    while (maxTail > maxHead && candles[maxDeque[maxTail - 1]].high <= candles[i].high) maxTail--
    maxDeque[maxTail++] = i
    while (minTail > minHead && candles[minDeque[minTail - 1]].low >= candles[i].low) minTail--
    minDeque[minTail++] = i

    const windowStart = i - period + 1
    while (maxDeque[maxHead] < windowStart) maxHead++
    while (minDeque[minHead] < windowStart) minHead++

    if (i >= period - 1) {
      const up = candles[maxDeque[maxHead]].high
      const lo = candles[minDeque[minHead]].low
      ups[i] = up
      lows[i] = lo
      mids[i] = (up + lo) / 2
    }
  }
  return { mids, ups, lows }
}

export const DONCHIAN_CHANNELS = [
  { id: 'don20', label: '1분D', period: 20, color: '#F44336', type: 'donchian' },
  { id: 'don60', label: '3분D', period: 60, color: '#4FC3F7', type: 'donchian' },
  { id: 'don100', label: '5분D', period: 100, color: '#FF9800', type: 'donchian' },
  { id: 'don300', label: '15분D', period: 300, color: '#6DFF38', type: 'donchian' },
  { id: 'don1200', label: '1시간D', period: 1200, color: '#1F43F4', type: 'donchian' },
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

// values(null 섞여있어도 됨)의 최근 period개를 단순평균한다 - rollingSMA와 달리 앞부분 null을
// 건너뛰고 밀도 있는 값들끼리만 계산(rollingWMA/rollingEMA와 같은 "dense" 방식). 스토캐스틱 %K
// 평활(Slow %K)·%D처럼 원본 배열 앞부분이 비어있는 값을 다시 평균낼 때 씀.
function rollingSMADense(values, period) {
  const n = values.length
  const out = new Array(n).fill(null)
  if (period < 1) return out
  const idxs = []
  const dense = []
  for (let i = 0; i < n; i++) {
    if (values[i] != null) { idxs.push(i); dense.push(values[i]) }
  }
  if (dense.length < period) return out
  let sum = 0
  for (let j = 0; j < period; j++) sum += dense[j]
  out[idxs[period - 1]] = sum / period
  for (let j = period; j < dense.length; j++) {
    sum += dense[j] - dense[j - period]
    out[idxs[j]] = sum / period
  }
  return out
}

// 스토캐스틱 - kPeriod 구간의 최고/최저가 대비 종가 위치(0~100, raw %K)를 구하고,
// kSmooth로 한 번 평활한 게 화면에 그리는 %K(Slow %K), 그 %K를 다시 dPeriod로 평활한 게 %D(시그널).
// candles는 {high, low, close} 배열이면 되고(캔들 원본 그대로 넘기면 됨).
export function rollingStochastic(candles, kPeriod, kSmooth, dPeriod) {
  const n = candles.length
  const rawK = new Array(n).fill(null)
  for (let i = kPeriod - 1; i < n; i++) {
    let hh = -Infinity, ll = Infinity
    for (let j = i - kPeriod + 1; j <= i; j++) {
      if (candles[j].high > hh) hh = candles[j].high
      if (candles[j].low < ll) ll = candles[j].low
    }
    rawK[i] = hh === ll ? 50 : (candles[i].close - ll) / (hh - ll) * 100
  }
  const k = rollingSMADense(rawK, kSmooth)
  const d = rollingSMADense(k, dPeriod)
  return { k, d }
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
  if (ma.type === 'ema') return rollingEMA(closes, ma.period)
  return rollingHMA(closes, ma.period)
}

// 이평선 — type: 'hma'|'wma'|'sma'. period는 1분봉 기준 내부 계산기간
// (표시기간 × 분 = 내부기간, 볼린저와 같은 치환 규칙). lineWidth/lineStyle은
// lightweight-charts 라인 시리즈 옵션 그대로(lineStyle 0=실선, 1=점선(dot), 2=대시).
// label은 좁은 왼쪽 컬럼에서 줄바꿈 안 되게 짧게 유지 (H=HMA, W+숫자=WMA표시기간, S+숫자=SMA표시기간)
// H(hma) 계열 6개는 전부 점(dot) 스타일로 통일(사용자 요청) - 예전엔 대시(2)였음.
export const MOVING_AVERAGES = [
  { id: 'hma10', label: '30초 H', type: 'hma', period: 10, color: '#FFEB3B', lineWidth: 3, lineStyle: 1 },
  { id: 'hma20', label: '1분 H', type: 'hma', period: 20, color: '#F44336', lineWidth: 3, lineStyle: 1 },
  { id: 'hma60', label: '3분 H', type: 'hma', period: 60, color: '#4FC3F7', lineWidth: 3, lineStyle: 1 },
  { id: 'hma100', label: '5분 H', type: 'hma', period: 100, color: '#FF9800', lineWidth: 3, lineStyle: 1 },
  { id: 'hma300', label: '15분 H', type: 'hma', period: 300, color: '#6DFF38', lineWidth: 3, lineStyle: 1 },
  { id: 'hma1200', label: '1시간 H', type: 'hma', period: 1200, color: '#1F43F4', lineWidth: 3, lineStyle: 1 },
  // W(wma) 계열 3개는 전부 대시(2) 스타일로 통일(사용자 요청, wma4_1h는 원래도 2였음)
  { id: 'wma17_1m', label: '1분 W17', type: 'wma', period: 17, color: '#2196F3', lineWidth: 2, lineStyle: 2 },
  { id: 'sma20_3m', label: '3분 S20', type: 'sma', period: 60, color: '#FFFFFF', lineWidth: 2, lineStyle: 0 },
  { id: 'wma17_5m', label: '5분 W17', type: 'wma', period: 85, color: '#4FC3F7', lineWidth: 2, lineStyle: 2 },
  { id: 'wma4_1h', label: '1시간 W4', type: 'wma', period: 240, color: '#FFEB3B', lineWidth: 3, lineStyle: 2 },
  // 볼린저 중심선(sma20/sma60/sma100/sma300/sma1200)과 같은 기간의 단순이동평균 - 밴드 없이 선 하나만.
  // 3분(sma20_3m/period 60)은 이미 있었고, 나머지 5분/15분/1시간을 추가함(사용자 요청).
  { id: 'sma100', label: '5분 S', type: 'sma', period: 100, color: '#26A69A', lineWidth: 2, lineStyle: 0 },
  { id: 'sma300', label: '15분 S', type: 'sma', period: 300, color: '#EF5350', lineWidth: 2, lineStyle: 0 },
  { id: 'sma1200', label: '1시간 S', type: 'sma', period: 1200, color: '#AB47BC', lineWidth: 2, lineStyle: 0 },
]

// Madrid 리본(EMA 5~90, 5씩 18개) - 선은 18개 다 그리되, MACD처럼 체크박스 하나가 전체 세트를
// 켜고 끈다(사용자 요청 - "세트"는 체크박스를 하나로 묶으라는 뜻이었지 선을 줄이라는 게 아니었음).
// 오르면 라임/내리면 레드로 색이 바뀌게 그린다(트레이딩뷰처럼, 사용자 요청).
export const MADRID_RIBBON = [
  { id: 'madrid05', label: 'M5', type: 'ema', period: 5, color: '#FFF176', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid10', label: 'M10', type: 'ema', period: 10, color: '#FFEE58', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid15', label: 'M15', type: 'ema', period: 15, color: '#FFCA28', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid20', label: 'M20', type: 'ema', period: 20, color: '#FFA726', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid25', label: 'M25', type: 'ema', period: 25, color: '#FF7043', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid30', label: 'M30', type: 'ema', period: 30, color: '#FF5252', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid35', label: 'M35', type: 'ema', period: 35, color: '#EC407A', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid40', label: 'M40', type: 'ema', period: 40, color: '#D81B60', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid45', label: 'M45', type: 'ema', period: 45, color: '#AB47BC', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid50', label: 'M50', type: 'ema', period: 50, color: '#8E24AA', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid55', label: 'M55', type: 'ema', period: 55, color: '#7E57C2', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid60', label: 'M60', type: 'ema', period: 60, color: '#5C6BC0', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid65', label: 'M65', type: 'ema', period: 65, color: '#3F51B5', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid70', label: 'M70', type: 'ema', period: 70, color: '#42A5F5', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid75', label: 'M75', type: 'ema', period: 75, color: '#29B6F6', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid80', label: 'M80', type: 'ema', period: 80, color: '#26C6DA', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid85', label: 'M85', type: 'ema', period: 85, color: '#26A69A', lineWidth: 1, lineStyle: 0 },
  { id: 'madrid90', label: 'M90', type: 'ema', period: 90, color: '#66BB6A', lineWidth: 1, lineStyle: 0 },
]

// EMA(지수이동평균) - MACD 계산에 필요한 보조 함수. 첫 값은 초기 period개의 단순평균으로 시작(표준 방식).
// values에 null이 섞여있어도(예: MACD라인처럼 앞부분이 비어있는 배열) 그 구간은 건너뛰고 밀도 있는 값들끼리만 계산한다.
export function rollingEMA(values, period) {
  const n = values.length
  const out = new Array(n).fill(null)
  if (period < 1) return out

  const idxs = []
  const dense = []
  for (let i = 0; i < n; i++) {
    if (values[i] != null) { idxs.push(i); dense.push(values[i]) }
  }
  if (dense.length < period) return out

  const k = 2 / (period + 1)
  let sum = 0
  for (let j = 0; j < period; j++) sum += dense[j]
  let ema = sum / period
  out[idxs[period - 1]] = ema
  for (let j = period; j < dense.length; j++) {
    ema = dense[j] * k + ema * (1 - k)
    out[idxs[j]] = ema
  }
  return out
}

// RSI(Wilder 방식) - 첫 구간(period개)은 단순평균으로 시작, 이후 1/period 가중치로 평활.
// 0~100 사이 값. avgLoss가 0이면(계속 상승만) 100으로 처리.
export function rollingRSI(closes, period = 14) {
  const n = closes.length
  const out = new Array(n).fill(null)
  if (n < period + 1) return out

  let gainSum = 0
  let lossSum = 0
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i - 1]
    if (diff > 0) gainSum += diff
    else lossSum -= diff
  }
  let avgGain = gainSum / period
  let avgLoss = lossSum / period
  out[period] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)

  for (let i = period + 1; i < n; i++) {
    const diff = closes[i] - closes[i - 1]
    const gain = diff > 0 ? diff : 0
    const loss = diff < 0 ? -diff : 0
    avgGain = (avgGain * (period - 1) + gain) / period
    avgLoss = (avgLoss * (period - 1) + loss) / period
    out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss)
  }
  return out
}

// MACD - macd라인(EMA fast - EMA slow) / 시그널라인(macd라인의 EMA signal) / 히스토그램(macd-시그널) 반환.
// 기본 12/26/9(표준값, 사용자 요청대로 고정 - 커스터마이징은 색상만).
export function rollingMACD(closes, fast = 12, slow = 26, signal = 9) {
  const emaFast = rollingEMA(closes, fast)
  const emaSlow = rollingEMA(closes, slow)
  const n = closes.length
  const macdLine = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (emaFast[i] != null && emaSlow[i] != null) macdLine[i] = emaFast[i] - emaSlow[i]
  }
  const signalLine = rollingEMA(macdLine, signal)
  const histogram = new Array(n).fill(null)
  for (let i = 0; i < n; i++) {
    if (macdLine[i] != null && signalLine[i] != null) histogram[i] = macdLine[i] - signalLine[i]
  }
  return { macdLine, signalLine, histogram }
}
