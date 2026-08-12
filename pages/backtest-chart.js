import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, CollapsibleCard, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, DONCHIAN_CHANNELS, rollingDonchian, MOVING_AVERAGES, MADRID_RIBBON, computeMA, rollingRSI, rollingMACD } from '../lib/indicators'

// 이평선 데이터 계산/토글 파이프라인(maDataRef/maSeriesRef/enabledMA 등)은 id로만 구분하므로
// 리본도 같은 파이프라인을 공유한다 - 화면에서만 "리본" 카드로 따로 묶어서 보여준다(사용자 요청).
const ALL_MA = [...MOVING_AVERAGES, ...MADRID_RIBBON]

// 볼린저와 도치안 채널은 상/중/하 3선 구조(bandDataRef/bandSeriesRef/enabledBands 등)를 그대로 공유한다
// - 화면에서만 "볼린저"/"도치안 채널" 카드로 따로 묶어서 보여준다(ALL_MA와 같은 방식, replay.js와 동일).
const ALL_BANDS = [...BOLLINGER_BANDS, ...DONCHIAN_CHANNELS]

// 리본 가장 바깥선(M5-M90) 폭이 "지금까지 관측된 것 중" 가장 크게 벌어진/좁아진 지점에 세로선(사용자
// 요청). lightweight-charts엔 세로선 기본 기능이 없어서 캔버스에 직접 그리는 프리미티브를 새로 만든다
// (v5 attachPrimitive/paneViews 방식). 새로운 최대/최소가 나오면 setTime으로 위치만 옮겨서 다시 그림.
class VerticalLinePrimitive {
  constructor(color) {
    this._time = null
    this._chart = null
    this._requestUpdate = null
    this._color = color
  }
  attached({ chart, requestUpdate }) {
    this._chart = chart
    this._requestUpdate = requestUpdate
  }
  detached() {
    this._chart = null
  }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: (target) => {
          if (this._time == null || !this._chart) return
          const x = this._chart.timeScale().timeToCoordinate(this._time)
          if (x == null) return
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const ratio = scope.horizontalPixelRatio
            const px = Math.round(x * ratio) + 0.5
            ctx.save()
            ctx.strokeStyle = this._color
            ctx.lineWidth = 1
            ctx.setLineDash([4, 3])
            ctx.beginPath()
            ctx.moveTo(px, 0)
            ctx.lineTo(px, scope.bitmapSize.height)
            ctx.stroke()
            ctx.restore()
          })
        },
      }),
    }]
  }
  setTime(time) {
    if (this._time === time) return
    this._time = time
    this._requestUpdate?.()
  }
}
const MAX_SPREAD_LINE_COLOR = '#FFEB3B' // 가장 크게 벌어진 지점(노랑)
const MIN_SPREAD_LINE_COLOR = '#00E5FF' // 가장 좁게 뭉친 지점(하늘)

