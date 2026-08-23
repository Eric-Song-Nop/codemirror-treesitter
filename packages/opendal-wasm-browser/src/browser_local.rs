// Licensed to the Apache Software Foundation (ASF) under one or more
// contributor license agreements. See the NOTICE file distributed with this
// work for additional information regarding copyright ownership. The ASF
// licenses this file to you under the Apache License, Version 2.0.

use std::fmt;
use std::sync::Arc;

use opendal::raw::oio;
use opendal::raw::*;
use opendal::*;
use send_wrapper::SendWrapper;
use wasm_bindgen::JsCast;
use wasm_bindgen::JsValue;
use wasm_bindgen_futures::JsFuture;
use web_sys::{
    DomException, File, FileSystemDirectoryHandle, FileSystemFileHandle,
    FileSystemGetDirectoryOptions, FileSystemGetFileOptions, FileSystemRemoveOptions,
    FileSystemWritableFileStream, WriteCommandType, WriteParams,
};

const BROWSER_LOCAL_SCHEME: &str = "browser-local";

#[derive(Clone)]
pub(crate) struct BrowserLocalAccess {
    core: Arc<BrowserLocalCore>,
}

struct BrowserLocalCore {
    info: Arc<AccessorInfo>,
    root: SendWrapper<FileSystemDirectoryHandle>,
}

impl fmt::Debug for BrowserLocalAccess {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("BrowserLocalAccess")
            .field("scheme", &BROWSER_LOCAL_SCHEME)
            .finish_non_exhaustive()
    }
}

impl BrowserLocalAccess {
    pub(crate) fn new(root: FileSystemDirectoryHandle) -> Self {
        let info = AccessorInfo::default();
        info.set_scheme(BROWSER_LOCAL_SCHEME);
        info.set_name("browser-local");
        info.set_root("/");
        info.set_native_capability(Capability {
            create_dir: true,
            delete: true,
            delete_with_recursive: true,
            list: true,
            read: true,
            stat: true,
            write: true,
            write_can_empty: true,
            write_can_multi: true,
            ..Default::default()
        });

        Self {
            core: Arc::new(BrowserLocalCore {
                info: Arc::new(info),
                root: SendWrapper::new(root),
            }),
        }
    }
}

impl Access for BrowserLocalAccess {
    type Reader = BrowserLocalReader;
    type Writer = BrowserLocalWriter;
    type Lister = BrowserLocalLister;
    type Deleter = oio::OneShotDeleter<BrowserLocalDeleter>;
    type Copier = ();

    fn info(&self) -> Arc<AccessorInfo> {
        self.core.info.clone()
    }

    async fn stat(&self, path: &str, _args: OpStat) -> Result<RpStat> {
        let path = validate_storage_path(path)?;
        if path.is_empty() || path.ends_with('/') {
            get_directory_handle(&self.core, &path, false).await?;
            return Ok(RpStat::new(Metadata::new(EntryMode::DIR)));
        }

        match get_file_handle(&self.core, &path, false).await {
            Ok(handle) => {
                let file = file_from_handle(&handle).await?;
                Ok(RpStat::new(metadata_from_file(&file)))
            }
            Err(error) if error.kind() == ErrorKind::NotFound => {
                get_directory_handle(&self.core, &format!("{path}/"), false).await?;
                Ok(RpStat::new(Metadata::new(EntryMode::DIR)))
            }
            Err(error) => Err(error),
        }
    }

    async fn read(&self, path: &str, args: OpRead) -> Result<(RpRead, Self::Reader)> {
        let path = validate_file_path(path)?;
        let handle = get_file_handle(&self.core, &path, false).await?;
        let file = file_from_handle(&handle).await?;
        let metadata = metadata_from_file(&file);
        Ok((
            RpRead::new(metadata),
            BrowserLocalReader::new(file, args.range()),
        ))
    }

    async fn list(&self, path: &str, _args: OpList) -> Result<(RpList, Self::Lister)> {
        let path = validate_directory_path(path)?;
        let directory = get_directory_handle(&self.core, &path, false).await?;
        Ok((RpList::default(), BrowserLocalLister::new(directory, path)))
    }

    async fn create_dir(&self, path: &str, _args: OpCreateDir) -> Result<RpCreateDir> {
        let path = validate_non_root_directory_path(path)?;
        get_directory_handle(&self.core, &path, true).await?;
        Ok(RpCreateDir::default())
    }

    async fn write(&self, path: &str, _args: OpWrite) -> Result<(RpWrite, Self::Writer)> {
        let path = validate_file_path(path)?;
        let handle = get_file_handle(&self.core, &path, true).await?;
        let stream: FileSystemWritableFileStream = JsFuture::from(handle.create_writable())
            .await
            .and_then(JsCast::dyn_into)
            .map_err(parse_js_error)?;
        Ok((RpWrite::default(), BrowserLocalWriter::new(handle, stream)))
    }

    async fn delete(&self) -> Result<(RpDelete, Self::Deleter)> {
        Ok((
            RpDelete::default(),
            oio::OneShotDeleter::new(BrowserLocalDeleter {
                core: self.core.clone(),
            }),
        ))
    }
}

