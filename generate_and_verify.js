const fs = require('fs');
const path = require('path');
const { callMcp } = require('../run_mcp_action.js');

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL_NAME = "gemma4:latest";

// Compact SDK Reference to fit context windows of local models
const sdkReference = `
n8n Workflow SDK Usage Cheat Sheet:

Imports:
import { workflow, node, trigger, newCredential, ifElse, switchCase, merge } from '@n8n/workflow-sdk';

Basic Webhook Trigger (v2.1):
const webhook = trigger({
  type: 'n8n-nodes-base.webhook',
  version: 2.1,
  config: {
    name: 'Webhook Trigger',
    parameters: { path: 'webhook-path', httpMethod: 'POST', responseMode: 'onReceived' },
    position: [250, 300]
  },
  output: [{ body: { message: 'hello error' } }]
});

Filter/ifElse Node (v2.2):
const checkError = ifElse({
  version: 2.2,
  config: {
    name: 'Check Error',
    parameters: {
      conditions: {
        options: { caseSensitive: false, typeValidation: 'loose' },
        conditions: [
          {
            leftValue: expr('{{ $json.body?.message ?? $json.message }}'),
            operator: { type: 'string', operation: 'contains' },
            rightValue: 'error'
          }
        ],
        combinator: 'and'
      }
    },
    position: [500, 300]
  }
});

Gmail Node (v2.1):
const sendEmail = node({
  type: 'n8n-nodes-base.gmail',
  version: 2.1,
  config: {
    name: 'Send Gmail Email',
    parameters: {
      resource: 'message',
      operation: 'send',
      sendTo: 'user@example.com',
      subject: 'Error Alert',
      messageType: 'text',
      message: expr('Error: {{ $json.body?.message ?? $json.message }}')
    },
    credentials: { gmailOAuth2: newCredential('Gmail OAuth2') },
    position: [750, 300]
  },
  output: [{ id: '123' }]
});

Chaining Workflow with Conditional Branch:
export default workflow('webhook-filter-gmail', 'Webhook Filter Gmail Workflow')
  .add(webhook)
  .to(checkError
    .onTrue(sendEmail)
  );
`;

async function callOllama(messages) {
  const response = await fetch(OLLAMA_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: MODEL_NAME,
      messages: messages,
      stream: false
    })
  });
  if (!response.ok) {
    throw new Error(`Ollama API call failed: ${response.status} ${response.statusText}`);
  }
  const data = await response.json();
  return data.message.content;
}

// Extract the Javascript code block from the LLM's response
function extractCode(text) {
  let cleaned = text.trim();
  
  // Try to find a code block with or without closing backticks
  const match = cleaned.match(/```(?:javascript|js)?\s*\n([\s\S]*?)(?:```|$)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  
  // Manual fallback cleaning if regex didn't capture properly
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:javascript|js|ts)?\s*/i, '');
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return cleaned.trim();
}

// Generate mock data based on node type
function generateMockDataForNode(nodeType, nodeName) {
  if (nodeType.includes('webhook') || nodeType.includes('manualTrigger')) {
    return [
      {
        json: {
          body: { message: "Hola, este es un webhook de prueba autogenerado." },
          headers: { "user-agent": "n8n-mcp-verifier" },
          query: { test: "true" }
        }
      }
    ];
  }
  if (nodeType.includes('slack')) {
    return [
      {
        json: {
          ok: true,
          channel: "C12345678",
          ts: "1234567890.123456",
          message: { text: "Mensaje de Slack simulado exitosamente." }
        }
      }
    ];
  }
  if (nodeType.includes('gmail')) {
    return [
      {
        json: {
          id: "msg-12345",
          threadId: "thread-12345",
          labelIds: ["SENT"],
          snippet: "Correo de prueba enviado"
        }
      }
    ];
  }
  if (nodeType.includes('httpRequest') || nodeType.includes('http')) {
    return [
      {
        json: {
          status: "success",
          data: { id: 1, title: "Item simulado", completed: false }
        }
      }
    ];
  }
  // Generic fallback mock item
  return [{ json: { status: "simulated", note: `Mock data for ${nodeName} (${nodeType})` } }];
}

