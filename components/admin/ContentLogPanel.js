import { useState, useEffect, useCallback } from 'react'
import { S, Toast } from './AdminUI'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

export default function ContentLogPanel({ adminToken }) {
  const [logs, setLogs] = useState([])
  const [loading, setLoading] = useState(true)
  const [categories, setCategories] = useState([])
  const [filterCat, setFilterCat] = useState('all')
  const [toast, setToast] = useState('')
  const [promptText, setPromptText] = useState('')
  const [promptOpen, setPromptOpen] = useState(false)
  const [form, setForm] = useState({ category: '', angle: '', title: '', slug: '', memo: '', targetKeyword: '', searchPc: '', searchMobile: '', searchTotal: '', competition: '', publishedAt: nowKST().slice(0, 10) })
  const [saving, setSaving] = useState(false)
  const [pasteText, setPasteText] = useState('')
  const [parseMsg, setParseMsg] = useState('')

  const showToast = (msg) => { setToast(msg); setTimeout(() => setToast(''), 2200) }

  const buildClaudePrompt = () => {
    const lines = []
    lines.push('아래는 트레이더 블로그 발행 기록입니다. 이 기록을 기준으로 중복 없이 오늘 블로그 글 1편을 써줘.')
    lines.push('')
    if (!logs.length) {
      lines.push('발행 기록: 없음 (처음 시작)')
    } else {
      lines.push(`발행 기록 (${logs.length}건, 최신순):`)
      logs.forEach(l => {
        let line = `- 카테고리: ${l.category || '-'} / 각도: ${l.angle} / 제목: ${l.title} / 슬러그: ${l.slug}${l.published_at ? ' / 발행일: ' + l.published_at : ''}`
        if (l.target_keyword) {
          line += ` / 타겟키워드: ${l.target_keyword}`
          if (l.search_total) line += ` (검색수 ${Number(l.search_total).toLocaleString()}${l.competition ? ' / 경쟁도 ' + l.competition : ''})`
        }
        lines.push(line)
      })
    }
    lines.push('')
    lines.push('위 기록에서 이미 다룬 각도와 겹치지 않는 새로운 각도로 글감을 정해줘.')
    return lines.join('\n')
  }

  const parsePastedLog = (text) => {
    const lines = text.split('\n').map(l => l.trim()).filter(Boolean)
    const picked = { category: '', angle: '', title: '', slug: '', memo: '', targetKeyword: '', searchPc: '', searchMobile: '', searchTotal: '', competition: '', publishedAt: '' }
    const patterns = {
      category: /^(카테고리|category)[:：]\s*(.+)$/i,
      angle: /^(키워드\s*각도|각도|angle)[:：]\s*(.+)$/i,
      title: /^(제목|title)[:：]\s*(.+)$/i,
      slug: /^(슬러그|slug)[:：]\s*(.+)$/i,
      memo: /^(메모|비고|memo)[:：]\s*(.+)$/i,
      targetKeyword: /^(타겟\s*키워드|타겟키워드|target.?keyword)[:：]\s*(.+)$/i,
      searchPc: /^(PC\s*검색수|search.?pc)[:：]\s*(.+)$/i,
      searchMobile: /^(모바일\s*검색수|search.?mobile)[:：]\s*(.+)$/i,
      searchTotal: /^(검색수\s*합계|합계|search.?total)[:：]\s*(.+)$/i,
      competition: /^(경쟁도|competition)[:：]\s*(.+)$/i,
      publishedAt: /^(발행일|date)[:：]\s*(.+)$/i,
    }
    lines.forEach(line => {
      for (const key of Object.keys(patterns)) {
        const m = line.match(patterns[key])
        if (m) picked[key] = m[2].trim()
      }
    })
    return picked
  }

  const handlePasteParse = (text) => {
    setPasteText(text)
    if (!text.trim()) { setParseMsg(''); return }
    const picked = parsePastedLog(text)
    const found = Object.entries(picked).filter(([, v]) => v)
    if (!found.length) { setParseMsg('⚠️ 인식된 항목이 없습니다.'); return }
    setForm(f => ({
      category: picked.category || f.category,
      angle: picked.angle || f.angle,
      title: picked.title || f.title,
      slug: picked.slug || f.slug,
      memo: picked.memo || f.memo,
      targetKeyword: picked.targetKeyword || f.targetKeyword,
      searchPc: picked.searchPc || f.searchPc,
      searchMobile: picked.searchMobile || f.searchMobile,
      searchTotal: picked.searchTotal || f.searchTotal,
      competition: picked.competition || f.competition,
      publishedAt: picked.publishedAt || f.publishedAt,
    }))
    const labels = { category: '카테고리', angle: '각도', title: '제목', slug: '슬러그', memo: '메모', targetKeyword: '타겟키워드', searchPc: 'PC검색수', searchMobile: '모바일검색수', searchTotal: '합계검색수', competition: '경쟁도', publishedAt: '발행일' }
    setParseMsg(`✅ ${found.map(([k]) => labels[k]).join(', ')} 자동 입력됨 — 확인 후 "기록 추가" 눌러주세요`)
  }

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const res = await fetch('/api/admin/content-log', { headers: { 'x-admin-token': adminToken } })
      const data = await res.json()
      setLogs(Array.isArray(data) ? data : [])
    } catch { showToast('❌ 불러오기 실패') }
    setLoading(false)
  }, [adminToken])

  const loadCategories = useCallback(async () => {
    try {
      const res = await fetch('/api/blog/categories')
      const data = await res.json()
      setCategories(Array.isArray(data) ? data : [])
    } catch {}
  }, [])

  useEffect(() => { load(); loadCategories() }, [load, loadCategories])

  const addLog = async () => {
    if (!form.angle.trim() || !form.title.trim() || !form.slug.trim()) {
      showToast('⚠️ 각도·제목·슬러그는 필수입니다'); return
    }
    setSaving(true)
    try {
      const res = await fetch('/api/admin/content-log', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-admin-token': adminToken },
        body: JSON.stringify(form),
      })
      if (!res.ok) throw new Error()
      setForm(f => ({ ...f, angle: '', title: '', slug: '', memo: '', targetKeyword: '', searchPc: '', searchMobile: '', searchTotal: '', competition: '', publishedAt: nowKST().slice(0, 10) }))
      setPasteText(''); setParseMsg('')
      showToast('✅ 기록 추가됨'); load()
    } catch { showToast('❌ 저장 실패') }
    setSaving(false)
  }

  const deleteLog = async (id) => {
    if (!confirm('이 기록을 삭제할까요?')) return
    try {
      await fetch(`/api/admin/content-log?id=${id}`, { method: 'DELETE', headers: { 'x-admin-token': adminToken } })
      showToast('🗑 삭제됨'); load()
    } catch { showToast('❌ 삭제 실패') }
  }

  const filtered = filterCat === 'all' ? logs : logs.filter(l => l.category === filterCat)

  return (
    <div>
      <Toast msg={toast} />
      <div style={S.card}>
        <div style={S.cardTitle}>📋 발행 기록 (관리자 전용)</div>
        <p style={{ color: '#9aa0ab', fontSize: 13, lineHeight: 1.7, marginBottom: 18 }}>
          Claude가 글을 작성할 때마다 어떤 카테고리를, 어떤 각도로 다뤘는지 기록합니다.
          아래 붙여넣기 칸에 Claude가 준 발행 기록을 붙여넣으면 자동으로 입력됩니다.
        </p>

        <div style={{ marginBottom: 18 }}>
          <label style={S.label}>📋 Claude가 준 발행 기록을 여기에 붙여넣으세요</label>
          <textarea value={pasteText} onChange={e => handlePasteParse(e.target.value)}
            placeholder={'카테고리: 전략\n각도: 지표 소개\n제목: HMA 크로스 전략으로 진입 타이밍 잡는 법\n슬러그: hma-cross-entry-timing\n발행일: 2026-07-12'}
            rows={5} style={{ ...S.input, marginBottom: 6, resize: 'vertical' }} />
          {parseMsg && <div style={{ fontSize: 12, color: parseMsg.startsWith('✅') ? '#4CAF50' : '#FFC107' }}>{parseMsg}</div>}
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 12, marginBottom: 12 }}>
          <div>
            <label style={S.label}>카테고리</label>
            <input value={form.category} onChange={e => setForm(f => ({ ...f, category: e.target.value }))} placeholder="예: 전략" style={S.input} list="content-log-categories" />
            <datalist id="content-log-categories">
              {categories.map(c => <option key={c.id} value={c.label} />)}
            </datalist>
          </div>
          <div>
            <label style={S.label}>키워드 각도</label>
            <input value={form.angle} onChange={e => setForm(f => ({ ...f, angle: e.target.value }))} placeholder="예: 지표 소개" style={S.input} />
          </div>
          <div>
            <label style={S.label}>제목</label>
            <input value={form.title} onChange={e => setForm(f => ({ ...f, title: e.target.value }))} placeholder="글 제목" style={S.input} />
          </div>
          <div>
            <label style={S.label}>슬러그</label>
            <input value={form.slug} onChange={e => setForm(f => ({ ...f, slug: e.target.value }))} placeholder="hma-cross-entry-timing" style={S.input} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>타겟 키워드 (선택)</label>
            <input value={form.targetKeyword} onChange={e => setForm(f => ({ ...f, targetKeyword: e.target.value }))} placeholder="예: HMA 크로스 전략" style={S.input} />
          </div>
          <div>
            <label style={S.label}>PC 검색수</label>
            <input type="number" value={form.searchPc} onChange={e => setForm(f => ({ ...f, searchPc: e.target.value }))} placeholder="0" style={S.input} />
          </div>
          <div>
            <label style={S.label}>모바일 검색수</label>
            <input type="number" value={form.searchMobile} onChange={e => setForm(f => ({ ...f, searchMobile: e.target.value }))} placeholder="0" style={S.input} />
          </div>
          <div>
            <label style={S.label}>합계 검색수</label>
            <input type="number" value={form.searchTotal} onChange={e => setForm(f => ({ ...f, searchTotal: e.target.value }))} placeholder="0" style={S.input} />
          </div>
          <div>
            <label style={S.label}>경쟁도</label>
            <select value={form.competition} onChange={e => setForm(f => ({ ...f, competition: e.target.value }))} style={S.input}>
              <option value="">-</option>
              <option value="낮음">낮음</option>
              <option value="중간">중간</option>
              <option value="높음">높음</option>
            </select>
          </div>
          <div>
            <label style={S.label}>발행일</label>
            <input type="date" value={form.publishedAt} onChange={e => setForm(f => ({ ...f, publishedAt: e.target.value }))} style={S.input} />
          </div>
          <div style={{ gridColumn: '1 / -1' }}>
            <label style={S.label}>메모 (선택)</label>
            <input value={form.memo} onChange={e => setForm(f => ({ ...f, memo: e.target.value }))} placeholder="비고" style={S.input} />
          </div>
        </div>
        <button onClick={addLog} disabled={saving} style={{ ...S.btn(), opacity: saving ? 0.6 : 1 }}>
          {saving ? '저장 중...' : '+ 기록 추가'}
        </button>
      </div>

      <div style={S.card}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16, flexWrap: 'wrap', gap: 10 }}>
          <div style={{ ...S.cardTitle, marginBottom: 0 }}>📜 기록 목록 ({filtered.length})</div>
          <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
            <button onClick={() => { setPromptText(buildClaudePrompt()); setPromptOpen(true) }} style={S.btn()}>🤖 클로드에게 부탁하기</button>
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
              {[['all', '전체'], ...categories.map(c => [c.label, c.label])].map(([key, label]) => (
                <button key={key} onClick={() => setFilterCat(key)} style={{
                  padding: '6px 12px', borderRadius: 8, fontSize: 12, fontWeight: filterCat === key ? 700 : 500,
                  border: `1.5px solid ${filterCat === key ? '#4CAF50' : '#2a2e38'}`,
                  background: filterCat === key ? 'rgba(76,175,80,0.1)' : 'transparent',
                  color: filterCat === key ? '#4CAF50' : '#9aa0ab', cursor: 'pointer',
                }}>{label}</button>
              ))}
            </div>
          </div>
        </div>

        {promptOpen && (
          <div style={{ background: 'rgba(76,175,80,0.08)', border: '1px solid #4CAF50', borderRadius: 10, padding: 16, marginBottom: 18 }}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 }}>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#4CAF50' }}>💬 아래 내용을 복사해서 Claude 채팅창에 붙여넣으세요</div>
              <button onClick={() => setPromptOpen(false)} style={{ background: 'none', border: 'none', color: '#9aa0ab', cursor: 'pointer', fontSize: 14 }}>✕</button>
            </div>
            <textarea readOnly value={promptText}
              rows={Math.min(Math.max(promptText.split('\n').length + 1, 6), 16)}
              style={{ ...S.input, marginBottom: 10, fontSize: 12, resize: 'vertical' }}
              onFocus={e => e.target.select()} />
            <button onClick={() => {
              navigator.clipboard?.writeText(promptText).catch(() => {})
              showToast('✅ 복사됨')
            }} style={S.btn()}>📋 복사하기</button>
          </div>
        )}

        {loading ? (
          <div style={{ textAlign: 'center', padding: 40, color: '#9aa0ab' }}>불러오는 중...</div>
        ) : !filtered.length ? (
          <div style={{ textAlign: 'center', padding: '50px 20px', background: '#0f1115', borderRadius: 12, border: '1px solid #2a2e38', color: '#9aa0ab' }}>
            <div style={{ fontSize: 36, marginBottom: 10 }}>📭</div>
            <div style={{ fontSize: 14, fontWeight: 600 }}>아직 기록이 없습니다</div>
          </div>
        ) : (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {filtered.map(log => (
              <div key={log.id} style={{ ...S.row, display: 'flex', alignItems: 'center', gap: 14, flexWrap: 'wrap' }}>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4, flexWrap: 'wrap' }}>
                    {log.category && (
                      <span style={{ fontSize: 11, fontWeight: 700, color: '#4CAF50', background: 'rgba(76,175,80,0.1)', borderRadius: 4, padding: '2px 8px', border: '1px solid #4CAF5044' }}>{log.category}</span>
                    )}
                    <span style={{ fontSize: 11, color: '#4CAF50' }}>{log.angle}</span>
                  </div>
                  <div style={{ fontSize: 14, fontWeight: 700, color: '#e8eaed', marginBottom: 2 }}>{log.title}</div>
                  <div style={{ fontSize: 12, color: '#9aa0ab' }}>
                    /blog/{log.slug}
                    {log.published_at && <span style={{ marginLeft: 8 }}>· {log.published_at}</span>}
                    {log.memo && <span style={{ marginLeft: 8, opacity: 0.7 }}>· {log.memo}</span>}
                  </div>
                  {log.target_keyword && (
                    <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#8c9eff', background: 'rgba(63,81,181,0.1)', borderRadius: 4, padding: '2px 8px', border: '1px solid #3F51B544', fontWeight: 700 }}>
                        🔑 {log.target_keyword}
                      </span>
                      {log.search_total != null && (
                        <span style={{ fontSize: 11, color: '#9aa0ab' }}>
                          검색수 <strong style={{ color: '#e8eaed' }}>{Number(log.search_total).toLocaleString()}</strong>
                          {log.search_pc != null && <span> (PC {Number(log.search_pc).toLocaleString()} / 모바일 {Number(log.search_mobile).toLocaleString()})</span>}
                        </span>
                      )}
                      {log.competition && (
                        <span style={{
                          fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4,
                          background: log.competition === '낮음' ? 'rgba(76,175,80,0.1)' : log.competition === '중간' ? 'rgba(255,193,7,0.1)' : 'rgba(244,67,54,0.1)',
                          color: log.competition === '낮음' ? '#4CAF50' : log.competition === '중간' ? '#FFC107' : '#F44336',
                        }}>경쟁도 {log.competition}</span>
                      )}
                    </div>
                  )}
                  {(log.google_indexing || log.index_now) && (
                    <div style={{ marginTop: 5, display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
                      <span style={{ fontSize: 11, color: '#9aa0ab' }}>색인:</span>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: log.google_indexing === 'success' ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)', color: log.google_indexing === 'success' ? '#4CAF50' : '#F44336' }}>
                        {log.google_indexing === 'success' ? '✅ Google' : log.google_indexing ? '❌ Google' : '⏳ Google'}
                      </span>
                      <span style={{ fontSize: 11, fontWeight: 700, padding: '2px 8px', borderRadius: 4, background: log.index_now && log.index_now.startsWith('success') ? 'rgba(76,175,80,0.1)' : 'rgba(244,67,54,0.1)', color: log.index_now && log.index_now.startsWith('success') ? '#4CAF50' : '#F44336' }}>
                        {log.index_now && log.index_now.startsWith('success') ? '✅ IndexNow' : log.index_now ? '❌ IndexNow' : '⏳ IndexNow'}
                      </span>
                    </div>
                  )}
                </div>
                <button onClick={() => deleteLog(log.id)} style={{ ...S.btnGhost, borderColor: '#F44336', color: '#F44336' }}>삭제</button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
