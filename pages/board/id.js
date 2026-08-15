import { useState, useEffect } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { useRouter } from 'next/router'

export default function BoardDetail() {
  const router = useRouter()
  const { id } = router.query
  const [post, setPost] = useState(null)
  const [needPassword, setNeedPassword] = useState(false)
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  const fetchPost = async (pw) => {
    setError('')
    try {
      const res = await fetch('/api/board/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password: pw }),
      })
      const data = await res.json()
      if (!res.ok) {
        if (data.needPassword || res.status === 401) {
          setNeedPassword(true)
          if (pw) setError(data.error)
        } else {
          setError(data.error || '오류가 발생했습니다')
        }
        return
      }
      setPost(data)
      setNeedPassword(false)
    } catch {
      setError('오류가 발생했습니다')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    if (!id) return
    setLoading(true)
    fetchPost()
  }, [id])

  const handleVerify = (e) => {
    e.preventDefault()
    fetchPost(password)
  }

  const handleDelete = async () => {
    const pw = post?.is_secret ? password : (prompt('비밀번호를 입력해주세요') || '')
    if (!pw) return
    if (!confirm('이 글을 삭제할까요?')) return
    try {
      const res = await fetch('/api/board/post', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, password: pw, action: 'delete' }),
      })
      const data = await res.json()
      if (!res.ok) return alert(data.error || '삭제 실패')
      alert('삭제되었습니다')
      router.push('/board')
    } catch {
      alert('삭제 실패')
    }
  }

  return (
    <>
      <Head><title>{post?.title || '자유게시판'} - EasyTrade</title></Head>
      <div className="wrap">
        <header className="site">
          <h1>자유게시판</h1>
          <nav className="site">
            <Link href="/board">목록</Link>
          </nav>
        </header>

        {loading ? (
          <div style={{ padding: '60px 0', textAlign: 'center', color: 'var(--muted)' }}>불러오는 중...</div>
        ) : needPassword ? (
          <div style={{ padding: '40px 0', maxWidth: 360, margin: '0 auto', textAlign: 'center' }}>
            <div style={{ fontSize: 32, marginBottom: 12 }}>🔒</div>
            <p style={{ fontSize: 14, color: 'var(--muted)', marginBottom: 20 }}>비밀글입니다. 비밀번호를 입력해주세요.</p>
            <form onSubmit={handleVerify} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
              <input
                type="password" autoFocus value={password} onChange={e => setPassword(e.target.value)}
                style={{ padding: '11px 14px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'var(--card)', color: 'var(--text)', fontSize: 14, textAlign: 'center' }}
                placeholder="비밀번호"
              />
              {error && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}
              <button type="submit" style={{ marginTop: 4 }}>확인</button>
            </form>
            <div style={{ marginTop: 24 }}>
              <Link href="/board">← 자유게시판 목록</Link>
            </div>
          </div>
        ) : !post ? (
          <div className="card">
            <p style={{ color: 'var(--muted)' }}>{error || '글을 찾을 수 없어요.'}</p>
            <Link href="/board">← 자유게시판 목록</Link>
          </div>
        ) : (
          <article>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
              {post.is_secret && <span style={{ fontSize: 12 }}>🔒</span>}
              <h1 style={{ fontSize: 'clamp(20px,4vw,26px)', fontWeight: 900, lineHeight: 1.3, margin: 0 }}>{post.title}</h1>
            </div>
            <p style={{ fontSize: 12, color: 'var(--muted)', marginBottom: 28 }}>
              {post.author_name || '익명'} ·{' '}
              {new Date(new Date(post.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '. ') + '.'}
            </p>

            <div style={{ fontSize: 15, lineHeight: 1.85, whiteSpace: 'pre-wrap', minHeight: 100 }}>
              {post.content}
            </div>

            <div style={{ marginTop: 40, paddingTop: 20, borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <Link href="/board">← 자유게시판 목록</Link>
              <button onClick={handleDelete}
                style={{ width: 'auto', marginTop: 0, padding: '7px 14px', borderRadius: 8, border: '1px solid var(--border)', background: 'transparent', color: 'var(--muted)', fontSize: 12 }}>
                🗑 삭제
              </button>
            </div>
          </article>
        )}

        <footer className="site">
          문의: minssajang@gmail.com
          <Link href="/admin" className="admin-link">admin</Link>
        </footer>
      </div>
    </>
  )
}
