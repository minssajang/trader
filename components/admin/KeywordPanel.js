import { useState, useEffect } from 'react'

function formatDate(iso) {
  if (!iso) return '기록 없음'
  const d = new Date(new Date(iso).getTime() + 9 * 60 * 60 * 1000)
  return `${d.getUTCFullYear()}년 ${d.getUTCMonth() + 1}월 ${d.getUTCDate()}일`
}

function daysSince(iso) {
  if (!iso) return 999
  return Math.floor((Date.now() - new Date(iso).getTime()) / 86400000)
}

function fmt(n) { return (n || 0).toLocaleString() }

// 찜(별) 아이콘 — 이전엔 유니코드 ☆/⭐ 글자를 그대로 썼는데, 폰트/플랫폼에 따라
// 흰별(☆)이 제대로 안 그려지거나 다른 글자와 겹쳐 보이는 문제가 있어 SVG로 교체.
// 색상: 찜한 상태 = 금색 채움, 안 한 상태 = 회색 테두리만 (항상 눈에 보이도록 명시적 색 지정).
function StarIcon({ filled, size = 18 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24"
      fill={filled ? '#facc15' : 'none'}
      stroke={filled ? '#eab308' : '#9ca3af'}
      strokeWidth="1.6" strokeLinejoin="round"
      style={{ display: 'block' }}>
      <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
    </svg>
  )
}


