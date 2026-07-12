import { useState, useEffect } from 'react'
import Head from 'next/head'
import LicenseAdminPanel from '../components/admin/LicenseAdminPanel'
import BlogAdminPanel from '../components/admin/BlogAdminPanel'
import BlogMenuPanel from '../components/admin/BlogMenuPanel'
import ContentLogPanel from '../components/admin/ContentLogPanel'
import SystemPromptPanel from '../components/admin/SystemPromptPanel'
import PopupPanel from '../components/admin/PopupPanel'
import BoardAdminPanel from '../components/admin/BoardAdminPanel'
import { S, Toast } from '../components/admin/AdminUI'

const TAB_LABELS = {
  licenses: '🔑 라이선스 관리',
  blogwrite: '✍️ 블로그글쓰기',
  blogmanage: '📝 블로그관리',
  blogmenu: '📂 블로그메뉴관리',
  contentlog: '📋 발행기록',
  freeboard: '💬 자유게시판',
  systemprompt: '🤖 Claude 지침',
  popup: '📢 팝업관리',
  password: '🔒 비밀번호 변경',
}

function LoginScreen({ onLogin }) {
  const [pw, setPw] = useState('')
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(false)

  const submit = async (e) => {
    e.preventDefault()
    setLoading(true); setErr('')
    try {
      const res = await fetch('/api/settings/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password: pw }),
      })
      const data = await res.json()
      if (!res.ok) { setErr(data.error || '비밀번호가 틀렸습니다'); setTimeout(() => setErr(''), 2500) }
      else { sessionStorage.setItem('admin_token', data.token); onLogin(data.token) }
    } catch { setErr('서버 연결 실패') }
    setLoading(false)
  }

  return (
    <div style={{ minHeight: '100vh', background: '#0f1115', display: 'flex', alignItems: 'center', justifyContent: 'center', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif' }}>
      <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 14, padding: 40, width: 360 }}>
        <div style={{ marginBottom: 28 }}>
          <div style={{ width: 44, height: 44, background: '#4CAF50', borderRadius: 11, display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 22, marginBottom: 16 }}>📈</div>
          <h1 style={{ fontSize: 24, fontWeight: 800, color: '#e8eaed', margin: 0 }}>Admin</h1>
          <p style={{ color: '#9aa0ab', fontSize: 14, marginTop: 4 }}>매매 시스템 관리자</p>
        </div>
        <form onSubmit={submit}>
          <input type="password" placeholder="비밀번호" value={pw} onChange={e => setPw(e.target.value)}
            style={{ ...S.input, borderColor: err ? '#F44336' : '#2a2e38', marginBottom: 8 }} />
          {err && <p style={{ color: '#F44336', fontSize: 13, marginBottom: 8 }}>{err}</p>}
          <button type="submit" disabled={loading} style={{ ...S.btn(), width: '100%', marginTop: 8, opacity: loading ? 0.6 : 1 }}>
            {loading ? '확인 중...' : '로그인'}
          </button>
        </form>
      </div>
    </div>
  )
}

function PasswordPanel({ adminToken, showToast }) {
  const [newPw, setNewPw] = useState('')
  const [newPwConfirm, setNewPwConfirm] = useState('')
  const [msg, setMsg] = useState(null)

  const changePw = async () => {
    if (!newPw) { setMsg({ ok: false, text: '새 비밀번호를 입력하세요' }); return }
    if (newPw !== newPwConfirm) { setMsg({ ok: false, text: '비밀번호가 일치하지 않습니다' }); return }
    try {
      const res = await fetch('/api/settings/password', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ newPassword: newPw }),
      })
      if (!res.ok) throw new Error()
      setMsg({ ok: true, text: '✅ 비밀번호가 변경되었습니다' })
      setNewPw(''); setNewPwConfirm('')
      showToast?.('✅ 비밀번호 변경됨')
    } catch { setMsg({ ok: false, text: '변경 실패' }) }
  }

  return (
    <div style={S.card}>
      <div style={S.cardTitle}>🔒 비밀번호 변경</div>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 14, maxWidth: 360 }}>
        <div>
          <label style={S.label}>새 비밀번호</label>
          <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} style={S.input} />
        </div>
        <div>
          <label style={S.label}>새 비밀번호 확인</label>
          <input type="password" value={newPwConfirm} onChange={e => setNewPwConfirm(e.target.value)} style={S.input} />
        </div>
        {msg && <p style={{ color: msg.ok ? '#4CAF50' : '#F44336', fontSize: 13 }}>{msg.text}</p>}
        <button onClick={changePw} style={{ ...S.btn(), alignSelf: 'flex-start' }}>변경하기</button>
      </div>
    </div>
  )
}

