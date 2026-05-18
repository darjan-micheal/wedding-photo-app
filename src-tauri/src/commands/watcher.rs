use notify::{Event, RecommendedWatcher, RecursiveMode, Watcher};
use std::collections::HashSet;
use std::path::PathBuf;
use std::sync::{mpsc, Arc, Mutex};
use std::thread;
use std::time::Duration;

pub struct FolderWatcher {
    _watcher: RecommendedWatcher,
}

impl FolderWatcher {
    pub fn start(incoming_path: PathBuf, on_new_file: impl Fn(PathBuf) + Send + 'static) -> Self {
        let (tx, rx) = mpsc::channel::<notify::Result<Event>>();
        let mut watcher = notify::recommended_watcher(tx).unwrap();

        watcher.watch(&incoming_path, RecursiveMode::NonRecursive).unwrap();

        let active_locks = Arc::new(Mutex::new(HashSet::new()));

        // Single thread to catch Windows spam, instantly passing files to the concurrent pool!
        thread::spawn(move || {
            for result in rx {
                if let Ok(event) = result {
                    for path in event.paths {
                        if path.is_file() {
                            let mut locks = active_locks.lock().unwrap();
                            if locks.contains(&path) { continue; }
                            locks.insert(path.clone());
                            drop(locks); 

                            on_new_file(path.clone());

                            let locks_clone = active_locks.clone();
                            let path_clone = path;
                            thread::spawn(move || {
                                thread::sleep(Duration::from_secs(3));
                                if let Ok(mut l) = locks_clone.lock() { l.remove(&path_clone); }
                            });
                        }
                    }
                }
            }
        });

        FolderWatcher { _watcher: watcher }
    }
}