// 횡보 구간 배경 표시(사용자 요청) - VerticalLinePrimitive와 같은 방식이지만 선 1개가 아니라
// 여러 개의 [from,to] 시간 구간을 옅은 색 사각형으로 캔들 뒤에 채운다(zOrder: 'bottom').
class BackgroundBandsPrimitive {
  constructor(fillStyle) {
    this._ranges = [] // [{from, to}] (unix seconds)
    this._chart = null
    this._requestUpdate = null
    this._fillStyle = fillStyle
  }
  attached({ chart, requestUpdate }) {
    this._chart = chart
    this._requestUpdate = requestUpdate
  }
  detached() {
    this._chart = null
  }
  updateAllViews() {}
  paneViews() {
    return [{
      zOrder: () => 'bottom',
      renderer: () => ({
        draw: (target) => {
          if (!this._chart || !this._ranges.length) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const ratio = scope.horizontalPixelRatio
            const width = scope.bitmapSize.width
            const height = scope.bitmapSize.height
            ctx.save()
            ctx.fillStyle = this._fillStyle
            for (const r of this._ranges) {
              let x1 = ts.timeToCoordinate(r.from)
              let x2 = ts.timeToCoordinate(r.to)
              if (x1 == null && x2 == null) continue
              if (x1 == null) x1 = 0
              if (x2 == null) x2 = width / ratio
              const left = Math.max(0, Math.min(x1, x2) * ratio)
              const right = Math.min(width, Math.max(x1, x2) * ratio)
              if (right <= left) continue
              ctx.fillRect(left, 0, right - left, height)
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
  setRanges(ranges) {
    this._ranges = ranges
    this._requestUpdate?.()
  }
  setFillStyle(fillStyle) {
    this._fillStyle = fillStyle
    this._requestUpdate?.()
  }
}
const SIDEWAYS_BAND_COLOR = '#FFEB3B' // 횡보 구간 배경 기본색(옅은 노랑) - 알파는 적용할 때 따로 낮춤

// 세션 표시 전용(사용자 요청) - 차트 전체 높이를 채우는 BackgroundBandsPrimitive와 달리, 그 세션
// 동안의 실제 고가/저가에 맞춰 점선 테두리 사각형만 그린다(안은 채우지 않음).
class SessionBoxesPrimitive {
  constructor(hexColor, fillAlpha, borderWidth = 1, borderAlpha = 1) {
    this._boxes = [] // [{fromIndex, toIndex, high, low}] - 시각(time) 대신 캔들 순번(logical index) 기준.
    // time 기준으로 좌표를 구하면 아직 화면에 안 그려진(재생 안 된) 캔들 시각은 timeToCoordinate가
    // null을 반환해서 좌표를 못 구하는데, logicalToCoordinate는 데이터가 실제로 그려졌는지와
    // 무관하게 순번만으로 위치를 계산해줘서 항상 정확한 자리에 그려진다.
    this._chart = null
    this._series = null
    this._requestUpdate = null
    this._hexColor = hexColor       // 테두리 + 채우기 둘 다의 기본 색
    this._fillAlpha = fillAlpha     // 안쪽 채우기 투명도("선"이 아니라 "채우기"에 적용)
    this._borderWidth = borderWidth // 테두리 두께(px) - 세션 3개 공통
    this._borderAlpha = borderAlpha // 테두리 투명도 - 세션 3개 공통
  }
  attached({ chart, series, requestUpdate }) {
    this._chart = chart
    this._series = series
    this._requestUpdate = requestUpdate
  }
  detached() {
    this._chart = null
    this._series = null
  }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: (target) => {
          if (!this._chart || !this._series || !this._boxes.length) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const hRatio = scope.horizontalPixelRatio
            const vRatio = scope.verticalPixelRatio
            ctx.save()
            ctx.strokeStyle = hexToRgba(this._hexColor, this._borderAlpha)
            ctx.fillStyle = hexToRgba(this._hexColor, this._fillAlpha)
            ctx.lineWidth = this._borderWidth
            ctx.setLineDash([4, 3])
            for (const b of this._boxes) {
              const x1 = ts.logicalToCoordinate(b.fromIndex)
              const x2 = ts.logicalToCoordinate(b.toIndex)
              if (x1 == null || x2 == null) continue
              const yHigh = this._series.priceToCoordinate(b.high)
              const yLow = this._series.priceToCoordinate(b.low)
              if (yHigh == null || yLow == null) continue
              const left = Math.min(x1, x2) * hRatio
              const right = Math.max(x1, x2) * hRatio
              const top = Math.min(yHigh, yLow) * vRatio
              const bottom = Math.max(yHigh, yLow) * vRatio
              const w = Math.max(1, right - left), h = Math.max(1, bottom - top)
              ctx.fillRect(left, top, w, h)
              ctx.strokeRect(left, top, w, h)
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
  setBoxes(boxes) {
    this._boxes = boxes
    this._requestUpdate?.()
  }
  setColor(hexColor) {
    this._hexColor = hexColor
    this._requestUpdate?.()
  }
  setFillAlpha(alpha) {
    this._fillAlpha = alpha
    this._requestUpdate?.()
  }
  setBorderWidth(width) {
    this._borderWidth = width
    this._requestUpdate?.()
  }
  setBorderAlpha(alpha) {
    this._borderAlpha = alpha
    this._requestUpdate?.()
  }
}

// 라벨링(📍 라벨링) 마커 - lightweight-charts 기본 markers API(aboveBar/belowBar/inBar)는 캔들
// 위/아래 고정 위치에만 붙일 수 있어서, 클릭하거나 마우스를 올린 정확한 가격(십자선 세로 위치)에
// 못 찍는 문제가 있었다(사용자 지적). 세션박스와 같은 방식으로 직접 캔버스에 그려서 (time, price)
// 정확한 좌표에 도형+텍스트를 찍는다.
class AnnotationMarkersPrimitive {
  constructor() {
    this._markers = [] // [{time, price, color, shape, text}]
    this._chart = null
    this._series = null
    this._requestUpdate = null
  }
  attached({ chart, series, requestUpdate }) {
    this._chart = chart
    this._series = series
    this._requestUpdate = requestUpdate
  }
  detached() {
    this._chart = null
    this._series = null
  }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: (target) => {
          if (!this._chart || !this._series || !this._markers.length) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const hRatio = scope.horizontalPixelRatio
            const vRatio = scope.verticalPixelRatio
            ctx.save()
            const r = 6 * hRatio
            for (const m of this._markers) {
              const x = ts.timeToCoordinate(m.time)
              const y = this._series.priceToCoordinate(m.price)
              if (x == null || y == null) continue
              const px = x * hRatio, py = y * vRatio + (m.offset || 0) * vRatio
              ctx.fillStyle = m.color
              ctx.strokeStyle = m.color
              if (m.shape === 'arrowUp') {
                ctx.beginPath()
                ctx.moveTo(px, py - r); ctx.lineTo(px - r, py + r); ctx.lineTo(px + r, py + r)
                ctx.closePath(); ctx.fill()
              } else if (m.shape === 'arrowDown') {
                ctx.beginPath()
                ctx.moveTo(px, py + r); ctx.lineTo(px - r, py - r); ctx.lineTo(px + r, py - r)
                ctx.closePath(); ctx.fill()
              } else if (m.shape === 'square') {
                ctx.fillRect(px - r, py - r, r * 2, r * 2)
              } else {
                ctx.beginPath(); ctx.arc(px, py, r, 0, Math.PI * 2); ctx.fill()
              }
              if (m.text) {
                ctx.font = `${Math.round(11 * vRatio)}px -apple-system, "Segoe UI", "Malgun Gothic", sans-serif`
                ctx.textAlign = 'center'
                const below = m.shape === 'arrowDown'
                ctx.textBaseline = below ? 'top' : 'bottom'
                ctx.fillText(m.text, px, below ? py + r + 3 * vRatio : py - r - 3 * vRatio)
              }
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
  setMarkers(markers) {
    this._markers = markers
    this._requestUpdate?.()
  }
}

// 세션 표시(사용자가 공유한 Pine 스크립트에서 세션 부분만 분리, 사용자 요청) - 시작/종료 시각은
// 한국시간(KST) 기준이고, 이 차트의 시간 라벨이 이미 KST와 동일(SESSION_OPENS 주석 참고)이라
// 그대로 쓴다. endHour <= startHour면 자정을 넘어가는 세션(뉴욕: 21시~다음날 5시).
const SESSIONS = [
  { id: 'asia', label: '아시아', color: '#FFEB3B', startHour: 7, endHour: 16 },
  { id: 'europe', label: '유럽', color: '#2196F3', startHour: 16, endHour: 24 },
  { id: 'newyork', label: '뉴욕', color: '#F44336', startHour: 21, endHour: 5 },
]
function hourInSession(hourOfDay, startHour, endHour) {
  if (endHour <= startHour) return hourOfDay >= startHour || hourOfDay < endHour
  return hourOfDay >= startHour && hourOfDay < endHour
}
// rows(캔들 배열)에서 [startHour,endHour) 시간대(KST)에 해당하는 연속 구간을 전부 찾는다 -
// 초기 로드 시점과, 사용자가 시간을 나중에 바꿨을 때 재계산할 때 둘 다 씀.
function findSessionSegmentsIn(rows, startHour, endHour) {
  const segs = []
  let segStart = null
  for (let i = 0; i < rows.length; i++) {
    // getUTCHours가 아니라 getHours(로컬 시간대)를 쓴다 - 차트 시간축 라벨(localTickMarkFormatter)이
    // getHours()로 그려지므로, 세션 판정도 같은 기준이어야 화면에 보이는 시각과 어긋나지 않는다.
    const hourOfDay = new Date(rows[i].time * 1000).getHours()
    const inSession = hourInSession(hourOfDay, startHour, endHour)
    if (inSession && segStart == null) segStart = i
    if (!inSession && segStart != null) { segs.push({ startIdx: segStart, endIdx: i - 1 }); segStart = null }
  }
  if (segStart != null) segs.push({ startIdx: segStart, endIdx: rows.length - 1 })
  return segs.map(seg => {
    let high = -Infinity, low = Infinity
    for (let i = seg.startIdx; i <= seg.endIdx; i++) {
      if (rows[i].high > high) high = rows[i].high
      if (rows[i].low < low) low = rows[i].low
    }
    return { ...seg, startTime: rows[seg.startIdx].time, endTime: rows[seg.endIdx].time, high, low }
  })
}

// 리본 전용 - 오를 땐 라임/내릴 땐 레드로(Madrid 원본 색, 사용자 요청 "트레이딩뷰처럼").
// lightweight-charts는 선 하나 안에서 구간별 색을 못 바꾸므로, 예전엔 상승/하락 구간을 시리즈
// 2개(라임/레드)로 쪼개서 겹쳐 그리는 방식을 썼는데 - 방향이 짧은 간격으로 자주 바뀌는 구간(예:
// 봉우리 근처에서 위아래로 몇 번 꺾이는 곳)에서 경계점 중복 처리가 두 시리즈 모두에 겹쳐 들어가며
// "선이 2개로 보인다"는 증상을 만들었음(사용자 지적, 여러 번 시도해도 완전히 못 없앰).
// 근본적으로 다른 방식으로 교체 - 캔들 한 칸(i-1→i)마다 그 구간만의 방향 색으로 캔버스에 직접
// 선분을 그리는 프리미티브. 시리즈를 여러 개 겹치는 게 아니라 매번 정확히 "선분 1개"만 그리므로
// 구조적으로 이중선이 생길 수 없다.
const RIBBON_LIME = '#00FF00'
const RIBBON_RED = '#FF0000'
// DUAL_COLOR_IDS 중 "원래 단색이 있던" 것들의 상승/하락 기본 색상 - maUpColors/maDownColors에
// 커스텀 값이 없을 때 RIBBON_LIME/RIBBON_RED 대신 여기서 먼저 찾는다(getDualUpColor/getDualDownColor).
// 3분H(#00D5FF)/5분H(#FF9800, 원래 단색이던 오렌지)는 사용자 지정, W(wma) 3개는 "색은 원래대로,
// 구조만 dual"이라는 요청이라 상승/하락 둘 다 원래 단색 그대로 넣어둠.
const DUAL_DEFAULT_UP_COLOR = { hma60: '#00D5FF', hma100: '#FF9800', wma17_1m: '#2196F3', wma17_5m: '#4FC3F7', wma4_1h: '#FFEB3B' }
const DUAL_DEFAULT_DOWN_COLOR = { wma17_1m: '#2196F3', wma17_5m: '#4FC3F7', wma4_1h: '#FFEB3B' }
// 리본 18개 + "3분/5분/15분/1시간 H"(hma60/hma100/hma300/hma1200, 사용자 요청) - 이 id들은 단색 대신
// 상승/하락 두 색으로 동적 렌더링한다.
const DUAL_COLOR_IDS = new Set([...MADRID_RIBBON.map(m => m.id), 'hma60', 'hma100', 'hma300', 'hma1200', 'wma17_1m', 'wma17_5m', 'wma4_1h'])
const isDualColor = (maId) => DUAL_COLOR_IDS.has(maId)
const RIBBON_IDS = new Set(MADRID_RIBBON.map(m => m.id))
const isRibbonId = (maId) => RIBBON_IDS.has(maId)
// hex(#RRGGBB) -> rgba(r,g,b,alpha) 문자열
function hexToRgba(hex, alpha) {
  const h = (hex || '#000000').replace('#', '')
  const r = parseInt(h.substring(0, 2), 16)
  const g = parseInt(h.substring(2, 4), 16)
  const b = parseInt(h.substring(4, 6), 16)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}
// points는 로드된 구간 전체와 같은 길이의 배열, 인덱스 i가 캔들 i번째에 대응(값 없으면 null) -
// bandDataRef/maDataRef가 쓰는 것과 동일한 인덱싱. logicalToCoordinate(i)로 좌표를 구해서
// (SessionBoxesPrimitive와 같은 이유 - 아직 재생 안 된 시각도 timeToCoordinate보다 안전) i-1→i
// 구간마다 상승/하락 색으로 선분 하나씩 그린다.
// lineStyle: lightweight-charts LineStyle 값 그대로(0=실선, 1=점(dot), 2=대시, 3=긴대시, 4=성긴점).
// 점(dot)은 대시 배열을 [두께, 간격]으로 아주 짧게 주고 lineCap을 round로 해서 각 조각이 동그란
// 점처럼 보이게 만드는 흔한 캔버스 트릭 - lightweight-charts 내장 Dotted 스타일과 같은 방식.
function dashPatternForStyle(lineStyle, lineWidth, hRatio) {
  const w = lineWidth * hRatio
  if (lineStyle === 1) return [w, w * 2]           // 점(dot)
  if (lineStyle === 2) return [6 * hRatio, 4 * hRatio] // 대시
  if (lineStyle === 3) return [12 * hRatio, 6 * hRatio] // 긴 대시
  if (lineStyle === 4) return [w, w * 4]           // 성긴 점
  return [] // 0 = 실선
}
class DualColorLinePrimitive {
  constructor(upHex, downHex, alpha, lineWidth, lineStyle) {
    this._points = []
    this._chart = null
    this._series = null
    this._requestUpdate = null
    this._upHex = upHex
    this._downHex = downHex
    this._alpha = alpha
    this._lineWidth = lineWidth
    this._lineStyle = lineStyle
  }
  attached({ chart, series, requestUpdate }) {
    this._chart = chart
    this._series = series
    this._requestUpdate = requestUpdate
  }
  detached() {
    this._chart = null
    this._series = null
  }
  updateAllViews() {}
  paneViews() {
    return [{
      renderer: () => ({
        draw: (target) => {
          if (!this._chart || !this._series || this._points.length < 2) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const hRatio = scope.horizontalPixelRatio
            const vRatio = scope.verticalPixelRatio
            ctx.save()
            ctx.lineWidth = this._lineWidth
            ctx.lineJoin = 'round'
            ctx.lineCap = 'round'
            ctx.setLineDash(dashPatternForStyle(this._lineStyle, this._lineWidth, hRatio))
            // 캔들 하나짜리 구간마다 매번 beginPath+stroke를 하면 캔버스가 매 stroke마다 점선/대시
            // 패턴의 위상(phase)을 처음(=항상 "선 있음"부터)부터 다시 시작해버려서, 구간 폭이 패턴
            // 주기보다 좁으면 사실상 항상 실선처럼 보인다(점선/대시 구분이 안 되는 버그의 원인이었음).
            // 그래서 같은 색이 이어지는 동안은 path를 안 끊고 lineTo만 계속 이어붙여서 그 구간 전체를
            // 한 번의 stroke로 그린다 - 그래야 점/대시 패턴이 구간 전체에 걸쳐 자연스럽게 이어진다.
            let curColor = null
            let pathOpen = false
            const flush = () => { if (pathOpen) { ctx.stroke(); pathOpen = false } }
            for (let i = 1; i < this._points.length; i++) {
              const p0 = this._points[i - 1], p1 = this._points[i]
              if (p0 == null || p1 == null) { flush(); curColor = null; continue }
              const x0 = ts.logicalToCoordinate(i - 1)
              const x1 = ts.logicalToCoordinate(i)
              if (x0 == null || x1 == null) { flush(); curColor = null; continue }
              const y0 = this._series.priceToCoordinate(p0)
              const y1 = this._series.priceToCoordinate(p1)
              if (y0 == null || y1 == null) { flush(); curColor = null; continue }
              const color = p1 >= p0 ? this._upHex : this._downHex
              if (color !== curColor) {
                flush()
                ctx.strokeStyle = hexToRgba(color, this._alpha)
                ctx.beginPath()
                ctx.moveTo(x0 * hRatio, y0 * vRatio)
                curColor = color
                pathOpen = true
              }
              ctx.lineTo(x1 * hRatio, y1 * vRatio)
            }
            flush()
            ctx.restore()
          })
        },
      }),
    }]
  }
  setPoints(values) { // values: 인덱스 정렬된 순수 숫자(또는 null) 배열 - {time,value} 객체 아님
    this._points = values
    this._requestUpdate?.()
  }
  setUpColor(hex) { this._upHex = hex; this._requestUpdate?.() }
  setDownColor(hex) { this._downHex = hex; this._requestUpdate?.() }
  setAlpha(alpha) { this._alpha = alpha; this._requestUpdate?.() }
  setLineWidth(width) { this._lineWidth = width; this._requestUpdate?.() }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
// x1 = 실제 1분봉 그대로(캔들 1개 = 60초). 다른 배속은 전부 이 기준의 배수.
const SPEEDS = [1, 2, 3, 5, 20, 60, 100, 200, 300, 500, 600, 1000]
const REALTIME_MS = 60000
const MIN_TICK_MS = 50 // setInterval 실질 하한 - 이보다 짧은 간격은 한 틱에 여러 캔들을 진행시켜 흉내낸다
const PLAYBACK_VIEW_BARS = 150 // 재생 중 화면에 보여주는 캔들 개수(카메라 폭) - ⚙ 셋팅으로 이미 다 그려진 차트 위를 이 폭만큼씩 스크롤한다
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
const EMPTY_PAIR_SLOTS = [{ a: '', b: '' }, { a: '', b: '' }, { a: '', b: '' }]
// 라벨링(학습용 수동 마킹) - 재생 위치의 캔들에 사용자가 직접 찍는 마커. 매매 포지션과 무관하게
// 화면 표시 + DB 저장(학습 데이터화)만을 목적으로 한다.
const ANNOTATION_STYLES = {
  entry_long: { position: 'belowBar', color: '#26a69a', shape: 'arrowUp', text: '진입롱' },
  entry_short: { position: 'aboveBar', color: '#ef5350', shape: 'arrowDown', text: '진입숏' },
  exit: { position: 'inBar', color: '#e8eaed', shape: 'square', text: '청산' },
  sideways_start: { position: 'aboveBar', color: '#FFEB3B', shape: 'circle', text: '횡보시작' },
  sideways_end: { position: 'aboveBar', color: '#FFEB3B', shape: 'circle', text: '횡보끝' },
  trend_start: { position: 'belowBar', color: '#4FC3F7', shape: 'circle', text: '추세시작' },
  trend_end: { position: 'belowBar', color: '#4FC3F7', shape: 'circle', text: '추세끝' },
  // 진입롱/진입숏과 동시에 정확히 같은 가격(price)에 자동으로 같이 찍는 손절 마커(사용자 요청).
  // 마커가 이제 정확한 가격에 그려지다 보니 진입과 완전히 같은 자리에 겹쳐버려서, 데이터(price)는
  // 그대로 두고 화면에 그릴 때만 세로로 살짝(offset, px) 띄워서 둘 다 보이게 한다.
  stop_loss_long: { color: '#FF9800', shape: 'square', text: '손절', offset: -20 },
  stop_loss_short: { color: '#FF9800', shape: 'square', text: '손절', offset: 20 },
}
const ANNOTATION_BUTTONS = [
  ['entry_long', '진입롱'], ['entry_short', '진입숏'],
  ['sideways_start', '횡보시작'], ['sideways_end', '횡보끝'],
  ['trend_start', '추세시작'], ['trend_end', '추세끝'],
  ['exit', '청산'],
]

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
// 지표/색상/굵기/모양 등 "차트 표시 설정" 전체는 localStorage에 저장(사용자 요청) - 새로고침은 물론
// 브라우저를 완전히 닫았다 열어도 유지된다(위 BACKTEST_STATE_KEY는 심볼/날짜/재생위치 같은 "지금 뭘
// 보고 있었는지" 세션 복귀용이라 성격이 달라서 별도 키로 분리 유지).
const CHART_SETTINGS_KEY = 'backtestChartSettings'
// 라벨링(📍 라벨링) 구간 스냅샷 모음 - 서버로 바로 안 보내고 여기에 이름 붙여 쌓아뒀다가 한 번에 다운로드
const COLLECTED_ANNOTATIONS_KEY = 'chartAnnotationsCollected'

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
  // 표시 설정 복원(localStorage) - 마찬가지로 렌더 중 한 번만 읽는다. 없는 키는 각 useState의
  // 기본값(뒤의 ?? 오른쪽)이 그대로 쓰인다.
  const settingsRestoreRef = useRef(undefined)
  if (settingsRestoreRef.current === undefined) {
    settingsRestoreRef.current = null
    if (typeof window !== 'undefined') {
      try {
        const raw = window.localStorage.getItem(CHART_SETTINGS_KEY)
        if (raw) settingsRestoreRef.current = JSON.parse(raw)
      } catch { /* 저장된 값이 깨져있으면 무시하고 기본값으로 시작 */ }
    }
  }
  const rs = settingsRestoreRef.current || {}
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
  // (아래 전부 rs.필드명 ?? 기본값 형태 - localStorage에 저장된 값이 있으면 그걸로 시작, 없으면 기존 기본값)
  const [enabledBands, setEnabledBands] = useState(rs.enabledBands ?? { sma20: true, sma100: true, sma300: true, sma1200: true })
  const [lineVisibility, setLineVisibility] = useState(rs.lineVisibility ?? {}) // `${bandId}:${upper|middle|lower}` -> false면 숨김 (기본 true, 1분B 상/하도 기본 켜짐 - 사용자 요청)
  const [bandColors, setBandColors] = useState(rs.bandColors ?? {}) // bandId -> 커스텀 색상 (없으면 BOLLINGER_BANDS 기본색)
  // 기본 셋팅 - 3분/5분/15분 H, 1분/5분 W17, 1시간 W4 이평선 체크
  const [enabledMA, setEnabledMA] = useState(rs.enabledMA ?? {
    hma60: true, hma100: true, hma300: true, wma17_1m: true, wma17_5m: true, wma4_1h: true,
    ...Object.fromEntries(MADRID_RIBBON.map(m => [m.id, true])), // 리본 기본 체크(사용자 요청)
  })
  const [maColors, setMaColors] = useState(rs.maColors ?? {}) // maId -> 커스텀 색상 (없으면 MOVING_AVERAGES 기본색, 볼린저와 동일)
  // 기본 셋팅 - 위 6개 이평선 전부 두께 3
  const [maWidths, setMaWidths] = useState(rs.maWidths ?? { hma60: 3, hma100: 3, hma300: 3, wma17_1m: 3, wma17_5m: 3, wma4_1h: 3 }) // maId -> 커스텀 선 굵기 (없으면 MOVING_AVERAGES 기본 lineWidth)
  // 리본(Madrid) - MACD처럼 체크박스 하나가 켜고 끄는 세트(사용자 요청).
  const [ribbonEnabled, setRibbonEnabledState] = useState(rs.ribbonEnabled ?? true) // 기본 체크(사용자 요청)
  const [ribbonOpacity, setRibbonOpacityState] = useState(rs.ribbonOpacity ?? 0.2) // 리본 18개 선 전용 투명도(0~1, 기본 20%, 사용자 요청) - hma3는 영향 없음
  // 횡보 구간 배경 표시(사용자 요청) - 5분B 폭 & 리본 폭이 둘 다 로드된 구간 하위25%일 때 배경을 옅게 칠함
  const [sidewaysEnabled, setSidewaysEnabledState] = useState(rs.sidewaysEnabled ?? false)
  const [sidewaysColor, setSidewaysColorState] = useState(rs.sidewaysColor ?? SIDEWAYS_BAND_COLOR)
  // 세션 표시(아시아/유럽/뉴욕) - 세션마다 독립적으로 켜고 끄고 색상 지정(사용자 요청)
  const [sessionEnabled, setSessionEnabledState] = useState(rs.sessionEnabled ?? {})
  const [sessionColors, setSessionColorsState] = useState(rs.sessionColors ?? Object.fromEntries(SESSIONS.map(s => [s.id, s.color])))
  const [sessionHours, setSessionHoursState] = useState(rs.sessionHours ?? Object.fromEntries(SESSIONS.map(s => [s.id, { start: s.startHour, end: s.endHour }]))) // 세션마다 독립 (사용자 요청)
  const [sessionOpacity, setSessionOpacityState] = useState(rs.sessionOpacity ?? 0.15) // 세션 3개 공통 투명도(사용자 요청 - 색은 따로, 투명도는 같이)
  // 테두리 두께/투명도도 채우기 투명도와 같은 방식(세션 3개 공통) - 기본은 두께1/불투명(기존과 동일 외관)
  const [sessionBorderWidth, setSessionBorderWidthState] = useState(rs.sessionBorderWidth ?? 1)
  const [sessionBorderOpacity, setSessionBorderOpacityState] = useState(rs.sessionBorderOpacity ?? 1)
  // DUAL_COLOR_IDS(리본 18개 + hma60/hma100/hma300/W3개)의 상승/하락 색 - maId -> 커스텀 색.
  // 기본값은 여기 useState 초기값이 아니라 DUAL_DEFAULT_UP_COLOR/DOWN_COLOR(모듈 상수, getDualUpColor/
  // getDualDownColor에서 조회)에 둔다 - localStorage에 예전 세션에서 저장해둔 maUpColors/maDownColors가
  // 있으면 그 객체가 통째로 복원되면서(스프레드가 아니라 rs.maUpColors ?? {...} 형태라) 여기서 새로
  // 추가한 키가 씹혀버리는 버그가 있었음(5분H 오렌지/W3개 원래색이 리본 기본색인 라임/레드로 바뀌어
  // 보였음 - 사용자 지적). 기본값을 읽기 시점 조회로 옮기면 이 문제가 구조적으로 안 생긴다.
  const [maUpColors, setMaUpColors] = useState(rs.maUpColors ?? {})
  const [maDownColors, setMaDownColors] = useState(rs.maDownColors ?? {})
  // RSI/MACD - 기간은 표준값(14 / 12,26,9)으로 고정, 색상만 커스터마이징 가능. 기본은 꺼짐(체크해야 나옴)
  const [enabledRSI, setEnabledRSI] = useState(rs.enabledRSI ?? false)
  const [rsiColor, setRsiColorState] = useState(rs.rsiColor ?? DEFAULT_RSI_COLOR)
  const [enabledMACD, setEnabledMACD] = useState(rs.enabledMACD ?? false)
  const [macdLineColor, setMacdLineColorState] = useState(rs.macdLineColor ?? DEFAULT_MACD_LINE_COLOR)
  const [macdSignalColor, setMacdSignalColorState] = useState(rs.macdSignalColor ?? DEFAULT_MACD_SIGNAL_COLOR)
  const [enabledMACD5, setEnabledMACD5] = useState(rs.enabledMACD5 ?? false)
  const [macd5LineColor, setMacd5LineColorState] = useState(rs.macd5LineColor ?? DEFAULT_MACD5_LINE_COLOR)
  const [macd5SignalColor, setMacd5SignalColorState] = useState(rs.macd5SignalColor ?? DEFAULT_MACD5_SIGNAL_COLOR)
  const [upColor, setUpColorState] = useState(rs.upColor ?? DEFAULT_UP_COLOR)
  const [downColor, setDownColorState] = useState(rs.downColor ?? DEFAULT_DOWN_COLOR)
  const [candleVisible, setCandleVisible] = useState(() => rs.candleVisible ?? restoreRef.current?.candleVisible ?? true) // 체크 해제하면 캔들을 숨김(지표만 보고 판단 연습할 때 씀) - 기본 체크됨
  // 왼쪽 "크로스/더블비/눌림 신호" 표시 - 예전엔 체크박스를 여러 개 켜면 그 안에서 가능한 모든 조합을
  // 자동으로 판정했는데(체크 3개면 3쌍이 전부 감지되는 식으로 통제가 안 됨), 각각 1/2/3 슬롯으로 나눠
  // 슬롯마다 정확히 2개(드롭다운)만 골라 그 조합만 보게 바꿈(사용자 요청) - 크로스/더블비/눌림 전부 동일 방식,
  // 반자동(auto)/시뮬레이션(sim)도 같은 방식으로 통일함.
  const [crossPairs, setCrossPairs] = useState(rs.crossPairs ?? EMPTY_PAIR_SLOTS)
  // 골든크로스(단기선이 장기선을 아래에서 위로 돌파)/데드크로스(그 반대) 표시를 따로 설정
  const [goldenShape, setGoldenShapeState] = useState(rs.goldenShape ?? 'arrowUp')
  const [goldenColor, setGoldenColorState] = useState(rs.goldenColor ?? DEFAULT_GOLDEN_COLOR)
  const [goldenSize, setGoldenSizeState] = useState(rs.goldenSize ?? 3) // 기본 셋팅(사용자 요청) - 크로스 신호 크기 3번
  const [deadShape, setDeadShapeState] = useState(rs.deadShape ?? 'arrowDown')
  const [deadColor, setDeadColorState] = useState(rs.deadColor ?? DEFAULT_DEAD_COLOR)
  const [deadSize, setDeadSizeState] = useState(rs.deadSize ?? 3) // 기본 셋팅(사용자 요청) - 크로스 신호 크기 3번
  // 매매 연습 - 헤징 허용(바이/셀 동시 보유 가능), 수수료/스프레드는 계산 안 함
  const [startingBalance, setStartingBalanceState] = useState(rs.startingBalance ?? DEFAULT_STARTING_BALANCE)
  const [balance, setBalance] = useState(DEFAULT_STARTING_BALANCE)
  const [lotSize, setLotSize] = useState(rs.lotSize ?? 0.01)
  const [positions, setPositions] = useState([]) // { id, side:'buy'|'sell', symbol, lot, entryPrice, entryTime }
  const [pnlDisplay, setPnlDisplay] = useState(rs.pnlDisplay ?? 'dollar') // 'dollar' | 'point'
  // 반자동진입 - 왼쪽 표시(crossPairs 슬롯)와 켜고 끄는 슬롯 상태는 따로 관리한다(화면엔 여러 개
  // 띄워두고 그중 일부만 실전 진입 조건으로 쓸 수 있게). 계산 로직(findMACrossForPair)은 공유하므로,
  // 왼쪽과 여기에 같은 조합을 골라두면 마커 표시 캔들 = 실제 진입 캔들이 항상 일치한다.
  const [semiAutoEnabled, setSemiAutoEnabled] = useState(rs.semiAutoEnabled ?? false)
  const [autoCrossPairs, setAutoCrossPairsState] = useState(rs.autoCrossPairs ?? EMPTY_PAIR_SLOTS)

  // 시뮬레이션 - 반자동과 조건 구성은 완전히 동일하되, 켜고 끄는 체크 상태와 트리거 타임라인은 독립적이라
  // 반자동과 시뮬레이션을 동시에 켜두고 서로 다른 조건 조합을 비교해볼 수 있다
  const [simulationEnabled, setSimulationEnabled] = useState(rs.simulationEnabled ?? false)
  const [simCrossPairs, setSimCrossPairsState] = useState(rs.simCrossPairs ?? EMPTY_PAIR_SLOTS)
  // 시뮬레이션 결과 저장 - 청산된 거래를 여기 쌓아뒀다가 "결과 저장" 누르면 한 번에 DB로 보낸다.
  // (Claude가 나중에 MCP run_sql로 simulation_results 테이블을 조회해서 분석해줄 수 있게 하는 용도 -
  // 사이트 화면 어디에도 노출 안 되는, 세션에서만 쓰는 백엔드 기록)
  const [closedTradesCount, setClosedTradesCount] = useState(0)
  const [savingResults, setSavingResults] = useState(false)
  // 라벨링(학습용 마킹) - { id, type, idx, time, price } 목록. 매매(positions)와는 완전히 별개.
  const [annotations, setAnnotations] = useState([])
  const [snapshotName, setSnapshotName] = useState('') // 지금 구간에 붙일 이름(담기 전 입력)
  const [collectedAnnotations, setCollectedAnnotations] = useState(() => {
    if (typeof window === 'undefined') return []
    try {
      const raw = window.localStorage.getItem(COLLECTED_ANNOTATIONS_KEY)
      return raw ? JSON.parse(raw) : []
    } catch { return [] }
  })
  // 차트를 마우스로 클릭했을 때 뜨는 라벨 선택 팝업 - { idx, x, y } | null (x/y는 차트 컨테이너 기준 좌표)
  const [clickPopup, setClickPopup] = useState(null)

  const containerRef = useRef(null)
  const chartRef = useRef(null)
  const seriesRef = useRef(null)
  const markerSeriesRef = useRef(null) // 투명 라인 시리즈 - 마커 전용. 다른 라인이 새로 추가될 때마다 지웠다 다시 만들어서 항상 맨 위(가장 나중에 추가된 시리즈)에 오게 함
  const markersPrimitiveRef = useRef(null) // v5: series.setMarkers() 대신 createSeriesMarkers(series, markers)가 반환하는 primitive를 씀
  // 리본 외곽선(M5-M90) 폭이 "확정된" 국소 고점/저점 중 지금까지 최댓값/최솟값일 때만 세로선 위치를 옮김(방식 B, 사용자 요청)
  const maxSpreadLineRef = useRef(null)   // VerticalLinePrimitive 인스턴스(노랑, 발산 최대)
  const minSpreadLineRef = useRef(null)   // VerticalLinePrimitive 인스턴스(하늘, 수축 최소)
  const maxSpreadRef = useRef({ time: null, value: -Infinity })
  const minSpreadRef = useRef({ time: null, value: Infinity })
  const swingStateRef = useRef({ prevSpread: null, direction: null, legExtreme: null }) // 지그재그 스윙 탐지용 진행 상태
  const sidewaysBandRef = useRef(null)       // BackgroundBandsPrimitive 인스턴스
  const sidewaysSegmentsRef = useRef([])     // 로드된 구간 전체에서 미리 찾아둔 횡보 구간 [{startIdx,endIdx,startTime,endTime}]
  const sessionBandRefs = useRef({})         // sessionId -> BackgroundBandsPrimitive 인스턴스
  const annotationPrimitiveRef = useRef(null) // AnnotationMarkersPrimitive 인스턴스 - 라벨링 마커를 정확한 가격 위치에 그림
  const sessionSegmentsRef = useRef({})      // sessionId -> [{startIdx,endIdx,startTime,endTime}]
  const rowsRef = useRef([])
  const intervalRef = useRef(null)
  const indexRef = useRef(0)
  const datasetCacheRef = useRef({}) // dataset.id -> 파싱된 전체 rows (CSV 재요청 방지용)
  const bandDataRef = useRef({})     // bandId -> { upper, middle, lower } - 선택한 날짜분, 워밍업 포함해서 계산됨
  const bandSeriesRef = useRef({})   // bandId -> { upper, middle, lower } lightweight-charts 라인 시리즈
  const maDataRef = useRef({})       // maId -> [{time,value}|null] - 선택한 날짜분, 워밍업 포함해서 계산됨
  const maSeriesRef = useRef({})     // maId -> lightweight-charts 라인 시리즈 (밴드와 달리 선 1개) - 단색(DUAL_COLOR_IDS 아닌) 것만
  const maDualPrimitiveRef = useRef({}) // maId -> DualColorLinePrimitive 인스턴스 (DUAL_COLOR_IDS 전용, 리본18+hma60)
  const rsiDataRef = useRef([])      // [{time,value}|null] - 선택한 날짜분
  const rsiSeriesRef = useRef(null)
  const macdDataRef = useRef({ macd: [], signal: [], hist: [] }) // 각각 [{time,value}|null]
  const macdSeriesRef = useRef(null) // { macd, signal, hist } lightweight-charts 시리즈 3개
  const macd5DataRef = useRef({ macd: [], signal: [], hist: [] })
  const macd5SeriesRef = useRef(null)
  const crossPointsRef = useRef([])  // 체크한 이평선끼리 교차하는 지점 전체 [{idx, time, type:'golden'|'dead'}]
  const autoEventsRef = useRef([])   // 반자동진입 트리거 전체 [{idx, time, side:'buy'|'sell', source}]
  const simEventsRef = useRef([])    // 시뮬레이션 트리거 전체 (반자동과 동일한 구조, 별도 타임라인)
  const sessionPointsRef = useRef([]) // 세계 3대 시장 개장 시각 표시용 [{idx, time, label, color}] - 매매 신호가 아니라 항상 표시하는 고정 참고선
  const annotationsRef = useRef([]) // annotations state의 최신값 거울(재생 루프/applyAllMarkers가 클로저 stale 없이 읽기 위함)
  const hoveredIdxRef = useRef(null) // 크로스헤어가 지금 가리키는 캔들 인덱스(라벨링 위치) - 차트 밖이면 null(그때는 재생 위치를 씀)
  const hoveredPriceRef = useRef(null) // 크로스헤어의 정확한 세로 위치(가격) - 라벨 마커를 여기 그대로 찍는다
  const pendingStopLossIdRef = useRef(null) // 진입과 같이 자동으로 찍은 손절 마커의 id - 청산을 찍으면 이걸 같이 지운다
  const pendingViewIdxRef = useRef(null) // 재생 중 화면 이동 요청을 requestAnimationFrame으로 묶어내기 위한 대기값
  const viewRafRef = useRef(null)
  const rangeAnchorRef = useRef('') // 여러 날 선택 모드에서 첫 번째 클릭(범위 시작)을 임시로 들고 있다가 두 번째 클릭에서 씀
  const closedTradesRef = useRef([]) // 청산된 거래 전체(수동/반자동/시뮬레이션 다 포함, source로 구분) - "결과 저장" 누르면 DB로 보냄

  const availableDates = useMemo(() => buildAvailableDates(datasets), [datasets])

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
    sessionPointsRef.current = []
    annotationsRef.current = []
    setAnnotations([])
    pendingStopLossIdRef.current = null
    markersPrimitiveRef.current?.setMarkers([])
    annotationPrimitiveRef.current?.setMarkers([])
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
            // loadRange가 이미 전체를 다 그려놨으므로(⚙ 셋팅과 동일), 여기선 데이터를 다시 자르지 않고
            // 카메라(재생 위치)만 저장된 곳으로 되돌린다.
            if (!ignore && typeof saved.playIndex === 'number' && saved.playIndex > 0) {
              const idx = Math.min(saved.playIndex, rowsRef.current.length)
              indexRef.current = idx
              setPlayIndex(idx)
              scrollPlaybackView(idx)
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
      height: 700, // 전체 차트 높이(사용자 요청 - 기존 750에서 50px 축소, replay.js와 동일)
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

    maxSpreadLineRef.current = new VerticalLinePrimitive(MAX_SPREAD_LINE_COLOR)
    minSpreadLineRef.current = new VerticalLinePrimitive(MIN_SPREAD_LINE_COLOR)
    series.attachPrimitive(maxSpreadLineRef.current)
    series.attachPrimitive(minSpreadLineRef.current)

    sidewaysBandRef.current = new BackgroundBandsPrimitive(hexToRgba(sidewaysColor, 0.15))
    series.attachPrimitive(sidewaysBandRef.current)

    annotationPrimitiveRef.current = new AnnotationMarkersPrimitive()
    series.attachPrimitive(annotationPrimitiveRef.current)

    for (const s of SESSIONS) {
      const p = new SessionBoxesPrimitive(sessionColors[s.id] || s.color, sessionOpacity, sessionBorderWidth, sessionBorderOpacity)
      series.attachPrimitive(p)
      sessionBandRefs.current[s.id] = p
    }

    // 기본으로 켜둔 볼린저/이평선은 toggleBand/toggleMA(클릭했을 때만 시리즈를 만듦)를 거치지 않으므로,
    // 마운트 시점에 켜져 있는 것들의 실제 차트 시리즈를 여기서 직접 만들어둔다.
    // (마커 시리즈는 항상 "가장 나중에 추가된 것 = 맨 위"여야 하므로 이 시리즈들보다 뒤에 만든다)
    for (const band of ALL_BANDS) {
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
        const p = new DualColorLinePrimitive(
          getDualUpColor(ma.id), getDualDownColor(ma.id), alpha, width, ma.lineStyle,
        )
        series.attachPrimitive(p)
        maDualPrimitiveRef.current[ma.id] = p
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

    // 라벨링 버튼이 어느 캔들에 마킹할지 - 크로스헤어(마우스 올린 위치)가 있으면 그 캔들을 쓴다
    // (마우스가 차트 밖으로 나가면 param.logical이 없어져 null로 돌아가고, 그때는 재생 위치를 씀)
    chart.subscribeCrosshairMove((param) => {
      if (param.logical == null || !param.point || !rowsRef.current.length) { hoveredIdxRef.current = null; hoveredPriceRef.current = null; return }
      hoveredIdxRef.current = Math.max(0, Math.min(Math.round(param.logical), rowsRef.current.length - 1))
      hoveredPriceRef.current = seriesRef.current?.coordinateToPrice(param.point.y) ?? null
    })

    // 차트를 마우스로 클릭하면 그 자리(십자선 세로 위치 그대로)에 라벨 선택 팝업을 띄운다
    // (숫자키 대신 클릭으로도 마킹 가능하게)
    chart.subscribeClick((param) => {
      if (param.logical == null || !rowsRef.current.length || !param.point) { setClickPopup(null); return }
      const idx = Math.max(0, Math.min(Math.round(param.logical), rowsRef.current.length - 1))
      const price = seriesRef.current?.coordinateToPrice(param.point.y) ?? null
      setClickPopup({ idx, price, x: param.point.x, y: param.point.y })
    })

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
    if (viewRafRef.current != null) { cancelAnimationFrame(viewRafRef.current); viewRafRef.current = null }
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

  // DUAL_COLOR_IDS(리본18+hma60) 전용 - DualColorLinePrimitive는 순수 숫자(또는 null) 배열을 받는다
  // (own/other로 쪼갠 시리즈가 아니라 원본 값 그대로 넘기고, 색은 그릴 때마다 직접 계산함).
  const applyDualMAIndex = (maId, idx) => {
    const primitive = maDualPrimitiveRef.current[maId]
    const data = maDataRef.current[maId]
    if (!primitive || !data) return
    primitive.setPoints(data.slice(0, idx).map(p => p ? p.value : null))
  }

  const syncMA = (idx) => {
    Object.keys(maSeriesRef.current).forEach(maId => applyMAIndex(maId, idx))
    Object.keys(maDualPrimitiveRef.current).forEach(maId => applyDualMAIndex(maId, idx))
  }

  // 리본 가장 바깥선(M5-M90, madrid05/madrid90) 폭 - 세로선용. 리본 체크와 무관하게 maDataRef엔 항상 계산돼 있음.
  const spreadAt = (i) => {
    const m5 = maDataRef.current['madrid05']
    const m90 = maDataRef.current['madrid90']
    if (!m5 || !m90) return null
    const a = m5[i], b = m90[i]
    if (!a || !b) return null
    return { value: Math.abs(b.value - a.value), time: a.time }
  }

  // 지그재그 스윙 탐지(방식 B) - 확장→수축으로 꺾이는 순간 직전 구간의 최댓값이 "확정된 국소 고점",
  // 수축→확장으로 꺾이는 순간 직전 구간의 최솟값이 "확정된 국소 저점". 그게 지금까지 기록보다
  // 크면(작으면)만 세로선을 그 자리로 옮긴다. state는 호출 사이에 이어서 쓰는 진행 상태(swingStateRef).
  const scanSpreadSwings = (fromIdx, toIdx, state) => {
    for (let i = fromIdx; i < toIdx; i++) {
      const s = spreadAt(i)
      if (!s) continue
      if (state.prevSpread == null) {
        state.prevSpread = s.value
        state.direction = null
        state.legExtreme = s
        continue
      }
      if (s.value >= state.prevSpread) {
        if (state.direction === 'down') {
          if (state.legExtreme.value < minSpreadRef.current.value) {
            minSpreadRef.current = state.legExtreme
            minSpreadLineRef.current?.setTime(state.legExtreme.time)
          }
          state.legExtreme = s
        } else if (s.value > state.legExtreme.value) {
          state.legExtreme = s
        }
        state.direction = 'up'
      } else {
        if (state.direction === 'up') {
          if (state.legExtreme.value > maxSpreadRef.current.value) {
            maxSpreadRef.current = state.legExtreme
            maxSpreadLineRef.current?.setTime(state.legExtreme.time)
          }
          state.legExtreme = s
        } else if (s.value < state.legExtreme.value) {
          state.legExtreme = s
        }
        state.direction = 'down'
      }
      state.prevSpread = s.value
    }
  }

  // 재생 위치를 임의로 옮길 때(슬라이더 스크럽 등)는 처음부터 다시 스캔해야 한다(되감기일 수 있어서)
  const recomputeSpreadExtremes = (idx) => {
    swingStateRef.current = { prevSpread: null, direction: null, legExtreme: null }
    maxSpreadRef.current = { time: null, value: -Infinity }
    minSpreadRef.current = { time: null, value: Infinity }
    scanSpreadSwings(0, idx, swingStateRef.current)
    maxSpreadLineRef.current?.setTime(maxSpreadRef.current.time)
    minSpreadLineRef.current?.setTime(minSpreadRef.current.time)
  }

  // 횡보 구간 배경 - 재생 위치(idx)까지 드러난 구간만 표시(아직 안 지난 미래 구간은 안 보여줌).
  // 구간이 idx에 걸쳐 있으면 거기까지만 잘라서 보여준다.
  const applySidewaysBands = (idx) => {
    const ranges = []
    for (const seg of sidewaysSegmentsRef.current) {
      if (seg.startIdx >= idx) continue
      const clippedEndIdx = Math.min(seg.endIdx, idx - 1)
      if (clippedEndIdx < seg.startIdx) continue
      ranges.push({ from: seg.startTime, to: rowsRef.current[clippedEndIdx]?.time ?? seg.endTime })
    }
    sidewaysBandRef.current?.setRanges(ranges)
  }

  // 세션 배경 - 캔들이 아직 안 그려진(재생 안 된) 곳엔 미리 그리면 안 된다(사용자 지적) - 횡보와
  // 같은 방식으로 재생 위치(idx)까지 그려진 캔들 범위 안에서만 자라난다. index 기준으로 잘라서
  // 넘기면(fromIndex/toIndex) logicalToCoordinate가 항상 정확한 자리를 계산해준다.
  const applySessionBands = (idx) => {
    for (const session of SESSIONS) {
      const primitive = sessionBandRefs.current[session.id]
      if (!primitive) continue
      if (!sessionEnabled[session.id]) { primitive.setBoxes([]); continue }
      const boxes = []
      for (const seg of sessionSegmentsRef.current[session.id] || []) {
        if (seg.startIdx >= idx) continue
        const clippedEndIdx = Math.min(seg.endIdx, idx - 1)
        if (clippedEndIdx < seg.startIdx) continue
        boxes.push({ fromIndex: seg.startIdx, toIndex: clippedEndIdx, high: seg.high, low: seg.low })
      }
      primitive.setBoxes(boxes)
    }
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

  // 크로스 신호 마커는 재생 위치를 앞서가면 안 된다 - 미리 계산해둔 전체 지점 중
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

    // ⚙ 셋팅 단계에서 차트가 이미 전 구간 다 그려진 채로 시작하므로(재생은 화면 스크롤일 뿐 데이터를
    // 새로 드러내지 않음), 마커도 더 이상 재생 위치까지만 자르지 않고 항상 전체를 그린다.
    const crossMarkers = crossPointsRef.current
      .map(p => p.type === 'golden'
        ? { time: p.time, position: 'belowBar', color: gColor, shape: gShape, size: gSize, text: '' }
        : { time: p.time, position: 'aboveBar', color: dColor, shape: dShape, size: dSize, text: '' })

    // 세계 3대 시장 개장 시각 - 매매 신호가 아니라 항상 고정으로 보여주는 참고 마커(텍스트로 세션 이름 표시)
    const sessionMarkers = sessionPointsRef.current
      .map(p => ({ time: p.time, position: 'aboveBar', color: p.color, shape: 'circle', size: 1, text: p.label }))

    markersPrimitiveRef.current?.setMarkers([...crossMarkers, ...sessionMarkers].sort((a, b) => a.time - b.time))

    // 라벨링(수동 마킹)은 기본 markers API가 아니라 별도 프리미티브로 정확한 가격 위치에 그린다
    annotationPrimitiveRef.current?.setMarkers(
      annotationsRef.current.map(p => ({
        time: p.time, price: p.price, offset: ANNOTATION_STYLES[p.type].offset || 0,
        color: ANNOTATION_STYLES[p.type].color, shape: ANNOTATION_STYLES[p.type].shape, text: ANNOTATION_STYLES[p.type].text,
      }))
    )
  }

  // 라벨링 버튼(또는 숫자키, 또는 차트 클릭 팝업) - explicitIdx가 있으면 그 캔들에(클릭 팝업),
  // 없으면 차트에 마우스를 올려두고 있으면 그 크로스헤어 캔들에, 아니면 재생 위치(카메라) 캔들에
  // 마커를 찍는다. 전부 ref만 읽으므로 키보드 리스너에서 최신값으로 호출해도 안전.
  // 진입롱/진입숏은 같은 자리에 손절도 자동으로 같이 찍고(사용자 요청), 청산을 찍으면 그 손절은
  // 더 이상 유효하지 않으니 같이 지운다(직전 진입 하나만 추적 - 겹쳐 진입하는 경우는 없다고 가정).
  const addAnnotation = (type, explicitIdx, explicitPrice) => {
    const idx = explicitIdx != null ? explicitIdx : (hoveredIdxRef.current != null ? hoveredIdxRef.current : indexRef.current - 1)
    const row = rowsRef.current[idx]
    if (!row) return
    // 마커는 캔들 상/하단이 아니라 클릭·크로스헤어의 정확한 세로 위치(가격)에 찍는다(사용자 지적)
    const price = explicitPrice != null ? explicitPrice : (hoveredPriceRef.current != null ? hoveredPriceRef.current : row.close)

    let next = annotationsRef.current
    if (type === 'exit' && pendingStopLossIdRef.current != null) {
      next = next.filter(a => a.id !== pendingStopLossIdRef.current)
      pendingStopLossIdRef.current = null
    }

    const entry = { id: `${Date.now()}_${Math.random()}`, type, idx, time: row.time, price }
    next = [...next, entry]

    if (type === 'entry_long' || type === 'entry_short') {
      const stopLoss = {
        id: `${entry.id}_sl`, type: type === 'entry_long' ? 'stop_loss_long' : 'stop_loss_short',
        idx, time: row.time, price,
      }
      next = [...next, stopLoss]
      pendingStopLossIdRef.current = stopLoss.id
    }

    annotationsRef.current = next
    setAnnotations(next)
    applyAllMarkers(rowsRef.current.length)
  }

  const removeAnnotation = (id) => {
    annotationsRef.current = annotationsRef.current.filter(a => a.id !== id)
    setAnnotations(annotationsRef.current)
    applyAllMarkers(rowsRef.current.length)
  }

  // 서버로 바로 보내지 않고, 이름을 붙여서 브라우저(localStorage)에 구간별로 모아둔다.
  // 여러 구간을 이렇게 담아뒀다가 마지막에 downloadCollectedAnnotations로 한 번에 파일 다운로드.
  const collectAnnotations = () => {
    if (annotations.length === 0) {
      alert('담을 라벨이 없습니다. 차트에 마우스를 올리고 숫자키(1~7)로 먼저 마킹해보세요.')
      return
    }
    const name = snapshotName.trim()
    if (!name) {
      alert('이 구간의 이름을 입력해주세요.')
      return
    }
    const snapshot = {
      name, symbol, date_from: selectedDate, date_to: selectedDateTo || selectedDate,
      annotations, chart_data: buildChartDataPayload(),
      collected_at: new Date().toISOString(),
    }
    setCollectedAnnotations(prev => {
      const next = [...prev, snapshot]
      try { window.localStorage.setItem(COLLECTED_ANNOTATIONS_KEY, JSON.stringify(next)) } catch { /* 용량 초과 등은 무시 - 다운로드는 여전히 메모리 값 기준으로 됨 */ }
      return next
    })
    setSnapshotName('')
    annotationsRef.current = []
    setAnnotations([])
    pendingStopLossIdRef.current = null
    applyAllMarkers(rowsRef.current.length)
  }

  const removeCollected = (i) => {
    setCollectedAnnotations(prev => {
      const next = prev.filter((_, idx) => idx !== i)
      try { window.localStorage.setItem(COLLECTED_ANNOTATIONS_KEY, JSON.stringify(next)) } catch { /* 무시 */ }
      return next
    })
  }

  // 지금까지 담아둔 구간 전부를 JSON 파일 하나로 묶어 다운로드한다.
  const downloadCollectedAnnotations = () => {
    if (collectedAnnotations.length === 0) {
      alert('담아둔 구간이 없습니다.')
      return
    }
    const blob = new Blob([JSON.stringify(collectedAnnotations, null, 2)], { type: 'application/json' })
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `chart_annotations_${symbol}_${new Date().toISOString().slice(0, 10)}.json`
    document.body.appendChild(a)
    a.click()
    document.body.removeChild(a)
    URL.revokeObjectURL(url)
  }

  // 라벨링 숫자키 단축키(1~7 = ANNOTATION_BUTTONS 순서) - 차트에 마우스를 올린 채 키만 눌러서
  // 마킹할 수 있게(화면을 아래 버튼까지 오갈 필요 없이). ref만 쓰는 addAnnotation을 매 렌더 최신값으로
  // 갈아끼워두고, 리스너 자체는 마운트 시 한 번만 건다.
  const addAnnotationRef = useRef(addAnnotation)
  addAnnotationRef.current = addAnnotation
  useEffect(() => {
    const onKeyDown = (e) => {
      if (e.key === 'Escape') { setClickPopup(null); return }
      const tag = document.activeElement?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA') return
      const i = Number(e.key) - 1
      if (i < 0 || i >= ANNOTATION_BUTTONS.length) return
      if (!rowsRef.current.length) return
      addAnnotationRef.current(ANNOTATION_BUTTONS[i][0])
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [])

  const applyIndex = (idx) => {
    const dayRows = rowsRef.current.slice(0, idx)
    seriesRef.current?.setData(dayRows)
    // 마커 전용 투명 시리즈는 항상 구간 전체를 앵커로 갖고 있어야 한다 - 크로스/세션 마커는 idx와
    // 무관하게 항상 전체를 그리는데, idx까지만 주면 슬라이더로 되감았을 때 그 마커들이 앵커를 못
    // 찾아서 화면 오른쪽 끝에 쏠려 붙는 버그가 생긴다.
    markerSeriesRef.current?.setData(rowsRef.current.map(r => ({ time: r.time, value: r.close })))
    syncBands(idx)
    syncMA(idx)
    syncRSI(idx)
    syncMACD(idx)
    syncMACD5(idx)
    applyAllMarkers(idx)
    if (ribbonEnabled) recomputeSpreadExtremes(idx) // 슬라이더로 임의 위치 이동 - 되감기일 수 있어 처음부터 재스캔
    if (sidewaysEnabled) applySidewaysBands(idx)
    applySessionBands(idx) // 세션도 횡보처럼 재생(그려진 캔들) 범위 안에서만 표시(사용자 지적)
    indexRef.current = idx
    setPlayIndex(idx)
  }

  // 캔들을 하나씩 update()로 이어붙이는 게 setData 전체 재계산보다 가볍다
  const applyIncrement = (from, to) => {
    if (ribbonEnabled) scanSpreadSwings(from, to, swingStateRef.current) // 재생은 항상 앞으로만 가므로 이어서 스캔
    if (sidewaysEnabled) applySidewaysBands(to)
    applySessionBands(to)
    const rows = rowsRef.current
    for (let i = from; i < to; i++) seriesRef.current?.update(rows[i])
    for (let i = from; i < to; i++) {
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

  // [fromStr,toStr] 구간의 지표(볼린저/도치안/이평선/RSI/MACD/횡보/세션/크로스/신호마커)를 전부 계산해서
  // rowsRef.current/total과 각 Ref에 반영한다.
  const computeIndicatorsForRange = (fullRows, fromStr, toStr) => {
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
    if (dayRows.length === 0) return dayRows

    // 볼린저는 그 구간 데이터만으론 워밍업이 부족하니(예: 1시간봉 SMA1200 = 20시간 분량)
    // 같은 파일 안의 이전 날짜들까지 포함해서 계산한 뒤, 표시 구간만 잘라낸다.
    const closes = fullRows.map(r => r.close)
    const newBandData = {}
    for (const band of ALL_BANDS) {
      const { mids, ups, lows } = band.type === 'donchian' ? rollingDonchian(fullRows, band.period) : rollingBollinger(closes, band.period)
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
    // DUAL_COLOR_IDS(리본18+hma60)는 더 이상 별도 분할 배열을 안 만든다 - DualColorLinePrimitive가
    // 위 newMaData[ma.id](원본 {time,value} 배열) 그대로를 받아서 그릴 때마다 직접 방향을 계산한다.
    maDataRef.current = newMaData

    // 횡보 구간(사용자 요청) - 5분B 폭 & 리본(M5-M90) 폭이 둘 다 "이번에 로드된 구간" 안에서
    // 하위25%일 때 횡보로 본다. 임계값은 로드할 때마다 그 구간 분포로 다시 잡음(고정값 아님).
    {
      const bw100 = newBandData['sma100']
      const ribbon5 = newMaData['madrid05']
      const ribbon90 = newMaData['madrid90']
      const widthAt = (i) => {
        const u = bw100?.upper[i], l = bw100?.lower[i]
        return (u && l) ? u.value - l.value : null
      }
      const spreadAt2 = (i) => {
        const a = ribbon5?.[i], b = ribbon90?.[i]
        return (a && b) ? Math.abs(b.value - a.value) : null
      }
      const pct = (arr, p) => {
        if (!arr.length) return null
        const s = [...arr].sort((a, b) => a - b)
        return s[Math.min(Math.floor(s.length * p), s.length - 1)]
      }
      const widths = [], spreads = []
      for (let i = 0; i < dayRows.length; i++) {
        const w = widthAt(i); if (w != null) widths.push(w)
        const s = spreadAt2(i); if (s != null) spreads.push(s)
      }
      const bandThresh = pct(widths, 0.25)
      const ribbonThresh = pct(spreads, 0.25)
      const rawSegments = []
      if (bandThresh != null && ribbonThresh != null) {
        let segStart = null
        for (let i = 0; i < dayRows.length; i++) {
          const w = widthAt(i), s = spreadAt2(i)
          const isSide = w != null && s != null && w <= bandThresh && s <= ribbonThresh
          if (isSide && segStart == null) segStart = i
          if (!isSide && segStart != null) { rawSegments.push({ startIdx: segStart, endIdx: i - 1 }); segStart = null }
        }
        if (segStart != null) rawSegments.push({ startIdx: segStart, endIdx: dayRows.length - 1 })
      }
      const MIN_SIDEWAYS_MIN = 5 // 1~2캔들짜리 노이즈 제외
      sidewaysSegmentsRef.current = rawSegments
        .map(seg => ({ ...seg, startTime: dayRows[seg.startIdx].time, endTime: dayRows[seg.endIdx].time }))
        .filter(seg => (seg.endTime - seg.startTime) / 60 + 1 >= MIN_SIDEWAYS_MIN)
    }

    // 세션 표시(아시아/유럽/뉴욕) - 이 차트 시간 라벨이 이미 KST라 SESSIONS의 시/종료시각을 그대로 씀
    {
      const newSessionSegments = {}
      for (const session of SESSIONS) {
        const hrs = sessionHours[session.id] || { start: session.startHour, end: session.endHour }
        newSessionSegments[session.id] = findSessionSegmentsIn(dayRows, hrs.start, hrs.end)
      }
      sessionSegmentsRef.current = newSessionSegments
    }

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
    refreshAutoEvents()
    refreshSimEvents()
    refreshSessionMarkers()
    return dayRows
  }

  // fromStr === toStr이면 하루, fromStr < toStr이면 그 사이 여러 날을 이어서 하나의 재생 구간으로 불러온다.
  // '⚙ 셋팅' 버튼(applySelection)이 선택된 날짜/범위로 이 함수를 부른다.
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
    sessionPointsRef.current = []
    annotationsRef.current = []
    setAnnotations([])
    pendingStopLossIdRef.current = null
    markersPrimitiveRef.current?.setMarkers([])
    annotationPrimitiveRef.current?.setMarkers([])
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

      const dayRows = computeIndicatorsForRange(fullRows, fromStr, toStr)

      if (dayRows.length === 0) {
        setError('이 날짜엔 캔들이 없어요 (주말/휴장일일 수 있어요)')
      } else {
        // '⚙ 셋팅' = 그 기간 차트를 바로 다 그려서 보여준다(재생은 여기서 처음부터 다시 훑고 싶을 때
        // '⏮ 처음부터'를 눌러 0으로 되돌린 뒤 쓰면 됨 - 로드 직후 화면이 비어 보이는 문제 방지).
        applyIndex(dayRows.length)
      }
    } catch (e) {
      setError(e.message)
      rowsRef.current = []
      setTotal(0)
    }
    setLoadingCsv(false)
  }

  // 달력 클릭 처리 - 날짜를 고르기만 하고(선택 상태만 바뀜) 바로 로드하지 않는다.
  // 실제 로드는 아래 '⚙ 셋팅' 버튼을 눌러야 일어난다(사용자 요청 - 선택과 로드를 분리).
  // 여러 날 선택 모드가 꺼져있으면 클릭한 날 하루만 선택하고, 켜져있으면 첫 클릭은 범위
  // 시작점만 표시해두고 두 번째 클릭에서 시작~끝을 범위로 선택한다(로드는 아직 안 함).
  // (Shift+클릭도 같은 방식으로 동작 - MonthCalendar가 이미 shiftKey를 넘겨주고 있었음).
  const handleCalendarSelect = (dateStr, shiftKey) => {
    if (!multiSelectMode && !shiftKey) {
      rangeAnchorRef.current = ''
      // 이미 선택(또는 로드)된 날짜를 또 클릭하면 선택을 취소하고 빈 화면으로 돌아간다(사용자 요청)
      if (selectedDate === dateStr && !selectedDateTo) {
        clearSelection()
        return
      }
      setSelectedDate(dateStr)
      setSelectedDateTo('')
      setError('')
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
    setSelectedDate(from)
    setSelectedDateTo(to)
    setError('')
  }

  // '⚙ 셋팅' 버튼 - 지금 선택된(아직 안 불러온) 날짜/범위를 실제로 불러와 차트를 구성한다.
  const applySelection = () => {
    if (!selectedDate) return
    loadRange(selectedDate, selectedDateTo || selectedDate)
  }

  // 선택 전부 지우고 빈 화면으로 - 이미 선택된 날짜를 다시 클릭했을 때 씀. symbol 전환 리셋과 같은 항목을 지운다.
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
    sessionPointsRef.current = []
    annotationsRef.current = []
    setAnnotations([])
    pendingStopLossIdRef.current = null
    markersPrimitiveRef.current?.setMarkers([])
    annotationPrimitiveRef.current?.setMarkers([])
    setPositions([])
  }


  const toggleSummerTime = () => setSummerTime(prev => !prev)

  // 서머타임 상태가 바뀌면 캐시된 rows엔 예전 오프셋이 이미 반영돼 있어서 그대로 두면 안 바뀐다.
  // 캐시를 통째로 비우고, 지금 보고 있던 날짜가 있으면 새 오프셋으로 다시 불러온다.
  // (setSummerTime 콜백 안에서 바로 loadRange를 부르면 summerTime이 아직 안 바뀐 값이라 한 번 밀리므로 effect로 분리)
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

  // 차트 표시 설정(체크박스/색상/두께/시간/투명도/모양/크기/슬롯 선택 전부) 저장 - localStorage라 브라우저를
  // 완전히 닫았다 열어도 유지된다. "초기화" 버튼을 눌렀을 때만 CHART_SETTINGS_KEY를 지우고 새로고침한다.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(CHART_SETTINGS_KEY, JSON.stringify({
        enabledBands, lineVisibility, bandColors,
        enabledMA, maColors, maWidths, maUpColors, maDownColors,
        ribbonEnabled, ribbonOpacity,
        sidewaysEnabled, sidewaysColor,
        sessionEnabled, sessionColors, sessionHours, sessionOpacity, sessionBorderWidth, sessionBorderOpacity,
        enabledRSI, rsiColor,
        enabledMACD, macdLineColor, macdSignalColor,
        enabledMACD5, macd5LineColor, macd5SignalColor,
        upColor, downColor, candleVisible,
        crossPairs, goldenShape, goldenColor, goldenSize, deadShape, deadColor, deadSize,
        startingBalance, lotSize, pnlDisplay,
        semiAutoEnabled, autoCrossPairs,
        simulationEnabled, simCrossPairs,
      }))
    } catch { /* 저장 실패해도(예: 프라이빗 모드 용량제한) 기능엔 영향 없음 */ }
  }, [
    enabledBands, lineVisibility, bandColors,
    enabledMA, maColors, maWidths, maUpColors, maDownColors,
    ribbonEnabled, ribbonOpacity,
    sidewaysEnabled, sidewaysColor,
    sessionEnabled, sessionColors, sessionHours, sessionOpacity, sessionBorderWidth, sessionBorderOpacity,
    enabledRSI, rsiColor,
    enabledMACD, macdLineColor, macdSignalColor,
    enabledMACD5, macd5LineColor, macd5SignalColor,
    upColor, downColor, candleVisible,
    crossPairs, goldenShape, goldenColor, goldenSize, deadShape, deadColor, deadSize,
    startingBalance, lotSize, pnlDisplay,
    semiAutoEnabled, autoCrossPairs,
    simulationEnabled, simCrossPairs,
  ])

  // 초기화 버튼 - 저장된 설정을 지우고 새로고침하면 위의 모든 useState가 기본값으로 다시 시작된다.
  // (약 50개 상태를 하나하나 되돌리고 살아있는 차트 시리즈/프리미티브를 전부 재동기화하는 것보다,
  // 새로고침으로 기존 마운트 로직이 처음부터 다시 실행되게 하는 쪽이 훨씬 안전하다)
  const resetChartSettings = () => {
    if (typeof window === 'undefined') return
    if (!window.confirm('차트 설정을 전부 기본값으로 초기화할까요? (심볼/재생위치는 유지되고, 날짜는 오늘로 돌아갑니다)')) return
    try {
      window.localStorage.removeItem(CHART_SETTINGS_KEY)
      // 날짜도 초기화(사용자 요청) - 세션 복원값 중 날짜/재생위치만 오늘/0으로 덮어써서, 새로고침 후
      // 마운트 시 세션 복원 로직이 오늘 날짜를 자동으로 불러오게 한다(심볼은 그대로 유지).
      const raw = window.sessionStorage.getItem(BACKTEST_STATE_KEY)
      const prev = raw ? JSON.parse(raw) : {}
      window.sessionStorage.setItem(BACKTEST_STATE_KEY, JSON.stringify({
        ...prev, selectedDate: toLocalDateStr(Math.floor(Date.now() / 1000)), selectedDateTo: '', playIndex: 0,
      }))
    } catch { /* ignore */ }
    window.location.reload()
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
        const band = ALL_BANDS.find(b => b.id === bandId)
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
      maDualPrimitiveRef.current[maId]?.setLineWidth(width)
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
      maDualPrimitiveRef.current[ma.id]?.setLineWidth(ma.lineWidth)
    } else {
      maSeriesRef.current[ma.id]?.applyOptions({ lineWidth: ma.lineWidth })
    }
  }

  // DUAL_COLOR_IDS(리본 + hma60) 전용 - 커스텀 안 골랐으면 RIBBON_LIME/RIBBON_RED 기본값.
  // 이름이 candle up/down색 설정 함수(setUpColor/setDownColor, 위쪽에 있음)랑 겹쳐서 Dual 접두어로 구분.
  // DualColorLinePrimitive는 hex 원색 + 투명도를 따로 들고 있다가 그릴 때 합치므로, 여기선 항상
  // hex 원색만 넘긴다(투명도가 섞인 rgba를 저장/전달하지 않음).
  const getDualUpColor = (maId) => maUpColors[maId] || DUAL_DEFAULT_UP_COLOR[maId] || RIBBON_LIME
  const getDualDownColor = (maId) => maDownColors[maId] || DUAL_DEFAULT_DOWN_COLOR[maId] || RIBBON_RED
  const setDualUpColor = (maId, color) => {
    setMaUpColors(prev => ({ ...prev, [maId]: color }))
    maDualPrimitiveRef.current[maId]?.setUpColor(color)
  }
  const setDualDownColor = (maId, color) => {
    setMaDownColors(prev => ({ ...prev, [maId]: color }))
    maDualPrimitiveRef.current[maId]?.setDownColor(color)
  }
  // 리본 카드의 "세트" 컬러피커 - 리본 선 전부의 상승/하락 색을 한번에 바꾼다
  const setRibbonUpColor = (color) => { for (const ma of MADRID_RIBBON) setDualUpColor(ma.id, color) }
  const setRibbonDownColor = (color) => { for (const ma of MADRID_RIBBON) setDualDownColor(ma.id, color) }
  // 리본 18개 선 전용 투명도 슬라이더(사용자 요청) - hma3(dual이지만 리본 아님)는 영향 없음
  const setRibbonOpacityValue = (value) => {
    setRibbonOpacityState(value)
    for (const ma of MADRID_RIBBON) {
      maDualPrimitiveRef.current[ma.id]?.setAlpha(value)
    }
  }

  const toggleMA = (maId) => {
    const turningOn = !enabledMA[maId]
    setEnabledMA(prev => ({ ...prev, [maId]: turningOn }))
    const ma = ALL_MA.find(m => m.id === maId)
    const dual = isDualColor(maId)

    if (turningOn) {
      if (dual) {
        if (!maDualPrimitiveRef.current[maId] && seriesRef.current) {
          const width = getMAWidth(ma)
          const alpha = isRibbonId(maId) ? ribbonOpacity : 1
          const p = new DualColorLinePrimitive(getDualUpColor(maId), getDualDownColor(maId), alpha, width, ma.lineStyle)
          seriesRef.current.attachPrimitive(p)
          maDualPrimitiveRef.current[maId] = p
        }
        applyDualMAIndex(maId, indexRef.current)
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
        const p = maDualPrimitiveRef.current[maId]
        if (p && seriesRef.current) seriesRef.current.detachPrimitive(p)
        delete maDualPrimitiveRef.current[maId]
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
    const turningOn = !ribbonEnabled
    setRibbonEnabledState(turningOn)
    for (const ma of MADRID_RIBBON) toggleMA(ma.id)
    // 발산 최대/수축 최소 세로선도 리본 체크와 같이 켜고 끈다
    if (turningOn) {
      recomputeSpreadExtremes(indexRef.current)
    } else {
      maxSpreadLineRef.current?.setTime(null)
      minSpreadLineRef.current?.setTime(null)
    }
  }

  const toggleSideways = () => {
    const turningOn = !sidewaysEnabled
    setSidewaysEnabledState(turningOn)
    if (turningOn) applySidewaysBands(indexRef.current)
    else sidewaysBandRef.current?.setRanges([])
  }

  const setSidewaysColor = (hex) => {
    setSidewaysColorState(hex)
    sidewaysBandRef.current?.setFillStyle(hexToRgba(hex, 0.15))
  }

  // 세션(아시아/유럽/뉴욕)은 서로 독립적으로 켜고 끔 - sessionEnabled state는 비동기라 여기서
  // 바로 켤지 끌지(turningOn)를 계산해서 직접 primitive에 반영한다(리본/횡보 토글과 같은 패턴).
  const toggleSession = (sessionId) => {
    const turningOn = !sessionEnabled[sessionId]
    setSessionEnabledState(prev => ({ ...prev, [sessionId]: turningOn }))
    const primitive = sessionBandRefs.current[sessionId]
    if (!primitive) return
    if (!turningOn) { primitive.setBoxes([]); return }
    const idx = indexRef.current
    const boxes = []
    for (const seg of sessionSegmentsRef.current[sessionId] || []) {
      if (seg.startIdx >= idx) continue
      const clippedEndIdx = Math.min(seg.endIdx, idx - 1)
      if (clippedEndIdx < seg.startIdx) continue
      boxes.push({ fromIndex: seg.startIdx, toIndex: clippedEndIdx, high: seg.high, low: seg.low })
    }
    primitive.setBoxes(boxes)
  }

  const setSessionColor = (sessionId, hex) => {
    setSessionColorsState(prev => ({ ...prev, [sessionId]: hex }))
    sessionBandRefs.current[sessionId]?.setColor(hex)
  }

  // 투명도는 세션 3개 공통(사용자 요청) - 테두리가 아니라 안쪽 채우기 투명도. 각자 테두리/기본색은
  // 그대로 두고 채우기 알파만 3개 다 갱신
  const setSessionOpacityValue = (value) => {
    setSessionOpacityState(value)
    for (const s of SESSIONS) {
      sessionBandRefs.current[s.id]?.setFillAlpha(value)
    }
  }

  // 테두리 두께/투명도도 채우기 투명도와 같은 패턴 - 세션 3개 공통
  const setSessionBorderWidthValue = (value) => {
    setSessionBorderWidthState(value)
    for (const s of SESSIONS) {
      sessionBandRefs.current[s.id]?.setBorderWidth(value)
    }
  }
  const setSessionBorderOpacityValue = (value) => {
    setSessionBorderOpacityState(value)
    for (const s of SESSIONS) {
      sessionBandRefs.current[s.id]?.setBorderAlpha(value)
    }
  }

  // 시간은 세션마다 따로(사용자 요청) - 바꾸면 이미 로드된 데이터에서 그 세션만 다시 스캔하고,
  // 켜져 있으면 재생 위치까지 바로 반영한다.
  const setSessionHour = (sessionId, which, value) => {
    setSessionHoursState(prev => {
      const next = { ...prev, [sessionId]: { ...prev[sessionId], [which]: value } }
      const hrs = next[sessionId]
      sessionSegmentsRef.current = { ...sessionSegmentsRef.current, [sessionId]: findSessionSegmentsIn(rowsRef.current, hrs.start, hrs.end) }
      if (sessionEnabled[sessionId]) {
        const idx = indexRef.current
        const boxes = []
        for (const seg of sessionSegmentsRef.current[sessionId]) {
          if (seg.startIdx >= idx) continue
          const clippedEndIdx = Math.min(seg.endIdx, idx - 1)
          if (clippedEndIdx < seg.startIdx) continue
          boxes.push({ fromIndex: seg.startIdx, toIndex: clippedEndIdx, high: seg.high, low: seg.low })
        }
        sessionBandRefs.current[sessionId]?.setBoxes(boxes)
      }
      return next
    })
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

  // 크로스 슬롯(pairs)을 계산하는 공용 헬퍼 - 반자동(refreshAutoEvents)과 시뮬레이션(refreshSimEvents)이
  // 완전히 같은 구조라 여기서 공유한다.
  const computePairEvents = (crossPairsArg) => {
    return crossPairsArg
      .flatMap(({ a, b }) => (a && b && a !== b ? findMACrossForPair(a, b) : []))
      .map(p => ({ idx: p.idx, time: p.time, side: p.type === 'golden' ? 'buy' : 'sell', source: 'cross' }))
      .sort((a, b) => a.idx - b.idx)
  }

  // 반자동진입 트리거를 다시 계산한다
  const refreshAutoEvents = (crossP = autoCrossPairs) => {
    autoEventsRef.current = computePairEvents(crossP)
  }

  const setAutoCrossPair = (slotIndex, which, maId) => {
    setAutoCrossPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: maId } : p))
      refreshAutoEvents(next)
      return next
    })
  }

  // 시뮬레이션 트리거 - 반자동(refreshAutoEvents)과 완전히 같은 계산이지만 별도 타임라인(simEventsRef)에 쌓는다
  const refreshSimEvents = (crossP = simCrossPairs) => {
    simEventsRef.current = computePairEvents(crossP)
  }

  const setSimCrossPair = (slotIndex, which, maId) => {
    setSimCrossPairsState(prev => {
      const next = prev.map((p, i) => (i === slotIndex ? { ...p, [which]: maId } : p))
      refreshSimEvents(next)
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

  // 지금 불러온 구간 전체(캔들 + 볼린저밴드 5개 + 이평선 전부 + RSI + MACD1/5)를 숫자로 그대로 뽑아낸다.
  // ⚙ 셋팅 단계에서 이미 전 구간이 다 그려져 있으므로(재생은 화면 스크롤일 뿐), 재생 위치(카메라)와
  // 무관하게 항상 로드된 전체 범위를 담는다.
  const buildChartDataPayload = () => {
    const idx = rowsRef.current.length
    const bands = {}
    for (const band of ALL_BANDS) {
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

  // Claude가 Browser 도구로 이 페이지에 직접 접속했을 때, 파일 다운로드 없이 브라우저 콘솔에서
  // `window.getBacktestChartData()`를 호출해서 지금 이 화면 상태(재생위치까지)를 바로 읽어갈 수 있게
  // window에 노출해둔다. 렌더될 때마다 최신 클로저로 갱신(각 값이 바뀔 때마다 새로 만들어도 비용 거의 없음).
  useEffect(() => {
    window.getBacktestChartData = buildChartDataPayload
    return () => { if (window.getBacktestChartData === buildChartDataPayload) delete window.getBacktestChartData }
  })

  // '⚙ 셋팅' 단계에서 캔들/지표/마커가 이미 전부 그려져 있으므로(applyIndex(dayRows.length)),
  // 재생/처음부터/슬라이더는 더 이상 데이터를 새로 그리지 않고 화면(카메라)만 옮긴다.
  const scrollPlaybackView = (idx) => {
    const ts = chartRef.current?.timeScale()
    if (!ts) return
    ts.setVisibleLogicalRange({ from: idx - PLAYBACK_VIEW_BARS, to: idx })
  }

  // 재생 중(특히 고배속)엔 setInterval 틱이 화면 페인트보다 훨씬 잦을 수 있어, 매 틱마다 바로
  // scrollPlaybackView(무거운 차트 리렌더)와 setPlayIndex(리액트 리렌더)를 부르면 브라우저가
  // 못 따라가서 입력이 밀린다(INP 저하). 여러 틱이 겹치면 requestAnimationFrame 한 번으로 묶어서
  // 실제 화면 이동 + 리액트 갱신은 페인트당 최대 1번만 하게 한다(indexRef 자체는 매 틱 정확히 갱신).
  const requestScrollPlaybackView = (idx) => {
    pendingViewIdxRef.current = idx
    if (viewRafRef.current != null) return
    viewRafRef.current = requestAnimationFrame(() => {
      viewRafRef.current = null
      if (pendingViewIdxRef.current == null) return
      const flushIdx = pendingViewIdxRef.current
      scrollPlaybackView(flushIdx)
      setPlayIndex(flushIdx)
    })
  }

  const play = () => {
    if (!rowsRef.current.length) return
    if (indexRef.current >= rowsRef.current.length) {
      indexRef.current = 0
      setPlayIndex(0)
    }
    scrollPlaybackView(indexRef.current)
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
      const to = Math.min(indexRef.current + candlesPerTick, rowsRef.current.length)
      indexRef.current = to
      requestScrollPlaybackView(to)
      if (to >= rowsRef.current.length) stopPlayback()
    }, tickMs)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, speed, stopPlayback])

  const reset = () => {
    stopPlayback()
    indexRef.current = 0
    setPlayIndex(0)
    scrollPlaybackView(0)
  }

  const scrub = (idx) => {
    stopPlayback()
    indexRef.current = idx
    setPlayIndex(idx)
    scrollPlaybackView(idx)
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
            <span style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'rgba(76,175,80,0.15)', color: '#4CAF50', border: '1px solid #4CAF50' }}>학습</span>
            <Link href="/backtest-intraday" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>📈 일중 패턴</Link>
            <Link href="/replay" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>🔁 리플레이</Link>
          </nav>
        </header>

        <main style={{ maxWidth: 1500, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>캔들 시뮬레이션 차트</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 4 }}>달력에서 데이터가 있는 날짜를 골라서, 그날 시세를 순서대로 재생해볼 수 있어요.</p>
          <p style={{ color: '#FF9800', fontSize: 12.5, marginBottom: 24 }}>⚠ 한 번에 너무 긴 기간을 불러오면 느려질 수 있어요 — 1주일 단위로 나눠서 보는 걸 추천해요.</p>

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

              <button
                onClick={resetChartSettings}
                title="체크박스/색상/두께/시간/투명도/모양/크기 등 모든 차트 설정을 기본값으로 되돌립니다"
                style={{
                  width: '100%', background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '7px 0', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                }}
              >↺ 설정 초기화</button>

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

              <CollapsibleCard title="횡보" maxWidth={170} defaultOpen={false}>
                <div style={{ padding: '1px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={sidewaysEnabled}
                      onChange={toggleSideways}
                      style={{ width: 13, height: 13, margin: 0, accentColor: sidewaysColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>횡보 구간 표시</span>
                    <input
                      type="color"
                      value={sidewaysColor}
                      onClick={e => e.stopPropagation()}
                      onChange={e => setSidewaysColor(e.target.value)}
                      title="배경색 변경 가능"
                      style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                    />
                  </label>
                </div>
              </CollapsibleCard>

              <CollapsibleCard title="세션" maxWidth={170} defaultOpen={false}>
                {SESSIONS.map(s => {
                  const hrs = sessionHours[s.id] || { start: s.startHour, end: s.endHour }
                  return (
                    <div key={s.id} style={{ padding: '3px 0', borderBottom: '1px solid #1c2028' }}>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={!!sessionEnabled[s.id]}
                          onChange={() => toggleSession(s.id)}
                          style={{ width: 13, height: 13, margin: 0, accentColor: sessionColors[s.id] || s.color, flexShrink: 0 }}
                        />
                        <span style={{ flex: 1 }}>{s.label}</span>
                        <input
                          type="color"
                          value={sessionColors[s.id] || s.color}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setSessionColor(s.id, e.target.value)}
                          title="배경색 변경 가능"
                          style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                        />
                      </label>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                        <input
                          type="number" min={0} max={23} value={hrs.start}
                          onChange={e => setSessionHour(s.id, 'start', Math.min(23, Math.max(0, Number(e.target.value) || 0)))}
                          style={{ width: 34, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                        />
                        <span>시 ~</span>
                        <input
                          type="number" min={0} max={24} value={hrs.end}
                          onChange={e => setSessionHour(s.id, 'end', Math.min(24, Math.max(0, Number(e.target.value) || 0)))}
                          style={{ width: 34, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                        />
                        <span>시</span>
                      </div>
                    </div>
                  )
                })}
                <div style={{ marginTop: 6, fontSize: 10, color: '#5a5f6a', width: '100%', boxSizing: 'border-box' }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginBottom: 3, whiteSpace: 'nowrap' }}>
                    <span>투명도(공통)</span>
                    <input
                      type="number" min={5} max={100} step={5}
                      value={Math.round(sessionOpacity * 100)}
                      onChange={e => {
                        const pct = Math.min(100, Math.max(5, Number(e.target.value) || 0))
                        setSessionOpacityValue(pct / 100)
                      }}
                      style={{ width: 36, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                    />
                    <span>%</span>
                  </div>
                  <input
                    type="range" min={0.05} max={1} step={0.05}
                    value={sessionOpacity}
                    onChange={e => setSessionOpacityValue(Number(e.target.value))}
                    style={{ width: '100%', boxSizing: 'border-box', display: 'block', margin: 0 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, marginBottom: 3, whiteSpace: 'nowrap' }}>
                    <span>테두리 두께(공통)</span>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    {MA_WIDTHS.map(w => (
                      <button
                        key={w}
                        type="button"
                        onClick={() => setSessionBorderWidthValue(w)}
                        title={`두께 ${w}`}
                        style={{
                          fontSize: 10, padding: '2px 6px', borderRadius: 5,
                          border: `1px solid ${sessionBorderWidth === w ? '#e8eaed' : '#2a2e38'}`,
                          background: sessionBorderWidth === w ? '#e8eaed22' : 'none',
                          color: sessionBorderWidth === w ? '#e8eaed' : '#5a5f6a',
                          cursor: 'pointer',
                        }}
                      >{w}</button>
                    ))}
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginTop: 6, marginBottom: 3, whiteSpace: 'nowrap' }}>
                    <span>테두리 투명도(공통)</span>
                    <input
                      type="number" min={5} max={100} step={5}
                      value={Math.round(sessionBorderOpacity * 100)}
                      onChange={e => {
                        const pct = Math.min(100, Math.max(5, Number(e.target.value) || 0))
                        setSessionBorderOpacityValue(pct / 100)
                      }}
                      style={{ width: 36, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                    />
                    <span>%</span>
                  </div>
                  <input
                    type="range" min={0.05} max={1} step={0.05}
                    value={sessionBorderOpacity}
                    onChange={e => setSessionBorderOpacityValue(Number(e.target.value))}
                    style={{ width: '100%', boxSizing: 'border-box', display: 'block', margin: 0 }}
                  />
                </div>
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

              {/* 도치안 채널(Donchian Channel) - 볼린저는 매 순간 표준편차로 출렁여서 판단 기준으로 쓰기
                  어렵다는 사용자 피드백으로 추가(replay.js와 동일). 상/중/하 3선 구조와 토글/색상 파이프라인
                  (enabledBands, bandColors, toggleBand, isLineVisible, toggleLine, getBandColor, resetBandColor)을
                  볼린저와 완전히 공유한다(둘 다 ALL_BANDS 소속, bandId만 다름) - 카드만 따로 분리. */}
              <CollapsibleCard title="도치안 채널" maxWidth={170}>
                {DONCHIAN_CHANNELS.map(band => {
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
                        {/* 네모를 누르면 브라우저 기본 색상선택기가 뜬다 - 기본값은 DONCHIAN_CHANNELS의 원래 색(볼린저와 동일) */}
                        <input
                          type="color"
                          value={color}
                          onClick={e => e.stopPropagation()}
                          onChange={e => setBandColor(band.id, e.target.value)}
                          title="색상변경 가능"
                          style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer', flexShrink: 0 }}
                        />
                      </label>

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

            </div>

            {/* 오른쪽 컬럼: 상태줄 / 차트 / 컨트롤 */}
            {/* 왼쪽 사이드바(카드 여러개 펼치면 훨씬 길어짐)를 스크롤해서 내려도 이 컬럼이 화면 밖으로
                사라지지 않게 뷰포트 높이에 sticky로 고정하고, 자체 높이가 화면보다 크면 내부에서만 스크롤되게 함 */}
            <div style={{ flex: 1, minWidth: 280, position: 'sticky', top: 20, maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', overflowX: 'hidden' }}>
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

              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, position: 'relative' }}>
                <div ref={containerRef} style={{ width: '100%', height: 700 }} />

                {clickPopup && (
                  <>
                    <div
                      onClick={() => setClickPopup(null)}
                      style={{ position: 'absolute', inset: 0, zIndex: 10 }}
                    />
                    <div
                      style={{
                        position: 'absolute', left: clickPopup.x, top: clickPopup.y,
                        transform: 'translate(-50%, calc(-100% - 12px))', zIndex: 11,
                        background: '#171a21', border: '1px solid #4CAF50', borderRadius: 10,
                        padding: 8, display: 'flex', flexDirection: 'column', gap: 4,
                        boxShadow: '0 4px 16px rgba(0,0,0,0.5)', minWidth: 150,
                      }}
                    >
                      {annotations.filter(a => a.idx === clickPopup.idx).length > 0 && (
                        <>
                          <div style={{ fontSize: 10.5, color: '#9aa0ab', padding: '0 2px' }}>이 캔들의 라벨 - 눌러서 삭제</div>
                          {annotations.filter(a => a.idx === clickPopup.idx).map(a => (
                            <button
                              key={a.id}
                              type="button"
                              onClick={() => { removeAnnotation(a.id); setClickPopup(null) }}
                              style={{
                                background: `${ANNOTATION_STYLES[a.type].color}22`, color: ANNOTATION_STYLES[a.type].color,
                                border: `1px solid ${ANNOTATION_STYLES[a.type].color}`, borderRadius: 7,
                                padding: '6px 10px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left',
                              }}
                            >✕ {ANNOTATION_STYLES[a.type].text} 삭제</button>
                          ))}
                          <div style={{ borderTop: '1px solid #2a2e38', margin: '4px 0' }} />
                        </>
                      )}
                      {ANNOTATION_BUTTONS.map(([type, label], i) => (
                        <button
                          key={type}
                          type="button"
                          onClick={() => { addAnnotation(type, clickPopup.idx, clickPopup.price); setClickPopup(null) }}
                          style={{
                            background: 'none', color: ANNOTATION_STYLES[type].color, border: `1px solid ${ANNOTATION_STYLES[type].color}`,
                            borderRadius: 7, padding: '6px 10px', fontSize: 12.5, fontWeight: 700, cursor: 'pointer', textAlign: 'left',
                          }}
                        ><span style={{ opacity: 0.6, marginRight: 5 }}>{i + 1}</span>{label}</button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 16 }}>
                {selectedDate && (
                  <span style={{ color: '#e8eaed', fontSize: 13, fontWeight: 700 }}>
                    {selectedDateTo ? `${selectedDate} ~ ${selectedDateTo}` : selectedDate}
                  </span>
                )}
                <span style={{ color: '#9aa0ab', fontSize: 13 }}>{playIndex.toLocaleString()} / {total.toLocaleString()}봉</span>
              </div>
              <input
                type="range" min={0} max={total || 0} value={playIndex}
                onChange={e => scrub(Number(e.target.value))}
                disabled={!total}
                style={{ width: '100%', marginTop: 6 }}
              />

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={applySelection} disabled={!selectedDate} title="선택한 날짜(범위)의 차트를 불러와 준비합니다" style={{
                  background: '#2196F3', color: '#fff', border: 'none', borderRadius: 9,
                  padding: '10px 20px', fontSize: 14, fontWeight: 700, cursor: selectedDate ? 'pointer' : 'not-allowed', opacity: selectedDate ? 1 : 0.5,
                }}>⚙ 셋팅</button>

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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
                  <span style={{ fontSize: 14, fontWeight: 700 }}>📍 라벨링</span>
                  <span style={{ fontSize: 11.5, color: '#9aa0ab' }}>차트에 마우스를 올린 채 숫자키(1~7)를 누르면 그 캔들에 바로 마킹돼요(학습용 데이터)</span>
                </div>

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {ANNOTATION_BUTTONS.map(([type, label], i) => (
                    <button
                      key={type}
                      type="button" onClick={() => addAnnotation(type)} disabled={!total}
                      title={`숫자키 ${i + 1}`}
                      style={{
                        background: 'none', color: ANNOTATION_STYLES[type].color, border: `1px solid ${ANNOTATION_STYLES[type].color}`,
                        borderRadius: 9, padding: '8px 14px', fontSize: 13, fontWeight: 700,
                        cursor: total ? 'pointer' : 'not-allowed', opacity: total ? 1 : 0.5,
                      }}
                    ><span style={{ opacity: 0.6, marginRight: 5 }}>{i + 1}</span>{label}</button>
                  ))}
                </div>

                {annotations.length > 0 && (
                  <div style={{ marginTop: 12, borderTop: '1px solid #2a2e38', paddingTop: 8 }}>
                    {annotations.map(a => (
                      <div key={a.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5 }}>
                        <span style={{ color: ANNOTATION_STYLES[a.type].color, fontWeight: 700, width: 70 }}>{ANNOTATION_STYLES[a.type].text}</span>
                        <span style={{ color: '#9aa0ab', width: 130 }}>{localTimeFormatter(a.time)}</span>
                        <span style={{ color: '#9aa0ab' }}>{a.price.toFixed(2)}</span>
                        <button
                          type="button" onClick={() => removeAnnotation(a.id)}
                          style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', cursor: 'pointer' }}
                        >삭제</button>
                      </div>
                    ))}
                  </div>
                )}

                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14, paddingTop: 12, borderTop: '1px solid #2a2e38', flexWrap: 'wrap' }}>
                  <input
                    type="text" value={snapshotName} onChange={e => setSnapshotName(e.target.value)}
                    placeholder="이 구간 이름(예: 26.04.18 오전 눌림)"
                    style={{ flex: '1 1 220px', background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '7px 10px', fontSize: 13 }}
                  />
                  <button
                    type="button" onClick={collectAnnotations}
                    style={{ fontSize: 12, padding: '7px 14px', borderRadius: 6, cursor: 'pointer', border: '1px solid #4CAF50', background: '#4CAF5022', color: '#4CAF50', fontWeight: 700 }}
                  >이 구간 담기 ({annotations.length}건)</button>
                </div>

                {collectedAnnotations.length > 0 && (
                  <div style={{ marginTop: 12 }}>
                    {collectedAnnotations.map((s, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5 }}>
                        <span style={{ fontWeight: 700 }}>{s.name}</span>
                        <span style={{ color: '#9aa0ab' }}>{s.annotations.length}건</span>
                        <button
                          type="button" onClick={() => removeCollected(i)}
                          style={{ marginLeft: 'auto', fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', cursor: 'pointer' }}
                        >삭제</button>
                      </div>
                    ))}
                    <button
                      type="button" onClick={downloadCollectedAnnotations}
                      style={{ marginTop: 8, width: '100%', fontSize: 13, padding: '9px 0', borderRadius: 8, cursor: 'pointer', border: '1px solid #4CAF50', background: '#4CAF5022', color: '#4CAF50', fontWeight: 700 }}
                    >⬇ 담아둔 {collectedAnnotations.length}개 구간 전체 다운로드</button>
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
