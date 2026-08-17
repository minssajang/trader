import { useState, useEffect, useRef, useCallback, useMemo } from 'react'
import { createPortal } from 'react-dom'
import Head from 'next/head'
import Link from 'next/link'
import { createChart, CrosshairMode, CandlestickSeries, LineSeries, HistogramSeries, createSeriesMarkers } from 'lightweight-charts'
import BrandLogo from '../components/BrandLogo'
import { MonthCalendar, CollapsibleCard, buildAvailableDates } from '../components/BacktestCalendar'
import { parseCandleCsv, toLocalDateStr, toUnixSeconds, BROKER_OFFSET_SECONDS } from '../lib/candleCsv'
import { supabaseClient } from '../lib/supabaseClient'
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
        // 얇은 실선 대신 캔들 폭 정도의 반투명 배경 밴드로(트레이딩뷰 하이라이트 방식, 사용자 요청) -
        // barSpacing(현재 줌 배율의 캔들 간격)의 80%를 몸통 폭으로 근사해서, 줌을 바꿔도 항상
        // 캔들 두께와 비슷하게 유지된다. color는 호출 쪽에서 이미 rgba(투명도 포함)로 넘어온다.
        draw: (target) => {
          if (!this._lines.length || !this._chart) return
          const ts = this._chart.timeScale()
          const barWidth = (ts.options().barSpacing || 6) * 0.8
          target.useBitmapCoordinateSpace((scope) => {
            const ctx = scope.context
            const ratio = scope.horizontalPixelRatio
            const halfW = Math.max(ratio, (barWidth * ratio) / 2)
            ctx.save()
            for (const line of this._lines) {
              const x = ts.timeToCoordinate(line.time)
              if (x == null) continue
              const px = x * ratio
              ctx.fillStyle = line.color
              ctx.fillRect(px - halfW, 0, halfW * 2, scope.bitmapSize.height)
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
// hma20(1분 H)도 3분/5분 H처럼 상/하 듀얼로 전환(사용자 요청) - 상승은 원래 단색(#F44336) 그대로,
// 하락은 화이트로. wma17_1m(1분 W17)은 상/하 둘 다 rgb(41,0,245)로 지정(사용자 요청).
// 1분/3분/5분/1시간 H는 하락색을 상승색과 동일하게 통일(사용자 요청 - 사실상 단색으로 보임),
// 1시간H(hma1200)는 블루로 지정(사용자 요청). 15분H(hma300)만 예외 - 상승은 라임 그대로,
// 하락은 스토(210,45,45) 하락색과 맞춰 레드(rgb(250,0,0))로 지정(사용자 요청).
const DUAL_DEFAULT_UP_COLOR = { hma20: '#F44336', hma60: '#00D5FF', hma100: '#FF9800', hma300: '#6DFF38', hma1200: '#1F43F4', wma17_1m: '#2900F5', wma17_5m: '#4FC3F7', wma4_1h: '#FFEB3B' }
const DUAL_DEFAULT_DOWN_COLOR = { hma20: '#F44336', hma60: '#00D5FF', hma100: '#FF9800', hma300: '#FA0000', hma1200: '#1F43F4', wma17_1m: '#2900F5', wma17_5m: '#4FC3F7', wma4_1h: '#FFEB3B' }
// 리본 18개 + "1분/3분/5분/15분/1시간 H"(hma20/hma60/hma100/hma300/hma1200, 사용자 요청) - 이 id들은
// 단색 대신 상승/하락 두 색으로 동적 렌더링한다.
const DUAL_COLOR_IDS = new Set([...MADRID_RIBBON.map(m => m.id), 'hma20', 'hma60', 'hma100', 'hma300', 'hma1200', 'wma17_1m', 'wma17_5m', 'wma4_1h'])
const isDualColor = (maId) => DUAL_COLOR_IDS.has(maId)
// 볼린저 중심선만 위/아래(upper/lower)와 다른 고정 색을 쓰는 경우(사용자 요청 - "1분 볼린저 중심선"만
// rgb(250,17,0)). upper/lower는 그대로 bandColors(공용 색상 피커) 대상이고, 이 override는 middle에만 적용된다.
const BOLLINGER_MIDDLE_COLOR_OVERRIDE = { sma20: '#FA1100' }
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
// 데이터 끊김(stale)이 진짜 장애인지 그냥 주말 휴장인지 구분용 - 브라우저 로컬 시각 기준 토/일요일이면
// 주말로 본다. 주말은 통째로 이틀이라 브로커 시간대 오차(몇 시간) 정도는 오분류에 영향이 거의 없다.
const isWeekendNow = () => {
  const day = new Date().getDay() // 0=일, 6=토
  return day === 0 || day === 6
}

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
// 스토캐스틱 4세트(사용자 요청 그대로): [kPeriod, kSmooth(Slow%K), dPeriod(%D)]
const STOCH1_PARAMS = [14, 3, 3]
const STOCH2_PARAMS = [7, 2, 2]
const STOCH3_PARAMS = [70, 15, 15]
const STOCH4_PARAMS = [210, 45, 45]
// EasyTrade_MT5 데스크톱 앱의 "분리매매창" 골드/나스닥 탭 반자동 예약(3/4번 신호)이 쓰는
// 1분 스토캐스틱 - _MarketDataWorker의 _ta.stoch(k=5, d=3, smooth_k=3)와 동일 (kPeriod,kSmooth,dPeriod 순)
const STOCH_RESERVE_PARAMS = [5, 3, 3]
// 9,10번(사용자 요청)용 스토캐스틱 2세트 - 반자동 예약 카드 전용(차트에 그리는 stoch3와 파라미터는
// 같지만(70,15,15) 별도로 다시 계산함 - computeReservationSeries는 차트 렌더링 코드와 분리돼 있음).
const STOCH_RESERVE2_PARAMS = [70, 15, 15]
const STOCH_RESERVE3_PARAMS = [210, 45, 45]

// 분리매매창(PyQt "매매 실행" 창) 색상 팔레트 - EasyTrade_MT5 1_1_trading_window.py /
// trading_window_tabs/{strategy1_tab,hma_reservation_tab,nas100_tab}.py의 setStyleSheet 값 그대로.
const TW_SHORT_OFF = '#F44336', TW_SHORT_OFF_HOVER = '#D32F2F'
const TW_SHORT_ON = '#7F0000'
const TW_LONG_OFF = '#4CAF50', TW_LONG_OFF_HOVER = '#388E3C'
const TW_LONG_ON = '#1B5E20'
const TW_STATUS_OFF = { bg: '#EEEEEE', border: '#BDBDBD' }
const TW_STATUS_YELLOW = { bg: '#FBC02D', border: '#F57F17' }
const TW_STATUS_ORANGE = { bg: '#FB8C00', border: '#E65100' }
// 원래 파랑/핑크였던 걸 롱=라임/셀=레드로 변경(사용자 요청) - RIBBON_LIME/RIBBON_RED와 같은 색 그대로 재사용.
const TW_STATUS_LIME_A = { bg: RIBBON_LIME, border: '#00B300' }
const TW_STATUS_LIME_B = { bg: '#B9FFB9', border: RIBBON_LIME }
const TW_STATUS_RED_A = { bg: RIBBON_RED, border: '#B30000' }
const TW_STATUS_RED_B = { bg: '#FFB3B3', border: RIBBON_RED }
const TW_READY_OFF = { color: '#757575', border: '#BDBDBD' }
const TW_TEXT_GRAY = '#9E9E9E', TW_TEXT_ORANGE = '#FB8C00', TW_TEXT_LIME = RIBBON_LIME, TW_TEXT_RED = RIBBON_RED
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
  // 🛑 손절: 이평선 따라가기 15분상Bol/15분하Bol(사용자 요청) - 15분봉 상당 볼린저(period=300,
  // BOLLINGER_BANDS의 sma300과 동일 기간).
  const { ups: bbUp300, lows: bbLo300 } = rollingBollinger(closes, 300)
  // 🛑 손절: 이평선 따라가기 5D-상단/5D-하단(사용자 요청) - 도치안 채널(D)의 5분(don100, period=100)
  // 상/하단. 볼린저(bbUp/bbLo)와 달리 그 기간의 실제 고점/저점이 갱신될 때만 움직인다.
  const { ups: donUp5, lows: donLo5 } = rollingDonchian(fullRows, 100)
  const stoch = rollingStochastic(fullRows, ...STOCH_RESERVE_PARAMS)
  const stochGolden = closes.map((_, i) => (stoch.k[i] != null && stoch.d[i] != null) ? stoch.k[i] > stoch.d[i] : null)
  // 9,10번(사용자 요청) - 스토(70,15,15)/(210,45,45) 두 세트의 골든/데드 상태
  const stoch70 = rollingStochastic(fullRows, ...STOCH_RESERVE2_PARAMS)
  const stoch70Golden = closes.map((_, i) => (stoch70.k[i] != null && stoch70.d[i] != null) ? stoch70.k[i] > stoch70.d[i] : null)
  const stoch210 = rollingStochastic(fullRows, ...STOCH_RESERVE3_PARAMS)
  const stoch210Golden = closes.map((_, i) => (stoch210.k[i] != null && stoch210.d[i] != null) ? stoch210.k[i] > stoch210.d[i] : null)

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

  return { closes, h1, h3, h100, h300, wma17_1m, sma20_1m, wma85, sma100, wma255, sma300, bbUp, bbLo, bbUp300, bbLo300, donUp5, donLo5, stochGolden, row1Armed, stoch70Golden, stoch210Golden }
}

// computeReservationSeries의 배열들을 훑어서 신호별 발생 이벤트를 dayRows 기준 idx(=i-startIdx)로
// 뽑아둔다 - 반자동/시뮬레이션 크로스(autoEventsRef 등)와 완전히 같은 "미리 계산해두고 재생 구간만
// 필터링" 방식. row3/4(상태 조건)는 조건이 참인 매 캔들마다 이벤트를 만들어서, 무장 후 첫 캔들에
// 바로 발동하게 한다(PyQt 쪽도 매초 조건을 그대로 검사하므로 동일).
// 2026-08-14: 화면(반자동 예약 카드)의 준비/진입 로직을 여러 번 고치면서 실제 자동발동 로직인 이
// 함수는 안 맞춰뒀던 부분을 사용자 지적으로 전부 맞춤. row1의 매수 트리거(H1×H3 골든→H3×H100
// 골든), row2의 두 방향 전부(H3×SMA100 크로스 자체→H3 vs SMA100 상태 + H1×S20 크로스), row6Entry
// (H3×H100 데드+H1<S20 상태→H3<H100 상태 + H1×S20 데드)가 화면 로직과 반대/다르게 짜여 있었음.
// row3/row4(7,8번 추세)·row5Entry는 원래도 화면과 일치해서 안 건드림. row5Exit/row6Exit(3,4,5,6번
// 블랭킷 청산)는 이후 사용자 요청으로 기능 자체를 삭제함.
function computeReservationEvents(S, startIdx, endIdx) {
  const row1 = [], row3 = [], row4 = []
  // A~L(사용자 요청, 옛 A/B(주가vsH1)는 삭제) - 셀 쪽은 H1<S1/H1<H3/H3<H5/W17<S1/H1<H15/H1<W85,
  // 바이 쪽은 반대 부등호. 진입은 그 상태가 이 캔들에 새로 시작되는 순간(edge)만 잡는다.
  const rowC = [], rowD = [], rowE = [], rowF = [], rowG = [], rowH = [], rowI = [], rowJ = [], rowK = [], rowL = [], rowM = [], rowN = []
  // 🎯 청산 버튼 4종(사용자 요청, 삭제된 "✅ 익절: H1×H3 크로스 청산"의 후속) - H1(HMA20)과 S1/H3/H5/W85
  // 중 사용자가 고른 하나의 골든/데드크로스를 계속 감시하다가, 골든=숏 청산/데드=롱 청산(사용자 확인).
  const exitCross = { s1: [], h3: [], h5: [], w85: [] }
  const { h1, h3, h100, h300, wma17_1m, sma20_1m, wma85, sma100, bbUp, bbLo, stochGolden, row1Armed, closes } = S
  for (let i = Math.max(1, startIdx); i < endIdx; i++) {
    const idx = i - startIdx
    // 청산 버튼 4종 크로스 감시 - 골든=숏 청산(closeSide:'sell'), 데드=롱 청산(closeSide:'buy')
    const crossOf = (b) => {
      if (h1[i - 1] == null || b[i - 1] == null || h1[i] == null || b[i] == null) return null
      if (h1[i - 1] <= b[i - 1] && h1[i] > b[i]) return 'sell'
      if (h1[i - 1] >= b[i - 1] && h1[i] < b[i]) return 'buy'
      return null
    }
    const s1Side = crossOf(sma20_1m); if (s1Side) exitCross.s1.push({ idx, closeSide: s1Side })
    const h3Side = crossOf(h3); if (h3Side) exitCross.h3.push({ idx, closeSide: h3Side })
    const h5Side = crossOf(h100); if (h5Side) exitCross.h5.push({ idx, closeSide: h5Side })
    const w85Side = crossOf(wma85); if (w85Side) exitCross.w85.push({ idx, closeSide: w85Side })
    // 3번(매도)/4번(매수) 진입 조건 재정의(사용자 정정 - 크로스 얘기가 아니었음) - 화면 "진입" 표시등과
    // 동일하게, row1Armed가 이 캔들에 새로 'above'/'below'가 된 순간(종가가 5분볼린저 안쪽으로 재진입한
    // 그 캔들 하나)만 잡는다.
    if (row1Armed[i] === 'above' && row1Armed[i - 1] !== 'above') row1.push({ idx, side: 'sell' })
    if (row1Armed[i] === 'below' && row1Armed[i - 1] !== 'below') row1.push({ idx, side: 'buy' })
    // 7,8번: 상태 조건(WMA85 vs SMA100, 1분스토, 가격/HMA20, HMA300 방향)
    if (wma85[i] != null && sma100[i] != null && h1[i] != null && h1[i - 1] != null &&
        h300[i] != null && h300[i - 1] != null && stochGolden[i] != null) {
      const buyOk = wma85[i] > sma100[i] && stochGolden[i] === true && closes[i] > h1[i] &&
        h1[i] > h1[i - 1] && h300[i] > h300[i - 1]
      const sellOk = wma85[i] < sma100[i] && stochGolden[i] === false && closes[i] < h1[i] &&
        h1[i] < h1[i - 1] && h300[i] < h300[i - 1]
      if (buyOk) row3.push({ idx, side: 'buy' })
      if (sellOk) row4.push({ idx, side: 'sell' })
    }
    // C(셀)/D(바이): H1 vs S1(SMA20)
    if (h1[i] != null && sma20_1m[i] != null && h1[i - 1] != null && sma20_1m[i - 1] != null) {
      if (h1[i] < sma20_1m[i] && !(h1[i - 1] < sma20_1m[i - 1])) rowC.push({ idx, side: 'sell' })
      if (h1[i] > sma20_1m[i] && !(h1[i - 1] > sma20_1m[i - 1])) rowD.push({ idx, side: 'buy' })
    }
    // E(셀)/F(바이): H1 vs H3
    if (h1[i] != null && h3[i] != null && h1[i - 1] != null && h3[i - 1] != null) {
      if (h1[i] < h3[i] && !(h1[i - 1] < h3[i - 1])) rowE.push({ idx, side: 'sell' })
      if (h1[i] > h3[i] && !(h1[i - 1] > h3[i - 1])) rowF.push({ idx, side: 'buy' })
    }
    // G(셀)/H(바이): H3 vs H5(H100)
    if (h3[i] != null && h100[i] != null && h3[i - 1] != null && h100[i - 1] != null) {
      if (h3[i] < h100[i] && !(h3[i - 1] < h100[i - 1])) rowG.push({ idx, side: 'sell' })
      if (h3[i] > h100[i] && !(h3[i - 1] > h100[i - 1])) rowH.push({ idx, side: 'buy' })
    }
    // G(셀)/H(바이)(사용자 요청): W17(WMA17) vs S1(SMA20)
    if (wma17_1m[i] != null && sma20_1m[i] != null && wma17_1m[i - 1] != null && sma20_1m[i - 1] != null) {
      if (wma17_1m[i] < sma20_1m[i] && !(wma17_1m[i - 1] < sma20_1m[i - 1])) rowI.push({ idx, side: 'sell' })
      if (wma17_1m[i] > sma20_1m[i] && !(wma17_1m[i - 1] > sma20_1m[i - 1])) rowJ.push({ idx, side: 'buy' })
    }
    // I(셀)/J(바이)(사용자 요청): H1 vs H15(HMA300)
    if (h1[i] != null && h300[i] != null && h1[i - 1] != null && h300[i - 1] != null) {
      if (h1[i] < h300[i] && !(h1[i - 1] < h300[i - 1])) rowK.push({ idx, side: 'sell' })
      if (h1[i] > h300[i] && !(h1[i - 1] > h300[i - 1])) rowL.push({ idx, side: 'buy' })
    }
    // K(셀)/L(바이)(사용자 요청): H1 vs W85(WMA85)
    if (h1[i] != null && wma85[i] != null && h1[i - 1] != null && wma85[i - 1] != null) {
      if (h1[i] < wma85[i] && !(h1[i - 1] < wma85[i - 1])) rowM.push({ idx, side: 'sell' })
      if (h1[i] > wma85[i] && !(h1[i - 1] > wma85[i - 1])) rowN.push({ idx, side: 'buy' })
    }
  }
  return { row1, row3, row4, rowC, rowD, rowE, rowF, rowG, rowH, rowI, rowJ, rowK, rowL, rowM, rowN, exitCross }
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
const DEFAULT_STOCH4_K_COLOR = '#6DFF38' // rgb(109,255,56), 사용자 지정
const DEFAULT_STOCH4_D_COLOR = '#FA0000' // rgb(250,0,0), 사용자 지정(하락색=%D색 연동)
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
const DEFAULT_STARTING_BALANCE = 100 // 골드/나스닥 모두 시작 잔고 $100(사용자 요청)
// 분리매매창 골드/나스닥 탭을 전환할 때 랏수/손절/익절 기본값도 같이 바뀐다(사용자 요청) - 매매1 탭은 해당 없음.
const DEFAULT_TW_LOTS = { gold: 0.02, nasdaq: 0.1 }
const DEFAULT_TW_SL = { gold: 200, nasdaq: 2000 }
const DEFAULT_TW_TP = { gold: 500, nasdaq: 5000 }
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

// 다른 페이지 갔다가 돌아왔을 때(뒤로가기 등, 컴포넌트가 완전히 언마운트/리마운트됨) 심볼이 리셋되던
// 문제 - 탭을 닫기 전까진 유지되는 sessionStorage에 저장해두고 마운트 시 복원한다. replay.js와 키를
// 공유하면 같은 탭에서 리플레이↔라이브를 오가는 동안 서로의 세션(특히 날짜)을 잘못 복원하는 버그가
// 있었다(실사용 중 발견 - 라이브 페이지가 리플레이의 마지막 날짜를 그대로 불러오려다 실패) - 그래서
// 라이브 전용 키로 분리했다.
const LIVE_STATE_KEY = 'liveChartState'
// 지표/색상/굵기/모양 등 "차트 표시 설정" 전체는 localStorage에 저장(사용자 요청) - 새로고침은 물론
// 브라우저를 완전히 닫았다 열어도 유지된다. 위와 같은 이유로 replay.js와 다른 키를 쓴다.
const LIVE_SETTINGS_KEY = 'liveChartSettings'

export default function ReplayChart() {
  // 마운트 시 딱 한 번만 sessionStorage를 읽어서 ref에 담아둔다(렌더 중 계산이라 useEffect보다 먼저 값이 준비됨).
  const restoreRef = useRef(undefined)
  if (restoreRef.current === undefined) {
    restoreRef.current = null
    if (typeof window !== 'undefined') {
      try {
        const raw = window.sessionStorage.getItem(LIVE_STATE_KEY)
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
        const raw = window.localStorage.getItem(LIVE_SETTINGS_KEY)
        if (raw) settingsRestoreRef.current = JSON.parse(raw)
      } catch { /* 저장된 값이 깨져있으면 무시하고 기본값으로 시작 */ }
    }
  }
  const rs = settingsRestoreRef.current || {}
  const hasAutoRestoredRef = useRef(false)

  const [symbol, setSymbol] = useState('GOLD') // 기본값을 항상 골드로 - 이전 세션에서 나스닥을 보고 있었어도 새로 열면 골드부터 시작(사용자 요청)
  // resize/pan-zoom 핸들러(마운트 시 한 번만 설치되는 클로저)에서 updateMaStopAnchor가 손절 달러
  // 환산에 쓸 최신 symbol/lotSize를 읽으려면 ref 미러링이 필요하다(twFoundPositionsRef와 같은 이유).
  const symbolRef = useRef('GOLD')
  useEffect(() => { symbolRef.current = symbol }, [symbol])
  // 브로커 서머타임 여부 - 겨울엔 서버시간이 1시간 밀려서(EEST→EET) 한국시간 환산 오프셋이 6→7시간으로 바뀐다.
  // 자동판별할 방법이 없어서 버튼으로 직접 전환하게 함(기본값: 서머타임 켜짐)
  const [summerTime, setSummerTime] = useState(true)
  // 라이브 폴링 setInterval 클로저 안에서 최신 summerTime을 읽으려면 ref 미러링이 필요하다(symbolRef와 같은 이유).
  const summerTimeRef = useRef(true)
  useEffect(() => { summerTimeRef.current = summerTime }, [summerTime])
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
  // 🔍 찾기 결과를 캔들 위/아래에 표시하기 위한 화면 좌표들(사용자 요청 - timerAnchor와 같은 방식).
  // [{n, x, y, side}] - n=순번, x/y=차트 컨테이너 기준 px, side='sell'이면 캔들 위 20px, 'buy'면 아래 20px.
  const [foundMarkerAnchors, setFoundMarkerAnchors] = useState([])
  // 🛑 이평선 따라가기 손절 - 선택한 선의 "끝"(지금 재생 위치 값)을 계속 따라다니는 라벨 좌표(사용자
  // 요청, timerAnchor와 같은 방식). {x, y, label} | null
  const [maStopAnchor, setMaStopAnchor] = useState(null)
  // 🎯 청산목표 라벨도 캔들 타이머 위치가 아니라, 선택한 목표 중 "느린선"(크로스 방식이면 H1과 짝지어진
  // 그 선 자체, 터치 방식이면 그 선 그대로)을 계속 따라다니게(사용자 요청 - "H1×H5면 H5를 따라가야지").
  // maStopAnchor와 완전히 같은 구조/좌표계.
  const [exitTargetAnchor, setExitTargetAnchor] = useState(null)
  // 진입가 표시(사용자 요청, "----- 진입 +/-금액") - 보유 중인 포지션마다 진입가 자리에 점선+라벨을
  // 띄우고 실시간 손익(pnlDisplay 설정대로)을 계속 갱신한다. maStopAnchor와 같은 좌표계지만 포지션
  // 개수만큼 배열. [{id, x, y, side, points, dollars}]
  const [positionAnchors, setPositionAnchors] = useState([])
  // 왼쪽 사이드바(지표 설정) 접기(사용자 요청) - 셋팅 끝내고 나면 필요 없어져서 차트 폭을 넓히고
  // 싶다는 취지. 접으면 좁은 스트립만 남고 오른쪽 차트 컬럼(flex:1)이 그만큼 넓어진다.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false)
  const [playIndex, setPlayIndex] = useState(0)
  const [total, setTotal] = useState(0)
  // 기본 셋팅(사용자 요청) - 1분 볼린저는 중간선만, 5분/15분/1시간 볼린저는 전체 표시
  // (아래 전부 rs.필드명 ?? 기본값 형태 - localStorage에 저장된 값이 있으면 그걸로 시작, 없으면 기존 기본값)
  const [enabledBands, setEnabledBands] = useState(rs.enabledBands ?? { sma20: true, sma100: true, sma300: true, sma1200: true })
  const [lineVisibility, setLineVisibility] = useState(rs.lineVisibility ?? {}) // `${bandId}:${upper|middle|lower}` -> false면 숨김 (기본 true, 1분B 상/하도 기본 켜짐 - 사용자 요청)
  const [bandColors, setBandColors] = useState(rs.bandColors ?? {}) // bandId -> 커스텀 색상 (없으면 BOLLINGER_BANDS 기본색)
  // 기본 셋팅 - 3분/5분/15분/1시간 H, 1분/5분 W17, 1시간 W4 이평선 체크(1시간H 기본체크는 사용자 요청)
  const [enabledMA, setEnabledMA] = useState(rs.enabledMA ?? {
    hma20: true, hma60: true, hma100: true, hma300: true, hma1200: true, wma17_1m: true, wma17_5m: true, wma4_1h: true,
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
  // 스토캐스틱 4세트 - 14/3/3, 7/2/2, 70/15/15, 210/45/45(사용자 요청). 70/15/15, 210/45/45는
  // K/D가 교차할 때마다 세로줄도 같이 표시한다(아래 stoch3/4CrossTimesRef/토글 함수 참고).
  const [enabledStoch1, setEnabledStoch1] = useState(rs.enabledStoch1 ?? true)
  const [stoch1KColor, setStoch1KColorState] = useState(rs.stoch1KColor ?? DEFAULT_STOCH1_K_COLOR)
  const [stoch1DColor, setStoch1DColorState] = useState(rs.stoch1DColor ?? DEFAULT_STOCH1_D_COLOR)
  const [enabledStoch2, setEnabledStoch2] = useState(rs.enabledStoch2 ?? true)
  const [stoch2KColor, setStoch2KColorState] = useState(rs.stoch2KColor ?? DEFAULT_STOCH2_K_COLOR)
  const [stoch2DColor, setStoch2DColorState] = useState(rs.stoch2DColor ?? DEFAULT_STOCH2_D_COLOR)
  const [enabledStoch3, setEnabledStoch3] = useState(rs.enabledStoch3 ?? true)
  const [stoch3KColor, setStoch3KColorState] = useState(rs.stoch3KColor ?? DEFAULT_STOCH3_K_COLOR)
  const [stoch3DColor, setStoch3DColorState] = useState(rs.stoch3DColor ?? DEFAULT_STOCH3_D_COLOR)
  const [enabledStoch4, setEnabledStoch4] = useState(rs.enabledStoch4 ?? true)
  const [stoch4KColor, setStoch4KColorState] = useState(rs.stoch4KColor ?? DEFAULT_STOCH4_K_COLOR)
  const [stoch4DColor, setStoch4DColorState] = useState(rs.stoch4DColor ?? DEFAULT_STOCH4_D_COLOR)
  // 스토(70,15,15)/(210,45,45) K/D 골든·데드크로스 세로줄(사용자 요청 - 기본 체크). 상승색은 %K,
  // 하락색은 %D 색상을 그대로 따라간다(별도 색상 선택 없음, 사용자 요청 "상승색은 K와, 하락색은 D와 맞춰줘").
  const [stoch3CrossEnabled, setStoch3CrossEnabledState] = useState(rs.stoch3CrossEnabled ?? true)
  const [stoch3CrossOpacity, setStoch3CrossOpacityState] = useState(rs.stoch3CrossOpacity ?? 0.3) // 세로줄 투명도(0~1, 기본 30%, 사용자 요청)
  const [stoch4CrossEnabled, setStoch4CrossEnabledState] = useState(rs.stoch4CrossEnabled ?? true)
  const [stoch4CrossOpacity, setStoch4CrossOpacityState] = useState(rs.stoch4CrossOpacity ?? 0.3)
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
  // 메인 차트 매매 패널의 랏수 - 분리매매창(twLots였던 것)과 완전히 같은 값을 공유한다(사용자 지적 -
  // "메인차트 금액/랏수와 분리매매 설정이 안 맞는다"). 예전엔 별도 state(twLots)라 서로 안 따라갔다.
  const [lotSize, setLotSize] = useState(rs.lotSize ?? DEFAULT_TW_LOTS.gold)
  const lotSizeRef = useRef(lotSize)
  useEffect(() => { lotSizeRef.current = lotSize }, [lotSize])
  const [positions, setPositions] = useState([]) // { id, side:'buy'|'sell', symbol, lot, entryPrice, entryTime }
  const [pnlDisplay, setPnlDisplay] = useState(rs.pnlDisplay ?? 'dollar') // 'dollar' | 'point'

  // 실주문(진짜 MT5 주문) 관련 상태 - 위의 랏수/포지션은 전부 웹 안에서만 도는 가상매매고, 이건 실제
  // 돈이 움직이는 별개 기능이라 일부러 랏수도 따로 둔다(가상매매 설정과 안 섞이게). tradeAccountLabel
  // 자체가 각 이용자만 아는 비밀값 역할이라(자기 EA에도 똑같이 입력해두는 값) 별도 비밀번호는 안 둔다
  // (사용자 지적 - 중복이었음). 새로고침하면 사라지게 세션 state로만 두고 저장 안 함(공유 PC 등 대비).
  const [tradeAccountLabel, setTradeAccountLabel] = useState('') // 기본값 없음(사용자 요청) - 안 정하면 전송 버튼 비활성
  // 실주문 카드 자체를 기본적으로 숨겨두는 마스터 스위치(사용자 요청) - 체크해야 아래 실주문 카드가
  // 나타나고 경고 문구도 뜬다. 이것도 새로고침하면 꺼지게 세션에만 둔다(계속 켜진 채 남지 않게).
  const [realTradingUnlocked, setRealTradingUnlocked] = useState(false)
  const [showTradeGuideModal, setShowTradeGuideModal] = useState(false)
  const [tradeLot, setTradeLot] = useState(0.01)
  const [tradeCommands, setTradeCommands] = useState([]) // 최근 보낸 명령들 [{id, direction, status, message}] - 화면에 체결 결과 보여주는 용도
  const [tradeSending, setTradeSending] = useState(false)
  // 지금 로그인된 MT5가 데모/라이브인지, 잔고가 얼마인지 - EA가 주기적으로 보고해둔 걸 폴링해서 보여줌
  // (사용자 요청 - 실주문 누르기 전에 어느 계좌인지 먼저 확인할 수 있어야 함).
  const [accountStatus, setAccountStatus] = useState(null) // null | { is_demo, balance, currency, account_login, updated_at }

  // 분리매매창(EasyTrade_MT5 데스크톱 앱의 "매매 실행" 팝업 그대로 재현) - 공통 입력부 + 매매1/골드/나스닥 탭.
  // 골드/나스닥 탭의 반자동 예약 신호는 리플레이가 지금 로드해둔 심볼(symbol)의 데이터로만 실제 동작한다
  // (데스크톱 앱은 두 탭이 각자 독립적으로 MT5에서 실시간 데이터를 받아오지만, 리플레이는 한 번에 한
  // 심볼만 로드하므로 다른 심볼 탭은 대기 상태로 표시만 됨).
  const [showTradingWindow, setShowTradingWindow] = useState(false)
  const [twPos, setTwPos] = useState({ x: 80, y: 80 })
  // 매매진입 현황도 분리매매창처럼 떼어낼 수 있게(사용자 요청) - 페이지 안에 고정으로 박혀있던 걸
  // 분리매매창과 같은 방식(드래그 가능한 fixed 패널 + document.body 포탈로 항상 최상단)으로 바꾼다.
  // 매매진입 현황 - 기본은 원래 자리(메인 컨트롤 박스 오른쪽 컬럼)에 인라인으로 있고, "분리" 버튼을
  // 눌렀을 때만 분리매매창처럼 떠다니는 패널이 된다(사용자 지적 - "원래 있던곳에 있고 분리하면 떠야지").
  const [positionPanelFloating, setPositionPanelFloating] = useState(false)
  // 처음 열릴 때 화면 오른쪽에 뜨도록(사용자 요청 - "오른쪽에 표시해달라"고 했는데 왼쪽 고정값(x:80)에
  // 떠서 엉뚱한 자리에 있는 것처럼 보였다). 패널 폭(360)+여백만큼 오른쪽 끝에서 띄운다. SSR 환경엔
  // window가 없으니 그때는 임시 기본값을 쓰고, 마운트 후엔 어차피 드래그로 옮길 수 있다.
  const [posPanelPos, setPosPanelPos] = useState(() => ({
    x: typeof window !== 'undefined' ? Math.max(20, window.innerWidth - 400) : 900,
    y: 160,
  }))
  const [twTab, setTwTab] = useState('gold') // 'strategy1' | 'gold' | 'nasdaq' - symbol 기본값(골드)과 맞춤(사용자 지적)
  const [twSwapped, setTwSwapped] = useState(false)
  const [twSl, setTwSl] = useState(DEFAULT_TW_SL.gold)
  const [twTp, setTwTp] = useState(DEFAULT_TW_TP.gold)
  const [twUseSl, setTwUseSl] = useState(true)
  const [twUseTp, setTwUseTp] = useState(false) // "✅ 익절: H1×H3 크로스 청산"(twTpExitCross) 기능은 삭제됨(사용자 요청) - 포인트 익절 기본은 꺼둔 채로 유지
  // 🎯 청산 버튼 4종(사용자 요청, twTpExitCross 후속) - null|'s1'|'h3'|'h5'|'w85' 중 하나만 선택(라디오
  // 방식, 다시 누르면 꺼짐). 선택된 페어의 H1(HMA20)×그 값 골든/데드크로스를 계속 감시하다가 자동 청산.
  const [twExitCrossPair, setTwExitCrossPair] = useState(null)
  // applyIncrement의 setInterval 루프처럼 마운트 시 한 번만 잡히는 클로저에서도 최신 값을 읽으려면
  // ref로 미러링해야 한다(twFoundPositionsRef와 같은 이유).
  const twExitCrossPairRef = useRef(null)
  useEffect(() => { twExitCrossPairRef.current = twExitCrossPair }, [twExitCrossPair])
  // 🛑 손절: 이평선 따라가기(사용자 요청) - 청산 버튼과 같은 라디오 방식(4종 중 하나|null). 선택한
  // 이평선을 계속 추적하다가 캔들 고가/저가가 그 선에 닿으면(사용자 확인 - 종가 아님, 안전 우선)
  // 손절가로 즉시 청산. 기존 고정 손절(twUseSl, 포인트)과는 독립적으로 둘 다 동시에 켜둘 수 있음.
  const [twMaTrailStop, setTwMaTrailStop] = useState(null)
  const twMaTrailStopRef = useRef(null)
  useEffect(() => { twMaTrailStopRef.current = twMaTrailStop }, [twMaTrailStop])
  const [twSkipPopup, setTwSkipPopup] = useState(true)
  // 반자동 신호(골드/나스닥 탭의 방향버튼 무장 상태)를 차트 아래에 "N 롱 / M 셀"로 표시(사용자 요청,
  // 기본 체크)
  const [showSemiAutoSignalOnChart, setShowSemiAutoSignalOnChart] = useState(true)
  // symbol(메인 차트 🥇골드/💻나스닥 버튼)이 바뀌면 분리매매창 탭/랏수/손절/익절도 그 심볼 기준으로 같이
  // 맞춘다(사용자 지적 - "기본값만 나스닥이어야지 나스닥으로 고정해두라는 게 아니다". 분리매매창 탭을
  // 직접 누르는 방향(id==='gold'/'nasdaq'일 때 setSymbol 호출)은 이미 반영돼 있었는데, 반대로 메인
  // 심볼 버튼을 눌렀을 때 분리매매창이 안 따라가는 게 실제 빠진 부분이었다. 매매1 탭은 특정 심볼
  // 전용이 아니라 건드리지 않는다(원치 않게 매매1에서 쫓겨나지 않도록).
  useEffect(() => {
    if (twTab === 'strategy1') return
    const twId = symbol === 'GOLD' ? 'gold' : symbol === 'NASDAQ' ? 'nasdaq' : null
    if (!twId || twId === twTab) return
    setTwTab(twId)
    setLotSize(DEFAULT_TW_LOTS[twId])
    setTwSl(DEFAULT_TW_SL[twId])
    setTwTp(DEFAULT_TW_TP[twId])
  }, [symbol])
  // 원본은 체크박스(무장)와 SELL/BUY 방향버튼이 서로 다른 두 개의 토글이다 - 체크박스만 켜도(방향 아직
  // 안 골라도) 설명 박스는 바로 뜨고(_update_desc_label), 실제 발동엔 방향버튼까지 같이 눌려있어야 한다.
  const [twGoldChecked, setTwGoldChecked] = useState(null) // 체크된 행 번호(1~6) | null - 1~6 중 하나만
  const [twGoldDir, setTwGoldDir] = useState(null)         // { row, side } | null - 눌린 방향버튼
  const [twNasdaqChecked, setTwNasdaqChecked] = useState(null)
  const [twNasdaqDir, setTwNasdaqDir] = useState(null)
  // 🔍 찾기(검색) - 체크된 신호의 "진입" 위치를 불러온 구간 전체에서 찾아 순서대로 재생 바 위에
  // 번호로 표시(사용자 요청). [{idx, side}] 배열, idx는 dayRows 기준(1-based, playIndex와 같은 체계).
  const [twFoundPositions, setTwFoundPositions] = useState([])
  // resize/pan/zoom 핸들러는 마운트 시 한 번만 설치돼서 클로저가 고정되므로, state를 직접 읽으면
  // stale해진다(rowsRef/indexRef처럼 ref로 미러링해서 항상 최신값을 읽게 함).
  const twFoundPositionsRef = useRef([])
  useEffect(() => { twFoundPositionsRef.current = twFoundPositions }, [twFoundPositions])
  // 신호(체크박스)를 바꾸거나 데이터가 새로 로드되면 이전 검색 결과가 엉뚱한 캔들 위치를 가리키게
  // 되므로 자동으로 지운다.
  useEffect(() => { setTwFoundPositions([]); setFoundMarkerAnchors([]) }, [twGoldChecked, twNasdaqChecked, symbol, total])
  const [twBlinkPhase, setTwBlinkPhase] = useState(false) // 600ms 점멸 - _blink_timer 그대로
  const [twPopupEl, setTwPopupEl] = useState(null) // 새 창으로 뺐을 때 그 창 안에 만든 portal 대상 div (없으면 페이지 안 모달로 렌더)
  const twWinRef = useRef(null) // 새 창의 window 객체
  const twOnUnloadRef = useRef(null) // 위 창의 beforeunload 핸들러 참조(다시 붙이기 시 떼어내기 위해 보관)
  // 매매진입 현황도 분리매매창과 같은 방식으로 진짜 새 창으로 뺄 수 있게(사용자 요청) - 위 tw* 3개와
  // 완전히 같은 역할, 대상만 매매진입 현황 패널.
  const [posPopupEl, setPosPopupEl] = useState(null)
  const posWinRef = useRef(null)
  const posOnUnloadRef = useRef(null)
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
  // 라이브 폴링 상태 - liveRowsRef는 이 심볼로 지금까지 받은 캔들 전체(변환된 {id,time,open,high,low,close}),
  // liveLastCursorRef는 폴링 커서(마지막으로 받은 캔들의 실제 시각 {date,time} - bar_date/bar_time 원본
  // 문자열 그대로). 예전엔 id(auto increment)를 커서로 썼는데, 진행 중인 캔들을 EA가 500ms마다 같은
  // 행에 upsert해도 Postgres 시퀀스는 매번 소모돼서 id가 실제 캔들 수보다 훨씬 빨리 늘어나 최근 구간
  // 페이징이 극도로 느려지는 문제가 있었다(사용자가 직접 API를 수백 번 두드려 확인) - bar_date/bar_time
  // 자체를 커서로 쓰면 진짜 캔들 개수에 정확히 비례해서 늘어나므로 이 문제가 없다. sinceTime과 "같은"
  // 시각도 포함해서(>=) 요청해 그 캔들의 최신 갱신도 놓치지 않는다(pollLiveOnce 참고).
  const liveRowsRef = useRef([])
  const liveLastCursorRef = useRef(null) // {date, time} | null(아직 아무것도 못 받음)
  const livePollTimerRef = useRef(null)
  const liveRealtimeChannelRef = useRef(null) // Supabase Realtime 구독 채널 - 폴링 대신 DB 변경을 즉시 밀어받는 용도
  const hasLiveCenteredRef = useRef(false) // 새로고침/심볼전환 후 카메라를 딱 한 번만 중앙 정렬하기 위한 플래그
  // EA가 멈춰도 폴링 요청 자체는 계속 200으로 성공해서 "연결됨"으로 보이는 문제가 있었다(사용자 지적 -
  // 자동매매가 꺼져서 EA가 멈췄는데도 페이지는 계속 초록불이었음) - 요청 성공 여부 대신 "마지막 캔들의
  // 실제 시각이 지금과 얼마나 벌어졌는지"로 끊김을 감지한다(pollLiveOnce 참고).
  const [liveStatus, setLiveStatus] = useState('connecting') // 'connecting' | 'live' | 'stale' | 'error' | 'disconnected'
  const liveStatusRef = useRef('connecting') // 캔들 타이머 tick()이 effect 재시작 없이 최신 상태를 읽기 위한 미러
  useEffect(() => { liveStatusRef.current = liveStatus }, [liveStatus])
  const [liveStaleSec, setLiveStaleSec] = useState(0)
  // Realtime이 지금 막 들어온 캔들 하나만 먼저 밀어주는 경우, 그 이전 구간이 아직 안 채워진 상태로
  // 화면에 붙으면 "시간이 붕 뜨는" 점프처럼 보인다(사용자 지적) - 그 구간을 REST로 마저 채우는 동안은
  // 차트를 갱신하지 않고 이 플래그로 "갱신 중"임을 보여준다(pollLiveOnce 참고).
  const [liveCatchingUp, setLiveCatchingUp] = useState(false)
  const [liveConnected, setLiveConnected] = useState(true) // 사용자가 "연결 끊기" 버튼으로 직접 끈 상태(사용자 요청)
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
  const stoch3CrossTimesRef = useRef([]) // [{idx, time, type:'golden'|'dead'}] - K/D가 교차한 지점 전체(밴드 조건 삭제, 사용자 요청)
  const stoch3CrossLineRef = useRef(null) // MultiVerticalLinesPrimitive 인스턴스(메인 캔들 pane용)
  const stoch3CrossLineStochPaneRef = useRef(null) // 같은 세로줄을 스토캐스틱 pane 쪽에도 하나 더 얹은 인스턴스 - pane은
  // 넷 중 아무거나 처음 켜질 때 생겼다 전부 꺼지면 사라지므로, 이 primitive도 그때그때 새로 만들고 null로 되돌린다.
  const stoch3CrossEnabledRef = useRef(stoch3CrossEnabled) // on/off·투명도를 리렌더 없이 즉시 반영하기 위한 ref(다른 색상 피커들과 동일 패턴)
  const stoch3CrossUpColorRef = useRef(stoch3KColor) // 상승색=%K색(사용자 요청), setStoch3KColor에서 같이 갱신됨
  const stoch3CrossDownColorRef = useRef(stoch3DColor) // 하락색=%D색, setStoch3DColor에서 같이 갱신됨
  const stoch3CrossOpacityRef = useRef(stoch3CrossOpacity)
  const stoch4DataRef = useRef({ k: [], d: [] })
  const stoch4SeriesRef = useRef(null)
  const stoch4CrossTimesRef = useRef([]) // [{idx, time, type:'golden'|'dead'}] - 스토(210,45,45) K/D 교차 지점 전체(사용자 요청)
  const stoch4CrossLineRef = useRef(null) // MultiVerticalLinesPrimitive 인스턴스(메인 캔들 pane용)
  const stoch4CrossLineStochPaneRef = useRef(null) // 같은 세로줄을 스토캐스틱 pane 쪽에도 하나 더 얹은 인스턴스
  const stoch4CrossEnabledRef = useRef(stoch4CrossEnabled)
  const stoch4CrossUpColorRef = useRef(stoch4KColor) // 상승색=%K색(사용자 요청)
  const stoch4CrossDownColorRef = useRef(stoch4DColor) // 하락색=%D색
  const stoch4CrossOpacityRef = useRef(stoch4CrossOpacity)
  const crossPointsRef = useRef([])  // 체크한 이평선끼리 교차하는 지점 전체 [{idx, time, type:'golden'|'dead'}]
  const autoEventsRef = useRef([])   // 반자동진입 트리거 전체 [{idx, time, side:'buy'|'sell', source}]
  const reservationSeriesRef = useRef(null) // computeReservationSeries(fullRows) 결과 - 분리매매창 골드/나스닥 탭 라벨 표시용
  const reservationEventsRef = useRef(null) // computeReservationEvents(...) 결과 - idx는 dayRows 기준
  const reservationSymbolRef = useRef(null) // 위 두 값이 어느 심볼 데이터로 계산됐는지(symbol과 다르면 그 탭은 대기 상태)
  const positionsRef = useRef([]) // applyIncrement가 재생 인터벌의 오래된 클로저에서도 최신 포지션 목록을 읽을 수 있게 미러링
  useEffect(() => { positionsRef.current = positions }, [positions])
  const twDragRef = useRef(null) // 분리매매창 드래그용
  const posPanelDragRef = useRef(null) // 매매진입 현황 패널 드래그용
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
  // 심볼이 바뀌면 그 심볼의 라이브 폴링을 새로 시작한다(과거 CSV 날짜 목록을 불러오던 로직은 라이브
  // 페이지엔 안 맞아서 제거 - 대신 아래 startLivePolling이 /api/live-price를 폴링한다).
  useEffect(() => {
    stopPlayback()
    setError('')
    rowsRef.current = []
    indexRef.current = 0
    drawnUpToRef.current = 0 // 새 데이터 로드 시 "실제로 그려진 지점"도 반드시 같이 리셋 - 안 하면 이전
    // 심볼에서 남은 값이 새 심볼의 캔들 인덱스와 안 맞아서 update() 크래시로 이어졌다(실사용 중 재현됨).
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
    stoch4DataRef.current = { k: [], d: [] }
    stoch4CrossTimesRef.current = []
    syncStoch4(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    reservationSeriesRef.current = null
    reservationEventsRef.current = null
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    uploadedEdgePrimitiveRef.current?.setPoints([])
    setPositions([]); setPositionAnchors([]) // 심볼이 바뀌면 그 전 심볼 가격 기준 포지션은 의미가 없어짐(체결 없이 그냥 사라짐)
    startLivePolling(symbol)
    return () => {
      if (livePollTimerRef.current) clearInterval(livePollTimerRef.current)
      if (liveRealtimeChannelRef.current) { supabaseClient.removeChannel(liveRealtimeChannelRef.current); liveRealtimeChannelRef.current = null }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol])

  // 탭이 백그라운드로 갔다가 다시 보이게 되면(브라우저가 그동안 웹소켓/타이머를 조여뒀을 수 있음)
  // 즉시 한 번 따라잡기 폴링을 돈다 - 20초 안전망 폴링만 믿고 기다리지 않게(사용자가 실제로 겪은
  // "탭 백그라운드 중 놓친 데이터가 나중에 한꺼번에 튀어 보이는" 문제의 재발 방지).
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible' && liveConnected) pollLiveOnce(symbolRef.current)
    }
    document.addEventListener('visibilitychange', onVisible)
    window.addEventListener('focus', onVisible)
    return () => {
      document.removeEventListener('visibilitychange', onVisible)
      window.removeEventListener('focus', onVisible)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [liveConnected])

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
      height: 700, // 전체 차트 높이(사용자 요청 - 기존 750에서 50px 축소)
      layout: {
        background: { color: '#0f1115' }, textColor: '#9aa0ab',
        panes: { separatorColor: '#2a2e38', separatorHoverColor: 'rgba(76,175,80,0.15)', enableResize: true },
      },
      grid: { vertLines: { color: '#1c2028' }, horzLines: { color: '#1c2028' } },
      crosshair: { mode: CrosshairMode.Normal },
      timeScale: { borderColor: '#2a2e38', timeVisible: true, secondsVisible: false, tickMarkFormatter: localTickMarkFormatter },
      // scaleMargins 기본값(위 20%/아래 10%)이라 캔들이 실제 가격 범위에 비해 눌려 보였다(사용자 지적)
      // - 위아래 여백을 줄여서 캔들이 세로로 더 넓게 퍼지게 한다.
      rightPriceScale: { borderColor: '#2a2e38', scaleMargins: { top: 0.08, bottom: 0.08 } },
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
    stoch4CrossLineRef.current = new MultiVerticalLinesPrimitive()
    series.attachPrimitive(stoch4CrossLineRef.current)

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
        middle: chart.addSeries(LineSeries, { color: BOLLINGER_MIDDLE_COLOR_OVERRIDE[band.id] || color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: lineVisibility[`${band.id}:middle`] !== false }),
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

    // 스토캐스틱 4세트도 볼린저/이평선처럼 기본 체크(사용자 요청) - 마운트 시점에 켜져 있는 것만 여기서 직접 만든다.
    // 넷이 같은 pane을 공유하므로 pane index는 한 번만 잡고, 세로줄(stoch3/4CrossLineStochPaneRef)은 그 pane에 하나씩만 붙인다.
    if (enabledStoch1 || enabledStoch2 || enabledStoch3 || enabledStoch4) {
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
      if (enabledStoch4) {
        stoch4SeriesRef.current = {
          k: chart.addSeries(LineSeries, { color: stoch4KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
          d: chart.addSeries(LineSeries, { color: stoch4DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, stochPaneIndex),
        }
        firstStochKSeries = firstStochKSeries || stoch4SeriesRef.current.k
      }
      if (firstStochKSeries) {
        stoch3CrossLineStochPaneRef.current = new MultiVerticalLinesPrimitive()
        firstStochKSeries.attachPrimitive(stoch3CrossLineStochPaneRef.current)
        stoch4CrossLineStochPaneRef.current = new MultiVerticalLinesPrimitive()
        firstStochKSeries.attachPrimitive(stoch4CrossLineStochPaneRef.current)
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
    const onResize = () => chart.resize(containerRef.current.clientWidth, 700, true)
    window.addEventListener('resize', onResize)
    // 브라우저 창 자체를 resize할 때만 반응하는 위 리스너로는 부족했다 - 왼쪽 사이드바(달력/체크박스
    // 카드들)의 레이아웃이 차트 생성 시점 이후에 자리잡으면서 컨테이너 폭이 나중에 바뀌는 경우
    // (또는 생성 시점에 아직 0이었던 경우) 창을 실제로 리사이즈하기 전까진 차트가 라이브러리 기본값
    // (300x150)에 눌어붙어 비율이 다 깨진 채로 남아있었다(사용자가 실측으로 발견) - ResizeObserver로
    // 컨테이너 자체의 크기 변화를 직접 감시해서 항상 실제 폭에 맞춘다.
    const ro = new ResizeObserver(entries => {
      const w = entries[0]?.contentRect?.width
      if (w) { chart.resize(w, 700, true); updateTimerAnchor(); updateFoundMarkerAnchors(); updateMaStopAnchor(); updateExitTargetAnchor(); updatePositionAnchors() }
    })
    ro.observe(containerRef.current)

    // 캔들 타이머 배지 위치 - 화면을 드래그/줌하면(시각→x좌표 매핑이 바뀌므로) 캔들은 그대로여도
    // 화면상 위치는 움직여야 한다. 보이는 범위가 바뀔 때마다 다시 계산한다. 🔍 찾기 마커/이평선 손절
    // 라벨도 같은 이유로 같이 갱신.
    const onVisibleRangeChange = () => { updateTimerAnchor(); updateFoundMarkerAnchors(); updateMaStopAnchor(); updateExitTargetAnchor(); updatePositionAnchors() }
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

  // 70/15/15 스토캐스틱 - K/D 라인뿐 아니라 "K/D 크로스" 세로줄도 재생 위치까지만 표시
  const applyStoch3Index = (idx) => {
    const s = stoch3SeriesRef.current
    const d = stoch3DataRef.current
    if (s) {
      s.k.setData(d.k.slice(0, idx).filter(Boolean))
      s.d.setData(d.d.slice(0, idx).filter(Boolean))
    }
    // 색상은 ref로 즉시 반영(리렌더 기다리지 않고 색상 피커 onChange에서 바로 이 함수를 다시 불러 새 색으로 그림)
    const lines = stoch3CrossEnabledRef.current
      ? stoch3CrossTimesRef.current.filter(p => p.idx < idx).map(p => ({ time: p.time, color: hexToRgba(p.type === 'golden' ? stoch3CrossUpColorRef.current : stoch3CrossDownColorRef.current, stoch3CrossOpacityRef.current) }))
      : []
    stoch3CrossLineRef.current?.setLines(lines)
    stoch3CrossLineStochPaneRef.current?.setLines(lines)
  }
  const syncStoch3 = (idx) => applyStoch3Index(idx)

  // 스토(210,45,45) - 스토(70,15,15)와 동일한 방식(사용자 요청 - "다른스토들과 같은 방식으로")
  const applyStoch4Index = (idx) => {
    const s = stoch4SeriesRef.current
    const d = stoch4DataRef.current
    if (s) {
      s.k.setData(d.k.slice(0, idx).filter(Boolean))
      s.d.setData(d.d.slice(0, idx).filter(Boolean))
    }
    const lines = stoch4CrossEnabledRef.current
      ? stoch4CrossTimesRef.current.filter(p => p.idx < idx).map(p => ({ time: p.time, color: hexToRgba(p.type === 'golden' ? stoch4CrossUpColorRef.current : stoch4CrossDownColorRef.current, stoch4CrossOpacityRef.current) }))
      : []
    stoch4CrossLineRef.current?.setLines(lines)
    stoch4CrossLineStochPaneRef.current?.setLines(lines)
  }
  const syncStoch4 = (idx) => applyStoch4Index(idx)
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
    syncStoch4(idx)
    applyAllMarkers(idx)
    if (ribbonEnabled) recomputeSpreadExtremes(idx) // 슬라이더로 임의 위치 이동 - 되감기일 수 있어 처음부터 재스캔
    if (sidewaysEnabled) applySidewaysBands(idx)
    applySessionBands(idx) // 세션도 횡보처럼 재생(그려진 캔들) 범위 안에서만 표시(사용자 지적)
    applyShooting5MinIndex(idx)
    indexRef.current = idx
    setPlayIndex(idx)
    updateTimerAnchor()
    updateFoundMarkerAnchors()
    updateMaStopAnchor()
    updateExitTargetAnchor()
    updatePositionAnchors()
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
    syncStoch4(to)
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
      // 🛑 손절: 이평선 따라가기(사용자 요청) - 선택된 이평선의 이 구간 값을 미리 읽어둔다. 캔들 고가/저가
      // 기준(종가 아님 - 안전 우선, 사용자 확인)으로 SL/TP 다음 우선순위로 검사한다.
      const maTrailKey = twMaTrailStopRef.current
        ? { h1: 'h1', s1: 'sma20_1m', h3: 'h3', h5: 'h100', w85: 'wma85', center: 'sma100', don5up: 'donUp5', don5lo: 'donLo5', bbUp: 'bbUp', bbLo: 'bbLo', bbUp300: 'bbUp300', bbLo300: 'bbLo300' }[twMaTrailStopRef.current] : null
      // 🎯 청산목표 S100 계열(사용자 요청) - 크로스가 아니라 "닿으면" 방식. 익절(목표 도달) 방향이라
      // 손절과 정반대: SELL은 저가가 닿으면(가격 하락=이익), BUY는 고가가 닿으면(가격 상승=이익) 청산.
      // w85t(5M-17가중, 터치 방식 추가분)도 여기서 같이 처리 - 기존 w85(크로스 방식, H1×W85)와는
      // id가 달라서 서로 안 겹친다.
      const exitTargetKey = twExitCrossPairRef.current
        ? { center: 'sma100', bbUp: 'bbUp', bbLo: 'bbLo', w85t: 'wma85' }[twExitCrossPairRef.current] : null
      const S = reservationSeriesRef.current
      // 같은 캔들에서 여러 개 걸리면 보수적으로 SL→TP→이평선손절→청산목표 순으로 우선한다
      // (OHLC만으로는 어느 쪽이 먼저 닿았는지 알 수 없음)
      for (let i = from; i < to; i++) {
        const bar = rows[i]
        const maVal = (maTrailKey && S) ? S[maTrailKey]?.[i + S.offset] : null
        const targetVal = (exitTargetKey && S) ? S[exitTargetKey]?.[i + S.offset] : null
        for (const pos of positionsRef.current) {
          if (closedIds.has(pos.id)) continue
          if (pos.sl != null) {
            const hitSl = pos.side === 'buy' ? bar.low <= pos.sl : bar.high >= pos.sl
            if (hitSl) { closePositionAt(pos.id, pos.sl, bar.time, pos); closedIds.add(pos.id); continue }
          }
          if (pos.tp != null) {
            const hitTp = pos.side === 'buy' ? bar.high >= pos.tp : bar.low <= pos.tp
            if (hitTp) { closePositionAt(pos.id, pos.tp, bar.time, pos); closedIds.add(pos.id); continue }
          }
          if (maVal != null) {
            const hitMaStop = pos.side === 'buy' ? bar.low <= maVal : bar.high >= maVal
            if (hitMaStop) { closePositionAt(pos.id, maVal, bar.time, pos); closedIds.add(pos.id); continue }
          }
          if (targetVal != null) {
            const hitTarget = pos.side === 'buy' ? bar.high >= targetVal : bar.low <= targetVal
            if (hitTarget) { closePositionAt(pos.id, targetVal, bar.time, pos); closedIds.add(pos.id) }
          }
        }
      }

      const rEvents = reservationEventsRef.current
      if (rEvents && reservationSymbolRef.current === symbol) {
        const isGold = symbol === 'GOLD'
        const isNasdaq = symbol === 'NASDAQ'
        // 내부 row=1/1.1(=화면 3,4번)은 같은 배열(row1)에 side로만 나뉘어 들어있다. 내부 row=2/2.1
        // (옛 화면 5,6번, "주가<H1/주가>H1")은 완전 삭제됨(사용자 요청). 8,8.1,9,9.1,10,10.1은
        // A/B 카드 아래 추가된 C~H(사용자 요청).
        const eventListFor = (row) => (
          row === 1 || row === 1.1 ? rEvents.row1 :
          row === 3 ? rEvents.row3 : row === 4 ? rEvents.row4 :
          row === 8 ? rEvents.rowC : row === 8.1 ? rEvents.rowD :
          row === 9 ? rEvents.rowE : row === 9.1 ? rEvents.rowF :
          row === 10 ? rEvents.rowG : row === 10.1 ? rEvents.rowH :
          row === 11 ? rEvents.rowI : row === 11.1 ? rEvents.rowJ :
          row === 12 ? rEvents.rowK : row === 12.1 ? rEvents.rowL :
          row === 13 ? rEvents.rowM : rEvents.rowN
        )
        const fireRow = (row, side, idx) => {
          openModalPositionAt(side, rows[idx].close, rows[idx].time,
            { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: `row${row}` })
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
        // 3,4,5,6번 블랭킷 청산과 "✅ 익절: H1×H3 크로스 청산"(twTpExitCross) 기능은 삭제됨(사용자 요청).
        // 🎯 청산목표 - S1/H3/H5/W85 4종(후속 기능)만 여기서 처리, 골든=숏 청산/데드=롱 청산(tag 상관없이
        // 열려있는 모든 포지션 대상 - 벌크 청산과는 별개로 실시간 자동 동작). S100 계열 3종(터치 방식)은
        // rEvents.exitCross에 없어서 아래 SL/TP 루프 쪽에서 별도로 처리한다.
        if ((isGold || isNasdaq) && twExitCrossPairRef.current && rEvents.exitCross[twExitCrossPairRef.current]) {
          const exitHit = rEvents.exitCross[twExitCrossPairRef.current].find(e => e.idx >= from && e.idx < to)
          if (exitHit) {
            positionsRef.current.forEach(p => {
              if (!closedIds.has(p.id) && p.side === exitHit.closeSide) {
                closePositionAt(p.id, rows[exitHit.idx].close, rows[exitHit.idx].time, p); closedIds.add(p.id)
              }
            })
          }
        }
      }
    }
    } catch (e) {
      console.error('[재생] applyIncrement 도중 에러, 위치는 계속 진행함:', e)
    } finally {
      indexRef.current = to
      setPlayIndex(to)
      // 캔들이 새로 그려질 때마다 화면(카메라)도 같이 따라가야 한다(사용자 지적) - play()가 재생 시작
      // 순간에만 카메라를 한 번 맞추고 그 뒤로는 안 움직여서, 캔들이 계속 오른쪽으로만 쌓이고 화면
      // 밖으로 넘어가는 문제가 있었다. 매 틱마다 scrubView로 지금 위치를 다시 중앙에 맞춘다.
      scrubView(to)
      updateTimerAnchor()
      updateFoundMarkerAnchors()
      updateMaStopAnchor()
      updateExitTargetAnchor()
      updatePositionAnchors()
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
    // "하루의 시작"은 자정이 아니라 07:00(KST) 고정 기준 - 자정~07시 사이 캔들은 있으면 이미 그려진
    // 채로 두고, 그날 07시 이후 첫 캔들부터 재생 위치가 시작된다(사용자 확정 - 공백 탐지 방식은 다른
    // 공백에 잘못 걸릴 수 있어서 폐기하고, 07시 고정으로 되돌림).
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
    const stoch4 = rollingStochastic(fullRows, ...STOCH4_PARAMS)
    stoch4DataRef.current = sliceStoch(stoch4.k, stoch4.d)

    // 스토(70,15,15)/(210,45,45) K/D 크로스 세로줄 - K/D가 교차하는 캔들마다 전부 기록한다(밴드
    // 바깥 상태 조건은 삭제, 사용자 요청). color는 안 담고 type만 담아서 렌더 시점에 최신 색상
    // (ref)으로 칠한다 - 색상 피커에서 즉시 반영되게 하려고(다른 색상 피커들과 동일 패턴).
    {
      const crossTimes = []
      for (let i = startIdx; i < endIdx; i++) {
        const t = fullRows[i].time
        const k = stoch3.k[i], d = stoch3.d[i], pk = stoch3.k[i - 1], pd = stoch3.d[i - 1]
        if (k != null && d != null && pk != null && pd != null) {
          const golden = pk <= pd && k > d
          const dead = pk >= pd && k < d
          if (golden || dead) crossTimes.push({ idx: i - startIdx, time: t, type: golden ? 'golden' : 'dead' })
        }
      }
      stoch3CrossTimesRef.current = crossTimes
    }
    {
      const crossTimes = []
      for (let i = startIdx; i < endIdx; i++) {
        const t = fullRows[i].time
        const k = stoch4.k[i], d = stoch4.d[i], pk = stoch4.k[i - 1], pd = stoch4.d[i - 1]
        if (k != null && d != null && pk != null && pd != null) {
          const golden = pk <= pd && k > d
          const dead = pk >= pd && k < d
          if (golden || dead) crossTimes.push({ idx: i - startIdx, time: t, type: golden ? 'golden' : 'dead' })
        }
      }
      stoch4CrossTimesRef.current = crossTimes
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
    stoch4DataRef.current = { k: [], d: [] }
    stoch4CrossTimesRef.current = []
    syncStoch4(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    reservationSeriesRef.current = null
    reservationEventsRef.current = null
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    uploadedEdgePrimitiveRef.current?.setPoints([])
    setPositions([]); setPositionAnchors([]) // 새 구간을 불러오면 그 전 리플레이의 미체결 포지션은 그냥 사라짐(새 연습 세션)
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
        // 있었다(사용자 지적) - 그 대신 재생 시작 지점 근처를 평소 캔들 폭 그대로, 화면 좌우 중앙에
        // 오도록 보여준다(사용자 요청 - play()/reset()이 scrubView로 재생 위치를 중앙에 두는 것과 동일).
        // ★ 예전엔 여기서 ts.getVisibleLogicalRange()를 읽어서 "기존 줌 유지"를 시도했는데, 바로 위
        // applyIndex()의 setData()가 lightweight-charts의 기본 auto-fit을 트리거해서 그 순간 range가
        // 이미 "지금까지 그려진 캔들 전체"(수백 개)로 망가져 있었다 - 그 결과 캔들 하나당 픽셀이 너무
        // 좁아져서 X축 눈금이 항상 15분 단위로 뭉개져 보이는 원인이었다(실측으로 확인: 15분 간격일 때
        // 캔들당 약 6px, INITIAL_VISIBLE_CANDLES=60이면 훨씬 넓은 약 15~19px/캔들이 나와 정상 범위).
        // 이제 그 손상된 값을 읽지 않고 항상 고정값을 쓴다(scrubView를 그대로 쓰면 여기서도 같은
        // auto-fit 문제에 걸리므로, 고정폭으로 직접 계산한다).
        const chart = chartRef.current
        if (chart) {
          const boundary = dayRows.playStartIdx ?? 0
          const ts = chart.timeScale()
          ts.setVisibleLogicalRange({ from: boundary - INITIAL_VISIBLE_CANDLES / 2, to: boundary + INITIAL_VISIBLE_CANDLES / 2 })
          // 세로(가격) 중앙 정렬 - 가로 중앙 정렬과 같은 이유(사용자 요청, "처음 로드 순간만"으로 확정).
          // autoScale은 "지금 보이는 데이터" 기준으로 매 순간 다시 계산되므로, 여기서 맞춰놔도 autoScale을
          // 다시 켜두면 다음 재계산 때 바로 원래대로 돌아가 버려 사실상 적용 안 한 것과 같다 - 그래서
          // autoScale을 끄고 지금 자동계산된 범위의 폭(span)은 그대로 유지한 채, 중심만 마지막으로
          // 그려진 캔들(재생 위치 바로 앞) 종가로 옮긴다. 대신 이후 재생 중 가격이 이 범위를 크게
          // 벗어나면 캔들이 위/아래로 잘려 안 보일 수 있음(사용자 확인 후 진행) - 새 날짜를 불러오면
          // 여기서 다시 중앙으로 재조정된다.
          const ps = seriesRef.current?.priceScale()
          const priceRange = ps?.getVisibleRange()
          if (ps && priceRange) {
            const span = priceRange.to - priceRange.from
            const centerPrice = dayRows[boundary - 1]?.close ?? (priceRange.from + priceRange.to) / 2
            ps.applyOptions({ autoScale: false })
            ps.setVisibleRange({ from: centerPrice - span / 2, to: centerPrice + span / 2 })
          }
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

  // ── 라이브 연결 ──────────────────────────────────────────────────────────
  // 과거 CSV를 날짜로 골라 불러오던 위 loadRange/loadDate 대신, 라이브 페이지는 /api/live-price로 초기
  // 1회 전체 조회(백필분 포함) 후, 이후 갱신은 Supabase Realtime(웹소켓)으로 즉시 받는다 - 폴링(몇 초
  // 간격으로 물어보기)은 "실시간 매매엔 너무 느리다"는 사용자 지적으로 Realtime 푸시로 바꿨고, 폴링은
  // 연결이 끊겼을 때 대비한 뜸한 안전망(LIVE_FALLBACK_POLL_MS)으로만 남겨뒀다. 지표 워밍업용 과거봉은
  // MT5 EA가 시작 시 직접 live_candles에 백필해두므로(EasyTrade_LivePriceSender.mq5), 여기선 그냥
  // 서버에 있는 걸 받아오기만 하면 된다. computeIndicatorsForRange/applyIndex는 "fullRows 전체를 그
  // 구간 그대로 보여준다"는 동작이 그대로 맞아떨어져서 손대지 않고 재사용한다.
  // 지표 재계산은 갱신이 올 때마다 통째로 다시 도는데(rowsRef 전체를 O(n)으로 훑는 롤링계산 여러 개),
  // 백필된 3일치+계속 쌓이는 라이브봉을 다 넣고 돌리면 미장 시작처럼 캔들이 빠르게 들어올 때 그 계산
  // 자체가 오래 걸려서 화면이 실제 가격을 못 따라가는 지연이 있었다(사용자 지적). 지표 최대 워밍업이
  // 1200개(SMA1200 등)뿐이라, 매번 넘겨주는 배열을 넉넉히 2500개로 잘라서 계산량을 고정시킨다 -
  // 스크롤로 더 먼 과거를 보는 용도가 아니라 "현재 값"만 정확하면 되는 라이브 화면이라 문제없음.
  const LIVE_COMPUTE_WINDOW = 2500
  // 예전엔 여기서 5분 넘게 비는 지점을 찾아 그 이전 데이터를 통째로 버렸다("EA 재시작 시 시간 점프"
  // 대응용). 그런데 그 진짜 원인은 클라이언트가 탭 백그라운드/Realtime 재연결 때 밀린 데이터를 다
  // 못 받아온 것이었고(pollLiveOnce가 백로그를 끝까지 못 비우던 버그) 이미 따로 고쳤다(가득 찰 때까지
  // 반복해서 받아오는 루프 + 포커스 복귀 시 즉시 캐치업). 이 트림은 그 대응이 아니라 "주말/장마감처럼
  // 정상적으로 몇 시간~며칠 비는 구간"까지 전부 걸려서, 장이 다시 열릴 때마다 과거 데이터를 통째로
  // 날려버리고 방금 들어온 캔들 1~2개만 남기는 부작용이 있었다(사용자 지적 - "캔들이 안 그려짐").
  // 원인이 이미 해결된 안전장치라 완전히 제거.

  const refreshLiveChart = () => {
    const fullRows = liveRowsRef.current.length > LIVE_COMPUTE_WINDOW
      ? liveRowsRef.current.slice(-LIVE_COMPUTE_WINDOW)
      : liveRowsRef.current
    if (!fullRows.length) return
    const fromStr = toLocalDateStr(fullRows[0].time)
    const toStr = toLocalDateStr(fullRows[fullRows.length - 1].time)
    const dayRows = computeIndicatorsForRange(fullRows, fromStr, toStr)
    if (uploadedTradesRef.current.length > 0) recomputeUploadedTradeMarkers()
    applyIndex(dayRows.length)

    // 새로고침/심볼전환 직후 딱 한 번만 - 지금 그려지는 지점(최신 캔들)이 화면 좌우 중앙에 오도록
    // 카메라를 맞춘다(사용자 요청 - "새 캔들 그리는 곳이 중간에 와있어야 함"). loadRange가 재생 시작
    // 지점을 중앙에 두는 것과 완전히 같은 방식 - 이후 폴링(hasLiveCenteredRef=true)에서는 사용자가
    // 스크롤/줌해둔 걸 존중해서 다시 안 건드린다.
    if (!hasLiveCenteredRef.current && dayRows.length > 0) {
      hasLiveCenteredRef.current = true
      const chart = chartRef.current
      if (chart) {
        const boundary = dayRows.length
        const ts = chart.timeScale()
        ts.setVisibleLogicalRange({ from: boundary - INITIAL_VISIBLE_CANDLES / 2, to: boundary + INITIAL_VISIBLE_CANDLES / 2 })
        const ps = seriesRef.current?.priceScale()
        const priceRange = ps?.getVisibleRange()
        if (ps && priceRange) {
          const span = priceRange.to - priceRange.from
          const centerPrice = dayRows[boundary - 1]?.close ?? (priceRange.from + priceRange.to) / 2
          ps.applyOptions({ autoScale: false })
          ps.setVisibleRange({ from: centerPrice - span / 2, to: centerPrice + span / 2 })
        }
      }
    }
  }

  // 한 번의 폴링에서 새로 받은 rows를 liveRowsRef에 반영한다(id 기준 병합 - 진행 중인 캔들은 같은
  // id로 갱신되어 들어옴).
  // liveRowsRef 자체도 탭을 오래 켜두면 계속 불어나서(하루치+백필분) 이 merge의 Map 재구성/정렬
  // 비용까지 같이 늘어난다 - 화면엔 최근 몇십 개만 보이지만, SMA1200/HMA1200처럼 제일 긴 지표가
  // 1200개 워밍업을 필요로 해서 그보다는 넉넉해야 한다(사용자 지적으로 재확인 - 필요 이상 크게
  // 잡았던 6000을 계산 창(LIVE_COMPUTE_WINDOW=2500)에 딱 맞춰 줄임).
  const LIVE_ROWS_MAX = 3000

  const mergeLiveRows = (incoming) => {
    const offsetSeconds = summerTimeRef.current ? BROKER_OFFSET_SECONDS.summer : BROKER_OFFSET_SECONDS.winter
    const byId = new Map(liveRowsRef.current.map(r => [r.id, r]))
    // bar_date/bar_time은 자릿수 고정 텍스트라 문자열 비교(> )가 시간순 비교와 정확히 일치한다.
    const isNewer = (d, t) => {
      const cur = liveLastCursorRef.current
      return !cur || d > cur.date || (d === cur.date && t >= cur.time)
    }
    for (const r of incoming) {
      byId.set(r.id, {
        id: r.id,
        time: toUnixSeconds(r.date, r.time, offsetSeconds),
        open: r.open, high: r.high, low: r.low, close: r.close,
      })
      if (isNewer(r.date, r.time)) liveLastCursorRef.current = { date: r.date, time: r.time }
    }
    let merged = Array.from(byId.values()).sort((a, b) => a.time - b.time)
    if (merged.length > LIVE_ROWS_MAX) merged = merged.slice(-LIVE_ROWS_MAX)
    liveRowsRef.current = merged
  }

  const LIVE_STALE_SEC = 90 // 마지막 캔들 시각이 지금으로부터 이만큼(초) 넘게 지나면 "끊김"으로 본다(M1이라 정상이면 60초 안쪽)

  // 마지막 캔들의 "실제 시각"으로 끊김 여부를 판단해서 상태를 갱신한다 - pollLiveOnce/Realtime 이벤트
  // 양쪽에서 공유해서 쓴다(중복 제거).
  const refreshLiveStaleStatus = () => {
    const rows = liveRowsRef.current
    const lastBarTime = rows.length ? rows[rows.length - 1].time : null
    const ageSec = lastBarTime != null ? Math.floor(Date.now() / 1000) - lastBarTime : Infinity
    if (lastBarTime != null && ageSec > LIVE_STALE_SEC) {
      setLiveStatus('stale')
      setLiveStaleSec(ageSec)
    } else {
      setLiveStatus('live')
    }
  }

  // REST로 한 번에 받아오는 경로 - 최초 로드(백필분 포함 전체)와, Realtime이 놓쳤을까봐 도는 가벼운
  // 안전망 폴링(LIVE_FALLBACK_POLL_MS) 둘 다 이걸 쓴다. 평소엔 아래 Realtime 구독이 갱신을 즉시
  // 처리하므로, 이 함수가 새로 받아올 게 있는 경우는 자주 없다(있으면 그것도 정상 처리됨).
  // Realtime(웹소켓)이 탭 백그라운드/절전모드 등으로 조용히 끊기면, 그동안 서버엔 계속 정상으로
  // 쌓이는데 브라우저만 놓친다 - 돌아왔을 때 밀린 게 한 번의 요청으로 못 받을 만큼 많으면, "옛날 값 →
  // 뚝 끊기고 → 훨씬 나중 값"으로 튀어 보이는 버그가 있었다(사용자가 실제로 겪음 - 서버 데이터 자체는
  // 끊김 없었다고 직접 확인함). 처음엔 sinceId(auto increment) 기준으로 "응답이 꽉 찼으면 더 있다"고
  // 판단했는데 두 가지 문제가 겹쳐 있었다: (1) Supabase가 코드의 .limit(5000)과 무관하게 실제로는
  // 1000개로 응답을 잘라서, "1000<5000이니 다 받았다"고 오판하고 첫 페이지에서 멈춰버림, (2) id는 EA가
  // 진행 중인 캔들을 500ms마다 같은 행에 upsert해도 Postgres 시퀀스가 매번 소모돼서 실제 캔들 수보다
  // 훨씬 빨리 늘어나 - "빈 응답 올 때까지 반복"으로 고쳐도, 최근 구간은 id가 텅 비어서 새 캔들 1개
  // 받는 데 요청 수십~수백 번이 걸리는 새 문제가 생겼다(전부 사용자가 직접 API로 검증).
  // 근본 원인은 "id를 커서로 쓴 것" 자체였다 - pages/api/live-price.js를 sinceDate/sinceTime(캔들의
  // 실제 시각, bar_date/bar_time) 커서로 바꿔서, 진짜 캔들 개수에 정확히 비례해 진행되게 했다. 이제는
  // 안전하게 "빈 응답이 올 때까지" 반복해도 된다(대량 백필 기준으로도 충분한 guard만 걸어둠).
  const pollLiveOnce = async (sym) => {
    try {
      for (let guard = 0; guard < 50; guard++) { // 대량 백필(수천 개)도 페이지당 1000개면 몇 페이지면 끝남 - 넉넉한 여유
        const cur = liveLastCursorRef.current
        const qs = cur
          ? `symbol=${sym}&sinceDate=${encodeURIComponent(cur.date)}&sinceTime=${encodeURIComponent(cur.time)}`
          : `symbol=${sym}`
        const res = await fetch(`/api/live-price?${qs}`)
        if (!res.ok) throw new Error(`API 오류(${res.status})`)
        const data = await res.json()
        if (sym !== symbolRef.current) return // 응답 오는 사이 심볼이 바뀌었으면 버림
        const incoming = data.rows || []
        if (incoming.length === 0) break // (cur가 null인 첫 요청만 해당 - 데이터가 아예 없는 경우)
        // sinceTime을 >=로 요청해서 마지막으로 받은 캔들 자기 자신은 매번 다시 포함되므로, 응답 길이가
        // 0이 되는 일은 사실상 없다 - 대신 "커서가 실제로 더 전진했는지"로 진짜 새 데이터 유무를 본다.
        const cursorBefore = liveLastCursorRef.current
        mergeLiveRows(incoming)
        const cursorAfter = liveLastCursorRef.current
        if (cursorBefore && cursorAfter && cursorBefore.date === cursorAfter.date && cursorBefore.time === cursorAfter.time) break
        // 1페이지로 안 끝나고 더 받아야 한다는 뜻 - 여러 페이지를 마저 받는 동안은 화면을 아직 안
        // 갱신했으니(refreshLiveChart는 루프가 끝난 뒤 한 번만 호출) "갱신 중" 표시를 띄운다.
        if (guard === 0) setLiveCatchingUp(true)
      }
      setLiveCatchingUp(false)
      refreshLiveChart()
      // 폴링 요청 자체는 계속 200으로 성공해도 EA가 멈추면 캔들 내용이 그대로 멈춰있으니, "요청 성공
      // 여부"가 아니라 "마지막 캔들의 실제 시각이 지금과 얼마나 벌어졌는지"로 끊김을 판단한다.
      refreshLiveStaleStatus()
    } catch {
      setLiveCatchingUp(false)
      setLiveStatus('error')
    }
  }

  // Supabase Realtime(웹소켓)으로 live_candles 변경을 즉시 받는다 - 폴링(몇 초 간격)과 달리 DB에
  // 새 행이 생기거나 갱신되는 그 순간 브라우저로 바로 밀려온다(사용자 요청 - "틱마다 따라가야 함",
  // 3초 폴링으로는 실시간 매매에 못 씀). EA가 보내는 만큼(SendEveryMs)이 사실상의 속도 한계가 된다.
  // EA가 재시작되면 3일치 백필이 통째로 다시 들어가는데, 그 수천 개 행이 각각 개별 이벤트로 밀려오면
  // 이벤트마다 매번 다시 그리느라 화면이 잠깐 뒤죽박죽 보였다(사용자 지적 - "시간이 붕 떠버림") - 그래서
  // 짧은 시간(300ms) 안에 몰려온 이벤트를 모았다가 한 번에만 반영한다.
  // 원래는 여기서 밀려온 행을 mergeLiveRows에 바로 넣었는데, 그러면 그 행의 (date,time)이 커서보다
  // 훨씬 앞서 있어도(예: REST 캐치업이 아직 못 따라온 구간을 건너뛰고 "지금 막 들어온 캔들"이 먼저
  // 도착) 커서가 그 값으로 그냥 전진해버려서, 그 사이 안 받아온 구간을 영영 건너뛰게 되는 버그가
  // 있었다(사용자가 스샷으로 실제 확인 - "19:55에서 02:56으로 점프"). Realtime은 "뭔가 바뀌었다"는
  // 신호로만 쓰고, 실제 반영은 항상 pollLiveOnce의 정렬된 REST 캐치업을 통해서만 하도록 바꿔서
  // 커서가 구간을 건너뛸 수 없게 한다 - 그 사이엔 liveCatchingUp으로 "갱신 중"을 보여준다.
  const REALTIME_DEBOUNCE_MS = 300
  const realtimeSymRef = useRef(null)
  const realtimeFlushTimerRef = useRef(null)

  const flushRealtimeBuffer = () => {
    realtimeFlushTimerRef.current = null
    const sym = realtimeSymRef.current
    realtimeSymRef.current = null
    if (!sym) return
    pollLiveOnce(sym)
  }

  const handleRealtimeChange = (sym, payload) => {
    const row = payload.new
    if (!row || sym !== symbolRef.current) return
    realtimeSymRef.current = sym
    if (!realtimeFlushTimerRef.current) {
      realtimeFlushTimerRef.current = setTimeout(flushRealtimeBuffer, REALTIME_DEBOUNCE_MS)
    }
  }

  const subscribeLiveRealtime = (sym) => {
    if (liveRealtimeChannelRef.current) supabaseClient.removeChannel(liveRealtimeChannelRef.current)
    liveRealtimeChannelRef.current = supabaseClient
      .channel(`live_candles_${sym}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'live_candles', filter: `symbol=eq.${sym}` },
        (payload) => handleRealtimeChange(sym, payload))
      .subscribe()
  }

  const LIVE_FALLBACK_POLL_MS = 20000 // Realtime이 평소 처리하므로, 폴링은 연결이 끊겼을 때 대비한 안전망 정도로만 뜸하게

  // 심볼이 바뀌거나 페이지를 뜰 때 호출 - 그 심볼의 연결을 새로 시작한다(이전 심볼의 구독/버퍼는 정리).
  const startLivePolling = (sym) => {
    if (liveRealtimeChannelRef.current) { supabaseClient.removeChannel(liveRealtimeChannelRef.current); liveRealtimeChannelRef.current = null }
    if (livePollTimerRef.current) clearInterval(livePollTimerRef.current)
    liveRowsRef.current = []
    liveLastCursorRef.current = null
    hasLiveCenteredRef.current = false
    setLiveConnected(true) // 심볼을 바꾸면 수동으로 끊어뒀던 것도 다시 연결(새로 시작하는 거니까)
    setLiveStatus('connecting')
    pollLiveOnce(sym) // 초기 전체 로드(백필분 포함) - 이후 갱신은 Realtime이 담당
    subscribeLiveRealtime(sym)
    livePollTimerRef.current = setInterval(() => pollLiveOnce(symbolRef.current), LIVE_FALLBACK_POLL_MS)
  }

  // "연결 끊기/연결하기" 버튼(사용자 요청) - Realtime 구독/폴링 다 멈추고 지금까지 그려진 차트는
  // 그대로 둔다(데이터 초기화 안 함). 다시 연결하면 그 시점 이후 새 캔들부터 이어서 받아온다.
  const disconnectLive = () => {
    if (liveRealtimeChannelRef.current) { supabaseClient.removeChannel(liveRealtimeChannelRef.current); liveRealtimeChannelRef.current = null }
    if (livePollTimerRef.current) { clearInterval(livePollTimerRef.current); livePollTimerRef.current = null }
    setLiveConnected(false)
    setLiveStatus('disconnected')
  }
  const reconnectLive = () => {
    setLiveConnected(true)
    pollLiveOnce(symbolRef.current)
    subscribeLiveRealtime(symbolRef.current)
    livePollTimerRef.current = setInterval(() => pollLiveOnce(symbolRef.current), LIVE_FALLBACK_POLL_MS)
  }

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
    stoch4DataRef.current = { k: [], d: [] }
    stoch4CrossTimesRef.current = []
    syncStoch4(0)
    crossPointsRef.current = []
    autoEventsRef.current = []
    simEventsRef.current = []
    reservationSeriesRef.current = null
    reservationEventsRef.current = null
    sessionPointsRef.current = []
    markersPrimitiveRef.current?.setMarkers([])
    uploadedEdgePrimitiveRef.current?.setPoints([])
    setPositions([]); setPositionAnchors([])
  }

  const toggleSummerTime = () => setSummerTime(prev => !prev)

  // 서머타임 상태가 바뀌면 liveRowsRef에 이미 변환해둔 time엔 예전 오프셋이 반영돼 있어서 그대로 두면
  // 안 바뀐다 - 원본 브로커 date/time 문자열은 따로 안 들고 있으므로, 폴링을 새로 시작해서(커서 초기화 후
  // 처음부터) 새 오프셋으로 처음부터 다시 변환한다(라이브 세션 데이터라 다시 받아도 가벼움).
  // (setSummerTime 콜백 안에서 바로 부르면 summerTime이 아직 안 바뀐 값이라 한 번 밀리므로 effect로 분리)
  const summerTimeMountedRef = useRef(false)
  useEffect(() => {
    if (!summerTimeMountedRef.current) { summerTimeMountedRef.current = true; return } // 마운트 시엔 심볼 effect가 이미 폴링을 시작하므로 중복 호출 방지
    startLivePolling(symbolRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [summerTime])

  // candleVisible이 바뀔 때마다 sessionStorage에 저장 - 다른 페이지 갔다가 돌아와도 유지되게(마운트 시
  // restoreRef가 읽어서 복원). 라이브는 항상 골드로 시작하고(사용자 요청) 날짜/재생위치 개념이 없어서
  // replay.js와 달리 candleVisible 하나만 저장한다.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.sessionStorage.setItem(LIVE_STATE_KEY, JSON.stringify({ candleVisible }))
    } catch { /* 저장 실패해도(예: 프라이빗 모드 용량제한) 기능엔 영향 없음 - 그냥 다음번엔 복원 안 될 뿐 */ }
  }, [candleVisible])

  // 차트 표시 설정(체크박스/색상/두께/시간/투명도/모양/크기/슬롯 선택 전부) 저장 - localStorage라 브라우저를
  // 완전히 닫았다 열어도 유지된다. "초기화" 버튼을 눌렀을 때만 LIVE_SETTINGS_KEY를 지우고 새로고침한다.
  useEffect(() => {
    if (typeof window === 'undefined') return
    try {
      window.localStorage.setItem(LIVE_SETTINGS_KEY, JSON.stringify({
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
        enabledStoch4, stoch4KColor, stoch4DColor,
        stoch3CrossEnabled, stoch3CrossOpacity,
        stoch4CrossEnabled, stoch4CrossOpacity,
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
    if (!window.confirm('차트 설정을 전부 기본값으로 초기화할까요? (심볼은 유지되고, 라이브 데이터는 새로 다시 불러옵니다)')) return
    try {
      window.localStorage.removeItem(LIVE_SETTINGS_KEY)
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
      s.middle.applyOptions({ color: BOLLINGER_MIDDLE_COLOR_OVERRIDE[bandId] || color })
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
      s.middle.applyOptions({ color: BOLLINGER_MIDDLE_COLOR_OVERRIDE[band.id] || band.color })
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
          middle: chartRef.current.addSeries(LineSeries, { color: BOLLINGER_MIDDLE_COLOR_OVERRIDE[bandId] || color, lineWidth: 2, lastValueVisible: false, priceLineVisible: false, visible: isLineVisible(bandId, 'middle') }),
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

  // 스토캐스틱 4세트 - 각자 자기만의 pane(RSI와 같은 방식, MACD1/MACD5처럼 공유 안 함)
  // 스토캐스틱 4세트는 서로 같은 pane을 공유한다(MACD1/MACD5와 같은 방식, 사용자 요청 - "겹쳐서 나와야 함")
  // - 넷 중 이미 켜진 게 있으면 그 pane index를 그대로 쓰고, 끌 때는 나머지 셋 다 꺼져 있을 때만 pane 자체를 지운다.
  const findStochPaneIndex = () => {
    if (stoch1SeriesRef.current) return stoch1SeriesRef.current.k.getPane().paneIndex()
    if (stoch2SeriesRef.current) return stoch2SeriesRef.current.k.getPane().paneIndex()
    if (stoch3SeriesRef.current) return stoch3SeriesRef.current.k.getPane().paneIndex()
    if (stoch4SeriesRef.current) return stoch4SeriesRef.current.k.getPane().paneIndex()
    return chartRef.current.panes().length
  }
  const anyOtherStochOn = (exclude) => (
    (exclude !== 1 && stoch1SeriesRef.current) ||
    (exclude !== 2 && stoch2SeriesRef.current) ||
    (exclude !== 3 && stoch3SeriesRef.current) ||
    (exclude !== 4 && stoch4SeriesRef.current)
  )
  // 70/15/15, 210/45/45 세로줄을 메인 캔들 pane뿐 아니라 스토캐스틱 pane에도 하나씩 더 얹는다(사용자 지적 - 스토 부분엔 안 보였음)
  const ensureStochPaneCrossLine = (series) => {
    if (!stoch3CrossLineStochPaneRef.current) {
      stoch3CrossLineStochPaneRef.current = new MultiVerticalLinesPrimitive()
      series.attachPrimitive(stoch3CrossLineStochPaneRef.current)
    }
    if (!stoch4CrossLineStochPaneRef.current) {
      stoch4CrossLineStochPaneRef.current = new MultiVerticalLinesPrimitive()
      series.attachPrimitive(stoch4CrossLineStochPaneRef.current)
    }
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
          stoch4CrossLineStochPaneRef.current = null
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
          stoch4CrossLineStochPaneRef.current = null
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
          stoch4CrossLineStochPaneRef.current = null
        }
      }
      stoch3SeriesRef.current = null
      stoch3CrossLineRef.current?.setLines([])
    }
  }
  const setStoch3KColor = (color) => {
    setStoch3KColorState(color)
    stoch3SeriesRef.current?.k.applyOptions({ color })
    stoch3CrossUpColorRef.current = color // 상승(골든)크로스 세로줄 색=%K색(사용자 요청) - 즉시 재적용
    applyStoch3Index(indexRef.current)
  }
  const setStoch3DColor = (color) => {
    setStoch3DColorState(color)
    stoch3SeriesRef.current?.d.applyOptions({ color })
    stoch3CrossDownColorRef.current = color // 하락(데드)크로스 세로줄 색=%D색
    applyStoch3Index(indexRef.current)
  }
  // 스토(70,15,15) K/D 크로스 세로줄 on/off, 투명도 - ref 즉시 갱신 후 재적용(사용자 요청)
  const toggleStoch3Cross = () => {
    const next = !stoch3CrossEnabled
    setStoch3CrossEnabledState(next)
    stoch3CrossEnabledRef.current = next
    applyStoch3Index(indexRef.current)
  }
  const setStoch3CrossOpacity = (opacity) => {
    setStoch3CrossOpacityState(opacity)
    stoch3CrossOpacityRef.current = opacity
    applyStoch3Index(indexRef.current)
  }

  // 스토(210,45,45) - 스토(70,15,15)와 동일한 방식(사용자 요청 - "다른스토들과 같은 방식으로")
  const toggleStoch4 = () => {
    const turningOn = !enabledStoch4
    setEnabledStoch4(turningOn)
    if (turningOn) {
      if (!stoch4SeriesRef.current && chartRef.current) {
        const paneIndex = findStochPaneIndex()
        stoch4SeriesRef.current = {
          k: chartRef.current.addSeries(LineSeries, { color: stoch4KColor, lineWidth: 2, lastValueVisible: false, priceLineVisible: false }, paneIndex),
          d: chartRef.current.addSeries(LineSeries, { color: stoch4DColor, lineWidth: 1, lastValueVisible: false, priceLineVisible: false }, paneIndex),
        }
        ensureStochPaneCrossLine(stoch4SeriesRef.current.k)
        applyStochPaneRatio(chartRef.current, paneIndex)
        bumpMarkerLayer()
      }
      applyStoch4Index(indexRef.current)
    } else {
      const s = stoch4SeriesRef.current
      if (s && chartRef.current) {
        const pane = s.k.getPane()
        chartRef.current.removeSeries(s.k)
        chartRef.current.removeSeries(s.d)
        if (!anyOtherStochOn(4)) {
          try { chartRef.current.removePane(pane.paneIndex()) } catch (e) { /* 이미 자동 제거됐을 수 있음 */ }
          stoch3CrossLineStochPaneRef.current = null
          stoch4CrossLineStochPaneRef.current = null
        }
      }
      stoch4SeriesRef.current = null
      stoch4CrossLineRef.current?.setLines([])
    }
  }
  const setStoch4KColor = (color) => {
    setStoch4KColorState(color)
    stoch4SeriesRef.current?.k.applyOptions({ color })
    stoch4CrossUpColorRef.current = color // 상승(골든)크로스 세로줄 색=%K색(사용자 요청)
    applyStoch4Index(indexRef.current)
  }
  const setStoch4DColor = (color) => {
    setStoch4DColorState(color)
    stoch4SeriesRef.current?.d.applyOptions({ color })
    stoch4CrossDownColorRef.current = color // 하락(데드)크로스 세로줄 색=%D색
    applyStoch4Index(indexRef.current)
  }
  // 스토(210,45,45) K/D 크로스 세로줄 on/off, 투명도
  const toggleStoch4Cross = () => {
    const next = !stoch4CrossEnabled
    setStoch4CrossEnabledState(next)
    stoch4CrossEnabledRef.current = next
    applyStoch4Index(indexRef.current)
  }
  const setStoch4CrossOpacity = (opacity) => {
    setStoch4CrossOpacityState(opacity)
    stoch4CrossOpacityRef.current = opacity
    applyStoch4Index(indexRef.current)
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

  // 라이브 페이지는 배속 재생 개념이 없으니(사용자 요청) 캔들 타이머를 위 두 effect(배속 기준 카운트다운)
  // 대신 실제 벽시계 기준 "다음 정각 분까지 남은 시간"으로 보여준다 - MT5 M1 캔들은 매 분 0초에 새로 연다.
  // liveStatus가 'live'가 아니면(주말/장마감 등으로 데이터가 끊김) 더 이상 값을 갱신하지 않는다 - 데이터가
  // 안 오는데도 "곧 새 캔들"이라며 계속 도는 게 오해를 준다는 지적(사용자) - 숨기지 말고 그 순간 값에서
  // 그대로 얼려서 "멈춰있음"을 보여준다(배지 표시는 렌더 쪽에서 아이콘/색을 ⏸·회색으로 바꿔 처리).
  useEffect(() => {
    const tick = () => {
      if (liveStatusRef.current !== 'live') return
      setCandleTimerMs(60000 - (Date.now() % 60000))
    }
    tick()
    const timer = setInterval(tick, 200)
    return () => clearInterval(timer)
  }, [])

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
    setPositions(prev => {
      const next = [...prev, {
        id: `${Date.now()}_${Math.random()}`,
        side, symbol, lot: lotSize, entryPrice: currentPrice,
        entryTime: rowsRef.current[playIndex - 1].time,
      }]
      updatePositionAnchors(next)
      return next
    })
  }

  // 계좌 라벨을 입력하면 그 EA가 보고해둔 계좌 상태(데모/라이브, 잔고)를 10초마다 폴링해서 보여준다 -
  // 실주문 켜기 전에 "내가 지금 어느 계좌에 연결돼 있는지" 미리 확인할 수 있게(사용자 요청).
  useEffect(() => {
    if (!tradeAccountLabel) { setAccountStatus(null); return }
    let cancelled = false
    const poll = () => {
      fetch(`/api/account-status?account_label=${encodeURIComponent(tradeAccountLabel)}`)
        .then(r => r.json())
        .then(data => { if (!cancelled) setAccountStatus(data.status || null) })
        .catch(() => {})
    }
    poll()
    const timer = setInterval(poll, 10000)
    return () => { cancelled = true; clearInterval(timer) }
  }, [tradeAccountLabel])

  // ── 실주문(진짜 MT5 주문) ────────────────────────────────────────────────
  // 위 openPosition 등은 전부 웹 안에서만 도는 가상매매 - 이건 /api/trade-command에 명령을 만들어서
  // MT5 EA(EasyTrade_LivePriceSender.mq5, EnableRealTrading=true)가 실제로 체결하게 하는 별개 기능.
  // 계좌 비밀번호/라벨을 안 정하면 아예 버튼이 막힌다(안전장치) - EA 쪽에도 같은 안전장치가 이중으로 있음.
  const pollTradeCommandStatus = (id, triesLeft = 15) => {
    if (triesLeft <= 0) return
    fetch(`/api/trade-command?id=${id}`)
      .then(r => r.json())
      .then(data => {
        const cmd = data.command
        if (!cmd) return
        setTradeCommands(prev => prev.map(c => c.id === id ? { ...c, status: cmd.status, message: cmd.result_message || '' } : c))
        if (cmd.status === 'pending' || cmd.status === 'claimed') {
          setTimeout(() => pollTradeCommandStatus(id, triesLeft - 1), 2000)
        }
      })
      .catch(() => { /* 다음 폴링에서 재시도 */ })
  }

  const sendTradeCommand = async (direction) => {
    if (!tradeAccountLabel || tradeSending) return
    const actionLabel = direction === 'buy' ? '매수' : direction === 'sell' ? '매도' : '전체 청산'
    const lotLabel = direction === 'close' ? '' : ` ${tradeLot}랏`
    if (!window.confirm(`정말로 계좌 "${tradeAccountLabel}"에 ${symbol} ${actionLabel}${lotLabel} 실주문을 넣을까요? 실제 돈이 움직입니다.`)) return
    setTradeSending(true)
    try {
      const res = await fetch('/api/trade-command', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          account_label: tradeAccountLabel, symbol, direction,
          lot: direction === 'close' ? null : tradeLot,
        }),
      })
      const data = await res.json()
      if (!res.ok) { alert(`전송 실패: ${data.error || res.status}`); return }
      setTradeCommands(prev => [{ id: data.id, direction, status: 'pending', message: '' }, ...prev].slice(0, 20))
      pollTradeCommandStatus(data.id)
    } catch (e) {
      alert('전송 실패: ' + e.message)
    } finally {
      setTradeSending(false)
    }
  }

  // 분리매매창 전용 진입 - 손절/익절을 "포인트"로 받아 절대가격(sl/tp)으로 미리 계산해 포지션에 저장해둔다
  // (PyQt의 sl_spin/tp_spin과 같은 단위). 반자동 예약(1~6번)이 쏜 진입도 이 함수를 그대로 쓴다.
  const openModalPositionAt = (side, price, time, { lot, slPoints, tpPoints, tag }) => {
    const sl = slPoints > 0 ? (side === 'buy' ? price - slPoints : price + slPoints) : null
    const tp = tpPoints > 0 ? (side === 'buy' ? price + tpPoints : price - tpPoints) : null
    setPositions(prev => {
      const next = [...prev, {
        id: `tw${tag ? '_' + tag : ''}_${Date.now()}_${Math.random()}`,
        side, symbol, lot, entryPrice: price, entryTime: time, sl, tp,
      }]
      updatePositionAnchors(next)
      return next
    })
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
      const next = prev.filter(p => p.id !== id)
      updatePositionAnchors(next)
      return next
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

  // 매매진입 현황 패널 드래그 - 분리매매창 드래그(onTwHeaderMouseDown)와 완전히 같은 방식
  const onPosPanelHeaderMouseDown = (e) => {
    posPanelDragRef.current = { startX: e.clientX, startY: e.clientY, origX: posPanelPos.x, origY: posPanelPos.y }
    const onMove = (ev) => {
      if (!posPanelDragRef.current) return
      setPosPanelPos({
        x: posPanelDragRef.current.origX + (ev.clientX - posPanelDragRef.current.startX),
        y: posPanelDragRef.current.origY + (ev.clientY - posPanelDragRef.current.startY),
      })
    }
    const onUp = () => {
      posPanelDragRef.current = null
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

  // 매매진입 현황도 진짜 새 창으로 - openTwPopup/closeTwPopup과 완전히 같은 방식(같은 origin portal로
  // state 공유). 창 안에서 BUY/SELL·청산을 눌러도 이 페이지의 포지션·잔고에 곧바로 반영된다.
  const openPosPopup = () => {
    const w = window.open('', 'easytrade-pos', 'width=380,height=560,resizable=yes')
    if (!w) { alert('팝업이 차단됐어요. 브라우저 주소창의 팝업 차단 아이콘을 눌러 허용해주세요.'); return }
    w.document.title = '매매진입 현황 — EasyTrade'
    document.querySelectorAll('link[rel="stylesheet"], style').forEach(node => {
      w.document.head.appendChild(node.cloneNode(true))
    })
    const resetStyle = w.document.createElement('style')
    resetStyle.textContent = 'body{margin:0} #pos-root button{width:auto;margin-top:0}'
    w.document.head.appendChild(resetStyle)
    w.document.body.style.background = '#0f1115'
    const root = w.document.createElement('div')
    root.id = 'pos-root'
    w.document.body.appendChild(root)
    posWinRef.current = w
    setPosPopupEl(root)
    const onUserClosed = () => { posWinRef.current = null; setPosPopupEl(null); setPositionPanelFloating(false) }
    posOnUnloadRef.current = onUserClosed
    w.addEventListener('beforeunload', onUserClosed)
  }

  const closePosPopup = () => {
    if (posWinRef.current && !posWinRef.current.closed) {
      if (posOnUnloadRef.current) posWinRef.current.removeEventListener('beforeunload', posOnUnloadRef.current)
      posWinRef.current.close()
    }
    posOnUnloadRef.current = null
    posWinRef.current = null
    setPosPopupEl(null)
  }

  useEffect(() => () => { if (posWinRef.current && !posWinRef.current.closed) posWinRef.current.close() }, [])

  // 지금 재생 위치(playIndex-1, dayRows 기준)의 실시간 계산값 하나를 읽는다 - reservationSeriesRef는
  // fullRows(절대) 인덱스라 offset을 더해서 변환. 데이터가 없거나 워밍업 중이면 null.
  // back(기본 0)을 주면 그만큼 이전 캔들 값을 읽는다 - "진입" 표시등(크로스가 이 캔들에서 났는지)처럼
  // 직전 캔들과 비교해야 하는 경우에 씀.
  const twSeriesVal = (key, back = 0) => {
    const S = reservationSeriesRef.current
    if (!S || playIndex <= 0) return null
    const i = (playIndex - 1) + S.offset - back
    if (i < 0) return null
    const v = S[key]?.[i]
    return v == null ? null : v
  }

  // twSeriesVal과 완전히 같은 변환식인데, playIndex 대신 아무 dayIdx나 넣을 수 있게 일반화한 버전
  // (🔍 찾기가 불러온 구간 전체를 훑을 때 씀 - 지금 재생 위치와 무관하게 과거/미래 캔들도 읽어야 함).
  const seriesValAt = (key, dayIdx, back = 0) => {
    const S = reservationSeriesRef.current
    if (!S || dayIdx <= 0) return null
    const i = (dayIdx - 1) + S.offset - back
    if (i < 0) return null
    const v = S[key]?.[i]
    return v == null ? null : v
  }
  // 반자동 예약 카드의 "진입" 표시등과 완전히 같은 공식을 dayIdx 기준으로 재계산(사용자 요청 - 카드에
  // 뜨는 조건과 100% 일치해야 하므로, 자동매매용 computeReservationEvents가 아니라 이 렌더 로직을
  // 그대로 재사용). 7,8번(하락/상승추세)은 상태+준비+진입 세 표시등이 전부 켜진 캔들을 "진입"으로 본다.
  const isSignalEntryAt = (row, i) => {
    const h1 = seriesValAt('h1', i)
    const sma100 = seriesValAt('sma100', i), wma85 = seriesValAt('wma85', i)
    const h300 = seriesValAt('h300', i), prevH300 = seriesValAt('h300', i, 1), prevPrevH300 = seriesValAt('h300', i, 2)
    const price = rowsRef.current[i - 1]?.close ?? null
    const prevPrice = rowsRef.current[i - 2]?.close ?? null
    const stochGolden = seriesValAt('stochGolden', i)
    const row1Armed = seriesValAt('row1Armed', i)
    const prevH1 = seriesValAt('h1', i, 1)
    const prevRow1Armed = seriesValAt('row1Armed', i, 1)
    // 새 3,4번(HMA300 방향, checked=2/2.1 재사용) - "찾기"는 방향이 이 캔들에 새로 바뀐 순간(edge)만
    // 잡는다(사용자 요청 - 계속 참인 캔들을 전부 잡으면 3,4번 없이도 매 캔들 걸리니까).
    if (row === 2) return h300 != null && prevH300 != null && prevPrevH300 != null && h300 < prevH300 && !(prevH300 < prevPrevH300)
    if (row === 2.1) return h300 != null && prevH300 != null && prevPrevH300 != null && h300 >= prevH300 && !(prevH300 >= prevPrevH300)
    // 5,6번 진입 재정의(사용자 정정) - row1Armed가 이 캔들에 새로 'above'/'below'가 된 순간(edge)만.
    if (row === 1) return row1Armed === 'above' && prevRow1Armed !== 'above'
    if (row === 1.1) return row1Armed === 'below' && prevRow1Armed !== 'below'
    // A~L(사용자 지적 - 찾기가 A/B만 되고 있었음, 옛 A/B(주가vsH1)는 이후 삭제됨) -
    // computeReservationEvents의 rowC~rowN과 동일한 엣지 판정(그 상태가 이 캔들에 새로 시작되는
    // 순간)을 dayIdx 기준으로 재계산.
    if (row === 8 || row === 8.1) {
      const s20 = seriesValAt('sma20_1m', i), prevS20 = seriesValAt('sma20_1m', i, 1)
      if (h1 == null || s20 == null || prevH1 == null || prevS20 == null) return false
      return row === 8 ? (h1 < s20 && !(prevH1 < prevS20)) : (h1 > s20 && !(prevH1 > prevS20))
    }
    if (row === 9 || row === 9.1) {
      const h3 = seriesValAt('h3', i), prevH3 = seriesValAt('h3', i, 1)
      if (h1 == null || h3 == null || prevH1 == null || prevH3 == null) return false
      return row === 9 ? (h1 < h3 && !(prevH1 < prevH3)) : (h1 > h3 && !(prevH1 > prevH3))
    }
    if (row === 10 || row === 10.1) {
      const h3 = seriesValAt('h3', i), prevH3 = seriesValAt('h3', i, 1)
      const h5 = seriesValAt('h100', i), prevH5 = seriesValAt('h100', i, 1)
      if (h3 == null || h5 == null || prevH3 == null || prevH5 == null) return false
      return row === 10 ? (h3 < h5 && !(prevH3 < prevH5)) : (h3 > h5 && !(prevH3 > prevH5))
    }
    if (row === 11 || row === 11.1) {
      const w17 = seriesValAt('wma17_1m', i), prevW17 = seriesValAt('wma17_1m', i, 1)
      const s20 = seriesValAt('sma20_1m', i), prevS20 = seriesValAt('sma20_1m', i, 1)
      if (w17 == null || s20 == null || prevW17 == null || prevS20 == null) return false
      return row === 11 ? (w17 < s20 && !(prevW17 < prevS20)) : (w17 > s20 && !(prevW17 > prevS20))
    }
    if (row === 12 || row === 12.1) {
      const h15 = seriesValAt('h300', i), prevH15 = seriesValAt('h300', i, 1)
      if (h1 == null || h15 == null || prevH1 == null || prevH15 == null) return false
      return row === 12 ? (h1 < h15 && !(prevH1 < prevH15)) : (h1 > h15 && !(prevH1 > prevH15))
    }
    if (row === 13 || row === 13.1) {
      if (h1 == null || wma85 == null || prevH1 == null) return false
      const prevWma85 = seriesValAt('wma85', i, 1)
      if (prevWma85 == null) return false
      return row === 13 ? (h1 < wma85 && !(prevH1 < prevWma85)) : (h1 > wma85 && !(prevH1 > prevWma85))
    }
    if (row === 4) {
      const state = wma85 != null && sma100 != null && wma85 < sma100
      const ready = price != null && h1 != null && price < h1 && h300 != null && prevH300 != null && h300 < prevH300
      return state && ready && stochGolden === false
    }
    if (row === 3) {
      const state = wma85 != null && sma100 != null && wma85 > sma100
      const ready = price != null && h1 != null && price > h1 && h300 != null && prevH300 != null && h300 > prevH300
      return state && ready && stochGolden === true
    }
    // 새 9,10번(스토 2세트, checked=7/7.1) - 둘 다 데드/골든이 이 캔들에 새로 갖춰진 순간(edge)만.
    if (row === 7 || row === 7.1) {
      const s70 = seriesValAt('stoch70Golden', i), s210 = seriesValAt('stoch210Golden', i)
      const prevS70 = seriesValAt('stoch70Golden', i, 1), prevS210 = seriesValAt('stoch210Golden', i, 1)
      const wantGolden = row === 7.1
      const nowBoth = s70 === wantGolden && s210 === wantGolden
      const prevBoth = prevS70 === wantGolden && prevS210 === wantGolden
      return nowBoth && !prevBoth
    }
    return false
  }
  const twSignalSide = (row) => [1, 2, 4, 7, 8, 9, 10, 11, 12, 13].includes(row) ? 'sell' : 'buy' // 내부key 기준 셀 쪽(A,C,E,G,I,K 포함) - 화면 순서는 I,K,A,C,E,G,J,L,B,D,F,H로 재배치됐지만(사용자 요청) 내부key는 그대로
  // 🔍 찾기 버튼 - 체크된 신호가 불러온 구간(dayRows 1~total) 안에서 실제로 "진입"했던 캔들을 전부
  // 훑어서 순서대로 모은다. 결과는 재생 바(빨간 바) 위에 번호로 표시되고, 클릭하면 그 캔들로 이동한다.
  const findSignalPositions = () => {
    const checked = symbol === 'GOLD' ? twGoldChecked : twNasdaqChecked
    if (checked == null || !total) { setTwFoundPositions([]); setFoundMarkerAnchors([]); return }
    const found = []
    for (let i = 1; i <= total; i++) {
      if (isSignalEntryAt(checked, i)) found.push({ idx: i, side: twSignalSide(checked) })
    }
    setTwFoundPositions(found)
    updateFoundMarkerAnchors(found)
  }
  // 재생 바 위 번호랑 완전히 같은 결과를 캔들 위/아래에도 그대로 얹는다(사용자 요청 - "잘 동작하는지
  // 찾아보게"). lightweight-charts 네이티브 마커(createSeriesMarkers)는 markerSeriesRef가 다른 라인
  // 추가/삭제 때마다 통째로 지웠다 다시 만들어지는 구조라(라인 위 배치 유지 목적) 그때마다 마커가
  // 같이 사라져버렸다 - 그래서 timerAnchor(캔들 타이머 배지)와 같은 방식으로, 좌표를 직접 계산해서
  // absolute 오버레이 div로 그린다(20px 간격도 이 방식이라야 정확히 지정 가능 - 사용자 요청).
  // positions 인자를 따로 받을 수 있게 한 이유는 setTwFoundPositions 직후 같은 틱에서 부를 때
  // (findSignalPositions) state/ref가 아직 갱신 전이라 stale할 수 있어서다. 기본값은 ref를 읽는다 -
  // resize/pan/zoom 핸들러는 마운트 시 한 번만 설치되는 클로저라 state를 직접 읽으면 항상 옛날 값에
  // 고정되기 때문(rowsRef/indexRef와 같은 이유).
  const updateFoundMarkerAnchors = (positions = twFoundPositionsRef.current) => {
    const chart = chartRef.current
    const series = seriesRef.current
    if (!chart || !series || positions.length === 0) { setFoundMarkerAnchors([]); return }
    const ts = chart.timeScale()
    const anchors = positions.map((f, n) => {
      const row = rowsRef.current[f.idx - 1]
      if (!row) return null
      const x = ts.timeToCoordinate(row.time)
      const y = f.side === 'sell' ? series.priceToCoordinate(row.high) : series.priceToCoordinate(row.low)
      if (x == null || y == null) return null
      return { n: n + 1, x, y, side: f.side }
    }).filter(Boolean)
    setFoundMarkerAnchors(anchors)
  }

  // 🛑 이평선 따라가기 손절 - 선택된 선의 "끝"(지금 재생 위치의 값)을 좌표로 변환한다(사용자 요청 -
  // timerAnchor와 같은 방식, 화면을 드래그/줌하거나 캔들이 새로 그려질 때마다 다시 계산해야 함).
  // pair 인자는 setTwMaTrailStop 직후 같은 틱에서 부를 때 stale한 ref를 안 읽기 위한 override.
  const maTrailLabels = { h1: '1M-빠른선', s1: '1M-Bol 중심선', h3: '3M-빠른선', h5: '5M-빠른선', w85: '5M-17가중선', center: '5M-중심', don5up: '5D-상단', don5lo: '5D-하단', bbUp: '5분상Bol', bbLo: '5분하Bol', bbUp300: '15분상Bol', bbLo300: '15분하Bol' }
  const updateMaStopAnchor = (pair = twMaTrailStopRef.current) => {
    const chart = chartRef.current
    const series = seriesRef.current
    const S = reservationSeriesRef.current
    const idx = indexRef.current
    if (!chart || !series || !S || !pair || idx <= 0) { setMaStopAnchor(null); return }
    const maKey = { h1: 'h1', s1: 'sma20_1m', h3: 'h3', h5: 'h100', w85: 'wma85', center: 'sma100', don5up: 'donUp5', don5lo: 'donLo5', bbUp: 'bbUp', bbLo: 'bbLo', bbUp300: 'bbUp300', bbLo300: 'bbLo300' }[pair]
    const row = rowsRef.current[idx - 1]
    const val = S[maKey]?.[(idx - 1) + S.offset]
    if (!row || val == null) { setMaStopAnchor(null); return }
    const x = chart.timeScale().timeToCoordinate(row.time)
    const y = series.priceToCoordinate(val)
    if (x == null || y == null) { setMaStopAnchor(null); return }
    // 현재 주가와 손절선의 차이(사용자 요청) - 포인트/달러 둘 다 미리 계산해둔다(표시는 pnlDisplay로 전환).
    const diffPoints = row.close != null ? Math.abs(row.close - val) : null
    const diffDollars = diffPoints != null ? diffPoints * lotSizeRef.current * (POINT_VALUE_PER_LOT[symbolRef.current] || 0) : null
    setMaStopAnchor({ x, y, label: maTrailLabels[pair], diffPoints, diffDollars })
  }

  // 🎯 청산목표 - updateMaStopAnchor와 완전히 같은 방식이지만 대상 선이 다르다. 크로스 방식
  // (s1/h3/h5/w85)은 H1과 짝지어진 그 선 자체를, 터치 방식(center/bbUp/bbLo)은 그 선 그대로 따라간다.
  const exitTargetLineLabels = { s1: 'H1×S1', h3: 'H1×H3', h5: 'H1×H5', w85: 'H1×W85', center: '5분중심', bbUp: '5분상Bol', bbLo: '5분하Bol', w85t: '5M-17가중' }
  const updateExitTargetAnchor = (pair = twExitCrossPairRef.current) => {
    const chart = chartRef.current
    const series = seriesRef.current
    const S = reservationSeriesRef.current
    const idx = indexRef.current
    if (!chart || !series || !S || !pair || idx <= 0) { setExitTargetAnchor(null); return }
    const targetKey = { s1: 'sma20_1m', h3: 'h3', h5: 'h100', w85: 'wma85', center: 'sma100', bbUp: 'bbUp', bbLo: 'bbLo', w85t: 'wma85' }[pair]
    const row = rowsRef.current[idx - 1]
    const val = S[targetKey]?.[(idx - 1) + S.offset]
    if (!row || val == null) { setExitTargetAnchor(null); return }
    const x = chart.timeScale().timeToCoordinate(row.time)
    const y = series.priceToCoordinate(val)
    if (x == null || y == null) { setExitTargetAnchor(null); return }
    // 현재 주가와 청산목표선의 차이(사용자 요청, 손절과 동일) - 포인트/달러 둘 다 미리 계산해둔다.
    const diffPoints = row.close != null ? Math.abs(row.close - val) : null
    const diffDollars = diffPoints != null ? diffPoints * lotSizeRef.current * (POINT_VALUE_PER_LOT[symbolRef.current] || 0) : null
    setExitTargetAnchor({ x, y, label: exitTargetLineLabels[pair], diffPoints, diffDollars })
  }

  // 진입가 표시(사용자 요청) - maStopAnchor/exitTargetAnchor와 완전히 같은 방식. 좌표는 "지금 재생
  // 위치"(x, 계속 따라감) + "각 포지션의 진입가"(y, 고정) 조합이라 포지션마다 하나씩 만든다.
  // positionsRef를 쓰는 이유는 resize/visible-range 핸들러가 마운트 시 한 번만 설치되는 클로저라
  // state를 직접 읽으면 stale하기 때문(다른 anchor 함수들과 동일 패턴).
  const updatePositionAnchors = (posList = positionsRef.current) => {
    const chart = chartRef.current
    const series = seriesRef.current
    const idx = indexRef.current
    const row = rowsRef.current[idx - 1]
    if (!chart || !series || !row || posList.length === 0) { setPositionAnchors([]); return }
    const x = chart.timeScale().timeToCoordinate(row.time)
    if (x == null) { setPositionAnchors([]); return }
    const anchors = posList.map(pos => {
      const y = series.priceToCoordinate(pos.entryPrice)
      if (y == null) return null
      const { points, dollars } = row.close != null ? calcPnl(pos, row.close) : { points: 0, dollars: 0 }
      return { id: pos.id, x, y, side: pos.side, points, dollars }
    }).filter(Boolean)
    setPositionAnchors(anchors)
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
  // 평소(꺼짐)엔 테두리만, active일 땐 안쪽도 색으로 채운다(사용자 요청 - "점멸을 해달라는게 안에
  // 색칠을 해달라는 거였어, 평소에는 테두리만 있다가"). colorB를 주면 twBlinkPhase에 따라 colorA/colorB
  // 배경색을 번갈아 점멸, colorB 없이 colorA만 주면 점멸 없이 고정 채움(1번 신호).
  const TwStatusDot = ({ active, colorA, colorB, label = '상태' }) => {
    const c = active ? (colorB ? (twBlinkPhase ? colorA : colorB) : colorA) : null
    const borderColor = c ? c.border : TW_STATUS_OFF.border
    return (
      <span style={{
        display: 'inline-block', width: 44, textAlign: 'center', fontSize: 9, fontWeight: 700,
        padding: '2px 4px', borderRadius: 4, background: c ? c.bg : 'transparent',
        color: c ? '#fff' : TW_READY_OFF.color, border: `2px solid ${borderColor}`,
      }}>{label}</span>
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

    const h1 = twSeriesVal('h1'), h3 = twSeriesVal('h3'), h100 = twSeriesVal('h100')
    const wma17 = twSeriesVal('wma17_1m'), sma20 = twSeriesVal('sma20_1m')
    const wma85 = twSeriesVal('wma85'), sma100 = twSeriesVal('sma100')
    const wma255 = twSeriesVal('wma255'), sma300 = twSeriesVal('sma300')
    const price = playIndex > 0 ? rowsRef.current[playIndex - 1]?.close ?? null : null
    const candleHigh = playIndex > 0 ? rowsRef.current[playIndex - 1]?.high ?? null : null
    const candleLow = playIndex > 0 ? rowsRef.current[playIndex - 1]?.low ?? null : null
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
    // 3,4번: "슈팅"+"돌파"+"진입" 세 표시등(사용자 정정/추가). 슈팅=고가/저가는 밴드를 뚫었지만
    // 종가는 안쪽에서 마감(꼬리), 돌파=종가가 밴드 밖으로 나간 상태, 진입=그 종가가 다시 밴드
    // 안쪽으로 들어온 상태(row1Armed 방향). 매수매도 버튼은 계속 삭제 상태.
    const row1AboveShooting = candleHigh != null && bbUp != null && price != null && candleHigh > bbUp && price <= bbUp // 3번 슈팅
    const row1BelowShooting = candleLow != null && bbLo != null && price != null && candleLow < bbLo && price >= bbLo // 4번 슈팅
    const row1AboveBreakout = price != null && bbUp != null && price > bbUp // 3번 돌파: 종가가 상단 밖
    const row1BelowBreakout = price != null && bbLo != null && price < bbLo // 4번 돌파: 종가가 하단 밖
    const row1AboveReady = row1Armed === 'above' // 3번 진입: 종가가 상단 안쪽으로 재진입
    const row1BelowReady = row1Armed === 'below' // 4번 진입: 종가가 하단 안쪽으로 재진입
    // 두 줄(\n)로 나눠 보여주던 걸 "4051.58 X 4048.15" 한 줄로(사용자 요청)
    const fmtTopBottom = (fast, slow) => {
      if (fast == null || slow == null) return '-'
      const golden = fast > slow
      const top = golden ? fast : slow, bottom = golden ? slow : fast
      return `${top.toFixed(2)} X ${bottom.toFixed(2)}`
    }

    // 3/4번 라벨 색 - "상승/하락중"(prev 비교) 2개 조건만 빼고 나머지는 그대로 반영한 근사치.
    // 실제 발동 판정(applyIncrement)은 rising/falling까지 포함한 정확한 조건으로 이루어짐.
    const stochGolden = twSeriesVal('stochGolden')
    const row3Buy = wma85 != null && sma100 != null && h1 != null && wma85 > sma100 && stochGolden === true && price != null && price > h1
    const row4Sell = wma85 != null && sma100 != null && h1 != null && wma85 < sma100 && stochGolden === false && price != null && price < h1

    // 새 9,10번(사용자 요청) - 스토(70,15,15)/(210,45,45) 두 세트 상태 표시등. 9번=둘 다 데드, 10번=둘 다 골든(반대).
    const stoch70Golden = twSeriesVal('stoch70Golden')
    const stoch210Golden = twSeriesVal('stoch210Golden')
    const row9State1 = stoch70Golden === false // 9번: 스토(70,15,15) 데드
    const row9State2 = stoch210Golden === false // 9번: 스토(210,45,45) 데드
    const row10State1 = stoch70Golden === true // 10번: 스토(70,15,15) 골든
    const row10State2 = stoch210Golden === true // 10번: 스토(210,45,45) 골든

    // 1,2번 상태만 남김(사용자 요청 - 준비/진입은 삭제)
    const row5State = wma85 != null && sma100 != null && wma85 < sma100 // 1번(내부row4) 상태: WMA85<5분중심
    const row6State = wma85 != null && sma100 != null && wma85 > sma100 // 2번(내부row3) 상태: WMA85>5분중심

    // 새 3,4번(사용자 요청) - HMA300(15분, "HMA15") 방향만 보는 순수 상태 표시(체크박스는 유지하되
    // 버튼/진입 없음, 1,2번과 같은 스타일). 내부 체크/방향 키는 삭제됐던 2/2.1을 재사용.
    const h300 = twSeriesVal('h300'), prevH300 = twSeriesVal('h300', 1)
    // 차트에 이미 있는 HMA300 듀얼컬러 선(DualColorLinePrimitive)의 상승/하락 판정과 완전히 같은 식으로
    // 맞춤(사용자 지적) - 그 쪽은 p1>=p0면 상승색, 아니면 하락색(같으면 상승 쪽으로 침).
    const row2State = h300 != null && prevH300 != null && h300 < prevH300 // 3번 상태: HMA300 하락중
    const row2_1State = h300 != null && prevH300 != null && h300 >= prevH300 // 4번 상태: HMA300 상승중(=차트 상승색과 동일 기준)

    // A/B 카드 아래 C~H 추가(사용자 요청) - 셀 쪽(C,E,G)은 A카드에, 바이 쪽(D,F,H)은 B카드에 쌓이고
    // SELL/BUY 버튼은 각 카드에서 공용으로 쓴다(체크된 행이 무엇이든 그 행 기준으로 발동). 상태만
    // 표시하고 진입(발동)은 그 상태가 이 캔들에 새로 시작되는 순간(edge) - computeReservationEvents의
    // rowC~rowH와 동일한 조건.
    const prevH3 = twSeriesVal('h3', 1), prevH100 = twSeriesVal('h100', 1)
    const rowCState = h1 != null && sma20 != null && h1 < sma20 // A: H1 < S1
    const rowDState = h1 != null && sma20 != null && h1 > sma20 // B: H1 > S1
    const rowEState = h1 != null && h3 != null && h1 < h3 // C: H1 < H3
    const rowFState = h1 != null && h3 != null && h1 > h3 // D: H1 > H3
    const rowGState = h3 != null && h100 != null && h3 < h100 // E: H3 < H5
    const rowHState = h3 != null && h100 != null && h3 > h100 // F: H3 > H5
    // (내부키 11/11.1, 화면 G/H) - W17(WMA17, 1분) vs S1(SMA20)
    const prevWma17 = twSeriesVal('wma17_1m', 1)
    const rowIState = wma17 != null && sma20 != null && wma17 < sma20 // G: W17 < S1
    const rowJState = wma17 != null && sma20 != null && wma17 > sma20 // H: W17 > S1
    // 새 I(12)/J(12.1)(사용자 요청 - A,B 삭제 후 자리를 새로 채움) - H1 vs H15(HMA300)
    const rowH15SellState = h1 != null && h300 != null && h1 < h300 // I: H1 < H15
    const rowH15BuyState = h1 != null && h300 != null && h1 > h300 // J: H1 > H15
    // 새 K(13)/L(13.1)(사용자 요청) - H1 vs W85(WMA85)
    const rowW85SellState = h1 != null && wma85 != null && h1 < wma85 // K: H1 < W85
    const rowW85BuyState = h1 != null && wma85 != null && h1 > wma85 // L: H1 > W85
    const SELL_GROUP = [8, 9, 10, 11, 12, 13]
    const BUY_GROUP = [8.1, 9.1, 10.1, 11.1, 12.1, 13.1]

    // 원본 QHBoxLayout 순서 그대로: [체크박스+라벨] → [상태 표시등] → [SELL/BUY 버튼]
    // disabled(사용자 요청) - 3↔4, 5↔6은 같은 방향성의 반대쌍이라 한쪽이 무장되면 반대쪽은 아예 못
    // 누르게 막는다(그냥 unchecked가 아니라 disabled로 - "3번이 활성이면 4번은 비활성"이라고 명시함).
    // alignItems:center였던 걸 flex-start로 바꿈(사용자 지적 - "필요없는 공간") - 라벨 텍스트가 3줄로
    // 줄바꿈될 때 옆의 표시등/버튼이 그 블록 중앙에 맞춰지면서 위아래로 빈 공간이 생기던 문제.
    const rowDef = (n, label, checked, onCheck, statusEl, sideBtns, disabled) => (
      <div key={n} style={{ display: 'flex', alignItems: 'flex-start', gap: 6, marginBottom: 6, opacity: disabled ? 0.4 : 1 }}>
        <label style={{ margin: 0, display: 'flex', flexDirection: 'column', width: 130, flexShrink: 0, cursor: disabled ? 'not-allowed' : 'pointer', fontSize: 11, fontWeight: 700 }}>
          <span style={{ display: 'flex', alignItems: 'flex-start', gap: 4 }}>
            <input type="checkbox" checked={checked} disabled={disabled} onChange={onCheck} style={{ accentColor: '#4CAF50', marginTop: 2, flexShrink: 0 }} />
            <span style={{ color: label.color, whiteSpace: 'pre-line', lineHeight: 1.3 }}>{label.text}</span>
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
    // 5,6번 표시등 자리에 들어가는 세로형 매도/매수 버튼(사용자 요청) - writingMode로 글자를 세로로
    // 흘려서 좁은 폭(표시등 컬럼과 같은 44px)에 들어가게 한다.
    // disabled는 A카드/B카드에 C,D,E,F,G,H가 추가되면서(사용자 요청, 셀/바이 버튼 공용) 생김 - 그룹
    // 중 아무 것도 체크 안 돼있으면 눌러도 대상이 없으니 비활성화로 표시.
    const dirBtnVertical = (text, active, onClick, isLong, disabled) => (
      <button type="button" onClick={onClick} disabled={disabled} style={{
        width: 44, alignSelf: 'stretch', padding: '4px 2px', fontSize: 11, fontWeight: 700, borderRadius: 5,
        cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.5 : 1,
        color: 'white', border: active ? '3px solid white' : 'none',
        background: active ? (isLong ? TW_LONG_ON : TW_SHORT_ON) : (isLong ? TW_LONG_OFF : TW_SHORT_OFF),
        writingMode: 'vertical-rl', textOrientation: 'mixed',
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

    // 🎯 청산목표 버튼(사용자 요청, twTpExitCross 후속) - 라디오 방식(하나만 선택, 다시 누르면 꺼짐).
    // 벌크 청산 버튼 위/아래 두 자리에 똑같이 보여준다(하나의 공유 상태, 위치만 두 곳). 1번째 줄(S1/H3/
    // H5/W85)은 H1(HMA20)과의 크로스 방식(골든=숏 청산/데드=롱 청산), 2번째 줄(S100 계열+w85t)은 크로스가
    // 아니라 "닿으면"(터치) 방식 - 익절(목표 도달) 방향: SELL은 저가가 닿으면(가격 하락=이익), BUY는
    // 고가가 닿으면(가격 상승=이익) 청산(사용자 확인 - 손절과 정반대 방향). w85t(5M-17가중, 터치)는
    // 기존 w85(크로스, H1×W85)와 별개 옵션으로 추가(사용자 요청) - 2줄로 나눠서 표시.
    const exitCrossOptions = [
      [['s1', 'H1×S1', false], ['h3', 'H1×H3', false], ['h5', 'H1×H5', false], ['w85', 'H1×W85', false]],
      [['center', '5분중심', true], ['bbUp', '5분상Bol', true], ['bbLo', '5분하Bol', true], ['w85t', '5M-17가중', true]],
    ]
    const renderExitCrossButtons = () => (
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 12, fontWeight: 700, color: '#9aa0ab', marginBottom: 4 }}>청산목표</div>
        {exitCrossOptions.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: 6, marginBottom: ri < exitCrossOptions.length - 1 ? 6 : 0 }}>
            {row.map(([id, label, isTouch]) => (
              <button key={id} type="button"
                onClick={() => { const next = twExitCrossPair === id ? null : id; setTwExitCrossPair(next); updateExitTargetAnchor(next) }}
                title={isTouch
                  ? `${label}에 가격이 닿으면(SELL=저가, BUY=고가) 목표 도달로 청산 - 무장 여부와 무관하게 항상 감시`
                  : `H1(HMA20)×${label.split('×')[1]} 골든크로스=숏 청산 / 데드크로스=롱 청산 - 무장 여부와 무관하게 항상 감시`}
                style={{
                  flex: 1, padding: '8px 4px', fontSize: 12, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                  border: '1.5px solid #2196F3',
                  background: twExitCrossPair === id ? 'white' : 'none',
                  color: '#FF5722',
                }}
              >{label}</button>
            ))}
          </div>
        ))}
      </div>
    )

    // 🛑 손절: 이평선 따라가기 버튼(사용자 요청) - 청산 버튼과 완전히 같은 라디오 UI 패턴이지만
    // 헷갈리지 않게 색을 빨강으로 구분하고, 라벨도 "H1×.." 크로스 표기 대신 선 이름만 표시(사용자
    // 설명이 "그 선을 따라간다"는 개념이라 크로스 기호를 쓰면 오해 소지가 있음). 선택한 선을 캔들
    // 고가/저가가 건드리면(사용자 확인) 즉시 손절. center(5M-중심)/don5up·don5lo(5D-상단/하단, 도치안
    // 채널 5분=don100)도 추가(사용자 요청) - 5분상Bol/5분하Bol(bbUp/bbLo, 기존 청산목표에서 쓰던 것과
    // 같은 시리즈)/15분상Bol/15분하Bol(bbUp300/bbLo300, period=300)도 추가돼 12개라 3줄(4+4+4)로 표시.
    const maTrailOptions = [
      [['h1', '1M-빠른선'], ['s1', '1M-Bol 중심선'], ['h3', '3M-빠른선'], ['h5', '5M-빠른선']],
      [['w85', '5M-17가중선'], ['center', '5M-중심'], ['don5up', '5D-상단'], ['don5lo', '5D-하단']],
      [['bbUp', '5분상Bol'], ['bbLo', '5분하Bol'], ['bbUp300', '15분상Bol'], ['bbLo300', '15분하Bol']],
    ]
    const renderMaTrailStopButtons = () => (
      <div style={{ marginBottom: 8 }}>
        <div style={{ fontSize: 11, color: '#9aa0ab', marginBottom: 4 }}>🛑 손절: 이평선 따라가기</div>
        {maTrailOptions.map((row, ri) => (
          <div key={ri} style={{ display: 'flex', gap: 6, marginBottom: ri < maTrailOptions.length - 1 ? 6 : 0 }}>
            {row.map(([id, label]) => (
              <button key={id} type="button"
                onClick={() => { const next = twMaTrailStop === id ? null : id; setTwMaTrailStop(next); updateMaStopAnchor(next) }}
                title={`선택한 이평선(${label})을 계속 추적하다가 캔들 고가/저가가 닿으면 즉시 손절 - 무장 여부와 무관하게 항상 감시`}
                style={{
                  flex: 1, padding: '8px 4px', fontSize: 12, fontWeight: 700, borderRadius: 5, cursor: 'pointer',
                  border: '1.5px solid #F44336',
                  background: twMaTrailStop === id ? 'white' : 'none',
                  color: '#F44336',
                }}
              >{label}</button>
            ))}
          </div>
        ))}
      </div>
    )

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

        {/* 수동 매수/매도 버튼 바로 아래에 벌크 청산 하나 더(사용자 요청) - 아래쪽에 원래 있던 것과
            완전히 같은 함수(closeAllPositionsModal). 원래 버튼엔 disabled가 없는데 여기만 넣었던 게
            불일치였음(사용자 지적) - 똑같이 disabled 없이 항상 눌리게 맞춤. */}
        <button type="button" onClick={closeAllPositionsModal}
          style={{ width: '100%', marginBottom: 8, background: '#FF5722', color: 'white', border: 'none', borderRadius: 5, padding: 10, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}
        >🚨 벌크 청산</button>
        {renderExitCrossButtons()}
        {renderMaTrailStopButtons()}
        {/* 매수매도 버튼을 손절 아래로 이동(사용자 요청) - 원래는 벌크청산 위(맨 위)에 있었음. 크기도
            줄임(사용자 요청 - height 57 → 40). */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, marginBottom: 8, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
          <button type="button" onClick={() => openModalPosition('sell', { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'manual' })}
            disabled={currentPrice == null || !live}
            style={{ flex: 1, height: 40, background: TW_SHORT_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 14, fontWeight: 700, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>SELL 🔴 매도</button>
          <button type="button" onClick={() => openModalPosition('buy', { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'manual' })}
            disabled={currentPrice == null || !live}
            style={{ flex: 1, height: 40, background: TW_LONG_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 14, fontWeight: 700, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>BUY 🟢 매수</button>
        </div>

        <CollapsibleCard title="🎯 반자동 예약" maxWidth="none" defaultOpen={false} headerExtra={(
          /* 🔍 찾기(사용자 요청) - 지금 체크된 신호가 불러온 구간 안에서 실제로 진입했던 캔들을 전부
             찾아 아래 재생 바 위에 순서대로 번호로 표시한다(그 번호를 클릭하면 그 캔들로 이동).
             타이틀 오른쪽으로 옮겨서(사용자 요청) 카드를 안 열어도 바로 찾기를 쓸 수 있게 함. */
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" onClick={findSignalPositions} disabled={!live || checked == null}
              style={{
                background: (!live || checked == null) ? '#37474F' : '#4FC3F7', color: 'white', border: 'none',
                borderRadius: 5, padding: '6px 14px', fontSize: 12.5, fontWeight: 700, width: 'auto', flexShrink: 0,
                cursor: (!live || checked == null) ? 'not-allowed' : 'pointer', opacity: (!live || checked == null) ? 0.5 : 1,
              }}
            >🔍 찾기</button>
            {checked == null && <span style={{ fontSize: 11.5, color: '#9aa0ab' }}>신호를 먼저 체크하세요</span>}
            {twFoundPositions.length > 0 && (
              <>
                <span style={{ fontSize: 12, color: '#9aa0ab' }}>{twFoundPositions.length}개 찾음 (아래 재생 바 위 번호 클릭 시 이동)</span>
                <button type="button" onClick={() => { setTwFoundPositions([]); setFoundMarkerAnchors([]) }}
                  style={{ background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 5, padding: '5px 10px', fontSize: 11.5, cursor: 'pointer', width: 'auto', flexShrink: 0 }}
                >✕ 지우기</button>
              </>
            )}
          </div>
        )}>
          {/* 7,8번(추세)을 맨 위로 올림(사용자 요청) - 내부 checked/dir 키는 안 바꾸고, 화면 순서+라벨
              숫자만 1~8 순번으로 다시 붙였다. 새 순서: 내부row4(하락추세)=1번, 내부row3(상승추세)=2번,
              내부row1(5Bol 상단)=3번, 내부row1.1(5Bol 하단)=4번, 내부row2(주가<H1)=5번,
              내부row2.1(주가>H1)=6번, 내부row6(H1<1분중심)=7번, 내부row5(H1>1분중심)=8번. */}
          {/* 1,2번은 상태만 남기고 준비/진입 표시등 + 매수매도 버튼 삭제(사용자 요청) - 체크박스 자체는
              그대로 둠(🔍 찾기 등에서 여전히 checked를 씀). 1번(하락추세)+3번(15분↓)을 한 카드에
              간격 없이 세로로 붙여 왼쪽에, 2번(상승추세)+4번(15분↑)을 한 카드에 간격 없이 세로로
              붙여 오른쪽에 배치(사용자 요청 - 이전엔 1+3/2+4가 위아래 두 줄로 나뉘어 있었는데,
              그게 아니라 좌우로 나뉘어야 한다는 지적). "버튼 위치 변경"(twSwapped)에 좌우가 뒤바뀐다. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid #2a2e38', borderRadius: 5 }}>
              <label style={{ margin: 0, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', padding: '4px 8px' }}>
                <input type="checkbox" checked={checked === 4} onChange={() => toggleCheck(4)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
                <span style={{ color: row4Sell ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`1번: 하락추세\n5분17선 < 5분20선`}</span>
                <TwStatusDot label="상태" active={row5State} colorA={TW_STATUS_RED_A} />
              </label>
              <label style={{ margin: 0, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', padding: '4px 8px', borderTop: '1px solid #2a2e38' }}>
                <input type="checkbox" checked={checked === 2} onChange={() => toggleCheck(2)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
                <span style={{ color: row2State ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`3번: 15분 빠른선\n하락중`}</span>
                <TwStatusDot label="상태" active={row2State} colorA={TW_STATUS_RED_A} />
              </label>
            </div>
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', border: '1px solid #2a2e38', borderRadius: 5 }}>
              <label style={{ margin: 0, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', padding: '4px 8px' }}>
                <input type="checkbox" checked={checked === 3} onChange={() => toggleCheck(3)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
                <span style={{ color: row3Buy ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`2번: 상승추세\n5분17선 > 5분20선`}</span>
                <TwStatusDot label="상태" active={row6State} colorA={TW_STATUS_LIME_A} />
              </label>
              <label style={{ margin: 0, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', padding: '4px 8px', borderTop: '1px solid #2a2e38' }}>
                <input type="checkbox" checked={checked === 2.1} onChange={() => toggleCheck(2.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
                <span style={{ color: row2_1State ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`4번: 15분 빠른선\n상승중`}</span>
                <TwStatusDot label="상태" active={row2_1State} colorA={TW_STATUS_LIME_A} />
              </label>
            </div>
          </div>
          {/* I/K(내부key 12/13, H1 vs H15/W85)를 맨 위 A/C 자리로 올리고 나머지가 한 칸씩 밀림
              (사용자 요청) - 화면 순서만 바뀌고 내부key/공식은 그대로: A=12(H1<H15), C=13(H1<W85),
              E=8(H1<S1), G=9(H1<H3), I=10(H3<H5), K=11(W17<S1) - 짝수 자리(B/D/F/H/J/L)는 각각의
              매수쪽. 셀/바이 버튼은 카드 안에서 공용으로 쓰고, 체크된 행을 기준으로 발동한다. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
            <div style={{ flex: 1, border: '1px solid #2a2e38', borderRadius: 5, padding: '4px 8px', display: 'flex', gap: 6 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1 }}>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 12} onChange={() => toggleCheck(12)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowH15SellState ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>A: H1 &lt; H15</span>
                  <TwStatusDot label="상태" active={rowH15SellState} colorA={TW_STATUS_RED_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 13} onChange={() => toggleCheck(13)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowW85SellState ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>C: H1 &lt; W85</span>
                  <TwStatusDot label="상태" active={rowW85SellState} colorA={TW_STATUS_RED_A} />
                </label>
                {/* A,C 아래 구분선(사용자 요청) - A/C(H1 vs H15/W85)가 여기로 올라오면서 E~K(원래 A~H)와 구분되게 */}
                <div style={{ height: 1, background: '#333844', margin: '3px 0' }} />
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 8} onChange={() => toggleCheck(8)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowCState ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>E: H1 &lt; S1</span>
                  <TwStatusDot label="상태" active={rowCState} colorA={TW_STATUS_RED_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 9} onChange={() => toggleCheck(9)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowEState ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>G: H1 &lt; H3</span>
                  <TwStatusDot label="상태" active={rowEState} colorA={TW_STATUS_RED_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 10} onChange={() => toggleCheck(10)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowGState ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>I: H3 &lt; H5</span>
                  <TwStatusDot label="상태" active={rowGState} colorA={TW_STATUS_RED_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 11} onChange={() => toggleCheck(11)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowIState ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>K: W17 &lt; S1</span>
                  <TwStatusDot label="상태" active={rowIState} colorA={TW_STATUS_RED_A} />
                </label>
              </div>
              {dirBtnVertical('SELL 🔴 매도', SELL_GROUP.includes(dir?.row), () => { if (SELL_GROUP.includes(checked)) pressDir(checked, 'sell') }, false, !SELL_GROUP.includes(checked))}
            </div>
            <div style={{ flex: 1, border: '1px solid #2a2e38', borderRadius: 5, padding: '4px 8px', display: 'flex', gap: 6 }}>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 0, flex: 1 }}>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 12.1} onChange={() => toggleCheck(12.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowH15BuyState ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>B: H1 &gt; H15</span>
                  <TwStatusDot label="상태" active={rowH15BuyState} colorA={TW_STATUS_LIME_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 13.1} onChange={() => toggleCheck(13.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowW85BuyState ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>D: H1 &gt; W85</span>
                  <TwStatusDot label="상태" active={rowW85BuyState} colorA={TW_STATUS_LIME_A} />
                </label>
                {/* B,D 아래 구분선(사용자 요청) - B/D(H1 vs H15/W85)가 여기로 올라오면서 F~L(원래 B~H)와 구분되게 */}
                <div style={{ height: 1, background: '#333844', margin: '3px 0' }} />
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 8.1} onChange={() => toggleCheck(8.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowDState ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>F: H1 &gt; S1</span>
                  <TwStatusDot label="상태" active={rowDState} colorA={TW_STATUS_LIME_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 9.1} onChange={() => toggleCheck(9.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowFState ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>H: H1 &gt; H3</span>
                  <TwStatusDot label="상태" active={rowFState} colorA={TW_STATUS_LIME_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 10.1} onChange={() => toggleCheck(10.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowHState ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>J: H3 &gt; H5</span>
                  <TwStatusDot label="상태" active={rowHState} colorA={TW_STATUS_LIME_A} />
                </label>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
                  <input type="checkbox" checked={checked === 11.1} onChange={() => toggleCheck(11.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: 0 }} />
                  <span style={{ color: rowJState ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, lineHeight: 1.3, flex: 1 }}>L: W17 &gt; S1</span>
                  <TwStatusDot label="상태" active={rowJState} colorA={TW_STATUS_LIME_A} />
                </label>
              </div>
              {dirBtnVertical('BUY 🟢 매수', BUY_GROUP.includes(dir?.row), () => { if (BUY_GROUP.includes(checked)) pressDir(checked, 'buy') }, true, !BUY_GROUP.includes(checked))}
            </div>
          </div>
          {/* 5,6번 아래에 벌크 청산 버튼 하나 추가(사용자 요청) - 위/아래 두 벌과 완전히 같은 함수. */}
          <button type="button" onClick={closeAllPositionsModal}
            style={{ width: '100%', marginBottom: 6, background: '#FF5722', color: 'white', border: 'none', borderRadius: 5, padding: 10, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}
          >🚨 벌크 청산</button>
          {/* 옛 3,4번(5Bol 돌파)이 7,8번 자리로 밀림(사용자 요청 - 위 5,6번과 위치 맞바꿈) - "돌파"(=예전
              준비)+"진입" 표시등 세로, 왼쪽=7번(상단돌파)/오른쪽=8번(하단돌파) 나란히 배치. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
            <label style={{ margin: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', border: '1px solid #2a2e38', borderRadius: 5, padding: '4px 8px' }}>
              <input type="checkbox" checked={checked === 1} onChange={() => toggleCheck(1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
              <span style={{ color: row1AboveReady ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`5번: \n5분Bol 상단\n돌파후 진입`}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  <TwStatusDot label="슈팅" active={row1AboveShooting} colorA={TW_STATUS_RED_A} />
                  <TwStatusDot label="돌파" active={row1AboveBreakout} colorA={TW_STATUS_RED_A} />
                </div>
                <TwStatusDot label="진입" active={row1AboveReady} colorA={TW_STATUS_RED_A} />
              </div>
            </label>
            <label style={{ margin: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', border: '1px solid #2a2e38', borderRadius: 5, padding: '4px 8px' }}>
              <input type="checkbox" checked={checked === 1.1} onChange={() => toggleCheck(1.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
              <span style={{ color: row1BelowReady ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`6번: \n5분Bol 하단\n돌파후 진입`}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <div style={{ display: 'flex', gap: 2 }}>
                  <TwStatusDot label="슈팅" active={row1BelowShooting} colorA={TW_STATUS_LIME_A} />
                  <TwStatusDot label="돌파" active={row1BelowBreakout} colorA={TW_STATUS_LIME_A} />
                </div>
                <TwStatusDot label="진입" active={row1BelowReady} colorA={TW_STATUS_LIME_A} />
              </div>
            </label>
          </div>
          {/* 새 9,10번(사용자 요청) - 스토캐스틱 2세트(70,15,15 / 210,45,45) 상태만, 9번=둘 다 데드,
              10번=둘 다 골든(반대). 내부 체크 키는 새로 7/7.1 씀. twSwapped에 좌우 같이 뒤바뀜. */}
          <div style={{ display: 'flex', gap: 8, marginBottom: 6, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
            <label style={{ margin: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', border: '1px solid #2a2e38', borderRadius: 5, padding: '4px 8px' }}>
              <input type="checkbox" checked={checked === 7} onChange={() => toggleCheck(7)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
              <span style={{ color: (row9State1 && row9State2) ? TW_TEXT_RED : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`7번: 스토 데드크로스\n5분스토 (70,15,15)\n15분스토(210,45,45)`}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TwStatusDot label="70" active={row9State1} colorA={TW_STATUS_RED_A} />
                <TwStatusDot label="210" active={row9State2} colorA={TW_STATUS_RED_A} />
              </div>
            </label>
            <label style={{ margin: 0, flex: 1, display: 'flex', alignItems: 'flex-start', gap: 6, cursor: 'pointer', border: '1px solid #2a2e38', borderRadius: 5, padding: '4px 8px' }}>
              <input type="checkbox" checked={checked === 7.1} onChange={() => toggleCheck(7.1)} style={{ accentColor: '#4CAF50', flexShrink: 0, margin: '2px 0 0 0' }} />
              <span style={{ color: (row10State1 && row10State2) ? TW_TEXT_LIME : TW_TEXT_GRAY, fontSize: 11, fontWeight: 700, whiteSpace: 'pre-line', lineHeight: 1.3, flex: 1 }}>{`8번: 스토 골든크로스\n5분스토 (70,15,15)\n15분스토(210,45,45)`}</span>
              <div style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                <TwStatusDot label="70" active={row10State1} colorA={TW_STATUS_LIME_A} />
                <TwStatusDot label="210" active={row10State2} colorA={TW_STATUS_LIME_A} />
              </div>
            </label>
          </div>
        </CollapsibleCard>

        {/* 하단 청산목표 위에 상단과 동일한 수동 매수/매도 버튼 추가(사용자 요청) - 위쪽 것과 완전히
            같은 함수/옵션(twSwapped 좌우 순서도 같이 따름). 크기도 위쪽과 동일하게 줄임(사용자 요청,
            height 57 → 40). */}
        <div style={{ display: 'flex', gap: 6, marginTop: 10, marginBottom: 8, flexDirection: twSwapped ? 'row-reverse' : 'row' }}>
          <button type="button" onClick={() => openModalPosition('sell', { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'manual' })}
            disabled={currentPrice == null || !live}
            style={{ flex: 1, height: 40, background: TW_SHORT_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 14, fontWeight: 700, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>SELL 🔴 매도</button>
          <button type="button" onClick={() => openModalPosition('buy', { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'manual' })}
            disabled={currentPrice == null || !live}
            style={{ flex: 1, height: 40, background: TW_LONG_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 14, fontWeight: 700, cursor: live ? 'pointer' : 'not-allowed', opacity: live ? 1 : 0.5 }}>BUY 🟢 매수</button>
        </div>

        <div style={{ marginTop: 10 }}>{renderExitCrossButtons()}{renderMaTrailStopButtons()}</div>
        <button type="button" onClick={closeAllPositionsModal} style={{ width: '100%', background: '#FF5722', color: 'white', border: 'none', borderRadius: 5, padding: 10, fontSize: 13.5, fontWeight: 700, cursor: 'pointer' }}>{bulkLabel}</button>

        {/* 벌크 청산 버튼 아래로 이동(사용자 요청) - 원래는 반자동 예약 카드 바로 아래에 있었음 */}
        <div style={{ marginTop: 8 }}>
          <CollapsibleCard title="📋 신호 설명" maxWidth="none" defaultOpen={false}>
            <div style={{ fontSize: 11.5, color: '#c8ccd4', lineHeight: 1.6, whiteSpace: 'pre-line' }}>
              {/* 라벨 번호를 위 반자동 예약 카드와 똑같이 화면 위치 기준 1~8 순번으로 다시 붙였다
                  (사용자 요청). 새 3,4번(HMA300 방향) 추가, 옛 3,4번(5Bol)→5,6번, 옛 5,6번→7,8번(조건도
                  전면 교체: 주가 vs H1 상태 + 주가 자체가 S1을 크로스). */}
              {[
                checked === 4 && '1번: 하락추세\n   상태 - WMA85<5분중심',
                checked === 3 && '2번: 상승추세\n   상태 - WMA85>5분중심',
                checked === 2 && '3번: HMA15(HMA300) 하락중\n   상태 - HMA300이 직전 캔들보다 하락중',
                checked === 2.1 && '4번: HMA15(HMA300) 상승중\n   상태 - HMA300이 직전 캔들보다 상승중',
                checked === 12 && 'A: H1 < H15 (매도 전용)\n   상태 - H1이 H15(HMA300)보다 낮음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 12.1 && 'B: H1 > H15 (매수 전용)\n   상태 - H1이 H15(HMA300)보다 높음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 13 && 'C: H1 < W85 (매도 전용)\n   상태 - H1이 W85(WMA85)보다 낮음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 13.1 && 'D: H1 > W85 (매수 전용)\n   상태 - H1이 W85(WMA85)보다 높음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 8 && 'E: H1 < S1 (매도 전용)\n   상태 - H1이 S1(SMA20)보다 낮음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 8.1 && 'F: H1 > S1 (매수 전용)\n   상태 - H1이 S1(SMA20)보다 높음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 9 && 'G: H1 < H3 (매도 전용)\n   상태 - H1이 H3보다 낮음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 9.1 && 'H: H1 > H3 (매수 전용)\n   상태 - H1이 H3보다 높음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 10 && 'I: H3 < H5 (매도 전용)\n   상태 - H3이 H5(HMA100)보다 낮음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 10.1 && 'J: H3 > H5 (매수 전용)\n   상태 - H3이 H5(HMA100)보다 높음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 11 && 'K: W17 < S1 (매도 전용)\n   상태 - W17(WMA17)이 S1(SMA20)보다 낮음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 11.1 && 'L: W17 > S1 (매수 전용)\n   상태 - W17(WMA17)이 S1(SMA20)보다 높음\n   진입 - 이 상태가 새로 시작되는 순간',
                checked === 1 && '5번: 5Bol 상단 돌파\n   슈팅 - 5분볼린저(SMA100 볼린저) 상단을 고가가 뚫었지만 꼬리 달고 종가는 안쪽에서 마감\n   돌파 - 5분볼린저 상단을 캔들 종가가 나감\n   진입 - 5분볼린저 상단을 종가까지 들어옴',
                checked === 1.1 && '6번: 5Bol 하단 돌파\n   슈팅 - 5분볼린저(SMA100 볼린저) 하단을 저가가 뚫었지만 꼬리 달고 종가는 안쪽에서 마감\n   돌파 - 5분볼린저 하단을 캔들 종가가 나감\n   진입 - 5분볼린저 하단을 종가까지 들어옴',
                checked === 7 && '7번: 스토 데드크로스\n   상태 - 스토캐스틱(70,15,15) 데드 & 스토캐스틱(210,45,45) 데드',
                checked === 7.1 && '8번: 스토 골든크로스\n   상태 - 스토캐스틱(70,15,15) 골든 & 스토캐스틱(210,45,45) 골든',
              ].filter(Boolean).join('\n\n') || '체크된 신호가 없습니다'}
            </div>
          </CollapsibleCard>
        </div>

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
        <button type="button" onClick={() => openModalPosition('sell', { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'strategy1' })}
          disabled={currentPrice == null}
          style={{ flex: 1, padding: 20, background: TW_SHORT_OFF, color: 'white', border: 'none', borderRadius: 5, fontSize: 16, fontWeight: 700, cursor: 'pointer' }}>SELL<br />🔴 매도</button>
        <button type="button" onClick={() => openModalPosition('buy', { lot: lotSize, slPoints: twUseSl ? twSl : 0, tpPoints: twUseTp ? twTp : 0, tag: 'strategy1' })}
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
            <input type="number" step={0.01} min={0.01} value={lotSize} onChange={e => setLotSize(Math.max(0.01, Number(e.target.value) || 0.01))}
              style={{ width: 80, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '4px 6px', fontSize: 12.5 }} />
            <span />
            <span style={{ color: '#9aa0ab' }}>손절(포인트):</span>
            <input type="number" min={1} value={twSl} disabled={!twUseSl} onChange={e => setTwSl(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 80, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '4px 6px', fontSize: 12.5, opacity: twUseSl ? 1 : 0.5 }} />
            <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4, color: '#4CAF50', fontWeight: 700, fontSize: 11.5 }}>
              <input type="checkbox" checked={twUseSl} onChange={e => setTwUseSl(e.target.checked)} /> 사용
            </label>
            <span style={{ color: '#9aa0ab' }}>익절(포인트):</span>
            <input type="number" min={1} value={twTp} disabled={!twUseTp} onChange={e => setTwTp(Math.max(1, Number(e.target.value) || 1))}
              style={{ width: 80, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '4px 6px', fontSize: 12.5, opacity: twUseTp ? 1 : 0.5 }} />
            <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 4, color: '#4CAF50', fontWeight: 700, fontSize: 11.5 }}>
              <input type="checkbox" checked={twUseTp} onChange={e => setTwUseTp(e.target.checked)} /> 사용
            </label>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 10, flexWrap: 'wrap' }}>
          <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, color: '#FF9800', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={twSkipPopup} onChange={e => setTwSkipPopup(e.target.checked)} /> 팝업 확인 제외 (빠른 거래)
          </label>
          {/* 반자동 신호를 차트 아래에 "N 롱 / M 셀"로 표시(사용자 요청, 기본 체크) */}
          <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 8, color: '#4CAF50', fontWeight: 700, fontSize: 12, cursor: 'pointer' }}>
            <input type="checkbox" checked={showSemiAutoSignalOnChart} onChange={e => setShowSemiAutoSignalOnChart(e.target.checked)} /> 반자동 신호 차트 표시
          </label>
        </div>

        <div style={{ display: 'flex', gap: 4, marginBottom: 10 }}>
          {[['strategy1', '매매1'], ['gold', '골드'], ['nasdaq', '나스닥']].map(([id, label]) => (
            <button key={id} type="button" onClick={() => {
              setTwTab(id)
              // 골드/나스닥 탭을 선택하면 랏수/손절/익절도 그 심볼 기본값으로 바뀐다(사용자 요청 - "탭을
              // 나스닥 선택했을 때만 나스닥, 골드를 선택했을 때는 골드 셋팅으로 바뀌어야 함"). 매매1 탭은 해당 없음.
              if (DEFAULT_TW_LOTS[id] != null) setLotSize(DEFAULT_TW_LOTS[id])
              if (DEFAULT_TW_SL[id] != null) setTwSl(DEFAULT_TW_SL[id])
              if (DEFAULT_TW_TP[id] != null) setTwTp(DEFAULT_TW_TP[id])
              // 탭이 대상으로 하는 심볼과 실제 로드된 차트 데이터(symbol)가 다르면 live가 false가 되어
              // 수동 SELL/BUY 버튼이 비활성화됐다(가격 기준이 없어서) - 탭을 누르면 차트도 그 심볼로
              // 같이 전환해서 항상 활성화되게 한다(사용자 요청). 매매1 탭은 심볼 전용이 아니라 해당 없음.
              if (id === 'gold') setSymbol('GOLD')
              if (id === 'nasdaq') setSymbol('NASDAQ')
            }} style={{
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

  // 실제 매매(MT5 실주문) 사용법 안내 모달 - 정보 표시용이라 드래그/리사이즈 없이 단순 중앙 오버레이로 충분함.
  const renderTradeGuideModal = () => (
    <div
      onClick={() => setShowTradeGuideModal(false)}
      style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 2000, display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 20 }}
    >
      <div
        onClick={e => e.stopPropagation()}
        style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 24, maxWidth: 560, maxHeight: '85vh', overflowY: 'auto', color: '#e8eaed' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
          <div style={{ fontSize: 16, fontWeight: 800 }}>이지트레이더 차트로 MT5 실제 매매하는 방법</div>
          <button type="button" onClick={() => setShowTradeGuideModal(false)} style={{ background: 'none', border: 'none', color: '#9aa0ab', fontSize: 18, cursor: 'pointer', lineHeight: 1 }}>✕</button>
        </div>

        <div style={{ fontSize: 13, lineHeight: 1.9 }}>
          <div style={{ fontWeight: 700, color: '#4CAF50', marginBottom: 4 }}>① MT5에 EA 붙이기</div>
          <ol style={{ paddingLeft: 20, margin: '0 0 14px', color: '#c8ccd4' }}>
            <li>MT5를 열고 매매할 계좌(데모 또는 실계좌)로 로그인</li>
            <li>매매할 종목 차트를 열기 (골드=XAUUSD+, 나스닥=NAS100 등)</li>
            <li>탐색기에서 <b>EasyTrade_LivePriceSender</b>를 그 차트 위로 드래그</li>
            <li>설정창에서 <b>EnableRealTrading</b>을 true로 체크</li>
            <li><b>AccountLabel</b>에 나만 아는 이름을 정해서 입력 (예: my_gold_01) — <span style={{ color: '#F44336' }}>이 값이 곧 비밀번호 역할이라 남에게 알려주면 안 됨</span></li>
            <li><b>MaxLotSize</b>를 이 계좌에서 허용할 최대 랏수로 설정</li>
            <li>확인 → 상단 툴바의 "자동매매(AutoTrading)"가 켜져 있는지 확인(초록불)</li>
          </ol>

          <div style={{ fontWeight: 700, color: '#4CAF50', marginBottom: 4 }}>② 웹에서 주문 보내기</div>
          <ol style={{ paddingLeft: 20, margin: '0 0 14px', color: '#c8ccd4' }}>
            <li>이 라이브 페이지에서 매매할 심볼(골드/나스닥) 선택</li>
            <li>왼쪽의 "🔴 실제 매매" 체크박스 켜기 — 경고 문구가 뜸</li>
            <li>아래 나타난 "🔴 실주문" 카드의 계좌 라벨 칸에 ①에서 정한 값을 <b>정확히 똑같이</b> 입력</li>
            <li>랏수 정하고 실매수 / 실매도 / 전체 청산 버튼 클릭 → 확인창에서 한 번 더 확인</li>
            <li>몇 초 안에 MT5에서 실제로 체결되고, 카드 하단에 처리 결과(체결/실패)가 표시됨</li>
          </ol>

          <div style={{ background: 'rgba(244,67,54,0.1)', border: '1px solid #F44336', borderRadius: 8, padding: '10px 12px', color: '#F44336', fontSize: 12, lineHeight: 1.7 }}>
            ⚠ 실제 돈이 움직이는 기능입니다. 처음엔 반드시 <b>데모 계좌</b>로 충분히 테스트한 뒤 실계좌에 연결하세요.
            계좌 라벨은 그 자체가 비밀번호이니 남과 공유하지 마세요.
          </div>
        </div>
      </div>
    </div>
  )

  // 페이지 안 모달 - 드래그로 위치 이동 + 우측 하단 모서리로 좌우/상하 크기 조절(CSS resize) 가능.
  const renderTwEmbedded = () => (
    <div style={{
      position: 'fixed', left: twPos.x, top: twPos.y, width: 460, height: 700, // width 400→460(사용자 요청, 조금 더 넓게)
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

  // 매매진입 현황 패널 - 분리매매창(renderTwEmbedded)과 완전히 같은 구조(드래그 헤더 + fixed + resize +
  // document.body 포탈로 항상 최상단)로 뗀 떠다니는 패널(사용자 요청).
  // 매매진입 현황 내용물 - 인라인 패널/새 창 팝업 둘 다 이 함수 하나를 공유한다(분리매매창의 renderTwInner와
  // 같은 패턴, 사용자 요청으로 새 창 지원 추가하면서 중복 방지를 위해 뽑아냄).
  const renderPosInner = () => (
    <>
      {/* 진입 랏수/손절/목표 설정값 / 보유 포지션 개수를 맨 위에 요약(사용자 요청) - 지금 몇 랏으로
          진입되는지, 손절/목표가 몇 포인트로 잡혀있는지(분리매매창 twSl/twTp와 동일한 설정), 포지션이
          몇 개 열려있는지 버튼 누르기 전에 바로 보이게. */}
      <div style={{ display: 'flex', gap: 12, marginBottom: 4, fontSize: 12, color: '#9aa0ab', flexWrap: 'wrap' }}>
        <span>진입 랏수 <b style={{ color: '#e8eaed' }}>{lotSize}</b></span>
        <span>포지션 <b style={{ color: positions.length > 0 ? '#4CAF50' : '#e8eaed' }}>{positions.length}</b>개</span>
      </div>
      <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 12, color: '#9aa0ab', flexWrap: 'wrap' }}>
        <span>손절 <b style={{ color: twUseSl ? '#F44336' : '#5a5f6a' }}>{twUseSl ? `${twSl}pt` : '미사용'}</b></span>
        <span>목표 <b style={{ color: twUseTp ? '#4CAF50' : '#5a5f6a' }}>{twUseTp ? `${twTp}pt` : '미사용'}</b></span>
      </div>
      {/* BUY/SELL도 여기서 바로(사용자 요청) - 메인 차트의 openPosition/lotSize 그대로 재사용 */}
      <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
        <button
          type="button" onClick={() => openPosition('buy')} disabled={currentPrice == null}
          style={{
            flex: 1, width: 'auto', background: '#26a69a', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700,
            padding: '9px 0', fontSize: 13, cursor: currentPrice == null ? 'not-allowed' : 'pointer', opacity: currentPrice == null ? 0.5 : 1,
          }}
        >BUY</button>
        <button
          type="button" onClick={() => openPosition('sell')} disabled={currentPrice == null}
          style={{
            flex: 1, width: 'auto', background: '#ef5350', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700,
            padding: '9px 0', fontSize: 13, cursor: currentPrice == null ? 'not-allowed' : 'pointer', opacity: currentPrice == null ? 0.5 : 1,
          }}
        >SELL</button>
      </div>
      {/* 포지션이 여러 개일 때 맨 위에 전체 합계(사용자 요청) */}
      {positions.length > 1 && (() => {
        const totalDollars = positions.reduce((sum, pos) => sum + (currentPrice != null ? calcPnl(pos, currentPrice).dollars : 0), 0)
        const totalPoints = positions.reduce((sum, pos) => sum + (currentPrice != null ? calcPnl(pos, currentPrice).points : 0), 0)
        return (
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0 10px', marginBottom: 6, borderBottom: '1px solid #2a2e38', whiteSpace: 'nowrap' }}>
            <span style={{ fontWeight: 700 }}>합계</span>
            <span style={{ color: totalDollars >= 0 ? '#26a69a' : '#ef5350', fontWeight: 700, marginLeft: 'auto' }}>
              {currentPrice == null ? '—' : pnlDisplay === 'dollar'
                ? `${totalDollars >= 0 ? '+' : ''}$${totalDollars.toFixed(2)}`
                : `${totalPoints >= 0 ? '+' : ''}${totalPoints.toFixed(2)}pt`}
            </span>
            {/* 합계 옆에도 벌크 청산 바로가기(사용자 요청) - 아래 목록 끝에 있는 것과 완전히 같은 함수.
                disabled 없음(사용자 지적 - 다른 벌크청산 버튼들과 일관되게 항상 눌리게) */}
            <button
              type="button" onClick={closeAllPositionsModal}
              style={{
                width: 'auto', flexShrink: 0, fontSize: 11, padding: '5px 10px', borderRadius: 6, border: 'none',
                background: '#FF5722', color: '#fff', fontWeight: 700, cursor: 'pointer',
              }}
            >🚨 벌크 청산</button>
          </div>
        )
      })()}
      {positions.length === 0 ? (
        <div style={{ fontSize: 12.5, color: '#5a5f6a' }}>보유 중인 포지션이 없습니다</div>
      ) : (
        positions.map(pos => {
          const { points, dollars } = currentPrice != null ? calcPnl(pos, currentPrice) : { points: 0, dollars: 0 }
          const profit = dollars >= 0
          return (
            <div key={pos.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid #2a2e38', whiteSpace: 'nowrap' }}>
              <span style={{ color: pos.side === 'buy' ? '#26a69a' : '#ef5350', fontWeight: 700, width: 36, flexShrink: 0 }}>
                {pos.side === 'buy' ? 'BUY' : 'SELL'}
              </span>
              <span style={{ color: '#9aa0ab', flexShrink: 0 }}>{pos.lot.toFixed(2)}랏</span>
              <span style={{ color: '#9aa0ab', flexShrink: 0 }}>진입 {pos.entryPrice.toFixed(2)}</span>
              <span style={{ color: profit ? '#26a69a' : '#ef5350', fontWeight: 700, marginLeft: 'auto', flexShrink: 0 }}>
                {currentPrice == null ? '—' : pnlDisplay === 'dollar'
                  ? `${profit ? '+' : ''}$${dollars.toFixed(2)}`
                  : `${points >= 0 ? '+' : ''}${points.toFixed(2)}pt`}
              </span>
              <button
                type="button" onClick={() => closePosition(pos.id)}
                style={{ width: 'auto', flexShrink: 0, fontSize: 11, padding: '4px 10px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', cursor: 'pointer' }}
              >청산</button>
            </div>
          )
        })
      )}
      <button
        type="button" onClick={closeAllPositionsModal}
        style={{ width: '100%', marginTop: 10, background: '#FF5722', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, padding: '9px 16px', fontSize: 13, cursor: 'pointer' }}
      >🚨 벌크 청산</button>
    </>
  )

  const renderPositionPanel = () => (
    <div style={{
      position: 'fixed', left: posPanelPos.x, top: posPanelPos.y, width: 360, height: 400,
      minWidth: 280, minHeight: 200, maxWidth: '92vw', maxHeight: '92vh',
      resize: 'both', overflow: 'auto',
      background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, boxShadow: '0 12px 40px rgba(0,0,0,0.5)',
      zIndex: 1000, fontSize: 13,
    }}>
      <div onMouseDown={onPosPanelHeaderMouseDown} style={{
        position: 'sticky', top: 0, display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 10, padding: '10px 14px',
        background: '#171a21', borderBottom: '1px solid #2a2e38', cursor: 'move', userSelect: 'none', zIndex: 1,
      }}>
        {/* site.css의 전역 button{width:100%} 규칙이 .bt-page 밖(document.body 포탈)에선 안 걸러져서
            버튼이 제멋대로 커지던 문제(사용자 지적) - width:'auto'로 직접 눌러준다. 제목도 줄바꿈되던
            문제(사용자 지적) - whiteSpace:nowrap. */}
        <span style={{ fontWeight: 700, fontSize: 13.5, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>매매진입 현황 {positions.length > 0 && `(${positions.length})`}</span>
        <span style={{ display: 'flex', gap: 8, flexShrink: 0 }}>
          {/* 분리매매창과 동일하게 진짜 새 창으로도 뺄 수 있게(사용자 요청) */}
          <button type="button" onClick={openPosPopup} title="진짜 새 창으로 분리해서 열기 (크기 자유 조절, 리플레이와 계속 연동됨)"
            style={{ background: 'none', border: 'none', color: '#9aa0ab', fontSize: 14, cursor: 'pointer', lineHeight: 1, padding: 0 }}>🗗</button>
          {/* 닫기 버튼을 "🔗"만으론 뭘 하는 건지 알기 어려워서(사용자 지적) X박스 형태로 눈에 띄게 바꿈.
              기능은 그대로 - 이 패널엔 "완전히 숨김" 상태가 없어서 닫으면 곧 원래 자리(인라인)로 돌아간다. */}
          <button type="button" onClick={() => setPositionPanelFloating(false)} title="닫기 (원래 자리로 돌아감)"
            style={{
              width: 22, height: 22, flexShrink: 0, display: 'flex', alignItems: 'center', justifyContent: 'center',
              background: '#2a2e38', border: '1px solid #3a3f4a', borderRadius: 5, color: '#e8eaed', fontSize: 13,
              cursor: 'pointer', lineHeight: 1, padding: 0,
            }}>✕</button>
        </span>
      </div>
      <div style={{ padding: 14, overflowX: 'auto' }}>{renderPosInner()}</div>
    </div>
  )

  // 새 창(팝업) - 분리매매창의 renderTwPopupContent와 완전히 같은 패턴.
  const renderPosPopupContent = () => (
    <div style={{ padding: 14, color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif', fontSize: 13 }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 14, marginBottom: 8 }}>
        <span style={{ fontWeight: 700 }}>매매진입 현황 {positions.length > 0 && `(${positions.length})`}</span>
        <span style={{ display: 'flex', gap: 10 }}>
          <button type="button" onClick={closePosPopup} title="이 창을 닫고 페이지 안 패널로 다시 붙이기"
            style={{ background: 'none', border: '1px solid #2a2e38', borderRadius: 7, color: '#9aa0ab', fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>🔗 페이지에 다시 붙이기</button>
          <button type="button" onClick={() => { closePosPopup(); setPositionPanelFloating(false) }}
            style={{ background: 'none', border: '1px solid #2a2e38', borderRadius: 7, color: '#9aa0ab', fontSize: 12, padding: '5px 10px', cursor: 'pointer' }}>✕ 닫기</button>
        </span>
      </div>
      {renderPosInner()}
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
      <Head><title>실시간 차트 — EasyTrade</title></Head>
      <div className="bt-page" style={{ minHeight: '100vh', background: '#0f1115', color: '#e8eaed', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
        <style>{`
          /* styles/site.css의 전역 button { width:100%; margin-top:20px }이
             재생/속도 버튼들을 세로로 늘려버리는 문제를 이 페이지 안에서만 되돌린다. */
          .bt-page button { width: auto; margin-top: 0; }
        `}</style>
        <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '18px 28px', borderBottom: '1px solid #2a2e38' }}>
          <BrandLogo label="라이브" />
          <nav style={{ display: 'flex', gap: 6 }}>
            <Link href="/backtest-chart" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>학습</Link>
            <Link href="/backtest-intraday" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>📈 일중 패턴</Link>
            <Link href="/replay" style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, color: '#9aa0ab', border: '1px solid #2a2e38', textDecoration: 'none' }}>🔁 리플레이</Link>
            <span style={{ padding: '7px 14px', borderRadius: 8, fontSize: 13, fontWeight: 700, background: 'rgba(76,175,80,0.15)', color: '#4CAF50', border: '1px solid #4CAF50' }}>🔴 라이브</span>
          </nav>
        </header>

        <main style={{ maxWidth: 1500, margin: '0 auto', padding: '28px 20px 60px' }}>
          <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 6 }}>실시간 차트</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginBottom: 24 }}>MT5에 붙여둔 EA가 보내는 시세를 그대로 이어서 보여드려요. 지금은 1분(M1) 캔들만 지원해요.</p>

          <div style={{ display: 'flex', gap: 20, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            {/* 왼쪽 컬럼: 심볼버튼 / 지표 설정 카드들이 서로 붙어서 쌓인다 (오른쪽 차트 높이랑 무관하게) */}
            <div style={{ width: sidebarCollapsed ? 28 : 170, display: 'flex', flexDirection: 'column', gap: 12, flexShrink: 0 }}>
              <button
                type="button" onClick={() => setSidebarCollapsed(v => !v)}
                title={sidebarCollapsed ? '왼쪽 패널 펼치기' : '왼쪽 패널 접기'}
                style={{
                  width: '100%', background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '7px 0', fontSize: 12.5, fontWeight: 700, cursor: 'pointer',
                }}
              >{sidebarCollapsed ? '▶' : '◀ 접기'}</button>
              {!sidebarCollapsed && (
              <>
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

              {/* 실제 매매(실주문) 마스터 스위치 - 기본 꺼짐, 체크해야 하단의 "🔴 실주문" 카드가 나타나고
                  경고 문구도 뜬다(사용자 요청 - 실수로 그 카드를 건드릴 일이 없게 기본적으로 숨겨둠). */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: realTradingUnlocked ? '#F44336' : '#9aa0ab', cursor: 'pointer', fontWeight: realTradingUnlocked ? 700 : 400 }}>
                  <input type="checkbox" checked={realTradingUnlocked} onChange={e => setRealTradingUnlocked(e.target.checked)} />
                  🔴 실제 매매
                </label>
                <button
                  type="button" onClick={() => setShowTradeGuideModal(true)}
                  title="MT5 실제 매매 사용법 보기"
                  style={{ fontSize: 11, padding: '2px 8px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', cursor: 'pointer' }}
                >❓ 사용법</button>
              </div>
              {/* 연결 방식 설명(사용자 요청) - 서버가 계좌에 로그인하는 게 아니라 이용자 본인 PC의 MT5가
                  직접 주문을 내는 구조라는 걸 오해 없이 먼저 알려준다. 항상 보이게(체크 여부와 무관). */}
              <div style={{ fontSize: 10.5, color: '#6b7280', lineHeight: 1.6 }}>
                ℹ 이 기능은 본인 PC의 MT5 계좌에 직접 로그인되어 있어야 동작을 합니다.<br />
                그 어떤 계좌도 비번도 입력을 받지 않습니다.<br />
                사용자가 MT5에 로그인을 해둔 계좌에 주문을 전달할 뿐입니다.
              </div>
              {realTradingUnlocked && (
                <div style={{ background: 'rgba(244,67,54,0.1)', border: '1px solid #F44336', borderRadius: 8, padding: '8px 10px', fontSize: 11, color: '#F44336', lineHeight: 1.5 }}>
                  ⚠ 이제부터 아래 "실주문" 카드에서 누르는 매수/매도는 시뮬레이션이 아니라 MT5에 연결된
                  실제 계좌에 진짜 주문이 나갑니다. 실제 돈이 움직이니 계좌 라벨과 랏수를 꼭 확인하세요.
                </div>
              )}

              {/* 라이브 페이지는 재생할 과거 구간이 없어서(사용자 요청) 달력/매매내역 업로드 카드를
                  뺐다 - 둘 다 "날짜를 골라 그 구간을 불러온다"는 재생 전제 기능이라 실시간 모드랑 안 맞음. */}

              <CollapsibleCard title="횡보" maxWidth={170} defaultOpen={false}>
                <div style={{ padding: '1px 0' }}>
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                      <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                      <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                      <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                      <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={ribbonEnabled}
                      onChange={toggleRibbon}
                      style={{ width: 13, height: 13, margin: 0, accentColor: RIBBON_LIME, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>리본</span>
                  </label>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                    <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
                      상승
                      <input
                        type="color"
                        value={getDualUpColor('madrid05')}
                        onChange={e => setRibbonUpColor(e.target.value)}
                        title="상승 구간 색상(리본 18개 전체 적용)"
                        style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                      />
                    </label>
                    <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 3, cursor: 'pointer' }}>
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

              <CollapsibleCard title="RSI/MACD" maxWidth={170} defaultOpen={false}>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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

              <CollapsibleCard title="스토캐스틱" maxWidth={170} defaultOpen={false}>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
                      <label style={{ margin: '4px 0 0', marginLeft: 19, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#9aa0ab', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={stoch3CrossEnabled}
                          onChange={toggleStoch3Cross}
                          style={{ width: 12, height: 12, margin: 0, accentColor: stoch3KColor, flexShrink: 0 }}
                        />
                        <span style={{ flex: 1 }}>K/D 크로스 세로줄(상승=%K, 하락=%D)</span>
                      </label>
                      {stoch3CrossEnabled && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                          <span>투명도</span>
                          <input
                            type="number" min={10} max={100} step={5}
                            value={Math.round(stoch3CrossOpacity * 100)}
                            onChange={e => setStoch3CrossOpacity(Math.min(100, Math.max(10, Number(e.target.value) || 0)) / 100)}
                            style={{ width: 36, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                          />
                          <span>%</span>
                        </div>
                      )}
                    </>
                  )}
                </div>
                <div style={{ padding: '3px 0' }}>
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
                    <input
                      type="checkbox"
                      checked={enabledStoch4}
                      onChange={toggleStoch4}
                      style={{ width: 13, height: 13, margin: 0, accentColor: stoch4KColor, flexShrink: 0 }}
                    />
                    <span style={{ flex: 1 }}>스토(210,45,45)</span>
                  </label>
                  {enabledStoch4 && (
                    <>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                        <span>%K</span>
                        <input
                          type="color" value={stoch4KColor} onChange={e => setStoch4KColor(e.target.value)}
                          title="%K선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                        />
                        <span>%D</span>
                        <input
                          type="color" value={stoch4DColor} onChange={e => setStoch4DColor(e.target.value)}
                          title="%D선 색상" style={{ width: 16, height: 16, padding: 0, border: 'none', background: 'none', cursor: 'pointer' }}
                        />
                      </div>
                      <label style={{ margin: '4px 0 0', marginLeft: 19, display: 'flex', alignItems: 'center', gap: 6, fontSize: 10, color: '#9aa0ab', cursor: 'pointer' }}>
                        <input
                          type="checkbox"
                          checked={stoch4CrossEnabled}
                          onChange={toggleStoch4Cross}
                          style={{ width: 12, height: 12, margin: 0, accentColor: stoch4KColor, flexShrink: 0 }}
                        />
                        <span style={{ flex: 1 }}>K/D 크로스 세로줄(상승=%K, 하락=%D)</span>
                      </label>
                      {stoch4CrossEnabled && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 4, marginLeft: 19, marginTop: 3, fontSize: 10, color: '#5a5f6a' }}>
                          <span>투명도</span>
                          <input
                            type="number" min={10} max={100} step={5}
                            value={Math.round(stoch4CrossOpacity * 100)}
                            onChange={e => setStoch4CrossOpacity(Math.min(100, Math.max(10, Number(e.target.value) || 0)) / 100)}
                            style={{ width: 36, fontSize: 10, background: '#1c2028', color: '#e8eaed', border: '1px solid #2a2e38', borderRadius: 4, padding: '1px 3px' }}
                          />
                          <span>%</span>
                        </div>
                      )}
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
                <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 11.5, color: '#e8eaed', cursor: 'pointer' }}>
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
              </>
              )}

            </div>

            {/* 오른쪽 컬럼: 상태줄 / 차트 / 컨트롤 */}
            {/* 왼쪽 사이드바(카드 여러개 펼치면 훨씬 길어짐)를 스크롤해서 내려도 이 컬럼이 화면 밖으로
                사라지지 않게 뷰포트 높이에 sticky로 고정하고, 자체 높이가 화면보다 크면 내부에서만 스크롤되게 함 */}
            <div style={{ flex: 1, minWidth: 280, position: 'sticky', top: 20, maxHeight: 'calc(100vh - 40px)', overflowY: 'auto', overflowX: 'hidden' }}>
              <div style={{ display: 'flex', alignItems: 'center', minHeight: 38 }}>
                {liveCatchingUp ? (
                  <div style={{ color: '#9aa0ab', fontSize: 13 }}>🔄 빠진 구간 채우는 중...</div>
                ) : liveStatus === 'connecting' && <div style={{ color: '#9aa0ab', fontSize: 13 }}>⏳ 데이터 불러오는 중...</div>}
                {!liveCatchingUp && liveStatus === 'live' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#4CAF50', fontSize: 13, fontWeight: 700 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#4CAF50', display: 'inline-block', flexShrink: 0 }} />
                    실시간 연결됨{total ? ` · 캔들 ${total}개` : ' · 첫 캔들 대기 중'}
                  </div>
                )}
                {liveStatus === 'stale' && (
                  isWeekendNow() ? (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, fontWeight: 700 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6b7280', display: 'inline-block', flexShrink: 0 }} />
                      🌙 주말 휴장 중 - 장이 다시 열리면 자동으로 이어집니다
                    </div>
                  ) : (
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#FF9800', fontSize: 13, fontWeight: 700 }}>
                      <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#FF9800', display: 'inline-block', flexShrink: 0 }} />
                      ⚠ 데이터 끊김 - 마지막 캔들 {liveStaleSec}초 전(MT5 EA/자동매매 상태 확인해주세요)
                    </div>
                  )
                )}
                {liveStatus === 'error' && <div style={{ color: '#F44336', fontSize: 13 }}>❌ 서버 연결 실패 - 잠시 후 자동으로 다시 시도합니다</div>}
                {liveStatus === 'disconnected' && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 6, color: '#6b7280', fontSize: 13, fontWeight: 700 }}>
                    <span style={{ width: 8, height: 8, borderRadius: '50%', background: '#6b7280', display: 'inline-block', flexShrink: 0 }} />
                    🔌 연결 끊김 (수동)
                  </div>
                )}
                {/* 연결 끊기/연결하기 버튼(사용자 요청) - 폴링만 멈추고 지금 그려진 차트는 그대로 유지됨 */}
                <button
                  type="button"
                  onClick={liveConnected ? disconnectLive : reconnectLive}
                  style={{
                    marginLeft: 12, fontSize: 12, padding: '6px 12px', borderRadius: 8, cursor: 'pointer', fontWeight: 700,
                    border: `1px solid ${liveConnected ? '#2a2e38' : '#4CAF50'}`,
                    background: liveConnected ? 'none' : 'rgba(76,175,80,0.15)',
                    color: liveConnected ? '#9aa0ab' : '#4CAF50',
                  }}
                >{liveConnected ? '🔌 연결 끊기' : '▶ 연결하기'}</button>
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
                {/* 캔들 타이머 - 차트 구석에 고정된 배지가 아니라, 재생 위치(마지막으로 그려진 캔들)를
                    거리를 두고 계속 따라다녀야 한다는 지적(사용자) - updateTimerAnchor가 그 캔들의
                    시각/종가를 실제 화면 좌표로 변환해서 timerAnchor에 넣어두면 그 좌표 기준으로 뜬다.
                    컨테이너 padding(16px)만큼 보정하고, 캔들 오른쪽으로 60px 떨어뜨린다(사용자 요청).
                    pointerEvents:none이라 차트 드래그/줌 조작은 그대로 통과한다. */}
                {/* liveStatus!=='live'(주말/장마감 등으로 끊김)일 땐 배지 자체는 계속 보여주되 숫자가
                    더 이상 안 흐르게 얼려둔다(사용자 요청 - "안 보이면 안 되고 멈춰있어야") - 실제로
                    값을 멈추는 로직은 아래 tick() effect에서 liveStatus==='live'일 때만 setCandleTimerMs를
                    부르도록 처리한다. 배지 테두리색도 회색으로 바꿔 "지금 안 돌아가는 중"임을 표시. */}
                {timerAnchor && (
                  <span title={liveStatus === 'live' ? '다음 캔들이 그려질 때까지 남은 시간' : '데이터가 끊겨서 멈춰있음'} style={{
                    position: 'absolute', left: timerAnchor.x + 16 + 60, top: timerAnchor.y + 16 - 15,
                    zIndex: 5, pointerEvents: 'none', whiteSpace: 'nowrap',
                    display: 'inline-flex', alignItems: 'center', gap: 6,
                    background: 'rgba(23,26,33,0.92)', border: `1px solid ${liveStatus === 'live' ? '#2a2e38' : '#6b7280'}`, borderRadius: 9,
                    padding: '6px 12px', fontSize: 14, fontWeight: 700,
                    color: liveStatus !== 'live' ? '#6b7280' : (playing ? '#4CAF50' : '#9aa0ab'), fontVariantNumeric: 'tabular-nums',
                  }}>{liveStatus === 'live' ? '⏱' : '⏸'} {formatCandleTimer(candleTimerMs)}</span>
                )}
                {/* 🎯 청산목표 - 예전엔 캔들 타이머 배지 위치를 따라다녔는데, 그건 "지금 캔들" 자리일
                    뿐 실제 감시 대상(느린선)의 값과는 무관해서 오해를 줬다(사용자 지적 - "H1×H5면 H5를
                    따라가야지"). updateExitTargetAnchor가 손절과 완전히 같은 방식으로 그 선의 실제
                    좌표를 계산해서, maStopAnchor와 같은 점선+라벨 스타일로 계속 따라다니게 한다. */}
                {exitTargetAnchor && (
                  <div style={{
                    position: 'absolute', left: exitTargetAnchor.x + 16, top: exitTargetAnchor.y + 16,
                    transform: 'translateY(-50%)', zIndex: 5, pointerEvents: 'none',
                    display: 'flex', alignItems: 'center', whiteSpace: 'nowrap',
                  }}>
                    <span style={{ width: 22, borderTop: '2px dashed #FF5722', display: 'inline-block' }} />
                    <span style={{
                      background: 'rgba(23,26,33,0.92)', border: '1px solid #FF5722', borderRadius: 4,
                      padding: '2px 8px', fontSize: 11, fontWeight: 700, color: '#FF5722', marginLeft: 2,
                    }}>
                      🎯 청산목표({exitTargetAnchor.label})
                      {/* 현재 주가와의 차이(사용자 요청, 손절과 동일) - 달러/포인트는 pnlDisplay 토글을 그대로 따름 */}
                      {exitTargetAnchor.diffDollars != null && (
                        <span style={{ opacity: 0.85 }}>
                          {' '}{pnlDisplay === 'dollar' ? `$${exitTargetAnchor.diffDollars.toFixed(2)}` : `${exitTargetAnchor.diffPoints.toFixed(2)}pt`}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {/* 🛑 이평선 따라가기 손절 - 선택한 선의 "끝"(지금 값)에서 점선이 나와 라벨이 붙는다(사용자
                    요청, "-----손절(H5)" 형태). updateMaStopAnchor가 화면 갱신마다 좌표를 다시 계산해서
                    선택한 선을 계속 따라다닌다. */}
                {maStopAnchor && (
                  <div style={{
                    position: 'absolute', left: maStopAnchor.x + 16, top: maStopAnchor.y + 16,
                    transform: 'translateY(-50%)', zIndex: 5, pointerEvents: 'none',
                    display: 'flex', alignItems: 'center', whiteSpace: 'nowrap',
                  }}>
                    <span style={{ width: 22, borderTop: '2px dashed #F44336', display: 'inline-block' }} />
                    <span style={{
                      background: 'rgba(23,26,33,0.92)', border: '1px solid #F44336', borderRadius: 4,
                      padding: '2px 8px', fontSize: 11, fontWeight: 700, color: '#F44336', marginLeft: 2,
                    }}>
                      손절({maStopAnchor.label})
                      {/* 현재 주가와의 차이(사용자 요청) - 달러/포인트는 기존 pnlDisplay 토글(기본 달러)을 그대로 따름 */}
                      {maStopAnchor.diffDollars != null && (
                        <span style={{ opacity: 0.85 }}>
                          {' '}{pnlDisplay === 'dollar' ? `$${maStopAnchor.diffDollars.toFixed(2)}` : `${maStopAnchor.diffPoints.toFixed(2)}pt`}
                        </span>
                      )}
                    </span>
                  </div>
                )}
                {/* 진입가 표시(사용자 요청, "-----진입 +/-금액") - maStopAnchor/exitTargetAnchor와 같은
                    점선+라벨 스타일. 포지션마다 하나씩, 실시간 손익(pnlDisplay 설정 그대로)이 색과 함께
                    계속 갱신된다(리플레이/실시간 공통, MT5는 오버레이 파일로 별도 구현). */}
                {positionAnchors.map(a => (
                  <div key={a.id} style={{
                    position: 'absolute', left: a.x + 16, top: a.y + 16,
                    transform: 'translateY(-50%)', zIndex: 5, pointerEvents: 'none',
                    display: 'flex', alignItems: 'center', whiteSpace: 'nowrap',
                  }}>
                    <span style={{ width: 22, borderTop: `2px dashed ${twMoneyColor(a.dollars)}`, display: 'inline-block' }} />
                    <span style={{
                      background: 'rgba(23,26,33,0.92)', border: `1px solid ${twMoneyColor(a.dollars)}`, borderRadius: 4,
                      padding: '2px 8px', fontSize: 11, fontWeight: 700, color: twMoneyColor(a.dollars), marginLeft: 2,
                    }}>
                      진입({a.side === 'buy' ? 'BUY' : 'SELL'}){' '}
                      {pnlDisplay === 'dollar' ? `${a.dollars >= 0 ? '+' : ''}$${a.dollars.toFixed(2)}` : `${a.points >= 0 ? '+' : ''}${a.points.toFixed(2)}pt`}
                    </span>
                  </div>
                ))}
                {/* 🔍 찾기 결과 - timerAnchor와 같은 좌표계(컨테이너 padding 16px 보정). 셀은 캔들 위
                    20px, 롱은 캔들 아래 20px(사용자 요청 그대로). updateFoundMarkerAnchors가 화면을
                    드래그/줌하거나 캔들이 새로 그려질 때마다 좌표를 다시 계산해서 계속 따라다닌다. */}
                {foundMarkerAnchors.map(a => (
                  <span key={a.n} title={`${a.n}번째 - 클릭 시 이동은 아래 재생 바 위 번호에서`} style={{
                    position: 'absolute', left: a.x + 16, top: a.side === 'sell' ? a.y + 16 - 20 : a.y + 16 + 20,
                    transform: a.side === 'sell' ? 'translate(-50%, -100%)' : 'translate(-50%, 0%)',
                    zIndex: 5, pointerEvents: 'none', whiteSpace: 'nowrap',
                    display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                    minWidth: 16, height: 16, padding: '0 3px', borderRadius: 3, fontSize: 10, fontWeight: 700,
                    background: '#171a21', color: a.side === 'sell' ? '#ef5350' : '#26a69a',
                    border: `1px solid ${a.side === 'sell' ? '#ef5350' : '#26a69a'}`,
                  }}>{a.n}</span>
                ))}
                {/* 반자동 신호 - "차트 아래(별도 줄)"가 아니라 차트 그 자체 위에, 봉 하나하나에 붙는
                    마커가 아니라 차트 하단에 고정 기록되는 형태로 표시해달라는 지적(사용자) - 캔들
                    타이머와 같은 방식(차트 컨테이너 안에 절대좌표 오버레이)으로, 하단 중앙에 둔다.
                    "사용자가 무장(체크)한 것만"이 아니라 1~6번 신호 전부를 항상 모니터링해서 지금 몇 개가
                    롱 쪽/숏 쪽으로 읽히는지 센다(사용자 지적: "모니터링은 모두 해서"). 각 행의 판정은
                    렌더 색을 정하는 것과 완전히 같은 조건(row1Armed/row3Buy/row4Sell/row2State/row2_1State/
                    row3Ready/row4Ready)을 그대로 재사용 - 골드/나스닥을 동시에 진행 안 하므로(사용자 확인)
                    twSeriesVal은 지금 로드된 symbol 데이터 기준 값을 그대로 쓴다. */}
                {showSemiAutoSignalOnChart && (() => {
                  const h1 = twSeriesVal('h1')
                  const wma85 = twSeriesVal('wma85'), sma100 = twSeriesVal('sma100')
                  const stochGolden = twSeriesVal('stochGolden')
                  const row1Armed = twSeriesVal('row1Armed')
                  const price = playIndex > 0 ? rowsRef.current[playIndex - 1]?.close ?? null : null
                  const h300 = twSeriesVal('h300'), prevH300 = twSeriesVal('h300', 1)
                  const stoch70Golden = twSeriesVal('stoch70Golden'), stoch210Golden = twSeriesVal('stoch210Golden')

                  // "3롱/1셀"처럼 개수만 세면 어떤 번호가 롱인지 안 보인다는 지적(사용자) - 몇 번 신호가
                  // 롱인지/셀인지 번호 그대로 나열한다("1, 2, 3 롱" / "6 셀"). 번호는 분리매매창 반자동
                  // 예약 카드의 "화면에 보이는 순서"를 그대로 따른다(사용자 요청, 최신 번호 체계):
                  // 1=1번(내부row4, 하락추세)/2=2번(내부row3, 상승추세)/3=3번(HMA300 하락중)/
                  // 4=4번(HMA300 상승중)/5=5번(내부row1, 5Bol 상단)/6=6번(내부row1.1, 5Bol 하단)/
                  // 7=7번(스토 데드)/8=8번(스토 골든). A~L(C~N)은 이 패널에서 아직 모니터링 안 함.
                  // 1↔2, 3↔4, 7↔8은 각각 같은 비교식의 반대 방향이라 절대 동시에 못 뜬다.
                  const longRows = [], shortRows = []
                  if (wma85 != null && sma100 != null && h1 != null && wma85 < sma100 && stochGolden === false && price != null && price < h1) shortRows.push(1) // 1번(화면 위치, 내부row4): 하락추세
                  if (wma85 != null && sma100 != null && h1 != null && wma85 > sma100 && stochGolden === true && price != null && price > h1) longRows.push(2) // 2번(화면 위치, 내부row3): 상승추세
                  if (h300 != null && prevH300 != null && h300 < prevH300) shortRows.push(3) // 3번: HMA300 하락중
                  if (h300 != null && prevH300 != null && h300 >= prevH300) longRows.push(4) // 4번: HMA300 상승중(차트 듀얼컬러 선과 같은 기준)
                  if (row1Armed === 'above') shortRows.push(5) // 5번(매도 전용): 5Bol 상단 밖(row1Armed 진입 전)
                  if (row1Armed === 'below') longRows.push(6) // 6번(매수 전용): 5Bol 하단 밖(row1Armed 진입 전)
                  if (stoch70Golden === false && stoch210Golden === false) shortRows.push(7) // 7번: 스토(70,15,15)+(210,45,45) 둘 다 데드
                  if (stoch70Golden === true && stoch210Golden === true) longRows.push(8) // 8번: 스토(70,15,15)+(210,45,45) 둘 다 골든

                  if (longRows.length === 0 && shortRows.length === 0) return null
                  return (
                    <div style={{
                      position: 'absolute', left: '50%', bottom: 26, transform: 'translateX(-50%)',
                      zIndex: 5, pointerEvents: 'none', whiteSpace: 'nowrap', textAlign: 'center',
                      background: 'rgba(23,26,33,0.92)', border: '1px solid #2a2e38', borderRadius: 9,
                      padding: '6px 14px', fontSize: 13, fontWeight: 700, lineHeight: 1.5,
                    }}>
                      {longRows.length > 0 && <div style={{ color: '#26a69a' }}>{longRows.join(', ')} 롱</div>}
                      {shortRows.length > 0 && <div style={{ color: '#ef5350' }}>{shortRows.join(', ')} 셀</div>}
                    </div>
                  )
                })()}
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 16 }}>
                <span style={{ color: '#9aa0ab', fontSize: 13 }}>총 {total.toLocaleString()}봉</span>
              </div>
              {/* 라이브 페이지는 재생 개념이 없어서(사용자 요청) 빨간 바/파란 바/재생·처음부터/배속
                  버튼을 전부 뺐다 - 스샷 버튼만 남김. */}
              <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 12, flexWrap: 'wrap' }}>
                <button onClick={captureScreenshot} disabled={!total} title="지금 보이는 상태 그대로 PNG로 저장" style={{
                  background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
                  padding: '10px 16px', fontSize: 14, cursor: total ? 'pointer' : 'not-allowed',
                }}>📸 스샷</button>
              </div>

              {/* 왼쪽: 매매 컨트롤(폭 절반) / 오른쪽: 매매진입 현황 - 기본은 원래 자리(인라인)에 있고,
                  "🗗 분리" 버튼을 누르면 그때만 분리매매창처럼 떠다니는 패널(positionPanelFloating)이
                  된다(사용자 지적 - "원래 있던곳에 있고 분리하면 떠야지"). */}
              <div style={{ display: 'flex', gap: 16, marginTop: 16, alignItems: 'stretch', flexWrap: 'wrap' }}>
              {/* 시뮬레이션(가상매매) 패널 - 실제 매매를 켜면(realTradingUnlocked) 헷갈리지 않게 아예
                  숨긴다(사용자 요청 - "실매매 체크하면 안 보이게 해줘"). */}
              {!realTradingUnlocked && (
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, flex: positionPanelFloating ? '0 1 560px' : '1 1 460px' }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: '#4CAF50', marginBottom: 10 }}>🧪 시뮬레이션 (가상매매)</div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                  <label style={{ margin: 0, display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#9aa0ab' }}>
                    시작 자금
                    <input
                      type="number" min={0} value={startingBalance}
                      onChange={e => applyStartingBalance(e.target.value)}
                      style={{ width: 100, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '5px 8px', fontSize: 13 }}
                    />
                    USD
                  </label>
                  {/* 시작 자금 옆 리셋 버튼(사용자 요청) - 숫자를 다시 안 쳐도 잔고를 지금 시작 자금 값으로
                      되돌린다. applyStartingBalance는 입력창 onChange에서도 이미 쓰는 것과 같은 함수라
                      "시작자금을 리셋하거나 수정하면 초기화된다"는 동작이 두 경로 다 동일하게 보장된다. */}
                  <button
                    type="button" title="잔고를 시작 자금 값으로 리셋" onClick={() => applyStartingBalance(startingBalance)}
                    style={{ fontSize: 11.5, padding: '5px 10px', borderRadius: 6, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', cursor: 'pointer', fontWeight: 700 }}
                  >↺ 리셋</button>
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
              </div>
              )}

              {/* 실주문(진짜 MT5 주문) - 위 매매 컨트롤은 전부 웹 안에서만 도는 가상매매고, 이건 별개
                  기능이라 일부러 카드도 분리해뒀다(사용자 요청 - 실제 돈이 걸린 기능이라 안전장치 필요).
                  계좌라벨 자체가 비밀값 역할이라(자기 EA에도 똑같이 입력해두는 값) 이것만 안 정하면
                  버튼이 막힌다 - EA 쪽 EnableRealTrading/AccountLabel 이중 확인도 별개로 있음. */}
              {realTradingUnlocked && (
              <div style={{ background: '#171a21', border: '1px solid #F44336', borderRadius: 14, padding: 16, flex: '1 1 100%' }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 16, marginBottom: 12, flexWrap: 'wrap' }}>
                  <div style={{ fontSize: 13, fontWeight: 700, color: '#F44336' }}>🔴 실주문 (MT5에 실제로 체결됩니다)</div>
                  {/* 계좌 상태(데모/라이브 + 잔고) - EA가 주기적으로 보고해둔 걸 폴링해서 표시(사용자 요청).
                      계좌 라벨을 아직 안 정했거나 EA가 한 번도 보고 안 했으면 접속 안내만 보여준다. */}
                  {tradeAccountLabel && (
                    accountStatus ? (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 }}>
                        <span style={{
                          padding: '3px 8px', borderRadius: 6, fontWeight: 700,
                          background: accountStatus.is_demo ? 'rgba(33,150,243,0.15)' : 'rgba(244,67,54,0.15)',
                          color: accountStatus.is_demo ? '#4FC3F7' : '#F44336',
                          border: `1px solid ${accountStatus.is_demo ? '#4FC3F7' : '#F44336'}`,
                        }}>{accountStatus.is_demo ? '🔵 데모 계좌' : '🔴 라이브 계좌'}</span>
                        <span style={{ color: '#9aa0ab' }}>
                          잔고 {accountStatus.balance.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {accountStatus.currency || ''}
                          {accountStatus.account_login ? ` (#${accountStatus.account_login})` : ''}
                        </span>
                      </div>
                    ) : (
                      <span style={{ fontSize: 11.5, color: '#6b7280' }}>⏳ 계좌 정보 대기 중 - MT5의 EA가 아직 한 번도 보고하지 않았어요</span>
                    )
                  )}
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
                <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 10 }}>
                  <input
                    type="password" placeholder="계좌 라벨 (자기 EA와 동일하게)" value={tradeAccountLabel}
                    onChange={e => setTradeAccountLabel(e.target.value)}
                    style={{ width: 200, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '7px 8px', fontSize: 13 }}
                  />
                  <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                    <span style={{ fontSize: 12, color: '#9aa0ab' }}>랏수</span>
                    <input
                      type="number" step={0.01} min={0.01} value={tradeLot}
                      onChange={e => setTradeLot(Math.max(0.01, Number(e.target.value) || 0.01))}
                      style={{ width: 64, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 6, color: '#e8eaed', padding: '5px 6px', fontSize: 13, textAlign: 'center' }}
                    />
                  </div>
                </div>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                  {(() => {
                    const disabled = !tradeAccountLabel || tradeSending
                    return (
                      <>
                        <button
                          type="button" onClick={() => sendTradeCommand('buy')} disabled={disabled}
                          style={{ background: '#26a69a', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, padding: '9px 22px', fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}
                        >실매수</button>
                        <button
                          type="button" onClick={() => sendTradeCommand('sell')} disabled={disabled}
                          style={{ background: '#ef5350', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, padding: '9px 22px', fontSize: 14, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}
                        >실매도</button>
                        <button
                          type="button" onClick={() => sendTradeCommand('close')} disabled={disabled}
                          style={{ background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9, fontWeight: 700, padding: '9px 18px', fontSize: 13, cursor: disabled ? 'not-allowed' : 'pointer', opacity: disabled ? 0.4 : 1 }}
                        >전체 청산</button>
                        <button
                          type="button" onClick={() => setShowTradingWindow(v => !v)}
                          style={{
                            marginLeft: 'auto', fontSize: 12, padding: '8px 14px', borderRadius: 9, cursor: 'pointer', fontWeight: 700,
                            border: `1px solid ${showTradingWindow ? '#4CAF50' : '#2a2e38'}`,
                            background: showTradingWindow ? 'rgba(76,175,80,0.15)' : 'none',
                            color: showTradingWindow ? '#4CAF50' : '#9aa0ab',
                          }}
                        >🖱 매매 실행 (분리매매창){showTradingWindow ? ' 닫기' : ''}</button>
                      </>
                    )
                  })()}
                  {!tradeAccountLabel && <span style={{ fontSize: 11, color: '#6b7280' }}>계좌 라벨을 입력해야 버튼이 활성화됩니다</span>}
                </div>
                {tradeCommands.length > 0 && (
                  <div style={{ marginTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
                    {tradeCommands.map(c => (
                      <div key={c.id} style={{ fontSize: 11.5, color: '#9aa0ab', display: 'flex', gap: 6 }}>
                        <span style={{ color: c.status === 'done' ? '#4CAF50' : c.status === 'error' ? '#F44336' : '#FF9800', fontWeight: 700 }}>
                          {c.status === 'pending' || c.status === 'claimed' ? '⏳ 처리 중' : c.status === 'done' ? '✅ 체결' : '❌ 실패'}
                        </span>
                        <span>{c.direction === 'buy' ? '매수' : c.direction === 'sell' ? '매도' : '청산'}{c.message ? ` - ${c.message}` : ''}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
              )}

              {/* 매매진입 현황 - 원래 있던 자리(인라인). 분리하면(positionPanelFloating=true) 여기선
                  안 그리고 renderPositionPanel()이 떠다니는 패널로 대신 그린다. 벌크 청산 버튼도
                  이 안에 포함한다(사용자 요청). */}
              {!positionPanelFloating && (
                <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, flex: '1 1 300px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
                    <div style={{ fontSize: 13, fontWeight: 700 }}>매매진입 현황 {positions.length > 0 && `(${positions.length})`}</div>
                    <button type="button" onClick={() => setPositionPanelFloating(true)} title="떠다니는 패널로 분리"
                      style={{ background: 'none', border: 'none', color: '#9aa0ab', fontSize: 14, cursor: 'pointer', lineHeight: 1 }}>🗗</button>
                  </div>
                  {/* 진입 랏수/손절/목표 설정값 / 보유 포지션 개수를 맨 위에 요약(사용자 요청) - 위 떠다니는
                      패널(renderPositionPanel)과 동일한 요약, twSl/twTp는 분리매매창 설정과 같은 값. */}
                  <div style={{ display: 'flex', gap: 12, marginBottom: 4, fontSize: 12, color: '#9aa0ab', flexWrap: 'wrap' }}>
                    <span>진입 랏수 <b style={{ color: '#e8eaed' }}>{lotSize}</b></span>
                    <span>포지션 <b style={{ color: positions.length > 0 ? '#4CAF50' : '#e8eaed' }}>{positions.length}</b>개</span>
                  </div>
                  <div style={{ display: 'flex', gap: 12, marginBottom: 10, fontSize: 12, color: '#9aa0ab', flexWrap: 'wrap' }}>
                    <span>손절 <b style={{ color: twUseSl ? '#F44336' : '#5a5f6a' }}>{twUseSl ? `${twSl}pt` : '미사용'}</b></span>
                    <span>목표 <b style={{ color: twUseTp ? '#4CAF50' : '#5a5f6a' }}>{twUseTp ? `${twTp}pt` : '미사용'}</b></span>
                  </div>
                  {/* BUY/SELL도 여기서 바로(사용자 요청) */}
                  <div style={{ display: 'flex', gap: 8, marginBottom: 10 }}>
                    <button
                      type="button" onClick={() => openPosition('buy')} disabled={currentPrice == null}
                      style={{
                        flex: 1, background: '#26a69a', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700,
                        padding: '9px 0', fontSize: 13, cursor: currentPrice == null ? 'not-allowed' : 'pointer', opacity: currentPrice == null ? 0.5 : 1,
                      }}
                    >BUY</button>
                    <button
                      type="button" onClick={() => openPosition('sell')} disabled={currentPrice == null}
                      style={{
                        flex: 1, background: '#ef5350', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700,
                        padding: '9px 0', fontSize: 13, cursor: currentPrice == null ? 'not-allowed' : 'pointer', opacity: currentPrice == null ? 0.5 : 1,
                      }}
                    >SELL</button>
                  </div>
                  {/* 포지션이 여러 개일 때 맨 위에 전체 합계(사용자 요청) */}
                  {positions.length > 1 && (() => {
                    const totalDollars = positions.reduce((sum, pos) => sum + (currentPrice != null ? calcPnl(pos, currentPrice).dollars : 0), 0)
                    const totalPoints = positions.reduce((sum, pos) => sum + (currentPrice != null ? calcPnl(pos, currentPrice).points : 0), 0)
                    return (
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0 10px', marginBottom: 6, borderBottom: '1px solid #2a2e38' }}>
                        <span style={{ fontWeight: 700 }}>합계</span>
                        <span style={{ color: totalDollars >= 0 ? '#26a69a' : '#ef5350', fontWeight: 700, marginLeft: 'auto' }}>
                          {currentPrice == null ? '—' : pnlDisplay === 'dollar'
                            ? `${totalDollars >= 0 ? '+' : ''}$${totalDollars.toFixed(2)}`
                            : `${totalPoints >= 0 ? '+' : ''}${totalPoints.toFixed(2)}pt`}
                        </span>
                        <button
                          type="button" onClick={closeAllPositionsModal}
                          style={{ fontSize: 11, padding: '5px 10px', borderRadius: 6, border: 'none', background: '#FF5722', color: '#fff', fontWeight: 700, cursor: 'pointer' }}
                        >🚨 벌크 청산</button>
                      </div>
                    )
                  })()}
                  {positions.length === 0 ? (
                    <div style={{ fontSize: 12.5, color: '#5a5f6a' }}>보유 중인 포지션이 없습니다</div>
                  ) : (
                    positions.map(pos => {
                      const { points, dollars } = currentPrice != null ? calcPnl(pos, currentPrice) : { points: 0, dollars: 0 }
                      const profit = dollars >= 0
                      return (
                        <div key={pos.id} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid #2a2e38' }}>
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
                    })
                  )}
                  <button
                    type="button" onClick={closeAllPositionsModal}
                    style={{ width: '100%', marginTop: 10, background: '#FF5722', color: '#fff', border: 'none', borderRadius: 9, fontWeight: 700, padding: '9px 16px', fontSize: 13, cursor: 'pointer' }}
                  >🚨 벌크 청산</button>
                </div>
              )}
              </div>

              {/* 히스토리(사용자 요청) - closedTradesRef는 ref라 자체로는 리렌더를 안 일으키지만, 청산될
                  때마다 같이 올라가는 closedTradesCount(state)가 리렌더를 트리거하니 그 시점에 여기서
                  ref.current를 그대로 읽으면 항상 최신 상태가 보인다. 최근 청산이 위로 오게 뒤집어서 표시. */}
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 16, marginTop: 16 }}>
                <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10 }}>히스토리 {closedTradesCount > 0 && `(${closedTradesCount})`}</div>
                {closedTradesCount === 0 ? (
                  <div style={{ fontSize: 12.5, color: '#5a5f6a' }}>청산된 거래가 없습니다</div>
                ) : (
                  <div style={{ maxHeight: 260, overflowY: 'auto' }}>
                    {closedTradesRef.current.slice().reverse().map((t, i) => (
                      <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10, padding: '5px 0', fontSize: 12.5, borderBottom: '1px solid #2a2e38' }}>
                        <span style={{ color: t.side === 'buy' ? '#26a69a' : '#ef5350', fontWeight: 700, width: 36 }}>
                          {t.side === 'buy' ? 'BUY' : 'SELL'}
                        </span>
                        <span style={{ color: '#9aa0ab', width: 46 }}>{t.symbol === 'GOLD' ? '골드' : '나스닥'}</span>
                        <span style={{ color: '#9aa0ab' }}>{t.lot.toFixed(2)}랏</span>
                        <span style={{ color: '#9aa0ab' }}>{t.entryPrice.toFixed(2)} → {t.exitPrice.toFixed(2)}</span>
                        <span style={{ color: t.dollars >= 0 ? '#26a69a' : '#ef5350', fontWeight: 700, marginLeft: 'auto' }}>
                          {pnlDisplay === 'dollar'
                            ? `${t.dollars >= 0 ? '+' : ''}$${t.dollars.toFixed(2)}`
                            : `${t.points >= 0 ? '+' : ''}${t.points.toFixed(2)}pt`}
                        </span>
                      </div>
                    ))}
                  </div>
                )}
              </div>

              {/* 라이브 페이지는 "반자동"/"시뮬레이션" 카드도 필요 없어서 뺐다(사용자 요청) - 둘 다
                  재생 구간을 전제로 한 기능이라 실시간 모드랑 안 맞음. */}
            </div>
          </div>

        </main>

        <footer className="site">
          문의: minssajang@gmail.com
          <Link href="/admin" className="admin-link">admin</Link>
        </footer>

        {/* document.body에 포탈로 그린다(사용자 지적 - "항상 제일 위" 요청) - 이전엔 페이지 트리 안에
            그대로 그려서, 조상 요소 중 하나가 stacking context를 만들면(transform/opacity 등) zIndex:1000이
            그 안에 갇혀서 다른 요소 뒤로 숨을 수 있었다. body에 바로 붙이면 그런 조상 영향을 아예 안 받는다. */}
        {showTradingWindow && !twPopupEl && createPortal(renderTwEmbedded(), document.body)}
        {showTradingWindow && twPopupEl && createPortal(renderTwPopupContent(), twPopupEl)}
        {/* positionPanelFloating 기본값이 false라 SSR에서 document.body에 안 닿지만, 혹시를 대비해
            (예전 showPositionPanel=true 기본값 때 실제로 배포 에러가 났던 전례) typeof 가드는 유지한다.
            twPopupEl과 같은 패턴 - 새 창으로 뺐으면(posPopupEl) 그 창 document에, 아니면 페이지 안
            떠다니는 패널로 렌더한다. */}
        {positionPanelFloating && !posPopupEl && typeof document !== 'undefined' && createPortal(renderPositionPanel(), document.body)}
        {positionPanelFloating && posPopupEl && createPortal(renderPosPopupContent(), posPopupEl)}
        {showTradeGuideModal && typeof document !== 'undefined' && createPortal(renderTradeGuideModal(), document.body)}
      </div>
    </>
  )
}
