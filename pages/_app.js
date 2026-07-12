import { useRouter } from 'next/router'
import '../styles/site.css'
import { AdSlotsProvider, useAdSlot } from '../lib/AdSlotsContext'
import { SidebarAd } from '../components/AdSlot'

// 전체 페이지 좌/우 사이드 레일 광고 (넓은 화면에서만 노출, 모든 페이지 공통 적용)
function SideRailAds() {
  const left = useAdSlot('home_left')
  const right = useAdSlot('home_right')
  return (
    <>
      <div className="ad-rail ad-rail-left">
        <SidebarAd slot={left} label="좌측 사이드 광고" />
      </div>
      <div className="ad-rail ad-rail-right">
        <SidebarAd slot={right} label="우측 사이드 광고" />
      </div>
    </>
  )
}

export default function App({ Component, pageProps }) {
  const router = useRouter()
  // 관리자 페이지에는 사이트 광고 레일을 노출하지 않는다
  const showSiteAds = !router.pathname.startsWith('/admin')

  return (
    <AdSlotsProvider>
      {showSiteAds && <SideRailAds />}
      <Component {...pageProps} />
    </AdSlotsProvider>
  )
}
