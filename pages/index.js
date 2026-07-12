import { useState, useEffect } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { AdSlot } from '../components/AdSlot'
import { useAdSlot } from '../lib/AdSlotsContext'
import { callRpc } from '../lib/publicSupabase'

const FEATURES = [
  { icon: '⚡', title: '실시간 연동', desc: '실시간 시세를 그대로 받아와서 바로바로 반영돼요.' },
  { icon: '🎯', title: '예약매매', desc: '미리 정해둔 조건대로 알아서 진입해요.' },
  { icon: '🛡️', title: '손쉬운 손절 익절', desc: '복잡한 설정 없이 손절·익절을 자동으로 처리해요.' },
]

const STEPS = [
  { title: '무료체험 신청', desc: <><Link href="/apply">신청 페이지</Link>에서 이름/이메일/제품만 입력하면 끝 — 베타 기간엔 입금 없이 바로 신청됩니다.</> },
  { title: '라이선스 발급', desc: '신청 확인 후 이메일로 일주일 무료체험 라이선스 키를 보내드립니다.' },
  { title: '바로 사용', desc: '매매 프로그램 실행 시 라이선스 키를 입력하면 남은 기간이 표시되며 사용 가능합니다.' },
  { title: '상태 확인', desc: <><Link href="/check">내 정보 조회</Link>에서 이름/이메일로 언제든 상태를 확인할 수 있습니다.</> },
]

const MARKET_COMPARE = [
  {
    title: '주식', items: [
      '회사 지분을 직접 소유해요',
      '만기가 없어서 계속 보유할 수 있어요',
      '배당을 받을 수 있어요',
      '거래소 예: 코스피, 나스닥',
    ],
  },
  {
    title: '선물', items: [
      '미래 시점에 정해진 가격으로 사고팔기로 한 계약이에요',
      '정해진 만기일이 있어요',
      '적은 증거금으로 레버리지 거래를 해요',
      '실물 자산을 직접 소유하지는 않아요',
    ],
  },
]

const GLOSSARY = [
  { term: '프랍', label: '프랍 트레이딩 / 프랍펌', desc: '트레이더가 자기 돈이 아니라 회사(프랍펌)의 자금으로 거래하는 방식이에요. 평가(챌린지)를 통과하면 회사 자금으로 거래하고 수익을 나눠 가져요. NinjaTrader는 이런 프랍펌 평가에서 가장 많이 쓰이는 플랫폼이에요.' },
  { term: 'CME', label: '시카고상품거래소', desc: 'E-mini S&P500(ES), 나스닥(NQ) 같은 선물 상품이 거래되는 대표적인 정식 거래소예요. NinjaTrader가 주로 다루는 시장이 바로 여기예요.' },
  { term: 'CFD', label: '차액결제거래', desc: '실제 자산을 소유하지 않고 가격 변동분만 정산하는 파생상품이에요. 거래소가 아니라 브로커를 통해 거래되고, MetaTrader 5가 주로 다루는 방식이에요.' },
]

function DownloadButton({ info, app }) {
  const [showComingSoon, setShowComingSoon] = useState(false)

  if (info) {
    return (
      <Link href={`/download?app=${app}`} className="btn-cta primary" style={{ marginTop: 16 }}>
        ⬇️ 다운로드 (v{info.version})
      </Link>
    )
  }

  return (
    <>
      <button type="button" className="btn-cta primary" style={{ marginTop: 16 }} onClick={() => setShowComingSoon(true)}>
        ⬇️ 다운로드
      </button>
      {showComingSoon && (
        <div onClick={() => setShowComingSoon(false)} style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
        }}>
          <div onClick={e => e.stopPropagation()} className="card" style={{ maxWidth: 320, textAlign: 'center' }}>
            <p style={{ margin: '0 0 16px', fontSize: 15 }}>⏳ 다운로드 준비 중입니다.<br />조금만 기다려주세요!</p>
            <button type="button" className="btn-cta primary" style={{ width: 'auto' }} onClick={() => setShowComingSoon(false)}>확인</button>
          </div>
        </div>
      )}
    </>
  )
}

