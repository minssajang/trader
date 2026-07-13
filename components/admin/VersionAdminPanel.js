import { useState, useEffect } from 'react'
import { S, ConfirmModal, Toggle } from './AdminUI'

const APP_LABEL = { ninja: 'NT8 (Ninja)', mt5: 'MT5' }

const td = { padding: '10px 12px', borderBottom: '1px solid #2a2e38', fontSize: 13, verticalAlign: 'top' }
const th = { padding: '8px 12px', textAlign: 'left', fontSize: 12, color: '#9aa0ab', fontWeight: 600, borderBottom: '1px solid #2a2e38', whiteSpace: 'nowrap' }
const iconBtn = (color) => ({
  background: 'none', border: `1px solid ${color}`, color, borderRadius: 6,
  padding: '4px 8px', fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap',
})

export default function VersionAdminPanel({ adminToken, showToast }) {
  const [rows, setRows] = useState([])
  const [loading, setLoading] = useState(true)
  const [uploading, setUploading] = useState(false)
  const [confirmTarget, setConfirmTarget] = useState(null)

  const [app, setApp] = useState('ninja')
  const appRows = rows.filter(r => r.app === app)
  const [version, setVersion] = useState('')
  const [changelog, setChangelog] = useState('')
  const [downloadUrl, setDownloadUrl] = useState('')

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/versions', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setRows(data.rows || [])
    } catch {
      showToast?.('❌ 목록을 불러오지 못했습니다')
    }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const upload = async () => {
    if (!version.trim()) { showToast?.('❌ 버전을 입력하세요'); return }
    if (!downloadUrl.trim()) { showToast?.('❌ 다운로드 URL을 입력하세요'); return }
    setUploading(true)
    try {
      // 설치 파일(exe)이 수십~수백MB라 Supabase Storage(무료 플랜은 50MB 고정 한도)에
      // 직접 올리는 대신, GitHub Releases 등에 올려둔 파일의 다운로드 URL만 등록한다.
      const res = await fetch('/api/admin/versions', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ app, version: version.trim(), changelog, download_url: downloadUrl.trim() }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '등록 실패')
      setVersion(''); setChangelog(''); setDownloadUrl('')
      await load()
      showToast?.('✅ 새 버전이 등록되었습니다')
    } catch (e) {
      showToast?.(`❌ ${e.message || '등록 실패'}`)
    }
    setUploading(false)
  }

  const toggleActive = async (row) => {
    try {
      const res = await fetch('/api/admin/versions', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ id: row.id, is_active: !row.is_active }),
      })
      if (!res.ok) throw new Error()
      await load()
    } catch {
      showToast?.('❌ 처리 실패')
    }
  }

  const remove = async (id) => {
    try {
      const res = await fetch('/api/admin/versions', {
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

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>📦 버전 관리 ({rows.length})</div>

      <div style={{ display: 'flex', gap: 6, marginBottom: 16 }}>
        {['ninja', 'mt5'].map(a => (
          <button key={a} onClick={() => { setApp(a); setVersion(''); setChangelog(''); setDownloadUrl('') }}
            style={{
              ...S.btnGhost,
              padding: '6px 16px',
              background: app === a ? '#4CAF50' : 'none',
              color: app === a ? '#fff' : '#9aa0ab',
              borderColor: app === a ? '#4CAF50' : '#2a2e38',
            }}>
            {APP_LABEL[a]} ({rows.filter(r => r.app === a).length})
          </button>
        ))}
      </div>

      <div style={{ ...S.row, marginBottom: 20 }}>
        <div style={{ marginBottom: 12 }}>
          <label style={S.label}>버전</label>
          <input value={version} onChange={e => setVersion(e.target.value)} placeholder="예: 1.1.0" style={{ ...S.input, width: 160 }} />
        </div>
        <label style={S.label}>변경 내용</label>
        <textarea value={changelog} onChange={e => setChangelog(e.target.value)} rows={3} style={{ ...S.textarea, marginBottom: 12 }} />
        <label style={S.label}>다운로드 URL</label>
        <input value={downloadUrl} onChange={e => setDownloadUrl(e.target.value)}
          placeholder="GitHub Releases 등에 올린 Setup.exe의 다운로드 링크를 붙여넣으세요"
          style={{ ...S.input, marginBottom: 12 }} />
        <button onClick={upload} disabled={uploading} style={{ ...S.btn(), opacity: uploading ? 0.6 : 1 }}>
          {uploading ? '등록 중...' : '⬆️ 새 버전 등록'}
        </button>
      </div>

      {loading && <div style={{ color: '#9aa0ab', fontSize: 14 }}>불러오는 중...</div>}
      {!loading && appRows.length === 0 && <div style={{ color: '#9aa0ab', fontSize: 14 }}>{APP_LABEL[app]}에 등록된 버전이 없습니다</div>}

      {!loading && appRows.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table style={{ width: '100%', borderCollapse: 'collapse' }}>
            <thead>
              <tr>
                <th style={th}>버전</th>
                <th style={th}>변경 내용</th>
                <th style={th}>등록일</th>
                <th style={th}>활성</th>
                <th style={th}>다운로드</th>
                <th style={th}></th>
              </tr>
            </thead>
            <tbody>
              {appRows.map(r => (
                <tr key={r.id}>
                  <td style={td}>v{r.version}</td>
                  <td style={{ ...td, maxWidth: 260, whiteSpace: 'pre-wrap', color: '#9aa0ab' }}>{r.changelog}</td>
                  <td style={td}>{new Date(r.created_at).toLocaleDateString('ko-KR')}</td>
                  <td style={td}><Toggle value={r.is_active} onChange={() => toggleActive(r)} /></td>
                  <td style={td}><a href={r.download_url} target="_blank" rel="noreferrer" style={{ color: '#4CAF50' }}>파일 열기</a></td>
                  <td style={td}>
                    <button onClick={() => setConfirmTarget(r)} style={iconBtn('#F44336')}>삭제</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      <ConfirmModal
        open={!!confirmTarget}
        title="버전 삭제"
        message={confirmTarget ? `v${confirmTarget.version}을(를) 삭제할까요? (GitHub에 올려둔 실제 파일은 안 지워집니다)` : ''}
        danger
        confirmLabel="삭제"
        onCancel={() => setConfirmTarget(null)}
        onConfirm={() => { remove(confirmTarget.id); setConfirmTarget(null) }}
      />
    </div>
  )
}
