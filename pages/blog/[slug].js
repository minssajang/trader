import { useState, useEffect } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { parseMarkdown } from '../../lib/parseMarkdown'
import { AdSlot } from '../../components/AdSlot'
import { useAdSlot } from '../../lib/AdSlotsContext'

// ── 관련도 점수 계산: 같은 카테고리(+3), 태그(+2/개), 제목 키워드 겹침(+1/개)
function scoreRelated(post, allPosts) {
  if (!post || !Array.isArray(allPosts) || allPosts.length === 0) return []
  const others = allPosts.filter(p => p && p.id !== post.id)
  const scored = others.map(p => {
    let score = 0
    if (p.category && p.category === post.category) score += 3
    const postTags = Array.isArray(post.tags) ? post.tags : []
    const pTags = Array.isArray(p.tags) ? p.tags : []
    pTags.forEach(t => { if (postTags.includes(t)) score += 2 })
    const kw = (post.title || '').replace(/[^가-힣a-z0-9]/gi, ' ').split(/\s+/).filter(w => w.length > 1)
    kw.forEach(w => { if ((p.title || '').includes(w)) score += 1 })
    return { ...p, _score: score }
  })
  const ranked = [...scored].sort((a, b) => b._score - a._score || new Date(b.published_at || b.created_at) - new Date(a.published_at || a.created_at))
  const matched = ranked.filter(p => p._score > 0)
  const fallback = ranked.filter(p => p._score === 0)
  return [...matched, ...fallback]
}

const SITE_URL = 'https://trader-beta-liard.vercel.app'

