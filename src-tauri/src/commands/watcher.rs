use notify::{Event, EventKind, RecommendedWatcher, RecursiveMode, Watcher};
use std::path::PathBuf;
use std::sync::mpsc;
use std::thread;

pub struct FolderWatcher {
    _watcher: RecommendedWatcher,
}

impl FolderWatcher {
    pub fn start(
        incoming_path: PathBuf,
        on_new_file: impl Fn(PathBuf) + Send + 'static,
    ) -> Self {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(tx).unwrap();

        watcher.watch(&incoming_path, RecursiveMode::NonRecursive).unwrap();

        thread::spawn(move || {
            for result in rx {
                if let Ok(event) = result {
                    // We removed the is_jpeg check so all files pass through to lib.rs
                    if matches!(event.kind, EventKind::Create(_)) {
                        for path in event.paths {
                            on_new_file(path);
                        }
                    }
                }
            }
        });
        FolderWatcher { _watcher: watcher }
    }
}