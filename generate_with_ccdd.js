const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { callMcp } = require('../run_mcp_action.js');

const OLLAMA_URL = "http://localhost:11434/api/chat";
const MODEL_NAME = "qwen2.5:1.5b";
const PYTHON_PATH = "C:/Users/Administrador/.gemini/antigravity/scratch/functiongemma-tuning-lab/venv/Scripts/python.exe";
const CCDD_PATH = "C:/Users/Administrador/.gemini/antigravity/scratch/ccdd/ccdd_reference/ccdd.py";

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

function extractCode(text) {
  let cleaned = text.trim();
  const match = cleaned.match(/```(?:javascript|js)?\s*\n([\s\S]*?)(?:```|$)/i);
  if (match && match[1]) {
    return match[1].trim();
  }
  if (cleaned.startsWith('```')) {
    cleaned = cleaned.replace(/^```(?:javascript|js|ts)?\s*/i, '');
  }
  if (cleaned.endsWith('```')) {
    cleaned = cleaned.substring(0, cleaned.length - 3);
  }
  return cleaned.trim();
}

function generateMockDataForNode(nodeType, nodeName) {
  if (nodeType.includes('webhook') || nodeType.includes('manualTrigger')) {
    return [
      {
        json: {
          body: { message: "Hola, este es un webhook de prueba autogenerado bajo CCDD." },
          headers: { "user-agent": "n8n-mcp-ccdd-verifier" },
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
          message: { text: "Slack mock data." }
        }
      }
    ];
  }
  if (nodeType.includes('gmail')) {
    return [
      {
        json: {
          id: "msg-12345",
          snippet: "Correo de prueba CCDD enviado"
        }
      }
    ];
  }
  return [{ json: { status: "simulated", note: `Mock data for ${nodeName}` } }];
}

