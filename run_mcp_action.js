'use strict';

/*
 * run_mcp_action.js — puente entre los scripts generadores y el MCP server de n8n.
 *
 * Antes este módulo vivía FUERA del repo (los scripts hacían require('../run_mcp_action.js')),
 * así que el pipeline no corría desde un clon limpio. Ahora vive acá y expone `callMcp`.
 *
 * Herramientas que el pipeline consume (vía method 'tools/call'):
 *   - search_nodes            -> markdown crudo (node types reales, para grounding)
 *   - list_credentials        -> { data: [{ id, name, type }], count }
 *   - validate_workflow       -> { valid: bool, errors?: [...] }
 *   - create_workflow_from_code -> { workflowId, name, url, isError? }
 *   - prepare_test_pin_data   -> { nodesWithoutSchema: [...], nodeSchemasToGenerate: {...} }
 *   - test_workflow           -> { status, executionId }
 *
 * Estas 5 son un SUBCONJUNTO de las 27 herramientas del n8n MCP Server oficial (v1.1.0),
 * verificado contra un servidor real (ver docs/MCP_CONTRACT.md).
 *
 * Dos modos:
 *   - REAL : si N8N_MCP_URL está seteado, habla el transporte streamable-HTTP del n8n MCP
 *            Server: POST JSON-RPC, respuesta por SSE (text/event-stream), Bearer auth vía
 *            N8N_MCP_TOKEN. Es stateless (no exige handshake). Requiere n8n vivo — NO verificable
 *            en CI. Ej.: N8N_MCP_URL=http://localhost:5678/mcp-server/http N8N_MCP_TOKEN=<jwt>
 *   - MOCK : si N8N_MCP_URL no está, o MCP_MOCK=1, devuelve respuestas canónicas y
 *            deterministas. Permite correr y PROBAR el pipeline (incluido el ensamble CCDD
 *            real) desde un clon limpio, sin n8n ni Ollama. La frontera del mock es explícita.
 *
 * La forma de retorno imita la respuesta JSON-RPC de un MCP server:
 *   { jsonrpc:'2.0', id, result: { content: [{ type:'text', text: <json-string> }] } }
 * que es exactamente lo que los scripts parsean: JSON.parse(resp.result.content[0].text).
 */

let _id = 0;

function mockToolResult(params) {
  const name = params && params.name;
  const args = (params && params.arguments) || {};
  switch (name) {
    case 'list_credentials':
      // Forma del server real: { data: [...], count } (no array pelado).
      return { data: [{ id: 'cred-mock-1', name: 'Gmail OAuth2 (mock)', type: 'gmailOAuth2' }], count: 1 };

    case 'validate_workflow': {
      // Validación superficial pero NO trivial: exige export default workflow(...) y el import del SDK.
      // Suficiente para que el smoke test distinga un payload sano de uno roto.
      const code = String(args.code || '');
      const ok = /export\s+default\s+workflow\s*\(/.test(code) && /@n8n\/workflow-sdk/.test(code);
      return ok
        ? { valid: true }
        : { valid: false, errors: ['(mock) falta `export default workflow(...)` o el import de @n8n/workflow-sdk'] };
    }

    case 'create_workflow_from_code':
      return { workflowId: 'wf-mock-001', name: 'Flujo mock', url: 'https://n8n.local/workflow/wf-mock-001' };

    case 'prepare_test_pin_data':
      return { nodesWithoutSchema: ['Webhook Trigger'], nodeSchemasToGenerate: {} };

    case 'test_workflow':
      return { status: 'success', executionId: 'exec-mock-001' };

    case 'search_nodes':
      // El server real devuelve MARKDOWN crudo (no JSON) en content[0].text. Imitamos el formato.
      return [
        '## nodos',
        '- n8n-nodes-base.webhook [TRIGGER]',
        '  Display Name: Webhook',
        '  Version: 2.1',
        '- n8n-nodes-base.gmail [ACTION]',
        '  Display Name: Gmail',
        '  Version: 2.1',
        '- n8n-nodes-base.if [ACTION]',
        '  Display Name: If',
        '  Version: 2.2',
        '- n8n-nodes-base.set [ACTION]',
        '  Display Name: Edit Fields (Set)',
        '  Version: 3.4',
      ].join('\n');

    default:
      throw new Error(`run_mcp_action (mock): herramienta desconocida '${name}'`);
  }
}

function wrapJsonRpc(id, payloadObj) {
  // Las herramientas que devuelven JSON van como string JSON; las que devuelven texto (search_nodes,
  // get_sdk_reference) van como texto crudo — igual que el server real.
  const text = typeof payloadObj === 'string' ? payloadObj : JSON.stringify(payloadObj);
  return {
    jsonrpc: '2.0',
    id,
    result: { content: [{ type: 'text', text }] },
  };
}

/**
 * Invoca una acción del MCP server de n8n (o su mock).
 * @param {string} method  típicamente 'tools/call'
 * @param {object} params  { name, arguments } para 'tools/call'
 * @returns {Promise<object>} respuesta JSON-RPC con result.content[0].text (string JSON)
 */
async function callMcp(method, params) {
  const id = ++_id;
  const url = process.env.N8N_MCP_URL;
  const useMock = process.env.MCP_MOCK === '1' || !url;

  if (useMock) {
    if (method !== 'tools/call') return wrapJsonRpc(id, {}); // initialize/otros: no-op en mock
    return wrapJsonRpc(id, mockToolResult(params));
  }

  // Modo REAL: streamable-HTTP del n8n MCP Server oficial (JSON-RPC 2.0).
  // El server responde por SSE (text/event-stream) y requiere Bearer auth; es stateless
  // (no exige handshake initialize ni Mcp-Session-Id). Verificado contra n8n MCP Server v1.1.0.
  const headers = {
    'Content-Type': 'application/json',
    'Accept': 'application/json, text/event-stream',
  };
  if (process.env.N8N_MCP_TOKEN) headers['Authorization'] = `Bearer ${process.env.N8N_MCP_TOKEN}`;

  const res = await fetch(url, {
    method: 'POST',
    headers,
    body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
  });
  if (!res.ok) throw new Error(`MCP HTTP ${res.status} ${res.statusText} (N8N_MCP_URL=${url})`);

  const ctype = res.headers.get('content-type') || '';
  const json = ctype.includes('text/event-stream') ? parseSse(await res.text(), id) : await res.json();
  if (json.error) throw new Error(`MCP error: ${JSON.stringify(json.error)}`);
  return json;
}

// Extrae el mensaje JSON-RPC de una respuesta SSE (`event: message` / `data: {...}`).
// Devuelve el frame cuyo id coincide; si no, el primero con result/error.
function parseSse(text, id) {
  const frames = [];
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^data:\s?(.*)$/);
    if (m && m[1].trim().startsWith('{')) {
      try { frames.push(JSON.parse(m[1])); } catch { /* frame no-JSON, ignorar */ }
    }
  }
  return frames.find((f) => f.id === id) || frames.find((f) => 'result' in f || 'error' in f) || frames[0] || {};
}

module.exports = { callMcp };
