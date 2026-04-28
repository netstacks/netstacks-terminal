//! MCP Client Manager for connecting to external MCP servers
//!
//! Manages connections to MCP servers via child process transport,
//! discovers available tools, and invokes tool calls.

use rmcp::{ServiceExt, model::*, transport::TokioChildProcess};
use rmcp::transport::streamable_http_client::StreamableHttpClientTransport;
use tokio::process::Command;
use std::collections::HashMap;
use tokio::sync::RwLock;
use serde::{Deserialize, Serialize};

/// Configuration for an MCP server connection
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpServerConfig {
    pub id: String,
    pub name: String,
    pub transport_type: String,      // "stdio" or "sse"
    pub command: String,             // For stdio transport
    pub args: Vec<String>,           // For stdio transport
    pub url: Option<String>,         // For sse transport
    pub auth_type: String,           // "none", "bearer", "api-key"
    pub auth_token: Option<String>,  // Token/key value
    pub server_type: String,         // Category for AI context
    pub enabled: bool,
}

/// A discovered tool from an MCP server
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct McpTool {
    pub id: String,
    pub server_id: String,
    pub name: String,
    pub description: Option<String>,
    pub input_schema: serde_json::Value,
    pub enabled: bool,
}

/// Errors that can occur during MCP operations
#[derive(Debug, thiserror::Error)]
pub enum McpError {
    #[error("Server not connected: {0}")]
    ServerNotConnected(String),
    #[error("Connection failed: {0}")]
    ConnectionFailed(String),
    #[error("Tool call failed: {0}")]
    ToolCallFailed(String),
    #[error("IO error: {0}")]
    Io(#[from] std::io::Error),
}

/// An active connection to an MCP server
pub struct McpServerConnection {
    pub config: McpServerConfig,
    pub client: rmcp::service::RunningService<rmcp::RoleClient, ()>,
    pub tools: Vec<rmcp::model::Tool>,
}

/// Helper function to convert rmcp input_schema (Arc<Map>) to serde_json::Value
fn schema_to_json(schema: &std::sync::Arc<serde_json::Map<String, serde_json::Value>>) -> serde_json::Value {
    serde_json::Value::Object((**schema).clone())
}

/// Manages connections to multiple MCP servers
pub struct McpClientManager {
    servers: RwLock<HashMap<String, McpServerConnection>>,
}

impl McpClientManager {
    /// Create a new MCP client manager
    pub fn new() -> Self {
        Self {
            servers: RwLock::new(HashMap::new()),
        }
    }

    /// Connect to an MCP server and discover its tools
    pub async fn connect(&self, config: McpServerConfig) -> Result<Vec<McpTool>, McpError> {
        let client = match config.transport_type.as_str() {
            "sse" => {
                let url = config.url.as_deref().ok_or_else(|| {
                    McpError::ConnectionFailed("URL is required for SSE transport".to_string())
                })?;

                tracing::info!(
                    "Connecting to MCP server '{}' via SSE: {}",
                    config.name, url
                );

                // Build transport config with auth
                let mut transport_config = rmcp::transport::streamable_http_client::StreamableHttpClientTransportConfig::with_uri(url);

                match (config.auth_type.as_str(), &config.auth_token) {
                    ("bearer", Some(token)) => {
                        transport_config = transport_config.auth_header(format!("Bearer {}", token));
                    }
                    ("api-key", Some(token)) => {
                        transport_config = transport_config.auth_header(token.clone());
                    }
                    _ => {}
                }

                let transport = StreamableHttpClientTransport::with_client(
                    reqwest::Client::new(),
                    transport_config,
                );

                ().serve(transport).await
                    .map_err(|e| McpError::ConnectionFailed(e.to_string()))?
            }
            _ => {
                // stdio transport (default)
                let mut cmd = Command::new(&config.command);
                for arg in &config.args {
                    cmd.arg(arg);
                }

                tracing::info!(
                    "Connecting to MCP server '{}': {} {:?}",
                    config.name, config.command, config.args
                );

                let transport = TokioChildProcess::new(cmd)
                    .map_err(|e| McpError::ConnectionFailed(e.to_string()))?;

                ().serve(transport).await
                    .map_err(|e| McpError::ConnectionFailed(e.to_string()))?
            }
        };

        // Discover tools
        let tools_response = client.list_tools(Default::default()).await
            .map_err(|e| McpError::ConnectionFailed(e.to_string()))?;

        tracing::info!(
            "MCP server '{}' connected, discovered {} tools",
            config.name, tools_response.tools.len()
        );

        // Convert to McpTool structs
        let mcp_tools: Vec<McpTool> = tools_response.tools.iter().map(|t| {
            let name: String = t.name.clone().into();
            McpTool {
                id: format!("{}:{}", config.id, name),
                server_id: config.id.clone(),
                name,
                description: t.description.clone().map(|s| s.into()),
                input_schema: schema_to_json(&t.input_schema),
                enabled: false, // Tools disabled by default until approved
            }
        }).collect();

        // Store connection
        let conn = McpServerConnection {
            config: config.clone(),
            client,
            tools: tools_response.tools,
        };

        self.servers.write().await.insert(config.id.clone(), conn);

        Ok(mcp_tools)
    }