async function runWorkflowVerification(prompt) {
  console.log(`\n=== GENERANDO Y VERIFICANDO FLUJO PARA: "${prompt}" ===`);

  const systemPrompt = `You are an expert n8n Workflow SDK code generator. Your task is to generate valid JavaScript code using the '@n8n/workflow-sdk' library.

Here is the SDK Reference with patterns, rules, and examples. Study them closely:
<reference>
${sdkReference}
</reference>

CRITICAL RULES:
1. Return ONLY the complete JavaScript code block inside markdown code tags (e.g. \`\`\`javascript ... \`\`\`).
2. Do not include any explanations, introduction, markdown text, or HTML outside the code block.
3. ALWAYS start the code with the exact import statement:
   import { workflow, node, trigger, newCredential, ifElse, switchCase, merge } from '@n8n/workflow-sdk';
4. ALWAYS finish the code by exporting the compiled workflow as the DEFAULT export:
   export default workflow('workflow-id', 'Workflow Name')
     .add(startTrigger)
     .to(nextNode)...;
5. Always use newCredential('CredentialName') for credentials. Never synthesize raw string IDs for credentials.
6. Ensure the output of each node is fully defined with dummy data to satisfy the validation engine.
7. Use correct node types and versions (e.g. 'n8n-nodes-base.webhook' version 2.1, 'n8n-nodes-base.slack' version 2.5).`;

  let messages = [
    { role: 'system', content: systemPrompt },
    { role: 'user', content: `Crea el flujo SDK de n8n para: ${prompt}` }
  ];

  let code = "";
  let isValid = false;
  let validationResult = null;
  const maxRetries = 3;

  // --- PHASE 1: GENERATION & SELF-CORRECTION LOOP ---
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n[Intento ${attempt}/${maxRetries}] Generando código SDK con Ollama (${MODEL_NAME})...`);
    const llmResponse = await callOllama(messages);
    
    console.log(`\n--- RESPUESTA CRUDA DE OLLAMA (Intento ${attempt}) ---`);
    console.log(llmResponse);
    console.log("-------------------------------------------\n");

    code = extractCode(llmResponse);

    // Log the generated code for visibility
    console.log(`\n--- CÓDIGO EXTRAÍDO (Intento ${attempt}) ---`);
    console.log(code);
    console.log("-------------------------------------------\n");

    // Write file immediately for inspection/debugging
    fs.writeFileSync(path.join(__dirname, `workflow_sdk_generado_intento_${attempt}.js`), code);

    console.log(`[Intento ${attempt}/${maxRetries}] Validando código con el servidor MCP...`);
    validationResult = await callMcp("tools/call", {
      name: "validate_workflow",
      arguments: { code: code }
    });

    const parsedVal = JSON.parse(validationResult.result.content[0].text);
    if (parsedVal.valid) {
      console.log(`[+] ¡Validación exitosa en el intento ${attempt}!`);
      isValid = true;
      break;
    } else {
      console.warn(`[-] Error de validación en el intento ${attempt}:`, JSON.stringify(parsedVal, null, 2));
      
      // Feed errors back to the model for correction
      messages.push({ role: 'assistant', content: llmResponse });
      messages.push({
        role: 'user',
        content: `El código anterior falló la validación con los siguientes errores/advertencias:\n${JSON.stringify(parsedVal, null, 2)}\n\nPor favor corrige el código. Asegúrate de cumplir con todas las reglas, especialmente EXPORTAR el flujo usando 'export default workflow(...)' y tener la importación correcta desde '@n8n/workflow-sdk'. Devuelve solo el código corregido dentro del bloque de javascript.`
      });
    }
  }

  if (!isValid) {
    console.error("[-] No se pudo generar un código válido después de los intentos permitidos.");
    process.exit(1);
  }

  // Save generated code for inspection
  fs.writeFileSync(path.join(__dirname, 'workflow_sdk_generado.js'), code);
  console.log(`[+] Código SDK válido guardado en: n8n-generator/workflow_sdk_generado.js`);

  // --- PHASE 2: CREATION ---
  console.log("\n[Paso 2] Creando el flujo en n8n desde el código SDK validado...");
  const createResult = await callMcp("tools/call", {
    name: "create_workflow_from_code",
    arguments: {
      code: code,
      description: `Flujo autogenerado para: "${prompt}" verificado vía MCP.`
    }
  });

  const createOutput = JSON.parse(createResult.result.content[0].text);
  if (createOutput.isError) {
    console.error("[-] Error al crear el flujo en n8n:", createOutput);
    process.exit(1);
  }

  const workflowId = createOutput.workflowId;
  const workflowName = createOutput.name;
  const workflowUrl = createOutput.url;
  console.log(`[+] Flujo creado con éxito. ID: ${workflowId}, Nombre: ${workflowName}`);
  console.log(`[+] URL en n8n: ${workflowUrl}`);

  // --- PHASE 3: DYNAMIC PIN DATA PREPARATION ---
  console.log("\n[Paso 3] Preparando esquemas de datos simulados (Pin Data)...");
  const prepResult = await callMcp("tools/call", {
    name: "prepare_test_pin_data",
    arguments: { workflowId }
  });

  const prepOutput = JSON.parse(prepResult.result.content[0].text);
  console.log("Respuesta de prepare_test_pin_data:", JSON.stringify(prepOutput, null, 2));

  // Determine which nodes need pin data
  const nodesWithoutSchema = prepOutput.nodesWithoutSchema || [];
  const nodeSchemasToGenerate = prepOutput.nodeSchemasToGenerate || {};
  
  // We combine both to generate simulated data
  const pinData = {};
  
  // 1. Generate for nodes without schema
  for (const nodeName of nodesWithoutSchema) {
    // We try to infer node type from code or use a generic mock
    // For webhook trigger, we identify it by name containing trigger or webhook
    let nodeType = "generic";
    if (nodeName.toLowerCase().includes('webhook') || nodeName.toLowerCase().includes('trigger')) {
      nodeType = "webhook";
    }
    pinData[nodeName] = generateMockDataForNode(nodeType, nodeName);
  }

  // 2. Generate for nodes with schema definitions
  for (const [nodeName, schema] of Object.entries(nodeSchemasToGenerate)) {
    // Generate simple mock data fitting the schema
    pinData[nodeName] = generateMockDataForNode(schema.type || "generic", nodeName);
  }

  console.log("Datos Simulados Dinámicos Generados (pinData):", JSON.stringify(pinData, null, 2));

  // --- PHASE 4: EXECUTION & TEST RUN ---
  console.log("\n[Paso 4] Ejecutando prueba de flujo (test_workflow) con datos dinámicos...");
  const testResult = await callMcp("tools/call", {
    name: "test_workflow",
    arguments: {
      workflowId,
      pinData: pinData
    }
  });

  const testOutput = JSON.parse(testResult.result.content[0].text);
  console.log("Respuesta de test_workflow:", JSON.stringify(testOutput, null, 2));

  console.log(`\n=== RESULTADO FINAL DE LA VERIFICACIÓN ===`);
  console.log(`* Estatus de Ejecución: ${testOutput.status.toUpperCase()}`);
  console.log(`* ID de Ejecución: ${testOutput.executionId}`);
  console.log(`* URL del Lienzo: ${workflowUrl}`);

  // Write a markdown report
  const reportContent = `# Reporte de Verificación Inteligente MCP

Este reporte documenta la autogeneración del flujo, el bucle de validación/corrección de código, y la simulación final.

## 📋 Detalles del Requerimiento
* **Prompt del Usuario:** "${prompt}"
* **Nombre de Flujo Generado:** ${workflowName}
* **ID de Flujo:** ${workflowId}
* **Enlace de n8n:** [Abrir Lienzo de n8n](${workflowUrl})

## 🛠️ Código del SDK de n8n Validado
\`\`\`javascript
${code}
\`\`\`

## 🧪 Simulación (Test Run)
* **ID de Ejecución:** ${testOutput.executionId}
* **Resultado del Test:** **${testOutput.status.toUpperCase()}**
* **Datos Simulados Inyectados (Pin Data):**
\`\`\`json
${JSON.stringify(pinData, null, 2)}
\`\`\`
`;

  const reportPath = path.join(__dirname, '..', 'reporte_autocompletado.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`[+] Reporte de verificación guardado en: reporte_autocompletado.md`);
}

// Execute the process with command line argument prompt
const userPrompt = process.argv.slice(2).join(' ') || "Crea un flujo que se active con un webhook, filtre los mensajes que tengan la palabra 'error', y los envíe por Gmail";
runWorkflowVerification(userPrompt).catch(console.error);
