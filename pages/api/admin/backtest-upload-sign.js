import { supabase } from '../../../lib/supabase'

const BUCKET = 'backtest-data'
const SYMBOLS = ['GOLD', 'NASDAQ']
const MAX_MB = 80

// 캔들 CSV가 수십MB라 Next.js API로 바디를 직접 받으면 서버리스 요청 크기 제한에 걸린다.
// versions.js(exe)와 같은 이유로, signed URL만 여기서 발급하고 실제 업로드는
// 브라우저가 Supabase Storage로 직접 하게 한다 (lib/publicSupabase.js의 uploadToSignedUrl).
async function ensureBucket() {
  const { data: buckets } = await supabase.storage.listBuckets()
  if (buckets?.some(b => b.name === BUCKET)) return
  await supabase.storage.createBucket(BUCKET, { public: true, fileSizeLimit: `${MAX_MB}MB` })
}

export default async function handler(req, res) {
  if (req.headers['x-admin-token'] !== process.env.ADMIN_SECRET_TOKEN) {
    return res.status(401).json({ error: '인증 필요' })
  }
  if (req.method !== 'POST') return res.status(405).end()

  const { symbol, filename } = req.body || {}
  if (!SYMBOLS.includes(symbol)) return res.status(400).json({ error: 'symbol은 GOLD 또는 NASDAQ이어야 합니다' })
  if (!filename || !/\.csv$/i.test(filename)) return res.status(400).json({ error: 'CSV 파일만 업로드할 수 있습니다' })

  const safeName = filename.replace(/[^a-zA-Z0-9._-]/g, '_')
  const path = `${symbol}/${Date.now().toString(36)}_${safeName}`

  try {
    await ensureBucket()
    const { data, error } = await supabase.storage.from(BUCKET).createSignedUploadUrl(path)
    if (error) return res.status(500).json({ error: error.message })
    return res.status(200).json({ path, token: data.token })
  } catch (e) {
    return res.status(500).json({ error: e.message })
  }
}
