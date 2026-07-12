import { useState, useEffect } from 'react'
import { S, ConfirmModal } from './AdminUI'

const STATUS_LABEL = { pending: '대기중', active: '활성', expired: '만료', cancelled: '취소' }
const STATUS_COLOR = { pending: '#FFC107', active: '#4CAF50', expired: '#F44336', cancelled: '#9aa0ab' }
const PRODUCT_LABEL = { nt8: 'NT8', mt5: 'MT5' }

const td = { padding: '10px 12px', borderBottom: '1px solid #2a2e38', fontSize: 13, verticalAlign: 'top' }
const th = { padding: '8px 12px', textAlign: 'left', fontSize: 12, color: '#9aa0ab', fontWeight: 600, borderBottom: '1px solid #2a2e38', whiteSpace: 'nowrap' }
const iconBtn = (color) => ({
  background: 'none', border: `1px solid ${color}`, color, borderRadius: 6,
  padding: '4px 8px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
})

export default function LicenseAdminPanel({ adminToken, showToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState('all')
  const [confirmTarget, setConfirmTarget] = useState(null) // { id, action, label }

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/licenses', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setRows(data.rows || [])
    } catch {
      showToast?.('❌ 목록을 불러오지 못했습니다')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const patch = async (id, body) => {
    try {
      const res = await fetch('/api/admin/licenses', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ id, ...body }),
      })
      if (!res.ok) throw new Error()
      await load()
      showToast?.('✅ 처리되었습니다')
    } catch {
      showToast?.('❌ 처리 실패')
    }
  }

  const remove = async (id) => {
    try {
      const res = await fetch('/api/admin/licenses', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ id }),
      })
      if (!res.ok) throw new Error()
      await load()
      showToast?.('✅ 삭제되었습니다')
    } catch {
      showToast?.('❌ 삭제 실패')
    }
  }

  const filtered = filter === 'all' ? rows : rows.filter(r => r.status === filter)

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>🔑 라이선스 관리 ({rows.length})</div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16, flexWrap: 'wrap' }}>
        {['all', 'pending', 'active', 'expired', 'cancelled'].map(f => (
          <button key={f} onClick={() => setFilter(f)}
            style={{
              ...S.btnGhost,
              padding: '6px 14px',
              background: filter === f ? '#4CAF50' : 'none',
              color: filter === f ? '#fff' : '#9aa0ab',
              borderColor: filter === f ? '#4CAF50' : '#2a2e38',
            }}>
            {f === 'all' ? '전체' : STATUS_LABEL[f]} {f !== 'all' && `(${rows.filter(r => r.status === f).length})`}
          </button>
        ))}
      </div>

      {loading && <div style={{ color: '#9aa0ab', fontSize: 14 }}>불러오는 중...</div>}
      {!loading && filtered.length === 0 && <div style={{ color: '#9aa0ab', fontSize: 14 }}>신청 내역이 없습니다</div>}

      {!loading && filtered.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>신청자</th>
                <th style={th}>제품</th>
                <th style={th}>기간</th>
                <th style={th}>상태</th>
                <th style={th}>키</th>
                <th style={th}>액션</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(r => (
                <tr key={r.id}>
                  <td style={td}>
                    <div style={{ fontWeight: 700, color: '#e8eaed' }}>{r.name}</div>
                    <div style={{ color: '#9aa0ab', fontSize: 12 }}>{r.email}</div>
                    {r.phone && <div style={{ color: '#9aa0ab', fontSize: 12 }}>{r.phone}</div>}
                    {r.note && <div style={{ color: '#666', fontSize: 11, marginTop: 2 }}>메모: {r.note}</div>}
                  </td>
                  <td style={td}>{PRODUCT_LABEL[r.product] || r.product}</td>
                  <td style={td}>
                    {r.requested_months}개월
                    {r.expire_date && <div style={{ color: '#9aa0ab', fontSize: 11 }}>~{r.expire_date}</div>}
                  </td>
                  <td style={td}>
                    <span style={{ fontSize: 11, fontWeight: 700, color: STATUS_COLOR[r.status], border: `1px solid ${STATUS_COLOR[r.status]}`, borderRadius: 999, padding: '2px 8px', whiteSpace: 'nowrap' }}>
                      {STATUS_LABEL[r.status] || r.status}
                    </span>
                  </td>
                  <td style={{ ...td, fontFamily: 'monospace', fontSize: 11, color: '#4CAF50' }}>{r.license_key || '-'}</td>
                  <td style={td}>
                    <div style={{ display: 'flex', gap: 4, flexWrap: 'wrap' }}>
                      {r.status === 'pending' && (
                        <button onClick={() => setConfirmTarget({ id: r.id, action: 'issue', label: `${r.name}님에게 라이선스 키를 발급할까요? (입금 확인 후에만 진행하세요)` })} style={iconBtn('#4CAF50')}>
                          키 발급
                        </button>
                      )}
                      {r.status === 'active' && (
                        <button onClick={() => patch(r.id, { action: 'extend', months: r.requested_months || 1 })} style={iconBtn('#3F51B5')}>
                          연장
                        </button>
                      )}
                      {r.status !== 'cancelled' && (
                        <button onClick={() => setConfirmTarget({ id: r.id, action: 'cancel', label: `${r.name}님의 라이선스를 취소할까요?` })} style={iconBtn('#9aa0ab')}>
                          취소
                        </button>
                      )}
                      <button onClick={() => setConfirmTarget({ id: r.id, action: 'delete', label: `${r.name}님의 신청 내역을 완전히 삭제할까요? 복구할 수 없습니다.` })} style={iconBtn('#F44336')}>
                        삭제
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!confirmTarget}
        title="확인"
        message={confirmTarget?.label}
        danger={confirmTarget?.action === 'delete' || confirmTarget?.action === 'cancel'}
        confirmLabel={confirmTarget?.action === 'delete' ? '삭제' : '진행'}
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => {
          const t = confirmTarget
          setConfirmTarget(null)
          if (!t) return
          if (t.action === 'issue') patch(t.id, { action: 'issue' })
          else if (t.action === 'cancel') patch(t.id, { action: 'set_status', status: 'cancelled' })
          else if (t.action === 'delete') remove(t.id)
        }}
      />
    </div>
  )
}
