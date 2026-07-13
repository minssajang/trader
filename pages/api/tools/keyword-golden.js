/**
 * /api/tools/keyword-golden
 * "황금키워드" 목록 — 검색량은 높고 경쟁은 낮은 키워드를 그룹 구분 없이 전체에서 찾는다.
 *
 * GET /api/tools/keyword-golden?competition=낮음&limit=100
 */

import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).end()

  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

  const { competition = '낮음', limit = '100' } = req.query

  try {
    let q = supabase
      .from('keyword_stats')
      .select('hint, keyword, pc, mobile, total, competition, doc_count')
      .order('total', { ascending: false })
      .limit(Number(limit))

    if (competition !== 'all') q = q.eq('competition', competition)

    const { data, error } = await q
    if (error) throw new Error(error.message)

    return res.status(200).json({ results: data || [] })
  } catch (err) {
    return res.status(500).json({ error: err.message })
  }
}
