use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

use deno_core::error::AnyError;
use deno_core::ModuleSpecifier;
use deno_resolver::npm::DenoInNpmPackageChecker;
use deno_runtime::deno_core::FsModuleLoader;
use deno_runtime::deno_fs::RealFs;
use deno_runtime::deno_permissions::PermissionsContainer;
use deno_runtime::permissions::RuntimePermissionDescriptorParser;
use deno_runtime::worker::MainWorker;
use deno_runtime::worker::WorkerOptions;
use deno_runtime::worker::WorkerServiceOptions;
use deno_runtime::BootstrapOptions;
use sys_traits::impls::RealSys;

fn get_config_path() -> Result<String, AnyError> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        return Err(anyhow::anyhow!("Usage: denali-cli <config.ts|config.js>"));
    }
    Ok(args[1].clone())
}

fn resolve_module_specifier(path: &str) -> Result<ModuleSpecifier, AnyError> {
    let path = Path::new(path);
    let absolute_path = if path.is_absolute() {
        path.to_path_buf()
    } else {
        std::env::current_dir()?.join(path)
    };
    let canonical_path = absolute_path.canonicalize()?;
    ModuleSpecifier::from_file_path(&canonical_path)
        .map_err(|_| anyhow::anyhow!("Failed to create module specifier"))
}

async fn run_config(config_path: &str) -> Result<(), AnyError> {
    let main_module = resolve_module_specifier(config_path)?;

    // Create permission descriptor parser with RealSys
    let permission_parser = Arc::new(RuntimePermissionDescriptorParser::new(RealSys::default()));

    // Create permissions - allow all for maximum compatibility
    // Users can restrict via CLI flags in the future
    let permissions = PermissionsContainer::allow_all(permission_parser);

    // Bootstrap options for the runtime
    let bootstrap_options = BootstrapOptions {
        args: vec![],
        ..Default::default()
    };

    // Worker options with full API support
    let worker_options = WorkerOptions {
        bootstrap: bootstrap_options,
        ..Default::default()
    };

    let fs = Arc::new(RealFs);

    // Service options
    let service_options = WorkerServiceOptions::<DenoInNpmPackageChecker, deno_resolver::npm::NpmResolver<RealSys>, RealSys> {
        deno_rt_native_addon_loader: None,
        module_loader: Rc::new(FsModuleLoader),
        permissions,
        blob_store: Default::default(),
        broadcast_channel: Default::default(),
        feature_checker: Default::default(),
        fs,
        node_services: Default::default(),
        npm_process_state_provider: Default::default(),
        root_cert_store_provider: Default::default(),
        fetch_dns_resolver: Default::default(),
        shared_array_buffer_store: Default::default(),
        compiled_wasm_module_store: Default::default(),
        v8_code_cache: Default::default(),
        bundle_provider: None,
    };

    // Create the main worker
    let mut worker = MainWorker::bootstrap_from_options(
        &main_module,
        service_options,
        worker_options,
    );

    // Execute the main module
    worker.execute_main_module(&main_module).await?;

    // Run the event loop to completion
    worker.run_event_loop(false).await?;

    Ok(())
}

fn main() {
    let config_path = match get_config_path() {
        Ok(path) => path,
        Err(e) => {
            eprintln!("Error: {}", e);
            std::process::exit(1);
        }
    };

    // Initialize the tokio runtime
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .expect("Failed to create tokio runtime");

    // Run the config file
    if let Err(e) = runtime.block_on(run_config(&config_path)) {
        eprintln!("Error: {}", e);
        std::process::exit(1);
    }
}
