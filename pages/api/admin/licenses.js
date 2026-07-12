import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

function auth(req) {
  const token = req.headers['x-admin-token']
  return token && token === process.env.ADMIN_SECRET_TOKEN
}

function addMonths(dateStr, months) {
  const d = dateStr ? new Date(dateStr) : new Date()
  d.setMonth(d.getMonth() + months)
  return d.toISOString().slice(0, 10)
}

function genLicenseKey() {
  return randomUUID().replace(/-/g, '').slice(0, 20).toUpperCase().replace(/(.{5})/g, '$1-').replace(/-$/, '')
}

export default async function handler(req, res) {
  if (!auth(req)) return res.status(401).json({ error: '인증 필요' })

  if (req.method === 'GET') {
    const { data, error } = await supabase
      .from('licenses')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ rows: data || [] })
  }

  if (req.method === 'PATCH') {
    const { action, id } = req.body
    if (!id) return res.status(400).json({ error: 'id 필수' })

    if (action === 'issue') {
      const { data: row, error: fetchErr } = await supabase
        .from('licenses').select('requested_months').eq('id', id).single()
      if (fetchErr) return res.status(500).json({ error: fetchErr.message })
      const months = row?.requested_months || 1
      const start = new Date().toISOString().slice(0, 10)
      const update = {
        status: 'active',
        license_key: genLicenseKey(),
        start_date: start,
        expire_date: addMonths(start, months),
      }
      const { data, error } = await supabase.from('licenses').update(update).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, row: data })
    }

    if (action === 'extend') {
      const { months } = req.body
      const { data: row, error: fetchErr } = await supabase
        .from('licenses').select('expire_date').eq('id', id).single()
      if (fetchErr) return res.status(500).json({ error: fetchErr.message })
      const base = row?.expire_date && new Date(row.expire_date) > new Date() ? row.expire_date : new Date().toISOString().slice(0, 10)
      const update = { status: 'active', expire_date: addMonths(base, months || 1) }
      const { data, error } = await supabase.from('licenses').update(update).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, row: data })
    }

    if (action === 'set_status') {
      const { status } = req.body
      if (!['pending', 'active', 'expired', 'cancelled'].includes(status)) {
        return res.status(400).json({ error: '알 수 없는 status' })
      }
      const { data, error } = await supabase.from('licenses').update({ status }).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, row: data })
    }

    if (action === 'update_note') {
      const { note } = req.body
      const { data, error } = await supabase.from('licenses').update({ note }).eq('id', id).select().single()
      if (error) return res.status(500).json({ error: error.message })
      return res.json({ ok: true, row: data })
    }

    return res.status(400).json({ error: '알 수 없는 action' })
  }

  if (req.method === 'DELETE') {
    const { id } = req.body
    if (!id) return res.status(400).json({ error: 'id 필수' })
    const { error } = await supabase.from('licenses').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
