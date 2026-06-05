import os
import sys
import json
import uuid
import argparse
import ollama

# Mapping of common tool names to official n8n package node names
N8N_NODE_MAPPING = {
    "webhook": "n8n-nodes-base.webhook",
    "slack": "n8n-nodes-base.slack",
    "gmail": "n8n-nodes-base.gmail",
    "google_sheets": "n8n-nodes-base.googleSheets",
    "googlesheets": "n8n-nodes-base.googleSheets",
    "postgres": "n8n-nodes-base.postgres",
    "postgresql": "n8n-nodes-base.postgres",
    "wait": "n8n-nodes-base.wait",
    "if": "n8n-nodes-base.if",
    "telegram": "n8n-nodes-base.telegram"
}

# Define the tool schemas for the model
def add_node(node_type: str, name: str, parameters: dict = None) -> str:
    """
    Creates a new node in the n8n workflow.
    Args:
        node_type: The type of n8n node (e.g. 'webhook', 'slack', 'gmail', 'googlesheets', 'postgres')
        name: A unique name for the node (e.g. 'Webhook_Trigger', 'Slack_Notifier')
        parameters: A dictionary of parameters for the node (e.g. {'channel': '#alerts'})
    """
    return json.dumps({"action": "add_node", "node_type": node_type, "name": name, "parameters": parameters})

def connect_nodes(source_node: str, target_node: str) -> str:
    """
    Connects the output of one node to the input of another node.
    Args:
        source_node: The name of the source node
        target_node: The name of the target node
    """
    return json.dumps({"action": "connect_nodes", "source_node": source_node, "target_node": target_node})


class N8NWorkflowCompiler:
    def __init__(self):
        self.nodes = []
        self.connections = {}
        self.node_positions = {}
        self.grid_x = 250
        self.grid_y = 300

    def add_node_to_workflow(self, node_type: str, name: str = None, parameters: dict = None):
        if not node_type:
            print("[-] Warning: Omitted 'node_type' in add_node call.")
            return
            
        # Sanitize input strings
        node_type = str(node_type).strip()
        
        if not name:
            name = f"{node_type}_{str(uuid.uuid4())[:4]}"
        else:
            name = str(name).strip()
        
        # Resolve clean n8n node name
        resolved_type = N8N_NODE_MAPPING.get(node_type.lower(), node_type)
        if not resolved_type.startswith("n8n-nodes-base."):
            resolved_type = f"n8n-nodes-base.{resolved_type}"
            
        parameters = parameters or {}
        node_id = str(uuid.uuid4())
        
        # Simple automatic layout
        position = [self.grid_x, self.grid_y]
        self.grid_x += 250  # Offset next node to the right
        
        node = {
            "parameters": parameters,
            "id": node_id,
            "name": name,
            "type": resolved_type,
            "typeVersion": 1,
            "position": position
        }
        self.nodes.append(node)
        self.node_positions[name] = position
        print(f"[+] Added Node: '{name}' (Type: {resolved_type}) at position {position}")

    def connect_nodes_in_workflow(self, source_name: str, target_name: str):
        if not source_name or not target_name:
            print("[-] Warning: Omitted source or target in connect_nodes call.")
            return
            
        source_name = str(source_name).strip()
        target_name = str(target_name).strip()
        
        if source_name not in self.connections:
            self.connections[source_name] = {"main": [[]]}
            
        self.connections[source_name]["main"][0].append({
            "node": target_name,
            "type": "main",
            "index": 0
        })
        print(f"[+] Connected: '{source_name}' -> '{target_name}'")

    def compile(self) -> dict:
        return {
            "meta": {
                "instanceId": "local-prototype"
            },
            "nodes": self.nodes,
            "connections": self.connections,
            "active": False,
            "settings": {},
            "tags": []
        }


def generate_workflow(prompt: str, model_name: str, output_file: str):
    print(f"[*] Prompt: '{prompt}'")
    print(f"[*] Using local model: '{model_name}' in Ollama...")
    
    # System prompt to enforce parallel tool calls for complete workflows
    system_prompt = (
        "You are an n8n workflow builder. To complete the user's request, you must call the "
        "necessary tools. Create all the nodes using 'add_node', and link them sequentially "
        "using 'connect_nodes'. Always generate both the nodes and the connections linking them."
    )
    
    messages = [
        {
            "role": "system",
            "content": system_prompt
        },
        # Few-shot Example 1: Webhook to Slack
        {
            "role": "user",
            "content": "Crea un flujo de n8n para este caso: webhook a slack"
        },
        {
            "role": "assistant",
            "content": "",
            "tool_calls": [
                {
                    "type": "function",
                    "function": {
                        "name": "add_node",
                        "arguments": {"node_type": "webhook", "name": "webhook_node"}
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "add_node",
                        "arguments": {"node_type": "slack", "name": "slack_node"}
                    }
                },
                {
                    "type": "function",
                    "function": {
                        "name": "connect_nodes",
                        "arguments": {"source_node": "webhook_node", "target_node": "slack_node"}
                    }
                }
            ]
        },
        # Actual User Prompt
        {
            "role": "user",
            "content": f"Crea un flujo de n8n para este caso: {prompt}"
        }
    ]
    
    try:
        response = ollama.chat(
            model=model_name,
            messages=messages,
            tools=[add_node, connect_nodes]
        )
    except Exception as e:
        print(f"[-] Error calling Ollama: {e}")
        print(f"[-] Ensure Ollama is running and the model '{model_name}' is installed.")
        return False

    compiler = N8NWorkflowCompiler()
    
    if response.message.tool_calls:
        print(f"[+] Model generated {len(response.message.tool_calls)} actions:")
        for tool in response.message.tool_calls:
            args = tool.function.arguments
            name = tool.function.name
            
            if name == "add_node":
                compiler.add_node_to_workflow(
                    node_type=args.get("node_type"),
                    name=args.get("name"),
                    parameters=args.get("parameters")
                )
            elif name == "connect_nodes":
                # Support different potential parameter names from different models
                src = args.get("source_node") or args.get("source")
                tgt = args.get("target_node") or args.get("target")
                compiler.connect_nodes_in_workflow(
                    source_name=src,
                    target_name=tgt
                )
        
        # Save output workflow
        workflow_json = compiler.compile()
        with open(output_file, "w", encoding="utf-8") as f:
            json.dump(workflow_json, f, indent=2, ensure_ascii=False)
            
        print(f"\n[+] SUCCESS: n8n workflow JSON compiled and saved to: {os.path.abspath(output_file)}")
        print("[i] To use it: Open n8n, click 'Workflows' -> 'Import from File' and select this JSON file.")
        return True
    else:
        print("[-] The model did not trigger any tool calls. Response content:")
        print(response.message.content)
        return False

def main():
    parser = argparse.ArgumentParser(description="Generate n8n workflows using Ollama tool calling models.")
    parser.add_argument("prompt", type=str, help="Natural language description of the workflow.")
    parser.add_argument("--model", type=str, default="functiongemma", help="Model to use (e.g. 'functiongemma', 'qwen2.5:0.5b').")
    parser.add_argument("--output", type=str, default="workflow_generado.json", help="Path to save the generated JSON file.")
    args = parser.parse_args()
    
    generate_workflow(args.prompt, args.model, args.output)

if __name__ == "__main__":
    main()
