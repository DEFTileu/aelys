use aelys_runtime::channel::BackendChannelClient;

#[tokio::main(flavor = "current_thread")]
async fn main() {
    let endpoint = std::env::var("AELYS_CHANNEL_URL").expect("AELYS_CHANNEL_URL");
    let token = std::env::var("AELYS_ACCESS_TOKEN").expect("AELYS_ACCESS_TOKEN");
    BackendChannelClient::new(endpoint, token)
        .heartbeat()
        .await
        .expect("heartbeat");
    println!("runtime heartbeat acknowledged");
}
