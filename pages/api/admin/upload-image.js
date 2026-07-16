import { supabase } from '../../../lib/supabase'

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp']
const MAX_MB = 10

async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (buckets?.some(b => b.name === 'blog-images')) return
  await supabase.storage.createBucket('blog-images', { public: true, fileSizeLimit: '5MB' })
}

export default async function handler(req, res) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 필요' })
  }
  if (req.method !== 'POST') return res.status(405).end()

  const { base64, contentType, filename } = req.body || {}
  if (!base64 || !contentType) return res.status(400).json({ error: 'base64/contentType 필요' })
  if (!ALLOWED_TYPES.includes(contentType)) {
    return res.status(400).json({ error: '이미지 파일(jpg/png/gif/webp)만 업로드할 수 있습니다.' })
  }

  const buffer = Buffer.from(base64, 'base64')
  if (buffer.length > MAX_MB * 1024 * 1024) {
    return res.status(400).json({ error: `${MAX_MB}MB 이하 파일만 업로드할 수 있습니다.` })
  }

  const ext = (contentType.split('/')[1] || 'jpg').replace(/[^a-z0-9]/g, '') || 'jpg'
  const path = `uploads/${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}.${ext}`

  try {
    await ensureBucket()
    const { error: upErr } = await supabase.storage.from('blog-images').upload(path, buffer, { contentType, upsert: false })
    if (upErr) return res.status(500).json({ error: upErr.message })
    const { data: pub } = supabase.storage.from('blog-images').getPublicUrl(path)
    return res.status(200).json({ url: pub.publicUrl })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
