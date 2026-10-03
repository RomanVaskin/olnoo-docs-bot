import "./db.js";
import fs from "node:fs";
import http from "node:http";
import { Readable } from "node:stream";
import { createWebApplication, createWebPayment, confirmWebPayment, issueWebPolicy, policyFilePath, recognizePassport } from "./services/web-insurance.js";

const apiKey = process.env.INSURANCE_API_KEY;
if (!apiKey) throw new Error("INSURANCE_API_KEY is missing");
const port = Number(process.env.INSURANCE_API_PORT || 3100);
const host = process.env.INSURANCE_API_HOST || "127.0.0.1";
const json = (res: http.ServerResponse, status: number, data: unknown) => { res.writeHead(status,{"content-type":"application/json; charset=utf-8"}); res.end(JSON.stringify(data)); };
const body = async (req: http.IncomingMessage) => { const chunks:Buffer[]=[]; for await (const c of req) chunks.push(Buffer.from(c)); return Buffer.concat(chunks); };
const multipartFile = async (req: http.IncomingMessage) => {
  const headers = new Headers();
  for (const [name,value] of Object.entries(req.headers)) if (value !== undefined) headers.set(name,Array.isArray(value)?value.join(", "):value);
  const request = new Request(`http://${req.headers.host || "localhost"}${req.url || "/"}`, { method:"POST", headers, body:Readable.toWeb(req), duplex:"half" } as RequestInit & { duplex:"half" });
  const formData = await request.formData();
  const file = formData.get("file");
  if (!file || typeof file === "string") throw new Error("Файл не передан.");
  return { buffer:Buffer.from(await file.arrayBuffer()), filename:file.name || "document.jpg", mimeType:file.type || "application/octet-stream" };
};

http.createServer(async (req,res) => {
  try {
    if (req.headers.authorization !== `Bearer ${apiKey}`) return json(res,401,{error:"Unauthorized"});
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    if (req.method === "POST" && url.pathname === "/insurance/recognize-document") {
      const file = await multipartFile(req); return json(res,200,await recognizePassport(file.buffer,file.mimeType,file.filename));
    }
    const data = req.method === "POST" ? JSON.parse((await body(req)).toString("utf8") || "{}") : {};
    if (req.method === "POST" && url.pathname === "/insurance/applications") return json(res,201,createWebApplication(data));
    if (req.method === "POST" && url.pathname === "/insurance/payments") return json(res,200,await createWebPayment(Number(data.applicationId),String(data.returnUrl)));
    if (req.method === "GET" && url.pathname === "/insurance/payment-status") return json(res,200,await confirmWebPayment(Number(url.searchParams.get("applicationId")),String(url.searchParams.get("paymentId"))));
    if (req.method === "POST" && url.pathname === "/insurance/issue-policy") return json(res,200,await issueWebPolicy(Number(data.applicationId)));
    if (req.method === "GET" && url.pathname.startsWith("/insurance/policies/")) {
      const number = decodeURIComponent(url.pathname.split("/").pop() || "").replace(/\.pdf$/,""); const file = policyFilePath(number);
      if (!fs.existsSync(file)) return json(res,404,{error:"Not found"}); res.writeHead(200,{"content-type":"application/pdf","content-disposition":`attachment; filename="${number}.pdf"`}); return fs.createReadStream(file).pipe(res);
    }
    return json(res,404,{error:"Not found"});
  } catch (error) { return json(res,400,{error:error instanceof Error?error.message:"Unknown error"}); }
}).listen(port,host,()=>console.log(`Insurance API listening on ${host}:${port}`));