export default function Admin() {
  const [authed, setAuthed] = useState(false)
  const [adminToken, setAdminToken] = useState('')
  const [loading, setLoading] = useState(true)
  const [activeTab, setActiveTab] = useState('licenses')
  const [toast, setToast] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2500) }

  useEffect(() => {
    const token = sessionStorage.getItem('admin_token')
    if (token) { setAuthed(true); setAdminToken(token) }
    setLoading(false)
  }, [])

  const handleLogout = () => {
    sessionStorage.removeItem('admin_token')
    setAuthed(false)
  }

  if (loading) return null
  if (!authed) return <LoginScreen onLogin={(t) => { setAuthed(true); setAdminToken(t) }} />

  return (
    <>
      <Head><title>Admin — 매매 시스템</title></Head>
      <div style={{ minHeight: '100vh', background: '#0f1115', fontFamily: '-apple-system, "Segoe UI", "Malgun Gothic", sans-serif', color: '#e8eaed', display: 'flex' }}>
        <aside style={{ width: 220, minWidth: 220, background: '#171a21', borderRight: '1px solid #2a2e38', display: 'flex', flexDirection: 'column', height: '100vh', position: 'sticky', top: 0 }}>
          <div style={{ padding: '24px 20px 20px', borderBottom: '1px solid #2a2e38' }}>
            <div style={{ fontSize: 15, fontWeight: 700 }}>Admin Panel</div>
            <div style={{ fontSize: 11, color: '#9aa0ab', marginTop: 2 }}>매매 시스템</div>
          </div>
          <nav style={{ flex: 1, padding: '12px 0' }}>
            {Object.entries(TAB_LABELS).map(([id, label]) => (
              <button key={id} onClick={() => setActiveTab(id)} style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 10, padding: '10px 20px',
                background: activeTab === id ? 'rgba(76,175,80,0.15)' : 'none',
                border: 'none', borderLeft: activeTab === id ? '3px solid #4CAF50' : '3px solid transparent',
                color: activeTab === id ? '#4CAF50' : '#9aa0ab',
                fontSize: 14, fontWeight: activeTab === id ? 700 : 500,
                cursor: 'pointer', textAlign: 'left', fontFamily: 'inherit',
              }}>{label}</button>
            ))}
          </nav>
          <div style={{ padding: '12px 20px', borderTop: '1px solid #2a2e38', display: 'flex', flexDirection: 'column', gap: 6 }}>
            <a href="/" style={{ color: '#9aa0ab', fontSize: 13, textDecoration: 'none', padding: '6px 0' }}>← 사이트로</a>
            <button onClick={handleLogout} style={{ background: 'none', border: 'none', cursor: 'pointer', color: '#9aa0ab', fontSize: 14, padding: '6px 0', textAlign: 'left', fontFamily: 'inherit' }}>🚪 로그아웃</button>
          </div>
        </aside>

        <main style={{ flex: 1, minWidth: 0, padding: '32px 28px 60px' }}>
          <style>{`
            /* styles/site.css의 전역 button { width:100%; margin-top:20px } 이 관리자 화면
               버튼들(미리보기/발행/삭제 등)을 전부 강제로 늘려버리는 문제를 이 영역 안에서만 되돌린다. */
            main button { width: auto; margin-top: 0; }
          `}</style>
          <div style={{ maxWidth: 900, margin: '0 auto' }}>
            {activeTab === 'licenses' && <LicenseAdminPanel adminToken={adminToken} showToast={showToast} />}
            {activeTab === 'blogwrite' && <BlogAdminPanel adminToken={adminToken} showToast={showToast} initialView="write" />}
            {activeTab === 'blogmanage' && <BlogAdminPanel adminToken={adminToken} showToast={showToast} initialView="list" />}
            {activeTab === 'blogmenu' && <BlogMenuPanel adminToken={adminToken} />}
            {activeTab === 'contentlog' && <ContentLogPanel adminToken={adminToken} />}
            {activeTab === 'freeboard' && <BoardAdminPanel adminToken={adminToken} />}
            {activeTab === 'systemprompt' && <SystemPromptPanel adminToken={adminToken} />}
            {activeTab === 'popup' && <PopupPanel adminToken={adminToken} />}
            {activeTab === 'password' && <PasswordPanel adminToken={adminToken} showToast={showToast} />}
          </div>
        </main>
      </div>
      <Toast msg={toast} />
    </>
  )
}
