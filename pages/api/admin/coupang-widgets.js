import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

// 쿠팡 "배너/위젯 목록" — 배너/위젯(HTML) 코드만 다룬다. 링크는 coupang-links.js에서 별도 관리.
// 각 항목: { id, label, size, widget_html, enabled }

function isAdmin(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('coupang_widgets')
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
    const { label, size, widget_html, enabled } = req.body || {}

    const now = new Date().toISOString()
    const row = {
      id: randomUUID(),
      label: label ?? '',
      size: size ?? '',
      widget_html: widget_html ?? '',
      enabled: enabled === undefined ? true : !!enabled,
      created_at: now,
      updated_at: now,
    }

    const { error } = await supabase.from('coupang_widgets').insert(row)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(row)
  }

  if (req.method === 'PUT') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { id, ...rest } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })

    const row = {
      label: rest.label ?? '',
      size: rest.size ?? '',
      widget_html: rest.widget_html ?? '',
      enabled: rest.enabled === undefined ? true : !!rest.enabled,
      updated_at: new Date().toISOString(),
    }

    const { error } = await supabase.from('coupang_widgets').update(row).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { id } = req.query || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('coupang_widgets').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
