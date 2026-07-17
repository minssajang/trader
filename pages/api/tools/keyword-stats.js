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

  // 그룹(hint)별 요약 — DB의 keyword_stats_summary() 함수로 집계한다.
  // (예전엔 keyword_stats 전체 행을 select해서 JS로 그룹핑했는데, Supabase 기본 응답
  //  상한이 1,000행이라 테이블이 1,000행을 넘어가면 뒤쪽 그룹이 누락됐다. sql/009_keyword_stats_summary.sql 참고.)
  try {
    const { data, error } = await supabase.rpc('keyword_stats_summary')
    if (error) throw new Error(error.message)
    return res.status(200).json(data || [])
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
