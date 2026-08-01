import { supabase } from '../../lib/supabase'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, MOVING_AVERAGES, computeMA, rollingRSI, rollingMACD } from '../../lib/indicators'

// backtest-chart.js(백테스팅 캔들 리플레이 페이지)가 화면에 그리는 것과 동일한 계산을 서버에서
// 그대로 수행해서 JSON으로 돌려주는 읽기 전용 API. Claude(또는 다른 클라이언트)가 브라우저를 열지
// 않고도 특정 날짜의 캔들+볼린저밴드+이평선+RSI+MACD 값을 정확히 받아갈 수 있게 하려고 만듦
// (2026-08-01, 30차 - window.getBacktestChartData()는 브라우저 탭이 열려있어야만 쓸 수 있어서
// 그 한계를 없애려고 서버 API로 옮김. loadRange()의 워밍업 방식과 동일 - 같은 심볼의 파일을 전부
// 병합한 뒤 요청 범위만 잘라낸다).

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'
const RSI_PERIOD = 14
const MACD_FAST = 12, MACD_SLOW = 26, MACD_SIGNAL = 9
// MACD5 = 볼린저/이평선과 같은 멀티 타임프레임 치환 규칙(1분봉 기준 기간 × 5), backtest-chart.js와 동일
const MACD5_FAST = 60, MACD5_SLOW = 130, MACD5_SIGNAL = 45

function publicUrl(storagePath) {
  return `${SUPABASE_URL}/storage/v1/object/public/${BUCKET}/${storagePath}`
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'GET만 지원' })

  const { symbol, date, dateFrom, dateTo, upTo, summerTime } = req.query
  const fromStr = dateFrom || date
  const toStr = dateTo || date
  if (!symbol || !fromStr || !toStr) {
    return res.status(400).json({ error: 'symbol, 그리고 date(또는 dateFrom+dateTo)가 필요합니다. 예: ?symbol=NASDAQ&date=2026-06-30' })
  }

  const { data: datasets, error } = await supabase.from('backtest_datasets').select('*').eq('symbol', symbol)
  if (error) return res.status(500).json({ error: error.message })

  const overlapping = (datasets || []).filter(d => d.date_from <= toStr && fromStr <= d.date_to)
  if (overlapping.length === 0) {
    return res.status(404).json({ error: `${symbol}에 ${fromStr}~${toStr} 범위 데이터셋이 없습니다` })
  }

  const offsetSeconds = summerTime === 'false' ? BROKER_OFFSET_SECONDS.winter : BROKER_OFFSET_SECONDS.summer

  let fullRows
  try {
    const mergedByTime = new Map()
    for (const d of overlapping) {
      const r = await fetch(publicUrl(d.storage_path))
      if (!r.ok) throw new Error(`파일을 가져오지 못했습니다: ${d.storage_path} (${r.status})`)
      const csvText = await r.text()
      const { rows } = parseCandleCsv(csvText, offsetSeconds)
      for (const row of rows) mergedByTime.set(row.time, row)
    }
    fullRows = Array.from(mergedByTime.values()).sort((a, b) => a.time - b.time)
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }

  const startIdx = fullRows.findIndex(r => toLocalDateStr(r.time) >= fromStr)
  if (startIdx < 0) return res.status(404).json({ error: '해당 범위에 캔들이 없습니다(주말/휴장일일 수 있음)' })
  let endIdx = startIdx
  while (endIdx < fullRows.length && toLocalDateStr(fullRows[endIdx].time) <= toStr) endIdx++

  // upTo(unix seconds) - 실제 재생 위치를 흉내내서 그 시각까지만 반환(안 주면 그 날짜 범위 전체)
  let sliceEnd = endIdx
  if (upTo) {
    const upToSec = Number(upTo)
    let cut = startIdx
    while (cut < endIdx && fullRows[cut].time <= upToSec) cut++
    sliceEnd = cut
  }

  const closes = fullRows.map(r => r.close)

  const bollingerBands = {}
  for (const band of BOLLINGER_BANDS) {
    const { mids, ups, lows } = rollingBollinger(closes, band.period)
    const upper = [], middle = [], lower = []
    for (let i = startIdx; i < sliceEnd; i++) {
      const t = fullRows[i].time
      if (ups[i] != null) upper.push({ time: t, value: ups[i] })
      if (mids[i] != null) middle.push({ time: t, value: mids[i] })
      if (lows[i] != null) lower.push({ time: t, value: lows[i] })
    }
    bollingerBands[band.id] = { label: band.label, upper, middle, lower }
  }

  const movingAverages = {}
  for (const ma of MOVING_AVERAGES) {
    const vals = computeMA(ma, closes)
    const values = []
    for (let i = startIdx; i < sliceEnd; i++) {
      if (vals[i] != null) values.push({ time: fullRows[i].time, value: vals[i] })
    }
    movingAverages[ma.id] = { label: ma.label, values }
  }

  const rsiVals = rollingRSI(closes, RSI_PERIOD)
  const rsi = []
  for (let i = startIdx; i < sliceEnd; i++) {
    if (rsiVals[i] != null) rsi.push({ time: fullRows[i].time, value: rsiVals[i] })
  }

  function macdSlice(fast, slow, signal) {
    const { macdLine, signalLine, histogram } = rollingMACD(closes, fast, slow, signal)
    const macd = [], sig = [], hist = []
    for (let i = startIdx; i < sliceEnd; i++) {
      const t = fullRows[i].time
      if (macdLine[i] != null) macd.push({ time: t, value: macdLine[i] })
      if (signalLine[i] != null) sig.push({ time: t, value: signalLine[i] })
      if (histogram[i] != null) hist.push({ time: t, value: histogram[i] })
    }
    return { macd, signal: sig, hist }
  }

  return res.status(200).json({
    symbol,
    dateFrom: fromStr,
    dateTo: toStr,
    candleCount: sliceEnd - startIdx,
    candles: fullRows.slice(startIdx, sliceEnd),
    bollingerBands,
    movingAverages,
    rsi,
    macd1: macdSlice(MACD_FAST, MACD_SLOW, MACD_SIGNAL),
    macd5: macdSlice(MACD5_FAST, MACD5_SLOW, MACD5_SIGNAL),
  })
}
