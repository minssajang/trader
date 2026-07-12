import Head from 'next/head'
import Link from 'next/link'
import { AdSlot } from '../components/AdSlot'
import { useAdSlot } from '../lib/AdSlotsContext'

const FEATURES = [
  { icon: '⚡', title: '실시간 시세 연동', desc: '지연 없이 실시간 시세를 받아 즉시 판단하고 반응합니다.' },
  { icon: '📈', title: 'HMA 크로스 예약 진입', desc: '이동평균선 교차 시점을 자동으로 포착해 예약 진입합니다.' },
  { icon: '🛡️', title: '손절/익절 자동화', desc: '이동평균선 기반 손절·익절 모드로 리스크를 관리합니다.' },
  { icon: '🔁', title: 'Market Replay 연동', desc: '과거 시세 재생 화면에서도 동일하게 자동화를 테스트합니다.' },
]

const STEPS = [
  { title: '신청', desc: <><Link href="/apply">신청 페이지</Link>에서 이름/이메일/제품/기간을 입력해 신청합니다.</> },
  { title: '입금', desc: '안내되는 계좌로 입금합니다.' },
  { title: '라이선스 발급', desc: '입금 확인 후 이메일로 라이선스 키를 보내드립니다.' },
  { title: '바로 사용', desc: '매매 프로그램 실행 시 라이선스 키를 입력하면 남은 기간이 표시되며 사용 가능합니다.' },
  { title: '상태 확인', desc: <><Link href="/check">내 정보 조회</Link>에서 이름/이메일로 언제든 상태를 확인할 수 있습니다.</> },
]

export default function Home() {
  const topSlot = useAdSlot('home_top')
  const footerSlot = useAdSlot('footer')

  return (
    <>
      <Head>
        <title>닌자 트레이더 매매 시스템</title>
        <meta name="description" content="실시간 시세 연동, HMA 크로스 예약 진입, 손절/익절 자동화까지 지원하는 NinjaTrader 8 / MetaTrader 5 자동매매 보조 프로그램" />
      </Head>
      <div className="landing-wrap">
        <header className="site">
          <div className="brand">매매 시스템</div>
          <nav className="site">
            <Link href="/blog">블로그</Link>
            <Link href="/board">자유게시판</Link>
            <Link href="/apply">신청</Link>
            <Link href="/check">내 정보 조회</Link>
            <Link href="/admin">관리자</Link>
          </nav>
        </header>

        <AdSlot slot={topSlot} label="상단 배너" style={{ marginBottom: 20 }} />

        <section className="hero">
          <span className="hero-badge">🟢 NinjaTrader 8 · MetaTrader 5 지원</span>
          <h1>감정 없는 매매,<br />시스템이 대신합니다</h1>
          <p>
            실시간 시세 연동부터 HMA 크로스 예약 진입, 손절/익절 자동화까지 —
            지금 바로 쓸 수 있는 자동매매 보조 프로그램입니다.
          </p>
          <div className="hero-ctas">
            <Link href="/apply" className="btn-cta primary">🚀 지금 신청하기</Link>
            <Link href="/blog" className="btn-cta ghost">블로그 둘러보기</Link>
          </div>
        </section>

        <div className="section-title">
          <h2>무엇을 할 수 있나요</h2>
          <p>매매 판단은 그대로, 실행만 시스템에게 맡기세요</p>
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
        <div className="product-grid" style={{ marginBottom: 48 }}>
          <div className="card product-card">
            <span className="tag">NT8</span>
            <h3>NinjaTrader 8 버전</h3>
            <p>NT8 PythonBridge 애드온과 연동. Market Replay 화면 자동화, HMA 크로스 예약,
            실시간 이동평균선 손절/익절 지원.</p>
          </div>
          <div className="card product-card">
            <span className="tag">MT5</span>
            <h3>MetaTrader 5 버전</h3>
            <p>MT5 공식 파이썬 API 연동. 계정 로그인 기반, 다양한 심볼 지원.</p>
          </div>
        </div>

        <div className="section-title">
          <h2>이용 방법</h2>
          <p>신청부터 사용까지 5단계면 끝입니다</p>
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
          <h2>지금 바로 시작해보세요</h2>
          <p>신청 후 입금 확인만 되면 당일 라이선스가 발급됩니다.</p>
          <Link href="/apply" className="btn-cta primary">🚀 지금 신청하기</Link>
        </div>

        <AdSlot slot={footerSlot} label="하단 배너" style={{ marginTop: 20 }} />
        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
