import { useState, useEffect } from 'react'
import { useRouter } from 'next/router'
import Head from 'next/head'
import Link from 'next/link'
import { AdSlot } from '../components/AdSlot'
import { useAdSlot } from '../lib/AdSlotsContext'
import { callRpc } from '../lib/publicSupabase'

const APP_LABEL = { ninja: 'NT8 (NinjaTrader) 버전', mt5: 'MT5 (MetaTrader 5) 버전' }
const COUNTDOWN_SECONDS = 5

export default function Download() {
  const router = useRouter()
  const app = typeof router.query.app === 'string' ? router.query.app : null
  const interstitialSlot = useAdSlot('download_interstitial')

  const [info, setInfo] = useState(null) // { version, download_url, changelog }
  const [error, setError] = useState(null)
  const [seconds, setSeconds] = useState(COUNTDOWN_SECONDS)
  const [started, setStarted] = useState(false)

  useEffect(() => {
    if (!app) return
    callRpc('get_latest_version', { p_app: app })
      .then(rows => {
        if (rows && rows[0]) setInfo(rows[0])
        else setError('등록된 다운로드 파일이 없습니다')
      })
      .catch(() => setError('버전 정보를 불러오지 못했습니다'))
  }, [app])

  useEffect(() => {
    if (!info || seconds <= 0) return
    const t = setTimeout(() => setSeconds(s => s - 1), 1000)
    return () => clearTimeout(t)
  }, [info, seconds])

  useEffect(() => {
    if (info && seconds === 0 && !started) {
      setStarted(true)
      window.location.href = info.download_url
    }
  }, [info, seconds, started])

  const ready = seconds <= 0

  return (
    <>
      <Head>
        <title>다운로드 준비 중 — EasyTrade</title>
      </Head>
      <div className="landing-wrap" style={{ maxWidth: 640 }}>
        <header className="site">
          <div className="brand">EasyTrade</div>
          <nav className="site">
            <Link href="/">홈</Link>
          </nav>
        </header>

        <section className="hero" style={{ padding: '48px 12px 32px' }}>
          {!app && <p>잘못된 접근입니다. <Link href="/">홈으로 돌아가기</Link></p>}

          {app && error && (
            <>
              <h1 style={{ fontSize: 26 }}>다운로드 파일 준비 중</h1>
              <p>{error}</p>
              <Link href="/" className="btn-cta ghost">홈으로 돌아가기</Link>
            </>
          )}

          {app && !error && !info && <p>확인 중...</p>}

          {app && info && (
            <>
              <span className="hero-badge">⬇️ 다운로드 준비 중</span>
              <h1 style={{ fontSize: 28 }}>{APP_LABEL[app] || app} v{info.version}</h1>
              {info.changelog && <p style={{ whiteSpace: 'pre-wrap' }}>{info.changelog}</p>}

              <div style={{ margin: '24px 0' }}>
                <AdSlot slot={interstitialSlot} label="다운로드 대기 광고" />
              </div>

              {!ready ? (
                <p style={{ fontSize: 18, fontWeight: 700 }}>
                  {seconds}초 후 자동으로 다운로드가 시작됩니다...
                </p>
              ) : (
                <a href={info.download_url} className="btn-cta primary">⬇️ 다운로드 시작</a>
              )}

              <p style={{ fontSize: 13, color: 'var(--muted)', marginTop: 16 }}>
                다운로드가 자동으로 시작되지 않으면 위 버튼을 눌러주세요.
              </p>
            </>
          )}
        </section>
      </div>
    </>
  )
}
