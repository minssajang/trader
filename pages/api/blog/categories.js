import { supabase } from '../../../lib/supabase'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

function slugify(label) {
  const r = label.trim().toLowerCase()
  const eng = r.match(/[a-z0-9]+/g)
  if (eng && eng.join('').length >= 2) return eng.join('-')
  return 'cat-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6)
}

export default async function handler(req, res) {
  const isAdmin = req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN

  if (req.method === 'GET') {
    const { data } = await supabase.from('blog_categories').select('*').order('label')
    return res.status(200).json(data || [])
  }

  if (!isAdmin) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'POST') {
    const { label, icon } = req.body
    if (!label) return res.status(400).json({ error: '카테고리명 필요' })
    const { data, error } = await supabase.from('blog_categories').insert([{
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      label, slug: slugify(label), icon: icon || '📁',
      created_at: nowKST(),
    }]).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id 필요' })
    await supabase.from('blog_categories').delete().eq('id', id)
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
