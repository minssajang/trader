import { useEffect, useState } from 'react'
import { RepeatableListCard } from './CoupangPanel'

const ACCENT = '#ea580c'
const ALL_TAB = { id: '', label: '전체' }

const emptyProduct = (categoryId) => ({
  label: '', url: '', banner_html: '', banner_html_blog: '', category_id: categoryId || '', enabled: true,
})

export default function CoupangProductsPanel({ adminToken }) {
  const [categories, setCategories] = useState([])
  const [activeTab, setActiveTab] = useState('')
  const [newTab, setNewTab] = useState('')
  const [adding, setAdding] = useState(false)
  const [conceptDraft, setConceptDraft] = useState('')
  const [savingConcept, setSavingConcept] = useState(false)
  const [conceptSaved, setConceptSaved] = useState(false)

  const activeCategory = categories.find(c => c.id === activeTab) || null

  useEffect(() => {
    setConceptDraft(activeCategory?.concept || '')
    setConceptSaved(false)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, activeCategory?.concept])

  const loadCategories = async () => {
    try {
      const res = await fetch('/api/admin/coupang-product-categories')
      const data = await res.json()
      setCategories(Array.isArray(data) ? data : [])
    } catch { setCategories([]) }
  }

  useEffect(() => { loadCategories() }, [])

  const addTab = async () => {
    const label = newTab.trim()
    if (!label || categories.find(c => c.label === label)) { setNewTab(''); return }
    setAdding(true)
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
    setAdding(false)
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
          <button onClick={addTab} disabled={adding || !newTab.trim()} style={{
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
            style={{
              width: '100%', padding: '8px 10px', borderRadius: 8, fontSize: 13,
              background: '#0f1115', border: '1.5px solid #2a2e38', color: '#e8eaed',
              resize: 'vertical', fontFamily: 'inherit',
            }} />
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
            <button onClick={saveConcept} disabled={savingConcept} style={{
              padding: '6px 14px', borderRadius: 8, fontSize: 12, fontWeight: 700, cursor: 'pointer',
              border: `1.5px solid ${ACCENT}`, background: 'transparent', color: ACCENT,
              opacity: savingConcept ? 0.6 : 1,
            }}>{savingConcept ? '저장 중...' : '컨셉 저장'}</button>
            {conceptSaved && <span style={{ fontSize: 12, color: '#4CAF50' }}>✅ 저장됨</span>}
          </div>
        </div>
      )}

      <RepeatableListCard
        key={activeTab}
        adminToken={adminToken}
        title="📦 상품 목록 (필요한 만큼 추가)"
        description="상품명 / 탭 / 링크 / 일반 태그 / 블로그용 태그를 등록하세요."
        apiPath={`/api/admin/coupang-products${activeTab ? `?category_id=${activeTab}` : ''}`}
        empty={emptyProduct(activeTab)}
        addLabel="+ 상품 추가"
        previewOnlyWhenOpen
        fields={[
          { key: 'label', label: '상품명', placeholder: '예: 트레이딩 모니터암' },
          { key: 'category_id', label: '탭(카테고리)', type: 'select', options: categoryOptions },
          { key: 'url', label: '링크', placeholder: 'https://link.coupang.com/a/... 또는 https://coupa.ng/...' },
          { key: 'banner_html', label: '일반 태그', placeholder: '<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>', multiline: true },
          { key: 'banner_html_blog', label: '블로그용 태그', placeholder: '<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>', multiline: true },
        ]}
        renderPreview={(item) => (
          <div dangerouslySetInnerHTML={{ __html: item.banner_html || item.banner_html_blog || '' }} />
        )}
      />
    </div>
  )
}
