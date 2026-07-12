import Head from 'next/head'
import Link from 'next/link'

export default function Home() {
  return (
    <>
      <Head>
        <title>닌자 트레이더 매매 시스템</title>
      </Head>
      <div className="wrap">
        <header className="site">
          <h1>매매 시스템</h1>
          <nav className="site">
            <Link href="/blog">블로그</Link>
            <Link href="/apply">신청</Link>
            <Link href="/check">내 정보 조회</Link>
            <Link href="/admin">관리자</Link>
          </nav>
        </header>

        <div className="card">
          <h2>소개</h2>
          <p>실시간 시세 연동, HMA 기반 크로스 예약 진입, 손절/익절 이동평균선 모드, Market Replay
          연동까지 지원하는 자동매매 보조 프로그램입니다. NinjaTrader 8 / MetaTrader 5 두 가지
          버전을 제공합니다.</p>
        </div>

        <div className="product-grid">
          <div className="product-card">
            <span className="tag">NT8</span>
            <h3>NinjaTrader 8 버전</h3>
            <p>NT8 PythonBridge 애드온과 연동. Market Replay 화면 자동화, HMA 크로스 예약,
            실시간 이동평균선 손절/익절 지원.</p>
          </div>
          <div className="product-card">
            <span className="tag">MT5</span>
            <h3>MetaTrader 5 버전</h3>
            <p>MT5 공식 파이썬 API 연동. 계정 로그인 기반, 다양한 심볼 지원.</p>
          </div>
        </div>

        <div className="card">
          <h2>이용 방법</h2>
          <ol>
            <li><Link href="/apply">신청 페이지</Link>에서 이름/이메일/제품/기간을 입력해 신청합니다.</li>
            <li>안내되는 계좌로 입금합니다.</li>
            <li>입금 확인 후 이메일로 라이선스 키를 보내드립니다.</li>
            <li>매매 프로그램 실행 시 라이선스 키를 입력하면 남은 기간이 표시되며 사용 가능합니다.</li>
            <li><Link href="/check">내 정보 조회</Link>에서 이름/이메일로 언제든 상태를 확인할 수 있습니다.</li>
          </ol>
        </div>

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