pub(crate) struct BrowserLocalReader {
    file: SendWrapper<File>,
    range: BytesRange,
    done: bool,
}

impl BrowserLocalReader {
    fn new(file: File, range: BytesRange) -> Self {
        Self {
            file: SendWrapper::new(file),
            range,
            done: false,
        }
    }
}

impl oio::Read for BrowserLocalReader {
    async fn read(&mut self) -> Result<Buffer> {
        if self.done {
            return Ok(Buffer::new());
        }
        self.done = true;

        let blob: &web_sys::Blob = self.file.as_ref();
        let blob = if self.range.is_full() {
            blob.clone()
        } else {
            let offset = self.range.offset() as f64;
            let end = self
                .range
                .size()
                .map_or_else(|| blob.size(), |size| offset + size as f64);
            blob.slice_with_f64_and_f64(offset, end)
                .map_err(parse_js_error)?
        };
        let buffer = JsFuture::from(blob.array_buffer())
            .await
            .map_err(parse_js_error)?;
        Ok(Buffer::from(js_sys::Uint8Array::new(&buffer).to_vec()))
    }
}

pub(crate) struct BrowserLocalWriter {
    handle: SendWrapper<FileSystemFileHandle>,
    stream: SendWrapper<FileSystemWritableFileStream>,
}

impl BrowserLocalWriter {
    fn new(handle: FileSystemFileHandle, stream: FileSystemWritableFileStream) -> Self {
        Self {
            handle: SendWrapper::new(handle),
            stream: SendWrapper::new(stream),
        }
    }
}

impl oio::Write for BrowserLocalWriter {
    async fn write(&mut self, buffer: Buffer) -> Result<()> {
        let bytes = buffer.to_bytes();
        let params = WriteParams::new(WriteCommandType::Write);
        params.set_data(&js_sys::Uint8Array::from(bytes.as_ref()).into());
        params.set_size(Some(bytes.len() as f64));
        JsFuture::from(
            self.stream
                .write_with_write_params(&params.into())
                .map_err(parse_js_error)?,
        )
        .await
        .map_err(parse_js_error)?;
        Ok(())
    }

    async fn close(&mut self) -> Result<Metadata> {
        JsFuture::from(self.stream.close())
            .await
            .map_err(parse_js_error)?;
        let file = file_from_handle(&self.handle).await?;
        Ok(metadata_from_file(&file))
    }

    async fn abort(&mut self) -> Result<()> {
        JsFuture::from(self.stream.abort())
            .await
            .map_err(parse_js_error)?;
        Ok(())
    }
}

pub(crate) struct BrowserLocalLister {
    iterator: SendWrapper<js_sys::AsyncIterator>,
    path: String,
}

impl BrowserLocalLister {
    fn new(directory: FileSystemDirectoryHandle, path: String) -> Self {
        Self {
            iterator: SendWrapper::new(directory.entries()),
            path: path.trim_matches('/').to_string(),
        }
    }
}

impl oio::List for BrowserLocalLister {
    async fn next(&mut self) -> Result<Option<oio::Entry>> {
        let result = JsFuture::from(self.iterator.next().map_err(parse_js_error)?)
            .await
            .map_err(parse_js_error)?;
        let done = js_sys::Reflect::get(&result, &JsValue::from_str("done"))
            .unwrap_or(JsValue::TRUE)
            .as_bool()
            .unwrap_or(true);
        if done {
            return Ok(None);
        }

        let value =
            js_sys::Reflect::get(&result, &JsValue::from_str("value")).map_err(parse_js_error)?;
        let pair: js_sys::Array = value.unchecked_into();
        let name = pair
            .get(0)
            .as_string()
            .ok_or_else(|| Error::new(ErrorKind::Unexpected, "directory entry has no name"))?;
        validate_component(&name)?;
        let handle = pair.get(1);
        let kind = js_sys::Reflect::get(&handle, &JsValue::from_str("kind"))
            .ok()
            .and_then(|value| value.as_string())
            .unwrap_or_default();
        let prefix = if self.path.is_empty() {
            String::new()
        } else {
            format!("{}/", self.path)
        };
        let (path, metadata) = if kind == "directory" {
            (
                format!("{prefix}{name}/"),
                Metadata::new(EntryMode::DIR),
            )
        } else {
            let file_handle: FileSystemFileHandle = handle.dyn_into().map_err(parse_js_error)?;
            let file = file_from_handle(&file_handle).await?;
            (format!("{prefix}{name}"), metadata_from_file(&file))
        };
        Ok(Some(oio::Entry::new(&path, metadata)))
    }
}

pub(crate) struct BrowserLocalDeleter {
    core: Arc<BrowserLocalCore>,
}

impl oio::OneShotDelete for BrowserLocalDeleter {
    async fn delete_once(&self, path: String, args: OpDelete) -> Result<()> {
        let path = validate_non_root_path(&path)?;
        let (parent, name) = get_parent_directory_and_name(&self.core, &path, false).await?;
        let options = FileSystemRemoveOptions::new();
        options.set_recursive(args.recursive());
        match JsFuture::from(parent.remove_entry_with_options(name, &options)).await {
            Ok(_) => Ok(()),
            Err(error) => {
                let error = parse_js_error(error);
                if error.kind() == ErrorKind::NotFound {
                    Ok(())
                } else {
                    Err(error)
                }
            }
        }
    }
}

