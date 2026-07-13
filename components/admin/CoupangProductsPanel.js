import { RepeatableListCard } from './CoupangPanel'

const EMPTY_PRODUCT = { label: '', url: '', banner_html: '', banner_html_blog: '', enabled: true }

export default function CoupangProductsPanel({ adminToken }) {
  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <div style={{ fontSize: 17, fontWeight: 700, color: '#e8eaed' }}>📦 쿠팡상품</div>
        <div style={{ fontSize: 12, color: '#9aa0ab', marginTop: 3 }}>
          블로그 글 등에 수동으로 붙여넣어 쓸 쿠팡 상품을 등록해두는 목록입니다. (자동 판매/노출 기능 아님)
        </div>
      </div>

      <RepeatableListCard
        adminToken={adminToken}
        title="📦 상품 목록 (필요한 만큼 추가)"
        description="상품명 / 링크 / 일반 태그 / 블로그용 태그를 등록하세요."
        apiPath="/api/admin/coupang-products"
        empty={EMPTY_PRODUCT}
        addLabel="+ 상품 추가"
        fields={[
          { key: 'label', label: '상품명', placeholder: '예: 트레이딩 모니터암' },
          { key: 'url', label: '링크', placeholder: 'https://link.coupang.com/a/... 또는 https://coupa.ng/...' },
          { key: 'banner_html', label: '일반 태그', placeholder: '<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>', multiline: true },
          { key: 'banner_html_blog', label: '블로그용 태그', placeholder: '<a href="https://link.coupang.com/a/..." target="_blank" ...><img src="..." ...></a>', multiline: true },
        ]}
        renderPreview={(item) => (
          <div dangerouslySetInnerHTML={{ __html: item.banner_html || item.banner_html_blog || '' }} />
        )}
      />
    </div>
  )
}