export default function BlogPost({ post, html, allPosts }) {
  const relatedPool = post ? scoreRelated(post, allPosts).slice(0, 3) : []
  const middleSlot = useAdSlot('blog_middle')

  const [adminExtra, setAdminExtra] = useState(null)
  const [copiedField, setCopiedField] = useState('')
  useEffect(() => {
    if (!post?.slug) return
    let adminToken = ''
    try { adminToken = sessionStorage.getItem('admin_token') || '' } catch {}
    if (!adminToken) return
    fetch(`/api/blog/posts?slug=${post.slug}`, { headers: { 'x-admin-token': adminToken } })
      .then(r => r.ok ? r.json() : null)
      .then(data => {
        if (!data) return
        const { title_score, seo_score, title_score_detail, seo_score_detail, naver_summary, instagram_cards } = data
        setAdminExtra({ title_score, seo_score, title_score_detail, seo_score_detail, naver_summary, instagram_cards })
      })
      .catch(() => {})
  }, [post?.slug])

  const copyToClipboard = (field, text) => {
    if (!text) return
    try { navigator.clipboard.writeText(text); setCopiedField(field); setTimeout(() => setCopiedField(''), 1500) } catch {}
  }

  return (
    <>
      <Head>
        <title>{post ? `${post.title} - EasyTrade` : '글을 찾을 수 없습니다'}</title>
        <meta name="description" content={post?.summary || '트레이더 EasyTrade 블로그'} />
        <meta property="og:title" content={post ? `${post.title} - EasyTrade` : 'EasyTrade'} />
        <meta property="og:description" content={post?.summary || '트레이더 EasyTrade 블로그'} />
        {post?.cover_image && <meta property="og:image" content={post.cover_image} />}
        <meta property="og:url" content={`${SITE_URL}/blog/${post?.slug || ''}`} />
        <meta property="og:type" content="article" />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="canonical" href={`${SITE_URL}/blog/${post?.slug || ''}`} />
        {post && (
          <script type="application/ld+json" dangerouslySetInnerHTML={{
            __html: JSON.stringify({
              '@context': 'https://schema.org', '@type': 'BlogPosting',
              headline: post.title, description: post.summary || '',
              image: post.cover_image || undefined,
              datePublished: post.published_at || post.created_at || undefined,
              dateModified: post.updated_at || post.published_at || post.created_at || undefined,
              author: { '@type': 'Organization', name: post.author_name || '트레이더 편집팀' },
              mainEntityOfPage: { '@type': 'WebPage', '@id': `${SITE_URL}/blog/${post.slug}` },
            }),
          }} />
        )}
      </Head>
      <div className="wrap">
        <header className="site">
          <h1>블로그</h1>
          <nav className="site">
            <Link href="/">소개</Link>
            <Link href="/board">자유게시판</Link>
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
            {adminExtra && (
              <div style={{ marginBottom: 20, padding: '12px 16px', background: 'rgba(255,193,7,0.08)', border: '1px dashed #FFC107', borderRadius: 10, fontSize: 12.5, color: '#FFC107' }}>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, alignItems: 'center', fontWeight: 700, marginBottom: 10 }}>
                  <span>🔒 관리자 전용</span>
                  <span>제목 점수: {adminExtra.title_score != null ? `${adminExtra.title_score}/10` : '내용 없음'}</span>
                  <span>SEO 점수: {adminExtra.seo_score != null ? `${adminExtra.seo_score}/100` : '내용 없음'}</span>
                </div>

                {(Array.isArray(adminExtra.title_score_detail) && adminExtra.title_score_detail.length > 0) && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>📐 제목 점수 세부 근거</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {adminExtra.title_score_detail.map((row, i) => (
                        <li key={i} style={{ marginBottom: 4 }}><strong>{row.label}</strong> {row.points}/{row.max} — {row.reason}</li>
                      ))}
                    </ul>
                  </div>
                )}

                {(Array.isArray(adminExtra.seo_score_detail) && adminExtra.seo_score_detail.length > 0) && (
                  <div style={{ marginBottom: 10 }}>
                    <div style={{ fontWeight: 700, marginBottom: 4 }}>📐 SEO 체크리스트 세부 근거</div>
                    <ul style={{ margin: 0, paddingLeft: 18 }}>
                      {adminExtra.seo_score_detail.map((row, i) => (
                        <li key={i} style={{ marginBottom: 4 }}>{row.pass ? '✅' : '❌'} <strong>{row.label}</strong> {row.points}/{row.max} — {row.desc}</li>
                      ))}
                    </ul>
                  </div>
                )}

                <div style={{ marginBottom: 8 }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 700 }}>📋 네이버 블로그용 요약글</span>
                    {adminExtra.naver_summary && (
                      <button onClick={() => copyToClipboard('naver', adminExtra.naver_summary)}
                        style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, border: '1px solid #FFC107', background: copiedField === 'naver' ? '#FFC107' : 'transparent', color: copiedField === 'naver' ? '#000' : '#FFC107', cursor: 'pointer' }}>
                        {copiedField === 'naver' ? '복사됨!' : '복사'}
                      </button>
                    )}
                  </div>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 12.5, marginTop: 6, padding: 10, background: '#0f1115', borderRadius: 8, border: '1px solid #FFC10744' }}>
                    {adminExtra.naver_summary || '내용 없음'}
                  </pre>
                </div>

                <div>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 }}>
                    <span style={{ fontWeight: 700 }}>📱 인스타그램 카드뉴스 스크립트</span>
                    {adminExtra.instagram_cards && (
                      <button onClick={() => copyToClipboard('instagram', adminExtra.instagram_cards)}
                        style={{ fontSize: 11, fontWeight: 700, padding: '3px 10px', borderRadius: 999, border: '1px solid #FFC107', background: copiedField === 'instagram' ? '#FFC107' : 'transparent', color: copiedField === 'instagram' ? '#000' : '#FFC107', cursor: 'pointer' }}>
                        {copiedField === 'instagram' ? '복사됨!' : '복사'}
                      </button>
                    )}
                  </div>
                  <pre style={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', fontFamily: 'inherit', fontSize: 12.5, marginTop: 6, padding: 10, background: '#0f1115', borderRadius: 8, border: '1px solid #FFC10744' }}>
                    {adminExtra.instagram_cards || '내용 없음'}
                  </pre>
                </div>
              </div>
            )}

            {post.category && (
              <span className="badge active" style={{ marginBottom: 12, display: 'inline-block' }}>{post.category}</span>
            )}
            <h1 style={{ fontSize: 24, fontWeight: 800, marginBottom: 8 }}>{post.title}</h1>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 28 }}>
              {(post.published_at || post.created_at || '').slice(0, 10)}
            </p>

            {post.cover_image && (
              <img src={post.cover_image} alt={post.title} style={{ width: '100%', maxHeight: 320, objectFit: 'cover', borderRadius: 12, marginBottom: 28, display: 'block' }} />
            )}

            <div className="blog-content" style={{ fontSize: 15, lineHeight: 1.85 }}
              dangerouslySetInnerHTML={{ __html: html }} />

            <AdSlot slot={middleSlot} label="본문 중간 배너" style={{ margin: '32px 0' }} />

            {Array.isArray(post.tags) && post.tags.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 32, paddingTop: 24, borderTop: '1px solid var(--border)' }}>
                {post.tags.map((t, i) => (
                  <span key={i} style={{ fontSize: 12.5, fontWeight: 600, color: 'var(--muted)', background: 'var(--card)', border: '1px solid var(--border)', borderRadius: 999, padding: '5px 12px' }}>#{t}</span>
                ))}
              </div>
            )}

            {relatedPool.length > 0 && (
              <div style={{ marginTop: 48, paddingTop: 32, borderTop: '2px solid var(--border)' }}>
                <div style={{ fontSize: 17, fontWeight: 800, marginBottom: 16 }}>🤔 이런 글도 궁금하지 않으세요?</div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {relatedPool.map(p => (
                    <Link key={p.id} href={`/blog/${p.slug}`} className="card" style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
                      <div style={{ fontWeight: 700 }}>{p.title}</div>
                      {p.summary && <div style={{ fontSize: 12.5, color: 'var(--muted)', marginTop: 4 }}>{p.summary}</div>}
                    </Link>
                  ))}
                </div>
              </div>
            )}

            <div className="card" style={{ marginTop: 40, textAlign: 'center' }}>
              <h2 style={{ marginTop: 0 }}>🔑 EasyTrade 신청하기</h2>
              <p style={{ color: 'var(--muted)' }}>
                실시간 시세 연동, 스마트 자동 진입, 손절/익절 자동화까지 —
                NinjaTrader 8 / MetaTrader 5 자동매매 보조 프로그램을 지금 신청해보세요.
              </p>
              <Link href="/apply" style={{
                display: 'inline-block', marginTop: 12, padding: '12px 28px',
                background: 'var(--accent)', color: '#fff', borderRadius: 8,
                fontWeight: 700, textDecoration: 'none',
              }}>EasyTrade 신청하기 →</Link>
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
        .blog-content table { width: 100%; border-collapse: collapse; margin: 20px 0; font-size: 14px; }
        .blog-content th, .blog-content td { padding: 9px 14px; border: 1px solid var(--border); }
      `}</style>
    </>
  )
}

export async function getServerSideProps(context) {
  const { slug } = context.params
  try {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || `http://${context.req.headers.host}`
    const res = await fetch(`${baseUrl}/api/blog/posts?slug=${encodeURIComponent(slug)}`)
    if (!res.ok) return { props: { post: null, html: '', allPosts: [] } }
    const post = await res.json()
    if (!post) return { props: { post: null, html: '', allPosts: [] } }
    const html = parseMarkdown(post.content || '')

    let allPosts = []
    try {
      const listRes = await fetch(`${baseUrl}/api/blog/posts?limit=100`)
      if (listRes.ok) allPosts = await listRes.json()
    } catch {}

    return { props: { post, html, allPosts: Array.isArray(allPosts) ? allPosts : [] } }
  } catch (error) {
    console.error('블로그 상세 SSR 에러:', error)
    return { props: { post: null, html: '', allPosts: [] } }
  }
}
