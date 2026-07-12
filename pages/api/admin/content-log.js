import { supabase } from '../../../lib/supabase'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}
function genId() { return Date.now().toString(36) + Math.random().toString(36).slice(2) }

export default async function handler(req, res) {
  const isAdmin = req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
  if (!isAdmin) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'GET') {
    const { category, limit = 200, offset = 0 } = req.query
    let q = supabase.from('publish_log').select('*').order('created_at', { ascending: false })
    if (category) q = q.eq('category', category)
    q = q.range(Number(offset), Number(offset) + Number(limit) - 1)
    const { data, error } = await q
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  if (req.method === 'POST') {
    const { category, angle, title, slug, memo, targetKeyword, searchPc, searchMobile, searchTotal, competition, publishedAt } = req.body
    if (!angle || !title || !slug) return res.status(400).json({ error: 'angle, title, slug는 필수입니다' })
    const row = {
      id: genId(), category: category || null, angle, title, slug,
      memo: memo || null,
      target_keyword: targetKeyword || null,
      search_pc: searchPc != null && searchPc !== '' ? Number(searchPc) : null,
      search_mobile: searchMobile != null && searchMobile !== '' ? Number(searchMobile) : null,
      search_total: searchTotal != null && searchTotal !== '' ? Number(searchTotal) : null,
      competition: competition || null,
      published_at: publishedAt || nowKST(),
      created_at: nowKST(),
    }
    const { data, error } = await supabase.from('publish_log').insert([row]).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('publish_log').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
