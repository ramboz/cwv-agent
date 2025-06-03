// src/mcp/client.js
import 'dotenv/config';
import fetch from 'node-fetch';

let requestId = 1;

export async function callMCP(method, extraHeaders = {}, params = {}) {
  if (!method) throw new Error('method is required');

  const bodyObj = {
    jsonrpc: '2.0',
    id: requestId++,
    method,
    params,
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': process.env.MCP_API_KEY,
    ...extraHeaders,          // e.g. { 'x-gw-ims-org-id': process.env.MCP_ORG_ID }
  };

  console.log('POST', process.env.MCP_ENDPOINT);
  console.log('Headers', headers);
  console.log('Body', JSON.stringify(bodyObj, null, 2));

  const res   = await fetch(process.env.MCP_ENDPOINT, {
    method: 'POST',
    headers,
    body:   JSON.stringify(bodyObj),
  });

  const text  = await res.text();        // read as text first
  let   json;
  try   { json = JSON.parse(text); }
  catch { throw new Error(`Server did not return JSON:\n${text}`); }

  if (json.error) {
    throw new Error(`[MCP] ${json.error.message || 'Unknown MCP error'}`);
  }
  return json.result;
}