use std::collections::HashMap;

use async_stream::stream;
use async_trait::async_trait;
use aws_sdk_bedrockruntime::{
    Client,
    config::{Region, Token},
    primitives::Blob,
    types as aws,
};
use aws_smithy_types::{Document, Number};
use base64::Engine;
use serde_json::{Value, json};

use crate::{
    AiError, AssistantMessage, AssistantMessageEvent as Event, Content, Context, EventStream, Message, Model, Provider,
    ResolvedAuth, StopReason, StreamOptions, UserContent,
};

pub struct BedrockProvider {
    models: Vec<Model>,
}
impl BedrockProvider {
    #[must_use]
    pub fn new(models: Vec<Model>) -> Self {
        Self { models }
    }
}

#[async_trait]
impl Provider for BedrockProvider {
    fn id(&self) -> &str {
        "amazon-bedrock"
    }
    fn name(&self) -> &str {
        "Amazon Bedrock"
    }
    fn models(&self) -> Vec<Model> {
        self.models.clone()
    }
    fn env_keys(&self) -> &[String] {
        &[]
    }
    fn requires_auth(&self) -> bool {
        true
    }
    fn ambient_auth_configured(&self) -> bool {
        [
            "AWS_BEARER_TOKEN_BEDROCK",
            "AWS_ACCESS_KEY_ID",
            "AWS_PROFILE",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
        ]
        .iter()
        .any(|name| std::env::var_os(name).is_some())
            || std::env::var_os("HOME").is_some_and(|home| {
                let home = std::path::PathBuf::from(home);
                home.join(".aws/credentials").is_file() || home.join(".aws/config").is_file()
            })
    }
    async fn stream(
        &self,
        model: &Model,
        context: &Context,
        options: StreamOptions,
        auth: ResolvedAuth,
    ) -> Result<EventStream, AiError> {
        let region = options
            .env
            .get("AWS_REGION")
            .or_else(|| options.env.get("AWS_DEFAULT_REGION"))
            .cloned()
            .or_else(|| std::env::var("AWS_REGION").ok())
            .or_else(|| std::env::var("AWS_DEFAULT_REGION").ok())
            .unwrap_or_else(|| region_from_model(&model.id).unwrap_or_else(|| "us-east-1".into()));
        let shared = aws_config::defaults(aws_config::BehaviorVersion::latest())
            .region(Region::new(region))
            .load()
            .await;
        let mut config = aws_sdk_bedrockruntime::config::Builder::from(&shared);
        if let Some(endpoint) = (!model.base_url.is_empty()).then_some(model.base_url.clone()) {
            config = config.endpoint_url(endpoint)
        }
        let bearer = auth
            .api_key
            .or_else(|| options.env.get("AWS_BEARER_TOKEN_BEDROCK").cloned())
            .or_else(|| std::env::var("AWS_BEARER_TOKEN_BEDROCK").ok());
        if let Some(token) = bearer {
            config = config.bearer_token(Token::new(token, None));
        }
        let client = Client::from_conf(config.build());
        let messages = convert_messages(context)?;
        let system = context
            .system_prompt
            .as_ref()
            .map(|text| vec![aws::SystemContentBlock::Text(text.clone())]);
        let tools = convert_tools(context)?;
        let inference = aws::InferenceConfiguration::builder()
            .max_tokens(i32::try_from(options.max_tokens.unwrap_or(model.max_tokens)).unwrap_or(i32::MAX))
            .set_temperature(options.temperature.map(|value| value as f32))
            .build();
        let request = client
            .converse_stream()
            .model_id(&model.id)
            .set_messages(Some(messages))
            .set_system(system)
            .inference_config(inference)
            .set_tool_config(tools);
        let cancellation = options.cancellation.clone();
        let response = if let Some(token) = &cancellation {
            tokio::select! { response=request.send()=>response, ()=token.cancelled()=>return Ok(crate::failed_stream(model,"request aborted",StopReason::Aborted)) }
        } else {
            request.send().await
        };
        let mut response = match response {
            Ok(response) => response,
            Err(error) => return Ok(crate::failed_stream(model, error.to_string(), StopReason::Error)),
        };
        let model = model.clone();
        Ok(Box::pin(stream! {
            let mut output=AssistantMessage::empty(&model);let mut blocks:HashMap<i32,BlockState>=HashMap::new();let mut started=false;let mut stop=StopReason::Pending;
            loop{let received=if let Some(token)=&cancellation{tokio::select!{received=response.stream.recv()=>received,()=token.cancelled()=>{output.stop_reason=StopReason::Aborted;output.error_message=Some("request aborted".into());yield Event::Error{reason:StopReason::Aborted,error:output};return;}}}else{response.stream.recv().await};match received{Ok(Some(item))=>match item{
                aws::ConverseStreamOutput::MessageStart(_)=>{started=true;yield Event::Start{partial:output.clone()};}
                aws::ConverseStreamOutput::ContentBlockStart(event)=>{if let Some(aws::ContentBlockStart::ToolUse(tool))=event.start(){let index=output.content.len();output.content.push(Content::tool_call(tool.tool_use_id(),tool.name(),json!({})));blocks.insert(event.content_block_index(),BlockState::Tool{index,args:String::new()});yield Event::ToolcallStart{content_index:index,partial:output.clone()};}}
                aws::ConverseStreamOutput::ContentBlockDelta(event)=>{let upstream=event.content_block_index();if let Some(delta)=event.delta(){match delta{
                    aws::ContentBlockDelta::Text(text)=>{let new=!blocks.contains_key(&upstream);let index=ensure_text(&mut output,&mut blocks,upstream,false);if new{yield Event::TextStart{content_index:index,partial:output.clone()};}if let Content::Text{text:current,..}=&mut output.content[index]{current.push_str(text)}yield Event::TextDelta{content_index:index,delta:text.clone(),partial:output.clone()};}
                    aws::ContentBlockDelta::ReasoningContent(reasoning)=>if let aws::ReasoningContentBlockDelta::Text(text)=reasoning{let new=!blocks.contains_key(&upstream);let index=ensure_text(&mut output,&mut blocks,upstream,true);if new{yield Event::ThinkingStart{content_index:index,partial:output.clone()};}if let Content::Thinking{thinking,..}=&mut output.content[index]{thinking.push_str(text)}yield Event::ThinkingDelta{content_index:index,delta:text.clone(),partial:output.clone()};},
                    aws::ContentBlockDelta::ToolUse(tool)=>{if let Some(BlockState::Tool{index,args})=blocks.get_mut(&upstream){args.push_str(tool.input());let parsed=partial_json(args);if let Content::ToolCall{arguments,..}=&mut output.content[*index]{*arguments=parsed}yield Event::ToolcallDelta{content_index:*index,delta:tool.input().into(),partial:output.clone()};}},_=>{}}}}
                aws::ConverseStreamOutput::ContentBlockStop(event)=>if let Some(block)=blocks.get(&event.content_block_index()){match block{BlockState::Text{index,thinking:false}=>if let Content::Text{text,..}=&output.content[*index]{yield Event::TextEnd{content_index:*index,content:text.clone(),partial:output.clone()}},BlockState::Text{index,thinking:true}=>if let Content::Thinking{thinking,..}=&output.content[*index]{yield Event::ThinkingEnd{content_index:*index,content:thinking.clone(),partial:output.clone()}},BlockState::Tool{index,..}=>yield Event::ToolcallEnd{content_index:*index,tool_call:output.content[*index].clone(),partial:output.clone()}}},
                aws::ConverseStreamOutput::MessageStop(event)=>{let raw=event.stop_reason().as_str();output.raw_stop_reason=Some(raw.into());stop=match raw{"max_tokens"=>StopReason::Length,"tool_use"=>StopReason::ToolUse,_=>StopReason::Stop};},
                aws::ConverseStreamOutput::Metadata(event)=>if let Some(usage)=event.usage(){output.usage.input=u64::try_from(usage.input_tokens()).unwrap_or(0);output.usage.output=u64::try_from(usage.output_tokens()).unwrap_or(0);output.usage.cache_read=u64::try_from(usage.cache_read_input_tokens().unwrap_or(0)).unwrap_or(0);output.usage.cache_write=u64::try_from(usage.cache_write_input_tokens().unwrap_or(0)).unwrap_or(0);output.usage.calculate_cost(&model.cost);},_=>{}},Ok(None)=>break,Err(error)=>{output.stop_reason=StopReason::Error;output.error_message=Some(error.to_string());yield Event::Error{reason:StopReason::Error,error:output};return;}}}
            if !started{yield Event::Start{partial:output.clone()};}if stop==StopReason::Pending{stop=if blocks.values().any(|block|matches!(block,BlockState::Tool{..})){StopReason::ToolUse}else{StopReason::Stop}}output.stop_reason=stop;yield Event::Done{reason:stop,message:output};
        }))
    }
}

