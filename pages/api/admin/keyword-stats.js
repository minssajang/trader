import { supabase } from '../../../lib/supabase'

function todayKSTStart() {
  const kst = new Date(Date.now() + 9 * 60 * 60 * 1000)
  const yyyy = kst.getUTCFullYear(), mm = kst.getUTCMonth(), dd = kst.getUTCDate()
  return new Date(Date.UTC(yyyy, mm, dd, 0, 0, 0) - 9 * 60 * 60 * 1000).toISOString()
}

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()
  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

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

      const rows = (data || []).map(r => ({ ...r, picked: pickedSet.has(`${r.hint}:${r.keyword}`) }))
      return res.status(200).json(rows)
    } catch (err) {
      return res.status(500).json({ error: err.message })
    }
  }

  // hint별 요약 (개수 · 최근 수집일 · 미수집 문서수) — DB 함수 없이 JS에서 직접 집계
  try {
    const { data, error } = await supabase.from('keyword_stats').select('hint, created_at, doc_count')
    if (error) throw new Error(error.message)
    const map = {}
    for (const r of data || []) {
      if (!map[r.hint]) map[r.hint] = { hint: r.hint, count: 0, collected_at: r.created_at, null_doc_count: 0 }
      map[r.hint].count++
      if (r.doc_count == null) map[r.hint].null_doc_count++
      if (new Date(r.created_at) > new Date(map[r.hint].collected_at)) map[r.hint].collected_at = r.created_at
    }
    return res.status(200).json(Object.values(map))
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
