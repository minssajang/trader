import { supabase } from '../../../lib/supabase'

function auth(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'GET') {
    const { data, error } = await supabase.from('popups').select('*').order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ popups: data || [] })
  }

  if (req.method === 'POST') {
    const { title, content, link_url, link_label, bg_color, text_color, expires_at, is_active } = req.body
    if (!title || !content) return res.status(400).json({ error: 'title, content 필수' })
    const row = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2),
      title, content,
      link_url: link_url || null,
      link_label: link_label || '자세히 보기',
      bg_color: bg_color || '#ffffff',
      text_color: text_color || '#111827',
      expires_at: expires_at || null,
      is_active: is_active !== false,
      created_at: nowKST(),
    }
    const { error } = await supabase.from('popups').insert([row])
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true, id: row.id })
  }

  if (req.method === 'PATCH') {
    const { action, id, is_active } = req.body
    if (action === 'toggle') {
      const { error } = await supabase.from('popups').update({ is_active, updated_at: nowKST() }).eq('id', id)
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true })
    }
    return res.status(400).json({ error: '알 수 없는 action' })
  }

  if (req.method === 'DELETE') {
    const { id } = req.body
    if (!id) return res.status(400).json({ error: 'id 필수' })
    const { error } = await supabase.from('popups').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
