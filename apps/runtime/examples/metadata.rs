use aelys_runtime::channel::BackendChannelClient;
use serde_json::json;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let endpoint = std::env::var("AELYS_CHANNEL_URL").expect("AELYS_CHANNEL_URL");
    let token = std::env::var("AELYS_ACCESS_TOKEN").expect("AELYS_ACCESS_TOKEN");
    let item = json!({
        "session_index_id": "44444444-4444-4444-4444-444444444444",
        "state": "active",
        "adapter": "codex_cli",
        "message_count": 0
    });
    BackendChannelClient::new(endpoint, token)
        .send_metadata(vec![item])
        .await
        .expect("metadata");
    println!("runtime metadata acknowledged");
}
