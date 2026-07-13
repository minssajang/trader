import { useEffect, useMemo, useRef, useState } from 'react'
import { SLOT_BANNER_SIZE } from '../lib/adSlotSizes'
import { useCoupangWidgets, useAdsOn } from '../lib/AdSlotsContext'

// 관리자가 저장한 <script>/<ins> 코드를 안전하게 DOM에 주입 (innerHTML은 <script>를 실행하지 않으므로 직접 삽입)
function useInjectAdCode(containerRef, code, deps = []) {
  useEffect(() => {
    const el = containerRef.current
    if (!el || !code) return
    el.innerHTML = ''
    const wrapper = document.createElement('div')
    wrapper.innerHTML = code
    Array.from(wrapper.querySelectorAll('script')).forEach(oldScript => {
      const newScript = document.createElement('script')
      Array.from(oldScript.attributes).forEach(attr => newScript.setAttribute(attr.name, attr.value))
      newScript.textContent = oldScript.textContent
      oldScript.replaceWith(newScript)
    })
    el.appendChild(wrapper)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
}

const COUPANG_ROTATE_MS = 30000

// 사이즈가 맞고 켜져있는 쿠팡 배너 목록에서 하나를 고르되, 2개 이상이면 30초마다 무작위로 바꿔가며 보여준다
function useRotatingCoupangBanner(widgets, size) {
  const matches = useMemo(
    () => (Array.isArray(widgets) ? widgets : []).filter(w => w.enabled && w.widget_html && w.size === size),
    [widgets, size]
  )
  const [index, setIndex] = useState(0)

  useEffect(() => {
    setIndex(matches.length ? Math.floor(Math.random() * matches.length) : 0)
  }, [matches.length, size])

  useEffect(() => {
    if (matches.length <= 1) return
    const id = setInterval(() => {
      setIndex(Math.floor(Math.random() * matches.length))
    }, COUPANG_ROTATE_MS)
    return () => clearInterval(id)
  }, [matches.length])

  return matches.length ? matches[index] : null
}

/**
 * 슬롯 데이터(slot.source: 'adsense'(기본) | 'coupang' | 'random')와
 * 사이즈가 맞는 쿠팡 배너 목록을 바탕으로 실제로 주입할 HTML을 결정한다.
 */
function useResolvedAdContent(slotId, slot) {
  const coupangWidgets = useCoupangWidgets()
  const adsOn = useAdsOn()
  const size = SLOT_BANNER_SIZE[slotId]
  const coupangBanner = useRotatingCoupangBanner(coupangWidgets, size)

  const source = slot?.source || 'adsense'
  const hasAdsense = !!(slot?.active && slot?.code)
  const hasCoupang = !!(slot?.active && coupangBanner)

  let injectHtml = null
  if (adsOn && slot?.active) {
    if (source === 'coupang') {
      injectHtml = hasCoupang ? coupangBanner.widget_html : null
    } else if (source === 'random') {
      const pool = []
      if (hasAdsense) pool.push(slot.code)
      if (hasCoupang) pool.push(coupangBanner.widget_html)
      injectHtml = pool.length ? pool[Math.floor(Math.random() * pool.length)] : null
    } else {
      injectHtml = hasAdsense ? slot.code : null
    }
  }

  return {
    injectHtml,
    isOff: !adsOn || !!(slot && !slot.active),
    isWaiting: !!(adsOn && slot?.active && !injectHtml),
  }
}

/**
 * AdSlot — 본문/배너용 광고 영역
 * 관리자(admin > 광고 관리)가 설정한 소스(애드센스 코드 / 쿠팡 배너 / 무작위)를 사용.
 * OFF거나 광고 전체 노출 스위치가 꺼져있으면 아무것도 렌더링하지 않는다 (자리 차지 없음).
 */
export function AdSlot({ slot, label = '광고', style: extraStyle = {} }) {
  const codeRef = useRef(null)
  const slotId = slot?.id
  const { injectHtml, isOff, isWaiting } = useResolvedAdContent(slotId, slot)

  useInjectAdCode(codeRef, injectHtml, [injectHtml])

  if (isOff) return null

  if (injectHtml) return (
    <div style={{ ...extraStyle, display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div ref={codeRef} style={{ maxWidth: '100%' }} />
    </div>
  )

  if (isWaiting) return (
    <div style={{
      padding: '18px 12px', textAlign: 'center', border: '1.5px dashed var(--border)',
      borderRadius: 8, color: 'var(--muted)', fontSize: 12, ...extraStyle,
    }}>
      📢 {label} 영역 — 관리자 페이지에서 광고 코드/배너를 등록하세요
    </div>
  )

  return null
}

/**
 * SidebarAd — 사이드바(세로형, 160×600) 광고 영역
 */
export function SidebarAd({ slot, label = '광고' }) {
  const codeRef = useRef(null)
  const slotId = slot?.id
  const { injectHtml, isOff, isWaiting } = useResolvedAdContent(slotId, slot)

  useInjectAdCode(codeRef, injectHtml, [injectHtml])

  if (isOff) return null

  if (injectHtml) return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center' }}>
      <div ref={codeRef} style={{ maxWidth: '100%' }} />
    </div>
  )

  if (isWaiting) return (
    <div style={{
      width: 160, minHeight: 300, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
      border: '1.5px dashed var(--border)', borderRadius: 8, color: 'var(--muted)', textAlign: 'center', padding: 12,
    }}>
      <span style={{ fontSize: 18 }}>📢</span>
      <span style={{ fontSize: 12, marginTop: 6 }}>{label}</span>
      <span style={{ fontSize: 10, marginTop: 4 }}>160×600</span>
    </div>
  )

  return null
}
