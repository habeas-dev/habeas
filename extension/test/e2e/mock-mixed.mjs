// Mixed-auth fake service for e2e: the LIST is authed by a session COOKIE (no bearer), while the
// PDF is authed by a bearer JWT. Exercises per-endpoint auth resolution in the runtime.
import http from 'node:http';

const ORDERS = [
  { orderId: 'ORD-1', purchasedAt: '2026-06-01', amount: 9, storeName: 'Decathlon Uno' },
  { orderId: 'ORD-2', purchasedAt: '2026-06-02', amount: 12, storeName: 'Decathlon Dos' },
];
const COOKIE = 'hsid=SECRET123';
const PDF = Buffer.from('%PDF-1.4\n1 0 obj<</Type/Catalog>>endobj\ntrailer<</Root 1 0 R>>\n%%EOF');

const SPA = (path) => `<!doctype html><html><body><h1 id="t">loading</h1><script>
var p=${JSON.stringify(path)};
if(p.indexOf('/orders/')===0){
  var id=p.split('/orders/')[1];
  // PDF via a bearer JWT (no cookie needed)
  function gp(){return fetch('/api/orders/'+id+'/pdf',{headers:{authorization:'bearer eyJMOCKTOKEN.a.b'}}).then(function(r){document.getElementById('t').textContent='pdf '+r.status;});}
  gp(); var m=0; var ip=setInterval(function(){ if(++m>8){clearInterval(ip);return;} gp(); },500);
} else {
  // LIST via the session cookie (no Authorization header)
  function gl(){return fetch('/api/orders').then(function(r){document.getElementById('t').textContent=(r.ok?'loaded':'list '+r.status);});}
  gl(); var n=0; var il=setInterval(function(){ if(++n>8){clearInterval(il);return;} gl(); },500);
}
</script></body></html>`;

const hasCookie = (req) => (req.headers.cookie || '').includes(COOKIE);
const hasBearer = (req) => /eyJ/.test(req.headers.authorization || '');

export function startMockMixed() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      const p = new URL(req.url, 'http://localhost').pathname;
      if (p === '/') { res.writeHead(200, { 'content-type': 'text/html', 'set-cookie': COOKIE + '; Path=/' }); return res.end(SPA(p)); }
      if (p.startsWith('/orders/')) { res.writeHead(200, { 'content-type': 'text/html' }); return res.end(SPA(p)); }

      if (p === '/api/orders') {
        if (!hasCookie(req)) { res.writeHead(401); return res.end('cookie required'); } // cookie-authed list
        res.writeHead(200, { 'content-type': 'application/json' }); return res.end(JSON.stringify({ items: ORDERS }));
      }
      if (/^\/api\/orders\/[^/]+\/pdf$/.test(p)) {
        if (!hasBearer(req)) { res.writeHead(401); return res.end('bearer required'); }   // JWT-authed PDF
        res.writeHead(200, { 'content-type': 'application/pdf' }); return res.end(PDF);
      }
      res.writeHead(404); res.end();
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, orders: ORDERS.length }));
  });
}
