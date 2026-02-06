# Vers VM Networking

## Key Facts

- Vers proxy terminates TLS. All `*.vm.vers.sh` connections arrive as HTTPS at the browser. VMs serve plain HTTP.
- Vers proxy connects to VMs over **IPv6**.
- Allowed ports: **3000**, **8080**. Arbitrary ports may not route.
- URL pattern: `https://{vmId}.vm.vers.sh:{port}`

## If Your Server Binds IPv4 Only

Servers binding `0.0.0.0` are unreachable from the Vers proxy (IPv6). Two fixes:

### Option 1: Bind dual-stack (preferred)

```javascript
server.listen(3000, "::");  // listens on both IPv4 and IPv6
```

### Option 2: IPv6→IPv4 bridge

Run alongside your server:

```javascript
// proxy.js
const http = require("http");
const net = require("net");

const server = http.createServer((req, res) => {
  const proxy = http.request({
    hostname: "127.0.0.1", port: 3000,
    path: req.url, method: req.method,
    headers: { ...req.headers, "x-forwarded-for": req.socket.remoteAddress }
  }, (proxyRes) => {
    res.writeHead(proxyRes.statusCode, proxyRes.headers);
    proxyRes.pipe(res);
  });
  req.pipe(proxy);
});

// WebSocket support
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(3000, "127.0.0.1", () => {
    upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
    upstream.write(Object.entries(req.headers).map(([k,v]) => `${k}: ${v}`).join("\r\n"));
    upstream.write(`\r\nx-forwarded-for: ${socket.remoteAddress}\r\n\r\n`);
    upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  upstream.on("error", () => socket.destroy());
  socket.on("error", () => upstream.destroy());
});

server.listen(8080, "::");
```

## SSH to VMs

SSH goes over TLS on port 443 using openssl as ProxyCommand:

```bash
ssh -i /path/to/key.pem \
  -o StrictHostKeyChecking=no \
  -o UserKnownHostsFile=/dev/null \
  -o LogLevel=ERROR \
  -o ConnectTimeout=30 \
  -o "ProxyCommand=openssl s_client -connect %h:443 -servername %h -quiet 2>/dev/null" \
  root@{vmId}.vm.vers.sh
```

Key files are obtained from the Vers API: `GET /vm/{vmId}/ssh_key`.
