// A plain HTTP server. The only contract: listen on $PORT.
import { createServer } from "node:http";

const port = Number(process.env.PORT ?? 3000);
createServer((req, res) => {
  res.setHeader("content-type", "application/json");
  res.end(JSON.stringify({ hello: process.env.GREETING ?? "world", path: req.url }));
}).listen(port, () => console.log(`listening on ${port}`));
