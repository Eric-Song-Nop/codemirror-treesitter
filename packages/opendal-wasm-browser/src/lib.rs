use opendal::services::{Dropbox, Onedrive, S3};
use opendal::{Entry, Metadata, Operator};
use serde::{Deserialize, Serialize};
use wasm_bindgen::prelude::*;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpendalBrowserOperatorConfig {
    access_token: Option<String>,
    access_key_id: Option<String>,
    bucket: Option<String>,
    client_id: Option<String>,
    client_secret: Option<String>,
    endpoint: Option<String>,
    provider: String,
    region: Option<String>,
    refresh_token: Option<String>,
    root: Option<String>,
    secret_access_key: Option<String>,
    session_token: Option<String>,
}

#[derive(Default, Deserialize)]
#[serde(rename_all = "camelCase")]
struct OpendalBrowserWriteOptions {
    if_match: Option<String>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpendalBrowserCapabilities {
    native_copy: bool,
    native_create_dir: bool,
    native_delete: bool,
    native_list: bool,
    native_read: bool,
    native_rename: bool,
    native_stat: bool,
    native_write: bool,
    native_write_with_if_match: bool,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct OpendalBrowserEntry {
    #[serde(skip_serializing_if = "Option::is_none")]
    etag: Option<String>,
    is_directory: bool,
    is_file: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    last_modified: Option<String>,
    path: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    size: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    version: Option<String>,
}

#[wasm_bindgen(js_name = OpendalBrowserOperator)]
pub struct WasmOpendalBrowserOperator {
    operator: Operator,
}

#[wasm_bindgen(js_class = OpendalBrowserOperator)]
impl WasmOpendalBrowserOperator {
    #[wasm_bindgen(constructor)]
    pub fn new(config: JsValue) -> Result<WasmOpendalBrowserOperator, JsValue> {
        set_panic_hook();

        let config: OpendalBrowserOperatorConfig =
            serde_wasm_bindgen::from_value(config).map_err(js_error)?;

        let provider = config.provider.trim().to_string();
        let operator = match provider.as_str() {
            "dropbox" => build_dropbox_operator(config)?,
            "onedrive" => build_onedrive_operator(config)?,
            "s3" => build_s3_operator(config)?,
            provider => {
                return Err(js_error(format!(
                    "unsupported OpenDAL browser provider: {provider}"
                )));
            }
        };

        Ok(WasmOpendalBrowserOperator { operator })
    }
}

fn build_dropbox_operator(config: OpendalBrowserOperatorConfig) -> Result<Operator, JsValue> {
    let mut builder =
        Dropbox::default().access_token(required("accessToken", config.access_token.as_deref())?);

    if let Some(root) = optional_root(config.root.as_deref())? {
        builder = builder.root(&root);
    }

    Ok(Operator::new(builder).map_err(js_error)?.finish())
}

fn build_onedrive_operator(config: OpendalBrowserOperatorConfig) -> Result<Operator, JsValue> {
    let mut builder = Onedrive::default();

    match (
        optional_text(config.access_token.as_deref()),
        optional_text(config.refresh_token.as_deref()),
    ) {
        (Some(access_token), None) => {
            builder = builder.access_token(access_token);
        }
        (None, Some(refresh_token)) => {
            builder = builder
                .refresh_token(refresh_token)
                .client_id(required("clientId", config.client_id.as_deref())?);
            if let Some(client_secret) = optional_text(config.client_secret.as_deref()) {
                builder = builder.client_secret(client_secret);
            }
        }
        (Some(_), Some(_)) => {
            return Err(js_error(
                "accessToken and refreshToken cannot be set at the same time.",
            ));
        }
        (None, None) => return Err(js_error("OpenDAL browser config requires accessToken.")),
    }

    if let Some(root) = optional_root(config.root.as_deref())? {
        builder = builder.root(&root);
    }

    Ok(Operator::new(builder).map_err(js_error)?.finish())
}

fn build_s3_operator(config: OpendalBrowserOperatorConfig) -> Result<Operator, JsValue> {
    let mut builder = S3::default()
        .disable_config_load()
        .disable_ec2_metadata()
        .bucket(required("bucket", config.bucket.as_deref())?)
        .endpoint(required("endpoint", config.endpoint.as_deref())?)
        .region(required("region", config.region.as_deref())?);

    if let Some(root) = optional_root(config.root.as_deref())? {
        builder = builder.root(&root);
    }

    if let Some(access_key_id) = optional_text(config.access_key_id.as_deref()) {
        builder = builder.access_key_id(access_key_id);
    }

    if let Some(secret_access_key) = optional_text(config.secret_access_key.as_deref()) {
        builder = builder.secret_access_key(secret_access_key);
    }

    if let Some(session_token) = optional_text(config.session_token.as_deref()) {
        builder = builder.session_token(session_token);
    }

    Ok(Operator::new(builder).map_err(js_error)?.finish())
}

#[wasm_bindgen(js_class = OpendalBrowserOperator)]
impl WasmOpendalBrowserOperator {
    pub fn capabilities(&self) -> Result<JsValue, JsValue> {
        let cap = self.operator.info().native_capability();
        to_js_value(OpendalBrowserCapabilities {
            native_copy: cap.copy,
            native_create_dir: cap.create_dir,
            native_delete: cap.delete,
            native_list: cap.list,
            native_read: cap.read,
            native_rename: cap.rename,
            native_stat: cap.stat,
            native_write: cap.write,
            native_write_with_if_match: cap.write_with_if_match,
        })
    }

    pub async fn list(&self, prefix: String) -> Result<JsValue, JsValue> {
        let entries = self
            .operator
            .list(&normalize_list_prefix(&prefix)?)
            .await
            .map_err(js_error)?;
        let entries = entries
            .iter()
            .map(entry_to_payload)
            .collect::<Vec<OpendalBrowserEntry>>();
        to_js_value(entries)
    }

    #[wasm_bindgen(js_name = readText)]
    pub async fn read_text(&self, path: String) -> Result<String, JsValue> {
        let bytes = self
            .operator
            .read(&normalize_file_path(&path)?)
            .await
            .map_err(js_error)?;
        String::from_utf8(bytes.to_vec()).map_err(js_error)
    }

    #[wasm_bindgen(js_name = createDir)]
    pub async fn create_dir(&self, path: String) -> Result<(), JsValue> {
        self.operator
            .create_dir(&normalize_dir_path(&path)?)
            .await
            .map_err(js_error)
    }

    #[wasm_bindgen(js_name = writeText)]
    pub async fn write_text(
        &self,
        path: String,
        value: String,
        options: Option<JsValue>,
    ) -> Result<JsValue, JsValue> {
        let path = normalize_file_path(&path)?;
        let options = parse_write_options(options)?;
        let cap = self.operator.info().native_capability();
        let metadata = match optional_text(options.if_match.as_deref()) {
            Some(if_match) if cap.write_with_if_match => {
                self.operator
                    .write_with(&path, value.into_bytes())
                    .if_match(if_match)
                    .await
                    .map_err(js_error)?
            }
            _ => self
                .operator
                .write(&path, value.into_bytes())
                .await
                .map_err(js_error)?,
        };
        to_js_value(metadata_to_payload(path, &metadata))
    }

    pub async fn delete(&self, path: String) -> Result<(), JsValue> {
        self.operator
            .delete(&normalize_delete_path(&path)?)
            .await
            .map_err(js_error)
    }

    pub async fn rename(&self, from: String, to: String) -> Result<(), JsValue> {
        let from = normalize_file_path(&from)?;
        let to = normalize_file_path(&to)?;

        let cap = self.operator.info().native_capability();
        if cap.rename {
            self.operator.rename(&from, &to).await.map_err(js_error)?;
            return Ok(());
        }

        if !cap.copy {
            return Err(js_error(
                "OpenDAL backend does not support native rename or copy fallback.",
            ));
        }

        self.operator.copy(&from, &to).await.map_err(js_error)?;
        self.operator.delete(&from).await.map_err(js_error)?;
        Ok(())
    }

    pub async fn stat(&self, path: String) -> Result<JsValue, JsValue> {
        let path = normalize_storage_path(&path)?;
        let meta = self.operator.stat(&path).await.map_err(js_error)?;
        to_js_value(metadata_to_payload(path, &meta))
    }
}

#[wasm_bindgen]
pub fn set_panic_hook() {
    console_error_panic_hook::set_once();
}

fn entry_to_payload(entry: &Entry) -> OpendalBrowserEntry {
    metadata_to_payload(entry.path().to_string(), entry.metadata())
}

fn metadata_to_payload(path: String, metadata: &Metadata) -> OpendalBrowserEntry {
    OpendalBrowserEntry {
        etag: metadata.etag().map(str::to_string),
        is_directory: metadata.is_dir(),
        is_file: metadata.is_file(),
        last_modified: metadata.last_modified().map(|value| value.to_string()),
        path,
        size: metadata.is_file().then_some(metadata.content_length()),
        version: metadata.version().map(str::to_string),
    }
}

fn parse_write_options(options: Option<JsValue>) -> Result<OpendalBrowserWriteOptions, JsValue> {
    match options {
        Some(value) if !value.is_null() && !value.is_undefined() => {
            serde_wasm_bindgen::from_value(value).map_err(js_error)
        }
        _ => Ok(OpendalBrowserWriteOptions::default()),
    }
}

fn normalize_storage_path(path: &str) -> Result<String, JsValue> {
    let path = path.trim().replace('\\', "/");
    if path.is_empty() {
        return Ok(String::new());
    }

    let parts = path
        .split('/')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();

    if parts.iter().any(|part| *part == "." || *part == "..") {
        return Err(js_error("paths cannot include . or .. segments"));
    }

    Ok(parts.join("/"))
}

fn normalize_file_path(path: &str) -> Result<String, JsValue> {
    let path = normalize_storage_path(path)?;
    if path.is_empty() || path.ends_with('/') {
        return Err(js_error("expected a file path"));
    }
    Ok(path)
}

fn normalize_delete_path(path: &str) -> Result<String, JsValue> {
    let path = normalize_storage_path(path)?;
    if path.is_empty() {
        return Err(js_error("expected a path"));
    }
    Ok(path)
}

fn normalize_list_prefix(path: &str) -> Result<String, JsValue> {
    match normalize_storage_path(path) {
        Ok(path) if path.is_empty() || path.ends_with('/') => Ok(path),
        Ok(path) => Ok(format!("{path}/")),
        Err(error) => Err(error),
    }
}

fn normalize_dir_path(path: &str) -> Result<String, JsValue> {
    let path = normalize_storage_path(path)?;
    if path.is_empty() {
        return Err(js_error("expected a directory path"));
    }
    Ok(format!("{path}/"))
}

fn required<'a>(label: &str, value: Option<&'a str>) -> Result<&'a str, JsValue> {
    optional_text(value)
        .ok_or_else(|| js_error(format!("OpenDAL browser config requires {label}.")))
}

fn optional_text(value: Option<&str>) -> Option<&str> {
    value.map(str::trim).filter(|value| !value.is_empty())
}

fn optional_root(value: Option<&str>) -> Result<Option<String>, JsValue> {
    let Some(value) = optional_text(value) else {
        return Ok(None);
    };
    let root = normalize_storage_path(value)?;
    if root.is_empty() {
        Ok(None)
    } else {
        Ok(Some(format!("/{root}")))
    }
}

fn to_js_value(value: impl Serialize) -> Result<JsValue, JsValue> {
    serde_wasm_bindgen::to_value(&value).map_err(js_error)
}

fn js_error(error: impl ToString) -> JsValue {
    JsValue::from_str(&error.to_string())
}
