import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

function nowKST() {
  return new Date(Date.now() + 9 * 60 * 60 * 1000).toISOString().replace('Z', '+09:00')
}

function auth(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  const isAdmin = auth(req)

  if (req.method === 'GET') {
    const { id, slug, category, limit = 50, offset = 0, q } = req.query
    if (id) {
      let query = supabase.from('blog_posts').select('*').eq('id', id)
      if (!isAdmin) query = query.eq('status', 'published')
      const { data, error } = await query.single()
      if (error || !data) return res.status(404).json({ error: 'Not found' })
      return res.status(200).json(data)
    }
    if (slug) {
      let query = supabase.from('blog_posts').select('*').eq('slug', slug)
      if (!isAdmin) query = query.eq('status', 'published')
      const { data, error } = await query.single()
      if (error || !data) return res.status(404).json({ error: 'Not found' })
      return res.status(200).json(data)
    }
    let query = supabase.from('blog_posts').select('*').order('created_at', { ascending: false })
    if (!isAdmin) query = query.eq('status', 'published')
    if (category) query = query.eq('category', category)
    if (q) {
      const safeQ = String(q).replace(/[(),]/g, ' ').trim()
      if (safeQ) query = query.or(`title.ilike.%${safeQ}%,content.ilike.%${safeQ}%`)
    }
    query = query.range(Number(offset), Number(offset) + Number(limit) - 1)
    const { data, error } = await query
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data || [])
  }

  if (!isAdmin) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'POST') {
    const { title, slug, content, category, summary, status = 'published' } = req.body
    if (!title || !slug || !content) return res.status(400).json({ error: '필수 항목 누락' })
    const { data, error } = await supabase.from('blog_posts').insert([{
      id: randomUUID(), title, slug, content,
      category: category || '', summary: summary || '',
      status,
      published_at: status === 'published' ? nowKST() : null,
      created_at: nowKST(),
    }]).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'PUT') {
    const { id, ...updates } = req.body
    if (!id) return res.status(400).json({ error: 'id 필요' })
    if (updates.status === 'published' && !updates.published_at) updates.published_at = nowKST()
    const { data, error } = await supabase.from('blog_posts').update(updates).eq('id', id).select().single()
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(data)
  }

  if (req.method === 'DELETE') {
    const { id } = req.query
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('blog_posts').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).end()
}
