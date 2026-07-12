import { useState, useEffect } from 'react'
import { S } from './AdminUI'
import BlogMenuPanel from './BlogMenuPanel'
import { parseMarkdown as parseMd } from '../../lib/parseMarkdown'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}
function nowKSTDate() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000)
}

function slugify(text) {
  if (!text) return ''
  let r = text.trim().toLowerCase()
  if (/[가-힣]/.test(r)) {
    const eng = r.match(/[a-z0-9]+/g)
    return (eng && eng.join('').length >= 2) ? eng.join('-') : 'post-' + Date.now().toString(36)
  }
  return r.replace(/[^a-z0-9-]/g, '').replace(/\s+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || 'post-' + Date.now().toString(36)
}

// ── SEO 체크리스트 데이터 (fresh-season BlogAdminPanel과 동일 구성)
const TOOL_PANELS = {
  adsense: {
    label: '💰 애드센스', color: '#d97706', border: '#78500a',
    link: 'https://www.google.com/adsense', linkLabel: '애드센스 대시보드 →',
    sections: [
      { title: '🚀 최초 셋팅 (한 번만)', color: '#fbbf24',
        items: [
          { text: '사이트 URL 등록 및 소유권 확인', desc: '애드센스 가입 후 사이트 주소 등록, <head>에 메타태그 삽입' },
          { text: 'ads.txt 파일 루트에 업로드', desc: 'google.com, pub-XXXXXXX, DIRECT, f08c47fec0942fa0 형식' },
          { text: '자동 광고 ON 또는 광고 단위 수동 생성', desc: '자동 광고는 구글이 최적 위치 자동 배치' },
          { text: '광고 코드를 <head> 또는 본문에 삽입', desc: '_app.js의 <Head>에 Script 컴포넌트로 로드' },
        ] },
      { title: '📋 주기적으로 확인', color: '#f59e0b',
        items: [
          { text: '[주간] 수익 및 RPM 확인', desc: '대시보드 → 보고서에서 날짜별 수익 추이 체크' },
          { text: '[수시] 정책 위반 경고 확인', desc: '알림 탭에 빨간 경고 뜨면 즉시 조치' },
          { text: '[월간] 잘 클릭되는 광고 위치 파악', desc: '본문 상단·목차 아래·본문 중간이 CTR 높음' },
          { text: '[월간] 모바일 광고 노출 확인', desc: '반응형 광고 단위 사용 여부 체크' },
        ] } ],
  },
  searchconsole: {
    label: '🔍 서치콘솔', color: '#16a34a', border: '#166534',
    link: 'https://search.google.com/search-console', linkLabel: 'Search Console →',
    sections: [
      { title: '🚀 최초 셋팅', color: '#4ade80',
        items: [
          { text: '속성 추가 및 소유권 인증', desc: 'URL 접두사 방식 권장' },
          { text: 'sitemap.xml 제출', desc: '설정 → Sitemaps → sitemap.xml 제출' },
          { text: 'robots.txt 확인', desc: '크롤링 차단 규칙 없는지 확인' },
          { text: 'Google Analytics 연결', desc: '설정 → 연결 → Analytics 연동' },
        ] },
      { title: '📋 주기적으로 확인', color: '#22c55e',
        items: [
          { text: '[월간] 검색 성과 확인', desc: '어떤 키워드로 유입되는지 확인 — CTR 낮은 글은 제목/메타설명 수정 검토' },
          { text: '[월간] 색인 생성 현황 확인', desc: '색인이 생성되지 않은 페이지 원인 파악' },
          { text: '[글 발행 시] URL 즉시 검사 요청', desc: 'URL 검사 → 색인 생성 요청' },
          { text: '[분기] 모바일 사용성 오류 확인', desc: '경험 → 모바일 사용성' },
          { text: '[분기] Core Web Vitals 점수 확인', desc: 'LCP·INP·CLS 점수 확인 및 개선' },
        ] } ],
  },
  analytics: {
    label: '📊 애널리틱스', color: '#2563eb', border: '#1d4ed8',
    link: 'https://analytics.google.com', linkLabel: 'Google Analytics →',
    sections: [
      { title: '🚀 최초 셋팅', color: '#60a5fa',
        items: [
          { text: 'GA4 속성 생성 및 데이터 스트림 추가', desc: '측정 ID(G-XXXXXXXX) 발급' },
          { text: '측정 ID를 사이트 <head>에 삽입', desc: '_app.js에 Script 컴포넌트로 gtag.js 로드' },
          { text: 'Search Console 연결', desc: 'GA4 관리 → 속성 → Search Console 링크' },
          { text: '목표/전환 이벤트 설정', desc: '신청 완료, 문의 클릭 등 중요 액션을 전환으로 표시' },
        ] },
      { title: '📋 주기적으로 확인', color: '#3b82f6',
        items: [
          { text: '[수시] 실시간 사용자 수 확인', desc: '새 글 발행 직후 트래픽 반응 체크' },
          { text: '[주간] 유입 채널별 트래픽 분석', desc: '획득 → 트래픽 획득' },
          { text: '[주간] 인기 페이지 TOP 10 확인', desc: '참여 → 페이지 및 화면' },
          { text: '[월간] 이탈률·평균 참여 시간 확인', desc: '참여 시간 짧으면 도입부 개선' },
        ] } ],
  },
  ogtag: {
    label: '🔗 OG태그', color: '#7c3aed', border: '#5b21b6',
    link: 'https://developers.facebook.com/tools/debug/', linkLabel: 'OG 태그 검사기 →',
    sections: [
      { title: '🚀 최초 셋팅', color: '#a78bfa',
        items: [
          { text: 'og:title 추가', desc: '<meta property="og:title" content="사이트 제목" />' },
          { text: 'og:description 추가 (80~160자)', desc: '<meta property="og:description" content="..." />' },
          { text: 'og:image 추가 (1200x630px 권장)', desc: 'SNS 공유 시 표시되는 썸네일' },
          { text: '블로그 글 페이지에도 동적 OG 태그 적용', desc: '각 글의 제목/요약/커버이미지가 OG로 출력되는지 확인' },
        ] },
      { title: '📋 주기적으로 확인', color: '#8b5cf6',
        items: [
          { text: 'Facebook 공유 디버거로 OG 태그 확인', desc: '캐시 새로고침도 여기서 가능' },
          { text: '카카오톡 공유 미리보기 확인', desc: '링크 공유 시 썸네일·제목 테스트' },
        ] } ],
  },
  seo: {
    label: '🚀 SEO', color: '#0891b2', border: '#155e75',
    link: 'https://search.google.com/search-console', linkLabel: '서치콘솔 →',
    sections: [
      { title: '🏗️ 기술적 SEO', color: '#22d3ee',
        items: [
          { text: 'sitemap.xml 자동 생성 및 제출', desc: '새 글 발행 시 sitemap 자동 갱신 확인' },
          { text: 'robots.txt 정상 설정 확인', desc: '/admin은 Disallow, /blog는 Allow' },
          { text: 'canonical URL 태그 삽입', desc: '중복 페이지 문제 방지' },
          { text: '모바일 반응형 확인', desc: '구글은 모바일 우선 색인' },
        ] },
      { title: '✍️ 글 작성 시 매번 체크', color: '#06b6d4',
        items: [
          { text: '핵심 키워드를 제목(H1)에 포함', desc: '검색자가 실제로 치는 단어를 제목 앞쪽에 배치' },
          { text: '메타 description 작성 (80~160자)', desc: '키워드 포함 + 클릭 유도 문구' },
          { text: 'URL 슬러그를 짧고 명확하게', desc: '영문 소문자+하이픈, 한글 금지' },
          { text: 'H2·H3 소제목으로 콘텐츠 구조화', desc: '목차 역할 + 구글이 구조 파악' },
          { text: '내부 링크 2~3개 이상 삽입', desc: '관련 글·/apply 로 연결' },
          { text: '발행 후 서치콘솔에서 URL 색인 요청', desc: 'URL 검사 → 색인 생성 요청' },
        ] } ],
  },
  searchreg: {
    label: '🌐 검색엔진 등록', color: '#059669', border: '#065f46',
    link: 'https://searchadvisor.naver.com', linkLabel: '네이버 서치어드바이저 →',
    sections: [
      { title: '필수 등록', color: '#34d399',
        items: [
          { text: '구글 서치콘솔 등록', desc: '소유권 인증 · sitemap 제출 · GA4 연결' },
          { text: '네이버 서치어드바이저 등록', desc: '소유권 인증 · sitemap 제출' },
          { text: '빙 웹마스터 도구 등록', desc: '구글 서치콘솔에서 가져오기 가능' },
        ] },
      { title: '🔧 등록 후 해야 할 것', color: '#10b981',
        items: [
          { text: '각 검색엔진에 sitemap.xml 제출', desc: '구글·네이버·빙 모두 제출' },
          { text: '소유권 인증 메타태그 삽입', desc: '구글·네이버 인증 메타태그 <head>에 추가' },
        ] } ],
  },
}

// ── 루틴 체크리스트 데이터
const ROUTINES = {
  publish: {
    label: '📝 글 발행할 때마다', color: '#7c3aed',
    items: [
      { text: '서치콘솔 URL 색인 요청', link: 'https://search.google.com/search-console', desc: 'URL 검사 → 색인 생성 요청' },
      { text: '실시간 트래픽 확인', link: 'https://analytics.google.com', desc: '발행 후 GA4 실시간 탭 확인' },
    ],
  },
  weekly: {
    label: '📅 매주 토요일 확인', color: '#0891b2',
    items: [
      { text: '애드센스 수익/RPM 확인', link: 'https://www.google.com/adsense', desc: '보고서 → 날짜별 수익 추이' },
      { text: '서치콘솔 검색 성과 확인', link: 'https://search.google.com/search-console', desc: '클릭수·노출수·CTR 키워드 분석' },
      { text: 'GA4 인기 페이지 TOP 10', link: 'https://analytics.google.com', desc: '참여 → 페이지 및 화면' },
    ],
  },
  monthly: {
    label: '🗓️ 매월 마지막 토요일', color: '#d97706',
    items: [
      { text: '애드센스 광고 위치 CTR 분석', link: 'https://www.google.com/adsense', desc: '어떤 위치 광고가 잘 클릭되는지 파악' },
      { text: '서치콘솔 색인 현황 확인', link: 'https://search.google.com/search-console', desc: '색인 안 된 페이지 원인 파악' },
      { text: 'CTR 낮은 글 제목/메타설명 개선', link: 'https://search.google.com/search-console', desc: '성과 → CTR 낮은 페이지 찾아 수정' },
      { text: '오래된 글 콘텐츠 업데이트', link: null, desc: '6개월~1년 된 글 최신 정보로 갱신 후 재색인 요청' },
    ],
  },
}

const emptyForm = { title: '', slug: '', summary: '', content: '', category: '', tags: '', thumbnail: '', scheduledAt: '', publishedAt: '' }

export default function BlogAdminPanel({ adminToken, showToast }) {
  const [view, setView] = useState('list') // list | write | menu
  const [posts, setPosts] = useState([])
  const [loading, setLoading] = useState(false)
  const [filterType, setFilterType] = useState('all')
  const [preview, setPreview] = useState(false)
  const [editId, setEditId] = useState(null)
  const [msg, setMsg] = useState('')
  const [categories, setCategories] = useState([])

  const [activeToolPanel, setActiveToolPanel] = useState(null)
  const [checklistChecks, setChecklistChecks] = useState({})

  const [showRoutine, setShowRoutine] = useState(false)
  const [routineChecks, setRoutineChecks] = useState({})
  const [collapsedRoutines, setCollapsedRoutines] = useState({})

  const [form, setForm] = useState(emptyForm)

  useEffect(() => { loadPosts(); loadCategories(); loadChecklist() }, [])

  const loadChecklist = async () => {
    try {
      const res = await fetch('/api/admin/checklist', { headers: { 'x-admin-token': adminToken } })
      if (!res.ok) return
      const data = await res.json()
      if (data.checklist) setChecklistChecks(data.checklist)
      if (data.routine) setRoutineChecks(data.routine)
    } catch {}
  }

  const saveChecklist = async (checklist, routine) => {
    try {
      await fetch('/api/admin/checklist', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ checklist, routine }),
      })
    } catch {}
  }

  const loadPosts = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/blog/posts?limit=100', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setPosts(Array.isArray(data) ? data : [])
    } catch {}
    setLoading(false)
  }

  const loadCategories = async () => {
    try {
      const res = await fetch('/api/blog/categories')
      const data = await res.json()
      setCategories(Array.isArray(data) ? data : [])
    } catch {}
  }

  const allCategories = categories.map(c => c.label)

  const handleNew = () => { setEditId(null); setForm(emptyForm); setPreview(false); setView('write') }

  const handleEdit = (post) => {
    setEditId(post.id)
    setForm({
      title: post.title || '', slug: post.slug || '', summary: post.summary || '',
      content: post.content || '', category: post.category || '',
      tags: Array.isArray(post.tags) ? post.tags.join(', ') : '',
      thumbnail: post.cover_image || '',
      scheduledAt: post.scheduled_at ? post.scheduled_at.slice(0, 16) : '',
      publishedAt: post.published_at || '',
    })
    setPreview(false); setView('write')
  }

  const handleDelete = async (post) => {
    if (!confirm(`"${post.title}" 을(를) 삭제할까요?`)) return
    await fetch(`/api/blog/posts?id=${post.id}`, { method: 'DELETE', headers: { 'x-admin-token': adminToken } })
    loadPosts()
  }

  const handleSave = async (status) => {
    if (!form.title.trim()) { setMsg('❌ 제목을 입력해주세요'); setTimeout(() => setMsg(''), 3000); return }
    if (!form.content.trim()) { setMsg('❌ 내용을 입력해주세요'); setTimeout(() => setMsg(''), 3000); return }
    if (status === 'scheduled') {
      if (!form.scheduledAt) { setMsg('❌ 예약 날짜/시간을 입력해주세요'); setTimeout(() => setMsg(''), 3000); return }
      if (new Date(form.scheduledAt) <= nowKSTDate()) { setMsg('❌ 예약 시간은 현재 이후여야 합니다'); setTimeout(() => setMsg(''), 3000); return }
    }
    setLoading(true)
    try {
      const slug = form.slug.trim() || slugify(form.title)
      const tags = form.tags ? form.tags.split(',').map(t => t.trim()).filter(Boolean) : []
      const body = {
        title: form.title.trim(), slug, summary: form.summary.trim(),
        content: form.content, category: form.category, tags,
        cover_image: form.thumbnail.trim(), status,
        scheduled_at: status === 'scheduled' ? new Date(form.scheduledAt).toISOString() : null,
        published_at: status === 'published' ? (form.publishedAt || nowKST()) : (form.publishedAt || null),
      }
      const method = editId ? 'PUT' : 'POST'
      if (editId) body.id = editId
      const res = await fetch('/api/blog/posts', { method, headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken }, body: JSON.stringify(body) })
      if (!res.ok) throw new Error()
      setMsg(status === 'published' ? '🚀 발행 완료!' : status === 'scheduled' ? '⏰ 예약발행 설정!' : '💾 임시저장 완료')
      setTimeout(() => setMsg(''), 3000)
      setView('list'); setEditId(null); setForm(emptyForm); loadPosts()
    } catch {
      setMsg('❌ 저장 실패'); setTimeout(() => setMsg(''), 3000)
    }
    setLoading(false)
  }

  const toggleCheck = (key) => {
    const next = { ...checklistChecks, [key]: !checklistChecks[key] }
    setChecklistChecks(next); saveChecklist(next, routineChecks)
  }

  const getWeekKey = () => { const n = nowKSTDate(); const s = new Date(n.getFullYear(), 0, 1); return `${n.getFullYear()}-W${Math.ceil(((n - s) / 86400000 + s.getDay() + 1) / 7)}` }
  const getMonthKey = () => { const n = nowKSTDate(); return `${n.getFullYear()}-M${n.getMonth() + 1}` }

  const toggleRoutine = (periodKey, ii) => {
    const k = `${periodKey}__${ii}`
    const next = { ...routineChecks, [k]: !routineChecks[k] }
    setRoutineChecks(next); saveChecklist(checklistChecks, next)
  }

  const _kstIso = new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString()
  const year = parseInt(_kstIso.slice(0, 4), 10), month = parseInt(_kstIso.slice(5, 7), 10) - 1, today = parseInt(_kstIso.slice(8, 10), 10)
  const firstDay = new Date(year, month, 1).getDay()
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const monthStr = `${year}-${String(month + 1).padStart(2, '0')}`
  const dailyCount = {}
  posts.forEach(p => {
    if (p.status === 'published' && (p.published_at || p.created_at)) {
      const ds = new Date(new Date(p.published_at || p.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10)
      if (ds.startsWith(monthStr)) dailyCount[parseInt(ds.slice(8, 10))] = (dailyCount[parseInt(ds.slice(8, 10))] || 0) + 1
    }
  })
  const saturdays = []
  for (let d = 1; d <= daysInMonth; d++) if (new Date(year, month, d).getDay() === 6) saturdays.push(d)
  const lastSat = saturdays[saturdays.length - 1]

  const filteredPosts = filterType === 'all' ? posts : posts.filter(p => (p.category || '') === filterType)

  if (view === 'menu') {
    return (
      <div>
        <button onClick={() => setView('list')} style={{ ...S.btnGhost, marginBottom: 16 }}>← 목록으로</button>
        <BlogMenuPanel adminToken={adminToken} />
      </div>
    )
  }

  return (
    <div>
      <style>{`
        .md-preview { line-height:1.8; color:#e8eaed; font-size:15px; word-break:keep-all; }
        .md-preview h1 { font-size:22px; font-weight:800; margin:20px 0 10px; }
        .md-preview h2 { font-size:18px; font-weight:700; margin:16px 0 8px; border-bottom:2px solid #2a2e38; padding-bottom:6px; }
        .md-preview h3 { font-size:15px; font-weight:700; margin:14px 0 6px; }
        .md-preview p { margin:10px 0; }
        .md-preview ul, .md-preview ol { padding-left:22px; margin:10px 0; }
        .md-preview li { margin:5px 0; line-height:1.7; }
        .md-preview strong { font-weight:700; }
        .md-preview code { background:#0f1115; padding:2px 6px; border-radius:4px; font-size:12px; font-family:monospace; color:#4CAF50; }
        .md-preview pre { background:#0f1115; color:#e8eaed; padding:14px 18px; border-radius:8px; overflow-x:auto; margin:14px 0; }
        .md-preview blockquote { border-left:4px solid #4CAF50; padding:8px 14px; background:#0f1115; margin:14px 0; border-radius:0 6px 6px 0; }
        .md-preview a { color:#4CAF50; text-decoration:underline; }
        .md-preview img { max-width:100%; border-radius:8px; margin:8px 0; display:block; }
        .md-preview table { width:100%; border-collapse:collapse; margin:16px 0; font-size:14px; }
        .md-preview th { background:#0f1115; padding:10px 14px; text-align:left; border:1px solid #2a2e38; }
        .md-preview td { padding:10px 14px; border:1px solid #2a2e38; }
      `}</style>

      {view === 'list' && (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 20 }}>
          <div style={{ ...S.cardTitle, marginBottom: 0 }}>📝 블로그 관리 ({posts.length})</div>
          <div style={{ display: 'flex', gap: 8 }}>
            <button onClick={() => setView('menu')} style={S.btnGhost}>📂 카테고리 관리</button>
            <button onClick={handleNew} style={S.btn()}>+ 새 글</button>
          </div>
        </div>
      )}

      {msg && <div style={{ padding: '12px 16px', borderRadius: 10, marginBottom: 16, fontSize: 14, background: msg.startsWith('🚀') || msg.startsWith('💾') || msg.startsWith('⏰') ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)', color: msg.startsWith('🚀') || msg.startsWith('💾') || msg.startsWith('⏰') ? '#4CAF50' : '#F44336' }}>{msg}</div>}

      {view === 'write' && (
        <div style={{ display: 'grid', gridTemplateColumns: preview ? '1fr 1.1fr' : '1fr', gap: 24 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <button onClick={() => { setView('list'); setEditId(null); setForm(emptyForm) }} style={S.btnGhost}>← 목록</button>
              <h2 style={{ fontSize: 18, fontWeight: 700, margin: 0 }}>{editId ? '✏️ 글 수정' : '📝 새 글 작성'}</h2>
            </div>

            <input value={form.title} onChange={e => setForm(v => ({ ...v, title: e.target.value, slug: v.slug || slugify(e.target.value) }))}
              placeholder="제목을 입력하세요" style={{ ...S.input, fontSize: 18, fontWeight: 700, padding: '12px 14px' }} />

            <div style={{ display: 'grid', gridTemplateColumns: '1fr', gap: 10 }}>
              <div>
                <label style={S.label}>URL 슬러그</label>
                <input value={form.slug} onChange={e => setForm(v => ({ ...v, slug: e.target.value }))} placeholder="url-slug" style={S.input} />
              </div>
              <div>
                <label style={S.label}>카테고리</label>
                <select value={form.category} onChange={e => setForm(v => ({ ...v, category: e.target.value }))} style={S.input}>
                  <option value="">(선택 안 함)</option>
                  {allCategories.map(c => <option key={c} value={c}>{c}</option>)}
                </select>
              </div>
              <div>
                <label style={S.label}>태그 (쉼표 구분)</label>
                <input value={form.tags} onChange={e => setForm(v => ({ ...v, tags: e.target.value }))} placeholder="태그1, 태그2" style={S.input} />
              </div>
            </div>

            <div>
              <label style={S.label}>요약 (SEO description, 160자 이내)</label>
              <textarea value={form.summary} onChange={e => setForm(v => ({ ...v, summary: e.target.value }))} rows={2} maxLength={200}
                placeholder="검색엔진에 표시될 요약 문구" style={{ ...S.input, resize: 'vertical' }} />
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 10 }}>
              <div>
                <label style={S.label}>발행일 (비워두면 발행 시각 자동 기록)</label>
                <input type="date" value={form.publishedAt ? form.publishedAt.slice(0, 10) : ''}
                  onChange={e => setForm(v => ({ ...v, publishedAt: e.target.value ? new Date(e.target.value).toISOString() : '' }))}
                  style={S.input} />
              </div>
              <div>
                <label style={S.label}>커버 이미지 URL</label>
                <input value={form.thumbnail} onChange={e => setForm(v => ({ ...v, thumbnail: e.target.value }))} placeholder="https://..." style={S.input} />
              </div>
            </div>

            <div>
              <label style={S.label}>본문 (마크다운)</label>
              <textarea value={form.content} onChange={e => setForm(v => ({ ...v, content: e.target.value }))}
                rows={22} placeholder={'# 제목\n\n본문을 마크다운으로 작성하세요.\n\n## 소제목\n\n- 항목 1\n- 항목 2\n\n**굵게** *기울임* `코드`'}
                style={{ ...S.input, fontFamily: 'monospace', resize: 'vertical', lineHeight: 1.7 }} />
            </div>

            <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
              <button onClick={() => setPreview(v => !v)} style={S.btnGhost}>{preview ? '✏️ 편집' : '👁 미리보기'}</button>
              <button onClick={() => handleSave('draft')} disabled={loading} style={S.btn('#555')}>💾 임시저장</button>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, background: 'rgba(63,81,181,0.1)', border: '1.5px solid #3F51B5', borderRadius: 8, padding: '4px 10px' }}>
                <input type="datetime-local" value={form.scheduledAt} onChange={e => setForm(v => ({ ...v, scheduledAt: e.target.value }))}
                  min={new Date(Date.now() + 60000).toISOString().slice(0, 16)}
                  style={{ border: 'none', background: 'transparent', fontSize: 12, color: '#8c9eff', outline: 'none', cursor: 'pointer' }} />
                <button onClick={() => handleSave('scheduled')} disabled={loading} style={{ ...S.btn('#3F51B5'), padding: '5px 10px', fontSize: 12 }}>⏰ 예약</button>
              </div>
              <button onClick={() => handleSave('published')} disabled={loading} style={S.btn()}>{loading ? '저장 중...' : '🚀 발행'}</button>
            </div>
          </div>

          {preview && (
            <div style={{ ...S.card, overflowY: 'auto', maxHeight: '90vh', position: 'sticky', top: 20, marginBottom: 0 }}>
              <div style={{ fontSize: 11, fontWeight: 700, color: '#9aa0ab', marginBottom: 12, textTransform: 'uppercase', letterSpacing: 1 }}>미리보기</div>
              {form.thumbnail && <img src={form.thumbnail} alt="" style={{ width: '100%', height: 160, objectFit: 'cover', borderRadius: 10, marginBottom: 16, display: 'block' }} />}
              <h1 style={{ fontSize: 22, fontWeight: 800, marginBottom: 12 }}>{form.title || '(제목 없음)'}</h1>
              {form.summary && <div style={{ background: 'rgba(76,175,80,0.08)', border: '1px solid #2a2e38', borderRadius: 8, padding: '10px 14px', marginBottom: 16, fontSize: 13, lineHeight: 1.7 }}>{form.summary}</div>}
              <div className="md-preview" dangerouslySetInnerHTML={{ __html: parseMd(form.content) }} />
            </div>
          )}
        </div>
      )}

      {view === 'list' && (
        <>
          <div style={{ marginBottom: 16 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', padding: '10px 14px', background: '#171a21', borderRadius: activeToolPanel ? '10px 10px 0 0' : '10px', border: '1px solid #2a2e38', borderBottom: activeToolPanel ? 'none' : '1px solid #2a2e38' }}>
              <span style={{ fontSize: 12, fontWeight: 700, color: '#9aa0ab', marginRight: 4, whiteSpace: 'nowrap' }}>🔧 관리 도구</span>
              {Object.entries(TOOL_PANELS).map(([key, t]) => {
                const isActive = activeToolPanel === key
                return (
                  <button key={key} onClick={() => setActiveToolPanel(isActive ? null : key)}
                    style={{ display: 'flex', alignItems: 'center', gap: 5, padding: '5px 12px', borderRadius: 7, border: `1.5px solid ${t.border}`, background: isActive ? `${t.color}22` : 'transparent', color: t.color, fontSize: 12, fontWeight: 700, cursor: 'pointer', whiteSpace: 'nowrap' }}>
                    {t.label} {isActive ? '▲' : '▼'}
                  </button>
                )
              })}
            </div>

            {activeToolPanel && (() => {
              const panel = TOOL_PANELS[activeToolPanel]
              return (
                <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderTop: `3px solid ${panel.color}`, borderRadius: '0 0 12px 12px', padding: '20px 22px' }}>
                  <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
                    <div>
                      <span style={{ fontSize: 16, fontWeight: 800, color: panel.color }}>{panel.label} 필수 체크리스트</span>
                      <p style={{ fontSize: 12, color: '#9aa0ab', marginTop: 3 }}>아래 항목을 하나씩 확인하고 셋팅하세요.</p>
                    </div>
                    <a href={panel.link} target="_blank" rel="noopener noreferrer"
                      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, padding: '7px 16px', borderRadius: 8, background: panel.color, color: '#fff', fontSize: 12, fontWeight: 700, textDecoration: 'none' }}>
                      {panel.linkLabel}
                    </a>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 14 }}>
                    {panel.sections.map((sec, si) => (
                      <div key={si} style={{ background: '#0f1115', border: `1.5px solid ${sec.color}44`, borderRadius: 10, padding: '14px 16px' }}>
                        <div style={{ fontSize: 13, fontWeight: 800, color: sec.color, marginBottom: 10 }}>{sec.title}</div>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                          {sec.items.map((item, ii) => {
                            const ck = `${activeToolPanel}__${si}__${ii}`
                            const checked = ck in checklistChecks ? checklistChecks[ck] : false
                            return (
                              <div key={ii} onClick={() => toggleCheck(ck)}
                                style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: '#171a21', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', opacity: checked ? 0.65 : 1 }}>
                                <span style={{ fontSize: 18, flexShrink: 0, color: checked ? '#4CAF50' : '#9aa0ab' }}>{checked ? '☑' : '☐'}</span>
                                <div style={{ flex: 1 }}>
                                  <div style={{ fontSize: 13, fontWeight: 700, color: checked ? '#9aa0ab' : '#e8eaed', textDecoration: checked ? 'line-through' : 'none' }}>{item.text}</div>
                                  <div style={{ fontSize: 12, color: '#9aa0ab', lineHeight: 1.6 }}>{item.desc}</div>
                                </div>
                              </div>
                            )
                          })}
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )
            })()}
          </div>

          <div style={{ marginBottom: 16 }}>
            <button onClick={() => setShowRoutine(v => !v)}
              style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#171a21', borderRadius: showRoutine ? '10px 10px 0 0' : '10px', border: '1px solid #2a2e38', cursor: 'pointer', color: '#e8eaed' }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ fontSize: 13, fontWeight: 700 }}>📆 루틴 체크리스트 — {year}년 {month + 1}월</span>
                <span style={{ fontSize: 12, fontWeight: 700, color: '#4CAF50', background: 'rgba(76,175,80,0.1)', border: '1px solid #4CAF50', borderRadius: 6, padding: '2px 8px' }}>
                  이번 달 {Object.values(dailyCount).reduce((a, b) => a + b, 0)}편
                </span>
              </div>
              <span style={{ fontSize: 12, color: '#9aa0ab' }}>{showRoutine ? '▲ 접기' : '▼ 펼치기'}</span>
            </button>

            {showRoutine && (
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderTop: 'none', borderRadius: '0 0 12px 12px', padding: 20 }}>
                <div style={{ marginBottom: 20 }}>
                  <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7,1fr)', gap: 4, textAlign: 'center', marginBottom: 4 }}>
                    {['일', '월', '화', '수', '목', '금', '토'].map(d => (
                      <div key={d} style={{ fontSize: 11, fontWeight: 700, color: '#9aa0ab', padding: '4px 0' }}>{d}</div>
                    ))}
                    {Array.from({ length: firstDay }).map((_, i) => <div key={`e${i}`} />)}
                    {Array.from({ length: daysInMonth }).map((_, i) => {
                      const d = i + 1, isToday = d === today
                      const isSat = new Date(year, month, d).getDay() === 6
                      const isLastSat = d === lastSat, isWeekly = isSat && !isLastSat, isMonthly = isLastSat
                      const cnt = dailyCount[d] || 0
                      return (
                        <div key={d} style={{ padding: '4px 2px', borderRadius: 6, background: isToday ? '#4CAF50' : isMonthly ? 'rgba(217,119,6,0.15)' : isWeekly ? 'rgba(8,145,178,0.15)' : 'transparent', minHeight: 40, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 2 }}>
                          <div style={{ fontSize: 12, fontWeight: isToday ? 700 : 400, color: isToday ? '#fff' : '#e8eaed' }}>{d}</div>
                          {isMonthly && !isToday && <div style={{ fontSize: 8, color: '#d97706', lineHeight: 1 }}>월간</div>}
                          {isWeekly && !isToday && <div style={{ fontSize: 8, color: '#0891b2', lineHeight: 1 }}>주간</div>}
                          {cnt > 0 && <div style={{ fontSize: 9, fontWeight: 700, color: isToday ? '#fff' : '#4CAF50', background: isToday ? 'rgba(255,255,255,0.2)' : 'rgba(76,175,80,0.15)', borderRadius: 3, padding: '0 3px', lineHeight: '14px' }}>{cnt}</div>}
                        </div>
                      )
                    })}
                  </div>
                </div>

                <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
                  {Object.entries(ROUTINES).map(([key, r]) => {
                    const periodKey = key === 'publish' ? 'publish' : key === 'weekly' ? getWeekKey() : getMonthKey()
                    const isCollapsed = !!collapsedRoutines[key]
                    const checkedCnt = r.items.filter((_, ii) => !!routineChecks[`${periodKey}__${ii}`]).length
                    return (
                      <div key={key} style={{ border: `1.5px solid ${r.color}44`, borderRadius: 10, overflow: 'hidden' }}>
                        <button onClick={() => setCollapsedRoutines(v => ({ ...v, [key]: !v[key] }))}
                          style={{ width: '100%', display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '10px 14px', background: '#0f1115', border: 'none', cursor: 'pointer', color: '#e8eaed' }}>
                          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <span style={{ fontSize: 13, fontWeight: 800, color: r.color }}>{r.label}</span>
                            <span style={{ fontSize: 11, fontWeight: 600, color: checkedCnt === r.items.length ? '#4CAF50' : r.color, background: 'rgba(255,255,255,0.05)', borderRadius: 10, padding: '1px 8px' }}>
                              {checkedCnt}/{r.items.length}
                            </span>
                          </div>
                          <span style={{ fontSize: 11, color: r.color }}>{isCollapsed ? '▼' : '▲'}</span>
                        </button>
                        {!isCollapsed && (
                          <div style={{ background: '#0f1115', padding: '0 14px 12px', display: 'flex', flexDirection: 'column', gap: 8 }}>
                            {r.items.map((item, ii) => {
                              const mk = `${periodKey}__${ii}`, checked = !!routineChecks[mk]
                              return (
                                <div key={ii} onClick={() => toggleRoutine(periodKey, ii)}
                                  style={{ display: 'flex', gap: 10, alignItems: 'flex-start', background: checked ? 'rgba(76,175,80,0.08)' : '#171a21', borderRadius: 8, padding: '10px 12px', cursor: 'pointer', opacity: checked ? 0.7 : 1 }}>
                                  <span style={{ fontSize: 16, flexShrink: 0 }}>{checked ? '☑' : '☐'}</span>
                                  <div style={{ flex: 1 }}>
                                    <div style={{ fontSize: 13, fontWeight: 700, textDecoration: checked ? 'line-through' : 'none' }}>{item.text}</div>
                                    <div style={{ fontSize: 12, color: '#9aa0ab', lineHeight: 1.6 }}>{item.desc}</div>
                                  </div>
                                  {item.link && (
                                    <a href={item.link} target="_blank" rel="noopener noreferrer" onClick={e => e.stopPropagation()}
                                      style={{ fontSize: 11, fontWeight: 700, color: r.color, background: 'rgba(255,255,255,0.05)', border: `1px solid ${r.color}44`, borderRadius: 6, padding: '3px 8px', textDecoration: 'none', whiteSpace: 'nowrap', flexShrink: 0 }}>
                                      바로가기
                                    </a>
                                  )}
                                </div>
                              )
                            })}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )}
          </div>

          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 16 }}>
            {[['all', '전체'], ...allCategories.map(c => [c, c])].map(([key, label]) => (
              <button key={key} onClick={() => setFilterType(key)}
                style={{ padding: '6px 14px', borderRadius: 8, border: `1.5px solid ${filterType === key ? '#4CAF50' : '#2a2e38'}`, background: filterType === key ? 'rgba(76,175,80,0.1)' : 'transparent', color: filterType === key ? '#4CAF50' : '#9aa0ab', fontSize: 13, fontWeight: filterType === key ? 700 : 500, cursor: 'pointer' }}>
                {label} {key === 'all' ? posts.length : posts.filter(p => (p.category || '') === key).length}
              </button>
            ))}
          </div>

          {loading ? (
            <div style={{ textAlign: 'center', padding: 48, color: '#9aa0ab' }}>불러오는 중...</div>
          ) : filteredPosts.length === 0 ? (
            <div style={{ textAlign: 'center', padding: '60px 20px', background: '#171a21', borderRadius: 14, border: '1px solid #2a2e38', color: '#9aa0ab' }}>
              <div style={{ fontSize: 40, marginBottom: 12 }}>📝</div>
              <div style={{ fontSize: 15, fontWeight: 600 }}>아직 작성된 글이 없습니다</div>
            </div>
          ) : (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
              {filteredPosts.map(post => (
                <div key={post.id} style={{ background: '#171a21', borderRadius: 12, border: '1.5px solid #2a2e38', padding: '14px 18px', display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1, minWidth: 0 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                      <span style={{ fontSize: 11, fontWeight: 700, borderRadius: 999, padding: '2px 10px',
                        background: post.status === 'published' ? 'rgba(76,175,80,0.15)' : post.status === 'scheduled' ? 'rgba(63,81,181,0.15)' : 'rgba(154,160,171,0.15)',
                        color: post.status === 'published' ? '#4CAF50' : post.status === 'scheduled' ? '#8c9eff' : '#9aa0ab' }}>
                        {post.status === 'published' ? '✅ 발행' : post.status === 'scheduled' ? '⏰ 예약' : '📝 임시'}
                      </span>
                      {post.status === 'scheduled' && post.scheduled_at && (
                        <span style={{ fontSize: 11, color: '#8c9eff' }}>{new Date(new Date(post.scheduled_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 16).replace('T', ' ')}</span>
                      )}
                      {post.category && <span style={{ fontSize: 11, color: '#9aa0ab', background: '#0f1115', borderRadius: 4, padding: '2px 8px', border: '1px solid #2a2e38' }}>{post.category}</span>}
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, color: '#e8eaed', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', marginBottom: 3 }}>{post.title}</div>
                    <div style={{ fontSize: 12, color: '#9aa0ab' }}>
                      {(post.published_at || post.created_at) ? new Date(new Date(post.published_at || post.created_at).getTime() + 9 * 60 * 60 * 1000).toISOString().slice(0, 10).replace(/-/g, '. ') + '.' : ''}
                      {post.slug && <span style={{ marginLeft: 8, color: '#666' }}>/blog/{post.slug}</span>}
                    </div>
                  </div>
                  <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
                    {post.status === 'published' && post.slug && (
                      <a href={`/blog/${post.slug}`} target="_blank" rel="noopener noreferrer" style={{ ...S.btnGhost, textDecoration: 'none', padding: '6px 12px', fontSize: 12 }}>보기</a>
                    )}
                    <button onClick={() => handleEdit(post)} style={{ ...S.btn('#3F51B5'), padding: '6px 14px', fontSize: 12 }}>수정</button>
                    <button onClick={() => handleDelete(post)} style={{ ...S.btnGhost, padding: '6px 12px', fontSize: 12, borderColor: '#F44336', color: '#F44336' }}>삭제</button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  )
}
