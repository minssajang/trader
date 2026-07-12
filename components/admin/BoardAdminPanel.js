import { useState, useEffect, useCallback } from 'react'
import { S, Toast } from './AdminUI'

export default function BoardAdminPanel({ adminToken }) {
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(true)
  const [selected, setSelected] = useState(null)
  const [toast, setToast] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/blog/posts?post_type=free&limit=100', {
        headers: { 'x-admin-token': adminToken },
      })
      const data = await res.json()
      setPosts(Array.isArray(data) ? data : [])
    } catch { showToast('❌ 불러오기 실패') }
    setLoading(false)
  }, [adminToken])

  useEffect(() => { load() }, [load])

  const handleDelete = async (id) => {
    if (!confirm('이 글을 삭제할까요?')) return
    try {
      const res = await fetch(`/api/blog/posts?id=${id}`, {
        method: 'DELETE', headers: { 'x-admin-token': adminToken },
      })
      if (!res.ok) throw new Error()
      showToast('🗑 삭제됨')
      setPosts(p => p.filter(x => x.id !== id))
      if (selected?.id === id) setSelected(null)
    } catch { showToast('❌ 삭제 실패') }
  }

  return (
    <div>
      <Toast msg={toast} />
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={S.cardTitle}>💬 자유게시판 관리</div>
          <button onClick={load} style={{ ...S.btnGhost, padding: '6px 14px', fontSize: 12 }}>🔄 새로고침</button>
        </div>

        {selected ? (
          <div>
            <button onClick={() => setSelected(null)} style={{
              width: 'auto', marginTop: 0, background: 'none', border: 'none', color: '#9aa0ab', fontSize: 14,
              cursor: 'pointer', marginBottom: 16, padding: 0,
            }}>← 목록으로</button>
            <div style={{ background: '#0f1115', borderRadius: 10, padding: 20, border: '1px solid #2a2e38' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
                {selected.is_secret && <span style={{ fontSize: 12, color: '#FFC107', background: 'rgba(255,193,7,0.1)', borderRadius: 4, padding: '2px 8px', border: '1px solid #FFC10744' }}>🔒 비밀글</span>}
                <h3 style={{ fontSize: 16, fontWeight: 800, color: '#e8eaed', margin: 0 }}>{selected.title}</h3>
              </div>
              <div style={{ fontSize: 12, color: '#9aa0ab', marginBottom: 16 }}>
                {selected.author_name || '익명'} · {selected.created_at ? new Date(new Date(selected.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ') : ''}
              </div>
              <div style={{ fontSize: 14, color: '#d4d4d4', lineHeight: 1.8, whiteSpace: 'pre-wrap', borderTop: '1px solid #2a2e38', paddingTop: 16 }}>
                {selected.content}
              </div>
              <div style={{ marginTop: 20, display: 'flex', justifyContent: 'flex-end' }}>
                <button onClick={() => handleDelete(selected.id)} style={{
                  width: 'auto', marginTop: 0, padding: '8px 16px', borderRadius: 8, border: '1px solid #F44336',
                  background: 'transparent', color: '#F44336', fontSize: 13, fontWeight: 600, cursor: 'pointer',
                }}>🗑 삭제</button>
              </div>
            </div>
          </div>
        ) : loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9aa0ab' }}>불러오는 중...</div>
        ) : posts.length === 0 ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', color: '#9aa0ab' }}>
            <div style={{ fontSize: 32, marginBottom: 10 }}>📭</div>
            아직 글이 없습니다.
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 0 }}>
            <div style={{
              display: 'grid', gridTemplateColumns: '1fr 80px 100px 60px',
              padding: '8px 12px', borderBottom: '1px solid #2a2e38',
              fontSize: 11, fontWeight: 700, color: '#9aa0ab',
            }}>
              <span>제목</span>
              <span style={{ textAlign: 'center' }}>작성자</span>
              <span style={{ textAlign: 'right' }}>날짜</span>
              <span></span>
            </div>
            {posts.map(post => (
              <div key={post.id} style={{
                display: 'grid', gridTemplateColumns: '1fr 80px 100px 60px',
                padding: '12px', borderBottom: '1px solid #2a2e38',
                alignItems: 'center',
              }}>
                <div
                  onClick={() => setSelected(post)}
                  style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer', minWidth: 0 }}
                >
                  {post.is_secret && <span style={{ fontSize: 12 }}>🔒</span>}
                  <span style={{
                    fontSize: 14, fontWeight: 600, color: '#e8eaed',
                    overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                  }}>{post.title}</span>
                </div>
                <div style={{ fontSize: 12, color: '#9aa0ab', textAlign: 'center' }}>{post.author_name || '익명'}</div>
                <div style={{ fontSize: 11, color: '#9aa0ab', textAlign: 'right' }}>
                  {post.created_at ? new Date(new Date(post.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '. ') + '.' : ''}
                </div>
                <div style={{ textAlign: 'right' }}>
                  <button onClick={() => handleDelete(post.id)} style={{
                    width: 'auto', marginTop: 0, padding: '4px 10px', borderRadius: 6, border: '1px solid #F44336',
                    background: 'transparent', color: '#F44336', fontSize: 11, cursor: 'pointer',
                  }}>삭제</button>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
