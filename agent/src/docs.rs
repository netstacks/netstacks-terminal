//! Documents module for managing outputs, templates, backups, and history
//!
//! Handles CRUD operations for documents with category-based organization.

use axum::{
    extract::{Path, Query, State},
    http::StatusCode,
    Json,
};
use chrono::Utc;
use serde::{Deserialize, Serialize};
use sqlx::sqlite::SqlitePool;
use sqlx::FromRow;
use std::sync::Arc;
use uuid::Uuid;

use crate::models::{format_datetime, parse_datetime, ContentType, Document, DocumentCategory, DocumentVersion, DocumentVersionMeta, NewDocument, UpdateDocument};

/// Documents state containing database pool
pub struct DocsState {
    pub pool: SqlitePool,
}

/// Internal row type for documents from SQLite
#[derive(Debug, FromRow)]
struct DocumentRow {
    id: String,
    name: String,
    category: String,
    content_type: String,
    content: String,
    parent_folder: Option<String>,
    session_id: Option<String>,
    created_at: String,
    updated_at: String,
}

impl DocumentRow {
    fn into_document(self) -> Result<Document, String> {
        let category = DocumentCategory::from_str(&self.category)
            .ok_or_else(|| format!("Invalid category: {}", self.category))?;
        let content_type = ContentType::from_str(&self.content_type)
            .ok_or_else(|| format!("Invalid content_type: {}", self.content_type))?;

        Ok(Document {
            id: self.id,
            name: self.name,
            category,
            content_type,
            content: self.content,
            parent_folder: self.parent_folder,
            session_id: self.session_id,
            created_at: parse_datetime(&self.created_at)?,
            updated_at: parse_datetime(&self.updated_at)?,
        })
    }
}

/// Internal row type for document versions from SQLite
#[derive(Debug, FromRow)]
struct DocumentVersionRow {
    id: String,
    document_id: String,
    content: String,
    created_at: String,
}

impl DocumentVersionRow {
    fn into_version(self) -> Result<DocumentVersion, String> {
        Ok(DocumentVersion {
            id: self.id,
            document_id: self.document_id,
            content: self.content,
            created_at: parse_datetime(&self.created_at)?,
        })
    }

    fn into_version_meta(self) -> Result<DocumentVersionMeta, String> {
        Ok(DocumentVersionMeta {
            id: self.id,
            document_id: self.document_id,
            created_at: parse_datetime(&self.created_at)?,
        })
    }
}


/// API error response
#[derive(Debug, Serialize)]
pub struct DocsError {
    pub error: String,
    pub code: String,
}

impl axum::response::IntoResponse for DocsError {
    fn into_response(self) -> axum::response::Response {
        let status = match self.code.as_str() {
            "NOT_FOUND" => StatusCode::NOT_FOUND,
            "VALIDATION" => StatusCode::BAD_REQUEST,
            _ => StatusCode::INTERNAL_SERVER_ERROR,
        };
        (status, Json(self)).into_response()
    }
}

/// Query parameters for listing documents
#[derive(Debug, Deserialize)]
pub struct ListDocsQuery {
    pub category: Option<String>,
    pub parent_folder: Option<String>,
}

// === Document Endpoints ===

