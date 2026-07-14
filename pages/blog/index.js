import { useState, useEffect, useMemo } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { AdSlot } from '../../components/AdSlot'
import { useAdSlot } from '../../lib/AdSlotsContext'
import BrandLogo from '../../components/BrandLogo'

export default function BlogIndex() {
  const [posts, setPosts] = useState([])
  const [customCategories, setCustomCategories] = useState([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')
  const topSlot = useAdSlot('blog_top')
  const footerSlot = useAdSlot('footer')

  useEffect(() => {
    fetch('/api/blog/categories').then(r => r.json())
      .then(d => setCustomCategories(Array.isArray(d) ? d : []))
      .catch(() => setCustomCategories([]))
  }, [])

  useEffect(() => {
    fetch('/api/blog/posts?limit=100')
      .then(r => r.json())
      .then(d => setPosts(Array.isArray(d) ? d : []))
      .catch(() => setPosts([]))
      .finally(() => setLoading(false))
  }, [])

  const filtered = useMemo(() => {
    return posts.filter(p => {
      if (category && p.category !== category) return false
      if (search && !(p.title.includes(search) || (p.summary || '').includes(search))) return false
      return true
    })
  }, [posts, category, search])

  const catIcon = (label) => customCategories.find(c => c.label === label)?.icon || '📁'

  return (
    <>
      <Head>
        <title>블로그 - EasyTrade</title>
        <meta name="description" content="트레이더 EasyTrade 블로그 — 전략, 공지, 가이드" />
      </Head>
      <div className="wrap">
        <header className="site">
          <BrandLogo label="블로그" />
          <nav className="site">
            <Link href="/">소개</Link>
            <Link href="/board">자유게시판</Link>
            <Link href="/apply">신청</Link>
            <Link href="/check">내 정보 조회</Link>
          </nav>
        </header>

        <AdSlot slot={topSlot} label="블로그 상단 배너" style={{ marginBottom: 20 }} />

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          <button
            onClick={() => setCategory('')}
            style={{
              width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13,
              background: !category ? 'var(--accent)' : 'transparent',
              color: !category ? '#fff' : 'var(--muted)',
              border: '1px solid var(--border)', borderRadius: 999,
            }}>전체</button>
          {customCategories.map(c => (
            <button key={c.id} onClick={() => setCategory(c.label)}
              style={{
                width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13,
                background: category === c.label ? 'var(--accent)' : 'transparent',
                color: category === c.label ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: 999,
              }}>{c.icon || '📁'} {c.label}</button>
          ))}
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="🔍 제목·내용 검색"
            style={{ flex: '1 1 200px', minWidth: 160, padding: '8px 12px' }}
          />
        </div>

        {loading && <p style={{ color: 'var(--muted)' }}>불러오는 중...</p>}
        {!loading && filtered.length === 0 && (
          <div className="card"><p style={{ color: 'var(--muted)', margin: 0 }}>{search ? `"${search}"에 대한 검색 결과가 없어요.` : '아직 글이 없습니다.'}</p></div>
        )}

        <div className="blog-grid">
          {filtered.map(post => (
            <Link key={post.id} href={`/blog/${post.slug}`} className="card"
              style={{ display: 'flex', flexDirection: 'column', textDecoration: 'none', color: 'inherit', padding: 0, margin: 0, overflow: 'hidden' }}>
              {post.cover_image && (
                <img src={post.cover_image} alt={post.title} referrerPolicy="no-referrer"
                  style={{ width: '100%', height: 160, objectFit: 'cover', flexShrink: 0 }} />
              )}
              <div style={{ minWidth: 0, flex: 1, padding: 16 }}>
                {post.category && (
                  <span className="badge active" style={{ marginBottom: 8, display: 'inline-block' }}>{catIcon(post.category)} {post.category}</span>
                )}
                <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{post.title}</h2>
                {post.summary && <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{post.summary}</p>}
                {Array.isArray(post.tags) && post.tags.length > 0 && (
                  <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginTop: 8 }}>
                    {post.tags.slice(0, 5).map((t, i) => (
                      <span key={i} style={{ fontSize: 11, color: 'var(--accent)', background: 'rgba(76,175,80,0.1)', borderRadius: 999, padding: '2px 8px' }}>#{t}</span>
                    ))}
                  </div>
                )}
                <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, marginBottom: 0 }}>
                  {(post.published_at || post.created_at || '').slice(0, 10)}
                </p>
              </div>
            </Link>
          ))}
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
