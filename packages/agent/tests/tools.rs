#![allow(missing_docs)]

use pi_agent_core::{AgentTool, EditTool, ReadTool, WriteTool};
use serde_json::json;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

#[tokio::test]
async fn write_read_and_multi_edit() {
    let root = std::env::temp_dir().join(format!("pi-tools-{}", Uuid::new_v4()));
    let write = WriteTool::new(&root);
    write
        .execute(
            "1",
            json!({"path":"a.txt","content":"alpha\nbeta\ngamma\n"}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    let edit = EditTool::new(&root);
    edit.execute(
        "2",
        json!({"path":"a.txt","edits":[{"oldText":"alpha","newText":"one"},{"oldText":"gamma","newText":"three"}]}),
        CancellationToken::new(),
    )
    .await
    .unwrap();
    assert_eq!(
        tokio::fs::read_to_string(root.join("a.txt")).await.unwrap(),
        "one\nbeta\nthree\n"
    );
    let read = ReadTool::new(&root);
    let result = read
        .execute(
            "3",
            json!({"path":"a.txt","offset":2,"limit":1}),
            CancellationToken::new(),
        )
        .await
        .unwrap();
    assert!(format!("{:?}", result.content).contains("beta"));
    let _ = tokio::fs::remove_dir_all(root).await;
}

#[tokio::test]
async fn edit_rejects_non_unique_text() {
    let root = std::env::temp_dir().join(format!("pi-tools-{}", Uuid::new_v4()));
    tokio::fs::create_dir_all(&root).await.unwrap();
    tokio::fs::write(root.join("a.txt"), "same same").await.unwrap();
    let result = EditTool::new(&root)
        .execute(
            "1",
            json!({"path":"a.txt","oldText":"same","newText":"x"}),
            CancellationToken::new(),
        )
        .await;
    assert!(result.is_err());
    let _ = tokio::fs::remove_dir_all(root).await;
}
