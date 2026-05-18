use mdns_sd::{ServiceDaemon, ServiceInfo};
use std::collections::HashMap;
use std::net::{SocketAddr, TcpStream, UdpSocket};
use std::process::Command;
use std::time::Duration;

// THE FIX: The Ultimate Virtual-Adapter Bypass
pub fn get_true_local_ip() -> String {
    // We create a dummy connection to a public IP. It doesn't actually send data,
    // but it forces Windows to reveal which network adapter is ACTUALLY connected
    // to the real Wi-Fi router, ignoring all WSL/VirtualBox adapters!
    if let Ok(socket) = UdpSocket::bind("0.0.0.0:0") {
        if socket.connect("8.8.8.8:80").is_ok() {
            if let Ok(addr) = socket.local_addr() {
                return addr.ip().to_string();
            }
        }
    }
    "127.0.0.1".to_string() // Fallback
}

// We need to keep the daemon alive as long as the app runs
pub struct NetworkState {
    pub mdns: ServiceDaemon,
}

impl NetworkState {
    pub fn new() -> Self {
        NetworkState {
            mdns: ServiceDaemon::new().expect("Failed to create mDNS daemon"),
        }
    }

    pub fn start_broadcast(&self) {
        let service_type = "_http._tcp.local.";
        let instance_name = "weddingsnap";
        let ip = get_true_local_ip(); // <-- USING TRUE IP
        let host_name = "weddingsnap.local.";
        let port = 3000;
        let properties: HashMap<String, String> = HashMap::new();

        let my_service = ServiceInfo::new(
            service_type,
            instance_name,
            host_name,
            &ip,
            port,
            properties,
        )
        .expect("valid service info");

        self.mdns
            .register(my_service)
            .expect("Failed to register mDNS service");
        println!(
            "mDNS broadcasting as http://weddingsnap.local:3000 on IP {}",
            ip
        );
    }
}

#[tauri::command]
pub fn get_network_urls() -> Result<serde_json::Value, String> {
    let raw_ip = get_true_local_ip(); // <-- USING TRUE IP

    Ok(serde_json::json!({
        "mdns": "http://weddingsnap.local:3000",
        "raw_ip": format!("http://{}:3000", raw_ip)
    }))
}

// --- MODULE 10: Firewall Automation ---
pub fn ensure_firewall_rule() -> Result<(), String> {
    // Check if the rule already exists
    let check = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "show",
            "rule",
            "name=WeddingSnap Server",
        ])
        .output()
        .map_err(|e| format!("Failed to execute netsh: {}", e))?;

    if check
        .stdout
        .windows(b"WeddingSnap Server".len())
        .any(|w| w == b"WeddingSnap Server")
    {
        return Ok(()); // Rule already exists
    }

    // Attempt to add the rule
    let result = Command::new("netsh")
        .args([
            "advfirewall",
            "firewall",
            "add",
            "rule",
            "name=WeddingSnap Server",
            "dir=in",
            "action=allow",
            "protocol=TCP",
            "localport=3000",
        ])
        .output()
        .map_err(|e| format!("Failed to execute netsh: {}", e))?;

    if result.status.success() {
        Ok(())
    } else {
        Err("Firewall rule missing. Please restart WeddingSnap as Administrator to configure the network.".to_string())
    }
}

#[tauri::command]
pub async fn ping_router() -> bool {
    // We ping the sidecar port (3000). 
    let target: SocketAddr = "127.0.0.1:3000".parse().unwrap();
    
    // THE FIX: Give the Node sidecar up to 3 seconds to boot on initial startup!
    // We try 6 times, waiting 500ms between each attempt.
    for _ in 0..6 {
        if TcpStream::connect_timeout(&target, Duration::from_millis(500)).is_ok() {
            return true;
        }
        tokio::time::sleep(Duration::from_millis(500)).await;
    }
    
    // If it still fails after 3 seconds, it is truly disconnected.
    false
}
