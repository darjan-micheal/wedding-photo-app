use serde::{Deserialize, Serialize};
use std::time::Duration;

#[derive(Serialize, Deserialize, Clone)]
pub struct KeyInfo {
    pub plan: String,
    pub photo_limit: Option<i32>,
    pub expires_at: Option<String>,
}

#[tauri::command]
pub async fn validate_key(key: String) -> Result<KeyInfo, String> {
    // Generate the unique hardware fingerprint of this laptop
    let machine_id = machine_uid::get().unwrap_or_else(|_| "fallback-machine-id".to_string());

    let client = reqwest::Client::new();

    let res = client
        .post("http://localhost:8080/api/keys/validate")
        .json(&serde_json::json!({ "key": key, "machineId": machine_id }))
        .timeout(Duration::from_secs(5))
        .send()
        .await;

    match res {
        Ok(response) => {
            let body: serde_json::Value = response.json().await.map_err(|e| e.to_string())?;

            if body["valid"].as_bool().unwrap_or(false) {
                let info = KeyInfo {
                    plan: body["plan"].as_str().unwrap_or("basic").to_string(),
                    photo_limit: body["photo_limit"].as_i64().map(|v| v as i32),
                    expires_at: body["expires_at"].as_str().map(|v| v.to_string()), // <-- ADD THIS
                };
                Ok(info)
            } else {
                Err(body["reason"].as_str().unwrap_or("Invalid key").to_string())
            }
        }
        Err(_) => Err("Cannot reach license server. Check internet connection.".to_string()),
    }
}

#[tauri::command]
pub async fn invalidate_key(key: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    let _ = client
        .post("http://localhost:8080/api/keys/invalidate")
        .json(&serde_json::json!({ "key": key }))
        .timeout(Duration::from_secs(5))
        .send()
        .await;
    Ok(())
}
