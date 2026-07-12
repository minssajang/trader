import Head from 'next/head'
import Link from 'next/link'
import { parseMarkdown } from '../../lib/parseMarkdown'

export default function BlogPost({ post, html }) {
  return (
    <>
      <Head>
        <title>{post ? `${post.title} - 매매 시스템` : '글을 찾을 수 없습니다'}</title>
        {post?.summary && <meta name="description" content={post.summary} />}
      </Head>
      <div className="wrap">
        <header className="site">
          <h1>블로그</h1>
          <nav className="site">
            <Link href="/">소개</Link>
            <Link href="/apply">신청</Link>
            <Link href="/check">내 정보 조회</Link>
          </nav>
        </header>

        {!post ? (
          <div className="card">
            <p style={{ color: 'var(--muted)' }}>글을 찾을 수 없어요.</p>
            <Link href="/blog">← 블로그 목록</Link>
          </div>
        ) : (
          <article>
            {post.category && (
              <span className="badge active" style={{ marginBottom: 12, display: 'inline-block' }}>{post.category}</span>
            )}
            <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>{post.title}</h1>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 28 }}>
              {(post.published_at || post.created_at || '').slice(0, 10)}
            </p>

            <div className="blog-content" style={{ fontSize: 15, lineHeight: 1.85 }}
              dangerouslySetInnerHTML={{ __html: html }} />

            <div className="card" style={{ marginTop: 40, textAlign: 'center' }}>
              <h2 style={{ marginTop: 0 }}>🔑 매매 시스템 신청하기</h2>
              <p style={{ color: 'var(--muted)' }}>
                실시간 시세 연동, HMA 기반 크로스 예약 진입, 손절/익절 이동평균선 모드까지 —
                NinjaTrader 8 / MetaTrader 5 자동매매 보조 프로그램을 지금 신청해보세요.
              </p>
              <Link href="/apply" style={{
                display: 'inline-block', marginTop: 12, padding: '12px 28px',
                background: 'var(--accent)', color: '#fff', borderRadius: 8,
                fontWeight: 700, textDecoration: 'none',
              }}>매매 시스템 신청하기 →</Link>
            </div>

            <div style={{ marginTop: 32 }}>
              <Link href="/blog">← 블로그 목록</Link>
            </div>
          </article>
        )}

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>

      <style>{`
        .blog-content img { max-width: 100%; }
        .blog-content a { color: var(--accent); }
        .blog-content h1, .blog-content h2, .blog-content h3, .blog-content h4 { color: var(--text); }
      `}</style>
    </>
  )
}

export async function getServerSideProps(context) {
  const { slug } = context.params
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `http://${context.req.headers.host}`
    const res = await fetch(`${baseUrl}/api/blog/posts?slug=${encodeURIComponent(slug)}`)
    if (!res.ok) return { props: { post: null, html: '' } }
    const post = await res.json()
    if (!post) return { props: { post: null, html: '' } }
    const html = parseMarkdown(post.content || '')
    return { props: { post, html } }
  } catch (error) {
    console.error('블로그 상세 SSR 에러:', error)
    return { props: { post: null, html: '' } }
  }
}
