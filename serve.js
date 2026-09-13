/* SupportLayer — zero-dependency static server for local dev, demos and tests. */
"use strict";

const http = require("http");
const fs = require("fs");
const path = require("path");

const root = __dirname;
const envPort = Number(process.env.PORT); // PORT=0 is exported by some shells and means "unset"
const port = Number.isInteger(envPort) && envPort > 0 && envPort < 65536 ? envPort : 4174;
const types = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".ico": "image/x-icon",
  ".json": "application/json",
  ".md": "text/markdown; charset=utf-8",
};

http
  .createServer((req, res) => {
    let pathname = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
    if (pathname.endsWith("/")) pathname += "index.html";
    const file = path.join(root, path.normalize(pathname).replace(/^(\.\.[/\\])+/, ""));
    fs.readFile(file, (err, data) => {
      if (err) {
        res.writeHead(404, { "Content-Type": "text/plain" });
        return res.end("not found");
      }
      res.writeHead(200, {
        "Content-Type": types[path.extname(file).toLowerCase()] || "application/octet-stream",
        "Cache-Control": "no-cache",
      });
      res.end(data);
    });
  })
  .listen(port, "127.0.0.1", () => console.log("SupportLayer dev server on http://127.0.0.1:" + port));
