import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";

const listenPort = Number(process.env.PORT || 51101);
const upstream = new URL(process.env.UPSTREAM || "https://eda-fe-original.eda-system.svc:51101");
const upstreamServerName = process.env.UPSTREAM_SERVER_NAME || "eda-fe.eda-system.svc";
const clientCertDir = process.env.EDA_CLIENT_CERT_DIR || "/var/run/eda/tls/internal/client";
const trustBundlePath = process.env.EDA_TRUST_BUNDLE || "/var/run/eda/tls/internal/trust/trust-bundle.pem";
const patchedChunkPath =
  process.env.PATCHED_CHUNK || "/app/proxy/EdaApplicationsRoute-ChGAYQlA.js";
const patchedChunkRoute = "/assets/EdaApplicationsRoute-ChGAYQlA.js";

function read(file) {
  return fs.readFileSync(file);
}

const tlsOptions = {
  cert: read(path.join(clientCertDir, "tls.crt")),
  key: read(path.join(clientCertDir, "tls.key")),
  ca: fs.existsSync(trustBundlePath)
    ? read(trustBundlePath)
    : read(path.join(clientCertDir, "ca.crt")),
};

const upstreamAgent = new https.Agent({
  ...tlsOptions,
  servername: upstreamServerName,
});

function proxy(req, res) {
  const headers = { ...req.headers, host: `${upstreamServerName}:51101` };
  const upstreamReq = https.request(
    {
      protocol: upstream.protocol,
      hostname: upstream.hostname,
      port: upstream.port || 443,
      method: req.method,
      path: req.url,
      headers,
      agent: upstreamAgent,
      servername: upstreamServerName,
    },
    upstreamRes => {
      res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
      upstreamRes.pipe(res);
    },
  );

  upstreamReq.on("error", err => {
    res.writeHead(502, { "content-type": "text/plain; charset=utf-8" });
    res.end(`eda-fe proxy upstream error: ${err.message}\n`);
  });

  req.pipe(upstreamReq);
}

https
  .createServer(
    {
      ...tlsOptions,
      requestCert: true,
      rejectUnauthorized: false,
    },
    (req, res) => {
      if (req.url && req.url.split("?")[0] === patchedChunkRoute) {
        const body = read(patchedChunkPath);
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

      proxy(req, res);
    },
  )
  .listen(listenPort, () => {
    console.log(`eda-fe cable-map proxy listening on ${listenPort}`);
  });

http
  .createServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
  })
  .listen(18080);
