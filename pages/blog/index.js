import { useState, useEffect, useMemo } from 'react'
import Head from 'next/head'
import Link from 'next/link'

export default function BlogIndex() {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [category, setCategory] = useState('')
  const [search, setSearch] = useState('')

  useEffect(() => {
    fetch('/api/blog/posts?limit=100')
      .then(r => r.json())
      .then(d => setPosts(Array.isArray(d) ? d : []))
      .catch(() => setPosts([]))
      .finally(() => setLoading(false))
  }, [])

  const categories = useMemo(
    () => [...new Set(posts.map(p => p.category).filter(Boolean))],
    [posts]
  )

  const filtered = useMemo(() => {
    return posts.filter(p => {
      if (category && p.category !== category) return false
      if (search && !(p.title.includes(search) || (p.summary || '').includes(search))) return false
      return true
    })
  }, [posts, category, search])

  return (
    <>
      <Head>
        <title>블로그 - 매매 시스템</title>
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

        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 20 }}>
          <button
            onClick={() => setCategory('')}
            style={{
              width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13,
              background: !category ? 'var(--accent)' : 'transparent',
              color: !category ? '#fff' : 'var(--muted)',
              border: '1px solid var(--border)', borderRadius: 999,
            }}>전체</button>
          {categories.map(c => (
            <button key={c} onClick={() => setCategory(c)}
              style={{
                width: 'auto', marginTop: 0, padding: '6px 14px', fontSize: 13,
                background: category === c ? 'var(--accent)' : 'transparent',
                color: category === c ? '#fff' : 'var(--muted)',
                border: '1px solid var(--border)', borderRadius: 999,
              }}>{c}</button>
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
          <div className="card"><p style={{ color: 'var(--muted)', margin: 0 }}>아직 글이 없습니다.</p></div>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map(post => (
            <Link key={post.id} href={`/blog/${post.slug}`} className="card"
              style={{ display: 'block', textDecoration: 'none', color: 'inherit' }}>
              {post.category && (
                <span className="badge active" style={{ marginBottom: 8, display: 'inline-block' }}>{post.category}</span>
              )}
              <h2 style={{ fontSize: 16, fontWeight: 700, margin: '0 0 8px' }}>{post.title}</h2>
              {post.summary && <p style={{ fontSize: 13, color: 'var(--muted)', margin: 0 }}>{post.summary}</p>}
              <p style={{ fontSize: 12, color: 'var(--muted)', marginTop: 10, marginBottom: 0 }}>
                {(post.published_at || post.created_at || '').slice(0, 10)}
              </p>
            </Link>
          ))}
        </div>

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
