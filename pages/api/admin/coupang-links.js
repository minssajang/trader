import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

// 쿠팡 "링크 목록" — 링크(URL)만 다룬다. 위젯은 coupang-widgets.js에서 별도 관리.
// 각 항목: { id, label, url, enabled }

function isAdmin(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('coupang_links')
        .select('*')
        .order('created_at', { ascending: true })
      if (error) throw error
      return res.status(200).json(data || [])
    } catch {
      return res.status(200).json([])
    }
  }

  if (req.method === 'POST') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { label, url, enabled } = req.body || {}

    const now = new Date().toISOString()
    const row = {
      id: randomUUID(),
      label: label ?? '',
      url: url ?? '',
      enabled: enabled === undefined ? true : !!enabled,
      created_at: now,
      updated_at: now,
    }

    const { error } = await supabase.from('coupang_links').insert(row)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(row)
  }

  if (req.method === 'PUT') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { id, ...rest } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })

    const row = {
      label: rest.label ?? '',
      url: rest.url ?? '',
      enabled: rest.enabled === undefined ? true : !!rest.enabled,
      updated_at: new Date().toISOString(),
    }

    const { error } = await supabase.from('coupang_links').update(row).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { id } = req.query || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('coupang_links').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
