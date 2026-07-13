import { useState, useEffect, useCallback } from 'react'
import { S, Toggle, ConfirmModal } from './AdminUI'

const ACCENT = '#ea580c'

const EMPTY_LINK = { label: '', url: '', enabled: true }
const EMPTY_WIDGET = { label: '', size: '728x90', widget_html: '', enabled: true }

// 쿠팡 파트너스 배너 생성 페이지 사이즈 탭 그대로 + 우리 사이트 어느 슬롯에 맞는지 표시
const BANNER_SIZE_OPTIONS = [
  { value: '728x90', label: '728×90  → 상단/중단/하단 배너' },
  { value: '160x600', label: '160×600 → 좌측/우측 사이드' },
  { value: '600x900', label: '600×900' },
  { value: '320x480', label: '320×480' },
  { value: '320x100', label: '320×100' },
  { value: '320x50', label: '320×50' },
  { value: '200x200', label: '200×200' },
  { value: '150x60', label: '150×60' },
  { value: '120x60', label: '120×60' },
]

// ── 1) 쿠팡파트너스 바로가기 카드 ────────────────────────────
// 링크/배너는 반드시 쿠팡 파트너스 공식 링크 생성 도구를 거쳐야 실적으로 집계된다.
// 생성한 링크/위젯은 아래 목록에 등록한다.
function ShortcutCard() {
  return (
    <div style={S.card}>
      <div style={S.cardTitle}>🔗 쿠팡 파트너스</div>
      <div style={{ fontSize: 12, color: '#9aa0ab', marginBottom: 14, lineHeight: 1.6 }}>
        링크/배너는 반드시 쿠팡 파트너스 사이트에서 직접 생성해야 실적(수익)으로 집계됩니다.
        생성한 링크는 아래 "링크 목록"에, 위젯 코드는 "위젯 목록"에 등록하세요.
      </div>
      <a href="https://partners.coupang.com/" target="_blank" rel="noopener noreferrer"
        style={{ ...S.btn(ACCENT), display: 'inline-flex', alignItems: 'center', justifyContent: 'center', textDecoration: 'none' }}>
        🔗 쿠팡파트너스 바로가기
      </a>
    </div>
  )
}