export default function Home() {
  const topSlot = useAdSlot('home_top')
  const footerSlot = useAdSlot('footer')
  const [versions, setVersions] = useState({}) // { ninja: {version, download_url}, mt5: {...} }

  useEffect(() => {
    ['ninja', 'mt5'].forEach(app => {
      callRpc('get_latest_version', { p_app: app })
        .then(rows => {
          if (rows && rows[0]) setVersions(v => ({ ...v, [app]: rows[0] }))
        })
        .catch(() => {})
    })
  }, [])

  return (
    <>
      <Head>
        <title>EasyTrade — 닌자 트레이더 자동매매 시스템</title>
        <meta name="description" content="그냥 손쉬운 예약매매 시스템 — 실시간 연동, 손쉬운 손절 익절까지. 베타 오픈 기념 일주일 무료체험 진행 중" />
      </Head>
      <div className="landing-wrap">
        <header className="site">
          <div className="brand">EasyTrade</div>
          <nav className="site">
            <Link href="/blog">블로그</Link>
            <Link href="/board">자유게시판</Link>
            <Link href="/apply">신청</Link>
            <Link href="/check">내 정보 조회</Link>
          </nav>
        </header>

        <AdSlot slot={topSlot} label="상단 배너" style={{ marginBottom: 20 }} />

        <section className="hero">
          <span className="hero-badge">🎉 베타 오픈 기념 · 일주일 무료체험</span>
          <h1>그냥, 손쉬운<br />예약매매 시스템</h1>
          <p>
            실시간 연동에 손쉬운 손절 익절까지 — 복잡한 설정 없이 그냥 쓰면 돼요.
            지금 베타 오픈 기간 동안 일주일 무료체험으로 먼저 경험해보세요.
          </p>
          <div className="hero-ctas">
            <Link href="/apply" className="btn-cta primary">🎁 일주일 무료체험 신청</Link>
            <Link href="/blog" className="btn-cta ghost">블로그 둘러보기</Link>
          </div>
        </section>

        <div className="section-title">
          <h2>무엇을 할 수 있나요</h2>
          <p>어려운 설정 없이, 그냥 켜두기만 하면 돼요</p>
        </div>
        <div className="feature-grid">
          {FEATURES.map((f, i) => (
            <div key={i} className="feature-card">
              <div className="icon">{f.icon}</div>
              <h3>{f.title}</h3>
              <p>{f.desc}</p>
            </div>
          ))}
        </div>

        <div className="section-title">
          <h2>버전 선택</h2>
          <p>사용 중인 플랫폼에 맞는 버전을 선택하세요</p>
        </div>
        <div className="product-grid" style={{ marginBottom: 20 }}>
          <div className="card product-card">
            <span className="tag">NT8</span>
            <h3>NinjaTrader 8 버전</h3>
            <p>NT8 PythonBridge 애드온과 연동. Market Replay 화면 자동화, 예약매매,
            실시간 손절/익절 지원.</p>
            <p className="product-note">🏢 프랍펌(자금 지원 트레이딩 회사)에서 특히 많이 쓰는 선물 트레이딩 플랫폼이에요.</p>
            <DownloadButton info={versions.ninja} app="ninja" />
          </div>
          <div className="card product-card">
            <span className="tag">MT5</span>
            <h3>MetaTrader 5 버전</h3>
            <p>MT5 공식 파이썬 API 연동. 계정 로그인 기반, 다양한 심볼 지원.</p>
            <p className="product-note">🌍 전 세계 CFD 브로커들이 표준으로 채택한 플랫폼이에요.</p>
            <DownloadButton info={versions.mt5} app="mt5" />
          </div>
        </div>

        <div className="section-title" style={{ marginTop: 48 }}>
          <h2>선물 거래가 처음이신가요?</h2>
          <p>주식과 뭐가 다른지, CME・CFD가 뭔지 간단히 정리했어요</p>
        </div>
        <div className="compare-grid">
          {MARKET_COMPARE.map((m, i) => (
            <div key={i} className="card compare-card">
              <h3>{m.title}</h3>
              <ul>
                {m.items.map((it, j) => <li key={j}>{it}</li>)}
              </ul>
            </div>
          ))}
        </div>
        <div className="glossary-grid" style={{ marginBottom: 48 }}>
          {GLOSSARY.map((g, i) => (
            <div key={i} className="card glossary-card">
              <div className="glossary-term">{g.term}<span>{g.label}</span></div>
              <p>{g.desc}</p>
            </div>
          ))}
        </div>

        <div className="section-title">
          <h2>이용 방법</h2>
          <p>신청부터 사용까지 4단계면 끝입니다</p>
        </div>
        <div className="card">
          <div className="steps">
            {STEPS.map((s, i) => (
              <div key={i} className="step">
                <div className="step-num">{i + 1}</div>
                <div>
                  <strong>{s.title}</strong>
                  <p>{s.desc}</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        <div className="cta-band">
          <h2>🎉 베타 오픈 기간, 일주일 무료체험</h2>
          <p>베타 오픈 기간 동안 신청하시면 일주일 무료체험이 제공됩니다. 지금 바로 경험해보세요.</p>
          <Link href="/apply" className="btn-cta primary">🎁 일주일 무료체험 신청하기</Link>
        </div>

        <AdSlot slot={footerSlot} label="하단 배너" style={{ marginTop: 20 }} />
        <footer className="site">
          문의: minssajang@gmail.com
          <Link href="/admin" className="admin-link">admin</Link>
        </footer>
      </div>
    </>
  )
}
