import { useState, useEffect } from 'react'
import { S, Toast, Toggle } from './AdminUI'
import { SLOT_BANNER_SIZE } from '../../lib/adSlotSizes'

const SOURCE_OPTIONS = [
  { value: 'adsense', label: '애드센스' },
  { value: 'coupang', label: '쿠팡' },
  { value: 'random', label: '무작위' },
]

export default function AdsensePanel({ adminToken }) {
  const [adSlots, setAdSlots] = useState([])
  const [adsOn, setAdsOnState] = useState(true)
  const [loading, setLoading] = useState(true)
  const [editId, setEditId] = useState(null)
  const [code, setCode] = useState('')
  const [savingId, setSavingId] = useState(null)
  const [savingMaster, setSavingMaster] = useState(false)
  const [coupangWidgets, setCoupangWidgets] = useState([])
  const [toast, setToast] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200) }

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/settings/get')
      const data = await res.json()
      setAdSlots(Array.isArray(data.adSlots) ? data.adSlots : [])
      if (data.adsOn !== undefined) setAdsOnState(data.adsOn)
    } catch { showToast('❌ 불러오기 실패') }
    setLoading(false)
  }

  useEffect(() => {
    load()
    fetch('/api/admin/coupang-widgets')
      .then(r => r.ok ? r.json() : [])
      .then(data => setCoupangWidgets(Array.isArray(data) ? data : []))
      .catch(() => setCoupangWidgets([]))
  }, [])

  // 슬롯별 "쿠팡" 소스를 골랐을 때 실제로 매칭되는 배너가 몇 개 등록됐는지 보여주기 위해 계산
  const countCoupangBanners = (slotId) => {
    const size = SLOT_BANNER_SIZE[slotId]
    if (!size) return 0
    return coupangWidgets.filter(w => w.enabled && w.widget_html && w.size === size).length
  }

  const persist = async (nextSlots, nextAdsOn) => {
    try {
      const res = await fetch('/api/settings/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({
          ...(nextSlots !== undefined ? { adSlots: nextSlots } : {}),
          ...(nextAdsOn !== undefined ? { adsOn: nextAdsOn } : {}),
        }),
      })
      if (!res.ok) throw new Error()
      showToast('✅ 저장됨')
    } catch { showToast('❌ 저장 실패') }
  }

  const toggleMaster = async () => {
    setSavingMaster(true)
    const next = !adsOn
    setAdsOnState(next)
    await persist(undefined, next)
    setSavingMaster(false)
  }

  const updateSlot = (id, patch) => {
    const next = adSlots.map(s => s.id === id ? { ...s, ...patch } : s)
    setAdSlots(next)
    return next
  }

  const saveCode = async (id) => {
    setSavingId(id)
    await persist(updateSlot(id, { code }))
    setEditId(null)
    setSavingId(null)
  }

  const removeCode = async (id) => {
    setSavingId(id)
    await persist(updateSlot(id, { code: '' }))
    setEditId(null)
    setSavingId(null)
  }

  const toggleActive = async (id) => {
    const slot = adSlots.find(s => s.id === id)
    setSavingId(id)
    await persist(updateSlot(id, { active: !slot?.active }))
    setSavingId(null)
  }

  const setSource = async (id, source) => {
    setSavingId(id)
    await persist(updateSlot(id, { source }))
    setSavingId(null)
  }

  return (
    <div>
      <Toast msg={toast} />
      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <div>
            <div style={{ ...S.cardTitle, marginBottom: 4 }}>🔌 광고 전체 노출</div>
            <div style={{ fontSize: 12, color: '#9aa0ab' }}>OFF 시 사이트 전체 광고 영역이 슬롯 설정과 무관하게 전부 숨겨집니다.</div>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
            <Toggle value={adsOn} onChange={savingMaster ? () => {} : toggleMaster} />
            <span style={{ fontSize: 12, fontWeight: 700, color: adsOn ? '#4CAF50' : '#9aa0ab' }}>{adsOn ? 'ON' : 'OFF'}</span>
          </div>
        </div>
      </div>

      <div style={S.card}>
        <div style={S.cardTitle}>📢 광고 슬롯 관리</div>
        <div style={{ marginBottom: 20, padding: 16, background: 'rgba(255,193,7,0.08)', border: '1.5px solid #FFC107', borderRadius: 12, fontSize: 13, color: '#FFC107', lineHeight: 1.7 }}>
          <strong>동작 방식</strong><br />
          ⚪ <strong>OFF</strong> — 사이트에서 해당 광고 영역이 완전히 숨겨집니다.<br />
          🟡 <strong>대기</strong> — ON인데 노출할 코드/배너가 없는 상태. 빈 자리만 표시됩니다.<br />
          ✅ <strong>ON + 코드/배너 등록</strong> — 실제 광고가 노출됩니다.<br /><br />
          <strong>소스 선택 (애드센스 / 쿠팡 / 무작위)</strong><br />
          <strong>애드센스</strong> — 아래 "코드 입력"에 등록한 애드센스 코드를 보여줍니다.<br />
          <strong>쿠팡</strong> — 🛒 쿠팡 관리 &gt; 배너/위젯 목록에서 이 슬롯 사이즈와 맞는 배너를 자동으로(여러 개면 무작위로) 골라 보여줍니다. 코드 입력은 필요 없어요.<br />
          <strong>무작위</strong> — 애드센스 코드와 쿠팡 배너 중 있는 것을 무작위로 섞어서 보여줍니다.
        </div>

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9aa0ab' }}>불러오는 중...</div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            {adSlots.map(slot => {
              const isSaving = savingId === slot.id
              const source = slot.source || 'adsense'
              const coupangCount = countCoupangBanners(slot.id)
              const hasContent = source === 'coupang' ? coupangCount > 0
                : source === 'random' ? (!!slot.code || coupangCount > 0)
                : !!slot.code
              let statusText = '⚪ OFF (숨김)'
              if (slot.active) {
                if (!hasContent) statusText = '🟡 대기 (코드/배너 등록 필요)'
                else if (source === 'coupang') statusText = `🛒 쿠팡 배너 자동 노출 (${coupangCount}개 등록됨)`
                else if (source === 'random') statusText = '🔀 무작위 노출 중'
                else statusText = '✅ 광고 노출 중'
              }

              return (
                <div key={slot.id} style={S.row}>
                  <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 16, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 220 }}>
                      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
                        <span style={{ fontSize: 14, fontWeight: 700, color: '#e8eaed' }}>{slot.name}</span>
                      </div>
                      <div style={{ fontSize: 11, color: '#9aa0ab', marginBottom: 10 }}>슬롯 ID: {slot.id}</div>

                      <div style={{ display: 'flex', gap: 6, marginBottom: 10, maxWidth: 320 }}>
                        {SOURCE_OPTIONS.map(opt => {
                          const on = source === opt.value
                          return (
                            <button key={opt.value} onClick={() => setSource(slot.id, opt.value)} disabled={isSaving}
                              style={{
                                flex: 1, padding: '6px 8px', borderRadius: 8, fontSize: 12, fontWeight: 700,
                                cursor: 'pointer',
                                border: `1.5px solid ${on ? '#4CAF50' : '#2a2e38'}`,
                                background: on ? 'rgba(76,175,80,0.1)' : 'transparent',
                                color: on ? '#4CAF50' : '#9aa0ab',
                                opacity: isSaving ? 0.6 : 1,
                              }}>
                              {opt.label}
                            </button>
                          )
                        })}
                      </div>

                      <div style={{
                        maxWidth: 320, padding: '10px 12px',
                        background: slot.active && hasContent ? 'rgba(76,175,80,0.1)' : slot.active ? 'rgba(255,193,7,0.1)' : '#0f1115',
                        border: `1.5px dashed ${slot.active && hasContent ? '#4CAF50' : slot.active ? '#FFC107' : '#2a2e38'}`,
                        borderRadius: 8, fontSize: 12,
                        color: slot.active && hasContent ? '#4CAF50' : slot.active ? '#FFC107' : '#9aa0ab',
                        marginBottom: 10,
                      }}>
                        {statusText}
                      </div>

                      {source !== 'coupang' ? (
                        editId === slot.id ? (
                          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                            <textarea value={code} onChange={e => setCode(e.target.value)} rows={4}
                              placeholder="<script>... AdSense 코드를 붙여넣으세요 ...</script>"
                              style={S.textarea} />
                            <div style={{ display: 'flex', gap: 8 }}>
                              <button onClick={() => saveCode(slot.id)} disabled={isSaving} style={{ ...S.btn(), opacity: isSaving ? 0.6 : 1 }}>저장</button>
                              <button onClick={() => setEditId(null)} style={S.btnGhost}>취소</button>
                              {slot.code && <button onClick={() => removeCode(slot.id)} style={S.btnGhost}>코드 삭제</button>}
                            </div>
                          </div>
                        ) : (
                          <button onClick={() => { setCode(slot.code || ''); setEditId(slot.id) }} style={S.btnGhost}>
                            {slot.code ? '코드 편집' : '+ 코드 입력'}
                          </button>
                        )
                      ) : (
                        <div style={{ fontSize: 12, color: '#9aa0ab' }}>
                          🛒 쿠팡 관리 &gt; 배너/위젯 목록에서 이 슬롯 사이즈에 맞는 배너를 등록하면 자동으로 노출돼요. 코드 입력 필요 없음.
                        </div>
                      )}
                    </div>

                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 6 }}>
                      <Toggle value={slot.active} onChange={isSaving ? () => {} : () => toggleActive(slot.id)} />
                      <span style={{ fontSize: 11, color: slot.active && hasContent ? '#4CAF50' : slot.active ? '#FFC107' : '#9aa0ab', fontWeight: 600 }}>
                        {slot.active && hasContent ? 'ON' : slot.active ? '대기' : 'OFF'}
                      </span>
                    </div>
                  </div>
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