// ── 공용: 여러 개 추가되는 목록 카드 ─────────────────────────
function RepeatableRow({ adminToken, item, isNew, apiPath, fields, onSaved, onDeleted, onCancelNew, renderPreview, previewOnlyWhenOpen = false }) {
  const [form, setForm] = useState(item)
  const [saving, setSaving] = useState(false)
  const [open, setOpen] = useState(isNew)
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const set = (k, v) => setForm(p => ({ ...p, [k]: v }))

  const save = async () => {
    setSaving(true)
    try {
      const method = isNew ? 'POST' : 'PUT'
      const res = await fetch(apiPath, {
        method,
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify(isNew ? form : { ...form, id: item.id }),
      })
      const data = await res.json().catch(() => ({}))
      if (res.ok) onSaved(isNew ? data : { ...form, id: item.id })
      else alert('저장 실패: ' + (data.error || res.status))
    } catch (e) {
      alert('저장 실패: ' + e.message)
    }
    setSaving(false)
  }

  const askDelete = () => setConfirmOpen(true)

  const del = async () => {
    setDeleting(true)
    try {
      const res = await fetch(`${apiPath}?id=${encodeURIComponent(item.id)}`, {
        method: 'DELETE',
        headers: { 'x-admin-token': adminToken },
      })
      if (res.ok) onDeleted(item.id)
      else alert('삭제 실패')
    } catch (e) {
      alert('삭제 실패: ' + e.message)
    }
    setDeleting(false)
    setConfirmOpen(false)
  }

  return (
    <div style={S.row}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', cursor: 'pointer' }}
        onClick={() => setOpen(p => !p)}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ fontWeight: 700, color: '#e8eaed' }}>{form.label || (isNew ? '(새 항목)' : '(이름없음)')}</span>
          {form.size && (
            <span style={{ fontSize: 11, color: ACCENT, background: 'rgba(234,88,12,0.1)', border: `1px solid ${ACCENT}44`, borderRadius: 999, padding: '1px 8px', fontWeight: 700 }}>
              {form.size}
            </span>
          )}
          {form.enabled ? <span style={{ fontSize: 11, color: '#4CAF50' }}>● 사용중</span> : <span style={{ fontSize: 11, color: '#9aa0ab' }}>○ 꺼짐</span>}
        </div>
        <span style={{ fontSize: 13, color: '#9aa0ab' }}>{open ? '▲' : '▼'}</span>
      </div>

      {renderPreview && (form.widget_html || form.url) && (!previewOnlyWhenOpen || open) && (
        <div style={{
          marginTop: 10, padding: '10px 12px', background: '#0f1115',
          border: '1px dashed #2a2e38', borderRadius: 8, overflow: 'auto',
        }}>
          {renderPreview(form)}
        </div>
      )}

      {open && (
        <div style={{ marginTop: 14, display: 'flex', flexDirection: 'column', gap: 12 }}>
          {fields.map(f => (
            <div key={f.key}>
              <label style={S.label}>{f.label}</label>
              {f.type === 'select' ? (
                <select value={form[f.key] || (f.options && f.options[0]?.value) || ''} onChange={e => set(f.key, e.target.value)}
                  style={S.input}>
                  {f.options.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
                </select>
              ) : f.multiline ? (
                <textarea value={form[f.key] || ''} onChange={e => set(f.key, e.target.value)}
                  rows={3} style={S.textarea} placeholder={f.placeholder} />
              ) : (
                <input value={form[f.key] || ''} onChange={e => set(f.key, e.target.value)}
                  placeholder={f.placeholder} style={S.input} />
              )}
            </div>
          ))}
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
            <label style={S.label}>사용</label>
            <Toggle value={form.enabled} onChange={v => set('enabled', v)} />
          </div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={save} disabled={saving} style={{ ...S.btn(ACCENT), flex: 1, opacity: saving ? 0.6 : 1 }}>
              {saving ? '저장 중...' : (isNew ? '추가' : '저장하기')}
            </button>
            {isNew ? (
              <button onClick={onCancelNew} style={S.btnGhost}>취소</button>
            ) : (
              <button onClick={askDelete} style={{ ...S.btnGhost, borderColor: '#F44336', color: '#F44336' }}>삭제</button>
            )}
          </div>
        </div>
      )}

      <ConfirmModal
        open={confirmOpen}
        title="삭제 확인"
        message={`"${form.label || '이 항목'}"을(를) 삭제할까요?`}
        confirmLabel={deleting ? '삭제 중...' : '삭제'}
        cancelLabel="취소"
        danger
        onConfirm={deleting ? undefined : del}
        onCancel={() => setConfirmOpen(false)}
      />
    </div>
  )
}

