import { useState } from 'react'
import Head from 'next/head'
import Link from 'next/link'
import { callRpc } from '../lib/publicSupabase'

const STATUS_LABEL = { active: '활성', pending: '입금 확인 대기중', expired: '만료됨', cancelled: '취소됨' }
const PRODUCT_LABEL = { nt8: 'NinjaTrader 8', mt5: 'MetaTrader 5' }

export default function Check() {
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [result, setResult] = useState(null) // { ok, row } | { ok:false, msg }

  const submit = async (e) => {
    e.preventDefault()
    setSubmitting(true)
    setResult(null)
    try {
      const rows = await callRpc('check_license', { p_name: name.trim(), p_email: email.trim() })
      if (!rows || rows.length === 0) {
        setResult({ ok: false, msg: '일치하는 신청 내역을 찾지 못했습니다. 이름/이메일을 다시 확인해주세요.' })
      } else {
        setResult({ ok: rows[0].status === 'active', row: rows[0] })
      }
    } catch (err) {
      setResult({ ok: false, msg: '조회 중 오류가 발생했습니다: ' + err.message })
    }
    setSubmitting(false)
  }

  return (
    <>
      <Head>
        <title>내 정보 조회 - EasyTrade</title>
      </Head>
      <div className="wrap">
        <header className="site">
          <h1>내 정보 조회</h1>
          <nav className="site">
            <Link href="/">소개</Link>
            <Link href="/blog">블로그</Link>
            <Link href="/apply">신청</Link>
          </nav>
        </header>

        <div className="card">
          <h2>라이선스 상태 확인</h2>
          <form onSubmit={submit}>
            <label htmlFor="name">이름</label>
            <input type="text" id="name" required value={name} onChange={e => setName(e.target.value)} />

            <label htmlFor="email">이메일</label>
            <input type="email" id="email" required value={email} onChange={e => setEmail(e.target.value)} />

            <button type="submit" disabled={submitting}>{submitting ? '조회 중...' : '조회하기'}</button>
          </form>

          {result && !result.row && (
            <div className="result-box show err">{result.msg}</div>
          )}
          {result && result.row && (
            <div className={`result-box show ${result.ok ? 'ok' : 'err'}`}>
              <span className={`badge ${result.row.status || 'pending'}`}>{STATUS_LABEL[result.row.status] || result.row.status}</span><br /><br />
              제품: {PRODUCT_LABEL[result.row.product] || result.row.product}<br />
              {result.row.requested_months && <>신청 기간: {result.row.requested_months}개월<br /></>}
              {result.row.start_date && <>시작일: {result.row.start_date}<br /></>}
              {result.row.expire_date && <>만료일: {result.row.expire_date}<br /></>}
              {result.row.license_key && <>라이선스 키: {result.row.license_key}<br /></>}
            </div>
          )}
        </div>

        <footer className="site">문의: minssajang@gmail.com</footer>
      </div>
    </>
  )
}
