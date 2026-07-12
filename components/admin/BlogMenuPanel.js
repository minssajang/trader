import { useState, useEffect } from 'react'
import { S } from './AdminUI'

const ICON_CHOICES = ['📁', '📈', '📊', '💡', '📝', '🔔', '⭐', '🎥', '📖', '🛒', '🔥', '🎉']

export default function BlogMenuPanel({ adminToken }) {
  const [categories, setCategories] = useState([])
  const [newCat, setNewCat] = useState('')
  const [newIcon, setNewIcon] = useState(ICON_CHOICES[0])
  const [msg, setMsg] = useState('')
  const [loading, setLoading] = useState(false)

  useEffect(() => { loadCategories() }, [])

  const loadCategories = async () => {
    try {
      const res = await fetch('/api/blog/categories', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setCategories(Array.isArray(data) ? data : [])
    } catch {}
  }

  const addCategory = async () => {
    const label = newCat.trim()
    if (!label) return
    if (categories.find(c => c.label === label)) {
      setMsg('❌ 이미 있는 카테고리예요'); setTimeout(() => setMsg(''), 2500); return
    }
    setLoading(true)
    try {
      const res = await fetch('/api/blog/categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ label, icon: newIcon }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.error || `HTTP ${res.status}`)
      }
      setNewCat(''); setNewIcon(ICON_CHOICES[0])
      setMsg('✅ 추가되었습니다'); setTimeout(() => setMsg(''), 2500)
      loadCategories()
    } catch (e) {
      setMsg(`❌ 추가 실패: ${e.message || '알 수 없는 오류'}`); setTimeout(() => setMsg(''), 4000)
    }
    setLoading(false)
  }

  const deleteCategory = async (id, label) => {
    if (!confirm(`"${label}" 카테고리를 삭제할까요?`)) return
    try {
      await fetch(`/api/blog/categories?id=${id}`, { method: 'DELETE', headers: { 'x-admin-token': adminToken } })
      setMsg('✅ 삭제되었습니다'); setTimeout(() => setMsg(''), 2500)
      loadCategories()
    } catch {
      setMsg('❌ 삭제 실패'); setTimeout(() => setMsg(''), 2500)
    }
  }

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>📂 블로그 카테고리 관리</div>
      <p style={{ color: '#9aa0ab', fontSize: 13, marginBottom: 16 }}>블로그 글에서 사용할 카테고리를 추가/삭제할 수 있어요.</p>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 12 }}>
        {ICON_CHOICES.map(ic => (
          <button key={ic} type="button" onClick={() => setNewIcon(ic)} style={{
            width: 34, height: 34, borderRadius: 8, fontSize: 16, cursor: 'pointer',
            display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 0, lineHeight: 1,
            background: newIcon === ic ? 'rgba(76,175,80,0.2)' : '#0f1115',
            border: newIcon === ic ? '1.5px solid #4CAF50' : '1.5px solid #2a2e38',
          }}>{ic}</button>
        ))}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        <input
          value={newCat}
          onChange={e => setNewCat(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && addCategory()}
          placeholder="새 카테고리 이름 (예: 전략, 공지, 가이드)"
          style={{ ...S.input, flex: 1 }}
        />
        <button onClick={addCategory} disabled={loading || !newCat.trim()} style={{ ...S.btn(), opacity: !newCat.trim() ? 0.4 : 1 }}>
          {newIcon} 추가
        </button>
      </div>

      {msg && (
        <div style={{
          padding: '10px 14px', borderRadius: 8, marginBottom: 16, fontSize: 13,
          background: msg.startsWith('✅') ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)',
          color: msg.startsWith('✅') ? '#4CAF50' : '#F44336',
        }}>{msg}</div>
      )}

      {categories.length === 0 ? (
        <div style={{ textAlign: 'center', padding: '32px 0', color: '#9aa0ab' }}>추가된 카테고리가 없습니다</div>
      ) : (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
          {categories.map(cat => (
            <div key={cat.id} style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '7px 10px 7px 16px', borderRadius: 999,
              background: '#0f1115', border: '1.5px solid #2a2e38',
            }}>
              <span style={{ fontSize: 13, fontWeight: 600, color: '#e8eaed' }}>{cat.icon || '📁'} {cat.label}</span>
              <button onClick={() => deleteCategory(cat.id, cat.label)} style={{
                background: 'none', border: 'none', cursor: 'pointer',
                color: '#9aa0ab', fontSize: 16, lineHeight: 1, padding: '0 2px',
                display: 'flex', alignItems: 'center',
              }}
                onMouseEnter={e => e.currentTarget.style.color = '#4CAF50'}
                onMouseLeave={e => e.currentTarget.style.color = '#9aa0ab'}
              >×</button>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