async function runCCDDWorkflowGeneration(prompt) {
  console.log(`\n=== INICIANDO PIPELINE CCDD PARA: "${prompt}" ===`);

  // Step 1: Query credentials from MCP server to inject dynamically
  console.log("[Paso 1] Recuperando credenciales de la instancia n8n local...");
  let credentialsListStr = "Ninguna credencial disponible.";
  try {
    const credResult = await callMcp("tools/call", { name: "list_credentials", arguments: {} });
    const credOutput = JSON.parse(credResult.result.content[0].text);
    if (credOutput && credOutput.length > 0) {
      credentialsListStr = credOutput.map(c => `- ID: ${c.id}, Name: ${c.name}, Type: ${c.type}`).join('\n');
    }
  } catch (e) {
    console.warn("[-] Warning: could not list credentials via MCP:", e.message);
  }

  // Step 2: Write inputs.json for CCDD
  const inputs = {
    user_prompt: prompt,
    available_credentials: `CREDENCIALES DISPONIBLES EN LA INSTANCIA (usá los IDs exactamente):\n${credentialsListStr}`
  };
  const inputsPath = path.join(__dirname, 'inputs.json');
  fs.writeFileSync(inputsPath, JSON.stringify(inputs, null, 2));
  console.log(`[Paso 2] Datos de entrada de runtime escritos en inputs.json`);

  // Step 3: Run CCDD assemble tool
  console.log("[Paso 3] Ejecutando ensamble de contexto y validación de guardrails de CCDD...");
  try {
    const cmd = `"${PYTHON_PATH}" "${CCDD_PATH}" assemble "${__dirname}" --inputs "${inputsPath}"`;
    const execOut = execSync(cmd, { encoding: 'utf-8' });
    console.log(execOut);
  } catch (err) {
    console.error("[-] ERROR: CCDD Assemble fue abortado o bloqueado por guardrail!");
    console.error(err.stdout || err.message);
    process.exit(2);
  }

  // Step 4: Read the assembled payload from last-assembly.json
  const lastAssemblyPath = path.join(__dirname, 'last-assembly.json');
  const lastAssembly = JSON.parse(fs.readFileSync(lastAssemblyPath, 'utf-8'));
  const promptPayload = lastAssembly.payload;
  console.log(`[+] Ensamble exitoso. Hash del Payload: ${lastAssembly.payload_sha256}`);

  // Step 5: Call Ollama with self-correction loop
  let messages = [
    { role: 'user', content: promptPayload }
  ];
  let code = "";
  let isValid = false;
  const maxRetries = 3;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    console.log(`\n[Paso 5 - Intento ${attempt}/${maxRetries}] Consultando modelo local (${MODEL_NAME})...`);
    try {
      const llmResponse = await callOllama(messages);
      code = extractCode(llmResponse);

      console.log(`\n--- CÓDIGO GENERADO (Intento ${attempt}) ---`);
      console.log(code);
      console.log("-------------------------------------------\n");

      // Step 6: Validate generated code
      console.log(`[Paso 6 - Intento ${attempt}/${maxRetries}] Validando código del SDK vía MCP...`);
      const valResult = await callMcp("tools/call", {
        name: "validate_workflow",
        arguments: { code: code }
      });

      const parsedVal = JSON.parse(valResult.result.content[0].text);
      if (parsedVal.valid) {
        console.log(`[+] ¡Validación exitosa en el intento ${attempt}!`);
        isValid = true;
        break;
      } else {
        console.warn(`[-] Error de validación en el intento ${attempt}:`, JSON.stringify(parsedVal, null, 2));
        messages.push({ role: 'assistant', content: llmResponse });
        messages.push({
          role: 'user',
          content: `El código anterior falló la validación con los siguientes errores/advertencias:\n${JSON.stringify(parsedVal, null, 2)}\n\nPor favor corrige el código. Asegúrate de corregir los tokens inesperados, equilibrar los paréntesis/llaves, y exportar usando 'export default workflow(...)'. Devuelve SOLO el código corregido dentro del bloque de javascript.`
        });
      }
    } catch (e) {
      console.error(`[-] Error en el intento ${attempt}:`, e.message);
    }
  }

  if (!isValid) {
    console.error("[-] No se pudo generar un código válido después de los intentos permitidos.");
    process.exit(1);
  }


  // Step 7: Create workflow in n8n
  console.log("[Paso 7] Creando flujo en n8n...");
  const createResult = await callMcp("tools/call", {
    name: "create_workflow_from_code",
    arguments: {
      code: code,
      description: `Flujo autogenerado bajo CCDD para: "${prompt}"`
    }
  });

  const createOutput = JSON.parse(createResult.result.content[0].text);
  const workflowId = createOutput.workflowId;
  const workflowName = createOutput.name;
  const workflowUrl = createOutput.url;
  console.log(`[+] Flujo creado con éxito. ID: ${workflowId}, Nombre: ${workflowName}`);
  console.log(`[+] URL en n8n: ${workflowUrl}`);

  // Step 8: Prepare Pin Data
  console.log("[Paso 8] Preparando pin data...");
  const prepResult = await callMcp("tools/call", {
    name: "prepare_test_pin_data",
    arguments: { workflowId }
  });
  const prepOutput = JSON.parse(prepResult.result.content[0].text);
  const nodesWithoutSchema = prepOutput.nodesWithoutSchema || [];
  
  const pinData = {};
  for (const nodeName of nodesWithoutSchema) {
    let nodeType = "generic";
    if (nodeName.toLowerCase().includes('webhook') || nodeName.toLowerCase().includes('trigger')) {
      nodeType = "webhook";
    } else if (nodeName.toLowerCase().includes('slack')) {
      nodeType = "slack";
    } else if (nodeName.toLowerCase().includes('gmail')) {
      nodeType = "gmail";
    }
    pinData[nodeName] = generateMockDataForNode(nodeType, nodeName);
  }

  // Step 9: Run test run
  console.log("[Paso 9] Ejecutando simulación de test_workflow...");
  const testResult = await callMcp("tools/call", {
    name: "test_workflow",
    arguments: {
      workflowId,
      pinData: pinData
    }
  });

  const testOutput = JSON.parse(testResult.result.content[0].text);
  console.log(`\n=== RESULTADO FINAL PIPELINE CCDD ===`);
  console.log(`* Estatus: ${testOutput.status.toUpperCase()}`);
  console.log(`* ID de Ejecución: ${testOutput.executionId}`);
  console.log(`* URL del Lienzo: ${workflowUrl}`);

  // Write a markdown report
  const reportContent = `# Reporte de Verificación CCDD + n8n

Este reporte documenta el ciclo de vida del flujo bajo la metodología CCDD.

## Detalles del Contrato de Contexto (CCDD)
* **Nombre de Contrato:** n8n-workflow-generator
* **Tokens Usados:** ${lastAssembly.tokens_used} / ${lastAssembly.tokens_available} tokens
* **Hash del Payload:** ${lastAssembly.payload_sha256}

## Detalles del Flujo Creado
* **Nombre:** ${workflowName}
* **ID:** ${workflowId}
* **URL:** [Lienzo de n8n](${workflowUrl})

## Código SDK Validado
\`\`\`javascript
${code}
\`\`\`

## Simulación de Ejecución (Test Run)
* **ID de Ejecución:** ${testOutput.executionId}
* **Resultado:** **${testOutput.status.toUpperCase()}**
* **Mocks de Pin Data Inyectados:**
\`\`\`json
${JSON.stringify(pinData, null, 2)}
\`\`\`
`;

  const reportPath = path.join(__dirname, 'reporte_ccdd_final.md');
  fs.writeFileSync(reportPath, reportContent);
  console.log(`[+] Reporte CCDD escrito en: n8n-generator/reporte_ccdd_final.md`);
}

const userPrompt = process.argv.slice(2).join(' ') || "Crea un flujo que se active con un webhook, filtre por la palabra 'error', y envíe por Gmail";
runCCDDWorkflowGeneration(userPrompt).catch(console.error);
