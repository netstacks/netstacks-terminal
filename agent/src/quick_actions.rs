//! Quick Actions execution engine
//!
//! Handles executing API calls with auth resolution, variable substitution,
//! and JSON path extraction.

use crate::models::*;
use std::collections::HashMap;
use std::time::Instant;

/// Extract a value from JSON using a simple dot-bracket path.
///
/// Supports paths like:
/// - `name` → obj["name"]
/// - `result[0]` → obj["result"][0]
/// - `result[0].name.txrate` → obj["result"][0]["name"]["txrate"]
/// - `data.items[2].value` → obj["data"]["items"][2]["value"]
pub fn json_extract(value: &serde_json::Value, path: &str) -> Option<serde_json::Value> {
    let mut current = value;

    for segment in parse_path_segments(path) {
        match segment {
            PathSegment::Key(key) => {
                current = current.get(&key)?;
            }
            PathSegment::Index(idx) => {
                current = current.get(idx)?;
            }
        }
    }

    Some(current.clone())
}

enum PathSegment {
    Key(String),
    Index(usize),
}

fn parse_path_segments(path: &str) -> Vec<PathSegment> {
    let mut segments = Vec::new();
    let mut chars = path.chars().peekable();
    let mut current_key = String::new();

    while let Some(&ch) = chars.peek() {
        match ch {
            '.' => {
                if !current_key.is_empty() {
                    segments.push(PathSegment::Key(current_key.clone()));
                    current_key.clear();
                }
                chars.next();
            }
            '[' => {
                if !current_key.is_empty() {
                    segments.push(PathSegment::Key(current_key.clone()));
                    current_key.clear();
                }
                chars.next(); // consume '['
                let mut idx_str = String::new();
                while let Some(&c) = chars.peek() {
                    if c == ']' {
                        chars.next();
                        break;
                    }
                    idx_str.push(c);
                    chars.next();
                }
                if let Ok(idx) = idx_str.parse::<usize>() {
                    segments.push(PathSegment::Index(idx));
                } else {
                    // Treat as string key (for map access like ["key"])
                    let key = idx_str.trim_matches('"').trim_matches('\'').to_string();
                    segments.push(PathSegment::Key(key));
                }
            }
            _ => {
                current_key.push(ch);
                chars.next();
            }
        }
    }

    if !current_key.is_empty() {
        segments.push(PathSegment::Key(current_key));
    }

    segments
}

/// Substitute `{{variable}}` placeholders in a string with values from a map.
///
/// AUDIT FIX (EXEC-015): values that contain CR/LF are rejected so they
/// cannot inject HTTP header lines via the header-substitution path. We do
/// the rejection here (in the shared substitution helper) so every call site
/// that ultimately produces an HTTP request benefits.
fn substitute_variables(template: &str, variables: &HashMap<String, String>) -> String {
    let mut result = template.to_string();
    for (key, value) in variables {
        let safe_value = if value.contains('\r') || value.contains('\n') {
            tracing::warn!(
                target: "audit",
                key = %key,
                "quick-action variable contained CR/LF; replaced with literal placeholder"
            );
            "<rejected: CR/LF not allowed in variable value>".to_string()
        } else {
            value.clone()
        };
        result = result.replace(&format!("{{{{{}}}}}", key), &safe_value);
    }
    result
}

/// Build an HTTP client with the resource's SSL and timeout settings.
fn build_http_client(resource: &ApiResource) -> Result<reqwest::Client, String> {
    reqwest::Client::builder()
        .danger_accept_invalid_certs(!resource.verify_ssl)
        .timeout(std::time::Duration::from_secs(resource.timeout_secs as u64))
        .build()
        .map_err(|e| format!("Failed to build HTTP client: {}", e))
}

