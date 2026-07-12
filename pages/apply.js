import { useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { callRpc } from '../lib/publicSupabase'

export default function Apply() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [phone, setPhone] = useState('')
  const [product, setProduct] = useState('nt8')
  const [months, setMonths] = useState('1')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null) // { ok, msg }

  const submit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setResult(null)
    try {
      await callRpc('apply_license', {
        p_name: name.trim(),
        p_email: email.trim(),
        p_product: product,
        p_months: parseInt(months, 10),
        p_phone: phone.trim() || null,
      })
      setResult({ ok: true, msg: '신청이 접수되었습니다. 위 계좌로 입금해주시면 확인 후 이메일로 라이선스 키를 보내드립니다.' })
      setName(''); setEmail(''); setPhone(''); setProduct('nt8'); setMonths('1')
    } catch (err) {
      setResult({ ok: false, msg: '신청 중 오류가 발생했습니다: ' + err.message })
    }
    setSubmitting(false)
  }

  return (
    <>
      <Head>
        <title>신청 - 매매 시스템</title>
      </Head>
      <div className="wrap">
        <header className="site">
          <h1>신청</h1>
          <nav className="site">
            <Link href="/">소개</Link>
            <Link href="/check">내 정보 조회</Link>
          </nav>
        </header>

        <div className="card">
          <h2>사용 신청</h2>
          <form onSubmit={submit}>
            <label htmlFor="name">이름</label>
            <input type="text" id="name" required value={name} onChange={e => setName(e.target.value)} />

            <label htmlFor="email">이메일</label>
            <input type="email" id="email" required value={email} onChange={e => setEmail(e.target.value)} />

            <label htmlFor="phone">전화번호</label>
            <input type="text" id="phone" placeholder="010-1234-5678" value={phone} onChange={e => setPhone(e.target.value)} />

            <label htmlFor="product">제품</label>
            <select id="product" value={product} onChange={e => setProduct(e.target.value)}>
              <option value="nt8">NinjaTrader 8 버전</option>
              <option value="mt5">MetaTrader 5 버전</option>
            </select>

            <label htmlFor="months">신청 기간</label>
            <select id="months" value={months} onChange={e => setMonths(e.target.value)}>
              <option value="1">1개월</option>
              <option value="3">3개월</option>
              <option value="6">6개월</option>
              <option value="12">12개월</option>
            </select>

            <button type="submit" disabled={submitting}>{submitting ? '신청 중...' : '신청하기'}</button>
          </form>

          {result && (
            <div className={`result-box show ${result.ok ? 'ok' : 'err'}`}>{result.msg}</div>
          )}

          <div className="deposit-info">
            <strong>입금 계좌 안내</strong><br />
            카카오뱅크 3333-24-9824590 (예금주: 민찬홍)<br />
            신청 접수 후 위 계좌로 입금해주시면, 확인 후 이메일로 라이선스 키를 보내드립니다.
          </div>
        </div>

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