    /// Disconnect from an MCP server
    pub async fn disconnect(&self, server_id: &str) -> Result<(), McpError> {
        let mut servers = self.servers.write().await;
        if let Some(conn) = servers.remove(server_id) {
            tracing::info!("Disconnected from MCP server '{}'", conn.config.name);
        }
        Ok(())
    }

    /// List IDs of all connected servers
    pub async fn _list_connected(&self) -> Vec<String> {
        self.servers.read().await.keys().cloned().collect()
    }

    /// Check if a server is connected
    pub async fn is_connected(&self, server_id: &str) -> bool {
        self.servers.read().await.contains_key(server_id)
    }

    /// Get tools for a connected server
    pub async fn _get_server_tools(&self, server_id: &str) -> Result<Vec<McpTool>, McpError> {
        let servers = self.servers.read().await;
        let conn = servers.get(server_id)
            .ok_or_else(|| McpError::ServerNotConnected(server_id.to_string()))?;

        let tools = conn.tools.iter().map(|t| {
            let name: String = t.name.clone().into();
            McpTool {
                id: format!("{}:{}", server_id, name),
                server_id: server_id.to_string(),
                name,
                description: t.description.clone().map(|s| s.into()),
                input_schema: schema_to_json(&t.input_schema),
                enabled: false,
            }
        }).collect();

        Ok(tools)
    }

    /// Call a tool on a connected MCP server
    #[allow(dead_code)]
    pub async fn call_tool(
        &self,
        server_id: &str,
        tool_name: &str,
        arguments: serde_json::Value,
    ) -> Result<CallToolResult, McpError> {
        let servers = self.servers.read().await;
        let conn = servers.get(server_id)
            .ok_or_else(|| McpError::ServerNotConnected(server_id.to_string()))?;

        tracing::debug!(
            "Calling MCP tool '{}' on server '{}'",
            tool_name, conn.config.name
        );

        // Convert tool_name to owned String for the request
        let tool_name_owned: String = tool_name.to_string();
        let result = conn.client.call_tool(CallToolRequestParams {
            meta: None,
            name: tool_name_owned.into(),
            arguments: arguments.as_object().cloned(),
            task: None,
        }).await
            .map_err(|e| McpError::ToolCallFailed(e.to_string()))?;

        Ok(result)
    }

    /// Get all tools from all connected servers
    #[allow(dead_code)]
    pub async fn list_all_tools(&self) -> Vec<McpTool> {
        let servers = self.servers.read().await;
        let mut all_tools = Vec::new();

        for (server_id, conn) in servers.iter() {
            for tool in &conn.tools {
                let name: String = tool.name.clone().into();
                all_tools.push(McpTool {
                    id: format!("{}:{}", server_id, name),
                    server_id: server_id.clone(),
                    name,
                    description: tool.description.clone().map(|s| s.into()),
                    input_schema: schema_to_json(&tool.input_schema),
                    enabled: false,
                });
            }
        }

        all_tools
    }
}

impl Default for McpClientManager {
    fn default() -> Self {
        Self::new()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_mcp_server_config_serialization() {
        let config = McpServerConfig {
            id: "test-id".to_string(),
            name: "Test Server".to_string(),
            transport_type: "stdio".to_string(),
            command: "npx".to_string(),
            args: vec!["-y".to_string(), "@modelcontextprotocol/server-filesystem".to_string()],
            url: None,
            auth_type: "none".to_string(),
            auth_token: None,
            server_type: "filesystem".to_string(),
            enabled: true,
        };

        let json = serde_json::to_string(&config).unwrap();
        let parsed: McpServerConfig = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.id, config.id);
        assert_eq!(parsed.name, config.name);
        assert_eq!(parsed.transport_type, "stdio");
        assert_eq!(parsed.command, config.command);
        assert_eq!(parsed.args, config.args);
        assert_eq!(parsed.server_type, "filesystem");
    }

    #[test]
    fn test_mcp_tool_serialization() {
        let tool = McpTool {
            id: "server:tool".to_string(),
            server_id: "server".to_string(),
            name: "read_file".to_string(),
            description: Some("Read a file from disk".to_string()),
            input_schema: serde_json::json!({
                "type": "object",
                "properties": {
                    "path": { "type": "string" }
                }
            }),
            enabled: false,
        };

        let json = serde_json::to_string(&tool).unwrap();
        let parsed: McpTool = serde_json::from_str(&json).unwrap();
        assert_eq!(parsed.name, tool.name);
        assert_eq!(parsed.description, tool.description);
    }
}
