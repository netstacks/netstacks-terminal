use std::path::PathBuf;
use super::types::*;

pub struct GitOps {
    cwd: PathBuf,
}

impl GitOps {
    pub fn new(cwd: impl Into<PathBuf>) -> Self {
        Self { cwd: cwd.into() }
    }
}
