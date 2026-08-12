import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Head from 'next/head'
import Link from 'next/link'
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, CollapsibleCard, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'
import { BOLLINGER_BANDS, rollingBollinger, DONCHIAN_CHANNELS, rollingDonchian, MOVING_AVERAGES, MADRID_RIBBON, computeMA, rollingRSI, rollingMACD, rollingStochastic, rollingHMA, rollingWMA, rollingSMA } from '../lib/indicators'

// 이평선 데이터 계산/토글 파이프라인(maDataRef/maSeriesRef/enabledMA 등)은 id로만 구분하므로
// 리본도 같은 파이프라인을 공유한다 - 화면에서만 "리본" 카드로 따로 묶어서 보여준다(사용자 요청).
const ALL_MA = [...MOVING_AVERAGES, ...MADRID_RIBBON]

// 볼린저와 도치안 채널은 상/중/하 3선 구조(bandDataRef/bandSeriesRef/enabledBands 등)를 그대로 공유한다
// - 화면에서만 "볼린저"/"도치안 채널" 카드로 따로 묶어서 보여준다(ALL_MA와 같은 방식).
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

// VerticalLinePrimitive과 같은 방식이지만 시각 하나가 아니라 여러 시각에 동시에 세로선을 그린다.
// 70/15/15 스토캐스틱이 "볼린저 외부 상태에서 %K/%D 크로스" 조건을 만족한 캔들들을 전부 표시할 때 씀.
// 골든/데드크로스마다 색을 다르게 줄 수 있게 setLines({time,color}[])로 받는다(사용자 요청).
class MultiVerticalLinesPrimitive {
  constructor() {
    this._lines = [] // [{time, color}]
    this._chart = null
    this._requestUpdate = null
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
          if (!this._lines.length || !this._chart) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const ratio = scope.horizontalPixelRatio
            ctx.save()
            ctx.lineWidth = 2 // 너무 얇아서 색이 안 보인다는 지적 - 1 -> 2로 두껍게
            ctx.setLineDash([]) // 실선(사용자 요청) - 다른 세로선(리본 발산/수축 표시 등)은 점선이라 명시적으로 초기화
            for (const line of this._lines) {
              const x = ts.timeToCoordinate(line.time)
              if (x == null) continue
              const px = Math.round(x * ratio) + 0.5
              ctx.strokeStyle = line.color
              ctx.beginPath()
              ctx.moveTo(px, 0)
              ctx.lineTo(px, scope.bitmapSize.height)
              ctx.stroke()
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
  setLines(lines) {
    this._lines = lines
    this._requestUpdate?.()
  }
}
const STOCH3_CROSS_GOLDEN_COLOR = '#C6FF00' // 70/15/15 스토캐스틱 골든크로스 세로줄(라임, 사용자 요청)
const STOCH3_CROSS_DEAD_COLOR = '#F44336' // 70/15/15 스토캐스틱 데드크로스 세로줄(레드, 사용자 요청)
const SHOOTING_5MIN_COLOR = '#00E5FF' // "5분 슈팅" 표시 색 - 캔들/다른 신호들과 안 헷갈리게 튀는 시안색(사용자 요청 "잘보이게")

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

// "5분 슈팅"(사용자 요청) - 캔들 위/아래(aboveBar/belowBar)가 아니라 실제로 뚫고 나간 꼬리 끝(정확한
// 고가/저가 가격)에 정확히 찍어야 해서, 기본 markers API 대신 (time, price) 좌표에 직접 그리는
// 프리미티브가 필요하다(학습의 라벨링 마커와 같은 방식).
class ExactPriceMarkersPrimitive {
  constructor(color) {
    this._points = [] // [{time, price}]
    this._color = color
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
          if (!this._chart || !this._series || !this._points.length) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const hRatio = scope.horizontalPixelRatio
            const vRatio = scope.verticalPixelRatio
            ctx.save()
            ctx.fillStyle = this._color
            ctx.strokeStyle = '#0f1115'
            ctx.lineWidth = 1 * hRatio
            const r = 3.5 * hRatio
            for (const p of this._points) {
              const x = ts.timeToCoordinate(p.time)
              const y = this._series.priceToCoordinate(p.price)
              if (x == null || y == null) continue
              const px = x * hRatio, py = y * vRatio
              ctx.beginPath()
              ctx.arc(px, py, r, 0, Math.PI * 2)
              ctx.fill()
              ctx.stroke()
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
  setPoints(points) {
    this._points = points
    this._requestUpdate?.()
  }
  setColor(color) {
    this._color = color
    this._requestUpdate?.()
  }
}

// 업로드 매매내역의 "이탈"/롱·숏 진입 화살표가 캔들 옆(aboveBar/belowBar)에 붙으면 다른 캔들·신호에
// 묻혀 잘 안 보인다는 지적(사용자 요청) - 캔들 가격과 무관하게 pane 맨 위/맨 아래 가장자리에 고정으로
// 그린다. 청산(exit) 마커도 같은 방식(추가 요청). 이탈/진입이 같은 방향(edge)에 몰릴 때(예: 하단회귀는
// 이탈도 하단, 진입도 하단) 서로 겹쳐서 화살표가 안 보이는 문제가 있어 row로 세로 단을 나눠 그린다
// (0=가장자리에 가장 가까움=이탈, 1=그 안쪽=진입/청산).
class EdgeMarkersPrimitive {
  constructor() {
    this._points = [] // [{time, edge:'top'|'bottom', row, color, shape:'arrowUp'|'arrowDown'|'circle', text}]
    this._chart = null
    this._requestUpdate = null
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
          if (!this._chart || !this._points.length) return
          const ts = this._chart.timeScale()
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const hRatio = scope.horizontalPixelRatio
            const vRatio = scope.verticalPixelRatio
            const margin = 18 * vRatio
            const rowGap = 34 * vRatio
            ctx.save()
            ctx.textAlign = 'center'
            ctx.font = `bold ${Math.round(13 * vRatio)}px sans-serif` // 글씨/화살표 크기 키움(사용자 요청)
            ctx.strokeStyle = '#0f1115'
            ctx.lineWidth = 1.3 * hRatio
            const lineHeight = 15 * vRatio
            for (const p of this._points) {
              const x = ts.timeToCoordinate(p.time)
              if (x == null) continue
              const px = x * hRatio
              // textLines: 줄마다 다른 색을 섞어 쓸 때 씀 - 한 줄 = [{text,color}, ...] 세그먼트 배열
              // (예: 나쁜조합 경고는 "⚠" 아이콘 세그먼트만 빨강, 같은 줄의 가격 세그먼트는 방향색
              // 그대로). {text,color} 객체를 바로 줄로 줘도 세그먼트 1개짜리로 취급한다. 없으면
              // text를 줄바꿈으로 나눠 전부 p.color 세그먼트 1개짜리 줄로 그린다.
              const lines = (p.textLines || (p.text ? p.text.split('\n').map(t => ({ text: t, color: p.color })) : []))
                .map(l => Array.isArray(l) ? l : [l])
              // 텍스트가 가장자리에 가장 가깝고, 화살표/원은 그 텍스트 블록 너머(가장자리 반대쪽, pane
              // 안쪽)에 그린다 - 아래쪽 가장자리에서 화면을 위→아래로 읽으면 화살표가 맨 처음, 위쪽
              // 가장자리에서는 반대로 화살표가 맨 마지막에 오게 됨(사용자 요청).
              const edgeAnchor = margin + (p.row || 0) * rowGap
              const shapeDist = edgeAnchor + lines.length * lineHeight
              const toY = (distFromEdge) => p.edge === 'top' ? distFromEdge : scope.bitmapSize.height - distFromEdge
              const py = toY(shapeDist)
              ctx.fillStyle = p.color
              ctx.beginPath()
              if (p.shape === 'circle') {
                ctx.arc(px, py, 6 * vRatio, 0, Math.PI * 2)
              } else {
                const w = 7 * hRatio, h = 11 * vRatio
                if (p.shape === 'arrowUp') {
                  ctx.moveTo(px, py - h / 2)
                  ctx.lineTo(px - w, py + h / 2)
                  ctx.lineTo(px + w, py + h / 2)
                } else {
                  ctx.moveTo(px, py + h / 2)
                  ctx.lineTo(px - w, py - h / 2)
                  ctx.lineTo(px + w, py - h / 2)
                }
                ctx.closePath()
              }
              ctx.fill()
              ctx.stroke()
              lines.forEach((segments, i) => {
                const ty = toY(edgeAnchor + i * lineHeight)
                ctx.textAlign = 'left'
                const widths = segments.map(s => ctx.measureText(s.text).width)
                let sx = px - widths.reduce((a, b) => a + b, 0) / 2
                segments.forEach((s, si) => {
                  ctx.fillStyle = s.color
                  ctx.fillText(s.text, sx, ty)
                  sx += widths[si]
                })
                ctx.textAlign = 'center'
              })
            }
            ctx.restore()
          })
        },
      }),
    }]
  }
  setPoints(points) {
    this._points = points
    this._requestUpdate?.()
  }
}

const SUPABASE_URL = process.env.NEXT_PUBLIC_SUPABASE_URL || 'https://ztrdgcebsxbhtckstlhn.supabase.co'
const BUCKET = 'backtest-data'

const SYMBOL_LABEL = { GOLD: '🥇 골드', NASDAQ: '💻 나스닥' }
// x1 = 실제 1분봉 그대로(캔들 1개 = 60초). 다른 배속은 전부 이 기준의 배수.
const SPEEDS = [1, 2, 3, 5, 20, 60, 100, 200, 300] // x0.25/x0.5는 너무 느려서 뺌(사용자 요청)
// x1 = 1분봉 1개당 실제 60초(실제 시세 속도) - 사용자 확정. 되돌림(1000으로 바꿨던 건 잘못된 추측이었음).
const REALTIME_MS = 60000
// 날짜를 새로 불러왔을 때 화면에 기본으로 보여줄 캔들 개수(줌 레벨) - 원래 코드도 이 값을 60으로
// 의도했었지만, applyIndex()의 setData() 직후 auto-fit된(수백 개짜리) 범위를 그대로 읽어버리는 버그
// 때문에 한 번도 실제로 적용된 적이 없었다(그래서 X축이 항상 15분 단위로 뭉개져 보였다 - 실측 확인).
// 이 상수 자체가 정확히 5분 눈금을 만드는지는 아직 화면으로 재확인 못 했다 - 캔들당 픽셀이 이전보다는
// 훨씬 넓어지니 나아질 것으로 예상하지만, 라이브러리 내부 임계값을 모르는 채로 하는 추정이라 실제
// 화면에서 여전히 5분이 아니면 이 숫자를 더 줄여야 한다.
const INITIAL_VISIBLE_CANDLES = 60
const MIN_TICK_MS = 50 // setInterval 실질 하한 - 이보다 짧은 간격은 한 틱에 여러 캔들을 진행시켜 흉내낸다
// 캔들 타이머 표시용 - ms를 "1:05" 또는 "48.2초" 형태로 포맷. 1분 이상이면 분:초, 아니면 소수점 1자리 초.
const formatCandleTimer = (ms) => {
  const totalSec = Math.max(0, ms / 1000)
  if (totalSec >= 60) {
    const m = Math.floor(totalSec / 60)
    const s = Math.floor(totalSec % 60)
    return `${m}:${String(s).padStart(2, '0')}`
  }
  return `${totalSec.toFixed(1)}초`
}
const MA_WIDTHS = [1, 2, 3, 4]
const RSI_PERIOD = 14
const MACD_FAST = 12
const MACD_SLOW = 26
const MACD_SIGNAL = 9
// MACD5 = "5분" MACD - 볼린저/이평선과 같은 멀티 타임프레임 치환 규칙(1분봉 기준 기간 × 5)을 그대로 적용
const MACD5_FAST = 60
const MACD5_SLOW = 130
const MACD5_SIGNAL = 45
// 스토캐스틱 3세트(사용자 요청 그대로): [kPeriod, kSmooth(Slow%K), dPeriod(%D)]
const STOCH1_PARAMS = [14, 3, 3]
const STOCH2_PARAMS = [7, 2, 2]
const STOCH3_PARAMS = [70, 15, 15]
// EasyTrade_MT5 데스크톱 앱의 "분리매매창" 골드/나스닥 탭 반자동 예약(3/4번 신호)이 쓰는
// 1분 스토캐스틱 - _MarketDataWorker의 _ta.stoch(k=5, d=3, smooth_k=3)와 동일 (kPeriod,kSmooth,dPeriod 순)
const STOCH_RESERVE_PARAMS = [5, 3, 3]

// 분리매매창(PyQt "매매 실행" 창) 색상 팔레트 - EasyTrade_MT5 1_1_trading_window.py /
// trading_window_tabs/{strategy1_tab,hma_reservation_tab,nas100_tab}.py의 setStyleSheet 값 그대로.
const TW_SHORT_OFF = '#F44336', TW_SHORT_OFF_HOVER = '#D32F2F'
const TW_SHORT_ON = '#7F0000'
const TW_LONG_OFF = '#4CAF50', TW_LONG_OFF_HOVER = '#388E3C'
const TW_LONG_ON = '#1B5E20'
const TW_STATUS_OFF = { bg: '#EEEEEE', border: '#BDBDBD' }
const TW_STATUS_YELLOW = { bg: '#FBC02D', border: '#F57F17' }
const TW_STATUS_ORANGE = { bg: '#FB8C00', border: '#E65100' }
const TW_STATUS_BLUE_A = { bg: '#1976D2', border: '#0D47A1' }
const TW_STATUS_BLUE_B = { bg: '#90CAF9', border: '#1976D2' }
const TW_STATUS_PINK_A = { bg: '#D81B60', border: '#880E4F' }
const TW_STATUS_PINK_B = { bg: '#F48FB1', border: '#D81B60' }
const TW_READY_OFF = { color: '#757575', border: '#BDBDBD' }
const TW_TEXT_GRAY = '#9E9E9E', TW_TEXT_ORANGE = '#FB8C00', TW_TEXT_BLUE = '#1976D2', TW_TEXT_PINK = '#D81B60'
const TW_MOVE_SL_OFF = '#BDBDBD', TW_MOVE_SL_ON = '#FF9800', TW_MOVE_SL_ON_HOVER = '#F57C00'

// 골드/나스닥 탭 "🎯 반자동 예약" 1~6번 신호 - hma_reservation_tab.py/nas100_tab.py와 동일한 로직을
// 리플레이가 이미 로드해둔 fullRows(1분봉)로 재현한다. 실시간 MT5 조회 대신, 구간 전체를 한 번에
// 훑어서 신호별 발생 지점을 미리 계산해두고(반자동/시뮬레이션 크로스와 같은 방식) 재생 중 그 구간에
// 들어올 때 무장 여부를 확인해 발동시킨다.
//   H1=1분HMA(20) H3=3분HMA(60) H100=5분HMA(100) H300=15분HMA(300)
//   WMA17(1분)/SMA20(1분), WMA85(5분)/SMA100(5분), WMA255(15분)/SMA300(15분)
//   1번은 5분 볼린저(SMA100 밴드) 바깥→안쪽 재진입으로 무장 후 H1×H3 크로스로 진입(무장 상태는
//   가격 데이터만으로 결정되므로 전 구간을 한 번에 순차 계산 가능 - 아래 row1Armed 배열).
function computeReservationSeries(fullRows) {
  const closes = fullRows.map(r => r.close)
  const h1 = rollingHMA(closes, 20)
  const h3 = rollingHMA(closes, 60)
  const h100 = rollingHMA(closes, 100)
  const h300 = rollingHMA(closes, 300)
  const wma17_1m = rollingWMA(closes, 17)
  const sma20_1m = rollingSMA(closes, 20)
  const wma85 = rollingWMA(closes, 85)
  const sma100 = rollingSMA(closes, 100)
  const wma255 = rollingWMA(closes, 255)
  const sma300 = rollingSMA(closes, 300)
  const { ups: bbUp, lows: bbLo } = rollingBollinger(closes, 100)
  const stoch = rollingStochastic(fullRows, ...STOCH_RESERVE_PARAMS)
  const stochGolden = closes.map((_, i) => (stoch.k[i] != null && stoch.d[i] != null) ? stoch.k[i] > stoch.d[i] : null)

  // 1번 신호 무장 상태 - 가격이 5분 볼린저(SMA100) 바깥에서 안쪽으로 재진입하면 무장, 다시 벗어나면 해제.
  // 순수하게 가격 이력만으로 정해지는 값이라 체크박스/재생 여부와 무관하게 구간 전체를 한 번에 계산해둔다.
  const row1Armed = new Array(fullRows.length).fill(null)
  let armed = null
  for (let i = 0; i < fullRows.length; i++) {
    const up = bbUp[i], lo = bbLo[i]
    if (i > 0 && up != null && lo != null) {
      const pPrice = closes[i - 1], price = closes[i]
      if (pPrice < lo && price >= lo) armed = 'below'
      else if (pPrice > up && price <= up) armed = 'above'
      else if (price < lo || price > up) armed = null
    }
    row1Armed[i] = armed
  }

  return { closes, h1, h3, h100, h300, wma17_1m, sma20_1m, wma85, sma100, wma255, sma300, bbUp, bbLo, stochGolden, row1Armed }
}

