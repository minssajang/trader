import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

// 쿠팡상품 탭(카테고리) 목록 — 각 항목: { id, label, concept }
// concept: 이 탭에 어떤 상품을 등록할지 적어두는 설명 메모.
// 상품(coupang_products)은 category_id로 이 탭 중 하나를 참조한다.

function isAdmin(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { data, error } = await supabase
        .from('coupang_product_categories')
        .select('*')
        .order('created_at', { ascending: true })
      if (error) throw error
      return res.status(200).json(data || [])
    } catch {
      return res.status(200).json([])
    }
  }

  if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })

  if (req.method === 'POST') {
    const { label, concept } = req.body || {}
    if (!label) return res.status(400).json({ error: '탭 이름 필요' })

    const row = { id: randomUUID(), label, concept: concept ?? '', created_at: new Date().toISOString() }
    const { error } = await supabase.from('coupang_product_categories').insert(row)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json(row)
  }

  if (req.method === 'PUT') {
    const { id, label, concept } = req.body || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })

    const row = {}
    if (label !== undefined) row.label = label
    if (concept !== undefined) row.concept = concept

    const { error } = await supabase.from('coupang_product_categories').update(row).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    const { id } = req.query || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('coupang_product_categories').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
