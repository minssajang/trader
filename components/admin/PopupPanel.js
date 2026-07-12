import { useState, useEffect, useCallback } from 'react'
import { S } from './AdminUI'

function fmtDate(iso) {
  if (!iso) return '-'
  const d = new Date(iso)
  return `${d.getFullYear()}.${String(d.getMonth() + 1).padStart(2, '0')}.${String(d.getDate()).padStart(2, '0')}`
}

function AddPopupModal({ onClose, onSave }) {
  const [form, setForm] = useState({
    title: '', content: '', link_url: '', link_label: '자세히 보기',
    bg_color: '#171a21', text_color: '#e8eaed',
    expires_at: '', is_active: true,
  })
  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  return (
    <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.6)', zIndex: 9000, display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
      <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 28, width: 500, maxHeight: '90vh', overflowY: 'auto', boxShadow: '0 20px 60px rgba(0,0,0,0.4)' }}>
        <div style={{ fontSize: 16, fontWeight: 700, marginBottom: 20, color: '#e8eaed' }}>📢 팝업 추가</div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
          <div>
            <label style={S.label}>제목 *</label>
            <input value={form.title} onChange={e => set('title', e.target.value)} style={S.input} placeholder="팝업 제목" />
          </div>
          <div>
            <label style={S.label}>내용 *</label>
            <textarea value={form.content} onChange={e => set('content', e.target.value)} rows={4} style={{ ...S.input, resize: 'vertical' }} placeholder="팝업에 표시할 내용" />
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>링크 URL (선택)</label>
              <input value={form.link_url} onChange={e => set('link_url', e.target.value)} style={S.input} placeholder="https://..." />
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>링크 버튼 텍스트</label>
              <input value={form.link_label} onChange={e => set('link_label', e.target.value)} style={S.input} placeholder="자세히 보기" />
            </div>
          </div>
          <div style={{ display: 'flex', gap: 10 }}>
            <div style={{ flex: 1 }}>
              <label style={S.label}>배경색</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="color" value={form.bg_color} onChange={e => set('bg_color', e.target.value)} style={{ width: 40, height: 36, border: '1px solid #2a2e38', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                <input value={form.bg_color} onChange={e => set('bg_color', e.target.value)} style={{ ...S.input, flex: 1 }} />
              </div>
            </div>
            <div style={{ flex: 1 }}>
              <label style={S.label}>텍스트색</label>
              <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                <input type="color" value={form.text_color} onChange={e => set('text_color', e.target.value)} style={{ width: 40, height: 36, border: '1px solid #2a2e38', borderRadius: 6, cursor: 'pointer', padding: 2 }} />
                <input value={form.text_color} onChange={e => set('text_color', e.target.value)} style={{ ...S.input, flex: 1 }} />
              </div>
            </div>
          </div>
          <div>
            <label style={S.label}>만료일 (비우면 무기한)</label>
            <input type="date" value={form.expires_at} onChange={e => set('expires_at', e.target.value)} style={S.input} />
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <input type="checkbox" id="is_active" checked={form.is_active} onChange={e => set('is_active', e.target.checked)} style={{ width: 16, height: 16, cursor: 'pointer' }} />
            <label htmlFor="is_active" style={{ fontSize: 14, color: '#e8eaed', cursor: 'pointer' }}>즉시 활성화</label>
          </div>

          <div>
            <label style={S.label}>미리보기</label>
            <div style={{ background: form.bg_color, color: form.text_color, border: '1px solid #2a2e38', borderRadius: 10, padding: 20, maxWidth: 360, margin: '0 auto', boxShadow: '0 4px 20px rgba(0,0,0,0.3)' }}>
              <div style={{ fontWeight: 700, fontSize: 15, marginBottom: 8 }}>{form.title || '제목'}</div>
              <div style={{ fontSize: 13, lineHeight: 1.6, whiteSpace: 'pre-wrap' }}>{form.content || '내용'}</div>
              {form.link_url && (
                <div style={{ marginTop: 12 }}>
                  <span style={{ fontSize: 12, fontWeight: 700, padding: '6px 14px', borderRadius: 6, background: '#4CAF50', color: '#fff' }}>{form.link_label}</span>
                </div>
              )}
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={S.btnGhost}>취소</button>
          <button onClick={() => { if (form.title.trim() && form.content.trim()) onSave(form) }}
            disabled={!form.title.trim() || !form.content.trim()}
            style={{ ...S.btn(), opacity: form.title.trim() && form.content.trim() ? 1 : 0.4 }}>저장</button>
        </div>
      </div>
    </div>
  )
}