function FeatureIdeasTab({ adminToken, showToast }) {
  const [ideas, setIdeas] = useState([])
  const [loading, setLoading] = useState(true)
  const [statusFilter, setStatusFilter] = useState('all')

  const STATUS_LABELS = {
    proposed: { label: '검토 중', color: '#facc15', bg: '#1c1c00' },
    building:  { label: '개발 중', color: '#60a5fa', bg: '#0f1f3d' },
    done:      { label: '완료',   color: '#16a34a', bg: '#f0fdf4' },
    rejected:  { label: '보류',   color: '#71717a', bg: '#f5f9f5' },
  }

  const load = async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/tools/feature-ideas', {
        headers: { 'x-admin-token': adminToken },
      })
      const data = await res.json()
      setIdeas(Array.isArray(data) ? data : [])
    } catch { setIdeas([]) }
    setLoading(false)
  }

  useEffect(() => { load() }, [])

  const handleStatusChange = async (id, newStatus) => {
    try {
      const res = await fetch('/api/tools/feature-ideas', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ id, status: newStatus }),
      })
      if (!res.ok) throw new Error()
      setIdeas(prev => prev.map(i => i.id === id ? { ...i, status: newStatus } : i))
      showToast('✅ 상태 변경됨')
    } catch { showToast('❌ 변경 실패') }
  }

  const fmtN = (n) => (n || 0).toLocaleString('ko-KR')
  const filtered = statusFilter === 'all' ? ideas : ideas.filter(i => i.status === statusFilter)

  return (
    <div>
      <div style={{ marginBottom: 16, fontSize: 13, color: '#71717a', lineHeight: 1.7 }}>
        MCP <code style={{ color: '#16a34a' }}>suggest_feature</code> 툴로 기록된 기능 추가 제안 목록입니다.<br />
        Claude가 황금키워드를 발견했을 때 기존 도구에 기능으로 추가하면 좋겠다고 판단하면 여기에 쌓입니다.
      </div>
      <div style={{ display: 'flex', gap: 8, marginBottom: 16, flexWrap: 'wrap' }}>
        {[['all', '전체'], ['proposed', '검토 중'], ['building', '개발 중'], ['done', '완료'], ['rejected', '보류']].map(([v, l]) => (
          <button key={v} onClick={() => setStatusFilter(v)} style={{
            padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: statusFilter === v ? '#16a34a' : '#f5f9f5',
            color: statusFilter === v ? '#fff' : '#4b6e4b',
            fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif",
          }}>{l}</button>
        ))}
        <button onClick={load} style={{
          padding: '5px 14px', borderRadius: 8, border: '1px solid #3f3f46',
          background: 'none', color: '#71717a', fontSize: 13, cursor: 'pointer',
          fontFamily: "'Outfit', sans-serif",
        }}>🔄 새로고침</button>
      </div>
      {loading ? (
        <div style={{ color: '#71717a', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div>
      ) : filtered.length === 0 ? (
        <div style={{ color: '#4b6e4b', fontSize: 14, padding: 40, textAlign: 'center' }}>
          <div style={{ fontSize: 32, marginBottom: 10 }}>💡</div>
          아직 기록된 아이디어가 없습니다.<br />
          <span style={{ fontSize: 12, color: '#4b6e4b', marginTop: 6, display: 'block' }}>
            Claude가 글 작성 중 suggest_feature 툴을 호출하면 여기에 나타납니다.
          </span>
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 12 }}>
          {filtered.map(idea => {
            const s = STATUS_LABELS[idea.status] || STATUS_LABELS.proposed
            return (
              <div key={idea.id} style={{
                background: '#f5f9f5', borderRadius: 12, padding: '16px 20px',
                border: '1px solid #d1e8d1',
              }}>
                <div style={{ display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 12, flexWrap: 'wrap' }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6, flexWrap: 'wrap' }}>
                      <span style={{
                        fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                        background: '#e8f5e9', color: '#15803d',
                      }}>{idea.tool_id}</span>
                      <span style={{ fontSize: 15, fontWeight: 800, color: '#0f1f0f' }}>{idea.feature_name}</span>
                    </div>
                    {idea.keyword && (
                      <div style={{ fontSize: 12, color: '#71717a', marginBottom: 6 }}>
                        🔑 키워드: <span style={{ color: '#0f1f0f' }}>{idea.keyword}</span>
                        {idea.total ? <span style={{ marginLeft: 8 }}>검색수 <strong style={{ color: '#16a34a' }}>{fmtN(idea.total)}</strong></span> : ''}
                        {idea.competition ? <span style={{ marginLeft: 8 }}>경쟁도 {idea.competition}</span> : ''}
                      </div>
                    )}
                    <div style={{ fontSize: 13, color: '#374151', lineHeight: 1.7 }}>{idea.notes}</div>
                    <div style={{ fontSize: 11, color: '#4b6e4b', marginTop: 8 }}>
                      {idea.created_at ? new Date(new Date(idea.created_at).getTime() + 9*60*60*1000).toISOString().slice(0,10).replace(/-/g,'. ') + '.' : ''}
                    </div>
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6, alignItems: 'flex-end' }}>
                    <span style={{
                      fontSize: 12, fontWeight: 700, padding: '4px 12px', borderRadius: 999,
                      background: s.bg, color: s.color, border: `1px solid ${s.color}40`,
                      whiteSpace: 'nowrap',
                    }}>{s.label}</span>
                    <select
                      value={idea.status}
                      onChange={e => handleStatusChange(idea.id, e.target.value)}
                      style={{
                        background: '#f5f9f5', border: '1px solid #d1e8d1', color: '#4b6e4b',
                        borderRadius: 6, padding: '4px 8px', fontSize: 12,
                        cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                      }}
                    >
                      <option value="proposed">검토 중</option>
                      <option value="building">개발 중</option>
                      <option value="done">완료</option>
                      <option value="rejected">보류</option>
                    </select>
                  </div>
                </div>
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

export default function KeywordPanel({ adminToken }) {
  const [hintList, setHintList]           = useState([])
  const [loadingKw, setLoadingKw]         = useState({})   // 키워드 업데이트 로딩
  const [loadingDoc, setLoadingDoc]       = useState({})   // 문서수 업데이트 로딩
  const [docProgress, setDocProgress]     = useState({})   // {hint: {filled, stillNull, total}}
  const [expanded, setExpanded]           = useState(null)
  const [topData, setTopData]             = useState({})
  const [topLoading, setTopLoading]       = useState({})
  const [resultModal, setResultModal]     = useState(null)   // {type:'success'|'error', message}
  const [tab, setTab]                     = useState('top')
  const [picks, setPicks]                 = useState([])
  const [picksLoading, setPicksLoading]   = useState(false)
  const [addKeyword, setAddKeyword]       = useState('')
  const [addLoading, setAddLoading]       = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [allKeywords, setAllKeywords]     = useState([])
  const [allKwLimit, setAllKwLimit] = useState(100)
  const [allKwLoading, setAllKwLoading]   = useState(false)
  const [allKwLoaded, setAllKwLoaded]     = useState(false)
  const [goldenKeywords, setGoldenKeywords]         = useState([])
  const [goldenLoading, setGoldenLoading]           = useState(false)
  const [goldenLoaded, setGoldenLoaded]             = useState(false)
  const [goldenCompetition, setGoldenCompetition]   = useState('낮음')
  const [todayRows, setTodayRows]             = useState([])
  const [todayLoading, setTodayLoading]       = useState(false)

  // ── 전체 자동 배치 ──────────────────────────────────────────────
  const [batchStatus, setBatchStatus]   = useState(null)   // {daily_limit, today_used, remaining, total_null, hints[]}
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState(null) // {filled, stillNull, dailyUsed, dailyRemaining}
  const [batchPriority, setBatchPriority] = useState('search_volume')
  const [batchChunk, setBatchChunk]     = useState(100)

  const showToast = (msg) => {
    const isError = msg.trim().startsWith('❌')
    setResultModal({ type: isError ? 'error' : 'success', message: msg })
  }

  const loadStats = () => {
    fetch('/api/tools/keyword-stats', { headers: { 'x-admin-token': adminToken } })
      .then(r => r.json())
      .then(data => setHintList(Array.isArray(data) ? data : []))
      .catch(console.error)
  }

  useEffect(() => { loadStats() }, [adminToken])

  const loadBatchStatus = async () => {
    try {
      const res = await fetch('/api/tools/doc-batch', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      if (res.ok) setBatchStatus(data)
    } catch (e) { console.error(e) }
  }

  useEffect(() => { loadBatchStatus() }, [adminToken])

  const handleRunBatch = async () => {
    if (batchRunning) return
    setBatchRunning(true)
    setBatchProgress({ filled: 0, stillNull: null, dailyUsed: null, dailyRemaining: null })

    let totalFilled = 0
    let continueLoop = true

    try {
      while (continueLoop) {
        const res = await fetch('/api/tools/doc-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
          body: JSON.stringify({ chunk: batchChunk, priority: batchPriority }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '오류')

        totalFilled += data.filled || 0
        continueLoop = !data.done

        setBatchProgress({
          filled: totalFilled,
          stillNull: data.still_null,
          dailyUsed: data.today_used,
          dailyRemaining: data.remaining,
          reason: data.reason,
        })

        if (!continueLoop) break

        await new Promise(r => setTimeout(r, 400))
      }

      loadStats()
      loadBatchStatus()
      if (batchProgress?.reason === 'daily_limit') {
        showToast(`⚠️ 일일 한도 도달 — 오늘 ${totalFilled}개 수집 완료`)
      } else {
        showToast(`✅ 전체 문서수 수집 완료! ${totalFilled}개`)
      }
    } catch (e) {
      showToast(`❌ 배치 오류: ${e.message}`)
    }

    setBatchRunning(false)
  }

  const loadPicks = async () => {
    setPicksLoading(true)
    try {
      const res = await fetch('/api/tools/keyword-picks', { headers: { 'x-admin-token': adminToken } })
      setPicks(await res.json())
    } catch (e) { console.error(e) }
    setPicksLoading(false)
  }

  useEffect(() => { loadPicks() }, [adminToken])

  const loadAllKeywords = async (lim) => {
    setAllKwLoading(true)
    try {
      const res = await fetch(`/api/tools/keyword-all?limit=${lim || allKwLimit}`, { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setAllKeywords(data.results || [])
      setAllKwLoaded(true)
    } catch (e) { console.error(e) }
    setAllKwLoading(false)
  }

  const loadGolden = async (comp) => {
    setGoldenLoading(true)
    try {
      const c = comp || goldenCompetition
      const res = await fetch(`/api/tools/keyword-golden?competition=${encodeURIComponent(c)}&limit=200`, {
        headers: { 'x-admin-token': adminToken },
      })
      const data = await res.json()
      setGoldenKeywords(data.results || [])
      setGoldenLoaded(true)
    } catch (e) { console.error(e) }
    setGoldenLoading(false)
  }

  const loadToday = async () => {
    setTodayLoading(true)
    try {
      const res = await fetch('/api/tools/keyword-stats?mode=today', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setTodayRows(Array.isArray(data) ? data : [])
    } catch (e) { console.error(e) }
    setTodayLoading(false)
  }

  const handleGoldenCompetitionChange = (c) => {
    setGoldenCompetition(c)
    setGoldenLoaded(false)
    loadGolden(c)
  }

  const handleTabChange = (t) => {
    setTab(t)
    if (t === 'all') loadAllKeywords()
    if (t === 'golden' && !goldenLoaded) loadGolden()
    if (t === 'today') loadToday()
  }

  const handleLimitChange = (lim) => {
    setAllKwLimit(lim)
    setAllKwLoaded(false)
    loadAllKeywords(lim)
  }

  const handleExpand = async (hint) => {
    if (expanded === hint) { setExpanded(null); return }
    setExpanded(hint)
    if (topData[hint]) return
    setTopLoading(l => ({ ...l, [hint]: true }))
    try {
      const res = await fetch(`/api/tools/keyword-top?hint=${encodeURIComponent(hint)}&limit=50`, {
        headers: { 'x-admin-token': adminToken },
      })
      const data = await res.json()
      setTopData(d => ({ ...d, [hint]: data.results || [] }))
    } catch (e) { console.error(e) }
    setTopLoading(l => ({ ...l, [hint]: false }))
  }

  const handleUpdateKeyword = async (hint) => {
    setLoadingKw(l => ({ ...l, [hint]: true }))
    try {
      const res = await fetch(`/api/tools/keyword-volume?keyword=${encodeURIComponent(hint)}&mode=keyword_only`, {
        headers: { 'x-admin-token': adminToken },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '오류')
      loadStats()
      setTopData(d => ({ ...d, [hint]: null }))
      setAllKwLoaded(false)
      showToast(`✅ "${hint}" 검색량 ${data.saved}개 갱신 완료!`)
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
    setLoadingKw(l => ({ ...l, [hint]: false }))
  }

  const handleUpdateDocCount = async (hint) => {
    setLoadingDoc(l => ({ ...l, [hint]: true }))
    setDocProgress(p => ({ ...p, [hint]: { filled: 0, stillNull: null, total: null } }))

    const CHUNK = 50
    let totalFilled = 0

    try {
      let done = false
      while (!done) {
        const res = await fetch(
          `/api/tools/keyword-volume?keyword=${encodeURIComponent(hint)}&mode=doc_only&chunk=${CHUNK}`,
          { headers: { 'x-admin-token': adminToken } }
        )
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '오류')

        totalFilled += data.filled || 0
        done = data.done

        setDocProgress(p => ({
          ...p,
          [hint]: {
            filled: totalFilled,
            stillNull: data.still_null,
            total: (data.still_null || 0) + totalFilled,
          },
        }))

        if (!done) await new Promise(r => setTimeout(r, 300))
      }

      loadStats()
      setTopData(d => ({ ...d, [hint]: null }))
      showToast(`✅ "${hint}" 문서수 ${totalFilled}개 수집 완료!`)
    } catch (e) {
      showToast(`❌ 문서수 오류: ${e.message}`)
    }

    setLoadingDoc(l => ({ ...l, [hint]: false }))
    setTimeout(() => setDocProgress(p => { const n = { ...p }; delete n[hint]; return n }), 3000)
  }

  const handleAdd = async () => {
    const kw = addKeyword.trim()
    if (!kw) return showToast('키워드를 입력해주세요')
    const exists = hintList.find(h => h.hint === kw)
    if (exists) {
      setConfirmDelete({ type: 'duplicate', hint: kw })
      return
    }
    setAddLoading(true)
    try {
      const res = await fetch(`/api/tools/keyword-volume?keyword=${encodeURIComponent(kw)}`, {
        headers: { 'x-admin-token': adminToken },
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || '오류')
      loadStats()
      setAllKwLoaded(false)
      showToast(`✅ "${kw}" 연관 키워드 ${data.saved}개 추가됨!`)
      setAddKeyword('')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
    setAddLoading(false)
  }

  const handleDeleteHint = async (hint) => {
    try {
      const res = await fetch(`/api/tools/keyword-delete?hint=${encodeURIComponent(hint)}`, {
        method: 'DELETE', headers: { 'x-admin-token': adminToken },
      })
      if (!res.ok) throw new Error('삭제 실패')
      loadStats()
      setTopData(d => { const n = { ...d }; delete n[hint]; return n })
      if (expanded === hint) setExpanded(null)
      setAllKwLoaded(false)
      showToast(`🗑 "${hint}" 삭제 완료`)
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handlePick = async (hint, item) => {
    const isPicked = item.picked
    try {
      if (isPicked) {
        await fetch(`/api/tools/keyword-picks?tool_id=${encodeURIComponent(hint)}&keyword=${encodeURIComponent(item.keyword)}`, {
          method: 'DELETE', headers: { 'x-admin-token': adminToken },
        })
      } else {
        await fetch('/api/tools/keyword-picks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
          body: JSON.stringify({ tool_id: hint, keyword: item.keyword, pc: item.pc, mobile: item.mobile, total: item.total, competition: item.competition, hint }),
        })
      }
      setTopData(d => ({
        ...d,
        [hint]: (d[hint] || []).map(k => k.keyword === item.keyword ? { ...k, picked: !isPicked } : k),
      }))
      loadPicks()
      showToast(isPicked ? '⭐ 찜 해제됨' : '⭐ 찜에 추가됨!')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleUnpick = async (toolId, keyword) => {
    try {
      await fetch(`/api/tools/keyword-picks?tool_id=${encodeURIComponent(toolId)}&keyword=${encodeURIComponent(keyword)}`, {
        method: 'DELETE', headers: { 'x-admin-token': adminToken },
      })
      setPicks(p => p.filter(k => !(k.tool_id === toolId && k.keyword === keyword)))
      showToast('⭐ 찜 해제됨')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleSyncFromPublishLog = async () => {
    try {
      showToast('🔄 발행기록에서 동기화 중...')
      const res = await fetch('/api/admin/content-log?limit=500', {
        headers: { 'x-admin-token': adminToken }
      })
      const logs = await res.json()
      const toSync = logs.filter(l => l.target_keyword)
      if (toSync.length === 0) { showToast('⚠️ 동기화할 키워드가 없습니다'); return }

      let updated = 0
      for (const log of toSync) {
        const group = log.category || log.angle || 'general'
        await fetch('/api/tools/keyword-picks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
          body: JSON.stringify({
            tool_id: group,
            hint: group,
            keyword: log.target_keyword,
            pc: log.search_pc || 0,
            mobile: log.search_mobile || 0,
            total: log.search_total || 0,
            competition: log.competition || '',
          })
        })
        const r = await fetch('/api/tools/keyword-picks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
          body: JSON.stringify({
            tool_id: group,
            keyword: log.target_keyword,
            used_in_title: log.title || null,
            used_in_slug: log.slug || null,
          })
        })
        if (r.ok) updated++
      }
      loadPicks()
      showToast(`✅ ${updated}개 키워드 동기화 완료`)
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleUnmarkUsed = async (toolId, keyword) => {
    try {
      const res = await fetch('/api/tools/keyword-picks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ tool_id: toolId, keyword, unmark: true }),
      })
      if (!res.ok) throw new Error('되돌리기 실패')
      loadPicks()
      showToast('↩️ 미사용으로 되돌림')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleMarkUsed = async (item) => {
    const title = window.prompt('이 키워드를 사용한 글 제목을 입력하세요')
    if (!title) return
    const slug = window.prompt('슬러그 (선택, 비워도 됩니다)') || ''
    try {
      const res = await fetch('/api/tools/keyword-picks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify({ tool_id: item.tool_id, keyword: item.keyword, used_in_title: title, used_in_slug: slug }),
      })
      if (!res.ok) throw new Error('처리 실패')
      loadPicks()
      showToast('✅ 사용 처리됨')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const allRows = [...hintList].sort((a, b) => a.hint.localeCompare(b.hint, 'ko'))

  const pendingPicks = picks.filter(p => !p.used_at)
  const usedPicks = picks.filter(p => p.used_at)
    .sort((a, b) => new Date(b.used_at).getTime() - new Date(a.used_at).getTime())

  const S = {
    th: { fontSize: 12, color: '#4b6e4b', fontWeight: 600, padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid #d1e8d1' },
    td: { fontSize: 13, color: '#374151', padding: '8px 10px', borderBottom: '1px solid #e5e7eb' },
    tdNum: { fontSize: 13, color: '#0f1f0f', fontWeight: 700, padding: '8px 10px', borderBottom: '1px solid #e5e7eb', textAlign: 'right' },
  }

  return (
    <div style={{ padding: 28, fontFamily: "'Outfit', sans-serif", maxWidth: 780 }}>
      <h2 style={{ color: '#0f1f0f', fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🔍 키워드 검색량 관리</h2>
      <p style={{ color: '#71717a', fontSize: 13, marginBottom: 12 }}>키워드를 입력하면 네이버 연관 키워드 전체를 수집해서 아래 목록에 그룹으로 추가합니다.</p>

      {/* 전체 수집 현황 요약 */}
      {allRows.length > 0 && (() => {
        const totalKeywords = allRows.reduce((sum, r) => sum + (r.count || 0), 0)
        const totalWithDoc  = allRows.reduce((sum, r) => sum + (r.doc_count_filled || 0), 0)

        const dailyLimit     = batchStatus?.daily_limit || 25000
        const liveUsed       = batchProgress?.dailyUsed ?? batchStatus?.today_used ?? null
        const liveRemaining  = batchProgress?.dailyRemaining ?? batchStatus?.remaining ?? null
        const WARNING_THRESH = 5000
        const isWarning      = liveRemaining != null && liveRemaining <= WARNING_THRESH
        const isDanger       = liveRemaining != null && liveRemaining <= 1000
        const usedPct        = liveUsed != null ? Math.min(100, Math.round((liveUsed / dailyLimit) * 100)) : null

        return (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{
                background: '#f5f9f5', border: '1px solid #d1e8d1', borderRadius: 10,
                padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 13, color: '#4b6e4b' }}>전체 수집 키워드</span>
                <span style={{ fontSize: 18, fontWeight: 900, color: '#16a34a' }}>{totalKeywords.toLocaleString()}</span>
                <span style={{ fontSize: 13, color: '#4b6e4b' }}>개</span>
              </div>
              <div style={{
                background: '#f5f9f5', border: '1px solid #d1e8d1', borderRadius: 10,
                padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8,
              }}>
                <span style={{ fontSize: 13, color: '#4b6e4b' }}>수집한 그룹</span>
                <span style={{ fontSize: 18, fontWeight: 900, color: '#0f1f0f' }}>{allRows.length}</span>
                <span style={{ fontSize: 13, color: '#4b6e4b' }}>개</span>
              </div>
              {liveRemaining != null && (
                <div style={{
                  background: isDanger ? '#fef2f2' : isWarning ? '#fffbeb' : '#f5f9f5',
                  border: `1px solid ${isDanger ? '#fca5a5' : isWarning ? '#fcd34d' : '#d1e8d1'}`,
                  borderRadius: 10,
                  padding: '10px 18px',
                  display: 'flex', alignItems: 'center', gap: 10,
                  minWidth: 220,
                }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, color: isDanger ? '#dc2626' : isWarning ? '#d97706' : '#4b6e4b' }}>
                        {isDanger ? '🚨' : isWarning ? '⚠️' : '📡'} 오늘 남은 한도
                      </span>
                      <span style={{ fontSize: 18, fontWeight: 900, color: isDanger ? '#dc2626' : isWarning ? '#d97706' : '#16a34a' }}>
                        {liveRemaining.toLocaleString()}
                      </span>
                      <span style={{ fontSize: 13, color: '#4b6e4b' }}>/ {dailyLimit.toLocaleString()}</span>
                    </div>
                    <div style={{ height: 4, background: '#d1e8d1', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{
                        height: '100%',
                        width: `${usedPct}%`,
                        background: isDanger ? '#ef4444' : isWarning ? '#f59e0b' : '#16a34a',
                        borderRadius: 2,
                        transition: 'width 0.4s, background 0.3s',
                      }} />
                    </div>
                    <div style={{ fontSize: 11, color: '#4b6e4b' }}>
                      사용 {(liveUsed || 0).toLocaleString()}개 ({usedPct}%)
                    </div>
                  </div>
                </div>
              )}
            </div>
            {isWarning && (
              <div style={{
                background: isDanger ? '#fef2f2' : '#fffbeb',
                border: `1px solid ${isDanger ? '#fca5a5' : '#fcd34d'}`,
                borderRadius: 8, padding: '10px 16px', marginBottom: 12,
                display: 'flex', alignItems: 'center', gap: 10,
              }}>
                <span style={{ fontSize: 18 }}>{isDanger ? '🚨' : '⚠️'}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isDanger ? '#dc2626' : '#d97706' }}>
                    {isDanger
                      ? `API 한도 거의 소진 — 오늘 ${liveRemaining.toLocaleString()}개만 남았습니다`
                      : `API 한도 주의 — 오늘 ${liveRemaining.toLocaleString()}개 남음 (5,000개 이하)`}
                  </div>
                  <div style={{ fontSize: 12, color: '#4b6e4b', marginTop: 2 }}>
                    다른 서비스에서도 이 API를 사용 중입니다. 대량 수집 전 확인하세요.
                  </div>
                </div>
              </div>
            )}
          </>
        )
      })()}

      <div style={{ background: '#f5f9f5', border: '1px solid #d1e8d1', borderRadius: 10, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#0f1f0f', marginBottom: 12 }}>➕ 키워드 추가 수집</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input
            value={addKeyword}
            onChange={e => setAddKeyword(e.target.value)}
            onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="예: 자동매매, 선물전략, RSI"
            style={{
              flex: 1, background: '#fff', border: '1px solid #d1e8d1',
              borderRadius: 8, color: '#0f1f0f', fontSize: 13, padding: '8px 12px',
              fontFamily: "'Outfit', sans-serif", outline: 'none',
            }}
          />
          <button onClick={handleAdd} disabled={addLoading} style={{
            background: '#16a34a', color: '#fff', border: 'none', borderRadius: 8,
            padding: '8px 20px', fontSize: 13, fontWeight: 700,
            cursor: addLoading ? 'wait' : 'pointer', opacity: addLoading ? 0.6 : 1,
            fontFamily: "'Outfit', sans-serif",
          }}>
            {addLoading ? '수집 중...' : '수집'}
          </button>
        </div>
        <div style={{ fontSize: 11, color: '#4b6e4b', marginTop: 8 }}>수집하면 아래 목록에 새 그룹으로 추가됩니다.</div>
      </div>

      {/* ── 문서수 전체 자동 배치 카드 ─────────────────────────────── */}
      <div style={{
        background: '#f0fdf4', border: `1px solid ${batchRunning ? '#16a34a' : '#86efac'}`,
        borderRadius: 12, padding: '18px 20px', marginBottom: 20,
        transition: 'border-color 0.3s',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#15803d', marginBottom: 3 }}>
              🚀 문서수 전체 자동 수집
            </div>
            <div style={{ fontSize: 12, color: '#4b6e4b' }}>
              검색량 높은 미수집 키워드부터 일일 한도 내에서 자동으로 수집합니다
            </div>
          </div>
          {batchStatus && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 160 }}>
              <div style={{ fontSize: 11, color: '#4b6e4b', display: 'flex', gap: 6 }}>
                <span>오늘 사용</span>
                <b style={{ color: (batchProgress?.dailyUsed ?? batchStatus.today_used) > batchStatus.daily_limit * 0.8 ? '#d97706' : '#16a34a' }}>
                  {((batchProgress?.dailyUsed ?? batchStatus.today_used) || 0).toLocaleString()}
                </b>
                <span style={{ color: '#86efac' }}>/</span>
                <span>{batchStatus.daily_limit.toLocaleString()}</span>
              </div>
              <div style={{ width: 160, height: 6, background: '#d1e8d1', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: `${Math.min(100, Math.round(((batchProgress?.dailyUsed ?? batchStatus.today_used) / batchStatus.daily_limit) * 100))}%`,
                  background: (batchProgress?.dailyUsed ?? batchStatus.today_used) > batchStatus.daily_limit * 0.8 ? '#d97706' : '#16a34a',
                  borderRadius: 3, transition: 'width 0.4s',
                }} />
              </div>
              <div style={{ fontSize: 11, color: '#4b6e4b' }}>
                남은 한도 <b style={{ color: '#0f1f0f' }}>
                  {((batchProgress?.dailyRemaining ?? batchStatus.remaining) || 0).toLocaleString()}
                </b>개
              </div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: '#4b6e4b', fontWeight: 700 }}>우선순위</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[
                ['search_volume', '📊 검색량 순'],
                ['null_ratio', '📉 미수집 비율'],
                ['hint_order', '🗂 그룹 순서'],
              ].map(([v, l]) => (
                <button key={v} onClick={() => !batchRunning && setBatchPriority(v)} style={{
                  padding: '4px 10px', borderRadius: 6, border: 'none', cursor: batchRunning ? 'default' : 'pointer',
                  background: batchPriority === v ? '#16a34a' : '#d1e8d1',
                  color: batchPriority === v ? '#fff' : '#15803d',
                  fontSize: 11, fontWeight: 700, fontFamily: "'Outfit', sans-serif",
                  opacity: batchRunning ? 0.5 : 1,
                }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: '#4b6e4b', fontWeight: 700 }}>한 번에</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[50, 100, 200].map(n => (
                <button key={n} onClick={() => !batchRunning && setBatchChunk(n)} style={{
                  padding: '4px 10px', borderRadius: 6, border: 'none', cursor: batchRunning ? 'default' : 'pointer',
                  background: batchChunk === n ? '#16a34a' : '#d1e8d1',
                  color: batchChunk === n ? '#fff' : '#15803d',
                  fontSize: 11, fontWeight: 700, fontFamily: "'Outfit', sans-serif",
                  opacity: batchRunning ? 0.5 : 1,
                }}>{n}개</button>
              ))}
            </div>
          </div>
          <button
            onClick={handleRunBatch}
            disabled={batchRunning || (batchStatus?.remaining === 0)}
            style={{
              marginLeft: 'auto',
              background: batchRunning ? '#15803d' : batchStatus?.remaining === 0 ? '#d1e8d1' : '#16a34a',
              color: batchStatus?.remaining === 0 && !batchRunning ? '#4b6e4b' : '#fff',
              border: 'none', borderRadius: 8, padding: '9px 20px',
              fontSize: 13, fontWeight: 800,
              cursor: batchRunning ? 'wait' : batchStatus?.remaining === 0 ? 'default' : 'pointer',
              fontFamily: "'Outfit', sans-serif",
              minWidth: 120,
            }}
          >
            {batchRunning ? '수집 중...' : batchStatus?.remaining === 0 ? '오늘 한도 완료' : '▶ 자동 수집 시작'}
          </button>
        </div>

        {(batchRunning || batchProgress) && (
          <div style={{ background: '#f0fdf4', borderRadius: 8, padding: '12px 14px', marginTop: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#15803d', fontWeight: 700 }}>
                {batchRunning ? '⏳ 수집 중...' : batchProgress?.reason === 'all_filled' ? '✅ 전체 완료!' : batchProgress?.reason === 'daily_limit' ? '⚠️ 오늘 한도 도달' : '완료'}
              </span>
              <span style={{ fontSize: 12, color: '#4b6e4b' }}>
                수집 <b style={{ color: '#16a34a' }}>{(batchProgress?.filled || 0).toLocaleString()}</b>개
                {batchProgress?.stillNull != null && (
                  <span> · 남은 미수집 <b style={{ color: batchProgress.stillNull > 0 ? '#dc2626' : '#16a34a' }}>{batchProgress.stillNull.toLocaleString()}</b>개</span>
                )}
              </span>
            </div>
            {batchProgress?.stillNull != null && batchStatus && (
              <div style={{ height: 6, background: '#d1e8d1', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{
                  height: '100%',
                  width: (() => {
                    const total = (batchProgress.filled || 0) + (batchProgress.stillNull || 0)
                    return total > 0 ? `${Math.round((batchProgress.filled / total) * 100)}%` : '0%'
                  })(),
                  background: '#16a34a', borderRadius: 3, transition: 'width 0.4s',
                }} />
              </div>
            )}
          </div>
        )}

        {batchStatus?.hints?.length > 0 && !batchRunning && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 12, color: '#4b6e4b', cursor: 'pointer', userSelect: 'none' }}>
              그룹별 미수집 현황 ({batchStatus.total_null?.toLocaleString()}개 남음) ▸
            </summary>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {batchStatus.hints.map(h => (
                <div key={h.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ color: '#4b6e4b', minWidth: 90 }}>{h.hint}</span>
                  <div style={{ flex: 1, height: 4, background: '#d1e8d1', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{
                      height: '100%',
                      width: `${Math.round(h.nullRatio * 100)}%`,
                      background: h.nullRatio > 0.5 ? '#f87171' : '#16a34a',
                      borderRadius: 2,
                    }} />
                  </div>
                  <span style={{ color: '#f87171', minWidth: 50, textAlign: 'right' }}>
                    {h.nullCount.toLocaleString()}개
                  </span>
                  <span style={{ color: '#4b6e4b' }}>({Math.round(h.nullRatio * 100)}%)</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[
          ['top', '📊 수집 현황'],
          ['all', '📈 전체 순위'],
          ['golden', '🏆 황금키워드'],
          ['today', '🔴 오늘 실시간'],
          ['picks', '⭐ 찜한 키워드'],
          ['used', '✅ 사용 키워드'],
          ['ideas', '💡 아이디어 제안'],
        ].map(([id, label]) => (
          <button key={id} onClick={() => handleTabChange(id)} style={{
            padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer',
            background: tab === id ? '#16a34a' : '#f5f9f5',
            color: tab === id ? '#fff' : '#4b6e4b',
            fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif",
          }}>{label}</button>
        ))}
      </div>

      {tab === 'top' && (
        <div>
          {allRows.map(row => {
            const days           = daysSince(row.collected_at)
            const kwNeedsUpdate  = days >= 30
            const docNeedsUpdate = (row.null_doc_count || 0) > 0
            const isLoadingKw    = loadingKw[row.hint]
            const isLoadingDoc   = loadingDoc[row.hint]
            const docProg        = docProgress[row.hint]
            const isExpanded     = expanded === row.hint
            const topList        = topData[row.hint] || []

            return (
              <div key={row.hint} style={{ marginBottom: 8 }}>
                <div style={{
                  background: '#f5f9f5',
                  border: `1px solid ${isExpanded ? '#16a34a' : kwNeedsUpdate ? '#7f1d1d' : docNeedsUpdate ? '#14532d' : '#d1e8d1'}`,
                  borderRadius: isExpanded ? '10px 10px 0 0' : 10,
                  padding: '14px 18px',
                  display: 'flex', alignItems: 'center', justifyContent: 'space-between',
                  cursor: row.count > 0 ? 'pointer' : 'default',
                }} onClick={() => row.count > 0 && handleExpand(row.hint)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#0f1f0f', minWidth: 120 }}>{row.hint}</span>
                    <div>
                      <div style={{ fontSize: 13, color: kwNeedsUpdate ? '#dc2626' : '#4b6e4b' }}>
                        검색일: <b style={{ color: kwNeedsUpdate ? '#dc2626' : '#0f1f0f' }}>{formatDate(row.collected_at)}</b>
                        {row.collected_at && !kwNeedsUpdate && (() => {
                          const nextDate = new Date(new Date(row.collected_at).getTime() + 30 * 86400000)
                          const daysLeft = Math.ceil((nextDate.getTime() - Date.now()) / 86400000)
                          return (
                            <span style={{ marginLeft: 10, fontSize: 12, color: '#4b6e4b' }}>
                              · 다음 업데이트 <b style={{ color: '#0f1f0f' }}>{formatDate(nextDate.toISOString())}</b>
                              <span style={{ color: '#4b6e4b', marginLeft: 4 }}>({daysLeft}일 후)</span>
                            </span>
                          )
                        })()}
                      </div>
                      {row.count > 0 && (
                        <div style={{ fontSize: 12, color: '#4b6e4b', marginTop: 2 }}>
                          키워드 <b style={{ color: '#16a34a', fontSize: 13 }}>{fmt(row.count)}개</b>
                          {row.null_doc_count > 0
                            ? <span style={{ color: '#f87171', marginLeft: 6 }}>· 문서수 미수집 <b>{fmt(row.null_doc_count)}개</b> 남음</span>
                            : <span style={{ color: '#16a34a', marginLeft: 6 }}>· 문서수 완료 ✓</span>
                          }
                          {' · 클릭해서 TOP 50 보기'}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    {row.count > 0 && (
                      <span style={{ fontSize: 18, color: isExpanded ? '#16a34a' : '#4b6e4b' }}>
                        {isExpanded ? '▲' : '▼'}
                      </span>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); kwNeedsUpdate && !isLoadingKw && handleUpdateKeyword(row.hint) }}
                      disabled={isLoadingKw || !kwNeedsUpdate}
                      title={kwNeedsUpdate ? '검색량 갱신' : '수집 완료 (30일마다 갱신)'}
                      style={{
                        background: isLoadingKw ? '#1d4ed8' : kwNeedsUpdate ? '#2563eb' : '#f5f9f5',
                        color: kwNeedsUpdate ? '#fff' : '#4b6e4b',
                        border: `1px solid ${kwNeedsUpdate ? '#3b82f6' : '#d1e8d1'}`,
                        borderRadius: 8, padding: '7px 13px',
                        fontSize: 12, fontWeight: 700,
                        cursor: isLoadingKw ? 'wait' : kwNeedsUpdate ? 'pointer' : 'default',
                        opacity: isLoadingKw ? 0.7 : 1, whiteSpace: 'nowrap',
                        fontFamily: "'Outfit', sans-serif",
                        transition: 'all 0.15s',
                      }}
                    >
                      {isLoadingKw ? '수집 중...' : kwNeedsUpdate ? '🔄 키워드' : '✓ 키워드'}
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                      <button
                        onClick={e => { e.stopPropagation(); docNeedsUpdate && !isLoadingDoc && handleUpdateDocCount(row.hint) }}
                        disabled={isLoadingDoc || !docNeedsUpdate}
                        title={docNeedsUpdate ? `미수집 ${row.null_doc_count}개 문서수 수집` : '문서수 수집 완료'}
                        style={{
                          background: isLoadingDoc ? '#15803d' : docNeedsUpdate ? '#16a34a' : '#f5f9f5',
                          color: docNeedsUpdate ? '#fff' : '#4b6e4b',
                          border: `1px solid ${docNeedsUpdate ? '#16a34a' : '#d1e8d1'}`,
                          borderRadius: 8, padding: '7px 13px',
                          fontSize: 12, fontWeight: 700,
                          cursor: isLoadingDoc ? 'wait' : docNeedsUpdate ? 'pointer' : 'default',
                          opacity: isLoadingDoc ? 0.7 : 1, whiteSpace: 'nowrap',
                          fontFamily: "'Outfit', sans-serif",
                          transition: 'all 0.15s',
                          minWidth: 80,
                        }}
                      >
                        {isLoadingDoc
                          ? (docProg?.total
                              ? `${docProg.filled}/${docProg.total}`
                              : '수집 중...')
                          : docNeedsUpdate ? '📄 문서수' : '✓ 문서수'
                        }
                      </button>
                      {isLoadingDoc && docProg?.total > 0 && (
                        <div style={{ width: 80, height: 4, background: '#d1e8d1', borderRadius: 2, overflow: 'hidden' }}>
                          <div style={{
                            height: '100%',
                            width: `${Math.round((docProg.filled / docProg.total) * 100)}%`,
                            background: '#16a34a',
                            borderRadius: 2,
                            transition: 'width 0.3s',
                          }} />
                        </div>
                      )}
                      {!isLoadingDoc && docProg?.stillNull > 0 && (
                        <div style={{ fontSize: 10, color: '#f87171', whiteSpace: 'nowrap' }}>
                          {docProg.stillNull}개 재시도 필요
                        </div>
                      )}
                    </div>
                    <button onClick={e => { e.stopPropagation(); setConfirmDelete({ type: 'delete', hint: row.hint }) }} style={{
                      background: 'none', border: '1px solid #3f3f46', borderRadius: 8,
                      color: '#71717a', fontSize: 13, padding: '7px 10px',
                      cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                    }}>🗑</button>
                  </div>
                </div>

                {isExpanded && (
                  <div style={{ background: '#ffffff', border: '1px solid #22c55e', borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
                    {topLoading[row.hint] ? (
                      <div style={{ padding: 20, color: '#71717a', fontSize: 13, textAlign: 'center' }}>로딩 중...</div>
                    ) : (
                      <div style={{ overflowX: 'auto' }}>
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead>
                          <tr>
                            <th style={S.th}>순위</th>
                            <th style={S.th}>키워드</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>PC</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>모바일</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>합계</th>
                            <th style={S.th}>경쟁</th>
                            <th style={{ ...S.th, textAlign: 'right' }}>문서수</th>
                            <th style={{ ...S.th, textAlign: 'center', position: 'sticky', right: 0, background: '#fff' }}>찜</th>
                          </tr>
                        </thead>
                        <tbody>
                          {topList.map((item, i) => (
                            <tr key={item.keyword} style={{ background: item.picked ? '#1a1a00' : 'transparent' }}>
                              <td style={{ ...S.td, color: '#4b6e4b' }}>{i + 1}</td>
                              <td style={{ ...S.td, fontWeight: 600, color: '#0f1f0f' }}>{item.keyword}</td>
                              <td style={S.tdNum}>{fmt(item.pc)}</td>
                              <td style={S.tdNum}>{fmt(item.mobile)}</td>
                              <td style={{ ...S.tdNum, color: '#16a34a' }}>{fmt(item.total)}</td>
                              <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                              <td style={{ ...S.tdNum, fontSize: 12, color: '#71717a' }}>{item.doc_count != null ? fmt(item.doc_count) : '-'}</td>
                              <td style={{ ...S.td, textAlign: 'center', position: 'sticky', right: 0, background: item.picked ? '#1a1a00' : '#fff' }}>
                                <button onClick={e => { e.stopPropagation(); handlePick(row.hint, item) }} style={{
                                  background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
                                }}>
                                  <StarIcon filled={item.picked} />
                                </button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}

      {tab === 'all' && (
        <div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {[100, 200, 500, 1000].map(n => (
              <button key={n} onClick={() => handleLimitChange(n)} style={{
                padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: allKwLimit === n ? '#16a34a' : '#f5f9f5',
                color: allKwLimit === n ? '#fff' : '#4b6e4b',
                fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif",
              }}>{n}개</button>
            ))}
            <span style={{ fontSize: 12, color: '#4b6e4b', alignSelf: 'center', marginLeft: 8 }}>
              현재 {allKeywords.length.toLocaleString()}개 표시
            </span>
          </div>
          {allKwLoading ? (
            <div style={{ color: '#71717a', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #d1e8d1' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', overflow: 'hidden' }}>
              <thead>
                <tr>
                  <th style={S.th}>순위</th>
                  <th style={S.th}>그룹</th>
                  <th style={S.th}>키워드</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>PC</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>모바일</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>합계</th>
                  <th style={S.th}>경쟁</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>문서수</th>
                  <th style={{ ...S.th, textAlign: 'center', position: 'sticky', right: 0, background: '#fff' }}>찜</th>
                </tr>
              </thead>
              <tbody>
                {allKeywords.map((item, i) => {
                  const isPicked = picks.some(p => p.keyword === item.keyword && p.tool_id === item.hint)
                  return (
                    <tr key={`${item.hint}-${item.keyword}`} style={{ background: isPicked ? '#1a1a00' : 'transparent' }}>
                      <td style={{ ...S.td, color: '#4b6e4b' }}>{i + 1}</td>
                      <td style={{ ...S.td, fontSize: 12, color: '#71717a' }}>{item.hint}</td>
                      <td style={{ ...S.td, fontWeight: 700, color: '#0f1f0f' }}>{item.keyword}</td>
                      <td style={S.tdNum}>{fmt(item.pc)}</td>
                      <td style={S.tdNum}>{fmt(item.mobile)}</td>
                      <td style={{ ...S.tdNum, color: '#16a34a' }}>{fmt(item.total)}</td>
                      <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                      <td style={{ ...S.tdNum, fontSize: 12, color: '#71717a' }}>{item.doc_count != null ? fmt(item.doc_count) : '-'}</td>
                      <td style={{ ...S.td, textAlign: 'center', position: 'sticky', right: 0, background: isPicked ? '#1a1a00' : '#fff' }}>
                        <button onClick={() => handlePick(item.hint, { ...item, picked: isPicked })} style={{
                          background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
                        }}>
                          <StarIcon filled={isPicked} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {tab === 'golden' && (
        <div>
          <div style={{ fontSize: 12, color: '#71717a', marginBottom: 12, lineHeight: 1.6 }}>
            검색량은 높고 경쟁은 낮은 키워드를 그룹 구분 없이 전체에서 찾아 보여줍니다.
            아래일수록 합계가 낮아지니, <b style={{ color: '#0f1f0f' }}>위쪽일수록 더 좋은 후보</b>예요.
          </div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {['낮음', '중간', '높음', 'all'].map(c => (
              <button key={c} onClick={() => handleGoldenCompetitionChange(c)} style={{
                padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer',
                background: goldenCompetition === c ? '#16a34a' : '#f5f9f5',
                color: goldenCompetition === c ? '#fff' : '#4b6e4b',
                fontSize: 13, fontWeight: 700, fontFamily: "'Outfit', sans-serif",
              }}>{c === 'all' ? '전체' : '경쟁 ' + c}</button>
            ))}
            <span style={{ fontSize: 12, color: '#4b6e4b', alignSelf: 'center', marginLeft: 8 }}>
              {goldenKeywords.length.toLocaleString()}개 표시
            </span>
          </div>
          {goldenLoading ? (
            <div style={{ color: '#71717a', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div>
          ) : goldenKeywords.length === 0 ? (
            <div style={{ color: '#4b6e4b', fontSize: 14, padding: 20, textAlign: 'center' }}>
              이 경쟁도에 해당하는 키워드가 없어요.
            </div>
          ) : (
            <div style={{ overflowX: 'auto', borderRadius: 10, border: '1px solid #d1e8d1' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', overflow: 'hidden' }}>
              <thead>
                <tr>
                  <th style={S.th}>순위</th>
                  <th style={S.th}>그룹</th>
                  <th style={S.th}>키워드</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>PC</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>모바일</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>합계</th>
                  <th style={S.th}>경쟁</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>문서수</th>
                  <th style={{ ...S.th, textAlign: 'center', position: 'sticky', right: 0, background: '#fff' }}>찜</th>
                </tr>
              </thead>
              <tbody>
                {goldenKeywords.map((item, i) => {
                  const isPicked = picks.some(p => p.keyword === item.keyword && p.tool_id === item.hint)
                  return (
                    <tr key={`${item.hint}-${item.keyword}`} style={{ background: isPicked ? '#1a1a00' : 'transparent' }}>
                      <td style={{ ...S.td, color: '#4b6e4b' }}>{i + 1}</td>
                      <td style={{ ...S.td, fontSize: 12, color: '#71717a' }}>{item.hint}</td>
                      <td style={{ ...S.td, fontWeight: 700, color: '#0f1f0f' }}>{item.keyword}</td>
                      <td style={S.tdNum}>{fmt(item.pc)}</td>
                      <td style={S.tdNum}>{fmt(item.mobile)}</td>
                      <td style={{ ...S.tdNum, color: '#16a34a' }}>{fmt(item.total)}</td>
                      <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                      <td style={{ ...S.tdNum, fontSize: 12, color: '#71717a' }}>{item.doc_count != null ? fmt(item.doc_count) : '-'}</td>
                      <td style={{ ...S.td, textAlign: 'center', position: 'sticky', right: 0, background: isPicked ? '#1a1a00' : '#fff' }}>
                        <button onClick={() => handlePick(item.hint, { ...item, picked: isPicked })} style={{
                          background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
                        }}>
                          <StarIcon filled={isPicked} />
                        </button>
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
            </div>
          )}
        </div>
      )}

      {tab === 'picks' && (
        <div>
          {picksLoading ? (
            <div style={{ color: '#71717a', fontSize: 13, padding: 20 }}>로딩 중...</div>
          ) : pendingPicks.length === 0 ? (
            <div style={{ color: '#4b6e4b', fontSize: 14, padding: 20, textAlign: 'center' }}>
              아직 쓸 차례를 기다리는 찜 키워드가 없어요.<br/>
              <span style={{ fontSize: 12, marginTop: 6, display: 'block' }}>수집 현황 / 전체 순위 / 황금키워드 탭에서 ☆ 버튼으로 찜해두세요!</span>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 10, overflow: 'hidden', border: '1px solid #d1e8d1' }}>
              <thead>
                <tr>
                  <th style={S.th}>그룹</th>
                  <th style={S.th}>키워드</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>PC</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>모바일</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>합계</th>
                  <th style={S.th}>경쟁</th>
                  <th style={S.th}>메모</th>
                  <th style={{ ...S.th, textAlign: 'center' }}>사용 처리</th>
                  <th style={{ ...S.th, textAlign: 'center' }}>해제</th>
                </tr>
              </thead>
              <tbody>
                {pendingPicks.map(item => (
                  <tr key={`${item.tool_id}-${item.keyword}`}>
                    <td style={{ ...S.td, fontSize: 12, color: '#71717a' }}>{item.tool_id}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: '#0f1f0f' }}>{item.keyword}</td>
                    <td style={S.tdNum}>{fmt(item.pc)}</td>
                    <td style={S.tdNum}>{fmt(item.mobile)}</td>
                    <td style={{ ...S.tdNum, color: '#16a34a' }}>{fmt(item.total)}</td>
                    <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                    <td style={{ ...S.td, fontSize: 12, color: '#374151', maxWidth: 200 }}>{item.memo || '-'}</td>
                    <td style={{ ...S.td, textAlign: 'center' }}>
                      <button onClick={() => handleMarkUsed(item)} style={{
                        background: '#f0fdf4', border: '1px solid #86efac', color: '#16a34a',
                        borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        fontFamily: "'Outfit', sans-serif",
                      }}>✅ 사용함</button>
                    </td>
                    <td style={{ ...S.td, textAlign: 'center' }}>
                      <button onClick={() => handleUnpick(item.tool_id, item.keyword)} style={{
                        background: 'none', border: 'none', cursor: 'pointer', fontSize: 16,
                      }}><StarIcon filled /></button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'today' && (
        <div>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 14 }}>
            <div style={{ fontSize: 12, color: '#71717a', lineHeight: 1.7 }}>
              오늘 Claude가 <code style={{ color: '#16a34a' }}>naver_keyword_volume</code>으로 실시간 조회한 키워드 목록입니다.<br />
              ☆ 버튼으로 찜해두면 "찜한 키워드" 탭에서 관리할 수 있습니다.
            </div>
            <button onClick={loadToday} style={{
              padding: '5px 14px', borderRadius: 8, border: '1px solid #3f3f46',
              background: 'none', color: '#71717a', fontSize: 13, cursor: 'pointer',
              fontFamily: "'Outfit', sans-serif",
            }}>🔄 새로고침</button>
          </div>
          {todayLoading ? (
            <div style={{ color: '#71717a', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div>
          ) : todayRows.length === 0 ? (
            <div style={{ color: '#4b6e4b', fontSize: 14, padding: 40, textAlign: 'center' }}>
              <div style={{ fontSize: 32, marginBottom: 10 }}>🔴</div>
              오늘 실시간 조회한 키워드가 없어요.<br />
              <span style={{ fontSize: 12, color: '#4b6e4b', marginTop: 6, display: 'block' }}>
                Claude와 대화 중 naver_keyword_volume 툴이 호출되면 여기에 나타납니다.
              </span>
            </div>
          ) : (() => {
            const groups = {}
            todayRows.forEach(r => { if (!groups[r.hint]) groups[r.hint] = []; groups[r.hint].push(r) })
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {Object.entries(groups).map(([hint, rows]) => (
                  <div key={hint} style={{ background: '#f5f9f5', border: '1px solid #d1e8d1', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 18px', borderBottom: '1px solid #d1e8d1', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: '#16a34a' }}>🔍 {hint}</span>
                      <span style={{ fontSize: 12, color: '#4b6e4b' }}>연관 키워드 {rows.length}개</span>
                    </div>
                    <div style={{ overflowX: 'auto' }}>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr>
                        <th style={S.th}>순위</th><th style={S.th}>키워드</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>PC</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>모바일</th>
                        <th style={{ ...S.th, textAlign: 'right' }}>합계</th>
                        <th style={S.th}>경쟁</th>
                        <th style={{ ...S.th, textAlign: 'center', position: 'sticky', right: 0, background: '#f5f9f5' }}>찜</th>
                      </tr></thead>
                      <tbody>
                        {rows.map((item, i) => (
                          <tr key={item.keyword} style={{ background: item.picked ? '#1a1a00' : 'transparent' }}>
                            <td style={{ ...S.td, color: '#4b6e4b' }}>{i + 1}</td>
                            <td style={{ ...S.td, fontWeight: 600, color: '#0f1f0f' }}>{item.keyword}</td>
                            <td style={S.tdNum}>{fmt(item.pc)}</td>
                            <td style={S.tdNum}>{fmt(item.mobile)}</td>
                            <td style={{ ...S.tdNum, color: '#16a34a' }}>{fmt(item.total)}</td>
                            <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                            <td style={{ ...S.td, textAlign: 'center', position: 'sticky', right: 0, background: item.picked ? '#1a1a00' : '#f5f9f5' }}>
                              <button onClick={() => handlePick(item.hint, { ...item, picked: item.picked })} style={{
                                background: 'none', border: 'none', cursor: 'pointer', fontSize: 18,
                              }}><StarIcon filled={item.picked} /></button>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                    </div>
                  </div>
                ))}
              </div>
            )
          })()}
        </div>
      )}

      {tab === 'used' && (
        <div>
          <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 12 }}>
            <button onClick={handleSyncFromPublishLog} style={{
              padding: '8px 18px', background: '#16a34a', color: '#fff',
              border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700,
              cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
            }}>🔄 발행기록으로 업데이트</button>
          </div>
          {picksLoading ? (
            <div style={{ color: '#71717a', fontSize: 13, padding: 20 }}>로딩 중...</div>
          ) : usedPicks.length === 0 ? (
            <div style={{ color: '#4b6e4b', fontSize: 14, padding: 20, textAlign: 'center' }}>
              아직 사용 처리된 키워드가 없어요.<br/>
              <span style={{ fontSize: 12, marginTop: 6, display: 'block' }}>찜한 키워드 탭의 "✅ 사용함" 버튼으로 기록해두세요!</span>
            </div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#fff', borderRadius: 10, overflow: 'hidden', border: '1px solid #d1e8d1' }}>
              <thead>
                <tr>
                  <th style={S.th}>사용일</th>
                  <th style={S.th}>그룹</th>
                  <th style={S.th}>키워드</th>
                  <th style={{ ...S.th, textAlign: 'right' }}>합계</th>
                  <th style={S.th}>사용한 글</th>
                  <th style={{ ...S.th, textAlign: 'center' }}>되돌리기</th>
                </tr>
              </thead>
              <tbody>
                {usedPicks.map(item => (
                  <tr key={`${item.tool_id}-${item.keyword}`}>
                    <td style={{ ...S.td, fontSize: 12, color: '#71717a' }}>{formatDate(item.used_at)}</td>
                    <td style={{ ...S.td, fontSize: 12, color: '#71717a' }}>{item.tool_id}</td>
                    <td style={{ ...S.td, fontWeight: 700, color: '#0f1f0f' }}>{item.keyword}</td>
                    <td style={{ ...S.tdNum, color: '#16a34a' }}>{fmt(item.total)}</td>
                    <td style={{ ...S.td, fontSize: 13, color: '#374151' }}>
                      {item.used_in_title || '-'}
                      {item.used_in_slug && (
                        <div style={{ fontSize: 11, color: '#4b6e4b' }}>/blog/{item.used_in_slug}</div>
                      )}
                    </td>
                    <td style={{ ...S.td, textAlign: 'center' }}>
                      <button onClick={() => handleUnmarkUsed(item.tool_id, item.keyword)} style={{
                        background: 'none', border: '1px solid #d1e8d1', color: '#4b6e4b',
                        borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer',
                        fontFamily: "'Outfit', sans-serif",
                      }}>↩️ 되돌리기</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {confirmDelete && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998,
        }} onClick={() => setConfirmDelete(null)}>
          <div style={{
            background: '#f5f9f5', border: '1px solid #3f3f46', borderRadius: 12,
            padding: 28, width: 320, fontFamily: "'Outfit', sans-serif",
          }} onClick={e => e.stopPropagation()}>
            {confirmDelete.type === 'duplicate' ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0f1f0f', marginBottom: 10 }}>⚠️ 이미 있는 키워드</div>
                <div style={{ fontSize: 14, color: '#374151', marginBottom: 20 }}>
                  <b style={{ color: '#16a34a' }}>"{confirmDelete.hint}"</b>는 이미 수집된 키워드예요.<br/>
                  업데이트하려면 해당 항목의 업데이트 버튼을 눌러주세요.
                </div>
                <button onClick={() => setConfirmDelete(null)} style={{
                  width: '100%', background: '#f5f9f5', color: '#0f1f0f', border: 'none',
                  borderRadius: 8, padding: '10px', fontSize: 14, fontWeight: 700,
                  cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                }}>확인</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#0f1f0f', marginBottom: 10 }}>🗑 키워드 삭제</div>
                <div style={{ fontSize: 14, color: '#374151', marginBottom: 20 }}>
                  <b style={{ color: '#16a34a' }}>"{confirmDelete.hint}"</b> 키워드 데이터를 전부 삭제할까요?
                  <span style={{ fontSize: 12, color: '#4b6e4b', marginTop: 4, display: 'block' }}>삭제 후 복구가 불가능합니다.</span>
                </div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setConfirmDelete(null)} style={{
                    flex: 1, background: '#e8f5e9', color: '#15803d', border: 'none',
                    borderRadius: 8, padding: '10px', fontSize: 14, fontWeight: 700,
                    cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                  }}>취소</button>
                  <button onClick={async () => {
                    const hint = confirmDelete.hint
                    setConfirmDelete(null)
                    await handleDeleteHint(hint)
                  }} style={{
                    flex: 1, background: '#16a34a', color: '#fff', border: 'none',
                    borderRadius: 8, padding: '10px', fontSize: 14, fontWeight: 700,
                    cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
                  }}>삭제</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {tab === 'ideas' && (
        <FeatureIdeasTab adminToken={adminToken} showToast={showToast} />
      )}

      {resultModal && (
        <div style={{
          position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999,
        }} onClick={() => setResultModal(null)}>
          <div style={{
            background: '#ffffff', border: `2px solid ${resultModal.type === 'error' ? '#dc2626' : '#16a34a'}`,
            borderRadius: 14, padding: 28, width: 340, maxWidth: '90vw',
            fontFamily: "'Outfit', sans-serif", boxShadow: '0 12px 36px rgba(0,0,0,0.25)',
          }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 26 }}>{resultModal.type === 'error' ? '⛔' : '✅'}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: resultModal.type === 'error' ? '#dc2626' : '#15803d' }}>
                {resultModal.type === 'error' ? '오류 발생' : '완료'}
              </span>
            </div>
            <div style={{ fontSize: 14, color: '#27272a', lineHeight: 1.6, marginBottom: 24, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
              {resultModal.message}
            </div>
            <button onClick={() => setResultModal(null)} style={{
              width: '100%', background: resultModal.type === 'error' ? '#dc2626' : '#2563eb',
              color: '#fff', border: 'none', borderRadius: 9, padding: '12px',
              fontSize: 15, fontWeight: 800, cursor: 'pointer', fontFamily: "'Outfit', sans-serif",
              boxShadow: resultModal.type === 'error' ? '0 2px 10px rgba(220,38,38,0.35)' : '0 2px 10px rgba(37,99,235,0.35)',
            }}>확인</button>
          </div>
        </div>
      )}
    </div>
  )
}
