import Link from 'next/link'

// 사이트 공통 로고 — 아이콘 배지 + 워드마크. 페이지마다 각자 텍스트만 다르게 쓰던 걸 통일.
export default function BrandLogo({ label }) {
  return (
    <Link href="/" className="brand-logo">
      <span className="brand-logo-mark">📈</span>
      <span className="brand-logo-text">
        <span className="brand-logo-word">EasyTrade</span>
        {label && <span className="brand-logo-sub">{label}</span>}
      </span>
    </Link>
  )
}
