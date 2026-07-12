import { useState } from 'react'
import Head from 'next/head'
import { useRouter } from 'next/router'
import Link from 'next/link'

const inputStyle = {
  width: '100%', padding: '11px 14px', borderRadius: 8,
  border: '1.5px solid var(--border)', background: 'var(--bg)',
  color: 'var(--text)', fontSize: 14, fontFamily: 'inherit',
}

export default function BoardWrite() {
  const router = useRouter()
  const [title, setTitle] = useState('')
  const [authorName, setAuthorName] = useState('')
  const [password, setPassword] = useState('')
  const [content, setContent] = useState('')
  const [isSecret, setIsSecret] = useState(false)
  const [error, setError] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const handleSubmit = async (e) => {
    e.preventDefault()
    setError('')
    if (!title.trim()) return setError('제목을 입력해주세요')
    if (!content.trim()) return setError('내용을 입력해주세요')
    if (password.length < 4) return setError('비밀번호는 4자 이상 입력해주세요')

    setSubmitting(true)
    try {
      const res = await fetch('/api/board/posts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          title, author_name: authorName, password, content, is_secret: isSecret,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '등록 실패')
      router.push(`/board/${data.id}`)
    } catch (err) {
      setError(err.message)
      setSubmitting(false)
    }
  }

  return (
    <>
      <Head><title>자유게시판 글쓰기 - 매매 시스템</title></Head>
      <div className="wrap">
        <header className="site">
          <h1>자유게시판 글쓰기</h1>
          <nav className="site">
            <Link href="/board">목록</Link>
          </nav>
        </header>

        <form onSubmit={handleSubmit} style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>제목</label>
            <input style={inputStyle} value={title} onChange={e => setTitle(e.target.value)} maxLength={100} placeholder="제목을 입력해주세요" />
          </div>

          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>작성자</label>
              <input style={inputStyle} value={authorName} onChange={e => setAuthorName(e.target.value)} maxLength={20} placeholder="익명" />
            </div>
            <div style={{ flex: 1 }}>
              <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>비밀번호</label>
              <input style={inputStyle} type="password" value={password} onChange={e => setPassword(e.target.value)} placeholder="4자 이상 (수정·삭제 시 필요)" />
            </div>
          </div>

          <div>
            <label style={{ display: 'block', fontSize: 12, fontWeight: 700, color: 'var(--muted)', marginBottom: 6 }}>내용</label>
            <textarea
              style={{ ...inputStyle, minHeight: 220, resize: 'vertical', lineHeight: 1.6 }}
              value={content}
              onChange={e => setContent(e.target.value)}
              placeholder="내용을 입력해주세요"
            />
          </div>

          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 13, color: 'var(--muted)', cursor: 'pointer' }}>
            <input type="checkbox" checked={isSecret} onChange={e => setIsSecret(e.target.checked)} style={{ width: 'auto' }} />
            🔒 비밀글로 작성 (비밀번호를 아는 사람만 볼 수 있어요)
          </label>

          {error && <div style={{ fontSize: 13, color: 'var(--danger)' }}>{error}</div>}

          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button type="button" onClick={() => router.push('/board')}
              style={{ width: 'auto', marginTop: 0, padding: '11px 20px', borderRadius: 8, border: '1.5px solid var(--border)', background: 'transparent', color: 'var(--muted)', fontSize: 14, fontWeight: 600 }}>
              취소
            </button>
            <button type="submit" disabled={submitting}
              style={{ flex: 1, marginTop: 0, padding: '11px 20px', opacity: submitting ? 0.6 : 1 }}>
              {submitting ? '등록 중...' : '등록하기'}
            </button>
          </div>
        </form>

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
