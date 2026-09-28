// Gemini 프록시. API 키는 서버 환경변수로만 읽고, 브라우저로 내려보내지 않는다.
import './env.js';
import { jsonrepair } from 'jsonrepair';

const defaultApiBase = 'https://generativelanguage.googleapis.com';
const maxOutputTokens = Math.max(2400, Number(process.env.GEMINI_MAX_OUTPUT_TOKENS || 8192));

export function buildProviders() {
  const keys = envList('GEMINI_API_KEYS');
  if (!keys.length && process.env.GEMINI_API_KEY) keys.push(process.env.GEMINI_API_KEY.trim());
  const bases = envList('GEMINI_API_BASES');
  const formats = envList('GEMINI_API_KEY_FORMATS');
  const modelOverrides = envList('GEMINI_API_KEY_MODELS').length ? envList('GEMINI_API_KEY_MODELS') : envList('GEMINI_API_MODELS');
  return keys.filter(Boolean).map((apiKey, index) => {
    const apiBase = normalizeApiBase(bases[index] || process.env.GEMINI_API_BASE || defaultApiBase);
    const format = normalizeFormat(formats[index] || process.env.GEMINI_API_KEY_FORMAT || inferFormat(apiBase));
    return {
      apiKey,
      apiBase,
      format,
      modelOverride: modelOverrides[index] || '',
      keyMode: `gemini:${format}:${index + 1}`
    };
  });
}

// 프로바이더를 순서대로 시도하고, 첫 성공의 JSON을 반환한다.
// logger를 주면 호출 한 건마다 시작·끝을 기록한다. (gemini_requests 테이블)
export async function generateJson(providers, { model, system, user, temperature = 1.0, thinkingLevel = 'low', logger = null }) {
  let lastFailure = { status: 502, message: 'Gemini 요청 중 오류가 발생했습니다.' };

  for (let index = 0; index < providers.length; index += 1) {
    const provider = providers[index];
    const targetModel = provider.modelOverride || model;
    const logId = await logger?.start({ keyMode: provider.keyMode, requestedModel: model, actualModel: targetModel }) ?? null;
    try {
      const res = await fetch(endpointFor(targetModel, provider), {
        method: 'POST',
        signal: AbortSignal.timeout(Number(process.env.GEMINI_TIMEOUT_MS || 90000)),
        headers: headersFor(provider),
        body: JSON.stringify(bodyFor(targetModel, { system, user, temperature, thinkingLevel }, provider))
      });

      if (!res.ok) {
        const text = await res.text();
        const message = text || `Gemini request failed (${res.status}).`;
        logFailure(provider, res.status, message);
        await logger?.finish(logId, { ok: false, status: res.status, errorMessage: message });
        // 응답 본문을 그대로 화면에 띄우지 않고 사람이 읽을 문장만 뽑는다.
        lastFailure = { status: res.status, message: shortMessage(message) };
        if (shouldRetry(res.status, message, index, providers.length)) continue;
        return { ok: false, ...lastFailure };
      }

      const data = await res.json();
      const finishReason = finishReasonOf(data, provider);
      if (/max.?tokens|length/i.test(finishReason)) {
        throw new Error(`Gemini output was truncated (${finishReason}).`);
      }
      const text = extractText(data, provider);
      if (!text) throw new Error('Gemini 응답이 비어 있습니다.');
      const parsed = parseJsonText(text);
      await logger?.finish(logId, { ok: true, status: res.status });
      return { ok: true, data: parsed, keyMode: provider.keyMode, model: targetModel };
    } catch (error) {
      const message = error instanceof SyntaxError
        ? 'Gemini 응답을 JSON으로 해석하지 못했습니다.'
        : error.message || 'Gemini 요청 중 오류가 발생했습니다.';
      logFailure(provider, 502, message);
      await logger?.finish(logId, { ok: false, status: 502, errorMessage: message });
      lastFailure = { status: 502, message };
      if (index < providers.length - 1) continue;
      return { ok: false, ...lastFailure };
    }
  }

  return { ok: false, ...lastFailure };
}

function normalizeApiBase(value) {
  const raw = String(value || '').trim();
  const markdownLink = raw.match(/^\[([^\]]+)\]\((https?:\/\/[^)]+)\)$/i);
  const angleUrl = raw.match(/^<(https?:\/\/[^>]+)>$/i);
  return (markdownLink?.[2] || angleUrl?.[1] || raw).trim().replace(/\/+$/, '');
}

function envList(name) {
  return String(process.env[name] || '')
    .split(/[\n,]+/)
    .map(value => value.trim())
    .filter(Boolean);
}

