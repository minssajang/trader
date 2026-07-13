import { supabase } from '../../../lib/supabase'

export default async function handler(req, res) {
  const token = req.headers['x-admin-token']
  if (token !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 필요' })
  }

  if (req.method === 'GET') {
    const { tool_id, status } = req.query
    let q = supabase.from('feature_ideas').select('*').order('created_at', { ascending: false })
    if (tool_id) q = q.eq('tool_id', tool_id)
    if (status) q = q.eq('status', status)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  if (req.method === 'PATCH') {
    const { id, status } = req.body
    if (!id || !status) return res.status(400).json({ error: 'id, status 필요' })
    const valid = ['proposed', 'building', 'done', 'rejected']
    if (!valid.includes(status)) return res.status(400).json({ error: '유효하지 않은 status' })
    const { data, error } = await supabase
      .from('feature_ideas').update({ status }).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('feature_ideas').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
