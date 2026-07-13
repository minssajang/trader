// trader 관리자 공용 스타일 & UI 컴포넌트 (다크 테마, 사이트 톤과 통일)
export const S = {
  card: { background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 24, marginBottom: 20 },
  cardTitle: { fontSize: 17, fontWeight: 700, marginBottom: 20, display: 'flex', alignItems: 'center', gap: 8, color: '#e8eaed' },
  input: {
    background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 8,
    padding: '10px 14px', color: '#e8eaed', fontFamily: 'inherit',
    fontSize: 14, outline: 'none', width: '100%', boxSizing: 'border-box',
  },
  textarea: {
    background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 8,
    padding: '10px 14px', color: '#e8eaed', fontFamily: 'monospace',
    fontSize: 13, outline: 'none', width: '100%', boxSizing: 'border-box',
    resize: 'vertical', lineHeight: 1.7,
  },
  btn: (color = '#4CAF50') => ({
    background: color, color: '#fff', border: 'none', borderRadius: 9,
    padding: '10px 22px', fontFamily: 'inherit',
    fontSize: 14, fontWeight: 700, cursor: 'pointer',
    width: 'auto', marginTop: 0,
  }),
  btnGhost: {
    background: 'none', color: '#9aa0ab', border: '1px solid #2a2e38', borderRadius: 9,
    padding: '8px 16px', fontFamily: 'inherit',
    fontSize: 13, fontWeight: 700, cursor: 'pointer',
    width: 'auto', marginTop: 0,
  },
  label: { color: '#9aa0ab', fontSize: 12, marginBottom: 5, display: 'block', fontWeight: 600 },
  row: { background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 10, padding: '12px 16px', marginBottom: 8 },
}

export function Toggle({ value, onChange }) {
  return (
    <div onClick={() => onChange(!value)} style={{
      width: 50, height: 28, borderRadius: 14,
      background: value ? '#4CAF50' : '#2a2e38',
      position: 'relative', cursor: 'pointer', transition: 'background 0.2s', flexShrink: 0,
    }}>
      <div style={{
        width: 22, height: 22, borderRadius: 11, background: '#fff',
        position: 'absolute', top: 3, left: value ? 25 : 3, transition: 'left 0.2s',
        boxShadow: '0 1px 4px rgba(0,0,0,0.3)',
      }} />
    </div>
  )
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

// 몇 초 만에 사라지는 Toast 대신, 직접 "확인" 눌러야 닫히는 안내 모달.
// 에러 메시지가 다 읽기도 전에 사라지는 문제 때문에 admin.js 전역 알림을 이걸로 교체함.
export function MessageModal({ msg, onClose }) {
  if (!msg) return null
  return (
    <div onClick={onClose} style={{
      position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.5)',
      display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 1000, padding: 20,
    }}>
      <div onClick={e => e.stopPropagation()} style={{
        background: '#171a21', borderRadius: 14, padding: 24, width: '100%', maxWidth: 420,
        border: '1px solid #2a2e38',
      }}>
        <div style={{ fontSize: 14, color: '#e8eaed', lineHeight: 1.6, marginBottom: 20, whiteSpace: 'pre-wrap' }}>{msg}</div>
        <div style={{ display: 'flex', justifyContent: 'flex-end' }}>
          <button onClick={onClose} style={S.btn()}>확인</button>
        </div>
      </div>
    </div>
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
