import dgram from "node:dgram";
import fs from "node:fs";
import https from "node:https";
import net from "node:net";
import path from "node:path";
import { Readable } from "node:stream";
import tls from "node:tls";

const apiCertDir = process.env.EDA_API_CERT_DIR || "/var/run/eda/tls/api/client";
const apiTrustBundle = process.env.EDA_API_TRUST_BUNDLE || "/var/run/eda/tls/api/trust/trust-bundle.pem";
const patchedChunkPath =
  process.env.PATCHED_CHUNK || "/app/proxy/EdaApplicationsRoute-ChGAYQlA.js";
const patchedChunkRoute = "/assets/EdaApplicationsRoute-ChGAYQlA.js";
const cableMapPrefix = "/core/httpproxy/v1/cable-map";
const cableMapHost = process.env.CABLE_MAP_HOST || "cable-map.eda-system.svc";
const cableMapPort = Number(process.env.CABLE_MAP_UPSTREAM_PORT || 8080);
const upstreamHost = process.env.UPSTREAM_HOST || "eda-api-original.eda-system.svc";
const upstreamServerName = process.env.UPSTREAM_SERVER_NAME || "eda-api.eda-system.svc";

const tlsOptions = {
  cert: fs.readFileSync(path.join(apiCertDir, "tls.crt")),
  key: fs.readFileSync(path.join(apiCertDir, "tls.key")),
  ca: fs.existsSync(apiTrustBundle)
    ? fs.readFileSync(apiTrustBundle)
    : fs.readFileSync(path.join(apiCertDir, "ca.crt")),
};

const upstreamHttpsAgent = new https.Agent({
  ...tlsOptions,
  servername: upstreamServerName,
  rejectUnauthorized: false,
});

const hopByHopHeaders = new Set([
  "connection",
  "keep-alive",
  "proxy-authenticate",
  "proxy-authorization",
  "te",
  "trailer",
  "transfer-encoding",
  "upgrade",
]);

function filteredHeaders(reqHeaders, overrides = {}) {
  const headers = {};
  for (const [name, value] of Object.entries(reqHeaders)) {
    if (!hopByHopHeaders.has(name.toLowerCase())) {
      headers[name] = value;
    }
  }
  return { ...headers, ...overrides };
}

function sendRequestBody(req, upstreamReq) {
  if (req.method === "GET" || req.method === "HEAD") {
    upstreamReq.end();
    return;
  }
  req.pipe(upstreamReq);
}

function proxyHttps(req, res) {
  const host = req.headers.host || upstreamServerName;
  const headers = filteredHeaders(req.headers, {
    "x-forwarded-host": host,
    "x-forwarded-proto": "https",
    "x-forwarded-port": host.includes(":") ? host.split(":").pop() : "443",
  });
  const upstreamReq = https.request(
    {
      hostname: upstreamHost,
      port: 443,
      method: req.method,
      path: req.url,
      headers,
      agent: upstreamHttpsAgent,
      servername: upstreamServerName,
      rejectUnauthorized: false,
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", err => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`eda-api proxy upstream error: ${err.message}\n`);
  });

  sendRequestBody(req, upstreamReq);
}

async function proxyCableMap(req, res) {
  const stripped = (req.url || "/").slice(cableMapPrefix.length);
  const targetPath = stripped ? (stripped.startsWith("/") ? stripped : `/${stripped}`) : "/";
  const headers = filteredHeaders(req.headers);
  delete headers.host;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 30000);
  const requestInit = {
    method: req.method,
    headers,
    redirect: "manual",
    signal: controller.signal,
  };
  if (req.method !== "GET" && req.method !== "HEAD") {
    requestInit.body = req;
    requestInit.duplex = "half";
  }

  try {
    const upstreamRes = await fetch(
      `http://${cableMapHost}:${cableMapPort}${targetPath}`,
      requestInit,
    );
    clearTimeout(timeout);

    const responseHeaders = {};
    for (const [name, value] of upstreamRes.headers.entries()) {
      if (!hopByHopHeaders.has(name.toLowerCase())) {
        responseHeaders[name] = value;
      }
    }
    res.writeHead(upstreamRes.status, responseHeaders);
    if (req.method === "HEAD" || !upstreamRes.body) {
      res.end();
      return;
    }
    Readable.fromWeb(upstreamRes.body).pipe(res);
  } catch (err) {
    clearTimeout(timeout);
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`cable-map upstream error: ${err.message}\n`);
  }
}

const httpsServer = https.createServer(tlsOptions, (req, res) => {
  if (req.url && req.url.split("?")[0].startsWith(cableMapPrefix)) {
    proxyCableMap(req, res);
    return;
  }

  if (req.url && req.url.split("?")[0] === patchedChunkRoute) {
    const body = fs.readFileSync(patchedChunkPath);
    res.writeHead(200, {
      "content-type": "application/javascript; charset=utf-8",
      "cache-control": "no-store",
      "content-length": body.length,
    });
    res.end(body);
    return;
  }

  if (req.url === "/healthz") {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }

  proxyHttps(req, res);
});

httpsServer.on("upgrade", (req, socket, head) => {
  const upstream = tls.connect(
    {
      host: upstreamHost,
      port: 443,
      servername: upstreamServerName,
      rejectUnauthorized: false,
    },
    () => {
      upstream.write(`${req.method} ${req.url} HTTP/${req.httpVersion}\r\n`);
      for (const [name, value] of Object.entries(req.headers)) {
        upstream.write(`${name}: ${value}\r\n`);
      }
      upstream.write("\r\n");
      if (head?.length) upstream.write(head);
      socket.pipe(upstream).pipe(socket);
    },
  );
  upstream.on("error", () => socket.destroy());
});

httpsServer.listen(9443, () => {
  console.log("eda-api cable-map HTTPS proxy listening on 9443");
});

function tcpForward(listenPort, targetPort = listenPort) {
  net
    .createServer(client => {
      const upstream = net.connect({ host: upstreamHost, port: targetPort });
      client.pipe(upstream).pipe(client);
      client.on("error", () => upstream.destroy());
      upstream.on("error", () => client.destroy());
    })
    .listen(listenPort, () => {
      console.log(`tcp proxy ${listenPort} -> ${targetPort}`);
    });
}

function udpForward(listenPort, targetPort = listenPort) {
  const server = dgram.createSocket("udp4");
  server.on("message", (message, rinfo) => {
    const upstream = dgram.createSocket("udp4");
    upstream.on("message", response => {
      server.send(response, rinfo.port, rinfo.address);
      upstream.close();
    });
    upstream.send(message, targetPort, upstreamHost, err => {
      if (err) upstream.close();
    });
  });
  server.bind(listenPort, () => {
    console.log(`udp proxy ${listenPort} -> ${targetPort}`);
  });
}

for (const port of [9200, 51201, 51202, 51203, 51206, 51300]) {
  tcpForward(port);
}

for (const port of [67, 547]) {
  udpForward(port);
}
