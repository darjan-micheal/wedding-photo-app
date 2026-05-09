use std::time::Duration;
use serde::{Deserialize, Serialize};

#[derive(Serialize, Deserialize, Clone)]
pub struct KeyInfo {
    pub plan: String,
    pub photo_limit: Option<i32>,
}

#[tauri::command]
pub async fn validate_key(key: String) -> Result<KeyInfo, String> {
    let client = reqwest::Client::new();
    
    let res = client
        .post("http://localhost:8080/api/keys/validate")
        .json(&serde_json::json!({ "key": key }))
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
                };
                // In a future step, save this to SQLite for offline caching
                Ok(info)
            } else {
                Err(body["reason"].as_str().unwrap_or("Invalid key").to_string())
            }
        }
        Err(_) => {
            Err("Cannot reach license server. Check internet connection.".to_string())
        }
    }
}
#[tauri::command]
pub async fn invalidate_key(key: &str) -> Result<(), String> {
    let client = reqwest::Client::new();
    
    // Fire and forget to the cloud backend
    let _ = client
        .post("http://localhost:8080/api/keys/invalidate")
        .json(&serde_json::json!({ "key": key }))
        .send()
        .await;

    Ok(())
}