import { useState, useEffect } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { AdSlot } from '../../components/AdSlot'
import { useAdSlot } from '../../lib/AdSlotsContext'

export default function BoardIndex() {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const topSlot = useAdSlot('board_top')

  useEffect(() => {
    fetch('/api/board/posts?limit=50')
      .then(r => r.json())
      .then(d => setPosts(Array.isArray(d) ? d : []))
      .catch(() => setPosts([]))
      .finally(() => setLoading(false))
  }, [])

  return (
    <>
      <Head>
        <title>자유게시판 - 매매 시스템</title>
      </Head>
      <div className="wrap">
        <header className="site">
          <h1>자유게시판</h1>
          <nav className="site">
            <Link href="/">소개</Link>
            <Link href="/blog">블로그</Link>
            <Link href="/apply">신청</Link>
          </nav>
        </header>

        <AdSlot slot={topSlot} label="게시판 상단 배너" style={{ marginBottom: 20 }} />

        <section style={{ margin: '4px 0 24px', display: 'flex', justifyContent: 'flex-end' }}>
          <Link href="/board/write" style={{
            display: 'inline-block', width: 'auto', padding: '9px 18px',
            background: 'var(--accent)', color: '#fff', borderRadius: 8,
            fontWeight: 700, fontSize: 14, textDecoration: 'none',
          }}>✏️ 글쓰기</Link>
        </section>

        {loading && <p style={{ color: 'var(--muted)' }}>불러오는 중...</p>}
        {!loading && posts.length === 0 && (
          <div className="card"><p style={{ color: 'var(--muted)', margin: 0 }}>아직 글이 없어요. 첫 번째 글을 남겨보세요!</p></div>
        )}
        {!loading && posts.length > 0 && (
          <div style={{ border: '1px solid var(--border)', borderRadius: 12, overflow: 'hidden' }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 90px 100px',
              padding: '10px 16px', borderBottom: '1px solid var(--border)',
              fontSize: 12, fontWeight: 700, color: 'var(--muted)', background: 'var(--card)',
            }}>
              <span>제목</span>
              <span style={{ textAlign: 'center' }}>작성자</span>
              <span style={{ textAlign: 'right' }}>날짜</span>
            </div>
            {posts.map(post => (
              <Link key={post.id} href={`/board/${post.id}`}
                style={{
                  display: 'grid', gridTemplateColumns: '1fr 90px 100px',
                  padding: '14px 16px', borderBottom: '1px solid var(--border)',
                  alignItems: 'center', textDecoration: 'none', color: 'inherit',
                }}>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
                  {post.is_secret && <span style={{ fontSize: 13 }}>🔒</span>}
                  <span style={{ fontSize: 14, fontWeight: 600, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {post.title}
                  </span>
                </div>
                <div style={{ fontSize: 12, color: 'var(--muted)', textAlign: 'center' }}>{post.author_name || '익명'}</div>
                <div style={{ fontSize: 11, color: 'var(--muted)', textAlign: 'right' }}>
                  {new Date(new Date(post.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '. ') + '.'}
                </div>
              </Link>
            ))}
          </div>
        )}

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