// computeReservationSeries의 배열들을 훑어서 신호별 발생 이벤트를 dayRows 기준 idx(=i-startIdx)로
// 뽑아둔다 - 반자동/시뮬레이션 크로스(autoEventsRef 등)와 완전히 같은 "미리 계산해두고 재생 구간만
// 필터링" 방식. row3/4(상태 조건)는 조건이 참인 매 캔들마다 이벤트를 만들어서, 무장 후 첫 캔들에
// 바로 발동하게 한다(PyQt 쪽도 매초 조건을 그대로 검사하므로 동일).
function computeReservationEvents(S, startIdx, endIdx) {
  const row1 = [], row2 = [], row3 = [], row4 = []
  const row5Entry = [], row5Exit = [], row6Entry = [], row6Exit = [], tp = []
  const { h1, h3, h100, h300, wma17_1m, sma20_1m, wma85, sma100, bbUp, bbLo, stochGolden, row1Armed, closes } = S
  for (let i = Math.max(1, startIdx); i < endIdx; i++) {
    const idx = i - startIdx
    // 1번 + 익절용 순수 H1×H3 크로스
    if (h1[i - 1] != null && h3[i - 1] != null && h1[i] != null && h3[i] != null) {
      const golden = h1[i - 1] <= h3[i - 1] && h1[i] > h3[i]
      const dead = h1[i - 1] >= h3[i - 1] && h1[i] < h3[i]
      if (golden && row1Armed[i] === 'below') row1.push({ idx, side: 'buy' })
      if (dead && row1Armed[i] === 'above') row1.push({ idx, side: 'sell' })
      if (golden) tp.push({ idx, closeSide: 'sell' })  // 골든크로스 → 숏 포지션 청산
      if (dead) tp.push({ idx, closeSide: 'buy' })     // 데드크로스 → 롱 포지션 청산
    }
    // 2번: H3(HMA60) × S5(SMA100)
    if (h3[i - 1] != null && sma100[i - 1] != null && h3[i] != null && sma100[i] != null) {
      if (h3[i - 1] <= sma100[i - 1] && h3[i] > sma100[i]) row2.push({ idx, side: 'buy' })
      if (h3[i - 1] >= sma100[i - 1] && h3[i] < sma100[i]) row2.push({ idx, side: 'sell' })
    }
    // 3/4번: 상태 조건(WMA85 vs SMA100, 1분스토, 가격/HMA20, HMA300 방향)
    if (wma85[i] != null && sma100[i] != null && h1[i] != null && h1[i - 1] != null &&
        h300[i] != null && h300[i - 1] != null && stochGolden[i] != null) {
      const buyOk = wma85[i] > sma100[i] && stochGolden[i] === true && closes[i] > h1[i] &&
        h1[i] > h1[i - 1] && h300[i] > h300[i - 1]
      const sellOk = wma85[i] < sma100[i] && stochGolden[i] === false && closes[i] < h1[i] &&
        h1[i] < h1[i - 1] && h300[i] < h300[i - 1]
      if (buyOk) row3.push({ idx, side: 'buy' })
      if (sellOk) row4.push({ idx, side: 'sell' })
    }
    // 5번 진입: HMA60>HMA100(상태) & HMA20×SMA20 골든크로스(이벤트)
    if (h1[i - 1] != null && sma20_1m[i - 1] != null && h1[i] != null && sma20_1m[i] != null) {
      const goldenCross = h1[i - 1] <= sma20_1m[i - 1] && h1[i] > sma20_1m[i]
      if (goldenCross && h3[i] != null && h100[i] != null && h3[i] > h100[i]) row5Entry.push({ idx, side: 'buy' })
    }
    // 5번 청산: HMA20×HMA100 데드크로스 (항상 감시)
    if (h1[i - 1] != null && h100[i - 1] != null && h1[i] != null && h100[i] != null) {
      if (h1[i - 1] >= h100[i - 1] && h1[i] < h100[i]) row5Exit.push({ idx })
    }
    // 6번 진입: HMA20<SMA20(상태) & HMA60×HMA100 데드크로스(이벤트)
    if (h3[i - 1] != null && h100[i - 1] != null && h3[i] != null && h100[i] != null) {
      const deadCross = h3[i - 1] >= h100[i - 1] && h3[i] < h100[i]
      if (deadCross && h1[i] != null && sma20_1m[i] != null && h1[i] < sma20_1m[i]) row6Entry.push({ idx, side: 'sell' })
    }
    // 6번 청산: HMA20×HMA60 골든크로스 (항상 감시)
    if (h1[i - 1] != null && h3[i - 1] != null && h1[i] != null && h3[i] != null) {
      if (h1[i - 1] <= h3[i - 1] && h1[i] > h3[i]) row6Exit.push({ idx })
    }
  }
  return { row1, row2, row3, row4, row5Entry, row5Exit, row6Entry, row6Exit, tp }
}
const DEFAULT_RSI_COLOR = '#FFB74D'
const DEFAULT_MACD_LINE_COLOR = '#42A5F5'
const DEFAULT_MACD_SIGNAL_COLOR = '#FF7043'
const DEFAULT_MACD_HIST_UP = '#26A69A'
const DEFAULT_MACD_HIST_DOWN = '#EF5350'
const DEFAULT_MACD5_LINE_COLOR = '#AB47BC'
const DEFAULT_MACD5_SIGNAL_COLOR = '#FFCA28'
// 스토캐스틱 3세트 기본 색상 (사용자 요청: 1번 블루/레드, 2번 옐로우/화이트, 3번 오렌지/화이트)
const DEFAULT_STOCH1_K_COLOR = '#2196F3'
const DEFAULT_STOCH1_D_COLOR = '#F44336'
const DEFAULT_STOCH2_K_COLOR = '#FFEB3B'
const DEFAULT_STOCH2_D_COLOR = '#FFFFFF'
const DEFAULT_STOCH3_K_COLOR = '#FF9800'
const DEFAULT_STOCH3_D_COLOR = '#FFFFFF'
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
const REPLAY_STATE_KEY = 'replayChartState'
// 지표/색상/굵기/모양 등 "차트 표시 설정" 전체는 localStorage에 저장(사용자 요청) - 새로고침은 물론
// 브라우저를 완전히 닫았다 열어도 유지된다(위 REPLAY_STATE_KEY는 심볼/날짜/재생위치 같은 "지금 뭘
// 보고 있었는지" 세션 복귀용이라 성격이 달라서 별도 키로 분리 유지).
const REPLAY_SETTINGS_KEY = 'replayChartSettings'

