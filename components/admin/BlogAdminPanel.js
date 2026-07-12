import { useState, useEffect } from 'react'
import { S, ConfirmModal } from './AdminUI'

function slugify(text) {
  if (!text) return ''
  let r = text.trim().toLowerCase()
  if (/[가-힣]/.test(r)) {
    const eng = r.match(/[a-z0-9]+/g)
    return (eng && eng.join('').length >= 2) ? eng.join('-') : 'post-' + Date.now().toString(36)
  }
  return r.replace(/[^a-z0-9-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'post-' + Date.now().toString(36)
}

const emptyForm = { title: '', slug: '', summary: '', content: '', category: '', status: 'draft' }

export default function BlogAdminPanel({ adminToken, showToast }) {
  const [view, setView] = useState('list') // list | write
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(false)
  const [editId, setEditId] = useState(null)
  const [form, setForm] = useState(emptyForm)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/blog/posts?limit=100', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setPosts(Array.isArray(data) ? data : [])
    } catch {
      showToast?.('❌ 목록을 불러오지 못했습니다')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleNew = () => { setEditId(null); setForm(emptyForm); setView('write') }

  const handleEdit = (post) => {
    setEditId(post.id)
    setForm({
      title: post.title || '',
      slug: post.slug || '',
      summary: post.summary || '',
      content: post.content || '',
      category: post.category || '',
      status: post.status || 'draft',
    })
    setView('write')
  }

  const handleSave = async (status) => {
    if (!form.title.trim()) { showToast?.('❌ 제목을 입력하세요'); return }
    if (!form.content.trim()) { showToast?.('❌ 본문을 입력하세요'); return }
    setLoading(true)
    try {
      const slug = form.slug.trim() || slugify(form.title)
      const body = {
        title: form.title.trim(), slug,
        summary: form.summary.trim(), content: form.content,
        category: form.category.trim(), status,
      }
      const method = editId ? 'PUT' : 'POST'
      if (editId) body.id = editId
      const res = await fetch('/api/blog/posts', {
        method, headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error()
      showToast?.(status === 'published' ? '🚀 발행 완료' : '💾 임시저장 완료')
      setView('list'); setEditId(null); setForm(emptyForm)
      load()
    } catch {
      showToast?.('❌ 저장 실패')
    }
    setLoading(false)
  }

  const handleDelete = async (id) => {
    try {
      const res = await fetch(`/api/blog/posts?id=${id}`, { method: 'DELETE', headers: { 'x-admin-token': adminToken } })
      if (!res.ok) throw new Error()
      showToast?.('✅ 삭제되었습니다')
      load()
    } catch {
      showToast?.('❌ 삭제 실패')
    }
  }

  if (view === 'write') {
    return (
      <div style={S.card}>
        <div style={S.cardTitle}>{editId ? '✏️ 글 수정' : '📝 새 글 작성'}</div>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={S.label}>제목</label>
            <input value={form.title}
              onChange={e => setForm(v => ({ ...v, title: e.target.value, slug: v.slug || slugify(e.target.value) }))}
              style={S.input} placeholder="제목을 입력하세요" />
          </div>
          <div>
            <label style={S.label}>URL 슬러그</label>
            <input value={form.slug} onChange={e => setForm(v => ({ ...v, slug: e.target.value }))} style={S.input} placeholder="url-slug" />
          </div>
          <div>
            <label style={S.label}>카테고리</label>
            <input value={form.category} onChange={e => setForm(v => ({ ...v, category: e.target.value }))} style={S.input} placeholder="예: 전략 / 공지 / 가이드" />
          </div>
          <div>
            <label style={S.label}>요약</label>
            <input value={form.summary} onChange={e => setForm(v => ({ ...v, summary: e.target.value }))} style={S.input} placeholder="목록·검색결과에 보일 짧은 요약" />
          </div>
          <div>
            <label style={S.label}>본문 (마크다운)</label>
            <textarea value={form.content} onChange={e => setForm(v => ({ ...v, content: e.target.value }))}
              rows={18} style={{ ...S.input, fontFamily: 'monospace', resize: 'vertical', lineHeight: 1.7 }}
              placeholder={'# 제목\n\n본문을 마크다운으로 작성하세요.\n\n## 소제목\n\n- 항목 1\n- 항목 2'} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => { setView('list'); setEditId(null); setForm(emptyForm) }} style={S.btnGhost}>← 취소</button>
            <button onClick={() => handleSave('draft')} disabled={loading} style={S.btn('#555')}>💾 임시저장</button>
            <button onClick={() => handleSave('published')} disabled={loading} style={S.btn()}>🚀 발행</button>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div style={S.card}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div style={{ ...S.cardTitle, marginBottom: 0 }}>📝 블로그 관리 ({posts.length})</div>
        <button onClick={handleNew} style={S.btn()}>+ 새 글</button>
      </div>

      {loading && <div style={{ color: '#9aa0ab', fontSize: 14 }}>불러오는 중...</div>}
      {!loading && posts.length === 0 && <div style={{ color: '#9aa0ab', fontSize: 14 }}>아직 작성된 글이 없습니다</div>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {posts.map(post => (
          <div key={post.id} style={S.row}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
              <span style={{
                fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 10px',
                background: post.status === 'published' ? 'rgba(76,175,80,0.15)' : 'rgba(154,160,171,0.15)',
                color: post.status === 'published' ? '#4CAF50' : '#9aa0ab',
              }}>{post.status === 'published' ? '✅ 발행' : '📝 임시'}</span>
              {post.category && <span style={{ fontSize: 11, color: '#9aa0ab' }}>{post.category}</span>}
              <span style={{ fontWeight: 700, color: '#e8eaed', flex: 1, minWidth: 0 }}>{post.title}</span>
            </div>
            <div style={{ display: 'flex', gap: 6, marginTop: 8, flexWrap: 'wrap' }}>
              {post.status === 'published' && post.slug && (
                <a href={`/blog/${post.slug}`} target="_blank" rel="noopener noreferrer" style={{ ...S.btnGhost, textDecoration: 'none', padding: '4px 12px', fontSize: 12 }}>보기</a>
              )}
              <button onClick={() => handleEdit(post)} style={{ ...S.btnGhost, padding: '4px 12px', fontSize: 12 }}>수정</button>
              <button onClick={() => setDeleteTarget(post)} style={{ ...S.btnGhost, padding: '4px 12px', fontSize: 12, borderColor: '#F44336', color: '#F44336' }}>삭제</button>
            </div>
          </div>
        ))}
      </div>

      <ConfirmModal
        open={!!deleteTarget}
        title="확인"
        message={deleteTarget ? `"${deleteTarget.title}" 을(를) 삭제할까요?` : ''}
        danger
        confirmLabel="삭제"
        onCancel={() => setDeleteTarget(null)}
        onConfirm={() => { const t = deleteTarget; setDeleteTarget(null); if (t) handleDelete(t.id) }}
      />
    </div>
  )
}