export default function PopupPanel({ adminToken }) {
  const [popups, setPopups] = useState([])
  const [loading, setLoading] = useState(true)
  const [showAdd, setShowAdd] = useState(false)
  const [toast, setToast] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200) }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/popups', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      if (Array.isArray(data.popups)) setPopups(data.popups)
    } catch {}
    setLoading(false)
  }, [adminToken])

  useEffect(() => { load() }, [load])

  const addPopup = async (form) => {
    setShowAdd(false)
    const res = await fetch('/api/admin/popups', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify(form),
    })
    if (res.ok) { showToast('✅ 팝업 추가됨'); load() }
  }

  const toggleActive = async (id, current) => {
    await fetch('/api/admin/popups', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ action: 'toggle', id, is_active: !current }),
    })
    setPopups(prev => prev.map(p => p.id === id ? { ...p, is_active: !current } : p))
    showToast(!current ? '✅ 활성화됨' : '⏸ 비활성화됨')
  }

  const deletePopup = async (id) => {
    if (!confirm('팝업을 삭제할까요?')) return
    await fetch('/api/admin/popups', {
      method: 'DELETE',
      headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
      body: JSON.stringify({ id }),
    })
    setPopups(prev => prev.filter(p => p.id !== id))
    showToast('삭제됨')
  }

  const activeCount = popups.filter(p => p.is_active).length

  return (
    <div>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
        <div>
          <div style={{ fontSize: 17, fontWeight: 700, color: '#e8eaed' }}>📢 팝업 관리</div>
          <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 3 }}>활성 팝업 <span style={{ color: '#4CAF50', fontWeight: 700 }}>{activeCount}개</span> / 전체 {popups.length}개</div>
        </div>
        <button onClick={() => setShowAdd(true)} style={S.btn()}>+ 팝업 추가</button>
      </div>

      {loading ? (
        <div style={{ color: '#9aa0ab', textAlign: 'center', padding: '40px 0' }}>불러오는 중...</div>
      ) : popups.length === 0 ? (
        <div style={{ color: '#9aa0ab', textAlign: 'center', padding: '60px 0' }}>
          <div style={{ fontSize: 32, marginBottom: 12 }}>📢</div>
          <div style={{ marginBottom: 16 }}>등록된 팝업이 없어요</div>
          <button onClick={() => setShowAdd(true)} style={S.btn()}>+ 첫 팝업 추가하기</button>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {popups.map(p => (
            <div key={p.id} style={{
              background: '#171a21', border: `1px solid ${p.is_active ? '#4CAF5044' : '#2a2e38'}`,
              borderLeft: `4px solid ${p.is_active ? '#4CAF50' : '#2a2e38'}`,
              borderRadius: 10, padding: '16px 18px', opacity: p.is_active ? 1 : 0.6,
            }}>
              <div style={{ display: 'flex', alignItems: 'flex-start', gap: 12 }}>
                <div style={{ width: 40, height: 40, borderRadius: 8, flexShrink: 0, background: p.bg_color || '#171a21', border: '1px solid #2a2e38', display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 16 }}>📢</div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
                    <span style={{ fontWeight: 700, fontSize: 14, color: '#e8eaed' }}>{p.title}</span>
                    <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 10, background: p.is_active ? 'rgba(76,175,80,0.15)' : 'rgba(154,160,171,0.15)', color: p.is_active ? '#4CAF50' : '#9aa0ab' }}>{p.is_active ? '활성' : '비활성'}</span>
                    {p.expires_at && <span style={{ fontSize: 11, color: '#FFC107' }}>~{fmtDate(p.expires_at)}</span>}
                  </div>
                  <div style={{ fontSize: 13, color: '#9aa0ab', lineHeight: 1.5, marginBottom: 4 }}>{p.content}</div>
                  {p.link_url && <div style={{ fontSize: 12, color: '#4CAF50' }}>🔗 {p.link_url}</div>}
                  <div style={{ fontSize: 11, color: '#666', marginTop: 4 }}>등록 {fmtDate(p.created_at)}</div>
                </div>
                <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                  <button onClick={() => toggleActive(p.id, p.is_active)} style={{ background: 'none', border: `1px solid ${p.is_active ? '#F4433644' : '#4CAF5044'}`, borderRadius: 7, color: p.is_active ? '#F44336' : '#4CAF50', cursor: 'pointer', padding: '5px 10px', fontSize: 12, fontWeight: 700, width: 'auto', marginTop: 0 }}>
                    {p.is_active ? '비활성화' : '활성화'}
                  </button>
                  <button onClick={() => deletePopup(p.id)} style={{ background: 'none', border: '1px solid #F4433644', borderRadius: 7, color: '#F44336', cursor: 'pointer', padding: '5px 9px', fontSize: 13, width: 'auto', marginTop: 0 }}>×</button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && <AddPopupModal onClose={() => setShowAdd(false)} onSave={addPopup} />}

      {toast && (
        <div style={{ position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)', background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, padding: '12px 22px', fontSize: 14, color: '#e8eaed', zIndex: 9999, boxShadow: '0 8px 24px rgba(0,0,0,0.4)' }}>{toast}</div>
      )}
    </div>
  )
}
