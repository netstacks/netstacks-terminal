//! OAuth2 token management for AI providers.
//!
//! Supports client_credentials grant type for enterprise API gateways
//! like Apigee that sit in front of AI services (Vertex AI, etc.).
//!
//! Tokens are cached in-memory and refreshed automatically before expiry.

use serde::{Deserialize, Serialize};
use std::sync::Arc;
use std::time::{Duration, Instant};
use tokio::sync::RwLock;

/// OAuth2 configuration for client_credentials grant.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OAuth2Config {
    /// Token endpoint URL (e.g., "https://api.example.com/oauth/token")
    pub token_url: String,
    /// OAuth2 client ID
    pub client_id: String,
    /// OAuth2 client secret
    pub client_secret: String,
    /// Additional custom headers to include on API requests (e.g., user_email)
    #[serde(default)]
    pub custom_headers: std::collections::HashMap<String, String>,
}

/// A cached OAuth2 token with expiry tracking.
#[derive(Debug, Clone)]
struct CachedToken {
    access_token: String,
    /// When this token was fetched
    fetched_at: Instant,
    /// How long the token is valid (from the server's expires_in field)
    expires_in: Duration,
}

impl CachedToken {
    /// Check if the token is still valid (with 60-second safety margin).
    fn is_valid(&self) -> bool {
        let elapsed = self.fetched_at.elapsed();
        let margin = Duration::from_secs(60);
        elapsed + margin < self.expires_in
    }
}

/// Token response from OAuth2 token endpoint.
#[derive(Debug, Deserialize)]
struct TokenResponse {
    access_token: String,
    #[serde(default = "default_expires_in")]
    expires_in: u64,
    #[allow(dead_code)]
    token_type: Option<String>,
}

fn default_expires_in() -> u64 {
    1800 // 30 minutes default
}

/// Manages OAuth2 tokens with automatic caching and refresh.
///
/// Thread-safe — can be shared across async tasks via Arc.
#[derive(Clone)]
pub struct OAuth2TokenManager {
    config: OAuth2Config,
    client: reqwest::Client,
    cached_token: Arc<RwLock<Option<CachedToken>>>,
}

impl OAuth2TokenManager {
    /// Create a new token manager with the given OAuth2 configuration.
    pub fn new(config: OAuth2Config) -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(15))
            .danger_accept_invalid_certs(true) // Token endpoints may use self-signed certs
            .build()
            .expect("Failed to create HTTP client for OAuth2");

        Self {
            config,
            client,
            cached_token: Arc::new(RwLock::new(None)),
        }
    }

    /// Get a valid access token, fetching or refreshing as needed.
    pub async fn get_token(&self) -> Result<String, OAuth2Error> {
        // Check cached token first (read lock)
        {
            let cache = self.cached_token.read().await;
            if let Some(ref token) = *cache {
                if token.is_valid() {
                    return Ok(token.access_token.clone());
                }
            }
        }

        // Token expired or missing — fetch a new one (write lock)
        let mut cache = self.cached_token.write().await;
        // Double-check after acquiring write lock (another task may have refreshed)
        if let Some(ref token) = *cache {
            if token.is_valid() {
                return Ok(token.access_token.clone());
            }
        }

        tracing::info!("OAuth2: fetching new token from {}", self.config.token_url);
        let new_token = self.fetch_token().await?;
        let access_token = new_token.access_token.clone();
        *cache = Some(new_token);
        Ok(access_token)
    }

    /// Invalidate the cached token (e.g., after a 401 response).
    pub async fn invalidate(&self) {
        let mut cache = self.cached_token.write().await;
        *cache = None;
        tracing::info!("OAuth2: token invalidated, will re-fetch on next request");
    }

    /// Fetch a new token from the OAuth2 token endpoint using client_credentials grant.
    async fn fetch_token(&self) -> Result<CachedToken, OAuth2Error> {
        let response = self
            .client
            .post(&self.config.token_url)
            .basic_auth(&self.config.client_id, Some(&self.config.client_secret))
            .form(&[("grant_type", "client_credentials")])
            .send()
            .await
            .map_err(|e| OAuth2Error::RequestFailed(format!("Token request failed: {}", e)))?;

        let status = response.status();
        if !status.is_success() {
            let body = response.text().await.unwrap_or_default();
            return Err(OAuth2Error::TokenError(format!(
                "Token endpoint returned {}: {}",
                status, body
            )));
        }

        let token_response: TokenResponse = response
            .json()
            .await
            .map_err(|e| OAuth2Error::ParseError(format!("Failed to parse token response: {}", e)))?;

        tracing::info!(
            "OAuth2: token acquired, expires in {} seconds",
            token_response.expires_in
        );

        Ok(CachedToken {
            access_token: token_response.access_token,
            fetched_at: Instant::now(),
            expires_in: Duration::from_secs(token_response.expires_in),
        })
    }
}

/// Errors that can occur during OAuth2 token management.
#[derive(Debug, thiserror::Error)]
pub enum OAuth2Error {
    #[error("OAuth2 request failed: {0}")]
    RequestFailed(String),

    #[error("OAuth2 token error: {0}")]
    TokenError(String),

    #[error("OAuth2 parse error: {0}")]
    ParseError(String),
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_cached_token_validity() {
        let token = CachedToken {
            access_token: "test".to_string(),
            fetched_at: Instant::now(),
            expires_in: Duration::from_secs(3600),
        };
        assert!(token.is_valid());
    }

    #[test]
    fn test_cached_token_expired() {
        let token = CachedToken {
            access_token: "test".to_string(),
            fetched_at: Instant::now() - Duration::from_secs(3700),
            expires_in: Duration::from_secs(3600),
        };
        assert!(!token.is_valid());
    }
}
