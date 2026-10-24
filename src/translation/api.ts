import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import type { ModelApiConfig } from "./config";

export function redact(text: string, key: string): string {
  return key ? text.split(key).join("[REDACTED]") : text;
}
export function apiBaseUrl(value: string): string {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("请输入有效的模型 API 服务地址"); }
  if (!["https:", "http:"].includes(url.protocol) || url.username || url.password || url.search || url.hash)
    throw new Error("API 地址须为 HTTP(S)，不要包含账号、密钥、查询参数或锚点");
  url.pathname = url.pathname.replace(/\/+$/, "").replace(/\/chat\/completions$/, "");
  return url.toString().replace(/\/+$/, "");
}
export function validateApi(config: ModelApiConfig): ModelApiConfig {
  const baseUrl = apiBaseUrl(config.baseUrl);
  if (!config.model.trim()) throw new Error("请在 Paper Lens 设置中填写翻译模型 ID");
  if (!config.apiKey.trim()) throw new Error("请在 Paper Lens 设置中填写 API Key（本地无认证服务可填任意非空值）");
  if (!Number.isFinite(config.timeout) || config.timeout <= 0) throw new Error("API 超时必须大于零");
  return { ...config, baseUrl, model: config.model.trim() };
}
function requestJson(config: ModelApiConfig, route: string, body?: unknown, signal?: AbortSignal): Promise<unknown> {
  const endpoint = new URL(apiBaseUrl(config.baseUrl) + route);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) { reject(new Error("翻译已取消")); return; }
    const data = body === undefined ? undefined : JSON.stringify(body);
    const request = (endpoint.protocol === "https:" ? httpsRequest : httpRequest)(endpoint, {
      method: data ? "POST" : "GET", headers: {
        Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json",
        ...(data ? { "Content-Length": Buffer.byteLength(data) } : {}),
      },
    }, (response) => {
      const chunks: Buffer[] = []; let length = 0;
      response.on("data", (chunk: Buffer) => {
        length += chunk.length;
        if (length > 2 * 1024 * 1024) request.destroy(new Error("API 响应过大"));
        else chunks.push(chunk);
      });
      response.on("error", (error) => { cleanup(); reject(new Error(redact(error.message, config.apiKey))); });
      response.on("end", () => {
        cleanup();
        const text = Buffer.concat(chunks).toString("utf8");
        if (!response.statusCode || response.statusCode < 200 || response.statusCode >= 300) {
          reject(new Error(redact(`模型 API HTTP ${response.statusCode}：${text.slice(0, 2000)}`, config.apiKey))); return;
        }
        try { resolve(JSON.parse(text)); } catch { reject(new Error("模型 API 返回了无效 JSON")); }
      });
    });
    const timer = setTimeout(() => request.destroy(new Error("模型 API 请求超时，请检查服务地址或增加超时")), config.timeout * 1000);
    const abort = () => request.destroy(new Error("翻译已取消"));
    signal?.addEventListener("abort", abort, { once: true });
    const cleanup = () => { clearTimeout(timer); signal?.removeEventListener("abort", abort); };
    request.on("error", (error) => { cleanup(); reject(new Error(redact(error.message, config.apiKey))); });
    request.end(data);
  });
}
export async function testConnection(input: ModelApiConfig, signal?: AbortSignal): Promise<string> {
  const config = validateApi(input);
  const value = await requestJson(config, "/chat/completions", {
    model: config.model, stream: false,
    messages: [{ role: "user", content: "Reply only OK. This is a connection test." }],
    ...(config.effort ? { reasoning_effort: config.effort } : {}),
  }, signal) as { choices?: { message?: { content?: unknown } }[] };
  const content = value.choices?.[0]?.message?.content;
  if (typeof content !== "string" || !content.trim()) throw new Error("模型 API 未返回有效文本，请检查模型是否支持 Chat Completions");
  return redact(content, config.apiKey).slice(0, 500);
}
export async function listModels(config: ModelApiConfig): Promise<string[]> {
  const value = await requestJson(config, "/models") as { data?: { id?: unknown }[] };
  if (!Array.isArray(value.data)) throw new Error("服务不支持模型目录，请直接填写模型 ID");
  return [...new Set(value.data.map((item) => item.id).filter((id): id is string => typeof id === "string" && !!id))].sort();
}
