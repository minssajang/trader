// trader 관리자 공용 스타일 & UI 컴포넌트 (다크 테마, 사이트 톤과 통일)
export const S = {
  card: { background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 24, marginBottom: 20 },
  cardTitle: { fontSize: 17, fontWeight: 700, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, color: '#e8eaed' },
  input: {
    background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 8,
    padding: '10px 14px', color: '#e8eaed', fontFamily: 'inherit',
    fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box',
  },
  btn: (color = '#4CAF50') => ({
    background: color, color: '#fff', border: 'none', borderRadius: 9,
    padding: '10px 22px', fontFamily: 'inherit',
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
  }),
  btnGhost: {
    background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
    padding: '8px 16px', fontFamily: 'inherit',
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
  },
  label: { color: '#9aa0ab', fontSize: 12, marginBottom: 5, display: 'block', fontWeight: 600 },
  row: { background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 10, padding: '12px 16px', marginBottom: 8 },
}

export function Toast({ msg }) {
  if (!msg) return null
  return (
    <div style={{
      position: 'fixed', bottom: 24, left: '50%', transform: 'translateX(-50%)',
      background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10,
      padding: '12px 22px', fontSize: 14, color: '#e8eaed', zIndex: 999,
      boxShadow: '0 8px 24px rgba(0,0,0,0.3)',
    }}>{msg}</div>
  )
}

export function ConfirmModal({ open, title, message, confirmLabel = '확인', cancelLabel = '취소', danger = false, onConfirm, onCancel }) {
  if (!open) return null
  return (
    <div onClick={onCancel} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#171a21', borderRadius: 14, padding: 24, width: '100%', maxWidth: 360,
        border: '1px solid #2a2e38',
      }}>
        {title && <div style={{ fontSize: 16, fontWeight: 700, color: '#e8eaed', marginBottom: 8 }}>{title}</div>}
        {message && <div style={{ fontSize: 13, color: '#9aa0ab', lineHeight: 1.6, marginBottom: 20 }}>{message}</div>}
        <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end' }}>
          <button onClick={onCancel} style={S.btnGhost}>{cancelLabel}</button>
          <button onClick={onConfirm} style={S.btn(danger ? '#F44336' : '#4CAF50')}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}