function inferFormat(apiBase) {
  if (apiBase.includes('monorouter/v1')) return 'monorouter';
  if (apiBase.includes('llm-router.cafe24.com')) return 'openai';
  if (apiBase.endsWith('/chat/completions') || apiBase.endsWith('/v1') || apiBase.includes('/api/v1')) return 'openai';
  return 'gemini';
}

function normalizeFormat(format) {
  const normalized = String(format || '').trim().toLowerCase();
  if (['openai', 'openai-compatible', 'chat-completions'].includes(normalized)) return 'openai';
  if (['monogpt', 'monorouter'].includes(normalized)) return 'monorouter';
  return 'gemini';
}

function endpointFor(model, provider) {
  const encodedModel = encodeURIComponent(model);
  if (provider.format === 'openai') {
    if (provider.apiBase.endsWith('/chat/completions')) return provider.apiBase;
    return provider.apiBase.endsWith('/v1') ? `${provider.apiBase}/chat/completions` : `${provider.apiBase}/api/v1/chat/completions`;
  }
  if (provider.format === 'monorouter') {
    return `${provider.apiBase}/v1beta/models/${encodedModel}:generateContent`;
  }
  if (provider.apiBase.includes('{model}')) {
    return provider.apiBase.replace('{model}', encodedModel);
  }
  if (provider.apiBase.endsWith(':generateContent')) return provider.apiBase;
  if (/\/v1(beta)?$/.test(provider.apiBase)) return `${provider.apiBase}/models/${encodedModel}:generateContent`;
  return `${provider.apiBase}/v1beta/models/${encodedModel}:generateContent`;
}

function headersFor(provider) {
  const headers = { 'Content-Type': 'application/json' };
  if (provider.format === 'openai') {
    headers.Authorization = `Bearer ${provider.apiKey}`;
    return headers;
  }
  headers['x-goog-api-key'] = provider.apiKey;
  if (provider.format === 'monorouter') headers.Authorization = `Bearer ${provider.apiKey}`;
  return headers;
}

function bodyFor(model, { system, user, temperature, thinkingLevel }, provider) {
  if (provider.format === 'openai') {
    return {
      model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user }
      ],
      response_format: { type: 'json_object' },
      temperature,
      max_tokens: maxOutputTokens
    };
  }

  const body = {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      temperature,
      maxOutputTokens
    }
  };

  if (provider.format === 'monorouter') {
    body.model = model;
    return body;
  }

  // 원가 핵심: thinking을 낮게 고정한다.
  if (thinkingLevel) body.generationConfig.thinkingConfig = { thinkingLevel };
  return body;
}

function finishReasonOf(data, provider) {
  if (provider.format === 'openai') return String(data.choices?.[0]?.finish_reason || '');
  return String(data.candidates?.[0]?.finishReason || '');
}

function extractText(data, provider) {
  if (provider.format === 'openai') {
    const content = data.choices?.[0]?.message?.content;
    if (Array.isArray(content)) return content.map(part => part.text || part.content || '').join('');
    return content || '';
  }
  return (data.candidates?.[0]?.content?.parts || []).map(part => part.text || '').join('');
}

function parseJsonText(text) {
  let trimmed = String(text || '').replace(/^﻿/, '').trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  if (fenced) trimmed = fenced[1].trim();
  try {
    return JSON.parse(trimmed);
  } catch {
    const start = trimmed.indexOf('{');
    const end = trimmed.lastIndexOf('}');
    const candidate = start >= 0 && end > start
      ? trimmed.slice(start, end + 1)
      : (start >= 0 ? trimmed.slice(start) : trimmed);
    return JSON.parse(jsonrepair(candidate));
  }
}

function shouldRetry(status, message, index, providerCount) {
  if (index >= providerCount - 1) return false;
  if ([402, 429, 500, 502, 503, 504].includes(Number(status))) return true;
  return /credit|quota|insufficient|depleted|rate.?limit|overloaded|unavailable|timeout/i.test(String(message || ''));
}

function logFailure(provider, status, message) {
  console.warn(`[gemini] provider=${provider.keyMode} host=${safeHost(provider.apiBase)} status=${status} message=${shortMessage(message)}`);
}

function safeHost(value) {
  try { return new URL(value).host || 'unknown'; } catch { return 'invalid-url'; }
}

function shortMessage(message) {
  const parsed = looseJson(message);
  const text = parsed?.user_message || parsed?.message || parsed?.error?.message || parsed?.error || message;
  return String(text || '').replace(/\s+/g, ' ').slice(0, 260);
}

function looseJson(value) {
  if (!value || typeof value !== 'string') return null;
  if (!/^[{[]/.test(value.trim())) return null;
  try { return JSON.parse(value.trim()); } catch { return null; }
}
