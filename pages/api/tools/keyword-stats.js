import { supabase } from '../../../lib/supabase'

/** KST 기준 오늘 자정(00:00:00) ISO 문자열 반환 */
function todayKSTStart() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const yyyy = kst.getUTCFullYear(), mm = kst.getUTCMonth(), dd = kst.getUTCDate()
  return new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0) - 9 * 60 * 60 * 1000).toISOString()
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

  // ?mode=today → 오늘 실시간 조회 기록 반환
  if (req.query.mode === 'today') {
    try {
      const todayStart = todayKSTStart()
      const { data, error } = await supabase
        .from('keyword_stats')
        .select('hint, keyword, pc, mobile, total, competition, doc_count, created_at')
        .gte('created_at', todayStart)
        .order('created_at', { ascending: false })
      if (error) throw new Error(error.message)

      const { data: picks } = await supabase.from('keyword_picks').select('tool_id, keyword')
      const pickedSet = new Set((picks || []).map(p => `${p.tool_id}:${p.keyword}`))

      const rows = (data || []).map(r => ({
        ...r,
        picked: pickedSet.has(`${r.hint}:${r.keyword}`),
      }))
      return res.status(200).json(rows)
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // 그룹(hint)별 요약 — Postgres 함수 없이 직접 집계 (count / collected_at / null_doc_count / doc_count_filled)
  try {
    const { data, error } = await supabase
      .from('keyword_stats')
      .select('hint, created_at, doc_count')
    if (error) throw new Error(error.message)

    const grouped = {}
    ;(data || []).forEach(r => {
      if (!grouped[r.hint]) {
        grouped[r.hint] = { hint: r.hint, count: 0, collected_at: r.created_at, null_doc_count: 0, doc_count_filled: 0 }
      }
      const g = grouped[r.hint]
      g.count += 1
      if (r.doc_count == null) g.null_doc_count += 1
      else g.doc_count_filled += 1
      if (new Date(r.created_at) > new Date(g.collected_at)) g.collected_at = r.created_at
    })
    const rows = Object.values(grouped).sort((a, b) => new Date(b.collected_at) - new Date(a.collected_at))
    return res.status(200).json(rows)
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