/// List all documents with optional filters
pub async fn list_documents(
    State(state): State<Arc<DocsState>>,
    Query(query): Query<ListDocsQuery>,
) -> Result<Json<Vec<Document>>, DocsError> {
    let rows: Vec<DocumentRow> = match (&query.category, &query.parent_folder) {
        (Some(category), Some(folder)) => {
            sqlx::query_as(
                "SELECT * FROM documents WHERE category = ? AND parent_folder = ? ORDER BY name",
            )
            .bind(category)
            .bind(folder)
            .fetch_all(&state.pool)
            .await
        }
        (Some(category), None) => {
            sqlx::query_as("SELECT * FROM documents WHERE category = ? ORDER BY name")
                .bind(category)
                .fetch_all(&state.pool)
                .await
        }
        (None, Some(folder)) => {
            sqlx::query_as("SELECT * FROM documents WHERE parent_folder = ? ORDER BY name")
                .bind(folder)
                .fetch_all(&state.pool)
                .await
        }
        (None, None) => {
            sqlx::query_as("SELECT * FROM documents ORDER BY category, name")
                .fetch_all(&state.pool)
                .await
        }
    }
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let documents: Result<Vec<Document>, _> = rows.into_iter().map(|r| r.into_document()).collect();
    documents.map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Get a single document
pub async fn get_document(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
) -> Result<Json<Document>, DocsError> {
    let row: DocumentRow = sqlx::query_as("SELECT * FROM documents WHERE id = ?")
        .bind(&id)
        .fetch_optional(&state.pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    row.into_document().map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Create a new document
pub async fn create_document(
    State(state): State<Arc<DocsState>>,
    Json(new_doc): Json<NewDocument>,
) -> Result<(StatusCode, Json<Document>), DocsError> {
    let id = Uuid::new_v4().to_string();
    let now = format_datetime(&Utc::now());

    sqlx::query(
        r#"
        INSERT INTO documents (id, name, category, content_type, content, parent_folder, session_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        "#,
    )
    .bind(&id)
    .bind(&new_doc.name)
    .bind(new_doc.category.as_str())
    .bind(new_doc.content_type.as_str())
    .bind(&new_doc.content)
    .bind(&new_doc.parent_folder)
    .bind(&new_doc.session_id)
    .bind(&now)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let doc = get_document_by_id(&state.pool, &id).await?;
    Ok((StatusCode::CREATED, Json(doc)))
}

/// Update an existing document
pub async fn update_document(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
    Json(update): Json<UpdateDocument>,
) -> Result<Json<Document>, DocsError> {
    // Verify document exists and get current content
    let current = get_document_by_id(&state.pool, &id).await?;
    let now = format_datetime(&Utc::now());

    // Create a version from the current content before updating
    let version_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO document_versions (id, document_id, content, created_at)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(&version_id)
    .bind(&id)
    .bind(&current.content)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let name = update.name.unwrap_or(current.name);
    let category = update.category.unwrap_or(current.category);
    let content_type = update.content_type.unwrap_or(current.content_type);
    let content = update.content.unwrap_or(current.content);
    let parent_folder = match update.parent_folder {
        Some(v) => v,
        None => current.parent_folder,
    };
    let session_id = match update.session_id {
        Some(v) => v,
        None => current.session_id,
    };

    sqlx::query(
        r#"
        UPDATE documents
        SET name = ?, category = ?, content_type = ?, content = ?, parent_folder = ?, session_id = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&name)
    .bind(category.as_str())
    .bind(content_type.as_str())
    .bind(&content)
    .bind(&parent_folder)
    .bind(&session_id)
    .bind(&now)
    .bind(&id)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let doc = get_document_by_id(&state.pool, &id).await?;
    Ok(Json(doc))
}

/// Delete a document
pub async fn delete_document(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
) -> Result<StatusCode, DocsError> {
    let result = sqlx::query("DELETE FROM documents WHERE id = ?")
        .bind(&id)
        .execute(&state.pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?;

    if result.rows_affected() == 0 {
        return Err(DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        });
    }

    Ok(StatusCode::NO_CONTENT)
}

/// Helper to get a document by ID
async fn get_document_by_id(pool: &SqlitePool, id: &str) -> Result<Document, DocsError> {
    let row: DocumentRow = sqlx::query_as("SELECT * FROM documents WHERE id = ?")
        .bind(id)
        .fetch_optional(pool)
        .await
        .map_err(|e| DocsError {
            error: e.to_string(),
            code: "DATABASE_ERROR".to_string(),
        })?
        .ok_or_else(|| DocsError {
            error: format!("Document not found: {}", id),
            code: "NOT_FOUND".to_string(),
        })?;

    row.into_document().map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

// === Version History Endpoints ===

/// List all versions of a document (metadata only, no content)
pub async fn list_versions(
    State(state): State<Arc<DocsState>>,
    Path(document_id): Path<String>,
) -> Result<Json<Vec<DocumentVersionMeta>>, DocsError> {
    // Verify document exists
    let _ = get_document_by_id(&state.pool, &document_id).await?;

    let rows: Vec<DocumentVersionRow> = sqlx::query_as(
        "SELECT id, document_id, content, created_at FROM document_versions WHERE document_id = ? ORDER BY created_at DESC",
    )
    .bind(&document_id)
    .fetch_all(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let versions: Result<Vec<DocumentVersionMeta>, _> =
        rows.into_iter().map(|r| r.into_version_meta()).collect();
    versions.map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Get a single version with full content
pub async fn get_version(
    State(state): State<Arc<DocsState>>,
    Path(version_id): Path<String>,
) -> Result<Json<DocumentVersion>, DocsError> {
    let row: DocumentVersionRow = sqlx::query_as(
        "SELECT id, document_id, content, created_at FROM document_versions WHERE id = ?",
    )
    .bind(&version_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?
    .ok_or_else(|| DocsError {
        error: format!("Version not found: {}", version_id),
        code: "NOT_FOUND".to_string(),
    })?;

    row.into_version().map(Json).map_err(|e| DocsError {
        error: e,
        code: "PARSE_ERROR".to_string(),
    })
}

/// Restore a document to a previous version
/// Creates a new version from current content, then copies version content to document
pub async fn restore_version(
    State(state): State<Arc<DocsState>>,
    Path((document_id, version_id)): Path<(String, String)>,
) -> Result<Json<Document>, DocsError> {
    // Get the current document
    let current = get_document_by_id(&state.pool, &document_id).await?;

    // Get the version to restore
    let version_row: DocumentVersionRow = sqlx::query_as(
        "SELECT id, document_id, content, created_at FROM document_versions WHERE id = ? AND document_id = ?",
    )
    .bind(&version_id)
    .bind(&document_id)
    .fetch_optional(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?
    .ok_or_else(|| DocsError {
        error: format!("Version not found: {}", version_id),
        code: "NOT_FOUND".to_string(),
    })?;

    let now = format_datetime(&Utc::now());

    // Create a version from the current content before restoring
    let new_version_id = Uuid::new_v4().to_string();
    sqlx::query(
        r#"
        INSERT INTO document_versions (id, document_id, content, created_at)
        VALUES (?, ?, ?, ?)
        "#,
    )
    .bind(&new_version_id)
    .bind(&document_id)
    .bind(&current.content)
    .bind(&now)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    // Update the document with the version content
    sqlx::query(
        r#"
        UPDATE documents
        SET content = ?, updated_at = ?
        WHERE id = ?
        "#,
    )
    .bind(&version_row.content)
    .bind(&now)
    .bind(&document_id)
    .execute(&state.pool)
    .await
    .map_err(|e| DocsError {
        error: e.to_string(),
        code: "DATABASE_ERROR".to_string(),
    })?;

    let doc = get_document_by_id(&state.pool, &document_id).await?;
    Ok(Json(doc))
}

// === Template Rendering ===

/// Request to render a Jinja template
#[derive(Debug, Deserialize)]
pub struct RenderTemplateRequest {
    pub variables: serde_json::Value,
}

/// Response from rendering a template
#[derive(Debug, Serialize)]
pub struct RenderTemplateResponse {
    pub output: String,
    pub success: bool,
    pub error: Option<String>,
}

/// Render a Jinja template with provided variables
pub async fn render_template(
    State(state): State<Arc<DocsState>>,
    Path(id): Path<String>,
    Json(req): Json<RenderTemplateRequest>,
) -> Result<Json<RenderTemplateResponse>, DocsError> {
    // Get the document
    let doc = get_document_by_id(&state.pool, &id).await?;

    // Verify it's a Jinja template
    if doc.content_type != ContentType::Jinja {
        return Err(DocsError {
            error: format!("Document is not a Jinja template (type: {:?})", doc.content_type),
            code: "VALIDATION".to_string(),
        });
    }

    // Render the template using minijinja
    let result = render_jinja_template(&doc.content, &req.variables);

    match result {
        Ok(output) => Ok(Json(RenderTemplateResponse {
            output,
            success: true,
            error: None,
        })),
        Err(e) => Ok(Json(RenderTemplateResponse {
            output: String::new(),
            success: false,
            error: Some(e),
        })),
    }
}

/// Render a Jinja template string with variables
fn render_jinja_template(template: &str, variables: &serde_json::Value) -> Result<String, String> {
    use minijinja::Environment;

    let mut env = Environment::new();
    env.add_template("template", template)
        .map_err(|e| format!("Template parse error: {}", e))?;

    let tmpl = env.get_template("template")
        .map_err(|e| format!("Template error: {}", e))?;

    // Convert JSON value to minijinja Value
    let ctx = json_to_minijinja_value(variables);

    tmpl.render(ctx)
        .map_err(|e| format!("Render error: {}", e))
}

/// Convert serde_json::Value to minijinja::Value
fn json_to_minijinja_value(json: &serde_json::Value) -> minijinja::Value {
    match json {
        serde_json::Value::Null => minijinja::Value::UNDEFINED,
        serde_json::Value::Bool(b) => minijinja::Value::from(*b),
        serde_json::Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                minijinja::Value::from(i)
            } else if let Some(f) = n.as_f64() {
                minijinja::Value::from(f)
            } else {
                minijinja::Value::UNDEFINED
            }
        }
        serde_json::Value::String(s) => minijinja::Value::from(s.as_str()),
        serde_json::Value::Array(arr) => {
            let values: Vec<minijinja::Value> = arr.iter().map(json_to_minijinja_value).collect();
            minijinja::Value::from(values)
        }
        serde_json::Value::Object(obj) => {
            let map: std::collections::BTreeMap<String, minijinja::Value> = obj
                .iter()
                .map(|(k, v)| (k.clone(), json_to_minijinja_value(v)))
                .collect();
            minijinja::Value::from_iter(map)
        }
    }
}