async fn file_from_handle(handle: &FileSystemFileHandle) -> Result<File> {
    JsFuture::from(handle.get_file())
        .await
        .and_then(JsCast::dyn_into)
        .map_err(parse_js_error)
}

fn metadata_from_file(file: &File) -> Metadata {
    let mut metadata = Metadata::new(EntryMode::FILE);
    metadata.set_content_length(file.size() as u64);
    if let Ok(timestamp) = Timestamp::from_millisecond(file.last_modified() as i64) {
        metadata.set_last_modified(timestamp);
    }
    metadata
}

async fn get_directory_handle(
    core: &BrowserLocalCore,
    path: &str,
    create: bool,
) -> Result<FileSystemDirectoryHandle> {
    let path = validate_storage_path(path)?;
    let mut handle = (*core.root).clone();
    let options = FileSystemGetDirectoryOptions::new();
    options.set_create(create);
    for component in path
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
    {
        validate_component(component)?;
        handle = JsFuture::from(handle.get_directory_handle_with_options(component, &options))
            .await
            .and_then(JsCast::dyn_into)
            .map_err(parse_js_error)?;
    }
    Ok(handle)
}

async fn get_parent_directory_and_name<'a>(
    core: &BrowserLocalCore,
    path: &'a str,
    create: bool,
) -> Result<(FileSystemDirectoryHandle, &'a str)> {
    let path = path.trim_matches('/');
    let (parent, name) = path.rsplit_once('/').unwrap_or(("", path));
    validate_component(name)?;
    Ok((get_directory_handle(core, parent, create).await?, name))
}

async fn get_file_handle(
    core: &BrowserLocalCore,
    path: &str,
    create: bool,
) -> Result<FileSystemFileHandle> {
    let path = validate_file_path(path)?;
    let (parent, name) = get_parent_directory_and_name(core, &path, create).await?;
    let options = FileSystemGetFileOptions::new();
    options.set_create(create);
    JsFuture::from(parent.get_file_handle_with_options(name, &options))
        .await
        .and_then(JsCast::dyn_into)
        .map_err(parse_js_error)
}

fn validate_component(component: &str) -> Result<()> {
    if component.is_empty()
        || component == "."
        || component == ".."
        || component.contains('/')
        || component.contains('\\')
    {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "browser-local path contains an invalid component",
        ));
    }
    Ok(())
}

fn validate_storage_path(path: &str) -> Result<String> {
    if path.starts_with('/') && path != "/" {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "browser-local paths must be relative",
        ));
    }
    let directory = path.ends_with('/');
    let components = path
        .trim_matches('/')
        .split('/')
        .filter(|part| !part.is_empty())
        .map(|part| {
            validate_component(part)?;
            Ok(part)
        })
        .collect::<Result<Vec<_>>>()?;
    let mut normalized = components.join("/");
    if directory && !normalized.is_empty() {
        normalized.push('/');
    }
    Ok(normalized)
}

fn validate_directory_path(path: &str) -> Result<String> {
    let mut path = validate_storage_path(path)?;
    if !path.is_empty() && !path.ends_with('/') {
        path.push('/');
    }
    Ok(path)
}

fn validate_non_root_directory_path(path: &str) -> Result<String> {
    let path = validate_directory_path(path)?;
    if path.is_empty() {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "browser-local operation requires a non-root directory",
        ));
    }
    Ok(path)
}

fn validate_file_path(path: &str) -> Result<String> {
    let path = validate_storage_path(path)?;
    if path.is_empty() || path.ends_with('/') {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "browser-local operation requires a file path",
        ));
    }
    Ok(path)
}

fn validate_non_root_path(path: &str) -> Result<String> {
    let path = validate_storage_path(path)?;
    if path.is_empty() {
        return Err(Error::new(
            ErrorKind::ConfigInvalid,
            "browser-local operation requires a non-root path",
        ));
    }
    Ok(path)
}

fn parse_js_error(value: JsValue) -> Error {
    if let Some(exception) = value.dyn_ref::<DomException>() {
        let kind = match exception.name().as_str() {
            "NotFoundError" | "TypeMismatchError" => ErrorKind::NotFound,
            "InvalidModificationError" => ErrorKind::AlreadyExists,
            "NotAllowedError" | "SecurityError" => ErrorKind::PermissionDenied,
            "NotSupportedError" => ErrorKind::Unsupported,
            _ => ErrorKind::Unexpected,
        };
        return Error::new(kind, exception.message());
    }
    if let Some(error) = value.dyn_ref::<js_sys::Error>() {
        return Error::new(ErrorKind::Unexpected, String::from(error.message()));
    }
    Error::new(
        ErrorKind::Unexpected,
        value
            .as_string()
            .unwrap_or_else(|| "unknown browser file-system error".to_string()),
    )
}
