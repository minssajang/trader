/**
 * /api/admin/keyword-top
 * hint(그룹)별 keyword_stats TOP 키워드 조회
 * GET /api/admin/keyword-top?hint=매매전략&limit=30
 */
import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()
  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

  const { hint, limit = '30' } = req.query
  if (!hint) return res.status(400).json({ error: 'hint 필요' })

  try {
    const { data: topData, error: topError } = await supabase
      .from('keyword_stats')
      .select('keyword, pc, mobile, total, competition, doc_count')
      .eq('hint', hint)
      .order('total', { ascending: false })
      .limit(Number(limit))
    if (topError) throw new Error(topError.message)

    const { data: picksData } = await supabase.from('keyword_picks').select('keyword').eq('tool_id', hint)
    const pickedSet = new Set((picksData || []).map(p => p.keyword))

    const results = (topData || []).map(item => ({ ...item, picked: pickedSet.has(item.keyword) }))
    return res.status(200).json({ results })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
