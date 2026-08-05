'use strict';
/**
 * OmniSMS — Infobip SMS Service
 *
 * Handles outbound SMS sending via Infobip REST API.
 * Configuration via environment variables:
 *   INFOBIP_API_KEY    — API key from Infobip portal
 *   INFOBIP_BASE_URL   — e.g. https://XXXXX.api.infobip.com
 *   INFOBIP_SENDER_ID  — sender name / number (default: OmniSMS)
 *
 * Production webhook URL:
 *   https://omnisms-backend.onrender.com/webhooks/infobip
 */

const https = require('https');
const http  = require('http');
const url   = require('url');

const { logger } = require('../middleware/logger');

// ── Config helpers ──────────────────────────────────────────
function getConfig() {
  return {
    apiKey   : process.env.INFOBIP_API_KEY    || '',
    baseUrl  : (process.env.INFOBIP_BASE_URL  || '').replace(/\/$/, ''),
    senderId : process.env.INFOBIP_SENDER_ID  || 'OmniSMS',
  };
}

function isConfigured() {
  const { apiKey, baseUrl } = getConfig();
  return !!(apiKey && baseUrl);
}

// ── Low-level HTTP request helper ───────────────────────────
/**
 * Make an authenticated request to Infobip REST API.
 * Returns a Promise that resolves to { statusCode, body }.
 */
function infobipRequest(method, path, payload) {
  return new Promise((resolve, reject) => {
    const { apiKey, baseUrl } = getConfig();

    if (!apiKey || !baseUrl) {
      return reject(new Error('Infobip not configured: set INFOBIP_API_KEY and INFOBIP_BASE_URL'));
    }

    // ── CRITICAL FIX: normalise baseUrl — prepend https:// if missing ──
    // Without this, url.parse("x196k3.api.infobip.com") returns hostname=null
    // and the entire HTTP request silently fails.
    let normalizedBaseUrl = baseUrl.trim();
    if (normalizedBaseUrl && !normalizedBaseUrl.match(/^https?:\/\//i)) {
      normalizedBaseUrl = 'https://' + normalizedBaseUrl;
      logger.warn('[Infobip] baseUrl was missing https:// prefix — auto-corrected', {
        original   : baseUrl,
        normalized : normalizedBaseUrl,
      });
    }

    const parsed  = url.parse(normalizedBaseUrl);
    const isHttps = parsed.protocol === 'https:';
    const host    = parsed.hostname;
    const port    = parsed.port
      ? parseInt(parsed.port, 10)
      : (isHttps ? 443 : 80);

    // Guard: if host is still null after normalization, reject immediately
    if (!host) {
      return reject(new Error(`Infobip baseUrl invalid — could not parse hostname from: "${baseUrl}"`));
    }

    const body = payload ? JSON.stringify(payload) : null;

    const options = {
      hostname: host,
      port,
      path,
      method,
      headers: {
        'Authorization' : 'App ' + apiKey,
        'Content-Type'  : 'application/json',
        'Accept'        : 'application/json',
        ...(body ? { 'Content-Length': Buffer.byteLength(body) } : {}),
      },
    };

    logger.info('[Infobip] Request', {
      method, host, port, path, isHttps,
    });

    const transport = isHttps ? https : http;
    const req = transport.request(options, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        let parsedBody;
        try   { parsedBody = JSON.parse(data); }
        catch (_) { parsedBody = { raw: data }; }
        logger.info('[Infobip] Response', {
          statusCode: res.statusCode,
          body      : JSON.stringify(parsedBody).slice(0, 500),
        });
        resolve({ statusCode: res.statusCode, body: parsedBody });
      });
    });

    req.on('error', (err) => {
      logger.error('[Infobip] HTTP request error', {
        host, port, path, method,
        error : err.message,
        code  : err.code,
        hint  : host === null
          ? 'INFOBIP_BASE_URL env var is malformed — set to e.g. https://XXXXX.api.infobip.com'
          : 'Check network/firewall or INFOBIP_BASE_URL value',
      });
      reject(err);
    });
    req.setTimeout(15000, () => {
      req.destroy(new Error('Infobip request timed out after 15s'));
    });

    if (body) req.write(body);
    req.end();
  });
}

// ── Send SMS ────────────────────────────────────────────────
/**
 * Send a single SMS via Infobip.
 *
 * @param {object} opts
 * @param {string}   opts.to      - Destination number in E.164 format (+22600000000)
 * @param {string}   opts.text    - Message body (max 1600 chars; multi-part handled by Infobip)
 * @param {string}  [opts.from]   - Sender ID override (falls back to INFOBIP_SENDER_ID)
 * @param {string}  [opts.notifyUrl] - Delivery report callback URL
 * @returns {Promise<{ success: boolean, messageId?: string, status?: string, error?: string }>}
 */