/// Result of running a single auth-flow step in isolation. Used by the
/// per-step Test button so users can debug each step independently.
#[derive(Debug, Clone, serde::Serialize)]
pub struct AuthStepTestResult {
    /// Whether the step succeeded end-to-end (HTTP success + parse + extract).
    pub success: bool,
    /// HTTP status code returned by the step's URL. 0 if the request failed
    /// before getting a response (network error / DNS / TLS).
    pub status_code: u16,
    /// Final URL the request was sent to (post-substitution), so the user can
    /// see exactly what got hit.
    pub url: String,
    /// First 1000 chars of the response body. Truncated for UI sanity.
    pub response_preview: Option<String>,
    /// The extracted value (the thing that would be stored as the next
    /// variable). Always a string; non-string JSON gets `.to_string()`d.
    pub extracted_value: Option<String>,
    /// The variable name the value would be stored under, mirrored back so
    /// the UI can label it without re-reading the step config.
    pub store_as: String,
    /// Human-readable error if anything went wrong.
    pub error: Option<String>,
    pub duration_ms: u64,
}

/// Execute a single auth-flow step against the given resource and return a
/// rich result for the UI's per-step test feature. Does NOT chain into other
/// steps — it's a debug primitive.
pub async fn test_auth_step(
    resource: &ApiResource,
    credentials: Option<&StoredApiResourceCredential>,
    step: &AuthFlowStep,
    extra_variables: &HashMap<String, String>,
) -> AuthStepTestResult {
    let start = Instant::now();

    // Build base variables from credentials + caller-supplied vars (caller
    // may have additional `{{var}}` placeholders to substitute, e.g. captured
    // outputs from a prior step the user pasted in).
    let mut variables: HashMap<String, String> = HashMap::new();
    if let Some(creds) = credentials {
        if let Some(u) = &creds.username {
            variables.insert("username".to_string(), u.clone());
        }
        if let Some(p) = &creds.password {
            variables.insert("password".to_string(), p.clone());
        }
    }
    for (k, v) in extra_variables {
        variables.insert(k.clone(), v.clone());
    }

    let resolved_path = substitute_variables(&step.path, &variables);
    let url = format!(
        "{}/{}",
        resource.base_url.trim_end_matches('/'),
        resolved_path.trim_start_matches('/'),
    );

    let client = match build_http_client(resource) {
        Ok(c) => c,
        Err(e) => {
            return AuthStepTestResult {
                success: false,
                status_code: 0,
                url,
                response_preview: None,
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!("Failed to build HTTP client: {}", e)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let method: reqwest::Method = match step.method.parse() {
        Ok(m) => m,
        Err(_) => {
            return AuthStepTestResult {
                success: false,
                status_code: 0,
                url,
                response_preview: None,
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!("Invalid HTTP method: {}", step.method)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let mut req = client.request(method, &url);
    for (k, v) in &step.headers {
        req = req.header(k, substitute_variables(v, &variables));
    }
    if step.use_basic_auth {
        match (variables.get("username"), variables.get("password")) {
            (Some(u), Some(p)) if !u.is_empty() => {
                req = req.basic_auth(u, Some(p));
            }
            _ => {
                return AuthStepTestResult {
                    success: false,
                    status_code: 0,
                    url,
                    response_preview: None,
                    extracted_value: None,
                    store_as: step.store_as.clone(),
                    error: Some(
                        "Basic Auth is required by this step but the resource has no username/password stored.".to_string(),
                    ),
                    duration_ms: start.elapsed().as_millis() as u64,
                };
            }
        }
    }
    if let Some(body_template) = &step.body {
        if !body_template.is_empty() {
            let body = substitute_variables(body_template, &variables);
            req = req.header("Content-Type", "application/json").body(body);
        }
    }

    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => {
            return AuthStepTestResult {
                success: false,
                status_code: 0,
                url,
                response_preview: None,
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!("Request failed: {}", e)),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let status = response.status();
    let body_text = response.text().await.unwrap_or_default();
    let preview: String = body_text.chars().take(1000).collect();

    if !status.is_success() {
        return AuthStepTestResult {
            success: false,
            status_code: status.as_u16(),
            url,
            response_preview: Some(preview),
            extracted_value: None,
            store_as: step.store_as.clone(),
            error: Some(format!("Endpoint returned HTTP {}", status)),
            duration_ms: start.elapsed().as_millis() as u64,
        };
    }

    // Parse + extract.
    let json: serde_json::Value = match serde_json::from_str(&body_text) {
        Ok(v) => v,
        Err(e) => {
            return AuthStepTestResult {
                success: false,
                status_code: status.as_u16(),
                url,
                response_preview: Some(preview),
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!(
                    "Response was not JSON ({}). Check the Headers — most APIs require Accept: application/json.",
                    e
                )),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let extracted = match json_extract(&json, &step.extract_path) {
        Some(v) => v,
        None => {
            return AuthStepTestResult {
                success: false,
                status_code: status.as_u16(),
                url,
                response_preview: Some(preview),
                extracted_value: None,
                store_as: step.store_as.clone(),
                error: Some(format!(
                    "Failed to extract '{}' from response. Verify the JSON path matches the response body shown above.",
                    step.extract_path
                )),
                duration_ms: start.elapsed().as_millis() as u64,
            };
        }
    };

    let extracted_str = match &extracted {
        serde_json::Value::String(s) => s.clone(),
        other => other.to_string().trim_matches('"').to_string(),
    };

    AuthStepTestResult {
        success: true,
        status_code: status.as_u16(),
        url,
        response_preview: Some(preview),
        extracted_value: Some(extracted_str),
        store_as: step.store_as.clone(),
        error: None,
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

/// Resolve multi-step authentication, returning extracted variables.
async fn resolve_multi_step_auth(
    client: &reqwest::Client,
    resource: &ApiResource,
    steps: &[AuthFlowStep],
    base_variables: &HashMap<String, String>,
) -> Result<HashMap<String, String>, String> {
    let mut variables = base_variables.clone();

    for (idx, step) in steps.iter().enumerate() {
        let resolved_step_path = substitute_variables(&step.path, &variables);
        let url = format!(
            "{}/{}",
            resource.base_url.trim_end_matches('/'),
            resolved_step_path.trim_start_matches('/'),
        );
        let method: reqwest::Method = step.method.parse()
            .map_err(|_| format!("Invalid HTTP method: {}", step.method))?;

        let mut req = client.request(method, &url);

        // Per-step headers (templated). Applied before body so the body's
        // implicit Content-Type from .body() doesn't get clobbered.
        for (k, v) in &step.headers {
            req = req.header(k, substitute_variables(v, &variables));
        }

        // Optional Basic Auth derived from the resource's stored username/password.
        // Only applied when both are present — otherwise reqwest would send
        // `Authorization: Basic <empty>` which leaks intent without working.
        if step.use_basic_auth {
            match (variables.get("username"), variables.get("password")) {
                (Some(u), Some(p)) if !u.is_empty() => {
                    req = req.basic_auth(u, Some(p));
                }
                _ => {
                    return Err(format!(
                        "Step {} requires Basic Auth but no username/password is stored on the resource",
                        idx + 1
                    ));
                }
            }
        }

        // Add body with variable substitution
        if let Some(body_template) = &step.body {
            if !body_template.is_empty() {
                let body = substitute_variables(body_template, &variables);
                req = req.header("Content-Type", "application/json").body(body);
            }
        }

        let response = req.send().await
            .map_err(|e| format!("Auth step {} failed: {}", idx + 1, e))?;

        let status = response.status();
        let response_text = response.text().await
            .map_err(|e| format!("Auth step {}: failed to read response body: {}", idx + 1, e))?;

        if !status.is_success() {
            // Surface a snippet of the body so the user can see *why* (e.g. login page HTML, error JSON).
            let snippet: String = response_text.chars().take(200).collect();
            return Err(format!(
                "Auth step {} returned HTTP {}: {}",
                idx + 1,
                status,
                snippet
            ));
        }

        let response_json: serde_json::Value = serde_json::from_str(&response_text)
            .map_err(|e| {
                let snippet: String = response_text.chars().take(200).collect();
                format!(
                    "Auth step {}: response was not JSON ({}). First 200 chars: {}",
                    idx + 1, e, snippet
                )
            })?;

        // Extract value and store as variable
        let extracted = json_extract(&response_json, &step.extract_path)
            .ok_or_else(|| format!(
                "Auth step {}: failed to extract '{}' from response",
                idx + 1, step.extract_path
            ))?;

        let extracted_str = match &extracted {
            serde_json::Value::String(s) => s.clone(),
            other => other.to_string().trim_matches('"').to_string(),
        };

        variables.insert(step.store_as.clone(), extracted_str);
    }

    Ok(variables)
}

/// Execute a quick action against its API resource.
///
/// This function:
/// 1. Resolves authentication (including multi-step flows)
/// 2. Substitutes variables in path, headers, and body
/// 3. Makes the HTTP request
/// 4. Extracts a value from the JSON response if json_extract_path is set
pub async fn execute_action(
    resource: &ApiResource,
    credentials: Option<&StoredApiResourceCredential>,
    method: &str,
    path: &str,
    headers: &serde_json::Value,
    body: Option<&str>,
    json_extract_path: Option<&str>,
    user_variables: &HashMap<String, String>,
) -> QuickActionResult {
    let start = Instant::now();

    let client = match build_http_client(resource) {
        Ok(c) => c,
        Err(e) => return QuickActionResult {
            success: false,
            status_code: 0,
            extracted_value: None,
            raw_body: None,
            error: Some(e),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    };

    // Build base variables from decrypted credentials
    let mut variables = HashMap::new();
    if let Some(creds) = credentials {
        if let Some(username) = &creds.username {
            variables.insert("username".to_string(), username.clone());
        }
        if let Some(password) = &creds.password {
            variables.insert("password".to_string(), password.clone());
        }
    }

    // Collect built-in variable names (credentials + auth flow store_as names)
    let mut built_in_keys: std::collections::HashSet<String> = ["username", "password"]
        .iter().map(|s| s.to_string()).collect();
    if let Some(steps) = &resource.auth_flow {
        for step in steps {
            built_in_keys.insert(step.store_as.clone());
        }
    }

    // Merge user-provided variables, but never override built-in vars
    for (key, value) in user_variables {
        if !built_in_keys.contains(key) {
            variables.insert(key.clone(), value.clone());
        }
    }

    // Resolve auth
    match &resource.auth_type {
        ApiResourceAuthType::MultiStep => {
            if let Some(steps) = &resource.auth_flow {
                match resolve_multi_step_auth(&client, resource, steps, &variables).await {
                    Ok(resolved) => variables = resolved,
                    Err(e) => return QuickActionResult {
                        success: false,
                        status_code: 0,
                        extracted_value: None,
                        raw_body: None,
                        error: Some(format!("Auth flow failed: {}", e)),
                        duration_ms: start.elapsed().as_millis() as u64,
                    },
                }
            }
        }
        _ => {}
    }

    // Build the request URL
    let resolved_path = substitute_variables(path, &variables);
    let url = format!(
        "{}/{}",
        resource.base_url.trim_end_matches('/'),
        resolved_path.trim_start_matches('/')
    );

    let http_method: reqwest::Method = match method.parse() {
        Ok(m) => m,
        Err(_) => return QuickActionResult {
            success: false,
            status_code: 0,
            extracted_value: None,
            raw_body: None,
            error: Some(format!("Invalid HTTP method: {}", method)),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    };

    let mut req = client.request(http_method, &url);

    // Apply default headers from resource
    if let Some(obj) = resource.default_headers.as_object() {
        for (k, v) in obj {
            if let Some(val) = v.as_str() {
                req = req.header(k, substitute_variables(val, &variables));
            }
        }
    }

    // Apply action-specific headers
    if let Some(obj) = headers.as_object() {
        for (k, v) in obj {
            if let Some(val) = v.as_str() {
                req = req.header(k, substitute_variables(val, &variables));
            }
        }
    }

    // Apply auth headers using decrypted credentials from vault
    let cred_token = credentials.and_then(|c| c.token.as_deref());
    let cred_username = credentials.and_then(|c| c.username.as_deref());
    let cred_password = credentials.and_then(|c| c.password.as_deref());
    match &resource.auth_type {
        ApiResourceAuthType::BearerToken => {
            if let Some(token) = cred_token {
                req = req.header("Authorization", format!("Bearer {}", token));
            }
        }
        ApiResourceAuthType::Basic => {
            if let (Some(username), Some(password)) = (cred_username, cred_password) {
                req = req.basic_auth(username, Some(password));
            }
        }
        ApiResourceAuthType::ApiKeyHeader => {
            if let (Some(header_name), Some(token)) = (&resource.auth_header_name, cred_token) {
                req = req.header(header_name, token);
            }
        }
        ApiResourceAuthType::MultiStep => {
            // Auth headers come from resolved variables via header templates
        }
        ApiResourceAuthType::None => {}
    }

    // Apply body with variable substitution
    if let Some(body_template) = body {
        let resolved_body = substitute_variables(body_template, &variables);
        req = req.header("Content-Type", "application/json").body(resolved_body);
    }

    // Execute request
    let response = match req.send().await {
        Ok(r) => r,
        Err(e) => return QuickActionResult {
            success: false,
            status_code: 0,
            extracted_value: None,
            raw_body: None,
            error: Some(format!("Request failed: {}", e)),
            duration_ms: start.elapsed().as_millis() as u64,
        },
    };

    let status_code = response.status().as_u16();
    let success = response.status().is_success();

    // Parse response body
    let raw_body: Option<serde_json::Value> = match response.json().await {
        Ok(json) => Some(json),
        Err(_) => None,
    };

    // Extract value if path is specified
    let extracted_value = if let (Some(extract_path), Some(ref body_json)) = (json_extract_path, &raw_body) {
        json_extract(body_json, extract_path)
    } else {
        None
    };

    QuickActionResult {
        success,
        status_code,
        extracted_value,
        raw_body,
        error: if !success { Some(format!("HTTP {}", status_code)) } else { None },
        duration_ms: start.elapsed().as_millis() as u64,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_json_extract_simple_key() {
        let json = serde_json::json!({"name": "test", "value": 42});
        assert_eq!(json_extract(&json, "name"), Some(serde_json::json!("test")));
        assert_eq!(json_extract(&json, "value"), Some(serde_json::json!(42)));
    }

    #[test]
    fn test_json_extract_nested() {
        let json = serde_json::json!({"data": {"name": "test"}});
        assert_eq!(json_extract(&json, "data.name"), Some(serde_json::json!("test")));
    }

    #[test]
    fn test_json_extract_array() {
        let json = serde_json::json!({"result": [{"txrate": 1000}, {"txrate": 2000}]});
        assert_eq!(json_extract(&json, "result[0].txrate"), Some(serde_json::json!(1000)));
        assert_eq!(json_extract(&json, "result[1].txrate"), Some(serde_json::json!(2000)));
    }

    #[test]
    fn test_json_extract_missing() {
        let json = serde_json::json!({"name": "test"});
        assert_eq!(json_extract(&json, "missing"), None);
        assert_eq!(json_extract(&json, "name.nested"), None);
    }

    #[test]
    fn test_substitute_variables() {
        let mut vars = HashMap::new();
        vars.insert("username".to_string(), "admin".to_string());
        vars.insert("token".to_string(), "abc123".to_string());

        assert_eq!(
            substitute_variables("Bearer {{token}}", &vars),
            "Bearer abc123"
        );
        assert_eq!(
            substitute_variables("/api/users/{{username}}/data", &vars),
            "/api/users/admin/data"
        );
    }
}
