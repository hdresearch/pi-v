# I need to deploy an app on Vers

## Steps

1. Create a VM:
```
vers_vm_create --mem_size_mib 4096 --fs_size_mib 8192 --wait_boot true
```

2. Connect to it:
```
vers_vm_use --vmId <vmId>
```

3. Install and run your app:
```bash
apt-get update && apt-get install -y nodejs npm
git clone <repo> /root/app && cd /root/app
npm install
node server.js &
```

4. Your app is live at:
```
https://<vmId>.vm.vers.sh:3000
```

## If the app isn't reachable

Your server probably binds `0.0.0.0` (IPv4 only). Vers routes over IPv6.

Fix option 1 — bind dual-stack:
```javascript
server.listen(3000, "::");
```

Fix option 2 — run an IPv6 bridge on port 8080:
```javascript
// proxy.js
const http = require("http");
const net = require("net");
const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: "127.0.0.1", port: 3000,
    path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress }
  }, (proxyRes) => { res.writeHead(proxyRes.statusCode, proxyRes.headers); proxyRes.pipe(res); });
  req.pipe(proxy);
});
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(3000, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    upstream.write(Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n"));
    upstream.write(`\r\nx-forwarded-for: ${socket.remoteAddress}\r\n\r\n`);
    upstream.write(head); upstream.pipe(socket); socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy()); socket.on("error", () => upstream.destroy());
});
server.listen(8080, "::");
```
Then access via `https://<vmId>.vm.vers.sh:8080`.

## If the port doesn't work

Only ports 3000 and 8080 are routed through the Vers proxy. Use one of those.

## If you need HTTPS

You already have it. Vers terminates TLS at the proxy. Your VM serves plain HTTP, the browser sees HTTPS.

## When you're done

```
vers_vm_local
vers_vm_delete --vmId <vmId>
```
