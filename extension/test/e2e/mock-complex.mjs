// A harder fake service for record-mode e2e:
//  - several list endpoints (orders / wishlist / recommendations) → the search is needed
//  - a value (SKU-9) appears in TWO lists → the search is ambiguous (disambiguation UI)
//  - the PDF is gated behind the detail page via the Referer header (anti-scraping pattern):
//    GET /api/orders/{id}/pdf returns 403 unless Referer contains /orders/{id}
import http from 'node:http';

const ORDERS = [
  { orderId: 'ORD-1', purchasedAt: '2026-06-01', amount: 19.9, storeName: 'Decathlon Xàtiva', productRef: 'SKU-9' },
  { orderId: 'ORD-2', purchasedAt: '2026-06-02', amount: 5, storeName: 'Decathlon Online', productRef: 'SKU-3' },
];
const WISHLIST = [{ sku: 'SKU-9', name: 'Bici' }, { sku: 'SKU-7', name: 'Casco' }, { sku: 'SKU-1', name: 'Guantes' }];
const RECS = Array.from({ length: 6 }, (_, i) => ({ id: 'R' + (i + 1), title: 'Producto ' + (i + 1) }));
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

// The SPA: on the home page it loads the three lists; on an /orders/<id> detail page it fetches
// that order's PDF (so the browser sends Referer = the detail page).
const SPA = (path) => `<!doctype html><html><body><h1 id="t">loading</h1><script>
var H={authorization:'bearer eyJTESTtoken.a.b'};
function J(u){return fetch(u,{headers:H}).then(function(r){return r.json()});}
var p=${JSON.stringify(path)};
if(p.indexOf('/orders/')===0){
  var id=p.split('/orders/')[1];
  // fetch the PDF from the detail page → Referer is this page (retry so the hook's late arm catches it)
  function gp(){return fetch('/api/orders/'+id+'/pdf',{headers:H}).then(function(r){document.getElementById('t').textContent='detail '+id+' pdf '+r.status;});}
  gp(); var m=0; var ip=setInterval(function(){ if(++m>30){clearInterval(ip);return;} gp(); },500);
} else {
  var n=0; function go(){Promise.all([J('/api/orders'),J('/api/wishlist'),J('/api/recommendations')]).then(function(){document.getElementById('t').textContent='loaded';}).catch(function(){});}
  go(); var iv=setInterval(function(){ if(++n>30){clearInterval(iv);return;} go(); },500);
}
</script></body></html>`;

const need = (req) => /eyJ/.test(req.headers.authorization || '');

export function startMockComplex() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const u = new URL(req.url, 'http://localhost');
      const p = u.pathname;
      const json = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };

      if (p === '/' || p.startsWith('/orders/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(SPA(p)); }
      if (!need(req)) { res.writeHead(401); return res.end('no token'); }
      if (p === '/api/orders') return json({ items: ORDERS });
      if (p === '/api/wishlist') return json({ products: WISHLIST });
      if (p === '/api/recommendations') return json({ data: { recs: RECS } });

      const pdf = p.match(/^\/api\/orders\/([^/]+)\/pdf$/);
      if (pdf) {
        const id = pdf[1];
        const ref = req.headers.referer || '';
        if (!ref.includes('/orders/' + id)) { res.writeHead(403); return res.end('referer required'); } // must come from the detail page
        res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF);
      }
      const detail = p.match(/^\/api\/orders\/([^/]+)$/);
      if (detail) return json({ orderId: detail[1], lines: [{ sku: 'X' }], total: 5 });

      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, orders: ORDERS.length }));
  });
}