#[derive(Clone)]
enum BlockState {
    Text { index: usize, thinking: bool },
    Tool { index: usize, args: String },
}
fn ensure_text(
    output: &mut AssistantMessage,
    blocks: &mut HashMap<i32, BlockState>,
    upstream: i32,
    thinking: bool,
) -> usize {
    if let Some(BlockState::Text { index, .. }) = blocks.get(&upstream) {
        return *index;
    }
    let index = output.content.len();
    output.content.push(if thinking {
        Content::thinking("")
    } else {
        Content::text("")
    });
    blocks.insert(upstream, BlockState::Text { index, thinking });
    index
}
fn partial_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or_else(|_| json!({}))
}
fn region_from_model(model: &str) -> Option<String> {
    model
        .strip_prefix("arn:")
        .and_then(|value| value.split(':').nth(2))
        .map(str::to_owned)
}

fn convert_messages(context: &Context) -> Result<Vec<aws::Message>, AiError> {
    context
        .messages
        .iter()
        .map(|message| {
            let (role, content) = match message {
                Message::User { content, .. } => (aws::ConversationRole::User, user_blocks(content)?),
                Message::Assistant { message } => (aws::ConversationRole::Assistant, assistant_blocks(message)?),
                Message::ToolResult {
                    tool_call_id,
                    content,
                    is_error,
                    ..
                } => {
                    let result = aws::ToolResultBlock::builder()
                        .tool_use_id(tool_call_id)
                        .set_content(Some(
                            content
                                .iter()
                                .filter_map(|block| match block {
                                    Content::Text { text, .. } => Some(aws::ToolResultContentBlock::Text(text.clone())),
                                    _ => None,
                                })
                                .collect(),
                        ))
                        .status(if *is_error {
                            aws::ToolResultStatus::Error
                        } else {
                            aws::ToolResultStatus::Success
                        })
                        .build()
                        .map_err(|error| AiError::Config(error.to_string()))?;
                    (aws::ConversationRole::User, vec![aws::ContentBlock::ToolResult(result)])
                }
            };
            aws::Message::builder()
                .role(role)
                .set_content(Some(content))
                .build()
                .map_err(|error| AiError::Config(error.to_string()))
        })
        .collect()
}
fn user_blocks(content: &UserContent) -> Result<Vec<aws::ContentBlock>, AiError> {
    match content {
        UserContent::Text(text) => Ok(vec![aws::ContentBlock::Text(text.clone())]),
        UserContent::Blocks(blocks) => blocks
            .iter()
            .filter_map(|block| match block {
                Content::Text { text, .. } => Some(Ok(aws::ContentBlock::Text(text.clone()))),
                Content::Image { data, mime_type } => Some(image_block(data, mime_type)),
                _ => None,
            })
            .collect(),
    }
}
fn image_block(data: &str, mime: &str) -> Result<aws::ContentBlock, AiError> {
    let format = match mime {
        "image/jpeg" => aws::ImageFormat::Jpeg,
        "image/gif" => aws::ImageFormat::Gif,
        "image/webp" => aws::ImageFormat::Webp,
        _ => aws::ImageFormat::Png,
    };
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(data)
        .map_err(|error| AiError::Config(error.to_string()))?;
    let image = aws::ImageBlock::builder()
        .format(format)
        .source(aws::ImageSource::Bytes(Blob::new(bytes)))
        .build()
        .map_err(|error| AiError::Config(error.to_string()))?;
    Ok(aws::ContentBlock::Image(image))
}
fn assistant_blocks(message: &crate::AssistantMessage) -> Result<Vec<aws::ContentBlock>, AiError> {
    message
        .content
        .iter()
        .filter_map(|block| match block {
            Content::Text { text, .. } => Some(Ok(aws::ContentBlock::Text(text.clone()))),
            Content::Thinking { thinking, .. } => Some(Ok(aws::ContentBlock::Text(format!(
                "<thinking>\n{thinking}\n</thinking>"
            )))),
            Content::ToolCall {
                id, name, arguments, ..
            } => Some(
                aws::ToolUseBlock::builder()
                    .tool_use_id(id)
                    .name(name)
                    .input(document(arguments))
                    .build()
                    .map(aws::ContentBlock::ToolUse)
                    .map_err(|error| AiError::Config(error.to_string())),
            ),
            Content::Image { .. } => None,
        })
        .collect()
}
fn convert_tools(context: &Context) -> Result<Option<aws::ToolConfiguration>, AiError> {
    if context.tools.is_empty() {
        return Ok(None);
    }
    let tools = context
        .tools
        .iter()
        .map(|tool| {
            aws::ToolSpecification::builder()
                .name(&tool.name)
                .description(&tool.description)
                .input_schema(aws::ToolInputSchema::Json(document(&tool.parameters)))
                .build()
                .map(aws::Tool::ToolSpec)
                .map_err(|error| AiError::Config(error.to_string()))
        })
        .collect::<Result<Vec<_>, _>>()?;
    Ok(Some(
        aws::ToolConfiguration::builder()
            .set_tools(Some(tools))
            .build()
            .map_err(|error| AiError::Config(error.to_string()))?,
    ))
}
fn document(value: &Value) -> Document {
    match value {
        Value::Null => Document::Null,
        Value::Bool(value) => Document::Bool(*value),
        Value::String(value) => Document::String(value.clone()),
        Value::Number(value) => value.as_u64().map_or_else(
            || {
                value.as_i64().map_or_else(
                    || Document::Number(Number::Float(value.as_f64().unwrap_or_default())),
                    |value| Document::Number(Number::NegInt(value)),
                )
            },
            |value| Document::Number(Number::PosInt(value)),
        ),
        Value::Array(values) => Document::Array(values.iter().map(document).collect()),
        Value::Object(values) => Document::Object(
            values
                .iter()
                .map(|(key, value)| (key.clone(), document(value)))
                .collect::<HashMap<_, _>>(),
        ),
    }
}