async function sendSMS({ to, text, from, notifyUrl } = {}) {
  if (!to || !text) {
    throw new Error('sendSMS: "to" and "text" are required');
  }

  const { senderId, baseUrl } = getConfig();
  if (!isConfigured()) {
    throw new Error('Infobip not configured — set INFOBIP_API_KEY and INFOBIP_BASE_URL');
  }

  const payload = {
    messages: [
      {
        from       : from || senderId,
        destinations: [{ to }],
        text,
        ...(notifyUrl ? { notifyUrl } : {}),
      },
    ],
  };

  const { baseUrl: bUrl } = getConfig();
  logger.info('[Infobip] Sending SMS', {
    to, from: from || senderId, textLength: text.length,
    baseUrl : bUrl,
    configured: isConfigured(),
  });

  let response;
  try {
    response = await infobipRequest('POST', '/sms/2/text/advanced', payload);
  } catch (err) {
    logger.error('[Infobip] HTTP error during sendSMS', {
      error  : err.message,
      code   : err.code,
      to,
      baseUrl: bUrl,
      hint   : 'Check INFOBIP_BASE_URL and INFOBIP_API_KEY environment variables on Render',
    });
    return { success: false, error: err.message, code: err.code };
  }

  const { statusCode, body } = response;

  if (statusCode >= 200 && statusCode < 300) {
    const msg       = body?.messages?.[0];
    const messageId = msg?.messageId || msg?.message_id || null;
    const status    = msg?.status?.name || msg?.status?.groupName || 'SENT';

    logger.info('[Infobip] SMS sent successfully', { to, messageId, status, statusCode });
    return { success: true, messageId, status, raw: body };
  }

  // Verbose failure logging — never mask the actual Infobip API response
  const errMsg = body?.requestError?.serviceException?.text
    || body?.requestError?.serviceException?.messageId
    || body?.error
    || JSON.stringify(body);

  logger.error('[Infobip] SMS send FAILED', {
    to, statusCode,
    error    : errMsg,
    fullBody : JSON.stringify(body).slice(0, 800),
    apiKeySet: !!getConfig().apiKey,
    baseUrl  : bUrl,
    hint     : statusCode === 401 ? 'Invalid API key — check INFOBIP_API_KEY'
             : statusCode === 400 ? 'Bad request — check phone format (E.164) and sender ID'
             : statusCode === 403 ? 'Forbidden — check account credits / sender permissions on Infobip'
             : 'Check Infobip dashboard for details',
  });
  return { success: false, error: errMsg, statusCode, raw: body };
}

// ── Send bulk SMS ───────────────────────────────────────────
/**
 * Send SMS to multiple recipients in a single API call.
 *
 * @param {object} opts
 * @param {string[]} opts.recipients - Array of E.164 phone numbers
 * @param {string}   opts.text       - Message text
 * @param {string}  [opts.from]      - Sender ID override
 * @returns {Promise<{ success: boolean, results: object[], error?: string }>}
 */
async function sendBulkSMS({ recipients, text, from } = {}) {
  if (!Array.isArray(recipients) || recipients.length === 0) {
    throw new Error('sendBulkSMS: "recipients" must be a non-empty array');
  }
  if (!text) {
    throw new Error('sendBulkSMS: "text" is required');
  }

  const { senderId } = getConfig();
  if (!isConfigured()) {
    throw new Error('Infobip not configured — set INFOBIP_API_KEY and INFOBIP_BASE_URL');
  }

  const payload = {
    messages: recipients.map((to) => ({
      from        : from || senderId,
      destinations: [{ to }],
      text,
    })),
  };

  logger.info('[Infobip] Sending bulk SMS', { count: recipients.length });

  let response;
  try {
    response = await infobipRequest('POST', '/sms/2/text/advanced', payload);
  } catch (err) {
    logger.error('[Infobip] Bulk HTTP error', { error: err.message });
    return { success: false, results: [], error: err.message };
  }

  const { statusCode, body } = response;

  if (statusCode >= 200 && statusCode < 300) {
    const results = (body?.messages || []).map((m) => ({
      to       : m?.to,
      messageId: m?.messageId || m?.message_id,
      status   : m?.status?.name || m?.status?.groupName || 'SENT',
    }));
    logger.info('[Infobip] Bulk SMS sent', { count: results.length });
    return { success: true, results, raw: body };
  }

  const errMsg = body?.requestError?.serviceException?.text
    || body?.error
    || JSON.stringify(body);

  logger.error('[Infobip] Bulk SMS failed', { statusCode, error: errMsg });
  return { success: false, results: [], error: errMsg, statusCode };
}

// ── Get delivery report ─────────────────────────────────────
/**
 * Fetch delivery reports for a specific message.
 * @param {string} messageId
 */
async function getDeliveryReport(messageId) {
  if (!isConfigured()) {
    return { success: false, error: 'Infobip not configured' };
  }

  try {
    const path   = '/sms/1/reports?messageId=' + encodeURIComponent(messageId);
    const { statusCode, body } = await infobipRequest('GET', path, null);

    if (statusCode >= 200 && statusCode < 300) {
      return { success: true, results: body?.results || [], raw: body };
    }
    return { success: false, error: JSON.stringify(body), statusCode };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ── Provider status ─────────────────────────────────────────
function getStatus() {
  const { apiKey, baseUrl, senderId } = getConfig();
  return {
    provider   : 'infobip',
    configured : isConfigured(),
    baseUrl    : baseUrl || null,
    senderId,
    hasApiKey  : !!apiKey,
  };
}

module.exports = {
  isConfigured,
  getStatus,
  sendSMS,
  sendBulkSMS,
  getDeliveryReport,
};
