import { useEffect, useState, useCallback } from 'react'
import { S, Toggle, ConfirmModal } from './AdminUI'

const ACCENT = '#ea580c'
const ALL_TAB = { id: '', label: '전체' }

const emptyProduct = (categoryId) => ({
  id: null, label: '', url: '', banner_html: '', banner_html_blog: '', category_id: categoryId || '', enabled: true,
})

export default function CoupangProductsPanel({ adminToken }) {
  const [categories, setCategories] = useState([])
  const [activeTab, setActiveTab] = useState('')
  const [newTab, setNewTab] = useState('')
  const [addingTab, setAddingTab] = useState(false)
  const [conceptDraft, setConceptDraft] = useState('')
  const [savingConcept, setSavingConcept] = useState(false)
  const [conceptSaved, setConceptSaved] = useState(false)

  const [products, setProducts] = useState([])
  const [loadingProducts, setLoadingProducts] = useState(true)
  const [editing, setEditing] = useState(null)
  const [saving, setSaving] = useState(false)
  const [deleteTarget, setDeleteTarget] = useState(null)

  const activeCategory = categories.find(c => c.id === activeTab) || null

  const loadCategories = async () => {
    try {
      const res = await fetch('/api/admin/coupang-product-categories')
      const data = await res.json()
      setCategories(Array.isArray(data) ? data : [])
    } catch { setCategories([]) }
  }

  useEffect(() => { loadCategories() }, [])

  useEffect(() => {
    setConceptDraft(activeCategory?.concept || '')
    setConceptSaved(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeCategory?.concept])

  const loadProducts = useCallback(async () => {
    setLoadingProducts(true)
    try {
      const res = await fetch(`/api/admin/coupang-products${activeTab ? `?category_id=${activeTab}` : ''}`)
      const data = await res.json()
      setProducts(Array.isArray(data) ? data : [])
    } catch { setProducts([]) }
    setLoadingProducts(false)
  }, [activeTab])

  useEffect(() => { loadProducts(); setEditing(null) }, [loadProducts])

  const addTab = async () => {
    const label = newTab.trim()
    if (!label || categories.find(c => c.label === label)) { setNewTab(''); return }
    setAddingTab(true)
    try {
      const res = await fetch('/api/admin/coupang-product-categories', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ label }),
      })
      if (res.ok) {
        const created = await res.json()
        setCategories(p => [...p, created])
        setActiveTab(created.id)
        setNewTab('')
      }
    } catch {}
    setAddingTab(false)
  }

  const deleteTab = async (id, label) => {
    if (!confirm(`"${label}" 탭을 삭제할까요? (이 탭에 등록된 상품은 삭제되지 않고 '전체'에서 계속 보여요)`)) return
    try {
      await fetch(`/api/admin/coupang-product-categories?id=${id}`, {
        method: 'DELETE', headers: { 'x-admin-token': adminToken },
      })
      setCategories(p => p.filter(c => c.id !== id))
      if (activeTab === id) setActiveTab('')
    } catch {}
  }

  const saveConcept = async () => {
    if (!activeTab) return
    setSavingConcept(true)
    try {
      const res = await fetch('/api/admin/coupang-product-categories', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ id: activeTab, concept: conceptDraft }),
      })
      if (res.ok) {
        setCategories(p => p.map(c => c.id === activeTab ? { ...c, concept: conceptDraft } : c))
        setConceptSaved(true)
        setTimeout(() => setConceptSaved(false), 2000)
      }
    } catch {}
    setSavingConcept(false)
  }

  const setField = (k, v) => setEditing(p => ({ ...p, [k]: v }))

  const saveProduct = async () => {
    if (!editing) return
    setSaving(true)
    try {
      const isNew = !editing.id
      const res = await fetch('/api/admin/coupang-products', {
        method: isNew ? 'POST' : 'PUT',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify(editing),
      })
      if (!res.ok) throw new Error()
      await loadProducts()
      setEditing(null)
    } catch {
      alert('저장 실패')
    }
    setSaving(false)
  }

  const confirmDelete = async () => {
    if (!deleteTarget) return
    try {
      await fetch(`/api/admin/coupang-products?id=${deleteTarget}`, {
        method: 'DELETE', headers: { 'x-admin-token': adminToken },
      })
      setProducts(p => p.filter(x => x.id !== deleteTarget))
      if (editing?.id === deleteTarget) setEditing(null)
    } catch {}
    setDeleteTarget(null)
  }

  const tabs = [ALL_TAB, ...categories]
  const categoryOptions = [{ value: '', label: '(미분류)' }, ...categories.map(c => ({ value: c.id, label: c.label }))]

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#e8eaed' }}>📦 쿠팡상품</div>
        <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 3 }}>
          블로그 글 등에 수동으로 붙여넣어 쓸 쿠팡 상품을 등록해두는 목록입니다. (자동 판매/노출 기능 아님)
        </div>
      </div>

      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginBottom: 16 }}>
        {tabs.map(tab => (
          <div key={tab.id || 'all'} style={{ display: 'flex', alignItems: 'center' }}>
            <button onClick={() => setActiveTab(tab.id)} style={{
              padding: '7px 14px', borderRadius: 999, fontSize: 13, fontWeight: 700, cursor: 'pointer',
              border: `1.5px solid ${activeTab === tab.id ? ACCENT : '#2a2e38'}`,
              background: activeTab === tab.id ? 'rgba(234,88,12,0.12)' : 'transparent',
              color: activeTab === tab.id ? ACCENT : '#9aa0ab',
            }}>{tab.label}</button>
            {tab.id && (
              <button onClick={() => deleteTab(tab.id, tab.label)} title="탭 삭제" style={{
                background: 'none', border: 'none', cursor: 'pointer', color: '#9aa0ab',
                fontSize: 13, marginLeft: -4, padding: '2px 6px',
              }}>×</button>
            )}
          </div>
        ))}
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <input value={newTab} onChange={e => setNewTab(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && addTab()}
            placeholder="+ 탭 추가"
            style={{
              width: 100, padding: '6px 10px', borderRadius: 999, fontSize: 12,
              background: '#0f1115', border: '1.5px dashed #2a2e38', color: '#e8eaed',
            }} />
          <button onClick={addTab} disabled={addingTab || !newTab.trim()} style={{
            padding: '6px 10px', borderRadius: 999, fontSize: 12, fontWeight: 700, cursor: 'pointer',
            border: `1.5px solid ${ACCENT}`, background: 'transparent', color: ACCENT,
            opacity: !newTab.trim() ? 0.5 : 1,
          }}>추가</button>
        </div>
      </div>

      {activeTab && (
        <div style={{
          marginBottom: 16, padding: '12px 14px', background: '#12151b',
          border: '1px dashed #2a2e38', borderRadius: 10,
        }}>
          <div style={{ fontSize: 12, fontWeight: 700, color: '#9aa0ab', marginBottom: 8 }}>
            🏷️ "{activeCategory?.label}" 탭 컨셉
          </div>
          <textarea value={conceptDraft} onChange={e => setConceptDraft(e.target.value)}
            rows={2} placeholder="이 탭에 어떤 상품을 등록할지 메모해두세요 (예: 재택근무용 모니터암, 가성비 위주)"
            style={{ ...S.textarea, fontFamily: 'inherit' }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button onClick={saveConcept} disabled={savingConcept} style={{ ...S.btn(ACCENT), opacity: savingConcept ? 0.6 : 1 }}>
              {savingConcept ? '저장 중...' : '컨셉 저장'}
            </button>
            {conceptSaved && <span style={{ fontSize: 12, color: '#4CAF50' }}>✅ 저장됨</span>}
          </div>
        </div>
      )}

      {/* 상품이 많아져도 옆으로 채워지는 그리드 — 세로로 끝없이 안 늘어나게 */}
      <div style={S.card}>
        <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 16 }}>
          <div style={{ ...S.cardTitle, marginBottom: 0 }}>📦 상품 목록 ({products.length}개)</div>
          <button onClick={() => setEditing(emptyProduct(activeTab))} style={S.btn(ACCENT)}>+ 상품 추가</button>
        </div>

        {loadingProducts ? (
          <div style={{ textAlign: 'center', padding: 30, color: '#9aa0ab' }}>불러오는 중...</div>
        ) : products.length === 0 ? (
          <div style={{ textAlign: 'center', padding: 30, color: '#9aa0ab', fontSize: 13 }}>아직 등록된 상품이 없어요.</div>
        ) : (
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))', gap: 10 }}>
            {products.map(p => (
              <button key={p.id} onClick={() => setEditing({ ...p })} style={{
                display: 'flex', alignItems: 'center', gap: 6, padding: '10px 12px',
                borderRadius: 10, cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
                border: `1.5px solid ${editing?.id === p.id ? ACCENT : '#2a2e38'}`,
                background: editing?.id === p.id ? 'rgba(234,88,12,0.08)' : '#0f1115',
              }}>
                <span style={{ fontSize: 10, flexShrink: 0, color: p.enabled ? '#4CAF50' : '#5a5f6a' }}>●</span>
                <span style={{
                  fontSize: 13, fontWeight: 600, color: '#e8eaed',
                  overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
                }}>{p.label || '(이름없음)'}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      {editing && (
        <div style={S.card}>
          <div style={S.cardTitle}>{editing.id ? '✏️ 상품 편집' : '➕ 새 상품'}</div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div>
              <label style={S.label}>상품명</label>
              <input value={editing.label} onChange={e => setField('label', e.target.value)}
                placeholder="예: 트레이딩 모니터암" style={S.input} />
            </div>
            <div>
              <label style={S.label}>탭(카테고리)</label>
              <select value={editing.category_id || ''} onChange={e => setField('category_id', e.target.value)} style={S.input}>
                {categoryOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
              </select>
            </div>
            <div>
              <label style={S.label}>링크</label>
              <input value={editing.url} onChange={e => setField('url', e.target.value)}
                placeholder="https://link.coupang.com/a/... 또는 https://coupa.ng/..." style={S.input} />
            </div>
            <div>
              <label style={S.label}>일반 태그</label>
              <textarea value={editing.banner_html} onChange={e => setField('banner_html', e.target.value)}
                rows={3} placeholder='<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>'
                style={S.textarea} />
            </div>
            <div>
              <label style={S.label}>블로그용 태그</label>
              <textarea value={editing.banner_html_blog} onChange={e => setField('banner_html_blog', e.target.value)}
                rows={3} placeholder='<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>'
                style={S.textarea} />
            </div>

            {(editing.banner_html || editing.banner_html_blog) && (
              <div>
                <label style={S.label}>미리보기</label>
                <div style={{
                  padding: '10px 12px', background: '#0f1115', border: '1px dashed #2a2e38',
                  borderRadius: 8, overflow: 'auto',
                }} dangerouslySetInnerHTML={{ __html: editing.banner_html || editing.banner_html_blog || '' }} />
              </div>
            )}

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
              <label style={S.label}>사용</label>
              <Toggle value={editing.enabled} onChange={v => setField('enabled', v)} />
            </div>

            <div style={{ display: 'flex', gap: 8 }}>
              <button onClick={saveProduct} disabled={saving} style={{ ...S.btn(ACCENT), opacity: saving ? 0.6 : 1 }}>
                {saving ? '저장 중...' : '저장'}
              </button>
              <button onClick={() => setEditing(null)} style={S.btnGhost}>취소</button>
              {editing.id && (
                <button onClick={() => setDeleteTarget(editing.id)} style={{ ...S.btnGhost, borderColor: '#F44336', color: '#F44336' }}>
                  삭제
                </button>
              )}
            </div>
          </div>
        </div>
      )}

      <ConfirmModal
        open={!!deleteTarget}
        title="삭제 확인"
        message="이 상품을 삭제할까요?"
        confirmLabel="삭제"
        cancelLabel="취소"
        danger
        onConfirm={confirmDelete}
        onCancel={() => setDeleteTarget(null)}
      />
    </div>
  )
}
