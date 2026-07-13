import { supabase } from '../../../lib/supabase'
import { randomUUID } from 'crypto'

// 쿠팡 "상품 목록" — 블로그 등에 수동으로 붙여넣어 쓰는 상품(이름/링크/일반태그/블로그용태그/탭).
// 광고 슬롯(AdSlot) 자동노출용 coupang_widgets/coupang_links와는 별개의 등록 전용 목록.
// 각 항목: { id, label, url, banner_html, banner_html_blog, category_id, enabled }
// 탭(카테고리)은 coupang_product_categories 테이블에서 별도 관리 (coupang-product-categories.js).

function isAdmin(req) {
  return req.headers['x-admin-token'] === process.env.ADMIN_SECRET_TOKEN
}

export default async function handler(req, res) {
  if (req.method === 'GET') {
    try {
      const { category_id } = req.query || {}
      let query = supabase.from('coupang_products').select('*').order('created_at', { ascending: true })
      if (category_id) query = query.eq('category_id', category_id)
      const { data, error } = await query
      if (error) throw error
      return res.status(200).json(data || [])
    } catch {
      return res.status(200).json([])
    }
  }

  if (req.method === 'POST') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { label, url, banner_html, banner_html_blog, category_id, enabled } = req.body || {}

    const now = new Date().toISOString()
    const row = {
      id: randomUUID(),
      label: label ?? '',
      url: url ?? '',
      banner_html: banner_html ?? '',
      banner_html_blog: banner_html_blog ?? '',
      category_id: category_id || null,
      enabled: enabled === undefined ? true : !!enabled,
      created_at: now,
      updated_at: now,
    }

    const { error } = await supabase.from('coupang_products').insert(row)
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
      banner_html: rest.banner_html ?? '',
      banner_html_blog: rest.banner_html_blog ?? '',
      category_id: rest.category_id || null,
      enabled: rest.enabled === undefined ? true : !!rest.enabled,
      updated_at: new Date().toISOString(),
    }

    const { error } = await supabase.from('coupang_products').update(row).eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  if (req.method === 'DELETE') {
    if (!isAdmin(req)) return res.status(401).json({ error: '인증 실패' })
    const { id } = req.query || {}
    if (!id) return res.status(400).json({ error: 'id 필요' })
    const { error } = await supabase.from('coupang_products').delete().eq('id', id)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ ok: true })
  }

  res.status(405).json({ error: 'Method not allowed' })
}
