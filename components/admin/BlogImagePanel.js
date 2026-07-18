import { useState, useRef } from 'react'
import { S } from './AdminUI'

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result).split(',')[1] || '')
    reader.onerror = reject
    reader.readAsDataURL(file)
  })
}

function extractStoragePath(url) {
  // 공개 URL 형식: https://<project>.supabase.co/storage/v1/object/public/blog-images/<path>
  const marker = '/blog-images/'
  const idx = url.indexOf(marker)
  return idx === -1 ? '' : url.slice(idx + marker.length)
}

const ALLOWED = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']

// 특정 글에 종속되지 않는 독립 이미지 업로드함 — 외부 자료 스크린샷 등을 미리 올려서
// URL만 받아두고, 어느 글의 어디에 쓸지는 나중에(채팅으로 Claude에게 "N번" 식으로 전달해서) 정한다.
// /api/admin/upload-image는 postId를 받지 않는 순수 "파일 → Storage → URL" 엔드포인트라
// 이 화면에서 올리든 글쓰기 화면에서 올리든 결과(URL)는 동일하다.
export default function BlogImagePanel({ adminToken, showToast }) {
  const [items, setItems] = useState([]) // { id, seq, filename, previewUrl, url, path, status, error }
  const [copiedId, setCopiedId] = useState('')
  const fileInputRef = useRef(null)
  // 업로드 순서를 가리키는 번호는 삭제해도 재배치되지 않도록 별도 카운터로 관리한다
  // (배열 index로 매기면 앞의 항목을 지웠을 때 뒤 항목 번호가 밀려서, 채팅에서 이미
  // 말해둔 "3번"이 다른 사진을 가리키게 되는 문제가 생긴다).
  const seqRef = useRef(0)

  const uploadOne = async (file) => {
    const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
    seqRef.current += 1
    const seq = seqRef.current
    const previewUrl = URL.createObjectURL(file)
    setItems(prev => [{ id, seq, filename: file.name, previewUrl, url: '', path: '', status: 'uploading', error: '' }, ...prev])

    try {
      if (!ALLOWED.includes(file.type)) throw new Error('이미지 파일(jpg/png/gif/webp)만 업로드할 수 있습니다.')
      if (file.size > 10 * 1024 * 1024) throw new Error('10MB 이하 파일만 업로드할 수 있습니다.')
      const base64 = await fileToBase64(file)
      const res = await fetch('/api/admin/upload-image', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ base64, contentType: file.type, filename: file.name }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '업로드 실패')
      setItems(prev => prev.map(it => it.id === id ? { ...it, url: data.url, path: extractStoragePath(data.url), status: 'done' } : it))
    } catch (e) {
      setItems(prev => prev.map(it => it.id === id ? { ...it, status: 'error', error: e.message } : it))
    }
  }

  const handleFiles = (fileList) => {
    Array.from(fileList || []).forEach(uploadOne)
  }

  const onInputChange = (e) => {
    handleFiles(e.target.files)
    e.target.value = '' // 같은 파일을 다시 선택해도 onChange가 발생하도록 초기화
  }

  const onDrop = (e) => {
    e.preventDefault()
    handleFiles(e.dataTransfer.files)
  }

  const copyUrl = (id, url) => {
    if (!url) return
    try {
      navigator.clipboard.writeText(url)
      setCopiedId(id)
      setTimeout(() => setCopiedId(''), 1500)
      showToast?.('✅ 링크가 복사됐습니다')
    } catch {}
  }

  const deleteItem = async (item) => {
    if (item.path) {
      try {
        await fetch('/api/admin/delete-image', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
          body: JSON.stringify({ path: item.path }),
        })
      } catch {}
    }
    try { URL.revokeObjectURL(item.previewUrl) } catch {}
    setItems(prev => prev.filter(it => it.id !== item.id))
    showToast?.('🗑️ 삭제됨')
  }

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>🖼️ 블로그 사진 업로드</div>
      <p style={{ fontSize: 13, color: '#9aa0ab', marginBottom: 16, lineHeight: 1.6 }}>
        외부 자료 스크린샷 등 이미지를 여기서 올리면 바로 URL이 생성됩니다. 어느 글에 쓸지는
        정해두지 않아도 되고, 앞의 번호와 함께 URL을 복사해서 Claude 채팅에 "N번 사진이에요"처럼
        붙여넣으면 원하는 글의 원하는 위치에 삽입해드립니다.
      </p>

      <div
        onDragOver={e => e.preventDefault()}
        onDrop={onDrop}
        onClick={() => fileInputRef.current?.click()}
        style={{
          border: '2px dashed #2a2e38', borderRadius: 12, padding: '32px 20px',
          textAlign: 'center', cursor: 'pointer', marginBottom: 20, background: '#0f1115',
        }}
      >
        <div style={{ fontSize: 28, marginBottom: 8 }}>📤</div>
        <div style={{ fontSize: 14, color: '#e8eaed', fontWeight: 600 }}>클릭하거나 이미지를 여기로 끌어다 놓으세요</div>
        <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 4 }}>jpg / png / gif / webp, 10MB 이하 (여러 장 동시 선택 가능)</div>
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/gif,image/webp"
          multiple
          onChange={onInputChange}
          style={{ display: 'none' }}
        />
      </div>

      {items.length === 0 && (
        <p style={{ fontSize: 13, color: '#9aa0ab' }}>아직 업로드한 이미지가 없습니다.</p>
      )}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
        {items.map(it => (
          <div key={it.id} style={{ ...S.row, display: 'flex', alignItems: 'center', gap: 14 }}>
            <div style={{
              flexShrink: 0, width: 28, height: 28, borderRadius: '50%', background: '#0f1115',
              border: '1px solid #2a2e38', display: 'flex', alignItems: 'center', justifyContent: 'center',
              fontSize: 12, fontWeight: 800, color: '#4CAF50',
            }}>{it.seq}</div>
            <img src={it.previewUrl} alt="" style={{ width: 56, height: 56, objectFit: 'cover', borderRadius: 8, flexShrink: 0, background: '#000' }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div style={{ fontSize: 13, color: '#e8eaed', fontWeight: 600, marginBottom: 6, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {it.seq}번 · {it.filename}
              </div>
              {it.status === 'uploading' && <div style={{ fontSize: 12, color: '#9aa0ab' }}>업로드 중...</div>}
              {it.status === 'error' && <div style={{ fontSize: 12, color: '#F44336' }}>❌ {it.error}</div>}
              {it.status === 'done' && (
                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                  <input readOnly value={it.url} onFocus={e => e.target.select()} style={{ ...S.input, fontSize: 12, padding: '6px 10px' }} />
                  <button onClick={() => copyUrl(it.id, it.url)} style={{ ...S.btn(copiedId === it.id ? '#2a2e38' : '#4CAF50'), flexShrink: 0, padding: '6px 14px', fontSize: 12 }}>
                    {copiedId === it.id ? '복사됨!' : '복사'}
                  </button>
                </div>
              )}
            </div>
            <button onClick={() => deleteItem(it)} title="삭제" style={{
              flexShrink: 0, background: 'none', border: '1px solid #2a2e38', borderRadius: 8,
              color: '#F44336', fontSize: 12, fontWeight: 700, padding: '8px 12px', cursor: 'pointer', fontFamily: 'inherit',
            }}>삭제</button>
          </div>
        ))}
      </div>
    </div>
  )
}