export function RepeatableListCard({ adminToken, title, description, apiPath, empty, fields, addLabel, renderPreview, notice, previewOnlyWhenOpen = false }) {
  const [items, setItems] = useState([])
  const [loading, setLoading] = useState(true)
  const [newDraft, setNewDraft] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch(apiPath)
      const data = await res.json()
      setItems(Array.isArray(data) ? data : [])
    } catch {
      setItems([])
    }
    setLoading(false)
  }, [apiPath])

  useEffect(() => { load() }, [load])

  const addNew = () => setNewDraft({ ...empty })
  const onSavedExisting = (updated) => setItems(p => p.map(x => x.id === updated.id ? updated : x))
  const onSavedNew = (created) => { setItems(p => [...p, created]); setNewDraft(null) }
  const onDeleted = (id) => setItems(p => p.filter(x => x.id !== id))

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>{title}</div>
      <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: -12, marginBottom: 16 }}>{description}</div>

      {notice && (
        <div style={{
          marginBottom: 16, padding: '12px 14px', background: 'rgba(234,88,12,0.08)',
          border: `1px solid ${ACCENT}44`, borderRadius: 8, fontSize: 12, color: '#fb923c', lineHeight: 1.7,
        }}>
          {notice}
        </div>
      )}

      {loading ? (
        <div style={{ color: '#9aa0ab', textAlign: 'center', padding: '20px 0' }}>불러오는 중...</div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 14 }}>
          {items.map(it => (
            <RepeatableRow key={it.id} adminToken={adminToken} item={it} isNew={false}
              apiPath={apiPath} fields={fields} renderPreview={renderPreview} previewOnlyWhenOpen={previewOnlyWhenOpen}
              onSaved={onSavedExisting} onDeleted={onDeleted} />
          ))}
          {newDraft && (
            <RepeatableRow adminToken={adminToken} item={newDraft} isNew={true}
              apiPath={apiPath} fields={fields} renderPreview={renderPreview} previewOnlyWhenOpen={previewOnlyWhenOpen}
              onSaved={onSavedNew} onDeleted={() => {}} onCancelNew={() => setNewDraft(null)} />
          )}
          {items.length === 0 && !newDraft && (
            <div style={{ fontSize: 12, color: '#9aa0ab', textAlign: 'center', padding: '10px 0' }}>
              아직 등록된 항목이 없어요.
            </div>
          )}
        </div>
      )}

      {!newDraft && (
        <button onClick={addNew} style={{ ...S.btn(ACCENT), width: '100%' }}>{addLabel}</button>
      )}
    </div>
  )
}

export default function CoupangPanel({ adminToken }) {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#e8eaed' }}>🛒 쿠팡 관리</div>
        <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 3 }}>
          쿠팡 파트너스 사이트에서 만든 링크/위젯을 등록하세요.
        </div>
      </div>

      <ShortcutCard />

      <RepeatableListCard
        adminToken={adminToken}
        title="📋 링크 목록 (필요한 만큼 추가)"
        description="쿠팡 링크(URL)만 추가하는 목록입니다. 위젯 코드는 아래 위젯 목록에서 따로 추가하세요."
        apiPath="/api/admin/coupang-links"
        empty={EMPTY_LINK}
        addLabel="+ 링크 추가"
        fields={[
          { key: 'label', label: '이름 (구분용)', placeholder: '예: 트레이딩 모니터, 키보드 특가' },
          { key: 'url', label: '링크 URL', placeholder: 'https://link.coupang.com/a/... 또는 https://coupa.ng/...' },
        ]}
      />

      <RepeatableListCard
        adminToken={adminToken}
        title="🖼️ 배너/위젯 목록 (사이즈별로 필요한 만큼 추가)"
        description="쿠팡 파트너스에서 만든 배너/위젯 코드를 등록하는 목록입니다. 링크(URL)만 있는 경우엔 위 링크 목록을 이용하세요."
        apiPath="/api/admin/coupang-widgets"
        empty={EMPTY_WIDGET}
        addLabel="+ 배너/위젯 추가"
        notice={
          <>
            <strong>⚠️ 쿠팡 파트너스에서 배너 만들 때 꼭 확인하세요</strong><br />
            배너 생성 페이지 오른쪽 "HTML" 영역에서 <strong>자바스크립트 태그 / iframe 태그가 아니라
            반드시 "HTML 태그"</strong>를 선택한 뒤 코드를 복사해서 아래에 붙여넣으세요.<br />
            사이즈는 아래 드롭다운에서 방금 쿠팡 사이트에서 만든 것과 같은 사이즈를 선택하면,
            어느 슬롯에 넣으면 좋을지 옆에 같이 표시됩니다.
          </>
        }
        fields={[
          { key: 'label', label: '이름 (구분용)', placeholder: '예: 모니터암1, 기계식키보드1' },
          { key: 'size', label: '사이즈', type: 'select', options: BANNER_SIZE_OPTIONS },
          { key: 'widget_html', label: '배너/위젯 코드 (HTML 태그)', placeholder: '<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>', multiline: true },
        ]}
        renderPreview={(item) => (
          <div dangerouslySetInnerHTML={{ __html: item.widget_html || '' }} />
        )}
      />
    </div>
  )
}
