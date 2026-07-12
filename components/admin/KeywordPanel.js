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

export default function KeywordPanel({ token }) {
  const [hintList, setHintList] = useState([])
  const [loadingKw, setLoadingKw] = useState({})
  const [loadingDoc, setLoadingDoc] = useState({})
  const [docProgress, setDocProgress] = useState({})
  const [expanded, setExpanded] = useState(null)
  const [topData, setTopData] = useState({})
  const [topLoading, setTopLoading] = useState({})
  const [resultModal, setResultModal] = useState(null)
  const [tab, setTab] = useState('top')
  const [picks, setPicks] = useState([])
  const [picksLoading, setPicksLoading] = useState(false)
  const [addKeyword, setAddKeyword] = useState('')
  const [addLoading, setAddLoading] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(null)
  const [allKeywords, setAllKeywords] = useState([])
  const [allKwLimit, setAllKwLimit] = useState(100)
  const [allKwLoading, setAllKwLoading] = useState(false)
  const [allKwLoaded, setAllKwLoaded] = useState(false)
  const [goldenKeywords, setGoldenKeywords] = useState([])
  const [goldenLoading, setGoldenLoading] = useState(false)
  const [goldenLoaded, setGoldenLoaded] = useState(false)
  const [goldenCompetition, setGoldenCompetition] = useState('낮음')
  const [todayRows, setTodayRows] = useState([])
  const [todayLoading, setTodayLoading] = useState(false)

  const [batchStatus, setBatchStatus] = useState(null)
  const [batchRunning, setBatchRunning] = useState(false)
  const [batchProgress, setBatchProgress] = useState(null)
  const [batchPriority, setBatchPriority] = useState('search_volume')
  const [batchChunk, setBatchChunk] = useState(100)

  const showToast = (msg) => {
    const isError = msg.trim().startsWith('❌')
    setResultModal({ type: isError ? 'error' : 'success', message: msg })
  }

  const loadStats = () => {
    fetch('/api/admin/keyword-stats', { headers: { 'x-admin-token': token } })
      .then(r => r.json())
      .then(data => setHintList(Array.isArray(data) ? data : []))
      .catch(console.error)
  }

  useEffect(() => { loadStats() }, [token])

  const loadBatchStatus = async () => {
    try {
      const res = await fetch('/api/admin/doc-batch', { headers: { 'x-admin-token': token } })
      const data = await res.json()
      if (res.ok) setBatchStatus(data)
    } catch (e) { console.error(e) }
  }

  useEffect(() => { loadBatchStatus() }, [token])

  const handleRunBatch = async () => {
    if (batchRunning) return
    setBatchRunning(true)
    setBatchProgress({ filled: 0, stillNull: null, dailyUsed: null, dailyRemaining: null })
    let totalFilled = 0
    let continueLoop = true
    try {
      while (continueLoop) {
        const res = await fetch('/api/admin/doc-batch', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
          body: JSON.stringify({ chunk: batchChunk, priority: batchPriority }),
        })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '오류')
        totalFilled += data.filled || 0
        continueLoop = !data.done
        setBatchProgress({ filled: totalFilled, stillNull: data.still_null, dailyUsed: data.today_used, dailyRemaining: data.remaining, reason: data.reason })
        if (!continueLoop) break
        await new Promise(r => setTimeout(r, 400))
      }
      loadStats(); loadBatchStatus()
      if (batchProgress?.reason === 'daily_limit') showToast(`⚠️ 일일 한도 도달 — 오늘 ${totalFilled}개 수집 완료`)
      else showToast(`✅ 전체 문서수 수집 완료! ${totalFilled}개`)
    } catch (e) {
      showToast(`❌ 배치 오류: ${e.message}`)
    }
    setBatchRunning(false)
  }

  const loadPicks = async () => {
    setPicksLoading(true)
    try {
      const res = await fetch('/api/admin/keyword-picks', { headers: { 'x-admin-token': token } })
      setPicks(await res.json())
    } catch (e) { console.error(e) }
    setPicksLoading(false)
  }

  useEffect(() => { loadPicks() }, [token])

  const loadAllKeywords = async (lim) => {
    setAllKwLoading(true)
    try {
      const res = await fetch(`/api/admin/keyword-all?limit=${lim || allKwLimit}`, { headers: { 'x-admin-token': token } })
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
      const res = await fetch(`/api/admin/keyword-golden?competition=${encodeURIComponent(c)}&limit=200`, { headers: { 'x-admin-token': token } })
      const data = await res.json()
      setGoldenKeywords(data.results || [])
      setGoldenLoaded(true)
    } catch (e) { console.error(e) }
    setGoldenLoading(false)
  }

  const loadToday = async () => {
    setTodayLoading(true)
    try {
      const res = await fetch('/api/admin/keyword-stats?mode=today', { headers: { 'x-admin-token': token } })
      const data = await res.json()
      setTodayRows(Array.isArray(data) ? data : [])
    } catch (e) { console.error(e) }
    setTodayLoading(false)
  }

  const handleGoldenCompetitionChange = (c) => { setGoldenCompetition(c); setGoldenLoaded(false); loadGolden(c) }

  const handleTabChange = (t) => {
    setTab(t)
    if (t === 'all') loadAllKeywords()
    if (t === 'golden' && !goldenLoaded) loadGolden()
    if (t === 'today') loadToday()
  }

  const handleLimitChange = (lim) => { setAllKwLimit(lim); setAllKwLoaded(false); loadAllKeywords(lim) }

  const handleExpand = async (hint) => {
    if (expanded === hint) { setExpanded(null); return }
    setExpanded(hint)
    if (topData[hint]) return
    setTopLoading(l => ({ ...l, [hint]: true }))
    try {
      const res = await fetch(`/api/admin/keyword-top?hint=${encodeURIComponent(hint)}&limit=50`, { headers: { 'x-admin-token': token } })
      const data = await res.json()
      setTopData(d => ({ ...d, [hint]: data.results || [] }))
    } catch (e) { console.error(e) }
    setTopLoading(l => ({ ...l, [hint]: false }))
  }

  const handleUpdateKeyword = async (hint) => {
    setLoadingKw(l => ({ ...l, [hint]: true }))
    try {
      const res = await fetch(`/api/admin/keyword-volume?keyword=${encodeURIComponent(hint)}&mode=keyword_only`, { headers: { 'x-admin-token': token } })
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
        const res = await fetch(`/api/admin/keyword-volume?keyword=${encodeURIComponent(hint)}&mode=doc_only&chunk=${CHUNK}`, { headers: { 'x-admin-token': token } })
        const data = await res.json()
        if (!res.ok) throw new Error(data.error || '오류')
        totalFilled += data.filled || 0
        done = data.done
        setDocProgress(p => ({ ...p, [hint]: { filled: totalFilled, stillNull: data.still_null, total: (data.still_null || 0) + totalFilled } }))
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
    if (exists) { setConfirmDelete({ type: 'duplicate', hint: kw }); return }
    setAddLoading(true)
    try {
      const res = await fetch(`/api/admin/keyword-volume?keyword=${encodeURIComponent(kw)}`, { headers: { 'x-admin-token': token } })
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
      const res = await fetch(`/api/admin/keyword-delete?hint=${encodeURIComponent(hint)}`, { method: 'DELETE', headers: { 'x-admin-token': token } })
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
        await fetch(`/api/admin/keyword-picks?tool_id=${encodeURIComponent(hint)}&keyword=${encodeURIComponent(item.keyword)}`, { method: 'DELETE', headers: { 'x-admin-token': token } })
      } else {
        await fetch('/api/admin/keyword-picks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
          body: JSON.stringify({ tool_id: hint, keyword: item.keyword, pc: item.pc, mobile: item.mobile, total: item.total, competition: item.competition, hint }),
        })
      }
      setTopData(d => ({ ...d, [hint]: (d[hint] || []).map(k => k.keyword === item.keyword ? { ...k, picked: !isPicked } : k) }))
      loadPicks()
      showToast(isPicked ? '⭐ 찜 해제됨' : '⭐ 찜에 추가됨!')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleUnpick = async (toolId, keyword) => {
    try {
      await fetch(`/api/admin/keyword-picks?tool_id=${encodeURIComponent(toolId)}&keyword=${encodeURIComponent(keyword)}`, { method: 'DELETE', headers: { 'x-admin-token': token } })
      setPicks(p => p.filter(k => !(k.tool_id === toolId && k.keyword === keyword)))
      showToast('⭐ 찜 해제됨')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleSyncFromPublishLog = async () => {
    try {
      showToast('🔄 발행기록에서 동기화 중...')
      const res = await fetch('/api/admin/content-log?limit=500', { headers: { 'x-admin-token': token } })
      const logs = await res.json()
      const toSync = logs.filter(l => l.target_keyword)
      if (toSync.length === 0) { showToast('⚠️ 동기화할 키워드가 없습니다'); return }
      let updated = 0
      for (const log of toSync) {
        const toolId = log.category || 'general'
        await fetch('/api/admin/keyword-picks', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
          body: JSON.stringify({ tool_id: toolId, hint: toolId, keyword: log.target_keyword, pc: log.search_pc || 0, mobile: log.search_mobile || 0, total: log.search_total || 0, competition: log.competition || '' }),
        })
        const r = await fetch('/api/admin/keyword-picks', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
          body: JSON.stringify({ tool_id: toolId, keyword: log.target_keyword, used_in_title: log.title || null, used_in_slug: log.slug || null }),
        })
        if (r.ok) updated++
      }
      loadPicks()
      showToast(`✅ ${updated}개 키워드 동기화 완료`)
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const handleUnmarkUsed = async (toolId, keyword) => {
    try {
      const res = await fetch('/api/admin/keyword-picks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
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
      const res = await fetch('/api/admin/keyword-picks', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': token },
        body: JSON.stringify({ tool_id: item.tool_id, keyword: item.keyword, used_in_title: title, used_in_slug: slug }),
      })
      if (!res.ok) throw new Error('처리 실패')
      loadPicks()
      showToast('✅ 사용 처리됨')
    } catch (e) { showToast(`❌ 오류: ${e.message}`) }
  }

  const allRows = [...hintList].sort((a, b) => a.hint.localeCompare(b.hint, 'ko'))
  const pendingPicks = picks.filter(p => !p.used_at)
  const usedPicks = picks.filter(p => p.used_at).sort((a, b) => new Date(b.used_at).getTime() - new Date(a.used_at).getTime())

  const S = {
    th: { fontSize: 12, color: '#9aa0ab', fontWeight: 600, padding: '6px 10px', textAlign: 'left', borderBottom: '1px solid #2a2e38' },
    td: { fontSize: 13, color: '#e8eaed', padding: '8px 10px', borderBottom: '1px solid #2a2e38' },
    tdNum: { fontSize: 13, color: '#e8eaed', fontWeight: 700, padding: '8px 10px', borderBottom: '1px solid #2a2e38', textAlign: 'right' },
  }

  return (
    <div>
      <h2 style={{ color: '#e8eaed', fontSize: 20, fontWeight: 800, marginBottom: 6 }}>🔍 키워드 검색량 관리</h2>
      <p style={{ color: '#9aa0ab', fontSize: 13, marginBottom: 12 }}>키워드를 입력하면 네이버 연관 키워드 전체를 수집해서 아래 목록에 추가합니다.</p>

      {allRows.length > 0 && (() => {
        const totalKeywords = allRows.reduce((sum, r) => sum + (r.count || 0), 0)
        const dailyLimit = batchStatus?.daily_limit || 25000
        const liveUsed = batchProgress?.dailyUsed ?? batchStatus?.today_used ?? null
        const liveRemaining = batchProgress?.dailyRemaining ?? batchStatus?.remaining ?? null
        const WARNING_THRESH = 5000
        const isWarning = liveRemaining != null && liveRemaining <= WARNING_THRESH
        const isDanger = liveRemaining != null && liveRemaining <= 1000
        const usedPct = liveUsed != null ? Math.min(100, Math.round((liveUsed / dailyLimit) * 100)) : null

        return (
          <>
            <div style={{ display: 'flex', gap: 10, marginBottom: 12, flexWrap: 'wrap' }}>
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: '#9aa0ab' }}>전체 수집 키워드</span>
                <span style={{ fontSize: 18, fontWeight: 900, color: '#4CAF50' }}>{totalKeywords.toLocaleString()}</span>
                <span style={{ fontSize: 13, color: '#9aa0ab' }}>개</span>
              </div>
              <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 8 }}>
                <span style={{ fontSize: 13, color: '#9aa0ab' }}>그룹</span>
                <span style={{ fontSize: 18, fontWeight: 900, color: '#e8eaed' }}>{allRows.length}</span>
                <span style={{ fontSize: 13, color: '#9aa0ab' }}>개</span>
              </div>
              {liveRemaining != null && (
                <div style={{ background: isDanger ? 'rgba(244,67,54,0.08)' : isWarning ? 'rgba(255,193,7,0.08)' : '#171a21', border: `1px solid ${isDanger ? '#F44336' : isWarning ? '#FFC107' : '#2a2e38'}`, borderRadius: 10, padding: '10px 18px', display: 'flex', alignItems: 'center', gap: 10, minWidth: 220 }}>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1 }}>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                      <span style={{ fontSize: 13, color: isDanger ? '#F44336' : isWarning ? '#FFC107' : '#9aa0ab' }}>{isDanger ? '🚨' : isWarning ? '⚠️' : '📡'} 오늘 남은 한도</span>
                      <span style={{ fontSize: 18, fontWeight: 900, color: isDanger ? '#F44336' : isWarning ? '#FFC107' : '#4CAF50' }}>{liveRemaining.toLocaleString()}</span>
                      <span style={{ fontSize: 13, color: '#9aa0ab' }}>/ {dailyLimit.toLocaleString()}</span>
                    </div>
                    <div style={{ height: 4, background: '#2a2e38', borderRadius: 2, overflow: 'hidden' }}>
                      <div style={{ height: '100%', width: `${usedPct}%`, background: isDanger ? '#F44336' : isWarning ? '#FFC107' : '#4CAF50', borderRadius: 2, transition: 'width 0.4s' }} />
                    </div>
                    <div style={{ fontSize: 11, color: '#9aa0ab' }}>사용 {(liveUsed || 0).toLocaleString()}개 ({usedPct}%)</div>
                  </div>
                </div>
              )}
            </div>
            {isWarning && (
              <div style={{ background: isDanger ? 'rgba(244,67,54,0.08)' : 'rgba(255,193,7,0.08)', border: `1px solid ${isDanger ? '#F44336' : '#FFC107'}`, borderRadius: 8, padding: '10px 16px', marginBottom: 12, display: 'flex', alignItems: 'center', gap: 10 }}>
                <span style={{ fontSize: 18 }}>{isDanger ? '🚨' : '⚠️'}</span>
                <div>
                  <div style={{ fontSize: 13, fontWeight: 700, color: isDanger ? '#F44336' : '#FFC107' }}>
                    {isDanger ? `API 한도 거의 소진 — 오늘 ${liveRemaining.toLocaleString()}개만 남았습니다` : `API 한도 주의 — 오늘 ${liveRemaining.toLocaleString()}개 남음`}
                  </div>
                </div>
              </div>
            )}
          </>
        )
      })()}

      <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, padding: '16px 18px', marginBottom: 20 }}>
        <div style={{ fontSize: 14, fontWeight: 700, color: '#e8eaed', marginBottom: 12 }}>➕ 키워드 추가 수집</div>
        <div style={{ display: 'flex', gap: 8 }}>
          <input value={addKeyword} onChange={e => setAddKeyword(e.target.value)} onKeyDown={e => e.key === 'Enter' && handleAdd()}
            placeholder="예: 매매전략, 자동매매, HMA크로스"
            style={{ flex: 1, background: '#0f1115', border: '1px solid #2a2e38', borderRadius: 8, color: '#e8eaed', fontSize: 13, padding: '8px 12px', outline: 'none' }} />
          <button onClick={handleAdd} disabled={addLoading} style={{ background: '#4CAF50', color: '#fff', border: 'none', borderRadius: 8, padding: '8px 20px', fontSize: 13, fontWeight: 700, cursor: addLoading ? 'wait' : 'pointer', opacity: addLoading ? 0.6 : 1 }}>
            {addLoading ? '수집 중...' : '수집'}
          </button>
        </div>
      </div>

      <div style={{ background: 'rgba(76,175,80,0.06)', border: `1px solid ${batchRunning ? '#4CAF50' : '#2a2e38'}`, borderRadius: 12, padding: '18px 20px', marginBottom: 20 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 10, marginBottom: 14 }}>
          <div>
            <div style={{ fontSize: 14, fontWeight: 800, color: '#4CAF50', marginBottom: 3 }}>🚀 문서수 전체 자동 수집</div>
            <div style={{ fontSize: 12, color: '#9aa0ab' }}>검색량 높은 미수집 키워드부터 일일 한도 내에서 자동으로 수집합니다</div>
          </div>
          {batchStatus && (
            <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4, minWidth: 160 }}>
              <div style={{ fontSize: 11, color: '#9aa0ab', display: 'flex', gap: 6 }}>
                <span>오늘 사용</span>
                <b style={{ color: '#4CAF50' }}>{((batchProgress?.dailyUsed ?? batchStatus.today_used) || 0).toLocaleString()}</b>
                <span>/ {batchStatus.daily_limit.toLocaleString()}</span>
              </div>
              <div style={{ width: 160, height: 6, background: '#2a2e38', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ height: '100%', width: `${Math.min(100, Math.round(((batchProgress?.dailyUsed ?? batchStatus.today_used) / batchStatus.daily_limit) * 100))}%`, background: '#4CAF50', borderRadius: 3 }} />
              </div>
              <div style={{ fontSize: 11, color: '#9aa0ab' }}>남은 한도 <b style={{ color: '#e8eaed' }}>{((batchProgress?.dailyRemaining ?? batchStatus.remaining) || 0).toLocaleString()}</b>개</div>
            </div>
          )}
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap', marginBottom: 12 }}>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: '#9aa0ab', fontWeight: 700 }}>우선순위</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[['search_volume', '📊 검색량 순'], ['null_ratio', '📉 미수집 비율'], ['hint_order', '🗂 그룹 순서']].map(([v, l]) => (
                <button key={v} onClick={() => !batchRunning && setBatchPriority(v)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: batchRunning ? 'default' : 'pointer', background: batchPriority === v ? '#4CAF50' : '#0f1115', color: batchPriority === v ? '#fff' : '#9aa0ab', fontSize: 11, fontWeight: 700, opacity: batchRunning ? 0.5 : 1 }}>{l}</button>
              ))}
            </div>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ fontSize: 10, color: '#9aa0ab', fontWeight: 700 }}>한 번에</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {[50, 100, 200].map(n => (
                <button key={n} onClick={() => !batchRunning && setBatchChunk(n)} style={{ padding: '4px 10px', borderRadius: 6, border: 'none', cursor: batchRunning ? 'default' : 'pointer', background: batchChunk === n ? '#4CAF50' : '#0f1115', color: batchChunk === n ? '#fff' : '#9aa0ab', fontSize: 11, fontWeight: 700, opacity: batchRunning ? 0.5 : 1 }}>{n}개</button>
              ))}
            </div>
          </div>
          <button onClick={handleRunBatch} disabled={batchRunning || (batchStatus?.remaining === 0)} style={{ marginLeft: 'auto', background: batchRunning ? '#388E3C' : batchStatus?.remaining === 0 ? '#2a2e38' : '#4CAF50', color: batchStatus?.remaining === 0 && !batchRunning ? '#9aa0ab' : '#fff', border: 'none', borderRadius: 8, padding: '9px 20px', fontSize: 13, fontWeight: 800, cursor: batchRunning ? 'wait' : batchStatus?.remaining === 0 ? 'default' : 'pointer', minWidth: 120 }}>
            {batchRunning ? '수집 중...' : batchStatus?.remaining === 0 ? '오늘 한도 완료' : '▶ 자동 수집 시작'}
          </button>
        </div>

        {(batchRunning || batchProgress) && (
          <div style={{ background: 'rgba(76,175,80,0.06)', borderRadius: 8, padding: '12px 14px', marginTop: 4 }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
              <span style={{ fontSize: 12, color: '#4CAF50', fontWeight: 700 }}>
                {batchRunning ? '⏳ 수집 중...' : batchProgress?.reason === 'all_filled' ? '✅ 전체 완료!' : batchProgress?.reason === 'daily_limit' ? '⚠️ 오늘 한도 도달' : '완료'}
              </span>
              <span style={{ fontSize: 12, color: '#9aa0ab' }}>수집 <b style={{ color: '#4CAF50' }}>{(batchProgress?.filled || 0).toLocaleString()}</b>개</span>
            </div>
          </div>
        )}

        {batchStatus?.hints?.length > 0 && !batchRunning && (
          <details style={{ marginTop: 10 }}>
            <summary style={{ fontSize: 12, color: '#9aa0ab', cursor: 'pointer' }}>그룹별 미수집 현황 ({batchStatus.total_null?.toLocaleString()}개 남음) ▸</summary>
            <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 4 }}>
              {batchStatus.hints.map(h => (
                <div key={h.hint} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
                  <span style={{ color: '#9aa0ab', minWidth: 90 }}>{h.hint}</span>
                  <div style={{ flex: 1, height: 4, background: '#2a2e38', borderRadius: 2, overflow: 'hidden' }}>
                    <div style={{ height: '100%', width: `${Math.round(h.nullRatio * 100)}%`, background: h.nullRatio > 0.5 ? '#F44336' : '#4CAF50', borderRadius: 2 }} />
                  </div>
                  <span style={{ color: '#F44336', minWidth: 50, textAlign: 'right' }}>{h.nullCount.toLocaleString()}개</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </div>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}>
        {[['top', '📊 수집 현황'], ['all', '📈 전체 순위'], ['golden', '🏆 황금키워드'], ['today', '🔴 오늘 실시간'], ['picks', '⭐ 찜한 키워드'], ['used', '✅ 사용 키워드']].map(([id, label]) => (
          <button key={id} onClick={() => handleTabChange(id)} style={{ padding: '7px 16px', borderRadius: 8, border: 'none', cursor: 'pointer', background: tab === id ? '#4CAF50' : '#171a21', color: tab === id ? '#fff' : '#9aa0ab', fontSize: 13, fontWeight: 700 }}>{label}</button>
        ))}
      </div>

      {tab === 'top' && (
        <div>
          {allRows.length === 0 && <div style={{ color: '#9aa0ab', fontSize: 13, padding: 20, textAlign: 'center' }}>아직 수집된 키워드 그룹이 없습니다. 위에서 키워드를 추가해보세요.</div>}
          {allRows.map(row => {
            const days = daysSince(row.collected_at)
            const kwNeedsUpdate = days >= 30
            const docNeedsUpdate = (row.null_doc_count || 0) > 0
            const isLoadingKw = loadingKw[row.hint]
            const isLoadingDoc = loadingDoc[row.hint]
            const docProg = docProgress[row.hint]
            const isExpanded = expanded === row.hint
            const topList = topData[row.hint] || []
            return (
              <div key={row.hint} style={{ marginBottom: 8 }}>
                <div style={{ background: '#171a21', border: `1px solid ${isExpanded ? '#4CAF50' : '#2a2e38'}`, borderRadius: isExpanded ? '10px 10px 0 0' : 10, padding: '14px 18px', display: 'flex', alignItems: 'center', justifyContent: 'space-between', cursor: row.count > 0 ? 'pointer' : 'default' }} onClick={() => row.count > 0 && handleExpand(row.hint)}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: 15, fontWeight: 700, color: '#e8eaed', minWidth: 120 }}>{row.hint}</span>
                    <div>
                      <div style={{ fontSize: 13, color: kwNeedsUpdate ? '#F44336' : '#9aa0ab' }}>네이버 검색일: <b style={{ color: '#e8eaed' }}>{formatDate(row.collected_at)}</b></div>
                      {row.count > 0 && (
                        <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 2 }}>
                          키워드 <b style={{ color: '#4CAF50', fontSize: 13 }}>{fmt(row.count)}개</b>
                          {row.null_doc_count > 0 ? <span style={{ color: '#F44336', marginLeft: 6 }}>· 문서수 미수집 <b>{fmt(row.null_doc_count)}개</b> 남음</span> : <span style={{ color: '#4CAF50', marginLeft: 6 }}>· 문서수 완료 ✓</span>}
                          {' · 클릭해서 TOP 50 보기'}
                        </div>
                      )}
                    </div>
                  </div>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <button onClick={e => { e.stopPropagation(); kwNeedsUpdate && !isLoadingKw && handleUpdateKeyword(row.hint) }} disabled={isLoadingKw || !kwNeedsUpdate}
                      style={{ background: isLoadingKw ? '#1d4ed8' : kwNeedsUpdate ? '#2563eb' : '#0f1115', color: kwNeedsUpdate ? '#fff' : '#9aa0ab', border: `1px solid ${kwNeedsUpdate ? '#3b82f6' : '#2a2e38'}`, borderRadius: 8, padding: '7px 13px', fontSize: 12, fontWeight: 700, cursor: isLoadingKw ? 'wait' : kwNeedsUpdate ? 'pointer' : 'default', whiteSpace: 'nowrap' }}>
                      {isLoadingKw ? '수집 중...' : kwNeedsUpdate ? '🔄 키워드' : '✓ 키워드'}
                    </button>
                    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 3 }}>
                      <button onClick={e => { e.stopPropagation(); docNeedsUpdate && !isLoadingDoc && handleUpdateDocCount(row.hint) }} disabled={isLoadingDoc || !docNeedsUpdate}
                        style={{ background: isLoadingDoc ? '#388E3C' : docNeedsUpdate ? '#4CAF50' : '#0f1115', color: docNeedsUpdate ? '#fff' : '#9aa0ab', border: `1px solid ${docNeedsUpdate ? '#4CAF50' : '#2a2e38'}`, borderRadius: 8, padding: '7px 13px', fontSize: 12, fontWeight: 700, cursor: isLoadingDoc ? 'wait' : docNeedsUpdate ? 'pointer' : 'default', minWidth: 80 }}>
                        {isLoadingDoc ? (docProg?.total ? `${docProg.filled}/${docProg.total}` : '수집 중...') : docNeedsUpdate ? '📄 문서수' : '✓ 문서수'}
                      </button>
                    </div>
                    <button onClick={e => { e.stopPropagation(); setConfirmDelete({ type: 'delete', hint: row.hint }) }} style={{ background: 'none', border: '1px solid #2a2e38', borderRadius: 8, color: '#9aa0ab', fontSize: 13, padding: '7px 10px', cursor: 'pointer' }}>🗑</button>
                  </div>
                </div>

                {isExpanded && (
                  <div style={{ background: '#0f1115', border: '1px solid #4CAF50', borderTop: 'none', borderRadius: '0 0 10px 10px', overflow: 'hidden' }}>
                    {topLoading[row.hint] ? (
                      <div style={{ padding: 20, color: '#9aa0ab', fontSize: 13, textAlign: 'center' }}>로딩 중...</div>
                    ) : (
                      <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                        <thead><tr><th style={S.th}>순위</th><th style={S.th}>키워드</th><th style={{ ...S.th, textAlign: 'right' }}>PC</th><th style={{ ...S.th, textAlign: 'right' }}>모바일</th><th style={{ ...S.th, textAlign: 'right' }}>합계</th><th style={S.th}>경쟁</th><th style={{ ...S.th, textAlign: 'right' }}>문서수</th><th style={{ ...S.th, textAlign: 'center' }}>찜</th></tr></thead>
                        <tbody>
                          {topList.map((item, i) => (
                            <tr key={item.keyword} style={{ background: item.picked ? 'rgba(255,193,7,0.06)' : 'transparent' }}>
                              <td style={{ ...S.td, color: '#9aa0ab' }}>{i + 1}</td>
                              <td style={{ ...S.td, fontWeight: 600 }}>{item.keyword}</td>
                              <td style={S.tdNum}>{fmt(item.pc)}</td>
                              <td style={S.tdNum}>{fmt(item.mobile)}</td>
                              <td style={{ ...S.tdNum, color: '#4CAF50' }}>{fmt(item.total)}</td>
                              <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                              <td style={{ ...S.tdNum, fontSize: 12, color: '#9aa0ab' }}>{item.doc_count != null ? fmt(item.doc_count) : '-'}</td>
                              <td style={{ ...S.td, textAlign: 'center' }}>
                                <button onClick={e => { e.stopPropagation(); handlePick(row.hint, item) }} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>{item.picked ? '⭐' : '☆'}</button>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
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
              <button key={n} onClick={() => handleLimitChange(n)} style={{ padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: allKwLimit === n ? '#4CAF50' : '#171a21', color: allKwLimit === n ? '#fff' : '#9aa0ab', fontSize: 13, fontWeight: 700 }}>{n}개</button>
            ))}
            <span style={{ fontSize: 12, color: '#9aa0ab', alignSelf: 'center', marginLeft: 8 }}>현재 {allKeywords.length.toLocaleString()}개 표시</span>
          </div>
          {allKwLoading ? <div style={{ color: '#9aa0ab', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div> : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#171a21', borderRadius: 10, overflow: 'hidden', border: '1px solid #2a2e38' }}>
              <thead><tr><th style={S.th}>순위</th><th style={S.th}>그룹</th><th style={S.th}>키워드</th><th style={{ ...S.th, textAlign: 'right' }}>PC</th><th style={{ ...S.th, textAlign: 'right' }}>모바일</th><th style={{ ...S.th, textAlign: 'right' }}>합계</th><th style={S.th}>경쟁</th><th style={{ ...S.th, textAlign: 'right' }}>문서수</th><th style={{ ...S.th, textAlign: 'center' }}>찜</th></tr></thead>
              <tbody>
                {allKeywords.map((item, i) => {
                  const isPicked = picks.some(p => p.keyword === item.keyword && p.tool_id === item.hint)
                  return (
                    <tr key={`${item.hint}-${item.keyword}`} style={{ background: isPicked ? 'rgba(255,193,7,0.06)' : 'transparent' }}>
                      <td style={{ ...S.td, color: '#9aa0ab' }}>{i + 1}</td>
                      <td style={{ ...S.td, fontSize: 12, color: '#9aa0ab' }}>{item.hint}</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{item.keyword}</td>
                      <td style={S.tdNum}>{fmt(item.pc)}</td>
                      <td style={S.tdNum}>{fmt(item.mobile)}</td>
                      <td style={{ ...S.tdNum, color: '#4CAF50' }}>{fmt(item.total)}</td>
                      <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                      <td style={{ ...S.tdNum, fontSize: 12, color: '#9aa0ab' }}>{item.doc_count != null ? fmt(item.doc_count) : '-'}</td>
                      <td style={{ ...S.td, textAlign: 'center' }}><button onClick={() => handlePick(item.hint, { ...item, picked: isPicked })} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>{isPicked ? '⭐' : '☆'}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'golden' && (
        <div>
          <div style={{ fontSize: 12, color: '#9aa0ab', marginBottom: 12, lineHeight: 1.6 }}>검색량은 높고 경쟁은 낮은 키워드를 그룹 구분 없이 전체에서 찾아 보여줍니다.</div>
          <div style={{ display: 'flex', gap: 6, marginBottom: 14 }}>
            {['낮음', '중간', '높음', 'all'].map(c => (
              <button key={c} onClick={() => handleGoldenCompetitionChange(c)} style={{ padding: '5px 14px', borderRadius: 8, border: 'none', cursor: 'pointer', background: goldenCompetition === c ? '#4CAF50' : '#171a21', color: goldenCompetition === c ? '#fff' : '#9aa0ab', fontSize: 13, fontWeight: 700 }}>{c === 'all' ? '전체' : '경쟁 ' + c}</button>
            ))}
          </div>
          {goldenLoading ? <div style={{ color: '#9aa0ab', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div> : goldenKeywords.length === 0 ? (
            <div style={{ color: '#9aa0ab', fontSize: 14, padding: 20, textAlign: 'center' }}>이 경쟁도에 해당하는 키워드가 없어요.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#171a21', borderRadius: 10, overflow: 'hidden', border: '1px solid #2a2e38' }}>
              <thead><tr><th style={S.th}>순위</th><th style={S.th}>그룹</th><th style={S.th}>키워드</th><th style={{ ...S.th, textAlign: 'right' }}>PC</th><th style={{ ...S.th, textAlign: 'right' }}>모바일</th><th style={{ ...S.th, textAlign: 'right' }}>합계</th><th style={S.th}>경쟁</th><th style={{ ...S.th, textAlign: 'right' }}>문서수</th><th style={{ ...S.th, textAlign: 'center' }}>찜</th></tr></thead>
              <tbody>
                {goldenKeywords.map((item, i) => {
                  const isPicked = picks.some(p => p.keyword === item.keyword && p.tool_id === item.hint)
                  return (
                    <tr key={`${item.hint}-${item.keyword}`} style={{ background: isPicked ? 'rgba(255,193,7,0.06)' : 'transparent' }}>
                      <td style={{ ...S.td, color: '#9aa0ab' }}>{i + 1}</td>
                      <td style={{ ...S.td, fontSize: 12, color: '#9aa0ab' }}>{item.hint}</td>
                      <td style={{ ...S.td, fontWeight: 700 }}>{item.keyword}</td>
                      <td style={S.tdNum}>{fmt(item.pc)}</td>
                      <td style={S.tdNum}>{fmt(item.mobile)}</td>
                      <td style={{ ...S.tdNum, color: '#4CAF50' }}>{fmt(item.total)}</td>
                      <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                      <td style={{ ...S.tdNum, fontSize: 12, color: '#9aa0ab' }}>{item.doc_count != null ? fmt(item.doc_count) : '-'}</td>
                      <td style={{ ...S.td, textAlign: 'center' }}><button onClick={() => handlePick(item.hint, { ...item, picked: isPicked })} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>{isPicked ? '⭐' : '☆'}</button></td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </div>
      )}

      {tab === 'picks' && (
        <div>
          {picksLoading ? <div style={{ color: '#9aa0ab', fontSize: 13, padding: 20 }}>로딩 중...</div> : pendingPicks.length === 0 ? (
            <div style={{ color: '#9aa0ab', fontSize: 14, padding: 20, textAlign: 'center' }}>아직 쓸 차례를 기다리는 찜 키워드가 없어요.<br /><span style={{ fontSize: 12, marginTop: 6, display: 'block' }}>수집 현황 / 전체 순위 / 황금키워드 탭에서 ☆ 버튼으로 찜해두세요!</span></div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#171a21', borderRadius: 10, overflow: 'hidden', border: '1px solid #2a2e38' }}>
              <thead><tr><th style={S.th}>그룹</th><th style={S.th}>키워드</th><th style={{ ...S.th, textAlign: 'right' }}>PC</th><th style={{ ...S.th, textAlign: 'right' }}>모바일</th><th style={{ ...S.th, textAlign: 'right' }}>합계</th><th style={S.th}>경쟁</th><th style={S.th}>메모</th><th style={{ ...S.th, textAlign: 'center' }}>사용 처리</th><th style={{ ...S.th, textAlign: 'center' }}>해제</th></tr></thead>
              <tbody>
                {pendingPicks.map(item => (
                  <tr key={`${item.tool_id}-${item.keyword}`}>
                    <td style={{ ...S.td, fontSize: 12, color: '#9aa0ab' }}>{item.tool_id}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{item.keyword}</td>
                    <td style={S.tdNum}>{fmt(item.pc)}</td>
                    <td style={S.tdNum}>{fmt(item.mobile)}</td>
                    <td style={{ ...S.tdNum, color: '#4CAF50' }}>{fmt(item.total)}</td>
                    <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                    <td style={{ ...S.td, fontSize: 12, maxWidth: 200 }}>{item.memo || '-'}</td>
                    <td style={{ ...S.td, textAlign: 'center' }}><button onClick={() => handleMarkUsed(item)} style={{ background: 'rgba(76,175,80,0.1)', border: '1px solid #4CAF50', color: '#4CAF50', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>✅ 사용함</button></td>
                    <td style={{ ...S.td, textAlign: 'center' }}><button onClick={() => handleUnpick(item.tool_id, item.keyword)} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 16 }}>⭐</button></td>
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
            <div style={{ fontSize: 12, color: '#9aa0ab', lineHeight: 1.7 }}>오늘 Claude가 <code style={{ color: '#4CAF50' }}>naver_keyword_volume</code>으로 실시간 조회한 키워드 목록입니다.</div>
            <button onClick={loadToday} style={{ padding: '5px 14px', borderRadius: 8, border: '1px solid #2a2e38', background: 'none', color: '#9aa0ab', fontSize: 13, cursor: 'pointer' }}>🔄 새로고침</button>
          </div>
          {todayLoading ? <div style={{ color: '#9aa0ab', fontSize: 13, padding: 20, textAlign: 'center' }}>로딩 중...</div> : todayRows.length === 0 ? (
            <div style={{ color: '#9aa0ab', fontSize: 14, padding: 40, textAlign: 'center' }}><div style={{ fontSize: 32, marginBottom: 10 }}>🔴</div>오늘 실시간 조회한 키워드가 없어요.</div>
          ) : (() => {
            const groups = {}
            todayRows.forEach(r => { if (!groups[r.hint]) groups[r.hint] = []; groups[r.hint].push(r) })
            return (
              <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
                {Object.entries(groups).map(([hint, rows]) => (
                  <div key={hint} style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 10, overflow: 'hidden' }}>
                    <div style={{ padding: '12px 18px', borderBottom: '1px solid #2a2e38', display: 'flex', alignItems: 'center', gap: 10 }}>
                      <span style={{ fontSize: 14, fontWeight: 800, color: '#4CAF50' }}>🔍 {hint}</span>
                      <span style={{ fontSize: 12, color: '#9aa0ab' }}>연관 키워드 {rows.length}개</span>
                    </div>
                    <table style={{ width: '100%', borderCollapse: 'collapse' }}>
                      <thead><tr><th style={S.th}>순위</th><th style={S.th}>키워드</th><th style={{ ...S.th, textAlign: 'right' }}>PC</th><th style={{ ...S.th, textAlign: 'right' }}>모바일</th><th style={{ ...S.th, textAlign: 'right' }}>합계</th><th style={S.th}>경쟁</th><th style={{ ...S.th, textAlign: 'center' }}>찜</th></tr></thead>
                      <tbody>
                        {rows.map((item, i) => (
                          <tr key={item.keyword} style={{ background: item.picked ? 'rgba(255,193,7,0.06)' : 'transparent' }}>
                            <td style={{ ...S.td, color: '#9aa0ab' }}>{i + 1}</td>
                            <td style={{ ...S.td, fontWeight: 600 }}>{item.keyword}</td>
                            <td style={S.tdNum}>{fmt(item.pc)}</td>
                            <td style={S.tdNum}>{fmt(item.mobile)}</td>
                            <td style={{ ...S.tdNum, color: '#4CAF50' }}>{fmt(item.total)}</td>
                            <td style={{ ...S.td, fontSize: 12 }}>{item.competition || '-'}</td>
                            <td style={{ ...S.td, textAlign: 'center' }}><button onClick={() => handlePick(item.hint, { ...item, picked: item.picked })} style={{ background: 'none', border: 'none', cursor: 'pointer', fontSize: 18 }}>{item.picked ? '⭐' : '☆'}</button></td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
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
            <button onClick={handleSyncFromPublishLog} style={{ padding: '8px 18px', background: '#4CAF50', color: '#fff', border: 'none', borderRadius: 8, fontSize: 13, fontWeight: 700, cursor: 'pointer' }}>🔄 발행기록으로 업데이트</button>
          </div>
          {picksLoading ? <div style={{ color: '#9aa0ab', fontSize: 13, padding: 20 }}>로딩 중...</div> : usedPicks.length === 0 ? (
            <div style={{ color: '#9aa0ab', fontSize: 14, padding: 20, textAlign: 'center' }}>아직 사용 처리된 키워드가 없어요.</div>
          ) : (
            <table style={{ width: '100%', borderCollapse: 'collapse', background: '#171a21', borderRadius: 10, overflow: 'hidden', border: '1px solid #2a2e38' }}>
              <thead><tr><th style={S.th}>사용일</th><th style={S.th}>그룹</th><th style={S.th}>키워드</th><th style={{ ...S.th, textAlign: 'right' }}>합계</th><th style={S.th}>사용한 글</th><th style={{ ...S.th, textAlign: 'center' }}>되돌리기</th></tr></thead>
              <tbody>
                {usedPicks.map(item => (
                  <tr key={`${item.tool_id}-${item.keyword}`}>
                    <td style={{ ...S.td, fontSize: 12, color: '#9aa0ab' }}>{formatDate(item.used_at)}</td>
                    <td style={{ ...S.td, fontSize: 12, color: '#9aa0ab' }}>{item.tool_id}</td>
                    <td style={{ ...S.td, fontWeight: 700 }}>{item.keyword}</td>
                    <td style={{ ...S.tdNum, color: '#4CAF50' }}>{fmt(item.total)}</td>
                    <td style={{ ...S.td, fontSize: 13 }}>{item.used_in_title || '-'}{item.used_in_slug && <div style={{ fontSize: 11, color: '#9aa0ab' }}>/blog/{item.used_in_slug}</div>}</td>
                    <td style={{ ...S.td, textAlign: 'center' }}><button onClick={() => handleUnmarkUsed(item.tool_id, item.keyword)} style={{ background: 'none', border: '1px solid #2a2e38', color: '#9aa0ab', borderRadius: 6, padding: '3px 10px', fontSize: 12, fontWeight: 700, cursor: 'pointer' }}>↩️ 되돌리기</button></td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {confirmDelete && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9998 }} onClick={() => setConfirmDelete(null)}>
          <div style={{ background: '#171a21', border: '1px solid #2a2e38', borderRadius: 12, padding: 28, width: 320 }} onClick={e => e.stopPropagation()}>
            {confirmDelete.type === 'duplicate' ? (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#e8eaed', marginBottom: 10 }}>⚠️ 이미 있는 키워드</div>
                <div style={{ fontSize: 14, color: '#9aa0ab', marginBottom: 20 }}><b style={{ color: '#4CAF50' }}>"{confirmDelete.hint}"</b>는 이미 수집된 키워드예요.</div>
                <button onClick={() => setConfirmDelete(null)} style={{ width: '100%', background: '#0f1115', color: '#e8eaed', border: 'none', borderRadius: 8, padding: '10px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>확인</button>
              </>
            ) : (
              <>
                <div style={{ fontSize: 16, fontWeight: 800, color: '#e8eaed', marginBottom: 10 }}>🗑 키워드 삭제</div>
                <div style={{ fontSize: 14, color: '#9aa0ab', marginBottom: 20 }}><b style={{ color: '#4CAF50' }}>"{confirmDelete.hint}"</b> 키워드 데이터를 전부 삭제할까요?<span style={{ fontSize: 12, marginTop: 4, display: 'block' }}>삭제 후 복구가 불가능합니다.</span></div>
                <div style={{ display: 'flex', gap: 8 }}>
                  <button onClick={() => setConfirmDelete(null)} style={{ flex: 1, background: '#0f1115', color: '#e8eaed', border: 'none', borderRadius: 8, padding: '10px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>취소</button>
                  <button onClick={async () => { const hint = confirmDelete.hint; setConfirmDelete(null); await handleDeleteHint(hint) }} style={{ flex: 1, background: '#F44336', color: '#fff', border: 'none', borderRadius: 8, padding: '10px', fontSize: 14, fontWeight: 700, cursor: 'pointer' }}>삭제</button>
                </div>
              </>
            )}
          </div>
        </div>
      )}

      {resultModal && (
        <div style={{ position: 'fixed', inset: 0, background: 'rgba(0,0,0,0.7)', display: 'flex', alignItems: 'center', justifyContent: 'center', zIndex: 9999 }} onClick={() => setResultModal(null)}>
          <div style={{ background: '#171a21', border: `2px solid ${resultModal.type === 'error' ? '#F44336' : '#4CAF50'}`, borderRadius: 14, padding: 28, width: 340, maxWidth: '90vw' }} onClick={e => e.stopPropagation()}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
              <span style={{ fontSize: 26 }}>{resultModal.type === 'error' ? '⛔' : '✅'}</span>
              <span style={{ fontSize: 16, fontWeight: 800, color: resultModal.type === 'error' ? '#F44336' : '#4CAF50' }}>{resultModal.type === 'error' ? '오류 발생' : '완료'}</span>
            </div>
            <div style={{ fontSize: 14, color: '#e8eaed', lineHeight: 1.6, marginBottom: 24, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>{resultModal.message}</div>
            <button onClick={() => setResultModal(null)} style={{ width: '100%', background: resultModal.type === 'error' ? '#F44336' : '#4CAF50', color: '#fff', border: 'none', borderRadius: 9, padding: '12px', fontSize: 15, fontWeight: 800, cursor: 'pointer' }}>확인</button>
          </div>
        </div>
      )}
    </div>
  )
}
