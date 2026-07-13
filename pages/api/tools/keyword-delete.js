/**
 * /api/tools/keyword-delete
 * hint(그룹) 전체 삭제
 * DELETE /api/tools/keyword-delete?hint=자동매매
 */
import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  if (req.method !== 'DELETE') return res.status(405).end()

  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) return res.status(401).json({ error: '인증 필요' })

  const { hint } = req.query
  if (!hint) return res.status(400).json({ error: 'hint 필요' })

  const { error } = await supabase
    .from('keyword_stats')
    .delete()
    .eq('hint', hint)

  if (error) return res.status(500).json({ error: error.message })
  return res.status(200).json({ ok: true })
}