export default function ReplayChart() {
  // 마운트 시 딱 한 번만 sessionStorage를 읽어서 ref에 담아둔다(렌더 중 계산이라 useEffect보다 먼저 값이 준비됨).
  const restoreRef = useRef(undefined)
  if (restoreRef.current === undefined) {
    restoreRef.current = null
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem(REPLAY_STATE_KEY)
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
        const raw = window.localStorage.getItem(REPLAY_SETTINGS_KEY)
        if (raw) settingsRestoreRef.current = JSON.parse(raw)
      } catch { /* 저장된 값이 깨져있으면 무시하고 기본값으로 시작 */ }
    }
  }
  const rs = settingsRestoreRef.current || {}
  const hasAutoRestoredRef = useRef(false)

  const [symbol, setSymbol] = useState('NASDAQ') // 기본값을 항상 나스닥으로 - 이전 세션에서 골드를 보고 있었어도 새로 열면 나스닥부터 시작(사용자 요청)
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
  const [speed, setSpeed] = useState(20) // 기본 배속(사용자 요청) - x20 = 캔들 1개당 3초
  // 다음 캔들이 그려질 때까지 남은 시간(ms) - 재생 중엔 REALTIME_MS/speed에서 0으로 카운트다운하다가
  // 실제로 캔들이 그려지는 순간 다시 꽉 채워진다. 재생을 멈추거나 배속을 바꾸면 그 배속 기준 풀타임으로 리셋.
  const [candleTimerMs, setCandleTimerMs] = useState(REALTIME_MS / speed)
  // 캔들 타이머 배지가 화면에서 위치할 좌표(차트 컨테이너 기준 px) - 마지막으로 그려진 캔들(재생 위치)의
  // 시각/가격을 좌표로 변환해서 구한다. null이면(범위 밖으로 스크롤됐거나 아직 데이터 없음) 숨긴다.
  const [timerAnchor, setTimerAnchor] = useState(null)
  const [playIndex, setPlayIndex] = useState(0)
  const [total, setTotal] = useState(0)
  // 기본 셋팅(사용자 요청) - 1분 볼린저는 중간선만, 5분/15분/1시간 볼린저는 전체 표시
  // (아래 전부 rs.필드명 ?? 기본값 형태 - localStorage에 저장된 값이 있으면 그걸로 시작, 없으면 기존 기본값)
  const [enabledBands, setEnabledBands] = useState(rs.enabledBands ?? { sma20: true, sma100: true, sma300: true, sma1200: true })
  const [lineVisibility, setLineVisibility] = useState(rs.lineVisibility ?? {}) // `${bandId}:${upper|middle|lower}` -> false면 숨김 (기본 true, 1분B 상/하도 기본 켜짐 - 사용자 요청)
  const [bandColors, setBandColors] = useState(rs.bandColors ?? {}) // bandId -> 커스텀 색상 (없으면 BOLLINGER_BANDS 기본색)
  // 기본 셋팅 - 3분/5분/15분 H, 1분/5분 W17, 1시간 W4 이평선 체크
  const [enabledMA, setEnabledMA] = useState(rs.enabledMA ?? {
    hma20: true, hma60: true, hma100: true, hma300: true, wma17_1m: true, wma17_5m: true, wma4_1h: true,
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
  // 스토캐스틱 3세트 - 14/3/3, 7/2/2, 70/15/15(사용자 요청). 70/15/15는 "5분B 볼린저 외부 상태에서
  // K/D 크로스" 조건을 만족하면 세로줄도 같이 표시한다(아래 stoch3CrossTimesRef/토글 함수 참고).
  const [enabledStoch1, setEnabledStoch1] = useState(rs.enabledStoch1 ?? true)
  const [stoch1KColor, setStoch1KColorState] = useState(rs.stoch1KColor ?? DEFAULT_STOCH1_K_COLOR)
  const [stoch1DColor, setStoch1DColorState] = useState(rs.stoch1DColor ?? DEFAULT_STOCH1_D_COLOR)
  const [enabledStoch2, setEnabledStoch2] = useState(rs.enabledStoch2 ?? true)
  const [stoch2KColor, setStoch2KColorState] = useState(rs.stoch2KColor ?? DEFAULT_STOCH2_K_COLOR)
  const [stoch2DColor, setStoch2DColorState] = useState(rs.stoch2DColor ?? DEFAULT_STOCH2_D_COLOR)
  const [enabledStoch3, setEnabledStoch3] = useState(rs.enabledStoch3 ?? true)
  const [stoch3KColor, setStoch3KColorState] = useState(rs.stoch3KColor ?? DEFAULT_STOCH3_K_COLOR)
  const [stoch3DColor, setStoch3DColorState] = useState(rs.stoch3DColor ?? DEFAULT_STOCH3_D_COLOR)
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
  // "5분 슈팅"(사용자 요청) - 고가/저가가 5분 볼린저를 조금이라도 뚫고 나간 지점을 꼬리 끝(정확한
  // 가격)에 표시. 기본 항상 체크(사용자 요청).
  const [shooting5MinEnabled, setShooting5MinEnabled] = useState(rs.shooting5MinEnabled ?? true)
  // 매매 연습 - 헤징 허용(바이/셀 동시 보유 가능), 수수료/스프레드는 계산 안 함
  const [startingBalance, setStartingBalanceState] = useState(rs.startingBalance ?? DEFAULT_STARTING_BALANCE)
  const [balance, setBalance] = useState(DEFAULT_STARTING_BALANCE)
  const [lotSize, setLotSize] = useState(rs.lotSize ?? 0.01)
  const [positions, setPositions] = useState([]) // { id, side:'buy'|'sell', symbol, lot, entryPrice, entryTime }
  const [pnlDisplay, setPnlDisplay] = useState(rs.pnlDisplay ?? 'dollar') // 'dollar' | 'point'

  // 분리매매창(EasyTrade_MT5 데스크톱 앱의 "매매 실행" 팝업 그대로 재현) - 공통 입력부 + 매매1/골드/나스닥 탭.
  // 골드/나스닥 탭의 반자동 예약 신호는 리플레이가 지금 로드해둔 심볼(symbol)의 데이터로만 실제 동작한다
  // (데스크톱 앱은 두 탭이 각자 독립적으로 MT5에서 실시간 데이터를 받아오지만, 리플레이는 한 번에 한
  // 심볼만 로드하므로 다른 심볼 탭은 대기 상태로 표시만 됨).
  const [showTradingWindow, setShowTradingWindow] = useState(false)
  const [twPos, setTwPos] = useState({ x: 80, y: 80 })
  const [twTab, setTwTab] = useState('strategy1') // 'strategy1' | 'gold' | 'nasdaq'
  const [twSwapped, setTwSwapped] = useState(false)
  const [twLots, setTwLots] = useState(0.01)
  const [twSl, setTwSl] = useState(100)
  const [twTp, setTwTp] = useState(200)
  const [twUseSl, setTwUseSl] = useState(true)
  const [twUseTp, setTwUseTp] = useState(true)
  const [twTpExitCross, setTwTpExitCross] = useState(true) // "✅ 익절: H1×H3 크로스 청산" 기본 체크(원본과 동일 - 체크 시 포인트익절은 자동 꺼짐)
  const [twSkipPopup, setTwSkipPopup] = useState(true)
  // 원본은 체크박스(무장)와 SELL/BUY 방향버튼이 서로 다른 두 개의 토글이다 - 체크박스만 켜도(방향 아직
  // 안 골라도) 설명 박스는 바로 뜨고(_update_desc_label), 실제 발동엔 방향버튼까지 같이 눌려있어야 한다.
  const [twGoldChecked, setTwGoldChecked] = useState(null) // 체크된 행 번호(1~6) | null - 1~6 중 하나만
  const [twGoldDir, setTwGoldDir] = useState(null)         // { row, side } | null - 눌린 방향버튼
  const [twNasdaqChecked, setTwNasdaqChecked] = useState(null)
  const [twNasdaqDir, setTwNasdaqDir] = useState(null)
  const [twBlinkPhase, setTwBlinkPhase] = useState(false) // 600ms 점멸 - _blink_timer 그대로
  const [twPopupEl, setTwPopupEl] = useState(null) // 새 창으로 뺐을 때 그 창 안에 만든 portal 대상 div (없으면 페이지 안 모달로 렌더)
  const twWinRef = useRef(null) // 새 창의 window 객체
  const twOnUnloadRef = useRef(null) // 위 창의 beforeunload 핸들러 참조(다시 붙이기 시 떼어내기 위해 보관)
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

  // 업로드한 매매내역 CSV(Claude가 만든 백테스트 거래 원장)를 차트에 마커로 겹쳐 보기 위한 상태
  const [uploadedTradeFile, setUploadedTradeFile] = useState('')
  const [uploadedTradeCount, setUploadedTradeCount] = useState(0)
  const [showUploadedTrades, setShowUploadedTrades] = useState(true)
  const [uploadedTradeError, setUploadedTradeError] = useState('')
  const [tradeDragOver, setTradeDragOver] = useState(false)
  const [uploadedTradeRows, setUploadedTradeRows] = useState([]) // 현재 불러온 구간 안에 있는 거래 목록(캔들번호 포함) - 마커 찾기 힘들다는 지적으로 추가
  // scrubView()가 화면(카메라) 이동 위치를 기록해두는 내부 상태 - 매매내역 CSV 업로드 시 뜨는 전용
  // 스크럽 슬라이더, 그리고 아래 빨간 바 드래그 둘 다 이 함수를 거쳐가지만 화면에 직접 그리는 값으로는
  // 안 쓴다(빨간 바는 redPos=playIndex를 그린다).
  const [viewScrubPos, setViewScrubPos] = useState(0)
  // 파란 바 - 재생 버튼과는 완전히 무관, 사용자가 직접 드래그할 때만 움직인다. 데이터를 불러오면
  // 항상 맨 끝(total)에 가 있는 상태로 시작(사용자 요청) - setTotal이 바뀌는 4곳에서 같이 맞춰준다.
  const [bluePos, setBluePos] = useState(0)
  // 빨간 바 - 드래그하면 화면(카메라)만 그 시점으로 옮기면서(scrubView, 이미 그려진 캔들은 안 지움)
  // 재생 위치(playIndex) 자체도 그 자리로 옮겨둔다. 손을 떼면 그 자리에 그대로 있고, 그 다음
  // ▶재생을 누르면 거기서부터 이어서 재생된다(재생 버튼을 누르기 전까진 이 값이 곧 재생 위치).
  const redPos = playIndex

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
  const sessionSegmentsRef = useRef({})      // sessionId -> [{startIdx,endIdx,startTime,endTime}]
  const rowsRef = useRef([])
  const intervalRef = useRef(null)
  const nextCandleAtRef = useRef(0)   // 다음 캔들이 그려질 예정 시각(Date.now() 기준 ms) - 캔들 타이머 표시용
  const timerTickRef = useRef(null)   // 캔들 타이머 숫자를 화면에 부드럽게 카운트다운시키는 별도의 짧은 인터벌
  const indexRef = useRef(0)
  // 캔들 시리즈(seriesRef)에 실제로 .update()가 호출된 가장 앞선(마지막) 인덱스 - indexRef/playIndex와는
  // 다르다. playIndex는 "지금 빨간 바가 가리키는 위치"(뒤로 돌려볼 수도 있음)인 반면, 이건 "실제로
  // 화면에 그려진 가장 먼 지점"이다. 이 둘을 분리 안 하고 그냥 playIndex부터 그리면, 빨간 바를
  // 뒤로 드래그했다가 다시 재생했을 때 이미 그려진 것보다 과거 시각을 update()하게 되어
  // lightweight-charts가 "Cannot update oldest data"로 크래시하는 문제가 있었다(실사용 중 재현됨).
  const drawnUpToRef = useRef(0)
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
  const stoch1DataRef = useRef({ k: [], d: [] }) // 각각 [{time,value}|null]
  const stoch1SeriesRef = useRef(null) // { k, d } lightweight-charts 라인 시리즈 2개
  const stoch2DataRef = useRef({ k: [], d: [] })
  const stoch2SeriesRef = useRef(null)
  const stoch3DataRef = useRef({ k: [], d: [] })
  const stoch3SeriesRef = useRef(null)
  const stoch3CrossTimesRef = useRef([]) // [{idx, time}] - 5분B 외부 상태에서 K/D 크로스가 난 지점 전체
  const stoch3CrossLineRef = useRef(null) // MultiVerticalLinesPrimitive 인스턴스(메인 캔들 pane용)
  const stoch3CrossLineStochPaneRef = useRef(null) // 같은 세로줄을 스토캐스틱 pane 쪽에도 하나 더 얹은 인스턴스 - pane은
  // 셋 중 아무거나 처음 켜질 때 생겼다 전부 꺼지면 사라지므로, 이 primitive도 그때그때 새로 만들고 null로 되돌린다.
  const crossPointsRef = useRef([])  // 체크한 이평선끼리 교차하는 지점 전체 [{idx, time, type:'golden'|'dead'}]
  const autoEventsRef = useRef([])   // 반자동진입 트리거 전체 [{idx, time, side:'buy'|'sell', source}]
  const reservationSeriesRef = useRef(null) // computeReservationSeries(fullRows) 결과 - 분리매매창 골드/나스닥 탭 라벨 표시용
  const reservationEventsRef = useRef(null) // computeReservationEvents(...) 결과 - idx는 dayRows 기준
  const reservationSymbolRef = useRef(null) // 위 두 값이 어느 심볼 데이터로 계산됐는지(symbol과 다르면 그 탭은 대기 상태)
  const positionsRef = useRef([]) // applyIncrement가 재생 인터벌의 오래된 클로저에서도 최신 포지션 목록을 읽을 수 있게 미러링
  useEffect(() => { positionsRef.current = positions }, [positions])
  const twDragRef = useRef(null) // 분리매매창 드래그용
  // 분리매매창 [상태] 표시등 점멸 - _blink_timer(600ms)와 동일, 모달이 열려 있을 때만 돈다
  useEffect(() => {
    if (!showTradingWindow) return
    const t = setInterval(() => setTwBlinkPhase(v => !v), 600)
    return () => clearInterval(t)
  }, [showTradingWindow])
  const simEventsRef = useRef([])    // 시뮬레이션 트리거 전체 (반자동과 동일한 구조, 별도 타임라인)
  const sessionPointsRef = useRef([]) // 세계 3대 시장 개장 시각 표시용 [{idx, time, label, color}] - 매매 신호가 아니라 항상 표시하는 고정 참고선
  const shooting5MinPointsRef = useRef([]) // "5분 슈팅" 지점 전체 [{idx, time, price}] - 고가/저가가 5분 볼린저를 뚫은 정확한 가격
  const shooting5MinPrimitiveRef = useRef(null) // ExactPriceMarkersPrimitive 인스턴스
  const rangeAnchorRef = useRef('') // 여러 날 선택 모드에서 첫 번째 클릭(범위 시작)을 임시로 들고 있다가 두 번째 클릭에서 씀
  const closedTradesRef = useRef([]) // 청산된 거래 전체(수동/반자동/시뮬레이션 다 포함, source로 구분) - "결과 저장" 누르면 DB로 보냄
  const uploadedTradesRef = useRef([]) // 업로드한 CSV 원본 거래 전체 [{entryTime, exitTime, dir, entryPrice, exitPrice, exitReason, pnl}]
  const uploadedEdgeMarkersRef = useRef([]) // 이탈/진입/청산 마커 - 현재 구간(rowsRef) 기준 계산, pane 위/아래 가장자리 고정(EdgeMarkersPrimitive)
  const uploadedEdgePrimitiveRef = useRef(null) // EdgeMarkersPrimitive 인스턴스

  const availableDates = useMemo(() => buildAvailableDates(datasets), [datasets])
  // 업로드한 매매내역이 있는 날짜를 달력에서 바로 알아볼 수 있게 강조 표시 (진입 시각 기준 하루씩)
  const uploadedTradeDateColors = useMemo(() => {
    if (!uploadedTradeCount) return undefined
    const colors = {}
    for (const t of uploadedTradesRef.current) colors[toLocalDateStr(t.entryTime)] = '#FFC107'
    return colors
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [uploadedTradeCount, uploadedTradeFile])
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
    drawnUpToRef.current = 0 // 새 데이터 로드 시 "실제로 그려진 지점"도 반드시 같이 리셋 - 안 하면 이전
    // 날짜에서 남은 값이 새 날짜의 캔들 인덱스와 안 맞아서 update() 크래시로 이어졌다(실사용 중 재현됨).
    setPlayIndex(0)
    setTotal(0)
    setBluePos(0)
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
    stoch1DataRef.current = { k: [], d: [] }
    syncStoch1(0)
    stoch2DataRef.current = { k: [], d: [] }
    syncStoch2(0)
    stoch3DataRef.current = { k: [], d: [] }
    stoch3CrossTimesRef.current = []
    syncStoch3(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    reservationSeriesRef.current = null
    reservationEventsRef.current = null
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    uploadedEdgePrimitiveRef.current?.setPoints([])
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

  // 스토캐스틱 pane이 메인 캔들 pane의 6분의 1 높이가 되도록 비율 고정(사용자 요청 - 스토캐스틱이 너무 높았음)
  function applyStochPaneRatio(chart, stochPaneIndex) {
    try {
      chart.panes()[0]?.setStretchFactor(6)
      chart.panes()[stochPaneIndex]?.setStretchFactor(1)
    } catch (e) { /* 차트/pane이 아직 준비 안 됐을 수 있음 */ }
  }

  // 차트 인스턴스는 한 번만 생성
  useEffect(() => {
    if (!containerRef.current) return
    const chart = createChart(containerRef.current, {
      width: containerRef.current.clientWidth,
      height: 750,
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

    stoch3CrossLineRef.current = new MultiVerticalLinesPrimitive()
    series.attachPrimitive(stoch3CrossLineRef.current)

    shooting5MinPrimitiveRef.current = new ExactPriceMarkersPrimitive(SHOOTING_5MIN_COLOR)
    series.attachPrimitive(shooting5MinPrimitiveRef.current)

    uploadedEdgePrimitiveRef.current = new EdgeMarkersPrimitive()
    series.attachPrimitive(uploadedEdgePrimitiveRef.current)

    sidewaysBandRef.current = new BackgroundBandsPrimitive(hexToRgba(sidewaysColor, 0.15))
    series.attachPrimitive(sidewaysBandRef.current)

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

    // 스토캐스틱 3세트도 볼린저/이평선처럼 기본 체크(사용자 요청) - 마운트 시점에 켜져 있는 것만 여기서 직접 만든다.
    // 셋이 같은 pane을 공유하므로 pane index는 한 번만 잡고, 세로줄(stoch3CrossLineStochPaneRef)은 그 pane에 딱 하나만 붙인다.
    if (enabledStoch1 || enabledStoch2 || enabledStoch3) {
      const stochPaneIndex = chart.panes().length
      let firstStochKSeries = null
      if (enabledStoch1) {
        stoch1SeriesRef.current = {
          k: chart.addSeries(LineSeries, { color: stoch1KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
          d: chart.addSeries(LineSeries, { color: stoch1DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
        }
        firstStochKSeries = firstStochKSeries || stoch1SeriesRef.current.k
      }
      if (enabledStoch2) {
        stoch2SeriesRef.current = {
          k: chart.addSeries(LineSeries, { color: stoch2KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
          d: chart.addSeries(LineSeries, { color: stoch2DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
        }
        firstStochKSeries = firstStochKSeries || stoch2SeriesRef.current.k
      }
      if (enabledStoch3) {
        stoch3SeriesRef.current = {
          k: chart.addSeries(LineSeries, { color: stoch3KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
          d: chart.addSeries(LineSeries, { color: stoch3DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
        }
        firstStochKSeries = firstStochKSeries || stoch3SeriesRef.current.k
      }
      if (firstStochKSeries) {
        stoch3CrossLineStochPaneRef.current = new MultiVerticalLinesPrimitive()
        firstStochKSeries.attachPrimitive(stoch3CrossLineStochPaneRef.current)
      }
      applyStochPaneRatio(chart, stochPaneIndex)
    }

    markerSeriesRef.current = chart.addSeries(LineSeries, {
      color: 'rgba(0,0,0,0)', lineWidth: 1,
      lastValueVisible: false, priceLineVisible: false, crosshairMarkerVisible: false,
    })
    markersPrimitiveRef.current = createSeriesMarkers(markerSeriesRef.current, [])

    // applyOptions({width})는 이 차트처럼 pane이 여러 개(캔들+RSI+MACD+스토캐스틱)일 때 서브pane
    // 캔버스까지는 안 따라가는 경우가 실측으로 확인됐다 - chart.resize(w,h)가 라이브러리가 명시하는
    // 정식 전체 리사이즈 API라 이걸로 통일한다.
    // forceRepaint(3번째 인자)를 true로 줘야 캔버스 내부 그리기 버퍼(width/height 속성 - CSS 크기와는
    // 별개로 실제 해상도를 결정하는 값)가 그 자리에서 바로 재할당된다. 이걸 안 주면 CSS 크기(화면에
    // 보이는 크기)는 986px로 맞게 바뀌어도 내부 버퍼는 라이브러리 기본값(300x150)에 그대로 남아있어서,
    // 브라우저가 300px짜리 그림을 986px로 늘려 그리는 바람에 실제로 그려지는 캔들 개수가 확 줄어
    // "차트가 중간에서 끊긴 것처럼" 보이는 문제가 있었다(실측으로 확인).
    const onResize = () => chart.resize(containerRef.current.clientWidth, 750, true)
    window.addEventListener('resize', onResize)
    // 브라우저 창 자체를 resize할 때만 반응하는 위 리스너로는 부족했다 - 왼쪽 사이드바(달력/체크박스
    // 카드들)의 레이아웃이 차트 생성 시점 이후에 자리잡으면서 컨테이너 폭이 나중에 바뀌는 경우
    // (또는 생성 시점에 아직 0이었던 경우) 창을 실제로 리사이즈하기 전까진 차트가 라이브러리 기본값
    // (300x150)에 눌어붙어 비율이 다 깨진 채로 남아있었다(사용자가 실측으로 발견) - ResizeObserver로
    // 컨테이너 자체의 크기 변화를 직접 감시해서 항상 실제 폭에 맞춘다.
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w) { chart.resize(w, 750, true); updateTimerAnchor() }
    })
    ro.observe(containerRef.current)

    // 캔들 타이머 배지 위치 - 화면을 드래그/줌하면(시각→x좌표 매핑이 바뀌므로) 캔들은 그대로여도
    // 화면상 위치는 움직여야 한다. 보이는 범위가 바뀔 때마다 다시 계산한다.
    const onVisibleRangeChange = () => updateTimerAnchor()
    chart.timeScale().subscribeVisibleLogicalRangeChange(onVisibleRangeChange)

    return () => {
      window.removeEventListener('resize', onResize)
      ro.disconnect()
      chart.timeScale().unsubscribeVisibleLogicalRangeChange(onVisibleRangeChange)
      chart.remove()
    }
  }, [])

  const stopPlayback = useCallback(() => {
    setPlaying(false)
    if (intervalRef.current) { clearInterval(intervalRef.current); intervalRef.current = null }
    setCandleTimerMs(REALTIME_MS / speed) // 멈추면 캔들 타이머도 그 배속 기준 풀타임으로 리셋
  }, [speed])

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

  // 스토캐스틱 3세트 - RSI/MACD와 같은 방식으로 재생 위치(idx)까지만 그린다
  const applyStoch1Index = (idx) => {
    const s = stoch1SeriesRef.current
    const d = stoch1DataRef.current
    if (!s) return
    s.k.setData(d.k.slice(0, idx).filter(Boolean))
    s.d.setData(d.d.slice(0, idx).filter(Boolean))
  }
  const syncStoch1 = (idx) => applyStoch1Index(idx)

  const applyStoch2Index = (idx) => {
    const s = stoch2SeriesRef.current
    const d = stoch2DataRef.current
    if (!s) return
    s.k.setData(d.k.slice(0, idx).filter(Boolean))
    s.d.setData(d.d.slice(0, idx).filter(Boolean))
  }
  const syncStoch2 = (idx) => applyStoch2Index(idx)

  // 70/15/15 스토캐스틱 - K/D 라인뿐 아니라 "5분B 외부 상태에서 크로스" 세로줄도 재생 위치까지만 표시
  const applyStoch3Index = (idx) => {
    const s = stoch3SeriesRef.current
    const d = stoch3DataRef.current
    if (s) {
      s.k.setData(d.k.slice(0, idx).filter(Boolean))
      s.d.setData(d.d.slice(0, idx).filter(Boolean))
    }
    const lines = stoch3CrossTimesRef.current.filter(p => p.idx < idx).map(p => ({ time: p.time, color: p.color }))
    stoch3CrossLineRef.current?.setLines(lines)
    stoch3CrossLineStochPaneRef.current?.setLines(lines)
  }
  const syncStoch3 = (idx) => applyStoch3Index(idx)
  const syncMACD5 = (idx) => applyMACD5Index(idx)

  // 업로드한 매매내역 CSV 청산사유별 마커 색상 (익절=흰색, 손절=빨강, 크로스전환=주황, 사용자 지정)
  const uploadedExitColor = (reason) => {
    if (reason.startsWith('TP')) return '#FFFFFF'
    if (reason.startsWith('SL')) return '#F44336'
    if (reason.startsWith('flip')) return '#FF9800'
    return '#9E9E9E'
  }
  // 청산 마커에 "몇 번 거래의 익절/손절인지" 같이 적어달라는 요청 - 색상만으론 구분이 안 보일 때 대비
  const uploadedExitLabel = (reason) => {
    if (reason.startsWith('SL')) return '손절'
    if (reason.startsWith('TP')) return '익절'
    if (reason.startsWith('flip')) return '전환'
    return reason
  }

  // Claude가 만들어주는 백테스트 거래 CSV 형식 그대로 파싱한다:
  // 진입날짜,진입시간,방향,진입가,청산날짜,청산시간,청산가,보유시간(분),청산사유,손익(pt)
  // 날짜+시간은 브라우저 로컬(한국시간)로 해석 - 이 차트의 캔들 시간도 이미 한국시간 기준이라 그대로 맞아떨어진다.
  const parseTradeCsv = (text) => {
    const lines = text.replace(/^﻿/, '').split(/\r?\n/).filter(l => l.trim().length > 0)
    if (lines.length < 2) return []
    // 헤더 이름으로 컬럼 위치를 찾는다 - "조합분류,조합,1차분류,2차분류,3차분류" 같은 컬럼이
    // 앞에 추가로 붙어도 그대로 지원하기 위함. 헤더에 이름이 없으면(옛 포맷) 기존 고정 위치를 그대로 씀.
    const headerCols = lines[0].split(',').map(h => h.trim())
    const idxOf = (name, fallback) => { const i = headerCols.indexOf(name); return i >= 0 ? i : fallback }
    const iEntryDate = idxOf('진입날짜', 0)
    const iEntryTime = idxOf('진입시간', 1)
    const iDir = idxOf('방향', 2)
    const iEntryPrice = idxOf('진입가', 3)
    const iExitDate = idxOf('청산날짜', 4)
    const iExitTime = idxOf('청산시간', 5)
    const iExitPrice = idxOf('청산가', 6)
    const iExitReason = idxOf('청산사유', 8)
    const iPnl = idxOf('손익(pt)', 9)
    const iBreakoutDate = idxOf('이탈날짜', 10)
    const iBreakoutTime = idxOf('이탈시각', 11)
    const iBreakoutDir = idxOf('이탈방향', 12)
    const iComboLabel = headerCols.indexOf('조합분류') // 없으면 -1 (옛 파일엔 없는 컬럼)
    const iCombo = headerCols.indexOf('조합')
    const iNum = headerCols.indexOf('전체관리번호') // 파일 전체 기준 고유번호 - 날짜마다 리셋되는 화면의 "#캔들번호"와 다름(사용자 지적)
    const iDateNum = headerCols.indexOf('날짜관리번호') // "YYMMDD#그날캔들순번" 형식(예: 260422#104)
    const iPattern = headerCols.indexOf('4차분류(진입패턴)') // 상단돌파/상단회귀/하단돌파/하단회귀 - "조합"엔 B/S/R(볼린저/스토/리본)만 들어있고 패턴은 따로 분리됨
    const minCols = Math.max(iEntryDate, iEntryTime, iDir, iEntryPrice, iExitDate, iExitTime, iExitPrice, iExitReason, iPnl) + 1

    const trades = []
    for (let i = 1; i < lines.length; i++) {
      const cols = lines[i].split(',')
      if (cols.length < minCols) continue
      const entryDate = cols[iEntryDate], entryTime = cols[iEntryTime], dir = cols[iDir], entryPrice = cols[iEntryPrice]
      const exitDate = cols[iExitDate], exitTime = cols[iExitTime], exitPrice = cols[iExitPrice]
      const exitReason = cols[iExitReason], pnl = cols[iPnl]
      const entryMs = new Date(`${entryDate}T${entryTime}`).getTime()
      const exitMs = new Date(`${exitDate}T${exitTime}`).getTime()
      if (Number.isNaN(entryMs) || Number.isNaN(exitMs)) continue
      // CSV는 서버(API)가 UTC 환경에서 계산한 시각을 한국시간 문자열로 적어 넘긴 것.
      // 이 페이지의 캔들 시간(rowsRef)은 브라우저(KST)에서 직접 계산돼서 서버와 정확히
      // 9시간(32400초) 차이가 난다 - 같은 캔들을 원본 CSV로 직접 대조해서 확인한 값.
      // 그 오차를 여기서 보정해야 실제 로드된 캔들 시간과 정확히 맞아떨어진다.
      // ⚠ 나스닥_전체분류_*.csv/xlsx(Downloads 루트)의 진입/청산/이탈 시각도 이 -9시간 보정을
      // 전제로 미리 +9시간을 더해서 저장돼 있다 - CSV를 직접 열어서 "몇 시 거래냐"를 사용자에게
      // 답할 때 그 값을 그대로 읽으면 오답(실제 KST 시각은 -9시간 해야 나옴). 나스닥_시뮬레이션_
      // 조건.txt 8번 항목 참고, 2026-08-10에 이거 빼먹고 답해서 지적받음.
      const SERVER_BROWSER_TZ_OFFSET_SEC = 9 * 3600
      // 이탈날짜/이탈시각/이탈방향은 선택 항목 - 크로스전환 진입은 원래 비어있다.
      let breakoutTime = null
      const breakoutDate = cols[iBreakoutDate], breakoutTimeStr = cols[iBreakoutTime]
      if (breakoutDate && breakoutTimeStr) {
        const breakoutMs = new Date(`${breakoutDate}T${breakoutTimeStr}`).getTime()
        if (!Number.isNaN(breakoutMs)) breakoutTime = Math.floor(breakoutMs / 1000) - SERVER_BROWSER_TZ_OFFSET_SEC
      }
      trades.push({
        entryTime: Math.floor(entryMs / 1000) - SERVER_BROWSER_TZ_OFFSET_SEC,
        exitTime: Math.floor(exitMs / 1000) - SERVER_BROWSER_TZ_OFFSET_SEC,
        dir: dir.trim() === '롱' ? 'long' : 'short',
        entryPrice: parseFloat(entryPrice),
        exitPrice: parseFloat(exitPrice),
        exitReason: (exitReason || '').trim(),
        pnl: parseFloat(pnl),
        breakoutTime,
        breakoutDir: (cols[iBreakoutDir] || '').trim() || null,
        comboLabel: iComboLabel >= 0 ? (cols[iComboLabel] || '').trim() || null : null,
        combo: iCombo >= 0 ? (cols[iCombo] || '').trim() || null : null,
        num: iNum >= 0 ? (cols[iNum] || '').trim() || null : null,
        dateNum: iDateNum >= 0 ? (cols[iDateNum] || '').trim() || null : null,
        pattern: iPattern >= 0 ? (cols[iPattern] || '').trim() || null : null,
      })
    }
    return trades
  }

  const fmtHm = (t) => {
    const d = new Date(t * 1000)
    return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0')
  }

  // 매매목록 패널/차트 마커가 똑같이 쓰는 거래 번호 - 기준은 전체 거래내역(전체관리번호, CSV의
  // t.num), 그날 캔들 기준 번호(entryIdx+1 등)는 날짜마다 리셋되고 매번 다시 계산되는 값이라
  // 기준으로 쓰면 안 된다는 지적(사용자 요청) - num이 없는 CSV(전체관리번호 컬럼 없음)에서만
  // 그날 캔들 번호로 대체한다.
  const tradeNumLabel = (num, fallbackIdx) =>
    num != null ? `#${num}` : (fallbackIdx != null ? `#${fallbackIdx + 1}` : '')

  // 지금 불러온 구간(rowsRef.current)에 맞춰 업로드한 거래를 진입/청산 마커 + 목록(캔들번호 포함)으로 변환.
  // 재생 위치(idx)와 무관하게 구간 안에 들어오는 건 전부 계산해두고, applyAllMarkers에서 마커를 통째로 얹는다.
  // 목록(uploadedTradeRows)은 "마커가 안 보인다"는 지적 때문에 추가 — 몇 번째 캔들인지 숫자로 보여주고 클릭하면 그 위치로 바로 이동한다.
  const recomputeUploadedTradeMarkers = () => {
    const rows = rowsRef.current
    if (!rows.length || uploadedTradesRef.current.length === 0) {
      uploadedEdgeMarkersRef.current = []
      setUploadedTradeRows([])
      return
    }
    const idxByTime = new Map(rows.map((r, i) => [r.time, i]))
    const rangeFrom = rows[0].time, rangeTo = rows[rows.length - 1].time
    const edgeMarkers = [] // 이탈/진입/청산 전부 - pane 위/아래 가장자리 고정(캔들 위/아래 대신, 사용자 요청 - "잘 안보여")
    const listRows = []
    for (const t of uploadedTradesRef.current) {
      const entryIdx = idxByTime.get(t.entryTime)
      const exitIdx = idxByTime.get(t.exitTime)
      const breakoutIdx = t.breakoutTime != null ? idxByTime.get(t.breakoutTime) : null
      const entryIn = t.entryTime >= rangeFrom && t.entryTime <= rangeTo && entryIdx != null
      const exitIn = t.exitTime >= rangeFrom && t.exitTime <= rangeTo && exitIdx != null
      const breakoutIn = t.breakoutTime != null && t.breakoutTime >= rangeFrom && t.breakoutTime <= rangeTo && breakoutIdx != null
      if (!entryIn && !exitIn && !breakoutIn) continue
      // 마커 번호는 매매목록 패널과 항상 같은 기준(tradeNumLabel - 전체관리번호가 기본, 사용자 지적)을 쓴다.
      if (breakoutIn) {
        edgeMarkers.push({
          time: t.breakoutTime,
          edge: t.breakoutDir === '상단' ? 'top' : 'bottom',
          row: 0, // 이탈은 가장자리에 가장 가깝게 - 같은 edge를 쓰는 진입(row 1)과 안 겹치게
          color: '#FFC107',
          shape: 'circle',
          text: `${tradeNumLabel(t.num, breakoutIdx)} 이탈`,
        })
      }
      if (entryIn) {
        // 한 줄에 몰아넣지 말고 번호/가격을 줄바꿈으로 분리(사용자 요청) - 도형에 가까운 줄부터
        // 번호 → 가격 순. 화살표/번호/가격은 전부 항상 방향색(롱=라임/숏=보라) 그대로 두고, 나쁜
        // 조합(건당평균 마이너스로 분류된 1차/2차/3차 조합)일 때는 "⚠" 아이콘 그 글자만 빨강으로
        // 표시한다 - 줄 전체나 마커 전체를 빨강으로 덮지 말라는 지적(사용자, "나쁜조합 표시만 빨간색").
        const isBad = t.comboLabel === '나쁜'
        const dirColor = t.dir === 'long' ? '#C6FF00' : '#AB47BC'
        edgeMarkers.push({
          time: t.entryTime,
          edge: t.dir === 'long' ? 'bottom' : 'top',
          row: 1,
          color: dirColor,
          shape: t.dir === 'long' ? 'arrowUp' : 'arrowDown',
          textLines: [
            [{ text: tradeNumLabel(t.num, entryIdx), color: dirColor }],
            isBad
              ? [{ text: '⚠ ', color: '#F44336' }, { text: t.entryPrice.toFixed(2), color: dirColor }]
              : [{ text: t.entryPrice.toFixed(2), color: dirColor }],
          ],
        })
      }
      if (exitIn) {
        // 줄바꿈 분리(사용자 요청) - 도형에 가까운 줄부터 익절/손절+손익 → 번호 → 가격 순
        const pnlLabel = `${uploadedExitLabel(t.exitReason)} / ${t.pnl > 0 ? '+' : ''}${t.pnl.toFixed(1)}pt`
        edgeMarkers.push({
          time: t.exitTime,
          edge: t.dir === 'long' ? 'top' : 'bottom',
          row: 1,
          color: uploadedExitColor(t.exitReason),
          shape: 'circle',
          text: `${pnlLabel}\n${tradeNumLabel(t.num, exitIdx)}\n${t.exitPrice.toFixed(2)}`,
        })
      }
      listRows.push({
        dir: t.dir, exitReason: t.exitReason, pnl: t.pnl,
        entryIdx: entryIn ? entryIdx : null, entryTime: t.entryTime, entryPrice: t.entryPrice,
        exitIdx: exitIn ? exitIdx : null, exitTime: t.exitTime, exitPrice: t.exitPrice,
        breakoutIdx: breakoutIdx ?? null, breakoutTime: t.breakoutTime, breakoutDir: t.breakoutDir,
        comboLabel: t.comboLabel, combo: t.combo, num: t.num, dateNum: t.dateNum, pattern: t.pattern,
      })
    }
    uploadedEdgeMarkersRef.current = edgeMarkers.sort((a, b) => a.time - b.time)
    setUploadedTradeRows(listRows.sort((a, b) => (a.entryTime ?? a.exitTime) - (b.entryTime ?? b.exitTime)))
  }

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
    const showUp = overrides.showUploadedTrades ?? showUploadedTrades

    const crossMarkers = crossPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => p.type === 'golden'
        ? { time: p.time, position: 'belowBar', color: gColor, shape: gShape, size: gSize, text: '' }
        : { time: p.time, position: 'aboveBar', color: dColor, shape: dShape, size: dSize, text: '' })

    // 세계 3대 시장 개장 시각 - 매매 신호가 아니라 항상 고정으로 보여주는 참고 마커(텍스트로 세션 이름 표시)
    const sessionMarkers = sessionPointsRef.current
      .filter(p => p.idx < idx)
      .map(p => ({ time: p.time, position: 'aboveBar', color: p.color, shape: 'circle', size: 1, text: p.label }))

    markersPrimitiveRef.current?.setMarkers([...crossMarkers, ...sessionMarkers].sort((a, b) => a.time - b.time))
    // 업로드한 매매내역 마커(이탈/진입/청산)는 재생 위치(idx)와 무관하게 항상 전부 표시 (사용자 요청)
    uploadedEdgePrimitiveRef.current?.setPoints(showUp ? uploadedEdgeMarkersRef.current : [])
  }

  const applyIndex = (idx) => {
    const dayRows = rowsRef.current.slice(0, idx)
    seriesRef.current?.setData(dayRows)
    drawnUpToRef.current = idx // setData로 완전히 다시 그렸으니, "실제로 그려진 지점"도 정확히 idx로 갱신
    // 마커 전용 투명 시리즈는 항상 구간 전체를 앵커로 갖고 있어야 한다 - 재생 위치(idx)까지만 주면
    // 아직 재생 안 된 시각의 마커(특히 재생 위치와 무관하게 항상 표시하는 업로드 매매내역)가 앵커를
    // 못 찾아서 화면 오른쪽 끝에 전부 쏠려 붙는 버그가 있었다. 다른 신호 마커들은 어차피
    // applyAllMarkers에서 idx로 따로 걸러지니 여기서 전체를 줘도 미래 정보가 새는 게 아니다.
    markerSeriesRef.current?.setData(rowsRef.current.map(r => ({ time: r.time, value: r.close })))
    syncBands(idx)
    syncMA(idx)
    syncRSI(idx)
    syncMACD(idx)
    syncMACD5(idx)
    syncStoch1(idx)
    syncStoch2(idx)
    syncStoch3(idx)
    applyAllMarkers(idx)
    if (ribbonEnabled) recomputeSpreadExtremes(idx) // 슬라이더로 임의 위치 이동 - 되감기일 수 있어 처음부터 재스캔
    if (sidewaysEnabled) applySidewaysBands(idx)
    applySessionBands(idx) // 세션도 횡보처럼 재생(그려진 캔들) 범위 안에서만 표시(사용자 지적)
    applyShooting5MinIndex(idx)
    indexRef.current = idx
    setPlayIndex(idx)
    updateTimerAnchor()
  }

  // "5분 슈팅" - 다른 신호 마커들과 같은 방식으로 재생 위치(idx) 이전 것만 보여준다.
  const applyShooting5MinIndex = (idx) => {
    if (!shooting5MinPrimitiveRef.current) return
    if (!shooting5MinEnabled) { shooting5MinPrimitiveRef.current.setPoints([]); return }
    shooting5MinPrimitiveRef.current.setPoints(
      shooting5MinPointsRef.current.filter(p => p.idx < idx).map(p => ({ time: p.time, price: p.price }))
    )
  }

  // 캔들을 하나씩 update()로 이어붙이는 게 setData 전체 재계산보다 가볍다
  const applyIncrement = (from, to) => {
    // 이 함수 안 어디서든(캔들 그리기·지표 동기화·반자동/시뮬레이션·분리매매창 로직 전부) 에러가 나도
    // 재생 위치(indexRef/playIndex, 빨간 바)는 반드시 끝까지 진행돼야 한다 - 안 그러면 같은 자리에서
    // 매 틱 조용히 멈추기만 하고 빨간 바가 안 움직이는 버그가 된다. 그래서 함수 전체를 감싸고, 위치
    // 갱신은 try/catch/finally의 finally에서 무조건 실행한다.
    try {
    if (ribbonEnabled) scanSpreadSwings(from, to, swingStateRef.current) // 재생은 항상 앞으로만 가므로 이어서 스캔
    if (sidewaysEnabled) applySidewaysBands(to)
    applySessionBands(to)
    applyShooting5MinIndex(to)
    const rows = rowsRef.current
    // from이 아니라 drawnUpToRef(실제로 이미 그려진 지점)부터 그린다 - 빨간 바를 뒤로 드래그했다가
    // 다시 재생하면 from(playIndex)이 이미 그려진 지점보다 과거일 수 있는데, 그 과거 시각을 그대로
    // update()하면 lightweight-charts가 "Cannot update oldest data"로 크래시했다(실사용 중 재현됨).
    // 이미 그려진 구간은 다시 그릴 필요도 없으므로 Math.max로 항상 앞으로만 그린다.
    for (let i = Math.max(from, drawnUpToRef.current); i < to; i++) seriesRef.current?.update(rows[i])
    drawnUpToRef.current = Math.max(drawnUpToRef.current, to)
    // markerSeriesRef는 applyIndex()가 이미 구간 전체(rowsRef.current 전부)를 앵커로 setData해뒀으므로
    // 여기서 다시 update()할 필요가 없다.
    syncBands(to)
    syncMA(to)
    syncRSI(to)
    syncMACD(to)
    syncMACD5(to)
    syncStoch1(to)
    syncStoch2(to)
    syncStoch3(to)
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
    // 분리매매창: SL/TP 자동청산(캔들 high/low로 돌파 판정) + 골드/나스닥 탭 반자동 예약(1~6번) 발동/청산.
    // 모달이 열려 있을 때만 동작한다(원본의 stop_timers와 대응 - 창을 닫으면 타이머가 멈추는 것과 같은 취지).
    if (showTradingWindow) {
      const closedIds = new Set()
      // 같은 캔들에서 SL/TP가 둘 다 걸리면 보수적으로 SL을 우선한다(OHLC만으로는 어느 쪽이 먼저 닿았는지 알 수 없음)
      for (let i = from; i < to; i++) {
        const bar = rows[i]
        for (const pos of positionsRef.current) {
          if (closedIds.has(pos.id)) continue
          if (pos.sl != null) {
            const hitSl = pos.side === 'buy' ? bar.low <= pos.sl : bar.high >= pos.sl
            if (hitSl) { closePositionAt(pos.id, pos.sl, bar.time, pos); closedIds.add(pos.id); continue }
          }
          if (pos.tp != null) {
            const hitTp = pos.side === 'buy' ? bar.high >= pos.tp : bar.low <= pos.tp
            if (hitTp) { closePositionAt(pos.id, pos.tp, bar.time, pos); closedIds.add(pos.id) }
          }
        }
      }

      const rEvents = reservationEventsRef.current
      if (rEvents && reservationSymbolRef.current === symbol) {
        const isGold = symbol === 'GOLD'
        const isNasdaq = symbol === 'NASDAQ'
        const eventListFor = (row) => (
          row === 1 ? rEvents.row1 : row === 2 ? rEvents.row2 : row === 3 ? rEvents.row3 :
          row === 4 ? rEvents.row4 : row === 5 ? rEvents.row5Entry : rEvents.row6Entry
        )
        const fireRow = (row, side, idx) => {
          openModalPositionAt(side, rows[idx].close, rows[idx].time,
            { lot: twLots, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: `row${row}` })
        }
        // 발동 조건 = 체크박스(twXChecked)와 방향버튼(twXDir)이 "같은 행"으로 둘 다 켜져 있을 때만
        if (isGold && twGoldChecked != null && twGoldDir?.row === twGoldChecked) {
          const { row, side } = twGoldDir
          const hit = eventListFor(row).find(e => e.idx >= from && e.idx < to && e.side === side)
          if (hit) { fireRow(row, side, hit.idx); setTwGoldChecked(null); setTwGoldDir(null) }
        }
        if (isNasdaq && twNasdaqChecked != null && twNasdaqDir?.row === twNasdaqChecked) {
          const { row, side } = twNasdaqDir
          const hit = eventListFor(row).find(e => e.idx >= from && e.idx < to && e.side === side)
          if (hit) { fireRow(row, side, hit.idx); setTwNasdaqChecked(null); setTwNasdaqDir(null) }
        }
        // 5/6번 청산 + 익절(H1×H3) - 무장/체크 여부와 무관하게 항상 감시(원본과 동일)
        if (isGold || isNasdaq) {
          const exitHit = rEvents.row5Exit.find(e => e.idx >= from && e.idx < to) || rEvents.row6Exit.find(e => e.idx >= from && e.idx < to)
          if (exitHit) {
            positionsRef.current.forEach(p => {
              if (!closedIds.has(p.id)) { closePositionAt(p.id, rows[exitHit.idx].close, rows[exitHit.idx].time, p); closedIds.add(p.id) }
            })
          }
          if (twTpExitCross) {
            const tpHit = rEvents.tp.find(e => e.idx >= from && e.idx < to)
            if (tpHit) {
              positionsRef.current.forEach(p => {
                if (!closedIds.has(p.id) && p.side === tpHit.closeSide) {
                  closePositionAt(p.id, rows[tpHit.idx].close, rows[tpHit.idx].time, p); closedIds.add(p.id)
                }
              })
            }
          }
        }
      }
    }
    } catch (e) {
      console.error('[재생] applyIncrement 도중 에러, 위치는 계속 진행함:', e)
    } finally {
      indexRef.current = to
      setPlayIndex(to)
      updateTimerAnchor()
    }
  }

  // [fromStr,toStr] 구간의 지표(볼린저/도치안/이평선/RSI/MACD/스토캐스틱/횡보/세션/크로스/신호마커)를
  // 전부 계산해서 rowsRef.current/total과 각 Ref에 반영한다.
  const computeIndicatorsForRange = (fullRows, fromStr, toStr) => {
    // fromStr 그 날짜에 캔들이 하나도 없어도(주말/휴장일) 통째로 실패시키지 않고, 그 날짜 이후
    // 첫 캔들부터 시작한다 - 범위 중간의 주말은 원래도 그냥 건너뛰어지므로, 시작일도 같은 방식으로 맞춤.
    let selectedStartIdx = fullRows.findIndex(r => toLocalDateStr(r.time) >= fromStr)
    let endIdx = selectedStartIdx
    if (selectedStartIdx >= 0) {
      endIdx = selectedStartIdx
      while (endIdx < fullRows.length && toLocalDateStr(fullRows[endIdx].time) <= toStr) endIdx++
    }
    // 선택한 날짜에 캔들이 하나도 없으면(주말/휴장일) 전날을 찾을 것도 없이 그냥 빈 배열 - loadRange가
    // "이 날짜엔 캔들이 없어요" 에러를 그대로 띄운다(원래 동작 그대로 유지).
    const selectedEmpty = selectedStartIdx < 0 || endIdx <= selectedStartIdx
    // 선택한 날짜 바로 전 거래일(주말/휴장일 건너뛰고 실제 캔들이 있는 그 전날)도 화면에 같이 불러와서
    // 이어붙인다 - 재생 시작 위치(빨간 바)를 전날 끝(=선택한 날짜 시작)에 두면, 전날 차트는 이미 다
    // 그려진 채로 있고 선택한 날짜 캔들만 하나씩 새로 나타나는 것처럼 보인다(사용자 요청).
    let startIdx = selectedStartIdx
    if (!selectedEmpty && selectedStartIdx > 0) {
      const selectedDayStr = toLocalDateStr(fullRows[selectedStartIdx].time)
      let j = selectedStartIdx - 1
      const prevDayStr = toLocalDateStr(fullRows[j].time)
      if (prevDayStr < selectedDayStr) {
        while (j > 0 && toLocalDateStr(fullRows[j - 1].time) === prevDayStr) j--
        startIdx = j
      }
    }
    // "하루의 시작"을 자정이 아니라 아시아 세션 시작 시각(SESSIONS의 asia.startHour=7, 07:00 KST)으로
    // 본다(사용자 지적 - 재생 시작이 07시 근처여야 한다고 함, 이 코드베이스가 이미 세션 구분에 쓰는
    // 기준과 동일). 자정~07시 사이 캔들은 있으면 전날 몫처럼 이미 그려진 채로 두고, 재생 위치(빨간 바)만
    // 07시부터 시작한다. 그날 07시 이후 캔들이 아예 없는 이례적인 경우(조기 마감 등)엔 자정 그대로 둔다.
    let playStartCandleIdx = selectedStartIdx
    if (!selectedEmpty) {
      for (let i = selectedStartIdx; i < endIdx; i++) {
        if (new Date(fullRows[i].time * 1000).getHours() >= 7) { playStartCandleIdx = i; break }
      }
    }
    const dayRows = selectedEmpty ? [] : fullRows.slice(startIdx, endIdx)
    // dayRows 안에서 "선택한 날짜"가 시작되는 idx - loadRange가 재생 위치 초기값으로 씀(전날 끝까지는
    // 이미 그려진 채로 시작, 그 뒤부터 캔들이 하나씩 나타남).
    dayRows.playStartIdx = selectedEmpty ? 0 : playStartCandleIdx - startIdx
    rowsRef.current = dayRows
    setTotal(dayRows.length)
    setBluePos(dayRows.length) // 파란 바는 데이터 로드 즉시 맨 끝(전부 로드됨)에 위치
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

    // 스토캐스틱 3세트 - RSI/MACD처럼 파일 전체(fullRows)로 계산해서 워밍업을 채운 뒤 표시 구간만 자른다
    function sliceStoch(kArr, dArr) {
      const kPoints = [], dPoints = []
      for (let i = startIdx; i < endIdx; i++) {
        const t = fullRows[i].time
        kPoints.push(kArr[i] != null ? { time: t, value: kArr[i] } : null)
        dPoints.push(dArr[i] != null ? { time: t, value: dArr[i] } : null)
      }
      return { k: kPoints, d: dPoints }
    }
    const stoch1 = rollingStochastic(fullRows, ...STOCH1_PARAMS)
    stoch1DataRef.current = sliceStoch(stoch1.k, stoch1.d)
    const stoch2 = rollingStochastic(fullRows, ...STOCH2_PARAMS)
    stoch2DataRef.current = sliceStoch(stoch2.k, stoch2.d)
    const stoch3 = rollingStochastic(fullRows, ...STOCH3_PARAMS)
    stoch3DataRef.current = sliceStoch(stoch3.k, stoch3.d)

    // 70/15/15 스토캐스틱 크로스 세로줄 - "5분B(SMA100) 외부로 나간 뒤 아직 안 돌아온 상태"에서
    // K/D가 교차하는 캔들만 기록한다(볼린저 안으로 돌아온 뒤에 나는 크로스는 표시 안 함, 사용자 요청).
    {
      const up100Map = new Map((newBandData.sma100?.upper || []).filter(Boolean).map(p => [p.time, p.value]))
      const low100Map = new Map((newBandData.sma100?.lower || []).filter(Boolean).map(p => [p.time, p.value]))
      const crossTimes = []
      let isOutsideBand = false
      for (let i = startIdx; i < endIdx; i++) {
        const t = fullRows[i].time
        const up = up100Map.get(t), low = low100Map.get(t)
        if (up != null && low != null) {
          if (fullRows[i].high > up || fullRows[i].low < low) isOutsideBand = true
          else if (fullRows[i].high <= up && fullRows[i].low >= low) isOutsideBand = false
        }
        const k = stoch3.k[i], d = stoch3.d[i], pk = stoch3.k[i - 1], pd = stoch3.d[i - 1]
        if (isOutsideBand && k != null && d != null && pk != null && pd != null) {
          const golden = pk <= pd && k > d
          const dead = pk >= pd && k < d
          if (golden || dead) crossTimes.push({ idx: i - startIdx, time: t, color: golden ? STOCH3_CROSS_GOLDEN_COLOR : STOCH3_CROSS_DEAD_COLOR })
        }
      }
      stoch3CrossTimesRef.current = crossTimes
    }

    // 분리매매창 골드/나스닥 탭 반자동 예약(1~6번) - 지금 로드한 심볼 데이터 기준으로 미리 계산해둔다.
    // fullRows 전체로 계산해야 HMA300(15분) 등 워밍업이 채워지고, 이벤트 idx는 dayRows 기준(-startIdx)으로 저장.
    {
      const rSeries = computeReservationSeries(fullRows)
      rSeries.offset = startIdx // dayRows idx → 이 값을 더하면 rSeries 배열들의 절대(fullRows) idx
      reservationSeriesRef.current = rSeries
      reservationEventsRef.current = computeReservationEvents(rSeries, startIdx, endIdx)
      reservationSymbolRef.current = symbol
    }

    refreshCross()
    refreshAutoEvents()
    refreshSimEvents()
    refreshSessionMarkers()
    refreshShooting5Min()
    return dayRows
  }

  // "5분 슈팅"(사용자 요청) - 캔들의 고가가 5분 볼린저(sma100) 상단선을 조금이라도 넘었으면 그
  // 정확한 고가 위치에, 저가가 하단선을 조금이라도 넘었으면 그 정확한 저가 위치에 표시한다.
  const refreshShooting5Min = () => {
    const rows = rowsRef.current
    const band = bandDataRef.current['sma100']
    if (!rows.length || !band) { shooting5MinPointsRef.current = []; return }
    const points = []
    for (let i = 0; i < rows.length; i++) {
      const u = band.upper[i], l = band.lower[i]
      if (u && rows[i].high > u.value) points.push({ idx: i, time: rows[i].time, price: rows[i].high })
      if (l && rows[i].low < l.value) points.push({ idx: i, time: rows[i].time, price: rows[i].low })
    }
    shooting5MinPointsRef.current = points.sort((a, b) => a.idx - b.idx)
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
    stoch1DataRef.current = { k: [], d: [] }
    syncStoch1(0)
    stoch2DataRef.current = { k: [], d: [] }
    syncStoch2(0)
    stoch3DataRef.current = { k: [], d: [] }
    stoch3CrossTimesRef.current = []
    syncStoch3(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    reservationSeriesRef.current = null
    reservationEventsRef.current = null
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    uploadedEdgePrimitiveRef.current?.setPoints([])
    setPositions([]) // 새 구간을 불러오면 그 전 리플레이의 미체결 포지션은 그냥 사라짐(새 연습 세션)
    indexRef.current = 0
    drawnUpToRef.current = 0 // 새 데이터 로드 시 "실제로 그려진 지점"도 반드시 같이 리셋 - 안 하면 이전
    // 날짜에서 남은 값이 새 날짜의 캔들 인덱스와 안 맞아서 update() 크래시로 이어졌다(실사용 중 재현됨).
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

      if (uploadedTradesRef.current.length > 0) recomputeUploadedTradeMarkers()

      if (dayRows.length === 0) {
        setError('이 날짜엔 캔들이 없어요 (주말/휴장일일 수 있어요)')
      } else {
        // 재생 위치(빨간 바)는 전날 끝(=선택한 날짜가 시작되는 지점)에서 출발한다 - 전날 차트는 이미
        // 다 그려진 채로 있고, 거기서부터 선택한 날짜 캔들이 하나씩 새로 나타난다(사용자 요청).
        applyIndex(dayRows.playStartIdx ?? 0)
        // fitContent()는 전날+선택일 전체를 억지로 한 화면에 욱여넣어서 캔들 비율이 뭉개지는 문제가
        // 있었다(사용자 지적) - 그 대신 재생 시작 지점(전날 끝) 근처를 평소 캔들 폭 그대로 보여준다.
        // ★ 예전엔 여기서 ts.getVisibleLogicalRange()를 읽어서 "기존 줌 유지"를 시도했는데, 바로 위
        // applyIndex()의 setData()가 lightweight-charts의 기본 auto-fit을 트리거해서 그 순간 range가
        // 이미 "지금까지 그려진 캔들 전체"(수백 개)로 망가져 있었다 - 그 결과 캔들 하나당 픽셀이 너무
        // 좁아져서 X축 눈금이 항상 15분 단위로 뭉개져 보이는 원인이었다(실측으로 확인: 15분 간격일 때
        // 캔들당 약 6px, INITIAL_VISIBLE_CANDLES=60이면 훨씬 넓은 약 15~19px/캔들이 나와 정상 범위).
        // 이제 그 손상된 값을 읽지 않고 항상 고정값을 쓴다.
        const chart = chartRef.current
        if (chart) {
          const boundary = dayRows.playStartIdx ?? 0
          const ts = chart.timeScale()
          ts.setVisibleLogicalRange({ from: boundary - INITIAL_VISIBLE_CANDLES * 0.8, to: boundary + INITIAL_VISIBLE_CANDLES * 0.2 })
        }
      }
    } catch (e) {
      setError(e.message)
      rowsRef.current = []
      setTotal(0)
    setBluePos(0)
    }
    setLoadingCsv(false)
  }


  const loadDate = (dateStr) => loadRange(dateStr, dateStr)

  // 매매내역 CSV 업로드 - 파일 하나를 고르면 그걸로 통째로 교체(여러 개 겹쳐 올리는 기능 아님).
  // 클릭 선택(input onChange)과 드래그앤드롭이 공유하는 실제 처리 로직
  const processTradeCsvFile = async (file) => {
    if (!file) return
    if (!/\.csv$/i.test(file.name)) { setUploadedTradeError('CSV 파일만 업로드할 수 있습니다'); return }
    setUploadedTradeError('')
    try {
      const text = await file.text()
      const trades = parseTradeCsv(text)
      if (trades.length === 0) throw new Error('거래 데이터를 찾을 수 없습니다 (진입날짜,진입시간,방향,진입가,청산날짜,청산시간,청산가,보유시간(분),청산사유,손익(pt) 형식이어야 해요)')
      uploadedTradesRef.current = trades
      setUploadedTradeFile(file.name)
      setUploadedTradeCount(trades.length)
      setShowUploadedTrades(true)
      recomputeUploadedTradeMarkers()
      if (rowsRef.current.length > 0) applyIndex(rowsRef.current.length)
    } catch (err) {
      setUploadedTradeError(err.message || '파일을 읽지 못했습니다')
    }
  }

  const handleTradeCsvUpload = async (e) => {
    const file = e.target.files?.[0]
    e.target.value = ''
    await processTradeCsvFile(file)
  }

  const handleTradeCsvDrop = async (e) => {
    e.preventDefault()
    setTradeDragOver(false)
    const file = e.dataTransfer.files?.[0]
    await processTradeCsvFile(file)
  }

  const clearUploadedTrades = () => {
    uploadedTradesRef.current = []
    uploadedEdgeMarkersRef.current = []
    setUploadedTradeFile('')
    setUploadedTradeCount(0)
    setUploadedTradeError('')
    applyAllMarkers(indexRef.current, { showUploadedTrades: true })
  }

  const toggleShowUploadedTrades = (checked) => {
    setShowUploadedTrades(checked)
    applyAllMarkers(indexRef.current, { showUploadedTrades: checked })
  }

  // 달력 클릭 처리 - 여러 날 선택 모드가 꺼져있으면 예전처럼 클릭한 날 하루만 바로 불러온다.
  // 켜져있으면 첫 클릭은 범위 시작점만 표시해두고, 두 번째 클릭에서 시작~끝을 이어서 불러온다
  // (Shift+클릭도 같은 방식으로 동작 - MonthCalendar가 이미 shiftKey를 넘겨주고 있었음).
  // 단일 선택 모드에서 이미 선택된 날짜를 또 클릭하면 선택을 취소하고 빈 화면으로 돌아간다(사용자 요청)
  const handleCalendarSelect = (dateStr, shiftKey) => {
    if (!multiSelectMode && !shiftKey) {
      rangeAnchorRef.current = ''
      if (selectedDate === dateStr && !selectedDateTo) {
        clearSelection()
        return
      }
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

  // 선택 전부 지우고 빈 화면으로 - 이미 선택된 날짜를 다시 클릭했을 때 씀. symbol 전환 리셋과 같은 항목을 지운다.
  const clearSelection = () => {
    stopPlayback()
    setSelectedDate('')
    setSelectedDateTo('')
    rangeAnchorRef.current = ''
    setError('')
    rowsRef.current = []
    indexRef.current = 0
    drawnUpToRef.current = 0 // 새 데이터 로드 시 "실제로 그려진 지점"도 반드시 같이 리셋 - 안 하면 이전
    // 날짜에서 남은 값이 새 날짜의 캔들 인덱스와 안 맞아서 update() 크래시로 이어졌다(실사용 중 재현됨).
    setPlayIndex(0)
    setTotal(0)
    setBluePos(0)
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
    stoch1DataRef.current = { k: [], d: [] }
    syncStoch1(0)
    stoch2DataRef.current = { k: [], d: [] }
    syncStoch2(0)
    stoch3DataRef.current = { k: [], d: [] }
    stoch3CrossTimesRef.current = []
    syncStoch3(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    reservationSeriesRef.current = null
    reservationEventsRef.current = null
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    uploadedEdgePrimitiveRef.current?.setPoints([])
    setPositions([])
  }

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
      window.sessionStorage.setItem(REPLAY_STATE_KEY, JSON.stringify({ symbol, selectedDate, selectedDateTo, playIndex, candleVisible }))
    } catch { /* 저장 실패해도(예: 프라이빗 모드 용량제한) 기능엔 영향 없음 - 그냥 다음번엔 복원 안 될 뿐 */ }
  }, [symbol, selectedDate, selectedDateTo, playIndex, candleVisible])

  // 차트 표시 설정(체크박스/색상/두께/시간/투명도/모양/크기/슬롯 선택 전부) 저장 - localStorage라 브라우저를
  // 완전히 닫았다 열어도 유지된다. "초기화" 버튼을 눌렀을 때만 REPLAY_SETTINGS_KEY를 지우고 새로고침한다.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(REPLAY_SETTINGS_KEY, JSON.stringify({
        enabledBands, lineVisibility, bandColors,
        enabledMA, maColors, maWidths, maUpColors, maDownColors,
        ribbonEnabled, ribbonOpacity,
        sidewaysEnabled, sidewaysColor,
        sessionEnabled, sessionColors, sessionHours, sessionOpacity, sessionBorderWidth, sessionBorderOpacity,
        enabledRSI, rsiColor,
        enabledMACD, macdLineColor, macdSignalColor,
        enabledMACD5, macd5LineColor, macd5SignalColor,
        enabledStoch1, stoch1KColor, stoch1DColor,
        enabledStoch2, stoch2KColor, stoch2DColor,
        enabledStoch3, stoch3KColor, stoch3DColor,
        upColor, downColor, candleVisible,
        crossPairs, goldenShape, goldenColor, goldenSize, deadShape, deadColor, deadSize,
        shooting5MinEnabled,
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
    shooting5MinEnabled,
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
      window.localStorage.removeItem(REPLAY_SETTINGS_KEY)
      // 날짜도 초기화(사용자 요청) - 세션 복원값 중 날짜/재생위치만 오늘/0으로 덮어써서, 새로고침 후
      // 마운트 시 세션 복원 로직이 오늘 날짜를 자동으로 불러오게 한다(심볼은 그대로 유지).
      const raw = window.sessionStorage.getItem(REPLAY_STATE_KEY)
      const prev = raw ? JSON.parse(raw) : {}
      window.sessionStorage.setItem(REPLAY_STATE_KEY, JSON.stringify({
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

  const toggleShooting5Min = (checked) => {
    setShooting5MinEnabled(checked)
    if (checked) applyShooting5MinIndex(indexRef.current)
    else shooting5MinPrimitiveRef.current?.setPoints([])
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

  // 스토캐스틱 3세트 - 각자 자기만의 pane(RSI와 같은 방식, MACD1/MACD5처럼 공유 안 함)
  // 스토캐스틱 3세트는 서로 같은 pane을 공유한다(MACD1/MACD5와 같은 방식, 사용자 요청 - "겹쳐서 나와야 함")
  // - 셋 중 이미 켜진 게 있으면 그 pane index를 그대로 쓰고, 끌 때는 나머지 둘 다 꺼져 있을 때만 pane 자체를 지운다.
  const findStochPaneIndex = () => {
    if (stoch1SeriesRef.current) return stoch1SeriesRef.current.k.getPane().paneIndex()
    if (stoch2SeriesRef.current) return stoch2SeriesRef.current.k.getPane().paneIndex()
    if (stoch3SeriesRef.current) return stoch3SeriesRef.current.k.getPane().paneIndex()
    return chartRef.current.panes().length
  }
  const anyOtherStochOn = (exclude) => (
    (exclude !== 1 && stoch1SeriesRef.current) ||
    (exclude !== 2 && stoch2SeriesRef.current) ||
    (exclude !== 3 && stoch3SeriesRef.current)
  )
  // 70/15/15 세로줄을 메인 캔들 pane뿐 아니라 스토캐스틱 pane에도 하나 더 얹는다(사용자 지적 - 스토 부분엔 안 보였음)
  const ensureStochPaneCrossLine = (series) => {
    if (stoch3CrossLineStochPaneRef.current) return
    stoch3CrossLineStochPaneRef.current = new MultiVerticalLinesPrimitive()
    series.attachPrimitive(stoch3CrossLineStochPaneRef.current)
  }

  const toggleStoch1 = () => {
    const turningOn = !enabledStoch1
    setEnabledStoch1(turningOn)
    if (turningOn) {
      if (!stoch1SeriesRef.current && chartRef.current) {
        const paneIndex = findStochPaneIndex()
        stoch1SeriesRef.current = {
          k: chartRef.current.addSeries(LineSeries, { color: stoch1KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, paneIndex),
          d: chartRef.current.addSeries(LineSeries, { color: stoch1DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, paneIndex),
        }
        ensureStochPaneCrossLine(stoch1SeriesRef.current.k)
        applyStochPaneRatio(chartRef.current, paneIndex)
        bumpMarkerLayer()
      }
      applyStoch1Index(indexRef.current)
    } else {
      const s = stoch1SeriesRef.current
      if (s && chartRef.current) {
        const pane = s.k.getPane()
        chartRef.current.removeSeries(s.k)
        chartRef.current.removeSeries(s.d)
        if (!anyOtherStochOn(1)) {
          try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
          stoch3CrossLineStochPaneRef.current = null
        }
      }
      stoch1SeriesRef.current = null
    }
  }
  const setStoch1KColor = (color) => { setStoch1KColorState(color); stoch1SeriesRef.current?.k.applyOptions({ color }) }
  const setStoch1DColor = (color) => { setStoch1DColorState(color); stoch1SeriesRef.current?.d.applyOptions({ color }) }

  const toggleStoch2 = () => {
    const turningOn = !enabledStoch2
    setEnabledStoch2(turningOn)
    if (turningOn) {
      if (!stoch2SeriesRef.current && chartRef.current) {
        const paneIndex = findStochPaneIndex()
        stoch2SeriesRef.current = {
          k: chartRef.current.addSeries(LineSeries, { color: stoch2KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, paneIndex),
          d: chartRef.current.addSeries(LineSeries, { color: stoch2DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, paneIndex),
        }
        ensureStochPaneCrossLine(stoch2SeriesRef.current.k)
        applyStochPaneRatio(chartRef.current, paneIndex)
        bumpMarkerLayer()
      }
      applyStoch2Index(indexRef.current)
    } else {
      const s = stoch2SeriesRef.current
      if (s && chartRef.current) {
        const pane = s.k.getPane()
        chartRef.current.removeSeries(s.k)
        chartRef.current.removeSeries(s.d)
        if (!anyOtherStochOn(2)) {
          try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
          stoch3CrossLineStochPaneRef.current = null
        }
      }
      stoch2SeriesRef.current = null
    }
  }
  const setStoch2KColor = (color) => { setStoch2KColorState(color); stoch2SeriesRef.current?.k.applyOptions({ color }) }
  const setStoch2DColor = (color) => { setStoch2DColorState(color); stoch2SeriesRef.current?.d.applyOptions({ color }) }

  // 70/15/15 - K/D 라인은 나머지 둘과 같은 pane에, "볼린저 외부 크로스" 세로줄은 메인 캔들 시리즈(stoch3CrossLineRef)에 얹는다
  const toggleStoch3 = () => {
    const turningOn = !enabledStoch3
    setEnabledStoch3(turningOn)
    if (turningOn) {
      if (!stoch3SeriesRef.current && chartRef.current) {
        const paneIndex = findStochPaneIndex()
        stoch3SeriesRef.current = {
          k: chartRef.current.addSeries(LineSeries, { color: stoch3KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, paneIndex),
          d: chartRef.current.addSeries(LineSeries, { color: stoch3DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, paneIndex),
        }
        ensureStochPaneCrossLine(stoch3SeriesRef.current.k)
        applyStochPaneRatio(chartRef.current, paneIndex)
        bumpMarkerLayer()
      }
      applyStoch3Index(indexRef.current)
    } else {
      const s = stoch3SeriesRef.current
      if (s && chartRef.current) {
        const pane = s.k.getPane()
        chartRef.current.removeSeries(s.k)
        chartRef.current.removeSeries(s.d)
        if (!anyOtherStochOn(3)) {
          try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
          stoch3CrossLineStochPaneRef.current = null
        }
      }
      stoch3SeriesRef.current = null
      stoch3CrossLineRef.current?.setLines([])
    }
  }
  const setStoch3KColor = (color) => { setStoch3KColorState(color); stoch3SeriesRef.current?.k.applyOptions({ color }) }
  const setStoch3DColor = (color) => { setStoch3DColorState(color); stoch3SeriesRef.current?.d.applyOptions({ color }) }

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

  // 지금 재생 위치까지 실제로 화면에 그려진 데이터를 스샷(그림) 대신 숫자 그대로 뽑아낸다.
  // 캔들 + 볼린저밴드 5개 + 이평선 전부 + RSI + MACD1/5 - 전부 재생 위치(playIndex) 이후(아직 안 지난)
  // 구간은 제외하고 지금까지 드러난 만큼만 담는다(화면에 실제 그려진 것과 동일한 범위).
  const buildChartDataPayload = () => {
    const idx = playIndex
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
  // `window.getReplayChartData()`를 호출해서 지금 이 화면 상태(재생위치까지)를 바로 읽어갈 수 있게
  // window에 노출해둔다. 렌더될 때마다 최신 클로저로 갱신(각 값이 바뀔 때마다 새로 만들어도 비용 거의 없음).
  useEffect(() => {
    window.getReplayChartData = buildChartDataPayload
    return () => { if (window.getReplayChartData === buildChartDataPayload) delete window.getReplayChartData }
  })

  const play = () => {
    if (!rowsRef.current.length) return
    // 끝까지 다 본 뒤 다시 재생하면 절대 0(전날 시작점)이 아니라 선택한 날짜가 시작되는 지점으로 되돌아간다
    if (indexRef.current >= rowsRef.current.length) applyIndex(rowsRef.current.playStartIdx ?? 0)
    // 재생 위치를 찾기 힘들다는 피드백 - 재생 시작할 때 차트를 "지금 재생 위치(indexRef)"가 보이는
    // 곳으로 이동시킨다. 예전엔 무조건 scrollToPosition(0, true)(차트 전체 데이터 기준 맨 끝)를 썼는데,
    // 빨간 바를 과거로 드래그해둔 뒤 재생을 누르면 그 위치가 아니라 엉뚱한 오른쪽 끝으로 화면이 순식간에
    // 튀는 버그였다(사용자 지적) - scrubView는 항상 indexRef 기준으로 카메라를 옮기므로 이 문제가 없다.
    scrubView(indexRef.current)
    setPlaying(true)
  }

  useEffect(() => {
    if (!playing) return
    // 이상적인 간격(실제 1분 ÷ 배속)이 브라우저 타이머 하한보다 짧아지면,
    // 틱 간격은 하한에 고정하고 그 틱마다 여러 캔들을 진행시켜 같은 체감 속도를 낸다.
    const idealMs = REALTIME_MS / speed
    const tickMs = Math.max(MIN_TICK_MS, idealMs)
    const candlesPerTick = Math.max(1, Math.round(speed * tickMs / REALTIME_MS))
    // 캔들 타이머(화면 표시용) - 이 배속에서 캔들 1개당 걸리는 시간(idealMs) 기준으로 리셋해두고,
    // 매 틱마다 "다음 캔들 예정 시각"도 같이 다시 잡는다. 배속을 바꾸면 이 effect가 통째로 재시작되니
    // (의존성 배열에 speed 포함) 재생 중 배속 버튼을 눌러도 타이머가 곧바로 새 배속 기준으로 맞춰진다.
    nextCandleAtRef.current = Date.now() + tickMs
    setCandleTimerMs(idealMs)
    intervalRef.current = setInterval(() => {
      const from = indexRef.current
      const to = Math.min(from + candlesPerTick, rowsRef.current.length)
      applyIncrement(from, to)
      nextCandleAtRef.current = Date.now() + tickMs
      setCandleTimerMs(idealMs)
      if (to >= rowsRef.current.length) stopPlayback()
    }, tickMs)
    return () => { if (intervalRef.current) clearInterval(intervalRef.current) }
  }, [playing, speed, stopPlayback])

  // 캔들 타이머 화면 숫자를 부드럽게 카운트다운시키는 전용 인터벌 - 위 재생 인터벌(tickMs)은 배속이
  // 낮으면 몇십 초 단위라 그 주기로만 갱신하면 숫자가 안 움직이는 것처럼 보인다. 100ms마다
  // nextCandleAtRef(다음 캔들 예정 시각)까지 남은 시간을 다시 계산해서 화면만 갱신한다.
  useEffect(() => {
    if (!playing) return
    timerTickRef.current = setInterval(() => {
      setCandleTimerMs(Math.max(0, nextCandleAtRef.current - Date.now()))
    }, 100)
    return () => { if (timerTickRef.current) clearInterval(timerTickRef.current) }
  }, [playing])

  // 멈춰있는 동안(재생 전/일시정지 중) 배속 버튼을 누르면 캔들 타이머 표시도 그 배속 기준 풀타임으로
  // 바로 바뀐다 - 재생 중엔 위 재생 인터벌 effect가 speed 변경 시 통째로 재시작되며 이미 처리한다.
  useEffect(() => {
    if (!playing) setCandleTimerMs(REALTIME_MS / speed)
  }, [speed, playing])

  const reset = () => {
    stopPlayback()
    // "처음부터" = 선택한 날짜가 시작되는 지점(전날 끝) - 전날 차트는 계속 그려진 채로 유지됨
    const startIdx = rowsRef.current.playStartIdx ?? 0
    applyIndex(startIdx)
    // applyIndex는 데이터/빨간 바 위치만 옮기고 카메라(화면)는 안 건드린다 - 재생을 한참 진행해서
    // 화면이 오른쪽 끝을 보고 있는 상태에서 처음부터를 누르면 데이터는 리셋돼도 화면은 그대로라
    // "처음으로 안 간 것처럼" 보이는 버그였다(사용자 지적). scrubView로 카메라도 같이 되돌린다.
    scrubView(startIdx)
  }

  // 빨간 바 - 드래그하면 화면(카메라)을 그 시점으로 옮기고(scrubView), 차트도 항상 그 지점까지로
  // 다시 그린다(applyIndex) - 과거로 드래그하면 그 뒤 캔들은 사라지고(진짜 되감기), 미래로 드래그하면
  // 그 지점까지 새로 그려진다. 재생 위치(playIndex)도 같이 그 자리로 옮겨진다. 손을 떼도 그대로 그
  // 자리에 있고, 다음 ▶재생은 거기서부터 이어진다(drawnUpToRef도 idx로 맞춰지므로 다시 재생해도
  // applyIncrement가 즉시 새 캔들을 그린다 - 예전엔 revealTo가 뒤로 드래그할 때 화면을 안 지워서
  // drawnUpToRef가 앞서 있는 채로 남았고, 그 상태로 재생하면 drawnUpToRef를 따라잡을 때까지 화면이
  // 하나도 안 움직이는 버그가 있었다).
  const scrubBarRef = useRef(null)
  const onScrubBarMouseDown = (e) => {
    if (!total) return
    const bar = scrubBarRef.current
    if (!bar) return
    stopPlayback()
    const moveTo = (clientX) => {
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const idx = Math.round(ratio * total)
      scrubView(idx)
      applyIndex(idx)
    }
    moveTo(e.clientX)
    const onMove = (ev) => moveTo(ev.clientX)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 파란 바 - 재생 버튼/재생 위치(빨간 바)와는 완전히 무관, 카메라(화면)만 그 지점으로 옮긴다.
  // scrub(applyIndex)를 쓰면 재생 위치가 같이 끌려가고 차트가 setData로 통째로 다시 그려지는
  // 버그가 있었다(사용자 지적) - scrubView로 바꿔서 재생 위치/데이터는 그대로 두고 화면만 이동한다.
  const blueBarRef = useRef(null)
  const onBlueBarMouseDown = (e) => {
    if (!total) return
    const bar = blueBarRef.current
    if (!bar) return
    const moveTo = (clientX) => {
      const rect = bar.getBoundingClientRect()
      const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
      const idx = Math.round(ratio * total)
      setBluePos(idx)
      scrubView(idx)
    }
    moveTo(e.clientX)
    const onMove = (ev) => moveTo(ev.clientX)
    const onUp = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 화면(카메라) 전용 이동 - 재생 위치(indexRef/playIndex)는 이 함수 자체는 안 건드리고 차트 "화면"만
  // 그 캔들로 이동시킨다. 지금 보이는 창 너비(logical range)는 유지한 채 중심만 옮긴다.
  // (매매내역 CSV 업로드 스크럽바, 빨간 바 드래그 둘 다 이 함수를 쓴다 - 빨간 바는 여기에 더해서
  // playIndex도 직접 옮기지만, 그건 onScrubBarMouseDown이 scrubView 호출 뒤에 따로 한다.)
  const scrubView = (idx) => {
    setViewScrubPos(idx)
    const chart = chartRef.current
    if (!chart) return
    const ts = chart.timeScale()
    const range = ts.getVisibleLogicalRange()
    const width = range ? (range.to - range.from) : INITIAL_VISIBLE_CANDLES
    ts.setVisibleLogicalRange({ from: idx - width / 2, to: idx + width / 2 })
  }

  // 캔들 타이머 배지 위치 갱신 - 마지막으로 그려진 캔들(재생 위치)의 시각/종가를 실제 화면 좌표(px)로
  // 변환해서 그 캔들 바로 옆에 거리를 두고 뜨게 한다(사용자 요청 - 차트 구석에 고정된 배지 말고,
  // 재생 위치를 보여주는 그 지점을 계속 따라다녀야 함). 화면을 드래그/줌하거나 캔들이 새로 그려질 때마다
  // 다시 계산해야 하므로 여러 곳(applyIncrement/applyIndex/차트 리사이즈/보이는 범위 변경)에서 호출한다.
  const updateTimerAnchor = () => {
    const idx = indexRef.current
    const row = rowsRef.current[idx - 1]
    const chart = chartRef.current
    const series = seriesRef.current
    if (!row || !chart || !series) { setTimerAnchor(null); return }
    const x = chart.timeScale().timeToCoordinate(row.time)
    const y = series.priceToCoordinate(row.close)
    if (x == null || y == null) { setTimerAnchor(null); return }
    setTimerAnchor({ x, y })
  }

  // 매매목록 클릭 시 진입 시점으로 이동 - 진입이 다른 날짜(전날 등)라 지금 불러온 구간 밖이면
  // 그 날짜를 새로 불러온 뒤 이동한다. 예전엔 청산 위치로만 이동해서, 진입 당시 상황(스퀴즈/스토
  // 등)은 못 보고 청산 시점 상황만 보고 "왜 이 상황에서 진입했냐"고 오해하는 문제가 있었음(사용자 지적).
  const goToTradeEntry = async (r) => {
    if (r.entryIdx != null) { scrubView(r.entryIdx); return }
    if (r.entryTime == null) { if (r.exitIdx != null) scrubView(r.exitIdx); return }
    const dateStr = toLocalDateStr(r.entryTime)
    await loadRange(dateStr, dateStr)
    const idx = rowsRef.current.findIndex(row => row.time === r.entryTime)
    if (idx >= 0) scrubView(idx)
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

  // 분리매매창 전용 진입 - 손절/익절을 "포인트"로 받아 절대가격(sl/tp)으로 미리 계산해 포지션에 저장해둔다
  // (PyQt의 sl_spin/tp_spin과 같은 단위). 반자동 예약(1~6번)이 쏜 진입도 이 함수를 그대로 쓴다.
  const openModalPositionAt = (side, price, time, { lot, slPoints, tpPoints, tag }) => {
    const sl = slPoints > 0 ? (side === 'buy' ? price - slPoints : price + slPoints) : null
    const tp = tpPoints > 0 ? (side === 'buy' ? price + tpPoints : price - tpPoints) : null
    setPositions(prev => [...prev, {
      id: `tw${tag ? '_' + tag : ''}_${Date.now()}_${Math.random()}`,
      side, symbol, lot, entryPrice: price, entryTime: time, sl, tp,
    }])
  }
  const openModalPosition = (side, opts) => {
    if (currentPrice == null) return
    openModalPositionAt(side, currentPrice, rowsRef.current[playIndex - 1].time, opts)
  }

  // 포지션 id의 접두어로 어디서 생긴 거래인지 구분한다 - 반자동/시뮬레이션은 applyIncrement에서
  // `auto_...`/`sim_...`로 접두어를 붙여서 만들고, 수동 BUY/SELL(openPosition)은 접두어가 없다.
  // 분리매매창(모달)에서 낸 거래는 `tw...`로 시작한다.
  const tradeSource = (id) => {
    if (id.startsWith('sim_')) return 'sim'
    if (id.startsWith('auto_')) return 'auto'
    if (id.startsWith('tw')) return 'modal'
    return 'manual'
  }

  // 특정 가격/시각으로 청산 - SL/TP 자동청산·반자동 예약 청산처럼 "지금 재생 위치"가 아니라
  // 그 사이 지나간 특정 캔들에서 체결됐어야 하는 경우에 쓴다. closePosition(수동 청산 버튼)은
  // 항상 currentPrice(=지금 드러난 마지막 캔들)로 닫는 게 맞아서 그대로 별도 유지.
  const closePositionAt = (id, price, time, posArg) => {
    setPositions(prev => {
      const pos = posArg || prev.find(p => p.id === id)
      if (!pos) return prev
      const { points, dollars } = calcPnl(pos, price)
      setBalance(b => b + dollars)
      closedTradesRef.current.push({
        source: tradeSource(pos.id), side: pos.side, symbol: pos.symbol, lot: pos.lot,
        entryPrice: pos.entryPrice, entryTime: pos.entryTime,
        exitPrice: price, exitTime: time, points, dollars,
      })
      setClosedTradesCount(c => c + 1)
      return prev.filter(p => p.id !== id)
    })
  }

  const closePosition = (id) => {
    if (currentPrice == null) return
    closePositionAt(id, currentPrice, rowsRef.current[playIndex - 1]?.time ?? null)
  }

  // 🚨 벌크 청산 - 모든 포지션을 지금 재생 위치 가격으로 일괄 청산 (전략1/골드/나스닥 탭 공용)
  const closeAllPositionsModal = () => {
    positions.forEach(p => closePosition(p.id))
  }

  // 손절이동(진입가) - 이미 진입가면 아무것도 안 함(원본과 동일)
  const moveSlToEntry = (id) => {
    setPositions(prev => prev.map(p => {
      if (p.id !== id) return p
      if (p.sl != null && Math.abs(p.sl - p.entryPrice) < 1e-9) return p
      return { ...p, sl: p.entryPrice }
    }))
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

  // ══════════════════════════════════════════════════════════════════════
  // 분리매매창(EasyTrade_MT5 데스크톱 앱 "매매 실행" 팝업) - 렌더 헬퍼
  // ══════════════════════════════════════════════════════════════════════
  const onTwHeaderMouseDown = (e) => {
    twDragRef.current = { startX: e.clientX, startY: e.clientY, origX: twPos.x, origY: twPos.y }
    const onMove = (ev) => {
      if (!twDragRef.current) return
      setTwPos({
        x: twDragRef.current.origX + (ev.clientX - twDragRef.current.startX),
        y: twDragRef.current.origY + (ev.clientY - twDragRef.current.startY),
      })
    }
    const onUp = () => {
      twDragRef.current = null
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', onUp)
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', onUp)
  }

  // 진짜 브라우저 새 창으로 분리매매창을 띄운다 - 같은 origin의 window.open이라 자바스크립트 힙을 공유하므로,
  // React 포탈(createPortal)로 그 창 document에 렌더하면 별도 동기화 코드 없이도 지금 이 컴포넌트의
  // state/함수(포지션·잔고·재생 위치 등)를 그대로 함께 쓴다 - 클릭하면 즉시 이 페이지의 시뮬레이션에 반영됨.
  const openTwPopup = () => {
    const w = window.open('', 'easytrade-tw', 'width=440,height=920,resizable=yes')
    if (!w) { alert('팝업이 차단됐어요. 브라우저 주소창의 팝업 차단 아이콘을 눌러 허용해주세요.'); return }
    w.document.title = '매매 실행 — EasyTrade'
    // 부모 문서의 스타일시트(styles/site.css 등)를 그대로 복사 - 새 창은 별도 document라 기본적으로 비어있음
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
      w.document.head.appendChild(node.cloneNode(true))
    })
    // site.css의 전역 `button{width:100%;margin-top:20px}` 규칙이 이 창 안 버튼들의 flex 레이아웃을
    // 깨뜨리는 걸 막는다 - replay.js 안에서도 .bt-page에 같은 이유로 이미 걸어둔 오버라이드와 동일.
    const resetStyle = w.document.createElement('style')
    resetStyle.textContent = 'body{margin:0} #tw-root button{width:auto;margin-top:0}'
    w.document.head.appendChild(resetStyle)
    w.document.body.style.background = '#0f1115'
    const root = w.document.createElement('div')
    root.id = 'tw-root'
    w.document.body.appendChild(root)
    twWinRef.current = w
    setTwPopupEl(root)
    // 사용자가 새 창을 (우리가 만든 버튼이 아니라) 직접 OS 창 닫기 버튼으로 닫은 경우에만
    // 분리매매창 전체를 종료한다 - closeTwPopup()으로 "다시 붙이기"할 땐 이 리스너를 먼저 떼어내서
    // 안 걸리게 한다(안 그러면 다시 붙이기 눌러도 모달째로 꺼져버림).
    const onUserClosed = () => { twWinRef.current = null; setTwPopupEl(null); setShowTradingWindow(false) }
    twOnUnloadRef.current = onUserClosed
    w.addEventListener('beforeunload', onUserClosed)
  }

  const closeTwPopup = () => {
    if (twWinRef.current && !twWinRef.current.closed) {
      if (twOnUnloadRef.current) twWinRef.current.removeEventListener('beforeunload', twOnUnloadRef.current)
      twWinRef.current.close()
    }
    twOnUnloadRef.current = null
    twWinRef.current = null
    setTwPopupEl(null)
  }

  // 탭이 닫히거나 이 페이지를 벗어나면 열어둔 새 창도 같이 정리
  useEffect(() => () => { if (twWinRef.current && !twWinRef.current.closed) twWinRef.current.close() }, [])

  // 지금 재생 위치(playIndex-1, dayRows 기준)의 실시간 계산값 하나를 읽는다 - reservationSeriesRef는
  // fullRows(절대) 인덱스라 offset을 더해서 변환. 데이터가 없거나 워밍업 중이면 null.
  const twSeriesVal = (key) => {
    const S = reservationSeriesRef.current
    if (!S || playIndex <= 0) return null
    const i = (playIndex - 1) + S.offset
    const v = S[key]?.[i]
    return v == null ? null : v
  }

  const twMoneyColor = (v) => (v >= 0 ? '#26a69a' : '#ef5350')

  // 손절이동(진입가) 4슬롯 - 전략1/골드/나스닥 탭 공용. 원본은 MT5 티켓 순(진입시각 순 정렬)으로
  // 4개까지 보여주고 이미 진입가면 버튼이 비활성 상태 텍스트를 보여준다.
  const renderTwMoveSlSlots = () => {
    const sorted = [...positions].sort((a, b) => a.entryTime - b.entryTime).slice(0, 4)
    return (
      <div style={{ border: '1px solid #2a2e38', borderRadius: 10, padding: 10, marginTop: 10 }}>
        <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 8, fontWeight: 700 }}>손절이동 (진입가)</div>
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
          {[0, 1, 2, 3].map(i => {
            const pos = sorted[i]
            const atEntry = pos && pos.sl != null && Math.abs(pos.sl - pos.entryPrice) < 1e-9
            const pnl = pos && currentPrice != null ? calcPnl(pos, currentPrice) : null
            return (
              <button
                key={i} type="button" disabled={!pos || atEntry}
                onClick={() => pos && moveSlToEntry(pos.id)}
                style={{
                  minHeight: 46, borderRadius: 6, border: 'none', fontSize: 11.5, fontWeight: 700, lineHeight: 1.4,
                  cursor: pos && !atEntry ? 'pointer' : 'not-allowed',
                  background: pos && !atEntry ? TW_MOVE_SL_ON : TW_MOVE_SL_OFF,
                  color: 'white',
                }}
              >
                {!pos ? `${i + 1}번\n대기` : atEntry ? `${i + 1}번\n진입가 완료` :
                  `${i + 1}번 ${pos.side === 'buy' ? '🟢' : '🔴'}\n${pnl.dollars >= 0 ? '+' : ''}$${pnl.dollars.toFixed(1)}`}
              </button>
            )
          })}
        </div>
      </div>
    )
  }

  // [상태] 표시등 - 44px 고정폭, 체크박스와 SELL/BUY 버튼 "사이"(원본 QHBoxLayout 순서 그대로: 체크박스→상태→방향버튼).
  // 항상 배경은 투명(테두리만) - active=false면 회색 테두리로 꺼짐, active=true면 테두리·글자색이 해당 상태색.
  // colorB를 주면 twBlinkPhase에 따라 colorA/colorB를 번갈아 점멸, colorB 없이 colorA만 주면 점멸 없이 고정색(1번 신호).
  const TwStatusDot = ({ active, colorA, colorB }) => {
    const c = active ? (colorB ? (twBlinkPhase ? colorA : colorB) : colorA) : null
    const borderColor = c ? c.border : TW_STATUS_OFF.border
    return (
      <span style={{
        display: 'inline-block', width: 44, textAlign: 'center', fontSize: 9, fontWeight: 700,
        padding: '2px 4px', borderRadius: 4, background: 'transparent',
        color: c ? borderColor : TW_READY_OFF.color, border: `2px solid ${borderColor}`,
      }}>상태</span>
    )
  }

  // 골드/나스닥 탭 - hma_reservation_tab.py / nas100_tab.py와 완전히 동일한 로직·색상.
  // symbol이 이 탭의 대상(GOLD/NASDAQ)과 다르면 신호는 계산되지만 실제로 발동은 안 됨(applyIncrement에서
  // isGold/isNasdaq로 걸러짐) - UI에서도 "대기 중" 안내를 보여준다.
  const renderTwReservationTab = (which) => {
    const targetSymbol = which === 'gold' ? 'GOLD' : 'NASDAQ'
    const live = symbol === targetSymbol
    // checked = 체크박스(무장) 상태(설명 박스는 이것만으로 뜬다), dir = 눌린 방향버튼. 발동엔 둘 다 필요.
    const checked = which === 'gold' ? twGoldChecked : twNasdaqChecked
    const setChecked = which === 'gold' ? setTwGoldChecked : setTwNasdaqChecked
    const dir = which === 'gold' ? twGoldDir : twNasdaqDir
    const setDir = which === 'gold' ? setTwGoldDir : setTwNasdaqDir
    const title = which === 'gold' ? '🥇 XAUUSD+ 전용' : '📈 NAS100 전용'
    const titleBg = which === 'gold' ? '#B8860B' : '#1565C0'
    const bulkLabel = which === 'gold' ? '🚨 벌크 청산 (XAUUSD+)' : '🚨 벌크 청산 (NAS100)'

    const h1 = twSeriesVal('h1'), h3 = twSeriesVal('h3'), h100 = twSeriesVal('h100'), h300 = twSeriesVal('h300')
    const wma17 = twSeriesVal('wma17_1m'), sma20 = twSeriesVal('sma20_1m')
    const wma85 = twSeriesVal('wma85'), sma100 = twSeriesVal('sma100')
    const wma255 = twSeriesVal('wma255'), sma300 = twSeriesVal('sma300')
    const price = playIndex > 0 ? rowsRef.current[playIndex - 1]?.close ?? null : null
    const bbUp = twSeriesVal('bbUp'), bbLo = twSeriesVal('bbLo')

    // 정배열 라벨 3개 (WMA17/SMA20, WMA85/SMA100, WMA255/SMA300) - 빠른선이 위면 파랑, 아래면 핑크
    const alignLabel = (fastLabel, fastVal, slowLabel, slowVal) => {
      if (fastVal == null || slowVal == null) return { text: `${fastLabel}/${slowLabel}\n-`, bg: '#616161' }
      const isBuy = fastVal > slowVal
      const text = isBuy
        ? `${fastLabel} / ${fastVal.toFixed(2)}\n${slowLabel} / ${slowVal.toFixed(2)}`
        : `${slowLabel} / ${slowVal.toFixed(2)}\n${fastLabel} / ${fastVal.toFixed(2)}`
      return { text, bg: isBuy ? '#1976D2' : '#D81B60' }
    }
    const a1 = alignLabel('W17', wma17, 'S20', sma20)
    const a2 = alignLabel('W85', wma85, 'S100', sma100)
    const a3 = alignLabel('W255', wma255, 'S300', sma300)

    // 1/2번 체크박스 라벨 텍스트+색
    const row1Outside = price != null && bbUp != null && bbLo != null && (price < bbLo || price > bbUp)
    const row1Armed = twSeriesVal('row1Armed')
    const row1Color = row1Outside ? TW_TEXT_ORANGE : TW_TEXT_GRAY
    const row2Golden = h3 != null && sma100 != null && h3 > sma100
    const row2Color = (h3 == null || sma100 == null) ? TW_TEXT_GRAY : (row2Golden ? TW_TEXT_BLUE : TW_TEXT_PINK)
    const fmtTopBottom = (fast, slow) => {
      if (fast == null || slow == null) return '-'
      const golden = fast > slow
      const top = golden ? fast : slow, bottom = golden ? slow : fast
      return `${top.toFixed(2)}\n${bottom.toFixed(2)}`
    }

    // 3/4번 라벨 색 - "상승/하락중"(prev 비교) 2개 조건만 빼고 나머지는 그대로 반영한 근사치.
    // 실제 발동 판정(applyIncrement)은 rising/falling까지 포함한 정확한 조건으로 이루어짐.
    const stochGolden = twSeriesVal('stochGolden')
    const row3Buy = wma85 != null && sma100 != null && h1 != null && wma85 > sma100 && stochGolden === true && price != null && price > h1
    const row4Sell = wma85 != null && sma100 != null && h1 != null && wma85 < sma100 && stochGolden === false && price != null && price < h1

    const row5Golden = h3 != null && h100 != null && h3 > h100
    const row6Dead = h1 != null && h3 != null && h1 < h3

    // 원본 QHBoxLayout 순서 그대로: [체크박스+라벨] → [상태 표시등] → [SELL/BUY 버튼]
    const rowDef = (n, label, checked, onCheck, statusEl, sideBtns) => (
      <div key={n} style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 6 }}>
        <label style={{ display: 'flex', flexDirection: 'column', width: 130, flexShrink: 0, cursor: 'pointer', fontSize: 11, fontWeight: 700 }}>
          <span style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
            <input type="checkbox" checked={checked} onChange={onCheck} style={{ accentColor: '#4CAF50' }} />
            <span style={{ color: label.color, whiteSpace: 'pre-line' }}>{label.text}</span>
          </span>
        </label>
        {statusEl}
        <div style={{ display: 'flex', gap: 4, flex: 1 }}>{sideBtns}</div>
      </div>
    )

    const dirBtn = (text, active, onClick, isLong) => (
      <button type="button" onClick={onClick} style={{
        height: 38, padding: '4px 10px', fontSize: 13, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
        color: 'white', border: active ? '3px solid white' : 'none',
        background: active ? (isLong ? TW_LONG_ON : TW_SHORT_ON) : (isLong ? TW_LONG_OFF : TW_SHORT_OFF),
      }}>{text}</button>
    )

    // 체크박스(무장) - 1~6번 상호배타. 다른 행으로 바뀌거나 해제되면 그 행에 눌려있던 방향버튼도 원복(원본 _reset_row_buttons와 동일).
    const toggleCheck = (n) => {
      const next = checked === n ? null : n
      setChecked(next)
      if (dir && dir.row !== next) setDir(null)
    }
    // 방향버튼(SELL/BUY) - 체크박스와 별개의 토글. 다시 누르면 원복.
    const pressDir = (row, side) => setDir(d => (d && d.row === row && d.side === side) ? null : { row, side })
    // 1/2번처럼 SELL+BUY가 한 쌍인 행 - "버튼 위치 변경"(twSwapped)에 따라 좌우 순서가 같이 바뀐다
    // (원본 swap_buttons가 상단 수동버튼뿐 아니라 1~2번 행의 short/long_btn도 같이 좌우를 바꿔치기함).
    const dirPair = (row) => {
      const sell = dirBtn('SELL 🔴 매도', dir?.row === row && dir.side === 'sell', () => pressDir(row, 'sell'), false)
      const buy = dirBtn('BUY 🟢 매수', dir?.row === row && dir.side === 'buy', () => pressDir(row, 'buy'), true)
      return twSwapped ? <>{buy}{sell}</> : <>{sell}{buy}</>
    }

    return (
      <div>
        <div style={{ textAlign: 'center', fontSize: 14, fontWeight: 700, color: 'white', background: titleBg, padding: 8, borderRadius: 5, marginBottom: 8 }}>
          {title}{!live && <span style={{ fontWeight: 400, fontSize: 11 }}> — 지금은 {symbol === 'GOLD' ? '골드' : '나스닥'} 데이터 재생 중이라 대기만 함</span>}
        </div>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8 }}>
          {[a1, a2, a3].map((a, i) => (
            <div key={i} style={{ flex: 1, textAlign: 'center', fontSize: 13, fontWeight: 700, color: 'white', background: a.bg, padding: '10px 4px', borderRadius: 5, whiteSpace: 'pre-line' }}>{a.text}</div>
          ))}
        </div>

        <button type="button" onClick={() => setTwSwapped(v => !v)} style={{ width: '100%', background: '#9E9E9E', color: 'white', border: 'none', borderRadius: 5, padding: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', marginBottom: 8 }}>버튼 위치 변경</button>

        <div style={{ display: 'flex', gap: 6, marginBottom: 8, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
          <button type="button" onClick={() => openModalPosition('sell', { lot: twLots, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'manual' })}
            disabled={currentPrice == null || !live}
            style={{ flex: 1, height: 57, background: TW_SHORT_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 16, fontWeight: 700, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>SELL 🔴 매도</button>
          <button type="button" onClick={() => openModalPosition('buy', { lot: twLots, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'manual' })}
            disabled={currentPrice == null || !live}
            style={{ flex: 1, height: 57, background: TW_LONG_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 16, fontWeight: 700, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>BUY 🟢 매수</button>
        </div>

        <CollapsibleCard title="🎯 반자동 예약" maxWidth="none" defaultOpen={false}>
          {rowDef(1, { text: `1번: H1×H3\n${fmtTopBottom(h1, h3)}`, color: row1Color }, checked === 1, () => toggleCheck(1),
            <TwStatusDot active={row1Outside || !!row1Armed} colorA={row1Outside ? TW_STATUS_YELLOW : TW_STATUS_ORANGE} />,
            dirPair(1))}
          {rowDef(2, { text: `2번: H3×S5\n${fmtTopBottom(h3, sma100)}`, color: row2Color }, checked === 2, () => toggleCheck(2),
            <TwStatusDot active={h3 != null && sma100 != null} colorA={row2Golden ? TW_STATUS_BLUE_A : TW_STATUS_PINK_A} colorB={row2Golden ? TW_STATUS_BLUE_B : TW_STATUS_PINK_B} />,
            dirPair(2))}
          {rowDef(3, { text: `3번: 상승추세\n-`, color: row3Buy ? TW_TEXT_BLUE : TW_TEXT_GRAY }, checked === 3, () => toggleCheck(3),
            <TwStatusDot active={row3Buy} colorA={TW_STATUS_BLUE_A} colorB={TW_STATUS_BLUE_B} />,
            dirBtn('BUY 🟢 매수', dir?.row === 3, () => pressDir(3, 'buy'), true))}
          {rowDef(4, { text: `4번: 하락추세\n-`, color: row4Sell ? TW_TEXT_PINK : TW_TEXT_GRAY }, checked === 4, () => toggleCheck(4),
            <TwStatusDot active={row4Sell} colorA={TW_STATUS_PINK_A} colorB={TW_STATUS_PINK_B} />,
            dirBtn('SELL 🔴 매도', dir?.row === 4, () => pressDir(4, 'sell'), false))}
          {rowDef(5, { text: `5번: H60/H100\n${fmtTopBottom(h3, h100)}`, color: row5Golden ? TW_TEXT_BLUE : TW_TEXT_GRAY }, checked === 5, () => toggleCheck(5),
            <TwStatusDot active={h1 != null && sma20 != null && h1 > sma20} colorA={TW_STATUS_BLUE_A} colorB={TW_STATUS_BLUE_B} />,
            dirBtn('BUY 🟢 매수', dir?.row === 5, () => pressDir(5, 'buy'), true))}
          {rowDef(6, { text: `6번: H20/H60\n${fmtTopBottom(h3, h1)}`, color: row6Dead ? TW_TEXT_PINK : TW_TEXT_GRAY }, checked === 6, () => toggleCheck(6),
            <TwStatusDot active={h1 != null && sma20 != null && h1 < sma20} colorA={TW_STATUS_PINK_A} colorB={TW_STATUS_PINK_B} />,
            dirBtn('SELL 🔴 매도', dir?.row === 6, () => pressDir(6, 'sell'), false))}
        </CollapsibleCard>

        <div style={{ marginTop: 8 }}>
          <CollapsibleCard title="📋 신호 설명" maxWidth="none" defaultOpen={false}>
            <div style={{ fontSize: 11.5, color: '#c8ccd4', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
              {[
                checked === 1 && '1번: H1×H3\n   SMA100 밴드 바깥→안쪽 재진입으로 무장된 뒤, 그 방향과 맞는\n   H1×H3 크로스가 나오면 진입 (재진입·크로스는 동시일 필요 없음)',
                checked === 2 && '2번: H3(HMA60) × S5(SMA100) 크로스',
                checked === 3 && '3번: 상승추세 (매수 전용)\n   WMA85>SMA100, 1분스토 골든, 가격>HMA20, HMA20 상승중, HMA300 상승중',
                checked === 4 && '4번: 하락추세 (매도 전용)\n   WMA85<SMA100, 1분스토 데드, 가격<HMA20, HMA20 하락중, HMA300 하락중',
                checked === 5 && '5번: HMA20/SMA20 (매수 전용)\n   진입 - HMA60>HMA100, HMA20×SMA20 골든크로스\n   청산 - HMA20×HMA100 데드크로스 (항상 감시)',
                checked === 6 && '6번: HMA60×HMA100 (매도 전용)\n   진입 - HMA20<SMA20, HMA60×HMA100 데드크로스\n   청산 - HMA20×HMA60 골든크로스 (항상 감시)',
              ].filter(Boolean).join('\n\n') || '체크된 신호가 없습니다'}
            </div>
          </CollapsibleCard>
        </div>

        <button type="button" onClick={closeAllPositionsModal} style={{ width: '100%', marginTop: 10, background: '#FF5722', color: 'white', border: 'none', borderRadius: 5, padding: 10, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>{bulkLabel}</button>

        {renderTwMoveSlSlots()}
      </div>
    )
  }

  // 매매1 탭 - strategy1_tab.py와 동일(수동 SELL/BUY + 벌크청산 + 손절이동 4슬롯). 실시간 MT5 연동인
  // "손절이동" 클릭 시 실제 브로커 주문수정은 리플레이엔 없으니, 시뮬레이션 포지션의 sl 값을 진입가로 옮긴다.
  const renderTwStrategy1Tab = () => (
    <div>
      <button type="button" onClick={() => setTwSwapped(v => !v)} style={{ width: '100%', background: '#9E9E9E', color: 'white', border: 'none', borderRadius: 5, padding: 6, fontSize: 12.5, fontWeight: 700, cursor: 'pointer', marginBottom: 8 }}>버튼 위치 변경</button>
      <div style={{ display: 'flex', gap: 8, marginBottom: 10, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
        <button type="button" onClick={() => openModalPosition('sell', { lot: twLots, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'strategy1' })}
          disabled={currentPrice == null}
          style={{ flex: 1, padding: 20, background: TW_SHORT_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>SELL<br />🔴 매도</button>
        <button type="button" onClick={() => openModalPosition('buy', { lot: twLots, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'strategy1' })}
          disabled={currentPrice == null}
          style={{ flex: 1, padding: 20, background: TW_LONG_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>BUY<br />🟢 매수</button>
      </div>
      <button type="button" onClick={closeAllPositionsModal} style={{ width: '100%', background: '#FF5722', color: 'white', border: 'none', borderRadius: 5, padding: 15, fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>🚨 벌크 청산</button>
      {renderTwMoveSlSlots()}
    </div>
  )

  // 모달 본문(거래정보+체크박스+탭바+탭 내용) - 페이지 안 모달/새 창 둘 다 이 내용을 그대로 재사용한다.
  const renderTwInner = () => (
    <>
        <div style={{ border: '1px solid #2a2e38', borderRadius: 10, padding: 10, marginBottom: 10 }}>
          <div style={{ fontSize: 11.5, color: '#9aa0ab', marginBottom: 6, fontWeight: 700 }}>거래 정보</div>
          <div style={{ display: 'grid', gridTemplateColumns: 'auto 1fr auto', gap: '6px 10px', alignItems: 'center', fontSize: 12.5 }}>
            <span style={{ color: '#9aa0ab' }}>종목:</span>
            <span style={{ fontWeight: 700 }}>{symbol === 'GOLD' ? 'XAUUSD+' : 'NAS100'}</span>
            <span />
            <span style={{ color: '#9aa0ab' }}>잔고:</span>
            <span style={{ color: twMoneyColor(balance - startingBalance), fontWeight: 700 }}>${balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span>
            <span />
            <span style={{ color: '#9aa0ab' }}>랏수:</span>
            <input type="number" step={0.01} min={0.01} value={twLots} onChange={e => setTwLots(Math.max(0.01, Number(e.target.value) || 0.01))}
              style={{ width: 80, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '4px 6px', fontSize: 12.5 }} />
            <span />
            <span style={{ color: '#9aa0ab' }}>손절(포인트):</span>
            <input type="number" min={1} value={twSl} disabled={!twUseSl} onChange={e => setTwSl(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 80, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '4px 6px', fontSize: 12.5, opacity: twUseSl ? 1 : 0.5 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#4CAF50', fontWeight: 700, fontSize: 11.5 }}>
              <input type="checkbox" checked={twUseSl} onChange={e => setTwUseSl(e.target.checked)} /> 사용
            </label>
            <span style={{ color: '#9aa0ab' }}>익절(포인트):</span>
            <input type="number" min={1} value={twTp} disabled={!twUseTp} onChange={e => setTwTp(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 80, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '4px 6px', fontSize: 12.5, opacity: twUseTp ? 1 : 0.5 }} />
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: '#4CAF50', fontWeight: 700, fontSize: 11.5 }}>
              <input type="checkbox" checked={twUseTp} onChange={e => setTwUseTp(e.target.checked)} /> 사용
            </label>
          </div>
        </div>

        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#1976D2', fontWeight: 700, fontSize: 12, cursor: 'pointer', marginBottom: 8 }}>
          <input type="checkbox" checked={twTpExitCross} onChange={e => { setTwTpExitCross(e.target.checked); if (e.target.checked) setTwUseTp(false) }} />
          ✅ 익절: H1×H3 크로스 청산 (숏=골든청산 / 롱=데드청산)
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 8, color: '#FF9800', fontWeight: 700, fontSize: 12, cursor: 'pointer', marginBottom: 10 }}>
          <input type="checkbox" checked={twSkipPopup} onChange={e => setTwSkipPopup(e.target.checked)} /> 팝업 확인 제외 (빠른 거래)
        </label>

        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {[['strategy1', '매매1'], ['gold', '골드'], ['nasdaq', '나스닥']].map(([id, label]) => (
            <button key={id} type="button" onClick={() => setTwTab(id)} style={{
              flex: 1, padding: '8px 0', fontSize: 12.5, fontWeight: 700, borderRadius: 7, cursor: 'pointer',
              border: `1px solid ${twTab === id ? '#4CAF50' : '#2a2e38'}`,
              background: twTab === id ? 'rgba(76,175,80,0.15)' : 'none',
              color: twTab === id ? '#4CAF50' : '#9aa0ab',
            }}>{label}</button>
          ))}
        </div>

        {twTab === 'strategy1' && renderTwStrategy1Tab()}
        {twTab === 'gold' && renderTwReservationTab('gold')}
        {twTab === 'nasdaq' && renderTwReservationTab('nasdaq')}
    </>
  )

  // 페이지 안 모달 - 드래그로 위치 이동 + 우측 하단 모서리로 좌우/상하 크기 조절(CSS resize) 가능.
  const renderTwEmbedded = () => (
    <div style={{
      position: 'fixed', left: twPos.x, top: twPos.y, width: 400, height: 700,
      minWidth: 340, minHeight: 320, maxWidth: '92vw', maxHeight: '92vh',
      resize: 'both', overflow: 'auto',
      background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      zIndex: 1000, fontSize: 13,
    }}>
      <div onMouseDown={onTwHeaderMouseDown} style={{
        position: 'sticky', top: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px',
        background: '#171a21', borderBottom: '1px solid #2a2e38', cursor: 'move', userSelect: 'none', zIndex: 1,
      }}>
        <span style={{ fontWeight: 700, fontSize: 13.5 }}>🖱 매매 실행 (분리매매창)</span>
        <span style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={openTwPopup} title="진짜 새 창으로 분리해서 열기 (크기 자유 조절, 리플레이와 계속 연동됨)"
            style={{ background: 'none', border: 'none', color: '#9aa0ab', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>🗗</button>
          <button type="button" onClick={() => setShowTradingWindow(false)} style={{ background: 'none', border: 'none', color: '#9aa0ab', fontSize: 16, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </span>
      </div>
      <div style={{ padding: 14 }}>{renderTwInner()}</div>
    </div>
  )

  // 새 창(팝업) - window.open으로 띄운 실제 브라우저 창 document에 portal로 렌더. 같은 origin이라
  // React state를 공유하므로 여기서 BUY/SELL을 눌러도 이 페이지의 포지션·잔고에 곧바로 반영된다.
  const renderTwPopupContent = () => (
    <div style={{ padding: 14, color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 14, marginBottom: 8 }}>
        <button type="button" onClick={closeTwPopup} title="이 창을 닫고 페이지 안 모달로 다시 붙이기"
          style={{ background: 'none', border: '1px solid #2a2e38', borderRadius: 7, color: '#9aa0ab', fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>🔗 페이지에 다시 붙이기</button>
        <button type="button" onClick={() => { closeTwPopup(); setShowTradingWindow(false) }}
          style={{ background: 'none', border: '1px solid #2a2e38', borderRadius: 7, color: '#9aa0ab', fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>✕ 닫기</button>
      </div>
      {renderTwInner()}
    </div>
  )

  return (
    <>
      <Head><title>리플레이 차트 시뮬레이션 — EasyTrade</title></Head>
      <div className="bt-page" style={{ minHeight: '100vh', background: '#0f1115', color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
        <style>{`
          /* styles/site.css의 전역 button { width:100%; margin-top:20px }이
             재생/속도 버튼들을 세로로 늘려버리는 문제를 이 페이지 안에서만 되돌린다. */
          .bt-page button { width: auto; margin-top: 0; }
        `}</style>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 28px', borderBottom: '1px solid #2a2e38' }}>
          <BrandLogo label="리플레이" />
          <nav style={{ display: 'flex', gap: 6 }}>
            <Link href="/backtest-chart" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>학습</Link>
            <Link href="/backtest-intraday" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>📈 일중 패턴</Link>
            <span style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'rgba(76,175,80,0.15)', color: '#4CAF50', border: '1px solid #4CAF50' }}>🔁 리플레이</span>
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
                  dateColors={uploadedTradeDateColors}
                  bare
                />
              </CollapsibleCard>

              <CollapsibleCard title="📤 매매내역 업로드" maxWidth={170} defaultOpen={true}>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                  <label
                    onDragOver={e => { e.preventDefault(); setTradeDragOver(true) }}
                    onDragLeave={() => setTradeDragOver(false)}
                    onDrop={handleTradeCsvDrop}
                    style={{
                      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 6,
                      fontSize: 11, padding: '8px 6px', borderRadius: 8, cursor: 'pointer',
                      border: `1px dashed ${tradeDragOver ? '#4CAF50' : '#2a2e38'}`,
                      background: tradeDragOver ? 'rgba(76,175,80,0.08)' : 'transparent',
                      color: '#9aa0ab', textAlign: 'center', transition: 'all 0.15s',
                    }}
                  >
                    📥 CSV 선택 또는 드래그
                    <input type="file" accept=".csv" style={{ display: 'none' }} onChange={handleTradeCsvUpload} />
                  </label>
                  {uploadedTradeFile && (
                    <>
                      <div style={{ fontSize: 11, color: '#9aa0ab', wordBreak: 'break-all' }}>{uploadedTradeFile} ({uploadedTradeCount}건)</div>
                      <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 11, color: '#9aa0ab', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={showUploadedTrades}
                          onChange={e => toggleShowUploadedTrades(e.target.checked)}
                          style={{ width: 12, height: 12, margin: 0, flexShrink: 0 }}
                        />
                        차트에 표시
                      </label>
                      <button
                        type="button"
                        onClick={clearUploadedTrades}
                        style={{ fontSize: 11, padding: '4px 8px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#F44336', cursor: 'pointer' }}
                      >지우기</button>
                      <div style={{ fontSize: 10, color: '#6b7280', lineHeight: 1.6 }}>
                        <span style={{ color: '#C6FF00' }}>▲</span>롱진입&nbsp;
                        <span style={{ color: '#AB47BC' }}>▼</span>숏진입<br />
                        <span style={{ color: '#FFFFFF' }}>●</span>손절&nbsp;
                        <span style={{ color: '#26A69A' }}>●</span>익절&nbsp;
                        <span style={{ color: '#FF9800' }}>●</span>전환&nbsp;
                        <span style={{ color: '#FFC107' }}>●</span>볼린저 이탈<br />
                        <span style={{ color: '#FFC107' }}>■</span>달력에 매매 있는 날<br />
                        ⚠ 나쁜 조합(1차/2차/3차 분류상 건당평균 마이너스)
                      </div>
                      {uploadedTradeRows.length > 0 ? (
                        <div style={{ maxHeight: 220, overflowY: 'auto', display: 'flex', flexDirection: 'column', gap: 4, marginTop: 4 }}>
                          {uploadedTradeRows.map((r, i) => (
                            <div
                              key={i}
                              onClick={() => goToTradeEntry(r)}
                              title="클릭하면 진입 시점으로 이동 (다른 날짜면 그 날짜를 새로 불러옴, 재생 위치는 그대로 유지)"
                              style={{
                                fontSize: 10.5, padding: '5px 6px', borderRadius: 6, cursor: 'pointer',
                                background: r.comboLabel === '나쁜' ? 'rgba(244,67,54,0.10)' : '#0f1115',
                                border: r.comboLabel === '나쁜' ? '1px solid #F44336' : '1px solid #2a2e38',
                                lineHeight: 1.6,
                              }}
                            >
                              <div>
                                <span style={{ color: r.dir === 'long' ? '#C6FF00' : '#AB47BC', fontWeight: 700 }}>
                                  {r.dir === 'long' ? '▲롱' : '▼숏'}
                                </span>
                                {' / '}
                                <span style={{ color: '#6b7280' }}>{r.pnl > 0 ? '+' : ''}{r.pnl.toFixed(1)}pt</span>
                              </div>
                              {r.comboLabel && (
                                <div style={{ color: r.comboLabel === '나쁜' ? '#F44336' : '#4CAF50', marginTop: 1, fontWeight: r.comboLabel === '나쁜' ? 700 : 400 }}>
                                  {r.comboLabel === '나쁜' ? '⚠ 나쁜조합' : '좋은조합'}
                                </div>
                              )}
                              {r.combo && (
                                <div style={{ color: r.comboLabel === '나쁜' ? '#F44336' : '#4CAF50', marginTop: 1 }}>
                                  ({r.combo})
                                </div>
                              )}
                              {r.pattern && (
                                <div style={{ color: '#e8eaed', marginTop: 1, fontWeight: 700 }}>
                                  {r.pattern}
                                </div>
                              )}
                              <div style={{ marginTop: 1 }}>
                                {r.entryIdx != null ? `${tradeNumLabel(r.num, r.entryIdx)}(${fmtHm(r.entryTime)})` : '이전구간'}
                                {' → '}
                                <span style={{ color: uploadedExitColor(r.exitReason) }}>
                                  {r.exitIdx != null ? `${tradeNumLabel(r.num, r.exitIdx)}(${fmtHm(r.exitTime)})` : '다음구간'}
                                </span>
                              </div>
                              <div style={{ color: r.breakoutTime != null ? '#FFC107' : '#6b7280', marginTop: 1 }}>
                                {r.breakoutTime != null
                                  ? `${r.breakoutDir || ''}이탈: ${r.breakoutIdx != null ? `${tradeNumLabel(r.num, r.breakoutIdx)}(${fmtHm(r.breakoutTime)})` : fmtHm(r.breakoutTime)}`
                                  : '이탈: 크로스전환(새 돌파 없음)'}
                              </div>
                              <div style={{ color: '#6b7280', marginTop: 1 }}>
                                진입가 {r.entryPrice != null ? r.entryPrice.toFixed(2) : '-'}
                              </div>
                              <div style={{ color: '#6b7280', marginTop: 1 }}>
                                청산가 {r.exitPrice != null ? r.exitPrice.toFixed(2) : '-'}
                              </div>
                            </div>
                          ))}
                        </div>
                      ) : (
                        <div style={{ fontSize: 10.5, color: '#6b7280', marginTop: 4 }}>이 구간엔 해당 파일의 매매가 없어요 — 노란 날짜를 먼저 불러오세요.</div>
                      )}
                    </>
                  )}
                  {uploadedTradeError && <div style={{ fontSize: 11, color: '#F44336' }}>{uploadedTradeError}</div>}
                </div>
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

              <CollapsibleCard title="볼린저" maxWidth={170} defaultOpen={false}>
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

              {/* 도치안 채널(Donchian Channel) - 볼린저는 매 순간 표준편차로 출렁여서 판단 기준으로 쓰기
                  어렵다는 사용자 피드백으로 추가. 상/중/하 3선 구조와 토글/색상 파이프라인(enabledBands,
                  bandColors, toggleBand, isLineVisible, toggleLine, getBandColor, resetBandColor)을
                  볼린저와 완전히 공유한다(둘 다 ALL_BANDS 소속, bandId만 다름) - 카드만 따로 분리. */}
              <CollapsibleCard title="도치안 채널" maxWidth={170} defaultOpen={false}>
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
                <div style={{ padding: '3px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledStoch1}
                      onChange={toggleStoch1}
                      style={{ width: 13, height: 13, margin: 0, accentColor: stoch1KColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>스토(14,3,3)</span>
                  </label>
                  {enabledStoch1 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                      <span>%K</span>
                      <input
                        type="color" value={stoch1KColor} onChange={e => setStoch1KColor(e.target.value)}
                        title="%K선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                      <span>%D</span>
                      <input
                        type="color" value={stoch1DColor} onChange={e => setStoch1DColor(e.target.value)}
                        title="%D선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </div>
                  )}
                </div>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledStoch2}
                      onChange={toggleStoch2}
                      style={{ width: 13, height: 13, margin: 0, accentColor: stoch2KColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>스토(7,2,2)</span>
                  </label>
                  {enabledStoch2 && (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                      <span>%K</span>
                      <input
                        type="color" value={stoch2KColor} onChange={e => setStoch2KColor(e.target.value)}
                        title="%K선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                      <span>%D</span>
                      <input
                        type="color" value={stoch2DColor} onChange={e => setStoch2DColor(e.target.value)}
                        title="%D선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </div>
                  )}
                </div>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledStoch3}
                      onChange={toggleStoch3}
                      style={{ width: 13, height: 13, margin: 0, accentColor: stoch3KColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>스토(70,15,15)</span>
                  </label>
                  {enabledStoch3 && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                        <span>%K</span>
                        <input
                          type="color" value={stoch3KColor} onChange={e => setStoch3KColor(e.target.value)}
                          title="%K선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                        />
                        <span>%D</span>
                        <input
                          type="color" value={stoch3DColor} onChange={e => setStoch3DColor(e.target.value)}
                          title="%D선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                        />
                      </div>
                      <div style={{ marginLeft: 19, marginTop: 3, fontSize: 9.5, color: '#5a5f6a', lineHeight: 1.4 }}>
                        5분B 밖으로 나간 뒤 아직 안 돌아온 상태에서 K/D가 교차하면 세로줄 표시(골든=라임, 데드=레드). 밴드 안으로 돌아온 뒤의 교차는 표시 안 함.
                      </div>
                    </>
                  )}
                </div>
              </CollapsibleCard>

              <CollapsibleCard title="크로스 신호" maxWidth={170} defaultOpen={false}>
                {renderCrossRow('골든크로스', goldenShape, setGoldenShape, goldenColor, setGoldenColor, goldenSize, setGoldenSize)}
                {renderCrossRow('데드크로스', deadShape, setDeadShape, deadColor, setDeadColor, deadSize, setDeadSize)}
                {renderPairSlots(crossPairs, setCrossPair, MOVING_AVERAGES, '크로스')}
              </CollapsibleCard>

              <CollapsibleCard title="5분 슈팅" maxWidth={170} defaultOpen={false}>
                <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                  <input
                    type="checkbox"
                    checked={shooting5MinEnabled}
                    onChange={e => toggleShooting5Min(e.target.checked)}
                    style={{ width: 13, height: 13, margin: 0, accentColor: SHOOTING_5MIN_COLOR, flexShrink: 0 }}
                  />
                  <span style={{ flex: 1 }}>5분 볼린저 이탈 표시</span>
                </label>
                <p style={{ color: '#6b7280', fontSize: 10.5, marginTop: 6, marginBottom: 0, lineHeight: 1.5 }}>
                  고가/저가가 5분 볼린저를 조금이라도 뚫은 지점을 꼬리 끝(정확한 가격)에 표시합니다.
                </p>
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
                <div ref={containerRef} style={{ width: '100%', height: 750 }} />
                {/* 캔들 타이머 - 차트 구석에 고정된 배지가 아니라, 재생 위치(마지막으로 그려진 캔들)를
                    거리를 두고 계속 따라다녀야 한다는 지적(사용자) - updateTimerAnchor가 그 캔들의
                    시각/종가를 실제 화면 좌표로 변환해서 timerAnchor에 넣어두면 그 좌표 기준으로 뜬다.
                    컨테이너 padding(16px)만큼 보정하고, 캔들 오른쪽으로 40px 떨어뜨린다(사용자 요청 -
                    캔들에 너무 붙어 있어서 간격을 더 벌림).
                    pointerEvents:none이라 차트 드래그/줌 조작은 그대로 통과한다. */}
                {timerAnchor && (
                  <span title="다음 캔들이 그려질 때까지 남은 시간" style={{
                    position: 'absolute', left: timerAnchor.x + 16 + 40, top: timerAnchor.y + 16 - 15,
                    zIndex: 5, pointerEvents: 'none', whiteSpace: 'nowrap',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'rgba(23,26,33,0.92)', border: '1px solid #2a2e38', borderRadius: 9,
                    padding: '6px 12px', fontSize: 14, fontWeight: 700,
                    color: playing ? '#4CAF50' : '#9aa0ab', fontVariantNumeric: 'tabular-nums',
                  }}>⏱ {formatCandleTimer(candleTimerMs)}</span>
                )}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
                <span style={{ color: '#9aa0ab', fontSize: 13 }}>{playIndex.toLocaleString()} / {total.toLocaleString()}봉</span>
                {selectedDate && (
                  <span style={{ color: '#e8eaed', fontSize: 13, fontWeight: 700 }}>
                    {selectedDateTo ? `${selectedDate} ~ ${selectedDateTo}` : selectedDate}
                  </span>
                )}
              </div>
              {/* 파란 바 - 재생 버튼/재생 위치(빨간 바)와는 완전히 무관, 사용자가 직접 드래그할 때만
                  움직인다(그 외엔 항상 맨 끝). 드래그하면 화면(카메라)만 그 지점으로 옮기고, 재생 위치나
                  이미 그려진 캔들은 그대로 유지된다. */}
              <div
                ref={blueBarRef}
                onMouseDown={onBlueBarMouseDown}
                title="드래그하면 화면만 그 캔들로 이동합니다 (재생 위치는 그대로 유지됩니다)"
                style={{
                  position: 'relative', width: '100%', height: 16, marginTop: 8,
                  background: '#2a2e38', borderRadius: 8, overflow: 'visible',
                  cursor: total ? 'pointer' : 'not-allowed', opacity: total ? 1 : 0.5,
                }}
              >
                <div style={{
                  position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 8,
                  width: `${total ? Math.min(100, (bluePos / total) * 100) : 0}%`,
                  background: '#4FC3F7', pointerEvents: 'none',
                }} />
                <div style={{
                  position: 'absolute', top: '50%', left: `${total ? Math.min(100, (bluePos / total) * 100) : 0}%`,
                  width: 18, height: 18, marginLeft: -9, marginTop: -9, borderRadius: '50%',
                  background: '#4FC3F7', border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.5)', pointerEvents: 'none',
                }} />
              </div>

              {/* 빨간 바 - 재생 버튼과만 연동(재생하면 자동으로 채워짐), 파란 바와는 완전히 독립.
                  드래그하면 화면(카메라)만 그 시점으로 옮기고(scrubView, 이미 드러난 캔들은 안 사라짐)
                  재생 위치(playIndex) 자체도 그 자리로 같이 옮겨둔다 - 손을 떼도 스냅백 없이 그
                  자리에 그대로 있고, 다음 ▶재생은 거기서부터 이어진다. */}
              <div
                ref={scrubBarRef}
                onMouseDown={onScrubBarMouseDown}
                title="드래그하면 그 자리로 재생 위치가 옮겨갑니다(캔들은 안 사라짐) - 손을 떼도 그 자리에 그대로 있고, 다음 재생은 여기서부터 이어집니다"
                style={{
                  position: 'relative', width: '100%', height: 16, marginTop: 8,
                  background: '#2a2e38', borderRadius: 8, overflow: 'visible',
                  cursor: total ? 'pointer' : 'not-allowed', opacity: total ? 1 : 0.5,
                }}
              >
                <div style={{
                  position: 'absolute', left: 0, top: 0, height: '100%', borderRadius: 8,
                  width: `${total ? Math.min(100, (redPos / total) * 100) : 0}%`,
                  background: '#F44336', pointerEvents: 'none', transition: playing ? 'width 0.15s linear' : 'none',
                }} />
                <div style={{
                  position: 'absolute', top: '50%', left: `${total ? Math.min(100, (redPos / total) * 100) : 0}%`,
                  width: 18, height: 18, marginLeft: -9, marginTop: -9, borderRadius: '50%',
                  background: '#F44336', border: '2px solid #fff', boxShadow: '0 1px 4px rgba(0,0,0,0.5)', pointerEvents: 'none',
                }} />
              </div>

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

                {SPEEDS.map(s => {
                  const secs = REALTIME_MS / s / 1000
                  const secsLabel = secs >= 60 ? `${(secs / 60).toFixed(secs % 60 === 0 ? 0 : 1)}분` : `${secs.toFixed(secs % 1 === 0 ? 0 : 1)}초`
                  // 버튼에 배속마다 캔들 1개 그려지는 데 몇 초 걸리는지 바로 보이게(사용자 요청) - 예: x1 (60s), x3 (20s)
                  const secDisplay = secs % 1 === 0 ? `${secs}` : secs.toFixed(1)
                  return (
                    <button key={s} onClick={() => setSpeed(s)} title={`캔들 1개 = ${secsLabel}`} style={{
                      background: speed === s ? '#2a2e38' : 'none', color: speed === s ? '#e8eaed' : '#9aa0ab',
                      border: '1px solid #2a2e38', borderRadius: 9, padding: '8px 12px', fontSize: 13, cursor: 'pointer',
                    }}>x{s} ({secDisplay}s)</button>
                  )
                })}
              </div>
              <div style={{ fontSize: 12.5, color: '#c8ccd4', marginTop: 6, fontWeight: 500 }}>
                x1 = 1분당 캔들 1개(실제 시세 속도). 배속은 그 배수 — x2=30초/캔들, x60=1초/캔들
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

                  <button
                    type="button" onClick={() => setShowTradingWindow(v => !v)}
                    style={{
                      marginLeft: 'auto', fontSize: 12, padding: '8px 14px', borderRadius: 9, cursor: 'pointer', fontWeight: 700,
                      border: `1px solid ${showTradingWindow ? '#4CAF50' : '#2a2e38'}`,
                      background: showTradingWindow ? 'rgba(76,175,80,0.15)' : 'none',
                      color: showTradingWindow ? '#4CAF50' : '#9aa0ab',
                    }}
                  >🖱 매매 실행 (분리매매창){showTradingWindow ? ' 닫기' : ''}</button>

                  <span style={{ fontSize: 11, color: '#5a5f6a', width: '100%' }}>
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

                </CollapsibleCard>
              </div>
            </div>
          </div>

          <div style={{ marginTop: 40, background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 24 }}>
            <h2 style={{ fontSize: 16, fontWeight: 800, marginBottom: 12 }}>📤 매매내역 업로드 — CSV 형식 안내</h2>
            <p style={{ color: '#9aa0ab', fontSize: 13.5, lineHeight: 1.7, marginBottom: 12 }}>
              직접 돌린 백테스트 결과(진입/청산 시각·가격·손익)를 CSV로 만들어 왼쪽 "📤 매매내역 업로드" 카드에 올리면,
              이 캔들 차트 위에 진입(▲롱 / ▼숏)·청산(●손절 빨강 / ●익절 초록 / ●크로스전환 주황) 마커로 겹쳐서 볼 수 있어요.
              날짜 범위를 불러오면 재생하지 않아도 그 안의 매매가 바로 전부 표시됩니다.
            </p>
            <p style={{ color: '#9aa0ab', fontSize: 13.5, lineHeight: 1.7, marginBottom: 12 }}>
              CSV는 아래 10개 컬럼을 헤더 그대로 가진 형식이어야 해요(뒤에 컬럼이 더 있어도 무시하고 앞 10개만 읽어요):
            </p>
            <div style={{ background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 8, padding: '10px 14px', fontSize: 12.5, color: '#e8eaed', overflowX: 'auto', marginBottom: 14, fontFamily: 'monospace' }}>
              진입날짜,진입시간,방향,진입가,청산날짜,청산시간,청산가,보유시간(분),청산사유,손익(pt)
              <span style={{ color: '#6b7280' }}>[,이탈날짜,이탈시각,이탈방향]</span>
            </div>
            <ul style={{ color: '#9aa0ab', fontSize: 13, lineHeight: 1.8, marginBottom: 16, paddingLeft: 20 }}>
              <li><b style={{ color: '#e8eaed' }}>진입날짜/청산날짜</b>: YYYY-MM-DD</li>
              <li><b style={{ color: '#e8eaed' }}>진입시간/청산시간</b>: HH:MM:SS (한국시간 기준)</li>
              <li><b style={{ color: '#e8eaed' }}>방향</b>: 롱 또는 숏</li>
              <li><b style={{ color: '#e8eaed' }}>청산사유</b>: <code>SL</code>로 시작하면 손절(빨강), <code>TP</code>로 시작하면 익절(초록), <code>flip</code>으로 시작하면 크로스전환(주황)으로 표시돼요</li>
              <li><b style={{ color: '#e8eaed' }}>이탈날짜/이탈시각/이탈방향</b>(선택): 이 진입을 만든 5분B 볼린저 이탈 시점 — 새 돌파 없이 크로스만으로 전환된 진입은 비어있어요. 화면 표시엔 안 쓰고 CSV 안에서 참고용으로만 남겨둬요.</li>
            </ul>
            <a
              href="/sample-trades.csv"
              download="sample-trades.csv"
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 8, padding: '10px 18px', borderRadius: 9,
                background: '#4CAF50', color: '#fff', fontWeight: 700, fontSize: 13.5, textDecoration: 'none',
              }}
            >📥 샘플 CSV 다운로드</a>
            <p style={{ color: '#6b7280', fontSize: 12, marginTop: 10 }}>
              실제 백테스트 결과 6건(롱 익절·롱 손절·숏 익절·숏 손절·크로스전환 2건)이 담긴 샘플이에요. 다운로드한 파일을 그대로 왼쪽 업로드 카드에 올려서
              동작을 먼저 확인해본 뒤, 자신의 결과 CSV로 바꿔 올리면 됩니다. 업로드하면 달력에서 매매가 있는 날짜가 노란색으로 표시되니, 그 날짜를 눌러 불러오면 왼쪽 카드에 캔들 번호와 함께 목록이 뜨고 클릭하면 그 위치로 바로 이동해요.
            </p>
          </div>
        </main>

        {showTradingWindow && !twPopupEl && renderTwEmbedded()}
        {showTradingWindow && twPopupEl && createPortal(renderTwPopupContent(), twPopupEl)}
      </div>
    </>
  )
}
